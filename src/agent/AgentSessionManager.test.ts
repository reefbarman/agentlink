import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import type { AgentConfig, AgentMessage } from "./types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentSessionManager } from "./AgentSessionManager.js";

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

const makeConfig = (): AgentConfig => ({
  model: "claude-sonnet-4-6",
  maxTokens: 8192,
  thinkingBudget: 0,
  showThinking: false,
  autoCondense: true,
  autoCondenseThreshold: 0.9,
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

    const save = vi.fn();
    const store = {
      save,
      get: vi.fn(() => ({
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
      })),
      loadMessages: vi.fn(() => sessionMessages),
      loadMetadata: vi.fn(() => ({
        schemaVersion: 1,
        mode: "code",
        model: "claude-sonnet-4-6",
        totalInputTokens: 0,
        totalOutputTokens: 0,
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

    expect(result).toEqual({ ok: true, restoredPrompt: "second prompt" });
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
    expect(save).toHaveBeenCalled();
    const lastSaveArg = save.mock.calls.at(-1)?.[0];
    expect(lastSaveArg?.checkpoints).toEqual([
      {
        id: "cp-1",
        commitHash: "hash-1",
        turnIndex: 1,
        createdAt: 111,
      },
    ]);
    expect(lastSaveArg?.getAllMessages()).toEqual([
      { role: "user", content: "first prompt" },
      { role: "assistant", content: "first answer" },
    ]);
  });
});
