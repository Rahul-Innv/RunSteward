// Parallel/concurrency verification against the fake-claude stub (zero usage):
//   P1. concurrency=2 + three --worktree tasks -> at some moment 2 run AT ONCE,
//       and all three finish.
//   P2. two in-folder tasks in the SAME repo -> they never run simultaneously
//       (an in-folder task needs exclusive use of its checkout), yet both finish,
//       each on its own branch.
//
// Each part gets its OWN CARRY_HOME and we await the runner's real exit, so
// a previous part's runner can never race the next on a shared queue. Uses
// FAKE_BEHAVIOR=slow so runs overlap long enough to observe. Concurrency is read
// from <HOME>/config.json.
//
// Usage: node test/parallel-test.mjs

import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { rmSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NQ = join(ROOT, 'bin', 'carry.mjs');
const FAKE = join(ROOT, 'test', 'fake-claude.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function assert(name, cond, detail = '') {
  console.log(`${cond ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
}

const cleanups = [];
function freshHome(label) {
  const home = mkdtempSync(join(tmpdir(), `carry-par-${label}-`));
  writeFileSync(join(home, 'config.json'), JSON.stringify({ concurrency: 2 }));
  cleanups.push(home);
  return home;
}
const carry = (home, args, env = {}) =>
  spawnSync(process.execPath, [NQ, ...args], { encoding: 'utf8', env: { ...process.env, CARRY_HOME: home, CARRY_CLAUDE: FAKE, ...env } });
const tasksOf = (home) => JSON.parse(readFileSync(join(home, 'queue.json'), 'utf8')).tasks;

function makeRepo(label) {
  const dir = mkdtempSync(join(tmpdir(), `carry-par-${label}-repo-`));
  const g = (...a) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  g('init', '-b', 'main'); g('config', 'user.email', 't@t'); g('config', 'user.name', 'T');
  writeFileSync(join(dir, 'README.md'), 'seed\n'); g('add', '-A'); g('commit', '-m', 'init');
  cleanups.push(dir);
  return dir;
}

// Drain a home's queue with one runner, sampling max simultaneous 'running'.
// Awaits the runner's real exit (it self-exits on --until-idle when idle).
async function runAndSample(home, slowMs) {
  // capture the runner's stderr (was stdio:'ignore') so a crash surfaces its
  // stack instead of a cryptic stuck-status assertion.
  let stderr = '';
  const runner = spawn(process.execPath, [NQ, 'run', '--until-idle'], {
    env: { ...process.env, CARRY_HOME: home, CARRY_CLAUDE: FAKE, FAKE_BEHAVIOR: 'slow', FAKE_SLOW_MS: String(slowMs) },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  runner.stderr.on('data', (d) => { stderr += d; });
  const exited = once(runner, 'exit').then(() => true).catch(() => true);
  let maxRunning = 0;
  for (let i = 0; i < 600; i++) {
    await Promise.race([sleep(40), exited]);
    try {
      const ts = tasksOf(home);
      maxRunning = Math.max(maxRunning, ts.filter((t) => t.status === 'running').length);
      if (ts.length && ts.every((t) => t.status === 'done')) break;
    } catch {}
    if (runner.exitCode !== null) break;
  }
  if (runner.exitCode === null) {
    // tasks are done on disk but the runner is still wrapping up (--until-idle
    // writes report/handoff, then returns and the process exits 0). Give it a
    // bounded moment to self-exit cleanly before forcibly killing it, so a clean
    // run reads exitCode 0 and only a genuine hang fails the clean-exit assert.
    await Promise.race([once(runner, 'exit').catch(() => {}), sleep(3000)]);
    if (runner.exitCode === null) { try { runner.kill(); } catch {} await once(runner, 'exit').catch(() => {}); }
  }
  return { maxRunning, tasks: tasksOf(home), exitCode: runner.exitCode, stderr };
}

// ---- P1: two run at once across different checkouts ----
// own throwaway repo (never the real dev repo) — worktree tasks default cwd to
// process.cwd() with no --cwd, and the SWEEP LESSON is: never run the runner
// against the live repo.
const home1 = freshHome('p1');
const repo1 = makeRepo('p1');
carry(home1, ['add', 'P1 a', '--worktree', '--cwd', repo1]);
carry(home1, ['add', 'P1 b', '--worktree', '--cwd', repo1]);
carry(home1, ['add', 'P1 c', '--worktree', '--cwd', repo1]);
const r1 = await runAndSample(home1, 1500);
assert('P1: runner exited cleanly', r1.exitCode === 0, r1.exitCode === 0 ? '' : `exit ${r1.exitCode}\n${r1.stderr.slice(0, 1500)}`);
assert('P1: reached 2 tasks running at once (concurrency=2)', r1.maxRunning >= 2, `max observed = ${r1.maxRunning}`);
assert('P1: all three finished', r1.tasks.length === 3 && r1.tasks.every((t) => t.status === 'done'), r1.tasks.map((t) => t.status).join(','));

// ---- P2: same-repo in-folder tasks serialize (never both running) ----
const home2 = freshHome('p2');
const repo = makeRepo('p2');
carry(home2, ['add', 'P2 first', '--cwd', repo]);   // in-folder (default)
carry(home2, ['add', 'P2 second', '--cwd', repo]);  // in-folder, same cwd
const r2 = await runAndSample(home2, 1200);
// the safety property is "never 2 at once" (serialized by canStart); both
// finishing on their own branches confirms they actually ran.
assert('P2: runner exited cleanly', r2.exitCode === 0, r2.exitCode === 0 ? '' : `exit ${r2.exitCode}\n${r2.stderr.slice(0, 1500)}`);
assert('P2: same-repo in-folder tasks never ran simultaneously', r2.maxRunning <= 1, `max observed = ${r2.maxRunning}`);
assert('P2: both finished (serialized)', r2.tasks.every((t) => t.status === 'done'), r2.tasks.map((t) => t.status).join(','));
assert('P2: each got its own carry branch', new Set(r2.tasks.map((t) => t.branch)).size === 2 && r2.tasks.every((t) => /^carry\//.test(t.branch || '')), r2.tasks.map((t) => t.branch).join(', '));

// ---- wrap up ----
for (const d of cleanups) rmSync(d, { recursive: true, force: true });
if (failures === 0) console.log('\x1b[32m\nALL PARALLEL TESTS PASSED\x1b[0m');
else console.log(`\x1b[31m\n${failures} TEST(S) FAILED\x1b[0m`);
process.exit(failures === 0 ? 0 : 1);
