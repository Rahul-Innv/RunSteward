import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { bodyWithoutDigest, canonicalizeRunSteward, runstewardDigest } from "../src/canonical-json.mjs";
import { authorityFromProvenance, authorityFromQualification, RW4_ACCEPTED_CHOICEGATE_AUTHORITY } from "../src/choicegate-authority.mjs";
import { ingestQualifiedChoiceGateReceipt } from "../src/choicegate-runtime.mjs";
import { readJsonStrict, resolveContractPath } from "../src/contract-loader.mjs";

const QUALIFICATION_REF = "contracts/fixtures/choicegate/qualification.rw4.json";
const PROVENANCE_REF = "contracts/fixtures/choicegate/provenance.rw4.json";

const QUALIFICATION_AUTHORITY_FIELDS = {
  schema_id: "receipt_schema_id",
  receipt_schema_sha256: "receipt_schema_sha256",
  receipt_schema_source_raw_sha256: "receipt_schema_source_raw_sha256",
  choicegate_commit: "choicegate_commit",
  choicegate_tree: "choicegate_tree",
  choicegate_acceptance_receipt_sha256: "choicegate_acceptance_receipt_sha256",
  lifecycle_authority_commit: "lifecycle_authority_commit",
  lifecycle_authority_tree: "lifecycle_authority_tree",
  lifecycle_authority_state_model: "lifecycle_authority_state_model",
  inventory_fingerprint: "lifecycle_inventory_fingerprint",
  authority_fingerprint: "lifecycle_authority_fingerprint"
};

const PROVENANCE_AUTHORITY_FIELDS = {
  schema_id: "choicegate_receipt_schema_id",
  receipt_schema_sha256: "choicegate_receipt_schema_sha256",
  receipt_schema_source_raw_sha256: "choicegate_receipt_schema_source_raw_sha256",
  choicegate_commit: "choicegate_commit",
  choicegate_tree: "choicegate_tree",
  choicegate_acceptance_receipt_sha256: "choicegate_acceptance_receipt_sha256",
  lifecycle_authority_commit: "lifecycle_authority_commit",
  lifecycle_authority_tree: "lifecycle_authority_tree",
  lifecycle_authority_state_model: "lifecycle_authority_state_model",
  inventory_fingerprint: "lifecycle_inventory_fingerprint",
  authority_fingerprint: "lifecycle_authority_fingerprint"
};

const CASES = {
  atomic: {
    plan: "contracts/fixtures/valid/capability-plan.rw4-atomic.json",
    receipt: "contracts/fixtures/choicegate/rw4-cg-atomic-01.receipt.json"
  },
  bundle: {
    plan: "contracts/fixtures/valid/capability-plan.rw4-bundle.json",
    receipt: "contracts/fixtures/choicegate/rw4-cg-bundle-01.receipt.json"
  },
  gated: {
    plan: "contracts/fixtures/valid/capability-plan.rw4-owner-gated.json",
    receipt: "contracts/fixtures/choicegate/rw4-cg-owner-gated-01.receipt.json"
  }
};

async function artifacts(kind = "atomic") {
  const paths = CASES[kind];
  const [plan, receipt, qualification, provenance, receiptBytes] = await Promise.all([
    readJsonStrict(resolveContractPath(paths.plan)),
    readJsonStrict(resolveContractPath(paths.receipt)),
    readJsonStrict(resolveContractPath(QUALIFICATION_REF)),
    readJsonStrict(resolveContractPath(PROVENANCE_REF)),
    readFile(resolveContractPath(paths.receipt))
  ]);
  return {
    plan,
    receipt,
    qualificationArtifacts: {
      qualificationRef: QUALIFICATION_REF,
      qualification,
      provenanceRef: PROVENANCE_REF,
      provenance,
      receiptBytes
    }
  };
}

