#!/usr/bin/env node
'use strict';
// Human-facing status view — what the tool currently SEES and has DONE.
// Read-only, zero-dependency, fail-open (missing files -> "unknown", never throws).
// Run:  node bin/status.js
//
// This is the legibility surface: the sensor/hook are otherwise invisible (they
// speak to the model, not to you). Reuses the same extract + reserve logic the
// live decision path uses, so what you see here is what the tool actually decides on.

const fs = require('fs');
const path = require('path');
const os = require('os');

let burnrate = {};
let decideMod = {};
try { burnrate = require('../sensor/burnrate'); } catch {}
try { decideMod = require('../trigger/decide'); } catch {}

const DIR = process.env.LIMIT_WRAPUP_DIR || path.join(os.homedir(), '.claude', 'limit-wrapup');
const WINDOWS = [['five_hour', '5-hour'], ['seven_day', 'weekly']];

function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }
function round1(n) { return Math.round(n * 10) / 10; }
function pad(s, n) { s = String(s); return s + ' '.repeat(Math.max(0, n - s.length)); }

function fmtClock(ms) {
  const d = new Date(ms);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}
function fmtUntil(ms, now) {
  const min = Math.round((ms - now) / 60000);
  if (min <= 0) return 'now';
  if (min < 120) return '~' + min + 'm';
  const h = Math.round(min / 60);
  return h < 48 ? h + 'h' : Math.round(h / 24) + 'd';
}
function fmtAgo(ms, now) {
  const s = Math.round((now - ms) / 1000);
  if (s < 90) return s + 's ago';
  const m = Math.round(s / 60);
  return m < 90 ? m + 'm ago' : Math.round(m / 60) + 'h ago';
}

// Most recent sample that actually carries THIS window (a sample can hold only one).
function latestFor(samples, key) {
  if (!Array.isArray(samples)) return null;
  for (let i = samples.length - 1; i >= 0; i--) {
    const s = samples[i];
    const util = burnrate.extractUtil ? burnrate.extractUtil(s && s.rate_limits, key) : undefined;
    if (util === undefined) continue;
    return { util, ts: s.ts, src: s.src || 'statusline', reset: burnrate.extractReset(s.rate_limits, key) };
  }
  return null;
}

function main() {
  const now = Date.now();
  const cfg = decideMod.mergeConfig ? decideMod.mergeConfig(readJson(path.join(DIR, 'config.json'))) : {};
  const state = readJson(path.join(DIR, 'state.json'));
  const samples = state && Array.isArray(state.samples) ? state.samples : [];
  const reserve = decideMod.effectiveReserve ? round1(decideMod.effectiveReserve(cfg)) : null;
  const staleMin = cfg.stale_after_min || 10;

  const out = [];
  out.push('Limit-Aware Wrapup — status @ ' + new Date(now).toLocaleString());
  out.push('');

  if (cfg.enabled === false) out.push('  ⚠ DISABLED (enabled:false) — the tool is off.');

  // Usage per window
  out.push('Usage (account-wide):');
  let newestTs;
  for (const [key, label] of WINDOWS) {
    const r = latestFor(samples, key);
    if (!r) { out.push('  ' + pad(label, 8) + ' unknown (no sample)'); continue; }
    newestTs = newestTs === undefined ? r.ts : Math.max(newestTs, r.ts);
    const warnAt = (cfg.warn_at && cfg.warn_at[key]) || [];
    const crossed = warnAt.filter((t) => r.util >= t);
    let line = '  ' + pad(label, 8) + pad(r.util + '%', 5);
    if (r.reset && r.reset.atMs) line += '  resets ' + fmtClock(r.reset.atMs) + ' (' + fmtUntil(r.reset.atMs, now) + ')';
    if (crossed.length) line += '   ⚠ past heads-up (' + crossed[crossed.length - 1] + '%)';
    if (reserve !== null && r.util >= 100 - reserve) line += '  ‼ INSIDE WRAP RESERVE';
    out.push(line);
  }
  out.push('');

  // Sensor freshness
  if (newestTs === undefined) {
    out.push('Sensor:  no data yet');
  } else {
    const ageMin = (now - newestTs) / 60000;
    const stale = ageMin > staleMin;
    const src = (latestFor(samples, 'five_hour') || latestFor(samples, 'seven_day') || {}).src;
    out.push('Sensor:  ' + (stale ? 'STALE (' + Math.round(ageMin) + 'm > ' + staleMin + 'm) — decisions silent'
      : 'fresh (' + (src || '?') + ', ' + fmtAgo(newestTs, now) + ')'));
  }

  // Policy
  let warnDesc = '?';
  if (Array.isArray(cfg.warn_at)) warnDesc = cfg.warn_at.join('/') + '%';
  else if (cfg.warn_at) {
    const fh = (cfg.warn_at.five_hour || []).join('/');
    const wk = (cfg.warn_at.seven_day || []).join('/');
    warnDesc = fh === wk ? fh + '%' : '5h ' + fh + '% · wk ' + wk + '%';
  }
  out.push('Mode:    ' + (cfg.mode || 'warn') + (cfg.mode === 'auto'
    ? ' (heads-ups + auto-wrap near the cliff)' : ' (heads-ups only; no auto-wrap — attended)'));
  out.push('         heads-up at ' + warnDesc + (reserve !== null
    ? ' · auto-wrap at ' + round1(100 - reserve) + '% (reserve ' + reserve + '%)' : ''));
  out.push('         dry_run: ' + (cfg.dry_run ? 'ON (logging only, injects nothing)' : 'off (live)'));
  out.push('');

  // Decisions today
  const log = decisionsToday(now);
  out.push('Today:   ' + log.checks + ' checks · ' + log.warns + ' heads-ups · ' + log.wraps + ' wraps'
    + (log.stale ? ' · ' + log.stale + ' stale-silent' : ''));
  if (log.recent.length) {
    out.push('Recent decisions:');
    for (const r of log.recent) out.push('  ' + fmtClock(r.ts) + '  ' + pad(r.decision, 6) + ' ' + r.reason);
  }

  process.stdout.write(out.join('\n') + '\n');
}

function decisionsToday(now) {
  const res = { checks: 0, warns: 0, wraps: 0, stale: 0, recent: [] };
  let lines;
  try { lines = fs.readFileSync(path.join(DIR, 'decisions.log'), 'utf8').trim().split('\n'); } catch { return res; }
  const todayStr = new Date(now).toDateString();
  for (const ln of lines) {
    let j; try { j = JSON.parse(ln); } catch { continue; }
    if (!j || new Date(j.ts).toDateString() !== todayStr) continue;
    if (j.dry_run) { /* still counts as a check */ }
    res.checks++;
    if (j.decision === 'WARN') res.warns++;
    else if (j.decision === 'WRAPUP') res.wraps++;
    if ((j.reasons || []).some((r) => /stale/.test(r))) res.stale++;
    if (j.decision && j.decision !== 'NONE') {
      res.recent.push({ ts: j.ts, decision: j.decision, reason: (j.reasons || []).find((r) => /crossed|WRAPUP|reserve/.test(r)) || (j.reasons || [])[0] || '' });
    }
  }
  res.recent = res.recent.slice(-6);
  return res;
}

try { main(); } catch (e) { process.stdout.write('status unavailable: ' + (e && e.message) + '\n'); }
