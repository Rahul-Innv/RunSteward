// queue-store — the single source of truth for Claude Carry.
//
// Everything lives in one human-readable queue.json (schema v1, FROZEN — the
// future VS Code panel and any other surface read this same file) plus an
// append-only runs.ndjson history. Writes are atomic: write a temp file, then
// rename over the original. A crash at any instant leaves either the old file
// or the new file — never a half-written one.

import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  appendFileSync,
  rmSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Windows replaces files with MoveFileEx, which fails transiently
// (EPERM/EACCES/EBUSY) when ANOTHER process holds the destination open for
// reading at that instant — e.g. `carry list`, the VS Code panel, or a test
// poller reading queue.json while the runner writes it. POSIX rename never hits
// this. Retry a few times with a tiny backoff so a concurrent reader can never
// crash the unattended runner. saveQueue/loadQueue are synchronous and called
// from async stream handlers, so the sleep must be synchronous too — Atomics.wait
// is a real sleep (no busy-spin) and is allowed on Node's main thread.
const TRANSIENT_FS = new Set(['EPERM', 'EACCES', 'EBUSY', 'EEXIST']);
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function fsRetry(op) {
  for (let i = 0; ; i++) {
    try {
      return op();
    } catch (e) {
      if (process.platform !== 'win32' || !TRANSIENT_FS.has(e.code) || i >= 10) throw e;
      sleepSync(Math.min(2 ** i, 128)); // 1,2,4,...,128,128 ms — ~0.7s worst case
    }
  }
}

// Central state for all projects (tasks carry their own cwd). Overridable for tests.
export const STATE_DIR = process.env.CARRY_HOME || join(homedir(), '.claude-carry');
export const QUEUE_FILE = join(STATE_DIR, 'queue.json');
export const RUNS_LOG = join(STATE_DIR, 'runs.ndjson');
export const LOGS_DIR = join(STATE_DIR, 'logs');

export const STATUSES = ['pending', 'running', 'waiting', 'parked', 'needs-approval', 'done', 'failed'];

const EMPTY = { version: 1, paused: false, nextId: 1, tasks: [] };

export function loadQueue() {
  if (!existsSync(QUEUE_FILE)) return structuredClone(EMPTY);
  // the rename in saveQueue is atomic, so a read always sees a whole file (old
  // or new) — only the OPEN can transiently fault while a writer renames over it.
  const q = JSON.parse(fsRetry(() => readFileSync(QUEUE_FILE, 'utf8')));
  if (q.version !== 1) {
    throw new Error(`queue.json schema version ${q.version} not supported (expected 1)`);
  }
  return q;
}

export function saveQueue(q) {
  mkdirSync(STATE_DIR, { recursive: true });
  const tmp = `${QUEUE_FILE}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(q, null, 2));
  try {
    fsRetry(() => renameSync(tmp, QUEUE_FILE)); // atomic replace; retried on Windows EPERM
  } catch (e) {
    rmSync(tmp, { force: true }); // don't leave a stray tmp behind on permanent failure
    throw e;
  }
}

export function logRun(event) {
  mkdirSync(STATE_DIR, { recursive: true });
  appendFileSync(RUNS_LOG, JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n');
}

export function addTask(q, { prompt, goal = null, cwd }) {
  if (!prompt || !prompt.trim()) throw new Error('task prompt must not be empty');
  const now = new Date().toISOString();
  const task = {
    id: `t${q.nextId++}`,
    prompt: prompt.trim(),
    goal,
    cwd,
    model: null, // null -> runner uses config.default_model (sonnet)
    max_budget_usd: null, // null -> config.default_max_budget_usd
    plan_first: false, // true -> phase 1 produces a read-only plan to approve
    status: 'pending',
    session_id: null,
    continue_instruction: null, // (adopted/resumed) custom "what to keep doing" prompt; null -> generic "continue where you left off"
    worktree: null, // (worktree mode) the --worktree name claude isolates in
    isolation: null, // null/'infolder' -> branch in the main checkout; 'worktree' -> --worktree
    base_branch: null, // (in-folder) branch HEAD was on at first dispatch; returned to on finish
    branch: null, // (in-folder) 'carry/<id>' once created
    baseline_commit: null, // (in-folder) sha if dirty pre-run work was carried into a baseline commit
    checkpoint_commit: null, // (in-folder) sha of the night's checkpoint commit
    cost_usd: 0,
    cost_estimated: false, // true while cost_usd is a token-based estimate (no result event yet)
    result_summary: null, // the agent's closing summary (for the morning handoff)
    resume_at: null,
    parked_reason: null,
    parked_calls: [],
    allow_extra: [], // per-task grants added by `carry approve`
    retries: 0,
    lock: null,
    created_at: now,
    updated_at: now,
  };
  q.tasks.push(task);
  return task;
}

export function findTask(q, id) {
  const task = q.tasks.find((t) => t.id === id);
  if (!task) throw new Error(`no task ${id} (see: carry list)`);
  return task;
}

export function updateTask(q, id, patch) {
  const task = findTask(q, id);
  Object.assign(task, patch, { updated_at: new Date().toISOString() });
  return task;
}

export function removeTask(q, id) {
  const task = findTask(q, id);
  if (task.status === 'running') {
    throw new Error(`${id} is running — stop it first (carry stop arrives in Module 2)`);
  }
  q.tasks = q.tasks.filter((t) => t.id !== id);
  return task;
}

export function moveTask(q, id, where) {
  const from = q.tasks.findIndex((t) => t.id === id);
  if (from < 0) throw new Error(`no task ${id}`);
  const [task] = q.tasks.splice(from, 1);
  let to;
  if (where === 'top') to = 0;
  else if (where === 'bottom') to = q.tasks.length;
  else if (where === 'up') to = Math.max(0, from - 1);
  else if (where === 'down') to = Math.min(q.tasks.length, from + 1);
  else throw new Error(`move where? expected up|down|top|bottom, got "${where}"`);
  q.tasks.splice(to, 0, task);
  return task;
}

// Session locks (enforced, not advisory): the runner takes a lock before
// dispatching or resuming a session; every other surface must refuse to touch
// a locked session. Concurrent resume of one session silently interleaves
// transcripts — this is the guard against that.
export function acquireLock(q, id, owner) {
  const task = findTask(q, id);
  if (task.lock && task.lock.owner !== owner) {
    throw new Error(`${id} is locked by ${task.lock.owner} since ${task.lock.since}`);
  }
  task.lock = { owner, since: new Date().toISOString() };
  return task;
}

export function releaseLock(q, id, owner) {
  const task = findTask(q, id);
  if (task.lock && task.lock.owner !== owner) {
    throw new Error(`${id} lock is held by ${task.lock.owner}, not ${owner}`);
  }
  task.lock = null;
  return task;
}
