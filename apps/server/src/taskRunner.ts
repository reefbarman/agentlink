import type { AgentModelReference } from "@agentlink/core";
import type { EmbeddedAgentTurnEvent } from "@agentlink/protocol";

import type { AssistantServerAuth } from "./assistantServer.js";
import { HttpError } from "./httpJson.js";
import type { SessionEventHub } from "./SessionEventHub.js";
import {
  TaskInputError,
  isActiveTask,
  isResumableTask,
  newTaskId,
  taskBranchName,
  type TaskRequest,
  type TaskRun,
  type TaskState,
  type TaskStore,
} from "./taskStore.js";
import {
  TaskWorkspaceError,
  type TaskWorkspaces,
  type WorkspaceInspection,
} from "./taskWorkspace.js";
import type { AssistantSessionOperations } from "./workspaceRoutes.js";

/**
 * Runs coding tasks, one at a time. Each task gets a fresh clone on its own
 * branch, mounted as a hidden project, and an implementation chat there
 * that acts for the owner (the task is its device). When the chat finishes
 * the runner itself checks the clone: the work must be committed on the
 * task branch with nothing left over. If not, the chat is told what is
 * wrong and tries again, a bounded number of times.
 *
 * A restart never continues a task by itself: it is recorded interrupted
 * with its clone and chat kept, and the owner resumes it.
 */

const DEFAULT_MAX_CONCURRENT_TASKS = 1;
/** Extra turns to fix a dirty tree or missing commit. */
const DEFAULT_MAX_FOLLOW_UPS = 2;
const DEFAULT_APPROVAL_TIMEOUT_MS = 12 * 60 * 60 * 1_000;
const MAX_SUMMARY_LENGTH = 2_000;
const TASK_PROJECT_PREFIX = "task-";

export interface TaskRunnerOptions {
  readonly store: TaskStore;
  readonly workspaces: TaskWorkspaces;
  readonly operations: AssistantSessionOperations;
  readonly events: SessionEventHub;
  /** Mount or unmount a task's hidden project (idempotent). */
  readonly projects: {
    open(task: TaskRun): Promise<void>;
    close(task: TaskRun): Promise<void>;
  };
  readonly ownerId: () => string | undefined;
  readonly resolveModel: (key: string) => AgentModelReference | undefined;
  readonly onTaskChanged?: (task: TaskRun) => void;
  /** A task a previous process left working, now recorded interrupted. */
  readonly onTaskRecovered?: (task: TaskRun) => void;
  readonly failureDetail?: (
    projectId: string,
    sessionId: string,
  ) => string | undefined;
  readonly maxConcurrentTasks?: number;
  readonly maxFollowUps?: number;
  readonly approvalTimeoutMs?: number;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
}

export interface TaskRunner {
  /** Record tasks a previous process left working as interrupted. */
  start(): Promise<void>;
  create(request: TaskRequest): Promise<TaskRun>;
  /** Stop a queued or working task; it can be resumed. */
  stop(taskId: string): Promise<TaskRun>;
  /** Queue a stopped, failed or interrupted task again. */
  resume(taskId: string): Promise<TaskRun>;
  /** Stop it if needed, then remove its clone, chat mount and record. */
  delete(taskId: string): Promise<void>;
  /** Record working tasks interrupted, keeping their clones. */
  close(): Promise<void>;
}

type TurnResult = Extract<
  EmbeddedAgentTurnEvent,
  { result: unknown }
>["result"];

interface Outcome {
  readonly state: TaskState;
  readonly summary?: string;
  readonly error?: string;
  readonly errorDetail?: string;
}

interface LiveTask {
  task: TaskRun;
  readonly controller: AbortController;
  readonly auth: AssistantServerAuth;
  stopping: { readonly reason: string; readonly state: TaskState } | undefined;
  /** Ends the turn being waited for, if any. */
  endTurn: ((outcome: Outcome) => void) | undefined;
  done: Promise<void> | undefined;
}

