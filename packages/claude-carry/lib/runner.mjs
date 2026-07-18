// night-runner — the supervisor loop. Pops the next actionable task, runs it
// as headless Claude Code (stream-json), persists the session_id the moment it
// is born, and on any interruption resumes the SAME conversation later.
//
// Design rules (from the research):
// - never parse UI text; only stream-json events
// - persist state to disk at every transition (a crash anywhere is recoverable)
// - wall-clock recheck loop, never one long timer (Windows sleep breaks timers)
// - unknown event types/enum values are logged, never fatal

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, appendFileSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadQueue,
  saveQueue,
  findTask,
  updateTask,
  acquireLock,
  releaseLock,
  logRun,
  STATE_DIR,
  LOGS_DIR,
} from './store.mjs';
import { findClaude, withClaudePath } from './doctor.mjs';
import { classify, budgetGate, loadConfig, resolveTaskBudget } from './sentinel.mjs';
import { scheduleWake, removeWake, scheduleLogonRecovery, keepAwakeFor } from './wake.mjs';
import { guardrailArgs, detectDenials } from './guardrails.mjs';
import { writeReport } from './report.mjs';
import { writeHandoff } from './handoff.mjs';
import { estimateUsd } from './pricing.mjs';
import {
  currentBranch,
  hasCommits,
  isDirty,
  branchExists,
  checkoutNew,
  checkout,
  commitAll,
  stashPush,
} from './git.mjs';

const POLL_MS = 10_000;
const OWNER = `runner:${process.pid}`;
const RUNNER_PID_FILE = join(STATE_DIR, 'runner.pid');

// the command Windows Task Scheduler runs to wake the PC and restart the runner
// (exported so `carry adopt` can arm the same wake when no runner is up yet)
export function runnerCmd() {
  if (process.env.CARRY_RUNNER_CMD) return process.env.CARRY_RUNNER_CMD;
  const carry = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'carry.mjs');
  return `& '${process.execPath}' '${carry}' run`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stopMarker = (id) => join(STATE_DIR, `stop-${id}`);

// CARRY_CLAUDE=<path to .mjs> swaps in the test stub (test/fake-claude.mjs)
export function claudeCommand() {
  if (process.env.CARRY_CLAUDE) {
    return { cmd: process.execPath, baseArgs: [process.env.CARRY_CLAUDE] };
  }
  const path = findClaude();
  if (!path) throw new Error('claude CLI not found — run ./setup.ps1');
  return { cmd: path, baseArgs: [] };
}

function isGitRepo(cwd) {
  return existsSync(join(cwd, '.git'));
}

// How a task is isolated:
//   'worktree' — opt-in (task.isolation==='worktree'): claude runs in a hidden
//                git worktree, exactly as before. Reserved for parallel/same-repo
//                runs where two branches can't share one checkout.
//   'infolder' — DEFAULT for a git repo: the runner works on branch
//                carry/<id> in the project's MAIN checkout, so the session
//                and the branch are natively visible in VS Code.
//   'none'     — cwd isn't a git repo, OR explicit task.isolation==='none' (an
//                ADOPTED live session): just run there, no branch lifecycle, so
//                the continuation stays on the user's own current branch.
function isolationMode(task) {
  if (task.isolation === 'worktree') return 'worktree';
  if (task.isolation === 'none') return 'none';
  return isGitRepo(task.cwd) ? 'infolder' : 'none';
}

