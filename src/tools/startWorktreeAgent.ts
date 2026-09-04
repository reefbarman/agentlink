import * as fs from "fs/promises";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { randomUUID } from "crypto";
import * as vscode from "vscode";

import {
  errorResult,
  successResult,
  type ToolResult,
} from "@agentlink/protocol/tool-result";
import type { OnApprovalRequest } from "@agentlink/protocol/inline-approval";
import type { WorktreeAgentLaunchRequest } from "../core/capabilities/worktree.js";
import { WorktreeAgentIntentStore } from "../worktree/WorktreeAgentIntentStore.js";

const execFileAsync = promisify(execFile);
const DEFAULT_INTENT_TTL_MS = 10 * 60 * 1000;
const SAFE_BRANCH_RE = /^[A-Za-z0-9._/-]+$/;

export interface StartWorktreeAgentParams extends WorktreeAgentLaunchRequest {}

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

interface ResolvedFetchRef {
  remote: string;
  ref: string;
}

export async function handleStartWorktreeAgent(
  params: StartWorktreeAgentParams,
  deps: StartWorktreeAgentDeps,
): Promise<ToolResult> {
  // Populated as launch context resolves so every failure path — including
  // the catch-all for git errors — can report where the launch got to.
  const launchContext: Record<string, unknown> = {};
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
    launchContext.sourceRoot = sourceRoot;
    launchContext.repoRoot = repoRoot;
    const fetchRef = params.fetchRef
      ? await resolveFetchRef(runGit, repoRoot, params.fetchRef)
      : undefined;
    const initialBaseRef =
      params.baseRef?.trim() ||
      (fetchRef
        ? `${fetchRef.remote}:${fetchRef.ref}`
        : (await runGit(["rev-parse", "HEAD"], repoRoot)).trim());
    if (!initialBaseRef)
      return worktreeError(
        "Unable to resolve baseRef from current HEAD.",
        launchContext,
      );
    launchContext.baseRef = initialBaseRef;

    const branch = params.branch?.trim() || generatedBranchName(task);
    validateBranchName(branch);
    launchContext.branch = branch;

    const worktreePath = await resolveWorktreePath({
      requestedPath: params.worktreePath,
      branch,
      repoRoot,
      configuration:
        deps.configuration ??
        vscode.workspace.getConfiguration(
          "agentlink",
          sourceWorkspace.folder.uri,
        ),
    });

    launchContext.worktreePath = worktreePath;
    const dirtyStatus = (
      await runGit(["status", "--porcelain"], repoRoot)
    ).trim();
    launchContext.sourceTreeDirty = dirtyStatus.length > 0;
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

    if (fetchRef && branchExists) {
      return worktreeError(
        `Review branch "${branch}" already exists. Run /review again to create a fresh branch for the current pull request head.`,
        { worktreePath, branch, baseRef: initialBaseRef },
      );
    }

    if (checkedOutBranch && !pathsEqual(checkedOutBranch.path, worktreePath)) {
      return worktreeError(
        `Branch "${branch}" is already checked out at ${checkedOutBranch.path}. Choose a different branch or worktreePath.`,
        { worktreePath, branch, baseRef: initialBaseRef },
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
        { worktreePath, branch, baseRef: initialBaseRef },
      );
    }

    const approval = await requestWorktreeApproval({
      task,
      prompt,
      autoSubmit,
      sourceRoot,
      worktreePath,
      branch,
      baseRef: initialBaseRef,
      dirty: dirtyStatus.length > 0,
      existingWorktree: existingTarget,
      onApprovalRequest: deps.onApprovalRequest,
      sessionId: deps.sessionId,
    });

    if (approval.status === "rejected") {
      return successResult({
        status: "rejected_by_user",
        worktreePath,
        branch,
        baseRef: initialBaseRef,
        sourceRoot,
        repoRoot,
        sourceTreeDirty: dirtyStatus.length > 0,
        decision: approval.decision,
        ...(existingTarget
          ? { existingWorktreeBranch: existingTarget.branch }
          : {}),
        message: approval.message,
        reason: approval.message,
        ...(approval.followUp ? { follow_up: approval.followUp } : {}),
      });
    }

    const finalAutoSubmit = approval.autoSubmit;
    let baseRef = initialBaseRef;
    if (fetchRef) {
      await runGit(["fetch", fetchRef.remote, fetchRef.ref], repoRoot);
      baseRef = (await runGit(["rev-parse", "FETCH_HEAD"], repoRoot)).trim();
      if (!baseRef) {
        throw new Error(
          `Git fetched ${fetchRef.remote}:${fetchRef.ref} but did not resolve FETCH_HEAD.`,
        );
      }
      launchContext.baseRef = baseRef;
    }

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
      ...(params.fleetExchangeId
        ? { fleetExchangeId: params.fleetExchangeId }
        : {}),
      ...(params.commandApprovalPolicy
        ? { commandApprovalPolicy: params.commandApprovalPolicy }
        : {}),
      ...(params.approvalPolicy
        ? { approvalPolicy: params.approvalPolicy }
        : {}),
      ...(params.approvalReviewer
        ? { approvalReviewer: params.approvalReviewer }
        : {}),
      ...(params.executionPreset
        ? { executionPreset: params.executionPreset }
        : {}),
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
      ...(approval.followUp ? { follow_up: approval.followUp } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return worktreeError(message, launchContext);
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

export function findGitRemoteForRepository(
  remoteOutput: string,
  repository: string,
): string | undefined {
  const expected = normalizeRepositoryPath(repository);
  if (!expected) return undefined;

  for (const line of remoteOutput.split(/\r?\n/)) {
    const match = line.trim().match(/^(\S+)\s+(\S+)\s+\(fetch\)$/);
    if (!match) continue;
    const [, remote, remoteUrl] = match;
    if (remote?.startsWith("-")) continue;
    if (normalizeRepositoryPath(remoteUrl!) === expected) return remote;
  }
  return undefined;
}

function normalizeRepositoryPath(value: string): string | undefined {
  const trimmed = value.trim().replace(/\/+$/, "");
  const withoutScheme = trimmed.includes("://")
    ? trimmed.slice(trimmed.indexOf("://") + 3)
    : trimmed;
  const pathPart = withoutScheme.includes(":")
    ? withoutScheme.slice(withoutScheme.lastIndexOf(":") + 1)
    : withoutScheme;
  const segments = pathPart
    .replace(/^\/+/, "")
    .replace(/\.git$/i, "")
    .split("/");
  if (segments.length < 2) return undefined;
  return segments.slice(-2).join("/").toLowerCase();
}

async function resolveFetchRef(
  runGit: GitRunner,
  cwd: string,
  fetchRef: NonNullable<WorktreeAgentLaunchRequest["fetchRef"]>,
): Promise<ResolvedFetchRef> {
  const repository = fetchRef.repository.trim();
  const ref = fetchRef.ref.trim();
  if (!repository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error("Invalid repository for worktree fetch.");
  }
  if (
    !ref.startsWith("refs/pull/") ||
    !/^refs\/pull\/[1-9]\d*\/head$/.test(ref)
  ) {
    throw new Error("Invalid GitHub pull request ref for worktree fetch.");
  }

  const remote = findGitRemoteForRepository(
    await runGit(["remote", "-v"], cwd),
    repository,
  );
  if (!remote) {
    throw new Error(
      `No configured Git remote matches GitHub repository ${repository}. Open that repository or add a matching remote before using /review.`,
    );
  }
  return { remote, ref };
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
  | { status: "approved"; autoSubmit: boolean; followUp?: string }
  | {
      status: "rejected";
      decision: string;
      message: string;
      followUp?: string;
    }
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
        kind: "worktree",
        title: `Start worktree agent: ${args.task}`,
        detail,
        targetPath: args.worktreePath,
        choices,
      },
      args.sessionId,
    );
    const decision = typeof raw === "string" ? raw : raw.decision;
    const rejectionReason =
      typeof raw === "string" ? undefined : raw.rejectionReason;
    const followUp = typeof raw === "string" ? undefined : raw.followUp;
    return approvalDecisionToResult(decision, rejectionReason, followUp);
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
        : selection === "Deny"
          ? "deny"
          : undefined;
  return approvalDecisionToResult(decision);
}

function approvalDecisionToResult(
  decision: string | undefined,
  rejectionReason?: string,
  followUp?: string,
):
  | { status: "approved"; autoSubmit: boolean; followUp?: string }
  | {
      status: "rejected";
      decision: string;
      message: string;
      followUp?: string;
    } {
  const trimmedFollowUp = followUp?.trim() || undefined;
  if (decision === "approve-autosubmit") {
    return { status: "approved", autoSubmit: true, followUp: trimmedFollowUp };
  }
  if (decision === "approve-prefill") {
    return { status: "approved", autoSubmit: false, followUp: trimmedFollowUp };
  }
  if (decision === undefined) {
    return {
      status: "rejected",
      decision: "dismissed",
      message:
        rejectionReason?.trim() ||
        "The worktree approval was dismissed without a selection.",
      followUp: trimmedFollowUp,
    };
  }
  return {
    status: "rejected",
    decision,
    message: rejectionReason?.trim() || "User denied worktree agent startup.",
    followUp: trimmedFollowUp,
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
