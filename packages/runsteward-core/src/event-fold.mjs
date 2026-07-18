import { assertRunStewardDigest, canonicalizeRunSteward, runstewardDigest } from "./canonical-json.mjs";

const RESUMABLE_STATES = new Set(["waiting", "checkpointed", "stopped"]);

const PAIRS_BY_EVENT = new Map([
  ["run.created", [[null, "planned"]]],
  ["capability-plan.bound", [["planned", "planned"], ["needs_approval", "needs_approval"], ["stopped", "stopped"]]],
  ["run.queued", [["planned", "queued"], ["needs_approval", "queued"]]],
  ["lease.acquired", [["queued", "allocated"], ["waiting", "allocated"], ["checkpointed", "allocated"], ["stopped", "allocated"]]],
  ["run.started", [["allocated", "running"]]],
  ["run.resumed", [["allocated", "running"]]],
  ["run.waiting", [["running", "waiting"]]],
  ["run.approval_required", [["planned", "needs_approval"], ["running", "needs_approval"], ["waiting", "needs_approval"], ["checkpointed", "needs_approval"], ["stopped", "needs_approval"]]],
  ["run.checkpointed", [["running", "checkpointed"]]],
  ["checkpoint.finalized", [["checkpointed", "checkpointed"]]],
  ["run.stop_requested", [["running", "stopping"]]],
  ["run.stopped", [["waiting", "stopped"], ["needs_approval", "stopped"], ["checkpointed", "stopped"], ["stopping", "stopped"]]],
  ["run.completed", [["stopping", "completed"]]],
  ["run.failed", [["running", "failed"], ["waiting", "failed"], ["stopping", "failed"]]],
  ["run.cancelled", [["needs_approval", "cancelled"], ["checkpointed", "cancelled"], ["stopped", "cancelled"]]],
  ["report.finalized", [["stopped", "stopped"], ["completed", "completed"], ["failed", "failed"], ["cancelled", "cancelled"]]],
  ["lease.released", [["waiting", "waiting"], ["checkpointed", "checkpointed"], ["stopped", "stopped"], ["completed", "completed"], ["failed", "failed"], ["cancelled", "cancelled"]]]
]);

const IMMUTABLE_FIELDS = [
  "task_id", "created_at", "objective_digest", "objective_summary", "repository",
  "lifecycle_policy", "state_dir", "evidence_dir", "sensor_bindings"
];

const MUTABLE_FIELDS = [
  "lease_ref", "capability_plan_ref", "latest_checkpoint_ref", "owner_gates",
  "stopped_report_ref", "final_status_report_ref"
];

const ALLOWED_MUTATIONS = new Map([
  ["capability-plan.bound", new Set(["capability_plan_ref"])],
  ["run.queued", new Set(["owner_gates"])],
  ["lease.acquired", new Set(["lease_ref", "stopped_report_ref"])],
  ["run.approval_required", new Set(["owner_gates"])],
  ["checkpoint.finalized", new Set(["latest_checkpoint_ref"])],
  ["report.finalized", new Set(["stopped_report_ref", "final_status_report_ref"])],
  ["lease.released", new Set(["lease_ref"])]
]);

function same(left, right) {
  return canonicalizeRunSteward(left) === canonicalizeRunSteward(right);
}

function pairAllowed(eventType, fromState, toState) {
  return (PAIRS_BY_EVENT.get(eventType) ?? []).some(([from, to]) => from === fromState && to === toState);
}

function assertProjectionMutation(prior, current, event) {
  for (const field of IMMUTABLE_FIELDS) {
    if (!same(prior[field], current[field])) throw new Error(`immutable run field drift: ${field}`);
  }
  const allowed = ALLOWED_MUTATIONS.get(event.event_type) ?? new Set();
  for (const field of MUTABLE_FIELDS) {
    if (!allowed.has(field) && !same(prior[field], current[field])) {
      throw new Error(`${event.event_type} cannot change projection.${field}`);
    }
  }
}

function findLatest(priorEvents, eventType) {
  return [...priorEvents].reverse().find((event) => event.event_type === eventType);
}

