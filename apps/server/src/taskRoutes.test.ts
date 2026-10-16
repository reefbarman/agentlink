import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AssistantServerAuth } from "./assistantServer.js";
import { HttpError } from "./httpJson.js";
import { createTaskRoutes } from "./taskRoutes.js";
import type { TaskRunner } from "./taskRunner.js";
import { openRepositorySettings } from "./taskRepositories.js";
import { openGitHubConnections } from "./githubConnections.js";
import { openTaskStore, type TaskRequest, type TaskRun } from "./taskStore.js";
import { auditedTaskStore, openTaskAudit } from "./taskAudit.js";

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
  const audit = await openTaskAudit({ directory: path.join(dir, "audit") });
  const store = auditedTaskStore(
    await openTaskStore({ directory: dir }),
    audit,
  );
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
    continueTask: vi.fn(async (taskId: string) => store.get(taskId)!),
    steer: vi.fn(async (taskId: string) => store.get(taskId)!),
    publish: vi.fn(
      async (taskId: string, _options?: { allowUnreviewed?: boolean }) =>
        store.get(taskId)!,
    ),
    delete: vi.fn(async (taskId: string) => {
      await store.delete(taskId);
    }),
    wake: vi.fn(() => undefined),
    workingTasks: vi.fn(() => []),
    interruptWorking: vi.fn(async () => []),
    close: vi.fn(async () => undefined),
  } satisfies TaskRunner;
  const repositories = await openRepositorySettings({
    file: path.join(dir, "repositories.json"),
  });
  const connections = await openGitHubConnections({
    file: path.join(dir, "connections.json"),
  });
  const routes = createTaskRoutes({
    store,
    repositories,
    connections,
    runner: options.enabled === false ? undefined : runner,
    audit,
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
    audit,
    runner,
    connections,
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

  it("keeps validation commands per repository", async () => {
    const test = await setup();
    await expect(
      test.call("PUT", "/api/tasks/repositories", {
        repository: "https://GitHub.com/reefbarman/Demo.git",
        validation: [" npm ci ", "npm test"],
      }),
    ).resolves.toMatchObject({
      status: 200,
      body: {
        repository: {
          repository: "https://github.com/reefbarman/demo",
          validation: ["npm ci", "npm test"],
        },
      },
    });
    await expect(
      test.call("GET", "/api/tasks/repositories"),
    ).resolves.toMatchObject({
      body: { repositories: [{ validation: ["npm ci", "npm test"] }] },
    });
    // Any spelling of the same repository finds them.
    await test.call("POST", "/api/tasks", {
      ...REQUEST,
      repository: "https://github.com/reefbarman/demo/",
    });
    await expect(test.call("GET", `/api/tasks/${ID}`)).resolves.toMatchObject({
      body: { validation: ["npm ci", "npm test"] },
    });
    await expect(
      test.call("PUT", "/api/tasks/repositories", {
        repository: "https://github.com/reefbarman/demo",
        validation: ["x".repeat(1_001)],
      }),
    ).resolves.toMatchObject({
      status: 400,
      body: { error: "validation_command_invalid" },
    });
    // No commands clears them.
    await expect(
      test.call("PUT", "/api/tasks/repositories", {
        repository: "https://github.com/reefbarman/demo",
        validation: [],
      }),
    ).resolves.toMatchObject({ status: 200, body: { repository: null } });
  });

  it("grants and revokes a repository's permission to publish", async () => {
    const test = await setup();
    const connection = await test.connections.create(
      "app",
      { commitName: "Tristan", commitEmail: "tristan@example.com" },
      1,
    );
    await expect(
      test.call("PUT", "/api/tasks/repositories", {
        repository: "https://github.com/reefbarman/demo",
        connectionId: "ffffffffffff",
      }),
    ).resolves.toMatchObject({
      status: 400,
      body: { error: "connection_not_found" },
    });
    await expect(
      test.call("PUT", "/api/tasks/repositories", {
        repository: "https://gitlab.com/reefbarman/demo",
        connectionId: connection.id,
      }),
    ).resolves.toMatchObject({
      status: 400,
      body: { error: "repository_not_github" },
    });
    await test.call("PUT", "/api/tasks/repositories", {
      repository: "https://github.com/reefbarman/demo",
      validation: ["npm test"],
    });
    // Granting keeps the validation commands, and the reverse.
    await expect(
      test.call("PUT", "/api/tasks/repositories", {
        repository: "https://github.com/reefbarman/demo",
        connectionId: connection.id,
      }),
    ).resolves.toMatchObject({
      status: 200,
      body: {
        repository: {
          validation: ["npm test"],
          publish: { connectionId: connection.id },
        },
      },
    });
    await expect(
      test.call("PUT", "/api/tasks/repositories", {
        repository: "https://github.com/reefbarman/demo",
        validation: [],
      }),
    ).resolves.toMatchObject({
      body: {
        repository: {
          validation: [],
          publish: { connectionId: connection.id },
        },
      },
    });
    await expect(
      test.call("PUT", "/api/tasks/repositories", {
        repository: "https://github.com/reefbarman/demo",
        connectionId: null,
      }),
    ).resolves.toMatchObject({ status: 200, body: { repository: null } });
    await expect(
      test.call("PUT", "/api/tasks/repositories", {
        repository: "https://github.com/reefbarman/demo",
      }),
    ).resolves.toMatchObject({
      status: 400,
      body: { error: "repository_change_required" },
    });
  });

  it("publishes through the runner, only with known options", async () => {
    const test = await setup();
    await test.call("POST", "/api/tasks", REQUEST);
    await expect(
      test.call("POST", `/api/tasks/${ID}/publish`, { allowUnreviewed: true }),
    ).resolves.toMatchObject({ status: 202, body: { task: { id: ID } } });
    expect(test.runner.publish).toHaveBeenCalledWith(ID, {
      allowUnreviewed: true,
    });
    await expect(
      test.call("POST", `/api/tasks/${ID}/publish`, { force: true }),
    ).resolves.toMatchObject({
      status: 400,
      body: { error: "publish_field_unknown" },
    });
    test.setCaller(auth("owner", false));
    await expect(
      test.call("POST", `/api/tasks/${ID}/publish`, {}),
    ).resolves.toMatchObject({ status: 401 });
    expect(test.runner.publish).toHaveBeenCalledTimes(1);
  });

  it("shows only the evidence for the task's current commit", async () => {
    const test = await setup();
    await test.call("POST", "/api/tasks", REQUEST);
    await test.store.save({
      ...test.store.get(ID)!,
      headCommit: "c2",
      evidence: [
        { kind: "implementation", commit: "c1", at: 1 },
        {
          kind: "review",
          commit: "c1",
          at: 2,
          model: "claude/sonnet",
          sessionId: "r1",
          verdict: "approve",
          findings: [],
        },
        { kind: "implementation", commit: "c2", at: 3 },
      ],
    });
    const { body } = await test.call("GET", `/api/tasks/${ID}`);
    expect((body.task as { current: unknown }).current).toEqual({
      implementation: { kind: "implementation", commit: "c2", at: 3 },
    });
  });

  it("records who asked, and keeps a deleted task's audit", async () => {
    const test = await setup();
    await test.call("POST", "/api/tasks", REQUEST);
    await test.call("POST", `/api/tasks/${ID}/stop`);
    await test.call("POST", `/api/tasks/${ID}/publish`, {
      allowUnreviewed: true,
    });
    await test.call("DELETE", `/api/tasks/${ID}`);
    const { status, body } = await test.call("GET", `/api/tasks/${ID}/audit`);
    expect(status).toBe(200);
    const entries = body.entries as Array<{
      kind: string;
      data: Record<string, unknown>;
    }>;
    const owner = { kind: "owner", device: "Laptop" };
    expect(entries.map((entry) => [entry.kind, entry.data.action])).toEqual([
      ["created", undefined],
      ["state", undefined],
      ["request", "create"],
      ["request", "stop"],
      ["request", "publish"],
      ["request", "delete"],
      ["deleted", undefined],
    ]);
    expect(entries[4]!.data).toEqual({
      action: "publish",
      by: owner,
      allowUnreviewed: true,
    });
    expect(body.verification).toEqual({
      ok: true,
      entries: 7,
      problems: [],
      damaged: [],
    });
    await expect(
      test.call("GET", "/api/tasks/bbbbbbbbbbbb/audit"),
    ).resolves.toMatchObject({ status: 404 });
    await expect(
      test.call("POST", `/api/tasks/${ID}/audit`),
    ).resolves.toMatchObject({ status: 405 });
    test.setCaller(auth("guest"));
    await expect(
      test.call("GET", `/api/tasks/${ID}/audit`),
    ).resolves.toMatchObject({ status: 403 });
  });

  it("does not record a request that was refused", async () => {
    const test = await setup();
    await test.call("POST", "/api/tasks", REQUEST);
    test.setCaller(auth("owner", false));
    await test.call("POST", `/api/tasks/${ID}/stop`);
    expect(
      test.audit.entries(ID).filter((entry) => entry.kind === "request"),
    ).toHaveLength(1);
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
