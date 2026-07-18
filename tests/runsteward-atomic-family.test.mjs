import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  listAtomicSkills,
  listLegacyCommandRoutes,
  packagePluginCliMembership,
  resolveLegacyCommand,
} from "../packages/runsteward-cli/src/dispatch.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (relative) => JSON.parse(readFileSync(path.join(ROOT, relative), "utf8"));
const sha256 = (relative) => createHash("sha256").update(readFileSync(path.join(ROOT, relative))).digest("hex");
const manifest = readJson("skills/runsteward-atomic-family.json");
const bindings = readJson("skills/runsteward-source-bindings.json");
const evals = readJson("evals/runsteward/atomic-family-routing.json");
const plugin = readJson(".codex-plugin/plugin.json");

const EXPECTED_PUBLIC = [
  "runsteward-queue-task", "runsteward-reorder-queue", "runsteward-set-dispatch-state", "runsteward-cancel-run",
  "runsteward-adopt-session", "runsteward-supervise-run", "runsteward-inspect-runs", "runsteward-approve-action",
  "runsteward-sense-claude-limits", "runsteward-sense-codex-usage", "runsteward-checkpoint-run", "runsteward-wrap-run",
  "runsteward-stop-run", "runsteward-resume-run", "runsteward-report-run", "runsteward-check-readiness",
];
const EXPECTED_INTERNAL = [
  "runsteward-core-canonical-json", "runsteward-core-contract-validation", "runsteward-core-adapter-manifest",
  "runsteward-core-event-fold", "runsteward-core-atomic-write", "runsteward-core-path-identity",
  "runsteward-core-allocation-reservation", "runsteward-core-lease-release", "runsteward-core-successor-lease",
  "runsteward-core-scheduler-cas", "runsteward-core-child-dependency-evaluation", "runsteward-adapter-wake-scheduling",
  "runsteward-adapter-editor-installation", "runsteward-adapter-decision-demo", "runsteward-adapter-claude-hook",
  "runsteward-adapter-claude-limit-policy",
];
const EXPECTED_PACKAGES = [
  "@runsteward/core", "@runsteward/cli", "@runsteward/adapter-claude-code", "@runsteward/adapter-codex",
  "@runsteward/sensor-claude-limits", "@runsteward/sensor-codex-usage",
];
const EXPECTED_EXCLUSIONS = new Set([
  "runsteward.legacy-hard-queue-deletion", "runsteward.destructive-cleanup", "runsteward.automatic-git-add-or-commit",
  "runsteward.landing-merge-or-branch-deletion", "runsteward.live-editor-installation-or-configuration",
  "runsteward.live-wake-scheduler-mutation", "runsteward.provider-auth-network-or-execution",
  "runsteward.imported-package-mutation", "runsteward.remote-publication-or-public-exposure",
]);

function changedPathsFromPorcelainV1Z(text) {
  return text.split("\0").filter(Boolean).map((record) => {
    assert.match(record, /^[ MARC?][ MADRC?] /, `invalid porcelain record: ${record}`);
    return record.slice(3);
  });
}

function frontmatter(relative) {
  const text = readFileSync(path.join(ROOT, relative), "utf8");
  const match = text.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(match, `missing frontmatter: ${relative}`);
  const result = {};
  for (const line of match[1].split("\n")) {
    const index = line.indexOf(":");
    assert.ok(index > 0, `invalid frontmatter line: ${line}`);
    const key = line.slice(0, index).trim();
    const raw = line.slice(index + 1).trim();
    result[key] = raw.startsWith('"') ? JSON.parse(raw) : raw;
  }
  return { fields: result, text };
}

test("candidate preserves the external lifecycle authority and ChoiceGate authority with exact public and internal identities", () => {
  assert.equal(manifest.candidate_status, "inactive-precritic-candidate");
  assert.equal(manifest.lifecycle_authority, "external-lifecycle-authority");
  assert.equal(manifest.selection_authority, "ChoiceGate");
  assert.deepEqual(manifest.public_skills.map((entry) => entry.id), EXPECTED_PUBLIC);
  assert.deepEqual(manifest.internal_capabilities.map((entry) => entry.id), EXPECTED_INTERNAL);
  assert.ok(manifest.internal_capabilities.every((entry) => entry.public_skill === false));
  for (const identifier of EXPECTED_INTERNAL) assert.equal(statSync(path.join(ROOT, "skills")).isDirectory() && readdirSync(path.join(ROOT, "skills")).includes(identifier), false);
});

