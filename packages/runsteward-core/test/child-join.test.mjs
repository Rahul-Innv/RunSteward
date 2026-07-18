import assert from "node:assert/strict";
import test from "node:test";
import { bodyWithoutDigest, runstewardDigest } from "../src/canonical-json.mjs";
import { evaluateChildDependencies, assertChildDependencyEvaluation } from "../src/child-join.mjs";
import { readJsonStrict, resolveContractPath } from "../src/contract-loader.mjs";
import { foldStateEvents } from "../src/event-fold.mjs";
import { appendScenarioEvent, buildFullLifecycleScenario, buildInitialOwnerGatedScenario } from "./scenario-factory.mjs";

function refresh(value, field) {
  value[field] = runstewardDigest(bodyWithoutDigest(value, field));
  return value;
}

function eventRef(event) {
  return { ref: `evidence/events/${event.event_id.replaceAll(":", "-")}.json`, digest: event.event_digest };
}

function fullObservation(scenario, kind) {
  const report = kind === "stopped" ? scenario.stoppedReport : scenario.completedReport;
  const run = kind === "stopped" ? scenario.stoppedRun : scenario.completedRun;
  const finalization = scenario.events.find((event) => event.event_type === "report.finalized" && event.event_data.report_ref.digest === report.report_digest);
  const events = scenario.events.slice(0, finalization.sequence);
  const leaseHistory = kind === "stopped"
    ? [{ activeRef: report.lease_history_refs[0].ref.replace("released", "active"), activeValue: scenario.lease1Active, releasedRef: report.lease_history_refs[0].ref, releasedValue: scenario.lease1Released }]
    : [
        { activeRef: report.lease_history_refs[0].ref.replace("released", "active"), activeValue: scenario.lease1Active, releasedRef: report.lease_history_refs[0].ref, releasedValue: scenario.lease1Released },
        { activeRef: report.lease_history_refs[1].ref.replace("released", "active"), activeValue: scenario.lease2Active, releasedRef: report.lease_history_refs[1].ref, releasedValue: scenario.lease2Released }
      ];
  return {
    run, report,
    finalReportArguments: {
      run, events, capabilityPlan: scenario.plan,
      checkpoints: [{ ref: report.checkpoint_refs[0].ref, value: scenario.checkpoint }], leaseHistory
    }
  };
}

async function closedNoLeaseObservation(status) {
  const scenario = status === "failed" ? await buildFullLifecycleScenario() : await buildInitialOwnerGatedScenario();
  const events = status === "failed"
    ? structuredClone(scenario.events.slice(0, scenario.events.findIndex((event) => event.event_type === "run.started") + 1))
    : structuredClone(scenario.events.slice(0, 3));
  const terminal = appendScenarioEvent(events, `run.${status}`, status, null, { kind: `run.${status}` }, scenario.id);
  const template = await readJsonStrict(resolveContractPath(status === "cancelled" ? "contracts/fixtures/valid/report.null-lease-cancelled.json" : "contracts/fixtures/valid/report.final.json"));
  template.report_id = `report:${scenario.id}:${status}`;
  template.run_id = `run:${scenario.id}`;
  template.status = status;
  template.terminal_event_ref = eventRef(terminal);
  const planRef = events.find((event) => event.event_type === "capability-plan.bound").event_data.capability_plan_ref;
  template.capability_plan_ref = planRef;
  let leaseHistory = [];
  if (status === "failed") {
    const activeRef = events.find((event) => event.event_type === "lease.acquired").event_data.lease_ref;
    const releasedRef = scenario.events.find((event) => event.event_type === "lease.released").event_data.released_lease_ref;
    appendScenarioEvent(events, "lease.released", status, (projection) => { projection.lease_ref = null; }, {
      kind: "lease.released", active_lease_ref: activeRef, released_lease_ref: releasedRef
    }, scenario.id);
    template.lease_history_refs = [releasedRef];
    leaseHistory = [{
      activeRef: activeRef.ref, activeValue: scenario.lease1Active,
      releasedRef: releasedRef.ref, releasedValue: scenario.lease1Released
    }];
  } else {
    template.lease_history_refs = [];
  }
  template.checkpoint_refs = [];
  template.handoff_ref = null;
  template.outcome.objective_satisfied = false;
  template.outcome.summary = `The child closed with ${status} status and did not satisfy its objective.`;
  template.report_ref = `evidence/run-${scenario.id}/reports/${status}.json`;
  refresh(template, "report_digest");
  const reportRef = { ref: template.report_ref, digest: template.report_digest };
  appendScenarioEvent(events, "report.finalized", status, (projection) => { projection.final_status_report_ref = reportRef; }, {
    kind: "report.finalized", report_ref: reportRef, terminal_event_ref: eventRef(terminal)
  }, scenario.id);
  const run = foldStateEvents(events);
  return { run, report: template, finalReportArguments: { run, events, capabilityPlan: scenario.plan, checkpoints: [], leaseHistory } };
}

