import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import type { AgentConfig, AgentMessage } from "./types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentSessionManager } from "./AgentSessionManager.js";
import type { PersistedSessionRecord } from "./persistenceContracts.js";
import { ProviderRegistry } from "./providers/index.js";

const mocks = vi.hoisted(() => {
  const createSession = vi.fn(async (opts: any) => ({
    id: "session-1",
    mode: opts.mode,
    model: opts.config.model,
    providerId: opts.providerId,
    autoCondenseThreshold: opts.config.autoCondenseThreshold,
    title: "New Chat",
    background: Boolean(opts.background),
    status: "idle",
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheCreationTokens: 0,
    lastInputTokens: 0,
    lastOutputTokens: 0,
    lastCacheReadTokens: 0,
    currentTool: undefined,
    addUserMessage: vi.fn(),
    appendRuntimeError: vi.fn(),
    consumePendingInterjection: vi.fn(() => null),
    queuePendingModeResume: vi.fn(),
    consumePendingModeResume: vi.fn(() => null),
    autoTitle: vi.fn(),
    getAllMessages: vi.fn(() => []),
    rebuildSystemPrompt: vi.fn(async () => {}),
  }));

  return {
    createSession,
    getConfiguration: vi.fn(),
  };
});

vi.mock("vscode", async () => {
  const actual = await vi.importActual<typeof import("../__mocks__/vscode.js")>(
    "../__mocks__/vscode.js",
  );
  return {
    ...actual,
    workspace: {
      ...actual.workspace,
      getConfiguration: (...args: unknown[]) => mocks.getConfiguration(...args),
    },
  };
});

vi.mock("./AgentSession.js", () => ({
  AgentSession: {
    create: (opts: unknown) => mocks.createSession(opts),
  },
}));

async function flushPromises(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

const makeConfig = (): AgentConfig => ({
  model: "claude-sonnet-4-6",
  maxTokens: 8192,
  thinkingBudget: 0,
  showThinking: false,
  autoCondense: true,
  autoCondenseThreshold: 0.9,
});

describe("AgentSessionManager host injection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getConfiguration.mockReturnValue({
      get: () => undefined,
      inspect: () => undefined,
    });
  });

  it("uses injected host dependencies when creating foreground sessions", async () => {
    const providers = new ProviderRegistry();
    const createSession = vi.fn(
      (opts: Parameters<typeof mocks.createSession>[0]) =>
        mocks.createSession(opts),
    );
    const createActivityTraceRecorder = vi.fn(() => ({
      appendAgentEvent: vi.fn(),
    }));
    const createCheckpointManager = vi.fn(() => ({
      baseCommit: null,
      initialize: vi.fn(async () => undefined),
      createCheckpoint: vi.fn(async () => null),
      previewRevert: vi.fn(async () => null),
      revertToCheckpoint: vi.fn(async () => false),
      getDiffBetween: vi.fn(async () => ""),
    }));

    const mgr = new AgentSessionManager(
      makeConfig(),
      "/tmp",
      undefined,
      false,
      undefined,
      undefined,
      { maxConcurrent: 3 },
      {
        host: {
          workspace: {
            getWorkspaceFolders: () => [
              { name: "Injected", path: "/workspace/injected" },
            ],
          },
          config: {
            resolveModelForMode: () => "host-model",
            getCondenseThresholdForModel: () => 0.42,
            getBgSummaryMode: () => "heuristic",
          },
          providers,
          createSession: createSession as any,
          createActivityTraceRecorder,
          createCheckpointManager,
        },
      },
    );

    await mgr.createSession("code");

    expect(createActivityTraceRecorder).toHaveBeenCalledWith({
      workspaceDir: "/tmp",
    });
    expect(createCheckpointManager).toHaveBeenCalledWith({
      workspaceDir: "/tmp",
      taskId: "agent",
      log: expect.any(Function),
    });
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          model: "host-model",
          autoCondenseThreshold: 0.42,
        }),
        workspaceFolders: [{ name: "Injected", path: "/workspace/injected" }],
      }),
    );
  });

  it("memoizes the foreground engine and updates its runtime when tool context changes", async () => {
    const providers = new ProviderRegistry();
    const setToolRuntime = vi.fn();
    const createEngine = vi.fn(() => ({
      setToolRuntime,
      run: vi.fn(async function* () {}),
      condenseSession: vi.fn(async function* () {}),
      isOverCondenseThreshold: vi.fn(() => false),
    }));
    const runtimeA = { executeTool: vi.fn() };
    const runtimeB = { executeTool: vi.fn() };
    const createToolRuntime = vi
      .fn()
      .mockReturnValueOnce(runtimeA)
      .mockReturnValueOnce(runtimeB);

    const mgr = new AgentSessionManager(
      makeConfig(),
      "/tmp",
      undefined,
      false,
      undefined,
      undefined,
      { maxConcurrent: 3 },
      {
        host: {
          providers,
          createEngine: createEngine as any,
          createToolRuntime: createToolRuntime as any,
        },
      },
    );

    const ctxA = {
      approvalManager: {} as any,
      approvalPanel: {} as any,
      sessionId: "agent",
      extensionUri: {} as any,
    };
    const ctxB = { ...ctxA, sessionId: "agent-next" };

    mgr.setToolContext(ctxA);
    const first = (mgr as any).getEngine();
    const second = (mgr as any).getEngine();
    mgr.setToolContext(ctxB);

    expect(first).toBe(second);
    expect(createEngine).toHaveBeenCalledTimes(1);
    expect(createEngine).toHaveBeenCalledWith(providers, undefined);
    expect(createToolRuntime).toHaveBeenCalledTimes(2);
    expect(createToolRuntime).toHaveBeenNthCalledWith(1, ctxA);
    expect(createToolRuntime).toHaveBeenNthCalledWith(2, ctxB);
    expect(setToolRuntime).toHaveBeenNthCalledWith(1, runtimeA);
    expect(setToolRuntime).toHaveBeenNthCalledWith(2, runtimeB);
  });
});

