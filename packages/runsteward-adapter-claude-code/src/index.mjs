import { createBoundedHandoffArtifact, createCheckpointArtifact, assertResumePreflight } from "../../runsteward-core/src/checkpoint-runtime.mjs";
import { assertBoundedEvidenceRef, assertProviderEvidence, createProviderResumeBinding } from "../../runsteward-core/src/provider-evidence.mjs";
import { createWrapPlan } from "../../runsteward-core/src/wrap-orchestration.mjs";
import { CLAUDE_LIMIT_METRICS } from "../../runsteward-sensor-claude-limits/src/index.mjs";

export const CLAUDE_CODE_ADAPTER_ID = "runsteward.adapter.claude-code";

export function consumeClaudeCarryOutcome(outcome, outcomeEvidenceRef) {
  assertBoundedEvidenceRef(outcomeEvidenceRef, "Claude Carry outcome evidence");
  const mapped = {
    done: ["completed", "claude-carry-completed"],
    waiting: ["wait-required", "claude-carry-provider-wait"],
    parked: ["owner-attention-required", "claude-carry-owner-attention"],
    failed: ["failed", "claude-carry-failed"]
  }[outcome?.status];
  return Object.freeze({
    adapter_id: CLAUDE_CODE_ADAPTER_ID,
    source_status: mapped ? "verified" : "unknown",
    advisory_status: mapped?.[0] ?? "unknown",
    reason_code: mapped?.[1] ?? "claude-carry-outcome-unknown",
    outcome_evidence_ref: Object.freeze(structuredClone(outcomeEvidenceRef))
  });
}

export function consumeClaudeLimitAdvisory(legacyDecision, providerEvidence) {
  assertProviderEvidence(providerEvidence, { metricRegistry: CLAUDE_LIMIT_METRICS });
  const decision = legacyDecision?.decision;
  if (providerEvidence.source_status === "unknown" || legacyDecision?.stale === true) {
    return Object.freeze({
      adapter_id: CLAUDE_CODE_ADAPTER_ID,
      source_status: "unknown",
      advisory_status: "unknown",
      reason_code: "claude-limit-advisory-unknown",
      provider_evidence_digest: providerEvidence.evidence_digest
    });
  }
  const mapped = {
    NONE: ["clear", "claude-limit-no-directive"],
    WARN: ["informational", "claude-limit-heads-up"],
    WRAPUP: ["wrap-requested", "claude-limit-wrap-directive"]
  }[decision];
  if (!mapped) {
    return Object.freeze({
      adapter_id: CLAUDE_CODE_ADAPTER_ID,
      source_status: "unknown",
      advisory_status: "unknown",
      reason_code: "claude-limit-decision-invalid",
      provider_evidence_digest: providerEvidence.evidence_digest
    });
  }
  return Object.freeze({
    adapter_id: CLAUDE_CODE_ADAPTER_ID,
    source_status: providerEvidence.source_status,
    advisory_status: mapped[0],
    reason_code: mapped[1],
    provider_evidence_digest: providerEvidence.evidence_digest
  });
}

export function createClaudeResumeBinding() {
  return createProviderResumeBinding({
    adapterId: CLAUDE_CODE_ADAPTER_ID,
    verificationState: "not-required",
    identityReferenceDigest: null
  });
}

export function createClaudeCheckpoint(checkpointBody) {
  return createCheckpointArtifact({
    ...structuredClone(checkpointBody),
    provider_resume_binding: { ...createClaudeResumeBinding() }
  });
}

export function createClaudeHandoff(handoffBody, checkpoint) {
  return createBoundedHandoffArtifact(handoffBody, checkpoint);
}

export function createClaudeWrapPlan({ planId, runId, advisory, evidenceRef }) {
  if (advisory?.adapter_id !== CLAUDE_CODE_ADAPTER_ID || advisory.advisory_status !== "wrap-requested" || advisory.source_status === "unknown") {
    throw new Error("Claude wrap requires a non-unknown mapped WRAPUP directive");
  }
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

export function assertClaudeResumePreflight(checkpoint, handoff, context) {
  if (checkpoint.provider_resume_binding.adapter_id !== CLAUDE_CODE_ADAPTER_ID) throw new Error("checkpoint is not bound to the Claude Code adapter");
  return assertResumePreflight(checkpoint, handoff, context);
}