async function legacyArtifacts() {
  const [plan, receipt, qualification, provenance, receiptBytes] = await Promise.all([
    readJsonStrict(resolveContractPath("contracts/fixtures/valid/capability-plan.atomic.json")),
    readJsonStrict(resolveContractPath("contracts/fixtures/choicegate/cg-atomic-01.receipt.json")),
    readJsonStrict(resolveContractPath("contracts/fixtures/choicegate/qualification.json")),
    readJsonStrict(resolveContractPath("contracts/fixtures/choicegate/provenance.json")),
    readFile(resolveContractPath("contracts/fixtures/choicegate/cg-atomic-01.receipt.json"))
  ]);
  return {
    plan,
    receipt,
    qualificationArtifacts: {
      qualificationRef: "contracts/fixtures/choicegate/qualification.json",
      qualification,
      provenanceRef: "contracts/fixtures/choicegate/provenance.json",
      provenance,
      receiptBytes
    }
  };
}

function currentState(plan, receipt) {
  return {
    request_sha256: receipt.request_sha256,
    scope_fingerprint: plan.scope_fingerprint,
    frozen_preconditions: structuredClone(plan.frozen_preconditions),
    owner_gates: structuredClone(plan.owner_gates),
    changed_conditions: []
  };
}

function ingest(input, overrides = {}) {
  return ingestQualifiedChoiceGateReceipt({
    ...input,
    currentAuthority: structuredClone(RW4_ACCEPTED_CHOICEGATE_AUTHORITY),
    currentState: currentState(input.plan, input.receipt),
    ...overrides
  });
}

function digestBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function driftValue(field, value) {
  if (field.endsWith("commit") || field.endsWith("tree")) return "0".repeat(40);
  if (field.includes("sha256") || field.includes("fingerprint")) return "0".repeat(64);
  return `${value}-drift`;
}

function rebindQualification(input) {
  input.qualificationArtifacts.qualification.qualification_digest = runstewardDigest(
    bodyWithoutDigest(input.qualificationArtifacts.qualification, "qualification_digest")
  );
  input.plan.choicegate_receipt.qualification_ref.digest = input.qualificationArtifacts.qualification.qualification_digest;
  input.plan.plan_digest = runstewardDigest(bodyWithoutDigest(input.plan, "plan_digest"));
}

function derivedReceipt(base, mutate, suffix) {
  const receipt = structuredClone(base.receipt);
  mutate(receipt);
  receipt.receipt_sha256 = digestBytes(Buffer.from(canonicalizeRunSteward(bodyWithoutDigest(receipt, "receipt_sha256")), "utf8"));
  const receiptBytes = Buffer.from(JSON.stringify(receipt, null, 2) + "\n", "utf8");
  const immutableRef = `contracts/fixtures/choicegate/in-memory-${suffix}.receipt.json`;
  const provenance = structuredClone(base.qualificationArtifacts.provenance);
  provenance.fixtures.push({
    case_id: `CG-RW4-${suffix.toUpperCase()}`,
    path: immutableRef,
    fixture_class: "deterministic-runsteward-rw4-contract-fixture",
    production_decision: false,
    request_sha256: receipt.request_sha256,
    receipt_sha256: receipt.receipt_sha256,
    raw_bytes_sha256: digestBytes(receiptBytes),
    normalized_utf8_lf_sha256: digestBytes(receiptBytes)
  });
  const qualification = structuredClone(base.qualificationArtifacts.qualification);
  qualification.provenance_ref.digest = runstewardDigest(provenance);
  qualification.receipts.push({
    case_id: `CG-RW4-${suffix.toUpperCase()}`,
    immutable_ref: immutableRef,
    normalized_utf8_lf_sha256: digestBytes(receiptBytes),
    raw_bytes_sha256: digestBytes(receiptBytes),
    receipt_sha256: receipt.receipt_sha256,
    request_sha256: receipt.request_sha256,
    schema_id: receipt.receipt_version,
    choicegate_commit: receipt.router_binding.choicegate_commit,
    qualification_status: "passed"
  });
  qualification.qualification_digest = runstewardDigest(bodyWithoutDigest(qualification, "qualification_digest"));
  const plan = structuredClone(base.plan);
  Object.assign(plan.choicegate_receipt, {
    immutable_ref: immutableRef,
    receipt_sha256: receipt.receipt_sha256,
    qualification_ref: { ref: QUALIFICATION_REF, digest: qualification.qualification_digest }
  });
  plan.selected_route = {
    route_type: receipt.decision.route_type,
    route_id: receipt.decision.route_id,
    version: receipt.decision.version,
    owner: receipt.decision.owner,
    member_ids: [],
    executable: receipt.decision.executable,
    original_selection_ref: null
  };
  plan.plan_digest = runstewardDigest(bodyWithoutDigest(plan, "plan_digest"));
  return {
    plan,
    receipt,
    qualificationArtifacts: {
      ...base.qualificationArtifacts,
      qualification,
      provenance,
      receiptBytes
    }
  };
}

