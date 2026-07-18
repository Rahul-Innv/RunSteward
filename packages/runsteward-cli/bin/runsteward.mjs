#!/usr/bin/env node
import {
  listAtomicSkills,
  packagePluginCliMembership,
  resolveAtomicSkill,
  resolveLegacyCommand,
} from "../src/dispatch.mjs";

const [command, value, ...rest] = process.argv.slice(2);

function emit(valueToEmit) {
  process.stdout.write(`${JSON.stringify(valueToEmit, null, 2)}\n`);
}

try {
  if (rest.length) throw new Error("unexpected arguments");
  if (command === "list-skills" && value === undefined) {
    emit(listAtomicSkills());
  } else if (command === "route" && value) {
    emit(resolveAtomicSkill(value));
  } else if (command === "legacy-route" && value) {
    emit(resolveLegacyCommand(value, { explicit: true }));
  } else if (command === "check-membership" && value === undefined) {
    emit(packagePluginCliMembership());
  } else {
    throw new Error("usage: runsteward <list-skills|route SKILL_ID|legacy-route SOURCE_KEY|check-membership>");
  }
} catch (error) {
  process.stderr.write(`runsteward: ${error.message}\n`);
  process.exitCode = 2;
}
