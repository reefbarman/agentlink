import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp } from "fs/promises";
import * as os from "os";
import * as path from "path";

import { AgentSessionManager } from "./AgentSessionManager.js";
import { ProviderRegistry } from "./providers/index.js";
import type { ToolDispatchContext } from "./toolAdapter.js";
import { WorktreeFleetExchangeStore } from "../worktree/WorktreeFleetExchangeStore.js";

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
        setPendingInterjection: vi.fn(() => true),
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
        getLastFinalMarker: vi.fn(() => undefined),
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

  it("launches isolated delegation through the worktree provider and records it", async () => {
    const globalStoragePath = await mkdtemp(
      path.join(os.tmpdir(), "fleet-worktree-test-"),
    );
    const start = vi.fn().mockResolvedValue({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "opened",
            worktreePath: "/tmp/repo-worktrees/task",
            intentId: "intent-1",
          }),
        },
      ],
    });
    const mgr = new AgentSessionManager(config, "/tmp");
    mgr.setToolContext({
      ...toolCtx,
      globalStorageUri: { fsPath: globalStoragePath } as any,
      worktreeAgentLaunchProvider: { start },
    });
    const result = await mgr.spawnBackground({
      task: "isolated",
      message: "edit safely",
      worktree: "isolated",
    });
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({ task: "isolated", autoSubmit: true }),
    );
    const fleet = (mgr as any).sessions.get(result.sessionId).fleetMetadata;
    expect(fleet).toEqual(
      expect.objectContaining({
        placement: "worktree",
        lifecycle: "running",
        worktreeExchangeId: expect.any(String),
        worktreePath: "/tmp/repo-worktrees/task",
      }),
    );
    await new WorktreeFleetExchangeStore(globalStoragePath).update(
      fleet.worktreeExchangeId,
      {
        status: "completed",
        childSessionId: "child-window-session",
        resultText: "worktree result",
        usage: { inputTokens: 12, outputTokens: 3 },
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect((mgr as any).sessions.get(result.sessionId).fleetMetadata).toEqual(
      expect.objectContaining({
        lifecycle: "completed",
        childSessionId: "child-window-session",
        finalResult: "worktree result",
      }),
    );
  });

  it("rejects overlapping shared-workspace ownership", async () => {
    mocks.runBehavior.mockImplementation(() =>
      (async function* () {
        await new Promise<never>(() => undefined);
        yield { type: "done" };
      })(),
    );
    const mgr = new AgentSessionManager(config, "/tmp");
    mgr.setToolContext(toolCtx);
    await mgr.spawnBackground({
      task: "owner",
      message: "work",
      ownedPaths: ["src/agent"],
    });
    await expect(
      mgr.spawnBackground({
        task: "conflict",
        message: "work",
        ownedPaths: ["src/agent/tools"],
      }),
    ).rejects.toMatchObject({
      result: expect.objectContaining({ code: "workspace_conflict" }),
    });
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
    const second = await mgr.spawnBackground({
      task: "second",
      message: "wait",
    });
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

  it("requests a wrap-up at the budget limit and lets the agent deliver findings", async () => {
    mocks.runBehavior.mockReturnValue(
      (async function* () {
        yield { type: "tool_start", toolCallId: "tc-1", toolName: "search" };
        yield { type: "tool_start", toolCallId: "tc-2", toolName: "read" };
        yield { type: "done" };
      })(),
    );
    const mgr = new AgentSessionManager(config, "/tmp");
    mgr.setToolContext(toolCtx);

    const spawned = await mgr.spawnBackground({
      task: "bounded task",
      message: "run",
      budget: { maxToolCalls: 2 },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const session = (mgr as any).sessions.get(spawned.sessionId);

    // Hitting the limit injects a wrap-up instruction instead of killing the
    // run, so the agent's findings survive.
    expect(session.setPendingInterjection).toHaveBeenCalledWith(
      expect.stringContaining("budget for this task is exhausted"),
      expect.any(String),
    );
    expect(session.abort).not.toHaveBeenCalled();
    expect(session.fleetMetadata).toEqual(
      expect.objectContaining({
        lifecycle: "completed",
        budgetUsage: expect.objectContaining({ toolCalls: 2 }),
      }),
    );
  });

  it("preserves terminal engine errors as background failures", async () => {
    mocks.runBehavior.mockReturnValue(
      (async function* () {
        yield {
          type: "error",
          error: "Provider stream first event timed out after 90000ms",
          retryable: true,
        };
      })(),
    );
    const mgr = new AgentSessionManager(config, "/tmp");
    mgr.setToolContext(toolCtx);

    const spawned = await mgr.spawnBackground({
      task: "provider timeout",
      message: "run",
    });
    const info = await waitFor(
      () =>
        mgr.getBgSessionInfos().find((item) => item.id === spawned.sessionId),
      (item) => item?.status === "error",
    );

    expect(info).toMatchObject({
      status: "error",
      errorMessage: "Provider stream first event timed out after 90000ms",
    });
  });

  it("hard-stops past the wrap-up grace overage and persists an explicit terminal reason", async () => {
    mocks.runBehavior.mockReturnValue(
      (async function* () {
        yield { type: "tool_start", toolCallId: "tc-1", toolName: "search" };
        yield { type: "tool_start", toolCallId: "tc-2", toolName: "read" };
        // Third call reaches the 1.5x overage cap (2 * 1.5 = 3) → hard kill.
        yield { type: "tool_start", toolCallId: "tc-3", toolName: "read" };
        yield { type: "done" };
      })(),
    );
    const mgr = new AgentSessionManager(config, "/tmp");
    mgr.setToolContext(toolCtx);

    const spawned = await mgr.spawnBackground({
      task: "bounded task",
      message: "run",
      budget: { maxToolCalls: 2 },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const session = (mgr as any).sessions.get(spawned.sessionId);

    expect(session.abort).toHaveBeenCalled();
    expect(session.fleetMetadata).toEqual(
      expect.objectContaining({
        lifecycle: "budget_exhausted",
        terminalReason: "budget_exhausted:tool_calls",
        budgetUsage: expect.objectContaining({ toolCalls: 3 }),
      }),
    );
  });

  it("passes session-scoped budget caps into the background engine run", async () => {
    const mgr = new AgentSessionManager(config, "/tmp");
    mgr.setToolContext(toolCtx);

    await mgr.spawnBackground({
      task: "capped",
      message: "run",
      budget: { maxToolCalls: 5, maxApiTurns: 7 },
    });

    expect(mocks.runArgs).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ maxToolCalls: 5, maxApiTurns: 7 }),
    );
  });

  it("does not apply shared subtree budget caps to a single engine run", async () => {
    const mgr = new AgentSessionManager(config, "/tmp");
    mgr.setToolContext(toolCtx);

    await mgr.spawnBackground({
      task: "subtree owner",
      message: "run",
      budget: { maxToolCalls: 5, maxApiTurns: 7, scope: "subtree" },
    });

    expect(mocks.runArgs).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        maxToolCalls: undefined,
        maxApiTurns: undefined,
      }),
    );
  });

  it("counts ACP usage as uncached input + output, not cache reads", async () => {
    mocks.runBehavior.mockReturnValue(
      (async function* () {
        await new Promise<never>(() => undefined);
        yield { type: "done" };
      })(),
    );
    const mgr = new AgentSessionManager(config, "/tmp");
    mgr.setToolContext(toolCtx);

    const spawned = await mgr.spawnBackground({
      task: "acp usage",
      message: "run",
    });
    const session = (mgr as any).sessions.get(spawned.sessionId);
    const meta = (mgr as any).bgMeta.get(spawned.sessionId);

    (mgr as any).applyAcpPromptResponseUsage(session, {
      stopReason: "end_turn",
      usage: {
        totalTokens: 5000,
        inputTokens: 300,
        outputTokens: 200,
        cachedReadTokens: 4500,
      },
    });

    expect(meta.tokenUsage).toBe(500);
    expect(meta.apiTurns).toBe(1);
    mgr.stopSession(spawned.sessionId);
  });

  it("does not count ACP context occupancy against the token budget", async () => {
    mocks.runBehavior.mockReturnValue(
      (async function* () {
        await new Promise<never>(() => undefined);
        yield { type: "done" };
      })(),
    );
    const mgr = new AgentSessionManager(config, "/tmp");
    mgr.setToolContext(toolCtx);

    const spawned = await mgr.spawnBackground({
      task: "acp context",
      message: "run",
      budget: { maxTokens: 100_000 },
    });
    const session = (mgr as any).sessions.get(spawned.sessionId);
    const meta = (mgr as any).bgMeta.get(spawned.sessionId);

    (mgr as any).applyAcpSessionUpdate({
      session,
      assistantTextParts: [],
      update: { sessionUpdate: "usage_update", used: 150_000, size: 200_000 },
    });

    // Context occupancy is not spend: the budget must not trip.
    expect(meta.tokenUsage).toBe(0);
    expect(session.lastInputTokens).toBe(150_000);
    expect(session.abort).not.toHaveBeenCalled();
    expect(session.fleetMetadata.lifecycle).toBe("running");
    mgr.stopSession(spawned.sessionId);
  });

  it("reserves child capacity from a subtree budget", async () => {
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
      task: "budget owner",
      message: "coordinate",
      budget: { maxTokens: 100, scope: "subtree" },
    });
    await mgr.spawnBackground(
      {
        task: "first child",
        message: "work",
        budget: { maxTokens: 60 },
      },
      parent.sessionId,
    );

    await expect(
      mgr.spawnBackground(
        {
          task: "second child",
          message: "work",
          budget: { maxTokens: 50 },
        },
        parent.sessionId,
      ),
    ).rejects.toMatchObject({
      result: expect.objectContaining({
        code: "budget_reservation",
        limit: 100,
      }),
    });
    mgr.stopSession(parent.sessionId);
  });

  it("emits a durable warning and nudges the agent before a session budget is exhausted", async () => {
    mocks.runBehavior.mockReturnValue(
      (async function* () {
        await new Promise<never>(() => undefined);
        yield { type: "done" };
      })(),
    );
    const mgr = new AgentSessionManager(config, "/tmp");
    mgr.setToolContext(toolCtx);
    const spawned = await mgr.spawnBackground({
      task: "warning",
      message: "work",
      budget: { maxTokens: 100, warningThresholdRatio: 0.8 },
    });
    const session = (mgr as any).sessions.get(spawned.sessionId);
    const meta = (mgr as any).bgMeta.get(spawned.sessionId);
    meta.tokenUsage = 80;

    expect((mgr as any).enforceBackgroundBudget(session)).toBe(false);
    expect(session.fleetMetadata.budgetWarning).toEqual(
      expect.objectContaining({ kind: "tokens", ratio: 0.8 }),
    );
    expect(session.setPendingInterjection).toHaveBeenCalledWith(
      expect.stringContaining("80% of the token budget"),
      expect.any(String),
    );
    mgr.stopSession(spawned.sessionId);
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

  it("projects durable fleet ancestry, backend, lifecycle, and usage in tree order", async () => {
    const mgr = new AgentSessionManager(config, "/tmp");
    mgr.setToolContext(toolCtx);
    await mgr.createSession("code");
    const parent = await mgr.spawnBackground({
      task: "parent",
      message: "coordinate",
    });
    const child = await mgr.spawnBackground(
      { task: "child", message: "inspect" },
      parent.sessionId,
    );

    const infos = mgr.getBgSessionInfos();
    expect(infos.map((info) => info.id)).toEqual([
      parent.sessionId,
      child.sessionId,
    ]);
    expect(infos[1]).toEqual(
      expect.objectContaining({
        parentSessionId: parent.sessionId,
        rootSessionId: expect.any(String),
        depth: 2,
        placement: "background",
        backend: "native",
        capabilities: {
          canRead: true,
          canWrite: true,
          canExecute: true,
          canUseMcp: true,
          canDelegate: true,
          limitationReason: undefined,
        },
        lifecycle: expect.stringMatching(/running|completed/),
        totalInputTokens: expect.any(Number),
        totalOutputTokens: expect.any(Number),
        toolCalls: expect.any(Number),
      }),
    );
  });

  it("only exposes agents belonging to the current foreground session", async () => {
    const mgr = new AgentSessionManager(config, "/tmp");
    mgr.setToolContext(toolCtx);

    const firstForeground = await mgr.createSession("code");
    const firstAgent = await mgr.spawnBackground({
      task: "first session agent",
      message: "work",
    });
    const secondForeground = await mgr.createSession("code");
    const secondAgent = await mgr.spawnBackground({
      task: "second session agent",
      message: "work",
    });

    expect(mgr.getBgSessionInfos().map((info) => info.id)).toEqual([
      secondAgent.sessionId,
    ]);

    mgr.switchTo(firstForeground.id);
    expect(mgr.getBgSessionInfos().map((info) => info.id)).toEqual([
      firstAgent.sessionId,
    ]);
    mgr.switchTo(secondForeground.id);
  });

  it("hides completed agents after six hours", async () => {
    const mgr = new AgentSessionManager(config, "/tmp");
    mgr.setToolContext(toolCtx);
    await mgr.createSession("code");
    const spawned = await mgr.spawnBackground({
      task: "stale agent",
      message: "work",
    });
    await waitFor(
      () =>
        (mgr as any).sessions.get(spawned.sessionId).fleetMetadata.lifecycle,
      (lifecycle) => lifecycle === "completed",
    );

    const session = (mgr as any).sessions.get(spawned.sessionId);
    const staleTimestamp = Date.now() - 6 * 60 * 60 * 1000 - 1;
    session.lastActiveAt = staleTimestamp;
    session.fleetMetadata.completedAt = staleTimestamp;

    expect(mgr.getBgSessionInfos()).toEqual([]);
  });

  it("prefers the structured set_task_status result when the final turn has no prose", async () => {
    const mgr = new AgentSessionManager(config, "/tmp");
    mgr.setToolContext(toolCtx);
    await mgr.createSession("code");
    const spawned = await mgr.spawnBackground({
      task: "structured result",
      message: "work",
    });
    await waitFor(
      () =>
        (mgr as any).sessions.get(spawned.sessionId).fleetMetadata.lifecycle,
      (lifecycle) => lifecycle === "completed",
    );

    const session = (mgr as any).sessions.get(spawned.sessionId);
    session.getLastAssistantText.mockReturnValue(undefined);
    session.getLastFinalMarker.mockReturnValue({
      status: "completed",
      summary: "one-line summary",
      result: { type: "text", text: "full structured report" },
      source: "tool",
    });
    // Exercise the done-event window, which fires before bgFinalResults is set.
    (mgr as any).bgFinalResults.delete(spawned.sessionId);

    expect(mgr.getBackgroundResult(spawned.sessionId)).toEqual({
      resultText: "full structured report",
      summary: "one-line summary",
    });
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
    const second = await mgr.spawnBackground({
      task: "second",
      message: "two",
    });

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
    ).toEqual(expect.objectContaining({ killed: false }));
  });

  it("steers authorized descendants at a safe boundary", async () => {
    const mgr = new AgentSessionManager(config, "/tmp");
    mgr.setToolContext(toolCtx);
    const foreground = await mgr.createSession("code");
    const child = await mgr.spawnBackground({ task: "child", message: "work" });
    const session = (mgr as any).sessions.get(child.sessionId);
    session.status = "streaming";

    expect(
      mgr.steerAuthorizedBackground(
        foreground.id,
        child.sessionId,
        "Focus on the failing test",
      ),
    ).toEqual({ accepted: true });
    expect(session.setPendingInterjection).toHaveBeenCalledWith(
      "Focus on the failing test",
      expect.any(String),
      undefined,
      "Focus on the failing test",
    );
  });

  it("detaches a descendant subtree into an independent root", async () => {
    const mgr = new AgentSessionManager(config, "/tmp");
    mgr.setToolContext(toolCtx);
    const foreground = await mgr.createSession("code");
    const parent = await mgr.spawnBackground({
      task: "parent",
      message: "work",
    });
    const child = await mgr.spawnBackground(
      { task: "child", message: "work" },
      parent.sessionId,
    );

    expect(
      mgr.detachAuthorizedBackground(foreground.id, parent.sessionId),
    ).toEqual({ detached: true });
    expect((mgr as any).sessions.get(parent.sessionId).fleetMetadata).toEqual(
      expect.objectContaining({
        parentSessionId: undefined,
        rootSessionId: parent.sessionId,
        depth: 1,
      }),
    );
    expect((mgr as any).sessions.get(child.sessionId).fleetMetadata).toEqual(
      expect.objectContaining({ rootSessionId: parent.sessionId, depth: 2 }),
    );
  });

  it("pauses native work durably and resumes it as a linked replacement", async () => {
    mocks.runBehavior.mockImplementation(() =>
      (async function* () {
        await new Promise<never>(() => undefined);
        yield { type: "done" };
      })(),
    );
    const mgr = new AgentSessionManager(config, "/tmp");
    mgr.setToolContext(toolCtx);
    await mgr.createSession("code");
    const original = await mgr.spawnBackground({
      task: "pause me",
      message: "work",
    });

    expect(mgr.pauseBackground(original.sessionId)).toEqual({ paused: true });
    expect((mgr as any).sessions.get(original.sessionId).fleetMetadata).toEqual(
      expect.objectContaining({
        lifecycle: "paused",
        terminalReason: "paused_by_user",
      }),
    );

    const resumed = await mgr.resumeBackground(original.sessionId);
    expect((mgr as any).sessions.get(resumed.sessionId).fleetMetadata).toEqual(
      expect.objectContaining({ resumedFromSessionId: original.sessionId }),
    );
    expect((mgr as any).sessions.get(original.sessionId).fleetMetadata).toEqual(
      expect.objectContaining({
        archivedAt: expect.any(Number),
        terminalReason: "resumed_as_new_session",
      }),
    );
    mgr.stopSession(resumed.sessionId);
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
      expectedResult: "review_findings",
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
    const session = Array.from((mgr as any).sessions.values()).at(-1) as any;
    expect(session.addUserMessage).toHaveBeenCalledWith("review thoroughly");
  });

  it("hands a runtime-captured review scope to the background agent", async () => {
    mocks.resolveBackgroundRoute.mockResolvedValueOnce({
      resolvedMode: "review",
      resolvedModel: "claude-sonnet-4-6",
      resolvedProvider: "anthropic",
      taskClass: "review_code",
      routingReason: "captured review",
      fallbackUsed: false,
    });
    const mgr = new AgentSessionManager(config, "/tmp");
    mgr.setToolContext(toolCtx);

    const spawned = await mgr.spawnBackground({
      task: "review captured diff",
      message: "Review this implementation.",
      taskClass: "review_code",
      reviewScope: {
        kind: "diff",
        label: "Foreground changes",
        content: "diff --git a/a.ts b/a.ts\n+const value = 2;\n",
      },
    });
    const session = (mgr as any).sessions.get(spawned.sessionId);
    const handedOff = session.addUserMessage.mock.calls[0][0];

    expect(handedOff).toContain("Review this implementation.");
    expect(handedOff).toContain("Runtime-captured review scope");
    expect(handedOff).toContain("Foreground changes");
    expect(handedOff).toContain("+const value = 2;");
  });

  it("renders structured final-marker results for the foreground", () => {
    const mgr = new AgentSessionManager(config, "/tmp");
    const structuredResult = {
      type: "review_findings" as const,
      findings: [
        {
          severity: "medium" as const,
          message: "Retry state is not persisted.",
          path: "src/indexer/workerLib.ts",
          line: 88,
        },
      ],
      reviewedScope: "abc123..def456",
      emptyDiff: false,
    };
    const resolved = (mgr as any).resolveBackgroundResult(
      {
        getLastFinalMarker: () => ({ result: structuredResult }),
        getLastAssistantText: () => undefined,
        fleetMetadata: { delegation: { expectedResult: "review_findings" } },
      },
      "fallback",
    );

    expect(resolved.structuredResult).toEqual(structuredResult);
    expect(resolved.resultText).toContain(
      "**MEDIUM** — `src/indexer/workerLib.ts:88`: Retry state is not persisted.",
    );
    expect(resolved.resultText).not.toContain('"type":"review_findings"');
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

  it("persists sequenced fleet events and read state", async () => {
    const mgr = new AgentSessionManager(config, "/tmp");
    mgr.setToolContext(toolCtx);
    const onFleetEvent = vi.fn();
    mgr.onFleetEvent = onFleetEvent;
    const spawned = await mgr.spawnBackground({
      task: "eventful",
      message: "work",
    });
    await waitFor(
      () =>
        (mgr as any).sessions.get(spawned.sessionId).fleetMetadata.lifecycle,
      (lifecycle) => lifecycle === "completed",
    );
    const info = mgr
      .getBgSessionInfos()
      .find((item) => item.id === spawned.sessionId);
    expect(info?.events?.map((event) => event.type)).toEqual([
      "queued",
      "started",
      "completed",
    ]);
    expect(info?.unreadEventCount).toBe(3);
    expect(onFleetEvent).toHaveBeenCalledTimes(3);

    expect(mgr.markFleetEventsRead(spawned.sessionId)).toEqual({ marked: 3 });
    expect(
      mgr.getBgSessionInfos().find((item) => item.id === spawned.sessionId)
        ?.unreadEventCount,
    ).toBe(0);
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

    const restored =
      await mgr.restorePersistedBackgroundSessions("foreground-1");

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

  it("only restores background sessions from the current foreground tree", async () => {
    const now = Date.now();
    const summaries = ["current-bg", "historical-bg"].map((id) => ({
      schemaVersion: 1,
      id,
      mode: "agent",
      model: "gpt-5.4-pro",
      title: id,
      messageCount: 1,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      createdAt: now,
      lastActiveAt: now,
      background: true,
    }));
    const store = {
      list: vi.fn(() => []),
      listAll: vi.fn(() => summaries),
      readSession: vi.fn(async (id: string) => {
        const summary = summaries.find((candidate) => candidate.id === id)!;
        return {
          ok: true,
          revision: "1",
          value: {
            summary,
            messages: [],
            metadata: {
              mode: summary.mode,
              model: summary.model,
              totalInputTokens: 0,
              totalOutputTokens: 0,
              fleet: {
                schemaVersion: 1,
                placement: "background",
                task: summary.title,
                rootSessionId:
                  id === "current-bg" ? "foreground-1" : "foreground-old",
                parentSessionId:
                  id === "current-bg" ? "foreground-1" : "foreground-old",
                depth: 1,
                lifecycle: "completed",
              },
            },
          },
        };
      }),
    } as any;
    const mgr = new AgentSessionManager(
      config,
      "/tmp",
      undefined,
      false,
      store,
    );

    const restored =
      await mgr.restorePersistedBackgroundSessions("foreground-1");

    expect(restored.map((session) => session.id)).toEqual(["current-bg"]);
    expect(mgr.getBgSessionInfos().map((session) => session.id)).toEqual([
      "current-bg",
    ]);
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

  it("continues mode-switch resumes independently of the todo auto-continue budget, capped per turn", async () => {
    const mgr = new AgentSessionManager(config, "/tmp");
    mgr.setToolContext(toolCtx);

    const fg = await mgr.createSession("architect");
    const addUserMessageSpy = vi.spyOn(fg, "addUserMessage");

    // Every run queues another resume, as if each continuation switched modes
    // again. The old shared MAX_AUTO_CONTINUE budget stopped this at 5.
    mocks.runBehavior.mockImplementation(async function* () {
      mgr.queueModeSwitchResume(fg.id, "code");
      yield { type: "done" };
    });
    mocks.runBehavior.mockClear();

    await mgr.sendMessage(fg.id, "plan the fix", fg.mode);

    // 1 initial run + 10 resumes; the 11th queued resume is dropped with a log.
    expect(mocks.runBehavior).toHaveBeenCalledTimes(11);
    expect(addUserMessageSpy).toHaveBeenCalledTimes(11);
    expect(fg.consumePendingModeResume()).toBeNull();
  });

  it("resumes after a queued mode switch when retrying a session", async () => {
    const mgr = new AgentSessionManager(config, "/tmp");
    mgr.setToolContext(toolCtx);

    const fg = await mgr.createSession("architect");
    const addUserMessageSpy = vi.spyOn(fg, "addUserMessage");
    const events: Array<{ type: string }> = [];
    mgr.onEvent = (_sessionId, event) => {
      events.push(event as { type: string });
    };
    // Fresh generator per run — the resumed run must also complete naturally.
    mocks.runBehavior.mockImplementation(async function* () {
      yield { type: "done" };
    });

    mgr.queueModeSwitchResume(fg.id, "code", {
      reason: "Implementation should happen in code mode",
      followUp: "start with the concrete fix",
    });

    await mgr.retrySession(fg.id);

    expect(addUserMessageSpy).toHaveBeenCalledWith(
      expect.stringContaining("You just switched this session to code mode."),
    );
    expect(mocks.runBehavior).toHaveBeenCalledTimes(2);
    expect(fg.consumePendingModeResume()).toBeNull();
    // The intermediate done is deferred; exactly one done reaches listeners.
    expect(events.filter((event) => event.type === "done")).toHaveLength(1);
  });
});
