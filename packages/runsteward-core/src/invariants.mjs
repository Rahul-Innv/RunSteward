import { createHash } from "node:crypto";
import { posix as pathPosix } from "node:path";
import { assertRunStewardDigest, canonicalizeRunSteward, runstewardDigest } from "./canonical-json.mjs";
import { authorityFromProvenance, authorityFromQualification } from "./choicegate-authority.mjs";
import { foldStateEvents } from "./event-fold.mjs";

const FORBIDDEN_SELECTION_KEYS = new Set([
  "candidates",
  "candidate_evidence_sha256",
  "score_breakdown",
  "selection_tuple",
  "task_fit",
  "risk_penalty",
  "scope_penalty"
]);

function same(left, right) {
  return canonicalizeRunSteward(left) === canonicalizeRunSteward(right);
}

function assertAuthorityEnvelope(actual, expected, label) {
  for (const [field, expectedValue] of Object.entries(expected)) {
    if (expectedValue !== undefined && actual[field] !== expectedValue) {
      throw new Error(`${label} authority drift: ${field}`);
    }
  }
}

function foreignDeepEqual(left, right) {
  if (Object.is(left, right)) return true;
  if (typeof left !== typeof right || left === null || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((item, index) => foreignDeepEqual(item, right[index]));
  }
  if (typeof left !== "object") return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && foreignDeepEqual(left[key], right[key]));
}

function assertNoSelectionAuthority(value, path = "$") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSelectionAuthority(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_SELECTION_KEYS.has(key)) {
      throw new Error(`RunSteward plan contains ChoiceGate-owned selection field at ${path}.${key}`);
    }
    assertNoSelectionAuthority(child, `${path}.${key}`);
  }
}

function selectedBundleMemberIds(receipt) {
  return receipt.bundle_members
    .filter((member) => member.selection === "selected")
    .sort((left, right) => left.order - right.order)
    .map((member) => member.capability_id);
}

function expectedPreconditions(receipt) {
  return Object.entries(receipt.task.preconditions)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([precondition_id, value]) => ({ precondition_id, value_digest: runstewardDigest({ value }) }));
}

function assertQualifiedReceiptBytes(receipt, bytes, qualified) {
  if (!(bytes instanceof Uint8Array)) throw new Error("qualified receipt bytes are required");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (text.charCodeAt(0) === 0xfeff) throw new Error("qualified receipt bytes contain a BOM");
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const rawDigest = createHash("sha256").update(bytes).digest("hex");
  const digest = createHash("sha256").update(normalized, "utf8").digest("hex");
  if (rawDigest !== qualified.raw_bytes_sha256) throw new Error("qualified receipt raw bytes drift");
  if (digest !== qualified.normalized_utf8_lf_sha256) throw new Error("qualified receipt bytes drift");
  const parsed = JSON.parse(text);
  if (!foreignDeepEqual(parsed, receipt)) throw new Error("receipt object differs from its qualified immutable bytes");
}

function resumableProviderBinding(binding) {
  return (binding.verification_state === "verified" && binding.identity_reference_digest !== null)
    || (binding.verification_state === "not-required" && binding.identity_reference_digest === null);
}

function assertStaticLeaseIdentity(activeLease, releasedLease) {
  const fields = [
    "schema_version", "lease_id", "run_id", "task_id", "lease_epoch", "purpose", "repository_id",
    "original_source_head", "observed_head", "branch_name", "worktree", "state_path", "evidence_path",
    "lock_path", "owner", "acquired_at", "previous_lease_ref", "previous_lease_id"
  ];
  for (const field of fields) {
    if (!same(activeLease[field], releasedLease[field])) throw new Error(`released lease static identity drift: ${field}`);
  }
  if (activeLease.status !== "active" || releasedLease.status !== "released" || releasedLease.release_reason === null) {
    throw new Error("lease release snapshots have invalid states");
  }
}

