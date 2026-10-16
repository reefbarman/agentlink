import {
  defineTool,
  type CoreModelBackend,
  type CoreModelCapabilities,
  type CoreModelRequestContext,
  type CoreModelStreamEvent,
  type CoreModelStreamRequest,
} from "@agentlink/core";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AssistantServerAuth } from "./assistantServer.js";
import { createRemoteWorkspaceHost } from "./remoteWorkspaceHost.js";
import {
  createRunnerHttpClient,
  startRunnerHttpServer,
} from "./runnerProtocol.js";
import {
  createRunnerSessionState,
  runnerHostRoutes,
  startSessionRunner,
  type RunnerHost,
  type SessionRunner,
} from "./sessionRunner.js";
import { startSessionRunnerPool } from "./sessionRunners.js";
import { createAssistantWorkspaceRoutes } from "./workspaceRoutes.js";

const MODEL = { providerId: "fake", modelId: "model-a" };
const CAPS: CoreModelCapabilities = {
  supportsThinking: false,
  supportsCaching: false,
  supportsImages: false,
  supportsToolUse: true,
  contextWindow: 200_000,
  maxOutputTokens: 4_096,
};

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

const auth = (): AssistantServerAuth => {
  const signedIn: AssistantServerAuth = {
    principal: { tenantId: "agentlink-server", subjectId: "owner" },
    session: {
      ownerId: "owner",
      sessionId: "s",
      deviceId: "d",
      deviceLabel: "Laptop",
      createdAt: 0,
      expiresAt: Number.MAX_SAFE_INTEGER,
    },
    signal: new AbortController().signal,
    revalidate: async () => ({ valid: true }),
    detach: () => signedIn,
  };
  return signedIn;
};

type Script = (
  request: CoreModelStreamRequest,
) => AsyncGenerator<CoreModelStreamEvent>;

/** A model on the control plane; each turn's reply comes from `script`. */
class ScriptedBackend implements CoreModelBackend {
  readonly providerId = MODEL.providerId;
  readonly displayName = "Fake";
  readonly condenseModel = MODEL.modelId;
  readonly requests: CoreModelStreamRequest[] = [];
  readonly contexts: CoreModelRequestContext[] = [];
  constructor(public script: Script) {}
  listModels() {
    return [
      {
        id: MODEL.modelId,
        displayName: "Fake model",
        providerId: this.providerId,
        contextWindow: CAPS.contextWindow,
        maxOutputTokens: CAPS.maxOutputTokens,
        authenticated: true,
      },
    ];
  }
  getCapabilities() {
    return CAPS;
  }
  async *stream(
    request: CoreModelStreamRequest,
    context: CoreModelRequestContext,
  ) {
    this.requests.push(request);
    this.contexts.push(context);
    yield* this.script(request);
  }
  async complete(): Promise<never> {
    throw new Error("not used");
  }
}

function final(text: string): CoreModelStreamEvent[] {
  return [
    { type: "text_delta", text },
    { type: "usage", inputTokens: 1, outputTokens: 1 },
    {
      type: "model_stop",
      reason: "end_turn",
      assistantMessage: {
        role: "assistant",
        content: [{ type: "text", text }],
      },
    },
    { type: "done" },
  ];
}

function toolCall(
  name: string,
  input: Record<string, unknown>,
): CoreModelStreamEvent[] {
  return [
    { type: "tool_done", toolCallId: "call-1", toolName: name, input },
    {
      type: "model_stop",
      reason: "tool_use",
      assistantMessage: {
        role: "assistant",
        content: [{ type: "tool_use", id: "call-1", name, input }],
      },
    },
    { type: "done" },
  ];
}

/**
 * A control plane with a runner pool whose "manager" starts runners in this
 * process (a new one, on a new port, each time), and routes over them.
 */
