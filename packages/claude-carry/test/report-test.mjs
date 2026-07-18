// report + cleanup verification. Builds a mixed queue via the stub (done, failed,
// parked, waiting), asserts the morning report surfaces each correctly and that
// cleanup only touches finished tasks. Zero API usage.

import { spawnSync } from 'node:child_process';
import { rmSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { buildReport } from '../lib/report.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NQ = join(ROOT, 'bin', 'carry.mjs');
const FAKE = join(ROOT, 'test', 'fake-claude.mjs');
const HOME = join(tmpdir(), 'carry-report-test');
const baseEnv = { ...process.env, CARRY_HOME: HOME, CARRY_CLAUDE: FAKE };
// run tasks in a throwaway NON-git dir so they don't trigger in-folder git in
// this repo; report/cleanup behavior is identical (no worktree, no branch).
const CWD = join(tmpdir(), 'carry-report-test-cwd');

let failures = 0;
const assert = (name, cond, detail = '') => {
  console.log(`${cond ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
};
const carry = (args, env = {}) => spawnSync(process.execPath, [NQ, ...args], { encoding: 'utf8', env: { ...baseEnv, ...env } });

rmSync(HOME, { recursive: true, force: true });
rmSync(CWD, { recursive: true, force: true });
mkdirSync(HOME, { recursive: true });
mkdirSync(CWD, { recursive: true });

// build a mixed queue
carry(['add', 'alpha done task', '--cwd', CWD]);
carry(['run', '--once'], { FAKE_BEHAVIOR: 'ok' });
carry(['add', 'bravo fails', '--cwd', CWD]);
carry(['run', '--once'], { FAKE_BEHAVIOR: 'fail' });
carry(['add', 'charlie parks', '--cwd', CWD]);
carry(['run', '--once'], { FAKE_BEHAVIOR: 'denied' });

// ---- report ----
const out = carry(['report']).stdout;
assert('report: has a header', /Claude Carry report/.test(out));
assert('report: counts done+failed+needs-approval', /1 done/.test(out) && /1 failed/.test(out) && /1 need approval/.test(out), out.split('\n').find((l) => /need approval/.test(l)));
assert('report: surfaces the parked decision first', out.indexOf('Needs your decision') < out.indexOf('All tasks'));
assert('report: names the blocked command', /npm install lodash/.test(out));
assert('report: failed section explains why', /## Failed/.test(out) && /error_during_execution/.test(out));
assert('report: writes report.md', existsSync(join(HOME, 'report.md')));

// ---- cleanup only touches finished tasks ----
// (no real git worktrees here, so removeWorktree returns "no worktree"/"already gone";
// the key assertion is that it SELECTS done/failed and skips needs-approval)
const clean = carry(['cleanup']).stdout;
const q = JSON.parse(readFileSync(join(HOME, 'queue.json'), 'utf8'));
const parked = q.tasks.find((t) => t.prompt.startsWith('charlie'));
assert('cleanup: left the needs-approval task untouched', parked.status === 'needs-approval', parked.status);
assert('cleanup: reported on the done+failed tasks only', (clean.match(/^t\d/gm) || []).length === 2, clean.trim());

// ---- cleanup --all drops finished entries ----
carry(['cleanup', '--all']);
const q2 = JSON.parse(readFileSync(join(HOME, 'queue.json'), 'utf8'));
assert('cleanup --all: finished entries dropped', !q2.tasks.some((t) => t.status === 'done' || t.status === 'failed'));
assert('cleanup --all: parked task survives', q2.tasks.some((t) => t.status === 'needs-approval'));

// ---- in-folder surfacing (pure buildReport over a synthetic queue) ----
const synthetic = {
  version: 1, paused: false, nextId: 9,
  tasks: [
    { id: 't1', prompt: 'in-folder done', status: 'done', cost_usd: 0.01, model: 'sonnet', branch: 'carry/t1', base_branch: 'main', baseline_commit: null, checkpoint_commit: 'a'.repeat(40), worktree: null, parked_calls: [] },
    { id: 't2', prompt: 'carried wip', status: 'done', cost_usd: 0.01, model: 'sonnet', branch: 'carry/t2', base_branch: 'main', baseline_commit: 'b'.repeat(40), checkpoint_commit: 'c'.repeat(40), worktree: null, parked_calls: [] },
    { id: 't3', prompt: 'wt task', status: 'done', cost_usd: 0.01, model: 'opus', branch: null, worktree: 'task-t3', baseline_commit: null, parked_calls: [] },
  ],
};
const rep = buildReport(synthetic, '2026-06-15T08:00:00Z');
assert('report: in-folder task shows its carry branch', rep.includes('branch `carry/t1`'), rep);
assert('report: worktree task shows the worktree branch', rep.includes('worktree `worktree-task-t3`'));
assert('report: surfaces carried-WIP baseline', /## Carried your uncommitted work/.test(rep) && rep.includes('baseline `bbbbbbb`'));

rmSync(HOME, { recursive: true, force: true });
rmSync(CWD, { recursive: true, force: true });
console.log(failures === 0 ? '\x1b[32m\nALL REPORT TESTS PASSED\x1b[0m' : `\x1b[31m\n${failures} FAILED\x1b[0m`);
process.exit(failures === 0 ? 0 : 1);