export function taskProjectId(taskId: string): string {
  return `${TASK_PROJECT_PREFIX}${taskId}`;
}

export function createTaskRunner(options: TaskRunnerOptions): TaskRunner {
  const { store, workspaces, operations } = options;
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => undefined);
  const maxConcurrent =
    options.maxConcurrentTasks ?? DEFAULT_MAX_CONCURRENT_TASKS;
  const maxFollowUps = options.maxFollowUps ?? DEFAULT_MAX_FOLLOW_UPS;
  const approvalTimeoutMs =
    options.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
  const live = new Map<string, LiveTask>();
  const queue: LiveTask[] = [];
  let running = 0;
  let closed = false;

  const changed = (task: TaskRun) => {
    try {
      options.onTaskChanged?.(task);
    } catch {
      // A broken listener must not stop the task.
    }
  };

  const save = async (entry: LiveTask, patch: Partial<TaskRun>) => {
    entry.task = { ...entry.task, ...patch, updatedAt: now() };
    await store.save(entry.task).catch((error: unknown) => {
      log(`Could not record task ${entry.task.id}: ${describe(error)}`);
    });
    changed(entry.task);
  };

  /** The owner acting through this task, valid while the task exists. */
  const taskAuth = (
    taskId: string,
    ownerId: string,
    controller: AbortController,
  ): AssistantServerAuth => {
    const auth: AssistantServerAuth = {
      principal: { tenantId: "agentlink-server", subjectId: ownerId },
      session: {
        ownerId,
        sessionId: `task-${taskId}-${now()}`,
        deviceId: `task-${taskId}`,
        deviceLabel: `Task ${taskId}`,
        createdAt: now(),
        expiresAt: Number.MAX_SAFE_INTEGER,
      },
      signal: controller.signal,
      async revalidate() {
        return {
          valid:
            !controller.signal.aborted &&
            store.get(taskId) !== undefined &&
            options.ownerId() === ownerId,
        };
      },
      detach: () => auth,
    };
    return auth;
  };

  const enqueue = async (task: TaskRun): Promise<TaskRun> => {
    const controller = new AbortController();
    const entry: LiveTask = {
      task,
      controller,
      auth: taskAuth(task.id, options.ownerId() ?? "", controller),
      stopping: undefined,
      endTurn: undefined,
      done: undefined,
    };
    live.set(task.id, entry);
    queue.push(entry);
    await save(entry, {
      state: "queued",
      error: undefined,
      errorDetail: undefined,
      finishedAt: undefined,
    });
    pump();
    return entry.task;
  };

  const pump = () => {
    while (!closed && running < maxConcurrent && queue.length > 0) {
      const entry = queue.shift()!;
      running += 1;
      entry.done = execute(entry).finally(() => {
        running -= 1;
        if (live.get(entry.task.id) === entry) live.delete(entry.task.id);
        pump();
      });
    }
  };

  const assertNotStopping = (entry: LiveTask) => {
    if (entry.stopping) throw new HttpError(409, entry.stopping.reason);
  };

  /** Send one message to the task's chat and wait for the turn to end. */
  const runTurn = async (
    entry: LiveTask,
    sessionId: string,
    text: string,
  ): Promise<Outcome> => {
    const { projectId } = entry.task;
    const sessionKey = operations.sessionKey(projectId, sessionId);
    let result: TurnResult | undefined;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    const outcome = new Promise<Outcome>((resolve) => {
      entry.endTurn = resolve;
    });
    const subscription = options.events.subscribe(
      sessionKey,
      options.events.latestSequence(sessionKey),
      ({ event }) => {
        if (event.kind === "turn") {
          if ("result" in event.event) result = event.event.result;
          return;
        }
        if (event.kind !== "task" || entry.stopping) return;
        if (event.state === "started") {
          // The owner answered the approval: the task continues.
          if (entry.task.state === "awaiting_approval") {
            if (expiry) clearTimeout(expiry);
            expiry = undefined;
            void save(entry, { state: "implementing" });
          }
          return;
        }
        if (event.state === "failed") {
          entry.endTurn?.({ state: "failed", error: event.error });
          return;
        }
        switch (event.status) {
          case "completed":
            entry.endTurn?.({
              state: "implementing",
              ...(result?.text ? { summary: summarize(result.text) } : {}),
            });
            return;
          case "suspended":
            void save(entry, { state: "awaiting_approval" });
            if (expiry) clearTimeout(expiry);
            expiry = setTimeout(() => {
              void stop(entry, "approval_expired", "cancelled");
            }, approvalTimeoutMs);
            expiry.unref?.();
            return;
          case "cancelled":
            entry.endTurn?.({ state: "cancelled", error: "cancelled" });
            return;
          case "failed":
            entry.endTurn?.(classifyFailure(result));
            return;
        }
      },
    );
    try {
      await save(entry, { attempts: entry.task.attempts + 1 });
      await operations.startTurn(entry.auth, projectId, sessionId, text);
      // Stopped while the turn was starting: its cancel came too early.
      if (entry.stopping && entry.stopping.reason !== "server_stopped") {
        await operations
          .cancel(entry.auth, projectId, sessionId)
          .catch(() => undefined);
      }
      return await outcome;
    } finally {
      subscription.unsubscribe();
      if (expiry) clearTimeout(expiry);
      entry.endTurn = undefined;
    }
  };

  const execute = async (entry: LiveTask): Promise<void> => {
    let final: Outcome;
    try {
      if (!options.ownerId()) throw new HttpError(409, "owner_missing");
      if (entry.task.startedAt === undefined) {
        await save(entry, { startedAt: now() });
      }
      // No base commit yet: the clone was never made, or never finished.
      if (!entry.task.baseCommit || !(await workspaces.exists(entry.task))) {
        await save(entry, {
          state: "preparing",
          sessionId: undefined,
          commits: [],
        });
        const prepared = await workspaces.prepare(entry.task);
        await save(entry, { ...prepared, headCommit: prepared.baseCommit });
      }
      assertNotStopping(entry);
      await options.projects.open(entry.task);
      await save(entry, { state: "implementing" });

      let sessionId = entry.task.sessionId;
      let prompt: string;
      if (sessionId) {
        prompt = resumePrompt(entry.task);
      } else {
        const model = entry.task.model
          ? options.resolveModel(entry.task.model)
          : undefined;
        if (entry.task.model && !model) {
          throw new HttpError(400, "model_not_available");
        }
        // A new chat starts autonomous: protected files still ask.
        ({ sessionId } = await operations.createSession(
          entry.auth,
          entry.task.projectId,
          model,
        ));
        await save(entry, { sessionId });
        prompt = taskPrompt(entry.task);
      }
      assertNotStopping(entry);

      for (let followUps = 0; ; followUps += 1) {
        const outcome = await runTurn(entry, sessionId, prompt);
        if (outcome.state !== "implementing") {
          final = outcome;
          break;
        }
        const inspection = await workspaces.inspect(entry.task);
        await save(entry, {
          headCommit: inspection.head,
          commits: inspection.commits,
          ...(outcome.summary ? { summary: outcome.summary } : {}),
        });
        const problem = workProblem(entry.task, inspection);
        if (!problem) {
          await save(entry, {
            evidence: [
              ...entry.task.evidence,
              { kind: "implementation", commit: inspection.head, at: now() },
            ],
          });
          final = { state: "ready" };
          break;
        }
        if (followUps >= maxFollowUps) {
          final = {
            state: "failed",
            error: problem,
            ...(inspection.status ? { errorDetail: inspection.status } : {}),
          };
          break;
        }
        prompt = followUpPrompt(entry.task, problem, inspection);
      }
    } catch (error) {
      final = entry.stopping
        ? { state: entry.stopping.state, error: entry.stopping.reason }
        : {
            state: "failed",
            error: errorCode(error),
            ...(error instanceof TaskWorkspaceError && error.detail
              ? { errorDetail: error.detail }
              : {}),
          };
    }
    // Stopping wins over whatever the chat reported meanwhile.
    if (entry.stopping) {
      final = { state: entry.stopping.state, error: entry.stopping.reason };
    }
    const sessionId = entry.task.sessionId;
    const errorDetail =
      final.errorDetail ??
      (sessionId &&
      (final.state === "failed" ||
        final.state === "blocked_auth" ||
        final.state === "blocked_quota")
        ? options.failureDetail?.(entry.task.projectId, sessionId)
        : undefined);
    if (live.get(entry.task.id) === entry) live.delete(entry.task.id);
    await save(entry, {
      state: final.state,
      finishedAt: now(),
      error: final.error,
      errorDetail,
    });
    entry.controller.abort(new Error("task_finished"));
    log(
      `Task ${entry.task.id} ${final.state}${final.error ? ` (${final.error})` : ""}${errorDetail ? `: ${errorDetail}` : ""}`,
    );
  };

  const stop = async (
    entry: LiveTask,
    reason: string,
    state: TaskState,
  ): Promise<void> => {
    if (!entry.stopping) {
      entry.stopping = { reason, state };
      const index = queue.indexOf(entry);
      if (index >= 0) {
        // Never started: nothing to cancel.
        queue.splice(index, 1);
        if (live.get(entry.task.id) === entry) live.delete(entry.task.id);
        await save(entry, { state, error: reason, finishedAt: now() });
        entry.controller.abort(new Error(reason));
        return;
      }
      const sessionId = entry.task.sessionId;
      // Closing: the routes stop every turn themselves.
      if (sessionId && reason !== "server_stopped") {
        await operations
          .cancel(entry.auth, entry.task.projectId, sessionId)
          .catch(() => undefined);
      }
      entry.endTurn?.({ state, error: reason });
    }
    await entry.done;
  };

  const requireTask = (taskId: string) => {
    const task = store.get(taskId);
    if (!task) throw new TaskInputError("task_not_found", 404);
    return task;
  };

  return {
    async start() {
      const at = now();
      for (const task of store.list()) {
        if (!isActiveTask(task)) continue;
        const interrupted: TaskRun = {
          ...task,
          state: "interrupted",
          error: "server_restarted",
          finishedAt: at,
          updatedAt: at,
        };
        await store.save(interrupted);
        try {
          options.onTaskRecovered?.(interrupted);
        } catch {
          // A broken listener must not stop the start.
        }
      }
    },
    async create(request) {
      if (closed) throw new HttpError(503, "server_closing");
      const id = newTaskId();
      const at = now();
      const task: TaskRun = {
        ...request,
        id,
        projectId: taskProjectId(id),
        branch: taskBranchName(request.objective, id),
        workspace: workspaces.workspaceFor(id, request.repository),
        state: "queued",
        attempts: 0,
        evidence: [],
        effects: [],
        createdAt: at,
        updatedAt: at,
      };
      await store.create(task);
      return enqueue(task);
    },
    async stop(taskId) {
      requireTask(taskId);
      const entry = live.get(taskId);
      if (entry) await stop(entry, "stopped", "cancelled");
      return requireTask(taskId);
    },
    async resume(taskId) {
      if (closed) throw new HttpError(503, "server_closing");
      const task = requireTask(taskId);
      if (live.has(taskId)) throw new TaskInputError("task_busy", 409);
      if (!isResumableTask(task)) {
        throw new TaskInputError("task_not_resumable", 409);
      }
      return enqueue(task);
    },
    async delete(taskId) {
      const task = requireTask(taskId);
      const entry = live.get(taskId);
      if (entry) await stop(entry, "task_deleted", "cancelled");
      const current = store.get(taskId) ?? task;
      await options.projects.close(current).catch((error: unknown) => {
        log(`Could not close task ${taskId}'s chat: ${describe(error)}`);
      });
      await workspaces.remove(current);
      await store.delete(taskId);
    },
    async close() {
      closed = true;
      await Promise.all(
        [...live.values()].map((entry) =>
          stop(entry, "server_stopped", "interrupted"),
        ),
      );
      await store.flush();
    },
  };
}

