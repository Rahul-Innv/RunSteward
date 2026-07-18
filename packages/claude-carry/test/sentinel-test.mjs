// limit-sentinel verification — unit tests on classify() (including a replay of
// the REAL rate_limit_event shape captured on this machine during research),
// budget-gate math, and an integration pass: a fake limit hit parks the task
// as 'waiting' with the right resume_at, then the runner wakes and resumes
// the SAME session. Zero API usage.
//
// Usage: node test/sentinel-test.mjs

import { spawn, spawnSync } from 'node:child_process';
import { rmSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NQ = join(ROOT, 'bin', 'carry.mjs');
const FAKE = join(ROOT, 'test', 'fake-claude.mjs');
const HOME = join(tmpdir(), 'carry-sentinel-test');

// must be set before importing the lib (module reads them at import time)
process.env.CARRY_HOME = HOME;
process.env.CARRY_RESUME_BUFFER_MS = '500';
const { classify, budgetGate, nextMonthlyRefresh, resolveTaskBudget } = await import('../lib/sentinel.mjs');

const baseEnv = {
  ...process.env,
  CARRY_HOME: HOME,
  CARRY_CLAUDE: FAKE,
  CARRY_RESUME_BUFFER_MS: '500',
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function assert(name, cond, detail = '') {
  console.log(`${cond ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
}
const carry = (args, env = {}) =>
  spawnSync(process.execPath, [NQ, ...args], { encoding: 'utf8', env: { ...baseEnv, ...env } });
const queue = () => JSON.parse(readFileSync(join(HOME, 'queue.json'), 'utf8'));

rmSync(HOME, { recursive: true, force: true });
mkdirSync(HOME, { recursive: true });

// ---- unit: classify ----
let v = classify([{ type: 'result', subtype: 'success', total_cost_usd: 0.01 }]);
assert('unit: success -> done', v.status === 'done');

// REGRESSION: the exact rate_limit_info shape captured from a REAL `claude -p`
// run on this machine (2026-06-13) — verbatim, including the overage fields.
// A successful run embeds a status:'allowed' rate_limit_event; this must NOT be
// misread as a limit stop. If the real shape ever changes and the stub drifts,
// this fixture is the tripwire.
const REAL_RATE_LIMIT_INFO = {
  status: 'allowed',
  resetsAt: 1781374800, // epoch SECONDS
  rateLimitType: 'five_hour',
  overageStatus: 'rejected',
  overageDisabledReason: 'org_level_disabled',
  isUsingOverage: false,
};
v = classify([
  { type: 'system', subtype: 'init', session_id: '3d34058a', skills: new Array(25).fill('s') },
  { type: 'rate_limit_event', rate_limit_info: REAL_RATE_LIMIT_INFO, session_id: '3d34058a' },
  { type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } },
  { type: 'result', subtype: 'success', total_cost_usd: 0.44 },
]);
assert('REAL-shape: success with embedded allowed rate_limit_event -> done', v.status === 'done', v.status);

// the same real shape but status flipped to 'rejected' must parse resetsAt correctly
v = classify([
  { type: 'rate_limit_event', rate_limit_info: { ...REAL_RATE_LIMIT_INFO, status: 'rejected' } },
], { code: 1 });
assert(
  'REAL-shape: rejected variant -> waiting at real resetsAt (epoch-s normalized)',
  v.status === 'waiting' && Math.abs(Date.parse(v.resume_at) - (1781374800 * 1000 + 500)) < 2000,
  v.resume_at
);

// REAL shape from this machine (research capture): rate_limit_info with epoch-seconds resetsAt
const resetSec = Math.floor(Date.now() / 1000) + 3600;
v = classify([
  { type: 'system', subtype: 'init', session_id: 'abc' },
  { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'seven_day', resetsAt: resetSec, utilization: 0.94 } },
], { code: 1 });
assert('unit: rejected limit (epoch-s) -> waiting', v.status === 'waiting', v.reason);
assert(
  'unit: resume_at normalized to ms + buffer',
  Math.abs(Date.parse(v.resume_at) - (resetSec * 1000 + 500)) < 2000,
  v.resume_at
);

v = classify([
  { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: resetSec * 1000 } },
], { code: 1 });
assert('unit: rejected limit (epoch-ms) -> same waiting', v.status === 'waiting' && Math.abs(Date.parse(v.resume_at) - (resetSec * 1000 + 500)) < 2000);

v = classify([{ type: 'assistant', message: { content: [{ type: 'text', text: 'billing_error: credit balance is too low' }] } }], { code: 1 });
assert('unit: billing -> parked until refresh', v.status === 'parked' && Date.parse(v.resume_at) > Date.now(), v.resume_at);

v = classify([{ type: 'result', subtype: 'error_max_turns' }], { code: 1 });
assert('unit: error_max_turns -> failed', v.status === 'failed', v.reason);

v = classify([], { code: 1, stderrText: "You've hit your weekly limit · resets Mon 12:00am" });
const fallbackMs = Date.parse(v.resume_at) - Date.now();
assert('unit: text-only limit -> conservative wait (no prose time-parsing)', v.status === 'waiting' && fallbackMs > 25 * 60_000 && fallbackMs < 35 * 60_000);

v = classify([], { code: 1 });
assert('unit: silent death -> failed', v.status === 'failed', v.reason);

// ---- unit: budget gate ----
const month = new Date().toISOString();
writeFileSync(
  join(HOME, 'runs.ndjson'),
  [
    JSON.stringify({ ts: month, event: 'closed', task: 't0', cost: 50 }),
    JSON.stringify({ ts: month, event: 'closed', task: 't0', cost: 35 }),
    JSON.stringify({ ts: '2020-01-01T00:00:00Z', event: 'closed', task: 'old', cost: 999 }),
  ].join('\n') + '\n'
);
let gate = budgetGate();
assert('unit: $85 of $100 (80% cap) -> parked, old months ignored', !gate.ok && gate.spent === 85, `spent $${gate.spent}`);
writeFileSync(join(HOME, 'runs.ndjson'), JSON.stringify({ ts: month, event: 'closed', task: 't0', cost: 10 }) + '\n');
gate = budgetGate();
assert('unit: $10 of $100 -> clear', gate.ok && gate.spent === 10);
assert('unit: next refresh is in the future', nextMonthlyRefresh() > Date.now());

// ---- unit: per-model budget resolver ----
assert('unit: haiku budget cap = $1', resolveTaskBudget('haiku') === 1);
assert('unit: sonnet budget cap = $5', resolveTaskBudget('sonnet') === 5);
assert('unit: opus budget cap = $20', resolveTaskBudget('opus') === 20);
assert('unit: full model id matches by substring', resolveTaskBudget('claude-opus-4-8') === 20);
assert('unit: unknown model -> _default $10', resolveTaskBudget('mystery') === 10);

// ---- integration: limit hit -> waiting -> wake -> resume same session ----
// --worktree so the runner does NO in-folder git against the real repo this test
// runs in (the stub ignores --worktree); we're testing limit/billing behavior.
carry(['add', 'limit-test task', '--worktree']);
carry(['run', '--until-idle'], { FAKE_BEHAVIOR: 'limit', FAKE_RESET_S: '2' });
let q = queue();
let task = q.tasks.find((t) => t.prompt.startsWith('limit-test'));
assert('integration: limit hit -> status waiting', task.status === 'waiting', task.parked_reason);
assert('integration: session_id survived the limit stop', !!task.session_id);
assert('integration: resume_at ~2.5s out', Date.parse(task.resume_at) - Date.now() < 5000, task.resume_at);
const session = task.session_id;

await sleep(3200); // let the reset moment pass
carry(['run', '--until-idle']); // behavior back to ok
q = queue();
task = q.tasks.find((t) => t.prompt.startsWith('limit-test'));
assert('integration: woke after reset and completed', task.status === 'done', task.status);
assert('integration: resumed the SAME session', task.session_id === session);
const calls = readFileSync(join(HOME, 'fake-calls.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
assert('integration: wake call used --resume', calls.at(-1).argv.includes('--resume') && calls.at(-1).argv.includes(session));

// ---- integration: billing -> parked ----
carry(['add', 'billing-test task', '--worktree']);
carry(['run', '--until-idle'], { FAKE_BEHAVIOR: 'billing' });
q = queue();
task = q.tasks.find((t) => t.prompt.startsWith('billing-test'));
assert('integration: billing -> parked until monthly refresh', task.status === 'parked' && Date.parse(task.resume_at) > Date.now(), task.parked_reason);

rmSync(HOME, { recursive: true, force: true });
if (failures === 0) console.log('\x1b[32m\nALL SENTINEL TESTS PASSED\x1b[0m');
else console.log(`\x1b[31m\n${failures} TEST(S) FAILED\x1b[0m`);
process.exit(failures === 0 ? 0 : 1);
