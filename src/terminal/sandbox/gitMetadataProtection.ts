import { lstat, readFile, realpath } from "node:fs/promises";

import { SandboxStructuralProtectionError } from "./SandboxRuntimeProvider.js";
import path from "node:path";

const GIT_INTEGRITY_ENTRIES = [
  "config",
  "config.worktree",
  "hooks",
  "commondir",
  "gitdir",
] as const;

export interface WorkspaceGitProtection {
  readonly workspaceRoot: string;
  readonly marker: string;
  readonly markerExists: boolean;
  readonly deniedWrite: string[];
  readonly integrity: string[];
  readonly structural: string[];
  readonly readable: string[];
}

function isWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function uniqueRoots(roots: readonly string[]): string[] {
  const sorted = [...new Set(roots.map((root) => path.normalize(root)))].sort(
    (left, right) => left.length - right.length || left.localeCompare(right),
  );
  const result: string[] = [];
  for (const root of sorted) {
    if (!result.some((candidate) => isWithin(root, candidate))) {
      result.push(root);
    }
  }
  return result.sort((left, right) => left.localeCompare(right));
}

async function resolveGitIntegrityEntry(
  gitDirectory: string,
  entry: (typeof GIT_INTEGRITY_ENTRIES)[number],
): Promise<string | undefined> {
  const candidate = path.join(gitDirectory, entry);
  let metadata;
  try {
    metadata = await lstat(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (metadata.isSymbolicLink()) {
    throw new SandboxStructuralProtectionError(
      `Workspace Git integrity entry must not be a symbolic link: ${candidate}`,
      { kind: "symbolic_link", path: candidate },
    );
  }
  if (!metadata.isDirectory() && !metadata.isFile()) {
    throw new SandboxStructuralProtectionError(
      `Workspace Git integrity entry must be a regular file or directory: ${candidate}`,
      { kind: "unsupported_node", path: candidate },
    );
  }
  return realpath(candidate);
}

async function resolveGitIntegrityRoots(
  gitDirectory: string,
): Promise<string[]> {
  const roots = await Promise.all(
    GIT_INTEGRITY_ENTRIES.map((entry) =>
      resolveGitIntegrityEntry(gitDirectory, entry),
    ),
  );
  return roots.filter((entry): entry is string => entry !== undefined);
}

export async function resolveWorkspaceGitProtection(
  workspaceRoot: string,
): Promise<WorkspaceGitProtection> {
  const canonicalWorkspaceRoot = await realpath(workspaceRoot);
  const marker = path.join(canonicalWorkspaceRoot, ".git");
  let markerMetadata;
  try {
    markerMetadata = await lstat(marker);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        workspaceRoot: canonicalWorkspaceRoot,
        marker,
        markerExists: false,
        deniedWrite: [marker],
        integrity: [],
        structural: [],
        readable: [],
      };
    }
    throw error;
  }
  if (markerMetadata.isSymbolicLink()) {
    throw new SandboxStructuralProtectionError(
      `Workspace .git path must not be a symbolic link: ${marker}`,
      { kind: "symbolic_link", path: marker },
    );
  }
  if (!markerMetadata.isDirectory() && !markerMetadata.isFile()) {
    throw new SandboxStructuralProtectionError(
      `Workspace .git path must be a regular file or directory: ${marker}`,
      { kind: "unsupported_node", path: marker },
    );
  }

  const metadata = await realpath(marker);
  const deniedWrite = [marker, metadata];
  const integrity: string[] = [];
  const structural: string[] = [];
  const readable = [metadata];
  if (markerMetadata.isFile()) {
    integrity.push(metadata);
    const pointer = await readFile(marker, "utf8");
    const match = /^gitdir:\s*(.+?)\s*$/im.exec(pointer);
    if (!match) throw new Error(`Invalid Git worktree pointer: ${marker}`);
    const gitDirectory = await realpath(
      path.resolve(canonicalWorkspaceRoot, match[1] as string),
    );
    deniedWrite.push(gitDirectory);
    readable.push(gitDirectory);
    structural.push(gitDirectory);
    integrity.push(...(await resolveGitIntegrityRoots(gitDirectory)));

    try {
      const commonPointer = await readFile(
        path.join(gitDirectory, "commondir"),
        "utf8",
      );
      const commonDirectory = await realpath(
        path.resolve(gitDirectory, commonPointer.trim()),
      );
      deniedWrite.push(commonDirectory);
      readable.push(commonDirectory);
      structural.push(commonDirectory);
      integrity.push(...(await resolveGitIntegrityRoots(commonDirectory)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  } else {
    structural.push(metadata);
    integrity.push(...(await resolveGitIntegrityRoots(metadata)));
  }

  return {
    workspaceRoot: canonicalWorkspaceRoot,
    marker,
    markerExists: true,
    deniedWrite: uniqueRoots(deniedWrite),
    integrity: uniqueRoots(integrity),
    structural: uniqueRoots(structural),
    readable: uniqueRoots(readable),
  };
}

async function nearestGitMarker(
  cwd: string,
  workspaceRoot: string,
): Promise<string | undefined> {
  let current = cwd;
  while (isWithin(current, workspaceRoot)) {
    const marker = path.join(current, ".git");
    try {
      const metadata = await lstat(marker);
      if (
        metadata.isDirectory() ||
        metadata.isFile() ||
        metadata.isSymbolicLink()
      ) {
        return marker;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (current === workspaceRoot) break;
    current = path.dirname(current);
  }
  return undefined;
}

export async function resolveBaselineProtectedGitMetadataForCwd(
  cwd: string,
  workspaceRoots: readonly string[],
  options: { includeAbsentWorkspaceMarker?: boolean } = {},
): Promise<WorkspaceGitProtection | undefined> {
  const canonicalCwd = await realpath(cwd);
  const canonicalRoots: string[] = [];
  for (const root of workspaceRoots) {
    try {
      canonicalRoots.push(await realpath(root));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const containingRoots = canonicalRoots
    .filter((root) => isWithin(canonicalCwd, root))
    .sort((left, right) => left.length - right.length);
  if (containingRoots.length === 0) return undefined;

  const marker = await nearestGitMarker(canonicalCwd, containingRoots[0]);
  if (!marker) {
    const exactWorkspaceRoot = containingRoots.find(
      (root) => root === canonicalCwd,
    );
    return options.includeAbsentWorkspaceMarker && exactWorkspaceRoot
      ? resolveWorkspaceGitProtection(exactWorkspaceRoot)
      : undefined;
  }
  const workspaceRoot = containingRoots.find(
    (root) => marker === path.join(root, ".git"),
  );
  if (!workspaceRoot) return undefined;
  const protection = await resolveWorkspaceGitProtection(workspaceRoot);
  return protection.markerExists || options.includeAbsentWorkspaceMarker
    ? protection
    : undefined;
}
