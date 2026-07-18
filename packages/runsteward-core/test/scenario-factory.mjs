import { bodyWithoutDigest, runstewardDigest } from "../src/canonical-json.mjs";
import { readJsonStrict, resolveContractPath } from "../src/contract-loader.mjs";
import { foldStateEvents } from "../src/event-fold.mjs";

const ZERO = "sha256:" + "0".repeat(64);

function refresh(value, field) {
  value[field] = runstewardDigest(bodyWithoutDigest(value, field));
  return value;
}

function ref(refPath, value, field) {
  return { ref: refPath, digest: value[field] };
}

function eventRef(event) {
  return { ref: `evidence/events/${event.event_id.replaceAll(":", "-")}.json`, digest: event.event_digest };
}

function append(events, eventType, toState, mutateProjection, eventData, id) {
  const prior = events.at(-1);
  const projection = structuredClone(prior.projection);
  projection.status = toState;
  mutateProjection?.(projection);
  const sequence = events.length + 1;
  const event = {
    schema_version: "runsteward.state-event/v1", event_id: `event:${id}:${sequence}`, run_id: prior.run_id,
    sequence, occurred_at: `2026-07-14T01:${String(sequence).padStart(2, "0")}:00Z`, event_type: eventType,
    actor: { kind: "test-harness", actor_id: "rw1-fixture-builder" }, from_state: prior.to_state, to_state: toState,
    reason_code: "FIXTURE_EVENT", reason_summary: "Deterministic provider-neutral lifecycle fixture event.",
    previous_event_digest: prior.event_digest, evidence_refs: [], projection, event_data: eventData, event_digest: ZERO
  };
  refresh(event, "event_digest");
  events.push(event);
  return event;
}

async function initialEvents({ id, planName, initialOwnerGateIds = [] }) {
  const plan = await readJsonStrict(resolveContractPath(`contracts/fixtures/valid/capability-plan.${planName}.json`));
  plan.capability_plan_id = `plan:${id}`;
  plan.run_id = `run:${id}`;
  if (JSON.stringify(plan.owner_gates) !== JSON.stringify(initialOwnerGateIds)) throw new Error("scenario owner gates differ from the qualified capability plan template");
  const expectedAuthorization = initialOwnerGateIds.length === 0 ? "not-required" : "requires-owner";
  if (plan.authorization_state !== expectedAuthorization) throw new Error("scenario authorization differs from the qualified capability plan template");
  refresh(plan, "plan_digest");
  const planRefKind = planName === "initial-gated" ? "atomic" : planName;
  const planRef = ref(`contracts/fixtures/scenarios/capability-plan.${id}.${planRefKind}.json`, plan, "plan_digest");
  const created = await readJsonStrict(resolveContractPath("contracts/fixtures/valid/state-event.created.json"));
  created.run_id = `run:${id}`;
  created.event_id = `event:${id}:1`;
  created.projection.task_id = `task:${id}`;
  created.projection.capability_plan_ref = null;
  created.projection.lease_ref = null;
  created.projection.latest_checkpoint_ref = null;
  created.projection.stopped_report_ref = null;
  created.projection.final_status_report_ref = null;
  refresh(created, "event_digest");
  const events = [created];
  append(events, "capability-plan.bound", "planned", (p) => { p.capability_plan_ref = planRef; }, { kind: "capability-plan.bound", capability_plan_ref: planRef }, id);
  if (initialOwnerGateIds.length === 0) {
    append(events, "run.queued", "queued", null, { kind: "run.queued", queue_purpose: "initial", resume_from_state: null, previous_lease_ref: null }, id);
  } else {
    const gates = initialOwnerGateIds.map((gateId) => ({
      gate_id: gateId, owner: "owner:local", state: "open",
      protected_action: "Authorize the bounded initial local execution.", evidence_refs: []
    }));
    append(events, "run.approval_required", "needs_approval", (p) => { p.owner_gates = gates; }, {
      kind: "run.approval_required", owner_gate_ids: initialOwnerGateIds, capability_plan_ref: planRef
    }, id);
    append(events, "run.queued", "queued", (p) => {
      p.owner_gates = p.owner_gates.map((gate) => ({
        ...gate, state: "satisfied",
        evidence_refs: [{ ref: `evidence/${gate.gate_id.replaceAll(":", "-")}.json`, digest: "sha256:" + "a".repeat(64), media_type: "application/json" }]
      }));
    }, { kind: "run.queued", queue_purpose: "initial", resume_from_state: null, previous_lease_ref: null }, id);
  }
  return { events, plan, planRef };
}

