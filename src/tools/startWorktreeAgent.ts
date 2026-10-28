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
import { parseJsonWithComments } from "@agentlink/protocol/jsonc";
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
  /**
   * The source window's `.code-workspace` file, when one is open. Its
   * settings, tasks, launch and extension recommendations are carried into
   * the generated multi-root worktree workspace. Defaults to
   * `vscode.workspace.workspaceFile`.
   */
  workspaceFile?: vscode.Uri | null;
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

/** One Git repository that receives a worktree for this launch. */
interface RepoWorktreePlan {
  primary: boolean;
  repoRoot: string;
  worktreePath: string;
  baseRef: string;
  dirty: boolean;
  existingTarget?: ParsedWorktree;
  reuseExisting: boolean;
  branchExists: boolean;
}

/** One folder of the generated multi-root workspace. */
interface WorkspaceFolderTarget {
  name: string;
  /** Local folder path (a worktree path, or the original path when shared). */
  path?: string;
  /** Original URI for non-file folders, which are kept as-is. */
  uri?: string;
  /** True when the folder is not inside a Git worktree and points at the source. */
  shared: boolean;
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

    const configurationFor = (uri: vscode.Uri) =>
      deps.configuration ?? vscode.workspace.getConfiguration("agentlink", uri);
    const worktreePath = await resolveWorktreePath({
      requestedPath: params.worktreePath,
      branch,
      repoRoot,
      configuration: configurationFor(sourceWorkspace.folder.uri),
    });

    launchContext.worktreePath = worktreePath;
    const primaryInspection = await inspectRepoWorktree({
      runGit,
      repoRoot,
      gitCommonDir,
      branch,
      worktreePath,
      reviewFetch: Boolean(fetchRef),
    });
    if (primaryInspection.status === "error") {
      return worktreeError(primaryInspection.message, {
        worktreePath,
        branch,
        baseRef: initialBaseRef,
      });
    }
    const primaryPlan: RepoWorktreePlan = {
      ...primaryInspection.plan,
      primary: true,
      baseRef: initialBaseRef,
    };
    launchContext.sourceTreeDirty = primaryPlan.dirty;
    const { existingTarget } = primaryPlan;

    // Multi-root workspaces: every other local folder's repository gets a
    // worktree on the same branch so the new window mirrors the source window.
    const plans: RepoWorktreePlan[] = [primaryPlan];
    const workspaceTargets: WorkspaceFolderTarget[] | undefined =
      (workspaceFolders?.length ?? 0) > 1 ? [] : undefined;
    if (workspaceTargets) {
      const ordered = [
        sourceWorkspace.folder,
        ...(workspaceFolders ?? []).filter(
          (folder) => folder !== sourceWorkspace.folder,
        ),
      ];
      for (const folder of ordered) {
        if (folder.uri.scheme !== "file") {
          workspaceTargets.push({
            name: folder.name,
            uri: folder.uri.toString(),
            shared: true,
          });
          continue;
        }
        const folderPath = await realpathOrResolved(folder.uri.fsPath);
        let folderRepoRoot: string | undefined;
        try {
          folderRepoRoot = await realpathOrResolved(
            (await runGit(["rev-parse", "--show-toplevel"], folderPath)).trim(),
          );
        } catch {
          folderRepoRoot = undefined;
        }
        if (!folderRepoRoot) {
          workspaceTargets.push({
            name: folder.name,
            path: folderPath,
            shared: true,
          });
          continue;
        }

        let plan = plans.find((candidate) =>
          pathsEqual(candidate.repoRoot, folderRepoRoot!),
        );
        if (!plan) {
          const secondaryCommonDir = await realpathOrResolved(
            path.resolve(
              folderRepoRoot,
              (
                await runGit(["rev-parse", "--git-common-dir"], folderRepoRoot)
              ).trim(),
            ),
          );
          const secondaryWorktreePath = await resolveWorktreePath({
            branch,
            repoRoot: folderRepoRoot,
            configuration: configurationFor(folder.uri),
          });
          const inspection = await inspectRepoWorktree({
            runGit,
            repoRoot: folderRepoRoot,
            gitCommonDir: secondaryCommonDir,
            branch,
            worktreePath: secondaryWorktreePath,
            reviewFetch: false,
          });
          if (inspection.status === "error") {
            return worktreeError(
              `${inspection.message} (workspace folder "${folder.name}")`,
              { worktreePath, branch, baseRef: initialBaseRef },
            );
          }
          const secondaryBaseRef = inspection.plan.branchExists
            ? branch
            : (await runGit(["rev-parse", "HEAD"], folderRepoRoot)).trim();
          plan = {
            ...inspection.plan,
            primary: false,
            baseRef: secondaryBaseRef,
          };
          plans.push(plan);
        }
        const relative = path.relative(plan.repoRoot, folderPath);
        workspaceTargets.push({
          name: folder.name,
          path: relative
            ? path.join(plan.worktreePath, relative)
            : plan.worktreePath,
          shared: false,
        });
      }
    }
    const secondaryPlans = plans.filter((plan) => !plan.primary);
    const sharedFolders = (workspaceTargets ?? []).filter(
      (target) => target.shared,
    );

