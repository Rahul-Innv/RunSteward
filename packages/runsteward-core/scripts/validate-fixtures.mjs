import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertAdapterFixtureManifest } from "../src/adapter-manifest.mjs";
import { assertRunStewardDigest } from "../src/canonical-json.mjs";
import { loadFixtureManifest, readJsonStrict, REPOSITORY_ROOT, resolveContractPath } from "../src/contract-loader.mjs";
import { foldStateEvents } from "../src/event-fold.mjs";

const DIGEST_FIELDS = new Map([
  ["runsteward.run/v1", "run_digest"], ["runsteward.state-event/v1", "event_digest"],
  ["runsteward.checkpoint/v1", "checkpoint_digest"], ["runsteward.handoff/v1", "handoff_digest"],
  ["runsteward.report/v1", "report_digest"], ["runsteward.capability-plan/v1", "plan_digest"],
  ["runsteward.worktree-lease/v1", "lease_digest"], ["runsteward.choicegate-qualification/v1", "qualification_digest"],
  ["runsteward.provider-evidence/v1", "evidence_digest"], ["runsteward.wrap-plan/v1", "plan_digest"]
]);

async function jsonFiles(root) {
  const result = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...await jsonFiles(target));
    else if (entry.name.endsWith(".json")) result.push(target);
  }
  return result.sort();
}

function relative(filePath) {
  return path.relative(REPOSITORY_ROOT, filePath).split(path.sep).join("/");
}

const manifest = await loadFixtureManifest();
const adapterManifest = await readJsonStrict(resolveContractPath("tests/contract-compat/adapter_fixture_manifest.json"));
assertAdapterFixtureManifest(adapterManifest);
const actualPackageNames = (await readdir(resolveContractPath("packages"), { withFileTypes: true })).filter((item) => item.isDirectory()).map((item) => item.name).sort();
const registeredPackageNames = [...adapterManifest.imported_packages, ...adapterManifest.runsteward_owned_packages].map((item) => path.posix.basename(item.path)).sort();
if (JSON.stringify(actualPackageNames) !== JSON.stringify(registeredPackageNames)) throw new Error("adapter fixture manifest package inventory is incomplete or stale");
for (const [label, entries] of [["valid", manifest.valid], ["invalid", manifest.invalid]]) {
  const paths = entries.map((item) => item.path);
  if (new Set(paths).size !== paths.length) throw new Error(`duplicate ${label} fixture manifest path`);
}
const validPaths = new Set(manifest.valid.map((item) => item.path));
const overlap = manifest.invalid.map((item) => item.path).filter((item) => validPaths.has(item));
if (overlap.length) throw new Error(`fixture paths cannot be both valid and invalid: ${overlap.join(", ")}`);
const schemaDir = resolveContractPath("contracts/runsteward/v1");
const actualSchemas = (await jsonFiles(schemaDir)).map(relative);
if (JSON.stringify(actualSchemas) !== JSON.stringify([...manifest.schemas].sort())) throw new Error("fixture manifest schema inventory is incomplete or stale");

const registered = new Set([
  ...manifest.valid.map((item) => item.path), ...manifest.invalid.map((item) => item.path),
  ...manifest.auxiliary, ...manifest.event_chains.flatMap((chain) => [...(chain.event_paths ?? []), ...(chain.chain_path ? [chain.chain_path] : []), chain.run_path])
]);
const fixtureRoot = resolveContractPath("contracts/fixtures");
const actualFixtures = (await jsonFiles(fixtureRoot)).map(relative).filter((item) => item !== "contracts/fixtures/manifest.json");
const orphans = actualFixtures.filter((item) => !registered.has(item));
if (orphans.length) throw new Error(`orphan fixture files: ${orphans.join(", ")}`);
for (const item of registered) await readJsonStrict(resolveContractPath(item));

for (const fixture of manifest.valid) {
  const value = await readJsonStrict(resolveContractPath(fixture.path));
  const digestField = DIGEST_FIELDS.get(value.schema_version);
  if (digestField) assertRunStewardDigest(value, digestField);
}

for (const chain of manifest.event_chains) {
  const events = chain.chain_path
    ? (await readJsonStrict(resolveContractPath(chain.chain_path))).events
    : await Promise.all(chain.event_paths.map((item) => readJsonStrict(resolveContractPath(item))));
  const expectedRun = await readJsonStrict(resolveContractPath(chain.run_path));
  const actualRun = foldStateEvents(events);
  if (JSON.stringify(actualRun) !== JSON.stringify(expectedRun)) throw new Error(`event chain projection drift: ${chain.chain_id}`);
}

const vendorRoot = resolveContractPath("contracts/vendor");
const actualVendor = (await jsonFiles(vendorRoot)).map(relative);
const registeredVendor = manifest.vendor_schemas.map((item) => item.path).sort();
if (JSON.stringify(actualVendor) !== JSON.stringify(registeredVendor)) throw new Error("vendor schema inventory is incomplete or stale");
for (const vendor of manifest.vendor_schemas) {
  const bytes = await readFile(resolveContractPath(vendor.path));
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const digest = createHash("sha256").update(normalized, "utf8").digest("hex");
  if (digest !== vendor.normalized_utf8_lf_sha256) throw new Error(`vendor schema digest drift: ${vendor.path}`);
}

console.log(`RUNSTEWARD_JS_MANIFEST_REGISTERED_VALID=${manifest.valid.length}`);
console.log(`RUNSTEWARD_JS_MANIFEST_REGISTERED_INVALID=${manifest.invalid.length}`);
console.log(`RUNSTEWARD_JS_EVENT_CHAINS=${manifest.event_chains.length}`);