function buildLease(template, { id, epoch, purpose, status = "active", previous = null }) {
  const lease = structuredClone(template);
  lease.lease_id = `lease:${id}:${epoch}`;
  lease.run_id = `run:${id}`;
  lease.task_id = `task:${id}`;
  lease.lease_epoch = epoch;
  lease.purpose = purpose;
  lease.status = status;
  lease.previous_lease_id = previous?.lease_id ?? null;
  lease.previous_lease_ref = previous ? ref(`leases/${previous.lease_id.replaceAll(":", "-")}-released.json`, previous, "lease_digest") : null;
  lease.release_reason = status === "released" ? "The execution attempt released its local lease before reporting or resuming." : null;
  refresh(lease, "lease_digest");
  return lease;
}

function releaseLease(active) {
  const released = structuredClone(active);
  released.status = "released";
  released.release_reason = "The execution attempt released its local lease before reporting or resuming.";
  refresh(released, "lease_digest");
  return released;
}

export async function buildFullLifecycleScenario({ providerMode = "claude", resumeRequiresApproval = false } = {}) {
  const id = providerMode === "codex" ? "atomic-full-codex-01" : resumeRequiresApproval ? "atomic-gated-01" : "atomic-full-01";
  const { events, plan, planRef } = await initialEvents({ id, planName: "atomic" });
  const leaseTemplate = await readJsonStrict(resolveContractPath("contracts/fixtures/valid/worktree-lease.active.json"));
  const lease1Active = buildLease(leaseTemplate, { id, epoch: 1, purpose: "initial" });
  const lease1ActiveRef = ref(`contracts/fixtures/scenarios/lease.${id}.epoch1.active.json`, lease1Active, "lease_digest");
  append(events, "lease.acquired", "allocated", (p) => { p.lease_ref = lease1ActiveRef; }, { kind: "lease.acquired", lease_ref: lease1ActiveRef, lease_epoch: 1, lease_purpose: "initial", previous_lease_ref: null }, id);
  const allocatedRun = foldStateEvents(events);
  append(events, "run.started", "running", null, { kind: "run.started" }, id);
  const runningRun = foldStateEvents(events);
  const waitingEvents = structuredClone(events);
  append(waitingEvents, "run.waiting", "waiting", null, { kind: "run.waiting", condition_id: "condition:local-evidence", predicate_digest: "sha256:" + "d".repeat(64), observation_state: "pending", evidence_refs: [] }, id);
  const waitingRun = foldStateEvents(waitingEvents);

  const checkpointEvent = append(events, "run.checkpointed", "checkpointed", null, { kind: "run.checkpointed" }, id);
  const checkpoint = await readJsonStrict(resolveContractPath("contracts/fixtures/valid/checkpoint.complete.json"));
  checkpoint.checkpoint_id = `checkpoint:${id}:1`;
  checkpoint.run_id = `run:${id}`;
  checkpoint.event_ref = eventRef(checkpointEvent);
  checkpoint.lease_id = lease1Active.lease_id;
  checkpoint.lease_epoch = 1;
  checkpoint.capability_plan_ref = planRef;
  checkpoint.provider_resume_binding = providerMode === "codex"
    ? { adapter_id: "codex-local", identity_reference_digest: "sha256:" + "c".repeat(64), verification_state: "verified" }
    : { adapter_id: "claude-code-local", identity_reference_digest: null, verification_state: "not-required" };
  refresh(checkpoint, "checkpoint_digest");
  const checkpointRef = ref(`contracts/fixtures/scenarios/checkpoint.${id}.${providerMode === "codex" ? "codex-verified" : "claude-not-required"}.json`, checkpoint, "checkpoint_digest");
  append(events, "checkpoint.finalized", "checkpointed", (p) => { p.latest_checkpoint_ref = checkpointRef; }, { kind: "checkpoint.finalized", checkpoint_ref: checkpointRef, checkpoint_event_ref: eventRef(checkpointEvent) }, id);

  const stoppedEvent = append(events, "run.stopped", "stopped", null, { kind: "run.stopped" }, id);
  const lease1Released = releaseLease(lease1Active);
  const lease1ReleasedRef = ref(`contracts/fixtures/scenarios/lease.${id}.epoch1.released.json`, lease1Released, "lease_digest");
  append(events, "lease.released", "stopped", (p) => { p.lease_ref = null; }, { kind: "lease.released", active_lease_ref: lease1ActiveRef, released_lease_ref: lease1ReleasedRef }, id);

  const handoff = await readJsonStrict(resolveContractPath("contracts/fixtures/valid/handoff.checkpointed.json"));
  handoff.handoff_id = `handoff:${id}:1`;
  handoff.run_id = `run:${id}`;
  handoff.checkpoint_ref = checkpointRef;
  handoff.safe_resume.adapter_id = checkpoint.provider_resume_binding.adapter_id;
  handoff.safe_resume.identity_reference_digest = checkpoint.provider_resume_binding.identity_reference_digest;
  handoff.redactions = [{ class: "private-prompt", replacement: "[REDACTED_PRIVATE_PROMPT]", source_ref: "evidence/raw/private-prompt.txt" }];
  refresh(handoff, "handoff_digest");
  const handoffRef = ref(`contracts/fixtures/scenarios/handoff.${id}.redacted.json`, handoff, "handoff_digest");

  const stoppedReport = await readJsonStrict(resolveContractPath("contracts/fixtures/valid/report.stopped.json"));
  stoppedReport.report_id = `report:${id}:stopped`;
  stoppedReport.run_id = `run:${id}`;
  stoppedReport.terminal_event_ref = eventRef(stoppedEvent);
  stoppedReport.capability_plan_ref = planRef;
  stoppedReport.lease_history_refs = [lease1ReleasedRef];
  stoppedReport.checkpoint_refs = [checkpointRef];
  stoppedReport.handoff_ref = handoffRef;
  stoppedReport.report_ref = `evidence/run-${id.replaceAll(":", "-")}/reports/stopped.json`;
  refresh(stoppedReport, "report_digest");
  const stoppedReportRef = ref(stoppedReport.report_ref, stoppedReport, "report_digest");
  append(events, "report.finalized", "stopped", (p) => { p.stopped_report_ref = stoppedReportRef; }, { kind: "report.finalized", report_ref: stoppedReportRef, terminal_event_ref: eventRef(stoppedEvent) }, id);
  const stoppedRun = foldStateEvents(events);

  const lease2Active = buildLease(leaseTemplate, { id, epoch: 2, purpose: "resume", previous: lease1Released });
  lease2Active.previous_lease_ref = lease1ReleasedRef;
  refresh(lease2Active, "lease_digest");
  const lease2ActiveRef = ref(`contracts/fixtures/scenarios/lease.${id}.epoch2.active.json`, lease2Active, "lease_digest");
  let resumeApprovalRun = null;
  let resumeQueuedRun = null;
  if (resumeRequiresApproval) {
    const gate = { gate_id: "gate:resume-local", owner: "owner:local", state: "open", protected_action: "Authorize resume under the new local lease epoch.", evidence_refs: [] };
    append(events, "run.approval_required", "needs_approval", (p) => { p.owner_gates = [gate]; }, { kind: "run.approval_required", owner_gate_ids: [gate.gate_id], capability_plan_ref: planRef }, id);
    resumeApprovalRun = foldStateEvents(events);
    append(events, "run.queued", "queued", (p) => {
      p.owner_gates[0].state = "satisfied";
      p.owner_gates[0].evidence_refs = [{ ref: "evidence/owner-resume-approval.json", digest: "sha256:" + "a".repeat(64), media_type: "application/json" }];
    }, { kind: "run.queued", queue_purpose: "resume", resume_from_state: "stopped", previous_lease_ref: lease1ReleasedRef }, id);
    resumeQueuedRun = foldStateEvents(events);
  }
  append(events, "lease.acquired", "allocated", (p) => { p.lease_ref = lease2ActiveRef; p.stopped_report_ref = null; }, { kind: "lease.acquired", lease_ref: lease2ActiveRef, lease_epoch: 2, lease_purpose: "resume", previous_lease_ref: lease1ReleasedRef }, id);
  const resumeEvent = append(events, "run.resumed", "running", null, {
    kind: "run.resumed", checkpoint_ref: checkpointRef, checkpoint_event_id: checkpointEvent.event_id,
    checkpoint_event_sequence: checkpointEvent.sequence, checkpoint_event_digest: checkpointEvent.event_digest,
    new_lease_ref: lease2ActiveRef, prior_lease_ref: lease1ReleasedRef, new_lease_id: lease2Active.lease_id,
    new_lease_epoch: 2, capability_plan_ref: planRef, repository_id: events.at(-1).projection.repository.repository_id,
    original_source_head: events.at(-1).projection.repository.source_head, observed_head: checkpoint.repository.observed_head,
    branch_name: checkpoint.repository.branch_name, worktree_collision_key: checkpoint.repository.worktree.collision_key,
    state_collision_key: events.at(-1).projection.state_dir.collision_key, evidence_collision_key: events.at(-1).projection.evidence_dir.collision_key,
    adapter_id: checkpoint.provider_resume_binding.adapter_id, identity_reference_digest: checkpoint.provider_resume_binding.identity_reference_digest
  }, id);
  const resumedRun = foldStateEvents(events);

  append(events, "run.stop_requested", "stopping", null, { kind: "run.stop_requested" }, id);
  const completedEvent = append(events, "run.completed", "completed", null, { kind: "run.completed" }, id);
  const lease2Released = releaseLease(lease2Active);
  const lease2ReleasedRef = ref(`contracts/fixtures/scenarios/lease.${id}.epoch2.released.json`, lease2Released, "lease_digest");
  append(events, "lease.released", "completed", (p) => { p.lease_ref = null; }, { kind: "lease.released", active_lease_ref: lease2ActiveRef, released_lease_ref: lease2ReleasedRef }, id);
  const completedReport = await readJsonStrict(resolveContractPath("contracts/fixtures/valid/report.final.json"));
  completedReport.report_id = `report:${id}:completed`;
  completedReport.run_id = `run:${id}`;
  completedReport.terminal_event_ref = eventRef(completedEvent);
  completedReport.capability_plan_ref = planRef;
  completedReport.lease_history_refs = [lease1ReleasedRef, lease2ReleasedRef];
  completedReport.checkpoint_refs = [checkpointRef];
  completedReport.handoff_ref = handoffRef;
  completedReport.report_ref = `evidence/run-${id.replaceAll(":", "-")}/reports/completed.json`;
  refresh(completedReport, "report_digest");
  const completedReportRef = ref(completedReport.report_ref, completedReport, "report_digest");
  append(events, "report.finalized", "completed", (p) => { p.final_status_report_ref = completedReportRef; }, { kind: "report.finalized", report_ref: completedReportRef, terminal_event_ref: eventRef(completedEvent) }, id);
  const completedRun = foldStateEvents(events);

  return {
    id, events, plan, allocatedRun, runningRun, waitingEvents, waitingRun, checkpoint, handoff,
    stoppedReport, stoppedRun, lease1Active, lease1Released, lease2Active, lease2Released,
    resumeApprovalRun, resumeQueuedRun, resumeEvent, resumedRun, completedReport, completedRun
  };
}

export async function buildBundleRunningScenario() {
  const id = "bundle-running-01";
  const { events, plan } = await initialEvents({ id, planName: "bundle" });
  const template = await readJsonStrict(resolveContractPath("contracts/fixtures/valid/worktree-lease.active.json"));
  const lease = buildLease(template, { id, epoch: 1, purpose: "initial" });
  const leaseRef = ref(`contracts/fixtures/scenarios/lease.${id}.epoch1.active.json`, lease, "lease_digest");
  append(events, "lease.acquired", "allocated", (p) => { p.lease_ref = leaseRef; }, { kind: "lease.acquired", lease_ref: leaseRef, lease_epoch: 1, lease_purpose: "initial", previous_lease_ref: null }, id);
  append(events, "run.started", "running", null, { kind: "run.started" }, id);
  return { id, events, plan, lease, run: foldStateEvents(events) };
}

export async function buildInitialOwnerGatedScenario() {
  const id = "atomic-initial-gated-01";
  const { events, plan, planRef } = await initialEvents({
    id, planName: "initial-gated", initialOwnerGateIds: ["approval:initial-local"]
  });
  return { id, events, plan, planRef, run: foldStateEvents(events) };
}

export function appendScenarioEvent(...args) {
  return append(...args);
}
