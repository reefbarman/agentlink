import { lstat, readFile, readdir, readlink, realpath } from "node:fs/promises";

import { createHash } from "node:crypto";
import path from "node:path";

const MAX_PROTECTED_ENTRIES = 100_000;
const MAX_HASHED_FILE_BYTES = 1024 * 1024;

function isWithin(candidate, root) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function pathsOverlap(left, right) {
  return isWithin(left, right) || isWithin(right, left);
}

function statValue(value) {
  return typeof value === "bigint" ? value.toString() : String(value);
}

async function canonicalizeMutationPath(
  candidatePath,
  seenSymlinks = new Set(),
) {
  let existingAncestor = path.resolve(candidatePath);
  const suffix = [];
  while (true) {
    try {
      return path.join(
        await realpath(existingAncestor),
        ...suffix.toReversed(),
      );
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
      try {
        const stat = await lstat(existingAncestor);
        if (!stat.isSymbolicLink()) {
          throw error;
        }
        if (seenSymlinks.has(existingAncestor)) {
          throw new Error(
            `trusted-host mutation path contains a symbolic-link cycle: ${candidatePath}`,
          );
        }
        seenSymlinks.add(existingAncestor);
        const target = await readlink(existingAncestor);
        return canonicalizeMutationPath(
          path.join(
            path.resolve(path.dirname(existingAncestor), target),
            ...suffix.toReversed(),
          ),
          seenSymlinks,
        );
      } catch (statError) {
        if (statError?.code !== "ENOENT") {
          throw statError;
        }
      }
      const parent = path.dirname(existingAncestor);
      if (parent === existingAncestor) {
        throw error;
      }
      suffix.push(path.basename(existingAncestor));
      existingAncestor = parent;
    }
  }
}

async function canonicalizeProtectedRoot(requestedRoot) {
  const requested = path.resolve(requestedRoot);
  const requestedStat = await lstat(requested, { bigint: true });
  if (requestedStat.isSymbolicLink()) {
    throw new Error(`protected root must not be a symbolic link: ${requested}`);
  }
  const canonical = await realpath(requested);
  const canonicalStat = await lstat(canonical, { bigint: true });
  if (!canonicalStat.isDirectory() && !canonicalStat.isFile()) {
    throw new Error(
      `protected root must be a regular file or directory: ${canonical}`,
    );
  }
  return canonical;
}

export async function canonicalizeProtectedRoots(requestedRoots) {
  const canonicalRoots = [];
  for (const requestedRoot of requestedRoots) {
    const canonical = await canonicalizeProtectedRoot(requestedRoot);
    if (canonicalRoots.some((root) => isWithin(canonical, root))) {
      continue;
    }
    for (let index = canonicalRoots.length - 1; index >= 0; index -= 1) {
      if (isWithin(canonicalRoots[index], canonical)) {
        canonicalRoots.splice(index, 1);
      }
    }
    canonicalRoots.push(canonical);
  }
  return canonicalRoots.sort();
}

async function snapshotNode(root, target, entries) {
  if (entries.length >= MAX_PROTECTED_ENTRIES) {
    throw new Error(
      `protected tree exceeds ${MAX_PROTECTED_ENTRIES} entries: ${root}`,
    );
  }
  const stat = await lstat(target, { bigint: true });
  const relativePath = path.relative(root, target) || ".";
  if (stat.isSymbolicLink()) {
    throw new Error(`protected tree contains a symbolic link: ${target}`);
  }
  if (stat.isFile() && stat.nlink !== 1n) {
    throw new Error(
      `protected file has unexpected hard-link count ${stat.nlink}: ${target}`,
    );
  }
  if (!stat.isDirectory() && !stat.isFile()) {
    throw new Error(`protected tree contains an unsupported node: ${target}`);
  }

  entries.push({
    path: relativePath,
    type: stat.isDirectory() ? "directory" : "file",
    dev: statValue(stat.dev),
    ino: statValue(stat.ino),
    mode: statValue(stat.mode),
    nlink: statValue(stat.nlink),
    uid: statValue(stat.uid),
    gid: statValue(stat.gid),
    size: statValue(stat.size),
    mtimeNs: statValue(stat.mtimeNs),
    ctimeNs: statValue(stat.ctimeNs),
  });

  if (!stat.isDirectory()) {
    return;
  }
  const children = await readdir(target);
  children.sort();
  for (const child of children) {
    await snapshotNode(root, path.join(target, child), entries);
  }
}

