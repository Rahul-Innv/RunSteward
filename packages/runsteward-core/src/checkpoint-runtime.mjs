import { runstewardDigest } from "./canonical-json.mjs";
import { assertCheckpointResumable, assertHandoffSafeResume } from "./invariants.mjs";
import { assertBoundedEvidenceRef, assertProviderResumeBinding } from "./provider-evidence.mjs";

const STABLE_ID = /^[a-z][a-z0-9._:-]{2,127}$/;
const RUNSTEWARD_DIGEST = /^sha256:[0-9a-f]{64}$/;
const GIT_COMMIT = /^[0-9a-f]{40}$/;
const COLLISION_KEY = /^fs:[a-z0-9-]+:[0-9a-f]{64}$/;
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const LIFECYCLE_STATES = new Set(["planned", "queued", "allocated", "running", "waiting", "needs_approval", "checkpointed", "stopping", "stopped", "completed", "failed", "cancelled"]);

function assertPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${label} must be a plain object`);
  }
}

function assertExactKeys(value, keys, label) {
  assertPlainObject(value, label);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${label} has an unexpected or missing field`);
}

function assertStableId(value, label) {
  if (typeof value !== "string" || !STABLE_ID.test(value)) throw new Error(`${label} is not a stable id`);
}

function assertBoundedText(value, label, maximum = 4096) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum) throw new Error(`${label} is not bounded`);
}

function assertRelativeRef(value, label) {
  if (typeof value !== "string" || value.length < 1 || value.length > 512 || /^[A-Za-z]:/.test(value) || /^[\\/]/.test(value) || value.split(/[\\/]/).includes("..") || !/^[A-Za-z0-9._/\\:-]+$/.test(value)) {
    throw new Error(`${label} must be bounded and repository-relative`);
  }
}

function assertBoundedArray(value, maximum, label, validator) {
  if (!Array.isArray(value) || value.length > maximum) throw new Error(`${label} is not bounded`);
  value.forEach((item, index) => validator(item, `${label}[${index}]`));
}

function assertArtifactRef(value, label) {
  assertExactKeys(value, ["ref", "digest"], label);
  assertRelativeRef(value.ref, `${label}.ref`);
  if (typeof value.digest !== "string" || !RUNSTEWARD_DIGEST.test(value.digest)) throw new Error(`${label}.digest is invalid`);
}

function assertEvidenceRefs(value, maximum, label) {
  assertBoundedArray(value, maximum, label, (item, itemLabel) => assertBoundedEvidenceRef(item, itemLabel));
}

function assertChangedPath(value, label) {
  assertExactKeys(value, ["path", "change", "content_digest"], label);
  assertRelativeRef(value.path, `${label}.path`);
  if (!new Set(["added", "modified", "deleted", "renamed"]).has(value.change)) throw new Error(`${label}.change is invalid`);
  if (value.content_digest !== null && (typeof value.content_digest !== "string" || !RUNSTEWARD_DIGEST.test(value.content_digest))) throw new Error(`${label}.content_digest is invalid`);
}

function assertValidationResult(value, label) {
  assertExactKeys(value, ["check_id", "status", "summary", "evidence_refs"], label);
  assertStableId(value.check_id, `${label}.check_id`);
  if (!new Set(["passed", "failed", "not-run"]).has(value.status)) throw new Error(`${label}.status is invalid`);
  assertBoundedText(value.summary, `${label}.summary`, 512);
  assertEvidenceRefs(value.evidence_refs, 16, `${label}.evidence_refs`);
}

function assertOwnerGate(value, label) {
  assertExactKeys(value, ["gate_id", "owner", "state", "protected_action", "evidence_refs"], label);
  assertStableId(value.gate_id, `${label}.gate_id`);
  assertStableId(value.owner, `${label}.owner`);
  if (!new Set(["open", "satisfied", "denied"]).has(value.state)) throw new Error(`${label}.state is invalid`);
  assertBoundedText(value.protected_action, `${label}.protected_action`, 256);
  assertEvidenceRefs(value.evidence_refs, 16, `${label}.evidence_refs`);
  if (value.state === "satisfied" && value.evidence_refs.length === 0) throw new Error(`${label} satisfied without evidence`);
}

