// git — the small set of LOCAL git operations the runner performs for in-folder
// branch mode (the default). Worktree mode lets `claude -p --worktree` do its own
// git; in-folder mode the runner owns the branch lifecycle instead, so the work
// lands as a normal branch in the project's main checkout (visible in VS Code's
// Source Control, session filed under the project, not a hidden worktree).
//
// Every call goes through `git -C <cwd> …` with shell:false, so a project path
// with a space ("Claude Autopilot") needs no quoting. These helpers are
// non-throwing — they return a small result and let callers decide — because a
// git hiccup must never crash the unattended supervisor loop.
//
// Note: the runner shells git DIRECTLY (not via Claude's tools), so the
// guardrails' --disallowedTools (e.g. no `git push`) do not gate these. That is
// fine: every operation here is local and non-pushing (branch / checkout /
// commit / stash). Nothing here touches a remote.

import { spawnSync } from 'node:child_process';

// low-level primitive: run one git command in cwd, capture output, never throw.
export function git(cwd, args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  return {
    ok: r.status === 0,
    code: r.status,
    out: (r.stdout || '').trim(),
    err: (r.stderr || '').trim(),
  };
}

// Current branch name, or null when HEAD is detached. `branch --show-current`
// (git ≥ 2.22) prints the branch on a normal or unborn (empty-repo) HEAD and an
// empty string when detached — so empty output means "no safe branch to base on".
export function currentBranch(cwd) {
  const r = git(cwd, ['branch', '--show-current']);
  if (!r.ok) return null;
  return r.out || null;
}

// Does HEAD point at a real commit? False on a freshly-init'd repo with no
// commits yet (branching off an unborn HEAD would fail).
export function hasCommits(cwd) {
  return git(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD']).ok;
}

// Uncommitted changes OR untracked files present (porcelain covers both).
export function isDirty(cwd) {
  const r = git(cwd, ['status', '--porcelain']);
  return r.ok && r.out.length > 0;
}

export function branchExists(cwd, name) {
  return git(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]).ok;
}

// HEAD commit sha (full). null if it can't be read (e.g. empty repo).
export function headSha(cwd) {
  const r = git(cwd, ['rev-parse', 'HEAD']);
  return r.ok ? r.out : null;
}

// Create + check out a new branch from the current HEAD (carries any dirty
// working-tree changes onto it, exactly like `git checkout -b`).
export function checkoutNew(cwd, name) {
  return git(cwd, ['checkout', '-b', name]);
}

export function checkout(cwd, name) {
  return git(cwd, ['checkout', name]);
}

// Stage everything and commit, supplying an identity inline so the commit works
// even on a machine with no global git user configured. Returns { ok, sha }.
export function commitAll(cwd, message) {
  const add = git(cwd, ['add', '-A']);
  if (!add.ok) return { ok: false, sha: null, err: add.err };
  const commit = git(cwd, [
    '-c', 'user.name=Claude Carry',
    '-c', 'user.email=carry@localhost',
    'commit', '-m', message,
  ]);
  return { ok: commit.ok, sha: commit.ok ? headSha(cwd) : null, err: commit.err, out: commit.out };
}

// Set aside dirty work (including untracked, via -u) under a labelled stash.
export function stashPush(cwd, label) {
  return git(cwd, ['stash', 'push', '-u', '-m', label]);
}
