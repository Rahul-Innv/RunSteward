'use strict';
// Burn-rate calculation over sensor samples (Phase 1). Pure functions, zero deps.
// Fail-open contract: bad input -> null (or skipped sample), never throw.
// All quantities are account-% units (the rate_limits % is account-wide, so deltas
// between samples capture ALL concurrent sessions draining the same quota).
//
// Schema pinned from official docs (code.claude.com/docs/en/statusline):
//   rate_limits.{five_hour,seven_day}.{used_percentage: 0-100 decimal, resets_at: epoch SECONDS}
// Each window can be independently absent; rate_limits absent before first API response.
// Fallback key names kept as drift tolerance until a real capture double-confirms.

const WINDOW_KEYS = {
  five_hour: ['five_hour', 'fiveHour', '5h'],
  seven_day: ['seven_day', 'sevenDay', 'weekly', '7d'],
};
const UTIL_KEYS = ['used_percentage', 'utilization', 'used_pct', 'percent'];
const RESET_KEYS = ['resets_at', 'reset_at', 'resets', 'reset'];

const DEFAULTS = {
  lookbackMs: 60 * 60 * 1000, // rate reflects recent activity, not all history
  minSpanMs: 60 * 1000, // below this, noise dominates -> report nothing
  maxPairGapMs: 30 * 60 * 1000, // a huge gap can hide a reset; averaged rate is stale anyway
};

function pickKey(obj, keys) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
}

// Utilization as a 0-100 float. Pinned format is already 0-100 percent — no
// fraction heuristic (it would misread a real 0.5% as 50%).
function extractUtil(rateLimits, windowKey) {
  const win = pickKey(rateLimits, WINDOW_KEYS[windowKey] || [windowKey]);
  let v = pickKey(win, UTIL_KEYS);
  if (typeof v === 'string' && v.trim() !== '') v = Number(v);
  if (typeof v !== 'number' || !isFinite(v)) return undefined;
  if (v < 0) return undefined;
  return Math.min(100, v);
}

// Reset timestamp -> { id, atMs }. `id` is only used for identity comparison
// (did the window roll over between two samples); `atMs` is best-effort epoch ms
// for later time-to-reset math, undefined when unparseable.
// `id` is the PARSED instant rounded to the MINUTE when available, so the same
// reset expressed as epoch seconds (statusline) and ISO-8601 with sub-second
// jitter (oauth endpoint sends e.g. 22:00:00.096482) compares equal — otherwise
// mixed-source samples would break burn pairing and latch suppression. Resets
// land on hour boundaries (verified 2026-07-05), so minute rounding is safe.
function extractReset(rateLimits, windowKey) {
  const win = pickKey(rateLimits, WINDOW_KEYS[windowKey] || [windowKey]);
  const v = pickKey(win, RESET_KEYS);
  if (v === undefined) return undefined;
  let atMs;
  if (typeof v === 'number' && isFinite(v)) {
    atMs = v > 1e12 ? v : v > 1e9 ? v * 1000 : undefined;
  } else if (typeof v === 'string') {
    const parsed = Date.parse(v);
    if (isFinite(parsed)) atMs = parsed;
  }
  return { id: atMs !== undefined ? String(Math.round(atMs / 60000)) : String(v), atMs };
}

// samples: [{ ts: epoch-ms, rate_limits: {...} }, ...] oldest-first (sensor order).
// Returns { pctPerHour, pairsUsed, spanMs, lastUtil, lastTs } or null.
function computeBurnRate(samples, windowKey, opts) {
  const o = Object.assign({}, DEFAULTS, opts);
  if (!Array.isArray(samples) || samples.length < 2) return null;

  // Extract valid points, newest-window only.
  const nowMs = typeof o.nowMs === 'number' ? o.nowMs : lastTs(samples);
  if (nowMs === undefined) return null;
  const points = [];
  for (const s of samples) {
    if (!s || typeof s.ts !== 'number' || !isFinite(s.ts)) continue;
    if (s.ts < nowMs - o.lookbackMs) continue;
    const util = extractUtil(s.rate_limits, windowKey);
    if (util === undefined) continue;
    points.push({ ts: s.ts, util, reset: extractReset(s.rate_limits, windowKey) });
  }
  if (points.length < 2) return null;

  let sumDU = 0;
  let sumDT = 0;
  let pairsUsed = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const dt = b.ts - a.ts;
    if (dt <= 0 || dt > o.maxPairGapMs) continue;
    // Reset detection, two independent signals; either one discards the pair.
    if (a.reset && b.reset && a.reset.id !== b.reset.id) continue;
    const du = b.util - a.util;
    if (du < 0) continue; // utilization only rises within a window; a drop means reset (or glitch)
    sumDU += du;
    sumDT += dt;
    pairsUsed++;
  }
  if (pairsUsed === 0 || sumDT < o.minSpanMs) return null;

  const last = points[points.length - 1];
  return {
    pctPerHour: sumDU / (sumDT / 3600000),
    pairsUsed,
    spanMs: sumDT,
    lastUtil: last.util,
    lastTs: last.ts,
  };
}