function assertFailedCommand(value, label) {
  assertExactKeys(value, ["command_digest", "exit_code", "summary", "evidence_refs"], label);
  if (typeof value.command_digest !== "string" || !RUNSTEWARD_DIGEST.test(value.command_digest)) throw new Error(`${label}.command_digest is invalid`);
  if (!Number.isSafeInteger(value.exit_code) || value.exit_code < 1) throw new Error(`${label}.exit_code is invalid`);
  assertBoundedText(value.summary, `${label}.summary`, 512);
  assertEvidenceRefs(value.evidence_refs, 16, `${label}.evidence_refs`);
}

function assertRedaction(value, label) {
  assertExactKeys(value, ["class", "replacement", "source_ref"], label);
  if (!new Set(["credential", "private-prompt", "personal-data", "unbounded-transcript"]).has(value.class)) throw new Error(`${label}.class is invalid`);
  assertBoundedText(value.replacement, `${label}.replacement`, 128);
  assertRelativeRef(value.source_ref, `${label}.source_ref`);
}

function assertCheckpointRepository(value) {
  assertExactKeys(value, ["original_source_head", "observed_head", "branch_name", "worktree", "dirty_summary"], "checkpoint.repository");
  if (!GIT_COMMIT.test(value.original_source_head) || !GIT_COMMIT.test(value.observed_head)) throw new Error("checkpoint repository commit identity is invalid");
  assertBoundedText(value.branch_name, "checkpoint.repository.branch_name", 256);
  assertExactKeys(value.worktree, ["path", "collision_key"], "checkpoint.repository.worktree");
  assertBoundedText(value.worktree.path, "checkpoint.repository.worktree.path", 1024);
  if (!COLLISION_KEY.test(value.worktree.collision_key)) throw new Error("checkpoint.repository.worktree.collision_key is invalid");
  assertExactKeys(value.dirty_summary, ["dirty", "changed_path_count", "status_digest"], "checkpoint.repository.dirty_summary");
  if (typeof value.dirty_summary.dirty !== "boolean" || !Number.isSafeInteger(value.dirty_summary.changed_path_count) || value.dirty_summary.changed_path_count < 0 || !RUNSTEWARD_DIGEST.test(value.dirty_summary.status_digest)) {
    throw new Error("checkpoint.repository.dirty_summary is invalid");
  }
}

function assertPartialProviderBinding(binding) {
  assertExactKeys(binding, ["adapter_id", "identity_reference_digest", "verification_state"], "partial checkpoint provider binding");
  assertStableId(binding.adapter_id, "partial checkpoint provider binding.adapter_id");
  if (!new Set(["verified", "not-required", "unknown", "mismatched"]).has(binding.verification_state)) throw new Error("partial checkpoint provider binding state is unsupported");
  if (binding.identity_reference_digest !== null && (typeof binding.identity_reference_digest !== "string" || !RUNSTEWARD_DIGEST.test(binding.identity_reference_digest))) {
    throw new Error("partial checkpoint provider identity digest is invalid");
  }
  if (binding.verification_state === "verified" || binding.verification_state === "not-required") assertProviderResumeBinding(binding);
  if (binding.verification_state === "unknown" && binding.identity_reference_digest !== null) throw new Error("unknown provider identity cannot carry an identity digest");
}

