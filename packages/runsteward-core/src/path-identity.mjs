import { createHash } from "node:crypto";
import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";

export class PathIdentityUncertainError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "PathIdentityUncertainError";
    this.code = "RUNSTEWARD_PATH_IDENTITY_UNCERTAIN";
  }
}

const DEFAULT_FS = { lstat, realpath, stat };

function pathApiFor(platform) {
  if (platform === "win32") return path.win32;
  if (platform === "posix") return path.posix;
  throw new PathIdentityUncertainError(`unsupported filesystem platform: ${platform}`);
}

function normalizedForComparison(value, platform) {
  const api = pathApiFor(platform);
  const normalized = api.normalize(value).replace(/[\\/]$/, "");
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isMissing(error) {
  return error?.code === "ENOENT" || error?.code === "ENOTDIR";
}

async function nearestExistingAncestor(absolutePath, api, fsApi) {
  const missingSegments = [];
  let candidate = absolutePath;
  for (;;) {
    try {
      await fsApi.lstat(candidate);
      return { ancestor: candidate, missingSegments: missingSegments.reverse() };
    } catch (error) {
      if (!isMissing(error)) {
        throw new PathIdentityUncertainError(`cannot inspect filesystem identity for ${candidate}: ${error.message}`, { cause: error });
      }
      const parent = api.dirname(candidate);
      if (parent === candidate) {
        throw new PathIdentityUncertainError(`no existing filesystem ancestor for ${absolutePath}`);
      }
      missingSegments.push(api.basename(candidate));
      candidate = parent;
    }
  }
}

function assertSafeMissingSegments(segments) {
  for (const segment of segments) {
    if (!segment || segment === "." || segment === "..") {
      throw new PathIdentityUncertainError("path contains an ambiguous missing segment");
    }
  }
}

function filesystemKind(platform) {
  return platform === "win32" ? "win32" : "posix";
}

export function makePathCollisionKey({ platform, volumeIdentity, canonicalPath }) {
  if (typeof volumeIdentity !== "string" || volumeIdentity.length === 0) {
    throw new PathIdentityUncertainError("filesystem volume identity is unavailable");
  }
  const normalized = normalizedForComparison(canonicalPath, platform);
  const digest = createHash("sha256")
    .update(`runsteward-path-identity-v1\0${filesystemKind(platform)}\0${volumeIdentity}\0${normalized}`, "utf8")
    .digest("hex");
  return `fs:${filesystemKind(platform)}:${digest}`;
}

export async function resolvePathBinding(inputPath, options = {}) {
  const platform = options.platform ?? process.platform;
  const api = pathApiFor(platform);
  const fsApi = options.fsApi ?? DEFAULT_FS;
  if (typeof inputPath !== "string" || inputPath.length === 0) {
    throw new PathIdentityUncertainError("path is required");
  }
  if (!api.isAbsolute(inputPath)) {
    throw new PathIdentityUncertainError(`path must be absolute: ${inputPath}`);
  }
  const absolutePath = api.normalize(inputPath);
  if (platform === "win32" && absolutePath.startsWith("\\\\")) {
    throw new PathIdentityUncertainError(`UNC filesystem identity is not qualified: ${inputPath}`);
  }

  const { ancestor, missingSegments } = await nearestExistingAncestor(absolutePath, api, fsApi);
  assertSafeMissingSegments(missingSegments);
  const ancestorInfo = await fsApi.lstat(ancestor).catch((error) => {
    throw new PathIdentityUncertainError(`cannot inspect existing ancestor ${ancestor}: ${error.message}`, { cause: error });
  });
  if (ancestorInfo.isSymbolicLink()) {
    throw new PathIdentityUncertainError(`reparse or symbolic-link boundary is not allowed: ${ancestor}`);
  }

  let physicalAncestor;
  try {
    physicalAncestor = await fsApi.realpath(ancestor);
  } catch (error) {
    throw new PathIdentityUncertainError(`cannot resolve physical ancestor ${ancestor}: ${error.message}`, { cause: error });
  }
  if (normalizedForComparison(physicalAncestor, platform) !== normalizedForComparison(ancestor, platform)) {
    throw new PathIdentityUncertainError(`path crosses a reparse, junction, or alias boundary: ${inputPath}`);
  }

  let device;
  try {
    device = (await fsApi.stat(physicalAncestor)).dev;
  } catch (error) {
    throw new PathIdentityUncertainError(`cannot identify filesystem volume for ${ancestor}: ${error.message}`, { cause: error });
  }
  if (!Number.isSafeInteger(device) || device < 0) {
    throw new PathIdentityUncertainError(`ambiguous filesystem volume for ${inputPath}`);
  }
  const root = api.parse(physicalAncestor).root;
  if (!root || (platform === "win32" && !/^[A-Za-z]:\\$/.test(root))) {
    throw new PathIdentityUncertainError(`ambiguous filesystem root for ${inputPath}`);
  }

  const canonicalPath = missingSegments.reduce((current, segment) => api.join(current, segment), physicalAncestor);
  const volumeIdentity = `${normalizedForComparison(root, platform)}:${device}`;
  return {
    path: canonicalPath,
    collision_key: makePathCollisionKey({ platform, volumeIdentity, canonicalPath })
  };
}
