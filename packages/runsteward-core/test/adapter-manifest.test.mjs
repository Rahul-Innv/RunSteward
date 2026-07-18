import assert from "node:assert/strict";
import test from "node:test";
import { assertAdapterFixtureManifest } from "../src/adapter-manifest.mjs";
import { readJsonStrict, resolveContractPath } from "../src/contract-loader.mjs";

test("adapter manifest pins imported and RunSteward-owned package declarations exactly", async () => {
  const manifest = await readJsonStrict(resolveContractPath("tests/contract-compat/adapter_fixture_manifest.json"));
  assert.equal(assertAdapterFixtureManifest(manifest), true);
  for (let packageIndex = 0; packageIndex < manifest.imported_packages.length; packageIndex += 1) {
    for (const field of ["path", "owner", "rw1_mutation", "fixture_role", "focused_test"]) {
      const stale = structuredClone(manifest);
      stale.imported_packages[packageIndex][field] = `${stale.imported_packages[packageIndex][field]}-misdirected`;
      assert.throws(() => assertAdapterFixtureManifest(stale), /stale or misdirected/);
    }
  }
  const extra = structuredClone(manifest);
  extra.imported_packages.push(structuredClone(extra.imported_packages[0]));
  assert.throws(() => assertAdapterFixtureManifest(extra), /incomplete or stale/);
  for (let packageIndex = 0; packageIndex < manifest.runsteward_owned_packages.length; packageIndex += 1) {
    for (const field of ["path", "owner", "phase", "role"]) {
      const stale = structuredClone(manifest);
      stale.runsteward_owned_packages[packageIndex][field] = `${stale.runsteward_owned_packages[packageIndex][field]}-misdirected`;
      assert.throws(() => assertAdapterFixtureManifest(stale), /stale or misdirected/);
    }
  }
  const duplicateOwned = structuredClone(manifest);
  duplicateOwned.runsteward_owned_packages.push(structuredClone(duplicateOwned.runsteward_owned_packages[0]));
  assert.throws(() => assertAdapterFixtureManifest(duplicateOwned), /incomplete or stale/);
});
