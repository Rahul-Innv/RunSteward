import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { atomicWriteJson } from "../src/atomic-write.mjs";
import { bodyWithoutDigest, runstewardDigest } from "../src/canonical-json.mjs";
import { evaluateChildDependencies } from "../src/child-join.mjs";
import { createCheckpointArtifact } from "../src/checkpoint-runtime.mjs";
import { readJsonStrict, resolveContractPath } from "../src/contract-loader.mjs";
import { foldStateEvents } from "../src/event-fold.mjs";
import { assertCheckpointResumable, assertFinalReport } from "../src/invariants.mjs";
import {
  assessLeaseExpiry, assertAllocationAvailable, proposeInitialLease, readSchedulerState,
  reserveLease,
} from "../src/scheduler.mjs";
import { assertWrapPlan, createWrapPlan } from "../src/wrap-orchestration.mjs";
import { appendScenarioEvent, buildFullLifecycleScenario, buildInitialOwnerGatedScenario } from "./scenario-factory.mjs";

const SOURCE = "5".repeat(40);
const REPEATABILITY_ROUNDS = 5;
const OWNER = {
  executor_id: "executor:rw5-test",
  process_session_ref: `sha256:${"8".repeat(64)}`,
  host_fingerprint: `sha256:${"9".repeat(64)}`,
};
const workerProbe = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../scripts/rw5-worker-probe.mjs");

console.log(`RUNSTEWARD_RW5_INTERNAL_REPEATABILITY_ROUNDS=${REPEATABILITY_ROUNDS}`);

function leaseInput(root, taskId, acquiredAt = "2026-07-16T05:00:00Z") {
  return {
    taskId,
    repositoryId: "runsteward",
    sourceHead: SOURCE,
    roots: {
      worktree: path.join(root, "worktrees"),
      state: path.join(root, "state"),
      evidence: path.join(root, "evidence"),
      lock: path.join(root, "locks"),
    },
    owner: OWNER,
    acquiredAt,
    ttlMs: 300000,
  };
}

function inventory(overrides = {}) {
  return { branches: [], worktrees: [], leases: [], ...overrides };
}

function refresh(value, field) {
  value[field] = runstewardDigest(bodyWithoutDigest(value, field));
  return value;
}

function eventRef(event) {
  return { ref: `evidence/events/${event.event_id.replaceAll(":", "-")}.json`, digest: event.event_digest };
}

function resumeArguments(scenario) {
  const events = scenario.events.slice(0, scenario.resumeEvent.sequence);
  return {
    run: scenario.resumedRun,
    events,
    capabilityPlan: scenario.plan,
    checkpointEvent: events.find((event) => event.event_type === "run.checkpointed"),
    newLease: scenario.lease2Active,
    priorLease: scenario.lease1Released,
    activePriorLease: scenario.lease1Active,
    resumeEvent: scenario.resumeEvent,
  };
}

function reportArguments(scenario, kind) {
  const report = kind === "stopped" ? scenario.stoppedReport : scenario.completedReport;
  const run = kind === "stopped" ? scenario.stoppedRun : scenario.completedRun;
  const finalization = scenario.events.find((event) => event.event_type === "report.finalized" && event.event_data.report_ref.digest === report.report_digest);
  const events = scenario.events.slice(0, finalization.sequence);
  const leaseHistory = kind === "stopped"
    ? [{ activeRef: report.lease_history_refs[0].ref.replace("released", "active"), activeValue: scenario.lease1Active, releasedRef: report.lease_history_refs[0].ref, releasedValue: scenario.lease1Released }]
    : [
        { activeRef: report.lease_history_refs[0].ref.replace("released", "active"), activeValue: scenario.lease1Active, releasedRef: report.lease_history_refs[0].ref, releasedValue: scenario.lease1Released },
        { activeRef: report.lease_history_refs[1].ref.replace("released", "active"), activeValue: scenario.lease2Active, releasedRef: report.lease_history_refs[1].ref, releasedValue: scenario.lease2Released },
      ];
  return {
    report,
    run,
    args: {
      run,
      events,
      capabilityPlan: scenario.plan,
      checkpoints: [{ ref: report.checkpoint_refs[0].ref, value: scenario.checkpoint }],
      leaseHistory,
    },
  };
}

function observationFromScenario(scenario, kind) {
  const { report, run, args } = reportArguments(scenario, kind);
  return { run, report, finalReportArguments: args };
}