export function assertQualifiedCapabilityPlanBinding(plan, receipt, { qualificationRef, qualification, provenanceRef, provenance, receiptBytes, originalReceipt = null, originalReceiptBytes = null, expectedAuthority = null }) {
  assertRunStewardDigest(plan, "plan_digest");
  assertRunStewardDigest(qualification, "qualification_digest");
  assertNoSelectionAuthority(plan);

  if (qualification.verifier !== "runsteward-choicegate-python-qualification/v1") {
    throw new Error("ChoiceGate receipt lacks the required Python qualification");
  }
  const provenanceDigest = runstewardDigest(provenance);
  if (qualification.provenance_ref.ref !== provenanceRef || qualification.provenance_ref.digest !== provenanceDigest) {
    throw new Error("ChoiceGate qualification provenance mismatch");
  }
  if (!same(plan.choicegate_receipt.qualification_ref, {
    ref: qualificationRef,
    digest: qualification.qualification_digest
  })) {
    throw new Error("capability plan qualification reference mismatch");
  }

  const binding = plan.choicegate_receipt;
  const qualified = qualification.receipts.find((item) => item.immutable_ref === binding.immutable_ref);
  const provenanceEntry = provenance.fixtures.find((item) => item.path === binding.immutable_ref);
  if (!qualified || !provenanceEntry || qualified.qualification_status !== "passed") {
    throw new Error("receipt immutable_ref is not Python-qualified");
  }
  assertQualifiedReceiptBytes(receipt, receiptBytes, qualified);
  const authority = expectedAuthority ?? {
    schema_id: "choicegate.decision-receipt/v1",
    receipt_schema_sha256: "3d32d4bac2cb9ff78d0249741d74e8572326894435e3bab10bf0f2f7ca7c949d",
    choicegate_commit: "c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0",
    lifecycle_authority_commit: "d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0",
    lifecycle_authority_state_model: "orthogonal-seven-axis-v1",
    inventory_fingerprint: "e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0"
  };
  assertAuthorityEnvelope(authorityFromQualification(qualification), authority, "qualification");
  assertAuthorityEnvelope(authorityFromProvenance(provenance), authority, "qualification provenance");
  if (qualified.schema_id !== authority.schema_id || qualified.choicegate_commit !== authority.choicegate_commit || qualified.receipt_sha256 !== receipt.receipt_sha256 || qualified.request_sha256 !== receipt.request_sha256 || qualified.normalized_utf8_lf_sha256 !== provenanceEntry.normalized_utf8_lf_sha256) {
    throw new Error("qualified receipt evidence drift");
  }
  if (binding.schema_id !== receipt.receipt_version || binding.receipt_version !== receipt.receipt_version || binding.receipt_schema_sha256 !== authority.receipt_schema_sha256) {
    throw new Error("ChoiceGate schema/version binding mismatch");
  }
  if (binding.receipt_sha256 !== receipt.receipt_sha256 || binding.request_id !== receipt.request_id || binding.request_sha256 !== receipt.request_sha256) {
    throw new Error("ChoiceGate native receipt/request binding mismatch");
  }
  if (binding.task_class !== receipt.task.task_class || binding.inventory_fingerprint !== receipt.inventory_binding.manifest_fingerprint) {
    throw new Error("ChoiceGate task or inventory binding drift");
  }
  if (binding.accepted_lifecycle_authority_commit !== receipt.inventory_binding.accepted_lifecycle_authority_commit || binding.choicegate_commit !== receipt.router_binding.choicegate_commit) {
    throw new Error("ChoiceGate or the external lifecycle authority authority drift");
  }
  if (receipt.inventory_binding.accepted_lifecycle_authority_commit !== authority.lifecycle_authority_commit || receipt.inventory_binding.state_model_id !== authority.lifecycle_authority_state_model || receipt.inventory_binding.manifest_fingerprint !== authority.inventory_fingerprint) {
    throw new Error("receipt inventory authority drift");
  }
  if (plan.scope_fingerprint !== runstewardDigest(receipt.task.allowed_scope)) throw new Error("ChoiceGate allowed scope drift");
  if (!same(plan.frozen_preconditions, expectedPreconditions(receipt))) throw new Error("ChoiceGate frozen precondition drift");
  if (!same(plan.owner_gates, receipt.approvals_required)) throw new Error("ChoiceGate owner gate drift");
  const expectedAuthorization = receipt.task.authorization_required || receipt.approvals_required.length > 0 ? "requires-owner" : "not-required";
  if (plan.authorization_state !== expectedAuthorization) throw new Error("ChoiceGate authorization state drift");

  const route = plan.selected_route;
  for (const field of ["route_type", "route_id", "version", "owner", "executable"]) {
    if (route[field] !== receipt.decision[field]) throw new Error(`selected_route.${field} differs from the accepted receipt`);
  }
  const expectedMembers = route.route_type === "bundle" ? selectedBundleMemberIds(receipt) : [];
  if (!same(route.member_ids, expectedMembers)) throw new Error("selected_route.member_ids differs from the accepted receipt");
  if (route.route_type === "handoff") {
    if (route.original_selection_ref === null) throw new Error("handoff receipt lacks immutable original selection reference");
    const originalQualified = qualification.receipts.find((item) => item.immutable_ref === route.original_selection_ref.ref);
    if (!originalQualified || route.original_selection_ref.digest !== `sha256:${originalQualified.normalized_utf8_lf_sha256}` || originalQualified.qualification_status !== "passed" || !originalReceipt || originalReceipt.receipt_sha256 !== originalQualified.receipt_sha256 || originalReceipt.request_sha256 !== originalQualified.request_sha256 || originalReceipt.receipt_version !== originalQualified.schema_id || originalReceipt.router_binding?.choicegate_commit !== originalQualified.choicegate_commit || !["atomic", "bundle"].includes(originalReceipt.decision?.route_type)) {
      throw new Error("handoff original selection does not resolve to a qualified original atomic or bundle receipt");
    }
    assertQualifiedReceiptBytes(originalReceipt, originalReceiptBytes, originalQualified);
  }
  if (route.route_type !== "handoff" && route.original_selection_ref !== null) throw new Error("non-handoff receipt invented an original selection reference");
  for (const field of ["route_type", "route_id", "eligible", "reason"]) {
    if (plan.fallback[field] !== receipt.fallback[field]) throw new Error(`fallback.${field} differs from the accepted receipt`);
  }
  return true;
}

