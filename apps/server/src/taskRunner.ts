import type { AgentModelReference } from "@agentlink/core";
import type { EmbeddedAgentTurnEvent } from "@agentlink/protocol";

import type { AssistantServerAuth } from "./assistantServer.js";
import { HttpError } from "./httpJson.js";
import type { SessionEventHub } from "./SessionEventHub.js";
import type { RepositorySettingsStore } from "./taskRepositories.js";
import {
  REVIEW_RETRY_PROMPT,
  describeFinding,
  parseReview,
  reviewPrompt,
} from "./taskReview.js";
import {
  TaskInputError,
  evidenceFor,
  isActiveTask,
  isResumableTask,
  newTaskId,
  taskBranchName,
  type ReviewFinding,
  type TaskEvidence,
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
 * the runner itself checks the work, in order:
 *
 * 1. The clone: committed on the task branch with nothing left over. If
 *    not, the chat is told what is wrong (a bounded number of times).
 * 2. Validation: the owner's commands for the repository, run by the server
 *    in the worker against that exact commit.
 * 3. Review: a separate read-only chat on another provider's model reads
 *    `baseCommit..commit` and returns structured findings.
 *
 * Failed validation or blocking findings go back to the implementation
 * chat, for at most `maxFixRounds` rounds. Evidence is bound to the commit
 * it was made for; a new commit needs new evidence.
 *
 * A restart never continues a task by itself: it is recorded interrupted
 * with its clone and chats kept, and the owner resumes it.
 */

const DEFAULT_MAX_CONCURRENT_TASKS = 1;
/** Extra turns to fix a dirty tree or missing commit. */
const DEFAULT_MAX_FOLLOW_UPS = 2;
/** Rounds of fixing failed validation or blocking review findings. */
const DEFAULT_MAX_FIX_ROUNDS = 2;
const DEFAULT_APPROVAL_TIMEOUT_MS = 12 * 60 * 60 * 1_000;
/** Refusals of a reviewer's tool requests before it is stopped. */
const MAX_REVIEW_DENIALS = 10;
const MAX_SUMMARY_LENGTH = 2_000;
const MAX_FEEDBACK_OUTPUT = 3_000;
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
  /** The implementer when a task names no model. */
  readonly defaultModel: AgentModelReference;
  /** A reviewer on another provider than the implementer, if any. */
  readonly reviewModel: (
    implementer: AgentModelReference,
  ) => AgentModelReference | undefined;
  /** The owner's validation commands, per repository. */
  readonly repositories?: Pick<RepositorySettingsStore, "get">;
  readonly onTaskChanged?: (task: TaskRun) => void;
  /** A task a previous process left working, now recorded interrupted. */
  readonly onTaskRecovered?: (task: TaskRun) => void;
  readonly failureDetail?: (
    projectId: string,
    sessionId: string,
  ) => string | undefined;
  readonly maxConcurrentTasks?: number;
  readonly maxFollowUps?: number;
  readonly maxFixRounds?: number;
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
  /** Queue a stopped, failed, blocked or interrupted task again. */
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
  /** The chat's whole final message. */
  readonly text?: string;
  readonly error?: string;
  readonly errorDetail?: string;
  readonly openFindings?: number;
}

interface LiveTask {
  task: TaskRun;
  readonly controller: AbortController;
  readonly auth: AssistantServerAuth;
  stopping: { readonly reason: string; readonly state: TaskState } | undefined;
  /** The chat whose turn is running: implementation or review. */
  activeSessionId: string | undefined;
  /** Ends the turn being waited for, if any. */
  endTurn: ((outcome: Outcome) => void) | undefined;
  done: Promise<void> | undefined;
}

