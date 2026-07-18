#!/usr/bin/env node
'use strict';
// Standalone, dependency-free config validator for ~/.claude/limit-wrapup/config.json.
//
// NOTE: this is a FORKER convenience, NOT wired into the runtime. The hook is fail-open by
// design (mergeConfig sanitizes every bad value to a safe default and never throws — a hook
// that blocks a session is worse than no hook). This CLI lets you check your config on demand
// and see, in plain language, which fields would be ignored/clamped before you rely on them.
// It reports ALL problems at once. Field wording mirrors config.schema.json (single source).
//
// Usage:  node bin/validate-config.js [path]
//         CONFIG_PATH=/some/config.json node bin/validate-config.js
// Exit 0 = clean, 1 = problems found (also usable in CI).

const fs = require('fs');
const path = require('path');
const os = require('os');

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isBool = (v) => typeof v === 'boolean';

const MODES = ['warn', 'auto'];
const PLANS = ['pro', 'max_5x', 'max_10x', 'max_20x'];
const WINDOWS = ['five_hour', 'seven_day'];

function validThresholdArray(a) {
  return Array.isArray(a) && a.length > 0 && a.every((n) => isNum(n) && n > 0 && n < 100);
}

/**
 * Validate a parsed config object. Every field is optional; a missing field is never an error.
 * @returns {string[]} plain-language problems; empty array means valid.
 */
function validateConfig(config) {
  if (config == null || typeof config !== 'object' || Array.isArray(config)) {
    return ['config must be a JSON object (the parsed contents of your config.json).'];
  }
  const errors = [];
  const add = (m) => errors.push(m);

  // Typo-catch: only known keys are meaningful (mirrors schema additionalProperties:false).
  const KNOWN = new Set([
    '$schema', 'enabled', 'mode', 'plan', 'warn_at', 'reserve_pct', 'wrapup_cost_measured',
    'wrapup_reserve_margin', 'fallback_reserve_pct', 'dry_run', 'notify', 'stale_after_min',
    'suppress_warn_if_reset_within_min',
  ]);
  for (const k of Object.keys(config)) {
    if (!KNOWN.has(k)) add(`unknown key "${k}" — it will be ignored (check for a typo).`);
  }

  if ('enabled' in config && !isBool(config.enabled)) add('enabled must be true or false — the master kill-switch.');
  if ('dry_run' in config && !isBool(config.dry_run)) add('dry_run must be true or false — true logs only, false injects into the session.');
  if ('notify' in config && !isBool(config.notify)) add('notify must be true or false — show a desktop notification when a WRAPUP fires.');

  if ('mode' in config && !MODES.includes(config.mode)) {
    add(`mode must be one of ${MODES.join(', ')} (got ${JSON.stringify(config.mode)}) — anything else is treated as "warn".`);
  }
  if ('plan' in config && !PLANS.includes(config.plan)) {
    add(`plan must be one of ${PLANS.join(', ')} (got ${JSON.stringify(config.plan)}).`);
  }

  if ('warn_at' in config) {
    const w = config.warn_at;
    if (validThresholdArray(w)) {
      // ok
    } else if (w && typeof w === 'object' && !Array.isArray(w)) {
      for (const win of WINDOWS) {
        if (win in w && !validThresholdArray(w[win])) {
          add(`warn_at.${win} must be a non-empty array of numbers strictly between 0 and 100 (account-%).`);
        }
      }
      for (const k of Object.keys(w)) {
        if (!WINDOWS.includes(k)) add(`warn_at has unknown window "${k}" — expected ${WINDOWS.join(' / ')}.`);
      }
    } else {
      add('warn_at must be a non-empty array of numbers (0-100), or an object with five_hour / seven_day arrays.');
    }
  }

  if ('reserve_pct' in config && config.reserve_pct !== null) {
    if (!isNum(config.reserve_pct) || config.reserve_pct < 0.5 || config.reserve_pct > 10) {
      add('reserve_pct must be a number in [0.5, 10] (account-%), or null — the auto-wrap fires at (100 - reserve_pct)%.');
    }
  }
  if ('wrapup_cost_measured' in config && config.wrapup_cost_measured !== null) {
    if (!isNum(config.wrapup_cost_measured) || config.wrapup_cost_measured <= 0) {
      add('wrapup_cost_measured must be a positive number (account-%), or null.');
    }
  }
  if ('wrapup_reserve_margin' in config && (!isNum(config.wrapup_reserve_margin) || config.wrapup_reserve_margin <= 0)) {
    add('wrapup_reserve_margin must be a positive number (safety factor over the measured wrap cost).');
  }

  if ('fallback_reserve_pct' in config) {
    const fb = config.fallback_reserve_pct;
    if (fb == null || typeof fb !== 'object' || Array.isArray(fb)) {
      add('fallback_reserve_pct must be an object mapping plan -> account-% (e.g. {"pro":3,"max_20x":1}).');
    } else {
      for (const [k, v] of Object.entries(fb)) {
        if (!PLANS.includes(k)) add(`fallback_reserve_pct has unknown plan "${k}" — expected ${PLANS.join(' / ')}.`);
        else if (!isNum(v) || v <= 0) add(`fallback_reserve_pct.${k} must be a positive number (account-%).`);
      }
    }
  }

  if ('stale_after_min' in config && (!isNum(config.stale_after_min) || config.stale_after_min <= 0)) {
    add('stale_after_min must be a positive number of minutes — older samples are treated as unknown -> silent.');
  }
  if ('suppress_warn_if_reset_within_min' in config &&
      (!isNum(config.suppress_warn_if_reset_within_min) || config.suppress_warn_if_reset_within_min < 0)) {
    add('suppress_warn_if_reset_within_min must be a number of minutes >= 0.');
  }

  return errors;
}

function main() {
  const argPath = process.argv[2];
  const configPath = argPath || process.env.CONFIG_PATH ||
    path.join(os.homedir(), '.claude', 'limit-wrapup', 'config.json');

  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (e) {
    console.error(`[validate-config] cannot read ${configPath}: ${e.message}`);
    process.exitCode = 1;
    return;
  }

  let config;
  try {
    config = JSON.parse(raw);
  } catch (e) {
    console.error(`[validate-config] ${configPath} is not valid JSON: ${e.message}`);
    process.exitCode = 1;
    return;
  }

  const problems = validateConfig(config);
  if (problems.length) {
    console.error(`[validate-config] ${configPath} has ${problems.length} problem(s) — the tool would ignore/clamp these to defaults:\n  - ${problems.join('\n  - ')}`);
    process.exitCode = 1;
    return;
  }
  console.log(`[validate-config] ${configPath} is valid.`);
}

if (require.main === module) main();

module.exports = { validateConfig };