// in-folder FIRST dispatch: put the project's main checkout on branch
// carry/<id> so the run — and its session transcript — land natively in the
// project (visible in Source Control + the Claude panel). Mutates q but does NOT
// save; the caller persists base_branch/branch before spawn (crash-safety).
// Returns { ok } or { park, reason } when there's no safe branch to work from.
function prepareInFolder(q, taskId) {
  const task = findTask(q, taskId);
  const cwd = task.cwd;
  // empty repo (no commits yet): nothing to branch from — run in place.
  if (!hasCommits(cwd)) {
    logRun({ event: 'infolder-no-commits', task: taskId });
    return { ok: true };
  }
  const cur = currentBranch(cwd);
  if (!cur) {
    // detached HEAD: no branch to return to — don't guess, surface it.
    return { park: true, reason: 'detached HEAD — check out a branch in this project, then re-queue' };
  }
  const branch = `carry/${task.id}`;
  // never capture the carry branch itself as "base" (re-entry after a crash
  // between checkout and persist); keep any base we already recorded.
  const base = cur === branch ? task.base_branch : cur;
  const dirty = isDirty(cwd);
  if (branchExists(cwd, branch)) checkout(cwd, branch);
  else checkoutNew(cwd, branch);
  const patch = { base_branch: base, branch };
  // dirty tree → carry the user's uncommitted work onto the branch as a baseline
  // commit (their base branch stays clean; nothing is lost; report surfaces it).
  if (dirty) {
    const r = commitAll(cwd, `carry: baseline for ${task.id} — carried your uncommitted work`);
    if (r.ok) patch.baseline_commit = r.sha;
    // loud, non-blocking heads-up: the target repo had uncommitted work, which
    // is now tucked onto the branch (the report surfaces it too). If this wasn't
    // intended, --worktree isolates instead of touching the main checkout.
    console.warn(`⚠ ${cwd}\n  had uncommitted changes — carried them onto ${branch} as baseline ${(r.sha || '').slice(0, 7)} (review before landing; use --worktree to isolate).`);
    logRun({ event: 'infolder-baseline-warning', task: taskId, branch, baseline: r.sha || null });
  }
  updateTask(q, taskId, patch);
  logRun({ event: 'infolder-prepared', task: taskId, branch, base_branch: base, baseline: patch.baseline_commit || null });
  return { ok: true };
}

// in-folder RESUME (after a crash/stop): the checkout may be on another branch
// (we return to base on every close, and other tasks may have run since). Stash
// any stray changes (never destroy) and re-checkout this task's own branch so the
// resumed session continues on its own work. Mutates q, does not save.
function resumeInFolder(q, taskId) {
  const task = findTask(q, taskId);
  const cwd = task.cwd;
  if (!task.branch) return prepareInFolder(q, taskId); // pre-feature/empty-repo fallback
  if (isDirty(cwd)) stashPush(cwd, `carry pre-resume ${taskId}`);
  if (branchExists(cwd, task.branch)) {
    checkout(cwd, task.branch);
  } else {
    checkoutNew(cwd, task.branch); // branch vanished — recreate so work continues
    logRun({ event: 'infolder-branch-recreated', task: taskId, branch: task.branch });
  }
  return { ok: true };
}

