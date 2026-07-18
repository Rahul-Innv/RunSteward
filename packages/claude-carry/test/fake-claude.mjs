// fake-claude — a stand-in for the real `claude` binary that emits the same
// stream-json events the real one does (shapes captured live on this machine
// during research). Lets us verify the runner's dispatch/capture/resume logic
// without spending any usage. Selected via CARRY_CLAUDE=<this file>.
//
// Behavior via env:
//   FAKE_BEHAVIOR=ok      (default) init -> assistant -> result success
//   FAKE_BEHAVIOR=slow    init immediately, then sleep FAKE_SLOW_MS (20s) before result
//   FAKE_BEHAVIOR=fail    init -> result error_during_execution
//   FAKE_BEHAVIOR=limit   init -> rate_limit_event rejected (resetsAt =
//                         now + FAKE_RESET_S seconds, epoch-seconds style) -> exit 1
//   FAKE_BEHAVIOR=billing init -> billing_error text -> exit 1

import { randomUUID } from 'node:crypto';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const resumeIdx = argv.indexOf('--resume');
const sessionId = resumeIdx >= 0 ? argv[resumeIdx + 1] : randomUUID();
const behavior = process.env.FAKE_BEHAVIOR || 'ok';

// record every invocation so tests can assert how we were called
if (process.env.CARRY_HOME) {
  appendFileSync(
    join(process.env.CARRY_HOME, 'fake-calls.ndjson'),
    JSON.stringify({ ts: Date.now(), argv, behavior }) + '\n'
  );
}

const emit = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// token usage shape carried on assistant events (lets the runner estimate cost
// incrementally); fields mirror the real stream-json `usage` object.
const USAGE = { input_tokens: 12, output_tokens: 80, cache_read_input_tokens: 2000, cache_creation_input_tokens: 300 };

emit({
  type: 'system',
  subtype: 'init',
  session_id: sessionId,
  model: 'fake-haiku',
  skills: ['fake-skill-1', 'fake-skill-2'],
  cwd: process.cwd(),
});

// FAKE_TOUCH=<filename> makes the stub write a file in its cwd — simulating a
// real agent's file edit, so in-folder git tests have something to commit.
if (process.env.FAKE_TOUCH) {
  writeFileSync(join(process.cwd(), process.env.FAKE_TOUCH), `changed by fake agent (session ${sessionId})\n`);
}

if (behavior === 'limit') {
  // shape matches the real event captured on this machine during research:
  // epoch SECONDS (statusline style) — the sentinel must normalize it
  const resetsAt = Math.floor(Date.now() / 1000) + Number(process.env.FAKE_RESET_S || 3);
  emit({
    type: 'rate_limit_event',
    session_id: sessionId,
    // shape verbatim from a real run (2026-06-13), status flipped to rejected
    rate_limit_info: {
      status: 'rejected',
      resetsAt,
      rateLimitType: 'five_hour',
      overageStatus: 'rejected',
      overageDisabledReason: 'org_level_disabled',
      isUsingOverage: false,
    },
  });
  process.exit(1); // hard stop, no result event — exactly how a limit hit looks
}

if (behavior === 'plan') {
  // emulate a plan-mode run: model presents a plan via ExitPlanMode, then ends
  const toolUseId = 'tu_plan_' + sessionId.slice(0, 6);
  emit({
    type: 'assistant',
    session_id: sessionId,
    message: { content: [{ type: 'tool_use', id: toolUseId, name: 'ExitPlanMode', input: { plan: '## Plan\n1. Edit foo.js\n2. Run tests' } }] },
  });
  emit({ type: 'result', subtype: 'success', session_id: sessionId, total_cost_usd: 0.01 });
  process.exit(0);
}

if (behavior === 'denied') {
  // emulate a gray-zone (dontAsk) denial: claude tries a tool, gets blocked, then
  // finishes. Shapes captured verbatim from a real run on this machine.
  const toolUseId = 'tu_' + sessionId.slice(0, 8);
  emit({
    type: 'assistant',
    session_id: sessionId,
    message: { content: [{ type: 'tool_use', id: toolUseId, name: 'PowerShell', input: { command: 'npm install lodash' } }] },
  });
  emit({
    type: 'user',
    session_id: sessionId,
    message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, is_error: true, content: "Permission to use PowerShell has been denied because Claude Code is running in don't ask mode." }] },
  });
  emit({ type: 'result', subtype: 'success', session_id: sessionId, total_cost_usd: 0.02 });
  process.exit(0);
}

if (behavior === 'billing') {
  emit({
    type: 'assistant',
    session_id: sessionId,
    message: { content: [{ type: 'text', text: 'API Error: billing_error — credit balance is too low' }] },
  });
  process.exit(1);
}

// slowcost: stream an assistant event WITH token usage, then hang — lets a test
// kill the run mid-flight and confirm the runner persisted a cost estimate.
if (behavior === 'slowcost') {
  emit({ type: 'assistant', session_id: sessionId, message: { content: [{ type: 'text', text: 'working...' }], usage: USAGE } });
  await sleep(Number(process.env.FAKE_SLOW_MS || 20_000));
}

if (behavior === 'slow') await sleep(Number(process.env.FAKE_SLOW_MS || 20_000));
else await sleep(150);

emit({
  type: 'assistant',
  session_id: sessionId,
  message: { content: [{ type: 'text', text: resumeIdx >= 0 ? 'resumed and finished' : 'did the task' }], usage: USAGE },
});

if (behavior === 'fail') {
  emit({ type: 'result', subtype: 'error_during_execution', session_id: sessionId, total_cost_usd: 0.003, is_error: true });
  process.exit(1);
}

emit({ type: 'result', subtype: 'success', session_id: sessionId, total_cost_usd: 0.011, result: 'OK' });
