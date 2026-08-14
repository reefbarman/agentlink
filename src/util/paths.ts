import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

import { AsyncLocalStorage } from "async_hooks";
import { canonicalizePath } from "./canonicalPath.js";

export { canonicalizePath } from "./canonicalPath.js";

const workspaceRootScope = new AsyncLocalStorage<readonly string[]>();

/**
 * Run an operation with a request-bound workspace root set.
 *
 * Tool runtimes use this to keep legacy path helpers pinned to the executing
 * session's immutable project without mutating window-global VS Code state.
 */
export function withWorkspaceRoots<T>(
  roots: readonly string[],
  operation: () => T,
): T {
  return workspaceRootScope.run([...roots], operation);
}

export function getWorkspaceRoots(): string[] {
  const scopedRoots = workspaceRootScope.getStore();
  if (scopedRoots) return [...scopedRoots];

  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return [];
  }
  return folders.map((f) => f.uri.fsPath);
}

/** Case-insensitive path equality on Windows, case-sensitive elsewhere. */
function pathsEqual(a: string, b: string): boolean {
  if (process.platform === "win32") {
    return a.toLowerCase() === b.toLowerCase();
  }
  return a === b;
}

/** Check if `child` is inside `parent` directory (case-insensitive on Windows). */
function pathStartsWith(child: string, parent: string): boolean {
  if (process.platform === "win32") {
    return child.toLowerCase().startsWith((parent + path.sep).toLowerCase());
  }
  return child.startsWith(parent + path.sep);
}

export function getFirstWorkspaceRoot(): string {
  const roots = getWorkspaceRoots();
  if (roots.length === 0) {
    throw new Error("No workspace folder open");
  }
  return roots[0];
}

/** Returns the first workspace root, or `undefined` if no workspace is open. */
export function tryGetFirstWorkspaceRoot(): string | undefined {
  const roots = getWorkspaceRoots();
  return roots.length > 0 ? roots[0] : undefined;
}

/**
 * Return the workspace root that owns an absolute path.
 *
 * In multi-root workspaces, choose the longest matching root so nested
 * workspace folders are routed to their most specific index/cache.
 */
export function getWorkspaceRootForPath(
  absolutePath: string,
): string | undefined {
  const roots = getWorkspaceRoots();
  const resolvedPath = path.resolve(absolutePath);
  let bestRoot: string | undefined;

  for (const root of roots) {
    if (pathsEqual(resolvedPath, root) || pathStartsWith(resolvedPath, root)) {
      if (!bestRoot || root.length > bestRoot.length) {
        bestRoot = root;
      }
    }
  }

  return bestRoot;
}

export interface ResolvedPath {
  absolutePath: string;
  inWorkspace: boolean;
}

export function isPathWithinRoot(filePath: string, rootPath: string): boolean {
  const relative = path.relative(rootPath, filePath);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

/**
 * Resolve a path and check whether it falls within workspace boundaries.
 * For existing files, resolves symlinks via realpath.
 * For new files, validates the parent directory.
 *
 * Returns `{ absolutePath, inWorkspace }` — never throws for outside-workspace paths.
 * Relative paths are resolved against the best-matching workspace root.
 * Throws only if no workspace folder is open and the path is relative.
 */
export function resolveAndValidatePath(inputPath: string): ResolvedPath {
  const roots = getWorkspaceRoots();

  // Resolve relative to workspace root (or treat as absolute)
  let resolved: string;
  if (path.isAbsolute(inputPath)) {
    resolved = path.resolve(inputPath);
  } else if (roots.length > 0) {
    resolved = resolveRelativeToWorkspace(inputPath, roots);
  } else {
    throw new Error("No workspace folder open and path is relative");
  }

  // Resolve symlinks for existing files and canonicalize the parent for new files.
  const real = canonicalizePath(resolved);

  // Check workspace boundary
  const inWorkspace = roots.some((root) => {
    const canonicalRoot = canonicalizePath(root);
    return (
      pathsEqual(real, canonicalRoot) || pathStartsWith(real, canonicalRoot)
    );
  });

  return { absolutePath: real, inWorkspace };
}

/**
 * Get relative path from workspace root.
 */
export function getRelativePath(absolutePath: string): string {
  const root = getWorkspaceRootForPath(absolutePath);
  return root
    ? path.relative(root, absolutePath).replace(/\\/g, "/")
    : absolutePath;
}

/**
 * Resolve a relative path against the correct workspace root in multi-root workspaces.
 *
 * Strategy:
 * 1. If the path starts with a workspace folder name, resolve against that folder
 * 2. If the file already exists under a specific root, use that root
 * 3. If the parent directory exists under a specific root (new file), use that root
 * 4. Fall back to the first root
 */
function resolveRelativeToWorkspace(
  inputPath: string,
  roots: string[],
): string {
  if (roots.length > 1) {
    const folders = (vscode.workspace.workspaceFolders ?? []).filter((folder) =>
      roots.some((root) => pathsEqual(root, folder.uri.fsPath)),
    );

    // Check if path starts with a workspace folder name
    for (const folder of folders) {
      const normalizedInput = inputPath.replace(/\\/g, "/");
      const prefix = folder.name + "/";
      if (normalizedInput.startsWith(prefix)) {
        const subPath = normalizedInput.slice(prefix.length);
        return path.resolve(folder.uri.fsPath, subPath);
      }
      if (inputPath === folder.name) {
        return folder.uri.fsPath;
      }
    }

    // Check if file exists under any root
    for (const root of roots) {
      const candidate = path.resolve(root, inputPath);
      try {
        fs.accessSync(candidate);
        return candidate;
      } catch {
        // doesn't exist here, try next
      }
    }

    // Check if parent directory exists under any root (for new files)
    const parentDir = path.dirname(inputPath);
    if (parentDir !== ".") {
      for (const root of roots) {
        const candidateParent = path.resolve(root, parentDir);
        try {
          fs.accessSync(candidateParent);
          return path.resolve(root, inputPath);
        } catch {
          // doesn't exist here, try next
        }
      }
    }
  }

  // Single root or no match — use first root
  return path.resolve(roots[0], inputPath);
}

/**
 * Check if a file is likely binary by looking for null bytes in the first 8KB.
 */
export function isBinaryFile(filePath: string): boolean {
  try {
    const fd = fs.openSync(filePath, "r");
    const buffer = Buffer.alloc(8192);
    const bytesRead = fs.readSync(fd, buffer, 0, 8192, 0);
    fs.closeSync(fd);

    for (let i = 0; i < bytesRead; i++) {
      if (buffer[i] === 0) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}
