import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as path from "path";

import { canonicalizePath, isPathWithinRoot } from "../util/paths.js";

import type { ReviewScope } from "../core/capabilities/background.js";
import { execFile } from "child_process";
import { isUtf8 } from "buffer";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
const MAX_REVIEW_SNAPSHOT_BYTES = 1_000_000;

export interface CaptureReviewScopeOptions {
  workspaceRoots?: readonly string[];
}

interface ResolvedReviewPath {
  absolutePath: string;
  relativePath: string;
  root: string;
}

function normalizePaths(
  cwd: string,
  paths: string[] | undefined,
  options: CaptureReviewScopeOptions,
): ResolvedReviewPath[] {
  const comparisonKey = (value: string): string =>
    process.platform === "win32" ? value.toLowerCase() : value;
  const isWithinRoot = (filePath: string, root: string): boolean =>
    isPathWithinRoot(comparisonKey(filePath), comparisonKey(root));
  const seenRoots = new Set<string>();
  const roots = (
    options.workspaceRoots?.length ? options.workspaceRoots : [cwd]
  )
    .map((root) => ({
      rawRoot: path.resolve(root),
      canonicalRoot: canonicalizePath(root),
    }))
    .filter(({ canonicalRoot }) => {
      const key = comparisonKey(canonicalRoot);
      if (seenRoots.has(key)) return false;
      seenRoots.add(key);
      return true;
    })
    .sort((left, right) => right.rawRoot.length - left.rawRoot.length);
  return (paths ?? []).map((input) => {
    const trimmed = input.trim();
    if (!trimmed) throw new Error("Review scope paths cannot be empty.");
    const rawAbsolutePath = path.resolve(
      path.isAbsolute(trimmed) ? trimmed : path.resolve(cwd, trimmed),
    );
    const canonicalPath = canonicalizePath(rawAbsolutePath);
    const canonicalOwner = roots.find(({ canonicalRoot }) =>
      isWithinRoot(canonicalPath, canonicalRoot),
    );
    const lexicalOwner = canonicalOwner
      ? undefined
      : roots.find(({ rawRoot }) => isWithinRoot(rawAbsolutePath, rawRoot));
    const root = canonicalOwner ?? lexicalOwner;
    if (!root) {
      const allowedRoots = roots.map(({ canonicalRoot }) => canonicalRoot);
      const acceptedExample = path.join(
        allowedRoots[0] ?? cwd,
        "path",
        "to",
        "file.ts",
      );
      throw new Error(
        `Review scope path is outside the open workspace roots: ${input}. Allowed roots: ${allowedRoots.join(", ") || cwd}. Accepted example: ${acceptedExample}`,
      );
    }
    const absolutePath = canonicalOwner
      ? canonicalPath
      : path.resolve(
          root.canonicalRoot,
          path.relative(root.rawRoot, rawAbsolutePath),
        );
    return {
      absolutePath,
      root: root.canonicalRoot,
      relativePath:
        path
          .relative(root.canonicalRoot, absolutePath)
          .replaceAll(path.sep, "/") || ".",
    };
  });
}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      env: { ...process.env, GIT_LITERAL_PATHSPECS: "1" },
      maxBuffer: MAX_REVIEW_SNAPSHOT_BYTES * 2,
    });
    return stdout;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Unable to capture review scope with Git: ${detail}. If this workspace is not a Git repository, use reviewScope kind "files" with explicit paths.`,
    );
  }
}

function fenced(content: string, language: string): string {
  const longestRun = Math.max(
    0,
    ...Array.from(content.matchAll(/`+/g), (match) => match[0].length),
  );
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}${language}\n${content.trimEnd()}\n${fence}`;
}

async function captureFiles(paths: ResolvedReviewPath[]): Promise<string> {
  const sections: string[] = [];
  const spansMultipleRoots = new Set(paths.map((entry) => entry.root)).size > 1;
  for (const { absolutePath, relativePath } of paths) {
    const displayPath = spansMultipleRoots ? absolutePath : relativePath;
    let stat;
    try {
      stat = await fs.lstat(absolutePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        sections.push(`File ${JSON.stringify(displayPath)} is missing.`);
        continue;
      }
      throw error;
    }

    if (stat.isSymbolicLink()) {
      const target = await fs.readlink(absolutePath);
      sections.push(
        `File ${JSON.stringify(displayPath)} is a symbolic link to ${JSON.stringify(target)}.`,
      );
      continue;
    }
    if (!stat.isFile()) {
      throw new Error(`Review scope path is not a file: ${displayPath}`);
    }
    if (stat.size > MAX_REVIEW_SNAPSHOT_BYTES) {
      throw new Error(
        `Review scope file ${displayPath} is ${stat.size} bytes, above the ${MAX_REVIEW_SNAPSHOT_BYTES}-byte limit.`,
      );
    }

    const content = await fs.readFile(absolutePath);
    if (content.includes(0) || !isUtf8(content)) {
      sections.push(
        `Binary file ${JSON.stringify(displayPath)} (${content.byteLength} bytes, sha256:${crypto.createHash("sha256").update(content).digest("hex")}).`,
      );
      continue;
    }
    sections.push(
      `File: ${displayPath}\n${fenced(content.toString("utf8"), "text")}`,
    );
  }
  return sections.join("\n\n");
}

function assertSnapshotSize(snapshot: string): void {
  const bytes = Buffer.byteLength(snapshot);
  if (bytes > MAX_REVIEW_SNAPSHOT_BYTES) {
    throw new Error(
      `Captured review scope is ${bytes} bytes, above the ${MAX_REVIEW_SNAPSHOT_BYTES}-byte limit. Provide a narrower review scope, for example with reviewScope.paths.`,
    );
  }
}

function wrapSnapshot(kind: ReviewScope["kind"], body: string): string {
  const content = body.trim();
  const snapshot = [
    "## Runtime-captured review scope",
    "",
    `Kind: ${kind}`,
    "This immutable scope was captured when the background agent was spawned. Review it as supplied; do not rediscover the change set from the live workspace.",
    "",
    content || "The requested review scope was empty when captured.",
  ].join("\n");
  assertSnapshotSize(snapshot);
  return snapshot;
}

/** Resolve a structured review target into an immutable prompt snapshot. */
export async function captureReviewScope(
  cwd: string,
  scope: ReviewScope,
  options: CaptureReviewScopeOptions = {},
): Promise<string> {
  if (scope.kind === "diff") {
    const label = scope.label?.trim() || "Provided diff";
    return wrapSnapshot(
      scope.kind,
      `${label}:\n${fenced(scope.content, "diff")}`,
    );
  }

  const paths = normalizePaths(cwd, scope.paths, options);

  if (scope.kind === "files") {
    if (paths.length === 0) {
      throw new Error("reviewScope.files requires at least one path.");
    }
    return wrapSnapshot(scope.kind, await captureFiles(paths));
  }

  const pathRoots = [...new Set(paths.map((entry) => entry.root))];
  if (pathRoots.length > 1) {
    throw new Error(
      `Git review scopes cannot span multiple workspace roots: ${pathRoots.join(", ")}. Use reviewScope kind "files" for an exact cross-root snapshot.`,
    );
  }
  const gitRoot = pathRoots[0] ?? canonicalizePath(cwd);
  const gitPaths = paths.map((entry) => entry.relativePath);
  const pathArgs = gitPaths.length > 0 ? ["--", ...gitPaths] : [];

  if (scope.kind === "commit_range") {
    const range = scope.range.trim();
    if (!range || range.startsWith("-")) {
      throw new Error("reviewScope.commit_range requires a valid Git range.");
    }
    const diff = await git(gitRoot, [
      "diff",
      "--no-ext-diff",
      "--no-color",
      "--binary",
      range,
      ...pathArgs,
    ]);
    return wrapSnapshot(
      scope.kind,
      `Git range: ${range}${gitPaths.length ? `\nPaths: ${gitPaths.join(", ")}` : ""}\n\n${fenced(diff, "diff")}`,
    );
  }

  const include = new Set(
    scope.include?.length ? scope.include : ["unstaged", "untracked"],
  );
  const sections: string[] = [];

  if (include.has("staged")) {
    const diff = await git(gitRoot, [
      "diff",
      "--cached",
      "--no-ext-diff",
      "--no-color",
      "--binary",
      ...pathArgs,
    ]);
    if (diff) sections.push(`Staged changes:\n${fenced(diff, "diff")}`);
  }
  if (include.has("unstaged")) {
    const diff = await git(gitRoot, [
      "diff",
      "--no-ext-diff",
      "--no-color",
      "--binary",
      ...pathArgs,
    ]);
    if (diff)
      sections.push(`Unstaged tracked changes:\n${fenced(diff, "diff")}`);
  }
  if (include.has("untracked")) {
    const output = await git(gitRoot, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
      ...pathArgs,
    ]);
    const untracked = output.split("\0").filter(Boolean);
    if (untracked.length > 0) {
      const untrackedPaths = normalizePaths(gitRoot, untracked, {
        workspaceRoots: [gitRoot],
      });
      sections.push(`Untracked files:\n${await captureFiles(untrackedPaths)}`);
    }
  }

  const manifest = [
    `Included states: ${[...include].join(", ")}`,
    gitPaths.length ? `Paths: ${gitPaths.join(", ")}` : "Paths: all",
    "",
    ...sections,
  ].join("\n");
  return wrapSnapshot(scope.kind, manifest);
}