function replacePlanDigest(value, oldDigest, newDigest) {
  if (Array.isArray(value)) return value.map((item) => replacePlanDigest(item, oldDigest, newDigest));
  if (!value || typeof value !== "object") return value === oldDigest ? newDigest : value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, replacePlanDigest(child, oldDigest, newDigest)]));
}

async function satisfiedGateEvents(plan) {
  const wrapper = await readJsonStrict(resolveContractPath("contracts/fixtures/scenarios/lifecycle.atomic-initial-gated-01.json"));
  const oldDigest = wrapper.events[1].event_data.capability_plan_ref.digest;
  const events = replacePlanDigest(wrapper.events, oldDigest, plan.plan_digest);
  let previous = null;
  for (const event of events) {
    event.previous_event_digest = previous;
    event.event_digest = runstewardDigest(bodyWithoutDigest(event, "event_digest"));
    previous = event.event_digest;
  }
  return events;
}

test("RW4 dispatches only the exact original executable atomic or bundle selection", async () => {
  for (const kind of ["atomic", "bundle"]) {
    const input = await artifacts(kind);
    const result = ingest(input);
    assert.equal(result.status, "authorized");
    assert.equal(result.action, "dispatch-original-selection");
    assert.deepEqual(result.route, {
      route_type: input.plan.selected_route.route_type,
      route_id: input.plan.selected_route.route_id,
      version: input.plan.selected_route.version,
      owner: input.plan.selected_route.owner,
      member_ids: input.plan.selected_route.member_ids
    });
  }
});

test("RW4 stale-receipt matrix stops and requires ChoiceGate reselection", async () => {
  const input = await artifacts();
  const cases = [
    (state) => { state.request_sha256 = "0".repeat(64); },
    (state) => { state.scope_fingerprint = `sha256:${"1".repeat(64)}`; },
    (state) => { state.frozen_preconditions = [{ precondition_id: "changed", value_digest: `sha256:${"2".repeat(64)}` }]; },
    (state) => { state.owner_gates = ["approval:changed"]; },
    (state) => { state.changed_conditions = ["availability-changed"]; },
    (state) => { state.changed_conditions = ["selected-path-failed", "permission-or-risk-changed"]; }
  ];
  for (const mutate of cases) {
    const state = currentState(input.plan, input.receipt);
    mutate(state);
    const result = ingest(input, { currentState: state });
    assert.equal(result.status, "stopped");
    assert.equal(result.reason_code, "STALE_RECEIPT");
    assert.equal(result.requires_reselection, true);
  }
  const unknown = currentState(input.plan, input.receipt);
  unknown.changed_conditions = ["invented-change"];
  assert.throws(() => ingest(input, { currentState: unknown }), /undeclared ChoiceGate reselection condition/);
});

test("RW4 exact authority drift matrix stops before dispatch", async () => {
  const input = await artifacts();
  assert.deepEqual(authorityFromQualification(input.qualificationArtifacts.qualification), RW4_ACCEPTED_CHOICEGATE_AUTHORITY);
  assert.deepEqual(authorityFromProvenance(input.qualificationArtifacts.provenance), RW4_ACCEPTED_CHOICEGATE_AUTHORITY);
  for (const field of Object.keys(RW4_ACCEPTED_CHOICEGATE_AUTHORITY)) {
    const authority = structuredClone(RW4_ACCEPTED_CHOICEGATE_AUTHORITY);
    authority[field] = `${authority[field]}-drift`;
    const result = ingest(input, { currentAuthority: authority });
    assert.equal(result.status, "stopped", field);
    assert.equal(result.reason_code, "AUTHORITY_DRIFT", field);
    assert.equal(result.requires_reselection, true, field);
    assert.ok(result.drift.includes(`current:${field}`), field);
  }
});

