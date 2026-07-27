import * as path from "path";

import { canonicalizePath } from "../util/canonicalPath.js";

export const CODE_INDEX_PATH_IDENTITY_VERSION = 1;

export interface ContainedCodeIndexPath {
  absolutePath: string;
  relativePath: string;
  portableRelativePath: string;
}

type PathFlavor = Pick<typeof path, "relative" | "isAbsolute" | "sep">;

/** Return the longest raw workspace root that owns the canonical candidate. */
export function getCodeIndexWorkspaceRootForPath(
  workspaceRoots: readonly string[],
  candidatePath: string,
): string | undefined {
  const canonicalCandidate = canonicalizePath(candidatePath);
  let best: { root: string; canonicalLength: number } | undefined;

  for (const root of workspaceRoots) {
    const canonicalRoot = canonicalizePath(root);
    const relativePath = path.relative(canonicalRoot, canonicalCandidate);
    const contained =
      relativePath === "" ||
      (relativePath !== ".." &&
        !relativePath.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relativePath));
    if (contained && canonicalRoot.length > (best?.canonicalLength ?? -1)) {
      best = { root, canonicalLength: canonicalRoot.length };
    }
  }

  return best?.root;
}

/**
 * Resolve one physical code-index identity within a workspace. The workspace
 * root itself is not a file identity, and symlink targets outside it are rejected.
 */
export function resolveContainedCodeIndexPath(
  workspaceRoot: string,
  candidatePath: string,
): ContainedCodeIndexPath | undefined {
  const canonicalRoot = canonicalizePath(workspaceRoot);
  const absolutePath = canonicalizePath(candidatePath);
  const relativePath = getContainedCodeIndexRelativePath(
    canonicalRoot,
    absolutePath,
  );
  if (!relativePath) return undefined;

  return {
    absolutePath,
    relativePath,
    portableRelativePath: toPortableCodeIndexPath(relativePath),
  };
}

export function requireCanonicalPortableCodeIndexPath(
  inputPath: string,
): string {
  if (
    inputPath.length === 0 ||
    inputPath.includes("\\") ||
    path.posix.isAbsolute(inputPath) ||
    path.win32.isAbsolute(inputPath) ||
    /^[A-Za-z]:/.test(inputPath)
  ) {
    throw new Error(
      `Invalid code-index relative path: ${inputPath || "<empty>"}`,
    );
  }

  const segments = inputPath.split("/");
  if (
    segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    )
  ) {
    throw new Error(`Invalid code-index relative path: ${inputPath}`);
  }
  return inputPath;
}

export function getContainedCodeIndexRelativePath(
  canonicalRoot: string,
  canonicalCandidate: string,
  pathFlavor: PathFlavor = path,
): string | undefined {
  const relativePath = pathFlavor.relative(canonicalRoot, canonicalCandidate);
  return relativePath !== "" &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${pathFlavor.sep}`) &&
    !pathFlavor.isAbsolute(relativePath)
    ? relativePath
    : undefined;
}

function toPortableCodeIndexPath(relativePath: string): string {
  return requireCanonicalPortableCodeIndexPath(
    relativePath.split(path.sep).join("/"),
  );
}
