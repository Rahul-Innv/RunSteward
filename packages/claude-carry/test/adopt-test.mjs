// adopt-test — verify an ADOPTED external session (one the user started
// themselves, then handed to Claude Carry via `carry adopt`) resumes IN PLACE:
//   - isolation:'none' is honored even though cwd IS a git repo, so NO
//     carry/<id> branch is created and the working tree is left untouched
//   - the run resumes the SAME session via --resume <session_id>
//   - the user's custom continue_instruction is passed as the prompt
//
// The task is injected through the store API exactly as the `carry adopt` CLI
// builds it (waiting + past resume_at + external session_id + isolation:'none'
// + continue_instruction) — minus scheduleWake(), which the CLI calls but which
// would register a real Windows Scheduled Task (not a unit-test side effect).
//
// Usage: node test/adopt-test.mjs

import { spawnSync } from 'node:child_process';
import { rmSync, mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NQ = join(ROOT, 'bin', 'carry.mjs');
const FAKE = join(ROOT, 'test', 'fake-claude.mjs');
const HOME = join(tmpdir(), 'carry-adopt-test');
const REPO = join(tmpdir(), 'carry-adopt-repo');

// store.mjs reads CARRY_HOME at import time — set it BEFORE importing.
process.env.CARRY_HOME = HOME;
const baseEnv = { ...process.env, CARRY_HOME: HOME, CARRY_CLAUDE: FAKE };

let failures = 0;
function assert(name, cond, detail = '') {
  console.log(`${cond ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
}
const carry = (args, env = {}) => spawnSync(process.execPath, [NQ, ...args], { encoding: 'utf8', env: { ...baseEnv, ...env } });
const git = (args) => spawnSync('git', args, { encoding: 'utf8', cwd: REPO });
const queue = () => JSON.parse(readFileSync(join(HOME, 'queue.json'), 'utf8'));
const fakeCalls = () => readFileSync(join(HOME, 'fake-calls.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

// ---- setup: clean home + a real git repo on a known branch with one commit ----
rmSync(HOME, { recursive: true, force: true });
mkdirSync(HOME, { recursive: true });
rmSync(REPO, { recursive: true, force: true });
mkdirSync(REPO, { recursive: true });
git(['init', '-q']);
git(['config', 'user.email', 't@t']);
git(['config', 'user.name', 't']);
git(['symbolic-ref', 'HEAD', 'refs/heads/main']); // deterministic branch name
writeFileSync(join(REPO, 'work.txt'), 'in progress\n');
git(['add', '.']);
git(['commit', '-q', '-m', 'wip']);
const startBranch = git(['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
const startHead = git(['rev-parse', 'HEAD']).stdout.trim();

// ---- inject an adopted task exactly as `case 'adopt'` in bin/carry.mjs does ----
const EXT_SESSION = 'ext-session-abc123';
const CONTINUE = 'keep implementing Phase 2 per docs/BUILD_PLAN.md';
const { loadQueue, saveQueue, addTask } = await import(pathToFileURL(join(ROOT, 'lib', 'store.mjs')).href);
{
  const q = loadQueue();
  const task = addTask(q, { prompt: `adopt: continue session ${EXT_SESSION}`, cwd: REPO });
  task.session_id = EXT_SESSION;
  task.status = 'waiting';
  task.resume_at = new Date(Date.now() - 60_000).toISOString(); // already due
  task.isolation = 'none';
  task.continue_instruction = CONTINUE;
  saveQueue(q);
}
assert('schema carries continue_instruction (default null on a plain add)', 'continue_instruction' in addTask(loadQueue(), { prompt: 'x', cwd: REPO }));

// ---- run one tick: the due waiting task should resume in place ----
carry(['run', '--once'], { FAKE_BEHAVIOR: 'ok' });
const q = queue();
const adopted = q.tasks.find((t) => t.session_id === EXT_SESSION);
const call = fakeCalls().at(-1).argv;

assert('adopted task completed', adopted.status === 'done', adopted.status);
assert('resumed the SAME external session via --resume', call.includes('--resume') && call[call.indexOf('--resume') + 1] === EXT_SESSION, call.join(' '));
assert('custom continue_instruction passed as the -p prompt', call[call.indexOf('-p') + 1] === CONTINUE, call[call.indexOf('-p') + 1]);
assert('isolation:none -> no --worktree flag', !call.includes('--worktree'), call.join(' '));

// ---- the critical guarantee: the user's working tree is left untouched ----
const branches = git(['branch', '--list', 'carry/*']).stdout.trim();
assert('isolation:none -> NO carry/<id> branch created', branches === '', `branches: "${branches}"`);
assert('stayed on the user\'s own branch', git(['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim() === startBranch);
assert('no baseline/checkpoint commit added (HEAD unchanged)', git(['rev-parse', 'HEAD']).stdout.trim() === startHead);
assert('task never recorded a branch field', !adopted.branch, adopted.branch || '(none)');

// ---- --drain: resume a DUE adopted task, then EXIT on its own (not loop forever) ----
// This is the mechanism `carry adopt` relies on: it spawns a detached `carry run --drain`
// that waits for the reset, resumes, and then bows out.
{
  const q2 = loadQueue();
  const t = addTask(q2, { prompt: 'drain test', cwd: REPO });
  t.session_id = 'ext-drain-xyz';
  t.status = 'waiting';
  t.resume_at = new Date(Date.now() - 5_000).toISOString(); // already due
  t.isolation = 'none';
  saveQueue(q2);
}
// --no-wake: skip OS wake/logon registration (the Register-ScheduledTask cmdlet
// can hang in headless/CI shells); the wall-clock loop is what we're testing here.
const drainRes = spawnSync(process.execPath, [NQ, 'run', '--drain', '--no-wake'], { encoding: 'utf8', env: baseEnv, timeout: 25_000 });
const drained = queue().tasks.find((t) => t.session_id === 'ext-drain-xyz');
assert('--drain resumed the due adopted task', drained?.status === 'done', drained?.status);
assert('--drain exited on its own (did not hang/loop forever)', drainRes.signal !== 'SIGTERM' && drainRes.status === 0, `signal=${drainRes.signal} code=${drainRes.status}`);

// ---- wrap up ----
rmSync(HOME, { recursive: true, force: true });
rmSync(REPO, { recursive: true, force: true });
if (failures === 0) console.log('\x1b[32m\nALL ADOPT TESTS PASSED\x1b[0m');
else console.log(`\x1b[31m\n${failures} TEST(S) FAILED\x1b[0m`);
process.exit(failures === 0 ? 0 : 1);
