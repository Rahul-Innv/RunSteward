import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { bodyWithoutDigest, runstewardDigest } from "../src/canonical-json.mjs";
import { readJsonStrict, resolveContractPath } from "../src/contract-loader.mjs";
import {
  assessLeaseExpiry, assertAllocationAvailable, buildSchedulerState, parseGitWorktreePorcelain,
  proposeInitialLease, proposeSuccessorLease, readSchedulerState, releaseReservedLease, reserveLease
} from "../src/scheduler.mjs";

const OWNER = {
  executor_id: "executor:rw2-test",
  process_session_ref: `sha256:${"8".repeat(64)}`,
  host_fingerprint: `sha256:${"9".repeat(64)}`
};
const SOURCE = "d".repeat(40);

function input(root, taskId = "task:rw2-one", acquiredAt = "2026-07-15T05:00:00Z") {
  return {
    taskId, repositoryId: "runsteward", sourceHead: SOURCE,
    roots: {
      worktree: path.join(root, "worktrees"), state: path.join(root, "state"),
      evidence: path.join(root, "evidence"), lock: path.join(root, "locks")
    },
    owner: OWNER, acquiredAt, ttlMs: 300000
  };
}

function rehash(lease) {
  lease.lease_digest = runstewardDigest(bodyWithoutDigest(lease, "lease_digest"));
  return lease;
}

function inventory(overrides = {}) {
  return { branches: [], worktrees: [], leases: [], ...overrides };
}

