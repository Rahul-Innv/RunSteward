'use strict';
// Synthetic tests for trigger/decide.js (Phase 2). Run: node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const { decide, buildWarning, buildWrapup, mergeConfig, effectiveReserve, latchKey } = require('../trigger/decide');

const NOW = 1783271106910;
const MIN = 60 * 1000;
const RESET_5H = Math.floor((NOW + 3 * 3600e3) / 1000); // 3h out
const RESET_7D = Math.floor((NOW + 5 * 86400e3) / 1000); // 5d out

function state(fiveHourPct, sevenDayPct, opts) {
  const o = opts || {};
  return {
    samples: [{
      ts: o.ts !== undefined ? o.ts : NOW - MIN,
      rate_limits: {
        five_hour: { used_percentage: fiveHourPct, resets_at: o.reset5h !== undefined ? o.reset5h : RESET_5H },
        seven_day: { used_percentage: sevenDayPct, resets_at: o.reset7d !== undefined ? o.reset7d : RESET_7D },
      },
    }],
    burn: o.burn || null,
  };
}

test('disabled config -> NONE regardless of usage', () => {
  const r = decide(state(99, 99), { enabled: false }, {}, NOW);
  assert.equal(r.decision, 'NONE');
  assert.match(r.reasons.join(), /disabled/);
});

test('missing/empty/malformed state -> NONE, no throw', () => {
  assert.equal(decide(null, {}, {}, NOW).decision, 'NONE');
  assert.equal(decide({}, {}, {}, NOW).decision, 'NONE');
  assert.equal(decide({ samples: [{ bogus: true }] }, {}, {}, NOW).decision, 'NONE');
});

test('stale state -> NONE (unknown = silent)', () => {
  const r = decide(state(90, 90, { ts: NOW - 30 * MIN }), {}, {}, NOW);
  assert.equal(r.decision, 'NONE');
  assert.match(r.reasons.join(), /stale/);
});

test('below thresholds -> NONE', () => {
  const r = decide(state(42, 30), {}, {}, NOW);
  assert.equal(r.decision, 'NONE');
});

test('five_hour crosses 70 -> WARN with latch key', () => {
  const r = decide(state(72, 30), {}, {}, NOW);
  assert.equal(r.decision, 'WARN');
  assert.equal(r.windows.length, 1);
  assert.equal(r.windows[0].window, 'five_hour');
  assert.equal(r.windows[0].level, 70);
  assert.equal(r.newLatchKeys.length, 1);
});

test('latched level stays silent; higher level re-fires', () => {
  const latch = {};
  const r1 = decide(state(72, 30), {}, latch, NOW);
  assert.equal(r1.decision, 'WARN');
  r1.newLatchKeys.forEach((k) => (latch[k] = NOW));

  const r2 = decide(state(74, 30), {}, latch, NOW + MIN);
  assert.equal(r2.decision, 'NONE'); // same 70 level, latched

  const r3 = decide(state(86, 30), {}, latch, NOW + 2 * MIN);
  assert.equal(r3.decision, 'WARN'); // 85 is a new level
  assert.equal(r3.windows[0].level, 85);
});

test('reset id change re-arms the latch (new window, new budget)', () => {
  const latch = {};
  decide(state(72, 30), {}, latch, NOW).newLatchKeys.forEach((k) => (latch[k] = NOW));
  const nextReset = RESET_5H + 5 * 3600;
  const r = decide(state(72, 30, { reset5h: nextReset }), {}, latch, NOW + MIN);
  assert.equal(r.decision, 'WARN');
});

test('reset imminent -> suppressed (cheap cliff)', () => {
  const soon = Math.floor((NOW + 10 * MIN) / 1000);
  const r = decide(state(90, 30, { reset5h: soon }), {}, {}, NOW);
  assert.equal(r.decision, 'NONE');
  assert.match(r.reasons.join(), /suppressed/);
});

test('both windows crossed -> one WARN listing both', () => {
  const r = decide(state(88, 91), {}, {}, NOW);
  assert.equal(r.decision, 'WARN');
  assert.equal(r.windows.length, 2);
  assert.equal(r.newLatchKeys.length, 2);
});

test('custom warn_at respected; bogus warn_at falls back to defaults', () => {
  const r = decide(state(55, 30), { warn_at: [50, 90] }, {}, NOW);
  assert.equal(r.decision, 'WARN');
  assert.equal(r.windows[0].level, 50);

  const r2 = decide(state(72, 30), { warn_at: 'nonsense' }, {}, NOW);
  assert.equal(r2.decision, 'WARN');
  assert.equal(r2.windows[0].level, 70);
});

test('buildWarning renders numbers, reset, burn and headroom', () => {
  const s = state(86, 30, {
    burn: { five_hour: { pctPerHour: 3.5, pairsUsed: 4, spanMs: 600000, lastUtil: 86, lastTs: NOW } },
  });
  const r = decide(s, {}, {}, NOW);
  const text = buildWarning(r, NOW);
  assert.match(text, /\[limit-wrapup\]/);
  assert.match(text, /86% of usage budget consumed/);
  assert.match(text, /resets/);
  assert.match(text, /3\.5%\/h/);
  assert.match(text, /4h of headroom/); // (100-86)/3.5 = 4
  // WARN is informational only — it must NOT tell the model to wrap or invoke the skill
  assert.match(text, /heads-up/i);
  assert.match(text, /keep working/i);
  assert.doesNotMatch(text, /wrapping-up skill/);
  assert.doesNotMatch(text, /wrap up cleanly soon/);
});