function assertLeaseAcquired(event, priorProjection, priorEvents) {
  const data = event.event_data;
  const queued = priorEvents.at(-1)?.event_type === "run.queued" ? priorEvents.at(-1) : null;
  const effectiveOrigin = queued?.event_data.queue_purpose === "resume" ? queued.event_data.resume_from_state : event.from_state;
  const effectivePurpose = queued?.event_data.queue_purpose ?? data.lease_purpose;
  const queuedPredecessor = queued?.event_data.previous_lease_ref ?? data.previous_lease_ref;
  if (priorProjection.lease_ref !== null) throw new Error("lease.acquired requires the prior lease_ref to be null");
  if (!same(event.projection.lease_ref, data.lease_ref)) throw new Error("lease.acquired projection mismatch");
  if (effectivePurpose === "initial") {
    const hasPriorAttempt = priorEvents.some((item) => ["lease.acquired", "lease.released", "run.checkpointed", "checkpoint.finalized"].includes(item.event_type));
    if (hasPriorAttempt) throw new Error("initial acquisition cannot reset an existing attempt, lease, or checkpoint history");
    if (event.from_state !== "queued" || data.lease_purpose !== "initial" || data.lease_epoch !== 1 || data.previous_lease_ref !== null || queuedPredecessor !== null) {
      throw new Error("initial acquisition must be epoch one from queued without a predecessor");
    }
    if (!same(event.projection.stopped_report_ref, priorProjection.stopped_report_ref)) throw new Error("initial acquisition changed stopped report history");
    return;
  }
  if (data.lease_purpose !== "resume" || !RESUMABLE_STATES.has(effectiveOrigin) || data.lease_epoch < 2 || data.previous_lease_ref === null || !same(data.previous_lease_ref, queuedPredecessor)) {
    throw new Error("resume acquisition has an invalid origin, epoch, or predecessor");
  }
  const release = findLatest(priorEvents, "lease.released");
  if (!release || !same(release.event_data.released_lease_ref, data.previous_lease_ref)) {
    throw new Error("resume acquisition lacks its matching released predecessor");
  }
  if (effectiveOrigin === "stopped") {
    if (event.projection.stopped_report_ref !== null) throw new Error("resume acquisition must clear the stopped attempt report reference");
  } else if (!same(event.projection.stopped_report_ref, priorProjection.stopped_report_ref)) {
    throw new Error("resume acquisition unexpectedly changed stopped report history");
  }
}

function assertReportFinalized(event, priorProjection, priorEvents) {
  const data = event.event_data;
  const terminal = priorEvents.find((item) => item.event_digest === data.terminal_event_ref.digest);
  const expectedTerminalType = {
    stopped: "run.stopped", completed: "run.completed", failed: "run.failed", cancelled: "run.cancelled"
  }[event.to_state];
  if (!terminal || terminal.run_id !== event.run_id || terminal.to_state !== event.to_state || terminal.event_type !== expectedTerminalType) {
    throw new Error("report.finalized terminal event binding mismatch");
  }
  let release;
  if (terminal.projection.lease_ref !== null) {
    release = priorEvents.find((item) => item.event_type === "lease.released" && item.sequence > terminal.sequence && same(item.event_data.active_lease_ref, terminal.projection.lease_ref));
  } else {
    const acquisition = [...priorEvents].reverse().find((item) => item.event_type === "lease.acquired" && item.sequence < terminal.sequence);
    release = acquisition ? priorEvents.find((item) => item.event_type === "lease.released" && item.sequence > acquisition.sequence && item.sequence < terminal.sequence && same(item.event_data.active_lease_ref, acquisition.event_data.lease_ref)) : null;
    const interveningAcquisition = release && priorEvents.find((item) => item.event_type === "lease.acquired" && item.sequence > release.sequence && item.sequence < terminal.sequence);
    if (interveningAcquisition) release = undefined;
  }
  if (release === undefined) throw new Error("report.finalized requires the terminal attempt lease to be released first");
  if (event.to_state === "stopped") {
    if (priorProjection.stopped_report_ref !== null || !same(event.projection.stopped_report_ref, data.report_ref)) throw new Error("stopped report must be set exactly once");
    if (!same(event.projection.final_status_report_ref, priorProjection.final_status_report_ref)) throw new Error("stopped report cannot occupy the terminal report reference");
  } else {
    if (priorProjection.final_status_report_ref !== null || !same(event.projection.final_status_report_ref, data.report_ref)) throw new Error("terminal report must be set exactly once");
    if (!same(event.projection.stopped_report_ref, priorProjection.stopped_report_ref)) throw new Error("terminal report changed stopped report history");
  }
}