export function assertDispatchAuthorized(plan, receipt, qualificationArtifacts) {
  assertQualifiedCapabilityPlanBinding(plan, receipt, qualificationArtifacts);
  if (!["atomic", "bundle"].includes(receipt.decision.route_type) || receipt.decision.executable !== true) {
    throw new Error("only an original executable atomic or bundle receipt may dispatch");
  }
  if (receipt.task.authorization_required !== false || receipt.approvals_required.length !== 0 || plan.authorization_state !== "not-required" || plan.owner_gates.length !== 0) {
    throw new Error("authorization or owner gates prevent dispatch");
  }
  return true;
}

export function assertRunOwnerGateBinding(plan, events) {
  assertRunStewardDigest(plan, "plan_digest");
  foldStateEvents(events);
  if (events.length === 0 || events.some((event) => event.run_id !== plan.run_id)) throw new Error("capability plan run_id differs from its event chain");
  const bound = events.find((event) => event.event_type === "capability-plan.bound");
  if (!bound || bound.event_data.capability_plan_ref.digest !== plan.plan_digest) throw new Error("event chain does not bind the supplied capability plan");
  const declared = plan.owner_gates;
  const initialGateEvent = events.find((event) => event.event_type === "run.approval_required" && event.from_state === "planned");
  if (declared.length === 0) {
    if (initialGateEvent) throw new Error("gate-free plan acquired an initial owner gate event");
    return true;
  }
  if (!initialGateEvent || !same(initialGateEvent.event_data.owner_gate_ids, declared) || !same(initialGateEvent.event_data.capability_plan_ref, initialGateEvent.projection.capability_plan_ref)) {
    throw new Error("initial owner gates differ from the frozen capability plan");
  }
  const queued = events.find((event) => event.event_type === "run.queued" && event.sequence > initialGateEvent.sequence);
  if (!queued) throw new Error("owner-gated plan has no satisfied queue transition");
  return true;
}