describe("AgentSessionManager condense thresholds", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getConfiguration.mockReturnValue({
      get: (key: string) => {
        if (key === "modelCondenseThresholds") {
          return {
            "claude-sonnet-4-6": 0.72,
            "gpt-5.4": 0.83,
            "gpt-5.3-codex": 0.77,
          };
        }
        if (key === "modeModelPreferences") {
          return {
            code: "gpt-5.3-codex",
            architect: "gpt-5.4",
          };
        }
        return undefined;
      },
      inspect: () => undefined,
    });
  });

  it("uses mode-specific model preference when creating a session", async () => {
    const mgr = new AgentSessionManager(makeConfig(), "/tmp");

    await mgr.createSession("code");

    expect(mocks.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          model: "gpt-5.3-codex",
          autoCondenseThreshold: 0.77,
        }),
      }),
    );
  });

  it("applies persisted per-model thresholds when switching models", async () => {
    const mgr = new AgentSessionManager(makeConfig(), "/tmp");
    const session = await mgr.createSession("code");

    await mgr.setModel("gpt-5.4");

    expect(mgr.getConfig().autoCondenseThreshold).toBe(0.83);
    expect(session.model).toBe("gpt-5.4");
    expect(session.autoCondenseThreshold).toBe(0.83);
  });

  it("switchForegroundMode applies the target mode's preferred model", async () => {
    const mgr = new AgentSessionManager(makeConfig(), "/tmp");
    const session = await mgr.createSession("code");
    (session as any).setMode = vi.fn(async () => {});

    await mgr.switchForegroundMode("architect");

    expect(session.model).toBe("gpt-5.4");
    expect(session.autoCondenseThreshold).toBe(0.83);
    expect((session as any).setMode).toHaveBeenCalledWith(
      "architect",
      undefined,
    );
  });

  it("passes an MCP disclosure snapshot when MCP tools are connected", async () => {
    mocks.getConfiguration.mockReturnValue({
      get: () => ({}),
      inspect: () => undefined,
    });
    const mgr = new AgentSessionManager(makeConfig(), "/tmp");
    mgr.setToolContext({
      approvalManager: {} as any,
      approvalPanel: {} as any,
      sessionId: "agent",
      extensionUri: {} as any,
      mcpHub: {
        getToolDefs: () => [
          {
            name: "linear__list_issues",
            description: "List issues",
            input_schema: {
              type: "object",
              properties: { query: { type: "string" } },
            },
          },
          {
            name: "ddg-search__search",
            description: "Search the web",
            input_schema: { type: "object", properties: {} },
          },
        ],
        getServerConfig: (serverName: string) =>
          serverName === "linear" ? { toolDisclosure: "deferred" } : undefined,
      } as any,
    });

    await mgr.createSession("code");

    expect(mocks.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        mcpToolDisclosure: expect.objectContaining({
          inlineTools: [
            expect.objectContaining({ name: "ddg-search__search" }),
          ],
          deferredTools: [
            expect.objectContaining({ name: "linear__list_issues" }),
          ],
          catalog: expect.arrayContaining([
            expect.objectContaining({
              serverName: "ddg-search",
              toolCount: 1,
              representativeTools: ["search"],
              capabilities: ["web-search"],
            }),
            expect.objectContaining({
              serverName: "linear",
              toolCount: 1,
              representativeTools: ["list_issues"],
            }),
          ]),
        }),
      }),
    );
  });

  it("falls back to model-family defaults when there is no stored override", async () => {
    mocks.getConfiguration.mockReturnValue({
      get: () => ({}),
      inspect: () => undefined,
    });
    const mgr = new AgentSessionManager(makeConfig(), "/tmp");

    await mgr.createSession("code");

    expect(mocks.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          model: "claude-sonnet-4-6",
          autoCondenseThreshold: 0.6,
        }),
      }),
    );
  });

  it("falls back to default threshold resolution when config access fails", async () => {
    mocks.getConfiguration.mockImplementation(() => {
      throw new Error("boom");
    });
    const log = vi.fn();
    const mgr = new AgentSessionManager(
      makeConfig(),
      "/tmp",
      undefined,
      false,
      undefined,
      log,
    );

    await mgr.createSession("code");

    expect(mocks.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          model: "claude-sonnet-4-6",
          autoCondenseThreshold: 0.6,
        }),
      }),
    );
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining(
        "Failed to resolve configured condense threshold for claude-sonnet-4-6",
      ),
    );
  });
});

describe("AgentSessionManager manual condense", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getConfiguration.mockReturnValue({
      get: () => undefined,
      inspect: () => undefined,
    });
  });

  it("continues the agent turn after a successful manual condense", async () => {
    const mgr = new AgentSessionManager(makeConfig(), "/tmp");
    const session = await mgr.createSession("code");
    session.status = "idle";
    (session as any).loadedSkills = new Set<string>();
    (mgr as any).foregroundId = session.id;

    const onEvent = vi.fn();
    mgr.onEvent = onEvent;

    const engine = {
      condenseSession: vi.fn(async function* () {
        yield { type: "condense_start", isAutomatic: false };
        yield {
          type: "condense",
          summary: "summary",
          prevInputTokens: 10_000,
          newInputTokens: 2_000,
        };
      }),
      run: vi.fn(async function* () {
        yield { type: "text_delta", text: "continued" };
        yield {
          type: "done",
          totalInputTokens: 10,
          totalOutputTokens: 5,
          totalCacheReadTokens: 0,
          totalCacheCreationTokens: 0,
        };
      }),
      isOverCondenseThreshold: vi.fn(() => false),
    };

    (mgr as any).engine = engine;

    await mgr.condenseCurrentSession();

    expect(engine.condenseSession).toHaveBeenCalledTimes(1);
    expect(engine.run).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith(
      session.id,
      expect.objectContaining({ type: "condense" }),
    );
    expect(onEvent).toHaveBeenCalledWith(
      session.id,
      expect.objectContaining({ type: "text_delta", text: "continued" }),
    );
    expect(session.status).toBe("idle");
  });

  it("does not continue the agent turn when manual condense does not succeed", async () => {
    const mgr = new AgentSessionManager(makeConfig(), "/tmp");
    const session = await mgr.createSession("code");
    session.status = "idle";
    (session as any).loadedSkills = new Set<string>();
    (mgr as any).foregroundId = session.id;

    const engine = {
      condenseSession: vi.fn(async function* () {
        yield { type: "condense_start", isAutomatic: false };
        yield { type: "condense_error", error: "failed" };
      }),
      run: vi.fn(async function* () {
        yield { type: "text_delta", text: "continued" };
      }),
      isOverCondenseThreshold: vi.fn(() => false),
    };

    (mgr as any).engine = engine;

    await mgr.condenseCurrentSession();

    expect(engine.condenseSession).toHaveBeenCalledTimes(1);
    expect(engine.run).not.toHaveBeenCalled();
  });
});

describe("AgentSessionManager in-flight persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mocks.getConfiguration.mockReturnValue({
      get: () => undefined,
      inspect: () => undefined,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("serializes immediate revision-aware saves so create is followed by update", async () => {
    const expectedRevisions: Array<string | null> = [];
    const store = {
      saveSession: vi.fn(async (args: { expectedRevision: string | null }) => {
        expectedRevisions.push(args.expectedRevision);
        return { ok: true, revision: String(expectedRevisions.length) };
      }),
      list: vi.fn(() => []),
      get: vi.fn(),
      loadMessages: vi.fn(),
      loadMetadata: vi.fn(),
    } as any;

    const mgr = new AgentSessionManager(
      makeConfig(),
      "/tmp",
      undefined,
      false,
      store,
    );
    const session = await mgr.createSession("code");
    (session as any).getAllMessages = vi.fn(() => [
      { role: "user", content: "first" },
    ]);

    mgr.saveSession(session.id);
    mgr.saveSession(session.id);
    await flushPromises();
    await flushPromises();

    expect(expectedRevisions).toEqual([null, "1"]);
  });

  it("periodically saves session progress before done while a turn is in-flight", async () => {
    const savedCounts: number[] = [];
    const store = {
      save: vi.fn((entry: { getAllMessages: () => AgentMessage[] }) => {
        savedCounts.push(entry.getAllMessages().length);
      }),
      list: vi.fn(() => []),
      get: vi.fn(),
      loadMessages: vi.fn(),
      loadMetadata: vi.fn(),
    } as any;

    const mgr = new AgentSessionManager(
      makeConfig(),
      "/tmp",
      undefined,
      false,
      store,
    );

    const session = await mgr.createSession("code");
    const messages: AgentMessage[] = [];
    (session as any).getAllMessages = vi.fn(() => messages);
    (session as any).addUserMessage = vi.fn((text: string) => {
      messages.push({ role: "user", content: text });
      session.lastActiveAt = Date.now();
    });
    (session as any).appendAssistantTurn = vi.fn((content: unknown) => {
      messages.push({ role: "assistant", content: content as any });
      session.lastActiveAt = Date.now();
    });
    (session as any).appendToolResults = vi.fn((results: unknown) => {
      messages.push({ role: "user", content: results as any });
      session.lastActiveAt = Date.now();
    });

    const engine = {
      run: vi.fn(async function* (s: any) {
        yield { type: "text_delta", text: "partial" };
        await new Promise<void>((resolve) => setTimeout(resolve, 1300));
        s.appendAssistantTurn([{ type: "text", text: "assistant partial" }]);
        yield { type: "tool_start", toolCallId: "t1", toolName: "read_file" };
        await new Promise<void>((resolve) => setTimeout(resolve, 1300));
        s.appendToolResults([
          { type: "tool_result", tool_use_id: "t1", content: "ok" },
        ]);
        yield {
          type: "done",
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalCacheReadTokens: 0,
          totalCacheCreationTokens: 0,
        };
      }),
    };

    (mgr as any).engine = engine;

    const sendPromise = mgr.sendMessage(session.id, "start", session.mode);
    await vi.advanceTimersByTimeAsync(3500);
    await sendPromise;

    const inFlightSaveOccurred = savedCounts.some((count) => count >= 2);
    expect(inFlightSaveOccurred).toBe(true);
  });
});

