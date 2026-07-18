import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_ROOT = path.resolve(MODULE_DIR, "../../..");
export const CONTRACTS_ROOT = path.join(REPOSITORY_ROOT, "contracts");

export async function readJsonStrict(filePath) {
  const bytes = await readFile(filePath);
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw new Error(`UTF-8 BOM is forbidden: ${filePath}`);
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return JSON.parse(text);
}

export async function loadSchema(contractName) {
  if (!/^[a-z][a-z-]+$/.test(contractName)) {
    throw new Error(`invalid contract name: ${contractName}`);
  }
  return readJsonStrict(path.join(CONTRACTS_ROOT, "runsteward", "v1", `${contractName}.schema.json`));
}

export async function loadFixtureManifest() {
  return readJsonStrict(path.join(CONTRACTS_ROOT, "fixtures", "manifest.json"));
}

export function resolveContractPath(relativePath) {
  if (path.isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes("..")) {
    throw new Error(`fixture path must remain repository-relative: ${relativePath}`);
  }
  const resolved = path.resolve(REPOSITORY_ROOT, relativePath);
  if (resolved !== REPOSITORY_ROOT && !resolved.startsWith(`${REPOSITORY_ROOT}${path.sep}`)) {
    throw new Error(`fixture path escapes repository: ${relativePath}`);
  }
  return resolved;
}
