import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { bodyWithoutDigest, runstewardDigest } from "../src/canonical-json.mjs";
import { assertAllocationAvailable, parseGitWorktreePorcelain, proposeInitialLease } from "../src/scheduler.mjs";
import { resolvePathBinding } from "../src/path-identity.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(packageRoot, "../..");
const expectedBase = "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";
const qualificationRootVariable = "RUNSTEWARD_RW2_QUALIFICATION_ROOT";

function pinnedQualificationRoot() {
  const raw = process.env[qualificationRootVariable];
  if (!raw) {
    throw new Error(`${qualificationRootVariable} must pin the retained qualification root`);
  }
  if (raw !== raw.trim() || !path.isAbsolute(raw)) {
    throw new Error(`${qualificationRootVariable} must be a whitespace-free absolute path`);
  }
  return path.normalize(raw);
}

const qualificationRoot = pinnedQualificationRoot();
const owner = {
  executor_id: "executor:rw2-physical-qualification",
  process_session_ref: `sha256:${"8".repeat(64)}`,
  host_fingerprint: `sha256:${"9".repeat(64)}`
};

function git(args, { cwd = repositoryRoot, expectFailure = false } = {}) {
  const result = spawnSync("git.exe", ["-c", `safe.directory=${repositoryRoot}`, ...args], {
    cwd, encoding: "utf8", windowsHide: true
  });
  if (result.error) throw result.error;
  if (expectFailure) {
    if (result.status === 0) throw new Error(`Git command unexpectedly succeeded: git ${args.join(" ")}`);
  } else if (result.status !== 0) {
    throw new Error(`Git command failed (${result.status}): git ${args.join(" ")}\n${result.stderr}`);
  }
  return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

function proposalInput(taskId) {
  return {
    taskId, repositoryId: "runsteward", sourceHead: expectedBase,
    roots: {
      worktree: path.join(qualificationRoot, "worktrees"), state: path.join(qualificationRoot, "state"),
      evidence: path.join(qualificationRoot, "evidence"), lock: path.join(qualificationRoot, "locks")
    },
    owner, acquiredAt: "2026-07-15T05:30:00Z", ttlMs: 3600000
  };
}

function addRetainedWorktree(proposal) {
  const inventory = parseGitWorktreePorcelain(git(["worktree", "list", "--porcelain"]).stdout);
  const existing = inventory.find((item) => path.resolve(item.path).toLowerCase() === path.resolve(proposal.worktree.path).toLowerCase());
  if (existing) {
    assert.equal(existing.branch?.toLowerCase(), proposal.branch_name.toLowerCase());
    assert.equal(existing.head, expectedBase);
    return "already-retained";
  }
  git(["worktree", "add", "-b", proposal.branch_name, proposal.worktree.path, expectedBase]);
  return "created-retained";
}

const head = git(["rev-parse", "HEAD"]).stdout;
git(["merge-base", "--is-ancestor", expectedBase, head]);
const first = await proposeInitialLease(proposalInput("task:rw2-physical-a"));
const second = await proposeInitialLease(proposalInput("task:rw2-physical-b"));
assert.notEqual(first.branch_name, second.branch_name);
assert.notEqual(first.worktree.collision_key, second.worktree.collision_key);
await mkdir(path.dirname(first.worktree.path), { recursive: true });

const replayDispositions = [first, second].map(addRetainedWorktree);
const porcelain = git(["worktree", "list", "--porcelain"]).stdout;
const worktrees = parseGitWorktreePorcelain(porcelain);
const branches = worktrees.map((item) => item.branch).filter(Boolean);
for (const proposal of [first, second]) {
  const record = worktrees.find((item) => path.resolve(item.path).toLowerCase() === path.resolve(proposal.worktree.path).toLowerCase());
  assert(record, `missing retained worktree ${proposal.worktree.path}`);
  assert.equal(record.branch.toLowerCase(), proposal.branch_name.toLowerCase());
  assert.equal(record.head, expectedBase);
  assert.equal(git(["status", "--porcelain"], { cwd: proposal.worktree.path }).stdout, "");
}

let branchCollision;
try {
  await assertAllocationAvailable(first, { branches, worktrees, leases: [] });
  throw new Error("allocator did not reject active branch");
} catch (error) {
  branchCollision = error.message;
  assert.match(branchCollision, /active branch collision/);
}

const pathProbe = structuredClone(second);
pathProbe.branch_name = "runsteward/rw2-path-collision-probe";
pathProbe.worktree = structuredClone(first.worktree);
pathProbe.lease_digest = runstewardDigest(bodyWithoutDigest(pathProbe, "lease_digest"));
let pathCollision;
try {
  await assertAllocationAvailable(pathProbe, { branches: [], worktrees, leases: [] });
  throw new Error("allocator did not reject existing worktree path");
} catch (error) {
  pathCollision = error.message;
  assert.match(pathCollision, /existing worktree collision/);
}

const caseVariant = await resolvePathBinding(first.worktree.path.toUpperCase());
assert.equal(caseVariant.collision_key, first.worktree.collision_key);

const sameBranchAttemptPath = path.join(qualificationRoot, "rejected", "same-branch");
const sameBranch = git(["worktree", "add", sameBranchAttemptPath, first.branch_name], { expectFailure: true });
assert.match(sameBranch.stderr, /already used by worktree|already checked out/i);
const samePath = git(["worktree", "add", "--detach", first.worktree.path, expectedBase], { expectFailure: true });
assert.match(samePath.stderr, /already exists|missing but already registered|is a missing but already registered worktree/i);

const receipt = {
  schema_version: "runsteward.rw2-physical-qualification/v1",
  accepted_base_commit: expectedBase,
  qualification_root: qualificationRoot,
  qualification_root_binding: {
    source: "environment",
    variable: qualificationRootVariable,
    checkout_independent: true
  },
  retained_worktrees: [first, second].map((proposal, index) => ({
    task_id: proposal.task_id, run_id: proposal.run_id, branch_name: proposal.branch_name,
    worktree: proposal.worktree, disposition: "retained-qualification-evidence",
    replay_disposition: replayDispositions[index], head: expectedBase, clean: true
  })),
  allocator_branch_collision: branchCollision,
  allocator_path_collision: pathCollision,
  case_variant_collision_key_equal: true,
  git_same_branch_attempt_exit: sameBranch.status,
  git_same_path_attempt_exit: samePath.status,
  git_same_branch_rejected: true,
  git_same_path_rejected: true,
  worktree_deletion_performed: false,
  branch_deletion_performed: false,
  remote_action_performed: false,
  qualification_digest: null
};
receipt.qualification_digest = runstewardDigest(bodyWithoutDigest(receipt, "qualification_digest"));
process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
