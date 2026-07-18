import assert from "node:assert/strict";
import test from "node:test";
import { bodyWithoutDigest, assertRunStewardDigest } from "../../runsteward-core/src/canonical-json.mjs";
import { readJsonStrict, resolveContractPath } from "../../runsteward-core/src/contract-loader.mjs";
import { consumeCodexUsageAnalysis } from "../../runsteward-sensor-codex-usage/src/index.mjs";
import {
  CODEX_ADAPTER_ID,
  consumeCodexAnalysis,
  createCodexCheckpoint,
  createCodexHandoff,
  createCodexResumeBinding,
  createCodexWrapPlan
} from "../src/index.mjs";

const RAW = Object.freeze({ ref: "evidence/raw/codex-events.redacted.jsonl", digest: "sha256:" + "b".repeat(64), media_type: "application/x-ndjson" });
const IDENTITY = "sha256:" + "c".repeat(64);

test("Codex stop signal remains bounded and maps to wrap without raw event text", () => {
  const evidence = consumeCodexUsageAnalysis(null, { observedAt: "2026-07-15T12:00:00Z", rawEvidenceRef: RAW });
  const advisory = consumeCodexAnalysis({ decision: { action: "stop" }, stop_signal: { matched: true, reason: "private rate limit details" } }, evidence);
  assert.equal(advisory.advisory_status, "stop-requested");
  assert.equal(JSON.stringify(advisory).includes("private"), false);
  const plan = createCodexWrapPlan({
    planId: "wrap:codex:1",
    runId: "run:codex:1",
    advisory,
    evidenceRef: { ref: "evidence/provider/codex-stop.json", digest: evidence.evidence_digest, media_type: "application/json" }
  });
  assert.equal(plan.ordered_capabilities[0].skill_id, "runsteward-checkpoint-run");
  assert.equal(plan.final_status_marker_required, "RUNSTEWARD_FINAL_STATUS");
});

test("unknown Codex usage does not become a continue advisory", () => {
  const evidence = consumeCodexUsageAnalysis(null, { observedAt: "2026-07-15T12:00:00Z", rawEvidenceRef: RAW });
  const advisory = consumeCodexAnalysis({ decision: { action: "continue" }, stop_signal: { matched: false } }, evidence);
  assert.equal(advisory.advisory_status, "unknown");
  assert.throws(() => createCodexWrapPlan({ planId: "wrap:codex:unknown", runId: "run:codex:unknown", advisory, evidenceRef: RAW }), /mapped stop advisory/);
});

test("Codex checkpoint and handoff require VERIFIED plus digest", async () => {
  assert.deepEqual(createCodexResumeBinding(IDENTITY), { adapter_id: CODEX_ADAPTER_ID, identity_reference_digest: IDENTITY, verification_state: "verified" });
  assert.throws(() => createCodexResumeBinding(null), /VERIFIED plus digest/);
  const checkpointTemplate = await readJsonStrict(resolveContractPath("contracts/fixtures/scenarios/checkpoint.atomic-full-codex-01.codex-verified.json"));
  const checkpoint = createCodexCheckpoint(bodyWithoutDigest(checkpointTemplate, "checkpoint_digest"), IDENTITY);
  assert.deepEqual(checkpoint.provider_resume_binding, { adapter_id: CODEX_ADAPTER_ID, identity_reference_digest: IDENTITY, verification_state: "verified" });
  const handoffTemplate = await readJsonStrict(resolveContractPath("contracts/fixtures/scenarios/handoff.atomic-full-codex-01.redacted.json"));
  const body = bodyWithoutDigest(handoffTemplate, "handoff_digest");
  body.run_id = checkpoint.run_id;
  body.checkpoint_ref.digest = checkpoint.checkpoint_digest;
  body.safe_resume.adapter_id = CODEX_ADAPTER_ID;
  body.safe_resume.identity_reference_digest = IDENTITY;
  const handoff = createCodexHandoff(body, checkpoint);
  assert.equal(assertRunStewardDigest(handoff, "handoff_digest"), handoff.handoff_digest);
  assert.equal(JSON.stringify(handoff).includes("thread_real"), false);
});
