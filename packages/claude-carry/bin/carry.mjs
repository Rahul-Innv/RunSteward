#!/usr/bin/env node
// carry — Claude Carry CLI. Queue management (Module 1) + doctor (Module 0).
// The runner (Module 2+) is a separate long-lived process; this CLI only
// reads/writes the queue file, so it is always safe to use, even mid-run.

import { doctor } from '../lib/doctor.mjs';
import {
  loadQueue,
  saveQueue,
  addTask,
  removeTask,
  moveTask,
  findTask,
  QUEUE_FILE,
  LOGS_DIR,
  STATE_DIR,
} from '../lib/store.mjs';
import { runLoop, requestStop, approveTask } from '../lib/runner.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HELP = `carry — Claude Carry CLI

Queue:
  carry add "<prompt>" [--goal "<condition>"] [--cwd <path>]
                    [--model haiku|sonnet|opus] [--budget <usd>]
                    [--worktree | --isolation worktree|infolder]
                          queue a task (cwd defaults to current directory;
                          model defaults to sonnet — haiku for trivial,
                          opus for hard; budget caps that task's spend).
                          By default work lands on branch carry/<id> in
                          your project folder (visible in Source Control);
                          --worktree runs it in an isolated git worktree.
  carry adopt --session <id> [--cwd <path>] [--at <iso|+5h|+90m>]
           [--continue "<what to keep doing>"] [--model <m>]
                          adopt a session you started yourself so Claude Carry
                          CONTINUES IT in place after your usage limit resets
                          (default --at = +5h). Runs on your own branch (no
                          carry/<id>). Auto-starts a background runner that
                          resumes it at the reset (+ arms an OS wake for sleep)
                          then exits. Continues HEADLESSLY, not in your window.
                          Cancel: carry rm <id>.
  carry list | carry status | carry ls   show the queue
  carry move <id> up|down|top|bottom
  carry rm <id>              remove a task (not while running)
  carry pause | carry unpause   pause/resume dispatching (current task finishes)

Run:
  carry run                  start the night shift (foreground; Ctrl+C anytime —
                          everything is resumable)
  carry run --once           process a single task, then exit
  carry run --until-idle     process tasks until the queue is empty, then exit
  carry run --drain          wait for a due/scheduled task, run it, then exit
  carry run --no-wake        skip OS wake/logon scheduling (rely on the live loop)
  carry stop <id>            safe-stop a running task (becomes resumable)
  carry logs <id>            show a task's event log
  carry parked               list tasks parked for your approval + what they wanted
  carry approve <id>         approve a parked task's blocked action(s) and resume it
  carry guardrails           show the allow/deny safety rules in effect

Morning:
  carry report               write/print the morning summary (what happened, what
                          needs a decision, which branch to review)
  carry handoff              write/print the morning HANDOFF for a new session:
                          done work to bring in + a to-do list of what Claude Carry
                          couldn't do unattended (approvals, blocked actions, fails)
  carry cleanup [--all]      remove finished tasks' git worktrees (--all also drops
                          their queue entries)

VS Code:
  carry install-vscode [--cwd <dir>]
                          add a .vscode/tasks.json so Claude Carry runs from the
                          Command Palette in the target project
  carry wake-test [--in <s>] schedule a PC-wake in <s>s (default 120) to prove
                          sleep->wake->run works; then sleep the machine
  carry unwake               remove a pending scheduled wake

Health:
  carry doctor [--smoke]     check the whole chain (--smoke = one tiny real
                          claude call, ~<$0.01)

