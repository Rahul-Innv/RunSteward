import { createBoundedHandoffArtifact, createCheckpointArtifact, assertResumePreflight } from "../../runsteward-core/src/checkpoint-runtime.mjs";
import { assertProviderEvidence, createProviderResumeBinding } from "../../runsteward-core/src/provider-evidence.mjs";
import { createWrapPlan } from "../../runsteward-core/src/wrap-orchestration.mjs";
import { CODEX_USAGE_METRICS } from "../../runsteward-sensor-codex-usage/src/index.mjs";

export const CODEX_ADAPTER_ID = "runsteward.adapter.codex";

export function consumeCodexAnalysis(analysis, providerEvidence) {
  assertProviderEvidence(providerEvidence, { metricRegistry: CODEX_USAGE_METRICS });
  const stopMatched = analysis?.stop_signal?.matched === true;
  const action = analysis?.decision?.action;
  if (stopMatched || action === "stop") {
    return Object.freeze({
      adapter_id: CODEX_ADAPTER_ID,
      source_status: stopMatched ? "estimated" : providerEvidence.source_status,
      advisory_status: "stop-requested",
      reason_code: stopMatched ? "codex-stop-signal" : "codex-budget-stop",
      provider_evidence_digest: providerEvidence.evidence_digest
    });
  }
  if (providerEvidence.source_status === "unknown") {
    return Object.freeze({
      adapter_id: CODEX_ADAPTER_ID,
      source_status: "unknown",
      advisory_status: "unknown",
      reason_code: "codex-analysis-unknown",
      provider_evidence_digest: providerEvidence.evidence_digest
    });
  }
  const mapped = {
    checkpoint: ["checkpoint-requested", "codex-budget-checkpoint"],
    continue: ["continue-advisory", "codex-budget-below-threshold"]
  }[action];
  if (!mapped) {
    return Object.freeze({
      adapter_id: CODEX_ADAPTER_ID,
      source_status: "unknown",
      advisory_status: "unknown",
      reason_code: "codex-decision-invalid",
      provider_evidence_digest: providerEvidence.evidence_digest
    });
  }
  return Object.freeze({
    adapter_id: CODEX_ADAPTER_ID,
    source_status: providerEvidence.source_status,
    advisory_status: mapped[0],
    reason_code: mapped[1],
    provider_evidence_digest: providerEvidence.evidence_digest
  });
}

export function createCodexResumeBinding(identityReferenceDigest) {
  return createProviderResumeBinding({
    adapterId: CODEX_ADAPTER_ID,
    verificationState: "verified",
    identityReferenceDigest
  });
}

export function createCodexCheckpoint(checkpointBody, identityReferenceDigest) {
  return createCheckpointArtifact({
    ...structuredClone(checkpointBody),
    provider_resume_binding: { ...createCodexResumeBinding(identityReferenceDigest) }
  });
}

export function createCodexHandoff(handoffBody, checkpoint) {
  return createBoundedHandoffArtifact(handoffBody, checkpoint);
}

export function createCodexWrapPlan({ planId, runId, advisory, evidenceRef }) {
  if (advisory?.adapter_id !== CODEX_ADAPTER_ID || advisory.advisory_status !== "stop-requested") {
    throw new Error("Codex wrap requires a mapped stop advisory");
  }
  if (advisory.source_status === "unknown") throw new Error("unknown Codex evidence cannot independently authorize a wrap plan");
  return createWrapPlan({
    planId,
    runId,
    trigger: {
      kind: "provider-advisory",
      source_status: advisory.source_status,
      reason_code: advisory.reason_code,
      evidence_ref: structuredClone(evidenceRef)
    }
  });
}

export function assertCodexResumePreflight(checkpoint, handoff, context) {
  if (checkpoint.provider_resume_binding.adapter_id !== CODEX_ADAPTER_ID) throw new Error("checkpoint is not bound to the Codex adapter");
  return assertResumePreflight(checkpoint, handoff, context);
}
