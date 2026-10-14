import { promises as fs } from "node:fs";
import path from "node:path";

import {
  GitLaunchError,
  type GitCommand,
  type ProcessRunner,
} from "./gitCommand.js";
import { planRepositories } from "./projectCatalog.js";
import type { TaskRun, ValidationCommandResult } from "./taskStore.js";

/**
 * Task workspaces: one fresh clone per task, at
 * `<tasksRoot>/<taskId>/<repository folder>`, on the task's own branch.
 * Nothing else uses a task's folder: it is mounted as its own hidden
 * project, so the task's file tools cannot reach other tasks or projects.
 *
 * `tasksRoot` is `<projectsRoot>/.tasks`: a project ID cannot start with a
 * dot, so no project created in the app can ever own that folder.
 */

/**
 * Every task commit's author. A task bound to a GitHub connection also
 * credits that connection's person with a `Co-authored-by` trailer.
 */
export const TASK_COMMIT_NAME = "AgentLink Assistant";
export const TASK_COMMIT_EMAIL = "assistant@agentlink.invalid";
/** Holds the `Co-authored-by` trailer the commit hook adds. */
const CO_AUTHOR_FILE = "agentlink-co-author";
/**
 * Adds the trailer to every commit message, including `git commit -m` and
 * `--no-verify` (which skips other hooks, not this one). The trailer is read
 * from a file, so the person's name is never part of the script.
 */
const CO_AUTHOR_HOOK = `#!/bin/sh
# Added by AgentLink Assistant: credits this task's GitHub connection.
trailer_file="$(git rev-parse --git-dir)/${CO_AUTHOR_FILE}"
[ -f "$trailer_file" ] || exit 0
exec git interpret-trailers --in-place --if-exists addIfDifferent \\
  --trailer "$(cat "$trailer_file")" "$1"
`;
const MAX_DETAIL_LENGTH = 2_000;
/** Each validation command's time limit. */
const VALIDATION_TIMEOUT_MS = 20 * 60 * 1_000;
const MAX_VALIDATION_OUTPUT_TAIL = 4_000;
/** Diff given to the reviewer; longer ones are cut, with a note. */
const MAX_DIFF_BYTES = 120 * 1024;

export interface ValidationRun {
  /** Every command exited 0 and none changed tracked files. */
  readonly passed: boolean;
  /** In order, up to and including the first that failed. */
  readonly commands: readonly ValidationCommandResult[];
  /** Tracked files the commands changed, before they were restored. */
  readonly changedFiles?: string;
}

export interface TaskDiff {
  readonly stat: string;
  readonly patch: string;
  readonly truncated: boolean;
}

export class TaskWorkspaceError extends Error {
  constructor(
    readonly code: string,
    readonly detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "TaskWorkspaceError";
  }
}

/** The person a task's commits credit as co-author. */
export interface TaskCoAuthor {
  readonly name: string;
  readonly email: string;
}

/**
 * Writes a git bundle of the base branch to `destination` (the publisher
 * fetching it with a GitHub connection) and names the branch it holds.
 */
export type BaseSnapshot = (
  destination: string,
) => Promise<{ readonly branch: string }>;

export interface PrepareOptions {
  /** Every commit made in the clone credits them. */
  readonly coAuthor?: TaskCoAuthor;
  /**
   * Clone from this instead of the repository URL, so private repositories
   * work without a token reaching the clone.
   */
  readonly snapshot?: BaseSnapshot;
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
  prepare(task: TaskRun, options?: PrepareOptions): Promise<PreparedWorkspace>;
  inspect(task: TaskRun): Promise<WorkspaceInspection>;
  exists(task: TaskRun): Promise<boolean>;
  /**
   * Run validation commands in the clone, in order, stopping at the first
   * failure. The tree was clean and committed before; anything the
   * commands change or leave behind is put back afterwards.
   */
  validate(task: TaskRun, commands: readonly string[]): Promise<ValidationRun>;
  /** `baseCommit..HEAD`, for the reviewer. */
  diff(task: TaskRun): Promise<TaskDiff>;
  /** Delete the task's folder. */
  remove(task: TaskRun): Promise<void>;
}

