import { beforeEach, describe, expect, it, vi } from "vitest";

import { AgentSessionManager } from "./AgentSessionManager.js";
import { ProviderRegistry } from "./providers/index.js";
import type { ToolDispatchContext } from "./toolAdapter.js";

const mocks = vi.hoisted(() => {
  let seq = 0;
  return {
    setToolRuntime: vi.fn(),
    runBehavior: vi.fn<() => AsyncGenerator<unknown>>(),
    runArgs: vi.fn(),
    resolveBackgroundRoute: vi.fn(
      async (
        _registry: unknown,
        request: any,
        _foreground: unknown,
      ): Promise<Record<string, unknown>> => ({
        resolvedMode: request.mode ?? "review",
        resolvedModel: request.model ?? "claude-sonnet-4-6",
        resolvedProvider: request.provider ?? "anthropic",
        taskClass: request.taskClass ?? "general",
        routingReason: "test route",
        fallbackUsed: false,
      }),
    ),
    createSession: vi.fn(async (opts: any) => {
      seq += 1;
      let pendingModeResume: {
        mode: string;
        reason?: string;
        followUp?: string;
      } | null = null;
      let assistantText = "background result";
      const mockSession = {
        id: `bg-${seq}`,
        mode: opts.mode,
        model: opts.config.model,
        reasoningEffort: "high",
        providerId: opts.providerId,
        title: "New Chat",
        background: Boolean(opts.background),
        status: "idle",
        currentTool: undefined,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheReadTokens: 0,
        totalCacheCreationTokens: 0,
        lastInputTokens: 0,
        lastCacheReadTokens: 0,
        lastActiveAt: 1,
        fleetMetadata: undefined as any,
        addUserMessage: vi.fn(),
        restoreFromStore: vi.fn((data: any) => {
          mockSession.id = data.id;
          mockSession.title = data.title;
          mockSession.lastActiveAt = data.lastActiveAt;
          mockSession.fleetMetadata = data.fleetMetadata;
        }),
        rebuildSystemPrompt: vi.fn(async () => {}),
        setMode: vi.fn(async (mode: string) => {
          mockSession.mode = mode;
        }),
        appendAssistantTurn: vi.fn((content: any[]) => {
          assistantText = content
            .filter((block) => block?.type === "text")
            .map((block) => block.text)
            .join("");
        }),
        appendRuntimeError: vi.fn(),
        consumePendingInterjection: vi.fn(() => null),
        queuePendingModeResume: vi.fn((mode: string, opts?: any) => {
          pendingModeResume = {
            mode,
            reason: opts?.reason,
            followUp: opts?.followUp,
          };
        }),
        consumePendingModeResume: vi.fn(() => {
          const pending = pendingModeResume;
          pendingModeResume = null;
          return pending;
        }),
        autoTitle: vi.fn(),
        getAllMessages: vi.fn(() => []),
        createAbortController: vi.fn(() => new AbortController()),
        abort: vi.fn(),
        get isAborted() {
          return false;
        },
        get abortSignal() {
          return undefined;
        },
        getLastAssistantText: vi.fn(() => assistantText),
        getFullAssistantTranscript: vi.fn(() => assistantText),
      };
      return mockSession;
    }),
  };
});

vi.mock("./backgroundModelRouter.js", () => ({
  resolveBackgroundRoute: (
    registry: unknown,
    request: unknown,
    foreground: unknown,
  ) => mocks.resolveBackgroundRoute(registry, request, foreground),
}));

vi.mock("./AgentEngine.js", () => ({
  AgentEngine: class MockAgentEngine {
    setToolRuntime = mocks.setToolRuntime;
    run(...args: unknown[]) {
      mocks.runArgs(...args);
      return mocks.runBehavior();
    }
  },
}));

vi.mock("./AgentSession.js", () => ({
  AgentSession: {
    create: (opts: unknown) => mocks.createSession(opts),
  },
}));

async function waitFor<T>(
  read: () => T,
  predicate: (value: T) => boolean,
): Promise<T> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const value = read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return read();
}

