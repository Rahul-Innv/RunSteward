'use strict';
// End-to-end tests for trigger/check.js: spawn the real script with synthetic
// stdin + an isolated LIMIT_WRAPUP_DIR. Run: node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const CHECK = path.join(__dirname, '..', 'trigger', 'check.js');

function freshDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'limit-wrapup-test-'));
}

function run(dir, hookInput, extraEnv) {
  const r = cp.spawnSync(process.execPath, [CHECK], {
    input: typeof hookInput === 'string' ? hookInput : JSON.stringify(hookInput),
    // NO_NET: check.js may spawn the detached OAuth refresher on stale state;
    // in tests it must exit before touching the network.
    env: Object.assign({}, process.env, { LIMIT_WRAPUP_DIR: dir, LIMIT_WRAPUP_NO_NET: '1' }, extraEnv || {}),
    encoding: 'utf8',
    timeout: 15000,
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function writeState(dir, fiveHourPct, opts) {
  const o = opts || {};
  const now = o.now || Date.now();
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
    samples: [{
      ts: now - 60000,
      rate_limits: {
        five_hour: { used_percentage: fiveHourPct, resets_at: Math.floor((now + 3 * 3600e3) / 1000) },
        seven_day: { used_percentage: 30, resets_at: Math.floor((now + 5 * 86400e3) / 1000) },
      },
    }],
  }));
}

const PROMPT_EVENT = { session_id: 'e2e-test-session', hook_event_name: 'UserPromptSubmit', prompt: 'hi' };

test('no state file -> silent, exit 0', () => {
  const dir = freshDir();
  const r = run(dir, PROMPT_EVENT);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, '');
});

test('garbage stdin -> silent, exit 0', () => {
  const dir = freshDir();
  const r = run(dir, 'this is not json{{{');
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '');
});

test('malformed state.json -> silent, exit 0', () => {
  const dir = freshDir();
  fs.writeFileSync(path.join(dir, 'state.json'), '{broken');
  const r = run(dir, PROMPT_EVENT);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '');
});

test('default config is dry_run: WARN is logged, nothing emitted, latch persisted', () => {
  const dir = freshDir();
  writeState(dir, 86);
  const r = run(dir, PROMPT_EVENT);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, ''); // dry run emits nothing
  const log = fs.readFileSync(path.join(dir, 'decisions.log'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(log.length, 1);
  assert.equal(log[0].decision, 'WARN');
  assert.equal(log[0].dry_run, true);
  const latches = JSON.parse(fs.readFileSync(path.join(dir, 'latches.json'), 'utf8'));
  assert.ok(Object.keys(latches.sessions['e2e-test-session'].keys).length >= 1);
});

test('live mode emits UserPromptSubmit additionalContext; second call is latched-silent', () => {
  const dir = freshDir();
  writeState(dir, 86);
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ dry_run: false }));

  const r1 = run(dir, PROMPT_EVENT);
  assert.equal(r1.code, 0);
  const out = JSON.parse(r1.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(out.hookSpecificOutput.additionalContext, /\[limit-wrapup\]/);
  assert.match(out.hookSpecificOutput.additionalContext, /86%/);

  const r2 = run(dir, PROMPT_EVENT);
  assert.equal(r2.stdout, ''); // latched
});

test('enabled:false kill-switch -> silent, no files written', () => {
  const dir = freshDir();
  writeState(dir, 95);
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ enabled: false, dry_run: false }));
  const r = run(dir, PROMPT_EVENT);
  assert.equal(r.stdout, '');
  assert.ok(!fs.existsSync(path.join(dir, 'decisions.log')));
});

test('PreToolUse: full check first, throttled no-op within 60s, permission untouched', () => {
  const dir = freshDir();
  writeState(dir, 86);
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ dry_run: false }));
  const evt = { session_id: 'e2e-test-session', hook_event_name: 'PreToolUse', tool_name: 'Bash' };

  const r1 = run(dir, evt);
  const out = JSON.parse(r1.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.ok(!('permissionDecision' in out.hookSpecificOutput));
  assert.match(out.hookSpecificOutput.additionalContext, /\[limit-wrapup\]/);

  const r2 = run(dir, evt); // within throttle window -> instant no-op, no log line
  assert.equal(r2.stdout, '');
  const log = fs.readFileSync(path.join(dir, 'decisions.log'), 'utf8').trim().split('\n');
  assert.equal(log.length, 1);
});

