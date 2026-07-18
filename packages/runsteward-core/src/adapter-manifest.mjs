export const EXPECTED_IMPORTED_PACKAGE_DECLARATIONS = Object.freeze([
  Object.freeze({
    package_id: "claude-carry",
    path: "packages/claude-carry",
    owner: "imported-product-owned",
    rw1_mutation: "forbidden",
    fixture_role: "claude-local-resume-and-handoff-regression",
    focused_test: "npm.cmd test --prefix packages/claude-carry"
  }),
  Object.freeze({
    package_id: "codex-nightwatch",
    path: "packages/codex-nightwatch",
    owner: "imported-product-owned",
    rw1_mutation: "forbidden",
    fixture_role: "codex-classified-lifecycle-fact-regression",
    focused_test: "python.exe -B -m unittest discover -s packages/codex-nightwatch/tests -p test_*.py"
  }),
  Object.freeze({
    package_id: "limit-aware-wrapup",
    path: "packages/limit-aware-wrapup",
    owner: "imported-product-owned",
    rw1_mutation: "forbidden",
    fixture_role: "bounded-sensor-and-wrapup-regression",
    focused_test: "node --test packages/limit-aware-wrapup/test/*.test.js"
  })
]);

export const EXPECTED_RUNSTEWARD_PACKAGE_DECLARATIONS = Object.freeze([
  Object.freeze({ package_id: "@runsteward/core", path: "packages/runsteward-core", owner: "runsteward-integration-owned", phase: "rw1-rw4", role: "provider-neutral-contract-lifecycle-orchestration-and-frozen-choicegate-ingestion-core" }),
  Object.freeze({ package_id: "@runsteward/cli", path: "packages/runsteward-cli", owner: "runsteward-integration-owned", phase: "v2-atomic-family", role: "inactive-route-only-atomic-family-cli" }),
  Object.freeze({ package_id: "@runsteward/adapter-claude-code", path: "packages/runsteward-adapter-claude-code", owner: "runsteward-integration-owned", phase: "rw3", role: "thin-claude-checkpoint-wrap-resume-consumer" }),
  Object.freeze({ package_id: "@runsteward/adapter-codex", path: "packages/runsteward-adapter-codex", owner: "runsteward-integration-owned", phase: "rw3", role: "thin-codex-checkpoint-wrap-resume-consumer" }),
  Object.freeze({ package_id: "@runsteward/sensor-claude-limits", path: "packages/runsteward-sensor-claude-limits", owner: "runsteward-integration-owned", phase: "rw3", role: "typed-claude-limit-evidence-only" }),
  Object.freeze({ package_id: "@runsteward/sensor-codex-usage", path: "packages/runsteward-sensor-codex-usage", owner: "runsteward-integration-owned", phase: "rw3", role: "typed-codex-usage-evidence-only" })
]);

export function assertAdapterFixtureManifest(manifest) {
  if (manifest?.schema_version !== "runsteward.adapter-fixture-manifest/v2" || !Array.isArray(manifest.imported_packages) || !Array.isArray(manifest.runsteward_owned_packages)) {
    throw new Error("invalid adapter fixture manifest contract");
  }
  if (manifest.imported_packages.length !== EXPECTED_IMPORTED_PACKAGE_DECLARATIONS.length) {
    throw new Error("adapter fixture manifest package inventory is incomplete or stale");
  }
  const byId = new Map(manifest.imported_packages.map((item) => [item.package_id, item]));
  if (byId.size !== manifest.imported_packages.length) throw new Error("adapter fixture manifest has duplicate package declarations");
  for (const expected of EXPECTED_IMPORTED_PACKAGE_DECLARATIONS) {
    const actual = byId.get(expected.package_id);
    for (const field of ["path", "owner", "rw1_mutation", "fixture_role", "focused_test"]) {
      if (!actual || actual[field] !== expected[field]) throw new Error(`adapter fixture manifest ${expected.package_id}.${field} is stale or misdirected`);
    }
  }
  if (manifest.runsteward_owned_packages.length !== EXPECTED_RUNSTEWARD_PACKAGE_DECLARATIONS.length) throw new Error("RunSteward-owned package inventory is incomplete or stale");
  const ownedById = new Map(manifest.runsteward_owned_packages.map((item) => [item.package_id, item]));
  if (ownedById.size !== manifest.runsteward_owned_packages.length) throw new Error("adapter fixture manifest has duplicate RunSteward-owned package declarations");
  for (const expected of EXPECTED_RUNSTEWARD_PACKAGE_DECLARATIONS) {
    const actual = ownedById.get(expected.package_id);
    for (const field of ["path", "owner", "phase", "role"]) {
      if (!actual || actual[field] !== expected[field]) throw new Error(`adapter fixture manifest ${expected.package_id}.${field} is stale or misdirected`);
    }
  }
  return true;
}
