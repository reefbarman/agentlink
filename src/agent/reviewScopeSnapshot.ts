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
      env: { ...process.env },
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

/** Per-item byte sizes collected so cap-overflow errors can name offenders. */
type SizeHints = Array<{ path: string; bytes: number }>;

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

/**
 * Build explicit long-form pathspecs so user paths remain literal while excludes
 * are applied by Git before stdout is buffered. A directory literal pathspec also
 * matches descendants, matching reviewScope.excludePaths prefix semantics.
 */
function gitPathArgs(
  includePaths: readonly string[],
  excludePrefixes: readonly string[],
): string[] {
  const pathspecs = [
    ...includePaths.map((entry) => `:(top,literal)${entry}`),
    ...excludePrefixes.map((entry) => `:(top,exclude,literal)${entry}`),
  ];
  return pathspecs.length > 0 ? ["--", ...pathspecs] : [];
}

/**
 * Split a unified git diff into per-file sections so excludes and size
 * attribution can operate on file granularity.
 */
function splitDiffSections(
  diff: string,
): Array<{ paths: string[]; text: string }> {
  const lines = diff.split("\n");
  const sections: Array<{ paths: string[]; text: string }> = [];
  let current: { paths: string[]; buffer: string[] } | undefined;
  const flush = () => {
    if (current) {
      sections.push({ paths: current.paths, text: current.buffer.join("\n") });
      current = undefined;
    }
  };
  for (const line of lines) {
    const header = line.match(/^diff --git (?:"?a\/(.+?)"?) (?:"?b\/(.+?)"?)$/);
    if (header) {
      flush();
      current = {
        paths: [...new Set([header[1], header[2]])],
        buffer: [line],
      };
      continue;
    }
    if (current) current.buffer.push(line);
  }
  flush();
  return sections;
}

function filterDiffByExcludes(
  diff: string,
  excludePrefixes: readonly string[],
  sizeHints?: SizeHints,
): { diff: string; excluded: string[] } {
  const sections = splitDiffSections(diff);
  if (sections.length === 0) {
    if (diff.trim() && sizeHints) {
      sizeHints.push({ path: "(diff)", bytes: Buffer.byteLength(diff) });
    }
    return { diff, excluded: [] };
  }
  const kept: string[] = [];
  const excluded: string[] = [];
  for (const section of sections) {
    if (
      excludePrefixes.length > 0 &&
      section.paths.some((sectionPath) =>
        pathMatchesExclude(sectionPath, excludePrefixes),
      )
    ) {
      excluded.push(...section.paths);
      continue;
    }
    sizeHints?.push({
      path: section.paths[0] ?? "(diff)",
      bytes: Buffer.byteLength(section.text),
    });
    kept.push(section.text);
  }
  return { diff: kept.join("\n"), excluded: [...new Set(excluded)] };
}

async function captureFiles(
  paths: ResolvedReviewPath[],
  sizeHints?: SizeHints,
): Promise<string> {
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
      // Keep the rest of the capture usable: record the oversized file's
      // metadata with an explicit warning instead of rejecting the spawn.
      sections.push(
        `Oversized file ${JSON.stringify(displayPath)} (${stat.size} bytes, modified ${stat.mtime.toISOString()}) exceeds the ${MAX_REVIEW_SNAPSHOT_BYTES}-byte per-file capture limit; content omitted. Use excludePaths to silence this entry.`,
      );
      continue;
    }

    const content = await fs.readFile(absolutePath);
    if (content.includes(0) || !isUtf8(content)) {
      sections.push(
        `Binary file ${JSON.stringify(displayPath)} (${content.byteLength} bytes, sha256:${crypto.createHash("sha256").update(content).digest("hex")}).`,
      );
      continue;
    }
    sizeHints?.push({ path: displayPath, bytes: content.byteLength });
    sections.push(
      `File: ${displayPath}\n${fenced(content.toString("utf8"), "text")}`,
    );
  }
  return sections.join("\n\n");
}

function assertSnapshotSize(snapshot: string, sizeHints?: SizeHints): void {
  const bytes = Buffer.byteLength(snapshot);
  if (bytes > MAX_REVIEW_SNAPSHOT_BYTES) {
    const largest = (sizeHints ?? [])
      .slice()
      .sort((left, right) => right.bytes - left.bytes)
      .slice(0, 5)
      .map((hint) => `${hint.path} (${hint.bytes} bytes)`);
    throw new Error(
      `Captured review scope is ${bytes} bytes, above the ${MAX_REVIEW_SNAPSHOT_BYTES}-byte limit. Provide a narrower review scope, for example with reviewScope.paths or excludePaths.${
        largest.length > 0
          ? ` Largest captured items: ${largest.join(", ")}.`
          : ""
      }`,
    );
  }
}

function wrapSnapshot(
  kind: ReviewScope["kind"],
  body: string,
  sizeHints?: SizeHints,
): string {
  const content = body.trim();
  const snapshot = [
    "## Runtime-captured review scope",
    "",
    `Kind: ${kind}`,
    "This immutable scope was captured when the background agent was spawned. Review it as supplied; do not rediscover the change set from the live workspace.",
    "",
    content || "The requested review scope was empty when captured.",
  ].join("\n");
  assertSnapshotSize(snapshot, sizeHints);
  return snapshot;
}

