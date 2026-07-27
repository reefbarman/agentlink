import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

import picomatch from "picomatch";
import { resolveContainedCodeIndexPath } from "./codeIndexPaths.js";
import { spawn } from "child_process";

const MAX_FILE_SIZE = 1_000_000;

const EXPLICITLY_INDEXED_IGNORED_PATHS = [
  "fixtures/agent-eval-workspace/work/**",
];

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

export interface IndexableFileDiscoveryOptions {
  findFiles?: (
    workspaceRoot: string,
    excludePattern: string,
  ) => Promise<string[]>;
  statFile?: (filePath: string) => FileStat;
  getGitIgnoredRelativePaths?: (
    relPaths: string[],
    workspaceRoot: string,
  ) => Promise<Set<string>>;
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

  constructor(
    private readonly log: (message: string) => void,
    options: IndexableFileDiscoveryOptions = {},
  ) {
    this.findFiles = options.findFiles ?? findWorkspaceFiles;
    this.statFile = options.statFile ?? fs.statSync;
    this.getGitIgnoredRelativePaths =
      options.getGitIgnoredRelativePaths ??
      ((relPaths, workspaceRoot) =>
        getGitIgnoredRelativePaths(relPaths, workspaceRoot, this.log));
  }

  async discoverIndexableFiles(
    workspaceRoot: string,
    exclusions: string[] = DEFAULT_INDEX_EXCLUSIONS,
  ): Promise<string[]> {
    const excludePattern = `{${exclusions.join(",")}}`;
    const discovered = await this.findFiles(workspaceRoot, excludePattern);
    return this.filterIndexableFiles(discovered, workspaceRoot, exclusions);
  }

  async filterIndexableFiles(
    files: string[],
    workspaceRoot: string,
    exclusions: string[] = DEFAULT_INDEX_EXCLUSIONS,
  ): Promise<string[]> {
    const exclusionMatcher = buildExclusionMatcher(workspaceRoot, exclusions);
    const existingFiles = files.flatMap((filePath) => {
      const identity = resolveContainedCodeIndexPath(workspaceRoot, filePath);
      if (!identity || exclusionMatcher(identity)) return [];
      try {
        const stat = this.statFile(identity.absolutePath);
        return stat.isFile() && stat.size > 0 && stat.size <= MAX_FILE_SIZE
          ? [identity.absolutePath]
          : [];
      } catch {
        return [];
      }
    });

    const nonIgnoredFiles = await this.filterGitIgnoredPaths(
      existingFiles,
      workspaceRoot,
      false,
    );
    const explicitlyIndexedIgnoredFiles = await this.filterGitIgnoredPaths(
      existingFiles.filter((filePath) =>
        isExplicitlyIndexedIgnoredPath(filePath, workspaceRoot),
      ),
      workspaceRoot,
      true,
    );
    return [...new Set([...nonIgnoredFiles, ...explicitlyIndexedIgnoredFiles])];
  }

  async filterExplicitlyIncludedRemovedPaths(
    files: string[],
    workspaceRoot: string,
    exclusions: string[],
  ): Promise<string[]> {
    if (files.length === 0) return files;
    const exclusionMatcher = buildExclusionMatcher(workspaceRoot, exclusions);
    return files.flatMap((filePath) => {
      const identity = resolveContainedCodeIndexPath(workspaceRoot, filePath);
      return identity && !exclusionMatcher(identity)
        ? [identity.absolutePath]
        : [];
    });
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

function isExplicitlyIndexedIgnoredPath(
  filePath: string,
  workspaceRoot: string,
): boolean {
  const identity = resolveContainedCodeIndexPath(workspaceRoot, filePath);
  return (
    identity !== undefined &&
    EXPLICITLY_INDEXED_IGNORED_PATHS.some((pattern) =>
      picomatch(pattern, { dot: true })(identity.portableRelativePath),
    )
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

function getGitIgnoredRelativePaths(
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
