import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { atomicWriteJson } from "../src/atomic-write.mjs";

test("atomic write preserves the old file on pre-rename failure and leaves no temporary file", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "runsteward-atomic-"));
  const target = path.join(directory, "state.json");
  try {
    await writeFile(target, "old\n", "utf8");
    await assert.rejects(() => atomicWriteJson(target, { value: 1 }, { beforeRename: () => { throw new Error("injected-fault"); } }), /injected-fault/);
    assert.equal(await readFile(target, "utf8"), "old\n");
    assert.deepEqual(await readdir(directory), ["state.json"]);
    await atomicWriteJson(target, { value: 2 });
    assert.equal(await readFile(target, "utf8"), '{"value":2}\n');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
