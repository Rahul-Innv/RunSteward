#!/usr/bin/env node
'use strict';
// OAuth usage poller (Phase 5): the AUTHORITATIVE utilization source. The
// statusline sensor is fast and free but idle TUI sessions re-emit cached
// percentages; this endpoint always returns current account state, and it is
// the only source for VS Code / headless sessions (no statusline there).
// Spawned detached by trigger/check.js on every full check, throttled there to
// once per 180s machine-wide — the endpoint's documented-safe polling interval;
// without the claude-code User-Agent it lands in an aggressively rate-limited
// bucket (429s).
// Fail-open contract: any problem -> exit silently. Never prints, never non-zero.

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');

let burnrate = null;
try { burnrate = require('./burnrate'); } catch {}

// Env override exists for tests only — production always uses the home path.
const DIR = process.env.LIMIT_WRAPUP_DIR || path.join(os.homedir(), '.claude', 'limit-wrapup');
const STATE = path.join(DIR, 'state.json');
const MAX_SAMPLES = 300;
const FALLBACK_CC_VERSION = '2.1.201';

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function atomicWrite(file, text) {
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

// Windows/Linux credentials file; macOS keychain setups simply fail open here.
function oauthToken() {
  const cred = readJson(path.join(os.homedir(), '.claude', '.credentials.json'));
  const o = cred && cred.claudeAiOauth;
  if (!o || typeof o.accessToken !== 'string' || !o.accessToken) return null;
  if (typeof o.expiresAt === 'number' && o.expiresAt < Date.now() + 60000) return null; // expired(-ish)
  return o.accessToken;
}

function ccVersion() {
  const p = readJson(path.join(
    os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'package.json'));
  return (p && typeof p.version === 'string' && p.version) || FALLBACK_CC_VERSION;
}

// Endpoint shape differs from the statusline (`utilization` vs `used_percentage`,
// ISO-8601 vs epoch-seconds `resets_at`) — window objects are stored VERBATIM;
// burnrate's fallback keys already extract both shapes. `src` marks provenance.
function buildSample(payload, nowMs) {
  if (!payload || typeof payload !== 'object') return null;
  const rl = {};
  for (const w of ['five_hour', 'seven_day']) {
    if (payload[w] && typeof payload[w] === 'object') rl[w] = payload[w];
  }
  return Object.keys(rl).length ? { ts: nowMs, rate_limits: rl, src: 'oauth' } : null;
}

// Same append semantics as the statusline sensor (regression drop, cap, burn recompute).
// No freshness skip: the endpoint is authoritative and check.js's marker throttle
// owns the cadence — a fresh-but-stale-VALUED statusline sample must not block us.
function appendSample(sample) {
  let state = { samples: [] };
  try { state = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch {}
  if (!Array.isArray(state.samples)) state.samples = [];
  if (burnrate) {
    try { sample = burnrate.dropRegressions(state.samples, sample); } catch {}
  }
  if (!sample) return;
  state.samples.push(sample);
  if (state.samples.length > MAX_SAMPLES) state.samples = state.samples.slice(-MAX_SAMPLES);
  if (burnrate) {
    try {
      state.burn = {
        computed_at: sample.ts,
        five_hour: burnrate.computeBurnRate(state.samples, 'five_hour', { nowMs: sample.ts }),
        seven_day: burnrate.computeBurnRate(state.samples, 'seven_day', { nowMs: sample.ts }),
      };
    } catch {}
  }
  fs.mkdirSync(DIR, { recursive: true });
  atomicWrite(STATE, JSON.stringify(state));
}

function fetchUsage(tok, cb) {
  const req = https.request({
    hostname: 'api.anthropic.com',
    path: '/api/oauth/usage',
    method: 'GET',
    headers: {
      Authorization: 'Bearer ' + tok,
      'anthropic-beta': 'oauth-2025-04-20',
      'User-Agent': 'claude-code/' + ccVersion(),
      'Content-Type': 'application/json',
    },
    timeout: 8000,
  }, (res) => {
    let body = '';
    res.on('data', (d) => { body += d; });
    res.on('end', () => {
      if (res.statusCode !== 200) return cb(null);
      try { cb(JSON.parse(body)); } catch { cb(null); }
    });
  });
  req.on('timeout', () => req.destroy());
  req.on('error', () => cb(null));
  req.end();
}

function main() {
  if (process.env.LIMIT_WRAPUP_NO_NET) return; // tests: never touch the network
  const tok = oauthToken();
  if (!tok) return;
  // Race guard only: skip if another refresh landed an oauth sample moments ago.
  // A fresh statusline sample does NOT skip — its VALUES may be stale cache.
  const state = readJson(STATE);
  const last = state && Array.isArray(state.samples) && state.samples[state.samples.length - 1];
  if (last && last.src === 'oauth' && typeof last.ts === 'number' && Date.now() - last.ts < 60000) return;
  fetchUsage(tok, (payload) => {
    try {
      const sample = buildSample(payload, Date.now());
      if (sample) appendSample(sample);
    } catch {}
  });
}

module.exports = { buildSample, appendSample };
if (require.main === module) {
  try { main(); } catch {}
  process.exitCode = 0;
}