describe("AgentSessionManager activity tracing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getConfiguration.mockReturnValue({
      get: () => undefined,
      inspect: () => undefined,
    });
  });

  it("records forwarded agent events to a bounded session trace", async () => {
    const workspace = fs.mkdtempSync(
      path.join(os.tmpdir(), "agentlink-manager-trace-"),
    );
    try {
      const mgr = new AgentSessionManager(makeConfig(), workspace);
      const session = await mgr.createSession("code");
      (session as any).messageCount = 0;
      (session as any).isAborted = false;
      (session as any).getAllMessages = vi.fn(() => []);
      (session as any).addUserMessage = vi.fn(() => {
        (session as any).messageCount += 1;
        session.lastActiveAt = Date.now();
      });
      (session as any).autoTitle = vi.fn();
      (session as any).consumePendingInterjection = vi.fn(() => null);
      (session as any).consumePendingModeResume = vi.fn(() => null);

      const engine = {
        run: vi.fn(async function* () {
          yield {
            type: "tool_start",
            toolCallId: "tool-1",
            toolName: "read_file",
          };
          yield {
            type: "tool_result",
            toolCallId: "tool-1",
            toolName: "read_file",
            result: [{ type: "text", text: "ok" }],
            durationMs: 12,
            input: { path: "src/example.ts" },
          };
          yield {
            type: "api_request",
            requestId: "req-1",
            model: "model-a",
            inputTokens: 100,
            uncachedInputTokens: 80,
            outputTokens: 25,
            cacheReadTokens: 10,
            cacheCreationTokens: 5,
            durationMs: 50,
            timeToFirstToken: 10,
          };
          yield {
            type: "done",
            totalInputTokens: 100,
            totalOutputTokens: 25,
            totalCacheReadTokens: 10,
            totalCacheCreationTokens: 5,
          };
        }),
      };
      (mgr as any).engine = engine;

      await mgr.sendMessage(session.id, "start", session.mode);

      const sessionDir = path.join(
        workspace,
        ".agentlink",
        "history",
        session.id,
      );
      const tracePath = path.join(sessionDir, "activity-trace.jsonl");
      const summaryPath = path.join(sessionDir, "activity-trace-summary.json");
      const traceLines = fs
        .readFileSync(tracePath, "utf-8")
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line) as { kind: string });
      const summary = JSON.parse(fs.readFileSync(summaryPath, "utf-8"));

      expect(traceLines.map((event) => event.kind)).toEqual([
        "tool_start",
        "tool_result",
        "api_request",
        "done",
      ]);
      expect(summary).toMatchObject({
        eventCount: 4,
        toolCalls: 1,
        toolCallsByName: { read_file: 1 },
        apiCalls: 1,
        totalInputTokens: 100,
        totalOutputTokens: 25,
        totalCacheReadTokens: 10,
        totalCacheCreationTokens: 5,
      });
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});