function assertCheckpointProgress(progress) {
  assertExactKeys(progress, ["completed_work", "current_atomic_step", "remaining_work", "blocker", "safe_next_action"], "checkpoint progress");
  for (const field of ["completed_work", "remaining_work"]) {
    if (!Array.isArray(progress[field]) || progress[field].length > 64) throw new Error(`checkpoint progress.${field} is not bounded`);
    progress[field].forEach((item, index) => assertBoundedText(item, `checkpoint progress.${field}[${index}]`));
  }
  if (progress.current_atomic_step !== null) assertBoundedText(progress.current_atomic_step, "checkpoint progress.current_atomic_step");
  if (progress.blocker !== null) assertBoundedText(progress.blocker, "checkpoint progress.blocker");
  assertBoundedText(progress.safe_next_action, "checkpoint progress.safe_next_action");
}

export function createCheckpointArtifact(body) {
  const checkpoint = structuredClone(body);
  assertExactKeys(checkpoint, [
    "schema_version", "checkpoint_id", "run_id", "created_at", "completeness", "event_ref",
    "previous_checkpoint_ref", "repository", "lease_id", "lease_epoch", "capability_plan_ref",
    "provider_resume_binding", "progress", "changed_paths", "validation_results", "raw_evidence_refs", "handoff_ref"
  ], "checkpoint body");
  if (checkpoint.schema_version !== "runsteward.checkpoint/v1") throw new Error("checkpoint schema version is unsupported");
  assertStableId(checkpoint.checkpoint_id, "checkpoint.checkpoint_id");
  assertStableId(checkpoint.run_id, "checkpoint.run_id");
  if (typeof checkpoint.created_at !== "string" || !UTC_TIMESTAMP.test(checkpoint.created_at) || Number.isNaN(Date.parse(checkpoint.created_at))) throw new Error("checkpoint.created_at must be UTC");
  if (!new Set(["complete", "partial"]).has(checkpoint.completeness)) throw new Error("checkpoint completeness is unsupported");
  assertArtifactRef(checkpoint.event_ref, "checkpoint.event_ref");
  if (checkpoint.previous_checkpoint_ref !== null) assertArtifactRef(checkpoint.previous_checkpoint_ref, "checkpoint.previous_checkpoint_ref");
  assertCheckpointRepository(checkpoint.repository);
  assertStableId(checkpoint.lease_id, "checkpoint.lease_id");
  if (!Number.isSafeInteger(checkpoint.lease_epoch) || checkpoint.lease_epoch < 1) throw new Error("checkpoint.lease_epoch is invalid");
  assertArtifactRef(checkpoint.capability_plan_ref, "checkpoint.capability_plan_ref");
  if (checkpoint.completeness === "complete") assertProviderResumeBinding(checkpoint.provider_resume_binding);
  else assertPartialProviderBinding(checkpoint.provider_resume_binding);
  assertCheckpointProgress(checkpoint.progress);
  assertBoundedArray(checkpoint.changed_paths, 512, "checkpoint.changed_paths", assertChangedPath);
  assertBoundedArray(checkpoint.validation_results, 128, "checkpoint.validation_results", assertValidationResult);
  assertEvidenceRefs(checkpoint.raw_evidence_refs, 128, "checkpoint.raw_evidence_refs");
  if (checkpoint.handoff_ref !== null) assertArtifactRef(checkpoint.handoff_ref, "checkpoint.handoff_ref");
  checkpoint.checkpoint_digest = runstewardDigest(checkpoint);
  return checkpoint;
}

function assertSafeResumeShape(safeResume) {
  assertExactKeys(safeResume, ["eligible", "preconditions", "adapter_id", "identity_reference_digest", "invocation_template"], "handoff safe resume");
  if (typeof safeResume.eligible !== "boolean") throw new Error("handoff safe resume eligibility must be boolean");
  assertStableId(safeResume.adapter_id, "handoff safe resume.adapter_id");
  if (!Array.isArray(safeResume.preconditions) || safeResume.preconditions.length > 32) throw new Error("handoff safe resume preconditions are not bounded");
  safeResume.preconditions.forEach((item, index) => assertBoundedText(item, `handoff safe resume.preconditions[${index}]`, 256));
  if (safeResume.eligible) {
    if (safeResume.preconditions.length === 0) throw new Error("eligible handoff requires preconditions");
    assertBoundedText(safeResume.invocation_template, "handoff safe resume.invocation_template", 1024);
  } else if (safeResume.identity_reference_digest !== null || safeResume.invocation_template !== null) {
    throw new Error("ineligible handoff cannot carry an identity digest or invocation template");
  }
}

