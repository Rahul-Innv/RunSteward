import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { consumeClaudeLimitState, CLAUDE_LIMIT_METRICS } from "../src/index.mjs";
import { assertProviderEvidence } from "../../runsteward-core/src/provider-evidence.mjs";

const require = createRequire(import.meta.url);
const { decide } = require("../../limit-aware-wrapup/trigger/decide.js");
const { extractUtil } = require("../../limit-aware-wrapup/sensor/burnrate.js");
const NOW = 1_751_700_000_000;
const RAW = Object.freeze({ ref: "evidence/raw/claude-limit-state.redacted.json", digest: "sha256:" + "a".repeat(64), media_type: "application/json" });

test("Claude sensor consumes legacy state into typed non-decision evidence", () => {
  const state = {
    samples: [{ ts: NOW, src: "statusline", rate_limits: { five_hour: { used_percentage: 98 }, seven_day: { used_percentage: 30 } } }],
    burn: { five_hour: { pctPerHour: 3.5 } }
  };
  const evidence = consumeClaudeLimitState(state, { observedAt: "2026-07-15T12:00:00Z", rawEvidenceRef: RAW });
  assert.equal(assertProviderEvidence(evidence, { metricRegistry: CLAUDE_LIMIT_METRICS }), true);
  assert.deepEqual(evidence.metrics.map((item) => [item.metric, item.value, item.unit]), [
    ["runsteward.claude.five-hour-used-percent", "98", "account-percent"],
    ["runsteward.claude.five-hour-burn-rate", "3.5", "account-percent-per-hour"],
    ["runsteward.claude.seven-day-used-percent", "30", "account-percent"]
  ]);
  assert.equal(Object.hasOwn(evidence, "decision"), false);
  assert.equal(Object.hasOwn(evidence, "action"), false);
  assert.equal(decide(state, { mode: "auto", wrapup_cost_measured: 1 }, {}, NOW).decision, "WRAPUP");
});

test("Claude OAuth sample is verified while missing state remains unknown", () => {
  const oauth = consumeClaudeLimitState({ samples: [{ ts: NOW, src: "oauth", rate_limits: { five_hour: { utilization: 12.5 } } }] }, { observedAt: "2026-07-15T12:00:00Z", rawEvidenceRef: RAW });
  assert.equal(oauth.source_status, "verified");
  assert.equal(oauth.metrics[0].confidence, "verified");
  const unknown = consumeClaudeLimitState(null, { observedAt: "2026-07-15T12:00:00Z", rawEvidenceRef: RAW });
  assert.equal(unknown.source_status, "unknown");
  assert.deepEqual(unknown.metrics, []);
  assert.equal(decide(null, {}, {}, NOW).decision, "NONE");
});

test("Claude typed metrics preserve the imported Limit-Aware extractor semantics", () => {
  const state = { samples: [{ ts: NOW, rate_limits: { fiveHour: { percent: 120 }, weekly: { utilization: "12.5" } } }] };
  const evidence = consumeClaudeLimitState(state, { observedAt: "2026-07-15T12:00:00Z", rawEvidenceRef: RAW });
  const values = Object.fromEntries(evidence.metrics.map((item) => [item.metric, item.value]));
  assert.equal(values["runsteward.claude.five-hour-used-percent"], String(extractUtil(state.samples[0].rate_limits, "five_hour")));
  assert.equal(values["runsteward.claude.seven-day-used-percent"], String(extractUtil(state.samples[0].rate_limits, "seven_day")));
  assert.equal(values["runsteward.claude.five-hour-used-percent"], "100");
  assert.equal(values["runsteward.claude.seven-day-used-percent"], "12.5");
});
