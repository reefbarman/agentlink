import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { expandSubCommands, splitCompoundCommand } from "./commandSplitter.js";
import { isCommandPathInsideWorkspace } from "./commandTierClassifier.js";

import { scanShellLexWords } from "../util/shellLex.js";

export const MAX_REFERENCED_SCRIPTS = 4;
export const MAX_REFERENCED_SCRIPT_CONTENT_CHARS = 16_384;
export const MAX_REFERENCED_SCRIPT_TOTAL_CHARS = 32_768;
export const MAX_REFERENCED_SCRIPT_READ_BYTES = 1024 * 1024;
export const MAX_DELETION_TARGETS = 8;
export const MAX_DELETION_TARGET_SAMPLE_ENTRIES = 12;
export const MAX_DELETION_TARGET_SIZED_ENTRIES = 200;

const SCRIPT_INTERPRETERS = new Set([
  ".",
  "bash",
  "dash",
  "fish",
  "ksh",
  "node",
  "perl",
  "python",
  "python3",
  "ruby",
  "sh",
  "source",
  "zsh",
]);

// Flags that make the interpreter execute inline code or a module instead of
// a script file argument, so no file reference should be extracted.
const INLINE_CODE_FLAGS = new Set(["-c", "-e", "-m", "-p", "--eval"]);