// in-folder CLOSE: commit the night's work onto carry/<id> (so the branch
// holds it and the tree is clean), then return the checkout to the user's base
// branch — morning view is their normal branch, and the next sequential task can
// branch off base cleanly. Mutates q (caller saves). Best-effort: a git hiccup
// here must never crash the supervisor.
function finalizeInFolder(q, taskId, status) {
  const task = findTask(q, taskId);
  const cwd = task.cwd;
  if (!task.branch) return; // empty-repo skip or never prepared — nothing to do
  const patch = {};
  // if claude already committed, the tree is clean → no double commit.
  if (isDirty(cwd)) {
    const r = commitAll(cwd, `carry: ${task.id} checkpoint (${status}) — ${task.prompt.slice(0, 60)}`);
    if (r.ok) patch.checkpoint_commit = r.sha;
  }
  let returned = false;
  if (task.base_branch) returned = checkout(cwd, task.base_branch).ok;
  if (Object.keys(patch).length) updateTask(q, taskId, patch);
  logRun({ event: 'infolder-finalized', task: taskId, branch: task.branch, returned_to_base: returned, checkpoint: patch.checkpoint_commit || null });
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// One runner at a time: a second instance would double-dispatch tasks.
function takeRunnerLock() {
  mkdirSync(STATE_DIR, { recursive: true });
  if (existsSync(RUNNER_PID_FILE)) {
    const oldPid = Number(readFileSync(RUNNER_PID_FILE, 'utf8').trim());
    if (oldPid && oldPid !== process.pid && pidAlive(oldPid)) {
      throw new Error(`another runner is already active (pid ${oldPid})`);
    }
  }
  writeFileSync(RUNNER_PID_FILE, String(process.pid));
}

// Startup reconcile: tasks stuck in 'running' whose runner died are flipped
// back to pending — their session_id is intact, so dispatch resumes them.
export function reconcile() {
  const q = loadQueue();
  let fixed = 0;
  for (const t of q.tasks) {
    if (t.status === 'running' && !pidAlive(t.lock?.pid)) {
      t.status = 'pending';
      t.lock = null;
      t.retries += 1;
      fixed++;
      logRun({ event: 'reconciled', task: t.id, session_id: t.session_id });
    }
  }
  if (fixed) saveQueue(q);
  return fixed;
}

// pull the plan out of a plan-mode run: prefer the ExitPlanMode tool input,
// fall back to concatenated assistant text.
function extractPlan(events) {
  let text = '';
  for (const e of events) {
    const content = e?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (c.type === 'tool_use' && /ExitPlanMode/i.test(c.name || '') && c.input?.plan) return c.input.plan;
      if (c.type === 'text' && c.text) text += c.text + '\n';
    }
  }
  return text.trim();
}

function isActionable(t) {
  return (
    t.status === 'pending' ||
    (t.status === 'waiting' && t.resume_at && Date.parse(t.resume_at) <= Date.now())
  );
}

// Can this task START now given what's already running? An in-folder task needs
// exclusive use of its project's main checkout, so it must wait if another
// in-folder task is running in the same cwd. Worktree/none tasks have their own
// checkout (or no git), so they never conflict on the shared tree.
function canStart(q, task) {
  if (isolationMode(task) !== 'infolder') return true;
  return !q.tasks.some(
    (t) => t.status === 'running' && t.cwd === task.cwd && isolationMode(t) === 'infolder'
  );
}

// The next task that is both actionable AND safe to start right now (used to fill
// concurrency slots). Dispatched tasks flip to 'running' synchronously, so a
// fresh loadQueue between fills naturally excludes them.
function nextDispatchable(q) {
  return q.tasks.find((t) => isActionable(t) && canStart(q, t));
}

function buildArgs(task, isResume) {
  const { cmd, baseArgs } = claudeCommand();
  const cfg = loadConfig();
  const prompt = isResume
    ? task.continue_instruction || 'Continue the task exactly where it left off.'
    : task.goal
      ? `${task.prompt}\n\n/goal ${task.goal}`
      : task.prompt;
  // plan-first phase 1 runs READ-ONLY (plan mode) to produce a plan to approve;
  // after approval plan_first is cleared, so the execute run uses dontAsk
  const mode = task.plan_first && !isResume ? 'plan' : 'dontAsk';
  const args = [
    ...baseArgs,
    '-p',
    prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    mode,
  ];
  // model: per-task override, else config default (sonnet). Resume keeps the
  // task's own model so a conversation never switches models mid-flight.
  const model = task.model || cfg.default_model;
  if (model) args.push('--model', model);
  // per-task spend ceiling: claude -p ends with result subtype error_max_budget_usd
  const budget = task.max_budget_usd ?? resolveTaskBudget(model, cfg);
  if (budget != null) args.push('--max-budget-usd', String(budget));
  if (isResume) args.push('--resume', task.session_id);
  // worktree mode ONLY: claude isolates the run in <cwd>/.claude/worktrees/<name>
  // (the same name is reused on resume). In-folder mode (default) passes no
  // --worktree — the runner owns the branch and the run happens in the project
  // itself, so the session files under the project and shows in its Claude panel.
  // (Trust is a non-issue either way: -p mode disables the folder-trust dialog.)
  if (isolationMode(task) === 'worktree') {
    args.push('--worktree', task.worktree || `task-${task.id}`);
  }
  // guardrails LAST: --allowedTools/--disallowedTools are variadic and would
  // swallow any flag placed after them. task.allow_extra carries per-task grants
  // from `carry approve`.
  args.push(...guardrailArgs(cfg, task.allow_extra || []));
  return { cmd, args };
}

