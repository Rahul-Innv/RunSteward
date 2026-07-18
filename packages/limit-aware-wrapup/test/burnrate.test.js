'use strict';
// Synthetic-sample tests for sensor/burnrate.js (Phase 1). Run: node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const { computeBurnRate, extractUtil, extractReset, dropRegressions } = require('../sensor/burnrate');

const T0 = 1751700000000; // fixed epoch ms base; no wall-clock dependence
const MIN = 60 * 1000;

// Sample factory in the pinned schema (docs: used_percentage 0-100, resets_at epoch seconds).
function s(ts, fiveHourPct, resetSec, sevenDayPct) {
  const rl = {};
  if (fiveHourPct !== undefined) {
    rl.five_hour = { used_percentage: fiveHourPct };
    if (resetSec !== undefined) rl.five_hour.resets_at = resetSec;
  }
  if (sevenDayPct !== undefined) rl.seven_day = { used_percentage: sevenDayPct };
  return { ts, rate_limits: rl };
}

test('null on empty, non-array, and single-sample input', () => {
  assert.equal(computeBurnRate([], 'five_hour'), null);
  assert.equal(computeBurnRate(null, 'five_hour'), null);
  assert.equal(computeBurnRate([s(T0, 10)], 'five_hour'), null);
});

test('steady burn: 0.5%/min over 3 minutes -> 30%/hour', () => {
  const samples = [s(T0, 10), s(T0 + MIN, 10.5), s(T0 + 2 * MIN, 11), s(T0 + 3 * MIN, 11.5)];
  const r = computeBurnRate(samples, 'five_hour');
  assert.ok(r);
  assert.ok(Math.abs(r.pctPerHour - 30) < 1e-9, `got ${r.pctPerHour}`);
  assert.equal(r.pairsUsed, 3);
  assert.equal(r.lastUtil, 11.5);
});

test('pair spanning a reset (utilization drop) is discarded, neighbors survive', () => {
  const samples = [s(T0, 90), s(T0 + MIN, 95), s(T0 + 2 * MIN, 3), s(T0 + 3 * MIN, 4)];
  const r = computeBurnRate(samples, 'five_hour');
  assert.ok(r);
  assert.equal(r.pairsUsed, 2); // 90->95 and 3->4; 95->3 dropped
  // (5 + 1) % over 2 minutes = 180%/hour
  assert.ok(Math.abs(r.pctPerHour - 180) < 1e-9, `got ${r.pctPerHour}`);
});

test('resets_at identity change discards the pair even when utilization rises', () => {
  const resetA = 1751703600;
  const resetB = 1751721600;
  const samples = [s(T0, 90, resetA), s(T0 + MIN, 91, resetA), s(T0 + 2 * MIN, 92, resetB)];
  const r = computeBurnRate(samples, 'five_hour');
  assert.ok(r);
  assert.equal(r.pairsUsed, 1); // only the resetA->resetA pair
});

test('all pairs spanning resets -> null, not NaN or crash', () => {
  const samples = [s(T0, 95), s(T0 + MIN, 3)];
  assert.equal(computeBurnRate(samples, 'five_hour'), null);
});

test('malformed samples are skipped without throwing', () => {
  const samples = [
    null,
    { ts: 'yesterday', rate_limits: { five_hour: { used_percentage: 5 } } },
    s(T0, 10),
    { ts: T0 + MIN }, // no rate_limits
    { ts: T0 + 2 * MIN, rate_limits: { five_hour: { used_percentage: 'lots' } } },
    s(T0 + 3 * MIN, 13),
  ];
  const r = computeBurnRate(samples, 'five_hour');
  assert.ok(r);
  assert.equal(r.pairsUsed, 1); // only 10 -> 13 over 3 min
  assert.ok(Math.abs(r.pctPerHour - 60) < 1e-9, `got ${r.pctPerHour}`);
});

test('windows are independent: seven_day computed from its own fields', () => {
  const samples = [s(T0, 50, undefined, 20), s(T0 + 2 * MIN, 51, undefined, 20.1)];
  const r = computeBurnRate(samples, 'seven_day');
  assert.ok(r);
  assert.ok(Math.abs(r.pctPerHour - 3) < 1e-9, `got ${r.pctPerHour}`);
});