describe("AgentSessionManager checkpoints", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getConfiguration.mockReturnValue({
      get: () => undefined,
      inspect: () => undefined,
    });
  });

  it("renames unloaded persisted sessions with the current stored revision", async () => {
    const summary = {
      id: "session-1",
      mode: "code",
      model: "claude-sonnet-4-6",
      title: "Old title",
      messageCount: 1,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      createdAt: 100,
      lastActiveAt: 123,
      schemaVersion: 1,
    };
    const renameSession = vi.fn(async () => ({ ok: true, revision: "6" }));
    const store = {
      renameSession,
      readSession: vi.fn(async () => ({
        ok: true,
        revision: "5",
        value: {
          summary,
          messages: [{ role: "user", content: "persisted" }],
          metadata: {
            mode: "code",
            model: "claude-sonnet-4-6",
            totalInputTokens: 0,
            totalOutputTokens: 0,
            checkpointState: { baseCommit: null, checkpoints: [] },
          },
        },
      })),
      list: vi.fn(() => []),
      get: vi.fn(() => summary),
      loadMessages: vi.fn(() => []),
      loadMetadata: vi.fn(() => null),
    } as any;

    const mgr = new AgentSessionManager(
      makeConfig(),
      "/tmp",
      undefined,
      false,
      store,
    );

    await expect(
      mgr.renamePersistedSession("session-1", "New title"),
    ).resolves.toBe(true);
    expect(renameSession).toHaveBeenCalledWith({
      sessionId: "session-1",
      title: "New title",
      expectedRevision: "5",
    });
  });

  it("returns conflict details when persisted session rename sees a stale revision", async () => {
    const summary = {
      id: "session-1",
      mode: "code",
      model: "claude-sonnet-4-6",
      title: "Old title",
      messageCount: 1,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      createdAt: 100,
      lastActiveAt: 123,
      schemaVersion: 1,
    };
    const renameSession = vi.fn(async () => ({
      ok: false,
      reason: "conflict",
      currentRevision: "6",
    }));
    const log = vi.fn();
    const store = {
      renameSession,
      readSession: vi.fn(async () => ({
        ok: true,
        revision: "5",
        value: {
          summary,
          messages: [{ role: "user", content: "persisted" }],
          metadata: {
            mode: "code",
            model: "claude-sonnet-4-6",
            totalInputTokens: 0,
            totalOutputTokens: 0,
            checkpointState: { baseCommit: null, checkpoints: [] },
          },
        },
      })),
      list: vi.fn(() => []),
      get: vi.fn(() => summary),
      loadMessages: vi.fn(() => []),
      loadMetadata: vi.fn(() => null),
    } as any;

    const mgr = new AgentSessionManager(
      makeConfig(),
      "/tmp",
      undefined,
      false,
      store,
      log,
    );

    await expect(
      mgr.renamePersistedSessionWithResult("session-1", "New title"),
    ).resolves.toEqual({
      ok: false,
      operation: "rename",
      reason: "conflict",
      currentRevision: "6",
    });
    await expect(
      mgr.renamePersistedSession("session-1", "New title"),
    ).resolves.toBe(false);
    expect(log).toHaveBeenCalledWith(
      "[session] persistence rename conflict for session-1: current=6",
    );
  });

  it("deletes loaded persisted sessions with the tracked revision", async () => {
    const summary = {
      id: "session-1",
      mode: "code",
      model: "claude-sonnet-4-6",
      title: "Loaded session",
      messageCount: 1,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      createdAt: 100,
      lastActiveAt: 123,
      schemaVersion: 1,
    };
    const deleteSession = vi.fn(async () => ({ ok: true, revision: "4" }));
    const store = {
      deleteSession,
      readSession: vi.fn(async () => ({
        ok: true,
        revision: "3",
        value: {
          summary,
          messages: [{ role: "user", content: "persisted" }],
          metadata: {
            mode: "code",
            model: "claude-sonnet-4-6",
            totalInputTokens: 0,
            totalOutputTokens: 0,
            checkpointState: { baseCommit: null, checkpoints: [] },
          },
        },
      })),
      list: vi.fn(() => []),
      get: vi.fn(() => summary),
      loadMessages: vi.fn(() => []),
      loadMetadata: vi.fn(() => null),
    } as any;

    const mgr = new AgentSessionManager(
      makeConfig(),
      "/tmp",
      undefined,
      false,
      store,
    );
    const session = await mgr.createSession("code");
    expect(session.id).toBe("session-1");
    const loaded = await mgr.loadPersistedSession("session-1");
    expect(loaded).toBe(session);

    await expect(mgr.deletePersistedSession("session-1")).resolves.toBe(true);
    expect(deleteSession).toHaveBeenCalledWith({
      sessionId: "session-1",
      expectedRevision: "3",
    });
    expect(mgr.getSession("session-1")).toBeUndefined();
  });

  it("returns ownership details when persisted session rename is owned elsewhere", async () => {
    const summary = {
      id: "session-1",
      mode: "code",
      model: "claude-sonnet-4-6",
      title: "Old title",
      messageCount: 1,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      createdAt: 100,
      lastActiveAt: 123,
      schemaVersion: 1,
    };
    const renameSession = vi.fn(async () => ({
      ok: false,
      reason: "not_owner",
      owner: { ownerId: "other", surface: "cli", startedAt: 99 },
    }));
    const store = {
      renameSession,
      readSession: vi.fn(async () => ({
        ok: true,
        revision: "5",
        value: {
          summary,
          messages: [{ role: "user", content: "persisted" }],
          metadata: {
            mode: "code",
            model: "claude-sonnet-4-6",
            totalInputTokens: 0,
            totalOutputTokens: 0,
            checkpointState: { baseCommit: null, checkpoints: [] },
          },
        },
      })),
      list: vi.fn(() => []),
      get: vi.fn(() => summary),
      loadMessages: vi.fn(() => []),
      loadMetadata: vi.fn(() => null),
    } as any;

    const mgr = new AgentSessionManager(
      makeConfig(),
      "/tmp",
      undefined,
      false,
      store,
    );

    await expect(
      mgr.renamePersistedSessionWithResult("session-1", "New title"),
    ).resolves.toEqual({
      ok: false,
      operation: "rename",
      reason: "not_owner",
      message: undefined,
    });
  });

  it("returns IO details when persisted session delete fails", async () => {
    const summary = {
      id: "session-1",
      mode: "code",
      model: "claude-sonnet-4-6",
      title: "Loaded session",
      messageCount: 1,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      createdAt: 100,
      lastActiveAt: 123,
      schemaVersion: 1,
    };
    const deleteSession = vi.fn(async () => ({
      ok: false,
      reason: "io_error",
      message: "disk full",
    }));
    const store = {
      deleteSession,
      readSession: vi.fn(async () => ({
        ok: true,
        revision: "3",
        value: {
          summary,
          messages: [{ role: "user", content: "persisted" }],
          metadata: {
            mode: "code",
            model: "claude-sonnet-4-6",
            totalInputTokens: 0,
            totalOutputTokens: 0,
            checkpointState: { baseCommit: null, checkpoints: [] },
          },
        },
      })),
      list: vi.fn(() => []),
      get: vi.fn(() => summary),
      loadMessages: vi.fn(() => []),
      loadMetadata: vi.fn(() => null),
    } as any;

    const mgr = new AgentSessionManager(
      makeConfig(),
      "/tmp",
      undefined,
      false,
      store,
    );

    await expect(
      mgr.deletePersistedSessionWithResult("session-1"),
    ).resolves.toEqual({
      ok: false,
      operation: "delete",
      reason: "io_error",
      message: "disk full",
    });
    await expect(mgr.deletePersistedSession("session-1")).resolves.toBe(false);
  });

  it("does not replace a newer tracked revision when loading an already live session", async () => {
    const saveSession = vi.fn(
      async (args: { expectedRevision: string | null }) => {
        if (args.expectedRevision === null) return { ok: true, revision: "2" };
        return { ok: true, revision: "3" };
      },
    );
    const summary = {
      id: "session-1",
      mode: "code",
      model: "claude-sonnet-4-6",
      title: "Live session",
      messageCount: 1,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      createdAt: 100,
      lastActiveAt: 123,
      schemaVersion: 1,
    };
    const store = {
      saveSession,
      readSession: vi.fn(async () => ({
        ok: true,
        revision: "1",
        value: {
          summary,
          messages: [{ role: "user", content: "persisted" }],
          metadata: {
            mode: "code",
            model: "claude-sonnet-4-6",
            totalInputTokens: 0,
            totalOutputTokens: 0,
            checkpointState: { baseCommit: null, checkpoints: [] },
          },
        },
      })),
      list: vi.fn(() => []),
      get: vi.fn(() => summary),
      loadMessages: vi.fn(() => []),
      loadMetadata: vi.fn(() => null),
    } as any;

    const mgr = new AgentSessionManager(
      makeConfig(),
      "/tmp",
      undefined,
      false,
      store,
    );
    const session = await mgr.createSession("code");
    (session as any).getAllMessages = vi.fn(() => [
      { role: "user", content: "live" },
    ]);

    mgr.saveSession(session.id);
    await flushPromises();

    const loaded = await mgr.loadPersistedSession(session.id);
    expect(loaded).toBe(session);

    mgr.saveSession(session.id);
    await flushPromises();

    expect(
      saveSession.mock.calls.map(([args]) => args.expectedRevision),
    ).toEqual([null, "2"]);
  });

  it("creates an idempotent checkpoint for each completed user turn", async () => {
    const mgr = new AgentSessionManager(makeConfig(), "/tmp");
    const session = await mgr.createSession("code");
    const messages: AgentMessage[] = [];
    (session as any).messageCount = 0;
    (session as any).isAborted = false;
    (session as any).lastActiveAt = 123;
    (session as any).getAllMessages = vi.fn(() => messages);
    (session as any).addUserMessage = vi.fn((text: string) => {
      messages.push({ role: "user", content: text });
      (session as any).messageCount = messages.length;
      session.lastActiveAt += 1;
    });
    (session as any).consumePendingInterjection = vi.fn(() => null);
    (session as any).consumePendingModeResume = vi.fn(() => null);
    (session as any).autoTitle = vi.fn();

    const checkpointManager = {
      createCheckpoint: vi
        .fn()
        .mockResolvedValueOnce({
          id: "cp-turn-1",
          commitHash: "hash-1",
          turnIndex: 1,
          createdAt: 111,
        })
        .mockResolvedValueOnce({
          id: "cp-turn-1-refresh",
          commitHash: "hash-1-refreshed",
          turnIndex: 1,
          createdAt: 222,
        })
        .mockResolvedValueOnce({
          id: "cp-turn-2",
          commitHash: "hash-2",
          turnIndex: 2,
          createdAt: 333,
        }),
    };
    (mgr as any).checkpointManager = checkpointManager;

    const engine = {
      run: vi.fn(async function* () {
        yield {
          type: "done",
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalCacheReadTokens: 0,
          totalCacheCreationTokens: 0,
        };
      }),
    };
    (mgr as any).engine = engine;

    const onEvent = vi.fn();
    mgr.onEvent = onEvent;

    await mgr.sendMessage(session.id, "first prompt", session.mode);
    await mgr.sendMessage(session.id, "second prompt", session.mode);

    expect(checkpointManager.createCheckpoint).toHaveBeenCalledTimes(3);
    expect(checkpointManager.createCheckpoint).toHaveBeenNthCalledWith(1, 1);
    expect(checkpointManager.createCheckpoint).toHaveBeenNthCalledWith(2, 1);
    expect(checkpointManager.createCheckpoint).toHaveBeenNthCalledWith(3, 2);
    expect(mgr.getCheckpoints(session.id)).toEqual([
      expect.objectContaining({
        id: "cp-turn-1",
        commitHash: "hash-1-refreshed",
        turnIndex: 1,
        createdAt: 222,
      }),
      expect.objectContaining({
        id: "cp-turn-2",
        commitHash: "hash-2",
        turnIndex: 2,
        createdAt: 333,
      }),
    ]);
    expect(onEvent).toHaveBeenCalledWith(
      session.id,
      expect.objectContaining({
        type: "checkpoint_created",
        checkpointId: "cp-turn-1",
        turnIndex: 1,
      }),
    );
    expect(onEvent).toHaveBeenCalledWith(
      session.id,
      expect.objectContaining({
        type: "checkpoint_created",
        checkpointId: "cp-turn-2",
        turnIndex: 2,
      }),
    );
  });

  it("creates a checkpoint when a queued message is injected mid-turn", async () => {
    const mgr = new AgentSessionManager(makeConfig(), "/tmp");
    const session = await mgr.createSession("code");
    const messages: AgentMessage[] = [];
    (session as any).messageCount = 0;
    (session as any).isAborted = false;
    (session as any).lastActiveAt = 123;
    (session as any).getAllMessages = vi.fn(() => messages);
    (session as any).addUserMessage = vi.fn((text: string) => {
      messages.push({ role: "user", content: text });
      (session as any).messageCount = messages.length;
      session.lastActiveAt += 1;
    });
    (session as any).consumePendingInterjection = vi.fn(() => null);
    (session as any).consumePendingModeResume = vi.fn(() => null);
    (session as any).autoTitle = vi.fn();

    const checkpointManager = {
      createCheckpoint: vi
        .fn()
        .mockResolvedValueOnce({
          id: "cp-before-interjection",
          commitHash: "hash-before-interjection",
          turnIndex: 1,
          createdAt: 111,
        })
        .mockResolvedValueOnce({
          id: "cp-after-interjection",
          commitHash: "hash-after-interjection",
          turnIndex: 2,
          createdAt: 222,
        }),
    };
    (mgr as any).checkpointManager = checkpointManager;

    const engine = {
      run: vi.fn(async function* () {
        messages.push({ role: "user", content: "queued prompt" });
        (session as any).messageCount = messages.length;
        session.lastActiveAt += 1;
        yield {
          type: "user_interjection",
          text: "queued prompt",
          queueId: "queue-1",
        };
        yield {
          type: "done",
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalCacheReadTokens: 0,
          totalCacheCreationTokens: 0,
        };
      }),
    };
    (mgr as any).engine = engine;

    const onEvent = vi.fn();
    mgr.onEvent = onEvent;

    await mgr.sendMessage(session.id, "first prompt", session.mode);

    expect(checkpointManager.createCheckpoint).toHaveBeenCalledTimes(2);
    expect(checkpointManager.createCheckpoint).toHaveBeenNthCalledWith(1, 1);
    expect(checkpointManager.createCheckpoint).toHaveBeenNthCalledWith(2, 2);
    expect(mgr.getCheckpoints(session.id)).toEqual([
      expect.objectContaining({
        id: "cp-before-interjection",
        turnIndex: 1,
      }),
      expect.objectContaining({
        id: "cp-after-interjection",
        turnIndex: 2,
      }),
    ]);
    expect(onEvent).toHaveBeenCalledWith(
      session.id,
      expect.objectContaining({
        type: "checkpoint_created",
        checkpointId: "cp-before-interjection",
        turnIndex: 1,
      }),
    );
  });

  it("returns session and persistence revisions with checkpoint revert previews", async () => {
    const sessionMessages: AgentMessage[] = [
      { role: "user", content: "first prompt" },
      { role: "assistant", content: "first answer" },
      { role: "user", content: "second prompt" },
    ];
    const session: any = {
      id: "session-1",
      mode: "code",
      model: "claude-sonnet-4-6",
      providerId: undefined,
      autoCondenseThreshold: 0.9,
      title: "Checkpoint test",
      background: false,
      status: "idle",
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
      lastInputTokens: 0,
      lastOutputTokens: 0,
      lastCacheReadTokens: 0,
      currentTool: undefined,
      addUserMessage: vi.fn(),
      appendRuntimeError: vi.fn(),
      consumePendingInterjection: vi.fn(() => null),
      queuePendingModeResume: vi.fn(),
      consumePendingModeResume: vi.fn(() => null),
      autoTitle: vi.fn(),
      getAllMessages: vi.fn(() => sessionMessages),
      getLoadedSkills: vi.fn(() => []),
      replaceMessages: vi.fn(),
      restoreFromStore: vi.fn((data: { messages: AgentMessage[] }) => {
        sessionMessages.splice(0, sessionMessages.length, ...data.messages);
      }),
      rebuildSystemPrompt: vi.fn(async () => {}),
      lastActiveAt: 123,
      createdAt: 100,
    };
    mocks.createSession.mockResolvedValueOnce(session);

    const summary = {
      id: "session-1",
      mode: "code",
      model: "claude-sonnet-4-6",
      title: "Checkpoint test",
      messageCount: 3,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      createdAt: 100,
      lastActiveAt: 123,
      schemaVersion: 1,
    };
    const store = {
      readSession: vi.fn(async () => ({
        ok: true,
        revision: "persisted-1",
        value: {
          summary,
          messages: sessionMessages,
          metadata: {
            mode: "code",
            model: "claude-sonnet-4-6",
            totalInputTokens: 0,
            totalOutputTokens: 0,
            checkpointState: {
              baseCommit: null,
              checkpoints: [
                {
                  id: "cp-1",
                  commitHash: "hash-1",
                  turnIndex: 1,
                  createdAt: 111,
                },
              ],
            },
          },
        },
      })),
      get: vi.fn(() => summary),
      loadMessages: vi.fn(() => sessionMessages),
      loadMetadata: vi.fn(() => null),
      list: vi.fn(() => []),
    } as any;

    const mgr = new AgentSessionManager(
      makeConfig(),
      "/tmp",
      undefined,
      false,
      store,
    );
    await mgr.loadPersistedSession("session-1");

    const checkpointManager = {
      previewRevert: vi.fn(async () => ({
        modified: ["src/a.ts"],
        deleted: [],
        restored: [],
      })),
    };
    (mgr as any).checkpointManager = checkpointManager;

    const preview = await mgr.previewRevert("session-1", "cp-1");

    expect(preview).toEqual({
      checkpointId: "cp-1",
      sessionRevision: expect.any(String),
      persistenceRevision: "persisted-1",
      workspaceRevision: "hash-1",
      preview: { modified: ["src/a.ts"], deleted: [], restored: [] },
    });
  });

  it("reverts to the selected checkpoint snapshot and persists checkpoint metadata", async () => {
    const sessionMessages: AgentMessage[] = [
      { role: "user", content: "first prompt" },
      { role: "assistant", content: "first answer" },
      { role: "user", content: "second prompt" },
      { role: "assistant", content: "second answer" },
    ];

    const replaceMessages = vi.fn((messages: AgentMessage[]) => {
      sessionMessages.splice(0, sessionMessages.length, ...messages);
    });

    const session: any = {
      id: "session-1",
      mode: "code",
      model: "claude-sonnet-4-6",
      providerId: undefined,
      autoCondenseThreshold: 0.9,
      title: "Checkpoint test",
      background: false,
      status: "idle",
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
      lastInputTokens: 0,
      lastOutputTokens: 0,
      lastCacheReadTokens: 0,
      currentTool: undefined,
      addUserMessage: vi.fn(),
      appendRuntimeError: vi.fn(),
      consumePendingInterjection: vi.fn(() => null),
      queuePendingModeResume: vi.fn(),
      consumePendingModeResume: vi.fn(() => null),
      autoTitle: vi.fn(),
      getAllMessages: vi.fn(() => sessionMessages),
      getLoadedSkills: vi.fn(() => []),
      replaceMessages,
      restoreFromStore: vi.fn((data: { messages: AgentMessage[] }) => {
        sessionMessages.splice(0, sessionMessages.length, ...data.messages);
      }),
      rebuildSystemPrompt: vi.fn(async () => {}),
      lastActiveAt: 123,
      createdAt: 100,
    };
    mocks.createSession.mockResolvedValueOnce(session);

    const saveSession = vi.fn(
      async (_args: { session: PersistedSessionRecord }) => ({
        ok: true,
        revision: "2",
      }),
    );
    const summary = {
      id: "session-1",
      mode: "code",
      model: "claude-sonnet-4-6",
      title: "Checkpoint test",
      messageCount: 4,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      createdAt: 100,
      lastActiveAt: 123,
      schemaVersion: 1,
    };
    const store = {
      saveSession,
      readSession: vi.fn(async () => ({
        ok: true,
        revision: "1",
        value: {
          summary,
          messages: sessionMessages,
          metadata: {
            mode: "code",
            model: "claude-sonnet-4-6",
            totalInputTokens: 0,
            totalOutputTokens: 0,
            checkpointState: {
              baseCommit: null,
              checkpoints: [
                {
                  id: "cp-1",
                  commitHash: "hash-1",
                  turnIndex: 1,
                  createdAt: 111,
                },
                {
                  id: "cp-2",
                  commitHash: "hash-2",
                  turnIndex: 2,
                  createdAt: 222,
                },
              ],
            },
          },
        },
      })),
      get: vi.fn(() => summary),
      loadMessages: vi.fn(() => sessionMessages),
      loadMetadata: vi.fn(() => ({
        schemaVersion: 1,
        mode: "code",
        model: "claude-sonnet-4-6",
        totalInputTokens: 0,
        totalOutputTokens: 0,
        checkpoints: [],
      })),
      list: vi.fn(() => []),
    } as any;

    const mgr = new AgentSessionManager(
      makeConfig(),
      "/tmp",
      undefined,
      false,
      store,
    );
    const loaded = await mgr.loadPersistedSession("session-1");
    expect(loaded).toBe(session);

    const checkpointManager = {
      revertToCheckpoint: vi.fn(async () => true),
    };
    (mgr as any).checkpointManager = checkpointManager;

    const result = await mgr.revertToCheckpoint("session-1", "cp-1");

    expect(result).toEqual({
      ok: true,
      restoredPrompt: "second prompt",
      sessionRevision: "2",
    });
    expect(checkpointManager.revertToCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({ id: "cp-1", turnIndex: 1 }),
    );
    expect(replaceMessages).toHaveBeenCalledWith([
      { role: "user", content: "first prompt" },
      { role: "assistant", content: "first answer" },
    ]);
    expect(mgr.getCheckpoints("session-1")).toEqual([
      {
        id: "cp-1",
        commitHash: "hash-1",
        turnIndex: 1,
        createdAt: 111,
      },
    ]);
    expect(saveSession).toHaveBeenCalled();
    const lastSaveArg = saveSession.mock.lastCall![0].session;
    expect(lastSaveArg?.metadata.checkpointState?.checkpoints).toEqual([
      {
        id: "cp-1",
        commitHash: "hash-1",
        turnIndex: 1,
        createdAt: 111,
      },
    ]);
    expect(lastSaveArg?.messages).toEqual([
      { role: "user", content: "first prompt" },
      { role: "assistant", content: "first answer" },
    ]);
  });

  it("persists revertPending when workspace revert succeeds but session save conflicts", async () => {
    const sessionMessages: AgentMessage[] = [
      { role: "user", content: "first prompt" },
      { role: "assistant", content: "first answer" },
      { role: "user", content: "second prompt" },
      { role: "assistant", content: "second answer" },
    ];
    const replaceMessages = vi.fn((messages: AgentMessage[]) => {
      sessionMessages.splice(0, sessionMessages.length, ...messages);
    });
    const session: any = {
      id: "session-1",
      mode: "code",
      model: "claude-sonnet-4-6",
      providerId: undefined,
      autoCondenseThreshold: 0.9,
      title: "Checkpoint test",
      background: false,
      status: "idle",
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
      lastInputTokens: 0,
      lastOutputTokens: 0,
      lastCacheReadTokens: 0,
      currentTool: undefined,
      addUserMessage: vi.fn(),
      appendRuntimeError: vi.fn(),
      consumePendingInterjection: vi.fn(() => null),
      queuePendingModeResume: vi.fn(),
      consumePendingModeResume: vi.fn(() => null),
      autoTitle: vi.fn(),
      getAllMessages: vi.fn(() => sessionMessages),
      getLoadedSkills: vi.fn(() => []),
      replaceMessages,
      restoreFromStore: vi.fn((data: { messages: AgentMessage[] }) => {
        sessionMessages.splice(0, sessionMessages.length, ...data.messages);
      }),
      rebuildSystemPrompt: vi.fn(async () => {}),
      lastActiveAt: 123,
      createdAt: 100,
    };
    mocks.createSession.mockResolvedValueOnce(session);

    const summary = {
      id: "session-1",
      mode: "code",
      model: "claude-sonnet-4-6",
      title: "Checkpoint test",
      messageCount: 4,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      createdAt: 100,
      lastActiveAt: 123,
      schemaVersion: 1,
    };
    const persistedRecord = {
      summary,
      messages: sessionMessages,
      metadata: {
        mode: "code",
        model: "claude-sonnet-4-6",
        totalInputTokens: 0,
        totalOutputTokens: 0,
        checkpointState: {
          baseCommit: null,
          checkpoints: [
            {
              id: "cp-1",
              commitHash: "hash-1",
              turnIndex: 1,
              createdAt: 111,
            },
          ],
        },
      },
    } satisfies PersistedSessionRecord;
    const saveSession = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        reason: "conflict",
        currentRevision: "2",
      })
      .mockResolvedValueOnce({ ok: true, revision: "3" });
    const store = {
      saveSession,
      readSession: vi.fn(async () => ({
        ok: true,
        revision: "1",
        value: persistedRecord,
      })),
      get: vi.fn(() => summary),
      loadMessages: vi.fn(() => sessionMessages),
      loadMetadata: vi.fn(() => null),
      list: vi.fn(() => []),
    } as any;

    const mgr = new AgentSessionManager(
      makeConfig(),
      "/tmp",
      undefined,
      false,
      store,
    );
    await mgr.loadPersistedSession("session-1");

    const checkpointManager = {
      revertToCheckpoint: vi.fn(async () => true),
    };
    (mgr as any).checkpointManager = checkpointManager;

    const result = await mgr.revertToCheckpoint("session-1", "cp-1");

    expect(result).toEqual({
      ok: false,
      reason: "persistence_failed",
      currentRevision: "2",
    });
    expect(checkpointManager.revertToCheckpoint).toHaveBeenCalled();
    expect(replaceMessages).not.toHaveBeenCalled();
    expect(saveSession).toHaveBeenCalledTimes(2);
    expect(saveSession.mock.calls[1][0].session.metadata.revertPending).toEqual(
      expect.objectContaining({
        checkpointId: "cp-1",
        reason: "workspace_reverted_session_save_failed",
        sessionRevision: "2",
        workspaceRevision: "hash-1",
      }),
    );
  });

  it("does not return a cached current revision for non-conflict persistence failures", async () => {
    const sessionMessages: AgentMessage[] = [
      { role: "user", content: "first prompt" },
      { role: "assistant", content: "first answer" },
      { role: "user", content: "second prompt" },
    ];
    const session: any = {
      id: "session-1",
      mode: "code",
      model: "claude-sonnet-4-6",
      providerId: undefined,
      autoCondenseThreshold: 0.9,
      title: "Checkpoint test",
      background: false,
      status: "idle",
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
      lastInputTokens: 0,
      lastOutputTokens: 0,
      lastCacheReadTokens: 0,
      currentTool: undefined,
      addUserMessage: vi.fn(),
      appendRuntimeError: vi.fn(),
      consumePendingInterjection: vi.fn(() => null),
      queuePendingModeResume: vi.fn(),
      consumePendingModeResume: vi.fn(() => null),
      autoTitle: vi.fn(),
      getAllMessages: vi.fn(() => sessionMessages),
      getLoadedSkills: vi.fn(() => []),
      replaceMessages: vi.fn(),
      restoreFromStore: vi.fn((data: { messages: AgentMessage[] }) => {
        sessionMessages.splice(0, sessionMessages.length, ...data.messages);
      }),
      rebuildSystemPrompt: vi.fn(async () => {}),
      lastActiveAt: 123,
      createdAt: 100,
    };
    mocks.createSession.mockResolvedValueOnce(session);

    const summary = {
      id: "session-1",
      mode: "code",
      model: "claude-sonnet-4-6",
      title: "Checkpoint test",
      messageCount: 3,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      createdAt: 100,
      lastActiveAt: 123,
      schemaVersion: 1,
    };
    const record: PersistedSessionRecord = {
      summary,
      messages: sessionMessages,
      metadata: {
        mode: "code",
        model: "claude-sonnet-4-6",
        totalInputTokens: 0,
        totalOutputTokens: 0,
        checkpointState: {
          baseCommit: null,
          checkpoints: [
            {
              id: "cp-1",
              commitHash: "hash-1",
              turnIndex: 1,
              createdAt: 111,
            },
          ],
        },
      },
    };
    const store = {
      saveSession: vi.fn(async () => ({
        ok: false,
        reason: "io_error",
        message: "disk full",
      })),
      readSession: vi.fn(async () => ({
        ok: true,
        revision: "1",
        value: record,
      })),
      get: vi.fn(() => summary),
      loadMessages: vi.fn(() => sessionMessages),
      loadMetadata: vi.fn(() => null),
      list: vi.fn(() => []),
    } as any;

    const mgr = new AgentSessionManager(
      makeConfig(),
      "/tmp",
      undefined,
      false,
      store,
    );
    await mgr.loadPersistedSession("session-1");
    (mgr as any).checkpointManager = {
      revertToCheckpoint: vi.fn(async () => true),
    };

    const result = await mgr.revertToCheckpoint("session-1", "cp-1");

    expect(result).toEqual({ ok: false, reason: "persistence_failed" });
  });

  it("rejects checkpoint revert when the session is not loaded in memory", async () => {
    const mgr = new AgentSessionManager(makeConfig(), "/tmp");
    (mgr as any).checkpoints.set("session-1", [
      { id: "cp-1", commitHash: "hash-1", turnIndex: 1, createdAt: 111 },
    ]);
    const checkpointManager = { revertToCheckpoint: vi.fn(async () => true) };
    (mgr as any).checkpointManager = checkpointManager;

    const result = await mgr.revertToCheckpoint("session-1", "cp-1");

    expect(result).toEqual({ ok: false, reason: "not_found" });
    expect(checkpointManager.revertToCheckpoint).not.toHaveBeenCalled();
  });

  it("rejects checkpoint revert when the session changed after preview", async () => {
    const sessionMessages: AgentMessage[] = [
      { role: "user", content: "first prompt" },
      { role: "assistant", content: "first answer" },
      { role: "user", content: "second prompt" },
    ];
    const session: any = {
      id: "session-1",
      mode: "code",
      model: "claude-sonnet-4-6",
      providerId: undefined,
      autoCondenseThreshold: 0.9,
      title: "Checkpoint test",
      background: false,
      status: "idle",
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
      lastInputTokens: 0,
      lastOutputTokens: 0,
      lastCacheReadTokens: 0,
      currentTool: undefined,
      addUserMessage: vi.fn(),
      appendRuntimeError: vi.fn(),
      consumePendingInterjection: vi.fn(() => null),
      queuePendingModeResume: vi.fn(),
      consumePendingModeResume: vi.fn(() => null),
      autoTitle: vi.fn(),
      getAllMessages: vi.fn(() => sessionMessages),
      getLoadedSkills: vi.fn(() => []),
      replaceMessages: vi.fn(),
      restoreFromStore: vi.fn((data: { messages: AgentMessage[] }) => {
        sessionMessages.splice(0, sessionMessages.length, ...data.messages);
      }),
      rebuildSystemPrompt: vi.fn(async () => {}),
      lastActiveAt: 123,
      createdAt: 100,
    };
    mocks.createSession.mockResolvedValueOnce(session);

    const summary = {
      id: "session-1",
      mode: "code",
      model: "claude-sonnet-4-6",
      title: "Checkpoint test",
      messageCount: 3,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      createdAt: 100,
      lastActiveAt: 123,
      schemaVersion: 1,
    };
    const store = {
      readSession: vi.fn(async () => ({
        ok: true,
        revision: "1",
        value: {
          summary,
          messages: sessionMessages,
          metadata: {
            mode: "code",
            model: "claude-sonnet-4-6",
            totalInputTokens: 0,
            totalOutputTokens: 0,
            checkpointState: {
              baseCommit: null,
              checkpoints: [
                {
                  id: "cp-1",
                  commitHash: "hash-1",
                  turnIndex: 1,
                  createdAt: 111,
                },
              ],
            },
          },
        },
      })),
      get: vi.fn(() => summary),
      loadMessages: vi.fn(() => sessionMessages),
      loadMetadata: vi.fn(() => null),
      list: vi.fn(() => []),
    } as any;

    const mgr = new AgentSessionManager(
      makeConfig(),
      "/tmp",
      undefined,
      false,
      store,
    );
    await mgr.loadPersistedSession("session-1");

    const checkpointManager = {
      previewRevert: vi.fn(async () => ({
        modified: [],
        deleted: [],
        restored: [],
      })),
      revertToCheckpoint: vi.fn(async () => true),
    };
    (mgr as any).checkpointManager = checkpointManager;
    const preview = await mgr.previewRevert("session-1", "cp-1");
    expect(preview).not.toBeNull();

    sessionMessages.push({ role: "assistant", content: "new answer" });
    const result = await mgr.revertToCheckpoint(
      "session-1",
      "cp-1",
      preview!.sessionRevision,
      preview!.persistenceRevision,
    );

    expect(result).toEqual({
      ok: false,
      reason: "session_conflict",
      currentRevision: expect.any(String),
    });
    expect(checkpointManager.revertToCheckpoint).not.toHaveBeenCalled();
    expect(session.replaceMessages).not.toHaveBeenCalled();
  });

  it("accepts reverting to a checkpoint at the current transcript tail", async () => {
    const sessionMessages: AgentMessage[] = [
      { role: "user", content: "first prompt" },
      { role: "assistant", content: "first answer" },
      { role: "user", content: "second prompt" },
      { role: "assistant", content: "second answer" },
    ];

    const replaceMessages = vi.fn((messages: AgentMessage[]) => {
      sessionMessages.splice(0, sessionMessages.length, ...messages);
    });

    const session: any = {
      id: "session-1",
      mode: "code",
      model: "claude-sonnet-4-6",
      providerId: undefined,
      autoCondenseThreshold: 0.9,
      title: "Checkpoint test",
      background: false,
      status: "idle",
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
      lastInputTokens: 0,
      lastOutputTokens: 0,
      lastCacheReadTokens: 0,
      currentTool: undefined,
      addUserMessage: vi.fn(),
      appendRuntimeError: vi.fn(),
      consumePendingInterjection: vi.fn(() => null),
      queuePendingModeResume: vi.fn(),
      consumePendingModeResume: vi.fn(() => null),
      autoTitle: vi.fn(),
      getAllMessages: vi.fn(() => sessionMessages),
      getLoadedSkills: vi.fn(() => []),
      replaceMessages,
      restoreFromStore: vi.fn((data: { messages: AgentMessage[] }) => {
        sessionMessages.splice(0, sessionMessages.length, ...data.messages);
      }),
      rebuildSystemPrompt: vi.fn(async () => {}),
      lastActiveAt: 123,
      createdAt: 100,
    };
    mocks.createSession.mockResolvedValueOnce(session);

    const saveSession = vi.fn(
      async (_args: { session: PersistedSessionRecord }) => ({
        ok: true,
        revision: "2",
      }),
    );
    const summary = {
      id: "session-1",
      mode: "code",
      model: "claude-sonnet-4-6",
      title: "Checkpoint test",
      messageCount: 4,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      createdAt: 100,
      lastActiveAt: 123,
      schemaVersion: 1,
    };
    const store = {
      saveSession,
      readSession: vi.fn(async () => ({
        ok: true,
        revision: "1",
        value: {
          summary,
          messages: sessionMessages,
          metadata: {
            mode: "code",
            model: "claude-sonnet-4-6",
            totalInputTokens: 0,
            totalOutputTokens: 0,
            checkpointState: {
              baseCommit: null,
              checkpoints: [
                {
                  id: "cp-tail",
                  commitHash: "hash-tail",
                  turnIndex: 2,
                  createdAt: 222,
                },
              ],
            },
          },
        },
      })),
      get: vi.fn(() => summary),
      loadMessages: vi.fn(() => sessionMessages),
      loadMetadata: vi.fn(() => ({
        schemaVersion: 1,
        mode: "code",
        model: "claude-sonnet-4-6",
        totalInputTokens: 0,
        totalOutputTokens: 0,
        checkpoints: [],
      })),
      list: vi.fn(() => []),
    } as any;

    const mgr = new AgentSessionManager(
      makeConfig(),
      "/tmp",
      undefined,
      false,
      store,
    );
    await mgr.loadPersistedSession("session-1");

    const checkpointManager = {
      revertToCheckpoint: vi.fn(async () => true),
    };
    (mgr as any).checkpointManager = checkpointManager;

    const result = await mgr.revertToCheckpoint("session-1", "cp-tail");

    expect(result).toEqual({
      ok: true,
      restoredPrompt: undefined,
      sessionRevision: "2",
    });
    expect(replaceMessages).toHaveBeenCalledWith([
      { role: "user", content: "first prompt" },
      { role: "assistant", content: "first answer" },
      { role: "user", content: "second prompt" },
      { role: "assistant", content: "second answer" },
    ]);
    expect(saveSession).toHaveBeenCalled();
  });
});

