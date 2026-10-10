import type { AgentModelReference } from "@agentlink/core";
import type { EmbeddedAgentTurnEvent } from "@agentlink/protocol";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AssistantServerAuth } from "./assistantServer.js";
import { HttpError } from "./httpJson.js";
import { createJobRunner, type JobRunner } from "./jobRunner.js";
import {
  JobInputError,
  openJobStore,
  type JobFields,
  type JobRun,
  type JobStore,
} from "./jobStore.js";
import { SessionEventHub } from "./SessionEventHub.js";
import type { AssistantSessionOperations } from "./workspaceRoutes.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const START = Date.parse("2026-10-10T00:00:00Z");
const DEFAULT_MODEL: AgentModelReference = {
  providerId: "codex",
  modelId: "gpt-5",
};

const cleanup: Array<() => Promise<void>> = [];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(START);
});
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
  vi.useRealTimers();
});

const FIELDS: JobFields = {
  name: "Morning brief",
  projectId: "home",
  prompt: "Check the news and brief me",
  schedule: { kind: "interval", everyMinutes: 15 },
  enabled: true,
  approvalMode: "autonomous",
};

type TurnStatus = "completed" | "suspended" | "failed" | "cancelled";

function createFakeOperations(events: SessionEventHub) {
  let next = 0;
  const turns: Array<{
    readonly sessionId: string;
    readonly text: string;
    readonly auth: AssistantServerAuth;
  }> = [];
  const requireValid = async (auth: AssistantServerAuth) => {
    if (!(await auth.revalidate()).valid) {
      throw new HttpError(401, "authentication_required");
    }
  };
  const operations = {
    sessionKey: (projectId: string, sessionId: string) =>
      `${projectId}/${sessionId}`,
    createSession: vi.fn(
      async (
        auth: AssistantServerAuth,
        _projectId: string,
        _model?: AgentModelReference,
        _effort?: string,
      ) => {
        await requireValid(auth);
        return { sessionId: `s${(next += 1)}` };
      },
    ),
    setApprovalMode: vi.fn(
      async (
        _auth: AssistantServerAuth,
        _projectId: string,
        _sessionId: string,
        mode: string,
      ) => mode,
    ),
    startTurn: vi.fn(
      async (
        auth: AssistantServerAuth,
        projectId: string,
        sessionId: string,
        text: string,
      ) => {
        await requireValid(auth);
        turns.push({ sessionId, text, auth });
        events.publish(`${projectId}/${sessionId}`, {
          kind: "task",
          state: "started",
          taskId: `t-${sessionId}`,
          operation: "turn",
          actor: {
            subjectId: auth.principal.subjectId,
            deviceId: auth.session.deviceId,
          },
        });
        return { taskId: `t-${sessionId}` };
      },
    ),
    cancel: vi.fn(
      async (
        auth: AssistantServerAuth,
        _projectId: string,
        _sessionId: string,
      ) => {
        await requireValid(auth);
      },
    ),
  };
  /** End the session's current task the way the routes publish it. */
  const endTurn = (
    sessionId: string,
    status: TurnStatus,
    result: Record<string, unknown> = {},
  ) => {
    const key = `home/${sessionId}`;
    events.publish(key, {
      kind: "turn",
      event: {
        schemaVersion: 1,
        sessionId,
        turnId: "turn",
        sequence: 1,
        emittedAt: Date.now(),
        type: `turn.${status}`,
        result: { status, sessionId, turnId: "turn", ...result },
      } as unknown as EmbeddedAgentTurnEvent,
    });
    events.publish(key, {
      kind: "task",
      state: "finished",
      taskId: `t-${sessionId}`,
      status,
    });
  };
  /** The owner answered an approval: a resume task starts. */
  const resume = (sessionId: string) =>
    events.publish(`home/${sessionId}`, {
      kind: "task",
      state: "started",
      taskId: `r-${sessionId}`,
      operation: "resume",
      actor: { subjectId: "owner", deviceId: "phone" },
    });
  return {
    operations: operations as unknown as AssistantSessionOperations,
    calls: operations,
    turns,
    endTurn,
    resume,
  };
}