Queue file: ${QUEUE_FILE}
`;

const STATUS_COLOR = {
  pending: (s) => s,
  running: (s) => `\x1b[36m${s}\x1b[0m`,
  waiting: (s) => `\x1b[33m${s}\x1b[0m`,
  parked: (s) => `\x1b[35m${s}\x1b[0m`,
  'needs-approval': (s) => `\x1b[35m${s}\x1b[0m`,
  done: (s) => `\x1b[32m${s}\x1b[0m`,
  failed: (s) => `\x1b[31m${s}\x1b[0m`,
};

function flag(args, name) {
  const i = args.indexOf(name);
  if (i < 0) return null;
  const val = args[i + 1];
  args.splice(i, 2);
  return val;
}

// parse a reset time for `carry adopt --at`: ISO-8601, OR relative +<n>h / +<n>m,
// OR omitted -> default to 5 hours out (the common five-hour usage window).
function parseAt(s) {
  if (!s) return new Date(Date.now() + 5 * 3600_000).toISOString();
  const rel = String(s).match(/^\+(\d+)\s*([hm])$/i);
  if (rel) {
    const ms = Number(rel[1]) * (rel[2].toLowerCase() === 'h' ? 3600_000 : 60_000);
    return new Date(Date.now() + ms).toISOString();
  }
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new Error(`--at must be ISO-8601 or +<n>h / +<n>m, got "${s}"`);
  return new Date(t).toISOString();
}

function printStatus(q) {
  if (q.paused) console.log('\x1b[33m⏸ queue is PAUSED — carry unpause to continue\x1b[0m');
  if (q.tasks.length === 0) {
    console.log(`queue is empty — carry add "<prompt>" to queue a task`);
    return;
  }
  const idW = Math.max(...q.tasks.map((t) => t.id.length), 2);
  for (const t of q.tasks) {
    const status = STATUS_COLOR[t.status]?.(t.status.padEnd(14)) ?? t.status.padEnd(14);
    const cost = t.cost_usd ? `$${t.cost_usd.toFixed(2)}` : '';
    const extra =
      t.status === 'waiting' && t.resume_at
        ? `resumes ${new Date(t.resume_at).toLocaleString()}`
        : t.status === 'parked' || t.status === 'needs-approval'
          ? (t.parked_reason || '').slice(0, 40)
          : '';
    const prompt = t.prompt.length > 60 ? t.prompt.slice(0, 57) + '...' : t.prompt;
    console.log(`${t.id.padEnd(idW)}  ${status}  ${cost.padEnd(7)} ${prompt}${extra ? `  [${extra}]` : ''}`);
  }
}

const [, , cmd, ...args] = process.argv;

try {
  switch (cmd) {
    case 'add': {
      const goal = flag(args, '--goal');
      const cwd = flag(args, '--cwd') || process.cwd();
      const model = flag(args, '--model');
      const budgetStr = flag(args, '--budget');
      const planFirst = args.includes('--plan');
      if (planFirst) args.splice(args.indexOf('--plan'), 1);
      // isolation: default (in-folder) works on branch carry/<id> in the
      // project itself; --worktree (or --isolation worktree) keeps the old
      // isolated-worktree behavior, for parallel/same-repo runs.
      const isoFlag = flag(args, '--isolation');
      const worktreeBool = args.includes('--worktree');
      if (worktreeBool) args.splice(args.indexOf('--worktree'), 1);
      const isolation = isoFlag || (worktreeBool ? 'worktree' : null);
      if (isolation && isolation !== 'worktree' && isolation !== 'infolder')
        throw new Error(`--isolation must be worktree|infolder, got "${isolation}"`);
      const max_budget_usd = budgetStr != null ? Number(budgetStr) : null;
      if (budgetStr != null && !Number.isFinite(max_budget_usd)) throw new Error(`--budget must be a number, got "${budgetStr}"`);
      const prompt = args.join(' ');
      const q = loadQueue();
      const task = addTask(q, { prompt, goal, cwd });
      if (model) task.model = model;
      if (max_budget_usd != null) task.max_budget_usd = max_budget_usd;
      if (planFirst) task.plan_first = true;
      if (isolation) task.isolation = isolation;
      saveQueue(q);
      console.log(
        `queued ${task.id}: ${task.prompt.slice(0, 70)}` +
          `${task.goal ? `\n  done when: ${task.goal}` : ''}` +
          `\n  model: ${task.model || 'sonnet (default)'}${task.max_budget_usd != null ? `  budget: $${task.max_budget_usd}` : ''}${task.plan_first ? '  [plan-first: will park a plan for approval]' : ''}` +
          `\n  work: ${task.isolation === 'worktree' ? 'isolated git worktree' : `branch carry/${task.id} in your project (shows in Source Control)`}` +
          `\n  in: ${task.cwd}`
      );
      break;
    }
    case 'adopt': {
      // Adopt an EXISTING session you started yourself (interactively) so Claude Carry
      // continues IT in place after your usage limit resets — no separate headless
      // run to land. Reuses the same waiting->resume_at->wake->--resume machinery a
      // limited task already uses; isolation:'none' keeps it on your own branch.
      const session = flag(args, '--session');
      const cwd = flag(args, '--cwd') || process.cwd();
      const atStr = flag(args, '--at');
      const continueInstr = flag(args, '--continue');
      const model = flag(args, '--model');
      if (!session) throw new Error('carry adopt needs --session <id> (the session to continue)');
      const resume_at = parseAt(atStr);
      const q = loadQueue();
      const task = addTask(q, { prompt: `adopt: continue session ${session}`, cwd });
      task.session_id = session;
      task.status = 'waiting';
      task.resume_at = resume_at;
      task.isolation = 'none'; // run in place on YOUR current branch — never create carry/<id>
      if (continueInstr) task.continue_instruction = continueInstr;
      if (model) task.model = model;
      saveQueue(q);
      // Spawn a DETACHED `carry run --drain` so the resume actually fires: its
      // wall-clock loop resumes the task the moment resume_at passes (no dependence
      // on a scheduled wake while the PC is awake — that was the real failure mode),
      // then exits once drained. If a runner is already active it simply no-ops on
      // the runner lock. That detached runner also arms the OS wake (asleep backup)
      // from its own normal process context, where Register-ScheduledTask works.
      const carryMjs = fileURLToPath(import.meta.url); // this file (bin/carry.mjs)
      let watcher = false;
      try {
        const child = spawn(process.execPath, [carryMjs, 'run', '--drain'], {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        });
        child.on('error', () => {});
        child.unref();
        watcher = true;
      } catch {
        /* best-effort: if spawn fails, the user can still start `carry run` manually */
      }
      console.log(
        `adopted ${task.id}: will continue session ${session}` +
          `\n  at: ${new Date(resume_at).toLocaleString()}` +
          `\n  continue: ${continueInstr || '(generic "pick up exactly where you left off")'}` +
          `\n  in: ${cwd}` +
          (watcher
            ? `\n  watcher: a background runner is now waiting for the reset — it resumes the task, then exits.`
            : `\n  watcher: could not auto-start — run \`carry run\` yourself so the task resumes at the reset.`) +
          `\n  cancel:  carry rm ${task.id}` +
          `\n  NOTE: it continues HEADLESSLY (a background \`claude --resume\`, not your open window) and under Claude Carry guardrails (parks for approval on anything outside the safe set).`
      );
      break;
    }
    case 'list':
    case 'ls':
    case 'status': {
      printStatus(loadQueue());
      break;
    }
    case 'move': {
      const [id, where] = args;
      const q = loadQueue();
      moveTask(q, id, where);
      saveQueue(q);
      printStatus(q);
      break;
    }
    case 'rm': {
      const q = loadQueue();
      const task = removeTask(q, args[0]);
      saveQueue(q);
      console.log(`removed ${task.id}: ${task.prompt.slice(0, 70)}`);
      break;
    }
    case 'pause':
    case 'unpause': {
      const q = loadQueue();
      q.paused = cmd === 'pause';
      saveQueue(q);
      console.log(q.paused ? 'queue paused (current task will finish)' : 'queue unpaused');
      break;
    }
    case 'show': {
      console.log(JSON.stringify(findTask(loadQueue(), args[0]), null, 2));
      break;
    }
    case 'run': {
      await runLoop({ once: args.includes('--once'), untilIdle: args.includes('--until-idle'), drain: args.includes('--drain'), noWake: args.includes('--no-wake') });
      break;
    }
    case 'stop': {
      console.log(requestStop(args[0]));
      break;
    }
    case 'parked': {
      const q = loadQueue();
      const parked = q.tasks.filter((t) => t.status === 'needs-approval');
      if (!parked.length) {
        console.log('nothing parked for approval');
        break;
      }
      for (const t of parked) {
        console.log(`\x1b[35m${t.id}\x1b[0m  ${t.prompt.slice(0, 60)}`);
        for (const d of (t.parked_calls || []).filter((x) => x.kind === 'dontask')) {
          console.log(`   would run ${d.tool}: ${JSON.stringify(d.input)}`);
        }
        console.log(`   -> carry approve ${t.id}   (or  carry rm ${t.id}  to drop it)`);
      }
      break;
    }
    case 'approve': {
      const r = approveTask(args[0]);
      if (r.plan) {
        console.log(`approved plan for ${r.id} — will execute on the next run (resumes its session)`);
      } else {
        console.log(
          `approved ${r.id}: granted ${r.granted.length} action(s)\n` +
            (r.resumes ? '  will resume its session on the next run' : '  will re-run on the next run') +
            `\n  granted: ${r.granted.join(', ') || '(none)'}`
        );
      }
      break;
    }
    case 'plan': {
      const file = join(STATE_DIR, 'plans', `${args[0]}.md`);
      if (!existsSync(file)) throw new Error(`no saved plan for ${args[0]}`);
      console.log(readFileSync(file, 'utf8'));
      break;
    }
    case 'wake-test': {
      // schedule a wake N seconds out (default 120) that writes a proof file,
      // so you can sleep the PC and confirm it wakes itself and runs.
      const { scheduleWake } = await import('../lib/wake.mjs');
      const secs = Number(flag(args, '--in') || 120);
      const proof = join(LOGS_DIR, 'wake-proof.txt');
      const at = new Date(Date.now() + secs * 1000);
      const cmd = `Set-Content -Path '${proof}' -Value (Get-Date -Format o)`;
      const r = scheduleWake(at.toISOString(), cmd);
      console.log(
        r.ok
          ? `wake scheduled for ${at.toLocaleTimeString()} (${secs}s). Sleep the PC now;\nafter it wakes, check: ${proof}`
          : `failed to schedule wake: ${r.output}`
      );
      break;
    }
    case 'unwake': {
      const { removeWake } = await import('../lib/wake.mjs');
      console.log(removeWake().ok ? 'removed pending wake task' : 'no wake task to remove');
      break;
    }
    case 'logs': {
      const file = join(LOGS_DIR, `${args[0]}.ndjson`);
      if (!existsSync(file)) throw new Error(`no log for ${args[0]} yet`);
      for (const line of readFileSync(file, 'utf8').trim().split('\n').slice(-30)) {
        let evt;
        try {
          evt = JSON.parse(line);
        } catch {
          continue;
        }
        const text =
          evt.type === 'assistant'
            ? (evt.message?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join(' ')
            : evt.type === 'result'
              ? `${evt.subtype} (cost $${evt.total_cost_usd ?? '?'})`
              : evt.subtype || evt.text || '';
        console.log(`${evt.type.padEnd(10)} ${String(text).slice(0, 110)}`);
      }
      console.log(`\nfull log: ${file}`);
      break;
    }
    case 'report': {
      const { writeReport } = await import('../lib/report.mjs');
      const { file, md } = writeReport();
      console.log(md);
      console.log(`\n(written to ${file})`);
      break;
    }
    case 'handoff': {
      // the morning briefing for a NEW session: what's done to bring in, plus the
      // to-do list of what Claude Carry couldn't do unattended.
      const { writeHandoff } = await import('../lib/handoff.mjs');
      const { file, md } = writeHandoff();
      console.log(md);
      console.log(`\n(written to ${file})`);
      break;
    }
    case 'cleanup': {
      const { cleanup } = await import('../lib/cleanup.mjs');
      const results = cleanup({ all: args.includes('--all'), id: flag(args, '--id') });
      if (!results.length) console.log('nothing to clean (no finished tasks with worktrees)');
      for (const r of results) console.log(`${r.id}: ${r.result}`);
      break;
    }
    case 'guardrails': {
      const { effectiveRules } = await import('../lib/guardrails.mjs');
      const { loadConfig } = await import('../lib/sentinel.mjs');
      const { allow, deny } = effectiveRules(loadConfig());
      console.log('\x1b[36mALLOW\x1b[0m (run without prompting):');
      for (const r of allow) console.log('  ' + r);
      console.log('\x1b[31mDENY\x1b[0m (hard floor — never, even if allowed):');
      for (const r of deny) console.log('  ' + r);
      console.log('\nEverything else is auto-denied (dontAsk) and parked for your approval.');
      break;
    }
    case 'budget': {
      const { budgetGate, loadConfig, monthSpend, nextMonthlyRefresh } = await import('../lib/sentinel.mjs');
      const cfg = loadConfig();
      const gate = budgetGate();
      console.log(`monthly Agent SDK credit: $${cfg.monthly_credit_usd} (park at ${cfg.park_threshold * 100}%)`);
      console.log(`month-to-date spend (client-side estimate): $${monthSpend().toFixed(2)}`);
      console.log(`next refresh: ${new Date(nextMonthlyRefresh(cfg)).toLocaleString()}`);
      console.log(gate.ok ? '\x1b[32mdispatch: CLEAR\x1b[0m' : `\x1b[33mdispatch: PARKED — ${gate.reason}\x1b[0m`);
      break;
    }
    case 'install-vscode': {
      const { installVscode } = await import('../lib/vscode.mjs');
      const target = flag(args, '--cwd') || process.cwd();
      const r = installVscode(target);
      console.log(`wrote ${r.wrote}`);
      if (r.note) console.log(`note: ${r.note}`);
      else console.log('open this folder in VS Code, then Ctrl+Shift+P -> Tasks: Run Task -> Claude Carry: ...');
      break;
    }
    case 'doctor': {
      const ok = await doctor({ smoke: args.includes('--smoke') });
      process.exit(ok ? 0 : 1);
    }
    case '--help':
    case '-h':
    case 'help':
    case undefined:
      console.log(HELP);
      break;
    default:
      console.error(`Unknown command: ${cmd}\n`);
      console.log(HELP);
      process.exit(1);
  }
} catch (e) {
  console.error(`\x1b[31merror:\x1b[0m ${e.message}`);
  process.exit(1);
}
