import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

import { hostFlightRecorder } from "../core/hostLiveness.js";
import picomatch from "picomatch";
import { resolveContainedCodeIndexPath } from "./codeIndexPaths.js";
import { spawn } from "child_process";

const MAX_FILE_SIZE = 1_000_000;
// Candidate filtering runs on the extension host main thread; identity
// resolution (realpath) is sync per file, so chunks bound the per-slice block
// and the awaits between chunks yield to the event loop.
const FILTER_CHUNK_SIZE = 200;
// git check-ignore reads all paths from stdin; chunking bounds child stdin and
// stdout buffers when callers pass very large candidate sets.
const CHECK_IGNORE_CHUNK_SIZE = 5_000;

const EXPLICITLY_INDEXED_IGNORED_PATHS = [
  ".claude/skills/**",
  "fixtures/agent-eval-workspace/work/**",
];
const EXPLICITLY_INDEXED_IGNORED_PATH_MATCHERS =
  EXPLICITLY_INDEXED_IGNORED_PATHS.map((pattern) =>
    picomatch(pattern, { dot: true }),
  );
const CLAUDE_DIRECTORY_EXCLUSION = "**/.claude/**";

export const DEFAULT_INDEX_EXCLUSIONS = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
  "**/.next/**",
  "**/coverage/**",
  "**/__pycache__/**",
  "**/target/**",
  "**/.venv/**",
  "**/vendor/**",
  "**/.claude/**",
  "**/.codex/**",
  "**/.agentlink/**",
  "**/.agents/**",
  "**/*.min.js",
  "**/*.map",
];

interface FileStat {
  isFile(): boolean;
  size: number;
}

export interface GitWorkspaceFileListing {
  /** Tracked plus untracked-but-not-ignored paths, relative with `/` separators. */
  nonIgnoredRelativePaths: string[];
  /** Ignored paths matching EXPLICITLY_INDEXED_IGNORED_PATHS, same format. */
  explicitlyIndexedIgnoredRelativePaths: string[];
}

export interface IndexableFileDiscoveryOptions {
  findFiles?: (
    workspaceRoot: string,
    excludePattern: string,
  ) => Promise<string[]>;
  statFile?: (filePath: string) => FileStat | Promise<FileStat>;
  getGitIgnoredRelativePaths?: (
    relPaths: string[],
    workspaceRoot: string,
  ) => Promise<Set<string>>;
  /** Returns undefined when git enumeration is unavailable for the root. */
  listGitWorkspaceFiles?: (
    workspaceRoot: string,
  ) => Promise<GitWorkspaceFileListing | undefined>;
}

export class IndexableFileDiscovery {
  private readonly findFiles: NonNullable<
    IndexableFileDiscoveryOptions["findFiles"]
  >;
  private readonly statFile: NonNullable<
    IndexableFileDiscoveryOptions["statFile"]
  >;
  private readonly getGitIgnoredRelativePaths: NonNullable<
    IndexableFileDiscoveryOptions["getGitIgnoredRelativePaths"]
  >;
  private readonly listGitWorkspaceFiles: NonNullable<
    IndexableFileDiscoveryOptions["listGitWorkspaceFiles"]
  >;

  constructor(
    private readonly log: (message: string) => void,
    options: IndexableFileDiscoveryOptions = {},
  ) {
    this.findFiles = options.findFiles ?? findWorkspaceFiles;
    this.statFile =
      options.statFile ?? ((filePath) => fs.promises.stat(filePath));
    this.getGitIgnoredRelativePaths =
      options.getGitIgnoredRelativePaths ??
      ((relPaths, workspaceRoot) =>
        getGitIgnoredRelativePaths(relPaths, workspaceRoot, this.log));
    this.listGitWorkspaceFiles =
      options.listGitWorkspaceFiles ??
      ((workspaceRoot) => listGitWorkspaceFiles(workspaceRoot, this.log));
  }

