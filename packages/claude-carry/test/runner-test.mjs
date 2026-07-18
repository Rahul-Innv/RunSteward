// Runner verification against the fake-claude stub (zero API usage):
//   A. two tasks dispatch sequentially -> done, session_ids captured, cost recorded
//   B. one task fails -> marked failed with reason, queue moves on
//   C. THE BIG ONE: kill the runner (and child) mid-task -> task reconciles ->
//      restart -> the SAME session is resumed via --resume <id> -> done
//
// Usage: node test/runner-test.mjs

import { spawn, spawnSync } from 'node:child_process';
import { rmSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NQ = join(ROOT, 'bin', 'carry.mjs');
const FAKE = join(ROOT, 'test', 'fake-claude.mjs');
const HOME = join(tmpdir(), 'carry-runner-test');

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

// ---- setup ----
rmSync(HOME, { recursive: true, force: true });
mkdirSync(HOME, { recursive: true });

// These tasks use --worktree so the runner does NO real git in this test (the
// stub ignores --worktree); in-folder git mechanics get their own temp-repo
// suite in test/infolder-test.mjs. Default mode is checked in A3 below.
// ---- A: sequential happy path ----
carry(['add', 'first task: do a thing', '--worktree']);
carry(['add', 'second task: do another thing', '--worktree']);
let r = carry(['run', '--until-idle']);
let q = queue();
assert('A: both tasks done', q.tasks.every((t) => t.status === 'done'), q.tasks.map((t) => t.status).join(','));
assert('A: session_ids captured', q.tasks.every((t) => !!t.session_id));
assert('A: cost recorded', q.tasks.every((t) => t.cost_usd > 0));
assert('A: per-task logs exist', q.tasks.every((t) => existsSync(join(HOME, 'logs', `${t.id}.ndjson`))));
assert('A: ran sequentially (2 claude calls)', fakeCalls().length === 2, `${fakeCalls().length} calls`);
assert('A: idle auto-wrote report.md (no prompt)', existsSync(join(HOME, 'report.md')));
assert('A: default model (sonnet) passed via --model', fakeCalls().every((c) => { const i = c.argv.indexOf('--model'); return i >= 0 && c.argv[i + 1] === 'sonnet'; }), fakeCalls()[0].argv.join(' '));
assert('A: default sonnet budget cap = $5', fakeCalls().every((c) => { const i = c.argv.indexOf('--max-budget-usd'); return i >= 0 && c.argv[i + 1] === '5'; }), fakeCalls()[0].argv.join(' '));
// guardrails appear LAST and carry the safety floor
const a1 = fakeCalls()[0].argv;
assert('A: --allowedTools present with Read', a1.includes('--allowedTools') && a1.includes('Read'));
assert('A: --disallowedTools denies git push + rm + secrets', a1.includes('--disallowedTools') && a1.includes('Bash(git push *)') && a1.includes('Bash(rm *)') && a1.includes('Read(.env)'));
assert('A: --disallowedTools is the final flag (variadic-safe)', a1.lastIndexOf('--disallowedTools') > a1.lastIndexOf('--allowedTools') && a1.lastIndexOf('--disallowedTools') > a1.indexOf('--worktree'));
// read-only verification filters allowed (stop benign pipes false-parking) ...
assert('A: read-only filters allowed (Get-ChildItem, Select-Object, git check-ignore)', a1.includes('PowerShell(Get-ChildItem *)') && a1.includes('PowerShell(Select-Object *)') && a1.includes('Bash(git check-ignore *)'));
// ... but file-content readers are NOT auto-allowed (would bypass .env denials)
assert('A: file-content readers stay out of the allowlist', !a1.includes('PowerShell(Get-Content *)') && !a1.includes('PowerShell(Select-String *)'));

// ---- A2: per-task --model and --budget override ----
carry(['add', 'opus task', '--model', 'opus', '--budget', '3.50', '--worktree']);
carry(['run', '--once'], { FAKE_BEHAVIOR: 'ok' });
const opusCall = fakeCalls().at(-1).argv;
assert('A2: per-task --model opus passed', opusCall[opusCall.indexOf('--model') + 1] === 'opus', opusCall.join(' '));
assert('A2: per-task --max-budget-usd passed', opusCall.includes('--max-budget-usd') && opusCall[opusCall.indexOf('--max-budget-usd') + 1] === '3.5');

// ---- A3: default (in-folder) mode passes NO --worktree ----
// Run in a temp NON-git dir so isolation mode is 'none' (no branch lifecycle) —
// the point here is purely that the default no longer adds --worktree.
const plainDir = join(tmpdir(), 'carry-runner-test-plain');
rmSync(plainDir, { recursive: true, force: true });
mkdirSync(plainDir, { recursive: true });
carry(['add', 'default-mode task', '--cwd', plainDir]);
carry(['run', '--once'], { FAKE_BEHAVIOR: 'ok' });
const defCall = fakeCalls().at(-1).argv;
assert('A3: default mode passes no --worktree', !defCall.includes('--worktree'), defCall.join(' '));
rmSync(plainDir, { recursive: true, force: true });

// ---- B: failure is contained ----
carry(['add', 'third task: this one fails', '--worktree']);
r = carry(['run', '--until-idle'], { FAKE_BEHAVIOR: 'fail' });
q = queue();
const t3 = q.tasks.find((t) => t.prompt.startsWith('third'));
assert('B: failed task marked failed', t3.status === 'failed', t3.parked_reason);
assert('B: failure reason recorded', /error_during_execution/.test(t3.parked_reason || ''));

// ---- B2: parking — gray-zone denial parks the task for approval, approve resumes ----
carry(['add', 'parky task: needs a blocked action', '--worktree']);
carry(['run', '--once'], { FAKE_BEHAVIOR: 'denied' });
q = queue();
let pk = q.tasks.find((t) => t.prompt.startsWith('parky'));
assert('B2: gray-zone denial -> needs-approval', pk.status === 'needs-approval', pk.status);
assert('B2: blocked call recorded in parked_calls', (pk.parked_calls || []).some((d) => d.kind === 'dontask' && d.tool === 'PowerShell'), JSON.stringify(pk.parked_calls));
assert('B2: session preserved for resume', !!pk.session_id);
const approveOut = spawnSync(process.execPath, [NQ, 'approve', pk.id], { encoding: 'utf8', env: baseEnv });
q = queue();
pk = q.tasks.find((t) => t.prompt.startsWith('parky'));
assert('B2: approve -> pending', pk.status === 'pending', pk.status);
assert('B2: approve granted the exact command', (pk.allow_extra || []).includes('PowerShell(npm install lodash)'), JSON.stringify(pk.allow_extra));
// resume run should carry the granted rule into --allowedTools
carry(['run', '--once'], { FAKE_BEHAVIOR: 'ok' });
const resumeCall = fakeCalls().at(-1).argv;
assert('B2: granted rule passed to --allowedTools on resume', resumeCall.includes('PowerShell(npm install lodash)'), resumeCall.join(' '));

// ---- B3: plan-first — phase 1 parks a plan, approve executes ----
carry(['add', 'planny task: risky refactor', '--plan', '--worktree']);
carry(['run', '--once'], { FAKE_BEHAVIOR: 'plan' });
q = queue();
let pl = q.tasks.find((t) => t.prompt.startsWith('planny'));
assert('B3: plan task -> needs-approval', pl.status === 'needs-approval', pl.status);
assert('B3: phase 1 ran in plan mode', fakeCalls().at(-1).argv.includes('plan') && fakeCalls().at(-1).argv[fakeCalls().at(-1).argv.indexOf('--permission-mode') + 1] === 'plan');
assert('B3: plan saved to disk', existsSync(join(HOME, 'plans', `${pl.id}.md`)) && /Edit foo.js/.test(readFileSync(join(HOME, 'plans', `${pl.id}.md`), 'utf8')));
carry(['approve', pl.id]);
q = queue();
pl = q.tasks.find((t) => t.prompt.startsWith('planny'));
assert('B3: approve clears plan_first -> pending', pl.status === 'pending' && pl.plan_first === false, `${pl.status}/${pl.plan_first}`);
carry(['run', '--once'], { FAKE_BEHAVIOR: 'ok' });
const execCall = fakeCalls().at(-1).argv;
assert('B3: execute phase uses dontAsk + resume', execCall[execCall.indexOf('--permission-mode') + 1] === 'dontAsk' && execCall.includes('--resume'), execCall.join(' '));

// ---- C: kill mid-task, restart, resume the SAME session ----
carry(['add', 'fourth task: long running, will be killed', '--worktree']);
const runner = spawn(process.execPath, [NQ, 'run', '--until-idle'], {
  env: { ...baseEnv, FAKE_BEHAVIOR: 'slow', FAKE_SLOW_MS: '30000' },
  stdio: 'ignore',
});

// wait until the task is running AND its session_id has been persisted
let t4 = null;
for (let i = 0; i < 100; i++) {
  await sleep(100);
  q = queue();
  t4 = q.tasks.find((t) => t.prompt.startsWith('fourth'));
  if (t4?.status === 'running' && t4.session_id) break;
}
assert('C: session_id persisted while task still running', t4?.status === 'running' && !!t4.session_id, t4?.session_id);
const originalSession = t4.session_id;
const childPid = t4.lock?.pid;

// simulate a hard crash: kill runner first, then its claude child
runner.kill();
await sleep(200);
if (childPid) {
  try {
    process.kill(childPid);
  } catch {}
}
await sleep(300);

q = queue();
t4 = q.tasks.find((t) => t.prompt.startsWith('fourth'));
assert('C: after crash, task still has its session_id', t4.session_id === originalSession);

// restart the runner: reconcile should flip it to pending and resume
r = carry(['run', '--until-idle']); // FAKE_BEHAVIOR back to ok
q = queue();
t4 = q.tasks.find((t) => t.prompt.startsWith('fourth'));
assert('C: task completed after restart', t4.status === 'done', t4.status);
assert('C: same session preserved', t4.session_id === originalSession);
const lastCall = fakeCalls().at(-1);
assert(
  'C: restart used --resume with the original session',
  lastCall.argv.includes('--resume') && lastCall.argv.includes(originalSession),
  lastCall.argv.filter((a) => a === '--resume' || a === originalSession).join(' ')
);

// ---- D: incremental cost — a task killed before its result still shows a cost ----
carry(['add', 'fifth task: killed mid-run, should keep a cost estimate', '--worktree']);
const runner2 = spawn(process.execPath, [NQ, 'run', '--once'], {
  env: { ...baseEnv, FAKE_BEHAVIOR: 'slowcost', FAKE_SLOW_MS: '30000' },
  stdio: 'ignore',
});
let t5c = null;
for (let i = 0; i < 100; i++) {
  await sleep(100);
  q = queue();
  t5c = q.tasks.find((t) => t.prompt.startsWith('fifth'));
  if (t5c?.status === 'running' && t5c.cost_usd > 0) break;
}
assert('D: cost estimated incrementally while running', t5c?.status === 'running' && t5c.cost_usd > 0 && t5c.cost_estimated === true, `cost=${t5c?.cost_usd} est=${t5c?.cost_estimated}`);
const killedCost = t5c.cost_usd;
const pid2 = t5c.lock?.pid;
runner2.kill();
await sleep(200);
if (pid2) { try { process.kill(pid2); } catch {} }
await sleep(300);
q = queue();
t5c = q.tasks.find((t) => t.prompt.startsWith('fifth'));
assert('D: killed task keeps its cost (not $0)', t5c.cost_usd >= killedCost && t5c.cost_usd > 0, `cost=${t5c.cost_usd}`);
// restart -> resume -> authoritative cost from the result, estimate flag cleared
carry(['run', '--once'], { FAKE_BEHAVIOR: 'ok' });
q = queue();
t5c = q.tasks.find((t) => t.prompt.startsWith('fifth'));
assert('D: resume records authoritative cost (estimate flag cleared)', t5c.status === 'done' && t5c.cost_estimated === false && t5c.cost_usd > killedCost, `cost=${t5c.cost_usd} est=${t5c.cost_estimated}`);

// ---- wrap up ----
rmSync(HOME, { recursive: true, force: true });
if (failures === 0) console.log('\x1b[32m\nALL RUNNER TESTS PASSED\x1b[0m');
else console.log(`\x1b[31m\n${failures} TEST(S) FAILED\x1b[0m`);
process.exit(failures === 0 ? 0 : 1);
