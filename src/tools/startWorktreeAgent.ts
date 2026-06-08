import * as fs from "fs/promises";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { randomUUID } from "crypto";
import * as vscode from "vscode";

import {
  type OnApprovalRequest,
  type ToolResult,
  successResult,
  errorResult,
} from "../shared/types.js";
import { WorktreeAgentIntentStore } from "../worktree/WorktreeAgentIntentStore.js";

const execFileAsync = promisify(execFile);
const DEFAULT_INTENT_TTL_MS = 10 * 60 * 1000;
const SAFE_BRANCH_RE = /^[A-Za-z0-9._/-]+$/;

export interface StartWorktreeAgentParams {
  task: string;
  prompt: string;
  sourcePath?: string;
  branch?: string;
  baseRef?: string;
  worktreePath?: string;
  mode?: string;
  autoSubmit?: boolean;
}

export interface GitRunner {
  (args: string[], cwd: string): Promise<string>;
}

export interface StartWorktreeAgentDeps {
  globalStorageUri: vscode.Uri;
  onApprovalRequest?: OnApprovalRequest;
  sessionId?: string;
  workspaceFolders?: readonly vscode.WorkspaceFolder[];
  runGit?: GitRunner;
  intentStore?: WorktreeAgentIntentStore;
  openFolder?: (
    uri: vscode.Uri,
    opts: { forceNewWindow: boolean },
  ) => Thenable<unknown>;
  configuration?: vscode.WorkspaceConfiguration;
}

interface ParsedWorktree {
  path: string;
  head?: string;
  branch?: string;
  bare?: boolean;
}

