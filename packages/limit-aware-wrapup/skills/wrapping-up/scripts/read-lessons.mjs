#!/usr/bin/env node
// read-lessons.mjs — prints THIS skill's CURRENT lessons (the entries under "## Current method" in
// LESSONS.md) so they can be injected into the skill prompt at invocation time. Prints NOTHING when
// no lessons exist yet — the boilerplate header/schema stays out of context (open LESSONS.md
// directly when capturing a new entry). Wire it as the FIRST line of a SKILL.md body, with the cat
// fallback because the `!` dynamic-context shell (e.g. Windows git-bash) often has no node on PATH:
//
//     !`node "${CLAUDE_SKILL_DIR}/scripts/read-lessons.mjs" 2>/dev/null || cat "${CLAUDE_SKILL_DIR}/LESSONS.md" 2>/dev/null`
//
// (set `shell: bash` in the frontmatter; the cat path degrades to printing the whole file).
// Cross-platform (pure node), self-locating via import.meta.url, works from any working directory.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const scriptDir = dirname(fileURLToPath(import.meta.url)); // <skill>/scripts
const lessonsPath = join(scriptDir, '..', 'LESSONS.md');   // <skill>/LESSONS.md

try {
  const text = readFileSync(lessonsPath, 'utf8');
  const after = text.split(/^## Current method\s*$/m)[1] ?? '';
  const body = after.split(/^<details>|^## /m)[0].trim();
  if (body && !body.startsWith('_(none yet')) {
    process.stdout.write(
      'Lessons for this skill (apply these; they override the SKILL.md defaults on conflict):\n\n' +
        body +
        '\n'
    );
  }
} catch {
  // No LESSONS.md yet — print nothing; the skill runs on its defaults.
}