async function hashSmallPolicyFile(target, size) {
  if (size > MAX_HASHED_FILE_BYTES) {
    return undefined;
  }
  const content = await readFile(target);
  return createHash("sha256").update(content).digest("hex");
}

async function snapshotRoot(root) {
  const entries = [];
  await snapshotNode(root, root, entries);
  for (const entry of entries) {
    if (entry.type === "file") {
      entry.contentHash = await hashSmallPolicyFile(
        path.join(root, entry.path === "." ? "" : entry.path),
        Number(entry.size),
      );
    }
  }
  return { root, entries };
}

export async function prepareProtectedRoots(requestedRoots) {
  const roots = await canonicalizeProtectedRoots(requestedRoots);
  const snapshots = [];
  for (const root of roots) {
    snapshots.push(await snapshotRoot(root));
  }
  return { roots, snapshots };
}

export async function revalidateProtectedRoots(prepared) {
  const roots = await canonicalizeProtectedRoots(prepared.roots);
  if (JSON.stringify(roots) !== JSON.stringify(prepared.roots)) {
    throw new Error("protected roots changed after preparation");
  }
  const snapshots = [];
  for (const root of roots) {
    snapshots.push(await snapshotRoot(root));
  }
  if (JSON.stringify(snapshots) !== JSON.stringify(prepared.snapshots)) {
    throw new Error("protected root contents changed before spawn");
  }
}

export class ProtectedRootLeaseCoordinator {
  #leases = new Map();
  #mutations = new Map();
  #nextLeaseId = 1;
  #nextMutationId = 1;

  async acquire(requestedRoots) {
    const roots = await canonicalizeProtectedRoots(requestedRoots);
    for (const candidates of this.#mutations.values()) {
      for (const root of roots) {
        const conflict = candidates.find((candidate) =>
          pathsOverlap(candidate, root),
        );
        if (conflict) {
          throw new Error(
            `protected root overlaps an active trusted-host mutation: ${conflict}`,
          );
        }
      }
    }
    const id = this.#nextLeaseId;
    this.#nextLeaseId += 1;
    this.#leases.set(id, roots);
    let released = false;
    return {
      roots,
      release: () => {
        if (released) {
          return;
        }
        released = true;
        this.#leases.delete(id);
      },
    };
  }

  #assertCanonicalMutationAllowed(canonicalCandidates) {
    for (const roots of this.#leases.values()) {
      for (const root of roots) {
        const conflict = canonicalCandidates.find((candidate) =>
          pathsOverlap(candidate, root),
        );
        if (conflict) {
          throw new Error(
            `trusted-host mutation overlaps an active protected root lease: ${conflict}`,
          );
        }
      }
    }
  }

  async runMutation(candidatePaths, mutation) {
    const canonicalCandidates = await Promise.all(
      candidatePaths.map((candidate) => canonicalizeMutationPath(candidate)),
    );
    this.#assertCanonicalMutationAllowed(canonicalCandidates);
    const id = this.#nextMutationId;
    this.#nextMutationId += 1;
    this.#mutations.set(id, canonicalCandidates);
    try {
      return await mutation();
    } finally {
      this.#mutations.delete(id);
    }
  }

  async withLease(requestedRoots, operation) {
    const lease = await this.acquire(requestedRoots);
    try {
      return await operation(lease);
    } finally {
      lease.release();
    }
  }
}
