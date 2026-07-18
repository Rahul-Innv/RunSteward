import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { bodyWithoutDigest, runstewardDigest } from "../src/canonical-json.mjs";
import { assertDispatchAuthorized, assertQualifiedCapabilityPlanBinding, assertRunOwnerGateBinding } from "../src/invariants.mjs";
import { readJsonStrict, resolveContractPath } from "../src/contract-loader.mjs";
import { buildInitialOwnerGatedScenario } from "./scenario-factory.mjs";

const paths = {
  plan: "contracts/fixtures/valid/capability-plan.atomic.json",
  receipt: "contracts/fixtures/choicegate/cg-atomic-01.receipt.json",
  qualification: "contracts/fixtures/choicegate/qualification.json",
  provenance: "contracts/fixtures/choicegate/provenance.json"
};

async function artifacts() {
  const [plan, receipt, qualification, provenance, receiptBytes] = await Promise.all([
    readJsonStrict(resolveContractPath(paths.plan)), readJsonStrict(resolveContractPath(paths.receipt)),
    readJsonStrict(resolveContractPath(paths.qualification)), readJsonStrict(resolveContractPath(paths.provenance)),
    readFile(resolveContractPath(paths.receipt))
  ]);
  return { plan, receipt, qualificationRef: paths.qualification, qualification, provenanceRef: paths.provenance, provenance, receiptBytes };
}

test("qualified frozen ChoiceGate receipt authorizes only its exact local route", async () => {
  const { plan, receipt, ...qualificationArtifacts } = await artifacts();
  assert.equal(assertQualifiedCapabilityPlanBinding(plan, receipt, qualificationArtifacts), true);
  assert.equal(assertDispatchAuthorized(plan, receipt, qualificationArtifacts), true);
});

test("non-production gated receipt qualifies the exact plan and initial owner-gate chain", async () => {
  const scenario = await buildInitialOwnerGatedScenario();
  const qualificationRef = "contracts/fixtures/choicegate/qualification.initial-gated.json";
  const provenanceRef = "contracts/fixtures/choicegate/provenance.initial-gated.json";
  const receiptRef = "contracts/fixtures/choicegate/cg-initial-gated-01.receipt.json";
  const [receipt, qualification, provenance, receiptBytes] = await Promise.all([
    readJsonStrict(resolveContractPath(receiptRef)), readJsonStrict(resolveContractPath(qualificationRef)),
    readJsonStrict(resolveContractPath(provenanceRef)), readFile(resolveContractPath(receiptRef))
  ]);
  const evidence = { qualificationRef, qualification, provenanceRef, provenance, receiptBytes };
  assert.equal(provenance.local_contract_fixture_policy.production_decision, false);
  assert.equal(provenance.local_contract_fixture_policy.selection_authority_claimed, false);
  assert.equal(receipt.task.fixture_id, "atomic-initial-owner-gated-runsteward-contract");
  assert.equal(assertQualifiedCapabilityPlanBinding(scenario.plan, receipt, evidence), true);
  assert.equal(assertRunOwnerGateBinding(scenario.plan, scenario.events), true);
  assert.throws(() => assertDispatchAuthorized(scenario.plan, receipt, evidence), /authorization or owner gates/);
  for (const mutate of [
    (plan) => { plan.owner_gates = []; },
    (plan) => { plan.authorization_state = "not-required"; }
  ]) {
    const drifted = structuredClone(scenario.plan);
    mutate(drifted);
    drifted.plan_digest = runstewardDigest(bodyWithoutDigest(drifted, "plan_digest"));
    assert.throws(() => assertQualifiedCapabilityPlanBinding(drifted, receipt, evidence), /owner gate drift|authorization state drift/);
  }
});

test("JavaScript independently kills receipt-object and immutable-byte tampering", async () => {
  const { plan, receipt, ...qualificationArtifacts } = await artifacts();
  const tamperedReceipt = structuredClone(receipt);
  tamperedReceipt.decision.route_id = "fabricated-route";
  assert.throws(() => assertQualifiedCapabilityPlanBinding(plan, tamperedReceipt, qualificationArtifacts), /receipt object differs|native receipt/);
  const tamperedBytes = Buffer.from(qualificationArtifacts.receiptBytes);
  tamperedBytes[tamperedBytes.length - 2] ^= 1;
  assert.throws(() => assertQualifiedCapabilityPlanBinding(plan, receipt, { ...qualificationArtifacts, receiptBytes: tamperedBytes }), /bytes drift|JSON/);
});

test("plan scope, precondition, authority, and route drift fail closed", async () => {
  const { plan, receipt, ...qualificationArtifacts } = await artifacts();
  for (const mutate of [
    (value) => { value.scope_fingerprint = "sha256:" + "0".repeat(64); },
    (value) => { value.frozen_preconditions = [{ precondition_id: "invented", value_digest: "sha256:" + "1".repeat(64) }]; },
    (value) => { value.selected_route.route_id = "wrong-route"; },
    (value) => { value.authorization_state = "requires-owner"; }
  ]) {
    const tampered = structuredClone(plan);
    mutate(tampered);
    assert.throws(() => assertQualifiedCapabilityPlanBinding(tampered, receipt, qualificationArtifacts));
  }
});