  async discoverIndexableFiles(
    workspaceRoot: string,
    exclusions: string[] = DEFAULT_INDEX_EXCLUSIONS,
  ): Promise<string[]> {
    const flightOp = hostFlightRecorder.opStarted(
      "index-discovery",
      path.basename(workspaceRoot),
    );
    try {
      const gitListing = await this.listGitWorkspaceFiles(workspaceRoot);
      if (gitListing) {
        const toAbsolute = (relPath: string) =>
          path.join(workspaceRoot, ...relPath.split("/"));
        const nonIgnored = await this.filterByExclusionsAndStat(
          gitListing.nonIgnoredRelativePaths.map(toAbsolute),
          workspaceRoot,
          exclusions,
        );
        const explicitlyIndexedIgnored = await this.filterByExclusionsAndStat(
          gitListing.explicitlyIndexedIgnoredRelativePaths.map(toAbsolute),
          workspaceRoot,
          exclusions,
        );
        return [...new Set([...nonIgnored, ...explicitlyIndexedIgnored])];
      }

      const excludePattern = `{${exclusions.join(",")}}`;
      const discovered = await this.findFiles(workspaceRoot, excludePattern);
      this.log(
        `Git file listing unavailable for ${workspaceRoot}; filtering ${discovered.length} discovered candidates`,
      );
      return this.filterIndexableFiles(discovered, workspaceRoot, exclusions);
    } finally {
      flightOp.end();
    }
  }

  async filterIndexableFiles(
    files: string[],
    workspaceRoot: string,
    exclusions: string[] = DEFAULT_INDEX_EXCLUSIONS,
  ): Promise<string[]> {
    const flightOp = hostFlightRecorder.opStarted(
      "index-filter",
      `${files.length} candidates`,
    );
    try {
      const existingFiles = await this.filterByExclusionsAndStat(
        files,
        workspaceRoot,
        exclusions,
      );

      const nonIgnoredFiles = await this.filterGitIgnoredPaths(
        existingFiles,
        workspaceRoot,
        false,
      );
      const explicitlyIndexedIgnoredFiles = await this.filterGitIgnoredPaths(
        existingFiles.filter((filePath) =>
          isExplicitlyIndexedIgnoredPath(
            resolveContainedCodeIndexPath(workspaceRoot, filePath)
              ?.portableRelativePath ?? "",
          ),
        ),
        workspaceRoot,
        true,
      );
      return [
        ...new Set([...nonIgnoredFiles, ...explicitlyIndexedIgnoredFiles]),
      ];
    } finally {
      flightOp.end();
    }
  }

  async filterExplicitlyIncludedRemovedPaths(
    files: string[],
    workspaceRoot: string,
    exclusions: string[],
  ): Promise<string[]> {
    if (files.length === 0) return files;
    const exclusionMatcher = buildExclusionMatcher(workspaceRoot, exclusions);
    const explicitPathExclusionMatcher = buildExclusionMatcher(
      workspaceRoot,
      exclusions.filter((pattern) => pattern !== CLAUDE_DIRECTORY_EXCLUSION),
    );
    return files.flatMap((filePath) => {
      const identity = resolveContainedCodeIndexPath(workspaceRoot, filePath);
      return identity &&
        (!exclusionMatcher(identity) ||
          (isExplicitlyIndexedIgnoredPath(identity.portableRelativePath) &&
            !explicitPathExclusionMatcher(identity)))
        ? [identity.absolutePath]
        : [];
    });
  }