test("required completed children satisfy wait, join, and parent completion", async () => {
  const scenario = await buildFullLifecycleScenario();
  const observation = fullObservation(scenario, "completed");
  const result = evaluateChildDependencies([{ child_run_id: observation.run.run_id, required: true }], new Map([[observation.run.run_id, observation]]));
  assert.equal(result.wait_satisfied, true);
  assert.equal(result.join_satisfied, true);
  assert.equal(result.parent_completion_allowed, true);
  assert.equal(assertChildDependencyEvaluation(result), true);
});

test("failed, cancelled, and stopped children release wait but never satisfy join", async () => {
  const full = await buildFullLifecycleScenario();
  const observations = [fullObservation(full, "stopped"), await closedNoLeaseObservation("failed"), await closedNoLeaseObservation("cancelled")];
  for (const observation of observations) {
    const result = evaluateChildDependencies([{ child_run_id: observation.run.run_id, required: true }], { [observation.run.run_id]: observation });
    assert.equal(result.wait_satisfied, true);
    assert.equal(result.join_satisfied, false);
    assert.equal(result.parent_completion_allowed, false);
  }
});

test("missing, blocked, unfinished, and final-proof-free children satisfy neither wait nor join", async () => {
  const full = await buildFullLifecycleScenario();
  const gated = await buildInitialOwnerGatedScenario();
  const blockedRun = foldStateEvents(gated.events.slice(0, 3));
  const cases = [
    ["run:missing", null],
    [blockedRun.run_id, { run: blockedRun }],
    [full.runningRun.run_id, { run: full.runningRun }],
    [full.completedRun.run_id, { run: full.completedRun, report: full.completedReport, finalReportArguments: { run: full.completedRun, events: [] } }]
  ];
  for (const [runId, observation] of cases) {
    const observations = observation ? { [runId]: observation } : {};
    const result = evaluateChildDependencies([{ child_run_id: runId, required: true }], observations);
    assert.equal(result.wait_satisfied, false);
    assert.equal(result.join_satisfied, false);
    assert.equal(result.parent_completion_allowed, false);
  }
});

test("unfinished optional children do not widen or block the required completion condition", async () => {
  const full = await buildFullLifecycleScenario();
  const completed = fullObservation(full, "completed");
  const result = evaluateChildDependencies([
    { child_run_id: completed.run.run_id, required: true },
    { child_run_id: "run:optional-unfinished", required: false }
  ], { [completed.run.run_id]: completed });
  assert.equal(result.parent_completion_allowed, true);
  assert.equal(result.children[1].state, "missing");
});

test("child evaluation rejects duplicate dependencies and digest/boolean tampering", async () => {
  const full = await buildFullLifecycleScenario();
  const completed = fullObservation(full, "completed");
  assert.throws(() => evaluateChildDependencies([
    { child_run_id: completed.run.run_id, required: true },
    { child_run_id: completed.run.run_id, required: true }
  ], { [completed.run.run_id]: completed }), /duplicate child dependency/);
  const result = evaluateChildDependencies([{ child_run_id: completed.run.run_id, required: true }], { [completed.run.run_id]: completed });
  result.parent_completion_allowed = false;
  assert.throws(() => assertChildDependencyEvaluation(result), /digest mismatch|internally inconsistent/);
});

test("digest-valid forged child state and proof-flag combinations fail closed", async () => {
  const full = await buildFullLifecycleScenario();
  const completed = fullObservation(full, "completed");
  const valid = evaluateChildDependencies([{ child_run_id: completed.run.run_id, required: true }], { [completed.run.run_id]: completed });
  const forgeries = [
    { state: "missing", terminal: true, joined: true, report_digest: valid.children[0].report_digest },
    { state: "completed", terminal: false, joined: false, report_digest: null },
    { state: "stopped", terminal: true, joined: true, report_digest: valid.children[0].report_digest },
    { state: "failed", terminal: false, joined: false, report_digest: valid.children[0].report_digest },
    { state: "cancelled", terminal: true, joined: false, report_digest: null },
    { state: "identity-mismatch", terminal: true, joined: false, report_digest: valid.children[0].report_digest },
    { state: "invalid-final-proof", terminal: false, joined: false, report_digest: valid.children[0].report_digest },
    { state: "fabricated", terminal: true, joined: true, report_digest: valid.children[0].report_digest }
  ];
  for (const forgedChild of forgeries) {
    const forged = structuredClone(valid);
    forged.children[0] = { ...forged.children[0], ...forgedChild };
    forged.wait_satisfied = forged.children[0].terminal;
    forged.join_satisfied = forged.children[0].joined;
    forged.parent_completion_allowed = forged.wait_satisfied && forged.join_satisfied;
    refresh(forged, "evaluation_digest");
    assert.throws(() => assertChildDependencyEvaluation(forged), /impossible|lacks|unknown|nonterminal/);
  }
});
