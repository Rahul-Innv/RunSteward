import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(packageRoot, "../..");

function run(command, args) {
  const result = spawnSync(command, args, { cwd: repositoryRoot, stdio: "inherit", shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(process.execPath, [path.join(packageRoot, "scripts", "validate-fixtures.mjs")]);
run(process.env.PYTHON || "python.exe", ["-B", path.join(packageRoot, "scripts", "materialize_rw4_choicegate_fixtures.py"), "--check"]);
run(process.env.PYTHON || "python.exe", ["-B", path.join(repositoryRoot, "tests", "contract-compat", "python_hash_vectors.py")]);
const packageTestRoots = [
  packageRoot,
  path.join(repositoryRoot, "packages", "runsteward-cli"),
  path.join(repositoryRoot, "packages", "runsteward-adapter-claude-code"),
  path.join(repositoryRoot, "packages", "runsteward-adapter-codex"),
  path.join(repositoryRoot, "packages", "runsteward-sensor-claude-limits"),
  path.join(repositoryRoot, "packages", "runsteward-sensor-codex-usage")
];
const tests = packageTestRoots.flatMap((root) => readdirSync(path.join(root, "test"))
  .filter((name) => name.endsWith(".test.mjs"))
  .sort()
  .map((name) => path.join(root, "test", name)));
run(process.execPath, ["--test", ...tests]);