test('lookback window excludes old samples', () => {
  const samples = [
    s(T0 - 2 * 60 * MIN, 0), // 2h old: outside default 1h lookback
    s(T0, 10),
    s(T0 + 2 * MIN, 11),
  ];
  const r = computeBurnRate(samples, 'five_hour', { nowMs: T0 + 2 * MIN });
  assert.ok(r);
  assert.equal(r.pairsUsed, 1);
  assert.ok(Math.abs(r.pctPerHour - 30) < 1e-9, `got ${r.pctPerHour}`);
});

test('duplicate/backwards timestamps and oversized gaps are discarded', () => {
  const samples = [
    s(T0, 10),
    s(T0, 11), // dt = 0
    s(T0 - MIN, 12), // dt < 0
  ];
  assert.equal(computeBurnRate(samples, 'five_hour'), null);

  const gappy = [s(T0, 10), s(T0 + 45 * MIN, 40)]; // gap > maxPairGapMs (30 min)
  assert.equal(computeBurnRate(gappy, 'five_hour', { lookbackMs: 2 * 60 * MIN }), null);
});

test('total span below minSpanMs -> null (noise guard)', () => {
  const samples = [s(T0, 10), s(T0 + 20 * 1000, 10.2)]; // 20s < 60s min span
  assert.equal(computeBurnRate(samples, 'five_hour'), null);
});

test('zero burn over a valid span reports 0, not null', () => {
  const samples = [s(T0, 42), s(T0 + 5 * MIN, 42)];
  const r = computeBurnRate(samples, 'five_hour');
  assert.ok(r);
  assert.equal(r.pctPerHour, 0);
});

test('extractUtil: pinned key, no fraction heuristic, clamping, fallback keys', () => {
  assert.equal(extractUtil({ five_hour: { used_percentage: 23.5 } }, 'five_hour'), 23.5);
  // 0.5 means 0.5%, NOT 50%
  assert.equal(extractUtil({ five_hour: { used_percentage: 0.5 } }, 'five_hour'), 0.5);
  assert.equal(extractUtil({ five_hour: { used_percentage: 250 } }, 'five_hour'), 100);
  assert.equal(extractUtil({ five_hour: { used_percentage: -1 } }, 'five_hour'), undefined);
  assert.equal(extractUtil({ five_hour: { utilization: 12 } }, 'five_hour'), 12); // drift fallback
  assert.equal(extractUtil(undefined, 'five_hour'), undefined);
  assert.equal(extractUtil({}, 'five_hour'), undefined);
});

test('extractReset: epoch seconds normalized to ms, id stable for comparison', () => {
  const r = extractReset({ five_hour: { used_percentage: 1, resets_at: 1751703600 } }, 'five_hour');
  assert.ok(r);
  assert.equal(r.atMs, 1751703600000);
  // id = parsed instant rounded to the minute, so epoch-seconds (statusline) and
  // ISO-8601-with-sub-second-jitter (oauth endpoint) forms of the SAME reset compare equal
  assert.equal(r.id, String(1751703600000 / 60000));
  assert.equal(extractReset({ five_hour: { used_percentage: 1, resets_at: '2025-07-05T08:20:00.096482+00:00' } }, 'five_hour').id, r.id);
  assert.equal(extractReset({ five_hour: { used_percentage: 1 } }, 'five_hour'), undefined);
});