export function assertCheckpointResumable(checkpoint, { run, events, capabilityPlan, checkpointEvent, newLease, priorLease, activePriorLease, resumeEvent }) {
  assertRunProjection(run, events);
  assertRunStewardDigest(capabilityPlan, "plan_digest");
  assertRunStewardDigest(checkpoint, "checkpoint_digest");
  assertRunStewardDigest(newLease, "lease_digest");
  assertRunStewardDigest(priorLease, "lease_digest");
  assertRunStewardDigest(activePriorLease, "lease_digest");
  assertRunStewardDigest(checkpointEvent, "event_digest");
  assertRunStewardDigest(resumeEvent, "event_digest");
  const checkpointMember = events.find((event) => event.event_id === checkpointEvent.event_id && event.sequence === checkpointEvent.sequence && event.event_digest === checkpointEvent.event_digest);
  const resumeMember = events.find((event) => event.event_id === resumeEvent.event_id && event.sequence === resumeEvent.sequence && event.event_digest === resumeEvent.event_digest);
  if (!checkpointMember || !resumeMember) throw new Error("resume events are not members of the validated event chain");
  if (checkpoint.completeness !== "complete") throw new Error("partial checkpoint cannot be resumed");
  if (!resumableProviderBinding(checkpoint.provider_resume_binding)) throw new Error("resume provider binding is not fail-closed");
  if (checkpoint.run_id !== run.run_id || capabilityPlan.run_id !== run.run_id || resumeEvent.run_id !== run.run_id || newLease.run_id !== run.run_id || priorLease.run_id !== run.run_id || activePriorLease.run_id !== run.run_id) throw new Error("resume run_id mismatch");
  if (newLease.repository_id !== run.repository.repository_id || priorLease.repository_id !== run.repository.repository_id || newLease.task_id !== run.task_id || priorLease.task_id !== run.task_id) {
    throw new Error("resume lease repository or task identity mismatch");
  }
  assertStaticLeaseIdentity(activePriorLease, priorLease);
  if (newLease.status !== "active" || newLease.purpose !== "resume" || priorLease.status !== "released") throw new Error("resume requires a released predecessor and active resume lease");
  if (newLease.branch_name !== priorLease.branch_name || newLease.worktree.collision_key !== priorLease.worktree.collision_key || newLease.state_path.collision_key !== priorLease.state_path.collision_key || newLease.evidence_path.collision_key !== priorLease.evidence_path.collision_key || newLease.lock_path.collision_key !== priorLease.lock_path.collision_key) {
    throw new Error("resume lease path identity drift");
  }
  if (checkpoint.event_ref.digest !== checkpointEvent.event_digest || checkpointEvent.event_type !== "run.checkpointed") {
    throw new Error("checkpoint event binding mismatch");
  }
  const finalized = events.find((event) => event.event_type === "checkpoint.finalized" && event.event_data.checkpoint_ref.digest === checkpoint.checkpoint_digest && same(event.event_data.checkpoint_event_ref, checkpoint.event_ref));
  if (!finalized || !same(run.latest_checkpoint_ref, finalized.event_data.checkpoint_ref) || !same(resumeEvent.event_data.checkpoint_ref, finalized.event_data.checkpoint_ref)) {
    throw new Error("resume checkpoint is not finalized in the validated chain");
  }
  if (run.lifecycle_policy.resume_after_stop_policy !== "verified-checkpoint-only") throw new Error("run policy forbids checkpoint resume");
  if (checkpoint.repository.original_source_head !== run.repository.source_head) throw new Error("checkpoint original source drift");
  if (newLease.original_source_head !== run.repository.source_head || checkpoint.repository.observed_head !== resumeEvent.event_data.observed_head || newLease.observed_head !== resumeEvent.event_data.observed_head) {
    throw new Error("resume observed head drift");
  }
  if (checkpoint.repository.branch_name !== newLease.branch_name || checkpoint.repository.branch_name !== resumeEvent.event_data.branch_name) {
    throw new Error("resume branch drift");
  }
  if (checkpoint.repository.worktree.collision_key !== newLease.worktree.collision_key || checkpoint.repository.worktree.collision_key !== resumeEvent.event_data.worktree_collision_key) {
    throw new Error("resume worktree identity drift");
  }
  if (newLease.state_path.collision_key !== run.state_dir.collision_key || newLease.evidence_path.collision_key !== run.evidence_dir.collision_key || resumeEvent.event_data.state_collision_key !== run.state_dir.collision_key || resumeEvent.event_data.evidence_collision_key !== run.evidence_dir.collision_key) {
    throw new Error("resume state or evidence path identity drift");
  }
  if (!same(checkpoint.capability_plan_ref, run.capability_plan_ref) || !same(checkpoint.capability_plan_ref, resumeEvent.event_data.capability_plan_ref)) {
    throw new Error("resume capability plan drift");
  }
  if (checkpoint.capability_plan_ref.digest !== capabilityPlan.plan_digest) throw new Error("resume supplied a cross-run or unbound capability plan");
  if (checkpoint.lease_id !== priorLease.lease_id || checkpoint.lease_epoch !== priorLease.lease_epoch) throw new Error("checkpoint prior lease mismatch");
  if (newLease.lease_epoch <= priorLease.lease_epoch || newLease.previous_lease_id !== priorLease.lease_id || newLease.previous_lease_ref.digest !== priorLease.lease_digest) {
    throw new Error("new lease epoch or predecessor mismatch");
  }
  const acquisitionIndex = events.findIndex((event) => event.event_id === resumeEvent.event_id) - 1;
  const acquisition = events[acquisitionIndex];
  const release = events.slice(0, acquisitionIndex).reverse().find((event) => event.event_type === "lease.released");
  if (!acquisition || acquisition.event_type !== "lease.acquired" || acquisition.event_data.lease_purpose !== "resume" || !same(acquisition.event_data.previous_lease_ref, release?.event_data.released_lease_ref) || release.event_data.active_lease_ref.digest !== activePriorLease.lease_digest || release.event_data.released_lease_ref.digest !== priorLease.lease_digest) {
    throw new Error("resume chain lacks the matching active-to-released lease transition");
  }
  if (!same(newLease.previous_lease_ref, resumeEvent.event_data.prior_lease_ref) || newLease.lease_id !== resumeEvent.event_data.new_lease_id || newLease.lease_epoch !== resumeEvent.event_data.new_lease_epoch) {
    throw new Error("resume event lease binding mismatch");
  }
  if (resumeEvent.event_data.checkpoint_event_id !== checkpointEvent.event_id || resumeEvent.event_data.checkpoint_event_sequence !== checkpointEvent.sequence || resumeEvent.event_data.checkpoint_event_digest !== checkpointEvent.event_digest) {
    throw new Error("resume checkpoint position mismatch");
  }
  if (resumeEvent.event_data.adapter_id !== checkpoint.provider_resume_binding.adapter_id || resumeEvent.event_data.identity_reference_digest !== checkpoint.provider_resume_binding.identity_reference_digest) {
    throw new Error("resume adapter identity drift");
  }
  return true;
}