export function dispatch(taskId) {
  return new Promise((resolve) => {
    let q = loadQueue();
    let task = findTask(q, taskId);
    const isResume = !!task.session_id;
    const mode = isolationMode(task);
    const costBaseline = task.cost_usd || 0; // cost from prior segments; this run adds to it

    acquireLock(q, taskId, OWNER);
    const patch = { status: 'running' };
    // worktree mode: name the worktree on first dispatch (reused on resume).
    // in-folder mode manages a branch instead (prepare/finalize, below).
    if (mode === 'worktree' && !task.worktree) patch.worktree = `task-${task.id}`;
    updateTask(q, taskId, patch);

    // in-folder mode owns the git branch: create it (first run) or re-checkout it
    // (resume). A detached HEAD has no safe base → park instead of guessing.
    if (mode === 'infolder') {
      const prep = isResume ? resumeInFolder(q, taskId) : prepareInFolder(q, taskId);
      if (prep.park) {
        updateTask(q, taskId, { status: 'needs-approval', parked_reason: prep.reason });
        releaseLock(q, taskId, OWNER);
        saveQueue(q);
        logRun({ event: 'parked', task: taskId, reason: prep.reason });
        resolve('needs-approval');
        return;
      }
    }
    task = findTask(q, taskId);
    saveQueue(q); // base_branch/branch now persisted before spawn (crash-safe)
    logRun({ event: isResume ? 'resume' : 'start', task: taskId, session_id: task.session_id });

    const { cmd, args } = buildArgs(task, isResume);
    mkdirSync(LOGS_DIR, { recursive: true });
    const logFile = join(LOGS_DIR, `${taskId}.ndjson`);

    const child = spawn(cmd, args, {
      cwd: task.cwd,
      env: { ...withClaudePath(), DISABLE_AUTOUPDATER: '1' },
      // stdin = ignore (/dev/null): headless tasks never read stdin, and an open
      // pipe makes claude wait 3s per task for input that never arrives
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // persist the child pid so `carry stop` can target it
    q = loadQueue();
    const lockTask = findTask(q, taskId);
    if (lockTask.lock) lockTask.lock.pid = child.pid;
    saveQueue(q);

    // hold the PC awake while this task runs; point the helper at the claude
    // process so it self-releases when the task exits (belt-and-braces: we also
    // kill it on close), and never outlives the task. Skipped under the test
    // stub so the suite doesn't spawn real PowerShell keep-awake processes.
    const awake = process.env.CARRY_CLAUDE ? null : keepAwakeFor(child.pid);

    const events = [];
    let resultEvent = null;
    let stderrText = '';
    let buf = '';
    // incremental cost: accumulate streamed token usage so a task killed BEFORE
    // its `result` event (which carries the authoritative total_cost_usd) still
    // shows a ballpark estimate on disk instead of $0. The result overrides it.
    const usageAcc = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    let segEst = 0;
    let runModel = task.model; // refined from the init event's model id
    let lastUsageLine = null;
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        appendFileSync(logFile, line + '\n');
        let evt;
        try {
          evt = JSON.parse(line);
        } catch {
          continue; // defensive: schema drifts faster than docs
        }
        events.push(evt);
        if (evt.type === 'system' && evt.subtype === 'init') {
          if (evt.model) runModel = evt.model;
          if (evt.session_id) {
            // THE critical write: with the session_id on disk, any crash from
            // this instant onward is recoverable via --resume
            const q2 = loadQueue();
            updateTask(q2, taskId, { session_id: evt.session_id });
            saveQueue(q2);
          }
        }
        // accumulate token usage from assistant events (deduping the back-to-back
        // duplicate the stream emits) and persist a running cost estimate.
        const usage = evt.type === 'assistant' ? evt.message?.usage : null;
        if (usage && line !== lastUsageLine) {
          lastUsageLine = line;
          usageAcc.input_tokens += usage.input_tokens || 0;
          usageAcc.output_tokens += usage.output_tokens || 0;
          usageAcc.cache_read_input_tokens += usage.cache_read_input_tokens || 0;
          usageAcc.cache_creation_input_tokens += usage.cache_creation_input_tokens || 0;
          segEst = estimateUsd(runModel, usageAcc);
          const q2 = loadQueue();
          updateTask(q2, taskId, { cost_usd: costBaseline + segEst, cost_estimated: true });
          saveQueue(q2);
        }
        if (evt.type === 'result') resultEvent = evt;
      }
    });
    child.stderr.on('data', (chunk) => {
      stderrText += String(chunk).slice(0, 4000);
      appendFileSync(logFile, JSON.stringify({ type: 'stderr', text: String(chunk).slice(0, 2000) }) + '\n');
    });

    child.on('close', (code) => {
      if (awake && !awake.killed) awake.kill(); // release the keep-awake lock
      const q2 = loadQueue();
      const t2 = findTask(q2, taskId);
      const stopped = existsSync(stopMarker(taskId));
      if (stopped) rmSync(stopMarker(taskId), { force: true });

      // the sentinel owns ALL stop classification (limit -> waiting+resume_at,
      // billing -> parked, etc.); a user-requested stop overrides it
      const verdict = stopped
        ? { status: 'pending', reason: 'stopped by user — resumable', resume_at: null }
        : classify(events, { code, stderrText });

      // parking: if the run hit a GRAY-ZONE denial (dontAsk blocked an action you
      // could approve), surface it for morning review instead of a silent
      // done/failed. Hard-deny attempts are recorded too, but never reopen the
      // never-allow list. Limit/billing verdicts take priority (those resume).
      const denials = detectDenials(events);
      const grayParks = denials.filter((d) => d.kind === 'dontask');
      let { status, reason, resume_at } = verdict;
      // plan-first: a completed plan phase parks for review (the plan is saved)
      if (task.plan_first && !stopped && status === 'done') {
        const planText = extractPlan(events);
        if (planText) {
          mkdirSync(join(STATE_DIR, 'plans'), { recursive: true });
          writeFileSync(join(STATE_DIR, 'plans', `${taskId}.md`), planText);
        }
        status = 'needs-approval';
        reason = `plan ready — review then: carry approve ${taskId}`;
        resume_at = null;
      } else if (!stopped && grayParks.length && (status === 'done' || status === 'failed')) {
        status = 'needs-approval';
        reason = `parked: ${grayParks.length} action(s) need approval — e.g. ${grayParks[0].tool}: ${JSON.stringify(grayParks[0].input).slice(0, 60)}`;
        resume_at = null;
      }

      updateTask(q2, taskId, {
        status,
        parked_reason: reason,
        resume_at,
        parked_calls: denials,
        // authoritative cost from the result event when present; else the
        // streamed estimate (task killed before result). costBaseline carries
        // prior segments so resumes accumulate correctly without double-counting.
        cost_usd: costBaseline + (resultEvent?.total_cost_usd ?? segEst),
        cost_estimated: resultEvent?.total_cost_usd == null && segEst > 0,
        // the agent's own closing summary — what it did / what it couldn't —
        // surfaced in the morning handoff so a new session knows what's left.
        result_summary: resultEvent?.result ? String(resultEvent.result).slice(0, 500) : t2.result_summary,
        retries: status === 'failed' ? t2.retries + 1 : t2.retries,
      });
      // in-folder: checkpoint the night's work onto carry/<id> and return
      // the checkout to the user's base branch (after the status persist above,
      // so crash-safety is preserved). No-op in worktree/none modes.
      if (mode === 'infolder') finalizeInFolder(q2, taskId, status);
      releaseLock(q2, taskId, OWNER);
      saveQueue(q2);
      logRun({
        event: 'closed',
        task: taskId,
        status,
        reason,
        resume_at,
        denials: denials.length,
        code,
        subtype: resultEvent?.subtype ?? null,
        cost: resultEvent?.total_cost_usd ?? 0,
      });
      resolve(status);
    });

    child.on('error', (e) => {
      const q2 = loadQueue();
      updateTask(q2, taskId, { status: 'failed', parked_reason: `spawn error: ${e.message}` });
      // claude never ran (tree unchanged) — just return to base for a clean morning
      if (mode === 'infolder') finalizeInFolder(q2, taskId, 'failed');
      releaseLock(q2, taskId, OWNER);
      saveQueue(q2);
      resolve('failed');
    });
  });
}

