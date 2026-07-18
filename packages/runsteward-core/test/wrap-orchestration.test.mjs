import assert from "node:assert/strict";
import test from "node:test";
import { assertWrapPlan, createWrapPlan } from "../src/wrap-orchestration.mjs";

const evidenceRef = { ref: "evidence/provider/limit.json", digest: "sha256:" + "d".repeat(64), media_type: "application/json" };

test("wrap coordinator delegates exactly checkpoint, stop, and report", () => {
  const plan = createWrapPlan({
    planId: "wrap:test:1",
    runId: "run:test:1",
    trigger: { kind: "provider-advisory", source_status: "estimated", reason_code: "limit-wrap", evidence_ref: evidenceRef }
  });
  assert.equal(assertWrapPlan(plan), true);
  assert.deepEqual(plan.ordered_capabilities.map((item) => item.skill_id), ["runsteward-checkpoint-run", "runsteward-stop-run", "runsteward-report-run"]);
  assert.equal(plan.forbidden_actions.includes("automatic-git-commit"), true);
  assert.equal(plan.final_status_marker_required, "RUNSTEWARD_FINAL_STATUS");
});

test("unknown provider evidence fails closed before wrap", () => {
  assert.throws(() => createWrapPlan({
    planId: "wrap:test:unknown",
    runId: "run:test:unknown",
    trigger: { kind: "provider-advisory", source_status: "unknown", reason_code: "provider-unknown", evidence_ref: evidenceRef }
  }), /unknown trigger evidence/);
});