async function setup(script: Script) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "session-runner-")),
  );
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
  const folder = path.join(root, "projects", ".tasks", "t1");
  const clone = path.join(folder, "repo");
  await fs.mkdir(clone, { recursive: true });
  const backend = new ScriptedBackend(script);
  const lookups: string[] = [];
  const runners = new Map<string, SessionRunner>();
  const manager = {
    starts: 0,
    async start(request: {
      id: string;
      dataFolder: string;
      env: Readonly<Record<string, string>>;
    }) {
      manager.starts += 1;
      await runners.get(request.id)?.close();
      const runner = await startSessionRunner({
        spec: JSON.parse(request.env.AGENTLINK_RUNNER_SPEC!),
        token: request.env.AGENTLINK_RUNNER_TOKEN!,
        controlUrl: request.env.AGENTLINK_RUNNER_CONTROL_URL!,
        dataRoot: request.dataFolder,
        host: "127.0.0.1",
        port: 0,
        log: () => undefined,
      });
      runners.set(request.id, runner);
      return { url: `http://127.0.0.1:${runner.port}` };
    },
    stop: vi.fn(async (id: string) => {
      await runners.get(id)?.close();
      runners.delete(id);
    }),
    stopAll: vi.fn(async () => ({ stopped: 0 })),
  };
  let controlUrl = "";
  const pool = await startSessionRunnerPool({
    manager,
    backends: [backend],
    hostTools: (projectId) => () => [
      defineTool({
        name: "lookup",
        description: "Look something up on the control plane.",
        inputSchema: {
          type: "object",
          properties: { q: { type: "string" } },
          required: ["q"],
        },
        effect: "read",
        handler: async (input) => {
          lookups.push(`${projectId}:${String(input.q)}`);
          return { modelContent: `found ${String(input.q)}` };
        },
      }),
    ],
    listen: { host: "127.0.0.1", port: 0 },
    get controlUrl() {
      return controlUrl;
    },
    dataRoot: path.join(root, "data", "runners"),
    approvalMode: () => "autonomous",
    log: () => undefined,
  });
  controlUrl = `http://127.0.0.1:${pool.port}`;
  cleanup.push(async () => {
    await pool.close();
    for (const runner of runners.values()) await runner.close();
  });
  const host = pool.open(
    {
      projectId: "task-t1",
      projectRoot: folder,
      commandRoot: clone,
      shell: "/bin/sh",
      defaultModel: MODEL,
      instructions: "Work on the task.",
      commandEnvironment: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    },
    folder,
  );
  const routes = createAssistantWorkspaceRoutes({
    projects: [{ projectId: "task-t1", host, hidden: true }],
    authorizeProject: () => true,
    models: {
      available: [{ ...MODEL, displayName: "Fake model" }],
      defaultModel: MODEL,
    },
  });
  cleanup.push(() => routes.close());
  const run = async (sessionId: string, text: string) => {
    await routes.operations.startTurn(auth(), "task-t1", sessionId, text);
    await routes.whenIdle("task-t1", sessionId);
  };
  return {
    root,
    folder,
    clone,
    backend,
    manager,
    runners,
    routes,
    run,
    lookups,
  };
}

describe("session runners", () => {
  it("run a task's turns, commands and tools in the runner, with models and tools on the control plane", async () => {
    const harness = await setup(async function* (request) {
      const results = request.messages.filter(
        (message) =>
          Array.isArray(message.content) &&
          message.content.some((block) => block.type === "tool_result"),
      ).length;
      if (results === 0) {
        yield* toolCall("execute_command", {
          command: "printf ran > proof.txt && pwd",
        });
      } else if (results === 1) {
        yield* toolCall("lookup", { q: "docs" });
      } else {
        yield* final("All done.");
      }
    });
    const { sessionId } = await harness.routes.operations.createSession(
      auth(),
      "task-t1",
    );
    await harness.run(sessionId, "Do the task");

    // The command ran in the runner, in the clone, without asking.
    await expect(
      fs.readFile(path.join(harness.clone, "proof.txt"), "utf8"),
    ).resolves.toBe("ran");
    // The model was called on the control plane, as the runner's project.
    expect(harness.backend.requests.length).toBe(3);
    expect(harness.backend.contexts[0]!.principal).toEqual({
      tenantId: "local",
      subjectId: "runner:task-t1",
    });
    // The host tool ran on the control plane for this runner's project.
    expect(harness.lookups).toEqual(["task-t1:docs"]);
    const read = await harness.routes.operations.readSession(
      auth(),
      "task-t1",
      sessionId,
    );
    expect(JSON.stringify(read.messages)).toContain("All done.");
    expect(harness.manager.starts).toBe(1);
  });

  it("keeps the session when the runner restarts, and starts it again on demand", async () => {
    const harness = await setup(async function* () {
      yield* final("Hello from the runner.");
    });
    const { sessionId } = await harness.routes.operations.createSession(
      auth(),
      "task-t1",
    );
    await harness.run(sessionId, "Say hello");
    // The runner goes away (crash, idle stop, host restart).
    await harness.runners.get("task-t1")!.close();
    harness.runners.delete("task-t1");

    const read = await harness.routes.operations.readSession(
      auth(),
      "task-t1",
      sessionId,
    );
    expect(JSON.stringify(read.messages)).toContain("Hello from the runner.");
    expect(harness.manager.starts).toBe(2);
    await harness.run(sessionId, "Again");
    expect(harness.backend.requests.at(-1)!.messages.length).toBeGreaterThan(2);
  });

  it("stops a running turn when the owner presses Stop", async () => {
    let seenAbort: AbortSignal | undefined;
    const harness = await setup(async function* (request) {
      seenAbort = request.signal;
      // A model call that streams once, then only ends when it is aborted.
      yield { type: "text_delta", text: "Working" };
      await new Promise<void>((resolve) => {
        if (request.signal?.aborted) resolve();
        request.signal?.addEventListener("abort", () => resolve(), {
          once: true,
        });
      });
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    });
    const { sessionId } = await harness.routes.operations.createSession(
      auth(),
      "task-t1",
    );
    await harness.routes.operations.startTurn(
      auth(),
      "task-t1",
      sessionId,
      "Work forever",
    );
    await vi.waitFor(() => expect(seenAbort).toBeDefined());
    await harness.routes.operations.cancel(auth(), "task-t1", sessionId);
    await harness.routes.whenIdle("task-t1", sessionId);
    expect(seenAbort!.aborted).toBe(true);
    const read = await harness.routes.operations.readSession(
      auth(),
      "task-t1",
      sessionId,
    );
    // The session is idle again and can take the next message.
    expect(read.messages.length).toBeGreaterThan(0);
  });

  it("refuses callers without the runner's token", async () => {
    const harness = await setup(async function* () {
      yield* final("ok");
    });
    const { sessionId } = await harness.routes.operations.createSession(
      auth(),
      "task-t1",
    );
    expect(sessionId).toBeTruthy();
    const runner = harness.runners.get("task-t1")!;
    const intruder = createRunnerHttpClient({
      baseUrl: `http://127.0.0.1:${runner.port}`,
      token: "not-the-token",
    });
    await expect(
      intruder.call("/call", { method: "listSessions", args: [] }),
    ).rejects.toMatchObject({ code: "unauthorized" });
  });
});

