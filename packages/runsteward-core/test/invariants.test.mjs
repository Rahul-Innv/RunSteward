import assert from "node:assert/strict";
import test from "node:test";
import { bodyWithoutDigest, runstewardDigest } from "../src/canonical-json.mjs";
import { readJsonStrict, resolveContractPath } from "../src/contract-loader.mjs";
import { foldStateEvents } from "../src/event-fold.mjs";
import { assertCheckpointResumable, assertFinalReport, assertHandoffSafeResume, assertLeaseUniqueness, assertRunOwnerGateBinding } from "../src/invariants.mjs";
import { appendScenarioEvent, buildFullLifecycleScenario, buildInitialOwnerGatedScenario } from "./scenario-factory.mjs";

function refresh(value, field) {
  value[field] = runstewardDigest(bodyWithoutDigest(value, field));
  return value;
}

function eventRef(event) {
  return { ref: `evidence/events/${event.event_id.replaceAll(":", "-")}.json`, digest: event.event_digest };
}

function rehashChainFrom(events, startIndex) {
  for (let index = startIndex; index < events.length; index += 1) {
    const event = events[index];
    event.previous_event_digest = events[index - 1]?.event_digest ?? null;
    if (event.event_type === "report.finalized") {
      const terminalType = { stopped: "run.stopped", completed: "run.completed", failed: "run.failed", cancelled: "run.cancelled" }[event.to_state];
      const terminal = events.slice(0, index).find((candidate) => candidate.event_type === terminalType);
      event.event_data.terminal_event_ref.digest = terminal.event_digest;
    }
    refresh(event, "event_digest");
  }
}

test("safe handoff accepts verified identity or exact not-required null binding", async () => {
  const claude = await buildFullLifecycleScenario();
  assert.equal(assertHandoffSafeResume(claude.handoff, claude.checkpoint, claude.events), true);
  const codex = await buildFullLifecycleScenario({ providerMode: "codex" });
  assert.equal(assertHandoffSafeResume(codex.handoff, codex.checkpoint, codex.events), true);
});

test("safe handoff rejects unknown and mismatched provider bindings", async () => {
  const scenario = await buildFullLifecycleScenario();
  const { checkpoint, handoff, events } = scenario;
  for (const mutate of [
    (cp) => { cp.provider_resume_binding.verification_state = "unknown"; },
    (cp) => { cp.provider_resume_binding.verification_state = "verified"; cp.provider_resume_binding.identity_reference_digest = null; },
    (cp) => { cp.provider_resume_binding.verification_state = "not-required"; cp.provider_resume_binding.identity_reference_digest = "sha256:" + "c".repeat(64); }
  ]) {
    const invalid = structuredClone(checkpoint);
    mutate(invalid);
    refresh(invalid, "checkpoint_digest");
    assert.throws(() => assertHandoffSafeResume(handoff, invalid, events));
  }
  const finalizationIndex = events.findIndex((event) => event.event_type === "checkpoint.finalized");
  assert.throws(() => assertHandoffSafeResume(handoff, checkpoint, events.slice(0, finalizationIndex)), /finalization/);
});

test("safe handoff rejects fabricated checkpoint event arrays that were never validated as a chain", async () => {
  const { checkpoint, handoff } = await buildFullLifecycleScenario();
  const fabricated = [
    { event_type: "run.checkpointed", event_digest: checkpoint.event_ref.digest, run_id: checkpoint.run_id, sequence: 1 },
    {
      event_type: "checkpoint.finalized", run_id: checkpoint.run_id, sequence: 2,
      event_data: { checkpoint_ref: handoff.checkpoint_ref, checkpoint_event_ref: checkpoint.event_ref }
    }
  ];
  assert.throws(() => assertHandoffSafeResume(handoff, checkpoint, fabricated), /digest|state event|schema_version/);
});

test("owner-gate binding folds the supplied event chain before trusting it", async () => {
  const scenario = await buildInitialOwnerGatedScenario();
  assert.equal(assertRunOwnerGateBinding(scenario.plan, scenario.events), true);
  const fabricated = [{
    run_id: scenario.plan.run_id,
    event_type: "capability-plan.bound",
    event_data: { capability_plan_ref: { digest: scenario.plan.plan_digest } }
  }];
  assert.throws(() => assertRunOwnerGateBinding(scenario.plan, fabricated), /digest|state event|schema_version/);
});

test("lease uniqueness rejects duplicate ids, epochs, and reservations", async () => {
  const lease = await readJsonStrict(resolveContractPath("contracts/fixtures/valid/worktree-lease.active.json"));
  assert.equal(assertLeaseUniqueness([lease]), true);
  assert.throws(() => assertLeaseUniqueness([lease, structuredClone(lease)]), /duplicate lease_id/);
});

