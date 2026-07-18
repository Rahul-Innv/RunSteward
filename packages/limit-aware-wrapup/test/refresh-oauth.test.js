'use strict';
// Unit tests for sensor/refresh-oauth.js (pure parts — the network path is
// guarded by LIMIT_WRAPUP_NO_NET in e2e and untested by design).
// The endpoint's shape (`utilization`, ISO-8601 `resets_at`) differs from the
// statusline's; these tests pin that the verbatim-stored sample still extracts.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// Isolated dir BEFORE the module is required (it resolves STATE at load time).
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'limit-wrapup-oauth-test-'));
process.env.LIMIT_WRAPUP_DIR = DIR;

const { buildSample, appendSample } = require('../sensor/refresh-oauth');
const { extractUtil, extractReset, computeBurnRate } = require('../sensor/burnrate');

const NOW = 1783272000000;
const ENDPOINT_PAYLOAD = {
  five_hour: { utilization: 43, resets_at: '2026-07-05T22:00:00Z' },
  seven_day: { utilization: 61.5, resets_at: '2026-07-11T05:00:00Z' },
  seven_day_opus: null,
  extra_usage: { is_enabled: false },
};

test('buildSample stores endpoint windows verbatim with provenance', () => {
  const s = buildSample(ENDPOINT_PAYLOAD, NOW);
  assert.equal(s.ts, NOW);
  assert.equal(s.src, 'oauth');
  assert.deepEqual(s.rate_limits.five_hour, ENDPOINT_PAYLOAD.five_hour);
  assert.ok(!('extra_usage' in s.rate_limits)); // only the two known windows
});

test('endpoint field names extract through the burnrate fallback keys', () => {
  const s = buildSample(ENDPOINT_PAYLOAD, NOW);
  assert.equal(extractUtil(s.rate_limits, 'five_hour'), 43);
  assert.equal(extractUtil(s.rate_limits, 'seven_day'), 61.5);
  const reset = extractReset(s.rate_limits, 'five_hour');
  assert.equal(reset.atMs, Date.parse('2026-07-05T22:00:00Z')); // ISO string parsed
});

test('burn rate pairs across mixed statusline + oauth samples (same reset instant)', () => {
  // 1783288800 (epoch s) and its ISO form are the SAME instant -> normalized reset
  // ids match -> the cross-source pair is valid and the rate computes.
  const iso = new Date(1783288800 * 1000).toISOString();
  const statuslineSample = {
    ts: NOW - 10 * 60000,
    rate_limits: { five_hour: { used_percentage: 40, resets_at: 1783288800 } },
  };
  const oauthSample = buildSample({ five_hour: { utilization: 43, resets_at: iso } }, NOW);
  const rate = computeBurnRate([statuslineSample, oauthSample], 'five_hour', { nowMs: NOW });
  assert.ok(rate && Math.abs(rate.pctPerHour - 18) < 0.01); // 3% over 10 min
  // A genuinely DIFFERENT reset instant still discards the pair.
  const rolled = buildSample({ five_hour: { utilization: 2, resets_at: new Date(1783288800 * 1000 + 5 * 3600e3).toISOString() } }, NOW);
  assert.equal(computeBurnRate([statuslineSample, rolled], 'five_hour', { nowMs: NOW }), null);
});

test('appendSample: authoritative sample lands; stale-cached statusline regression is dropped', () => {
  const stateFile = path.join(DIR, 'state.json');
  appendSample(buildSample({ five_hour: { utilization: 67, resets_at: '2026-07-05T22:00:00Z' } }, NOW));
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).samples.length, 1);

  // The production bug: an idle TUI re-emits 31% (epoch-seconds reset form) after
  // the endpoint reported 67% for the SAME reset -> dropped, state unchanged.
  appendSample({ ts: NOW + 30000, rate_limits: { five_hour: { used_percentage: 31, resets_at: 1783288800 } } });
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).samples.length, 1);

  // Advancing reading appends; post-rollover low reading appends.
  appendSample({ ts: NOW + 60000, rate_limits: { five_hour: { used_percentage: 68, resets_at: 1783288800 } } });
  appendSample({ ts: NOW + 90000, rate_limits: { five_hour: { used_percentage: 2, resets_at: 1783288800 + 5 * 3600 } } });
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).samples.length, 3);
});

test('malformed payloads -> null, never throw', () => {
  assert.equal(buildSample(null, NOW), null);
  assert.equal(buildSample('nope', NOW), null);
  assert.equal(buildSample({ extra_usage: {} }, NOW), null);
  assert.equal(buildSample({ five_hour: 'bogus' }, NOW), null);
});