/** Resolve a `root` selector (absolute path or folder basename) to one open workspace root. */
function resolveScopeRoot(
  cwd: string,
  requestedRoot: string | undefined,
  options: CaptureReviewScopeOptions,
): string | undefined {
  const requested = requestedRoot?.trim();
  if (!requested) return undefined;
  const comparisonKey = (value: string): string =>
    process.platform === "win32" ? value.toLowerCase() : value;
  const roots = [
    ...new Set(
      (options.workspaceRoots?.length ? options.workspaceRoots : [cwd]).map(
        (root) => canonicalizePath(root),
      ),
    ),
  ];
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

  const excludePrefixes = (scope.excludePaths ?? [])
    .map(normalizeExcludePrefix)
    .filter(Boolean);
  const sizeHints: SizeHints = [];
  const allExcluded: string[] = [...excludePrefixes];

  if (scope.kind === "files") {
    const paths = normalizePaths(cwd, scope.paths, options).filter((entry) => {
      const excluded = pathMatchesExclude(entry.relativePath, excludePrefixes);
      if (excluded) allExcluded.push(entry.relativePath);
      return !excluded;
    });
    if (paths.length === 0 && allExcluded.length === 0) {
      throw new Error("reviewScope.files requires at least one path.");
    }
    const body = await captureFiles(paths, sizeHints);
    return wrapSnapshot(
      scope.kind,
      allExcluded.length > 0
        ? `Excluded paths: ${allExcluded.join(", ")}\n\n${body}`
        : body,
      sizeHints,
    );
  }

  const selectedRoot = resolveScopeRoot(cwd, scope.root, options);
  const pathBase = selectedRoot ?? cwd;
  const pathOptions = selectedRoot
    ? { workspaceRoots: [selectedRoot] }
    : options;
  const paths = normalizePaths(pathBase, scope.paths, pathOptions);

  const pathRoots = [...new Set(paths.map((entry) => entry.root))];
  if (pathRoots.length > 1) {
    throw new Error(
      `Git review scopes cannot span multiple workspace roots: ${pathRoots.join(", ")}. Use reviewScope kind "files" for an exact cross-root snapshot, or reviewScope.root to pick one root.`,
    );
  }
  const gitRoot = selectedRoot ?? pathRoots[0] ?? canonicalizePath(cwd);
  const gitPaths = paths.map((entry) => entry.relativePath);
  const pathArgs = gitPathArgs(gitPaths, excludePrefixes);
  const applyExcludes = (diff: string): string => {
    const filtered = filterDiffByExcludes(diff, excludePrefixes, sizeHints);
    allExcluded.push(...filtered.excluded);
    return filtered.diff.trim() ? filtered.diff : "";
  };

  if (scope.kind === "commit_range") {
    const range = scope.range.trim();
    if (!range || range.startsWith("-")) {
      throw new Error("reviewScope.commit_range requires a valid Git range.");
    }
    const diff = applyExcludes(
      await git(gitRoot, [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        range,
        ...pathArgs,
      ]),
    );
    return wrapSnapshot(
      scope.kind,
      [
        `Git root: ${gitRoot}`,
        `Git range: ${range}`,
        gitPaths.length ? `Paths: ${gitPaths.join(", ")}` : undefined,
        allExcluded.length
          ? `Excluded paths: ${[...new Set(allExcluded)].join(", ")}`
          : undefined,
        "",
        fenced(diff, "diff"),
      ]
        .filter((line): line is string => line !== undefined)
        .join("\n"),
      sizeHints,
    );
  }

  const include = new Set(
    scope.include?.length ? scope.include : ["unstaged", "untracked"],
  );
  const sections: string[] = [];

  if (include.has("staged")) {
    const diff = applyExcludes(
      await git(gitRoot, [
        "diff",
        "--cached",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        ...pathArgs,
      ]),
    );
    if (diff) sections.push(`Staged changes:\n${fenced(diff, "diff")}`);
  }
  if (include.has("unstaged")) {
    const diff = applyExcludes(
      await git(gitRoot, [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        ...pathArgs,
      ]),
    );
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
    const keptUntracked = untracked.filter((entry) => {
      const excluded = pathMatchesExclude(entry, excludePrefixes);
      if (excluded) allExcluded.push(entry);
      return !excluded;
    });
    if (keptUntracked.length > 0) {
      const untrackedPaths = normalizePaths(gitRoot, keptUntracked, {
        workspaceRoots: [gitRoot],
      });
      sections.push(
        `Untracked files:\n${await captureFiles(untrackedPaths, sizeHints)}`,
      );
    }
  }

  const manifest = [
    `Git root: ${gitRoot}`,
    `Included states: ${[...include].join(", ")}`,
    gitPaths.length ? `Paths: ${gitPaths.join(", ")}` : "Paths: all",
    ...(allExcluded.length
      ? [`Excluded paths: ${[...new Set(allExcluded)].join(", ")}`]
      : []),
    "",
    ...sections,
  ].join("\n");
  return wrapSnapshot(scope.kind, manifest, sizeHints);
}
