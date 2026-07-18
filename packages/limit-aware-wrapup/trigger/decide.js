'use strict';
// Decision engine for the trigger hook (Phase 2+). Pure and synchronous: all I/O
// (state file, config, latches, hook stdin/stdout) lives in check.js.
// Fail-open contract: malformed anything -> NONE with a reason, never a throw.
//
// Decisions: NONE | WARN (configured thresholds, fit delegated to the model) |
// WRAPUP (mode 'auto' only: remaining budget is inside the wrap-up reserve ->
// directive to run the ritual NOW). All latched once per session+window+reset,
// suppressed near a reset (cheap cliff).

const { extractUtil, extractReset } = require('../sensor/burnrate');

const WINDOWS = ['five_hour', 'seven_day'];
const WINDOW_LABEL = { five_hour: '5h window', seven_day: 'weekly window' };

const CONFIG_DEFAULTS = {
  enabled: true,
  // 'warn' (attended: only an informational heads-up, never forces a wrap) |
  // 'auto' (unattended: also emits a hard WRAPUP directive once a window is inside the reserve).
  mode: 'warn',
  plan: 'pro', // picks the reserve fallback ONLY until wrapup_cost_measured lands; pro = most conservative
  warn_at: [70, 85], // heads-up thresholds; flat array applies to both windows, or { five_hour:[..], seven_day:[..] }
  // The single knob for the auto-wrap point: it fires at (100 - reserve)%. Set reserve_pct
  // directly (e.g. 1.5 -> wrap at 98.5%) to override the measured value below.
  reserve_pct: null,
  wrapup_cost_measured: null, // account-% one ritual costs; written by the calibration runs
  wrapup_reserve_margin: 2.5, // reserve = measured x margin (ritual cost varies with context/diff size)
  fallback_reserve_pct: { pro: 3, max_5x: 2, max_10x: 1.5, max_20x: 1 },
  dry_run: true, // flipped off deliberately once the dry-run log looks sane over a real day
  notify: true, // show a native desktop notification when an (unattended) WRAPUP fires, so it's seen
  stale_after_min: 10,
  suppress_warn_if_reset_within_min: 15,
};

function validThresholds(a) {
  return Array.isArray(a) && a.length > 0 && a.every((n) => typeof n === 'number' && n > 0 && n < 100);
}

// Normalizes warn_at to { five_hour: [asc], seven_day: [asc] }; bogus input -> defaults.
function mergeConfig(userConfig) {
  const cfg = Object.assign({}, CONFIG_DEFAULTS, userConfig || {});
  const raw = cfg.warn_at;
  const perWindow = {};
  for (const w of WINDOWS) {
    let a = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? raw[w] : undefined;
    if (!validThresholds(a)) a = CONFIG_DEFAULTS.warn_at;
    perWindow[w] = [...a].sort((x, y) => x - y);
  }
  cfg.warn_at = perWindow;
  if (cfg.mode !== 'auto') cfg.mode = 'warn';
  return cfg;
}

// Account-% held back so the wrap-up ritual can still run; the auto-wrap fires at
// (100 - reserve)%. Precedence: explicit reserve_pct override > measured x margin >
// plan-tier fallback (only until calibration writes a value). Clamped [0.5, 10].
function effectiveReserve(cfg) {
  if (typeof cfg.reserve_pct === 'number' && isFinite(cfg.reserve_pct) && cfg.reserve_pct > 0) {
    return Math.max(0.5, Math.min(10, cfg.reserve_pct));
  }
  const m = cfg.wrapup_cost_measured;
  const margin = typeof cfg.wrapup_reserve_margin === 'number' && cfg.wrapup_reserve_margin > 0
    ? cfg.wrapup_reserve_margin : CONFIG_DEFAULTS.wrapup_reserve_margin;
  let r;
  if (typeof m === 'number' && isFinite(m) && m > 0) r = m * margin;
  else {
    const fb = cfg.fallback_reserve_pct || CONFIG_DEFAULTS.fallback_reserve_pct;
    r = typeof fb[cfg.plan] === 'number' ? fb[cfg.plan] : CONFIG_DEFAULTS.fallback_reserve_pct.pro;
  }
  return Math.max(0.5, Math.min(10, r));
}

