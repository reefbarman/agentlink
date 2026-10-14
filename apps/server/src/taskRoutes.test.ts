import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AssistantServerAuth } from "./assistantServer.js";
import { HttpError } from "./httpJson.js";
import { createTaskRoutes } from "./taskRoutes.js";
import type { TaskRunner } from "./taskRunner.js";
import { openTaskStore, type TaskRequest, type TaskRun } from "./taskStore.js";

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

const ID = "aaaaaaaaaaaa";

async function setup(options: { readonly enabled?: boolean } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "task-routes-"));
  cleanup.push(() => fs.rm(dir, { recursive: true, force: true }));
  const store = await openTaskStore({ directory: dir });
  const record = (request: TaskRequest): TaskRun => ({
    ...request,
    id: ID,
    projectId: `task-${ID}`,
    branch: `agentlink/x-${ID}`,
    workspace: `/srv/.tasks/${ID}/demo`,
    state: "queued",
    attempts: 0,
    evidence: [],
    effects: [],
    createdAt: 1,
    updatedAt: 1,
  });
  const runner = {
    start: vi.fn(async () => undefined),
    create: vi.fn(async (request: TaskRequest) =>
      store.create(record(request)),
    ),
    stop: vi.fn(async (taskId: string) => store.get(taskId)!),
    resume: vi.fn(async (taskId: string) => store.get(taskId)!),
    delete: vi.fn(async (taskId: string) => {
      await store.delete(taskId);
    }),
    close: vi.fn(async () => undefined),
  } satisfies TaskRunner;
  const routes = createTaskRoutes({
    store,
    runner: options.enabled === false ? undefined : runner,
    isOwner: (request) => request.principal.subjectId === "owner",
    models: [{ providerId: "codex", modelId: "gpt-5" }],
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
  const call = async (method: string, route: string, body?: unknown) => {
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
    call,
    setCaller(next: AssistantServerAuth) {
      caller = next;
    },
  };
}

const REQUEST = {
  repository: "https://github.com/reefbarman/demo",
  objective: "Fix the clock test",
};

describe("task routes", () => {
  it("starts, lists, reads, stops, resumes and deletes tasks", async () => {
    const test = await setup();
    const created = await test.call("POST", "/api/tasks", {
      ...REQUEST,
      model: "codex/gpt-5",
    });
    expect(created).toMatchObject({ status: 202, body: { task: { id: ID } } });
    expect(test.runner.create).toHaveBeenCalledWith({
      ...REQUEST,
      model: "codex/gpt-5",
    });
    await expect(test.call("GET", "/api/tasks")).resolves.toMatchObject({
      status: 200,
      body: { enabled: true, tasks: [{ id: ID }] },
    });
    await expect(test.call("GET", `/api/tasks/${ID}`)).resolves.toMatchObject({
      status: 200,
      body: { task: { id: ID }, events: [{ state: "queued" }] },
    });
    expect((await test.call("POST", `/api/tasks/${ID}/stop`)).status).toBe(200);
    expect(test.runner.stop).toHaveBeenCalledWith(ID);
    expect((await test.call("POST", `/api/tasks/${ID}/resume`)).status).toBe(
      202,
    );
    expect((await test.call("DELETE", `/api/tasks/${ID}`)).status).toBe(200);
    await expect(test.call("GET", `/api/tasks/${ID}`)).resolves.toMatchObject({
      status: 404,
      body: { error: "task_not_found" },
    });
  });

  it("refuses bad requests, other people and stale sign-ins", async () => {
    const test = await setup();
    await expect(
      test.call("POST", "/api/tasks", { ...REQUEST, model: "codex/other" }),
    ).resolves.toMatchObject({
      status: 400,
      body: { error: "model_not_available" },
    });
    await expect(
      test.call("POST", "/api/tasks", {
        ...REQUEST,
        repository: "http://github.com/a/b",
      }),
    ).resolves.toMatchObject({
      status: 400,
      body: { error: "repository_url_invalid" },
    });
    await expect(
      test.call("GET", "/api/tasks/../../etc"),
    ).resolves.toMatchObject({ status: 404 });
    test.setCaller(auth("owner", false));
    await expect(
      test.call("POST", "/api/tasks", REQUEST),
    ).resolves.toMatchObject({ status: 401 });
    test.setCaller(auth("guest"));
    await expect(test.call("GET", "/api/tasks")).resolves.toMatchObject({
      status: 403,
      body: { error: "tasks_forbidden" },
    });
    expect(test.runner.create).not.toHaveBeenCalled();
  });

  it("lists but does not start tasks without a projects folder", async () => {
    const test = await setup({ enabled: false });
    await expect(test.call("GET", "/api/tasks")).resolves.toMatchObject({
      status: 200,
      body: { enabled: false, tasks: [] },
    });
    await expect(
      test.call("POST", "/api/tasks", REQUEST),
    ).resolves.toMatchObject({
      status: 409,
      body: { error: "tasks_disabled" },
    });
  });
});
