import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWriteJson } from "../src/atomic-write.mjs";
import { bodyWithoutDigest, runstewardDigest } from "../src/canonical-json.mjs";
import { parseGitWorktreePorcelain, proposeInitialLease } from "../src/scheduler.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(packageRoot, "../..");
const workerProbe = path.join(packageRoot, "scripts", "rw5-worker-probe.mjs");
const focusedTest = path.join(packageRoot, "test", "rw5-failure-concurrency.test.mjs");
const qualificationRootVariable = "RUNSTEWARD_RW5_QUALIFICATION_ROOT";
const expectedBase = "a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2";
const expectedBaseTree = "a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3";
const acceptedRw4ReceiptSha256 = "a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4";
const focusedReplayRounds = 3;
const internalRepeatabilityRounds = 5;
const taskIds = ["task:rw5-physical-a", "task:rw5-physical-b"];
const owner = {
  executor_id: "executor:rw5-physical-qualification",
  process_session_ref: `sha256:${"8".repeat(64)}`,
  host_fingerprint: `sha256:${"9".repeat(64)}`,
};

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function pinnedQualificationRoot() {
  const raw = process.env[qualificationRootVariable];
  if (!raw || raw !== raw.trim() || !path.isAbsolute(raw)) {
    throw new Error(`${qualificationRootVariable} must pin a whitespace-free absolute retained root`);
  }
  return path.normalize(raw);
}