export function createBoundedHandoffArtifact(body, checkpoint) {
  const handoff = structuredClone(body);
  assertExactKeys(handoff, [
    "schema_version", "handoff_id", "run_id", "created_at", "checkpoint_ref", "status", "outcome_summary",
    "completed_items", "remaining_items", "blockers", "decisions_required", "approvals_required", "validation_summary",
    "changed_paths_summary", "failed_commands_summary", "safe_resume", "redactions", "raw_evidence_refs"
  ], "handoff body");
  if (handoff.schema_version !== "runsteward.handoff/v1") throw new Error("handoff schema version is unsupported");
  assertStableId(handoff.handoff_id, "handoff.handoff_id");
  assertStableId(handoff.run_id, "handoff.run_id");
  if (typeof handoff.created_at !== "string" || !UTC_TIMESTAMP.test(handoff.created_at) || Number.isNaN(Date.parse(handoff.created_at))) throw new Error("handoff.created_at must be UTC");
  assertArtifactRef(handoff.checkpoint_ref, "handoff.checkpoint_ref");
  if (!LIFECYCLE_STATES.has(handoff.status)) throw new Error("handoff.status is invalid");
  if (handoff.run_id !== checkpoint.run_id || handoff.checkpoint_ref.digest !== checkpoint.checkpoint_digest) {
    throw new Error("handoff differs from its checkpoint identity or digest");
  }
  assertBoundedText(handoff.outcome_summary, "handoff.outcome_summary");
  for (const field of ["completed_items", "remaining_items", "blockers"]) {
    assertBoundedArray(handoff[field], 64, `handoff.${field}`, (item, label) => assertBoundedText(item, label));
  }
  assertBoundedArray(handoff.decisions_required, 64, "handoff.decisions_required", assertOwnerGate);
  assertBoundedArray(handoff.approvals_required, 64, "handoff.approvals_required", assertOwnerGate);
  assertBoundedArray(handoff.validation_summary, 128, "handoff.validation_summary", assertValidationResult);
  assertBoundedArray(handoff.changed_paths_summary, 512, "handoff.changed_paths_summary", assertChangedPath);
  assertBoundedArray(handoff.failed_commands_summary, 64, "handoff.failed_commands_summary", assertFailedCommand);
  assertSafeResumeShape(handoff.safe_resume);
  if (handoff.safe_resume.eligible) {
    assertProviderResumeBinding({
      adapter_id: handoff.safe_resume.adapter_id,
      identity_reference_digest: handoff.safe_resume.identity_reference_digest,
      verification_state: checkpoint.provider_resume_binding.verification_state
    });
    if (handoff.safe_resume.adapter_id !== checkpoint.provider_resume_binding.adapter_id || handoff.safe_resume.identity_reference_digest !== checkpoint.provider_resume_binding.identity_reference_digest) {
      throw new Error("handoff safe resume identity differs from its checkpoint");
    }
  }
  assertBoundedArray(handoff.redactions, 128, "handoff.redactions", assertRedaction);
  assertEvidenceRefs(handoff.raw_evidence_refs, 128, "handoff.raw_evidence_refs");
  handoff.handoff_digest = runstewardDigest(handoff);
  return handoff;
}

export function assertResumePreflight(checkpoint, handoff, context) {
  assertProviderResumeBinding(checkpoint.provider_resume_binding);
  assertHandoffSafeResume(handoff, checkpoint, context.events);
  assertCheckpointResumable(checkpoint, context);
  return true;
}
