'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { validateConfig } = require('../bin/validate-config');

const REPO = path.join(__dirname, '..');

test('the shipped config.example.json is valid (guards schema/validator drift)', () => {
  const c = JSON.parse(fs.readFileSync(path.join(REPO, 'config.example.json'), 'utf8'));
  assert.deepEqual(validateConfig(c), []);
});

test('an empty config is valid (every field is optional, fail-open)', () => {
  assert.deepEqual(validateConfig({}), []);
});

test('non-object config is rejected with one clear message', () => {
  assert.equal(validateConfig(null).length, 1);
  assert.equal(validateConfig([]).length, 1);
  assert.equal(validateConfig('nope').length, 1);
});

test('collects ALL problems at once, in plain language', () => {
  const bad = {
    mode: 'turbo',
    plan: 'ultra',
    reserve_pct: 99,
    warn_at: [0, 150],
    wrapup_reserve_margin: -1,
    stale_after_min: 0,
    budgetcap: 5, // typo'd unknown key
  };
  const problems = validateConfig(bad);
  assert.ok(problems.length >= 6, `expected several problems, got ${problems.length}`);
  assert.ok(problems.some((p) => p.includes('mode')));
  assert.ok(problems.some((p) => p.includes('plan')));
  assert.ok(problems.some((p) => p.includes('reserve_pct')));
  assert.ok(problems.some((p) => p.includes('budgetcap')));
});

test('accepts the per-window warn_at object form', () => {
  assert.deepEqual(validateConfig({ warn_at: { five_hour: [80], seven_day: [70, 90] } }), []);
});

test('rejects a bogus per-window warn_at and unknown window', () => {
  const problems = validateConfig({ warn_at: { five_hour: [200], daily: [50] } });
  assert.ok(problems.some((p) => p.includes('five_hour')));
  assert.ok(problems.some((p) => p.includes('daily')));
});

test('reserve_pct null is allowed (means: derive from measured/fallback)', () => {
  assert.deepEqual(validateConfig({ reserve_pct: null, wrapup_cost_measured: null }), []);
});
