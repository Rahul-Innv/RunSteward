import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  RUNSTEWARD_CLI_ID,
  RUNSTEWARD_CLI_MODE,
  listAtomicSkills,
  listLegacyCommandRoutes,
  packagePluginCliMembership,
  resolveAtomicSkill,
  resolveLegacyCommand,
} from "../src/dispatch.mjs";

const EXPECTED_SKILLS = [
  "runsteward-queue-task",
  "runsteward-reorder-queue",
  "runsteward-set-dispatch-state",
  "runsteward-cancel-run",
  "runsteward-adopt-session",
  "runsteward-supervise-run",
  "runsteward-inspect-runs",
  "runsteward-approve-action",
  "runsteward-sense-claude-limits",
  "runsteward-sense-codex-usage",
  "runsteward-checkpoint-run",
  "runsteward-wrap-run",
  "runsteward-stop-run",
  "runsteward-resume-run",
  "runsteward-report-run",
  "runsteward-check-readiness",
];
const EXPECTED_COMMAND_AUTHORITY_TUPLE_SHA256 = "1ee379ac1718065364b4ffe25fa015b70e61670f8de993a1e2df844da3bd7b25";

test("RunSteward CLI exposes exactly the sixteen inactive atomic routes", () => {
  assert.equal(RUNSTEWARD_CLI_ID, "runsteward");
  assert.equal(RUNSTEWARD_CLI_MODE, "candidate-inactive-route-only-no-live-execution");
  assert.deepEqual(listAtomicSkills(), EXPECTED_SKILLS);
  for (const skillId of EXPECTED_SKILLS) {
    const receipt = resolveAtomicSkill(skillId);
    assert.equal(receipt.selected_skill, skillId);
    assert.equal(receipt.execution_authorized, false);
  }
  assert.throws(() => resolveAtomicSkill("codex-nightwatch"), /exact canonical/);
  assert.throws(() => resolveAtomicSkill("runsteward"), /exact canonical/);
});

test("legacy command routing preserves all forty-five accepted authority tuples", () => {
  assert.throws(() => resolveLegacyCommand("carry.add"), /explicit-only/);
  assert.deepEqual(resolveLegacyCommand("carry.add", { explicit: true }), {
    source_command_key: "carry.add",
    disposition: "canonical-skill",
    owner: "runsteward-queue-task",
    explicit_only: true,
  });
  assert.equal(resolveLegacyCommand("carry.install-vscode", { explicit: true }).disposition, "internal-component-closed-live-action");
  assert.equal(resolveLegacyCommand("carry.cleanup", { explicit: true }).disposition, "closed-exclusion");
  for (const sourceCommandKey of ["limit.burnrate", "limit.refresh-oauth", "limit.statusline"]) {
    assert.deepEqual(resolveLegacyCommand(sourceCommandKey, { explicit: true }), {
      source_command_key: sourceCommandKey,
      disposition: "internal-component",
      owner: "runsteward-sense-claude-limits",
      explicit_only: true,
    });
  }
  assert.throws(() => resolveLegacyCommand("carry.delete", { explicit: true }), /unknown legacy/);
  const rows = listLegacyCommandRoutes();
  assert.equal(rows.length, 45);
  assert.equal(new Set(rows.map((entry) => entry.source_command_key)).size, 45);
  const tupleBytes = rows.map((entry) => [entry.source_command_key, entry.disposition, entry.owner].join("\t")).join("\n");
  assert.equal(createHash("sha256").update(tupleBytes).digest("hex"), EXPECTED_COMMAND_AUTHORITY_TUPLE_SHA256);
  assert.equal(packagePluginCliMembership().command_route_count, rows.length);
});

test("package plugin and CLI membership is exact and remains non-executing", () => {
  const membership = packagePluginCliMembership();
  assert.equal(membership.plugin.id, "runsteward");
  assert.equal(membership.plugin.skills_path, "./skills/");
  assert.equal(membership.cli.id, "runsteward");
  assert.equal(membership.cli.package, "@runsteward/cli");
  assert.deepEqual(membership.packages, [
    "@runsteward/core",
    "@runsteward/cli",
    "@runsteward/adapter-claude-code",
    "@runsteward/adapter-codex",
    "@runsteward/sensor-claude-limits",
    "@runsteward/sensor-codex-usage",
  ]);
  assert.equal(membership.public_skill_count, 16);
  assert.equal(membership.execution_authorized, false);
});
