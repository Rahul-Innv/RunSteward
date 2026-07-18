import assert from "node:assert/strict";
import test from "node:test";
import { bodyWithoutDigest, runstewardDigest } from "../src/canonical-json.mjs";
import { readJsonStrict, resolveContractPath } from "../src/contract-loader.mjs";
import { foldStateEvents } from "../src/event-fold.mjs";

async function seed() {
  return Promise.all(["created", "plan-bound", "queued"].map((name) => readJsonStrict(resolveContractPath(`contracts/fixtures/valid/state-event.${name}.json`))));
}

function append(events, eventType, toState, mutateProjection, eventData) {
  const prior = events.at(-1);
  const projection = structuredClone(prior.projection);
  projection.status = toState;
  mutateProjection?.(projection);
  const event = {
    schema_version: "runsteward.state-event/v1", event_id: `event:test:${events.length + 1}`,
    run_id: prior.run_id, sequence: events.length + 1, occurred_at: `2026-07-14T00:${String(events.length + 1).padStart(2, "0")}:00Z`,
    event_type: eventType, actor: { kind: "test-harness", actor_id: "rw1-test" },
    from_state: prior.to_state, to_state: toState, reason_code: "TEST_EVENT", reason_summary: "Deterministic lifecycle test event.",
    previous_event_digest: prior.event_digest, evidence_refs: [], projection, event_data: eventData,
    event_digest: "sha256:" + "0".repeat(64)
  };
  event.event_digest = runstewardDigest(bodyWithoutDigest(event, "event_digest"));
  events.push(event);
  return event;
}

test("fixture event chain folds to the committed run projection", async () => {
  const events = await seed();
  const expected = await readJsonStrict(resolveContractPath("contracts/fixtures/valid/run.queued.json"));
  assert.deepEqual(foldStateEvents(events), expected);
});

test("duplicate event ids and illegal typed transitions fail closed", async () => {
  const events = await seed();
  events[2].event_id = events[1].event_id;
  events[2].event_digest = runstewardDigest(bodyWithoutDigest(events[2], "event_digest"));
  assert.throws(() => foldStateEvents(events), /duplicate event_id/);
  const illegal = await seed();
  illegal[2].event_type = "run.started";
  illegal[2].event_data = { kind: "run.started" };
  illegal[2].event_digest = runstewardDigest(bodyWithoutDigest(illegal[2], "event_digest"));
  assert.throws(() => foldStateEvents(illegal), /illegal/);
});

test("queue cannot bypass open, denied, or unevidenced owner gates", async () => {
  const base = (await seed()).slice(0, 2);
  const planRef = base.at(-1).projection.capability_plan_ref;
  const gate = { gate_id: "gate:publish", owner: "owner:local", state: "open", protected_action: "Authorize the bounded action.", evidence_refs: [] };
  append(base, "run.approval_required", "needs_approval", (p) => { p.owner_gates = [gate]; }, { kind: "run.approval_required", owner_gate_ids: [gate.gate_id], capability_plan_ref: planRef });
  for (const state of ["open", "denied", "satisfied"]) {
    const events = structuredClone(base);
    append(events, "run.queued", "queued", (p) => { p.owner_gates[0].state = state; }, { kind: "run.queued", queue_purpose: "initial", resume_from_state: null, previous_lease_ref: null });
    assert.throws(() => foldStateEvents(events), /satisfied with evidence/);
  }
  const events = structuredClone(base);
  append(events, "run.queued", "queued", (p) => {
    p.owner_gates[0].state = "satisfied";
    p.owner_gates[0].evidence_refs = [{ ref: "evidence/owner-approval.json", digest: "sha256:" + "a".repeat(64), media_type: "application/json" }];
  }, { kind: "run.queued", queue_purpose: "initial", resume_from_state: null, previous_lease_ref: null });
  assert.equal(foldStateEvents(events).status, "queued");
});