export function assertLeaseUniqueness(leases) {
  const ids = new Set();
  const epochs = new Set();
  const reservations = new Map();
  const byRunEpoch = new Map();
  for (const lease of leases) {
    assertRunStewardDigest(lease, "lease_digest");
    if (ids.has(lease.lease_id)) throw new Error(`duplicate lease_id: ${lease.lease_id}`);
    ids.add(lease.lease_id);
    const epochKey = `${lease.run_id}:${lease.lease_epoch}`;
    if (epochs.has(epochKey)) throw new Error(`duplicate lease epoch: ${epochKey}`);
    epochs.add(epochKey);
    byRunEpoch.set(epochKey, lease);
    if (lease.lease_epoch === 1) {
      if (lease.previous_lease_id !== null || lease.previous_lease_ref !== null) throw new Error("first lease must not claim a predecessor");
    } else {
      const prior = byRunEpoch.get(`${lease.run_id}:${lease.lease_epoch - 1}`) ?? leases.find((item) => item.run_id === lease.run_id && item.lease_epoch === lease.lease_epoch - 1);
      if (!prior || lease.previous_lease_id !== prior.lease_id || lease.previous_lease_ref?.digest !== prior.lease_digest) {
        throw new Error(`lease ${lease.lease_id} has a broken predecessor chain`);
      }
    }
    if (lease.status === "released") continue;
    const identities = [
      ["run_id", lease.run_id],
      ["task_id", lease.task_id],
      ["branch_name", `${lease.repository_id}:${lease.branch_name.toLowerCase()}`],
      ["worktree", lease.worktree.collision_key],
      ["state_path", lease.state_path.collision_key],
      ["evidence_path", lease.evidence_path.collision_key],
      ["lock_path", lease.lock_path.collision_key]
    ];
    for (const [kind, value] of identities) {
      const key = `${kind}:${value}`;
      if (reservations.has(key)) throw new Error(`lease collision on ${kind}: ${value}`);
      reservations.set(key, lease.lease_id);
    }
  }
  return true;
}

