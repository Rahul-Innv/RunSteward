import { assertRunStewardDigest, bodyWithoutDigest, runstewardDigest } from "./canonical-json.mjs";

const STABLE_ID = /^[a-z][a-z0-9._:-]{2,127}$/;
const RUNSTEWARD_DIGEST = /^sha256:[0-9a-f]{64}$/;
const BARE_SHA256 = /^[0-9a-f]{64}$/;
const DECIMAL = /^-?[0-9]+(?:\.[0-9]+)?$/;
const MEDIA_TYPE = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/;
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const SOURCE_STATES = new Set(["verified", "estimated", "unknown"]);
const CONFIDENCE_STATES = new Set(["verified", "estimated", "unknown"]);

function assertPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${label} must be a plain object`);
  }
}

function assertExactKeys(value, keys, label) {
  assertPlainObject(value, label);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} fields must be exactly ${expected.join(", ")}`);
  }
}

function assertStableId(value, label) {
  if (typeof value !== "string" || !STABLE_ID.test(value)) throw new Error(`${label} is not a stable id`);
}

function assertUtcTimestamp(value, label) {
  if (typeof value !== "string" || !UTC_TIMESTAMP.test(value) || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} must be an explicit UTC timestamp`);
  }
}

function assertRelativeRef(value, label) {
  if (typeof value !== "string" || value.length < 1 || value.length > 512) throw new Error(`${label} is not bounded`);
  if (/^[A-Za-z]:/.test(value) || /^[\\/]/.test(value)) throw new Error(`${label} must be repository-relative`);
  if (value.split(/[\\/]/).includes("..")) throw new Error(`${label} must not traverse outside its evidence root`);
  if (!/^[A-Za-z0-9._/\\:-]+$/.test(value)) throw new Error(`${label} contains unsupported characters`);
}

function sameEvidenceRef(left, right) {
  return left?.ref === right?.ref && left?.digest === right?.digest && left?.media_type === right?.media_type;
}

export function assertBoundedEvidenceRef(value, label = "evidence reference") {
  assertExactKeys(value, ["ref", "digest", "media_type"], label);
  assertRelativeRef(value.ref, `${label}.ref`);
  if (typeof value.digest !== "string" || (!RUNSTEWARD_DIGEST.test(value.digest) && !BARE_SHA256.test(value.digest))) {
    throw new Error(`${label}.digest must be a SHA-256 digest`);
  }
  if (typeof value.media_type !== "string" || !MEDIA_TYPE.test(value.media_type)) {
    throw new Error(`${label}.media_type must be a lowercase media type`);
  }
  return true;
}

export function assertProviderResumeBinding(binding, label = "provider resume binding") {
  assertExactKeys(binding, ["adapter_id", "identity_reference_digest", "verification_state"], label);
  assertStableId(binding.adapter_id, `${label}.adapter_id`);
  const verified = binding.verification_state === "verified" && typeof binding.identity_reference_digest === "string" && RUNSTEWARD_DIGEST.test(binding.identity_reference_digest);
  const notRequired = binding.verification_state === "not-required" && binding.identity_reference_digest === null;
  if (!verified && !notRequired) {
    throw new Error(`${label} must be VERIFIED plus digest or NOT_REQUIRED plus null`);
  }
  return true;
}

export function createProviderResumeBinding({ adapterId, verificationState, identityReferenceDigest }) {
  const binding = {
    adapter_id: adapterId,
    identity_reference_digest: identityReferenceDigest,
    verification_state: verificationState
  };
  assertProviderResumeBinding(binding);
  return Object.freeze(binding);
}

function assertMetric(value, envelope, index, metricRegistry) {
  const label = `provider evidence metrics[${index}]`;
  assertExactKeys(value, ["metric", "value", "unit", "source_adapter", "confidence", "raw_evidence_ref"], label);
  assertStableId(value.metric, `${label}.metric`);
  assertStableId(value.unit, `${label}.unit`);
  assertStableId(value.source_adapter, `${label}.source_adapter`);
  if (value.source_adapter !== envelope.adapter_id) throw new Error(`${label} changed adapter identity`);
  if (typeof value.value !== "string" || !DECIMAL.test(value.value)) throw new Error(`${label}.value must be a decimal string`);
  if (!CONFIDENCE_STATES.has(value.confidence) || value.confidence === "unknown") {
    throw new Error(`${label}.confidence cannot turn unknown evidence into a numeric metric`);
  }
  assertBoundedEvidenceRef(value.raw_evidence_ref, `${label}.raw_evidence_ref`);
  if (!metricRegistry || metricRegistry[value.metric] !== value.unit) {
    throw new Error(`${label} is not an exact registered metric and unit pair`);
  }
  const declaredRef = envelope.raw_evidence_refs.some((item) => sameEvidenceRef(item, value.raw_evidence_ref));
  if (!declaredRef) throw new Error(`${label} raw evidence reference is outside the bounded envelope index`);
}

export function assertProviderEvidence(envelope, { metricRegistry } = {}) {
  assertExactKeys(envelope, [
    "schema_version", "adapter_id", "observed_at", "source_status", "reason_code",
    "metrics", "raw_evidence_refs", "evidence_digest"
  ], "provider evidence");
  if (envelope.schema_version !== "runsteward.provider-evidence/v1") throw new Error("provider evidence schema version is unsupported");
  assertStableId(envelope.adapter_id, "provider evidence.adapter_id");
  assertUtcTimestamp(envelope.observed_at, "provider evidence.observed_at");
  if (!SOURCE_STATES.has(envelope.source_status)) throw new Error("provider evidence source status is unsupported");
  assertStableId(envelope.reason_code, "provider evidence.reason_code");
  if (!Array.isArray(envelope.raw_evidence_refs) || envelope.raw_evidence_refs.length > 16) throw new Error("provider evidence raw references are not bounded");
  envelope.raw_evidence_refs.forEach((item, index) => assertBoundedEvidenceRef(item, `provider evidence raw_evidence_refs[${index}]`));
  const refKeys = envelope.raw_evidence_refs.map((item) => `${item.ref}\u0000${item.digest}\u0000${item.media_type}`);
  if (new Set(refKeys).size !== refKeys.length) throw new Error("provider evidence repeats a raw evidence reference");
  if (!Array.isArray(envelope.metrics) || envelope.metrics.length > 32) throw new Error("provider evidence metrics are not bounded");
  if (envelope.source_status === "unknown" && envelope.metrics.length !== 0) throw new Error("unknown provider evidence cannot carry numeric metrics");
  envelope.metrics.forEach((item, index) => assertMetric(item, envelope, index, metricRegistry));
  const metricKeys = envelope.metrics.map((item) => `${item.metric}\u0000${item.unit}`);
  if (new Set(metricKeys).size !== metricKeys.length) throw new Error("provider evidence repeats a typed metric");
  assertRunStewardDigest(envelope, "evidence_digest");
  return true;
}

export function createProviderEvidence(body, { metricRegistry } = {}) {
  const value = structuredClone(body);
  value.evidence_digest = runstewardDigest(value);
  assertProviderEvidence(value, { metricRegistry });
  return value;
}

export function selectExactMetric(envelope, metric, unit, { metricRegistry } = {}) {
  assertProviderEvidence(envelope, { metricRegistry });
  assertStableId(metric, "selected metric");
  assertStableId(unit, "selected unit");
  if (!metricRegistry || metricRegistry[metric] !== unit) throw new Error("metric selection requires an exact registered metric and unit pair; conversion is forbidden");
  const match = envelope.metrics.find((item) => item.metric === metric && item.unit === unit);
  if (!match) throw new Error("requested typed budget metric is unavailable; conversion or substitution is forbidden");
  return structuredClone(match);
}

export function reportBudgetSummaryFromEvidence(envelopes, registriesByAdapter) {
  if (!Array.isArray(envelopes) || envelopes.length > 32) throw new Error("provider evidence envelope list is not bounded");
  const result = [];
  for (const envelope of envelopes) {
    const registry = registriesByAdapter?.[envelope.adapter_id];
    assertProviderEvidence(envelope, { metricRegistry: registry });
    for (const metric of envelope.metrics) result.push(structuredClone(metric));
  }
  if (result.length > 32) throw new Error("report budget summary exceeds its contract bound");
  return result;
}

export function refreshProviderEvidenceDigest(value) {
  value.evidence_digest = runstewardDigest(bodyWithoutDigest(value, "evidence_digest"));
  return value;
}