function assertTypedEventData(event, priorProjection, priorEvents) {
  const data = event.event_data;
  if (data.kind !== event.event_type) throw new Error("event_data.kind differs from event_type");
  if (event.projection.status !== event.to_state) throw new Error("projection status differs from to_state");

  if (event.event_type === "run.created") {
    for (const field of ["lease_ref", "capability_plan_ref", "latest_checkpoint_ref", "stopped_report_ref", "final_status_report_ref"]) {
      if (event.projection[field] !== null) throw new Error(`run.created must initialize ${field} to null`);
    }
  }
  if (event.event_type === "capability-plan.bound" && !same(event.projection.capability_plan_ref, data.capability_plan_ref)) throw new Error("capability-plan.bound projection mismatch");
  if (event.event_type === "lease.acquired") assertLeaseAcquired(event, priorProjection, priorEvents);
  if (event.event_type === "run.started") {
    const acquisition = priorEvents.at(-1);
    if (!acquisition || acquisition.event_type !== "lease.acquired" || acquisition.event_data.lease_purpose !== "initial") throw new Error("run.started must immediately follow an initial acquisition");
  }
  if (event.event_type === "run.approval_required") {
    const projected = event.projection.owner_gates.map((gate) => gate.gate_id);
    if (!same(projected, data.owner_gate_ids)) throw new Error("owner gate projection mismatch");
    if (!same(event.projection.capability_plan_ref, data.capability_plan_ref)) throw new Error("owner gate capability plan mismatch");
  }
  if (event.event_type === "run.queued") {
    if (priorProjection.lease_ref !== null || event.projection.lease_ref !== null) throw new Error("run.queued requires a released or never-acquired lease");
    const approval = event.from_state === "needs_approval" ? priorEvents.at(-1) : null;
    if (event.from_state === "needs_approval" && approval?.event_type !== "run.approval_required") throw new Error("owner-gated queue must immediately follow its approval requirement");
    if (data.queue_purpose === "initial") {
      if (data.resume_from_state !== null || data.previous_lease_ref !== null) throw new Error("initial queue invented resume origin");
      const hasPriorAttempt = priorEvents.some((item) => ["lease.acquired", "lease.released", "run.checkpointed", "checkpoint.finalized"].includes(item.event_type));
      if (hasPriorAttempt || (approval && approval.from_state !== "planned")) throw new Error("initial queue cannot reset prior attempt or checkpoint history");
    } else {
      const release = findLatest(priorEvents, "lease.released");
      if (!approval || data.resume_from_state !== approval.from_state || !RESUMABLE_STATES.has(data.resume_from_state) || !release || !same(release.event_data.released_lease_ref, data.previous_lease_ref)) throw new Error("resume queue lacks its exact approval origin or released predecessor");
    }
    const currentGates = event.projection.owner_gates;
    if (currentGates.some((gate) => gate.state !== "satisfied" || gate.evidence_refs.length === 0)) throw new Error("run.queued requires every declared owner gate to be satisfied with evidence");
    if (event.from_state === "planned") {
      if (priorProjection.owner_gates.length !== 0 || currentGates.length !== 0) throw new Error("planned queue cannot introduce owner gates");
    } else {
      if (priorProjection.owner_gates.length !== currentGates.length) throw new Error("queue changed owner gate membership");
      for (let index = 0; index < currentGates.length; index += 1) {
        const before = priorProjection.owner_gates[index];
        const after = currentGates[index];
        for (const field of ["gate_id", "owner", "protected_action"]) {
          if (!same(before[field], after[field])) throw new Error(`queue changed owner gate identity: ${field}`);
        }
      }
    }
  }
  if (event.event_type === "run.waiting" && data.observation_state !== "pending") throw new Error("run.waiting requires a pending machine-verifiable resume condition");
  if (event.event_type === "checkpoint.finalized") {
    if (!same(event.projection.latest_checkpoint_ref, data.checkpoint_ref)) throw new Error("checkpoint.finalized projection mismatch");
    const checkpointEvent = priorEvents.at(-1);
    if (!checkpointEvent || checkpointEvent.event_type !== "run.checkpointed" || checkpointEvent.event_digest !== data.checkpoint_event_ref.digest) {
      throw new Error("checkpoint.finalized must bind the preceding run.checkpointed event");
    }
  }
  if (event.event_type === "report.finalized") assertReportFinalized(event, priorProjection, priorEvents);
  if (event.event_type === "lease.released") {
    if (event.projection.lease_ref !== null || !same(priorProjection.lease_ref, data.active_lease_ref)) throw new Error("lease.released active lease projection mismatch");
    if (data.active_lease_ref.digest === data.released_lease_ref.digest) throw new Error("released lease snapshot must have a new digest");
  }
  if (event.event_type === "run.resumed") {
    const acquisition = priorEvents.at(-1);
    if (!acquisition || acquisition.event_type !== "lease.acquired" || acquisition.event_data.lease_purpose !== "resume" || !same(acquisition.event_data.lease_ref, data.new_lease_ref) || acquisition.event_data.lease_epoch !== data.new_lease_epoch || !same(acquisition.event_data.previous_lease_ref, data.prior_lease_ref)) {
      throw new Error("run.resumed must immediately follow its matching resume acquisition");
    }
    if (!same(priorProjection.lease_ref, data.new_lease_ref) || !same(event.projection.lease_ref, data.new_lease_ref)) throw new Error("resume new lease projection mismatch");
    if (!same(event.projection.capability_plan_ref, data.capability_plan_ref)) throw new Error("resume capability plan projection mismatch");
    if (!same(priorProjection.latest_checkpoint_ref, data.checkpoint_ref)) throw new Error("resume checkpoint projection mismatch");
    if (event.projection.lifecycle_policy.resume_after_stop_policy !== "verified-checkpoint-only") throw new Error("run policy forbids checkpoint resume");
    if (data.repository_id !== event.projection.repository.repository_id || data.original_source_head !== event.projection.repository.source_head) throw new Error("resume repository binding drift");
    if (data.state_collision_key !== event.projection.state_dir.collision_key || data.evidence_collision_key !== event.projection.evidence_dir.collision_key) throw new Error("resume state or evidence path drift");
    const checkpointEvent = priorEvents.find((item) => item.event_id === data.checkpoint_event_id);
    if (!checkpointEvent || checkpointEvent.sequence !== data.checkpoint_event_sequence || checkpointEvent.event_digest !== data.checkpoint_event_digest || checkpointEvent.event_type !== "run.checkpointed") throw new Error("resume checkpoint event position mismatch");
    const finalized = priorEvents.find((item) => item.event_type === "checkpoint.finalized" && same(item.event_data.checkpoint_ref, data.checkpoint_ref) && item.event_data.checkpoint_event_ref.digest === checkpointEvent.event_digest);
    if (!finalized) throw new Error("resume checkpoint was not finalized in the validated chain");
  }
}

