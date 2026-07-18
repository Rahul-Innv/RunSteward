import { createProviderEvidence } from "../../runsteward-core/src/provider-evidence.mjs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { extractUtil } = require("../../limit-aware-wrapup/sensor/burnrate.js");

export const CLAUDE_LIMIT_ADAPTER_ID = "runsteward.sensor.claude-limits";
export const CLAUDE_LIMIT_METRICS = Object.freeze({
  "runsteward.claude.five-hour-used-percent": "account-percent",
  "runsteward.claude.seven-day-used-percent": "account-percent",
  "runsteward.claude.five-hour-burn-rate": "account-percent-per-hour",
  "runsteward.claude.seven-day-burn-rate": "account-percent-per-hour"
});

const WINDOWS = Object.freeze(["five_hour", "seven_day"]);

function burnRate(state, window) {
  const value = state?.burn?.[window]?.pctPerHour;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function decimal(value) {
  return String(Math.round(value * 1_000_000) / 1_000_000);
}

function latestSample(samples) {
  if (!Array.isArray(samples)) return null;
  for (let index = samples.length - 1; index >= 0; index -= 1) {
    const sample = samples[index];
    if (sample && typeof sample === "object" && Number.isFinite(sample.ts) && sample.rate_limits && typeof sample.rate_limits === "object") return sample;
  }
  return null;
}

function metric(metricId, value, unit, confidence, rawEvidenceRef) {
  return {
    metric: metricId,
    value: decimal(value),
    unit,
    source_adapter: CLAUDE_LIMIT_ADAPTER_ID,
    confidence,
    raw_evidence_ref: structuredClone(rawEvidenceRef)
  };
}

export function consumeClaudeLimitState(state, { observedAt, rawEvidenceRef }) {
  const sample = latestSample(state?.samples);
  if (!sample) {
    return createProviderEvidence({
      schema_version: "runsteward.provider-evidence/v1",
      adapter_id: CLAUDE_LIMIT_ADAPTER_ID,
      observed_at: observedAt,
      source_status: "unknown",
      reason_code: "claude-limit-state-missing",
      metrics: [],
      raw_evidence_refs: [structuredClone(rawEvidenceRef)]
    }, { metricRegistry: CLAUDE_LIMIT_METRICS });
  }

  const confidence = sample.src === "oauth" ? "verified" : "estimated";
  const metrics = [];
  for (const window of WINDOWS) {
    const used = extractUtil(sample.rate_limits, window);
    if (used !== undefined) {
      metrics.push(metric(
        window === "five_hour" ? "runsteward.claude.five-hour-used-percent" : "runsteward.claude.seven-day-used-percent",
        used,
        "account-percent",
        confidence,
        rawEvidenceRef
      ));
    }
    const burn = burnRate(state, window);
    if (used !== undefined && burn !== null) {
      metrics.push(metric(
        window === "five_hour" ? "runsteward.claude.five-hour-burn-rate" : "runsteward.claude.seven-day-burn-rate",
        burn,
        "account-percent-per-hour",
        confidence,
        rawEvidenceRef
      ));
    }
  }

  return createProviderEvidence({
    schema_version: "runsteward.provider-evidence/v1",
    adapter_id: CLAUDE_LIMIT_ADAPTER_ID,
    observed_at: observedAt,
    source_status: metrics.length === 0 ? "unknown" : confidence,
    reason_code: metrics.length === 0 ? "claude-limit-metrics-missing" : "claude-limit-sample-consumed",
    metrics,
    raw_evidence_refs: [structuredClone(rawEvidenceRef)]
  }, { metricRegistry: CLAUDE_LIMIT_METRICS });
}