describe("AgentSessionManager background agents", () => {
  const config = {
    model: "claude-sonnet-4-6",
    maxTokens: 8192,
    thinkingBudget: 0,
    showThinking: false,
    autoCondense: true,
    autoCondenseThreshold: 0.9,
  };

  const configHost = {
    getCondenseThresholdForModel: vi.fn(() => 0.9),
    resolveModelForMode: vi.fn(
      (_mode: string, fallbackModel: string) => fallbackModel,
    ),
    getBgSummaryMode: vi.fn(() => "heuristic" as const),
    getBackgroundAgentSettings: vi.fn(() => ({})),
  };

  const toolCtx: ToolDispatchContext = {
    approvalManager: {} as any,
    approvalPanel: {} as any,
    extensionUri: {} as any,
    sessionId: "fg",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    configHost.getBackgroundAgentSettings.mockReturnValue({});
    mocks.runBehavior.mockReturnValue(
      (async function* () {
        yield { type: "done" };
      })(),
    );
  });

  it("queues spawn when the concurrent limit is reached", async () => {
    const mgr = new AgentSessionManager(
      config,
      "/tmp",
      undefined,
      false,
      undefined,
      undefined,
      { maxConcurrent: 0 },
    );
    mgr.setToolContext(toolCtx);

    const spawned = await mgr.spawnBackground({ task: "t", message: "m" });
    expect(mgr.getBackgroundStatus(spawned.sessionId)).toEqual(
      expect.objectContaining({ status: "queued", done: false }),
    );
  });

  it("starts the next queued agent when capacity becomes available", async () => {
    let releaseFirst: (() => void) | undefined;
    mocks.runBehavior
      .mockReturnValueOnce(
        (async function* () {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
          yield { type: "done" };
        })(),
      )
      .mockReturnValueOnce(
        (async function* () {
          yield { type: "done" };
        })(),
      );
    const mgr = new AgentSessionManager(
      config,
      "/tmp",
      undefined,
      false,
      undefined,
      undefined,
      { maxConcurrent: 1 },
    );
    mgr.setToolContext(toolCtx);

    await mgr.spawnBackground({ task: "first", message: "hold" });
    await waitFor(
      () => releaseFirst,
      (release) => typeof release === "function",
    );
    const second = await mgr.spawnBackground({ task: "second", message: "wait" });
    expect(mgr.getBackgroundStatus(second.sessionId).status).toBe("queued");

    releaseFirst?.();
    await waitFor(
      () => mgr.getBackgroundStatus(second.sessionId),
      (status) => status.done,
    );

    expect(mocks.runArgs).toHaveBeenCalledTimes(2);
    expect(mgr.getBackgroundStatus(second.sessionId).done).toBe(true);
  });

  it("runs explicit ACP provider without native route resolution", async () => {
    configHost.getBackgroundAgentSettings.mockReturnValue({
      acpAgents: [{ id: "claude", command: "claude-agent-acp" }],
    });
    const acpBackgroundRunner = {
      run: vi.fn(async (request: any) => {
        request.onEvent({
          type: "update",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "ACP result" },
          },
        });
        request.onEvent({
          type: "stop",
          response: {
            stopReason: "end_turn",
            usage: {
              totalTokens: 42,
              inputTokens: 30,
              outputTokens: 12,
              cachedReadTokens: 5,
              cachedWriteTokens: 2,
            },
          },
        });
      }),
    };
    const mgr = new AgentSessionManager(
      config,
      "/tmp",
      undefined,
      false,
      undefined,
      undefined,
      { maxConcurrent: 3 },
      { host: { config: configHost, acpBackgroundRunner } },
    );
    mgr.setToolContext(toolCtx);

    const spawned = await mgr.spawnBackground({
      task: "external review",
      message: "review this",
      provider: "acp:claude",
    });
    const result = await mgr.waitForBackground(spawned.sessionId);

    expect(result).toBe("ACP result");
    expect(spawned).toMatchObject({
      resolvedProvider: "acp",
      resolvedModel: "acp:claude",
    });
    expect(mgr.getBackgroundStatus(spawned.sessionId)).toMatchObject({
      status: "idle",
      done: true,
      partialOutput: "ACP result",
      resolvedProvider: "acp",
      tokenUsage: 42,
    });
    const session = (mgr as any).sessions.get(spawned.sessionId);
    expect(session.totalInputTokens).toBe(30);
    expect(session.totalOutputTokens).toBe(12);
    expect(session.totalCacheReadTokens).toBe(5);
    expect(session.totalCacheCreationTokens).toBe(2);
    expect(session.lastInputTokens).toBe(37);
    expect(mocks.resolveBackgroundRoute).not.toHaveBeenCalled();
  });

  it("uses configured default ACP provider without native route resolution", async () => {
    configHost.getBackgroundAgentSettings.mockReturnValue({
      defaultAgent: "acp:claude",
      acpAgents: [{ id: "claude", command: "claude-agent-acp" }],
    });
    const acpBackgroundRunner = {
      run: vi.fn(async (request: any) => {
        request.onEvent({
          type: "update",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "tc-1",
            title: "Inspecting files",
            status: "in_progress",
          },
        });
        request.onEvent({
          type: "update",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Default ACP result" },
          },
        });
      }),
    };
    const mgr = new AgentSessionManager(
      config,
      "/tmp",
      undefined,
      false,
      undefined,
      undefined,
      { maxConcurrent: 3 },
      { host: { config: configHost, acpBackgroundRunner } },
    );
    mgr.setToolContext(toolCtx);

    const spawned = await mgr.spawnBackground({
      task: "external review",
      message: "review this",
    });
    const result = await mgr.waitForBackground(spawned.sessionId);

    expect(result).toBe("Default ACP result");
    expect(mgr.getBackgroundStatus(spawned.sessionId)).toMatchObject({
      done: true,
      toolCalls: 1,
      resolvedProvider: "acp",
    });
    expect(mocks.resolveBackgroundRoute).not.toHaveBeenCalled();
  });

  it("cancels non-readonly ACP permission requests without surfacing approval", async () => {
    configHost.getBackgroundAgentSettings.mockReturnValue({
      defaultAgent: "acp:claude",
      acpAgents: [{ id: "claude", command: "claude-agent-acp" }],
    });
    const onApprovalRequest = vi.fn();
    const permissionOutcome: unknown[] = [];
    const acpBackgroundRunner = {
      run: vi.fn(async (request: any) => {
        permissionOutcome.push(
          await request.onRequestPermission({
            toolCall: {
              id: "tc-edit",
              kind: "edit",
              title: "Edit file",
              rawInput: { path: "src/file.ts" },
            },
            options: [
              { optionId: "allow", name: "Allow", kind: "allow_once" },
              { optionId: "reject", name: "Reject", kind: "reject_once" },
            ],
          }),
        );
        request.onEvent({
          type: "update",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Permission handled" },
          },
        });
      }),
    };
    const mgr = new AgentSessionManager(
      config,
      "/tmp",
      undefined,
      false,
      undefined,
      undefined,
      { maxConcurrent: 3 },
      { host: { config: configHost, acpBackgroundRunner } },
    );
    mgr.setToolContext({ ...toolCtx, onApprovalRequest });

    const spawned = await mgr.spawnBackground({
      task: "external review",
      message: "review this",
    });
    await mgr.waitForBackground(spawned.sessionId);

    expect(permissionOutcome).toEqual([{ outcome: { outcome: "cancelled" } }]);
    expect(onApprovalRequest).not.toHaveBeenCalled();
  });

  it("surfaces non-success ACP stop reasons as background errors", async () => {
    configHost.getBackgroundAgentSettings.mockReturnValue({
      defaultAgent: "acp:claude",
      acpAgents: [{ id: "claude", command: "claude-agent-acp" }],
    });
    const acpBackgroundRunner = {
      run: vi.fn(async (request: any) => {
        request.onEvent({
          type: "update",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Partial ACP result" },
          },
        });
        request.onEvent({
          type: "stop",
          response: { stopReason: "refusal" },
        });
      }),
    };
    const mgr = new AgentSessionManager(
      config,
      "/tmp",
      undefined,
      false,
      undefined,
      undefined,
      { maxConcurrent: 3 },
      { host: { config: configHost, acpBackgroundRunner } },
    );
    mgr.setToolContext(toolCtx);

    const spawned = await mgr.spawnBackground({
      task: "external review",
      message: "review this",
    });
    const result = await mgr.waitForBackground(spawned.sessionId);

    expect(result).toContain("Partial ACP result");
    expect(result).toContain("ACP background agent refused the request.");
    expect(mgr.getBackgroundStatus(spawned.sessionId)).toMatchObject({
      status: "error",
      done: true,
      partialOutput: result,
    });
  });

  it("creates background engines through the host without reusing the memoized foreground engine", async () => {
    const providers = new ProviderRegistry();
    const foregroundEngine = {
      setToolRuntime: vi.fn(),
      run: vi.fn(async function* () {}),
      condenseSession: vi.fn(async function* () {}),
      isOverCondenseThreshold: vi.fn(() => false),
    };
    const backgroundEngine = {
      setToolRuntime: vi.fn(),
      run: vi.fn(() => mocks.runBehavior()),
      condenseSession: vi.fn(async function* () {}),
      isOverCondenseThreshold: vi.fn(() => false),
    };
    const createEngine = vi
      .fn()
      .mockReturnValueOnce(foregroundEngine)
      .mockReturnValueOnce(backgroundEngine);
    const createToolRuntime = vi.fn(() => ({ executeTool: vi.fn() }));

    const mgr = new AgentSessionManager(
      config,
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
    mgr.setToolContext(toolCtx);

    const memoizedForeground = (mgr as any).getEngine();
    await mgr.spawnBackground({ task: "host engine", message: "run" });

    expect(memoizedForeground).toBe(foregroundEngine);
    expect(createEngine).toHaveBeenCalledTimes(2);
    expect(createEngine).toHaveBeenNthCalledWith(1, providers, undefined);
    expect(createEngine).toHaveBeenNthCalledWith(2, providers, undefined);
    expect(backgroundEngine.setToolRuntime).toHaveBeenCalledTimes(1);
    expect(backgroundEngine.run).toHaveBeenCalledTimes(1);
    expect(foregroundEngine.run).not.toHaveBeenCalled();
  });

  it("tracks tool calls and token usage without enforcing limits", async () => {
    mocks.runBehavior.mockReturnValue(
      (async function* () {
        yield { type: "tool_start", toolCallId: "tc-1", toolName: "search" };
        yield { type: "tool_start", toolCallId: "tc-2", toolName: "read" };
        yield {
          type: "api_request",
          requestId: "r1",
          model: "claude-sonnet-4-6",
          inputTokens: 5000,
          uncachedInputTokens: 5000,
          outputTokens: 1000,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          durationMs: 10,
          timeToFirstToken: 2,
        };
        yield { type: "done" };
      })(),
    );

    const mgr = new AgentSessionManager(config, "/tmp");
    mgr.setToolContext(toolCtx);

    await mgr.spawnBackground({
      task: "no limits",
      message: "run",
    });

    await new Promise((r) => setTimeout(r, 0));
    const info = mgr.getBgSessionInfos()[0];
    // Agent should complete normally — no guardrails to trigger
    expect(info).toBeDefined();
    expect(info.errorMessage).toBeUndefined();
  });

  it("exposes route summaries for debug payloads", async () => {
    const mgr = new AgentSessionManager(config, "/tmp");
    mgr.setToolContext(toolCtx);

    await mgr.spawnBackground({
      task: "route summary",
      message: "run",
      taskClass: "review_code",
    });

    await new Promise((r) => setTimeout(r, 0));
    const summaries = mgr.getRecentBgRoutingSummaries();
    expect(summaries.length).toBeGreaterThan(0);
    expect(summaries[0]).toContain("mode=");
    expect(summaries[0]).toContain("provider=");
    expect(summaries[0]).toContain("model=");
  });

  it("wraps background questions with context, session id, and task attribution", async () => {
    const onQuestion = vi.fn().mockResolvedValue({ answers: {}, notes: {} });
    const mgr = new AgentSessionManager(config, "/tmp");
    mgr.setToolContext({ ...toolCtx, onQuestion });

    const spawned = await mgr.spawnBackground({
      task: "review task",
      message: "run",
    });

    const bgRuntime = mocks.setToolRuntime.mock.calls.at(-1)?.[0];
    expect(bgRuntime).toBeDefined();
    await bgRuntime.executeTool({
      name: "ask_user",
      input: { context: "Need input.", questions: [] },
      context: { sessionId: spawned.sessionId },
    });

    expect(onQuestion).toHaveBeenCalledWith(
      "Need input.",
      [],
      spawned.sessionId,
      "review task",
    );
  });

  it("routes background mode switches with the originating session id", async () => {
    const onModeSwitch = vi.fn().mockResolvedValue({
      approved: true,
      mode: "debug",
    });
    const mgr = new AgentSessionManager(config, "/tmp");
    mgr.setToolContext({ ...toolCtx, onModeSwitch });

    const spawned = await mgr.spawnBackground({
      task: "debug task",
      message: "investigate",
      mode: "code",
    });
    const bgRuntime = mocks.setToolRuntime.mock.calls.at(-1)?.[0];

    await bgRuntime.executeTool({
      name: "switch_mode",
      input: { mode: "debug", reason: "Need runtime diagnostics" },
      context: { sessionId: spawned.sessionId },
    });

    expect(onModeSwitch).toHaveBeenCalledWith(
      spawned.sessionId,
      "debug",
      "Need runtime diagnostics",
    );
  });

  it("switches a background session without changing foreground ownership", async () => {
    const mgr = new AgentSessionManager(config, "/tmp");
    mgr.setToolContext(toolCtx);
    const foreground = await mgr.createSession("code");
    const spawned = await mgr.spawnBackground({
      task: "debug task",
      message: "investigate",
      mode: "code",
    });

    const switched = await mgr.switchSessionMode(spawned.sessionId, "debug");

    expect(switched?.id).toBe(spawned.sessionId);
    expect(switched?.mode).toBe("debug");
    expect(mgr.getForegroundSession()?.id).toBe(foreground.id);
    expect(mgr.getForegroundSession()?.mode).toBe("code");
  });

  it("allows background agents to spawn descendants within depth policy", async () => {
    const mgr = new AgentSessionManager(config, "/tmp");
    mgr.setToolContext({
      ...toolCtx,
      onSpawnBackground: (callerSessionId, request) =>
        mgr.spawnBackground(request, callerSessionId),
      onGetBackgroundStatus: (callerSessionId, sessionId) =>
        mgr.getAuthorizedBackgroundStatus(callerSessionId, sessionId),
      onGetBackgroundResult: (callerSessionId, sessionId) =>
        mgr.waitForAuthorizedBackground(callerSessionId, sessionId),
      onKillBackground: (callerSessionId, sessionId, reason) =>
        mgr.killAuthorizedBackground(callerSessionId, sessionId, reason),
    });
    await mgr.createSession("code");
    const parent = await mgr.spawnBackground({
      task: "parent",
      message: "coordinate",
      mode: "code",
    });
    const parentRuntime = mocks.setToolRuntime.mock.calls.at(-1)?.[0];

    const result = await parentRuntime.executeTool({
      name: "spawn_background_agent",
      input: { task: "child", message: "inspect", mode: "review" },
      context: { sessionId: parent.sessionId },
    });
    const childId = JSON.parse(result.content[0].text).sessionId;
    const child = (mgr as any).sessions.get(childId);

    expect(child.fleetMetadata).toEqual(
      expect.objectContaining({
        parentSessionId: parent.sessionId,
        depth: 2,
      }),
    );
    const childRuntime = mocks.setToolRuntime.mock.calls.at(-1)?.[0];
    await expect(
      childRuntime.executeTool({
        name: "spawn_background_agent",
        input: { task: "too deep", message: "stop" },
        context: { sessionId: childId },
      }),
    ).rejects.toThrow(/maximum fleet depth reached/);
  });

  it("prevents background agents from managing sibling subtrees", async () => {
    const mgr = new AgentSessionManager(config, "/tmp");
    mgr.setToolContext(toolCtx);
    await mgr.createSession("code");
    const first = await mgr.spawnBackground({ task: "first", message: "one" });
    const second = await mgr.spawnBackground({ task: "second", message: "two" });

    expect(
      mgr.getAuthorizedBackgroundStatus(first.sessionId, second.sessionId),
    ).toEqual(
      expect.objectContaining({
        status: "error",
        partialOutput: expect.stringContaining("outside the caller's subtree"),
      }),
    );
    expect(
      mgr.killAuthorizedBackground(first.sessionId, second.sessionId),
    ).toEqual(
      expect.objectContaining({ killed: false }),
    );
  });

  it("propagates parent cancellation through the descendant subtree", async () => {
    mocks.runBehavior.mockImplementation(() =>
      (async function* () {
        await new Promise<never>(() => undefined);
        yield { type: "done" };
      })(),
    );
    const mgr = new AgentSessionManager(config, "/tmp");
    mgr.setToolContext(toolCtx);
    await mgr.createSession("code");
    const parent = await mgr.spawnBackground({
      task: "parent",
      message: "coordinate",
    });
    const child = await mgr.spawnBackground(
      { task: "child", message: "work" },
      parent.sessionId,
    );

    mgr.stopSession(parent.sessionId);

    expect(mgr.getBackgroundStatus(parent.sessionId).status).toBe("cancelled");
    expect(mgr.getBackgroundStatus(child.sessionId).status).toBe("cancelled");
    expect((mgr as any).sessions.get(child.sessionId).fleetMetadata).toEqual(
      expect.objectContaining({
        lifecycle: "cancelled",
        terminalReason: "cancelled_by_user",
      }),
    );
  });

  it("creates native review agents with the full prompt path", async () => {
    const mgr = new AgentSessionManager(config, "/tmp");
    mgr.setToolContext(toolCtx);

    await mgr.spawnBackground({
      task: "review task",
      message: "review thoroughly",
      taskClass: "review_code",
    });

    expect(mocks.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        background: true,
        isBackground: true,
      }),
    );
    expect(mocks.createSession.mock.calls.at(-1)?.[0]).not.toHaveProperty(
      "lightweight",
    );
  });

  it("records durable native fleet identity and completion", async () => {
    const mgr = new AgentSessionManager(config, "/tmp");
    mgr.setToolContext(toolCtx);
    const foreground = await mgr.createSession("code");

    const spawned = await mgr.spawnBackground({
      task: "review task",
      message: "review thoroughly",
      taskClass: "review_code",
    });
    const session = (mgr as any).sessions.get(spawned.sessionId);

    expect(session.fleetMetadata).toEqual(
      expect.objectContaining({
        schemaVersion: 1,
        placement: "background",
        parentSessionId: foreground.id,
        rootSessionId: foreground.id,
        depth: 1,
        backend: "native",
        lifecycle: "running",
      }),
    );

    await waitFor(
      () => session.fleetMetadata.lifecycle,
      (lifecycle) => lifecycle === "completed",
    );
    expect(session.fleetMetadata).toEqual(
      expect.objectContaining({
        lifecycle: "completed",
        completedAt: expect.any(Number),
        finalResult: "background result",
      }),
    );
  });

  it("restores persisted background ancestry and marks running work interrupted", async () => {
    const summary = {
      schemaVersion: 1,
      id: "persisted-bg",
      mode: "review",
      model: "claude-sonnet-4-6",
      title: "Persisted review",
      messageCount: 1,
      totalInputTokens: 20,
      totalOutputTokens: 10,
      createdAt: 1,
      lastActiveAt: 2,
      background: true,
    };
    const fleet = {
      schemaVersion: 1 as const,
      placement: "background" as const,
      parentSessionId: "foreground-1",
      rootSessionId: "foreground-1",
      task: "Persisted review",
      depth: 1,
      backend: "native" as const,
      resolvedMode: "review",
      resolvedModel: "claude-sonnet-4-6",
      resolvedProvider: "anthropic",
      taskClass: "review_code",
      routingReason: "defaulted to foreground model",
      fallbackUsed: false,
      lifecycle: "running" as const,
    };
    const saveSession = vi.fn().mockResolvedValue({
      ok: true,
      revision: "2",
    });
    const store = {
      list: vi.fn(() => []),
      listAll: vi.fn(() => [summary]),
      readSession: vi.fn().mockResolvedValue({
        ok: true,
        revision: "1",
        value: {
          summary,
          messages: [{ role: "user", content: "review" }],
          metadata: {
            mode: summary.mode,
            model: summary.model,
            totalInputTokens: 20,
            totalOutputTokens: 10,
            fleet,
          },
        },
      }),
      saveSession,
    } as any;
    const mgr = new AgentSessionManager(
      config,
      "/tmp",
      undefined,
      false,
      store,
    );

    const restored = await mgr.restorePersistedBackgroundSessions();

    expect(restored).toHaveLength(1);
    expect(restored[0].fleetMetadata).toEqual(
      expect.objectContaining({
        parentSessionId: "foreground-1",
        lifecycle: "interrupted",
        terminalReason: "extension_reloaded_during_run",
      }),
    );
    expect(mgr.getBackgroundStatus("persisted-bg")).toEqual(
      expect.objectContaining({ status: "error", done: true }),
    );
    expect(mgr.listPersistedFleetSessions().map((item) => item.id)).toEqual([
      "persisted-bg",
    ]);
    expect(saveSession).toHaveBeenCalledWith(
      expect.objectContaining({ expectedRevision: "1" }),
    );
  });

  it("disables reasoning effort when the background route disables thinking", async () => {
    mocks.resolveBackgroundRoute.mockResolvedValueOnce({
      resolvedMode: "review",
      resolvedModel: "gpt-5.4-pro",
      resolvedProvider: "codex",
      taskClass: "review_plan",
      routingReason: "test route",
      fallbackUsed: false,
      thinkingBudget: 0,
      toolProfile: "review",
    });

    const mgr = new AgentSessionManager(config, "/tmp");
    mgr.setToolContext(toolCtx);

    const spawned = await mgr.spawnBackground({
      task: "plan review",
      message: "review the plan",
      taskClass: "review_plan",
    });

    const session = (mgr as any).sessions.get(spawned.sessionId);
    expect(session.reasoningEffort).toBe("none");
  });

  it("does not forward legacy route turn limits to background engine runs", async () => {
    mocks.resolveBackgroundRoute.mockResolvedValueOnce({
      resolvedMode: "code",
      resolvedModel: "claude-sonnet-4-6",
      resolvedProvider: "anthropic",
      taskClass: "general",
      routingReason: "legacy capped route",
      fallbackUsed: false,
      maxToolCalls: 1,
      maxApiTurns: 1,
    });

    const mgr = new AgentSessionManager(config, "/tmp");
    mgr.setToolContext(toolCtx);

    await mgr.spawnBackground({
      task: "uncapped background task",
      message: "run until complete",
      taskClass: "general",
    });

    await new Promise((r) => setTimeout(r, 0));
    expect(mocks.runArgs).toHaveBeenCalled();
    const opts = mocks.runArgs.mock.calls[0][1];
    expect(opts).toMatchObject({ isBackground: true });
    expect(opts.maxToolCalls).toBeUndefined();
    expect(opts.maxApiTurns).toBeUndefined();
  });

  it("killBackground stops a running session and returns partial output", async () => {
    // Use a long-running generator so the session stays "streaming"
    let yieldControl: () => void = () => {};
    mocks.runBehavior.mockReturnValue(
      (async function* () {
        yield { type: "text_delta", text: "partial work" };
        await new Promise<void>((resolve) => {
          yieldControl = resolve;
        });
        yield { type: "done" };
      })(),
    );

    const mgr = new AgentSessionManager(config, "/tmp");
    mgr.setToolContext(toolCtx);

    const result = await mgr.spawnBackground({
      task: "killable task",
      message: "do work",
    });

    // Give async generator time to start
    await new Promise((r) => setTimeout(r, 10));

    const killResult = mgr.killBackground(result.sessionId, "taking too long");
    expect(killResult.killed).toBe(true);
    expect(killResult.partialOutput).toBeDefined();

    const status = mgr.getBackgroundStatus(result.sessionId);
    expect(status).toMatchObject({ status: "cancelled", done: true });

    const info = mgr
      .getBgSessionInfos()
      .find((s: any) => s.id === result.sessionId);
    expect(info).toMatchObject({ status: "cancelled" });
    expect(info?.completedAt).toEqual(expect.any(Number));
    await expect(mgr.waitForBackground(result.sessionId)).resolves.toBe(
      "background result",
    );

    // Cleanup: resolve the pending promise so the generator can exit
    yieldControl();
  });

  it("killBackground stops an awaiting-approval background session", async () => {
    let release: (() => void) | undefined;
    mocks.runBehavior.mockReturnValue(
      (async function* () {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        yield { type: "done" };
      })(),
    );

    const mgr = new AgentSessionManager(config, "/tmp");
    mgr.setToolContext(toolCtx);

    const result = await mgr.spawnBackground({
      task: "approval task",
      message: "wait for approval",
    });
    const session = (mgr as any).sessions.get(result.sessionId);
    session.status = "awaiting_approval";

    const killResult = mgr.killBackground(result.sessionId, "approval stuck");
    expect(killResult.killed).toBe(true);

    expect(mgr.getBackgroundStatus(result.sessionId)).toMatchObject({
      status: "cancelled",
      done: true,
    });
    const info = mgr
      .getBgSessionInfos()
      .find((s: any) => s.id === result.sessionId);
    expect(info).toMatchObject({ status: "cancelled" });
    expect(info?.completedAt).toEqual(expect.any(Number));

    release?.();
  });

  it("killBackground returns false for non-existent session", () => {
    const mgr = new AgentSessionManager(config, "/tmp");
    mgr.setToolContext(toolCtx);

    const result = mgr.killBackground("nonexistent");
    expect(result.killed).toBe(false);
  });

  it("shows file-specific status detail from tool input when available", async () => {
    let release: (() => void) | undefined;

    mocks.runBehavior.mockReturnValue(
      (async function* () {
        yield { type: "tool_start", toolCallId: "tc-1", toolName: "read_file" };
        yield {
          type: "tool_result",
          toolCallId: "tc-1",
          toolName: "read_file",
          result: [{ type: "text", text: "ok" }],
          durationMs: 5,
          input: { path: "src/agent/ChatViewProvider.ts" },
        };
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        yield { type: "done" };
      })(),
    );

    const mgr = new AgentSessionManager(config, "/tmp");
    mgr.setToolContext(toolCtx);

    const spawned = await mgr.spawnBackground({
      task: "status detail",
      message: "inspect file",
    });

    const session = (mgr as any).sessions.get(spawned.sessionId);
    session.status = "streaming";
    session.currentTool = "read_file";

    const info = await waitFor(
      () =>
        mgr.getBgSessionInfos().find((s: any) => s.id === spawned.sessionId),
      (value) =>
        value?.displayStatus === "Reading src/agent/ChatViewProvider.ts",
    );
    expect(info).toBeDefined();
    expect(info!.displayStatus).toBe("Reading src/agent/ChatViewProvider.ts");
    expect(info!.displayStatusSource).toBe("heuristic");

    release?.();
  });

  it("clears stale file detail when a new tool starts", async () => {
    mocks.runBehavior.mockReturnValue(
      (async function* () {
        yield { type: "tool_start", toolCallId: "tc-1", toolName: "read_file" };
        yield {
          type: "tool_result",
          toolCallId: "tc-1",
          toolName: "read_file",
          result: [{ type: "text", text: "ok" }],
          durationMs: 5,
          input: { path: "src/agent/ChatViewProvider.ts" },
        };
        yield {
          type: "tool_start",
          toolCallId: "tc-2",
          toolName: "execute_command",
        };
        yield { type: "done" };
      })(),
    );

    const mgr = new AgentSessionManager(config, "/tmp");
    mgr.setToolContext(toolCtx);

    const spawned = await mgr.spawnBackground({
      task: "status detail clear",
      message: "inspect then run",
    });

    await new Promise((r) => setTimeout(r, 0));

    const session = (mgr as any).sessions.get(spawned.sessionId);
    session.status = "streaming";
    session.currentTool = "execute_command";

    const info = mgr
      .getBgSessionInfos()
      .find((s: any) => s.id === spawned.sessionId);
    expect(info).toBeDefined();
    expect(info!.displayStatus).toBe("Running command");
    expect(info!.displayStatusSource).toBe("heuristic");
  });

  it("normalizes model summary statuses to user-facing labels", async () => {
    mocks.runBehavior.mockReturnValue(
      (async function* () {
        yield { type: "tool_start", toolCallId: "tc-1", toolName: "read_file" };
        yield { type: "done" };
      })(),
    );

    const mgr = new AgentSessionManager(config, "/tmp");
    mgr.setToolContext(toolCtx);

    const spawned = await mgr.spawnBackground({
      task: "status normalization",
      message: "run",
    });

    const summary = (mgr as any).getOrInitBgSummary(spawned.sessionId);
    summary.shortStatus = "Streaming file analysis";
    summary.generatedAt = Date.now();

    const info = mgr
      .getBgSessionInfos()
      .find((s: any) => s.id === spawned.sessionId);
    expect(info).toBeDefined();

    // Force a non-terminal state to verify model-summary normalization path.
    const session = (mgr as any).sessions.get(spawned.sessionId);
    session.status = "streaming";

    const liveInfo = mgr
      .getBgSessionInfos()
      .find((s: any) => s.id === spawned.sessionId);
    expect(liveInfo).toBeDefined();
    expect(liveInfo!.displayStatus).toBe("Reviewing code");
    expect(liveInfo!.displayStatusSource).toBe("model");
  });

  it("getBackgroundStatus returns running progress metadata without waiting", async () => {
    let release: (() => void) | undefined;
    mocks.resolveBackgroundRoute.mockResolvedValueOnce({
      resolvedMode: "ask",
      resolvedModel: "claude-sonnet-4-6",
      resolvedProvider: "anthropic",
      taskClass: "readonly-research",
      routingReason: "test route",
      fallbackUsed: false,
      toolProfile: "readonly-research",
    });
    mocks.runBehavior.mockReturnValue(
      (async function* () {
        yield { type: "text_delta", text: "I found the likely test files" };
        yield { type: "tool_start", toolCallId: "tc-1", toolName: "read_file" };
        yield {
          type: "api_request",
          requestId: "r1",
          model: "claude-sonnet-4-6",
          inputTokens: 100,
          uncachedInputTokens: 80,
          outputTokens: 20,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          durationMs: 10,
          timeToFirstToken: 2,
        };
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        yield { type: "done" };
      })(),
    );

    const mgr = new AgentSessionManager(config, "/tmp");
    mgr.setToolContext(toolCtx);

    const spawned = await mgr.spawnBackground({
      task: "research tests",
      message: "inspect tests",
      taskClass: "readonly-research",
    });

    await new Promise((r) => setTimeout(r, 0));

    const status = mgr.getBackgroundStatus(spawned.sessionId);
    expect(status.done).toBe(false);
    expect(status.streamingPreview).toContain("likely test files");
    expect(status.progressSummary).toBeDefined();
    expect(status.resolvedMode).toBe("ask");
    expect(status.resolvedModel).toBe("claude-sonnet-4-6");
    expect(status.resolvedProvider).toBe("anthropic");
    expect(status.taskClass).toBe("readonly-research");
    expect(status.toolCalls).toBe(1);
    expect(status.tokenUsage).toBe(100);
    expect(status.partialOutput).toBeUndefined();

    release?.();
  });

  it("prefers heuristic over generic model thinking while tool activity is visible", async () => {
    mocks.runBehavior.mockReturnValue(
      (async function* () {
        yield {
          type: "tool_start",
          toolCallId: "tc-1",
          toolName: "execute_command",
        };
        yield { type: "text_delta", text: "running npm test" };
        yield { type: "done" };
      })(),
    );

    const mgr = new AgentSessionManager(config, "/tmp");
    mgr.setToolContext(toolCtx);

    const spawned = await mgr.spawnBackground({
      task: "generic fallback",
      message: "run tests",
    });

    const summary = (mgr as any).getOrInitBgSummary(spawned.sessionId);
    summary.shortStatus = "Streaming active";
    summary.generatedAt = Date.now();

    const session = (mgr as any).sessions.get(spawned.sessionId);
    session.status = "streaming";
    session.currentTool = "execute_command";

    const info = mgr
      .getBgSessionInfos()
      .find((s: any) => s.id === spawned.sessionId);
    expect(info).toBeDefined();
    expect(info!.displayStatus).toBe("Running command");
    expect(info!.displayStatusSource).toBe("heuristic");

    const statusInfo = mgr.getBackgroundStatus(spawned.sessionId);
    expect(statusInfo.displayStatus).toBe("Running command");
  });

  it("resumes the foreground session when a background result returns after it stopped", async () => {
    mocks.runBehavior
      .mockReturnValueOnce(
        (async function* () {
          yield { type: "done" };
        })(),
      )
      .mockReturnValueOnce(
        (async function* () {
          yield { type: "done" };
        })(),
      );

    const mgr = new AgentSessionManager(config, "/tmp");
    mgr.setToolContext(toolCtx);

    const fg = await mgr.createSession("code");
    const sendMessageSpy = vi.spyOn(mgr, "sendMessage");

    const result = await mgr.spawnBackground({
      task: "inspect failing tests",
      message: "run the investigation",
    });

    await new Promise((r) => setTimeout(r, 0));

    expect(sendMessageSpy).toHaveBeenCalledWith(
      fg.id,
      expect.stringContaining(
        `The background agent for "inspect failing tests" has returned while you were stopped.`,
      ),
      fg.mode,
    );
    expect(sendMessageSpy).toHaveBeenCalledWith(
      fg.id,
      expect.stringContaining(
        `<background_result task="inspect failing tests" sessionId="${result.sessionId}">`,
      ),
      fg.mode,
    );
  });

  it("does not resume the foreground session if it is still running", async () => {
    let releaseForeground: (() => void) | undefined;
    mocks.runBehavior
      .mockReturnValueOnce(
        (async function* () {
          await new Promise<void>((resolve) => {
            releaseForeground = resolve;
          });
          yield { type: "done" };
        })(),
      )
      .mockReturnValueOnce(
        (async function* () {
          yield { type: "done" };
        })(),
      );

    const mgr = new AgentSessionManager(config, "/tmp");
    mgr.setToolContext(toolCtx);

    const fg = await mgr.createSession("code");
    const sendPromise = mgr.sendMessage(fg.id, "keep working", fg.mode);
    await new Promise((r) => setTimeout(r, 0));

    const sendMessageSpy = vi.spyOn(mgr, "sendMessage");

    await mgr.spawnBackground({
      task: "inspect failing tests",
      message: "run the investigation",
    });

    await new Promise((r) => setTimeout(r, 0));

    expect(sendMessageSpy).not.toHaveBeenCalledWith(
      fg.id,
      expect.stringContaining("The background agent for"),
      fg.mode,
    );

    releaseForeground?.();
    await sendPromise;
  });

  it("auto-continues once after a queued mode switch resume", async () => {
    const mgr = new AgentSessionManager(config, "/tmp");
    mgr.setToolContext(toolCtx);

    const fg = await mgr.createSession("architect");
    const addUserMessageSpy = vi.spyOn(fg, "addUserMessage");

    mgr.queueModeSwitchResume(fg.id, "code", {
      reason: "Implementation should happen in code mode",
      followUp: "start with the concrete fix",
    });

    await mgr.sendMessage(fg.id, "plan the fix", fg.mode);

    expect(addUserMessageSpy).toHaveBeenNthCalledWith(1, "plan the fix", {
      displayText: undefined,
      isSlashCommand: false,
    });
    expect(addUserMessageSpy).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("You just switched this session to code mode."),
    );
    expect(addUserMessageSpy).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining(
        "Continue immediately in the new mode and start the next concrete implementation step now.",
      ),
    );
    expect(addUserMessageSpy).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining(
        "Switch reason: Implementation should happen in code mode",
      ),
    );
    expect(addUserMessageSpy).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("User follow-up: start with the concrete fix"),
    );
    expect(fg.consumePendingModeResume()).toBeNull();
    expect(mocks.runBehavior).toHaveBeenCalledTimes(2);
  });
});
