import type { AgentModelReference } from "@agentlink/core";
import type {
  CoreReasoningEffort,
  EmbeddedAgentTurnEvent,
} from "@agentlink/protocol";
import { randomUUID } from "node:crypto";

import type { AssistantServerAuth } from "./assistantServer.js";
import { HttpError } from "./httpJson.js";
import { latestOccurrence, nextOccurrence } from "./jobSchedule.js";
import {
  JobInputError,
  isActiveRun,
  type JobDefinition,
  type JobRun,
  type JobRunStatus,
  type JobStore,
} from "./jobStore.js";
import type { SessionEventHub } from "./SessionEventHub.js";
import type { AssistantSessionOperations } from "./workspaceRoutes.js";

/**
 * Runs scheduled jobs. Each run is a new chat in the job's project: the
 * runner creates the session and starts its turn through the same session
 * operations as the HTTP API, acting as a job principal (the owner, with
 * the job as its device), then follows the session's events to record the
 * outcome. Runs need no browser and never widen authority: a pending
 * approval waits for the owner and expires; nothing is auto-approved.
 */

const DEFAULT_MAX_CONCURRENT_RUNS = 2;
/** Missed occurrences older than this when the server returns are skipped. */
const DEFAULT_CATCH_UP_MS = 6 * 60 * 60 * 1_000;
/** How long a run waits for the owner to answer an approval. */
const DEFAULT_APPROVAL_TIMEOUT_MS = 12 * 60 * 60 * 1_000;
/** Timers re-check at least this often (clock changes, long sleeps). */
const MAX_TIMER_MS = 60 * 60 * 1_000;
/** A scheduled run starting later than this after its time is a catch-up. */
const LATE_RUN_MS = 60_000;
const MAX_SUMMARY_LENGTH = 2_000;

export interface JobRunnerOptions {
  readonly store: JobStore;
  readonly operations: AssistantSessionOperations;
  readonly events: SessionEventHub;
  /** The server's owner, whom every run acts for. */
  readonly ownerId: () => string | undefined;
  /** A configured model by `providerId/modelId`, if it is still available. */
  readonly resolveModel: (key: string) => AgentModelReference | undefined;
  /** The project's chat defaults, used when the job names no model. */
  readonly projectDefaults?: (projectId: string) => {
    readonly model?: AgentModelReference;
    readonly reasoningEffort?: CoreReasoningEffort;
  };
  /**
   * Every change of a run's record. `auth` is the run's principal, for
   * reading its chat.
   */
  readonly onRunChanged?: (change: {
    readonly run: JobRun;
    readonly job: JobDefinition;
    readonly auth: AssistantServerAuth;
  }) => void;
  /** A run a previous process left open, now recorded as interrupted. */
  readonly onRunRecovered?: (change: {
    readonly run: JobRun;
    readonly job: JobDefinition;
  }) => void;
  readonly maxConcurrentRuns?: number;
  readonly catchUpMs?: number;
  readonly approvalTimeoutMs?: number;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
  /**
   * Why a run's chat failed, in words, when the host knows more than the
   * turn's public error code. Read once, when the run ends.
   */
  readonly failureDetail?: (
    projectId: string,
    sessionId: string,
  ) => string | undefined;
  /**
   * While true (the server is draining for an upgrade), schedules wait and
   * queued runs do not start; `runNow` is refused. Call `wake()` after.
   */
  readonly paused?: () => boolean;
}

export interface JobRunner {
  /** Close runs a previous process left open, catch up, start the timer. */
  start(): Promise<void>;
  /**
   * Apply a job's new definition: schedule it, or stop its run and clear
   * its next run when it was paused or deleted.
   */
  jobChanged(jobId: string): Promise<void>;
  /** Stop the job's queued or live run, if any. Call before deleting it. */
  stopJob(jobId: string, reason: string): Promise<void>;
  /** Run a job now; `job_busy` while one of its runs is still going. */
  runNow(jobId: string): Promise<JobRun>;
  /** After a pause: start queued runs and catch up on schedules. */
  wake(): void;
  /** Runs that have started and not finished. */
  activeRuns(): ReadonlyArray<{
    readonly run: JobRun;
    readonly job: JobDefinition;
  }>;
  /** Stop every started run, recorded `interrupted` with `reason`. */
  interruptRuns(reason: string): Promise<JobRun[]>;
  close(): Promise<void>;
}

