export const RW4_ACCEPTED_CHOICEGATE_AUTHORITY = Object.freeze({
  schema_id: "choicegate.decision-receipt/v1",
  receipt_schema_sha256: "3d32d4bac2cb9ff78d0249741d74e8572326894435e3bab10bf0f2f7ca7c949d",
  receipt_schema_source_raw_sha256: "c21949ee1a0fcf80d550d22b541123bbd31c5c424c92f819ee9cfa409827b69f",
  choicegate_commit: "c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1",
  choicegate_tree: "c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2",
  choicegate_acceptance_receipt_sha256: "c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3",
  lifecycle_authority_commit: "d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1",
  lifecycle_authority_tree: "d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2",
  lifecycle_authority_state_model: "orthogonal-seven-axis-v1",
  inventory_fingerprint: "e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1",
  authority_fingerprint: "e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2"
});

export const RW4_AUTHORITY_FIELDS = Object.freeze(Object.keys(RW4_ACCEPTED_CHOICEGATE_AUTHORITY).sort());

export function authorityFromQualification(qualification) {
  return {
    schema_id: qualification.receipt_schema_id,
    receipt_schema_sha256: qualification.receipt_schema_sha256,
    receipt_schema_source_raw_sha256: qualification.receipt_schema_source_raw_sha256,
    choicegate_commit: qualification.choicegate_commit,
    choicegate_tree: qualification.choicegate_tree,
    choicegate_acceptance_receipt_sha256: qualification.choicegate_acceptance_receipt_sha256,
    lifecycle_authority_commit: qualification.lifecycle_authority_commit,
    lifecycle_authority_tree: qualification.lifecycle_authority_tree,
    lifecycle_authority_state_model: qualification.lifecycle_authority_state_model,
    inventory_fingerprint: qualification.lifecycle_inventory_fingerprint,
    authority_fingerprint: qualification.lifecycle_authority_fingerprint
  };
}

export function authorityFromProvenance(provenance) {
  const authority = provenance.authority;
  return {
    schema_id: authority.choicegate_receipt_schema_id,
    receipt_schema_sha256: authority.choicegate_receipt_schema_sha256,
    receipt_schema_source_raw_sha256: authority.choicegate_receipt_schema_source_raw_sha256,
    choicegate_commit: authority.choicegate_commit,
    choicegate_tree: authority.choicegate_tree,
    choicegate_acceptance_receipt_sha256: authority.choicegate_acceptance_receipt_sha256,
    lifecycle_authority_commit: authority.lifecycle_authority_commit,
    lifecycle_authority_tree: authority.lifecycle_authority_tree,
    lifecycle_authority_state_model: authority.lifecycle_authority_state_model,
    inventory_fingerprint: authority.lifecycle_inventory_fingerprint,
    authority_fingerprint: authority.lifecycle_authority_fingerprint
  };
}
