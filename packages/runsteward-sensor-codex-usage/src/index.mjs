import { createProviderEvidence } from "../../runsteward-core/src/provider-evidence.mjs";

export const CODEX_USAGE_ADAPTER_ID = "runsteward.sensor.codex-usage";
export const CODEX_USAGE_METRICS = Object.freeze({
  "runsteward.codex.turns": "turns",
  "runsteward.codex.input-tokens": "tokens",
  "runsteward.codex.cached-input-tokens": "tokens",
  "runsteward.codex.output-tokens": "tokens",
  "runsteward.codex.reasoning-output-tokens": "tokens",
  "runsteward.codex.billable-like-tokens": "tokens",
  "runsteward.codex.uncached-input-tokens": "tokens",
  "runsteward.codex.fresh-pressure-tokens": "tokens"
});

const SUMMARY_KEYS = Object.freeze([
  "turns",
  "input_tokens",
  "cached_input_tokens",
  "output_tokens",
  "reasoning_output_tokens"
]);

function metric(metricId, value, unit, rawEvidenceRef) {
  return {
    metric: metricId,
    value: String(value),
    unit,
    source_adapter: CODEX_USAGE_ADAPTER_ID,
    confidence: "verified",
    raw_evidence_ref: structuredClone(rawEvidenceRef)
  };
}

function classifiedUsage(analysis) {
  if (!analysis || typeof analysis !== "object" || Array.isArray(analysis)) {
    return { status: "unknown", reason: "codex-nightwatch-analysis-missing" };
  }
  const summary = analysis.summary;
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) {
    return { status: "unknown", reason: "codex-nightwatch-summary-missing" };
  }
  for (const key of SUMMARY_KEYS) {
    if (!Number.isSafeInteger(summary[key]) || summary[key] < 0) {
      return { status: "unknown", reason: "codex-nightwatch-summary-invalid" };
    }
  }
  if (summary.turns === 0) return { status: "unknown", reason: "codex-usage-missing" };

  const expected = {
    billable_like_tokens: summary.input_tokens + summary.output_tokens + summary.reasoning_output_tokens,
    uncached_input_tokens: Math.max(0, summary.input_tokens - summary.cached_input_tokens)
  };
  expected.fresh_pressure_tokens = expected.uncached_input_tokens + summary.output_tokens + summary.reasoning_output_tokens;
  if (!Object.values(expected).every(Number.isSafeInteger)) {
    return { status: "unknown", reason: "codex-derived-usage-total-unsafe" };
  }
  for (const [key, value] of Object.entries(expected)) {
    if (analysis[key] !== value) return { status: "unknown", reason: "codex-nightwatch-derived-summary-mismatch" };
  }
  return { status: "verified", reason: "codex-nightwatch-analysis-consumed", ...summary, ...expected };
}

export function consumeCodexUsageAnalysis(analysis, { observedAt, rawEvidenceRef }) {
  const summary = classifiedUsage(analysis);
  if (summary.status === "unknown") {
    return createProviderEvidence({
      schema_version: "runsteward.provider-evidence/v1",
      adapter_id: CODEX_USAGE_ADAPTER_ID,
      observed_at: observedAt,
      source_status: "unknown",
      reason_code: summary.reason,
      metrics: [],
      raw_evidence_refs: [structuredClone(rawEvidenceRef)]
    }, { metricRegistry: CODEX_USAGE_METRICS });
  }

  const values = [
    ["runsteward.codex.turns", summary.turns, "turns"],
    ["runsteward.codex.input-tokens", summary.input_tokens, "tokens"],
    ["runsteward.codex.cached-input-tokens", summary.cached_input_tokens, "tokens"],
    ["runsteward.codex.output-tokens", summary.output_tokens, "tokens"],
    ["runsteward.codex.reasoning-output-tokens", summary.reasoning_output_tokens, "tokens"],
    ["runsteward.codex.billable-like-tokens", summary.billable_like_tokens, "tokens"],
    ["runsteward.codex.uncached-input-tokens", summary.uncached_input_tokens, "tokens"],
    ["runsteward.codex.fresh-pressure-tokens", summary.fresh_pressure_tokens, "tokens"]
  ];
  return createProviderEvidence({
    schema_version: "runsteward.provider-evidence/v1",
    adapter_id: CODEX_USAGE_ADAPTER_ID,
    observed_at: observedAt,
    source_status: "verified",
    reason_code: summary.reason,
    metrics: values.map(([metricId, value, unit]) => metric(metricId, value, unit, rawEvidenceRef)),
    raw_evidence_refs: [structuredClone(rawEvidenceRef)]
  }, { metricRegistry: CODEX_USAGE_METRICS });
}
