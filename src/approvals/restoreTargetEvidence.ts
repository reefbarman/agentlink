import { execFile } from "node:child_process";
import { existsSync, type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { expandSubCommands, splitCompoundCommand } from "./commandSplitter.js";
import {
  hashWorkHistoryContent,
  type WorkHistoryFileFacts,
} from "../core/workHistory.js";

import type { FileKind } from "./commandReviewEvidence.js";
import { isCommandPathInsideWorkspace } from "./commandTierClassifier.js";
import { redactSensitiveText } from "./typeSafeGuardianShadow.js";
import { scanShellLexWords } from "../util/shellLex.js";

export const MAX_RESTORE_TARGETS = 8;
export const MAX_RESTORE_DIFF_CHARS = 12_000;
export const MAX_RESTORE_DIFF_TOTAL_CHARS = 32_000;
export const MAX_RESTORE_SAMPLE_FILES = 12;

const GIT_TIMEOUT_MS = 3_000;
const GIT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_HASHED_FILE_BYTES = 1024 * 1024;
const DIRECTORY_CHANGE_EXECUTABLES = new Set(["cd", "pushd", "popd"]);
const GLOB_CHARS_RE = /[*?[]/;

export type RestoreSourceKind = "index" | "tree" | "ours" | "theirs";

export type RestoreDiffUnavailableReason =
  | "binary"
  | "conflict_side"
  | "cwd_uncertain"
  | "git_failed"
  | "no_changes"
  | "not_a_single_file"
  | "outside_workspace"
  | "size_budget"
  | "unresolved_path";

/**
 * Host-measured facts about one path a `git checkout` or `git restore` would
 * overwrite in the working tree. `null` always means "not determined".
 */
export interface RestoreTargetEvidence {
  target: string;
  resolvedPath: string;
  insideWorkspace: boolean;
  kind: FileKind | null;
  /** Where the restored content comes from. */
  sourceKind: RestoreSourceKind;
  /** The tree-ish when `sourceKind` is "tree". */
  sourceRef: string | null;
  /** Tracked files under the target whose working copy would be overwritten. */
  changedFileCount: number | null;
  sampleChangedFiles: string[] | null;
  /** Working-copy lines that would be discarded, relative to the source. */
  linesAdded: number | null;
  linesRemoved: number | null;
  /** Source-to-working-copy diff: "+" lines are what the restore discards. */
  diff: string | null;
  diffTruncated: boolean;
  diffRedacted: boolean;
  diffUnavailableReason: RestoreDiffUnavailableReason | null;
  /** This session saved the file through AgentLink's file-edit tools. */
  sessionEdited: boolean | null;
  /** The file matched the restore source before the session's first recorded edit. */
  cleanBeforeSessionEdits: boolean | null;
  /** Something else changed the file between or after the session's recorded edits. */
  changedOutsideSessionEdits: boolean | null;
}

export interface RestoreTargetEvidenceResult {
  restoreTargets?: RestoreTargetEvidence[];
  restoreTargetsOmitted?: number;
}

export interface RestoreTargetEvidenceContext {
  cwd: string;
  workspaceRoots: string[];
  /** Host record of this session's edit-tool saves for one absolute path. */
  describeSessionFile?: (absolutePath: string) => {
    complete: boolean;
    file?: WorkHistoryFileFacts;
  };
}

interface ParsedRestore {
  cwd: string;
  cwdUncertain: boolean;
  sourceKind: RestoreSourceKind;
  sourceRef: string | null;
  paths: string[];
}

/**
 * Measure what the file-reverting git commands in `command` would discard.
 * Returns an empty object when the command restores no working-tree paths.
 * Facts describe the state before the command runs. Never throws.
 */
export async function collectRestoreTargetEvidence(
  command: string,
  ctx: RestoreTargetEvidenceContext,
): Promise<RestoreTargetEvidenceResult> {
  try {
    const requests: Array<{ target: string; parsed: ParsedRestore }> = [];
    let cwdUncertain = false;
    for (const subCommand of expandSubCommands(splitCompoundCommand(command))) {
      const tokens = scanShellLexWords(subCommand).words.map(({ raw }) =>
        stripQuotes(raw),
      );
      if (!tokens[0]) continue;
      if (DIRECTORY_CHANGE_EXECUTABLES.has(path.basename(tokens[0]))) {
        cwdUncertain = true;
        continue;
      }
      const parsed = parseRestoreCommand(tokens, ctx.cwd, cwdUncertain);
      if (!parsed) continue;
      for (const target of parsed.paths) requests.push({ target, parsed });
    }
    if (requests.length === 0) return {};

    const included = requests.slice(0, MAX_RESTORE_TARGETS);
    const targets = await Promise.all(
      included.map(({ target, parsed }) =>
        describeRestoreTarget(target, parsed, ctx).catch(() =>
          baseEvidence(target, parsed, ctx, "git_failed"),
        ),
      ),
    );
    applyDiffBudget(targets);
    return {
      restoreTargets: targets,
      restoreTargetsOmitted: requests.length - included.length,
    };
  } catch {
    return {};
  }
}

/**
 * Recognise `git checkout`/`git restore` invocations that overwrite
 * working-tree paths. Branch switches and index-only unstaging return
 * undefined.
 */
function parseRestoreCommand(
  tokens: string[],
  cwd: string,
  cwdUncertain: boolean,
): ParsedRestore | undefined {
  if (path.basename(tokens[0]!) !== "git") return undefined;
  let index = 1;
  let gitCwd = cwd;
  for (; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token === "-C") {
      const dir = tokens[++index];
      if (!dir || /[$`]/.test(dir)) return undefined;
      gitCwd = path.resolve(gitCwd, dir);
    } else if (token === "-c") {
      index++;
    } else if (/^--(?:git-dir|work-tree)(?:=|$)/.test(token)) {
      // A relocated repository or work tree is not measured.
      return undefined;
    } else if (!token.startsWith("-")) {
      break;
    }
  }
  const subcommand = tokens[index];
  const args = tokens.slice(index + 1);
  const parsed =
    subcommand === "restore"
      ? parseRestoreArgs(args)
      : subcommand === "checkout"
        ? parseCheckoutArgs(args, gitCwd)
        : undefined;
  if (!parsed || parsed.paths.length === 0) return undefined;
  if (parsed.sourceRef?.startsWith("-")) return undefined;
  return { cwd: gitCwd, cwdUncertain, ...parsed };
}

type ParsedRestoreArgs = Pick<
  ParsedRestore,
  "sourceKind" | "sourceRef" | "paths"
>;

function parseRestoreArgs(args: string[]): ParsedRestoreArgs | undefined {
  let staged = false;
  let worktree = false;
  let side: "ours" | "theirs" | undefined;
  let sourceRef: string | null = null;
  const paths: string[] = [];
  let afterSeparator = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (afterSeparator || !arg.startsWith("-")) {
      paths.push(arg);
    } else if (arg === "--") {
      afterSeparator = true;
    } else if (arg === "--source" || arg === "-s") {
      sourceRef = args[++index] ?? null;
    } else if (arg.startsWith("--source=")) {
      sourceRef = arg.slice("--source=".length);
    } else if (arg === "--staged") {
      staged = true;
    } else if (arg === "--worktree") {
      worktree = true;
    } else if (arg === "--ours" || arg === "--theirs") {
      side = arg === "--ours" ? "ours" : "theirs";
    } else if (arg === "--patch" || arg.startsWith("--pathspec-from-file")) {
      return undefined;
    } else if (!arg.startsWith("--")) {
      // Combined short flags such as -SW.
      const flags = arg.slice(1);
      if (flags.includes("p")) return undefined;
      staged ||= flags.includes("S");
      worktree ||= flags.includes("W");
      if (flags.endsWith("s")) sourceRef = args[++index] ?? null;
    }
  }
  // Without --worktree, --staged only unstages and leaves files intact.
  if (staged && !worktree) return undefined;
  if (side) return { sourceKind: side, sourceRef: null, paths };
  if (sourceRef) return { sourceKind: "tree", sourceRef, paths };
  return staged
    ? { sourceKind: "tree", sourceRef: "HEAD", paths }
    : { sourceKind: "index", sourceRef: null, paths };
}

const CHECKOUT_BRANCH_FLAGS = new Set([
  "-b",
  "-B",
  "--orphan",
  "--detach",
  "-d",
  "-t",
  "--track",
  "-p",
  "--patch",
]);

function parseCheckoutArgs(
  args: string[],
  cwd: string,
): ParsedRestoreArgs | undefined {
  if (args.some((arg) => CHECKOUT_BRANCH_FLAGS.has(arg))) return undefined;
  if (args.some((arg) => arg.startsWith("--pathspec-from-file"))) {
    return undefined;
  }
  const separator = args.indexOf("--");
  const before = (separator >= 0 ? args.slice(0, separator) : args).filter(
    (arg) => !arg.startsWith("-"),
  );
  const side = args.includes("--ours")
    ? "ours"
    : args.includes("--theirs")
      ? "theirs"
      : undefined;

  let treeish: string | undefined;
  let paths: string[];
  if (separator >= 0) {
    if (before.length > 1) return undefined;
    treeish = before[0];
    paths = args.slice(separator + 1);
  } else if (before.length === 0) {
    return undefined;
  } else if (side || existsSync(path.resolve(cwd, before[0]!))) {
    // Git reads the operands as paths when the first one names a file.
    paths = before;
  } else if (before.length >= 2) {
    treeish = before[0];
    paths = before.slice(1);
  } else {
    // A single operand that is not a path switches branches.
    return undefined;
  }

  if (side) return { sourceKind: side, sourceRef: null, paths };
  return treeish
    ? { sourceKind: "tree", sourceRef: treeish, paths }
    : { sourceKind: "index", sourceRef: null, paths };
}

function baseEvidence(
  target: string,
  parsed: ParsedRestore,
  ctx: RestoreTargetEvidenceContext,
  diffUnavailableReason: RestoreDiffUnavailableReason | null = null,
): RestoreTargetEvidence {
  const resolvedPath = path.resolve(parsed.cwd, target);
  return {
    target,
    resolvedPath,
    insideWorkspace: isCommandPathInsideWorkspace(
      resolvedPath,
      ctx.workspaceRoots,
    ),
    kind: null,
    sourceKind: parsed.sourceKind,
    sourceRef: parsed.sourceRef,
    changedFileCount: null,
    sampleChangedFiles: null,
    linesAdded: null,
    linesRemoved: null,
    diff: null,
    diffTruncated: false,
    diffRedacted: false,
    diffUnavailableReason,
    sessionEdited: null,
    cleanBeforeSessionEdits: null,
    changedOutsideSessionEdits: null,
  };
}

async function describeRestoreTarget(
  target: string,
  parsed: ParsedRestore,
  ctx: RestoreTargetEvidenceContext,
): Promise<RestoreTargetEvidence> {
  const evidence = baseEvidence(target, parsed, ctx);
  const unavailable = (reason: RestoreDiffUnavailableReason) => {
    evidence.diffUnavailableReason = reason;
    return evidence;
  };
  if (/[$`]/.test(target)) return unavailable("unresolved_path");
  // An earlier `cd` in the same command moves the paths somewhere unmeasured.
  if (parsed.cwdUncertain) return unavailable("cwd_uncertain");
  if (!evidence.insideWorkspace) return unavailable("outside_workspace");

  const pathspec = target.startsWith(":") || GLOB_CHARS_RE.test(target);
  const stat = pathspec
    ? undefined
    : await fs.lstat(evidence.resolvedPath).catch(() => undefined);
  evidence.kind = stat ? fileKind(stat) : null;
  const gitPath = pathspec
    ? target
    : path.relative(parsed.cwd, evidence.resolvedPath) || ".";

  const status = await runGit(
    ["status", "--porcelain=v1", "-z", "--untracked-files=no", "--", gitPath],
    parsed.cwd,
  );
  if (status === undefined) return unavailable("git_failed");
  const changed = changedFiles(status, parsed.sourceKind);
  evidence.changedFileCount = changed.length;
  evidence.sampleChangedFiles = changed.slice(0, MAX_RESTORE_SAMPLE_FILES);

  if (evidence.kind !== "file") return unavailable("not_a_single_file");
  if (changed.length === 0) return unavailable("no_changes");

  await Promise.all([
    measureDiff(evidence, parsed, gitPath),
    measureSessionFacts(evidence, parsed, gitPath, ctx),
  ]);
  return evidence;
}

/** Tracked paths from `git status --porcelain=v1 -z` that a restore overwrites. */
function changedFiles(status: string, sourceKind: RestoreSourceKind): string[] {
  const files: string[] = [];
  const entries = status.split("\0");
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!;
    if (entry.length < 4) continue;
    const indexState = entry[0]!;
    const worktreeState = entry[1]!;
    // Renames and copies carry their original path as the next entry.
    if (indexState === "R" || indexState === "C") index++;
    // Restoring from the index leaves staged-only changes in place.
    if (sourceKind === "index" && worktreeState === " ") continue;
    files.push(entry.slice(3));
  }
  return files;
}

async function measureDiff(
  evidence: RestoreTargetEvidence,
  parsed: ParsedRestore,
  gitPath: string,
): Promise<void> {
  if (parsed.sourceKind === "ours" || parsed.sourceKind === "theirs") {
    evidence.diffUnavailableReason = "conflict_side";
    return;
  }
  const output = await runGit(
    [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--unified=3",
      ...(parsed.sourceRef ? [parsed.sourceRef] : []),
      "--",
      gitPath,
    ],
    parsed.cwd,
  );
  if (output === undefined) {
    evidence.diffUnavailableReason = "git_failed";
    return;
  }
  if (/^Binary files .* differ$/m.test(output)) {
    evidence.diffUnavailableReason = "binary";
    return;
  }
  let added = 0;
  let removed = 0;
  let inHunk = false;
  for (const line of output.split("\n")) {
    if (line.startsWith("@@")) inHunk = true;
    else if (!inHunk) continue;
    else if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  evidence.linesAdded = added;
  evidence.linesRemoved = removed;
  const redacted = redactSensitiveText(output);
  evidence.diff = redacted.text;
  evidence.diffRedacted = redacted.redacted;
}

async function measureSessionFacts(
  evidence: RestoreTargetEvidence,
  parsed: ParsedRestore,
  gitPath: string,
  ctx: RestoreTargetEvidenceContext,
): Promise<void> {
  const record = ctx.describeSessionFile?.(evidence.resolvedPath);
  if (!record) return;
  const facts = record.file;
  if (!facts) {
    // An incomplete record cannot prove the session never edited the file.
    evidence.sessionEdited = record.complete ? false : null;
    return;
  }
  evidence.sessionEdited = true;

  const [currentHash, sourceHash] = await Promise.all([
    hashCurrentFile(evidence.resolvedPath),
    hashRestoreSource(parsed, gitPath),
  ]);
  if (currentHash !== undefined) {
    evidence.changedOutsideSessionEdits =
      !facts.continuous ||
      !facts.lastAfter.exists ||
      currentHash !== facts.lastAfter.hash;
  }
  if (sourceHash !== undefined) {
    evidence.cleanBeforeSessionEdits =
      facts.firstBefore.exists && facts.firstBefore.hash === sourceHash;
  }
}

async function hashCurrentFile(
  absolutePath: string,
): Promise<string | undefined> {
  try {
    const stat = await fs.lstat(absolutePath);
    if (!stat.isFile() || stat.size > MAX_HASHED_FILE_BYTES) return undefined;
    return hashWorkHistoryContent(
      true,
      await fs.readFile(absolutePath, "utf8"),
    );
  } catch {
    return undefined;
  }
}

/** Hash of the content the restore would write back, when git can show it. */
async function hashRestoreSource(
  parsed: ParsedRestore,
  gitPath: string,
): Promise<string | undefined> {
  if (parsed.sourceKind !== "index" && parsed.sourceKind !== "tree") {
    return undefined;
  }
  const relative = `./${gitPath.split(path.sep).join("/")}`;
  const content = await runGit(
    ["show", `${parsed.sourceRef ?? ""}:${relative}`],
    parsed.cwd,
  );
  return content === undefined
    ? undefined
    : hashWorkHistoryContent(true, content);
}

/** Keep diffs within the per-file and whole-command budgets, in target order. */
function applyDiffBudget(targets: RestoreTargetEvidence[]): void {
  let remaining = MAX_RESTORE_DIFF_TOTAL_CHARS;
  for (const target of targets) {
    if (target.diff === null) continue;
    const budget = Math.min(MAX_RESTORE_DIFF_CHARS, remaining);
    if (budget <= 0) {
      target.diff = null;
      target.diffUnavailableReason = "size_budget";
      continue;
    }
    if (target.diff.length > budget) {
      target.diff = target.diff.slice(0, budget);
      target.diffTruncated = true;
    }
    remaining -= target.diff.length;
  }
}

function runGit(args: string[], cwd: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    try {
      execFile(
        "git",
        ["-c", "core.fsmonitor=false", ...args],
        {
          cwd,
          timeout: GIT_TIMEOUT_MS,
          maxBuffer: GIT_MAX_OUTPUT_BYTES,
          encoding: "utf8",
          windowsHide: true,
          // Measuring must not take the index lock or refresh the index.
          env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
        },
        (error, stdout) => resolve(error ? undefined : stdout),
      );
    } catch {
      resolve(undefined);
    }
  });
}

function fileKind(stat: Stats): FileKind {
  if (stat.isSymbolicLink()) return "symlink";
  if (stat.isFile()) return "file";
  if (stat.isDirectory()) return "directory";
  return "other";
}

function stripQuotes(value: string): string {
  const fullyQuoted =
    (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
    (value.startsWith("'") && value.endsWith("'") && value.length >= 2);
  return fullyQuoted ? value.slice(1, -1) : value;
}
