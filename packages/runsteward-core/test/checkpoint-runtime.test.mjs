import assert from "node:assert/strict";
import test from "node:test";
import { bodyWithoutDigest, assertRunStewardDigest } from "../src/canonical-json.mjs";
import { createBoundedHandoffArtifact, createCheckpointArtifact } from "../src/checkpoint-runtime.mjs";
import { readJsonStrict, resolveContractPath } from "../src/contract-loader.mjs";

test("checkpoint builder preserves bounded references and strict resumable identity", async () => {
  const template = await readJsonStrict(resolveContractPath("contracts/fixtures/valid/checkpoint.complete.json"));
  const checkpoint = createCheckpointArtifact(bodyWithoutDigest(template, "checkpoint_digest"));
  assert.equal(assertRunStewardDigest(checkpoint, "checkpoint_digest"), checkpoint.checkpoint_digest);
  assert.equal(checkpoint.provider_resume_binding.verification_state, "not-required");
  assert.equal(checkpoint.provider_resume_binding.identity_reference_digest, null);
  assert.equal(Object.hasOwn(checkpoint, "raw_transcript"), false);
});

test("bounded handoff cannot smuggle raw identity into an ineligible resume", async () => {
  const checkpointTemplate = await readJsonStrict(resolveContractPath("contracts/fixtures/valid/checkpoint.complete.json"));
  const checkpoint = createCheckpointArtifact(bodyWithoutDigest(checkpointTemplate, "checkpoint_digest"));
  const handoffTemplate = await readJsonStrict(resolveContractPath("contracts/fixtures/valid/handoff.checkpointed.json"));
  const body = bodyWithoutDigest(handoffTemplate, "handoff_digest");
  body.checkpoint_ref.digest = checkpoint.checkpoint_digest;
  const handoff = createBoundedHandoffArtifact(body, checkpoint);
  assert.equal(assertRunStewardDigest(handoff, "handoff_digest"), handoff.handoff_digest);
  const ineligible = structuredClone(body);
  ineligible.safe_resume.eligible = false;
  ineligible.safe_resume.preconditions = [];
  ineligible.safe_resume.identity_reference_digest = "sha256:" + "c".repeat(64);
  ineligible.safe_resume.invocation_template = null;
  assert.throws(() => createBoundedHandoffArtifact(ineligible, checkpoint), /ineligible handoff/);
});

test("checkpoint and handoff builders enforce nested contract bounds before digesting", async () => {
  const checkpointTemplate = await readJsonStrict(resolveContractPath("contracts/fixtures/valid/checkpoint.complete.json"));
  const checkpointBody = bodyWithoutDigest(checkpointTemplate, "checkpoint_digest");
  const escapedCheckpoint = structuredClone(checkpointBody);
  escapedCheckpoint.changed_paths[0].path = "../private.txt";
  assert.throws(() => createCheckpointArtifact(escapedCheckpoint), /repository-relative/);
  const malformedCheckpoint = structuredClone(checkpointBody);
  malformedCheckpoint.repository.dirty_summary.changed_path_count = -1;
  assert.throws(() => createCheckpointArtifact(malformedCheckpoint), /dirty_summary/);

  const checkpoint = createCheckpointArtifact(checkpointBody);
  const handoffTemplate = await readJsonStrict(resolveContractPath("contracts/fixtures/valid/handoff.checkpointed.json"));
  const handoffBody = bodyWithoutDigest(handoffTemplate, "handoff_digest");
  handoffBody.checkpoint_ref.digest = checkpoint.checkpoint_digest;
  const unbounded = structuredClone(handoffBody);
  unbounded.completed_items = ["x".repeat(4097)];
  assert.throws(() => createBoundedHandoffArtifact(unbounded, checkpoint), /not bounded/);
  const rawField = structuredClone(handoffBody);
  rawField.failed_commands_summary = [{ command: "secret command", exit_code: 1, summary: "failed", evidence_refs: [] }];
  assert.throws(() => createBoundedHandoffArtifact(rawField, checkpoint), /unexpected or missing field/);
});