// Defends ONLY against idle-TUI-statusline caches: an idle statusline re-emits a whole
// CACHED payload — stale utilization AND its stale `resets_at` — under a fresh timestamp
// (verified live: 2026-07-05 31% vs 67% real within a window; 2026-07-06 67% vs 3% real
// ACROSS a 5h reset). For statusline samples two invariants separate cache from truth:
//   1. A reading citing an OLDER reset instant than one already seen is a pre-reset cache.
//   2. Within the newest reset window, utilization only RISES; a lower reading is stale.
//
// OAuth samples are NEVER regression-dropped: they come straight from the authoritative
// usage endpoint and always reflect current truth. This exception is required, not just
// tidy — the endpoint's seven_day `resets_at` can jitter EARLIER between polls (observed
// 2026-07-07: history 21:00, next poll 17:00), and invariant (1) would then wrongly drop
// every current weekly reading, blinding the weekly window exactly when it matters most
// (the 2026-07-07 soak: no weekly warning fired at 90% because of this). So `resets_at`
// is NOT reliably monotonic on the weekly window; only trust the reset ordering for the
// possibly-cached statusline source, never to reject the authoritative source.
//
// Returns the sample with untrustworthy windows removed (normalized to canonical names),
// or null when nothing trustworthy remains.
function dropRegressions(samples, sample) {
  if (!sample || !sample.rate_limits || typeof sample.rate_limits !== 'object') return null;
  const trusted = sample.src === 'oauth';
  const rl = {};
  for (const w of Object.keys(WINDOW_KEYS)) {
    const win = pickKey(sample.rate_limits, WINDOW_KEYS[w]);
    if (win === undefined) continue;
    const util = trusted ? undefined : extractUtil(sample.rate_limits, w);
    if (util !== undefined) {
      const reset = extractReset(sample.rate_limits, w);
      const atMs = reset && reset.atMs;
      const base = windowBaseline(samples, w);
      if (atMs !== undefined && base.newestResetMs !== undefined) {
        if (atMs < base.newestResetMs) continue; // (1) older reset window -> stale
        if (atMs === base.newestResetMs && base.maxUtil !== undefined && util < base.maxUtil) continue; // (2)
      } else {
        // No reset instant to anchor on -> fall back to a last-reading same-id compare.
        const prev = lastWindowReading(samples, w);
        if (prev && reset && prev.reset && prev.reset.id === reset.id && util < prev.util) continue;
      }
    }
    rl[w] = win;
  }
  return Object.keys(rl).length ? Object.assign({}, sample, { rate_limits: rl }) : null;
}

// Newest reset instant seen for a window, and the max utilization within THAT window.
// Uses maxima (not the last sample) so an already-polluted history can't skew the
// baseline: a stale-high reading carries an old reset instant and never wins newestResetMs.
function windowBaseline(samples, windowKey) {
  let newestResetMs;
  let maxUtil;
  if (Array.isArray(samples)) {
    for (const s of samples) {
      if (!s || !s.rate_limits) continue;
      const util = extractUtil(s.rate_limits, windowKey);
      if (util === undefined) continue;
      const reset = extractReset(s.rate_limits, windowKey);
      const atMs = reset && reset.atMs;
      if (atMs === undefined) continue;
      if (newestResetMs === undefined || atMs > newestResetMs) {
        newestResetMs = atMs;
        maxUtil = util; // new window resets the max
      } else if (atMs === newestResetMs && (maxUtil === undefined || util > maxUtil)) {
        maxUtil = util;
      }
    }
  }
  return { newestResetMs, maxUtil };
}

function lastWindowReading(samples, windowKey) {
  if (!Array.isArray(samples)) return null;
  for (let i = samples.length - 1; i >= 0; i--) {
    const s = samples[i];
    if (!s || !s.rate_limits) continue;
    const util = extractUtil(s.rate_limits, windowKey);
    if (util === undefined) continue;
    return { util, reset: extractReset(s.rate_limits, windowKey) };
  }
  return null;
}

function lastTs(samples) {
  for (let i = samples.length - 1; i >= 0; i--) {
    const s = samples[i];
    if (s && typeof s.ts === 'number' && isFinite(s.ts)) return s.ts;
  }
  return undefined;
}

module.exports = { computeBurnRate, extractUtil, extractReset, dropRegressions, DEFAULTS };