async function setup(
  options: {
    readonly maxConcurrentRuns?: number;
    readonly prepare?: (store: JobStore) => Promise<void>;
    readonly start?: boolean;
  } = {},
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "job-runner-"));
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
  const store = await openJobStore({ directory: path.join(root, "jobs") });
  await options.prepare?.(store);
  const events = new SessionEventHub();
  const fake = createFakeOperations(events);
  const changes: JobRun[] = [];
  let owner: string | undefined = "owner";
  const runner: JobRunner = createJobRunner({
    store,
    operations: fake.operations,
    events,
    ownerId: () => owner,
    resolveModel: (key) =>
      key === "claude/sonnet"
        ? { providerId: "claude", modelId: "sonnet" }
        : undefined,
    projectDefaults: () => ({ model: DEFAULT_MODEL, reasoningEffort: "low" }),
    onRunChanged: ({ run }) => changes.push(run),
    ...(options.maxConcurrentRuns
      ? { maxConcurrentRuns: options.maxConcurrentRuns }
      : {}),
  });
  cleanup.push(() => runner.close());
  if (options.start !== false) await runner.start();
  const latestRun = (jobId: string) => store.runs(jobId)[0];
  const waitForRun = (jobId: string, status: JobRun["status"]) =>
    vi.waitFor(() => expect(latestRun(jobId)?.status).toBe(status));
  return {
    store,
    runner,
    fake,
    changes,
    latestRun,
    waitForRun,
    setOwner(next: string | undefined) {
      owner = next;
    },
  };
}

async function createJob(
  harness: Awaited<ReturnType<typeof setup>>,
  fields: Partial<JobFields> = {},
) {
  const job = await harness.store.create({ ...FIELDS, ...fields }, Date.now());
  await harness.runner.jobChanged(job.id);
  return harness.store.get(job.id)!;
}