/** Why the finished chat's work is not acceptable yet, if it is not. */
function workProblem(
  task: TaskRun,
  inspection: WorkspaceInspection,
): "wrong_branch" | "uncommitted_changes" | "no_commits" | undefined {
  if (inspection.branch !== task.branch) return "wrong_branch";
  if (!inspection.clean) return "uncommitted_changes";
  if (inspection.commits.length === 0) return "no_commits";
  return undefined;
}

export function taskPrompt(task: TaskRun): string {
  return [
    `You are working on a coding task in a fresh clone of ${task.repository}.`,
    "",
    "Objective:",
    task.objective,
    "",
    "Rules:",
    `- Work only in this folder. It is on branch ${task.branch}, made from ${task.resolvedBaseBranch ?? task.baseBranch ?? "the default branch"} at ${task.baseCommit ?? "its latest commit"}.`,
    "- Make the change, then run the project's relevant tests or checks if you can.",
    `- Commit all of your work on ${task.branch} with clear commit messages. Do not create or switch branches, rebase, or push: the owner publishes the result.`,
    "- Finish with no uncommitted or untracked files: commit what belongs to the change and delete scratch files.",
    "- End with a short summary of what changed and how you checked it.",
  ].join("\n");
}

function resumePrompt(task: TaskRun): string {
  return [
    "This task was stopped before it finished and has now been resumed.",
    `Check the current state of the clone (git status, git log ${task.baseCommit ? `${task.baseCommit.slice(0, 12)}..HEAD` : ""}), then continue the objective:`,
    task.objective,
    "",
    `As before: commit everything on ${task.branch}, leave no uncommitted or untracked files, and end with a short summary.`,
  ].join("\n");
}

