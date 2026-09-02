import * as fs from "node:fs";
import * as path from "path";

import { canonicalizePath, isPathWithinRoot } from "../util/paths.js";

import type { ReviewScope } from "../core/capabilities/background.js";

const MAX_INLINE_REVIEW_DIFF_BYTES = 1_000_000;

export interface CaptureReviewScopeOptions {
  workspaceRoots?: readonly string[];
}

export interface ReviewScopeHandoff {
  /** Compact target instructions appended to the delegated review message. */
  content: string;
  /** Stable scope description used when the reviewer omits reviewedScope. */
  summary: string;
  kind: ReviewScope["kind"];
  /** Bytes of caller-supplied code embedded in the handoff. Live targets are zero. */
  inlineBytes: number;
  /** Internal absolute file targets revalidated when queued work starts. */
  liveFilePaths?: string[];
}

interface ResolvedReviewPath {
  absolutePath: string;
  relativePath: string;
  root: string;
}

function comparisonKey(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function normalizeRoots(
  cwd: string,
  options: CaptureReviewScopeOptions,
): Array<{ rawRoot: string; canonicalRoot: string }> {
  const seen = new Set<string>();
  return (options.workspaceRoots?.length ? options.workspaceRoots : [cwd])
    .map((root) => ({
      rawRoot: path.resolve(root),
      canonicalRoot: canonicalizePath(root),
    }))
    .filter(({ canonicalRoot }) => {
      const key = comparisonKey(canonicalRoot);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((left, right) => right.rawRoot.length - left.rawRoot.length);
}

function normalizePaths(
  cwd: string,
  paths: string[] | undefined,
  options: CaptureReviewScopeOptions,
): ResolvedReviewPath[] {
  const roots = normalizeRoots(cwd, options);
  const within = (filePath: string, root: string): boolean =>
    isPathWithinRoot(comparisonKey(filePath), comparisonKey(root));
  return (paths ?? []).map((input) => {
    const trimmed = input.trim();
    if (!trimmed) throw new Error("Review scope paths cannot be empty.");
    const rawAbsolutePath = path.resolve(
      path.isAbsolute(trimmed) ? trimmed : path.resolve(cwd, trimmed),
    );
    const canonicalPath = canonicalizePath(rawAbsolutePath);
    const canonicalOwner = roots.find(({ canonicalRoot }) =>
      within(canonicalPath, canonicalRoot),
    );
    const lexicalOwner = canonicalOwner
      ? undefined
      : roots.find(({ rawRoot }) => within(rawAbsolutePath, rawRoot));
    const root = canonicalOwner ?? lexicalOwner;
    if (!root) {
      const allowedRoots = roots.map(({ canonicalRoot }) => canonicalRoot);
      throw new Error(
        `Review scope path is outside the open workspace roots: ${input}. Allowed roots: ${allowedRoots.join(", ") || cwd}. Accepted example: ${path.join(allowedRoots[0] ?? cwd, "path", "to", "file.ts")}`,
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

function normalizeExcludePrefix(value: string): string {
  return value
    .trim()
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "");
}

function pathMatchesExclude(
  relativePath: string,
  excludePrefixes: readonly string[],
): boolean {
  const normalized = normalizeExcludePrefix(relativePath);
  return excludePrefixes.some(
    (prefix) =>
      prefix.length > 0 &&
      (normalized === prefix || normalized.startsWith(`${prefix}/`)),
  );
}

function resolveScopeRoot(
  cwd: string,
  requestedRoot: string | undefined,
  options: CaptureReviewScopeOptions,
): string | undefined {
  const requested = requestedRoot?.trim();
  if (!requested) return undefined;
  const roots = normalizeRoots(cwd, options).map(
    ({ canonicalRoot }) => canonicalRoot,
  );
  const canonicalRequested = path.isAbsolute(requested)
    ? canonicalizePath(requested)
    : undefined;
  const byPath = canonicalRequested
    ? roots.find(
        (root) => comparisonKey(root) === comparisonKey(canonicalRequested),
      )
    : undefined;
  if (byPath) return byPath;
  const byName = roots.filter(
    (root) => comparisonKey(path.basename(root)) === comparisonKey(requested),
  );
  if (byName.length === 1) return byName[0];
  throw new Error(
    byName.length > 1
      ? `reviewScope.root "${requested}" matches multiple workspace roots: ${byName.join(", ")}. Use the absolute root path.`
      : `reviewScope.root "${requested}" does not match an open workspace root. Open roots: ${roots.join(", ")}.`,
  );
}

function fenced(content: string, language: string): string {
  const longestRun = Math.max(
    0,
    ...Array.from(content.matchAll(/`+/g), (match) => match[0].length),
  );
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}${language}\n${content.trimEnd()}\n${fence}`;
}

function wrapLiveTarget(body: string): string {
  return [
    "## Live review target",
    "",
    "Inspect this target from the current workspace state when the review begins. Concurrent or unrelated work may be present; prioritize the stated change intent and paths. Do not spend work proving snapshot consistency. Report a material out-of-scope issue as such instead of broadening the review.",
    "",
    body,
  ].join("\n");
}

function renderList(
  label: string,
  values: readonly string[],
): string | undefined {
  return values.length > 0 ? `${label}: ${values.join(", ")}` : undefined;
}

/**
 * Validate a structured review target and render a compact live handoff.
 * Workspace-backed scopes intentionally contain selectors only; `diff` is the
 * explicit immutable escape hatch and is the only kind that embeds code.
 */
export function captureReviewScope(
  cwd: string,
  scope: ReviewScope,
  options: CaptureReviewScopeOptions = {},
): ReviewScopeHandoff {
  if (scope.kind === "diff") {
    const bytes = Buffer.byteLength(scope.content);
    if (bytes > MAX_INLINE_REVIEW_DIFF_BYTES) {
      throw new Error(
        `Inline review diff is ${bytes} bytes, above the ${MAX_INLINE_REVIEW_DIFF_BYTES}-byte limit. Provide only the relevant hunks or use a live working_tree, files, or commit_range scope.`,
      );
    }
    const label = scope.label?.trim() || "Provided diff";
    return {
      kind: scope.kind,
      inlineBytes: bytes,
      summary: label,
      content: [
        "## Explicit review diff",
        "",
        "This caller-supplied diff is the exact review target. Read current workspace files only when needed to validate a concrete risk.",
        "",
        `${label}:`,
        fenced(scope.content, "diff"),
      ].join("\n"),
    };
  }

  const excludePrefixes = (scope.excludePaths ?? [])
    .map(normalizeExcludePrefix)
    .filter(Boolean);

  if (scope.kind === "files") {
    const resolved = normalizePaths(cwd, scope.paths, options).filter(
      (entry) => !pathMatchesExclude(entry.relativePath, excludePrefixes),
    );
    if (resolved.length === 0) {
      throw new Error(
        "reviewScope.files requires at least one non-excluded path.",
      );
    }
    for (const entry of resolved) {
      let stat: fs.Stats;
      try {
        stat = fs.statSync(entry.absolutePath);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          throw new Error(
            `Live review file target is unavailable: ${entry.relativePath}. Refresh the scope or use kind "diff" with explicit hunks.`,
          );
        }
        throw error;
      }
      if (!stat.isFile()) {
        throw new Error(
          `Live review file target is not a file: ${entry.relativePath}.`,
        );
      }
    }
    const spansRoots = new Set(resolved.map((entry) => entry.root)).size > 1;
    const displayPaths = resolved.map((entry) =>
      spansRoots ? entry.absolutePath : entry.relativePath,
    );
    const summary = `current files: ${displayPaths.join(", ")}`;
    return {
      kind: scope.kind,
      inlineBytes: 0,
      liveFilePaths: resolved.map((entry) => entry.absolutePath),
      summary,
      content: wrapLiveTarget(
        [
          "Kind: files",
          renderList("Paths", displayPaths),
          renderList("Excluded paths", excludePrefixes),
          "Read the current contents of these files. Read directly affected callers or tests only when a concrete review hypothesis requires it.",
        ]
          .filter((line): line is string => Boolean(line))
          .join("\n"),
      ),
    };
  }

  const selectedRoot = resolveScopeRoot(cwd, scope.root, options);
  const pathBase = selectedRoot ?? cwd;
  const pathOptions = selectedRoot
    ? { workspaceRoots: [selectedRoot] }
    : options;
  const resolvedPaths = normalizePaths(pathBase, scope.paths, pathOptions);
  const pathRoots = [...new Set(resolvedPaths.map((entry) => entry.root))];
  if (pathRoots.length > 1) {
    throw new Error(
      `Git review scopes cannot span multiple workspace roots: ${pathRoots.join(", ")}. Use reviewScope kind "files" for a cross-root live target, or reviewScope.root to pick one root.`,
    );
  }
  const gitRoot = selectedRoot ?? pathRoots[0] ?? canonicalizePath(cwd);
  const gitPaths = resolvedPaths
    .filter((entry) => !pathMatchesExclude(entry.relativePath, excludePrefixes))
    .map((entry) => entry.relativePath);
  if (resolvedPaths.length > 0 && gitPaths.length === 0) {
    throw new Error(
      `reviewScope.${scope.kind} requires at least one non-excluded path.`,
    );
  }

  if (scope.kind === "commit_range") {
    const range = scope.range.trim();
    if (!range || range.startsWith("-")) {
      throw new Error("reviewScope.commit_range requires a valid Git range.");
    }
    const summary = `current Git range ${range}${gitPaths.length ? ` for ${gitPaths.join(", ")}` : ""}`;
    return {
      kind: scope.kind,
      inlineBytes: 0,
      summary,
      content: wrapLiveTarget(
        [
          "Kind: commit_range",
          `Git root: ${gitRoot}`,
          `Git range: ${range}`,
          renderList("Paths", gitPaths),
          renderList("Excluded paths", excludePrefixes),
          "Inspect this range with a scoped read-only Git diff. Use current files only for surrounding context needed to validate a concrete finding.",
        ]
          .filter((line): line is string => Boolean(line))
          .join("\n"),
      ),
    };
  }

  const include = scope.include?.length
    ? [...new Set(scope.include)]
    : ["unstaged", "untracked"];
  const pathDescription = gitPaths.length ? gitPaths.join(", ") : "all paths";
  const summary = `current working tree (${include.join(", ")}) for ${pathDescription}`;
  return {
    kind: scope.kind,
    inlineBytes: 0,
    summary,
    content: wrapLiveTarget(
      [
        "Kind: working_tree",
        `Git root: ${gitRoot}`,
        `Included states: ${include.join(", ")}`,
        `Paths: ${pathDescription}`,
        renderList("Excluded paths", excludePrefixes),
        "Inspect the scoped current status/diff once, including current untracked file contents when requested. Then follow only directly affected callers or tests needed to validate concrete risks.",
      ]
        .filter((line): line is string => Boolean(line))
        .join("\n"),
    ),
  };
}

/** Fail queued live-file reviews before provider work if their target disappeared. */
export function assertReviewScopeAvailable(handoff: ReviewScopeHandoff): void {
  for (const filePath of handoff.liveFilePaths ?? []) {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        throw new Error(
          `Live review file target became unavailable before the review started: ${filePath}. Refresh the scope and retry.`,
        );
      }
      throw error;
    }
    if (!stat.isFile()) {
      throw new Error(
        `Live review file target is no longer a file: ${filePath}. Refresh the scope and retry.`,
      );
    }
  }
}