function latchKey(windowKey, resetId, level) {
  return windowKey + ':' + (resetId || 'none') + ':' + level;
}

// state: sensor state.json content ({samples, burn}).
// latch: object of latchKey -> ts for THIS session (check.js scopes it).
// Returns { decision: 'NONE'|'WARN'|'WRAPUP', reasons, windows, newLatchKeys, reserve }
function decide(state, config, latch, nowMs) {
  const cfg = mergeConfig(config);
  const reserve = effectiveReserve(cfg);
  const out = { decision: 'NONE', reasons: [], windows: [], newLatchKeys: [], reserve };
  if (!cfg.enabled) return reason(out, 'disabled');
  // `stale: true` on the unknown-state branches tells check.js a background
  // OAuth usage refresh is worth spawning (fallback sensor).
  if (!state || !Array.isArray(state.samples) || state.samples.length === 0) {
    out.stale = true;
    return reason(out, 'no samples (sensor never fired or state missing)');
  }

  const last = lastValidSample(state.samples);
  if (!last) { out.stale = true; return reason(out, 'no valid samples'); }
  if (nowMs - last.ts > cfg.stale_after_min * 60000) {
    out.stale = true;
    return reason(out, `state stale (${Math.round((nowMs - last.ts) / 60000)} min old > ${cfg.stale_after_min}) -> unknown -> silent`);
  }

  for (const w of WINDOWS) {
    const util = extractUtil(last.rate_limits, w);
    if (util === undefined) { out.reasons.push(`${w}: no utilization in last sample`); continue; }
    const reset = extractReset(last.rate_limits, w);
    const resetId = reset && reset.id;

    // Cheap cliff: reset imminent -> being cut off costs minutes, acting costs attention
    let nearReset = false;
    if (reset && reset.atMs !== undefined) {
      const minToReset = (reset.atMs - nowMs) / 60000;
      nearReset = minToReset >= 0 && minToReset <= cfg.suppress_warn_if_reset_within_min;
    }

    // Auto mode: remaining budget inside the reserve -> the ritual must run NOW
    if (cfg.mode === 'auto' && util >= 100 - reserve) {
      const key = latchKey(w, resetId, 'wrapup');
      if (latch && latch[key]) { out.reasons.push(`${w}: wrapup already latched this session+window`); continue; }
      if (nearReset) { out.reasons.push(`${w}: ${util}% inside reserve but reset imminent -> suppressed`); continue; }
      out.windows.push({ window: w, util, level: 'wrapup', resetAtMs: reset && reset.atMs, burn: burnFor(state, w) });
      out.newLatchKeys.push(key);
      out.reasons.push(`${w}: ${util}% >= ${round1(100 - reserve)}% (100 - reserve ${round1(reserve)}%) -> WRAPUP`);
      continue;
    }

    // Highest configured threshold this window has crossed
    let level;
    for (const t of cfg.warn_at[w]) if (util >= t) level = t;
    if (level === undefined) { out.reasons.push(`${w}: ${util}% below warn thresholds`); continue; }

    const key = latchKey(w, resetId, level);
    if (latch && latch[key]) { out.reasons.push(`${w}: ${level}% warn already latched this session+window`); continue; }
    if (nearReset) {
      const minToReset = Math.round((reset.atMs - nowMs) / 60000);
      out.reasons.push(`${w}: ${util}% >= ${level}% but reset in ${minToReset} min -> suppressed`);
      continue;
    }

    out.windows.push({ window: w, util, level, resetAtMs: reset && reset.atMs, burn: burnFor(state, w) });
    out.newLatchKeys.push(key);
    out.reasons.push(`${w}: ${util}% crossed ${level}% -> WARN`);
  }

  if (out.windows.some((w) => w.level === 'wrapup')) out.decision = 'WRAPUP';
  else if (out.windows.length > 0) out.decision = 'WARN';
  return out;
}

