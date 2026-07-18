import assert from "node:assert/strict";
import test from "node:test";
import { canonicalizeRunSteward, runstewardDigest } from "../src/canonical-json.mjs";
import { readJsonStrict, resolveContractPath } from "../src/contract-loader.mjs";

test("canonical JSON has stable key ordering and Unicode bytes", () => {
  assert.equal(canonicalizeRunSteward({ z: "café", a: [true, null, 3] }), '{"a":[true,null,3],"z":"café"}');
  assert.match(runstewardDigest({ a: 1 }), /^sha256:[0-9a-f]{64}$/);
});

test("canonical JSON rejects every case in the shared strict v1 rejection corpus", async () => {
  const corpus = await readJsonStrict(resolveContractPath("contracts/fixtures/hash-vectors/runsteward-canonical-json-v1-rejected.json"));
  assert.equal(corpus.algorithm, "runsteward-canonical-json-sha256-v1");
  assert.equal(corpus.cases.length, 6);
  for (const vector of corpus.cases) {
    assert.throws(() => canonicalizeRunSteward(JSON.parse(vector.raw_json)), undefined, vector.id);
  }
});
