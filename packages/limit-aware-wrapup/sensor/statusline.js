#!/usr/bin/env node
// Sensor v0 (Phase 0 capture): reads Claude Code statusline stdin, persists the raw payload
// for schema pinning, appends verbatim rate_limits samples, renders a minimal usage statusline.
// Fail-open contract: any error -> print fallback text (or nothing) and exit 0. Never throw.

'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

// Optional companion module; its absence must not take down the statusline.
let burnrate = null;
try { burnrate = require('./burnrate'); } catch {}

// Env override exists for tests only — production always uses the home path.
const DIR = process.env.LIMIT_WRAPUP_DIR || path.join(os.homedir(), '.claude', 'limit-wrapup');
const RAW = path.join(DIR, 'raw-sample.json');
const STATE = path.join(DIR, 'state.json');
const RAW_MIN_AGE_MS = 60000; // re-capture raw payload at most once a minute
const SAMPLE_MIN_AGE_MS = 15000; // sample cadence; statusline itself refreshes far more often
const MAX_SAMPLES = 300;

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

function atomicWrite(file, text) {
  // temp + rename: atomic on same volume; last-writer-wins across concurrent sessions
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function pick(obj, keys) {
  for (const k of keys) {
    const v = obj ? obj[k] : undefined;
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
}

function pct(v) {
  // Pinned schema: used_percentage is a 0-100 decimal (docs) — no fraction heuristic.
  if (typeof v !== 'number' || !isFinite(v)) return undefined;
  return Math.max(0, Math.min(100, Math.round(v)));
}

function main() {
  // Invocation marker, written before any parsing: distinguishes "Claude Code never
  // ran the statusline" from "ran but payload was unusable". Single overwritten file.
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(path.join(DIR, 'last-invoked.txt'), new Date().toISOString());
  } catch {}
  let payload;
  try { payload = JSON.parse(readStdin()); } catch { payload = null; }
  if (!payload || typeof payload !== 'object') { process.stdout.write(''); return; }

  try { fs.mkdirSync(DIR, { recursive: true }); } catch {}

  const now = Date.now();

  // 1) Raw capture for schema pinning (throttled; latest payload only)
  try {
    let stale = true;
    try { stale = now - fs.statSync(RAW).mtimeMs > RAW_MIN_AGE_MS; } catch {}
    if (stale) atomicWrite(RAW, JSON.stringify(payload, null, 2));
  } catch {}

  // 2) Verbatim rate_limits sample (schema-agnostic until Phase 1 pins field names)
  const rl = payload.rate_limits;
  if (rl && typeof rl === 'object') {
    try {
      let state = { samples: [] };
      try { state = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch {}
      if (!Array.isArray(state.samples)) state.samples = [];
      const last = state.samples[state.samples.length - 1];
      // Idle TUI sessions re-emit CACHED percentages under fresh timestamps;
      // within a reset window utilization never decreases, so regressing
      // readings are dropped rather than stored (burnrate.dropRegressions).
      let sample = { ts: now, rate_limits: rl };
      if (burnrate) {
        try { sample = burnrate.dropRegressions(state.samples, sample); } catch {}
      }
      if (sample && (!last || now - last.ts > SAMPLE_MIN_AGE_MS)) {
        state.samples.push(sample);
        if (state.samples.length > MAX_SAMPLES) state.samples = state.samples.slice(-MAX_SAMPLES);
        // Precomputed burn rate (account-%/hour) so the trigger hook can read a
        // ready answer instead of re-deriving it. Fail-open: null on any gap.
        if (burnrate) {
          try {
            state.burn = {
              computed_at: now,
              five_hour: burnrate.computeBurnRate(state.samples, 'five_hour', { nowMs: now }),
              seven_day: burnrate.computeBurnRate(state.samples, 'seven_day', { nowMs: now }),
            };
          } catch {}
        }
        atomicWrite(STATE, JSON.stringify(state));
      }
    } catch {}
  }

  // 3) Render usage if findable (candidate key names until schema is pinned), else model + dir
  let text = '';
  try {
    const fh = pick(rl, ['five_hour', 'fiveHour', '5h']);
    const wk = pick(rl, ['seven_day', 'sevenDay', 'weekly', '7d']);
    const fhP = pct(pick(fh, ['used_percentage', 'utilization', 'used_pct', 'percent']));
    const wkP = pct(pick(wk, ['used_percentage', 'utilization', 'used_pct', 'percent']));
    const parts = [];
    if (fhP !== undefined) parts.push('5h ' + fhP + '%');
    if (wkP !== undefined) parts.push('wk ' + wkP + '%');
    if (parts.length) text = parts.join(' | ');
  } catch {}
  if (!text) {
    const model = (payload.model && (payload.model.display_name || payload.model.id)) || '';
    const dir = (payload.workspace && payload.workspace.current_dir) || payload.cwd || '';
    text = [model, dir ? path.basename(dir) : ''].filter(Boolean).join(' | ');
  }
  process.stdout.write(text);
}

try { main(); } catch { try { process.stdout.write(''); } catch {} }