  private async filterByExclusionsAndStat(
    files: string[],
    workspaceRoot: string,
    exclusions: string[],
  ): Promise<string[]> {
    if (files.length === 0) return [];
    const exclusionMatcher = buildExclusionMatcher(workspaceRoot, exclusions);
    const explicitPathExclusionMatcher = buildExclusionMatcher(
      workspaceRoot,
      exclusions.filter((pattern) => pattern !== CLAUDE_DIRECTORY_EXCLUSION),
    );
    const results: string[] = [];
    for (let start = 0; start < files.length; start += FILTER_CHUNK_SIZE) {
      const chunk = files.slice(start, start + FILTER_CHUNK_SIZE);
      const kept = await Promise.all(
        chunk.map(async (filePath) => {
          const identity = resolveContainedCodeIndexPath(
            workspaceRoot,
            filePath,
          );
          if (
            !identity ||
            (exclusionMatcher(identity) &&
              (!isExplicitlyIndexedIgnoredPath(identity.portableRelativePath) ||
                explicitPathExclusionMatcher(identity)))
          ) {
            return undefined;
          }
          try {
            const stat = await this.statFile(identity.absolutePath);
            return stat.isFile() && stat.size > 0 && stat.size <= MAX_FILE_SIZE
              ? identity.absolutePath
              : undefined;
          } catch {
            return undefined;
          }
        }),
      );
      for (const filePath of kept) {
        if (filePath !== undefined) results.push(filePath);
      }
    }
    return results;
  }

  private async filterGitIgnoredPaths(
    files: string[],
    workspaceRoot: string,
    keepIgnored: boolean,
  ): Promise<string[]> {
    if (files.length === 0) return files;

    const relPathEntries = files.flatMap((filePath) => {
      const identity = resolveContainedCodeIndexPath(workspaceRoot, filePath);
      return identity
        ? [
            {
              filePath: identity.absolutePath,
              relPath: identity.portableRelativePath,
            },
          ]
        : [];
    });

    if (relPathEntries.length === 0) return [];

    const ignoredRelPaths = await this.getGitIgnoredRelativePaths(
      relPathEntries.map((entry) => entry.relPath),
      workspaceRoot,
    );

    return relPathEntries
      .filter((entry) => ignoredRelPaths.has(entry.relPath) === keepIgnored)
      .map((entry) => entry.filePath);
  }
}

function buildExclusionMatcher(
  workspaceRoot: string,
  exclusions: string[],
): (identity: {
  absolutePath: string;
  portableRelativePath: string;
}) => boolean {
  const relativeMatchers = exclusions.map((pattern) =>
    picomatch(pattern, { dot: true }),
  );
  const absoluteMatchers = exclusions
    .filter((pattern) => path.isAbsolute(pattern))
    .map((pattern) => picomatch(pattern, { dot: true }));

  return ({ absolutePath, portableRelativePath }) => {
    if (relativeMatchers.some((matcher) => matcher(portableRelativePath))) {
      return true;
    }

    const normalizedAbsPath = absolutePath.split(path.sep).join("/");
    return absoluteMatchers.some((matcher) => matcher(normalizedAbsPath));
  };
}

function isExplicitlyIndexedIgnoredPath(portableRelativePath: string): boolean {
  return EXPLICITLY_INDEXED_IGNORED_PATH_MATCHERS.some((matcher) =>
    matcher(portableRelativePath),
  );
}

async function findWorkspaceFiles(
  workspaceRoot: string,
  excludePattern: string,
): Promise<string[]> {
  const folder = vscode.workspace.getWorkspaceFolder(
    vscode.Uri.file(workspaceRoot),
  );
  const includePattern = new vscode.RelativePattern(
    folder ?? workspaceRoot,
    "**/*",
  );
  const uris = await vscode.workspace.findFiles(includePattern, excludePattern);
  return uris.map((uri) => uri.fsPath);
}

/**
 * Enumerate indexable candidates straight from git so gitignored trees
 * (generated output, caches) are never materialized as candidates. Returns
 * undefined when the root is not a git work tree or git is unavailable, in
 * which case discovery falls back to workspace glob search + check-ignore.
 * Limitation: paths inside submodules are listed as the submodule gitlink
 * only, which the stat filter drops (submodule contents are not indexed).
 */