describe("AgentSessionManager memory candidate nudges", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getConfiguration.mockReturnValue({
      get: () => undefined,
      inspect: () => undefined,
    });
  });

  async function makeSendHarness() {
    const mgr = new AgentSessionManager(makeConfig(), "/tmp");
    const session = await mgr.createSession("code");
    const messages: AgentMessage[] = [];
    (session as any).messageCount = 0;
    (session as any).isAborted = false;
    (session as any).lastActiveAt = 123;
    (session as any).getAllMessages = vi.fn(() => messages);
    (session as any).addUserMessage = vi.fn((text: string, opts?: unknown) => {
      messages.push({
        role: "user",
        content: text,
        uiHint: opts
          ? { userMessage: opts as Record<string, unknown> }
          : undefined,
      } as AgentMessage);
      (session as any).messageCount = messages.length;
      session.lastActiveAt += 1;
    });
    (session as any).consumePendingInterjection = vi.fn(() => null);
    (session as any).consumePendingModeResume = vi.fn(() => null);
    (session as any).autoTitle = vi.fn();

    (mgr as any).checkpointManager = { createCheckpoint: vi.fn() };
    (mgr as any).engine = {
      run: vi.fn(async function* () {
        yield {
          type: "done",
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalCacheReadTokens: 0,
          totalCacheCreationTokens: 0,
        };
      }),
    };
    mgr.onEvent = vi.fn();
    return { mgr, session };
  }

  it("stores a model-facing memory reminder while preserving display text", async () => {
    const { mgr, session } = await makeSendHarness();
    const text = "Going forward, always ask me before switching modes.";

    await mgr.sendMessage(session.id, text, session.mode);

    expect((session as any).addUserMessage).toHaveBeenCalledWith(
      expect.stringContaining("[memory-candidate]"),
      expect.objectContaining({ displayText: text }),
    );
  });

  it("skips slash commands but not media messages with real text", async () => {
    const { mgr, session } = await makeSendHarness();

    await mgr.sendMessage(
      session.id,
      "Going forward, always ask me before switching modes.",
      session.mode,
      { isSlashCommand: true },
    );
    expect((session as any).addUserMessage).toHaveBeenLastCalledWith(
      "Going forward, always ask me before switching modes.",
      expect.objectContaining({ isSlashCommand: true }),
    );

    await mgr.sendMessage(
      session.id,
      "Going forward, always ask me before switching modes.",
      session.mode,
      { images: [{ name: "a.png", mimeType: "image/png", base64: "abc" }] },
    );
    expect((session as any).addUserMessage).toHaveBeenLastCalledWith(
      expect.stringContaining("[memory-candidate]"),
      expect.objectContaining({
        images: [{ name: "a.png", mimeType: "image/png", base64: "abc" }],
      }),
    );
  });

  it("respects the per-session nudge cap", async () => {
    const { mgr, session } = await makeSendHarness();

    await mgr.sendMessage(
      session.id,
      "Going forward, always ask me before mode switches.",
      session.mode,
    );
    await mgr.sendMessage(
      session.id,
      "In the future, always ask me before running release commands.",
      session.mode,
    );
    await mgr.sendMessage(
      session.id,
      "Remember to always ask me before deleting files.",
      session.mode,
    );

    const calls = (session as any).addUserMessage.mock.calls as Array<
      [string, unknown]
    >;
    expect(
      calls.filter(([content]) => content.includes("[memory-candidate]"))
        .length,
    ).toBe(2);
    expect(calls.at(-1)?.[0]).toBe(
      "Remember to always ask me before deleting files.",
    );
  });
});