function resumeArguments(scenario) {
  const events = scenario.events.slice(0, scenario.resumeEvent.sequence);
  const checkpointEvent = events.find((event) => event.event_type === "run.checkpointed");
  return {
    run: scenario.resumedRun, events, capabilityPlan: scenario.plan, checkpointEvent, newLease: scenario.lease2Active,
    priorLease: scenario.lease1Released, activePriorLease: scenario.lease1Active, resumeEvent: scenario.resumeEvent
  };
}

test("checkpoint resume binds finalized checkpoint, release snapshots, paths, policy, and both provider modes", async () => {
  for (const options of [{}, { providerMode: "codex" }, { resumeRequiresApproval: true }]) {
    const scenario = await buildFullLifecycleScenario(options);
    assert.equal(assertCheckpointResumable(scenario.checkpoint, resumeArguments(scenario)), true);
  }
});

test("checkpoint resume rejects missing or mismatched release evidence", async () => {
  const scenario = await buildFullLifecycleScenario();
  const mismatch = structuredClone(scenario.lease1Released);
  mismatch.branch_name = "unexpected-branch";
  refresh(mismatch, "lease_digest");
  assert.throws(() => assertCheckpointResumable(scenario.checkpoint, { ...resumeArguments(scenario), priorLease: mismatch }), /identity drift|predecessor|released/);
  const args = resumeArguments(scenario);
  args.events = args.events.filter((event) => event.event_type !== "lease.released");
  assert.throws(() => assertCheckpointResumable(scenario.checkpoint, args));
});

test("checkpoint resume binds the full checkpoint event reference, including its path", async () => {
  const scenario = await buildFullLifecycleScenario();
  const args = resumeArguments(scenario);
  const checkpoint = structuredClone(scenario.checkpoint);
  checkpoint.event_ref.ref = "evidence/events/fabricated-checkpoint-event.json";
  refresh(checkpoint, "checkpoint_digest");
  const events = structuredClone(args.events);
  const finalizationIndex = events.findIndex((event) => event.event_type === "checkpoint.finalized");
  const checkpointRef = { ...events[finalizationIndex].event_data.checkpoint_ref, digest: checkpoint.checkpoint_digest };
  for (const event of events.slice(finalizationIndex)) {
    if (event.projection.latest_checkpoint_ref !== null) event.projection.latest_checkpoint_ref = checkpointRef;
    if (event.event_type === "checkpoint.finalized" || event.event_type === "run.resumed") event.event_data.checkpoint_ref = checkpointRef;
  }
  rehashChainFrom(events, finalizationIndex);
  const resumeEvent = events.find((event) => event.event_type === "run.resumed");
  const run = foldStateEvents(events);
  assert.throws(() => assertCheckpointResumable(checkpoint, {
    ...args, run, events, checkpointEvent: events.find((event) => event.event_type === "run.checkpointed"), resumeEvent
  }), /checkpoint event binding|not finalized/);
});

function reportArguments(scenario, kind) {
  const report = kind === "stopped" ? scenario.stoppedReport : scenario.completedReport;
  const run = kind === "stopped" ? scenario.stoppedRun : scenario.completedRun;
  const finalization = scenario.events.find((event) => event.event_type === "report.finalized" && event.event_data.report_ref.digest === report.report_digest);
  const events = scenario.events.slice(0, finalization.sequence);
  const leases = kind === "stopped"
    ? [{ activeRef: report.lease_history_refs[0].ref.replace("released", "active"), activeValue: scenario.lease1Active, releasedRef: report.lease_history_refs[0].ref, releasedValue: scenario.lease1Released }]
    : [
        { activeRef: report.lease_history_refs[0].ref.replace("released", "active"), activeValue: scenario.lease1Active, releasedRef: report.lease_history_refs[0].ref, releasedValue: scenario.lease1Released },
        { activeRef: report.lease_history_refs[1].ref.replace("released", "active"), activeValue: scenario.lease2Active, releasedRef: report.lease_history_refs[1].ref, releasedValue: scenario.lease2Released }
      ];
  return {
    report, args: {
      run, events, capabilityPlan: scenario.plan,
      checkpoints: [{ ref: report.checkpoint_refs[0].ref, value: scenario.checkpoint }], leaseHistory: leases
    }
  };
}

test("stopped and completed reports bind event-derived checkpoint and active-to-released lease histories", async () => {
  const scenario = await buildFullLifecycleScenario();
  for (const kind of ["stopped", "completed"]) {
    const { report, args } = reportArguments(scenario, kind);
    assert.equal(assertFinalReport(report, args), true);
  }
});