test('auto mode inside reserve -> WRAPUP directive emitted live', () => {
  const dir = freshDir();
  writeState(dir, 99);
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ dry_run: false, mode: 'auto', wrapup_cost_measured: 1 }));
  const r = run(dir, PROMPT_EVENT);
  assert.equal(r.code, 0);
  const out = JSON.parse(r.stdout);
  assert.match(out.hookSpecificOutput.additionalContext, /WRAPUP directive/);
  assert.match(out.hookSpecificOutput.additionalContext, /wrapping-up skill NOW/);
  const log = JSON.parse(fs.readFileSync(path.join(dir, 'decisions.log'), 'utf8').trim());
  assert.equal(log.decision, 'WRAPUP');
});

test('WRAPUP dispatches a desktop notification (via NOTIFY_FILE seam)', () => {
  const dir = freshDir();
  const notifyFile = path.join(dir, 'notify.log');
  writeState(dir, 99);
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ dry_run: false, mode: 'auto', wrapup_cost_measured: 1 }));
  const r = run(dir, PROMPT_EVENT, { LIMIT_WRAPUP_NOTIFY_FILE: notifyFile });
  assert.equal(r.code, 0);
  const rec = JSON.parse(fs.readFileSync(notifyFile, 'utf8').trim());
  assert.match(rec.title, /wrapping up/i);
  assert.match(rec.message, /weekly 99%|5h 99%|near the usage cliff/);
});

test('a WARN does NOT dispatch a notification (only WRAPUP does)', () => {
  const dir = freshDir();
  const notifyFile = path.join(dir, 'notify.log');
  writeState(dir, 86); // crosses the 85 warn threshold, not the reserve
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ dry_run: false }));
  const r = run(dir, PROMPT_EVENT, { LIMIT_WRAPUP_NOTIFY_FILE: notifyFile });
  assert.equal(r.code, 0);
  assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /heads-up/i);
  assert.equal(fs.existsSync(notifyFile), false); // no toast for an informational warn
});

test('notify:false suppresses the WRAPUP notification but not the directive', () => {
  const dir = freshDir();
  const notifyFile = path.join(dir, 'notify.log');
  writeState(dir, 99);
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ dry_run: false, mode: 'auto', wrapup_cost_measured: 1, notify: false }));
  const r = run(dir, PROMPT_EVENT, { LIMIT_WRAPUP_NOTIFY_FILE: notifyFile });
  assert.equal(r.code, 0);
  assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /WRAPUP directive/);
  assert.equal(fs.existsSync(notifyFile), false);
});

test('stale state -> silent but spawns throttled oauth-refresh marker', () => {
  const dir = freshDir();
  writeState(dir, 50, { now: Date.now() - 30 * 60000 }); // sample ~31 min old -> stale
  const r = run(dir, PROMPT_EVENT);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, ''); // stale = unknown = silent, as before
  assert.ok(fs.existsSync(path.join(dir, 'oauth-refresh.txt'))); // fallback poll was dispatched
  const mtime1 = fs.statSync(path.join(dir, 'oauth-refresh.txt')).mtimeMs;

  const r2 = run(dir, { session_id: 'other-session', hook_event_name: 'UserPromptSubmit', prompt: 'x' });
  assert.equal(r2.code, 0);
  const mtime2 = fs.statSync(path.join(dir, 'oauth-refresh.txt')).mtimeMs;
  assert.equal(mtime1, mtime2); // within 180s window -> no second spawn
});

test('no state file at all also dispatches the fallback poll', () => {
  const dir = freshDir();
  const r = run(dir, PROMPT_EVENT);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '');
  assert.ok(fs.existsSync(path.join(dir, 'oauth-refresh.txt')));
});

test('two concurrent checks: both exit 0, latches.json stays valid JSON', async () => {
  const dir = freshDir();
  writeState(dir, 86);
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ dry_run: false }));
  const spawn = (sid) => new Promise((resolve) => {
    const p = cp.spawn(process.execPath, [CHECK], {
      env: Object.assign({}, process.env, { LIMIT_WRAPUP_DIR: dir }),
    });
    p.stdin.end(JSON.stringify({ session_id: sid, hook_event_name: 'UserPromptSubmit', prompt: 'hi' }));
    p.on('close', (code) => resolve(code));
  });
  const codes = await Promise.all([spawn('contend-a'), spawn('contend-b'), spawn('contend-c')]);
  assert.deepEqual(codes, [0, 0, 0]);
  const latches = JSON.parse(fs.readFileSync(path.join(dir, 'latches.json'), 'utf8')); // parses = not corrupted
  assert.ok(Object.keys(latches.sessions).length >= 1); // last-writer-wins is acceptable; corruption is not
});

test('below thresholds -> NONE logged, nothing emitted even live', () => {
  const dir = freshDir();
  writeState(dir, 42);
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ dry_run: false }));
  const r = run(dir, PROMPT_EVENT);
  assert.equal(r.stdout, '');
  const log = JSON.parse(fs.readFileSync(path.join(dir, 'decisions.log'), 'utf8').trim());
  assert.equal(log.decision, 'NONE');
});