export async function handleStartWorktreeAgent(
  params: StartWorktreeAgentParams,
  deps: StartWorktreeAgentDeps,
): Promise<ToolResult> {
  try {
    const task = normalizeRequired(params.task, "task");
    const prompt = normalizeRequired(params.prompt, "prompt");
    const autoSubmit = params.autoSubmit !== false;
    const mode = params.mode?.trim() || undefined;
    const workspaceFolders =
      deps.workspaceFolders ?? vscode.workspace.workspaceFolders;

    const sourceWorkspace = resolveSourceWorkspace(
      params.sourcePath,
      workspaceFolders,
    );
    if (sourceWorkspace.status === "error") {
      return worktreeError(sourceWorkspace.message);
    }
    if (sourceWorkspace.folder.uri.scheme !== "file") {
      return worktreeError(
        `start_worktree_agent only supports local file workspaces in v1. Workspace "${sourceWorkspace.folder.name}" uses URI scheme "${sourceWorkspace.folder.uri.scheme}".`,
      );
    }

    const runGit = deps.runGit ?? defaultRunGit;
    const sourceRoot = await realpathOrResolved(
      sourceWorkspace.folder.uri.fsPath,
    );
    const repoRoot = await realpathOrResolved(
      (await runGit(["rev-parse", "--show-toplevel"], sourceRoot)).trim(),
    );
    const gitCommonDir = await realpathOrResolved(
      path.resolve(
        repoRoot,
        (await runGit(["rev-parse", "--git-common-dir"], repoRoot)).trim(),
      ),
    );
    const baseRef =
      params.baseRef?.trim() ||
      (await runGit(["rev-parse", "HEAD"], repoRoot)).trim();
    if (!baseRef)
      return worktreeError("Unable to resolve baseRef from current HEAD.");

    const branch = params.branch?.trim() || generatedBranchName(task);
    validateBranchName(branch);

    const worktreePath = await resolveWorktreePath({
      requestedPath: params.worktreePath,
      branch,
      repoRoot,
      configuration:
        deps.configuration ?? vscode.workspace.getConfiguration("agentlink"),
    });

    const dirtyStatus = (
      await runGit(["status", "--porcelain"], repoRoot)
    ).trim();
    const worktrees = parseWorktreeList(
      await runGit(["worktree", "list", "--porcelain"], repoRoot),
    );
    const existingTarget = findWorktreeByPath(worktrees, worktreePath);
    const checkedOutBranch = worktrees.find(
      (wt) => wt.branch === `refs/heads/${branch}`,
    );
    const branchExists = await gitRefExists(
      runGit,
      repoRoot,
      `refs/heads/${branch}`,
    );

    if (checkedOutBranch && !pathsEqual(checkedOutBranch.path, worktreePath)) {
      return worktreeError(
        `Branch "${branch}" is already checked out at ${checkedOutBranch.path}. Choose a different branch or worktreePath.`,
        { worktreePath, branch, baseRef },
      );
    }

    const reuseExisting = Boolean(
      existingTarget && existingTarget.branch === `refs/heads/${branch}`,
    );
    await validateDestinationPath(worktreePath, repoRoot, gitCommonDir, {
      allowExistingWorktree: Boolean(existingTarget),
    });

    if (existingTarget && !reuseExisting) {
      return worktreeError(
        `Destination path is already a Git worktree for ${existingTarget.branch ?? existingTarget.head ?? "an unknown ref"}, not branch "${branch}".`,
        { worktreePath, branch, baseRef },
      );
    }

    const approval = await requestWorktreeApproval({
      task,
      prompt,
      autoSubmit,
      sourceRoot,
      worktreePath,
      branch,
      baseRef,
      dirty: dirtyStatus.length > 0,
      existingWorktree: existingTarget,
      onApprovalRequest: deps.onApprovalRequest,
      sessionId: deps.sessionId,
    });

    if (approval.status === "rejected") {
      return successResult({
        status: "rejected",
        worktreePath,
        branch,
        baseRef,
        message: approval.message,
      });
    }

    const finalAutoSubmit = approval.autoSubmit;

    if (!reuseExisting) {
      await fs.mkdir(path.dirname(worktreePath), { recursive: true });
      if (branchExists) {
        await runGit(["worktree", "add", worktreePath, branch], repoRoot);
      } else {
        await runGit(
          ["worktree", "add", "-b", branch, worktreePath, baseRef],
          repoRoot,
        );
      }
    }

    const store =
      deps.intentStore ??
      new WorktreeAgentIntentStore(deps.globalStorageUri.fsPath);
    const intent = await store.writeIntent({
      sourceWorkspacePath: repoRoot,
      worktreePath,
      branch,
      baseRef,
      task,
      prompt,
      ...(mode ? { mode } : {}),
      autoSubmit: finalAutoSubmit,
      ttlMs: DEFAULT_INTENT_TTL_MS,
    });

    const openFolder =
      deps.openFolder ??
      ((uri, opts) =>
        vscode.commands.executeCommand("vscode.openFolder", uri, opts));
    await openFolder(vscode.Uri.file(worktreePath), { forceNewWindow: true });

    return successResult({
      status: "opened",
      worktreePath,
      branch,
      baseRef,
      intentId: intent.id,
      message: reuseExisting
        ? "Reused existing worktree and opened a new VS Code window. Startup intent was written before opening; child-agent startup is best-effort."
        : "Created worktree and opened a new VS Code window. Startup intent was written before opening; child-agent startup is best-effort.",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return worktreeError(message);
  }
}

function normalizeRequired(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`start_worktree_agent requires a non-empty ${name}.`);
  }
  return value.trim();
}

function resolveSourceWorkspace(
  sourcePath: string | undefined,
  workspaceFolders: readonly vscode.WorkspaceFolder[] | undefined,
):
  | { status: "ok"; folder: vscode.WorkspaceFolder }
  | { status: "error"; message: string } {
  const folders = workspaceFolders ?? [];
  if (folders.length === 0) {
    return { status: "error", message: "No workspace folder is open." };
  }

  if (!sourcePath?.trim()) {
    if (folders.length > 1) {
      return {
        status: "error",
        message:
          "Multiple workspace folders are open. Pass sourcePath to select the repository for start_worktree_agent.",
      };
    }
    return { status: "ok", folder: folders[0] };
  }

  const requested = path.resolve(sourcePath.trim());
  const folder = folders.find((candidate) => {
    if (candidate.uri.scheme === "file") {
      return pathsEqual(path.resolve(candidate.uri.fsPath), requested);
    }
    return (
      candidate.uri.fsPath === sourcePath.trim() ||
      candidate.uri.path === sourcePath.trim()
    );
  });
  if (!folder) {
    return {
      status: "error",
      message: `sourcePath does not match an open local workspace folder: ${sourcePath}`,
    };
  }
  return { status: "ok", folder };
}

