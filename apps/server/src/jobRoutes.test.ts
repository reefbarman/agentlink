import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AssistantServerAuth } from "./assistantServer.js";
import { HttpError } from "./httpJson.js";
import { createJobRoutes } from "./jobRoutes.js";
import type { JobRunner } from "./jobRunner.js";
import { JobInputError, openJobStore, type JobRun } from "./jobStore.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

const auth = (subjectId: string, valid = true): AssistantServerAuth => {
  const signedIn: AssistantServerAuth = {
    principal: { tenantId: "agentlink-server", subjectId },
    session: {
      ownerId: subjectId,
      sessionId: "s",
      deviceId: "d",
      deviceLabel: "Laptop",
      createdAt: 0,
      expiresAt: Number.MAX_SAFE_INTEGER,
    },
    signal: new AbortController().signal,
    revalidate: async () => ({ valid }),
    detach: () => signedIn,
  };
  return signedIn;
};

async function setup() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "job-routes-"));
  cleanup.push(() =>
    fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
  );
  const store = await openJobStore({ directory: path.join(dir, "jobs") });
  const order: string[] = [];
  const runner = {
    start: vi.fn(async () => undefined),
    jobChanged: vi.fn(async (jobId: string) => {
      order.push(`changed:${jobId}:${store.get(jobId) ? "exists" : "gone"}`);
    }),
    stopJob: vi.fn(async (jobId: string, reason: string) => {
      order.push(`stop:${jobId}:${reason}`);
    }),
    runNow: vi.fn(async (jobId: string): Promise<JobRun> => {
      if (store.runs(jobId).some((run) => run.status === "running")) {
        throw new JobInputError("job_busy");
      }
      const run: JobRun = {
        runId: "r1",
        jobId,
        projectId: "home",
        trigger: "manual",
        status: "running",
        createdAt: 1,
        updatedAt: 1,
      };
      await store.saveRun(run);
      return run;
    }),
    wake: vi.fn(() => undefined),
    activeRuns: vi.fn(() => []),
    interruptRuns: vi.fn(async () => []),
    close: vi.fn(async () => undefined),
  } satisfies JobRunner;
  const routes = createJobRoutes({
    store,
    runner,
    isOwner: (request) => request.principal.subjectId === "owner",
    hasProject: (projectId) => projectId === "home",
    models: [
      { providerId: "codex", modelId: "gpt-5", reasoningEfforts: ["low"] },
      { providerId: "local", modelId: "fixture" },
    ],
    defaultTimeZone: "Australia/Sydney",
    now: () => 1_000,
  });
  let caller = auth("owner");
  const server = http.createServer((request, response) => {
    routes
      .handleRequest(request, response, caller)
      .then((handled) => {
        if (!handled) {
          response.writeHead(404);
          response.end("{}");
        }
      })
      .catch((error: unknown) => {
        response.writeHead(error instanceof HttpError ? error.status : 500, {
          "content-type": "application/json",
        });
        response.end(
          JSON.stringify({
            error: error instanceof HttpError ? error.code : String(error),
          }),
        );
      });
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const port = (server.address() as { port: number }).port;
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const call = async (
    method: string,
    route: string,
    body?: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {
      status: response.status,
      body: (await response.json()) as Record<string, unknown>,
    };
  };
  return {
    store,
    runner,
    order,
    call,
    setCaller(next: AssistantServerAuth) {
      caller = next;
    },
  };
}

const BRIEF = {
  name: "Morning brief",
  projectId: "home",
  prompt: "Brief me",
  schedule: { kind: "daily", time: "07:30" },
};

describe("job routes", () => {
  it("creates, lists, changes, runs and deletes jobs", async () => {
    const harness = await setup();
    const created = await harness.call("POST", "/api/jobs", {
      ...BRIEF,
      model: "codex/gpt-5",
      reasoningEffort: "low",
    });
    expect(created.status).toBe(201);
    const job = created.body.job as { id: string; schedule: unknown };
    expect(job.schedule).toEqual({
      kind: "daily",
      time: "07:30",
      timeZone: "Australia/Sydney",
    });
    expect(harness.runner.jobChanged).toHaveBeenCalledWith(job.id);

    const paused = await harness.call("PATCH", `/api/jobs/${job.id}`, {
      enabled: false,
      model: null,
    });
    expect(paused.status).toBe(200);
    expect(paused.body.job).toMatchObject({ enabled: false });
    expect(paused.body.job).not.toHaveProperty("model");

    const ran = await harness.call("POST", `/api/jobs/${job.id}/run`);
    expect(ran).toMatchObject({ status: 202, body: { run: { runId: "r1" } } });
    await expect(
      harness.call("POST", `/api/jobs/${job.id}/run`),
    ).resolves.toMatchObject({ status: 409, body: { error: "job_busy" } });
    await expect(
      harness.call("GET", `/api/jobs/${job.id}/runs`),
    ).resolves.toMatchObject({ body: { runs: [{ runId: "r1" }] } });
    const listed = await harness.call("GET", "/api/jobs");
    expect(listed.body.jobs).toEqual([
      expect.objectContaining({
        id: job.id,
        lastRun: expect.objectContaining({ runId: "r1" }),
        activeRun: expect.objectContaining({ runId: "r1" }),
      }),
    ]);

    // The live run stops while the job still exists, then it goes.
    await expect(
      harness.call("DELETE", `/api/jobs/${job.id}`),
    ).resolves.toMatchObject({ status: 200 });
    expect(harness.order.slice(-2)).toEqual([
      `stop:${job.id}:job_deleted`,
      `changed:${job.id}:gone`,
    ]);
    await expect(
      harness.call("GET", `/api/jobs/${job.id}`),
    ).resolves.toMatchObject({ status: 404, body: { error: "job_not_found" } });
  });

  it("refuses jobs for unknown projects, models and thinking levels", async () => {
    const harness = await setup();
    const fails = async (body: Record<string, unknown>, error: string) =>
      expect(
        harness.call("POST", "/api/jobs", { ...BRIEF, ...body }),
      ).resolves.toMatchObject({ status: 400, body: { error } });
    await fails({ projectId: "work" }, "project_not_found");
    await fails({ model: "codex/gpt-9" }, "model_not_available");
    await fails(
      { model: "local/fixture", reasoningEffort: "low" },
      "reasoning_effort_not_available",
    );
    await fails(
      { schedule: { kind: "interval", everyMinutes: 5 } },
      "schedule_interval_invalid",
    );
    await fails({ owner: "x" }, "job_field_unknown");
    expect(harness.store.list()).toEqual([]);
  });

  it("is for the owner only, with a current sign-in", async () => {
    const harness = await setup();
    harness.setCaller(auth("someone-else"));
    await expect(harness.call("GET", "/api/jobs")).resolves.toMatchObject({
      status: 403,
      body: { error: "jobs_forbidden" },
    });
    harness.setCaller(auth("owner", false));
    await expect(
      harness.call("POST", "/api/jobs", BRIEF),
    ).resolves.toMatchObject({
      status: 401,
      body: { error: "authentication_required" },
    });
    expect(harness.store.list()).toEqual([]);
    harness.setCaller(auth("owner"));
    await expect(harness.call("PUT", "/api/jobs")).resolves.toMatchObject({
      status: 405,
    });
    await expect(
      harness.call("GET", "/api/jobs/not-a-job/runs"),
    ).resolves.toMatchObject({ status: 404 });
  });
});
