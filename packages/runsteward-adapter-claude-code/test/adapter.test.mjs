import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { bodyWithoutDigest, assertRunStewardDigest } from "../../runsteward-core/src/canonical-json.mjs";
import { readJsonStrict, resolveContractPath } from "../../runsteward-core/src/contract-loader.mjs";
import { consumeClaudeLimitState } from "../../runsteward-sensor-claude-limits/src/index.mjs";
import { classify } from "../../claude-carry/lib/sentinel.mjs";
import {
  CLAUDE_CODE_ADAPTER_ID,
  consumeClaudeCarryOutcome,
  consumeClaudeLimitAdvisory,
  createClaudeCheckpoint,
  createClaudeHandoff,
  createClaudeResumeBinding,
  createClaudeWrapPlan
} from "../src/index.mjs";

const require = createRequire(import.meta.url);
const { decide } = require("../../limit-aware-wrapup/trigger/decide.js");
const NOW = 1_751_700_000_000;
const RAW = Object.freeze({ ref: "evidence/raw/claude-limit-state.redacted.json", digest: "sha256:" + "a".repeat(64), media_type: "application/json" });
const CARRY = Object.freeze({ ref: "evidence/provider/claude-carry-outcome.json", digest: "sha256:" + "d".repeat(64), media_type: "application/json" });

test("Claude adapter consumes imported Carry classifications without copying raw reasons", () => {
  const done = consumeClaudeCarryOutcome(classify([{ type: "result", subtype: "success" }]), CARRY);
  assert.equal(done.advisory_status, "completed");
  const waiting = consumeClaudeCarryOutcome(classify([{ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1_751_700_000, rateLimitType: "five_hour" } }]), CARRY);
  assert.equal(waiting.advisory_status, "wait-required");
  assert.equal(JSON.stringify(waiting).includes("resets"), false);
  assert.equal(consumeClaudeCarryOutcome({ status: "new-provider-state", reason: "private" }, CARRY).advisory_status, "unknown");
});

test("Claude legacy WRAPUP maps to a coordinator-only RunSteward wrap plan", () => {
  const state = { samples: [{ ts: NOW, rate_limits: { five_hour: { used_percentage: 98 } } }] };
  const legacy = decide(state, { mode: "auto", wrapup_cost_measured: 1 }, {}, NOW);
  assert.equal(legacy.decision, "WRAPUP");
  const evidence = consumeClaudeLimitState(state, { observedAt: "2026-07-15T12:00:00Z", rawEvidenceRef: RAW });
  const advisory = consumeClaudeLimitAdvisory(legacy, evidence);
  assert.equal(advisory.advisory_status, "wrap-requested");
  const plan = createClaudeWrapPlan({
    planId: "wrap:claude:1",
    runId: "run:claude:1",
    advisory,
    evidenceRef: { ref: "evidence/provider/claude-limit.json", digest: evidence.evidence_digest, media_type: "application/json" }
  });
  assert.deepEqual(plan.ordered_capabilities.map((item) => item.skill_id), ["runsteward-checkpoint-run", "runsteward-stop-run", "runsteward-report-run"]);
  assert.equal(plan.forbidden_actions.includes("automatic-git-commit"), true);
});

test("unknown Claude evidence cannot authorize wrap", () => {
  const evidence = consumeClaudeLimitState(null, { observedAt: "2026-07-15T12:00:00Z", rawEvidenceRef: RAW });
  const advisory = consumeClaudeLimitAdvisory({ decision: "WRAPUP", stale: true }, evidence);
  assert.equal(advisory.advisory_status, "unknown");
  assert.throws(() => createClaudeWrapPlan({ planId: "wrap:claude:unknown", runId: "run:claude:unknown", advisory, evidenceRef: RAW }), /non-unknown/);
});

test("Claude checkpoint and handoff use NOT_REQUIRED plus null only", async () => {
  const checkpointTemplate = await readJsonStrict(resolveContractPath("contracts/fixtures/valid/checkpoint.complete.json"));
  const checkpoint = createClaudeCheckpoint(bodyWithoutDigest(checkpointTemplate, "checkpoint_digest"));
  assert.deepEqual(checkpoint.provider_resume_binding, { adapter_id: CLAUDE_CODE_ADAPTER_ID, identity_reference_digest: null, verification_state: "not-required" });
  assert.deepEqual(createClaudeResumeBinding(), checkpoint.provider_resume_binding);
  const handoffTemplate = await readJsonStrict(resolveContractPath("contracts/fixtures/valid/handoff.checkpointed.json"));
  const body = bodyWithoutDigest(handoffTemplate, "handoff_digest");
  body.run_id = checkpoint.run_id;
  body.checkpoint_ref.digest = checkpoint.checkpoint_digest;
  body.safe_resume.adapter_id = CLAUDE_CODE_ADAPTER_ID;
  body.safe_resume.identity_reference_digest = null;
  const handoff = createClaudeHandoff(body, checkpoint);
  assert.equal(assertRunStewardDigest(handoff, "handoff_digest"), handoff.handoff_digest);
  const forbiddenKeys = new Set(["raw_transcript", "transcript", "prompt", "credential", "secret", "content"]);
  const containsForbiddenKey = (value) => value && typeof value === "object" && (Object.keys(value).some((key) => forbiddenKeys.has(key)) || Object.values(value).some(containsForbiddenKey));
  assert.equal(containsForbiddenKey(handoff), false);
});