export async function runLoop({ once = false, untilIdle = false, drain = false, noWake = false } = {}) {
  takeRunnerLock();
  const fixed = reconcile();
  if (fixed) console.log(`reconciled ${fixed} interrupted task(s) — will resume their sessions`);

  // --once always runs a single task; otherwise honor the configured concurrency.
  const concurrency = once ? 1 : Math.max(1, loadConfig().concurrency || 1);
  if (concurrency > 1) console.log(`concurrency: up to ${concurrency} tasks at once`);
  const wakeEnabled = !noWake && !once && !untilIdle && process.platform === 'win32';
  if (wakeEnabled) {
    const rec = scheduleLogonRecovery(runnerCmd());
    if (rec.ok) console.log('reboot recovery armed (runner restarts at next logon)');
  }

  let budgetWarned = false;
  let lastScheduledWake = null;
  let idleReported = false; // wrote report.md for the current idle stretch?
  let dispatchedOnce = false; // --once: stop filling after the first dispatch
  const inFlight = new Map(); // taskId -> Promise<status>; one entry per running dispatch

  for (;;) {
    let q = loadQueue();
    const budget = budgetGate();
    const gateClosed = q.paused || !budget.ok;
    if (!q.paused && !budget.ok && !budgetWarned) {
      console.log(`budget gate: ${budget.reason} — queue parks until ${budget.until}`);
      budgetWarned = true;
    }
    if (budget.ok) budgetWarned = false;

    // Fill free slots with tasks safe to start now (skip while the gate is closed
    // or, for --once, after the single task has been dispatched). dispatch() flips
    // a task to 'running' synchronously, so reloading q each pass excludes it.
    if (!gateClosed && !(once && dispatchedOnce)) {
      while (inFlight.size < concurrency) {
        q = loadQueue();
        const task = nextDispatchable(q);
        if (!task) break;
        if (wakeEnabled && lastScheduledWake !== null) {
          removeWake();
          lastScheduledWake = null;
        }
        idleReported = false; // activity → the next idle should refresh the report
        const id = task.id;
        console.log(`[${new Date().toLocaleTimeString()}] ${task.session_id ? 'resuming' : 'starting'} ${id}: ${task.prompt.slice(0, 60)}`);
        const p = dispatch(id).then((status) => {
          console.log(`[${new Date().toLocaleTimeString()}] ${id} -> ${status}`);
          inFlight.delete(id);
          return status;
        });
        inFlight.set(id, p);
        dispatchedOnce = true;
        if (once) break;
      }
    }

    // Something is running → wait for the next completion (or a poll tick to
    // re-check pause/budget/waiting), then loop to refill freed slots. Clear the
    // poll timer once a dispatch resolves: an uncleared 10s setTimeout keeps
    // Node's event loop alive, so without this the process lingers up to POLL_MS
    // after going idle before --once/--until-idle/--drain can actually exit.
    if (inFlight.size > 0) {
      let pollTimer;
      const tick = new Promise((r) => { pollTimer = setTimeout(r, POLL_MS); });
      await Promise.race([...inFlight.values(), tick]);
      clearTimeout(pollTimer);
      continue;
    }

    // Nothing in flight from here on.
    if (once && dispatchedOnce) {
      try { writeReport(); writeHandoff(); } catch {}
      return;
    }
    if (gateClosed) {
      if (once || untilIdle) return;
      await sleep(q.paused ? POLL_MS : POLL_MS * 6);
      continue;
    }

    // Truly idle: refresh the report once, then handle waiting/wake or exit.
    if (!idleReported) {
      try {
        const { file } = writeReport();
        writeHandoff();
        logRun({ event: 'report-written', reason: 'idle', file });
      } catch (e) {
        logRun({ event: 'report-failed', error: String(e).slice(0, 120) });
      }
      idleReported = true;
    }
    if (once || untilIdle) return;
    const waiting = q.tasks.filter((t) => t.status === 'waiting' && t.resume_at);
    // --drain: keep waiting (wall-clock) for tasks due on a future resume_at, but
    // EXIT once none remain — i.e. the adopted task has resumed and finished. This
    // is how `carry adopt` can spawn a runner that fires at the reset then bows out,
    // instead of lingering forever like the default night-shift loop.
    if (drain && waiting.length === 0) return;
    if (waiting.length) {
      const next = waiting.map((t) => Date.parse(t.resume_at)).sort((a, b) => a - b)[0];
      // schedule the OS to wake the PC at the next resume time (only when it
      // changes, to avoid re-registering every poll). The wall-clock loop
      // handles the awake case; this handles the asleep case.
      if (wakeEnabled && next !== lastScheduledWake) {
        const r = scheduleWake(new Date(next).toISOString(), runnerCmd());
        lastScheduledWake = next;
        console.log(`idle — wake scheduled for ${new Date(next).toLocaleString()}${r.ok ? '' : ' (scheduler failed; wall-clock loop still covers awake resume)'}`);
      } else {
        console.log(`idle — next wake ${new Date(next).toLocaleString()} (wall-clock recheck every ${POLL_MS / 1000}s)`);
      }
    }
    await sleep(POLL_MS);
  }
}