describe("job runner", () => {
  it("runs a due job in a new chat as the job and records its summary", async () => {
    const harness = await setup();
    const job = await createJob(harness);
    expect(job.nextRunAt).toBe(START + 15 * MINUTE);

    await vi.advanceTimersByTimeAsync(15 * MINUTE);
    await vi.waitFor(() => expect(harness.fake.turns).toHaveLength(1));
    const [turn] = harness.fake.turns;
    expect(turn!.text).toBe(FIELDS.prompt);
    expect(turn!.auth.principal.subjectId).toBe("owner");
    expect(turn!.auth.session.deviceLabel).toBe("Job: Morning brief");
    expect(harness.fake.calls.createSession).toHaveBeenCalledWith(
      expect.anything(),
      "home",
      DEFAULT_MODEL,
      "low",
    );
    // Autonomous is the new chat's default: nothing to change.
    expect(harness.fake.calls.setApprovalMode).not.toHaveBeenCalled();
    await harness.waitForRun(job.id, "running");

    harness.fake.endTurn(turn!.sessionId, "completed", {
      text: "  All quiet today.  ",
    });
    await harness.waitForRun(job.id, "completed");
    expect(harness.latestRun(job.id)).toMatchObject({
      trigger: "schedule",
      scheduledFor: START + 15 * MINUTE,
      sessionId: turn!.sessionId,
      summary: "All quiet today.",
      title: expect.stringMatching(/^Morning brief · /u),
    });
    expect(harness.store.get(job.id)!.nextRunAt).toBe(START + 30 * MINUTE);
    // The run's own principal stops working once it has finished.
    expect((await turn!.auth.revalidate()).valid).toBe(false);
    expect(harness.changes.map((run) => run.status)).toEqual(
      expect.arrayContaining(["queued", "running", "completed"]),
    );
  });

  it("uses the job's model and asks before changes when the job does", async () => {
    const harness = await setup();
    const job = await createJob(harness, {
      model: "claude/sonnet",
      approvalMode: "ask",
    });
    await harness.runner.runNow(job.id);
    await vi.waitFor(() => expect(harness.fake.turns).toHaveLength(1));
    expect(harness.fake.calls.createSession).toHaveBeenCalledWith(
      expect.anything(),
      "home",
      { providerId: "claude", modelId: "sonnet" },
      undefined,
    );
    expect(harness.fake.calls.setApprovalMode).toHaveBeenCalledWith(
      expect.anything(),
      "home",
      harness.fake.turns[0]!.sessionId,
      "ask",
    );

    // A model that is no longer configured fails the run, not a fallback.
    const other = await createJob(harness, { model: "gone/model" });
    await harness.runner.runNow(other.id);
    await harness.waitForRun(other.id, "failed");
    expect(harness.latestRun(other.id)!.error).toBe("model_not_available");
  });

  it("runs one run per job and at most two jobs at once", async () => {
    const harness = await setup();
    const jobs = [
      await createJob(harness, { name: "A" }),
      await createJob(harness, { name: "B" }),
      await createJob(harness, { name: "C" }),
    ];
    await vi.advanceTimersByTimeAsync(15 * MINUTE);
    await vi.waitFor(() => expect(harness.fake.turns).toHaveLength(2));
    await harness.waitForRun(jobs[2]!.id, "queued");
    await expect(harness.runner.runNow(jobs[0]!.id)).rejects.toThrow(
      new JobInputError("job_busy"),
    );

    // The next occurrence comes while all three are still going: skipped.
    await vi.advanceTimersByTimeAsync(15 * MINUTE);
    for (const job of jobs) {
      await vi.waitFor(() =>
        expect(harness.latestRun(job.id)).toMatchObject({
          status: "skipped",
          error: "overlap",
        }),
      );
    }
    expect(harness.fake.turns).toHaveLength(2);

    harness.fake.endTurn(harness.fake.turns[0]!.sessionId, "completed");
    await vi.waitFor(() => expect(harness.fake.turns).toHaveLength(3));
    expect(harness.store.runs(jobs[2]!.id)[1]!.status).toBe("running");
  });

  it("waits for the owner's approval, then expires and never approves itself", async () => {
    const harness = await setup();
    const job = await createJob(harness);
    await harness.runner.runNow(job.id);
    await vi.waitFor(() => expect(harness.fake.turns).toHaveLength(1));
    const first = harness.fake.turns[0]!.sessionId;
    harness.fake.endTurn(first, "suspended");
    await harness.waitForRun(job.id, "awaiting_approval");
    harness.fake.resume(first);
    await harness.waitForRun(job.id, "running");
    harness.fake.endTurn(first, "completed", { text: "Done" });
    await harness.waitForRun(job.id, "completed");

    await harness.runner.runNow(job.id);
    await vi.waitFor(() => expect(harness.fake.turns).toHaveLength(2));
    const second = harness.fake.turns[1]!.sessionId;
    harness.fake.endTurn(second, "suspended");
    await harness.waitForRun(job.id, "awaiting_approval");
    await vi.advanceTimersByTimeAsync(11 * HOUR);
    expect(harness.latestRun(job.id)!.status).toBe("awaiting_approval");
    await vi.advanceTimersByTimeAsync(1 * HOUR);
    await harness.waitForRun(job.id, "cancelled");
    expect(harness.latestRun(job.id)!.error).toBe("approval_expired");
    expect(harness.fake.calls.cancel).toHaveBeenCalledWith(
      expect.anything(),
      "home",
      second,
    );
  });

  it("stops a live run when its job is paused or deleted", async () => {
    const harness = await setup();
    const paused = await createJob(harness, { name: "Paused" });
    await harness.runner.runNow(paused.id);
    await vi.waitFor(() => expect(harness.fake.turns).toHaveLength(1));
    await harness.store.update(paused.id, { enabled: false }, Date.now());
    await harness.runner.jobChanged(paused.id);
    expect(harness.latestRun(paused.id)).toMatchObject({
      status: "cancelled",
      error: "job_paused",
    });
    expect(harness.fake.calls.cancel).toHaveBeenCalledTimes(1);
    expect(harness.store.get(paused.id)!.nextRunAt).toBeUndefined();

    const deleted = await createJob(harness, { name: "Deleted" });
    await harness.runner.runNow(deleted.id);
    await vi.waitFor(() => expect(harness.fake.turns).toHaveLength(2));
    const auth = harness.fake.turns[1]!.auth;
    await harness.runner.stopJob(deleted.id, "job_deleted");
    expect(harness.latestRun(deleted.id)).toMatchObject({
      status: "cancelled",
      error: "job_deleted",
    });
    await harness.store.delete(deleted.id);
    await harness.runner.jobChanged(deleted.id);
    expect((await auth.revalidate()).valid).toBe(false);

    // A run still waiting in the queue is cancelled without starting.
    const harnessOne = await setup({ maxConcurrentRuns: 1 });
    const busy = await createJob(harnessOne, { name: "Busy" });
    const waiting = await createJob(harnessOne, { name: "Waiting" });
    await harnessOne.runner.runNow(busy.id);
    await harnessOne.runner.runNow(waiting.id);
    await harnessOne.waitForRun(waiting.id, "queued");
    await harnessOne.store.update(waiting.id, { enabled: false }, Date.now());
    await harnessOne.runner.jobChanged(waiting.id);
    expect(harnessOne.latestRun(waiting.id)).toMatchObject({
      status: "cancelled",
      error: "job_paused",
    });
    expect(harnessOne.fake.turns).toHaveLength(1);
  });

  it("coalesces runs missed while the server was down into one", async () => {
    let recent = "";
    let stale = "";
    const harness = await setup({
      start: false,
      async prepare(store) {
        const scheduledFrom = START - 3 * HOUR;
        vi.setSystemTime(scheduledFrom);
        const interval = await store.create(FIELDS, scheduledFrom);
        // Last scheduled for two hours ago: eight occurrences were missed.
        await store.setNextRunAt(interval.id, START - 2 * HOUR);
        recent = interval.id;
        const daily = await store.create(
          {
            ...FIELDS,
            name: "Daily",
            schedule: { kind: "daily", time: "14:00", timeZone: "UTC" },
          },
          scheduledFrom,
        );
        // Its only missed run was ten hours ago, past the catch-up window.
        await store.setNextRunAt(daily.id, START - 10 * HOUR);
        stale = daily.id;
        vi.setSystemTime(START);
      },
    });
    await harness.runner.start();
    await vi.waitFor(() => expect(harness.fake.turns).toHaveLength(1));
    expect(harness.store.runs(recent)).toEqual([
      expect.objectContaining({
        trigger: "catch_up",
        scheduledFor: START,
      }),
    ]);
    expect(harness.store.get(recent)!.nextRunAt).toBe(START + 15 * MINUTE);
    expect(harness.store.runs(stale)).toEqual([
      expect.objectContaining({ status: "skipped", error: "missed" }),
    ]);
    expect(harness.store.get(stale)!.nextRunAt).toBe(
      Date.parse("2026-10-10T14:00:00Z"),
    );
  });

  it("marks a run the previous process left open as interrupted", async () => {
    let jobId = "";
    const harness = await setup({
      start: false,
      async prepare(store) {
        const job = await store.create(FIELDS, START);
        jobId = job.id;
        await store.saveRun({
          runId: "crashed",
          jobId: job.id,
          projectId: "home",
          trigger: "schedule",
          status: "running",
          sessionId: "old",
          createdAt: START,
          updatedAt: START,
        });
      },
    });
    await harness.runner.start();
    expect(harness.store.run("crashed")).toMatchObject({
      status: "interrupted",
      error: "server_restarted",
      sessionId: "old",
    });
    expect(harness.fake.turns).toHaveLength(0);
    expect(harness.store.get(jobId)!.nextRunAt).toBe(START + 15 * MINUTE);
  });

  it("reports provider sign-in and limits as blocked", async () => {
    const harness = await setup();
    const job = await createJob(harness);
    await harness.runner.runNow(job.id);
    await vi.waitFor(() => expect(harness.fake.turns).toHaveLength(1));
    harness.fake.endTurn(harness.fake.turns[0]!.sessionId, "failed", {
      error: {
        code: "provider_auth_expired",
        category: "authentication",
        message: "Sign in again",
        retryable: false,
      },
    });
    await harness.waitForRun(job.id, "blocked_auth");

    await harness.runner.runNow(job.id);
    await vi.waitFor(() => expect(harness.fake.turns).toHaveLength(2));
    harness.fake.endTurn(harness.fake.turns[1]!.sessionId, "failed", {
      error: {
        code: "usage_limit",
        category: "rate_limit",
        message: "Limit reached",
        retryable: true,
      },
    });
    await harness.waitForRun(job.id, "blocked_quota");
  });

  it("does not run without an owner and records stopped runs as interrupted", async () => {
    const harness = await setup();
    const job = await createJob(harness);
    harness.setOwner(undefined);
    await harness.runner.runNow(job.id);
    await harness.waitForRun(job.id, "failed");
    expect(harness.latestRun(job.id)!.error).toBe("owner_missing");

    harness.setOwner("owner");
    await harness.runner.runNow(job.id);
    await harness.waitForRun(job.id, "running");
    await harness.runner.close();
    expect(harness.latestRun(job.id)).toMatchObject({
      status: "interrupted",
      error: "server_stopped",
    });
    await expect(harness.runner.runNow(job.id)).rejects.toThrow(
      new HttpError(503, "server_closing"),
    );
  });
});
