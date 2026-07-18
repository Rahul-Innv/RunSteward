import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const manifestUrl = new URL("../../../skills/runsteward-atomic-family.json", import.meta.url);
const manifest = JSON.parse(readFileSync(manifestUrl, "utf8"));

export const RUNSTEWARD_CLI_ID = "runsteward";
export const RUNSTEWARD_CLI_MODE = "candidate-inactive-route-only-no-live-execution";

const publicSkills = new Map(manifest.public_skills.map((entry) => [entry.id, entry]));
const commandRoutes = new Map();

for (const entry of manifest.public_skills) {
  for (const sourceCommandKey of entry.command_keys) {
    const disposition = entry.command_dispositions?.[sourceCommandKey] ?? "canonical-skill";
    if (!new Set(["canonical-skill", "internal-component"]).has(disposition)) {
      throw new Error(`invalid public-owner command disposition: ${sourceCommandKey}`);
    }
    commandRoutes.set(sourceCommandKey, Object.freeze({
      source_command_key: sourceCommandKey,
      disposition,
      owner: entry.id,
      explicit_only: true,
    }));
  }
}
for (const entry of manifest.internal_capabilities) {
  for (const sourceCommandKey of entry.command_keys) {
    commandRoutes.set(sourceCommandKey, Object.freeze({
      source_command_key: sourceCommandKey,
      disposition: sourceCommandKey === "carry.install-vscode"
        ? "internal-component-closed-live-action"
        : "internal-component",
      owner: entry.id,
      explicit_only: true,
    }));
  }
}
commandRoutes.set("carry.cleanup", Object.freeze({
  source_command_key: "carry.cleanup",
  disposition: "closed-exclusion",
  owner: "future owner-gated RunSteward maintenance",
  explicit_only: true,
  reason: "destructive cleanup remains closed",
}));

if (commandRoutes.size !== manifest.command_map_authority.count) {
  throw new Error(`command map cardinality mismatch: ${commandRoutes.size}`);
}

export function listAtomicSkills() {
  return Object.freeze([...publicSkills.keys()]);
}

export function resolveAtomicSkill(skillId) {
  if (typeof skillId !== "string" || !publicSkills.has(skillId)) {
    throw new Error("an exact canonical runsteward-* skill id is required");
  }
  const entry = publicSkills.get(skillId);
  return Object.freeze({
    schema: "runsteward-cli-route-receipt/v1",
    cli_id: RUNSTEWARD_CLI_ID,
    mode: RUNSTEWARD_CLI_MODE,
    selected_skill: entry.id,
    trigger_key: entry.trigger_key,
    outcome: entry.outcome,
    execution_authorized: false,
  });
}

export function resolveLegacyCommand(sourceCommandKey, { explicit = false } = {}) {
  if (!explicit) throw new Error("legacy command routing is explicit-only");
  if (typeof sourceCommandKey !== "string" || !commandRoutes.has(sourceCommandKey)) {
    throw new Error("unknown legacy source command key");
  }
  return commandRoutes.get(sourceCommandKey);
}

export function listLegacyCommandRoutes() {
  return Object.freeze([...commandRoutes.values()].sort((left, right) =>
    left.source_command_key < right.source_command_key ? -1
      : left.source_command_key > right.source_command_key ? 1
        : 0));
}

export function packagePluginCliMembership() {
  return Object.freeze({
    plugin: manifest.identity_surfaces.plugin,
    cli: manifest.identity_surfaces.cli,
    packages: Object.freeze([...manifest.identity_surfaces.packages]),
    public_skill_count: publicSkills.size,
    command_route_count: commandRoutes.size,
    execution_authorized: false,
  });
}

export const __manifestPath = fileURLToPath(manifestUrl);