const GLOB_CHARS_RE = /[*?[]/;

export type FileKind = "file" | "directory" | "symlink" | "other";

export type ScriptContentUnavailableReason =
  | "missing"
  | "not_regular_file"
  | "outside_workspace"
  | "size_budget"
  | "unreadable";

export interface ReferencedScriptEvidence {
  reference: string;
  resolvedPath: string;
  insideWorkspace: boolean;
  exists: boolean;
  kind: FileKind | null;
  bytes: number | null;
  sha256: string | null;
  content: string | null;
  contentTruncated: boolean;
  contentUnavailableReason: ScriptContentUnavailableReason | null;
}

export interface DeletionTargetEvidence {
  target: string;
  resolvedPath: string;
  glob: boolean;
  insideWorkspace: boolean;
  exists: boolean;
  kind: FileKind | null;
  bytes: number | null;
  entryCount: number | null;
  sampleEntries: string[] | null;
}

export interface CommandReviewEvidence {
  referencedScripts: ReferencedScriptEvidence[];
  deletionTargets: DeletionTargetEvidence[];
  deletionTargetsOmitted: number;
}

export interface CommandReviewEvidenceContext {
  cwd: string;
  workspaceRoots: string[];
}

export function collectCommandReviewEvidence(
  command: string,
  ctx: CommandReviewEvidenceContext,
): CommandReviewEvidence {
  try {
    const subCommands = expandSubCommands(splitCompoundCommand(command));
    const scriptReferences: string[] = [];
    const deletionTargetArgs: string[] = [];

    for (const subCommand of subCommands) {
      const tokens = scanShellLexWords(subCommand).words.map(({ raw }) =>
        stripQuotes(raw),
      );
      const commandToken = tokens[0];
      if (!commandToken) continue;
      const executable = path.basename(commandToken);
      const args = tokens.slice(1);

      if (isPathQualified(commandToken)) {
        scriptReferences.push(commandToken);
      } else if (SCRIPT_INTERPRETERS.has(executable)) {
        const scriptArg = interpreterScriptArgument(args);
        if (scriptArg) scriptReferences.push(scriptArg);
      }

      if (executable === "rm" || executable === "rmdir") {
        deletionTargetArgs.push(...deletionArguments(args));
      }
    }

    return {
      referencedScripts: buildReferencedScripts(scriptReferences, ctx),
      ...buildDeletionTargets(deletionTargetArgs, ctx),
    };
  } catch {
    return {
      referencedScripts: [],
      deletionTargets: [],
      deletionTargetsOmitted: 0,
    };
  }
}

function buildReferencedScripts(
  references: string[],
  ctx: CommandReviewEvidenceContext,
): ReferencedScriptEvidence[] {
  const evidence: ReferencedScriptEvidence[] = [];
  const seen = new Set<string>();
  let remainingContentChars = MAX_REFERENCED_SCRIPT_TOTAL_CHARS;

  for (const reference of references) {
    if (evidence.length >= MAX_REFERENCED_SCRIPTS) break;
    try {
      const resolvedPath = resolvePathLike(reference, ctx.cwd);
      const seenKey = normalizeForCompare(resolvedPath);
      if (seen.has(seenKey)) continue;
      seen.add(seenKey);
      const entry = describeReferencedScript(
        reference,
        resolvedPath,
        ctx,
        remainingContentChars,
      );
      if (entry.content !== null) remainingContentChars -= entry.content.length;
      evidence.push(entry);
    } catch {
      // Evidence collection is best-effort; skip entries that cannot be read.
    }
  }

  return evidence;
}

function describeReferencedScript(
  reference: string,
  resolvedPath: string,
  ctx: CommandReviewEvidenceContext,
  remainingContentChars: number,
): ReferencedScriptEvidence {
  const insideWorkspace = isCommandPathInsideWorkspace(
    resolvedPath,
    ctx.workspaceRoots,
  );
  const base: ReferencedScriptEvidence = {
    reference,
    resolvedPath,
    insideWorkspace,
    exists: false,
    kind: null,
    bytes: null,
    sha256: null,
    content: null,
    contentTruncated: false,
    contentUnavailableReason: "missing",
  };

  const lstat = statNoThrow(resolvedPath, "lstat");
  if (!lstat) return base;
  base.exists = true;
  base.kind = fileKind(lstat);

  const stat = lstat.isSymbolicLink()
    ? statNoThrow(resolvedPath, "stat")
    : lstat;
  if (!stat?.isFile()) {
    base.contentUnavailableReason = "not_regular_file";
    return base;
  }
  base.bytes = stat.size;

  // Scripts inside the OS temp directory (e.g. agent-materialized files) are
  // also readable evidence; anything else outside the workspace stays
  // metadata-only so unrelated host files never enter a review prompt.
  const readable =
    insideWorkspace ||
    isCommandPathInsideWorkspace(resolvedPath, [os.tmpdir()]);
  if (!readable) {
    base.contentUnavailableReason = "outside_workspace";
    return base;
  }
  if (stat.size > MAX_REFERENCED_SCRIPT_READ_BYTES) {
    base.contentUnavailableReason = "size_budget";
    return base;
  }

  let content: string;
  try {
    content = fs.readFileSync(resolvedPath, "utf-8");
  } catch {
    base.contentUnavailableReason = "unreadable";
    return base;
  }
  base.sha256 = crypto
    .createHash("sha256")
    .update(content, "utf-8")
    .digest("hex");

  const budget = Math.min(
    MAX_REFERENCED_SCRIPT_CONTENT_CHARS,
    remainingContentChars,
  );
  if (budget <= 0) {
    base.contentUnavailableReason = "size_budget";
    return base;
  }
  base.contentUnavailableReason = null;
  base.contentTruncated = content.length > budget;
  base.content = base.contentTruncated ? content.slice(0, budget) : content;
  return base;
}

function buildDeletionTargets(
  targets: string[],
  ctx: CommandReviewEvidenceContext,
): Pick<CommandReviewEvidence, "deletionTargets" | "deletionTargetsOmitted"> {
  const evidence: DeletionTargetEvidence[] = [];
  for (const target of targets.slice(0, MAX_DELETION_TARGETS)) {
    try {
      evidence.push(describeDeletionTarget(target, ctx));
    } catch {
      // Evidence collection is best-effort; skip entries that cannot be read.
    }
  }
  return {
    deletionTargets: evidence,
    deletionTargetsOmitted: Math.max(0, targets.length - MAX_DELETION_TARGETS),
  };
}

function describeDeletionTarget(
  target: string,
  ctx: CommandReviewEvidenceContext,
): DeletionTargetEvidence {
  if (GLOB_CHARS_RE.test(target)) {
    return describeGlobDeletionTarget(target, ctx);
  }

  const resolvedPath = resolvePathLike(target, ctx.cwd);
  const base: DeletionTargetEvidence = {
    target,
    resolvedPath,
    glob: false,
    insideWorkspace: isCommandPathInsideWorkspace(
      resolvedPath,
      ctx.workspaceRoots,
    ),
    exists: false,
    kind: null,
    bytes: null,
    entryCount: null,
    sampleEntries: null,
  };

  const lstat = statNoThrow(resolvedPath, "lstat");
  if (!lstat) return base;
  base.exists = true;
  base.kind = fileKind(lstat);

  if (lstat.isFile()) {
    base.bytes = lstat.size;
  } else if (lstat.isDirectory()) {
    const entries = readdirNoThrow(resolvedPath);
    if (entries) {
      base.entryCount = entries.length;
      base.sampleEntries = entries.slice(0, MAX_DELETION_TARGET_SAMPLE_ENTRIES);
      base.bytes = shallowByteSum(resolvedPath, entries);
    }
  }
  return base;
}

function describeGlobDeletionTarget(
  target: string,
  ctx: CommandReviewEvidenceContext,
): DeletionTargetEvidence {
  const parent = path.dirname(target);
  const pattern = path.basename(target);
  const resolvedParent = resolvePathLike(parent, ctx.cwd);
  const base: DeletionTargetEvidence = {
    target,
    resolvedPath: path.join(resolvedParent, pattern),
    glob: true,
    insideWorkspace: isCommandPathInsideWorkspace(
      resolvedParent,
      ctx.workspaceRoots,
    ),
    exists: false,
    kind: null,
    bytes: null,
    entryCount: null,
    sampleEntries: null,
  };

  // Only basename-level globs are expanded; a glob in the directory part
  // stays unexpanded metadata.
  if (GLOB_CHARS_RE.test(parent)) return base;

  const entries = readdirNoThrow(resolvedParent);
  if (!entries) return base;
  const matcher = globToRegExp(pattern);
  const matches = entries.filter((entry) => matcher.test(entry));
  base.exists = matches.length > 0;
  base.entryCount = matches.length;
  base.sampleEntries = matches.slice(0, MAX_DELETION_TARGET_SAMPLE_ENTRIES);
  base.bytes = shallowByteSum(resolvedParent, matches);
  return base;
}

function shallowByteSum(dir: string, entries: string[]): number | null {
  let total = 0;
  let counted = false;
  for (const entry of entries.slice(0, MAX_DELETION_TARGET_SIZED_ENTRIES)) {
    const stat = statNoThrow(path.join(dir, entry), "lstat");
    if (stat?.isFile()) {
      total += stat.size;
      counted = true;
    }
  }
  return counted ? total : null;
}

function deletionArguments(args: string[]): string[] {
  const targets: string[] = [];
  let afterDoubleDash = false;
  for (const arg of args) {
    if (!afterDoubleDash && arg === "--") {
      afterDoubleDash = true;
      continue;
    }
    if (!afterDoubleDash && arg.startsWith("-") && arg !== "-") continue;
    targets.push(arg);
  }
  return targets;
}

function interpreterScriptArgument(args: string[]): string | undefined {
  let afterDoubleDash = false;
  for (const arg of args) {
    if (!afterDoubleDash && INLINE_CODE_FLAGS.has(arg)) return undefined;
    if (!afterDoubleDash && arg === "--") {
      afterDoubleDash = true;
      continue;
    }
    if (!afterDoubleDash && arg.startsWith("-") && arg !== "-") continue;
    return arg;
  }
  return undefined;
}

function isPathQualified(commandToken: string): boolean {
  return commandToken !== path.basename(commandToken);
}

function globToRegExp(pattern: string): RegExp {
  const source = pattern
    .split("")
    .map((char) => {
      if (char === "*") return ".*";
      if (char === "?") return ".";
      return char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    })
    .join("");
  return new RegExp(`^${source}$`);
}

function statNoThrow(
  target: string,
  mode: "stat" | "lstat",
): fs.Stats | undefined {
  try {
    return mode === "stat" ? fs.statSync(target) : fs.lstatSync(target);
  } catch {
    return undefined;
  }
}

function readdirNoThrow(dir: string): string[] | undefined {
  try {
    return fs.readdirSync(dir).sort();
  } catch {
    return undefined;
  }
}

function fileKind(stat: fs.Stats): FileKind {
  if (stat.isSymbolicLink()) return "symlink";
  if (stat.isFile()) return "file";
  if (stat.isDirectory()) return "directory";
  return "other";
}

function resolvePathLike(rawPath: string, cwd: string): string {
  const stripped = stripQuotes(rawPath.trim());
  if (stripped.startsWith("~")) {
    return path.join(os.homedir(), stripped.slice(1));
  }
  return path.resolve(cwd, stripped);
}

function stripQuotes(value: string): string {
  const fullyQuoted =
    (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
    (value.startsWith("'") && value.endsWith("'") && value.length >= 2);
  return fullyQuoted ? value.slice(1, -1) : value;
}

function normalizeForCompare(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}