test("all sixteen atomic leaves are discoverable through the inactive runsteward plugin", () => {
  assert.equal(plugin.name, "runsteward");
  assert.equal(plugin.skills, "./skills/");
  const dirs = readdirSync(path.join(ROOT, "skills"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("runsteward-"))
    .map((entry) => entry.name).sort();
  assert.deepEqual(dirs, [...EXPECTED_PUBLIC].sort());
  for (const identifier of EXPECTED_PUBLIC) {
    const skill = frontmatter(`skills/${identifier}/SKILL.md`);
    assert.deepEqual(Object.keys(skill.fields).sort(), ["description", "name"]);
    assert.equal(skill.fields.name, identifier);
    assert.match(skill.fields.description, /^.+ Use /);
    assert.match(skill.fields.description.toLowerCase(), /do not|never/);
    assert.match(skill.text, /## Outcome/);
    assert.match(skill.text, /## Trigger/);
    assert.match(skill.text, /## Non-goals/);
    assert.doesNotMatch(skill.text, /APPROVE_[A-Z0-9_]+/);
    const metadata = readFileSync(path.join(ROOT, `skills/${identifier}/agents/openai.yaml`), "utf8");
    assert.match(metadata, new RegExp(`\\$${identifier}\\b`));
    assert.match(metadata, /allow_implicit_invocation: false/);
    const short = metadata.match(/^  short_description: "([^"]+)"$/m);
    assert.ok(short);
    assert.ok(short[1].length >= 25 && short[1].length <= 64, `${identifier}: ${short[1].length}`);
  }
});

test("package plugin and CLI membership is exact and connected to the existing package validator", () => {
  assert.deepEqual(manifest.identity_surfaces.packages, EXPECTED_PACKAGES);
  const membership = packagePluginCliMembership();
  assert.deepEqual(membership.packages, EXPECTED_PACKAGES);
  assert.equal(membership.plugin.id, "runsteward");
  assert.equal(membership.cli.id, "runsteward");
  assert.equal(membership.execution_authorized, false);
  const packageJson = readJson("packages/runsteward-cli/package.json");
  assert.equal(packageJson.name, "@runsteward/cli");
  assert.equal(packageJson.bin.runsteward, "./bin/runsteward.mjs");
  const fixture = readJson("tests/contract-compat/adapter_fixture_manifest.json");
  assert.deepEqual(fixture.runsteward_owned_packages.map((entry) => entry.package_id), EXPECTED_PACKAGES);
});

test("all source references and RunSteward-owned thin implementation bindings match checksummed bytes", () => {
  assert.equal(bindings.authority.accepted_runsteward_r2_receipt_sha256, "f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0");
  assert.equal(bindings.authority.accepted_runsteward_r2_postcheck_sha256, "f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1");
  assert.equal(bindings.authority.source_owner_assignment_count, 66);
  assert.equal(bindings.authority.command_count, 45);
  assert.equal(bindings.authority.command_owner_tuple_sha256, manifest.command_map_authority.tuple_sha256);
  assert.equal(bindings.source_refs.length, 24);
  assert.equal(new Set(bindings.source_refs.map((entry) => entry.id)).size, 24);
  for (const entry of bindings.source_refs.filter((item) => item.verify_local)) {
    assert.equal(sha256(entry.path), entry.sha256, entry.path);
  }
  for (const entry of bindings.runsteward_owned_implementation_bindings) {
    assert.equal(sha256(entry.path), entry.sha256, entry.path);
  }
  const knownRefs = new Set(bindings.source_refs.map((entry) => entry.id));
  for (const entry of [...manifest.public_skills, ...manifest.internal_capabilities]) {
    for (const sourceRef of entry.source_refs) assert.ok(knownRefs.has(sourceRef), `${entry.id}: ${sourceRef}`);
  }
});

test("all six deliberate source splits and nine closed exclusions remain exact", () => {
  assert.equal(manifest.multi_owner_source_splits.length, 6);
  assert.equal(new Set(manifest.multi_owner_source_splits.map((entry) => entry.path)).size, 6);
  assert.equal(manifest.closed_exclusions.length, 9);
  assert.deepEqual(new Set(manifest.closed_exclusions.map((entry) => entry.id)), EXPECTED_EXCLUSIONS);
  assert.ok(manifest.closed_exclusions.every((entry) => entry.state.startsWith("CLOSED")));
});

test("legacy package plugin CLI and skill identities are explicit-only and non-coeligible", () => {
  assert.deepEqual(manifest.legacy_package_migrations.map((entry) => entry.legacy_id), ["claude-carry", "codex-nightwatch", "limit-aware-wrapup"]);
  assert.deepEqual(manifest.legacy_plugin_aliases.map((entry) => entry.legacy_id), ["codex-nightwatch"]);
  assert.deepEqual(manifest.legacy_cli_aliases.map((entry) => entry.legacy_id), ["carry", "nq", "limit-wrapup-status", "limit-wrapup-validate-config"]);
  assert.deepEqual(manifest.legacy_skill_aliases.map((entry) => entry.legacy_id), ["carry-queue", "continue-after-reset", "wrapping-up", "landing-carry-work", "codex-nightwatch", "[limit-wrapup] WRAPUP"]);
  for (const entry of [...manifest.legacy_plugin_aliases, ...manifest.legacy_cli_aliases, ...manifest.legacy_skill_aliases]) {
    assert.equal(entry.natural_language_eligible, false);
  }
  for (const entry of evals.legacy_skill_alias_cases) {
    assert.equal(entry.requires_explicit_invocation, true);
    assert.equal(entry.natural_language_eligible, false);
    assert.equal(entry.coeligible_with_successor, false);
  }
  assert.throws(() => resolveLegacyCommand("carry.add"), /explicit-only/);
});

test("all forty-five runtime command tuples match the accepted R2 authority aggregate", () => {
  assert.equal(manifest.command_map_authority.count, 45);
  assert.equal(manifest.command_map_authority.tuple_sha256, "1ee379ac1718065364b4ffe25fa015b70e61670f8de993a1e2df844da3bd7b25");
  assert.equal(bindings.authority.command_owner_tuple_sha256, manifest.command_map_authority.tuple_sha256);
  const rows = listLegacyCommandRoutes();
  assert.equal(rows.length, manifest.command_map_authority.count);
  assert.equal(new Set(rows.map((entry) => entry.source_command_key)).size, rows.length);
  const tupleBytes = rows.map((entry) => [entry.source_command_key, entry.disposition, entry.owner].join("\t")).join("\n");
  assert.equal(createHash("sha256").update(tupleBytes).digest("hex"), manifest.command_map_authority.tuple_sha256);
  assert.deepEqual(rows.filter((entry) => entry.owner === "runsteward-sense-claude-limits"), [
    { source_command_key: "limit.burnrate", disposition: "internal-component", owner: "runsteward-sense-claude-limits", explicit_only: true },
    { source_command_key: "limit.refresh-oauth", disposition: "internal-component", owner: "runsteward-sense-claude-limits", explicit_only: true },
    { source_command_key: "limit.statusline", disposition: "internal-component", owner: "runsteward-sense-claude-limits", explicit_only: true },
  ]);
});

test("wrap sensors adopt resume cancel and stop policies remain disjoint", () => {
  assert.deepEqual(manifest.wrap_policy.delegates, ["runsteward-checkpoint-run", "runsteward-report-run", "runsteward-stop-run"]);
  assert.equal(manifest.wrap_policy.duplicates_procedures, false);
  assert.deepEqual(manifest.sensor_policy.owners, ["runsteward-sense-claude-limits", "runsteward-sense-codex-usage"]);
  assert.ok(manifest.sensor_policy.forbidden.includes("checkpoint decision"));
  const byId = new Map(manifest.public_skills.map((entry) => [entry.id, entry]));
  assert.equal(byId.get("runsteward-adopt-session").trigger_key, "adopt-current-non-runsteward-session");
  assert.equal(byId.get("runsteward-resume-run").trigger_key, "verified-checkpoint-resume");
  assert.equal(byId.get("runsteward-cancel-run").trigger_key, "terminal-cancel-retain-evidence");
  assert.equal(byId.get("runsteward-stop-run").trigger_key, "resumable-attempt-stop");
});

test("routing evals cover every leaf twice plus near misses collisions aliases failures and runtime parity", () => {
  assert.equal(evals.positive_cases.length, 32);
  for (const identifier of EXPECTED_PUBLIC) assert.equal(evals.positive_cases.filter((entry) => entry.expected_skill === identifier).length, 2);
  assert.equal(evals.near_miss_cases.length, 18);
  assert.equal(evals.collision_cases.length, 16);
  for (const entry of evals.collision_cases) {
    assert.notEqual(entry.expected_skill, entry.competing_skill);
    assert.ok(entry.prompt.toLowerCase().includes(entry.decisive_signal.toLowerCase()), entry.id);
  }
  assert.deepEqual(new Set(evals.fail_closed_cases.map((entry) => entry.expected_exclusion)), EXPECTED_EXCLUSIONS);
  assert.ok(evals.fail_closed_cases.every((entry) => entry.expected_skill === null));
  assert.deepEqual(new Set(evals.runtime_parity_cases.map((entry) => entry.area)), new Set(["concurrency", "failure", "checkpoint-resume", "budget-metric", "raw-evidence"]));
});

test("CLI remains route-only and rejects action-like or ambiguous invocations", () => {
  const cli = path.join(ROOT, "packages/runsteward-cli/bin/runsteward.mjs");
  const list = spawnSync(process.execPath, [cli, "list-skills"], { encoding: "utf8" });
  assert.equal(list.status, 0, list.stderr);
  assert.deepEqual(JSON.parse(list.stdout), EXPECTED_PUBLIC);
  const route = spawnSync(process.execPath, [cli, "route", "runsteward-resume-run"], { encoding: "utf8" });
  assert.equal(route.status, 0, route.stderr);
  assert.equal(JSON.parse(route.stdout).execution_authorized, false);
  const rejected = spawnSync(process.execPath, [cli, "resume-run", "rw-run-1"], { encoding: "utf8" });
  assert.equal(rejected.status, 2);
  assert.match(rejected.stderr, /usage/);
});

test("NUL-delimited porcelain parsing preserves a leading-space worktree status column", () => {
  const fixture = readJson("tests/fixtures/git-status-porcelain-v1-z.json");
  const bytes = `${fixture.records.join("\0")}\0`;
  assert.deepEqual(changedPathsFromPorcelainV1Z(bytes), fixture.expected_paths);
});

