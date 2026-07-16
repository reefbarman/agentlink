import * as crypto from "crypto";
import { isUtf8 } from "buffer";
import { execFile } from "child_process";
import * as fs from "fs/promises";
import * as path from "path";
import { promisify } from "util";

import type { ReviewScope } from "../core/capabilities/background.js";

const execFileAsync = promisify(execFile);
const MAX_REVIEW_SNAPSHOT_BYTES = 1_000_000;

function normalizePaths(cwd: string, paths: string[] | undefined): string[] {
  return (paths ?? []).map((input) => {
    const trimmed = input.trim();
    if (!trimmed) throw new Error("Review scope paths cannot be empty.");
    if (path.isAbsolute(trimmed)) {
      throw new Error(`Review scope path must be workspace-relative: ${input}`);
    }
    const resolved = path.resolve(cwd, trimmed);
    const relative = path.relative(cwd, resolved);
    if (
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new Error(`Review scope path is outside the workspace: ${input}`);
    }
    return relative.replaceAll(path.sep, "/") || ".";
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
    throw new Error(`Unable to capture review scope with Git: ${detail}`);
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

async function captureFiles(cwd: string, paths: string[]): Promise<string> {
  const sections: string[] = [];
  for (const relativePath of paths) {
    const absolutePath = path.resolve(cwd, relativePath);
    let stat;
    try {
      stat = await fs.lstat(absolutePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        sections.push(`File ${JSON.stringify(relativePath)} is missing.`);
        continue;
      }
      throw error;
    }

    if (stat.isSymbolicLink()) {
      const target = await fs.readlink(absolutePath);
      sections.push(
        `File ${JSON.stringify(relativePath)} is a symbolic link to ${JSON.stringify(target)}.`,
      );
      continue;
    }
    if (!stat.isFile()) {
      throw new Error(`Review scope path is not a file: ${relativePath}`);
    }
    if (stat.size > MAX_REVIEW_SNAPSHOT_BYTES) {
      throw new Error(
        `Review scope file ${relativePath} is ${stat.size} bytes, above the ${MAX_REVIEW_SNAPSHOT_BYTES}-byte limit.`,
      );
    }

    const content = await fs.readFile(absolutePath);
    if (content.includes(0) || !isUtf8(content)) {
      sections.push(
        `Binary file ${JSON.stringify(relativePath)} (${content.byteLength} bytes, sha256:${crypto.createHash("sha256").update(content).digest("hex")}).`,
      );
      continue;
    }
    sections.push(
      `File: ${relativePath}\n${fenced(content.toString("utf8"), "text")}`,
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
): Promise<string> {
  if (scope.kind === "diff") {
    const label = scope.label?.trim() || "Provided diff";
    return wrapSnapshot(
      scope.kind,
      `${label}:\n${fenced(scope.content, "diff")}`,
    );
  }

  const paths = normalizePaths(cwd, scope.paths);

  if (scope.kind === "files") {
    if (paths.length === 0) {
      throw new Error("reviewScope.files requires at least one path.");
    }
    return wrapSnapshot(scope.kind, await captureFiles(cwd, paths));
  }

  const pathArgs = paths.length > 0 ? ["--", ...paths] : [];

  if (scope.kind === "commit_range") {
    const range = scope.range.trim();
    if (!range || range.startsWith("-")) {
      throw new Error("reviewScope.commit_range requires a valid Git range.");
    }
    const diff = await git(cwd, [
      "diff",
      "--no-ext-diff",
      "--no-color",
      "--binary",
      range,
      ...pathArgs,
    ]);
    return wrapSnapshot(
      scope.kind,
      `Git range: ${range}${paths.length ? `\nPaths: ${paths.join(", ")}` : ""}\n\n${fenced(diff, "diff")}`,
    );
  }

  const include = new Set(
    scope.include?.length ? scope.include : ["unstaged", "untracked"],
  );
  const sections: string[] = [];

  if (include.has("staged")) {
    const diff = await git(cwd, [
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
    const diff = await git(cwd, [
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
    const output = await git(cwd, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
      ...pathArgs,
    ]);
    const untracked = output.split("\0").filter(Boolean);
    if (untracked.length > 0) {
      sections.push(`Untracked files:\n${await captureFiles(cwd, untracked)}`);
    }
  }

  const manifest = [
    `Included states: ${[...include].join(", ")}`,
    paths.length ? `Paths: ${paths.join(", ")}` : "Paths: all",
    "",
    ...sections,
  ].join("\n");
  return wrapSnapshot(scope.kind, manifest);
}