export function assertHandoffSafeResume(handoff, checkpoint, events) {
  assertRunStewardDigest(handoff, "handoff_digest");
  if (!handoff.safe_resume.eligible) return true;
  if (!checkpoint || checkpoint.completeness !== "complete") throw new Error("safe resume requires a complete checkpoint");
  assertRunStewardDigest(checkpoint, "checkpoint_digest");
  if (handoff.run_id !== checkpoint.run_id) throw new Error("handoff and checkpoint run_id differ");
  if (handoff.checkpoint_ref.digest !== checkpoint.checkpoint_digest) throw new Error("handoff checkpoint drift");
  if (!Array.isArray(events)) throw new Error("safe resume requires the validated checkpoint event chain");
  foldStateEvents(events);
  const checkpointEvent = events.find((event) => event.event_type === "run.checkpointed" && event.event_digest === checkpoint.event_ref.digest && event.run_id === checkpoint.run_id);
  const finalization = events.find((event) => event.event_type === "checkpoint.finalized" && event.run_id === checkpoint.run_id && same(event.event_data.checkpoint_ref, handoff.checkpoint_ref) && same(event.event_data.checkpoint_event_ref, checkpoint.event_ref));
  if (!checkpointEvent || !finalization || finalization.sequence <= checkpointEvent.sequence) throw new Error("safe resume checkpoint lacks event-chain finalization evidence");
  if (!resumableProviderBinding(checkpoint.provider_resume_binding)) throw new Error("safe resume provider binding is not fail-closed");
  if (handoff.safe_resume.identity_reference_digest !== checkpoint.provider_resume_binding.identity_reference_digest || handoff.safe_resume.adapter_id !== checkpoint.provider_resume_binding.adapter_id) {
    throw new Error("handoff resume identity drift");
  }
  if (handoff.safe_resume.preconditions.length === 0 || typeof handoff.safe_resume.invocation_template !== "string") {
    throw new Error("safe resume requires preconditions and an invocation template");
  }
  return true;
}