function followUpPrompt(
  task: TaskRun,
  problem: NonNullable<ReturnType<typeof workProblem>>,
  inspection: WorkspaceInspection,
): string {
  switch (problem) {
    case "wrong_branch":
      return `The task is not finished: the clone is on ${inspection.branch ?? "a detached HEAD"}, not ${task.branch}. Switch back to ${task.branch}, make sure your commits are on it, and leave a clean working tree.`;
    case "uncommitted_changes":
      return [
        "The task is not finished: the working tree has changes that are not committed.",
        "git status:",
        inspection.status,
        "",
        `Commit what belongs to the change on ${task.branch} and delete anything that does not, so git status is clean.`,
      ].join("\n");
    case "no_commits":
      return `The task is not finished: ${task.branch} has no commits beyond the base. Make the change and commit it on ${task.branch}. If you are sure no change is needed, explain why in one paragraph.`;
  }
}

/** Provider sign-in and limits are reported as blocked, not failed. */
function classifyFailure(result: TurnResult | undefined): Outcome {
  const error = result?.error;
  if (error?.category === "authentication") {
    return { state: "blocked_auth", error: error.code };
  }
  if (error?.category === "rate_limit" || error?.category === "capacity") {
    return { state: "blocked_quota", error: error.code };
  }
  return { state: "failed", error: error?.code ?? "turn_failed" };
}

function summarize(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > MAX_SUMMARY_LENGTH
    ? `${trimmed.slice(0, MAX_SUMMARY_LENGTH - 1)}…`
    : trimmed;
}

function errorCode(error: unknown): string {
  if (error instanceof HttpError) return error.code;
  if (error instanceof TaskWorkspaceError) return error.code;
  return "task_failed";
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
