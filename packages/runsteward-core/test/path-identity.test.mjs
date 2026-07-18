import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PathIdentityUncertainError, makePathCollisionKey, resolvePathBinding } from "../src/path-identity.mjs";

test("Windows path identity case-folds and normalizes equivalent absolute paths", { skip: process.platform !== "win32" && "win32-only filesystem identity layer; fails closed by design elsewhere" }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "runsteward-path-"));
  try {
    await mkdir(path.join(root, "State"));
    const direct = await resolvePathBinding(path.join(root, "State", "run-one"));
    const equivalent = await resolvePathBinding(path.join(root.toUpperCase(), "State", ".", "run-one"));
    assert.equal(direct.collision_key, equivalent.collision_key);
    assert.match(direct.collision_key, /^fs:win32:[0-9a-f]{64}$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("path identity rejects junction and reparse boundaries", { skip: process.platform !== "win32" && "win32-only filesystem identity layer; fails closed by design elsewhere" }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "runsteward-junction-"));
  try {
    const target = path.join(root, "target");
    const junction = path.join(root, "junction");
    await mkdir(target);
    await symlink(target, junction, "junction");
    await assert.rejects(() => resolvePathBinding(path.join(junction, "run-one")), PathIdentityUncertainError);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("path identity fails closed for unknown platforms, UNC roots, and ambiguous volumes", async () => {
  await assert.rejects(() => resolvePathBinding("/tmp/run", { platform: "mystery" }), /unsupported filesystem platform/);
  await assert.rejects(() => resolvePathBinding("\\\\server\\share\\run", { platform: "win32" }), /UNC filesystem identity/);
  const fsApi = {
    async lstat() { return { isSymbolicLink: () => false }; },
    async realpath(value) { return value; },
    async stat() { return { dev: Number.NaN }; }
  };
  await assert.rejects(() => resolvePathBinding("C:\\state\\run", { platform: "win32", fsApi }), /ambiguous filesystem volume/);
});

test("collision keys bind platform, volume, and canonical path", () => {
  const left = makePathCollisionKey({ platform: "win32", volumeIdentity: "c:\\:7", canonicalPath: "C:\\State\\Run" });
  const caseVariant = makePathCollisionKey({ platform: "win32", volumeIdentity: "c:\\:7", canonicalPath: "c:\\state\\run" });
  const otherVolume = makePathCollisionKey({ platform: "win32", volumeIdentity: "d:\\:8", canonicalPath: "c:\\state\\run" });
  assert.equal(left, caseVariant);
  assert.notEqual(left, otherVolume);
});