async function resolveWorktreePath(args: {
  requestedPath?: string;
  branch: string;
  repoRoot: string;
  configuration: vscode.WorkspaceConfiguration;
}): Promise<string> {
  if (args.requestedPath?.trim()) {
    const raw = args.requestedPath.trim();
    const resolved = path.isAbsolute(raw)
      ? path.resolve(raw)
      : path.resolve(args.repoRoot, raw);
    return realpathParentAware(resolved);
  }

  const suffix = sanitizeDirectorySuffix(
    args.configuration.get<string>("worktreeDirectorySuffix") ?? "-worktrees",
  );
  const repoParent = path.dirname(args.repoRoot);
  const repoName = path.basename(args.repoRoot);
  const branchTail =
    args.branch.split("/").filter(Boolean).at(-1) ?? args.branch;
  const worktreeName = sanitizePathSegment(branchTail) || "workstream";
  return path.join(repoParent, `${repoName}${suffix}`, worktreeName);
}

export function generatedBranchName(task: string, id = randomUUID()): string {
  const slug = sanitizePathSegment(task).slice(0, 48) || "workstream";
  const shortId = id.replace(/-/g, "").slice(0, 8);
  return `agentlink/${slug}-${shortId}`;
}

export function sanitizePathSegment(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/[.-]+$/g, "")
    .slice(0, 80);
}

function sanitizeDirectorySuffix(value: string): string {
  const suffix = value.trim();
  if (!suffix) return "-worktrees";
  return suffix.replace(/[\\/]/g, "-");
}

function validateBranchName(branch: string): void {
  if (!branch || branch.length > 200) {
    throw new Error("Branch name must be between 1 and 200 characters.");
  }
  if (!SAFE_BRANCH_RE.test(branch)) {
    throw new Error(
      "Branch name contains unsupported characters. Use letters, numbers, '.', '_', '-', and '/'.",
    );
  }
  if (
    branch.startsWith("/") ||
    branch.endsWith("/") ||
    branch.includes("//") ||
    branch.includes("..") ||
    branch.endsWith(".") ||
    branch.includes("@{")
  ) {
    throw new Error(`Invalid Git branch name: ${branch}`);
  }
}

export async function validateDestinationPath(
  destination: string,
  repoRoot: string,
  gitCommonDir: string,
  opts: { allowExistingWorktree?: boolean } = {},
): Promise<void> {
  const resolvedDest = path.resolve(destination);
  if (pathsEqual(resolvedDest, repoRoot)) {
    throw new Error(
      "Worktree destination cannot be the current repository root.",
    );
  }
  if (isPathInsideOrEqual(resolvedDest, gitCommonDir)) {
    throw new Error(
      "Worktree destination cannot be inside the repository .git directory.",
    );
  }

  let entries: string[] | null = null;
  try {
    entries = await fs.readdir(resolvedDest);
  } catch (err) {
    if (isNodeError(err) && err.code === "ENOENT") return;
    throw err;
  }
  if (entries.length > 0 && opts.allowExistingWorktree) return;
  if (entries.length > 0) {
    throw new Error(
      "Worktree destination already exists and is non-empty. It can only be reused if it is already the intended Git worktree.",
    );
  }
}

async function gitRefExists(
  runGit: GitRunner,
  cwd: string,
  ref: string,
): Promise<boolean> {
  try {
    await runGit(["show-ref", "--verify", "--quiet", ref], cwd);
    return true;
  } catch {
    return false;
  }
}

export function parseWorktreeList(output: string): ParsedWorktree[] {
  const worktrees: ParsedWorktree[] = [];
  let current: ParsedWorktree | null = null;

  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) {
      if (current) worktrees.push(current);
      current = null;
      continue;
    }
    const [key, ...rest] = line.split(" ");
    const value = rest.join(" ");
    if (key === "worktree") {
      if (current) worktrees.push(current);
      current = { path: value };
    } else if (current && key === "HEAD") {
      current.head = value;
    } else if (current && key === "branch") {
      current.branch = value;
    } else if (current && key === "bare") {
      current.bare = true;
    }
  }
  if (current) worktrees.push(current);
  return worktrees;
}

function findWorktreeByPath(
  worktrees: ParsedWorktree[],
  targetPath: string,
): ParsedWorktree | undefined {
  return worktrees.find((wt) =>
    pathsEqual(path.resolve(wt.path), path.resolve(targetPath)),
  );
}

async function requestWorktreeApproval(args: {
  task: string;
  prompt: string;
  autoSubmit: boolean;
  sourceRoot: string;
  worktreePath: string;
  branch: string;
  baseRef: string;
  dirty: boolean;
  existingWorktree?: ParsedWorktree;
  onApprovalRequest?: OnApprovalRequest;
  sessionId?: string;
}): Promise<
  | { status: "approved"; autoSubmit: boolean }
  | { status: "rejected"; message: string }
