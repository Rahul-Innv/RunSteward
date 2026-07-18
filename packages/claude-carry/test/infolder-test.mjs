// In-folder branch mode verification against real temp git repos + the
// fake-claude stub (zero API usage). The runner owns the branch lifecycle here
// (no --worktree), so the work lands as a normal carry/<id> branch in the
// project's own checkout — visible in Source Control, session under the project.
//
//   T1 clean happy path  — no --worktree; branch created; work checkpointed on
//                          it; checkout returned to base; base has none of it
//   T2 worktree opt-in   — --worktree still isolates; no carry/* branch
//   T3 dirty tree        — uncommitted work carried into a baseline commit on
//                          the branch; base stays clean
//   T4 sequential        — two tasks in one repo each branch off base cleanly
//   T5 resume            — after a crash, resume re-checks-out the task's branch
//   T6 non-git cwd       — plain run, no branch lifecycle
//
// Usage: node test/infolder-test.mjs

import { spawn, spawnSync } from 'node:child_process';
import { rmSync, readFileSync, existsSync, mkdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NQ = join(ROOT, 'bin', 'carry.mjs');
const FAKE = join(ROOT, 'test', 'fake-claude.mjs');
const HOME = join(tmpdir(), 'carry-infolder-test');

const baseEnv = { ...process.env, CARRY_HOME: HOME, CARRY_CLAUDE: FAKE };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function assert(name, cond, detail = '') {
  console.log(`${cond ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
}

function carry(args, env = {}) {
  return spawnSync(process.execPath, [NQ, ...args], { encoding: 'utf8', env: { ...baseEnv, ...env } });
}
const queue = () => JSON.parse(readFileSync(join(HOME, 'queue.json'), 'utf8'));
const fakeCalls = () =>
  readFileSync(join(HOME, 'fake-calls.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const taskByPrompt = (prefix) => queue().tasks.find((t) => t.prompt.startsWith(prefix));

// git helpers over a repo dir
const g = (dir, ...args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
const gout = (dir, ...args) => (g(dir, ...args).stdout || '').trim();
const branchHere = (dir) => gout(dir, 'branch', '--show-current');
const clean = (dir) => gout(dir, 'status', '--porcelain') === '';
const branchExists = (dir, name) => g(dir, 'rev-parse', '--verify', '--quiet', `refs/heads/${name}`).status === 0;
const fileOnBranch = (dir, branch, file) => g(dir, 'cat-file', '-e', `${branch}:${file}`).status === 0;
const logSubjects = (dir, ref) => gout(dir, 'log', ref, '--format=%s');

const repos = [];
function makeRepo(label) {
  const dir = mkdtempSync(join(tmpdir(), `carry-infolder-${label}-`));
  g(dir, 'init', '-b', 'main');
  g(dir, 'config', 'user.email', 'test@local');
  g(dir, 'config', 'user.name', 'Test');
  writeFileSync(join(dir, 'README.md'), 'seed\n');
  g(dir, 'add', '-A');
  g(dir, 'commit', '-m', 'initial');
  repos.push(dir);
  return dir;
}

// ---- setup ----
rmSync(HOME, { recursive: true, force: true });
mkdirSync(HOME, { recursive: true });

// ---- T1: clean happy path ----
const r1 = makeRepo('t1');
carry(['add', 'T1 clean task', '--cwd', r1]);
carry(['run', '--once'], { FAKE_BEHAVIOR: 'ok', FAKE_TOUCH: 'feature.txt' });
let t1 = taskByPrompt('T1');
const c1 = fakeCalls().at(-1).argv;
assert('T1: ran without --worktree', !c1.includes('--worktree'), c1.join(' '));
assert('T1: task done', t1.status === 'done', t1.status);
assert('T1: branch carry/t1 created', branchExists(r1, 'carry/t1'));
assert('T1: task.branch + base_branch recorded', t1.branch === 'carry/t1' && t1.base_branch === 'main', `${t1.branch} / ${t1.base_branch}`);
assert('T1: checkpoint_commit recorded', /^[0-9a-f]{40}$/.test(t1.checkpoint_commit || ''), t1.checkpoint_commit);
assert('T1: no baseline (tree was clean)', t1.baseline_commit === null);
assert('T1: work committed on the branch', fileOnBranch(r1, 'carry/t1', 'feature.txt'));
assert('T1: returned to base (main), clean', branchHere(r1) === 'main' && clean(r1), `${branchHere(r1)} dirty=${!clean(r1)}`);
assert('T1: base branch has NONE of the work', !fileOnBranch(r1, 'main', 'feature.txt') && !existsSync(join(r1, 'feature.txt')));

// ---- T2: --worktree opt-in is unaffected (no runner git) ----
const r2 = makeRepo('t2');
carry(['add', 'T2 worktree task', '--cwd', r2, '--worktree']);
carry(['run', '--once'], { FAKE_BEHAVIOR: 'ok' });
let t2 = taskByPrompt('T2');
const c2 = fakeCalls().at(-1).argv;
assert('T2: ran WITH --worktree', c2.includes('--worktree') && c2.includes(`task-${t2.id}`), c2.join(' '));
assert('T2: task.worktree set, no in-folder branch', t2.worktree === `task-${t2.id}` && t2.branch === null);
assert('T2: no carry/* branch created', !branchExists(r2, `carry/${t2.id}`));

// ---- T3: dirty tree -> baseline commit on the branch, base stays clean ----
const r3 = makeRepo('t3');
writeFileSync(join(r3, 'wip.txt'), 'my unsaved work\n'); // uncommitted before the run
carry(['add', 'T3 dirty task', '--cwd', r3]);
carry(['run', '--once'], { FAKE_BEHAVIOR: 'ok', FAKE_TOUCH: 'feature.txt' });
let t3 = taskByPrompt('T3');
assert('T3: task done', t3.status === 'done', t3.status);
assert('T3: baseline_commit recorded', /^[0-9a-f]{40}$/.test(t3.baseline_commit || ''), t3.baseline_commit);
assert('T3: WIP carried onto the branch', fileOnBranch(r3, `carry/${t3.id}`, 'wip.txt'));
assert('T3: night work also on the branch', fileOnBranch(r3, `carry/${t3.id}`, 'feature.txt'));
assert('T3: base (main) never got the WIP', !fileOnBranch(r3, 'main', 'wip.txt'));
assert('T3: returned to base, clean (WIP not left loose)', branchHere(r3) === 'main' && clean(r3) && !existsSync(join(r3, 'wip.txt')));

// ---- T4: two tasks, same repo, each branches off base cleanly ----
const r4 = makeRepo('t4');
carry(['add', 'T4a first', '--cwd', r4]);
carry(['add', 'T4b second', '--cwd', r4]);
carry(['run', '--once'], { FAKE_BEHAVIOR: 'ok', FAKE_TOUCH: 'feature.txt' }); // does T4a
carry(['run', '--once'], { FAKE_BEHAVIOR: 'ok', FAKE_TOUCH: 'feature.txt' }); // does T4b
const t4a = taskByPrompt('T4a'), t4b = taskByPrompt('T4b');
assert('T4: both done', t4a.status === 'done' && t4b.status === 'done');
assert('T4: distinct branches created', branchExists(r4, t4a.branch) && branchExists(r4, t4b.branch) && t4a.branch !== t4b.branch, `${t4a.branch}, ${t4b.branch}`);
const subjB = logSubjects(r4, t4b.branch);
assert('T4: second branch carries its own work, not the first\'s', /T4b/.test(subjB) && !/T4a/.test(subjB), subjB.replace(/\n/g, ' | '));
assert('T4: ended on base, clean', branchHere(r4) === 'main' && clean(r4));

// ---- T5: resume re-checks-out the task's branch after a crash ----
const r5 = makeRepo('t5');
carry(['add', 'T5 resumable', '--cwd', r5]);
// first run: slow stub, NO touch (so the tree stays clean on the branch); kill mid-run
const runner = spawn(process.execPath, [NQ, 'run', '--once'], {
  env: { ...baseEnv, FAKE_BEHAVIOR: 'slow', FAKE_SLOW_MS: '30000' },
  stdio: 'ignore',
});
let t5 = null;
for (let i = 0; i < 100; i++) {
  await sleep(100);
  t5 = taskByPrompt('T5');
  if (t5?.status === 'running' && t5.session_id) break;
}
assert('T5: running + session + on its branch before crash', t5?.status === 'running' && !!t5.session_id && branchHere(r5) === t5.branch, `${branchHere(r5)} sess=${t5?.session_id}`);
const originalSession = t5.session_id;
const childPid = t5.lock?.pid;
runner.kill();
await sleep(200);
if (childPid) { try { process.kill(childPid); } catch {} }
await sleep(300);
// move HEAD away (simulate another branch being checked out meanwhile)
g(r5, 'checkout', 'main');
assert('T5: HEAD moved off the branch after crash', branchHere(r5) === 'main');
// restart: reconcile -> resume; resume must re-checkout the branch, then the
// stub writes resumed.txt which should land committed on the task's branch
carry(['run', '--once'], { FAKE_BEHAVIOR: 'ok', FAKE_TOUCH: 'resumed.txt' });
t5 = taskByPrompt('T5');
const lastCall = fakeCalls().at(-1).argv;
assert('T5: completed after restart', t5.status === 'done', t5.status);
assert('T5: resumed the SAME session', lastCall.includes('--resume') && lastCall.includes(originalSession));
assert('T5: resume re-checked-out the branch (work landed there)', fileOnBranch(r5, t5.branch, 'resumed.txt'));
assert('T5: ended on base, clean', branchHere(r5) === 'main' && clean(r5));

// ---- T6: non-git cwd is a plain run, no branch lifecycle ----
const r6 = mkdtempSync(join(tmpdir(), 'carry-infolder-t6-')); // NOT a git repo
repos.push(r6);
carry(['add', 'T6 plain dir', '--cwd', r6]);
carry(['run', '--once'], { FAKE_BEHAVIOR: 'ok' });
const t6 = taskByPrompt('T6');
const c6 = fakeCalls().at(-1).argv;
assert('T6: done, no --worktree, no branch fields', t6.status === 'done' && !c6.includes('--worktree') && t6.branch === null && t6.base_branch === null, `${t6.status} branch=${t6.branch}`);

// ---- wrap up ----
rmSync(HOME, { recursive: true, force: true });
for (const d of repos) rmSync(d, { recursive: true, force: true });
if (failures === 0) console.log('\x1b[32m\nALL IN-FOLDER TESTS PASSED\x1b[0m');
else console.log(`\x1b[31m\n${failures} TEST(S) FAILED\x1b[0m`);
process.exit(failures === 0 ? 0 : 1);