    const approval = await requestWorktreeApproval({
      task,
      prompt,
      autoSubmit,
      sourceRoot,
      worktreePath,
      branch,
      baseRef: initialBaseRef,
      dirty: primaryPlan.dirty,
      existingWorktree: existingTarget,
      additionalRepos: secondaryPlans,
      sharedFolders,
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
        sourceTreeDirty: primaryPlan.dirty,
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
      primaryPlan.baseRef = baseRef;
    }

    await createPlannedWorktrees(runGit, plans, branch);

    let workspaceFilePath: string | undefined;
    if (workspaceTargets) {
      workspaceFilePath = await writeWorktreeWorkspaceFile({
        primaryWorktreePath: worktreePath,
        targets: workspaceTargets,
        sourceWorkspaceFile:
          deps.workspaceFile === undefined
            ? vscode.workspace.workspaceFile
            : deps.workspaceFile,
      });
      launchContext.workspaceFilePath = workspaceFilePath;
    }

    const store =
      deps.intentStore ??
      new WorktreeAgentIntentStore(deps.globalStorageUri.fsPath);
    const intent = await store.writeIntent({
      sourceWorkspacePath: repoRoot,
      worktreePath,
      ...(workspaceFilePath ? { workspaceFilePath } : {}),
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
    await openFolder(vscode.Uri.file(workspaceFilePath ?? worktreePath), {
      forceNewWindow: true,
    });

    const reusedAll = plans.every((plan) => plan.reuseExisting);
    const worktreeNoun = plans.length > 1 ? "worktrees" : "worktree";
    return successResult({
      status: "opened",
      worktreePath,
      branch,
      baseRef,
      intentId: intent.id,
      ...(workspaceFilePath
        ? {
            workspaceFilePath,
            additionalWorktrees: secondaryPlans.map((plan) => ({
              repoRoot: plan.repoRoot,
              worktreePath: plan.worktreePath,
              baseRef: plan.baseRef,
              reused: plan.reuseExisting,
            })),
            ...(sharedFolders.length > 0
              ? {
                  sharedFolders: sharedFolders.map(
                    (target) => target.path ?? target.uri,
                  ),
                }
              : {}),
          }
        : {}),
      message: `${reusedAll ? `Reused existing ${worktreeNoun}` : `Created ${worktreeNoun}`} and opened a new VS Code window${workspaceFilePath ? ` with a multi-root workspace (${workspaceFilePath})` : ""}. Startup intent was written before opening; child-agent startup is best-effort.`,
      ...(approval.followUp ? { follow_up: approval.followUp } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return worktreeError(message, launchContext);
  }
}

async function inspectRepoWorktree(args: {
  runGit: GitRunner;
  repoRoot: string;
  gitCommonDir: string;
  branch: string;
  worktreePath: string;
  /** /review launches require a fresh branch at the fetched PR head. */
  reviewFetch: boolean;
}): Promise<
  | { status: "ok"; plan: Omit<RepoWorktreePlan, "primary" | "baseRef"> }
  | { status: "error"; message: string }
> {
  const { runGit, repoRoot, branch, worktreePath } = args;
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

  if (args.reviewFetch && branchExists) {
    return {
      status: "error",
      message: `Review branch "${branch}" already exists. Run /review again to create a fresh branch for the current pull request head.`,
    };
  }

  if (checkedOutBranch && !pathsEqual(checkedOutBranch.path, worktreePath)) {
    return {
      status: "error",
      message: `Branch "${branch}" is already checked out at ${checkedOutBranch.path}. Choose a different branch or worktreePath.`,
    };
  }

  const reuseExisting = Boolean(
    existingTarget && existingTarget.branch === `refs/heads/${branch}`,
  );
  await validateDestinationPath(worktreePath, repoRoot, args.gitCommonDir, {
    allowExistingWorktree: Boolean(existingTarget),
  });

  if (existingTarget && !reuseExisting) {
    return {
      status: "error",
      message: `Destination path is already a Git worktree for ${existingTarget.branch ?? existingTarget.head ?? "an unknown ref"}, not branch "${branch}".`,
    };
  }

  return {
    status: "ok",
    plan: {
      repoRoot,
      worktreePath,
      dirty: dirtyStatus.length > 0,
      existingTarget,
      reuseExisting,
      branchExists,
    },
  };
}

/**
 * Create every planned worktree. If one fails, worktrees and branches created
 * by this call are removed again so a partial multi-repo launch does not leave
 * stray checkouts behind; reused worktrees are never touched.
 */
async function createPlannedWorktrees(
  runGit: GitRunner,
  plans: RepoWorktreePlan[],
  branch: string,
): Promise<void> {
  const created: RepoWorktreePlan[] = [];
  try {
    for (const plan of plans) {
      if (plan.reuseExisting) continue;
      await fs.mkdir(path.dirname(plan.worktreePath), { recursive: true });
      if (plan.branchExists) {
        await runGit(
          ["worktree", "add", plan.worktreePath, branch],
          plan.repoRoot,
        );
      } else {
        await runGit(
          ["worktree", "add", "-b", branch, plan.worktreePath, plan.baseRef],
          plan.repoRoot,
        );
      }
      created.push(plan);
    }
  } catch (err) {
    for (const plan of created.reverse()) {
      try {
        await runGit(
          ["worktree", "remove", "--force", plan.worktreePath],
          plan.repoRoot,
        );
        if (!plan.branchExists) {
          await runGit(["branch", "-D", branch], plan.repoRoot);
        }
      } catch {
        // Best-effort rollback; the original error is more useful.
      }
    }
    if (created.length > 0 && err instanceof Error) {
      err.message = `${err.message} (rolled back ${created.length} worktree${created.length === 1 ? "" : "s"} created by this launch)`;
    }
    throw err;
  }
}

/**
 * Write a `.code-workspace` file next to the primary worktree that lists every
 * worktree folder (primary first, so the child agent starts in the requested
 * repository), carrying over settings from the source workspace file.
 */
async function writeWorktreeWorkspaceFile(args: {
  primaryWorktreePath: string;
  targets: WorkspaceFolderTarget[];
  sourceWorkspaceFile: vscode.Uri | null | undefined;
}): Promise<string> {
  const carried: Record<string, unknown> = {};
  if (args.sourceWorkspaceFile?.scheme === "file") {
    try {
      const raw = await fs.readFile(args.sourceWorkspaceFile.fsPath, "utf8");
      const parsed = parseJsonWithComments<Record<string, unknown>>(raw);
      for (const key of ["settings", "extensions", "launch", "tasks"]) {
        if (parsed && typeof parsed === "object" && key in parsed) {
          carried[key] = parsed[key];
        }
      }
    } catch {
      // The source workspace file is optional context; ignore unreadable files.
    }
  }

  const workspaceFilePath = path.join(
    path.dirname(args.primaryWorktreePath),
    `${path.basename(args.primaryWorktreePath)}.code-workspace`,
  );
  const content = {
    folders: args.targets.map((target) =>
      target.uri
        ? { name: target.name, uri: target.uri }
        : { name: target.name, path: target.path },
    ),
    ...carried,
  };
  await fs.mkdir(path.dirname(workspaceFilePath), { recursive: true });
  await fs.writeFile(
    workspaceFilePath,
    `${JSON.stringify(content, null, 2)}\n`,
    "utf8",
  );
  return workspaceFilePath;
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
  additionalRepos?: RepoWorktreePlan[];
  sharedFolders?: WorkspaceFolderTarget[];
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
  additionalRepos?: RepoWorktreePlan[];
  sharedFolders?: WorkspaceFolderTarget[];
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
  if (args.additionalRepos?.length) {
    lines.push(
      "",
      "Other workspace repositories (same branch, opened together as a multi-root workspace):",
    );
    for (const repo of args.additionalRepos) {
      const notes = [
        repo.reuseExisting
          ? "reusing existing worktree"
          : repo.branchExists
            ? "existing branch"
            : `base ${repo.baseRef}`,
        ...(repo.dirty ? ["has uncommitted changes, not copied"] : []),
      ];
      lines.push(
        `- ${repo.repoRoot} -> ${repo.worktreePath} (${notes.join("; ")})`,
      );
    }
  }
  if (args.sharedFolders?.length) {
    lines.push(
      "",
      "Workspace folders outside Git are shared with the source window, not isolated:",
      ...args.sharedFolders.map(
        (folder) => `- ${folder.path ?? folder.uri ?? folder.name}`,
      ),
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