export function assertFinalReport(report, { run, events, capabilityPlan, checkpoints = [], leaseHistory = [] }) {
  assertRunProjection(run, events);
  assertRunStewardDigest(report, "report_digest");
  assertRunStewardDigest(capabilityPlan, "plan_digest");
  checkpoints.forEach(({ value }) => {
    assertRunStewardDigest(value, "checkpoint_digest");
    if (value.run_id !== run.run_id) throw new Error("final report checkpoint history crosses run identity");
  });
  leaseHistory.forEach(({ activeValue, releasedValue }) => {
    assertRunStewardDigest(activeValue, "lease_digest");
    assertRunStewardDigest(releasedValue, "lease_digest");
    if (activeValue.run_id !== run.run_id || releasedValue.run_id !== run.run_id) throw new Error("final report lease history crosses run identity");
    assertStaticLeaseIdentity(activeValue, releasedValue);
  });
  if (report.report_kind !== "final" || report.final_status_marker !== "RUNSTEWARD_FINAL_STATUS") throw new Error("valid final status marker is required");
  if (!["stopped", "completed", "failed", "cancelled"].includes(report.status)) throw new Error("final report does not close the execution attempt");
  if (report.run_id !== run.run_id || report.status !== run.status) throw new Error("final report run projection mismatch");
  if (capabilityPlan.run_id !== run.run_id) throw new Error("final report supplied a cross-run capability plan");
  if (run.capability_plan_ref?.digest !== capabilityPlan.plan_digest) throw new Error("final report supplied a capability plan unbound from the run projection");
  if (report.evidence_dir_collision_key !== run.evidence_dir.collision_key) throw new Error("final report evidence directory drift");
  const reportRefWithPosixSeparators = report.report_ref.replaceAll("\\", "/");
  const normalizedReportRef = pathPosix.normalize(reportRefWithPosixSeparators);
  const expectedEvidenceRoot = `evidence/${run.run_id.replaceAll(":", "-")}/`;
  if (normalizedReportRef !== reportRefWithPosixSeparators || pathPosix.isAbsolute(normalizedReportRef) || !normalizedReportRef.startsWith(expectedEvidenceRoot) || normalizedReportRef.length <= expectedEvidenceRoot.length) {
    throw new Error("final report path is outside the run logical evidence directory");
  }
  if (report.status === "completed" && report.outcome.objective_satisfied !== true) throw new Error("completed report must claim a satisfied objective");
  if (["stopped", "failed", "cancelled"].includes(report.status) && report.outcome.objective_satisfied !== false) throw new Error(`${report.status} report cannot claim objective completion`);
  const terminalEvent = events.find((event) => event.event_digest === report.terminal_event_ref.digest);
  const expectedEventType = { stopped: "run.stopped", completed: "run.completed", failed: "run.failed", cancelled: "run.cancelled" }[report.status];
  if (!terminalEvent || terminalEvent.run_id !== run.run_id || terminalEvent.to_state !== report.status || terminalEvent.event_type !== expectedEventType) {
    throw new Error("final report terminal event mismatch");
  }
  const finalization = events.find((event) => event.event_type === "report.finalized" && event.event_data.report_ref.digest === report.report_digest);
  const finalizationProjectionRef = report.status === "stopped" ? finalization?.projection.stopped_report_ref : finalization?.projection.final_status_report_ref;
  if (!finalization || finalization.sequence <= terminalEvent.sequence || !same(report.terminal_event_ref, finalization.event_data.terminal_event_ref) || !same(finalizationProjectionRef, finalization.event_data.report_ref)) {
    throw new Error("report.finalized binding is missing or invalid");
  }
  if (report.report_ref !== finalization.event_data.report_ref.ref) throw new Error("final report path differs from report.finalized event");
  const projectedReportRef = report.status === "stopped" ? run.stopped_report_ref : run.final_status_report_ref;
  if (!same(projectedReportRef, finalization.event_data.report_ref)) throw new Error("run projection does not bind the report in its status-appropriate slot");
  if (report.status === "stopped" && run.final_status_report_ref !== null) throw new Error("stopped report cannot occupy the terminal report slot");
  if (!same(report.capability_plan_ref, run.capability_plan_ref) || report.capability_plan_ref.digest !== capabilityPlan.plan_digest) throw new Error("final report capability plan drift");
  const expectedCheckpointRefs = events.filter((event) => event.event_type === "checkpoint.finalized").map((event) => event.event_data.checkpoint_ref);
  if (!same(report.checkpoint_refs, expectedCheckpointRefs)) throw new Error("final report checkpoint history drift");
  const expectedLeaseRefs = events.filter((event) => event.event_type === "lease.released").map((event) => event.event_data.released_lease_ref);
  if (!same(report.lease_history_refs, expectedLeaseRefs)) throw new Error("final report lease history drift");
  const suppliedCheckpointRefs = checkpoints.map(({ ref, value }) => ({ ref, digest: value.checkpoint_digest }));
  const suppliedLeaseRefs = leaseHistory.map(({ releasedRef, releasedValue }) => ({ ref: releasedRef, digest: releasedValue.lease_digest }));
  if (!same(suppliedCheckpointRefs, expectedCheckpointRefs) || !same(suppliedLeaseRefs, expectedLeaseRefs)) throw new Error("supplied report artifacts differ from event-derived history");
  for (const lease of leaseHistory) {
    const releaseEvent = events.find((event) => event.event_type === "lease.released" && event.event_data.active_lease_ref.ref === lease.activeRef && event.event_data.active_lease_ref.digest === lease.activeValue.lease_digest && event.event_data.released_lease_ref.ref === lease.releasedRef && event.event_data.released_lease_ref.digest === lease.releasedValue.lease_digest);
    if (!releaseEvent) throw new Error("report lease history lacks matching active and released artifact evidence");
  }
  return true;
}

export function assertRunProjection(run, events) {
  assertRunStewardDigest(run, "run_digest");
  const projection = foldStateEvents(events);
  if (!same(run, projection)) throw new Error("run projection differs from the complete event fold");
  if (run.lifecycle_policy.push_policy !== "forbidden") throw new Error("push policy widened");
  return projection;
}