function burnFor(state, windowKey) {
  const b = state && state.burn && state.burn[windowKey];
  return b && typeof b.pctPerHour === 'number' && isFinite(b.pctPerHour) ? b : null;
}

function lastValidSample(samples) {
  for (let i = samples.length - 1; i >= 0; i--) {
    const s = samples[i];
    if (s && typeof s.ts === 'number' && isFinite(s.ts) && s.rate_limits) return s;
  }
  return null;
}

function reason(out, r) {
  out.reasons.push(r);
  return out;
}

function windowLine(w, nowMs) {
  let line = `${WINDOW_LABEL[w.window] || w.window}: ${round1(w.util)}% of usage budget consumed`;
  if (w.resetAtMs !== undefined && w.resetAtMs > nowMs) {
    const min = Math.round((w.resetAtMs - nowMs) / 60000);
    const d = new Date(w.resetAtMs);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    line += `, resets ${hh}:${mm} (${min >= 120 ? Math.round(min / 60) + 'h' : '~' + min + ' min'})`;
  }
  if (w.burn) {
    line += `; recent burn ~${round1(w.burn.pctPerHour)}%/h across all sessions`;
    if (w.burn.pctPerHour > 0) {
      const hrsLeft = (100 - w.util) / w.burn.pctPerHour;
      line += ` -> ~${round1(hrsLeft)}h of headroom at this rate`;
    }
  }
  return '- ' + line;
}

// Renders the additionalContext for a WARN — an INFORMATIONAL heads-up only. It must
// NOT tell the model to wrap: the owner's policy is to use the budget and let the hard
// WRAPUP directive (auto mode) stop the session near the cliff, not to wrap early on a
// poor task-fit. Wrapping on a warn is the attended owner's choice, or not at all.
function buildWarning(result, nowMs) {
  const lines = result.windows.map((w) => windowLine(w, nowMs));
  const reserve = typeof result.reserve === 'number' ? round1(result.reserve) : null;
  const tail = reserve !== null
    ? `\nThis is an informational heads-up — keep working; a warning is not a stop signal. Your budget is ` +
      `protected automatically: when running UNATTENDED, an auto-wrap triggers only near the cliff ` +
      `(once a window passes ${round1(100 - reserve)}%, leaving ~${reserve}% for the wrap-up itself). ` +
      `Wrap up before then only if you deliberately choose to.`
    : '\nThis is an informational heads-up — keep working; wrap up early only if you deliberately choose to.';
  return (
    '[limit-wrapup] Usage heads-up (fires at most once per threshold per session):\n' +
    lines.join('\n') + tail
  );
}

// Renders the additionalContext for a WRAPUP (mode 'auto'): not a question — a directive.
function buildWrapup(result, nowMs) {
  const lines = result.windows.map((w) => windowLine(w, nowMs));
  return (
    '[limit-wrapup] WRAPUP directive (auto mode): remaining budget is inside the wrap-up reserve' +
    (typeof result.reserve === 'number' ? ` (~${round1(result.reserve)}%)` : '') + ':\n' +
    lines.join('\n') +
    '\nInvoke the wrapping-up skill NOW: finish the current atomic step only, commit WIP to a wip/ branch, ' +
    'write HANDOFF.md with the exact resume command, then stop clean. Do not start new work. ' +
    'If this session is unattended, queue auto-resume (carry adopt / continue-after-reset) before stopping.'
  );
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

module.exports = { decide, buildWarning, buildWrapup, mergeConfig, effectiveReserve, latchKey, CONFIG_DEFAULTS };