> {
  const detail = buildApprovalDetail(args);
  const choices = [
    {
      label: "Approve and autosubmit prompt",
      value: "approve-autosubmit",
      isPrimary: args.autoSubmit,
    },
    {
      label: "Approve, prefill only",
      value: "approve-prefill",
      isPrimary: !args.autoSubmit,
    },
    { label: "Deny", value: "deny", isDanger: true },
  ];

  if (args.onApprovalRequest) {
    const raw = await args.onApprovalRequest(
      {
        kind: "command",
        title: `Start worktree agent: ${args.task}`,
        detail,
        choices,
      },
      args.sessionId,
    );
    const decision = typeof raw === "string" ? raw : raw.decision;
    const rejectionReason =
      typeof raw === "string" ? undefined : raw.rejectionReason;
    return approvalDecisionToResult(decision, rejectionReason);
  }

  const selection = await vscode.window.showWarningMessage(
    `Start worktree agent: ${args.task}`,
    { modal: true, detail },
    "Approve and autosubmit prompt",
    "Approve, prefill only",
    "Deny",
  );
  const decision =
    selection === "Approve and autosubmit prompt"
      ? "approve-autosubmit"
      : selection === "Approve, prefill only"
        ? "approve-prefill"
        : "deny";
  return approvalDecisionToResult(decision);
}

function approvalDecisionToResult(
  decision: string | undefined,
  rejectionReason?: string,
):
  | { status: "approved"; autoSubmit: boolean }
  | { status: "rejected"; message: string } {
  if (decision === "approve-autosubmit") {
    return { status: "approved", autoSubmit: true };
  }
  if (decision === "approve-prefill") {
    return { status: "approved", autoSubmit: false };
  }
  return {
    status: "rejected",
    message: rejectionReason?.trim() || "User denied worktree agent startup.",
  };
}

function buildApprovalDetail(args: {
  prompt: string;
  autoSubmit: boolean;
  sourceRoot: string;
  worktreePath: string;
  branch: string;
  baseRef: string;
  dirty: boolean;
  existingWorktree?: ParsedWorktree;
}): string {
  const lines = [
    `Source: ${args.sourceRoot}`,
    `Destination: ${args.worktreePath}`,
    `Branch: ${args.branch}`,
    `Base ref: ${args.baseRef}`,
    `Autosubmit requested: ${args.autoSubmit ? "yes" : "no"}`,
    "",
    "Initial prompt preview:",
    truncate(args.prompt, 1200),
  ];

  if (args.dirty) {
    lines.push(
      "",
      "Warning: the source worktree has uncommitted changes. They are not copied into the new worktree; the new worktree is based on committed Git state only.",
    );
  }
  if (args.existingWorktree) {
    lines.push(
      "",
      `Existing worktree will be reused: ${args.existingWorktree.path}`,
      `Existing HEAD: ${args.existingWorktree.head ?? "unknown"}`,
      "Warning: the existing worktree HEAD may differ from the requested baseRef.",
    );
  }
  return lines.join("\n");
}

async function defaultRunGit(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
    });
    return stdout;
  } catch (err) {
    const stderr =
      typeof err === "object" && err !== null && "stderr" in err
        ? String((err as { stderr?: unknown }).stderr ?? "").trim()
        : "";
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(stderr || message);
  }
}

async function realpathOrResolved(value: string): Promise<string> {
  const resolved = path.resolve(value);
  try {
    return await fs.realpath(resolved);
  } catch {
    return resolved;
  }
}

async function realpathParentAware(value: string): Promise<string> {
  const resolved = path.resolve(value);
  try {
    return await fs.realpath(resolved);
  } catch {
    const parent = path.dirname(resolved);
    try {
      return path.join(await fs.realpath(parent), path.basename(resolved));
    } catch {
      return resolved;
    }
  }
}

function pathsEqual(a: string, b: string): boolean {
  const left = path.normalize(a);
  const right = path.normalize(b);
  if (process.platform === "win32")
    return left.toLowerCase() === right.toLowerCase();
  return left === right;
}

function isPathInsideOrEqual(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function worktreeError(
  message: string,
  extra?: Record<string, unknown>,
): ToolResult {
  return errorResult(message, { status: "error", ...extra });
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return typeof err === "object" && err !== null && "code" in err;
}