test("RW4 qualification and provenance bind every accepted authority field", async () => {
  for (const [authorityField, qualificationField] of Object.entries(QUALIFICATION_AUTHORITY_FIELDS)) {
    const input = await artifacts();
    const qualification = input.qualificationArtifacts.qualification;
    qualification[qualificationField] = driftValue(authorityField, qualification[qualificationField]);
    rebindQualification(input);
    assert.throws(() => ingest(input), /authority drift/, `qualification:${authorityField}`);
  }
  for (const [authorityField, provenanceField] of Object.entries(PROVENANCE_AUTHORITY_FIELDS)) {
    const input = await artifacts();
    const provenance = input.qualificationArtifacts.provenance;
    provenance.authority[provenanceField] = driftValue(authorityField, provenance.authority[provenanceField]);
    input.qualificationArtifacts.qualification.provenance_ref.digest = runstewardDigest(provenance);
    rebindQualification(input);
    assert.throws(() => ingest(input), /authority drift/, `provenance:${authorityField}`);
  }
});

test("RW4 treats an internally valid superseded frozen authority as reselection-required", async () => {
  const input = await legacyArtifacts();
  const result = ingest(input);
  assert.equal(result.status, "stopped");
  assert.equal(result.reason_code, "AUTHORITY_DRIFT");
  assert.equal(result.requires_reselection, true);
  assert.ok(result.drift.some((field) => field.startsWith("receipt:")));
});

test("RW4 records NO_SAFE_ROUTE as a stopped reselection boundary", async () => {
  const base = await artifacts();
  const input = derivedReceipt(base, (receipt) => {
    receipt.decision = {
      route_type: "no-safe-route",
      route_id: "NO_SAFE_ROUTE",
      version: null,
      owner: null,
      executable: false,
      reason: "no-eligible-route"
    };
    receipt.bundle_members = [];
  }, "no-safe-route");
  const result = ingest(input);
  assert.equal(result.status, "stopped");
  assert.equal(result.reason_code, "NO_SAFE_ROUTE");
  assert.equal(result.requires_reselection, true);
});

test("RW4 handoff is continuity evidence only and never dispatches", async () => {
  const base = await artifacts();
  const input = derivedReceipt(base, (receipt) => {
    receipt.decision = {
      route_type: "handoff",
      route_id: "SAFE_HANDOFF",
      version: null,
      owner: null,
      executable: false,
      reason: "unchanged-original-selection"
    };
    receipt.bundle_members = [];
  }, "handoff");
  const originalQualified = input.qualificationArtifacts.qualification.receipts.find((item) => item.immutable_ref === base.plan.choicegate_receipt.immutable_ref);
  input.plan.selected_route.original_selection_ref = {
    ref: base.plan.choicegate_receipt.immutable_ref,
    digest: `sha256:${originalQualified.normalized_utf8_lf_sha256}`
  };
  input.plan.plan_digest = runstewardDigest(bodyWithoutDigest(input.plan, "plan_digest"));
  input.qualificationArtifacts.originalReceipt = base.receipt;
  input.qualificationArtifacts.originalReceiptBytes = base.qualificationArtifacts.receiptBytes;
  const result = ingest(input);
  assert.equal(result.status, "stopped");
  assert.equal(result.reason_code, "HANDOFF_CONTINUITY_ONLY");
  assert.equal(result.requires_reselection, false);
});

test("RW4 owner gates stop until the existing event chain proves satisfaction", async () => {
  const input = await artifacts("gated");
  const waiting = ingest(input);
  assert.equal(waiting.reason_code, "OWNER_APPROVAL_REQUIRED");
  assert.deepEqual(waiting.owner_gates, ["approval:initial-local"]);
  const authorized = ingest(input, { ownerGateEvents: await satisfiedGateEvents(input.plan) });
  assert.equal(authorized.status, "authorized");
  assert.equal(authorized.action, "dispatch-original-selection");
});

test("RW4 runtime contains no router, ranker, provider, network, or process invocation", async () => {
  const source = await readFile(new URL("../src/choicegate-runtime.mjs", import.meta.url), "utf8");
  for (const forbidden of ["score_breakdown", "candidate_evidence", "rankCandidates", "route_capabilities", "child_process", "fetch(", "spawn(", "provider-"]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});