test("allocator is deterministic per task and unique across task identities", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "runsteward-allocator-"));
  try {
    const first = await proposeInitialLease(input(root));
    const repeat = await proposeInitialLease(input(root));
    const second = await proposeInitialLease(input(root, "task:rw2-two"));
    assert.deepEqual(first, repeat);
    const schema = await readJsonStrict(resolveContractPath("contracts/runsteward/v1/worktree-lease.schema.json"));
    assert.deepEqual(Object.keys(first).sort(), schema.required.toSorted());
    assert.equal(first.status, "proposed");
    for (const key of ["run_id", "lease_id", "branch_name"]) assert.notEqual(first[key], second[key]);
    for (const key of ["worktree", "state_path", "evidence_path", "lock_path"]) assert.notEqual(first[key].collision_key, second[key].collision_key);
    assert.equal(await assertAllocationAvailable(first, inventory()), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("allocator fails closed on omitted or partial physical inventory and detects fixture Git collisions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "runsteward-inventory-"));
  try {
    const lease = await proposeInitialLease(input(root));
    await assert.rejects(() => assertAllocationAvailable(lease), /complete physical inventory/);
    await assert.rejects(() => assertAllocationAvailable(lease, { branches: [], worktrees: [] }), /complete physical inventory/);
    await assert.rejects(() => assertAllocationAvailable(lease, { branches: [], leases: [] }), /complete physical inventory/);
    await assert.rejects(() => assertAllocationAvailable(lease, { worktrees: [], leases: [] }), /complete physical inventory/);
    const fixture = parseGitWorktreePorcelain([
      `worktree ${lease.worktree.path}`, `HEAD ${SOURCE}`, `branch refs/heads/${lease.branch_name}`, ""
    ].join("\n"));
    await assert.rejects(() => assertAllocationAvailable(lease, inventory({
      branches: fixture.map((item) => item.branch), worktrees: []
    })), /branch collision/);
    await assert.rejects(() => assertAllocationAvailable(lease, inventory({
      branches: [], worktrees: fixture
    })), /worktree collision/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("allocator rejects branch, worktree, run, state, evidence, lock, and stale-lease collisions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "runsteward-collisions-"));
  try {
    const lease = await proposeInitialLease(input(root));
    await assert.rejects(() => assertAllocationAvailable(lease, inventory({ branches: [lease.branch_name.toUpperCase()] })), /branch collision/);
    await assert.rejects(() => assertAllocationAvailable(lease, inventory({ worktrees: [lease.worktree] })), /worktree collision/);
    await assert.rejects(() => assertAllocationAvailable(lease, inventory({ worktrees: [{
      path: path.join(lease.worktree.path, "nested"), collision_key: `fs:win32:${"0".repeat(64)}`
    }] })), /worktree collision/);
    const other = await proposeInitialLease(input(root, "task:other"));
    const collisionFields = new Map([
      ["run_id", /lease epoch/], ["task_id", /task_id/], ["branch_name", /branch_name/],
      ["worktree", /worktree/], ["state_path", /state_path/], ["evidence_path", /evidence_path/], ["lock_path", /lock_path/]
    ]);
    for (const [field, expected] of collisionFields) {
      const conflicting = structuredClone(other);
      conflicting[field] = structuredClone(lease[field]);
      conflicting.status = "stale";
      rehash(conflicting);
      await assert.rejects(() => assertAllocationAvailable(lease, inventory({ leases: [conflicting] })), expected);
    }
    const nestedExisting = structuredClone(other);
    nestedExisting.state_path.path = path.join(lease.state_path.path, "nested");
    rehash(nestedExisting);
    await assert.rejects(() => assertAllocationAvailable(lease, inventory({ leases: [nestedExisting] })), /path containment/);
    const internallyNested = structuredClone(lease);
    internallyNested.state_path.path = path.join(lease.worktree.path, "state");
    rehash(internallyNested);
    await assert.rejects(() => assertAllocationAvailable(internallyNested, inventory()), /proposed lease path containment/);
    const stale = structuredClone(other);
    stale.state_path = structuredClone(lease.state_path);
    stale.status = "stale";
    rehash(stale);
    const expired = assessLeaseExpiry(stale, "2026-07-15T06:00:00Z");
    assert.deepEqual(expired, {
      state: "stale-evidence-only", takeover_allowed: false,
      required_action: "owner-authorized-reclamation-with-preserved-predecessor-evidence"
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("successor lease requires explicit release and binds the next epoch and predecessor digest", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "runsteward-successor-"));
  try {
    const proposed = await proposeInitialLease(input(root));
    const active = structuredClone(proposed);
    active.status = "active";
    rehash(active);
    assert.throws(() => proposeSuccessorLease(active, {
      observedHead: SOURCE, acquiredAt: "2026-07-15T06:00:00Z", ttlMs: 300000, previousLeaseRef: "leases/one.json"
    }), /released predecessor/);
    const released = structuredClone(active);
    released.status = "released";
    released.release_reason = "Completed bounded attempt.";
    rehash(released);
    for (const previousLeaseRef of [undefined, null, 42, {}, [], "", " ", " leases/one.json", "../leases/one.json", "C:/leases/one.json"]) {
      assert.throws(() => proposeSuccessorLease(released, {
        observedHead: SOURCE, acquiredAt: "2026-07-15T06:00:00Z", ttlMs: 300000, previousLeaseRef
      }), /previousLeaseRef/);
    }
    const invalidPredecessorSchema = structuredClone(released);
    invalidPredecessorSchema.schema_version = "runsteward.worktree-lease/v999";
    rehash(invalidPredecessorSchema);
    assert.throws(() => proposeSuccessorLease(invalidPredecessorSchema, {
      observedHead: SOURCE, acquiredAt: "2026-07-15T06:00:00Z", ttlMs: 300000, previousLeaseRef: "leases/one.released.json"
    }), /pinned RW1 worktree-lease contract/);
    const releasedWithoutReason = structuredClone(released);
    releasedWithoutReason.release_reason = null;
    rehash(releasedWithoutReason);
    assert.throws(() => proposeSuccessorLease(releasedWithoutReason, {
      observedHead: SOURCE, acquiredAt: "2026-07-15T06:00:00Z", ttlMs: 300000, previousLeaseRef: "leases/one.released.json"
    }), /released lease requires/);
    const successor = proposeSuccessorLease(released, {
      observedHead: SOURCE, acquiredAt: "2026-07-15T06:00:00Z", ttlMs: 300000, previousLeaseRef: "leases/one.released.json"
    });
    assert.equal(successor.lease_epoch, 2);
    assert.equal(successor.previous_lease_id, released.lease_id);
    assert.equal(successor.previous_lease_ref.digest, released.lease_digest);
    assert.equal(successor.status, "proposed");
    const forgedSuccessor = structuredClone(successor);
    forgedSuccessor.previous_lease_ref.ref = "";
    rehash(forgedSuccessor);
    assert.throws(() => buildSchedulerState({
      revision: 0, updatedAt: "2026-07-15T06:00:00Z", leases: [released, forgedSuccessor]
    }), /previous_lease_ref/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("physical lock acquisition and scheduler state replacement are exclusive and failure-clean", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "runsteward-reserve-"));
  try {
    const first = await proposeInitialLease(input(root));
    const stateFile = path.join(root, "scheduler", "state.json");
    await assert.rejects(() => reserveLease({ proposedLease: first, stateFile, inventory: inventory() }, {
      resolvePathBinding: async (value) => value === first.worktree.path
        ? { path: value, collision_key: `fs:win32:${"f".repeat(64)}` }
        : first[Object.keys(first).find((key) => first[key]?.path === value)]
    }), /physical worktree identity changed/);
    await assert.rejects(() => readFile(first.lock_path.path), /ENOENT/);
    const reservation = await reserveLease({ proposedLease: first, stateFile, inventory: inventory() });
    assert.equal(reservation.lease.status, "active");
    assert.deepEqual(await readSchedulerState(stateFile), reservation.state);
    await assert.rejects(() => readFile(`${stateFile}.lock`), /ENOENT/);
    await assert.rejects(() => reserveLease({ proposedLease: first, stateFile, inventory: inventory() }), /physical lease lock collision/);
    assert.equal(await readFile(first.lock_path.path, "utf8"), `${first.lease_id}\n`);

    const second = await proposeInitialLease(input(root, "task:rw2-two", "2026-07-15T05:01:00Z"));
    const before = await readFile(stateFile, "utf8");
    await assert.rejects(() => reserveLease({
      proposedLease: second, stateFile, priorState: reservation.state,
      inventory: inventory({ leases: reservation.state.leases }), beforeStateRename: async () => { throw new Error("injected state failure"); }
    }), /injected state failure/);
    assert.equal(await readFile(stateFile, "utf8"), before);
    await assert.rejects(() => readFile(second.lock_path.path), /ENOENT/);
    assert.deepEqual((await readdir(path.dirname(stateFile))).filter((name) => name.endsWith(".tmp")), []);

    const beforeRelease = await readFile(stateFile, "utf8");
    await assert.rejects(() => releaseReservedLease({
      activeLease: reservation.lease, stateFile, priorState: reservation.state,
      releasedAt: "2026-07-15T05:04:00Z", releaseReason: "Injected release failure.",
      beforeStateRename: async () => { throw new Error("injected release failure"); }
    }), /injected release failure/);
    assert.equal(await readFile(stateFile, "utf8"), beforeRelease);
    assert.equal(await readFile(first.lock_path.path, "utf8"), `${first.lease_id}\n`);
    const released = await releaseReservedLease({
      activeLease: reservation.lease, stateFile, priorState: reservation.state,
      releasedAt: "2026-07-15T05:05:00Z", releaseReason: "Completed the bounded physical reservation test."
    });
    assert.equal(released.lease.status, "released");
    await assert.rejects(() => readFile(first.lock_path.path), /ENOENT/);
    const successor = proposeSuccessorLease(released.lease, {
      observedHead: SOURCE, acquiredAt: "2026-07-15T05:06:00Z", ttlMs: 300000,
      previousLeaseRef: "leases/rw2-one.epoch1.released.json"
    });
    const resumed = await reserveLease({
      proposedLease: successor, stateFile, priorState: released.state, inventory: inventory({ leases: released.state.leases })
    });
    assert.equal(resumed.lease.lease_epoch, 2);
    assert.equal(resumed.state.leases.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed reservation reports failed lease-lock cleanup and preserves residual evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "runsteward-reserve-cleanup-"));
  try {
    const lease = await proposeInitialLease(input(root));
    const stateFile = path.join(root, "scheduler", "state.json");
    await assert.rejects(() => reserveLease({
      proposedLease: lease, stateFile, inventory: inventory(),
      beforeStateRename: async () => { throw new Error("injected reservation failure"); }
    }, {
      unlinkPath: async (target) => {
        if (target === lease.lock_path.path) throw new Error("injected failed-reservation unlink failure");
        return unlink(target);
      }
    }), (error) => {
      assert.equal(error.code, "RUNSTEWARD_CLEANUP_REQUIRED");
      assert.equal(error.recovery.operation, "reserve");
      assert.equal(error.recovery.state_committed, false);
      assert.match(error.message, /reservation failed and cleanup failed/);
      return true;
    });
    assert.equal(await readFile(lease.lock_path.path, "utf8"), `${lease.lease_id}\n`);
    await assert.rejects(() => readFile(stateFile), /ENOENT/);
    await assert.rejects(() => readFile(`${stateFile}.lock`), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("committed reservation reports coordinator cleanup failure without claiming clean success", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "runsteward-coordinate-cleanup-"));
  try {
    const lease = await proposeInitialLease(input(root));
    const stateFile = path.join(root, "scheduler", "state.json");
    await assert.rejects(() => reserveLease({ proposedLease: lease, stateFile, inventory: inventory() }, {
      unlinkPath: async (target) => {
        if (target === `${stateFile}.lock`) throw new Error("injected coordinator unlink failure");
        return unlink(target);
      }
    }), (error) => {
      assert.equal(error.code, "RUNSTEWARD_CLEANUP_REQUIRED");
      assert.equal(error.recovery.state_committed, true);
      assert.match(error.message, /reservation committed but cleanup failed/);
      return true;
    });
    const state = await readSchedulerState(stateFile);
    assert.equal(state.leases[0].status, "active");
    assert.equal(await readFile(lease.lock_path.path, "utf8"), `${lease.lease_id}\n`);
    assert.equal(await readFile(`${stateFile}.lock`, "utf8"), `${lease.lease_id}\n`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("committed release reports physical lease-lock cleanup failure and preserves released state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "runsteward-release-cleanup-"));
  try {
    const proposed = await proposeInitialLease(input(root));
    const stateFile = path.join(root, "scheduler", "state.json");
    const reserved = await reserveLease({ proposedLease: proposed, stateFile, inventory: inventory() });
    await assert.rejects(() => releaseReservedLease({
      activeLease: reserved.lease, stateFile, priorState: reserved.state,
      releasedAt: "2026-07-15T05:05:00Z", releaseReason: "Injected physical cleanup evidence."
    }, {
      unlinkPath: async (target) => {
        if (target === proposed.lock_path.path) throw new Error("injected release unlink failure");
        return unlink(target);
      }
    }), (error) => {
      assert.equal(error.code, "RUNSTEWARD_CLEANUP_REQUIRED");
      assert.equal(error.recovery.state_committed, true);
      assert.equal(error.recovery.physical_lease_lock_removed, false);
      assert.match(error.message, /release committed but physical lease lock cleanup failed/);
      return true;
    });
    const state = await readSchedulerState(stateFile);
    assert.equal(state.leases[0].status, "released");
    assert.equal(await readFile(proposed.lock_path.path, "utf8"), `${proposed.lease_id}\n`);
    await assert.rejects(() => readFile(`${stateFile}.lock`), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("committed release reports residual coordinator lock after physical lease cleanup", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "runsteward-release-coordinate-cleanup-"));
  try {
    const proposed = await proposeInitialLease(input(root));
    const stateFile = path.join(root, "scheduler", "state.json");
    const reserved = await reserveLease({ proposedLease: proposed, stateFile, inventory: inventory() });
    await assert.rejects(() => releaseReservedLease({
      activeLease: reserved.lease, stateFile, priorState: reserved.state,
      releasedAt: "2026-07-15T05:05:00Z", releaseReason: "Injected coordinator cleanup evidence."
    }, {
      unlinkPath: async (target) => {
        if (target === `${stateFile}.lock`) throw new Error("injected release coordinator unlink failure");
        return unlink(target);
      }
    }), (error) => {
      assert.equal(error.code, "RUNSTEWARD_CLEANUP_REQUIRED");
      assert.equal(error.recovery.state_committed, true);
      assert.equal(error.recovery.physical_lease_lock_removed, true);
      assert.match(error.message, /release committed but cleanup failed/);
      return true;
    });
    const state = await readSchedulerState(stateFile);
    assert.equal(state.leases[0].status, "released");
    await assert.rejects(() => readFile(proposed.lock_path.path), /ENOENT/);
    assert.equal(await readFile(`${stateFile}.lock`, "utf8"), `${proposed.lease_id}:release\n`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("scheduler coordination lock and prior-state digest prevent concurrent lost updates", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "runsteward-concurrent-reserve-"));
  try {
    const stateFile = path.join(root, "scheduler", "state.json");
    const seed = await proposeInitialLease(input(root, "task:seed"));
    const seeded = await reserveLease({ proposedLease: seed, stateFile, inventory: inventory() });
    const first = await proposeInitialLease(input(root, "task:concurrent-a", "2026-07-15T05:01:00Z"));
    const second = await proposeInitialLease(input(root, "task:concurrent-b", "2026-07-15T05:02:00Z"));
    let releaseRename;
    let enteredRename;
    const entered = new Promise((resolve) => { enteredRename = resolve; });
    const held = new Promise((resolve) => { releaseRename = resolve; });
    const firstReservation = reserveLease({
      proposedLease: first, stateFile, priorState: seeded.state, inventory: inventory({ leases: seeded.state.leases }),
      beforeStateRename: async () => { enteredRename(); await held; }
    });
    await entered;
    await assert.rejects(() => reserveLease({
      proposedLease: second, stateFile, priorState: seeded.state, inventory: inventory({ leases: seeded.state.leases })
    }), /scheduler coordination lock collision/);
    await assert.rejects(() => readFile(second.lock_path.path), /ENOENT/);
    releaseRename();
    const firstResult = await firstReservation;
    await assert.rejects(() => reserveLease({
      proposedLease: second, stateFile, priorState: seeded.state, inventory: inventory({ leases: firstResult.state.leases })
    }), /scheduler state changed/);
    await assert.rejects(() => readFile(second.lock_path.path), /ENOENT/);
    const secondResult = await reserveLease({
      proposedLease: second, stateFile, priorState: firstResult.state, inventory: inventory({ leases: firstResult.state.leases })
    });
    assert.equal(secondResult.state.leases.length, 3);
    assert.deepEqual(await readSchedulerState(stateFile), secondResult.state);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("scheduler state digest and lease invariants reject tampering", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "runsteward-state-"));
  try {
    const lease = await proposeInitialLease(input(root));
    const state = buildSchedulerState({ revision: 0, updatedAt: "2026-07-15T05:00:00Z", leases: [lease] });
    assert.match(state.state_digest, /^sha256:[0-9a-f]{64}$/);
    state.revision = 1;
    assert.throws(() => buildSchedulerState({ revision: 0, updatedAt: state.updated_at, leases: [lease, lease] }), /duplicate lease_id/);
    for (const releaseReason of ["", "x".repeat(513)]) {
      const invalidActive = structuredClone(lease);
      invalidActive.status = "active";
      invalidActive.release_reason = releaseReason;
      rehash(invalidActive);
      assert.throws(() => buildSchedulerState({
        revision: 0, updatedAt: state.updated_at, leases: [invalidActive]
      }), /release_reason/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Git worktree porcelain parser preserves physical branch and lock facts", () => {
  const records = parseGitWorktreePorcelain([
    "worktree C:/repo", `HEAD ${SOURCE}`, "branch refs/heads/main", "",
    "worktree C:/repo-wt", `HEAD ${SOURCE}`, "branch refs/heads/feature/rw2", "locked qualification evidence", ""
  ].join("\n"));
  assert.deepEqual(records, [
    { path: "C:/repo", head: SOURCE, branch: "main", detached: false, bare: false, locked: false, prunable: false },
    { path: "C:/repo-wt", head: SOURCE, branch: "feature/rw2", detached: false, bare: false, locked: true, prunable: false }
  ]);
});
