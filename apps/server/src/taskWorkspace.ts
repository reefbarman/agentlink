import { promises as fs } from "node:fs";
import path from "node:path";

import { GitLaunchError, type GitCommand } from "./gitCommand.js";
import { planRepositories } from "./projectCatalog.js";
import type { TaskRun } from "./taskStore.js";

/**
 * Task workspaces: one fresh clone per task, at
 * `<tasksRoot>/<taskId>/<repository folder>`, on the task's own branch.
 * Nothing else uses a task's folder: it is mounted as its own hidden
 * project, so the task's file tools cannot reach other tasks or projects.
 *
 * `tasksRoot` is `<projectsRoot>/.tasks`: a project ID cannot start with a
 * dot, so no project created in the app can ever own that folder.
 */

/** Commits until slice C binds tasks to a GitHub connection's identity. */
export const TASK_COMMIT_NAME = "AgentLink Assistant";
export const TASK_COMMIT_EMAIL = "assistant@agentlink.invalid";
const MAX_DETAIL_LENGTH = 2_000;

export class TaskWorkspaceError extends Error {
  constructor(
    readonly code: string,
    readonly detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "TaskWorkspaceError";
  }
}

export interface PreparedWorkspace {
  readonly baseCommit: string;
  readonly resolvedBaseBranch: string;
}

export interface WorkspaceInspection {
  /** The checked-out branch; undefined when HEAD is detached. */
  readonly branch: string | undefined;
  readonly head: string;
  /** No staged, unstaged or untracked change. */
  readonly clean: boolean;
  /** `git status --short`, shortened, when not clean. */
  readonly status: string;
  /** `baseCommit..head`, oldest first. */
  readonly commits: readonly string[];
}

export interface TaskWorkspaces {
  /** Where a new task's clone goes. */
  workspaceFor(taskId: string, repository: string): string;
  /** Fresh clone at the base on the task branch; replaces any earlier try. */
  prepare(task: TaskRun): Promise<PreparedWorkspace>;
  inspect(task: TaskRun): Promise<WorkspaceInspection>;
  exists(task: TaskRun): Promise<boolean>;
  /** Delete the task's folder. */
  remove(task: TaskRun): Promise<void>;
}

export function createTaskWorkspaces(options: {
  /** Canonical absolute folder for every task's clone. */
  readonly tasksRoot: string;
  readonly git: GitCommand;
}): TaskWorkspaces {
  const { tasksRoot, git } = options;

  /** The task's own folder, after checking the record points inside it. */
  const taskFolder = (task: Pick<TaskRun, "id" | "workspace">) => {
    const folder = path.join(tasksRoot, task.id);
    if (path.dirname(task.workspace) !== folder) {
      throw new TaskWorkspaceError("workspace_invalid");
    }
    return folder;
  };

  const run = async (
    args: readonly string[],
    cwd: string,
    code: string,
  ): Promise<string> => {
    let result;
    try {
      result = await git({ args, cwd, purpose: "task-workspace" });
    } catch (error) {
      if (error instanceof GitLaunchError) {
        throw new TaskWorkspaceError("git_unavailable", error.message);
      }
      throw error;
    }
    if (result.exitCode !== 0) {
      throw new TaskWorkspaceError(
        code,
        result.output.trim().slice(-MAX_DETAIL_LENGTH) ||
          (result.signal ? `git stopped (${result.signal})` : undefined),
      );
    }
    return result.output;
  };

  return {
    workspaceFor(taskId, repository) {
      const [planned] = planRepositories([repository]);
      return path.join(tasksRoot, taskId, planned!.directory);
    },
    async prepare(task) {
      const folder = taskFolder(task);
      await fs.rm(folder, { recursive: true, force: true });
      await fs.mkdir(tasksRoot, { recursive: true, mode: 0o755 });
      await fs.mkdir(folder, { mode: 0o755 });
      const workspace = task.workspace;
      await run(
        [
          "clone",
          ...(task.baseBranch ? ["--branch", task.baseBranch] : []),
          "--",
          task.repository,
          path.basename(workspace),
        ],
        folder,
        "clone_failed",
      );
      const baseCommit = lastLine(
        await run(["rev-parse", "HEAD"], workspace, "base_unreadable"),
      );
      const branch = lastLine(
        await run(
          ["rev-parse", "--abbrev-ref", "HEAD"],
          workspace,
          "base_unreadable",
        ),
      );
      await run(
        ["checkout", "-q", "-b", task.branch],
        workspace,
        "branch_failed",
      );
      for (const [key, value] of [
        ["user.name", TASK_COMMIT_NAME],
        ["user.email", TASK_COMMIT_EMAIL],
      ] as const) {
        await run(["config", key, value], workspace, "config_failed");
      }
      return {
        baseCommit,
        // `HEAD` when the base was a tag: the name asked for is the base.
        resolvedBaseBranch:
          branch && branch !== "HEAD" ? branch : (task.baseBranch ?? "HEAD"),
      };
    },
    async inspect(task) {
      taskFolder(task);
      const workspace = task.workspace;
      const head = lastLine(
        await run(["rev-parse", "HEAD"], workspace, "workspace_unreadable"),
      );
      const branch = lastLine(
        await run(
          ["rev-parse", "--abbrev-ref", "HEAD"],
          workspace,
          "workspace_unreadable",
        ),
      );
      const status = await run(
        ["status", "--porcelain=v1", "--untracked-files=all"],
        workspace,
        "workspace_unreadable",
      );
      const commits = task.baseCommit
        ? (
            await run(
              ["rev-list", "--reverse", `${task.baseCommit}..HEAD`],
              workspace,
              "workspace_unreadable",
            )
          )
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean)
        : [];
      return {
        branch: branch === "HEAD" ? undefined : branch,
        head,
        clean: status.trim() === "",
        status: status.trim().slice(0, MAX_DETAIL_LENGTH),
        commits,
      };
    },
    async exists(task) {
      try {
        taskFolder(task);
        return (await fs.stat(task.workspace)).isDirectory();
      } catch {
        return false;
      }
    },
    async remove(task) {
      await fs.rm(taskFolder(task), { recursive: true, force: true });
    },
  };
}

/** git output is stdout and stderr together: a value is its last line. */
function lastLine(output: string): string {
  return (
    output
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1) ?? ""
  );
}
