import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { consumeCodexUsageAnalysis, CODEX_USAGE_METRICS } from "../src/index.mjs";
import { assertProviderEvidence } from "../../runsteward-core/src/provider-evidence.mjs";

const RAW = Object.freeze({ ref: "evidence/raw/codex-events.redacted.jsonl", digest: "sha256:" + "b".repeat(64), media_type: "application/x-ndjson" });

function nightwatchAnalysis() {
  const scriptPath = fileURLToPath(new URL("../../codex-nightwatch/scripts/nightwatch.py", import.meta.url));
  const fixturePath = fileURLToPath(new URL("../../codex-nightwatch/tests/sample_codex_events.jsonl", import.meta.url));
  const result = spawnSync(process.env.RUNSTEWARD_PYTHON || "python", [
    scriptPath, "analyze", "--jsonl", fixturePath, "--token-budget", "10000",
    "--reserve-tokens", "1000", "--checkpoint-ratio", "0.7"
  ], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr || "Codex Nightwatch analyze failed");
  return JSON.parse(result.stdout);
}

test("Codex sensor consumes the imported Nightwatch classified analysis without exposing thread identity", () => {
  const analysis = nightwatchAnalysis();
  const evidence = consumeCodexUsageAnalysis(analysis, { observedAt: "2026-07-15T12:00:00Z", rawEvidenceRef: RAW });
  assert.equal(assertProviderEvidence(evidence, { metricRegistry: CODEX_USAGE_METRICS }), true);
  const byMetric = Object.fromEntries(evidence.metrics.map((item) => [item.metric, item.value]));
  assert.equal(byMetric["runsteward.codex.input-tokens"], "1200");
  assert.equal(byMetric["runsteward.codex.cached-input-tokens"], "900");
  assert.equal(byMetric["runsteward.codex.output-tokens"], "300");
  assert.equal(byMetric["runsteward.codex.reasoning-output-tokens"], "100");
  assert.equal(byMetric["runsteward.codex.billable-like-tokens"], "1600");
  assert.equal(byMetric["runsteward.codex.billable-like-tokens"], String(analysis.billable_like_tokens));
  assert.equal(byMetric["runsteward.codex.fresh-pressure-tokens"], String(analysis.fresh_pressure_tokens));
  assert.equal(JSON.stringify(evidence).includes("sample-thread"), false);
  assert.equal(Object.hasOwn(evidence, "decision"), false);
});

test("Codex missing, invalid, or inconsistent classified usage remains unknown and invents no zero metric", () => {
  const missing = consumeCodexUsageAnalysis(null, { observedAt: "2026-07-15T12:00:00Z", rawEvidenceRef: RAW });
  assert.equal(missing.source_status, "unknown");
  assert.deepEqual(missing.metrics, []);
  const invalid = consumeCodexUsageAnalysis({ summary: { turns: 1, input_tokens: -1, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 } }, { observedAt: "2026-07-15T12:00:00Z", rawEvidenceRef: RAW });
  assert.equal(invalid.source_status, "unknown");
  assert.deepEqual(invalid.metrics, []);
  const analysis = nightwatchAnalysis();
  analysis.fresh_pressure_tokens += 1;
  const inconsistent = consumeCodexUsageAnalysis(analysis, { observedAt: "2026-07-15T12:00:00Z", rawEvidenceRef: RAW });
  assert.equal(inconsistent.source_status, "unknown");
  assert.deepEqual(inconsistent.metrics, []);
});