// approve a parked task: add the gray-zone actions it was blocked on to this
// task's own allowlist, clear the park, and set it pending so the runner resumes
// its SAME session and retries. Hard-deny (rule) attempts are never auto-approved.
export function approveTask(taskId) {
  const q = loadQueue();
  const task = findTask(q, taskId);
  if (task.status !== 'needs-approval') {
    throw new Error(`${taskId} is ${task.status}, not needs-approval`);
  }
  // plan-first approval: clear the plan flag so the resume runs in execute mode
  if (task.plan_first) {
    updateTask(q, taskId, { status: 'pending', parked_reason: null, plan_first: false });
    saveQueue(q);
    return { id: taskId, granted: [], plan: true, resumes: !!task.session_id };
  }
  const gray = (task.parked_calls || []).filter((d) => d.kind === 'dontask');
  // grant the specific tools that were blocked, scoped to this task. For shell
  // commands, allow the exact command; for tools, allow the tool.
  const grants = new Set(task.allow_extra || []);
  for (const d of gray) {
    if ((d.tool === 'Bash' || d.tool === 'PowerShell') && d.input?.command) {
      grants.add(`${d.tool}(${d.input.command})`);
    } else if (d.tool && d.tool !== 'unknown') {
      grants.add(d.tool);
    }
  }
  updateTask(q, taskId, {
    status: 'pending',
    parked_reason: null,
    allow_extra: [...grants],
  });
  saveQueue(q);
  return { id: taskId, granted: [...grants], resumes: !!task.session_id };
}

// safe-stop: marker file tells the close handler this exit was user-requested
export function requestStop(taskId) {
  const q = loadQueue();
  const task = findTask(q, taskId);
  if (task.status !== 'running') throw new Error(`${taskId} is not running (status: ${task.status})`);
  writeFileSync(stopMarker(taskId), new Date().toISOString());
  if (task.lock?.pid && pidAlive(task.lock.pid)) {
    process.kill(task.lock.pid);
    return `stop requested — ${taskId} will become resumable (session ${task.session_id || 'not yet issued'})`;
  }
  return `stop marker set, but no live process found for ${taskId}`;
}
