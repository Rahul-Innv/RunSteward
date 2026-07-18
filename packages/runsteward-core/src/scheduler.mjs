import { createHash } from "node:crypto";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { atomicWriteJson } from "./atomic-write.mjs";
import { assertRunStewardDigest, bodyWithoutDigest, runstewardDigest } from "./canonical-json.mjs";
import { assertChildDependencyEvaluation } from "./child-join.mjs";
import { assertLeaseUniqueness } from "./invariants.mjs";
import { resolvePathBinding } from "./path-identity.mjs";

const STABLE_ID = /^[a-z][a-z0-9._:-]{2,127}$/;
const GIT_COMMIT = /^[0-9a-f]{40}$/;
const RUNSTEWARD_DIGEST = /^sha256:[0-9a-f]{64}$/;
const RELATIVE_REF = /^(?![A-Za-z]:)(?![/\\])(?!.*(?:^|[/\\])\.\.(?:[/\\]|$))[A-Za-z0-9._/\\:-]+$/;
const LEASE_PATH_FIELDS = ["worktree", "state_path", "evidence_path", "lock_path"];
const LEASE_KEYS = [
  "acquired_at", "branch_name", "evidence_path", "expires_at", "last_heartbeat_at", "lease_digest",
  "lease_epoch", "lease_id", "lock_path", "observed_head", "original_source_head", "owner", "previous_lease_id",
  "previous_lease_ref", "purpose", "release_reason", "repository_id", "run_id", "schema_version", "state_path",
  "status", "task_id", "worktree"
];
const PATH_BINDING_KEYS = ["collision_key", "path"];
const OWNER_KEYS = ["executor_id", "host_fingerprint", "process_session_ref"];
const LEASE_STATUSES = new Set(["proposed", "active", "releasing", "released", "stale", "quarantined"]);

function hasExactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify(keys);
}

function assertStableId(value, label) {
  if (typeof value !== "string" || !STABLE_ID.test(value)) throw new Error(`${label} is not a stable RunSteward id`);
}

function taskToken(taskId, repositoryId, sourceHead) {
  const slug = taskId.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "task";
  const suffix = createHash("sha256").update(`runsteward-allocation-v1\0${repositoryId}\0${taskId}\0${sourceHead}`, "utf8").digest("hex").slice(0, 16);
  return `${slug}-${suffix}`;
}

function addMilliseconds(timestamp, ttlMs) {
  const value = new Date(timestamp);
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || Number.isNaN(value.valueOf()) || typeof timestamp !== "string" || !timestamp.endsWith("Z")) {
    throw new Error("UTC acquiredAt and positive ttlMs are required");
  }
  return new Date(value.valueOf() + ttlMs).toISOString();
}

function assertOwner(owner) {
  if (!hasExactKeys(owner, OWNER_KEYS)) throw new Error("lease owner does not match the pinned RW1 contract");
  assertStableId(owner?.executor_id, "owner.executor_id");
  for (const field of ["process_session_ref", "host_fingerprint"]) {
    if (!RUNSTEWARD_DIGEST.test(owner?.[field])) throw new Error(`owner.${field} is not a RunSteward digest`);
  }
}

