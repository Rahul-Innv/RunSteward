// Handoff verification: buildHandoff turns queue state into a morning briefing
// for a NEW session — done work to bring in, plus a to-do list of what Claude Carry
// couldn't do unattended. Pure function over a synthetic queue (zero usage).
//
// Usage: node test/handoff-test.mjs

import { buildHandoff } from '../lib/handoff.mjs';

let failures = 0;
const assert = (name, cond, detail = '') => {
  console.log(`${cond ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
};

const q = {
  version: 1, paused: false, nextId: 9,
  tasks: [
    { id: 't1', prompt: 'add dark mode toggle', status: 'done', cost_usd: 0.4, model: 'sonnet',
      branch: 'carry/t1', result_summary: 'Added the toggle and tests. Could not run the e2e suite (needs a browser).',
      parked_calls: [{ kind: 'rule', tool: 'Bash', input: { command: 'git push origin main' } }] },
    { id: 't2', prompt: 'refactor auth needing a package', status: 'needs-approval', cost_usd: 0.2, model: 'sonnet',
      parked_reason: 'parked: 1 action(s) need approval', parked_calls: [{ kind: 'dontask', tool: 'PowerShell', input: { command: 'npm install jose' } }] },
    { id: 't3', prompt: 'risky migration', status: 'needs-approval', cost_usd: 0.01, model: 'opus',
      parked_reason: 'plan ready — review then: carry approve t3', parked_calls: [] },
    { id: 't4', prompt: 'flaky thing', status: 'failed', cost_usd: 0.05, model: 'sonnet', parked_reason: 'result: error_during_execution', retries: 1, parked_calls: [] },
    { id: 't5', prompt: 'hit a limit', status: 'waiting', cost_usd: 0.1, model: 'sonnet', parked_reason: 'usage limit (five_hour)', resume_at: '2026-06-15T20:00:00Z', parked_calls: [] },
  ],
};

const h = buildHandoff(q, '2026-06-15T08:00:00Z');

assert('header present', /# Claude Carry handoff/.test(h));
assert('counts line (1 done, 2 need you, 1 failed, 1 waiting)', /1 done/.test(h) && /2 need you/.test(h) && /1 failed/.test(h) && /1 waiting/.test(h), h.split('\n')[2]);
// done section
assert('done section lists t1 + its branch', /## ✅ Done/.test(h) && h.includes('**t1**') && h.includes('branch `carry/t1`'));
assert('done shows the agent summary', h.includes('Could not run the e2e suite'));
assert('forbidden-overnight action surfaces as a manual todo', /couldn't run `Bash: git push origin main`/.test(h));
// to-do section
assert('to-do section exists', /## ▶ To do in this session/.test(h));
assert('gray-zone approval todo (t2) names the command + carry approve', h.includes('npm install jose') && h.includes('carry approve t2'));
assert('plan-first todo (t3) points to carry plan + approve', h.includes('carry plan t3') && h.includes('carry approve t3'));
assert('failed todo (t4) says investigate', h.includes('**t4**') && /failed:/.test(h) && /Investigate or requeue/.test(h));
// waiting section
assert('waiting section lists t5 with resume time', /## 💤 Waiting/.test(h) && h.includes('**t5**'));
// empty queue
assert('empty queue handled', /nothing to bring in/.test(buildHandoff({ version: 1, paused: false, nextId: 1, tasks: [] }, 'x')));

console.log(failures === 0 ? '\x1b[32m\nALL HANDOFF TESTS PASSED\x1b[0m' : `\x1b[31m\n${failures} TEST(S) FAILED\x1b[0m`);
process.exit(failures === 0 ? 0 : 1);