test("release-before-stopped report and stopped-report clearing on resume are coherent", async () => {
  const events = await seed();
  const activeRef = { ref: "leases/lease-1-active.json", digest: "sha256:" + "1".repeat(64) };
  const releasedRef = { ref: "leases/lease-1-released.json", digest: "sha256:" + "2".repeat(64) };
  append(events, "lease.acquired", "allocated", (p) => { p.lease_ref = activeRef; }, { kind: "lease.acquired", lease_ref: activeRef, lease_epoch: 1, lease_purpose: "initial", previous_lease_ref: null });
  append(events, "run.started", "running", null, { kind: "run.started" });
  append(events, "run.waiting", "waiting", null, { kind: "run.waiting", condition_id: "condition:test", predicate_digest: "sha256:" + "d".repeat(64), observation_state: "pending", evidence_refs: [] });
  append(events, "lease.released", "waiting", (p) => { p.lease_ref = null; }, { kind: "lease.released", active_lease_ref: activeRef, released_lease_ref: releasedRef });
  const stopped = append(events, "run.stopped", "stopped", null, { kind: "run.stopped" });
  const reportRef = { ref: "reports/stopped.json", digest: "sha256:" + "3".repeat(64) };
  append(events, "report.finalized", "stopped", (p) => { p.stopped_report_ref = reportRef; }, { kind: "report.finalized", report_ref: reportRef, terminal_event_ref: { ref: "events/stopped.json", digest: stopped.event_digest } });
  const newRef = { ref: "leases/lease-2-active.json", digest: "sha256:" + "4".repeat(64) };
  append(events, "lease.acquired", "allocated", (p) => { p.lease_ref = newRef; p.stopped_report_ref = null; }, { kind: "lease.acquired", lease_ref: newRef, lease_epoch: 2, lease_purpose: "resume", previous_lease_ref: releasedRef });
  assert.equal(foldStateEvents(events).stopped_report_ref, null);
  const bad = structuredClone(events);
  bad.at(-1).projection.stopped_report_ref = reportRef;
  bad.at(-1).event_digest = runstewardDigest(bodyWithoutDigest(bad.at(-1), "event_digest"));
  assert.throws(() => foldStateEvents(bad), /must clear/);
});

test("null-lease stopped and cancelled attempts can finalize reports without invented release evidence", async () => {
  for (const terminalType of ["run.stopped", "run.cancelled"]) {
    const events = (await seed()).slice(0, 2);
    const planRef = events.at(-1).projection.capability_plan_ref;
    const gate = { gate_id: "gate:no-lease", owner: "owner:local", state: "open", protected_action: "Await owner disposition.", evidence_refs: [] };
    append(events, "run.approval_required", "needs_approval", (p) => { p.owner_gates = [gate]; }, { kind: "run.approval_required", owner_gate_ids: [gate.gate_id], capability_plan_ref: planRef });
    const status = terminalType === "run.stopped" ? "stopped" : "cancelled";
    const terminal = append(events, terminalType, status, null, { kind: terminalType });
    const reportRef = { ref: `evidence/run-atomic-01/reports/${status}.json`, digest: "sha256:" + "e".repeat(64) };
    append(events, "report.finalized", status, (p) => {
      if (status === "stopped") p.stopped_report_ref = reportRef;
      else p.final_status_report_ref = reportRef;
    }, { kind: "report.finalized", report_ref: reportRef, terminal_event_ref: { ref: `events/${status}.json`, digest: terminal.event_digest } });
    assert.equal(foldStateEvents(events).status, status);
  }
});

function requireApproval(events, gateId = "gate:retry") {
  const planRef = events.at(-1).projection.capability_plan_ref;
  const gate = { gate_id: gateId, owner: "owner:local", state: "open", protected_action: "Authorize the bounded retry.", evidence_refs: [] };
  append(events, "run.approval_required", "needs_approval", (projection) => { projection.owner_gates = [gate]; }, {
    kind: "run.approval_required", owner_gate_ids: [gateId], capability_plan_ref: planRef
  });
}

function satisfyApproval(projection) {
  projection.owner_gates[0].state = "satisfied";
  projection.owner_gates[0].evidence_refs = [{ ref: "evidence/owner-retry.json", digest: "sha256:" + "a".repeat(64), media_type: "application/json" }];
}