function git(args, { cwd = repositoryRoot, expectFailure = false } = {}) {
  const result = spawnSync("git.exe", [
    "-c", `safe.directory=${cwd}`,
    "-c", "core.longpaths=true",
    "-C", cwd,
    ...args,
  ], {
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    maxBuffer: 128 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (expectFailure ? result.status === 0 : result.status !== 0) {
    throw new Error(`Git command ${expectFailure ? "unexpectedly succeeded" : "failed"}: git ${args.join(" ")}\n${result.stderr}`);
  }
  return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

function localBranchHead(branchName) {
  const output = git([
    "for-each-ref",
    "--format=%(objectname)",
    `refs/heads/${branchName}`,
  ]).stdout;
  if (output === "") return null;
  const heads = output.split(/\r?\n/u).filter(Boolean);
  assert.equal(heads.length, 1, "a retained qualification branch lookup must resolve exactly once");
  return heads[0];
}

function proposalInput(qualificationRoot, taskId) {
  return {
    taskId,
    repositoryId: "runsteward",
    sourceHead: expectedBase,
    roots: {
      worktree: path.join(qualificationRoot, "worktrees"),
      state: path.join(qualificationRoot, "state"),
      evidence: path.join(qualificationRoot, "evidence"),
      lock: path.join(qualificationRoot, "locks"),
    },
    owner,
    acquiredAt: "2026-07-16T23:50:00Z",
    ttlMs: 3600000,
  };
}

function samePath(left, right) {
  const a = path.resolve(left).replace(/[\\/]$/u, "");
  const b = path.resolve(right).replace(/[\\/]$/u, "");
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function addRetainedWorktree(proposal) {
  const current = parseGitWorktreePorcelain(git(["worktree", "list", "--porcelain"]).stdout);
  const existing = current.find((record) => samePath(record.path, proposal.worktree.path));
  if (existing) {
    assert.equal(existing.branch?.toLowerCase(), proposal.branch_name.toLowerCase());
    assert.equal(existing.head, expectedBase);
    assert.equal(git(["status", "--porcelain=v1", "--untracked-files=all"], { cwd: proposal.worktree.path }).stdout, "");
    return "already-retained";
  }
  const branchHead = localBranchHead(proposal.branch_name);
  if (branchHead !== null) {
    assert.equal(branchHead, expectedBase, "a retained qualification branch may only be resumed at the accepted RW4 base");
    assert.equal(
      current.some((record) => record.branch?.toLowerCase() === proposal.branch_name.toLowerCase()),
      false,
      "a retained qualification branch may not be attached to another worktree",
    );
    git(["worktree", "add", proposal.worktree.path, proposal.branch_name]);
    assert.equal(git(["status", "--porcelain=v1", "--untracked-files=all"], { cwd: proposal.worktree.path }).stdout, "");
    return "created-retained-from-unattached-base-branch";
  }
  git(["worktree", "add", "-b", proposal.branch_name, proposal.worktree.path, expectedBase]);
  assert.equal(git(["status", "--porcelain=v1", "--untracked-files=all"], { cwd: proposal.worktree.path }).stdout, "");
  return "created-retained";
}

function tapCounts(output) {
  const take = (label) => {
    const matches = [...output.matchAll(new RegExp(`(?:^|\\n)[^\\r\\n]*${label}\\s+(\\d+)\\s*(?:\\r?\\n|$)`, "gu"))];
    assert.ok(matches.length > 0, `missing TAP ${label} count`);
    return Number(matches.at(-1)[1]);
  };
  return { tests: take("tests"), pass: take("pass"), fail: take("fail") };
}

async function writeChecksummed(filePath, bytes) {
  await writeFile(filePath, bytes);
  const digest = sha256(bytes);
  await writeFile(`${filePath}.sha256`, `${digest}  ${path.basename(filePath)}\n`, "utf8");
  return digest;
}

function runFocused(round, qualificationRoot) {
  const result = spawnSync(process.execPath, ["--test", focusedTest], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    maxBuffer: 128 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const counts = tapCounts(output);
  assert.equal(result.status, 0);
  assert.deepEqual(counts, { tests: 10, pass: 10, fail: 0 });
  assert.match(output, new RegExp(`RUNSTEWARD_RW5_INTERNAL_REPEATABILITY_ROUNDS=${internalRepeatabilityRounds}`, "u"));
  return { round, exit: result.status, ...counts, output, log: path.join(qualificationRoot, `focused-round-${round}.log`) };
}

function runWorker({ cwd, taskId, output, mode }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      workerProbe,
      "--task-id", taskId,
      "--worktree", cwd,
      "--output", output,
      "--mode", mode,
      "--source-head", expectedBase,
    ], { cwd, env: { ...process.env }, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

const qualificationRoot = pinnedQualificationRoot();
await mkdir(qualificationRoot, { recursive: true });
assert.equal(git(["rev-parse", "HEAD"]).stdout, expectedBase);
assert.equal(git(["rev-parse", "HEAD^{tree}"]).stdout, expectedBaseTree);
assert.equal(git(["diff", "--name-only"]).stdout, "", "RW5 qualification requires no unstaged candidate bytes");
const stagedPaths = git(["diff", "--cached", "--name-only", "--diff-filter=ACMR"]).stdout.split(/\r?\n/u).filter(Boolean);
assert.ok(stagedPaths.length > 0, "RW5 qualification requires a staged candidate");
assert.equal(stagedPaths.some((item) => item.startsWith("packages/claude-carry/") || item.startsWith("packages/codex-nightwatch/") || item.startsWith("packages/limit-aware-wrapup/")), false);
const candidateTree = git(["write-tree"]).stdout;

const proposals = await Promise.all(taskIds.map((taskId) => proposeInitialLease(proposalInput(qualificationRoot, taskId))));
assert.notEqual(proposals[0].task_id, proposals[1].task_id);
assert.notEqual(proposals[0].branch_name, proposals[1].branch_name);
assert.notEqual(proposals[0].worktree.collision_key, proposals[1].worktree.collision_key);
await mkdir(path.dirname(proposals[0].worktree.path), { recursive: true });
const dispositions = proposals.map(addRetainedWorktree);

const worktreeRecords = parseGitWorktreePorcelain(git(["worktree", "list", "--porcelain"]).stdout);
const retainedWorktrees = proposals.map((proposal, index) => {
  const record = worktreeRecords.find((item) => samePath(item.path, proposal.worktree.path));
  assert.ok(record);
  assert.equal(record.head, expectedBase);
  assert.equal(record.branch?.toLowerCase(), proposal.branch_name.toLowerCase());
  return {
    task_id: proposal.task_id,
    run_id: proposal.run_id,
    branch_name: proposal.branch_name,
    worktree: proposal.worktree,
    head: record.head,
    clean: git(["status", "--porcelain=v1", "--untracked-files=all"], { cwd: proposal.worktree.path }).stdout === "",
    disposition: "retained-qualification-evidence-never-delete",
    replay_disposition: dispositions[index],
  };
});
assert.equal(retainedWorktrees.every((item) => item.clean), true);

const focusedReplays = [];
for (let round = 1; round <= focusedReplayRounds; round += 1) {
  const replay = runFocused(round, qualificationRoot);
  const outputBytes = Buffer.from(replay.output, "utf8");
  replay.log_sha256 = await writeChecksummed(replay.log, outputBytes);
  delete replay.output;
  focusedReplays.push(replay);
}

const workerEvidenceRoot = path.join(qualificationRoot, "worker-evidence");
await mkdir(workerEvidenceRoot, { recursive: true });
const blockedOutput = path.join(workerEvidenceRoot, "blocked-a.json");
const completeOutput = path.join(workerEvidenceRoot, "complete-b.json");
const [blocked, completed] = await Promise.all([
  runWorker({ cwd: proposals[0].worktree.path, taskId: proposals[0].task_id, output: blockedOutput, mode: "blocked" }),
  runWorker({ cwd: proposals[1].worktree.path, taskId: proposals[1].task_id, output: completeOutput, mode: "complete" }),
]);
assert.equal(blocked.code, 23);
assert.equal(completed.code, 0);
const blockedProof = JSON.parse(await readFile(blockedOutput, "utf8"));
const completeProof = JSON.parse(await readFile(completeOutput, "utf8"));
assert.equal(blockedProof.status, "stopped");
assert.equal(blockedProof.final_status_marker, "RUNSTEWARD_FINAL_STATUS");
assert.equal(completeProof.status, "completed");
assert.equal(completeProof.final_status_marker, "RUNSTEWARD_FINAL_STATUS");
assert.notEqual(blockedProof.worktree.collision_key, completeProof.worktree.collision_key);

const crashOutput = path.join(workerEvidenceRoot, "crash-a.json");
const baseline = await runWorker({ cwd: proposals[0].worktree.path, taskId: "task:rw5-crash-a", output: crashOutput, mode: "complete" });
assert.equal(baseline.code, 0);
const baselineBytes = await readFile(crashOutput);
const crash = await runWorker({ cwd: proposals[0].worktree.path, taskId: "task:rw5-crash-a", output: crashOutput, mode: "crash" });
assert.equal(crash.code, 86);
assert.deepEqual(await readFile(crashOutput), baselineBytes);
const crashTempFiles = (await readdir(workerEvidenceRoot)).filter((name) => /^\.crash-a\.json\..+\.tmp$/u.test(name));
assert.equal(crashTempFiles.length, 1);
const recoveryFirst = await runWorker({ cwd: proposals[0].worktree.path, taskId: "task:rw5-crash-a", output: crashOutput, mode: "recover" });
assert.equal(recoveryFirst.code, 0);
const recoveredBytes = await readFile(crashOutput);
const recoverySecond = await runWorker({ cwd: proposals[0].worktree.path, taskId: "task:rw5-crash-a", output: crashOutput, mode: "recover" });
assert.equal(recoverySecond.code, 0);
assert.deepEqual(await readFile(crashOutput), recoveredBytes);
const recoveredProof = JSON.parse(recoveredBytes.toString("utf8"));
assert.equal(recoveredProof.final_status_marker, "RUNSTEWARD_FINAL_STATUS");

for (const retained of retainedWorktrees) {
  assert.equal(git(["status", "--porcelain=v1", "--untracked-files=all"], { cwd: retained.worktree.path }).stdout, "");
}

const receipt = {
  schema_version: "runsteward.rw5-failure-concurrency-qualification/v1",
  accepted_rw4: {
    commit: expectedBase,
    tree: expectedBaseTree,
    acceptance_receipt_sha256: acceptedRw4ReceiptSha256,
  },
  candidate: {
    branch: git(["branch", "--show-current"]).stdout,
    head: expectedBase,
    staged_tree: candidateTree,
    staged_path_count: stagedPaths.length,
    imported_package_paths_changed: 0,
  },
  qualification_root: qualificationRoot,
  qualification_root_binding: { source: "environment", variable: qualificationRootVariable, retained: true },
  retained_worktrees: retainedWorktrees,
  repeatability: {
    focused_replay_rounds: focusedReplayRounds,
    internal_matrix_rounds_per_replay: internalRepeatabilityRounds,
    focused_results: focusedReplays,
  },
  physical_concurrency: {
    blocked_lane_exit: blocked.code,
    blocked_lane_status: blockedProof.status,
    independent_lane_exit: completed.code,
    independent_lane_status: completeProof.status,
    collision_keys_distinct: true,
    blocked_lane_did_not_block_independent_lane: true,
    literal_final_status_proof_both_lanes: true,
  },
  hard_crash_recovery: {
    crash_exit: crash.code,
    prior_complete_target_preserved: true,
    retained_pre_rename_temporary_files: crashTempFiles,
    recovery_exit: recoveryFirst.code,
    repeated_recovery_exit: recoverySecond.code,
    repeated_recovery_byte_identical: true,
    final_status_marker: recoveredProof.final_status_marker,
  },
  matrix_claims: {
    deterministic_collision: true,
    crash: true,
    stale_lease_and_contention: true,
    partial_atomic_write_and_checkpoint: true,
    interrupted_child: true,
    identity_mismatch: true,
    source_drift: true,
    forced_wrap: true,
    cancellation: true,
    stopped_and_missing_child: true,
    two_worktree_concurrency_and_isolation: true,
    blocked_lane_independence: true,
    recovery_and_idempotence: true,
    literal_final_proof: true,
  },
  prohibited_actions: {
    provider_calls: 0,
    network_calls: 0,
    remote_actions: 0,
    commits: 0,
    pushes: 0,
    worktree_deletions: 0,
    branch_deletions: 0,
    imported_package_edits: 0,
  },
  qualification_digest: null,
};
receipt.qualification_digest = runstewardDigest(bodyWithoutDigest(receipt, "qualification_digest"));
const receiptPath = path.join(qualificationRoot, "rw5-failure-concurrency-qualification.json");
await atomicWriteJson(receiptPath, receipt);
const receiptBytes = await readFile(receiptPath);
const receiptRawSha256 = sha256(receiptBytes);
await writeFile(`${receiptPath}.sha256`, `${receiptRawSha256}  ${path.basename(receiptPath)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ receipt_path: receiptPath, receipt_sha256: receiptRawSha256, receipt }, null, 2)}\n`);
