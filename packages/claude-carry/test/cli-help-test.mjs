import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CARRY = join(ROOT, 'bin', 'carry.mjs');
const forms = [[], ['help'], ['--help'], ['-h']];

for (const args of forms) {
  const result = spawnSync(process.execPath, [CARRY, ...args], { encoding: 'utf8' });
  const label = args[0] ?? '(no arguments)';
  if (result.status !== 0 || !result.stdout.includes('Claude Carry CLI') || /Unknown command/.test(result.stderr)) {
    console.error(`FAIL help form ${label}: status=${result.status}\n${result.stderr}`);
    process.exit(1);
  }
}

console.log('cli help aliases passed: --help, -h, help, no arguments');