describe("the runner protocol", () => {
  it("passes interjections to the running turn, reports background agents and keeps error codes", async () => {
    let interjected: readonly { id: string; text: string }[] = [];
    let release!: () => void;
    const fake = {
      listSessions: vi.fn(async () => [
        {
          sessionId: "s1",
          updatedAt: 1,
          model: MODEL,
          reasoningEffort: undefined,
          state: "idle",
        },
        {
          sessionId: "child-1",
          updatedAt: 1,
          model: MODEL,
          reasoningEffort: undefined,
          state: "idle",
        },
      ]),
      isBackgroundSession: (sessionId: string) => sessionId === "child-1",
      readSession: vi.fn(async () => {
        throw Object.assign(new Error("Session not found"), {
          code: "session_not_found",
        });
      }),
      runTurn: vi.fn(
        async (
          _sessionId: string,
          _text: string,
          options: Parameters<RunnerHost["runTurn"]>[2],
        ) => {
          options?.onEvent?.({ type: "turn.started" } as never);
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          interjected = options?.takeInterjections?.() ?? [];
          return { status: "completed", text: "done" } as never;
        },
      ),
    } as unknown as RunnerHost;
    const state = createRunnerSessionState();
    const server = await startRunnerHttpServer({
      host: "127.0.0.1",
      port: 0,
      authorize: (token) => (token === "t" ? true : undefined),
      routes: () => runnerHostRoutes(fake, state),
      health: () => ({ busy: state.busy() }),
    });
    cleanup.push(() => server.close());
    const onAgentChanged = vi.fn();
    const host = createRemoteWorkspaceHost({
      client: createRunnerHttpClient({
        baseUrl: `http://127.0.0.1:${server.port}`,
        token: "t",
      }),
      start: async () => undefined,
      stop: async () => undefined,
      approvalMode: () => "ask",
      onAgentChanged,
      interjectionPollMs: 10,
    });
    cleanup.push(() => host.close());

    const events: unknown[] = [];
    const queue = [{ id: "i1", text: "also do this" }];
    const turn = host.runTurn("s1", "go", {
      onEvent: (event) => events.push(event),
      takeInterjections: () => queue.splice(0),
    });
    await vi.waitFor(() => expect(release).toBeDefined());
    await vi.waitFor(() =>
      expect(state.busy() && queue.length === 0).toBe(true),
    );
    // Give the poll's request time to land before the turn takes them.
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    await expect(turn).resolves.toMatchObject({ status: "completed" });
    expect(events).toEqual([{ type: "turn.started" }]);
    expect(interjected).toEqual([{ id: "i1", text: "also do this" }]);
    // The session's mode went with the turn.
    expect(state.autonomous({ sessionId: "s1" })).toBe(false);

    // Background children are known before anyone asks.
    expect(host.isBackgroundSession("child-1")).toBe(true);
    expect(host.isBackgroundSession("s1")).toBe(false);
    state.onAgentChanged({
      parentSessionId: "s1",
      childSessionId: "child-2",
      lifecycle: "running",
      phase: "executing_tool",
      resultState: "running",
    } as never);
    await vi.waitFor(() => expect(onAgentChanged).toHaveBeenCalled());
    expect(host.isBackgroundSession("child-2")).toBe(true);
    expect(state.busy()).toBe(true);

    await expect(host.readSession("s1")).rejects.toMatchObject({
      code: "session_not_found",
      message: "Session not found",
    });
  });
});