test("stopped report cannot occupy the terminal slot and release static-identity drift is killed", async () => {
  const scenario = await buildFullLifecycleScenario();
  const { report, args } = reportArguments(scenario, "stopped");
  const wrongRun = structuredClone(args.run);
  wrongRun.final_status_report_ref = wrongRun.stopped_report_ref;
  refresh(wrongRun, "run_digest");
  assert.throws(() => assertFinalReport(report, { ...args, run: wrongRun }));
  const driftedRelease = structuredClone(args.leaseHistory[0].releasedValue);
  driftedRelease.branch_name = "drifted-branch";
  refresh(driftedRelease, "lease_digest");
  const leaseHistory = [{ ...args.leaseHistory[0], releasedValue: driftedRelease }];
  assert.throws(() => assertFinalReport(report, { ...args, leaseHistory }), /static identity drift/);
  const escaped = structuredClone(report);
  escaped.report_ref = "evidence/other-run/reports/stopped.json";
  refresh(escaped, "report_digest");
  assert.throws(() => assertFinalReport(escaped, args), /logical evidence directory/);
  const trailingParent = structuredClone(report);
  trailingParent.report_ref = `evidence/${args.run.run_id.replaceAll(":", "-")}/reports/..`;
  refresh(trailingParent, "report_digest");
  assert.throws(() => assertFinalReport(trailingParent, args), /logical evidence directory/);
});

test("cross-run capability plan substitution is rejected by resume and final reporting", async () => {
  const scenario = await buildFullLifecycleScenario();
  const foreign = structuredClone(scenario.plan);
  foreign.run_id = "run:foreign";
  refresh(foreign, "plan_digest");
  assert.throws(() => assertCheckpointResumable(scenario.checkpoint, { ...resumeArguments(scenario), capabilityPlan: foreign }), /run_id|cross-run/);
  const { report, args } = reportArguments(scenario, "completed");
  assert.throws(() => assertFinalReport(report, { ...args, capabilityPlan: foreign }), /cross-run/);
});

test("same-run capability plan and report substitution cannot replace the plan bound by the run", async () => {
  const scenario = await buildFullLifecycleScenario();
  const { report, args } = reportArguments(scenario, "completed");
  const substitutedPlan = structuredClone(scenario.plan);
  substitutedPlan.capability_plan_id = "plan:same-run-substitute";
  refresh(substitutedPlan, "plan_digest");
  const substitutedReport = structuredClone(report);
  substitutedReport.capability_plan_ref.digest = substitutedPlan.plan_digest;
  refresh(substitutedReport, "report_digest");
  const substitutedEvents = structuredClone(args.events);
  const finalization = substitutedEvents.at(-1);
  finalization.event_data.report_ref.digest = substitutedReport.report_digest;
  finalization.projection.final_status_report_ref.digest = substitutedReport.report_digest;
  refresh(finalization, "event_digest");
  const substitutedRun = foldStateEvents(substitutedEvents);
  assert.throws(() => assertFinalReport(substitutedReport, {
    ...args, run: substitutedRun, events: substitutedEvents, capabilityPlan: substitutedPlan
  }), /unbound from the run projection/);
});

test("final report binds the full terminal event reference, including its path", async () => {
  const scenario = await buildFullLifecycleScenario();
  const { report, args } = reportArguments(scenario, "completed");
  const substitutedReport = structuredClone(report);
  substitutedReport.terminal_event_ref.ref = "evidence/events/fabricated-terminal-event.json";
  refresh(substitutedReport, "report_digest");
  const substitutedEvents = structuredClone(args.events);
  const finalization = substitutedEvents.at(-1);
  finalization.event_data.report_ref.digest = substitutedReport.report_digest;
  finalization.projection.final_status_report_ref.digest = substitutedReport.report_digest;
  refresh(finalization, "event_digest");
  const substitutedRun = foldStateEvents(substitutedEvents);
  assert.throws(() => assertFinalReport(substitutedReport, {
    ...args, run: substitutedRun, events: substitutedEvents
  }), /terminal event mismatch|finalized binding/);
});

test("null-lease cancelled close produces a valid final report and cannot claim success", async () => {
  const scenario = await buildInitialOwnerGatedScenario();
  const events = structuredClone(scenario.events.slice(0, 3));
  const cancelled = appendScenarioEvent(events, "run.cancelled", "cancelled", null, { kind: "run.cancelled" }, scenario.id);
  const report = await readJsonStrict(resolveContractPath("contracts/fixtures/valid/report.null-lease-cancelled.json"));
  report.run_id = `run:${scenario.id}`;
  report.terminal_event_ref = eventRef(cancelled);
  report.capability_plan_ref = scenario.planRef;
  report.report_ref = `evidence/run-${scenario.id}/reports/cancelled.json`;
  refresh(report, "report_digest");
  const reportRef = { ref: report.report_ref, digest: report.report_digest };
  appendScenarioEvent(events, "report.finalized", "cancelled", (projection) => { projection.final_status_report_ref = reportRef; }, {
    kind: "report.finalized", report_ref: reportRef, terminal_event_ref: eventRef(cancelled)
  }, scenario.id);
  const run = foldStateEvents(events);
  const args = { run, events, capabilityPlan: scenario.plan, checkpoints: [], leaseHistory: [] };
  assert.equal(assertFinalReport(report, args), true);
  const falseSuccess = structuredClone(report);
  falseSuccess.outcome.objective_satisfied = true;
  refresh(falseSuccess, "report_digest");
  assert.throws(() => assertFinalReport(falseSuccess, args), /cannot claim objective completion/);
});