function assertUtcTimestamp(value, label) {
  if (typeof value !== "string" || !value.endsWith("Z") || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} must be a UTC timestamp`);
  }
}

function assertRelativeRef(value, label) {
  if (typeof value !== "string" || value.length < 1 || value.length > 512 || value.trim() !== value || !RELATIVE_REF.test(value)) {
    throw new Error(`${label} must be a nonempty trimmed relative reference`);
  }
}

function assertPathBinding(value, label) {
  if (!hasExactKeys(value, PATH_BINDING_KEYS) || typeof value.path !== "string" || value.path.length < 3 || value.path.length > 1024
      || typeof value.collision_key !== "string" || !/^fs:[a-z0-9-]+:[0-9a-f]{64}$/.test(value.collision_key)) {
    throw new Error(`${label} does not match the pinned RW1 path-binding contract`);
  }
}

function assertArtifactRef(value, label) {
  if (!hasExactKeys(value, ["digest", "ref"]) || !RUNSTEWARD_DIGEST.test(value.digest)) {
    throw new Error(`${label} does not match the pinned RW1 artifact-reference contract`);
  }
  assertRelativeRef(value.ref, `${label}.ref`);
}

function assertWorktreeLeaseContract(lease) {
  if (!hasExactKeys(lease, LEASE_KEYS) || lease.schema_version !== "runsteward.worktree-lease/v1") {
    throw new Error("lease does not match the pinned RW1 worktree-lease contract");
  }
  for (const field of ["lease_id", "run_id", "task_id", "repository_id"]) assertStableId(lease[field], field);
  if (!Number.isSafeInteger(lease.lease_epoch) || lease.lease_epoch < 1) throw new Error("lease_epoch must be a positive safe integer");
  if (!GIT_COMMIT.test(lease.original_source_head) || !GIT_COMMIT.test(lease.observed_head)) throw new Error("lease Git commits are invalid");
  if (typeof lease.branch_name !== "string" || lease.branch_name.length < 1 || lease.branch_name.length > 256) throw new Error("lease branch_name is invalid");
  for (const field of LEASE_PATH_FIELDS) assertPathBinding(lease[field], field);
  assertOwner(lease.owner);
  for (const field of ["acquired_at", "last_heartbeat_at", "expires_at"]) assertUtcTimestamp(lease[field], field);
  if (!LEASE_STATUSES.has(lease.status)) throw new Error("lease status is invalid");
  if (lease.lease_epoch === 1) {
    if (lease.purpose !== "initial" || lease.previous_lease_ref !== null || lease.previous_lease_id !== null) {
      throw new Error("first lease must use initial purpose without a predecessor");
    }
  } else {
    if (lease.purpose !== "resume") throw new Error("successor lease must use resume purpose");
    assertStableId(lease.previous_lease_id, "previous_lease_id");
    assertArtifactRef(lease.previous_lease_ref, "previous_lease_ref");
  }
  if (lease.release_reason !== null && (typeof lease.release_reason !== "string" || lease.release_reason.length < 1 || lease.release_reason.length > 512)) {
    throw new Error("lease release_reason is invalid");
  }
  if (lease.status === "released" && (typeof lease.release_reason !== "string" || lease.release_reason.trim().length === 0)) {
    throw new Error("released lease requires a nonempty release_reason");
  }
  if (!RUNSTEWARD_DIGEST.test(lease.lease_digest)) throw new Error("lease_digest is not a RunSteward digest");
  assertRunStewardDigest(lease, "lease_digest");
  return true;
}

function assertCompleteInventory(inventory) {
  if (!inventory || typeof inventory !== "object" || Array.isArray(inventory)
      || !Array.isArray(inventory.branches) || !Array.isArray(inventory.worktrees) || !Array.isArray(inventory.leases)) {
    throw new Error("complete physical inventory with branches, worktrees, and leases is required");
  }
  for (const branch of inventory.branches) {
    const name = typeof branch === "string" ? branch : branch?.name;
    if (typeof name !== "string" || name.length === 0) throw new Error("physical branch inventory contains an invalid entry");
  }
  for (const worktree of inventory.worktrees) {
    const worktreePath = typeof worktree === "string" ? worktree : worktree?.path;
    if (typeof worktreePath !== "string" || worktreePath.length === 0) throw new Error("physical worktree inventory contains an invalid entry");
  }
  inventory.leases.forEach(assertWorktreeLeaseContract);
}

function cleanupError(message, primaryError, failures, recovery) {
  const causes = [primaryError, ...failures].filter(Boolean);
  const error = new Error(message, { cause: causes.length === 1 ? causes[0] : new AggregateError(causes, message) });
  error.code = "RUNSTEWARD_CLEANUP_REQUIRED";
  error.recovery = recovery;
  return error;
}

async function closeForCleanup(handle, label, failures) {
  if (!handle) return;
  try {
    await handle.close();
  } catch (error) {
    failures.push(new Error(`${label} close failed`, { cause: error }));
  }
}

async function unlinkForCleanup(unlinkPath, target, label, failures) {
  try {
    await unlinkPath(target);
  } catch (error) {
    failures.push(new Error(`${label} unlink failed: ${target}`, { cause: error }));
  }
}

function normalizeBranch(branch) {
  return branch.replace(/^refs\/heads\//, "").toLowerCase();
}

function normalizedPath(value) {
  const normalized = path.resolve(value).replace(/[\\/]$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function pathsOverlap(left, right) {
  const a = normalizedPath(left);
  const b = normalizedPath(right);
  return a === b || a.startsWith(`${b}${path.sep}`) || b.startsWith(`${a}${path.sep}`);
}

function assertNoLeasePathContainment(proposedLease, existingLeases) {
  for (let left = 0; left < LEASE_PATH_FIELDS.length; left += 1) {
    for (let right = left + 1; right < LEASE_PATH_FIELDS.length; right += 1) {
      const leftField = LEASE_PATH_FIELDS[left];
      const rightField = LEASE_PATH_FIELDS[right];
      if (pathsOverlap(proposedLease[leftField].path, proposedLease[rightField].path)) {
        throw new Error(`proposed lease path containment: ${leftField} overlaps ${rightField}`);
      }
    }
  }
  for (const existing of existingLeases.filter((lease) => lease.status !== "released")) {
    for (const proposedField of LEASE_PATH_FIELDS) {
      for (const existingField of LEASE_PATH_FIELDS) {
        if (pathsOverlap(proposedLease[proposedField].path, existing[existingField].path)) {
          throw new Error(`lease path containment: ${proposedField} overlaps ${existingField} from ${existing.lease_id}`);
        }
      }
    }
  }
}

function assertSchedulerPathContainment(leases) {
  const active = [];
  for (const lease of leases) {
    if (lease.status === "released") continue;
    assertNoLeasePathContainment(lease, active);
    active.push(lease);
  }
}

async function assertPhysicalBindingsCurrent(lease, resolve) {
  for (const field of LEASE_PATH_FIELDS) {
    const current = await resolve(lease[field].path);
    if (current.collision_key !== lease[field].collision_key) throw new Error(`physical ${field} identity changed after allocation`);
  }
}

export function parseGitWorktreePorcelain(text) {
  if (typeof text !== "string") throw new Error("git worktree porcelain output must be text");
  const records = [];
  let current = null;
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current) records.push(current);
      current = { path: line.slice(9), head: null, branch: null, detached: false, bare: false, locked: false, prunable: false };
    } else if (current && line.startsWith("HEAD ")) current.head = line.slice(5);
    else if (current && line.startsWith("branch ")) current.branch = line.slice(7).replace(/^refs\/heads\//, "");
    else if (current && line === "detached") current.detached = true;
    else if (current && line === "bare") current.bare = true;
    else if (current && line.startsWith("locked")) current.locked = true;
    else if (current && line.startsWith("prunable")) current.prunable = true;
  }
  if (current) records.push(current);
  if (records.some((record) => !record.path)) throw new Error("invalid git worktree porcelain record");
  return records;
}

export async function proposeInitialLease(input, options = {}) {
  const { taskId, repositoryId, sourceHead, roots, owner, acquiredAt, ttlMs } = input;
  assertStableId(taskId, "taskId");
  assertStableId(repositoryId, "repositoryId");
  if (!GIT_COMMIT.test(sourceHead)) throw new Error("sourceHead must be a lowercase 40-character Git commit");
  if (!roots || !owner) throw new Error("roots and owner are required");
  assertOwner(owner);
  for (const [kind, root] of Object.entries(roots)) {
    if (typeof root !== "string" || !path.isAbsolute(root)) throw new Error(`${kind} root must be absolute`);
  }
  const resolve = options.resolvePathBinding ?? resolvePathBinding;
  const token = taskToken(taskId, repositoryId, sourceHead);
  const runId = `run:${token}`;
  const branchName = `runsteward/${token}`;
  const paths = {
    worktree: path.resolve(roots.worktree, token),
    state_path: path.resolve(roots.state, token),
    evidence_path: path.resolve(roots.evidence, token),
    lock_path: path.resolve(roots.lock, `${token}.lock`)
  };
  const [worktree, statePath, evidencePath, lockPath] = await Promise.all([
    resolve(paths.worktree), resolve(paths.state_path), resolve(paths.evidence_path), resolve(paths.lock_path)
  ]);
  const lease = {
    schema_version: "runsteward.worktree-lease/v1",
    lease_id: `lease:${token}:1`,
    run_id: runId,
    task_id: taskId,
    lease_epoch: 1,
    purpose: "initial",
    status: "proposed",
    repository_id: repositoryId,
    original_source_head: sourceHead,
    observed_head: sourceHead,
    branch_name: branchName,
    worktree,
    state_path: statePath,
    evidence_path: evidencePath,
    lock_path: lockPath,
    owner: structuredClone(owner),
    acquired_at: acquiredAt,
    last_heartbeat_at: acquiredAt,
    expires_at: addMilliseconds(acquiredAt, ttlMs),
    previous_lease_ref: null,
    previous_lease_id: null,
    release_reason: null,
    lease_digest: null
  };
  lease.lease_digest = runstewardDigest(bodyWithoutDigest(lease, "lease_digest"));
  return lease;
}

export async function assertAllocationAvailable(proposedLease, inventory, options = {}) {
  assertWorktreeLeaseContract(proposedLease);
  assertCompleteInventory(inventory);
  const leases = inventory.leases;
  assertLeaseUniqueness([...leases, proposedLease]);
  assertNoLeasePathContainment(proposedLease, leases);
  const branch = normalizeBranch(proposedLease.branch_name);
  const branches = (inventory.branches ?? []).map((item) => normalizeBranch(typeof item === "string" ? item : item.name));
  if (branches.includes(branch)) throw new Error(`active branch collision: ${proposedLease.branch_name}`);

  const resolve = options.resolvePathBinding ?? resolvePathBinding;
  for (const worktree of inventory.worktrees ?? []) {
    const binding = worktree.collision_key ? worktree : await resolve(worktree.path ?? worktree);
    if (binding.collision_key === proposedLease.worktree.collision_key || pathsOverlap(binding.path, proposedLease.worktree.path)) {
      throw new Error(`existing worktree collision: ${binding.path}`);
    }
  }
  return true;
}

export function assessLeaseExpiry(lease, observedAt) {
  assertRunStewardDigest(lease, "lease_digest");
  const observed = Date.parse(observedAt);
  const expires = Date.parse(lease.expires_at);
  if (!Number.isFinite(observed) || !Number.isFinite(expires)) throw new Error("lease expiry comparison requires valid timestamps");
  const expired = observed >= expires;
  if (!expired) return { state: "current", takeover_allowed: false };
  return {
    state: "stale-evidence-only",
    takeover_allowed: false,
    required_action: "owner-authorized-reclamation-with-preserved-predecessor-evidence"
  };
}

export function proposeSuccessorLease(priorReleasedLease, input) {
  assertWorktreeLeaseContract(priorReleasedLease);
  if (priorReleasedLease.status !== "released") throw new Error("successor lease requires an explicitly released predecessor");
  if (input.observedHead !== priorReleasedLease.observed_head) throw new Error("successor lease observed head drift");
  assertRelativeRef(input.previousLeaseRef, "previousLeaseRef");
  const epoch = priorReleasedLease.lease_epoch + 1;
  const expectedSuffix = `:${priorReleasedLease.lease_epoch}`;
  if (!priorReleasedLease.lease_id.endsWith(expectedSuffix)) throw new Error("predecessor lease_id is not epoch-bound");
  const lease = structuredClone(priorReleasedLease);
  lease.lease_id = `${priorReleasedLease.lease_id.slice(0, -expectedSuffix.length)}:${epoch}`;
  lease.lease_epoch = epoch;
  lease.purpose = "resume";
  lease.status = "proposed";
  lease.acquired_at = input.acquiredAt;
  lease.last_heartbeat_at = input.acquiredAt;
  lease.expires_at = addMilliseconds(input.acquiredAt, input.ttlMs);
  lease.previous_lease_ref = { ref: input.previousLeaseRef, digest: priorReleasedLease.lease_digest };
  lease.previous_lease_id = priorReleasedLease.lease_id;
  lease.release_reason = null;
  lease.lease_digest = runstewardDigest(bodyWithoutDigest(lease, "lease_digest"));
  assertWorktreeLeaseContract(lease);
  return lease;
}

export function buildSchedulerState({ revision, updatedAt, leases, childEvaluations = [] }) {
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Error("scheduler revision must be a non-negative safe integer");
  if (!Array.isArray(leases)) throw new Error("scheduler leases must be an array");
  leases.forEach(assertWorktreeLeaseContract);
  assertLeaseUniqueness(leases);
  assertSchedulerPathContainment(leases);
  childEvaluations.forEach(assertChildDependencyEvaluation);
  const state = {
    schema_version: "runsteward.scheduler-state/v1",
    revision,
    updated_at: updatedAt,
    leases: structuredClone(leases),
    child_evaluations: structuredClone(childEvaluations),
    state_digest: null
  };
  state.state_digest = runstewardDigest(bodyWithoutDigest(state, "state_digest"));
  return state;
}

export async function reserveLease({ proposedLease, stateFile, priorState = null, inventory, beforeStateRename }, options = {}) {
  if (proposedLease?.status !== "proposed") throw new Error("only a proposed lease may be reserved");
  await assertAllocationAvailable(proposedLease, inventory, options);
  await assertPhysicalBindingsCurrent(proposedLease, options.resolvePathBinding ?? resolvePathBinding);
  if (priorState) {
    assertRunStewardDigest(priorState, "state_digest");
    for (const priorLease of priorState.leases) {
      if (!inventory.leases.some((lease) => lease.lease_id === priorLease.lease_id && lease.lease_digest === priorLease.lease_digest)) {
        throw new Error(`complete lease inventory is missing prior scheduler lease: ${priorLease.lease_id}`);
      }
    }
  }
  await mkdir(path.dirname(stateFile), { recursive: true });
  await mkdir(path.dirname(proposedLease.lock_path.path), { recursive: true });
  const unlinkPath = options.unlinkPath ?? unlink;
  let lockHandle;
  let leaseLockAcquired = false;
  let coordinationHandle;
  let coordinationLockAcquired = false;
  const coordinationLockPath = `${stateFile}.lock`;
  let committed = false;
  let result;
  let primaryError;
  try {
    try {
      lockHandle = await open(proposedLease.lock_path.path, "wx", 0o600);
      leaseLockAcquired = true;
    } catch (error) {
      if (error?.code === "EEXIST") throw new Error(`physical lease lock collision: ${proposedLease.lock_path.path}`, { cause: error });
      throw error;
    }
    await lockHandle.writeFile(`${proposedLease.lease_id}\n`, "utf8");
    await lockHandle.sync();
    await lockHandle.close();
    lockHandle = undefined;
    try {
      coordinationHandle = await open(coordinationLockPath, "wx", 0o600);
      coordinationLockAcquired = true;
    } catch (error) {
      if (error?.code === "EEXIST") throw new Error(`scheduler coordination lock collision: ${coordinationLockPath}`, { cause: error });
      throw error;
    }
    await coordinationHandle.writeFile(`${proposedLease.lease_id}\n`, "utf8");
    await coordinationHandle.sync();

    let currentState = null;
    try {
      currentState = await readSchedulerState(stateFile);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if ((currentState?.state_digest ?? null) !== (priorState?.state_digest ?? null)) {
      throw new Error("scheduler state changed since the supplied prior-state digest");
    }
    const activeLease = structuredClone(proposedLease);
    activeLease.status = "active";
    activeLease.lease_digest = runstewardDigest(bodyWithoutDigest(activeLease, "lease_digest"));
    const state = buildSchedulerState({
      revision: (priorState?.revision ?? -1) + 1,
      updatedAt: activeLease.acquired_at,
      leases: [...(priorState?.leases ?? []), activeLease],
      childEvaluations: priorState?.child_evaluations ?? []
    });
    await atomicWriteJson(stateFile, state, { beforeRename: beforeStateRename });
    committed = true;
    result = { lease: activeLease, state };
  } catch (error) {
    primaryError = error;
  }
  const cleanupFailures = [];
  await closeForCleanup(lockHandle, "physical lease lock", cleanupFailures);
  await closeForCleanup(coordinationHandle, "scheduler coordination lock", cleanupFailures);
  if (coordinationLockAcquired) await unlinkForCleanup(unlinkPath, coordinationLockPath, "scheduler coordination lock", cleanupFailures);
  if (leaseLockAcquired && !committed) await unlinkForCleanup(unlinkPath, proposedLease.lock_path.path, "failed reservation lease lock", cleanupFailures);
  if (cleanupFailures.length > 0) {
    throw cleanupError(
      committed ? "reservation committed but cleanup failed; residual lock evidence is preserved" : "reservation failed and cleanup failed; residual lock evidence is preserved",
      primaryError,
      cleanupFailures,
      { operation: "reserve", state_committed: committed, lease_lock_path: proposedLease.lock_path.path, coordination_lock_path: coordinationLockPath }
    );
  }
  if (primaryError) throw primaryError;
  return result;
}

export async function releaseReservedLease({ activeLease, stateFile, priorState, releasedAt, releaseReason, beforeStateRename }, options = {}) {
  assertWorktreeLeaseContract(activeLease);
  assertRunStewardDigest(priorState, "state_digest");
  if (activeLease.status !== "active") throw new Error("only an active lease may be released");
  if (typeof releaseReason !== "string" || releaseReason.length === 0 || releaseReason.length > 512) throw new Error("bounded releaseReason is required");
  if (typeof releasedAt !== "string" || !releasedAt.endsWith("Z") || Number.isNaN(Date.parse(releasedAt))) throw new Error("releasedAt must be a UTC timestamp");
  const coordinationLockPath = `${stateFile}.lock`;
  const unlinkPath = options.unlinkPath ?? unlink;
  let coordinationHandle;
  let coordinationLockAcquired = false;
  let stateCommitted = false;
  let physicalLeaseLockRemoved = false;
  let result;
  let primaryError;
  try {
    try {
      coordinationHandle = await open(coordinationLockPath, "wx", 0o600);
      coordinationLockAcquired = true;
    } catch (error) {
      if (error?.code === "EEXIST") throw new Error(`scheduler coordination lock collision: ${coordinationLockPath}`, { cause: error });
      throw error;
    }
    await coordinationHandle.writeFile(`${activeLease.lease_id}:release\n`, "utf8");
    await coordinationHandle.sync();
    const currentState = await readSchedulerState(stateFile);
    if (currentState.state_digest !== priorState.state_digest) throw new Error("scheduler state changed since the supplied prior-state digest");
    const index = currentState.leases.findIndex((lease) => lease.lease_id === activeLease.lease_id && lease.lease_digest === activeLease.lease_digest);
    if (index < 0 || currentState.leases[index].status !== "active") throw new Error("active lease is not bound by current scheduler state");
    const releasedLease = structuredClone(activeLease);
    releasedLease.status = "released";
    releasedLease.last_heartbeat_at = releasedAt;
    releasedLease.release_reason = releaseReason;
    releasedLease.lease_digest = runstewardDigest(bodyWithoutDigest(releasedLease, "lease_digest"));
    const leases = structuredClone(currentState.leases);
    leases[index] = releasedLease;
    const state = buildSchedulerState({
      revision: currentState.revision + 1,
      updatedAt: releasedAt,
      leases,
      childEvaluations: currentState.child_evaluations
    });
    await atomicWriteJson(stateFile, state, { beforeRename: beforeStateRename });
    stateCommitted = true;
    try {
      await unlinkPath(activeLease.lock_path.path);
      physicalLeaseLockRemoved = true;
    } catch (error) {
      throw new Error(`physical lease lock cleanup failed: ${activeLease.lock_path.path}`, { cause: error });
    }
    result = { lease: releasedLease, state };
  } catch (error) {
    primaryError = error;
  }
  const cleanupFailures = [];
  await closeForCleanup(coordinationHandle, "scheduler coordination lock", cleanupFailures);
  if (coordinationLockAcquired) await unlinkForCleanup(unlinkPath, coordinationLockPath, "scheduler coordination lock", cleanupFailures);
  if (stateCommitted && primaryError) {
    throw cleanupError(
      "lease release committed but physical lease lock cleanup failed; residual lock evidence is preserved",
      primaryError,
      cleanupFailures,
      { operation: "release", state_committed: true, physical_lease_lock_removed: physicalLeaseLockRemoved, lease_lock_path: activeLease.lock_path.path, coordination_lock_path: coordinationLockPath }
    );
  }
  if (cleanupFailures.length > 0) {
    throw cleanupError(
      stateCommitted ? "lease release committed but cleanup failed; residual coordination-lock evidence is preserved" : "lease release failed and cleanup failed; residual coordination-lock evidence is preserved",
      primaryError,
      cleanupFailures,
      { operation: "release", state_committed: stateCommitted, physical_lease_lock_removed: physicalLeaseLockRemoved, lease_lock_path: activeLease.lock_path.path, coordination_lock_path: coordinationLockPath }
    );
  }
  if (primaryError) throw primaryError;
  return result;
}

export async function readSchedulerState(stateFile) {
  const bytes = await readFile(stateFile);
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) throw new Error("scheduler state must not contain a UTF-8 BOM");
  const state = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (state.schema_version !== "runsteward.scheduler-state/v1" || !Number.isSafeInteger(state.revision) || state.revision < 0 || !Array.isArray(state.leases) || !Array.isArray(state.child_evaluations)) {
    throw new Error("invalid scheduler state shape");
  }
  assertRunStewardDigest(state, "state_digest");
  state.leases.forEach(assertWorktreeLeaseContract);
  assertLeaseUniqueness(state.leases);
  assertSchedulerPathContainment(state.leases);
  state.child_evaluations.forEach(assertChildDependencyEvaluation);
  return state;
}
