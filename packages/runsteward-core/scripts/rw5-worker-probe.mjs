import { bodyWithoutDigest, runstewardDigest } from "../src/canonical-json.mjs";
import { atomicWriteJson } from "../src/atomic-write.mjs";
import { resolvePathBinding } from "../src/path-identity.mjs";
import path from "node:path";

const STABLE_ID = /^[a-z][a-z0-9._:-]{2,127}$/u;
const GIT_COMMIT = /^[0-9a-f]{40}$/u;
const MODES = new Set(["blocked", "complete", "recover", "crash"]);

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || values.has(key)) {
      throw new Error("RW5 worker probe arguments must be unique --key value pairs");
    }
    values.set(key, value);
  }
  const result = {
    taskId: values.get("--task-id"),
    worktree: values.get("--worktree"),
    output: values.get("--output"),
    mode: values.get("--mode"),
    sourceHead: values.get("--source-head"),
  };
  if (values.size !== 5 || !STABLE_ID.test(result.taskId ?? "") || !MODES.has(result.mode)
      || !GIT_COMMIT.test(result.sourceHead ?? "") || !path.isAbsolute(result.worktree ?? "")
      || !path.isAbsolute(result.output ?? "")) {
    throw new Error("RW5 worker probe received an invalid bounded argument");
  }
  return result;
}

function samePath(left, right) {
  const a = path.resolve(left).replace(/[\\/]$/u, "");
  const b = path.resolve(right).replace(/[\\/]$/u, "");
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

const input = parseArguments(process.argv.slice(2));
if (!samePath(process.cwd(), input.worktree)) throw new Error("RW5 worker probe cwd differs from its physical worktree binding");
const worktreeBinding = await resolvePathBinding(input.worktree);
const status = input.mode === "blocked" ? "stopped" : "completed";
const proof = {
  schema_version: "runsteward.rw5-worker-proof/v1",
  task_id: input.taskId,
  source_head: input.sourceHead,
  worktree: worktreeBinding,
  mode: input.mode,
  status,
  reason_code: input.mode === "blocked" ? "OWNER_GATE_BLOCKED" : input.mode === "crash" ? "INJECTED_PRE_RENAME_CRASH" : "LOCAL_QUALIFICATION_COMPLETE",
  objective_satisfied: status === "completed",
  final_status_marker: "RUNSTEWARD_FINAL_STATUS",
  provider_calls: 0,
  remote_writes: 0,
  commits: 0,
  pushes: 0,
  proof_digest: null,
};
proof.proof_digest = runstewardDigest(bodyWithoutDigest(proof, "proof_digest"));

if (input.mode === "crash") {
  await atomicWriteJson(input.output, proof, {
    beforeRename: async () => process.exit(86),
  });
  throw new Error("injected crash did not terminate the worker");
}

await atomicWriteJson(input.output, proof);
process.stdout.write(`${JSON.stringify({ task_id: input.taskId, mode: input.mode, status, proof_digest: proof.proof_digest })}\n`);
if (input.mode === "blocked") process.exitCode = 23;
