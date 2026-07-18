import { canonicalizeRunSteward } from "./canonical-json.mjs";
import { authorityFromProvenance, authorityFromQualification, RW4_ACCEPTED_CHOICEGATE_AUTHORITY, RW4_AUTHORITY_FIELDS } from "./choicegate-authority.mjs";
import { assertQualifiedCapabilityPlanBinding, assertRunOwnerGateBinding } from "./invariants.mjs";

function same(left, right) {
  return canonicalizeRunSteward(left) === canonicalizeRunSteward(right);
}

function exactAuthorityDrift(actual) {
  return RW4_AUTHORITY_FIELDS.filter((field) => actual?.[field] !== RW4_ACCEPTED_CHOICEGATE_AUTHORITY[field]);
}

function stopped(reasonCode, drift = []) {
  return {
    status: "stopped",
    action: "require-choicegate-reselection",
    requires_reselection: true,
    reason_code: reasonCode,
    drift: [...drift].sort()
  };
}

function exactRoute(plan) {
  return {
    route_type: plan.selected_route.route_type,
    route_id: plan.selected_route.route_id,
    version: plan.selected_route.version,
    owner: plan.selected_route.owner,
    member_ids: [...plan.selected_route.member_ids]
  };
}

export function ingestQualifiedChoiceGateReceipt({
  plan,
  receipt,
  qualificationArtifacts,
  currentAuthority,
  currentState,
  ownerGateEvents = null
}) {
  if (!currentState || typeof currentState !== "object" || Array.isArray(currentState)) {
    throw new TypeError("currentState is required");
  }
  const frozenAuthority = authorityFromQualification(qualificationArtifacts.qualification);
  assertQualifiedCapabilityPlanBinding(plan, receipt, {
    ...qualificationArtifacts,
    expectedAuthority: frozenAuthority
  });

  const frozenAuthorityDrift = exactAuthorityDrift(frozenAuthority);
  const provenanceAuthorityDrift = exactAuthorityDrift(authorityFromProvenance(qualificationArtifacts.provenance));
  const liveAuthorityDrift = exactAuthorityDrift(currentAuthority);
  if (frozenAuthorityDrift.length > 0 || provenanceAuthorityDrift.length > 0 || liveAuthorityDrift.length > 0) {
    return stopped("AUTHORITY_DRIFT", [
      ...frozenAuthorityDrift.map((field) => `receipt:${field}`),
      ...provenanceAuthorityDrift.map((field) => `provenance:${field}`),
      ...liveAuthorityDrift.map((field) => `current:${field}`)
    ]);
  }

  const stale = [];
  if (currentState.request_sha256 !== receipt.request_sha256) stale.push("request-digest-changed");
  if (currentState.scope_fingerprint !== plan.scope_fingerprint) stale.push("scope-changed");
  if (!same(currentState.frozen_preconditions, plan.frozen_preconditions)) stale.push("preconditions-changed");
  if (!same(currentState.owner_gates, plan.owner_gates)) stale.push("owner-gate-changed");

  if (!Array.isArray(currentState.changed_conditions)) {
    throw new TypeError("currentState.changed_conditions must be an array");
  }
  const declaredTriggers = new Set(receipt.reselection_triggers);
  for (const condition of currentState.changed_conditions) {
    if (typeof condition !== "string" || !declaredTriggers.has(condition)) {
      throw new Error(`undeclared ChoiceGate reselection condition: ${String(condition)}`);
    }
    stale.push(condition);
  }
  if (stale.length > 0) return stopped("STALE_RECEIPT", [...new Set(stale)]);

  if (receipt.decision.route_type === "no-safe-route" || receipt.decision.route_id === "NO_SAFE_ROUTE") {
    return stopped("NO_SAFE_ROUTE", [receipt.decision.reason]);
  }
  if (receipt.decision.route_type === "handoff") {
    return {
      status: "stopped",
      action: "reuse-qualified-original-selection",
      requires_reselection: false,
      reason_code: "HANDOFF_CONTINUITY_ONLY",
      original_selection_ref: plan.selected_route.original_selection_ref
    };
  }
  if (!["atomic", "bundle"].includes(receipt.decision.route_type) || receipt.decision.executable !== true) {
    return stopped("NON_EXECUTABLE_SELECTION", [receipt.decision.route_type]);
  }

  if (plan.owner_gates.length > 0) {
    if (ownerGateEvents === null) {
      return {
        status: "stopped",
        action: "await-owner-approval",
        requires_reselection: false,
        reason_code: "OWNER_APPROVAL_REQUIRED",
        owner_gates: [...plan.owner_gates]
      };
    }
    assertRunOwnerGateBinding(plan, ownerGateEvents);
  } else if (plan.authorization_state !== "not-required" || receipt.task.authorization_required !== false || receipt.approvals_required.length !== 0) {
    return stopped("AUTHORIZATION_DRIFT", ["authorization-or-owner-gate-changed"]);
  }

  return {
    status: "authorized",
    action: "dispatch-original-selection",
    requires_reselection: false,
    reason_code: "EXACT_FROZEN_SELECTION_CURRENT",
    route: exactRoute(plan),
    receipt_ref: {
      ref: plan.choicegate_receipt.immutable_ref,
      digest: `sha256:${plan.choicegate_receipt.receipt_sha256}`
    }
  };
}