export function foldStateEvents(events) {
  if (!Array.isArray(events) || events.length === 0) throw new Error("at least one state event is required");
  let runId = null;
  let currentState = null;
  let previousDigest = null;
  let priorProjection = null;
  const accepted = [];
  const eventIds = new Set();

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    assertRunStewardDigest(event, "event_digest");
    if (event.sequence !== index + 1) throw new Error(`event sequence ${event.sequence} does not equal ${index + 1}`);
    if (eventIds.has(event.event_id)) throw new Error(`duplicate event_id: ${event.event_id}`);
    eventIds.add(event.event_id);
    if (runId === null) runId = event.run_id;
    if (event.run_id !== runId) throw new Error("event run_id changed inside one chain");
    if (event.previous_event_digest !== previousDigest) throw new Error(`event ${event.event_id} has a broken previous_event_digest`);
    if (event.from_state !== currentState) throw new Error(`event ${event.event_id} from_state does not match the projection`);
    if (!pairAllowed(event.event_type, event.from_state, event.to_state)) throw new Error(`illegal ${event.event_type} transition ${event.from_state} -> ${event.to_state}`);
    if (priorProjection) assertProjectionMutation(priorProjection, event.projection, event);
    assertTypedEventData(event, priorProjection, accepted);
    priorProjection = event.projection;
    currentState = event.to_state;
    previousDigest = event.event_digest;
    accepted.push(event);
  }

  const last = events.at(-1);
  const run = {
    schema_version: "runsteward.run/v1", run_id: runId, ...structuredClone(last.projection),
    last_event_id: last.event_id, last_event_sequence: last.sequence, last_event_digest: last.event_digest
  };
  run.run_digest = runstewardDigest(run);
  return run;
}

export function allowedTransition(eventType, fromState, toState) {
  return pairAllowed(eventType, fromState, toState);
}
