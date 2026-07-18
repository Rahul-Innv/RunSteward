#!/usr/bin/env node
// Trigger hook (Phase 2): reads sensor state, decides NONE|WARN, optionally injects
// additionalContext. Wired to UserPromptSubmit (turn boundary) and PreToolUse
// (mid-turn seam for long agentic turns, throttled to a full check at most once
// per THROTTLE_MS; otherwise a single small file read then exit).
//
// Fail-open contract: ANY error -> print nothing, exit 0. A hook that can block
// a session is worse than no hook. Never exit non-zero, never write to stderr.

'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

let decideMod = null;
try { decideMod = require('./decide'); } catch {}
let notifyMod = null;
try { notifyMod = require('./notify'); } catch {}

// Env override exists for tests only — production always uses the home path.
const DIR = process.env.LIMIT_WRAPUP_DIR || path.join(os.homedir(), '.claude', 'limit-wrapup');
const STATE = path.join(DIR, 'state.json');
const CONFIG = path.join(DIR, 'config.json');
const LATCHES = path.join(DIR, 'latches.json');
const LOG = path.join(DIR, 'decisions.log');
const THROTTLE_MS = 60 * 1000;
const LATCH_SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
const MAX_LOG_BYTES = 1024 * 1024;
const REFRESH_MARKER = path.join(DIR, 'oauth-refresh.txt');
const REFRESH_MIN_MS = 180 * 1000; // the usage endpoint's documented-safe polling interval

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function atomicWrite(file, text) {
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

// Fire-and-forget a detached OAuth usage poll (sensor/refresh-oauth.js) so the
// NEXT check has authoritative data — runs on every full check, not just stale
// state, because idle statusline sessions keep timestamps fresh while their
// VALUES go stale. Marker-file throttle keeps it to one spawn per REFRESH_MIN_MS
// machine-wide; the hook itself never waits on the network.
function maybeSpawnOauthRefresh(now) {
  try {
    try { if (now - fs.statSync(REFRESH_MARKER).mtimeMs < REFRESH_MIN_MS) return; } catch {}
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(REFRESH_MARKER, String(now));
    const script = path.join(__dirname, '..', 'sensor', 'refresh-oauth.js');
    const child = require('child_process').spawn(process.execPath, [script], {
      detached: true, stdio: 'ignore', env: process.env,
    });
    child.unref();
  } catch {}
}

function logLine(obj) {
  try {
    try { if (fs.statSync(LOG).size > MAX_LOG_BYTES) fs.renameSync(LOG, LOG + '.1'); } catch {}
    fs.appendFileSync(LOG, JSON.stringify(obj) + '\n');
  } catch {}
}

function main() {
  if (!decideMod) return;
  let input;
  try { input = JSON.parse(fs.readFileSync(0, 'utf8')); } catch { return; }
  if (!input || typeof input !== 'object') return;
  const event = input.hook_event_name;
  const sid = typeof input.session_id === 'string' && input.session_id ? input.session_id : 'unknown';
  const now = Date.now();

  const config = decideMod.mergeConfig(readJson(CONFIG));
  if (!config.enabled) return;

  // Latch/throttle store: { sessions: { <sid>: { keys: {latchKey: ts}, lastCheck, updated } } }
  let latches = readJson(LATCHES);
  if (!latches || typeof latches !== 'object' || typeof latches.sessions !== 'object' || !latches.sessions) {
    latches = { sessions: {} };
  }
  const sess = latches.sessions[sid] || { keys: {}, lastCheck: 0, updated: now };
  if (typeof sess.keys !== 'object' || !sess.keys) sess.keys = {};

  // Mid-turn seam is throttled: most PreToolUse calls cost one file read, then exit.
  if (event === 'PreToolUse' && now - (sess.lastCheck || 0) < THROTTLE_MS) return;

  const state = readJson(STATE);
  const result = decideMod.decide(state, config, sess.keys, now);
  maybeSpawnOauthRefresh(now);

  logLine({
    ts: now, event, sid: sid.slice(0, 8), dry_run: !!config.dry_run,
    decision: result.decision, reasons: result.reasons,
    windows: result.windows.map((w) => ({ w: w.window, util: w.util, level: w.level })),
  });

  // Persist latch + throttle bookkeeping (latch even in dry-run so the log
  // shows exactly what live mode WOULD have done, nag-cap included).
  try {
    sess.lastCheck = now;
    sess.updated = now;
    for (const k of result.newLatchKeys) sess.keys[k] = now;
    latches.sessions[sid] = sess;
    for (const [id, s] of Object.entries(latches.sessions)) {
      if (!s || now - (s.updated || 0) > LATCH_SESSION_TTL_MS) delete latches.sessions[id];
    }
    atomicWrite(LATCHES, JSON.stringify(latches));
  } catch {}

  if (config.dry_run || result.decision === 'NONE') return;

  const context = result.decision === 'WRAPUP'
    ? decideMod.buildWrapup(result, now)
    : decideMod.buildWarning(result, now);
  emit(event, context);

  // A WRAPUP is the one decision that must be SEEN (it fires unattended). Notify once — the latch
  // already caps it to one WRAPUP per session+window+reset. Fail-open: never let this affect the hook.
  if (result.decision === 'WRAPUP' && config.notify !== false && notifyMod) {
    try {
      const { title, message } = notifyMod.buildNotifyText(result);
      notifyMod.dispatch(title, message);
    } catch {}
  }
}

function emit(event, context) {
  // Output shapes per https://code.claude.com/docs/en/hooks (verified 2026-07-05).
  let out = null;
  if (event === 'UserPromptSubmit') {
    out = { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context } };
  } else if (event === 'PreToolUse') {
    // Advisory context only — no permissionDecision field, so the permission
    // flow is untouched.
    out = { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: context } };
  }
  if (out) process.stdout.write(JSON.stringify(out));
}

try { main(); } catch {}
process.exitCode = 0;
