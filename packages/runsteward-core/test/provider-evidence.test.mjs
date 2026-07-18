import assert from "node:assert/strict";
import test from "node:test";
import { bodyWithoutDigest } from "../src/canonical-json.mjs";
import {
  assertBoundedEvidenceRef,
  assertProviderEvidence,
  assertProviderResumeBinding,
  createProviderEvidence,
  createProviderResumeBinding,
  reportBudgetSummaryFromEvidence,
  selectExactMetric
} from "../src/provider-evidence.mjs";
import { readJsonStrict, resolveContractPath } from "../src/contract-loader.mjs";

const CLAUDE_REGISTRY = Object.freeze({ "runsteward.claude.five-hour-used-percent": "account-percent" });
const CODEX_REGISTRY = Object.freeze({ "runsteward.codex.billable-like-tokens": "tokens" });

test("typed provider evidence preserves exact metric units and forbids conversion", async () => {
  const claude = await readJsonStrict(resolveContractPath("contracts/fixtures/valid/provider-evidence.claude.json"));
  const codex = await readJsonStrict(resolveContractPath("contracts/fixtures/valid/provider-evidence.codex.json"));
  assert.equal(assertProviderEvidence(claude, { metricRegistry: CLAUDE_REGISTRY }), true);
  assert.equal(assertProviderEvidence(codex, { metricRegistry: CODEX_REGISTRY }), true);
  assert.equal(selectExactMetric(codex, "runsteward.codex.billable-like-tokens", "tokens", { metricRegistry: CODEX_REGISTRY }).value, "1600");
  assert.throws(() => selectExactMetric(codex, "runsteward.codex.billable-like-tokens", "account-percent", { metricRegistry: CODEX_REGISTRY }), /conversion is forbidden/);
  assert.deepEqual(reportBudgetSummaryFromEvidence([claude, codex], {
    "runsteward.sensor.claude-limits": CLAUDE_REGISTRY,
    "runsteward.sensor.codex-usage": CODEX_REGISTRY
  }).map((item) => item.unit), ["account-percent", "tokens"]);
});

test("unknown evidence cannot carry a numeric metric", async () => {
  const valid = await readJsonStrict(resolveContractPath("contracts/fixtures/valid/provider-evidence.codex.json"));
  const body = bodyWithoutDigest(valid, "evidence_digest");
  body.source_status = "unknown";
  body.reason_code = "codex-usage-missing";
  assert.throws(() => createProviderEvidence(body, { metricRegistry: CODEX_REGISTRY }), /unknown provider evidence/);
});

test("raw evidence is references only and remains bounded", () => {
  const valid = { ref: "evidence/raw/provider.redacted.json", digest: "sha256:" + "a".repeat(64), media_type: "application/json" };
  assert.equal(assertBoundedEvidenceRef(valid), true);
  assert.throws(() => assertBoundedEvidenceRef({ ...valid, ref: "C:\\secret\\raw.json" }), /repository-relative/);
  assert.throws(() => assertBoundedEvidenceRef({ ...valid, ref: "evidence/../secret.json" }), /traverse/);
  assert.throws(() => assertBoundedEvidenceRef({ ...valid, content: "secret" }), /fields must be exactly/);
});

test("resume binding accepts only VERIFIED plus digest or NOT_REQUIRED plus null", () => {
  const verified = createProviderResumeBinding({ adapterId: "runsteward.adapter.codex", verificationState: "verified", identityReferenceDigest: "sha256:" + "b".repeat(64) });
  const notRequired = createProviderResumeBinding({ adapterId: "runsteward.adapter.claude-code", verificationState: "not-required", identityReferenceDigest: null });
  assert.equal(assertProviderResumeBinding(verified), true);
  assert.equal(assertProviderResumeBinding(notRequired), true);
  for (const binding of [
    { adapter_id: "runsteward.adapter.codex", verification_state: "verified", identity_reference_digest: null },
    { adapter_id: "runsteward.adapter.codex", verification_state: "not-required", identity_reference_digest: "sha256:" + "b".repeat(64) },
    { adapter_id: "runsteward.adapter.codex", verification_state: "unknown", identity_reference_digest: null },
    { adapter_id: "runsteward.adapter.codex", verification_state: "mismatched", identity_reference_digest: "sha256:" + "b".repeat(64) }
  ]) assert.throws(() => assertProviderResumeBinding(binding), /VERIFIED plus digest or NOT_REQUIRED plus null/);
});