async function cancelledObservation() {
  const scenario = await buildInitialOwnerGatedScenario();
  const events = structuredClone(scenario.events.slice(0, 3));
  const terminal = appendScenarioEvent(events, "run.cancelled", "cancelled", null, { kind: "run.cancelled" }, scenario.id);
  const report = await readJsonStrict(resolveContractPath("contracts/fixtures/valid/report.null-lease-cancelled.json"));
  report.report_id = `report:${scenario.id}:cancelled-rw5`;
  report.run_id = `run:${scenario.id}`;
  report.status = "cancelled";
  report.terminal_event_ref = eventRef(terminal);
  report.capability_plan_ref = events.find((event) => event.event_type === "capability-plan.bound").event_data.capability_plan_ref;
  report.lease_history_refs = [];
  report.checkpoint_refs = [];
  report.handoff_ref = null;
  report.outcome.objective_satisfied = false;
  report.outcome.summary = "The deterministic RW5 child was cancelled with evidence retained.";
  report.report_ref = `evidence/run-${scenario.id}/reports/cancelled-rw5.json`;
  refresh(report, "report_digest");
  const reportRef = { ref: report.report_ref, digest: report.report_digest };
  appendScenarioEvent(events, "report.finalized", "cancelled", (projection) => { projection.final_status_report_ref = reportRef; }, {
    kind: "report.finalized",
    report_ref: reportRef,
    terminal_event_ref: eventRef(terminal),
  }, scenario.id);
  const run = foldStateEvents(events);
  return {
    run,
    report,
    finalReportArguments: { run, events, capabilityPlan: scenario.plan, checkpoints: [], leaseHistory: [] },
  };
}

