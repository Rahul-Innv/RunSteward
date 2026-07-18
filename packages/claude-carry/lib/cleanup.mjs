// cleanup — remove the disposable git worktrees that finished tasks ran in.
// `claude -p --worktree <name>` creates <cwd>/.claude/worktrees/<name> on branch
// worktree-<name> and never auto-cleans them (confirmed on this machine), so we
// do it: only for tasks that are truly finished (done/failed), never for ones
// that might still resume (waiting/needs-approval/running).

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadQueue, saveQueue, findTask } from './store.mjs';

const FINISHED = new Set(['done', 'failed']);

function git(cwd, args) {
  return spawnSync('git', args, { cwd, encoding: 'utf8' });
}

// Remove one task's worktree + its branch. Returns a short status string.
export function removeWorktree(task) {
  if (!task.worktree) {
    // in-folder mode has no worktree to remove. The carry/<id> branch IS
    // the deliverable, so we KEEP it — deletion happens only when the user lands
    // (merges) it. Just report it honestly.
    return task.branch ? `in-folder branch ${task.branch} kept — delete after merging` : 'no worktree';
  }
  const rel = join('.claude', 'worktrees', task.worktree);
  const abs = join(task.cwd, rel);
  if (!existsSync(abs)) return 'worktree already gone';
  const rm = git(task.cwd, ['worktree', 'remove', '--force', rel]);
  if (rm.status !== 0) return `git worktree remove failed: ${(rm.stderr || '').trim().slice(0, 120)}`;
  // best-effort branch delete (ignore failure — branch may be checked out elsewhere)
  git(task.cwd, ['branch', '-D', `worktree-${task.worktree}`]);
  return 'removed';
}

// Clean finished tasks' worktrees. opts.all also clears the queue entries.
export function cleanup({ all = false, id = null } = {}) {
  const q = loadQueue();
  const targets = id
    ? [findTask(q, id)]
    : q.tasks.filter((t) => FINISHED.has(t.status));
  const results = [];
  for (const t of targets) {
    if (!FINISHED.has(t.status) && !id) continue;
    const r = removeWorktree(t);
    results.push({ id: t.id, result: r });
    t.worktree = r === 'removed' || r === 'worktree already gone' ? null : t.worktree;
  }
  if (all) {
    // drop finished entries from the queue once their worktrees are gone
    q.tasks = q.tasks.filter((t) => !FINISHED.has(t.status));
  }
  saveQueue(q);
  return results;
}