export async function listGitWorkspaceFiles(
  workspaceRoot: string,
  log: (message: string) => void,
): Promise<GitWorkspaceFileListing | undefined> {
  const nonIgnored = await runGitPathList(
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    workspaceRoot,
    log,
  );
  if (nonIgnored === undefined) return undefined;

  let explicitlyIndexedIgnored: string[] = [];
  const explicitPrefixes = EXPLICITLY_INDEXED_IGNORED_PATHS.map(
    staticGlobPrefix,
  ).filter((prefix) => prefix.length > 0);
  if (explicitPrefixes.length > 0) {
    const listed = await runGitPathList(
      [
        "ls-files",
        "--others",
        "--ignored",
        "--exclude-standard",
        "-z",
        "--",
        ...explicitPrefixes,
      ],
      workspaceRoot,
      log,
    );
    const matchers = EXPLICITLY_INDEXED_IGNORED_PATHS.map((pattern) =>
      picomatch(pattern, { dot: true }),
    );
    explicitlyIndexedIgnored = (listed ?? []).filter((relPath) =>
      matchers.some((matcher) => matcher(relPath)),
    );
  }

  return {
    nonIgnoredRelativePaths: nonIgnored,
    explicitlyIndexedIgnoredRelativePaths: explicitlyIndexedIgnored,
  };
}

/** Leading pattern segments with no glob syntax, usable as a git pathspec. */
function staticGlobPrefix(pattern: string): string {
  const staticSegments: string[] = [];
  for (const segment of pattern.split("/")) {
    if (/[*?[\]{}()!]/.test(segment)) break;
    staticSegments.push(segment);
  }
  return staticSegments.join("/");
}

function runGitPathList(
  args: string[],
  workspaceRoot: string,
  log: (message: string) => void,
): Promise<string[] | undefined> {
  return new Promise((resolve) => {
    const child = spawn("git", args, {
      cwd: workspaceRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    child.on("error", (error) => {
      const code = (error as NodeJS.ErrnoException).code;
      log(
        `Git file listing unavailable (${String(code ?? error.message)}); falling back to workspace search.`,
      );
      resolve(undefined);
    });
    child.on("close", (code) => {
      if (code === 0) {
        const output = Buffer.concat(stdoutChunks).toString("utf8");
        resolve(output.split("\0").filter(Boolean));
        return;
      }
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
      log(
        `Git file listing failed (${code ?? "unknown"})${stderr ? `: ${stderr}` : ""}; falling back to workspace search.`,
      );
      resolve(undefined);
    });
  });
}

export async function getGitIgnoredRelativePaths(
  relPaths: string[],
  workspaceRoot: string,
  log: (message: string) => void,
): Promise<Set<string>> {
  const ignored = new Set<string>();
  for (
    let start = 0;
    start < relPaths.length;
    start += CHECK_IGNORE_CHUNK_SIZE
  ) {
    const chunk = relPaths.slice(start, start + CHECK_IGNORE_CHUNK_SIZE);
    const chunkIgnored = await runCheckIgnore(chunk, workspaceRoot, log);
    for (const relPath of chunkIgnored) ignored.add(relPath);
  }
  return ignored;
}

function runCheckIgnore(
  relPaths: string[],
  workspaceRoot: string,
  log: (message: string) => void,
): Promise<Set<string>> {
  if (relPaths.length === 0) return Promise.resolve(new Set());

  return new Promise((resolve) => {
    const child = spawn("git", ["check-ignore", "--stdin", "-z"], {
      cwd: workspaceRoot,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    child.on("error", (error) => {
      const code = (error as NodeJS.ErrnoException).code;
      log(
        `Git ignore filtering unavailable (${String(code ?? error.message)}); indexing non-excluded files only.`,
      );
      resolve(new Set());
    });
    child.stdin.on("error", () => {
      // git may exit before consuming all stdin; ignore broken-pipe errors.
    });
    child.on("close", (code) => {
      const output = Buffer.concat(stdoutChunks).toString("utf8");
      if (code === 0 || code === 1) {
        resolve(new Set(output.split("\0").filter(Boolean)));
        return;
      }

      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
      log(
        `Git ignore filtering failed (${code ?? "unknown"})${stderr ? `: ${stderr}` : ""}`,
      );
      resolve(new Set());
    });

    child.stdin.end(Buffer.from(relPaths.join("\0") + "\0"));
  });
}
