import { createHash } from "node:crypto";

export const RUNSTEWARD_CANONICAL_ALGORITHM = "runsteward-canonical-json-sha256-v1";

const KEY_PATTERN = /^[A-Za-z_$][A-Za-z0-9_.:$-]*$/;
const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

function assertUnicodeScalarString(value, label) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new TypeError(`${label} contains an unpaired high surrogate`);
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError(`${label} contains an unpaired low surrogate`);
    }
  }
}

function serialize(value, path) {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") {
    assertUnicodeScalarString(value, path);
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) {
      throw new TypeError(`${path} must be a finite safe integer`);
    }
    if (Object.is(value, -0)) {
      throw new TypeError(`${path} must not be negative zero`);
    }
    if (Math.abs(value) > MAX_SAFE_INTEGER) {
      throw new TypeError(`${path} exceeds the safe integer domain`);
    }
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item, index) => serialize(item, `${path}[${index}]`)).join(",")}]`;
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${path} must be a plain object`);
    }
    const keys = Object.keys(value).sort();
    const members = keys.map((key) => {
      if (!KEY_PATTERN.test(key)) {
        throw new TypeError(`${path} has a key outside the ASCII contract domain: ${key}`);
      }
      return `${JSON.stringify(key)}:${serialize(value[key], `${path}.${key}`)}`;
    });
    return `{${members.join(",")}}`;
  }
  throw new TypeError(`${path} contains unsupported type ${typeof value}`);
}

export function canonicalizeRunSteward(value) {
  return serialize(value, "$");
}

export function canonicalRunStewardBytes(value) {
  return Buffer.from(canonicalizeRunSteward(value), "utf8");
}

export function runstewardDigest(value) {
  return `sha256:${createHash("sha256").update(canonicalRunStewardBytes(value)).digest("hex")}`;
}

export function bodyWithoutDigest(value, digestField) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("digest-bearing value must be an object");
  }
  const body = { ...value };
  delete body[digestField];
  return body;
}

export function assertRunStewardDigest(value, digestField) {
  const expected = runstewardDigest(bodyWithoutDigest(value, digestField));
  if (value[digestField] !== expected) {
    throw new Error(`${digestField} mismatch: expected ${expected}`);
  }
  return expected;
}