test('latchKey is stable and reset-scoped', () => {
  assert.equal(latchKey('five_hour', '1783288800', 70), 'five_hour:1783288800:70');
  assert.equal(latchKey('five_hour', undefined, 70), 'five_hour:none:70');
});

test('per-window warn_at object honored independently', () => {
  const cfg = { warn_at: { five_hour: [70, 85], seven_day: [80, 92] } };
  const r = decide(state(30, 81), cfg, {}, NOW);
  assert.equal(r.decision, 'WARN');
  assert.equal(r.windows.length, 1);
  assert.equal(r.windows[0].window, 'seven_day');
  assert.equal(r.windows[0].level, 80);

  const r2 = decide(state(30, 78), cfg, {}, NOW); // 78 < weekly 80, and > nothing on 5h
  assert.equal(r2.decision, 'NONE');

  const r3 = decide(state(72, 30), { warn_at: { five_hour: 'bogus', seven_day: [80] } }, {}, NOW);
  assert.equal(r3.windows[0].level, 70); // bogus five_hour falls back to defaults
});

test('effectiveReserve: measured x margin wins, tier fallback until then, clamped', () => {
  assert.equal(effectiveReserve(mergeConfig({})), 3); // default plan pro
  assert.equal(effectiveReserve(mergeConfig({ plan: 'max_20x' })), 1);
  assert.equal(effectiveReserve(mergeConfig({ plan: 'max_20x', wrapup_cost_measured: 1 })), 2.5);
  assert.equal(effectiveReserve(mergeConfig({ wrapup_cost_measured: 0.1 })), 0.5); // min clamp
  assert.equal(effectiveReserve(mergeConfig({ wrapup_cost_measured: 20 })), 10); // max clamp
});

test('effectiveReserve: explicit reserve_pct override wins over measured, clamped', () => {
  // The single adjustable knob: wrap at (100 - reserve_pct)%
  assert.equal(effectiveReserve(mergeConfig({ reserve_pct: 1.5, wrapup_cost_measured: 0.5 })), 1.5);
  assert.equal(effectiveReserve(mergeConfig({ reserve_pct: 2 })), 2);
  assert.equal(effectiveReserve(mergeConfig({ reserve_pct: 0.1 })), 0.5); // min clamp
  assert.equal(effectiveReserve(mergeConfig({ reserve_pct: 50 })), 10); // max clamp
});

test('reserve_pct sets the auto-wrap point: reserve_pct 1.5 -> wraps at 98.5%, not 90%', () => {
  const cfg = { mode: 'auto', reserve_pct: 1.5 };
  assert.equal(decide(state(30, 90), cfg, {}, NOW).decision, 'WARN'); // 90% weekly: heads-up only, NOT a wrap
  assert.equal(decide(state(30, 98), cfg, {}, NOW).decision, 'WARN'); // 98% still below the 98.5 line
  const r = decide(state(30, 99), cfg, {}, NOW); // 99% >= 98.5 -> wrap
  assert.equal(r.decision, 'WRAPUP');
  assert.equal(r.windows[0].window, 'seven_day');
});

test('auto mode: inside the reserve -> WRAPUP, latched once, silent after', () => {
  const cfg = { mode: 'auto', wrapup_cost_measured: 1 }; // reserve 2.5 -> fires at 97.5
  const latch = {};
  const r1 = decide(state(98, 30), cfg, latch, NOW);
  assert.equal(r1.decision, 'WRAPUP');
  assert.equal(r1.windows[0].level, 'wrapup');
  assert.match(r1.reasons.join(), /WRAPUP/);
  r1.newLatchKeys.forEach((k) => (latch[k] = NOW));

  const r2 = decide(state(99, 30), cfg, latch, NOW + MIN);
  assert.equal(r2.decision, 'NONE');
  assert.match(r2.reasons.join(), /wrapup already latched/);
});

test('warn mode never emits WRAPUP even at 99%', () => {
  const r = decide(state(99, 30), { wrapup_cost_measured: 1 }, {}, NOW);
  assert.equal(r.decision, 'WARN');
  assert.equal(r.windows[0].level, 85);
});

test('auto mode WRAPUP suppressed when reset imminent (cheap cliff)', () => {
  const soon = Math.floor((NOW + 10 * MIN) / 1000);
  const r = decide(state(99, 30, { reset5h: soon }), { mode: 'auto' }, {}, NOW);
  assert.equal(r.decision, 'NONE');
  assert.match(r.reasons.join(), /suppressed/);
});

test('auto mode below the reserve line still warns normally', () => {
  const r = decide(state(88, 30), { mode: 'auto', wrapup_cost_measured: 1 }, {}, NOW);
  assert.equal(r.decision, 'WARN');
  assert.equal(r.windows[0].level, 85);
});

test('buildWrapup is a directive naming the skill', () => {
  const r = decide(state(98, 30), { mode: 'auto', wrapup_cost_measured: 1 }, {}, NOW);
  const text = buildWrapup(r, NOW);
  assert.match(text, /\[limit-wrapup\] WRAPUP directive/);
  assert.match(text, /wrapping-up skill NOW/);
  assert.match(text, /98% of usage budget consumed/);
  assert.match(text, /2\.5%/); // reserve rendered
  assert.match(text, /carry adopt|continue-after-reset/);
});

test('buildWarning is informational: states the auto-wrap point, does not push a wrap', () => {
  const r = decide(state(86, 30), {}, {}, NOW); // default reserve 3 -> wrap point 97%
  const text = buildWarning(r, NOW);
  assert.match(text, /heads-up/i);
  assert.match(text, /97%/); // (100 - reserve) auto-wrap point stated
  assert.doesNotMatch(text, /wrapping-up skill/); // never tells the model to wrap
});
