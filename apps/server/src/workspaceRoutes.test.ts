import {
  createWorkspaceHost,
  type WorkspaceHost,
} from "@agentlink/workspace-host";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { createAssistantServer } from "./assistantServer.js";
import {
  createTestCertificate,
  freePort,
  httpsRequest,
  openEventStream,
  openStalledJsonRequest,
  sessionCookieFrom,
  type TestServerSentEvent,
} from "./testSupport.js";
import {
  createAssistantWorkspaceRoutes,
  ownerProjectAccess,
  type AuthorizeAssistantProject,
} from "./workspaceRoutes.js";

const PASSPHRASE = "correct horse battery staple";

let certificate: { cert: string; key: string };
beforeAll(() => {
  certificate = createTestCertificate();
});

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

function toolCall(name: string, input: Record<string, unknown>): Response {
  return new Response(
    `data: ${JSON.stringify({
      id: "tool-response",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call-1",
                type: "function",
                function: { name, arguments: JSON.stringify(input) },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    })}\n\ndata: [DONE]\n\n`,
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

function completion(text: string): Response {
  return new Response(
    `data: ${JSON.stringify({
      id: "response",
      choices: [{ index: 0, delta: { content: text }, finish_reason: "stop" }],
    })}\n\ndata: [DONE]\n\n`,
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

interface Session {
  readonly cookie: string;
  readonly csrf: string;
  readonly deviceId: string;
}

async function startHarness(
  options: {
    authorizeProject?: AuthorizeAssistantProject;
    streamStallTimeoutMs?: number;
  } = {},
) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "assistant-routes-"));
  cleanup.push(() => fs.rm(parent, { recursive: true, force: true }));
  const projectRoot = path.join(parent, "project");
  await fs.mkdir(projectRoot);
  const fetch = vi.fn<typeof globalThis.fetch>();
  const claudeFetch = vi.fn<typeof globalThis.fetch>();
  let agentNotifier:
    | Pick<
        ReturnType<typeof createAssistantWorkspaceRoutes>,
        "notifyAgentApproval" | "notifyAgentChange"
      >
    | undefined;
  const host: WorkspaceHost = await createWorkspaceHost({
    projectRoot,
    dataRoot: path.join(parent, "workspace-data"),
    ownerId: "assistant-server-test",
    defaultModel: { providerId: "fixture", modelId: "fixture-model" },
    providers: [
      {
        type: "openai-compatible",
        id: "fixture",
        baseURL: "https://example.invalid/v1",
        noAuth: true,
        models: [
          {
            id: "fixture-model",
            contextWindow: 32_768,
            maxOutputTokens: 4_096,
            supportsToolUse: true,
          },
        ],
        fetch,
      },
      {
        type: "openai-compatible",
        id: "claude",
        baseURL: "https://claude.invalid/v1",
        noAuth: true,
        models: [
          {
            id: "claude-review",
            contextWindow: 32_768,
            maxOutputTokens: 4_096,
            supportsToolUse: true,
          },
        ],
        fetch: claudeFetch,
      },
    ],
    files: { enabled: true },
    background: {
      enabled: true,
      modelRoles: {
        review: { providerId: "claude", modelId: "claude-review" },
      },
      onApprovalAvailable: ({ parentSessionId, childSessionId }) =>
        agentNotifier?.notifyAgentApproval({
          projectId: "home",
          parentSessionId,
          childSessionId,
        }),
      onAgentChanged: (change) =>
        agentNotifier?.notifyAgentChange({ ...change, projectId: "home" }),
    },
  });
  cleanup.push(() => host.close());

  const port = await freePort();
  const origin = `https://localhost:${port}`;
  const clock = { value: Date.now() };
  let setupToken = "";
  // Routes need the store for owner mapping; it exists once the server does.
  let authorizeProject: AuthorizeAssistantProject = () => false;
  const routes = createAssistantWorkspaceRoutes({
    projects: [{ projectId: "home", label: "Home", host }],
    authorizeProject: (request) => authorizeProject(request),
    models: {
      available: [
        { providerId: "fixture", modelId: "fixture-model" },
        {
          providerId: "claude",
          modelId: "claude-review",
          displayName: "Claude review",
        },
      ],
      defaultModel: { providerId: "fixture", modelId: "fixture-model" },
      roles: { review: { providerId: "claude", modelId: "claude-review" } },
    },
    heartbeatMs: 100,
    streamStallTimeoutMs: options.streamStallTimeoutMs,
  });
  agentNotifier = routes;
  const server = await createAssistantServer({
    dataRoot: path.join(parent, "server-data"),
    tls: certificate,
    publicOrigins: [origin],
    listen: { host: "127.0.0.1", port },
    now: () => clock.value,
    passphraseCost: { N: 1024, r: 8, p: 1 },
    onSetupCredential: (credential) => {
      setupToken = credential.token;
    },
    handleRequest: routes.handleRequest,
    // Server shutdown owns stopping server-owned turns.
    onClose: () => routes.close(),
  });
  authorizeProject =
    options.authorizeProject ?? ownerProjectAccess(server.store);
  await server.start();
  let closed = false;
  const closeServer = async () => {
    if (closed) return;
    closed = true;
    await server.close();
  };
  cleanup.push(closeServer);

  const authHeaders = (session: Session) => ({
    cookie: session.cookie,
    "x-agentlink-csrf": session.csrf,
  });

  const request = (input: {
    method?: string;
    path: string;
    session?: Session;
    body?: unknown;
    headers?: Record<string, string>;
  }) =>
    httpsRequest({
      port,
      ca: certificate.cert,
      method: input.method,
      path: input.path,
      body: input.body,
      headers: {
        ...(input.session ? authHeaders(input.session) : {}),
        ...((input.method ?? "GET") !== "GET" ? { origin } : {}),
        ...input.headers,
      },
    });

  const toSession = (response: Awaited<ReturnType<typeof request>>) => {
    const body = response.body as { csrfToken: string; deviceId: string };
    return {
      cookie: sessionCookieFrom(response),
      csrf: body.csrfToken,
      deviceId: body.deviceId,
    };
  };

  const owner = toSession(
    await request({
      method: "POST",
      path: "/api/auth/bootstrap",
      body: { setupToken, passphrase: PASSPHRASE, deviceLabel: "Laptop" },
    }),
  );

  return {
    host,
    routes,
    server,
    closeServer,
    fetch,
    claudeFetch,
    clock,
    projectRoot,
    owner,
    request,
    toSession,
    stalled: (session: Session, requestPath: string, body: unknown) =>
      openStalledJsonRequest({
        port,
        ca: certificate.cert,
        path: requestPath,
        body,
        headers: { ...authHeaders(session), origin },
      }),
    events: (
      session: Session,
      sessionId: string,
      query = "",
      streamOptions: { paused?: boolean } = {},
    ) =>
      openEventStream({
        port,
        ca: certificate.cert,
        path: `/api/projects/home/sessions/${sessionId}/events${query}`,
        headers: { cookie: session.cookie },
        paused: streamOptions.paused,
      }),
  };
}

type Harness = Awaited<ReturnType<typeof startHarness>>;

async function createSession(harness: Harness): Promise<string> {
  const created = await harness.request({
    method: "POST",
    path: "/api/projects/home/sessions",
    session: harness.owner,
  });
  return (created.body as { sessionId: string }).sessionId;
}

/** Run a turn that suspends on a `write_file` approval for `note.txt`. */
async function suspendForApproval(harness: Harness) {
  const sessionId = await createSession(harness);
  const base = `/api/projects/home/sessions/${sessionId}`;
  harness.fetch
    .mockResolvedValueOnce(
      toolCall("write_file", {
        path: "note.txt",
        content: "hello\n",
        expectedAbsent: true,
      }),
    )
    .mockResolvedValueOnce(completion("done"));
  await harness.request({
    method: "POST",
    path: `${base}/turns`,
    session: harness.owner,
    body: { text: "write a note" },
  });
  await harness.routes.whenIdle("home", sessionId);
  const pending = await readPending(harness, base);
  return {
    sessionId,
    base,
    decision: {
      interactionId: pending!.request.interactionId,
      interactionRevision: pending!.interactionRevision,
      decision: "allow",
    },
  };
}

async function readPending(harness: Harness, base: string) {
  const snapshot = await harness.request({
    path: base,
    session: harness.owner,
  });
  return (
    snapshot.body as {
      session: {
        pendingInteraction?: {
          request: { interactionId: string };
          interactionRevision: string;
        };
      };
    }
  ).session.pendingInteraction;
}

function requestBody(init: RequestInit | undefined) {
  return JSON.parse(String(init?.body)) as {
    model: string;
    messages?: Array<{ role?: string; content?: unknown }>;
  };
}

function hasToolResult(init: RequestInit | undefined): boolean {
  return (
    requestBody(init).messages?.some((message) => message.role === "tool") ??
    false
  );
}

function lastUser(init: RequestInit | undefined): unknown {
  return [...(requestBody(init).messages ?? [])]
    .reverse()
    .find((message) => message.role === "user")?.content;
}

function sentModels(mock: { mock: { calls: unknown[][] } }): string[] {
  return mock.mock.calls.map(
    (call) => requestBody(call[1] as RequestInit).model,
  );
}

const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

function sessionEvents(events: readonly TestServerSentEvent[]) {
  return events
    .filter((event) => event.event === "session")
    .map(
      (event) =>
        event.data as {
          sequence: number;
          event: {
            kind: string;
            state?: string;
            status?: string;
            event?: { type: string; result?: { text?: string } };
          };
        },
    );
}

function isTaskState(state: string, status?: string) {
  return (event: TestServerSentEvent) => {
    const data = event.data as {
      event?: { kind?: string; state?: string; status?: string };
    };
    return (
      event.event === "session" &&
      data.event?.kind === "task" &&
      data.event.state === state &&
      (status === undefined || data.event.status === status)
    );
  };
}

describe("assistant workspace routes", () => {
  it("streams a turn, resumes an approval after reauthentication, and reconnects", async () => {
    const harness = await startHarness();
    const { owner, request } = harness;

    await expect(
      request({ path: "/api/projects", session: owner }),
    ).resolves.toMatchObject({
      status: 200,
      body: { projects: [{ projectId: "home", label: "Home" }] },
    });
    const created = await request({
      method: "POST",
      path: "/api/projects/home/sessions",
      session: owner,
    });
    expect(created.status).toBe(201);
    const { sessionId } = created.body as { sessionId: string };
    const base = `/api/projects/home/sessions/${sessionId}`;

    const live = await harness.events(owner, sessionId);
    expect(live.status).toBe(200);
    await live.waitFor((event) => event.event === "ready");

    harness.fetch
      .mockResolvedValueOnce(
        toolCall("write_file", {
          path: "note.txt",
          content: "hello\n",
          expectedAbsent: true,
        }),
      )
      .mockResolvedValueOnce(completion("done"));
    await expect(
      request({
        method: "POST",
        path: `${base}/turns`,
        session: owner,
        body: { text: "write a note" },
      }),
    ).resolves.toMatchObject({ status: 202 });
    await live.waitFor(isTaskState("finished", "suspended"));
    expect(
      sessionEvents(live.events).map((event) => event.event.event?.type),
    ).toContain("interaction.required");
    // The browser goes away; the durable session keeps the pending approval.
    live.close();
    await harness.routes.whenIdle("home", sessionId);

    const snapshot = await request({ path: base, session: owner });
    const body = snapshot.body as {
      session: {
        pendingInteraction?: {
          request: { interactionId: string; toolName: string };
          interactionRevision: string;
        };
      };
      events: { epoch: string; sequence: number };
    };
    expect(body.session.pendingInteraction?.request.toolName).toBe(
      "write_file",
    );
    const pending = body.session.pendingInteraction!;
    const decision = {
      interactionId: pending.request.interactionId,
      interactionRevision: pending.interactionRevision,
      decision: "allow",
    };
    await expect(
      request({
        method: "POST",
        path: `${base}/turns`,
        session: owner,
        body: { text: "another" },
      }),
    ).resolves.toMatchObject({
      status: 409,
      body: { error: "interaction_pending" },
    });

    harness.clock.value += 6 * 60 * 1000;
    await expect(
      request({
        method: "POST",
        path: `${base}/interaction`,
        session: owner,
        body: decision,
      }),
    ).resolves.toMatchObject({
      status: 401,
      body: { error: "reauthentication_required" },
    });
    await expect(
      request({
        method: "POST",
        path: "/api/auth/reauthenticate",
        session: owner,
        body: { passphrase: PASSPHRASE },
      }),
    ).resolves.toMatchObject({ status: 204 });
    await expect(
      request({
        method: "POST",
        path: `${base}/interaction`,
        session: owner,
        body: { ...decision, interactionRevision: "stale" },
      }),
    ).resolves.toMatchObject({
      status: 409,
      body: { error: "stale_interaction" },
    });

    // Reconnect from the snapshot cursor, then approve.
    const resumed = await harness.events(
      owner,
      sessionId,
      `?epoch=${body.events.epoch}&after=${body.events.sequence}`,
    );
    await resumed.waitFor((event) => event.event === "ready");
    expect(sessionEvents(resumed.events)).toEqual([]);
    await expect(
      request({
        method: "POST",
        path: `${base}/interaction`,
        session: owner,
        body: decision,
      }),
    ).resolves.toMatchObject({ status: 202 });
    await resumed.waitFor(isTaskState("finished", "completed"));
    const completed = sessionEvents(resumed.events).find(
      (event) => event.event.event?.type === "turn.completed",
    );
    expect(completed?.event.event?.result?.text).toBe("done");
    expect(
      sessionEvents(resumed.events).every(
        (event) => event.sequence > body.events.sequence,
      ),
    ).toBe(true);
    resumed.close();
    await expect(
      fs.readFile(path.join(harness.projectRoot, "note.txt"), "utf8"),
    ).resolves.toBe("hello\n");

    // A full replay is ordered and gap-free; a foreign epoch asks for a reset.
    const replay = await harness.events(
      owner,
      sessionId,
      `?epoch=${body.events.epoch}&after=0`,
    );
    await replay.waitFor(isTaskState("finished", "completed"));
    const sequences = sessionEvents(replay.events).map(
      (event) => event.sequence,
    );
    expect(sequences).toEqual(
      Array.from({ length: sequences.length }, (_, index) => index + 1),
    );
    replay.close();
    const restarted = await harness.events(
      owner,
      sessionId,
      "?epoch=previous-process&after=12",
    );
    await expect(
      restarted.waitFor((event) => event.event === "reset"),
    ).resolves.toMatchObject({ data: { reason: "epoch_changed" } });
    restarted.close();
  });

  it("keeps running when the browser disconnects and rejects a second turn", async () => {
    const harness = await startHarness();
    const { owner, request } = harness;
    const { sessionId } = (
      await request({
        method: "POST",
        path: "/api/projects/home/sessions",
        session: owner,
      })
    ).body as { sessionId: string };
    let release!: () => void;
    harness.fetch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(completion("finished offline"));
        }),
    );
    const stream = await harness.events(owner, sessionId);
    await stream.waitFor((event) => event.event === "ready");
    await expect(
      request({
        method: "POST",
        path: `/api/projects/home/sessions/${sessionId}/turns`,
        session: owner,
        body: { text: "long task" },
      }),
    ).resolves.toMatchObject({ status: 202 });
    await expect(
      request({
        method: "POST",
        path: `/api/projects/home/sessions/${sessionId}/turns`,
        session: owner,
        body: { text: "second" },
      }),
    ).resolves.toMatchObject({ status: 409, body: { error: "session_busy" } });
    stream.close();
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    release();
    await harness.routes.whenIdle("home", sessionId);

    const reconnected = await harness.events(
      owner,
      sessionId,
      `?epoch=${harness.routes.events.epoch}&after=0`,
    );
    await expect(
      reconnected.waitFor(isTaskState("finished", "completed")),
    ).resolves.toBeDefined();
    reconnected.close();
  });

  it("accepts a new turn after the owner cancels one", async () => {
    const harness = await startHarness();
    const sessionId = await createSession(harness);
    const base = `/api/projects/home/sessions/${sessionId}`;
    harness.fetch
      .mockImplementationOnce(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            const signal = init?.signal;
            signal?.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
          }),
      )
      .mockResolvedValueOnce(completion("after cancel"));
    await expect(
      harness.request({
        method: "POST",
        path: `${base}/turns`,
        session: harness.owner,
        body: { text: "long task" },
      }),
    ).resolves.toMatchObject({ status: 202 });
    await vi.waitFor(() => expect(harness.fetch).toHaveBeenCalledTimes(1));
    await expect(
      harness.request({
        method: "POST",
        path: `${base}/cancel`,
        session: harness.owner,
      }),
    ).resolves.toMatchObject({ status: 202 });
    await harness.routes.whenIdle("home", sessionId);

    // A cancelled turn leaves the session interrupted, which is runnable.
    const snapshot = await harness.request({
      path: base,
      session: harness.owner,
    });
    expect(
      (snapshot.body as { session: { phase: string } }).session.phase,
    ).toBe("interrupted");
    await expect(
      harness.request({
        method: "POST",
        path: `${base}/turns`,
        session: harness.owner,
        body: { text: "try again" },
      }),
    ).resolves.toMatchObject({ status: 202 });
    await harness.routes.whenIdle("home", sessionId);
    await expect(readPending(harness, base)).resolves.toBeUndefined();
  });

  it("routes sessions to the selected model or role", async () => {
    const harness = await startHarness();
    const { owner, request } = harness;
    const sentModel = (mock: typeof harness.fetch, call: number) =>
      (
        JSON.parse(String(mock.mock.calls[call]![1]!.body)) as {
          model: string;
        }
      ).model;

    await expect(
      request({ path: "/api/projects/home/models", session: owner }),
    ).resolves.toMatchObject({
      status: 200,
      body: {
        models: [
          { providerId: "fixture", modelId: "fixture-model" },
          {
            providerId: "claude",
            modelId: "claude-review",
            displayName: "Claude review",
          },
        ],
        defaultModel: { providerId: "fixture", modelId: "fixture-model" },
        roles: { review: { providerId: "claude", modelId: "claude-review" } },
      },
    });

    const review = await request({
      method: "POST",
      path: "/api/projects/home/sessions",
      session: owner,
      body: { role: "review" },
    });
    expect(review).toMatchObject({
      status: 201,
      body: { model: { providerId: "claude", modelId: "claude-review" } },
    });
    const reviewId = (review.body as { sessionId: string }).sessionId;
    harness.claudeFetch.mockResolvedValueOnce(completion("reviewed"));
    await request({
      method: "POST",
      path: `/api/projects/home/sessions/${reviewId}/turns`,
      session: owner,
      body: { text: "review this" },
    });
    await harness.routes.whenIdle("home", reviewId);
    expect(harness.claudeFetch).toHaveBeenCalledTimes(1);
    expect(sentModel(harness.claudeFetch, 0)).toBe("claude-review");
    expect(harness.fetch).not.toHaveBeenCalled();

    // A default session can switch to Claude between turns.
    const sessionId = await createSession(harness);
    const base = `/api/projects/home/sessions/${sessionId}`;
    harness.fetch.mockResolvedValueOnce(completion("default"));
    await request({
      method: "POST",
      path: `${base}/turns`,
      session: owner,
      body: { text: "hello" },
    });
    await harness.routes.whenIdle("home", sessionId);
    expect(sentModel(harness.fetch, 0)).toBe("fixture-model");
    await expect(
      request({
        method: "POST",
        path: `${base}/model`,
        session: owner,
        body: { model: { providerId: "claude", modelId: "claude-review" } },
      }),
    ).resolves.toMatchObject({
      status: 200,
      body: { model: { providerId: "claude", modelId: "claude-review" } },
    });
    await expect(
      request({ path: base, session: owner }),
    ).resolves.toMatchObject({
      body: { model: { providerId: "claude", modelId: "claude-review" } },
    });
    harness.claudeFetch.mockResolvedValueOnce(completion("switched"));
    await request({
      method: "POST",
      path: `${base}/turns`,
      session: owner,
      body: { text: "again" },
    });
    await harness.routes.whenIdle("home", sessionId);
    expect(harness.fetch).toHaveBeenCalledTimes(1);
    expect(sentModel(harness.claudeFetch, 1)).toBe("claude-review");

    const listed = await request({
      path: "/api/projects/home/sessions",
      session: owner,
    });
    expect(
      (listed.body as { sessions: { model: { modelId: string } }[] }).sessions
        .map((session) => session.model.modelId)
        .sort(),
    ).toEqual(["claude-review", "claude-review"]);
  });

  it("rejects unavailable models and changes during a turn", async () => {
    const harness = await startHarness();
    const { owner, request } = harness;
    const create = (body: unknown) =>
      request({
        method: "POST",
        path: "/api/projects/home/sessions",
        session: owner,
        body,
      });
    await expect(
      create({ model: { providerId: "fixture", modelId: "gpt-unknown" } }),
    ).resolves.toMatchObject({
      status: 400,
      body: { error: "model_not_available" },
    });
    await expect(create({ role: "planner" })).resolves.toMatchObject({
      status: 400,
      body: { error: "model_role_not_configured" },
    });
    await expect(
      create({
        role: "review",
        model: { providerId: "fixture", modelId: "fixture-model" },
      }),
    ).resolves.toMatchObject({
      status: 400,
      body: { error: "model_selection_invalid" },
    });
    await expect(
      create({
        model: {
          providerId: "fixture",
          modelId: "fixture-model",
          baseURL: "https://evil.invalid",
        },
      }),
    ).resolves.toMatchObject({ status: 400, body: { error: "model_invalid" } });

    const sessionId = await createSession(harness);
    const base = `/api/projects/home/sessions/${sessionId}`;
    await expect(
      request({
        method: "POST",
        path: `${base}/model`,
        session: owner,
        body: {},
      }),
    ).resolves.toMatchObject({
      status: 400,
      body: { error: "model_required" },
    });

    harness.fetch.mockImplementationOnce(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal;
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    );
    await request({
      method: "POST",
      path: `${base}/turns`,
      session: owner,
      body: { text: "long task" },
    });
    await vi.waitFor(() => expect(harness.fetch).toHaveBeenCalledTimes(1));
    await expect(
      request({
        method: "POST",
        path: `${base}/model`,
        session: owner,
        body: { role: "review" },
      }),
    ).resolves.toMatchObject({ status: 409, body: { error: "session_busy" } });
    await request({ method: "POST", path: `${base}/cancel`, session: owner });
    await harness.routes.whenIdle("home", sessionId);
    await expect(
      request({ path: base, session: owner }),
    ).resolves.toMatchObject({
      body: { model: { providerId: "fixture", modelId: "fixture-model" } },
    });
  });

  it("requires write access to choose a model", async () => {
    const harness = await startHarness({
      authorizeProject: ({ access }) => access === "read",
    });
    const { owner, request } = harness;
    await expect(
      request({ path: "/api/projects/home/models", session: owner }),
    ).resolves.toMatchObject({ status: 200 });
    await expect(
      request({
        method: "POST",
        path: "/api/projects/home/sessions",
        session: owner,
        body: { role: "review" },
      }),
    ).resolves.toMatchObject({
      status: 403,
      body: { error: "project_access_denied" },
    });
  });

  it("runs a read-only review agent on the review model", async () => {
    const harness = await startHarness();
    const { owner, request } = harness;
    await fs.writeFile(
      path.join(harness.projectRoot, "notes.md"),
      "add = (a, b) => a - b\n",
    );
    harness.fetch.mockImplementation(async (_url, init) =>
      hasToolResult(init)
        ? completion("parent done")
        : toolCall("spawn_background_agent", {
            task: "Review notes.md",
            message: "review notes.md",
            read_paths: [{ path: "notes.md", kind: "file" }],
            write_paths: [],
            model_role: "review",
          }),
    );
    harness.claudeFetch.mockImplementation(async () =>
      completion("add subtracts"),
    );
    const sessionId = await createSession(harness);
    const base = `/api/projects/home/sessions/${sessionId}`;
    const live = await harness.events(owner, sessionId);
    await live.waitFor((event) => event.event === "ready");
    await request({
      method: "POST",
      path: `${base}/turns`,
      session: owner,
      body: { text: "get a review" },
    });
    await harness.routes.whenIdle("home", sessionId);
    // Completion is pushed to the parent's stream, with state but no output.
    const done = await live.waitFor(
      (event) =>
        event.event === "session" &&
        (event.data as { event: { kind: string; lifecycle?: string } }).event
          .lifecycle === "completed",
    );
    expect(done.data).toMatchObject({
      event: {
        kind: "agent",
        state: "updated",
        lifecycle: "completed",
        phase: "completed",
      },
    });
    expect(JSON.stringify(done.data)).not.toContain("add subtracts");
    live.close();

    let agent!: { childSessionId: string };
    await vi.waitFor(async () => {
      const listed = await request({ path: `${base}/agents`, session: owner });
      expect(listed).toMatchObject({
        status: 200,
        body: {
          agents: [
            {
              lifecycle: "completed",
              resultText: "add subtracts",
              model: { providerId: "claude", modelId: "claude-review" },
              scopes: [{ path: "notes.md", access: "read" }],
            },
          ],
        },
      });
      agent = (listed.body as { agents: [{ childSessionId: string }] })
        .agents[0];
    });
    expect(sentModels(harness.claudeFetch)).toEqual(
      expect.arrayContaining(["claude-review"]),
    );
    expect(new Set(sentModels(harness.claudeFetch))).toEqual(
      new Set(["claude-review"]),
    );

    // A child is reachable only through its parent's agents.
    const child = `/api/projects/home/sessions/${agent.childSessionId}`;
    await expect(
      request({ path: child, session: owner }),
    ).resolves.toMatchObject({
      status: 404,
      body: { error: "session_not_found" },
    });
    await expect(
      request({
        method: "POST",
        path: `${child}/turns`,
        session: owner,
        body: { text: "bypass" },
      }),
    ).resolves.toMatchObject({ status: 404 });
    await expect(
      request({ path: `${child}/agents`, session: owner }),
    ).resolves.toMatchObject({ status: 404 });
    await expect(
      request({
        method: "POST",
        path: `${base}/agents/${agent.childSessionId}/steer`,
        session: owner,
        body: { message: "more" },
      }),
    ).resolves.toMatchObject({
      status: 409,
      body: { error: "agent_not_running" },
    });
  });

  it("approves a child's write only after reauthentication", async () => {
    const harness = await startHarness();
    const { owner, request } = harness;
    harness.fetch.mockImplementation(async (_url, init) => {
      if (lastUser(init) === "write child.txt") {
        return hasToolResult(init)
          ? completion("child done")
          : toolCall("write_file", {
              path: "child.txt",
              content: "from child\n",
              expectedAbsent: true,
            });
      }
      return hasToolResult(init)
        ? completion("parent done")
        : toolCall("spawn_background_agent", {
            task: "Write child.txt",
            message: "write child.txt",
            read_paths: [],
            write_paths: [{ path: "child.txt", kind: "file" }],
          });
    });
    const sessionId = await createSession(harness);
    const base = `/api/projects/home/sessions/${sessionId}`;
    const live = await harness.events(owner, sessionId);
    await live.waitFor((event) => event.event === "ready");
    await request({
      method: "POST",
      path: `${base}/turns`,
      session: owner,
      body: { text: "delegate" },
    });
    const notified = await live.waitFor(
      (event) =>
        event.event === "session" &&
        (event.data as { event: { kind: string; state?: string } }).event
          .state === "approval_required",
    );
    expect(notified.data).toMatchObject({
      event: { kind: "agent", state: "approval_required" },
    });
    live.close();

    const listed = await request({ path: `${base}/agents`, session: owner });
    const [agent] = (
      listed.body as {
        agents: [
          {
            childSessionId: string;
            lifecycle: string;
            approval: { interactionId: string; toolName: string };
          },
        ];
      }
    ).agents;
    expect(agent).toMatchObject({
      lifecycle: "awaiting_approval",
      approval: { toolName: "write_file" },
    });
    const approve = (body: Record<string, unknown>) =>
      request({
        method: "POST",
        path: `${base}/agents/${agent.childSessionId}/approval`,
        session: owner,
        body,
      });

    harness.clock.value += 6 * 60 * 1000;
    await expect(
      approve({
        interactionId: agent.approval.interactionId,
        decision: "allow",
      }),
    ).resolves.toMatchObject({
      status: 401,
      body: { error: "reauthentication_required" },
    });
    await request({
      method: "POST",
      path: "/api/auth/reauthenticate",
      session: owner,
      body: { passphrase: PASSPHRASE },
    });
    await expect(
      approve({ interactionId: "not-the-pending-one", decision: "allow" }),
    ).resolves.toMatchObject({
      status: 409,
      body: { error: "stale_interaction" },
    });
    await expect(
      approve({ interactionId: agent.approval.interactionId, decision: "ok" }),
    ).resolves.toMatchObject({
      status: 400,
      body: { error: "decision_invalid" },
    });
    await expect(
      fs.readFile(path.join(harness.projectRoot, "child.txt"), "utf8"),
    ).rejects.toThrow();
    await expect(
      approve({
        interactionId: agent.approval.interactionId,
        decision: "allow",
      }),
    ).resolves.toMatchObject({ status: 200 });
    await vi.waitFor(async () => {
      await expect(
        request({ path: `${base}/agents`, session: owner }),
      ).resolves.toMatchObject({
        body: {
          agents: [{ lifecycle: "completed", resultText: "child done" }],
        },
      });
    });
    await expect(
      fs.readFile(path.join(harness.projectRoot, "child.txt"), "utf8"),
    ).resolves.toBe("from child\n");
  });

  it("steers and stops a running agent, scoped to its parent", async () => {
    let allowWrite = true;
    const harness = await startHarness({
      authorizeProject: ({ access }) =>
        access === "read" || (access === "write" && allowWrite),
    });
    const { owner, request } = harness;
    harness.fetch.mockImplementation(async (_url, init) =>
      hasToolResult(init)
        ? completion("parent done")
        : toolCall("spawn_background_agent", {
            task: "Slow review",
            message: "slow review",
            read_paths: [{ path: ".", kind: "directory" }],
            write_paths: [],
            model_role: "review",
          }),
    );
    // The child's provider request hangs until it is aborted.
    harness.claudeFetch.mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal;
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    );
    const sessionId = await createSession(harness);
    const other = await createSession(harness);
    const base = `/api/projects/home/sessions/${sessionId}`;
    await request({
      method: "POST",
      path: `${base}/turns`,
      session: owner,
      body: { text: "start a slow review" },
    });
    await harness.routes.whenIdle("home", sessionId);
    await vi.waitFor(() => expect(harness.claudeFetch).toHaveBeenCalled());
    const listed = await request({ path: `${base}/agents`, session: owner });
    const { childSessionId } = (
      listed.body as { agents: [{ childSessionId: string }] }
    ).agents[0];
    const agentPath = (parent: string, op: string) =>
      `/api/projects/home/sessions/${parent}/agents/${childSessionId}/${op}`;

    await expect(
      request({
        method: "POST",
        path: agentPath(sessionId, "steer"),
        session: owner,
        body: { message: "   " },
      }),
    ).resolves.toMatchObject({
      status: 400,
      body: { error: "message_invalid" },
    });
    await expect(
      request({
        method: "POST",
        path: agentPath(sessionId, "steer"),
        session: owner,
        body: { message: "also check tests" },
      }),
    ).resolves.toMatchObject({ status: 202, body: { status: "queued" } });
    // Another session cannot reach this child.
    await expect(
      request({
        method: "POST",
        path: agentPath(other, "stop"),
        session: owner,
      }),
    ).resolves.toMatchObject({
      status: 404,
      body: { error: "agent_not_found" },
    });
    await expect(
      request({
        method: "POST",
        path: `${base}/agents/unknown-child/stop`,
        session: owner,
      }),
    ).resolves.toMatchObject({
      status: 404,
      body: { error: "agent_not_found" },
    });

    allowWrite = false;
    await expect(
      request({ path: `${base}/agents`, session: owner }),
    ).resolves.toMatchObject({
      status: 200,
      body: { agents: [{ lifecycle: "running", steeringQueued: 1 }] },
    });
    await expect(
      request({
        method: "POST",
        path: agentPath(sessionId, "stop"),
        session: owner,
      }),
    ).resolves.toMatchObject({
      status: 403,
      body: { error: "project_access_denied" },
    });
    allowWrite = true;
    await expect(
      request({
        method: "POST",
        path: agentPath(sessionId, "stop"),
        session: owner,
        body: { reason: "no longer needed" },
      }),
    ).resolves.toMatchObject({
      status: 200,
      body: {
        agent: {
          lifecycle: "cancelled",
          terminalReason: "no longer needed",
        },
      },
    });
    await expect(
      request({
        method: "POST",
        path: agentPath(sessionId, "steer"),
        session: owner,
        body: { message: "again" },
      }),
    ).resolves.toMatchObject({
      status: 409,
      body: { error: "agent_not_running" },
    });
    const log = harness.routes.events.read(`home\u0000${sessionId}`, 0);
    if (log.reset) throw new Error("expected the retained event log");
    const agentEvents = log.events.flatMap(({ event }) =>
      event.kind === "agent" ? [event] : [],
    );
    expect(
      agentEvents.flatMap((event) =>
        event.state === "updated" ? [] : [event.state],
      ),
    ).toEqual(["steered", "stopped"]);
    // The stop's terminal state is pushed exactly once, before the action.
    const updates = agentEvents.flatMap((event) =>
      event.state === "updated" ? [event.lifecycle] : [],
    );
    expect(updates[0]).toBe("running");
    expect(updates.filter((lifecycle) => lifecycle === "cancelled")).toEqual([
      "cancelled",
    ]);
    expect(updates.at(-1)).toBe("cancelled");
  });

  it("maps project access explicitly", async () => {
    const authorizeProject = vi.fn<AuthorizeAssistantProject>(
      ({ access }) => access !== "approve",
    );
    const harness = await startHarness({ authorizeProject });
    const { owner, request } = harness;
    await expect(
      request({ path: "/api/projects/elsewhere", session: owner }),
    ).resolves.toMatchObject({
      status: 404,
      body: { error: "project_not_found" },
    });
    await expect(
      request({ path: "/api/projects/home/sessions" }),
    ).resolves.toMatchObject({ status: 401 });
    const { sessionId } = (
      await request({
        method: "POST",
        path: "/api/projects/home/sessions",
        session: owner,
      })
    ).body as { sessionId: string };
    await expect(
      request({
        method: "POST",
        path: `/api/projects/home/sessions/${sessionId}/interaction`,
        session: owner,
        body: {
          interactionId: "x",
          interactionRevision: "y",
          decision: "allow",
        },
      }),
    ).resolves.toMatchObject({
      status: 403,
      body: { error: "project_access_denied" },
    });
    expect(authorizeProject).toHaveBeenCalledWith({
      principal: {
        tenantId: "agentlink-server",
        subjectId: harness.server.store.ownerId,
      },
      projectId: "home",
      access: "approve",
    });

    const ownerOnly = ownerProjectAccess(harness.server.store);
    const ownerId = harness.server.store.ownerId!;
    expect(
      ownerOnly({
        principal: { tenantId: "agentlink-server", subjectId: ownerId },
        projectId: "home",
        access: "write",
      }),
    ).toBe(true);
    expect(
      ownerOnly({
        principal: { tenantId: "agentlink-server", subjectId: "someone-else" },
        projectId: "home",
        access: "read",
      }),
    ).toBe(false);
    expect(
      ownerOnly({
        principal: {
          tenantId: "other-tenant",
          subjectId: ownerId,
        } as unknown as Parameters<AuthorizeAssistantProject>[0]["principal"],
        projectId: "home",
        access: "read",
      }),
    ).toBe(false);
  });

  it("closes an event stream when its device is revoked", async () => {
    const harness = await startHarness();
    const { owner, request } = harness;
    const { sessionId } = (
      await request({
        method: "POST",
        path: "/api/projects/home/sessions",
        session: owner,
      })
    ).body as { sessionId: string };
    const { code } = (
      await request({
        method: "POST",
        path: "/api/auth/pairings",
        session: owner,
      })
    ).body as { code: string };
    const phone = harness.toSession(
      await request({
        method: "POST",
        path: "/api/auth/pairings/redeem",
        body: { code, deviceLabel: "Phone" },
      }),
    );
    const stream = await harness.events(phone, sessionId);
    await stream.waitFor((event) => event.event === "ready");
    await expect(
      request({
        method: "DELETE",
        path: `/api/auth/devices/${phone.deviceId}`,
        session: owner,
      }),
    ).resolves.toMatchObject({ status: 204 });
    await expect(stream.ended).resolves.toBeUndefined();
  });

  it("rechecks authorization when a stalled approval body completes", async () => {
    const harness = await startHarness();
    const { base, decision } = await suspendForApproval(harness);

    // The reauthentication window lapses while the body is in flight.
    const lapsed = harness.stalled(
      harness.owner,
      `${base}/interaction`,
      decision,
    );
    await delay(200);
    harness.clock.value += 6 * 60 * 1000;
    lapsed.finish();
    await expect(lapsed.response).resolves.toMatchObject({
      status: 401,
      body: { error: "reauthentication_required" },
    });

    // A paired device's stalled approval stops as soon as it is revoked,
    // without waiting for the client to finish sending.
    await harness.request({
      method: "POST",
      path: "/api/auth/reauthenticate",
      session: harness.owner,
      body: { passphrase: PASSPHRASE },
    });
    const { code } = (
      await harness.request({
        method: "POST",
        path: "/api/auth/pairings",
        session: harness.owner,
      })
    ).body as { code: string };
    const phone = harness.toSession(
      await harness.request({
        method: "POST",
        path: "/api/auth/pairings/redeem",
        body: { code, deviceLabel: "Phone" },
      }),
    );
    const revoked = harness.stalled(phone, `${base}/interaction`, decision);
    await delay(200);
    await expect(
      harness.request({
        method: "DELETE",
        path: `/api/auth/devices/${phone.deviceId}`,
        session: harness.owner,
      }),
    ).resolves.toMatchObject({ status: 204 });
    await expect(revoked.response).rejects.toThrow();
    revoked.finish();

    await expect(readPending(harness, base)).resolves.toMatchObject({
      interactionRevision: decision.interactionRevision,
    });
    await expect(
      fs.access(path.join(harness.projectRoot, "note.txt")),
    ).rejects.toThrow();
  });

  it("stops server-owned turns when the server closes", async () => {
    const harness = await startHarness();
    const sessionId = await createSession(harness);
    harness.fetch.mockImplementationOnce(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal;
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    );
    const stream = await harness.events(harness.owner, sessionId);
    await stream.waitFor((event) => event.event === "ready");
    await expect(
      harness.request({
        method: "POST",
        path: `/api/projects/home/sessions/${sessionId}/turns`,
        session: harness.owner,
        body: { text: "long task" },
      }),
    ).resolves.toMatchObject({ status: 202 });
    await vi.waitFor(() => expect(harness.fetch).toHaveBeenCalled());

    await harness.closeServer();
    await stream.ended;
    // close() aborted the model request and waited for the turn to settle.
    const init = harness.fetch.mock.calls[0]![1];
    expect(init?.signal?.aborted).toBe(true);
    await expect(
      Promise.race([
        harness.routes.whenIdle("home", sessionId).then(() => "idle"),
        delay(0).then(() => "running"),
      ]),
    ).resolves.toBe("idle");
  });

  it("does not let an open event stream extend the session idle window", async () => {
    const harness = await startHarness();
    const sessionId = await createSession(harness);
    const stream = await harness.events(harness.owner, sessionId);
    await stream.waitFor((event) => event.event === "ready");

    // Heartbeats keep revalidating every 100 ms while a week passes.
    for (let day = 0; day < 8; day += 1) {
      harness.clock.value += 24 * 60 * 60 * 1000;
      await delay(150);
    }
    await expect(stream.ended).resolves.toBeUndefined();
    await expect(
      harness.request({ path: "/api/projects", session: harness.owner }),
    ).resolves.toMatchObject({ status: 401 });
  });

  it(
    "catches a slow reader up after bursts and drops a stalled one",
    {
      timeout: 20_000,
    },
    async () => {
      const harness = await startHarness({ streamStallTimeoutMs: 1_000 });
      const sessionId = await createSession(harness);
      const stalled = await harness.events(harness.owner, sessionId, "", {
        paused: true,
      });
      const live = await harness.events(harness.owner, sessionId);
      await live.waitFor((event) => event.event === "ready");

      // A synchronous burst far larger than any socket buffer. Hub keys are
      // internal; this mirrors the route's project/session key.
      const key = `home\u0000${sessionId}`;
      const filler = "x".repeat(32 * 1024);
      const count = 600;
      for (let index = 0; index < count; index += 1) {
        harness.routes.events.publish(key, {
          kind: "task",
          state: "failed",
          taskId: `filler-${index}`,
          error: filler,
        });
      }

      // The draining reader receives every event, in order, via catch-up.
      await live.waitFor(
        (event) =>
          event.event === "session" &&
          (event.data as { event: { taskId?: string } }).event.taskId ===
            `filler-${count - 1}`,
        15_000,
      );
      const sequences = sessionEvents(live.events).map(
        (event) => event.sequence,
      );
      expect(sequences).toEqual(
        Array.from({ length: count }, (_, index) => index + 1),
      );
      live.close();
      // The reader that never drained was dropped after the stall timeout:
      // once it reads again it finds a truncated, closed stream.
      await delay(1_500);
      stalled.resume();
      await expect(stalled.ended).resolves.toBeUndefined();
      expect(sessionEvents(stalled.events).length).toBeLessThan(count);
    },
  );
});