function runWorker({ cwd, taskId, output, mode }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      workerProbe,
      "--task-id", taskId,
      "--worktree", cwd,
      "--output", output,
      "--mode", mode,
      "--source-head", SOURCE,
    ], { cwd, env: { ...process.env }, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

test("RW5 allocation identities and collisions are deterministic across repeated rounds", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "runsteward-rw5-collision-"));
  try {
    for (let round = 0; round < REPEATABILITY_ROUNDS; round += 1) {
      const roundRoot = path.join(root, `round-${round}`);
      const first = await proposeInitialLease(leaseInput(roundRoot, `task:rw5-a-${round}`));
      const repeat = await proposeInitialLease(leaseInput(roundRoot, `task:rw5-a-${round}`));
      const second = await proposeInitialLease(leaseInput(roundRoot, `task:rw5-b-${round}`));
      assert.deepEqual(first, repeat);
      assert.notEqual(first.run_id, second.run_id);
      assert.notEqual(first.branch_name, second.branch_name);
      assert.notEqual(first.worktree.collision_key, second.worktree.collision_key);
      assert.equal(await assertAllocationAvailable(second, inventory({ leases: [first] })), true);
      await assert.rejects(() => assertAllocationAvailable(first, inventory({ leases: [first] })), /duplicate lease_id|lease collision/);
      await assert.rejects(() => assertAllocationAvailable(second, inventory({ branches: [second.branch_name] })), /branch collision/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("RW5 stale leases and physical contention remain evidence and never authorize takeover", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "runsteward-rw5-stale-"));
  try {
    const proposed = await proposeInitialLease(leaseInput(root, "task:rw5-stale"));
    const stale = structuredClone(proposed);
    stale.status = "stale";
    refresh(stale, "lease_digest");
    assert.deepEqual(assessLeaseExpiry(stale, "2026-07-16T06:00:00Z"), {
      state: "stale-evidence-only",
      takeover_allowed: false,
      required_action: "owner-authorized-reclamation-with-preserved-predecessor-evidence",
    });
    await assert.rejects(() => assertAllocationAvailable(proposed, inventory({ leases: [stale] })), /duplicate lease_id|lease collision|lease epoch|task_id|branch_name|worktree/);
    const stateFile = path.join(root, "scheduler", "state.json");
    const reserved = await reserveLease({ proposedLease: proposed, stateFile, inventory: inventory() });
    await assert.rejects(() => reserveLease({ proposedLease: proposed, stateFile, inventory: inventory() }), /physical lease lock collision/);
    assert.deepEqual(await readSchedulerState(stateFile), reserved.state);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("RW5 coordination lock and prior digest deterministically prevent concurrent lost updates", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "runsteward-rw5-cas-"));
  try {
    const stateFile = path.join(root, "scheduler", "state.json");
    const seed = await proposeInitialLease(leaseInput(root, "task:rw5-seed"));
    const seeded = await reserveLease({ proposedLease: seed, stateFile, inventory: inventory() });
    const first = await proposeInitialLease(leaseInput(root, "task:rw5-concurrent-a", "2026-07-16T05:01:00Z"));
    const second = await proposeInitialLease(leaseInput(root, "task:rw5-concurrent-b", "2026-07-16T05:02:00Z"));
    let releaseRename;
    let enteredRename;
    const entered = new Promise((resolve) => { enteredRename = resolve; });
    const held = new Promise((resolve) => { releaseRename = resolve; });
    const firstReservation = reserveLease({
      proposedLease: first,
      stateFile,
      priorState: seeded.state,
      inventory: inventory({ leases: seeded.state.leases }),
      beforeStateRename: async () => { enteredRename(); await held; },
    });
    await entered;
    await assert.rejects(() => reserveLease({
      proposedLease: second,
      stateFile,
      priorState: seeded.state,
      inventory: inventory({ leases: seeded.state.leases }),
    }), /scheduler coordination lock collision/);
    releaseRename();
    const firstResult = await firstReservation;
    await assert.rejects(() => reserveLease({
      proposedLease: second,
      stateFile,
      priorState: seeded.state,
      inventory: inventory({ leases: firstResult.state.leases }),
    }), /scheduler state changed/);
    const secondResult = await reserveLease({
      proposedLease: second,
      stateFile,
      priorState: firstResult.state,
      inventory: inventory({ leases: firstResult.state.leases }),
    });
    assert.equal(secondResult.state.leases.length, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("RW5 one blocked reservation cannot prevent an independent lane from completing and recovering", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "runsteward-rw5-independent-"));
  try {
    const blocked = await proposeInitialLease(leaseInput(root, "task:rw5-blocked"));
    const independent = await proposeInitialLease(leaseInput(root, "task:rw5-independent"));
    const stateFile = path.join(root, "scheduler", "state.json");
    await mkdir(path.dirname(blocked.lock_path.path), { recursive: true });
    await writeFile(blocked.lock_path.path, "retained-blocking-evidence\n", "utf8");
    const [blockedResult, independentResult] = await Promise.allSettled([
      reserveLease({ proposedLease: blocked, stateFile, inventory: inventory() }),
      reserveLease({ proposedLease: independent, stateFile, inventory: inventory() }),
    ]);
    assert.equal(blockedResult.status, "rejected");
    assert.match(String(blockedResult.reason), /physical lease lock collision/);
    assert.equal(independentResult.status, "fulfilled");
    const firstState = await readSchedulerState(stateFile);
    assert.deepEqual(firstState.leases.map((lease) => lease.task_id), [independent.task_id]);

    await unlink(blocked.lock_path.path);
    const recovered = await reserveLease({
      proposedLease: blocked,
      stateFile,
      priorState: firstState,
      inventory: inventory({ leases: firstState.leases }),
    });
    assert.deepEqual(recovered.state.leases.map((lease) => lease.task_id), [independent.task_id, blocked.task_id]);
    const committedBytes = await readFile(stateFile);
    await assert.rejects(() => reserveLease({
      proposedLease: blocked,
      stateFile,
      priorState: recovered.state,
      inventory: inventory({ leases: recovered.state.leases }),
    }), /physical lease lock collision|duplicate lease_id/);
    assert.deepEqual(await readFile(stateFile), committedBytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("RW5 partial atomic checkpoint writes recover idempotently without exposing torn JSON", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "runsteward-rw5-partial-"));
  try {
    const target = path.join(root, "checkpoint.json");
    const initial = { schema_version: "runsteward.rw5-test/v1", state: "old-complete", sequence: 1 };
    const replacement = { schema_version: "runsteward.rw5-test/v1", state: "new-complete", sequence: 2 };
    await atomicWriteJson(target, initial);
    const oldBytes = await readFile(target);
    await assert.rejects(() => atomicWriteJson(target, replacement, {
      beforeRename: async () => { throw new Error("injected partial-checkpoint crash boundary"); },
    }), /injected partial-checkpoint/);
    assert.deepEqual(await readFile(target), oldBytes);
    assert.deepEqual((await readdir(root)).filter((name) => name.endsWith(".tmp")), []);
    await atomicWriteJson(target, replacement);
    const recovered = await readFile(target);
    assert.deepEqual(JSON.parse(recovered.toString("utf8")), replacement);
    for (let round = 0; round < REPEATABILITY_ROUNDS; round += 1) {
      await atomicWriteJson(target, replacement);
      assert.deepEqual(await readFile(target), recovered);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("RW5 partial checkpoints, source drift, and worktree identity mismatch reject resume", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "runsteward-rw5-resume-"));
  try {
    const scenario = await buildFullLifecycleScenario();
    const args = resumeArguments(scenario);
    const partialBody = bodyWithoutDigest(scenario.checkpoint, "checkpoint_digest");
    partialBody.completeness = "partial";
    partialBody.provider_resume_binding = { adapter_id: "claude-code-local", identity_reference_digest: null, verification_state: "unknown" };
    const partial = createCheckpointArtifact(partialBody);
    assert.throws(() => assertCheckpointResumable(partial, args), /partial checkpoint/);

    const target = path.join(root, "checkpoint.json");
    await atomicWriteJson(target, partial);
    const partialBytes = await readFile(target);
    await assert.rejects(() => atomicWriteJson(target, scenario.checkpoint, {
      beforeRename: async () => { throw new Error("injected complete-checkpoint interruption"); },
    }), /complete-checkpoint interruption/);
    assert.deepEqual(await readFile(target), partialBytes);

    const sourceDrift = structuredClone(scenario.lease2Active);
    sourceDrift.original_source_head = "e".repeat(40);
    refresh(sourceDrift, "lease_digest");
    assert.throws(() => assertCheckpointResumable(scenario.checkpoint, { ...args, newLease: sourceDrift }), /observed head drift/);
    const identityDrift = structuredClone(scenario.lease2Active);
    identityDrift.worktree.collision_key = `fs:win32:${"f".repeat(64)}`;
    refresh(identityDrift, "lease_digest");
    assert.throws(() => assertCheckpointResumable(scenario.checkpoint, { ...args, newLease: identityDrift }), /path identity drift|worktree identity drift/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("RW5 forced wrap remains exact checkpoint-stop-report delegation with literal final proof", () => {
  for (let round = 0; round < REPEATABILITY_ROUNDS; round += 1) {
    const plan = createWrapPlan({
      planId: `wrap:rw5:${round}`,
      runId: `run:rw5:${round}`,
      trigger: { kind: "owner-request", source_status: "verified", reason_code: "forced-wrap", evidence_ref: null },
    });
    assert.equal(assertWrapPlan(plan), true);
    assert.deepEqual(plan.ordered_capabilities.map((step) => step.skill_id), ["runsteward-checkpoint-run", "runsteward-stop-run", "runsteward-report-run"]);
    assert.equal(plan.final_status_marker_required, "RUNSTEWARD_FINAL_STATUS");
    assert.deepEqual(plan.forbidden_actions, ["automatic-git-add", "automatic-git-commit", "branch-deletion", "destructive-cleanup", "provider-call", "remote-write"]);
  }
  assert.throws(() => createWrapPlan({
    planId: "wrap:rw5:unknown",
    runId: "run:rw5:unknown",
    trigger: { kind: "provider-advisory", source_status: "unknown", reason_code: "unknown-wrap", evidence_ref: null },
  }), /unknown trigger evidence|requires bounded evidence/);
});

test("RW5 interrupted, identity-mismatched, missing, stopped, and cancelled children fail closed", async () => {
  const scenario = await buildFullLifecycleScenario();
  const completed = observationFromScenario(scenario, "completed");
  const stopped = observationFromScenario(scenario, "stopped");
  const cancelled = await cancelledObservation();
  const cases = [
    { id: scenario.runningRun.run_id, observation: { run: scenario.runningRun }, state: "unfinished", terminal: false },
    { id: "run:rw5-identity-target", observation: completed, state: "identity-mismatch", terminal: false },
    { id: "run:rw5-missing", observation: null, state: "missing", terminal: false },
    { id: stopped.run.run_id, observation: stopped, state: "stopped", terminal: true },
    { id: cancelled.run.run_id, observation: cancelled, state: "cancelled", terminal: true },
  ];
  for (const entry of cases) {
    const observations = entry.observation ? { [entry.id]: entry.observation } : {};
    const result = evaluateChildDependencies([{ child_run_id: entry.id, required: true }], observations);
    assert.equal(result.children[0].state, entry.state);
    assert.equal(result.wait_satisfied, entry.terminal);
    assert.equal(result.join_satisfied, false);
    assert.equal(result.parent_completion_allowed, false);
  }
});

test("RW5 physical worker probes isolate blocked, crashed, completing, and recovered lanes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "runsteward-rw5-workers-"));
  const worktreeA = path.join(root, "worktree-a");
  const worktreeB = path.join(root, "worktree-b");
  const outputRoot = path.join(root, "proof");
  try {
    await Promise.all([mkdir(worktreeA), mkdir(worktreeB), mkdir(outputRoot)]);
    const blockedOutput = path.join(outputRoot, "blocked-a.json");
    const completeOutput = path.join(outputRoot, "complete-b.json");
    const [blocked, completed] = await Promise.all([
      runWorker({ cwd: worktreeA, taskId: "task:rw5-worker-a", output: blockedOutput, mode: "blocked" }),
      runWorker({ cwd: worktreeB, taskId: "task:rw5-worker-b", output: completeOutput, mode: "complete" }),
    ]);
    assert.equal(blocked.code, 23);
    assert.equal(completed.code, 0);
    const blockedProof = JSON.parse(await readFile(blockedOutput, "utf8"));
    const completeProof = JSON.parse(await readFile(completeOutput, "utf8"));
    assert.equal(blockedProof.status, "stopped");
    assert.equal(blockedProof.objective_satisfied, false);
    assert.equal(completeProof.status, "completed");
    assert.equal(completeProof.objective_satisfied, true);
    assert.equal(blockedProof.final_status_marker, "RUNSTEWARD_FINAL_STATUS");
    assert.equal(completeProof.final_status_marker, "RUNSTEWARD_FINAL_STATUS");
    assert.notEqual(blockedProof.worktree.collision_key, completeProof.worktree.collision_key);

    const crashOutput = path.join(outputRoot, "crash-a.json");
    const baseline = await runWorker({ cwd: worktreeA, taskId: "task:rw5-crash-a", output: crashOutput, mode: "complete" });
    assert.equal(baseline.code, 0);
    const baselineBytes = await readFile(crashOutput);
    const crashed = await runWorker({ cwd: worktreeA, taskId: "task:rw5-crash-a", output: crashOutput, mode: "crash" });
    assert.equal(crashed.code, 86);
    assert.deepEqual(await readFile(crashOutput), baselineBytes);
    const crashTemps = (await readdir(outputRoot)).filter((name) => /^\.crash-a\.json\..+\.tmp$/u.test(name));
    assert.equal(crashTemps.length, 1);
    const recovered = await runWorker({ cwd: worktreeA, taskId: "task:rw5-crash-a", output: crashOutput, mode: "recover" });
    assert.equal(recovered.code, 0);
    const recoveredBytes = await readFile(crashOutput);
    const recoveredProof = JSON.parse(recoveredBytes.toString("utf8"));
    assert.equal(recoveredProof.status, "completed");
    assert.equal(recoveredProof.final_status_marker, "RUNSTEWARD_FINAL_STATUS");
    const repeated = await runWorker({ cwd: worktreeA, taskId: "task:rw5-crash-a", output: crashOutput, mode: "recover" });
    assert.equal(repeated.code, 0);
    assert.deepEqual(await readFile(crashOutput), recoveredBytes);
    assert.deepEqual(await readdir(worktreeA), []);
    assert.deepEqual(await readdir(worktreeB), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("RW5 literal final reports are required; closing state or tampered marker alone is insufficient", async () => {
  const scenario = await buildFullLifecycleScenario();
  for (const kind of ["stopped", "completed"]) {
    const { report, args } = reportArguments(scenario, kind);
    assert.equal(report.final_status_marker, "RUNSTEWARD_FINAL_STATUS");
    assert.equal(assertFinalReport(report, args), true);
  }
  const completed = observationFromScenario(scenario, "completed");
  const tampered = structuredClone(completed.report);
  tampered.final_status_marker = "COMPLETE";
  refresh(tampered, "report_digest");
  assert.throws(() => assertFinalReport(tampered, { ...completed.finalReportArguments, report: tampered }), /final status marker/);
  const invalidObservation = { ...completed, report: tampered };
  const invalid = evaluateChildDependencies([{ child_run_id: completed.run.run_id, required: true }], { [completed.run.run_id]: invalidObservation });
  assert.equal(invalid.children[0].state, "invalid-final-proof");
  assert.equal(invalid.wait_satisfied, false);
  assert.equal(invalid.parent_completion_allowed, false);
});