type TurnResult = Extract<
  EmbeddedAgentTurnEvent,
  { result: unknown }
>["result"];

interface Outcome {
  readonly status: JobRunStatus;
  readonly summary?: string;
  readonly error?: string;
}

interface LiveRun {
  run: JobRun;
  readonly job: JobDefinition;
  readonly controller: AbortController;
  readonly auth: AssistantServerAuth;
  /** Why the runner is stopping this run, once it is. */
  stopping:
    | { readonly reason: string; readonly status: JobRunStatus }
    | undefined;
  readonly finish: (outcome: Outcome) => void;
  readonly outcome: Promise<Outcome>;
  /** Settles once the run's record is final. */
  done: Promise<void> | undefined;
}

export function createJobRunner(options: JobRunnerOptions): JobRunner {
  const { store, operations } = options;
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => undefined);
  const maxConcurrent =
    options.maxConcurrentRuns ?? DEFAULT_MAX_CONCURRENT_RUNS;
  const catchUpMs = options.catchUpMs ?? DEFAULT_CATCH_UP_MS;
  const approvalTimeoutMs =
    options.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
  /** Queued or running, by job: at most one per job. */
  const live = new Map<string, LiveRun>();
  const queue: LiveRun[] = [];
  let running = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let ticking: Promise<void> | undefined;
  let closed = false;

  const save = async (entry: LiveRun, patch: Partial<JobRun>) => {
    entry.run = { ...entry.run, ...patch, updatedAt: now() };
    await store.saveRun(entry.run).catch((error: unknown) => {
      log(`Could not record job run ${entry.run.runId}: ${describe(error)}`);
    });
    try {
      options.onRunChanged?.({
        run: entry.run,
        job: store.get(entry.job.id) ?? entry.job,
        auth: entry.auth,
      });
    } catch {
      // A broken listener must not stop the run.
    }
  };

  /** The owner acting through this job, valid while the job exists. */
  const jobAuth = (
    job: JobDefinition,
    runId: string,
    ownerId: string,
    controller: AbortController,
  ): AssistantServerAuth => {
    const auth: AssistantServerAuth = {
      principal: { tenantId: "agentlink-server", subjectId: ownerId },
      session: {
        ownerId,
        sessionId: `job-run-${runId}`,
        deviceId: `job-${job.id}`,
        deviceLabel: `Job: ${job.name}`,
        createdAt: now(),
        expiresAt: Number.MAX_SAFE_INTEGER,
      },
      signal: controller.signal,
      async revalidate() {
        return {
          valid:
            !controller.signal.aborted &&
            store.get(job.id) !== undefined &&
            options.ownerId() === ownerId,
        };
      },
      detach: () => auth,
    };
    return auth;
  };

  const enqueue = async (
    job: JobDefinition,
    trigger: JobRun["trigger"],
    scheduledFor: number | undefined,
  ): Promise<JobRun> => {
    const runId = randomUUID();
    const created = now();
    const base: JobRun = {
      runId,
      jobId: job.id,
      projectId: job.projectId,
      trigger,
      ...(scheduledFor === undefined ? {} : { scheduledFor }),
      status: "queued",
      createdAt: created,
      updatedAt: created,
    };
    const controller = new AbortController();
    let finish!: (outcome: Outcome) => void;
    const outcome = new Promise<Outcome>((resolve) => {
      finish = resolve;
    });
    const entry: LiveRun = {
      run: base,
      job,
      controller,
      auth: jobAuth(job, runId, options.ownerId() ?? "", controller),
      stopping: undefined,
      finish,
      outcome,
      done: undefined,
    };
    live.set(job.id, entry);
    queue.push(entry);
    await save(entry, {});
    pump();
    return entry.run;
  };

  const skip = async (
    job: JobDefinition,
    reason: "overlap" | "missed",
    scheduledFor: number,
  ) => {
    const at = now();
    await store
      .saveRun({
        runId: randomUUID(),
        jobId: job.id,
        projectId: job.projectId,
        trigger: "schedule",
        scheduledFor,
        status: "skipped",
        error: reason,
        createdAt: at,
        updatedAt: at,
        finishedAt: at,
      })
      .catch(() => undefined);
    log(
      `Skipped job "${job.name}" (${reason === "overlap" ? "its previous run is still going" : "missed while the server was down"})`,
    );
  };

  const paused = options.paused ?? (() => false);

  const pump = () => {
    while (
      !closed &&
      !paused() &&
      running < maxConcurrent &&
      queue.length > 0
    ) {
      const entry = queue.shift()!;
      running += 1;
      entry.done = execute(entry).finally(() => {
        running -= 1;
        if (live.get(entry.job.id) === entry) live.delete(entry.job.id);
        pump();
      });
    }
  };

  const execute = async (entry: LiveRun): Promise<void> => {
    const { job, auth } = entry;
    let unsubscribe: () => void = () => undefined;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    let final: Outcome;
    try {
      if (!options.ownerId()) throw new HttpError(409, "owner_missing");
      await save(entry, {
        status: "running",
        startedAt: now(),
        title: runTitle(job, now()),
      });
      const model = job.model
        ? options.resolveModel(job.model)
        : options.projectDefaults?.(job.projectId).model;
      if (job.model && !model) throw new HttpError(400, "model_not_available");
      const reasoningEffort =
        job.reasoningEffort ??
        (job.model
          ? undefined
          : options.projectDefaults?.(job.projectId).reasoningEffort);
      assertNotStopping(entry);
      const { sessionId } = await operations.createSession(
        auth,
        job.projectId,
        model,
        reasoningEffort,
      );
      await save(entry, { sessionId });
      // A new chat starts autonomous; never wider than the job asks.
      if (job.approvalMode === "ask") {
        await operations.setApprovalMode(auth, job.projectId, sessionId, "ask");
      }
      assertNotStopping(entry);

      const sessionKey = operations.sessionKey(job.projectId, sessionId);
      let result: TurnResult | undefined;
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
            // The owner answered the approval: the run continues.
            if (entry.run.status === "awaiting_approval") {
              if (expiry) clearTimeout(expiry);
              expiry = undefined;
              void save(entry, { status: "running" });
            }
            return;
          }
          if (event.state === "failed") {
            entry.finish({ status: "failed", error: event.error });
            return;
          }
          switch (event.status) {
            case "completed":
              entry.finish({
                status: "completed",
                ...(result?.text ? { summary: summarize(result.text) } : {}),
              });
              return;
            case "suspended":
              void save(entry, { status: "awaiting_approval" });
              if (expiry) clearTimeout(expiry);
              expiry = setTimeout(() => {
                void stop(entry, "approval_expired", "cancelled");
              }, approvalTimeoutMs);
              expiry.unref?.();
              return;
            case "cancelled":
              entry.finish({ status: "cancelled", error: "cancelled" });
              return;
            case "failed":
              entry.finish(classifyFailure(result));
              return;
          }
        },
      );
      unsubscribe = () => subscription.unsubscribe();
      await operations.startTurn(auth, job.projectId, sessionId, job.prompt);
      // Stopped while the turn was starting: its cancel came too early.
      if (entry.stopping && entry.stopping.reason !== "server_stopped") {
        await operations
          .cancel(auth, job.projectId, sessionId)
          .catch(() => undefined);
      }
      final = await entry.outcome;
    } catch (error) {
      final = entry.stopping
        ? { status: entry.stopping.status, error: entry.stopping.reason }
        : { status: "failed", error: errorCode(error) };
    } finally {
      unsubscribe();
      if (expiry) clearTimeout(expiry);
    }
    // Stopping wins over whatever the session reported meanwhile.
    if (entry.stopping) {
      final = { status: entry.stopping.status, error: entry.stopping.reason };
    }
    const runSessionId = entry.run.sessionId;
    const errorDetail =
      runSessionId &&
      (final.status === "failed" ||
        final.status === "blocked_auth" ||
        final.status === "blocked_quota")
        ? options.failureDetail?.(job.projectId, runSessionId)
        : undefined;
    // Free the job before its final record: whoever sees that may run it.
    if (live.get(job.id) === entry) live.delete(job.id);
    await save(entry, {
      status: final.status,
      finishedAt: now(),
      ...(final.summary ? { summary: final.summary } : {}),
      ...(final.error ? { error: final.error } : {}),
      ...(errorDetail ? { errorDetail } : {}),
    });
    entry.controller.abort(new Error("job_run_finished"));
    log(
      `Job "${job.name}" run ${final.status}${final.error ? ` (${final.error})` : ""}${errorDetail ? `: ${errorDetail}` : ""}`,
    );
  };

  const stop = async (
    entry: LiveRun,
    reason: string,
    status: JobRunStatus,
  ): Promise<void> => {
    if (!entry.stopping) {
      entry.stopping = { reason, status };
      const index = queue.indexOf(entry);
      if (index >= 0) {
        // Never started: nothing to cancel.
        queue.splice(index, 1);
        if (live.get(entry.job.id) === entry) live.delete(entry.job.id);
        await save(entry, { status, error: reason, finishedAt: now() });
        entry.controller.abort(new Error(reason));
        return;
      }
      const sessionId = entry.run.sessionId;
      // Closing: the routes stop every turn themselves.
      if (sessionId && reason !== "server_stopped") {
        await operations
          .cancel(entry.auth, entry.job.projectId, sessionId)
          .catch(() => undefined);
      }
      entry.finish({ status, error: reason });
    }
    await entry.done;
  };

  const assertNotStopping = (entry: LiveRun) => {
    if (entry.stopping) throw new HttpError(409, entry.stopping.reason);
  };

  /** Start every job that is due; coalesce missed occurrences into one. */
  const tick = (): Promise<void> => {
    // Cleared in `finally`, which runs after this assignment even when
    // nothing is due and the check finishes without waiting.
    ticking ??= checkDueJobs().finally(() => {
      ticking = undefined;
      arm();
    });
    return ticking;
  };

  const checkDueJobs = async (): Promise<void> => {
    // Due runs wait for `wake()`; one missed for longer than the catch-up
    // window is then recorded missed, as after a restart.
    if (paused()) return;
    try {
      const at = now();
      for (const job of store.list()) {
        if (closed) return;
        if (!job.enabled || job.nextRunAt === undefined) continue;
        if (job.nextRunAt > at) continue;
        const latest =
          latestOccurrence(job.schedule, at, job.scheduledFrom) ??
          job.nextRunAt;
        await store.setNextRunAt(
          job.id,
          nextOccurrence(job.schedule, at, job.scheduledFrom),
        );
        if (at - latest > catchUpMs) {
          await skip(job, "missed", latest);
        } else if (live.has(job.id)) {
          await skip(job, "overlap", latest);
        } else {
          await enqueue(
            job,
            at - job.nextRunAt > LATE_RUN_MS ? "catch_up" : "schedule",
            latest,
          );
        }
      }
    } catch (error) {
      log(`Scheduled jobs check failed: ${describe(error)}`);
    }
  };

  const arm = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (closed || paused()) return;
    let due: number | undefined;
    for (const job of store.list()) {
      if (!job.enabled || job.nextRunAt === undefined) continue;
      if (due === undefined || job.nextRunAt < due) due = job.nextRunAt;
    }
    if (due === undefined) return;
    const delay = Math.min(Math.max(0, due - now()), MAX_TIMER_MS);
    timer = setTimeout(() => void tick(), delay);
    timer.unref?.();
  };

  const schedule = async (job: JobDefinition) => {
    if (job.enabled && job.nextRunAt === undefined) {
      await store.setNextRunAt(
        job.id,
        nextOccurrence(job.schedule, now(), job.scheduledFrom),
      );
    } else if (!job.enabled && job.nextRunAt !== undefined) {
      await store.setNextRunAt(job.id, undefined);
    }
  };

  return {
    async start() {
      const at = now();
      for (const job of store.list()) {
        for (const run of store.runs(job.id)) {
          if (!isActiveRun(run)) continue;
          // Its chat is kept; it is never re-run automatically.
          const interrupted: JobRun = {
            ...run,
            status: "interrupted",
            error: "server_restarted",
            finishedAt: at,
            updatedAt: at,
          };
          await store.saveRun(interrupted);
          try {
            options.onRunRecovered?.({ run: interrupted, job });
          } catch {
            // A broken listener must not stop the start.
          }
        }
        await schedule(job);
      }
      await tick();
    },
    async jobChanged(jobId) {
      const job = store.get(jobId);
      if (!job || !job.enabled) {
        const entry = live.get(jobId);
        if (entry) {
          await stop(entry, job ? "job_paused" : "job_deleted", "cancelled");
        }
      }
      if (job) await schedule(job);
      arm();
    },
    async stopJob(jobId, reason) {
      const entry = live.get(jobId);
      if (entry) await stop(entry, reason, "cancelled");
    },
    async runNow(jobId) {
      if (closed) throw new HttpError(503, "server_closing");
      if (paused()) throw new HttpError(503, "maintenance");
      const job = store.get(jobId);
      if (!job) throw new JobInputError("job_not_found");
      if (live.has(jobId)) throw new JobInputError("job_busy");
      return enqueue(job, "manual", undefined);
    },
    wake() {
      if (closed || paused()) return;
      pump();
      void tick();
    },
    activeRuns() {
      return [...live.values()]
        .filter((entry) => !queue.includes(entry) && !entry.stopping)
        .map((entry) => ({ run: entry.run, job: entry.job }));
    },
    async interruptRuns(reason) {
      const started = [...live.values()].filter(
        (entry) => !queue.includes(entry),
      );
      await Promise.all(
        started.map((entry) => stop(entry, reason, "interrupted")),
      );
      return started.map((entry) => entry.run);
    },
    async close() {
      closed = true;
      if (timer) clearTimeout(timer);
      await ticking;
      await Promise.all(
        [...live.values()].map((entry) =>
          stop(entry, "server_stopped", "interrupted"),
        ),
      );
      await store.flush();
    },
  };
}

/** Provider sign-in and limits are reported as blocked, not failed. */
function classifyFailure(result: TurnResult | undefined): Outcome {
  const error = result?.error;
  if (error?.category === "authentication") {
    return { status: "blocked_auth", error: error.code };
  }
  if (error?.category === "rate_limit" || error?.category === "capacity") {
    return { status: "blocked_quota", error: error.code };
  }
  return { status: "failed", error: error?.code ?? "turn_failed" };
}

function runTitle(job: JobDefinition, at: number): string {
  const timeZone =
    job.schedule.kind === "interval" ? undefined : job.schedule.timeZone;
  const when = new Intl.DateTimeFormat("en-GB", {
    ...(timeZone ? { timeZone } : {}),
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(at);
  return `${job.name} · ${when}`;
}

function summarize(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > MAX_SUMMARY_LENGTH
    ? `${trimmed.slice(0, MAX_SUMMARY_LENGTH - 1)}…`
    : trimmed;
}

function errorCode(error: unknown): string {
  if (error instanceof HttpError || error instanceof JobInputError) {
    return error.code;
  }
  return "run_failed";
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