type ValidationEvidence = Extract<TaskEvidence, { kind: "validation" }>;
type ReviewEvidence = Extract<TaskEvidence, { kind: "review" }>;

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
  const maxFixRounds = options.maxFixRounds ?? DEFAULT_MAX_FIX_ROUNDS;
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

  const addEvidence = (entry: LiveTask, evidence: TaskEvidence) =>
    save(entry, { evidence: [...entry.task.evidence, evidence] });

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
      activeSessionId: undefined,
      endTurn: undefined,
      done: undefined,
    };
    live.set(task.id, entry);
    queue.push(entry);
    await save(entry, {
      state: "queued",
      error: undefined,
      errorDetail: undefined,
      openFindings: undefined,
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

  /**
   * Send one message to a chat and wait for its turn to end. In the
   * implementation chat an approval waits for the owner; in a review chat
   * every tool request is refused, so the reviewer cannot change anything.
   */
  const runTurn = async (
    entry: LiveTask,
    sessionId: string,
    text: string,
    role: "implement" | "review",
  ): Promise<Outcome> => {
    const { projectId } = entry.task;
    const workingState = entry.task.state;
    const sessionKey = operations.sessionKey(projectId, sessionId);
    let result: TurnResult | undefined;
    let pending:
      | { readonly interactionId: string; readonly interactionRevision: string }
      | undefined;
    let denials = 0;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    const outcome = new Promise<Outcome>((resolve) => {
      entry.endTurn = resolve;
    });
    const refuse = async () => {
      const interaction = pending;
      pending = undefined;
      denials += 1;
      if (!interaction || denials > MAX_REVIEW_DENIALS) {
        await operations
          .cancel(entry.auth, projectId, sessionId)
          .catch(() => undefined);
        entry.endTurn?.({ state: "failed", error: "reviewer_tried_to_write" });
        return;
      }
      await operations
        .answerInteraction(entry.auth, projectId, sessionId, {
          ...interaction,
          decision: "deny",
        })
        .catch((error: unknown) => {
          entry.endTurn?.({ state: "failed", error: errorCode(error) });
        });
    };
    const subscription = options.events.subscribe(
      sessionKey,
      options.events.latestSequence(sessionKey),
      ({ event }) => {
        if (event.kind === "turn") {
          const turnEvent = event.event;
          if (turnEvent.type === "interaction.required") {
            pending = {
              interactionId: turnEvent.interaction.interactionId,
              interactionRevision: turnEvent.interactionRevision,
            };
          }
          if ("result" in turnEvent) result = turnEvent.result;
          return;
        }
        if (event.kind !== "task" || entry.stopping) return;
        if (event.state === "started") {
          // The owner answered the approval: the task continues.
          if (entry.task.state === "awaiting_approval") {
            if (expiry) clearTimeout(expiry);
            expiry = undefined;
            void save(entry, { state: workingState });
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
              ...(result?.text
                ? { summary: summarize(result.text), text: result.text }
                : {}),
            });
            return;
          case "suspended":
            if (role === "review") {
              void refuse();
              return;
            }
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
      entry.activeSessionId = sessionId;
      if (role === "implement") {
        await save(entry, { attempts: entry.task.attempts + 1 });
      }
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
      entry.activeSessionId = undefined;
    }
  };

  const implementerModel = (task: TaskRun): AgentModelReference => {
    if (!task.model) return options.defaultModel;
    const model = options.resolveModel(task.model);
    if (!model) throw new HttpError(400, "model_not_available");
    return model;
  };

  /** Review the exact commit in a new, read-only chat on another provider. */
  const review = async (
    entry: LiveTask,
    commit: string,
  ): Promise<ReviewEvidence | Outcome> => {
    const model = options.reviewModel(implementerModel(entry.task));
    if (!model) {
      return {
        state: "blocked_review",
        error: "no_reviewer",
        errorDetail:
          "No model from another provider is configured to review this task. Add one (for example Claude through Meridian, as the `review` model role).",
      };
    }
    const diff = await workspaces.diff(entry.task);
    const { projectId } = entry.task;
    const { sessionId } = await operations.createSession(
      entry.auth,
      projectId,
      model,
    );
    await operations.setApprovalMode(entry.auth, projectId, sessionId, "ask");
    assertNotStopping(entry);
    const unavailable = (outcome: Outcome): Outcome => {
      // Read once: the host hands each failure's reason out a single time.
      const detail =
        outcome.errorDetail ?? options.failureDetail?.(projectId, sessionId);
      return {
        state: "blocked_review",
        error: outcome.error ?? "review_failed",
        ...(detail ? { errorDetail: detail } : {}),
      };
    };
    let outcome = await runTurn(
      entry,
      sessionId,
      reviewPrompt(entry.task, diff),
      "review",
    );
    if (outcome.state !== "implementing") return unavailable(outcome);
    let parsed = parseReview(outcome.text);
    if (!parsed) {
      outcome = await runTurn(entry, sessionId, REVIEW_RETRY_PROMPT, "review");
      if (outcome.state !== "implementing") return unavailable(outcome);
      parsed = parseReview(outcome.text);
    }
    if (!parsed) {
      return {
        state: "blocked_review",
        error: "review_unreadable",
        errorDetail: "The reviewer did not return findings in the asked form.",
      };
    }
    return {
      kind: "review",
      commit,
      at: now(),
      model: `${model.providerId}/${model.modelId}`,
      sessionId,
      verdict: parsed.verdict,
      findings: parsed.findings,
    };
  };

  /** Implement, check, validate, review, fix: until ready or stuck. */
  const work = async (
    entry: LiveTask,
    sessionId: string,
    firstPrompt: string | undefined,
  ): Promise<Outcome> => {
    let prompt = firstPrompt;
    let followUps = 0;
    let fixRounds = 0;
    await save(entry, { fixRounds: 0 });
    for (;;) {
      assertNotStopping(entry);
      if (prompt !== undefined) {
        await save(entry, { state: fixRounds > 0 ? "fixing" : "implementing" });
        const outcome = await runTurn(entry, sessionId, prompt, "implement");
        if (outcome.state !== "implementing") return outcome;
        if (outcome.summary) await save(entry, { summary: outcome.summary });
      }
      const inspection = await workspaces.inspect(entry.task);
      await save(entry, {
        headCommit: inspection.head,
        commits: inspection.commits,
      });
      const problem = workProblem(entry.task, inspection);
      if (problem) {
        if (followUps >= maxFollowUps) {
          return {
            state: "failed",
            error: problem,
            ...(inspection.status ? { errorDetail: inspection.status } : {}),
          };
        }
        followUps += 1;
        prompt = followUpPrompt(entry.task, problem, inspection);
        continue;
      }
      const head = inspection.head;
      if (!evidenceFor(entry.task, head).implementation) {
        await addEvidence(entry, {
          kind: "implementation",
          commit: head,
          at: now(),
        });
      }

      const commands =
        options.repositories?.get(entry.task.repository)?.validation ?? [];
      if (commands.length > 0) {
        let validation = evidenceFor(entry.task, head).validation;
        if (!validation || !sameCommands(validation, commands)) {
          await save(entry, { state: "validating" });
          const run = await workspaces.validate(entry.task, commands);
          assertNotStopping(entry);
          validation = { kind: "validation", commit: head, at: now(), ...run };
          await addEvidence(entry, validation);
        }
        if (!validation.passed) {
          if (fixRounds >= maxFixRounds) {
            return {
              state: "failed",
              error: "validation_failed",
              errorDetail: describeValidation(validation).slice(0, 2_000),
            };
          }
          fixRounds += 1;
          await save(entry, { fixRounds });
          prompt = validationFixPrompt(entry.task, validation);
          continue;
        }
      }

      let reviewed = evidenceFor(entry.task, head).review;
      if (!reviewed) {
        await save(entry, { state: "reviewing" });
        const result = await review(entry, head);
        assertNotStopping(entry);
        if (!("kind" in result)) return result;
        reviewed = result;
        await addEvidence(entry, reviewed);
      }
      const blocking = reviewed.findings.filter(
        (finding) => finding.severity === "blocking",
      );
      if (blocking.length > 0 && fixRounds < maxFixRounds) {
        fixRounds += 1;
        await save(entry, { fixRounds });
        prompt = reviewFixPrompt(entry.task, blocking);
        continue;
      }
      return { state: "ready", openFindings: blocking.length };
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
      let prompt: string | undefined;
      if (sessionId) {
        // Resumed: work already accepted at HEAD goes straight to the checks.
        const inspection = await workspaces.inspect(entry.task);
        const accepted =
          !workProblem(entry.task, inspection) &&
          evidenceFor(entry.task, inspection.head).implementation !== undefined;
        prompt = accepted ? undefined : resumePrompt(entry.task);
      } else {
        const model = entry.task.model
          ? implementerModel(entry.task)
          : undefined;
        // A new chat starts autonomous: protected files still ask.
        ({ sessionId } = await operations.createSession(
          entry.auth,
          entry.task.projectId,
          model,
        ));
        await save(entry, { sessionId });
        prompt = taskPrompt(entry.task);
      }
      final = await work(entry, sessionId, prompt);
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
      ...(final.openFindings !== undefined
        ? { openFindings: final.openFindings }
        : {}),
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
      const sessionId = entry.activeSessionId ?? entry.task.sessionId;
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

function sameCommands(
  validation: ValidationEvidence,
  commands: readonly string[],
): boolean {
  // A run that stopped early still ran the first failing command.
  const ran = validation.commands.map((result) => result.command);
  return validation.passed
    ? ran.length === commands.length &&
        ran.every((command, index) => command === commands[index])
    : ran.every((command, index) => command === commands[index]);
}

export function describeValidation(validation: ValidationEvidence): string {
  const lines: string[] = [];
  for (const result of validation.commands) {
    const status = result.timedOut
      ? "timed out"
      : result.exitCode === 0
        ? "passed"
        : `failed (exit ${result.exitCode ?? "signal"})`;
    lines.push(`$ ${result.command} — ${status}`);
    if (result.exitCode !== 0 && result.outputTail.trim()) {
      lines.push(result.outputTail.trim().slice(-MAX_FEEDBACK_OUTPUT));
    }
  }
  if (validation.changedFiles) {
    lines.push(
      `The commands changed tracked files (now put back):\n${validation.changedFiles}`,
    );
  }
  return lines.join("\n");
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
    "- After you finish, the server runs the repository's validation commands and another model reviews your commit; you may be asked to fix what they find.",
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

function validationFixPrompt(
  task: TaskRun,
  validation: ValidationEvidence,
): string {
  return [
    `The server ran the repository's validation commands on commit ${validation.commit.slice(0, 12)} and they did not pass:`,
    "",
    describeValidation(validation),
    "",
    `Fix the cause, run the failing command yourself to check, and commit the fix on ${task.branch}. Leave no uncommitted or untracked files, and end with a short summary.`,
  ].join("\n");
}

function reviewFixPrompt(
  task: TaskRun,
  findings: readonly ReviewFinding[],
): string {
  return [
    "A reviewer on another model read your commit and found problems that block it:",
    "",
    ...findings.map(describeFinding),
    "",
    `Fix each one, or if you are sure a finding is wrong, explain why in your summary. Commit the fixes on ${task.branch}, leave no uncommitted or untracked files, and end with a short summary.`,
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
