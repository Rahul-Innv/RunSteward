import { assertRunStewardDigest, runstewardDigest } from "./canonical-json.mjs";
import { assertBoundedEvidenceRef } from "./provider-evidence.mjs";

const STABLE_ID = /^[a-z][a-z0-9._:-]{2,127}$/;
const EXPECTED_STEPS = Object.freeze([
  Object.freeze({ sequence: 1, skill_id: "runsteward-checkpoint-run", outcome: "complete-checkpoint" }),
  Object.freeze({ sequence: 2, skill_id: "runsteward-stop-run", outcome: "resumable-stopped-attempt" }),
  Object.freeze({ sequence: 3, skill_id: "runsteward-report-run", outcome: "digest-bound-final-status-report" })
]);
const FORBIDDEN_ACTIONS = Object.freeze([
  "automatic-git-add",
  "automatic-git-commit",
  "branch-deletion",
  "destructive-cleanup",
  "provider-call",
  "remote-write"
]);

function assertPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError(`${label} must be a plain object`);
}

function assertExactKeys(value, keys, label) {
  assertPlainObject(value, label);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${label} fields are incomplete or widened`);
}

function assertStableId(value, label) {
  if (typeof value !== "string" || !STABLE_ID.test(value)) throw new Error(`${label} is not a stable id`);
}

export function assertWrapPlan(plan) {
  assertExactKeys(plan, [
    "schema_version", "plan_id", "run_id", "trigger", "ordered_capabilities", "forbidden_actions",
    "final_status_marker_required", "coordinator_only", "plan_digest"
  ], "wrap plan");
  if (plan.schema_version !== "runsteward.wrap-plan/v1") throw new Error("wrap plan schema version is unsupported");
  assertStableId(plan.plan_id, "wrap plan.plan_id");
  assertStableId(plan.run_id, "wrap plan.run_id");
  assertExactKeys(plan.trigger, ["kind", "source_status", "reason_code", "evidence_ref"], "wrap plan trigger");
  if (!new Set(["owner-request", "exact-compatibility-directive", "provider-advisory"]).has(plan.trigger.kind)) throw new Error("wrap trigger kind is unsupported");
  if (!new Set(["verified", "estimated"]).has(plan.trigger.source_status)) throw new Error("unknown trigger evidence cannot authorize a wrap plan");
  assertStableId(plan.trigger.reason_code, "wrap plan trigger.reason_code");
  if (plan.trigger.evidence_ref !== null) assertBoundedEvidenceRef(plan.trigger.evidence_ref, "wrap plan trigger.evidence_ref");
  if (plan.trigger.kind === "provider-advisory" && plan.trigger.evidence_ref === null) throw new Error("provider advisory wrap requires bounded evidence");
  if (JSON.stringify(plan.ordered_capabilities) !== JSON.stringify(EXPECTED_STEPS)) throw new Error("wrap coordinator must delegate checkpoint, stop, and report without duplicating them");
  if (JSON.stringify(plan.forbidden_actions) !== JSON.stringify(FORBIDDEN_ACTIONS)) throw new Error("wrap plan widened a closed action");
  if (plan.final_status_marker_required !== "RUNSTEWARD_FINAL_STATUS" || plan.coordinator_only !== true) throw new Error("wrap plan weakened final proof or coordinator-only behavior");
  assertRunStewardDigest(plan, "plan_digest");
  return true;
}

export function createWrapPlan({ planId, runId, trigger }) {
  const plan = {
    schema_version: "runsteward.wrap-plan/v1",
    plan_id: planId,
    run_id: runId,
    trigger: structuredClone(trigger),
    ordered_capabilities: EXPECTED_STEPS.map((item) => ({ ...item })),
    forbidden_actions: [...FORBIDDEN_ACTIONS],
    final_status_marker_required: "RUNSTEWARD_FINAL_STATUS",
    coordinator_only: true
  };
  plan.plan_digest = runstewardDigest(plan);
  assertWrapPlan(plan);
  return plan;
}

export { EXPECTED_STEPS as RW3_WRAP_STEPS, FORBIDDEN_ACTIONS as RW3_WRAP_FORBIDDEN_ACTIONS };