export function createTaskWorkspaces(options: {
  /** Canonical absolute folder for every task's clone. */
  readonly tasksRoot: string;
  readonly git: GitCommand;
  /** Runs validation commands where commands run. */
  readonly run: ProcessRunner;
  /** Absolute shell there; each command runs as `<shell> -c <command>`. */
  readonly shell: string;
  readonly validationTimeoutMs?: number;
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
    async prepare(task, prepareOptions = {}) {
      const { coAuthor, snapshot } = prepareOptions;
      const folder = taskFolder(task);
      await fs.rm(folder, { recursive: true, force: true });
      await fs.mkdir(tasksRoot, { recursive: true, mode: 0o755 });
      await fs.mkdir(folder, { mode: 0o755 });
      const workspace = task.workspace;
      if (snapshot) {
        // Beside the clone, never inside it, and gone once cloned.
        const bundle = path.join(folder, "base.bundle");
        try {
          const { branch } = await snapshot(bundle);
          await run(
            [
              "clone",
              "--branch",
              branch,
              "--",
              bundle,
              path.basename(workspace),
            ],
            folder,
            "clone_failed",
          );
        } finally {
          await fs.rm(bundle, { force: true });
        }
        // `origin` names the repository, never a token or the bundle.
        await run(
          ["remote", "set-url", "origin", task.repository],
          workspace,
          "config_failed",
        );
      } else {
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
      }
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
      if (coAuthor) {
        const gitDirectory = path.join(workspace, ".git");
        await fs.writeFile(
          path.join(gitDirectory, CO_AUTHOR_FILE),
          `Co-authored-by: ${coAuthor.name} <${coAuthor.email}>\n`,
          { mode: 0o644 },
        );
        await fs.mkdir(path.join(gitDirectory, "hooks"), { recursive: true });
        await fs.writeFile(
          path.join(gitDirectory, "hooks", "prepare-commit-msg"),
          CO_AUTHOR_HOOK,
          { mode: 0o755 },
        );
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
    async validate(task, commands) {
      taskFolder(task);
      const workspace = task.workspace;
      const head = lastLine(
        await run(["rev-parse", "HEAD"], workspace, "workspace_unreadable"),
      );
      const results: ValidationCommandResult[] = [];
      for (const command of commands) {
        let result;
        try {
          result = await options.run({
            executable: options.shell,
            args: ["-c", command],
            cwd: workspace,
            purpose: "task-validation",
            timeoutMs: options.validationTimeoutMs ?? VALIDATION_TIMEOUT_MS,
          });
        } catch (error) {
          if (error instanceof GitLaunchError) {
            throw new TaskWorkspaceError(
              "validation_unavailable",
              error.message,
            );
          }
          throw error;
        }
        results.push({
          command,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          durationMs: result.durationMs,
          outputTail: result.output.slice(-MAX_VALIDATION_OUTPUT_TAIL),
        });
        if (result.exitCode !== 0) break;
      }
      // What the commands changed, then put the clone back as it was.
      const after = lastLine(
        await run(["rev-parse", "HEAD"], workspace, "workspace_unreadable"),
      );
      const status = (
        await run(
          ["status", "--porcelain=v1", "--untracked-files=no"],
          workspace,
          "workspace_unreadable",
        )
      ).trim();
      const changedFiles =
        after !== head
          ? `the commands moved HEAD from ${head} to ${after}`
          : status.slice(0, MAX_DETAIL_LENGTH);
      await run(["reset", "-q", "--hard", head], workspace, "restore_failed");
      // Untracked, not ignored: only what the commands made (it was clean).
      await run(["clean", "-fdq"], workspace, "restore_failed");
      return {
        passed:
          !changedFiles && results.every((result) => result.exitCode === 0),
        commands: results,
        ...(changedFiles ? { changedFiles } : {}),
      };
    },
    async diff(task) {
      taskFolder(task);
      if (!task.baseCommit) throw new TaskWorkspaceError("base_unknown");
      const range = `${task.baseCommit}..HEAD`;
      const stat = await run(
        ["diff", "--stat", range],
        task.workspace,
        "diff_failed",
      );
      let patch;
      try {
        patch = await git({
          args: ["diff", "--no-color", range],
          cwd: task.workspace,
          purpose: "task-workspace",
          maxOutputBytes: MAX_DIFF_BYTES,
          keep: "head",
          streams: "stdout",
        });
      } catch (error) {
        if (error instanceof GitLaunchError) {
          throw new TaskWorkspaceError("git_unavailable", error.message);
        }
        throw error;
      }
      if (patch.exitCode !== 0) {
        throw new TaskWorkspaceError("diff_failed", patch.output.slice(-500));
      }
      return {
        stat: stat.trim(),
        patch: patch.output,
        truncated: patch.truncated,
      };
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