test('dropRegressions: stale-cached lower readings dropped, legitimate ones kept', () => {
  const prev = [{ ts: 1, rate_limits: {
    five_hour: { used_percentage: 67, resets_at: 1783288800 },
    seven_day: { used_percentage: 56, resets_at: 1783803600 },
  } }];

  // Full regression (idle-TUI cached value) -> nothing survives
  assert.equal(dropRegressions(prev, { ts: 2, rate_limits: { five_hour: { used_percentage: 31, resets_at: 1783288800 } } }), null);

  // Partial: five_hour regresses, seven_day advances -> only seven_day survives
  const part = dropRegressions(prev, { ts: 2, rate_limits: {
    five_hour: { used_percentage: 31, resets_at: 1783288800 },
    seven_day: { used_percentage: 57, resets_at: 1783803600 },
  } });
  assert.equal(part.rate_limits.five_hour, undefined);
  assert.equal(part.rate_limits.seven_day.used_percentage, 57);

  // Equal reading kept (no burn is legitimate)
  assert.ok(dropRegressions(prev, { ts: 2, rate_limits: { five_hour: { used_percentage: 67, resets_at: 1783288800 } } }));

  // New reset id -> lower utilization is a genuine rollover, kept
  assert.ok(dropRegressions(prev, { ts: 2, rate_limits: { five_hour: { used_percentage: 2, resets_at: 1783288800 + 5 * 3600 } } }));

  // Cross-source: ISO form of the SAME reset still detected as regression
  assert.equal(dropRegressions(prev, { ts: 2, rate_limits: { five_hour: { utilization: 31, resets_at: new Date(1783288800000).toISOString() } } }), null);

  // No history / malformed -> first sample kept / null, never throws
  assert.ok(dropRegressions([], { ts: 1, rate_limits: { five_hour: { used_percentage: 5, resets_at: 1783288800 } } }));
  assert.equal(dropRegressions(prev, null), null);
  assert.equal(dropRegressions(prev, { ts: 2, rate_limits: {} }), null);
});

test('dropRegressions: OAuth samples are authoritative — kept even if their reset jittered EARLIER', () => {
  // Regression for the 2026-07-07 weekly-blindness bug: the endpoint's seven_day resets_at
  // moved 21:00 -> 17:00 between polls, and the monotonic-reset rule dropped every current
  // weekly reading, so the tool never warned at 90% weekly.
  const later = 1783803600000; // Jul 11 21:00 (already in history)
  const earlier = later - 4 * 3600e3; // Jul 11 17:00 (next poll reports this EARLIER reset)
  const hist = [{ ts: 1, src: 'oauth', rate_limits: { seven_day: { utilization: 81, resets_at: new Date(later).toISOString() } } }];
  // OAuth reading citing the earlier reset MUST survive (authoritative)
  const oauthFresh = { ts: 2, src: 'oauth', rate_limits: { seven_day: { utilization: 90, resets_at: new Date(earlier).toISOString() } } };
  const kept = dropRegressions(hist, oauthFresh);
  assert.ok(kept && kept.rate_limits.seven_day, 'oauth weekly must survive a jittered-earlier reset');
  assert.equal(extractUtil(kept.rate_limits, 'seven_day'), 90);
  // A STATUSLINE sample (no src) citing the earlier reset is still treated as a stale cache
  const slStale = { ts: 3, rate_limits: { seven_day: { utilization: 90, resets_at: new Date(earlier).toISOString() } } };
  assert.equal(dropRegressions(hist, slStale), null);
});

test('dropRegressions: stale-high cache ACROSS a reset (old reset instant) is dropped', () => {
  // The 2026-07-06 production bug: 5h reset from 67% (reset R1) down to 3% (reset R2).
  // The authoritative low reading has already landed; an idle session then re-emits its
  // whole cached payload — 67% AND the OLD R1 resets_at. A same-id check misses it
  // (ids differ); the monotonic-reset rule catches it (R1 < R2 -> stale).
  const R1 = 1783312800; // earlier 5h reset (epoch seconds)
  const R2 = R1 + 5 * 3600; // the reset that actually happened
  const hist = [
    { ts: 1, rate_limits: { five_hour: { used_percentage: 67, resets_at: R1 } } },
    { ts: 2, rate_limits: { five_hour: { utilization: 3, resets_at: new Date(R2 * 1000).toISOString() } } }, // oauth truth
  ];
  // Idle statusline re-emits cached 67% citing the OLD reset -> dropped entirely
  assert.equal(dropRegressions(hist, { ts: 3, rate_limits: { five_hour: { used_percentage: 67, resets_at: R1 } } }), null);
  // A genuine rise within the NEW window (>=3%, reset R2) is kept
  assert.ok(dropRegressions(hist, { ts: 3, rate_limits: { five_hour: { used_percentage: 6, resets_at: R2 } } }));
  // baseline uses maxima, so a polluted history (stale-high last) still anchors on R2
  const polluted = hist.concat([{ ts: 3, rate_limits: { five_hour: { used_percentage: 67, resets_at: R1 } } }]);
  assert.equal(dropRegressions(polluted, { ts: 4, rate_limits: { five_hour: { used_percentage: 67, resets_at: R1 } } }), null);
});