test("vendored ChoiceGate schema normalized hash survives CRLF materialization", async () => {
  const bytes = await readFile(resolveContractPath("contracts/vendor/choicegate/decision-receipt.schema.json"));
  const crlf = Buffer.from(bytes.toString("utf8").replace(/\r?\n/g, "\r\n"), "utf8");
  const normalized = crlf.toString("utf8").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  assert.equal(createHash("sha256").update(normalized, "utf8").digest("hex"), "3d32d4bac2cb9ff78d0249741d74e8572326894435e3bab10bf0f2f7ca7c949d");
  assert.equal(createHash("sha256").update(crlf).digest("hex"), "c21949ee1a0fcf80d550d22b541123bbd31c5c424c92f819ee9cfa409827b69f");
});

test("contract path resolver rejects absolute and parent-directory escapes", () => {
  // The resolver delegates absoluteness to the host path API: POSIX-style
  // absolute paths are absolute on every platform (win32 included), while
  // drive-letter paths are only absolute where the host API says so (win32).
  assert.throws(() => resolveContractPath("/outside/artifact.json"), /repository-relative/);
  if (process.platform === "win32") {
    assert.throws(() => resolveContractPath("C:\\outside\\artifact.json"), /repository-relative/);
  }
  assert.throws(() => resolveContractPath("contracts/../outside.json"), /repository-relative/);
  assert.throws(() => resolveContractPath("..\\outside.json"), /repository-relative/);
  assert.throws(() => resolveContractPath("../outside.json"), /repository-relative/);
});

test("handoff resolves exact qualified original bytes, rejects a fabricated original object, and remains non-dispatchable", async () => {
  const base = await artifacts();
  const originalQualified = base.qualification.receipts.find((item) => item.immutable_ref === paths.receipt);
  const receipt = structuredClone(base.receipt);
  receipt.decision = { route_type: "handoff", route_id: "SAFE_HANDOFF", version: null, owner: null, executable: false, reason: "valid-handoff" };
  receipt.bundle_members = [];
  receipt.receipt_sha256 = "f".repeat(64);
  const receiptBytes = Buffer.from(JSON.stringify(receipt, null, 2) + "\n", "utf8");
  const raw = createHash("sha256").update(receiptBytes).digest("hex");
  const handoffPath = "contracts/fixtures/choicegate/in-memory-handoff.receipt.json";
  const provenance = structuredClone(base.provenance);
  provenance.fixtures.push({ case_id: "CG-HANDOFF-IN-MEMORY", path: handoffPath, request_sha256: receipt.request_sha256, receipt_sha256: receipt.receipt_sha256, raw_bytes_sha256: raw, normalized_utf8_lf_sha256: raw });
  const qualification = structuredClone(base.qualification);
  qualification.provenance_ref.digest = runstewardDigest(provenance);
  qualification.receipts.push({ case_id: "CG-HANDOFF-IN-MEMORY", immutable_ref: handoffPath, raw_bytes_sha256: raw, normalized_utf8_lf_sha256: raw, receipt_sha256: receipt.receipt_sha256, request_sha256: receipt.request_sha256, schema_id: receipt.receipt_version, choicegate_commit: receipt.router_binding.choicegate_commit, qualification_status: "passed" });
  qualification.qualification_digest = runstewardDigest(bodyWithoutDigest(qualification, "qualification_digest"));
  const plan = structuredClone(base.plan);
  Object.assign(plan.choicegate_receipt, {
    immutable_ref: handoffPath, receipt_sha256: receipt.receipt_sha256, request_id: receipt.request_id,
    request_sha256: receipt.request_sha256, task_class: receipt.task.task_class,
    inventory_fingerprint: receipt.inventory_binding.manifest_fingerprint,
    qualification_ref: { ref: paths.qualification, digest: qualification.qualification_digest }
  });
  plan.selected_route = {
    route_type: "handoff", route_id: receipt.decision.route_id, version: null, owner: null, member_ids: [], executable: false,
    original_selection_ref: { ref: paths.receipt, digest: `sha256:${originalQualified.normalized_utf8_lf_sha256}` }
  };
  plan.plan_digest = runstewardDigest(bodyWithoutDigest(plan, "plan_digest"));
  const qualificationArtifacts = {
    qualificationRef: paths.qualification, qualification, provenanceRef: paths.provenance, provenance,
    receiptBytes, originalReceipt: base.receipt, originalReceiptBytes: base.receiptBytes
  };
  assert.equal(assertQualifiedCapabilityPlanBinding(plan, receipt, qualificationArtifacts), true);
  assert.throws(() => assertDispatchAuthorized(plan, receipt, qualificationArtifacts), /original executable atomic or bundle/);
  const fabricatedOriginal = structuredClone(base.receipt);
  fabricatedOriginal.decision.route_id = "fabricated-original";
  assert.throws(() => assertQualifiedCapabilityPlanBinding(plan, receipt, { ...qualificationArtifacts, originalReceipt: fabricatedOriginal }), /original selection|differs from its qualified immutable bytes/);

  const chained = structuredClone(plan);
  chained.selected_route.original_selection_ref = { ref: handoffPath, digest: `sha256:${raw}` };
  chained.plan_digest = runstewardDigest(bodyWithoutDigest(chained, "plan_digest"));
  assert.throws(
    () => assertQualifiedCapabilityPlanBinding(chained, receipt, { ...qualificationArtifacts, originalReceipt: receipt, originalReceiptBytes: receiptBytes }),
    /original atomic or bundle/
  );
});