async function priorAttemptAt(origin) {
  const events = await seed();
  const activeRef = { ref: "leases/reset-epoch1-active.json", digest: "sha256:" + "5".repeat(64) };
  const releasedRef = { ref: "leases/reset-epoch1-released.json", digest: "sha256:" + "6".repeat(64) };
  append(events, "lease.acquired", "allocated", (projection) => { projection.lease_ref = activeRef; }, {
    kind: "lease.acquired", lease_ref: activeRef, lease_epoch: 1, lease_purpose: "initial", previous_lease_ref: null
  });
  append(events, "run.started", "running", null, { kind: "run.started" });
  if (origin === "checkpointed") {
    const checkpointed = append(events, "run.checkpointed", "checkpointed", null, { kind: "run.checkpointed" });
    const checkpointRef = { ref: "checkpoints/reset-epoch1.json", digest: "sha256:" + "7".repeat(64) };
    append(events, "checkpoint.finalized", "checkpointed", (projection) => { projection.latest_checkpoint_ref = checkpointRef; }, {
      kind: "checkpoint.finalized", checkpoint_ref: checkpointRef,
      checkpoint_event_ref: { ref: "events/reset-checkpointed.json", digest: checkpointed.event_digest }
    });
  } else {
    append(events, "run.waiting", "waiting", null, {
      kind: "run.waiting", condition_id: "condition:reset", predicate_digest: "sha256:" + "d".repeat(64), observation_state: "pending", evidence_refs: []
    });
  }
  append(events, "lease.released", origin === "checkpointed" ? "checkpointed" : "waiting", (projection) => { projection.lease_ref = null; }, {
    kind: "lease.released", active_lease_ref: activeRef, released_lease_ref: releasedRef
  });
  if (origin === "stopped") append(events, "run.stopped", "stopped", null, { kind: "run.stopped" });
  return { events, activeRef, releasedRef };
}

test("initial queue and epoch-one acquisition cannot reset waiting, checkpointed, or null-report stopped history", async () => {
  for (const origin of ["waiting", "checkpointed", "stopped"]) {
    const { events } = await priorAttemptAt(origin);
    requireApproval(events, `gate:${origin}-retry`);
    append(events, "run.queued", "queued", satisfyApproval, {
      kind: "run.queued", queue_purpose: "initial", resume_from_state: null, previous_lease_ref: null
    });
    assert.throws(() => foldStateEvents(events), /initial queue cannot reset/);
  }
});

test("active-lease approval cannot enter a dead-end queue", async () => {
  const events = await seed();
  const activeRef = { ref: "leases/active-approval.json", digest: "sha256:" + "8".repeat(64) };
  append(events, "lease.acquired", "allocated", (projection) => { projection.lease_ref = activeRef; }, {
    kind: "lease.acquired", lease_ref: activeRef, lease_epoch: 1, lease_purpose: "initial", previous_lease_ref: null
  });
  append(events, "run.started", "running", null, { kind: "run.started" });
  requireApproval(events, "gate:active-lease");
  append(events, "run.queued", "queued", satisfyApproval, {
    kind: "run.queued", queue_purpose: "initial", resume_from_state: null, previous_lease_ref: null
  });
  assert.throws(() => foldStateEvents(events), /released or never-acquired lease/);
});

test("stopped approval origin cannot be laundered as checkpointed resume", async () => {
  const { events, releasedRef } = await priorAttemptAt("stopped");
  const stopped = [...events].reverse().find((event) => event.event_type === "run.stopped");
  const stoppedReportRef = { ref: "reports/reset-stopped.json", digest: "sha256:" + "9".repeat(64) };
  append(events, "report.finalized", "stopped", (projection) => { projection.stopped_report_ref = stoppedReportRef; }, {
    kind: "report.finalized", report_ref: stoppedReportRef, terminal_event_ref: { ref: "events/reset-stopped.json", digest: stopped.event_digest }
  });
  requireApproval(events, "gate:stopped-resume");
  append(events, "run.queued", "queued", satisfyApproval, {
    kind: "run.queued", queue_purpose: "resume", resume_from_state: "checkpointed", previous_lease_ref: releasedRef
  });
  assert.throws(() => foldStateEvents(events), /exact approval origin/);
});
