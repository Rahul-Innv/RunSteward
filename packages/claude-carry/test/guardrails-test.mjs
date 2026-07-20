import { DEFAULT_ALLOW, guardrailArgs } from '../lib/guardrails.mjs';

const unsafeDefaults = [
  'node *',
  'npm run *',
  'npm test *',
  'npm test',
  'npm ci',
  'git add *',
  'git commit *',
  'git stash *',
  'git checkout *',
  'git restore *',
  'git branch *',
].flatMap((rule) => [`Bash(${rule})`, `PowerShell(${rule})`]);

const leaked = unsafeDefaults.filter((rule) => DEFAULT_ALLOW.includes(rule));
if (leaked.length) {
  console.error(`FAIL unsafe unattended defaults remain: ${leaked.join(', ')}`);
  process.exit(1);
}

const approved = 'Bash(node test/safe-check.mjs)';
const args = guardrailArgs({}, [approved]);
if (!args.includes(approved)) {
  console.error('FAIL an explicitly approved command was not forwarded');
  process.exit(1);
}

console.log('guardrail defaults park general Node/npm and mutating Git execution for approval');
