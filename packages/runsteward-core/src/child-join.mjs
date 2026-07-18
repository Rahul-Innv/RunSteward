import { bodyWithoutDigest, assertRunStewardDigest, runstewardDigest } from "./canonical-json.mjs";
import { assertFinalReport } from "./invariants.mjs";

const STABLE_ID = /^[a-z][a-z0-9._:-]{2,127}$/;
const RUNSTEWARD_DIGEST = /^sha256:[0-9a-f]{64}$/;
const NONTERMINAL_STATES = new Set(["missing", "identity-mismatch", "unfinished", "invalid-final-proof"]);
const UNSUCCESSFUL_TERMINAL_STATES = new Set(["stopped", "failed", "cancelled"]);
const CHILD_KEYS = ["child_run_id", "joined", "report_digest", "required", "state", "terminal"];
const EVALUATION_KEYS = ["children", "evaluation_digest", "join_satisfied", "parent_completion_allowed", "schema_version", "wait_satisfied"];

function proofFor(requirement, observation) {
  if (!observation) {
    return { child_run_id: requirement.child_run_id, state: "missing", terminal: false, joined: false, report_digest: null };
  }
  const run = observation.run;
  if (!run || run.run_id !== requirement.child_run_id) {
    return { child_run_id: requirement.child_run_id, state: "identity-mismatch", terminal: false, joined: false, report_digest: null };
  }
  if (!["stopped", "completed", "failed", "cancelled"].includes(run.status)) {
    return { child_run_id: requirement.child_run_id, state: "unfinished", terminal: false, joined: false, report_digest: null };
  }
  try {
    assertFinalReport(observation.report, observation.finalReportArguments);
  } catch {
    return { child_run_id: requirement.child_run_id, state: "invalid-final-proof", terminal: false, joined: false, report_digest: null };
  }
  const joined = run.status === "completed" && observation.report.outcome.objective_satisfied === true;
  return {
    child_run_id: requirement.child_run_id,
    state: joined ? "completed" : run.status,
    terminal: true,
    joined,
    report_digest: observation.report.report_digest
  };
}

export function evaluateChildDependencies(requirements, observations = new Map()) {
  if (!Array.isArray(requirements) || requirements.length === 0) {
    throw new Error("at least one child dependency is required");
  }
  const seen = new Set();
  const results = requirements.map((requirement) => {
    if (!requirement || typeof requirement.child_run_id !== "string" || typeof requirement.required !== "boolean") {
      throw new Error("child dependencies require child_run_id and required");
    }
    if (seen.has(requirement.child_run_id)) throw new Error(`duplicate child dependency: ${requirement.child_run_id}`);
    seen.add(requirement.child_run_id);
    const observation = observations instanceof Map ? observations.get(requirement.child_run_id) : observations[requirement.child_run_id];
    return { required: requirement.required, ...proofFor(requirement, observation) };
  });
  const required = results.filter((result) => result.required);
  const wait_satisfied = required.every((result) => result.terminal);
  const join_satisfied = required.every((result) => result.joined);
  const result = {
    schema_version: "runsteward.child-dependency-evaluation/v1",
    wait_satisfied,
    join_satisfied,
    parent_completion_allowed: wait_satisfied && join_satisfied,
    children: results,
    evaluation_digest: null
  };
  result.evaluation_digest = runstewardDigest(bodyWithoutDigest(result, "evaluation_digest"));
  return result;
}

export function assertChildDependencyEvaluation(value) {
  if (!value || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(EVALUATION_KEYS) || value.schema_version !== "runsteward.child-dependency-evaluation/v1" || !Array.isArray(value.children) || value.children.length === 0) {
    throw new Error("invalid child dependency evaluation shape");
  }
  assertRunStewardDigest(value, "evaluation_digest");
  const seen = new Set();
  for (const child of value.children) {
    if (!child || JSON.stringify(Object.keys(child).sort()) !== JSON.stringify(CHILD_KEYS)) throw new Error("invalid child dependency record shape");
    if (!STABLE_ID.test(child.child_run_id) || typeof child.required !== "boolean" || typeof child.terminal !== "boolean" || typeof child.joined !== "boolean") {
      throw new Error("invalid child dependency identity or flags");
    }
    if (seen.has(child.child_run_id)) throw new Error(`duplicate child dependency: ${child.child_run_id}`);
    seen.add(child.child_run_id);
    if (NONTERMINAL_STATES.has(child.state)) {
      if (child.terminal || child.joined || child.report_digest !== null) throw new Error(`nonterminal child state has impossible proof flags: ${child.state}`);
    } else if (child.state === "completed") {
      if (!child.terminal || !child.joined || !RUNSTEWARD_DIGEST.test(child.report_digest)) throw new Error("completed child lacks joined final-report proof");
    } else if (UNSUCCESSFUL_TERMINAL_STATES.has(child.state)) {
      if (!child.terminal || child.joined || !RUNSTEWARD_DIGEST.test(child.report_digest)) throw new Error(`unsuccessful terminal child has impossible proof flags: ${child.state}`);
    } else {
      throw new Error(`unknown child dependency state: ${child.state}`);
    }
  }
  const required = value.children.filter((child) => child.required);
  const expectedWait = required.every((child) => child.terminal === true);
  const expectedJoin = required.every((child) => child.joined === true);
  if (value.wait_satisfied !== expectedWait || value.join_satisfied !== expectedJoin || value.parent_completion_allowed !== (expectedWait && expectedJoin)) {
    throw new Error("child dependency evaluation is internally inconsistent");
  }
  return true;
}
