import { randomUUID } from "node:crypto";
import { open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { canonicalRunStewardBytes } from "./canonical-json.mjs";

export async function atomicWriteJson(targetPath, value, options = {}) {
  const directory = path.dirname(targetPath);
  const base = path.basename(targetPath);
  const temporaryPath = path.join(directory, `.${base}.${process.pid}.${randomUUID()}.tmp`);
  const payload = Buffer.concat([canonicalRunStewardBytes(value), Buffer.from("\n", "utf8")]);
  let handle;
  let renamed = false;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(payload);
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (options.beforeRename) await options.beforeRename({ targetPath, temporaryPath, payload });
    await rename(temporaryPath, targetPath);
    renamed = true;
    return { targetPath, bytesWritten: payload.length };
  } finally {
    if (handle) await handle.close().catch(() => undefined);
    if (!renamed) await unlink(temporaryPath).catch(() => undefined);
  }
}
