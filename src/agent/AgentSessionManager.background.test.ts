import { beforeEach, describe, expect, it, vi } from "vitest";

import { AgentSessionManager } from "./AgentSessionManager.js";
import { ProviderRegistry } from "./providers/index.js";
import {
  createAgentToolRuntime,
  type ToolDispatchContext,
} from "./toolAdapter.js";
import { WorkspaceMutationCoordinator } from "./WorkspaceMutationCoordinator.js";

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
    createSession: vi.fn(async (opts: any): Promise<any> => {
      seq += 1;
      let pendingModeResume: {
        mode: string;
        reason?: string;
        followUp?: string;
      } | null = null;
      let assistantText = "background result";
      const messages: any[] = [];
      let pendingInterjectionCount = 0;
      const interjectionListeners = new Set<() => void>();
      const mockSession = {
        id: `bg-${seq}`,
        mode: opts.mode,
        agentMode: opts.agentMode,
        model: opts.config.model,
        reasoningEffort: "high",
        providerId: opts.providerId,
        projectScope: opts.projectScope,
        projectAvailability: opts.projectAvailability ?? "available",
        requireProjectRoot: vi.fn(() => opts.projectScope.rootPath),
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
        setPendingInterjection: vi.fn(() => {
          pendingInterjectionCount += 1;
          for (const listener of interjectionListeners) listener();
          return true;
        }),
        get hasPendingInterjections() {
          return pendingInterjectionCount > 0;
        },
        onPendingInterjectionQueued: vi.fn((listener: () => void) => {
          interjectionListeners.add(listener);
          return () => interjectionListeners.delete(listener);
        }),
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
          messages.push({ role: "assistant", content });
          const text = content
            .filter((block) => block?.type === "text")
            .map((block) => block.text)
            .join("");
          if (text) assistantText = text;
        }),
        appendToolResults: vi.fn((content: any[]) => {
          messages.push({ role: "user", content });
        }),
        appendRuntimeError: vi.fn(),
        consumePendingInterjection: vi.fn(() => {
          if (pendingInterjectionCount > 0) pendingInterjectionCount -= 1;
          return null;
        }),
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
        getAllMessages: vi.fn(() => messages),
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
        trackFileRead: vi.fn(),
        getAdvertisedSkills: vi.fn(() => []),
        getAdvertisedRules: vi.fn(() => []),
        trackLoadedSkill: vi.fn(),
        getActiveSkillAllowedTools: vi.fn(() => undefined),
      };
      return mockSession;
    }),
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
      getConfiguration: () => ({
        get: (key: string, defaultValue: unknown) =>
          key === "webAccess.searchBackend" || key === "webAccess.fetchBackend"
            ? "disabled"
            : defaultValue,
      }),
    },
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
    getWebAccessSettings: vi.fn(() => ({
      searchBackend: "disabled" as const,
      fetchBackend: "disabled" as const,
    })),
  };

  const toolCtx: ToolDispatchContext = {
    approvalManager: { bindSessionProject: vi.fn() } as any,
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

  it("inherits and live-syncs the parent's full approval mode for a shared child", async () => {
    const mgr = new AgentSessionManager(
      config,
      "/tmp",
      undefined,
      false,
      undefined,
      undefined,
      { maxConcurrent: 0 },
    );
    const parent = await mgr.createSession("code");
    const inheritSessionApprovalState = vi.fn();
    mgr.setSessionApprovalMode(parent.id, {
      commandApprovalPolicy: "sensitive",
      approvalPolicy: "on-request",
      approvalReviewer: "auto-review",
      executionPreset: "native-manual",
    });
    mgr.setToolContext({
      ...toolCtx,
      getCommandApprovalPolicy: (sessionId) =>
        mgr.getCommandApprovalPolicy(sessionId),
      inheritSessionApprovalState,
    });

    const child = await mgr.spawnBackground(
      { task: "inherit policy", message: "inspect" },
      parent.id,
    );
    expect(mgr.getSessionApprovalMode(child.sessionId)).toEqual({
      commandApprovalPolicy: "sensitive",
      approvalPolicy: "on-request",
      approvalReviewer: "auto-review",
      executionPreset: "native-manual",
    });
    expect(inheritSessionApprovalState).toHaveBeenCalledWith(
      parent.id,
      child.sessionId,
    );
    expect(toolCtx.approvalManager.bindSessionProject).toHaveBeenCalledWith(
      parent.id,
      parent.projectScope,
    );
    expect(toolCtx.approvalManager.bindSessionProject).toHaveBeenCalledWith(
      child.sessionId,
      expect.objectContaining({ projectId: parent.projectScope.projectId }),
    );

    mgr.setSessionApprovalMode(parent.id, {
      commandApprovalPolicy: "safe",
      approvalPolicy: "on-request",
      approvalReviewer: "user",
      executionPreset: "workspace-write",
    });
    expect(mgr.getSessionApprovalMode(child.sessionId)).toEqual({
      commandApprovalPolicy: "safe",
      approvalPolicy: "on-request",
      approvalReviewer: "user",
      executionPreset: "workspace-write",
    });
  });

  it("adds later parent session approvals to active shared children", async () => {
    const mgr = new AgentSessionManager(
      config,
      "/tmp",
      undefined,
      false,
      undefined,
      undefined,
      { maxConcurrent: 0 },
    );
    const parent = await mgr.createSession("code");
    const inheritSessionApprovalState = vi.fn();
    mgr.setToolContext({
      ...toolCtx,
      inheritSessionApprovalState,
    });

    const child = await mgr.spawnBackground(
      { task: "inherit later approval", message: "inspect" },
      parent.id,
    );
    inheritSessionApprovalState.mockClear();

    mgr.refreshBackgroundApprovalInheritance();

    expect(inheritSessionApprovalState).toHaveBeenCalledOnce();
    expect(inheritSessionApprovalState).toHaveBeenCalledWith(
      parent.id,
      child.sessionId,
    );
  });

  it("propagates later approval-mode changes through active shared descendants", async () => {
    const mgr = new AgentSessionManager(
      config,
      "/tmp",
      undefined,
      false,
      undefined,
      undefined,
      { maxConcurrent: 0 },
    );
    const root = await mgr.createSession("code");
    mgr.setToolContext({
      ...toolCtx,
      inheritSessionApprovalState: vi.fn(),
    });
    const child = await mgr.spawnBackground(
      { task: "child", message: "inspect" },
      root.id,
    );
    const grandchild = await mgr.spawnBackground(
      { task: "grandchild", message: "inspect more" },
      child.sessionId,
    );
    const updatedMode = {
      commandApprovalPolicy: "approve-for-me" as const,
      approvalPolicy: "on-request" as const,
      approvalReviewer: "auto-review" as const,
      executionPreset: "workspace-write" as const,
    };

    mgr.setSessionApprovalMode(root.id, updatedMode);

    expect(mgr.getSessionApprovalMode(child.sessionId)).toEqual(updatedMode);
    expect(mgr.getSessionApprovalMode(grandchild.sessionId)).toEqual(
      updatedMode,
    );
  });

  it("propagates later approvals down the active shared-agent tree", async () => {
    const mgr = new AgentSessionManager(
      config,
      "/tmp",
      undefined,
      false,
      undefined,
      undefined,
      { maxConcurrent: 0 },
    );
    const root = await mgr.createSession("code");
    const authority = new Map<string, Set<string>>([
      [root.id, new Set(["initial"])],
    ]);
    const inheritSessionApprovalState = vi.fn(
      (parentSessionId: string, childSessionId: string) => {
        const childAuthority = authority.get(childSessionId) ?? new Set();
        for (const grant of authority.get(parentSessionId) ?? []) {
          childAuthority.add(grant);
        }
        authority.set(childSessionId, childAuthority);
      },
    );
    mgr.setToolContext({
      ...toolCtx,
      inheritSessionApprovalState,
    });

    const child = await mgr.spawnBackground(
      { task: "child", message: "inspect" },
      root.id,
    );
    const grandchild = await mgr.spawnBackground(
      { task: "grandchild", message: "inspect more" },
      child.sessionId,
    );
    const sibling = await mgr.spawnBackground(
      { task: "sibling", message: "inspect separately" },
      root.id,
    );
    authority.get(root.id)?.add("later-root");
    authority.get(child.sessionId)?.add("child-only");

    mgr.refreshBackgroundApprovalInheritance();

    expect(authority.get(child.sessionId)).toEqual(
      new Set(["initial", "child-only", "later-root"]),
    );
    expect(authority.get(grandchild.sessionId)).toEqual(
      new Set(["initial", "child-only", "later-root"]),
    );
    expect(authority.get(sibling.sessionId)).toEqual(
      new Set(["initial", "later-root"]),
    );
    expect(authority.get(root.id)).toEqual(new Set(["initial", "later-root"]));
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

  it("allows a parent to have eight outstanding background children", async () => {
    const mgr = new AgentSessionManager(
      config,
      "/tmp",
      undefined,
      false,
      undefined,
      undefined,
      { maxConcurrent: 0 },
    );
    const parent = await mgr.createSession("code");
    mgr.setToolContext(toolCtx);

    for (let index = 0; index < 8; index++) {
      await mgr.spawnBackground(
        { task: `task-${index}`, message: `inspect-${index}` },
        parent.id,
      );
    }

    await expect(
      mgr.spawnBackground({ task: "task-8", message: "inspect-8" }, parent.id),
    ).rejects.toThrow(/per-parent child limit reached \(8\)/);
  });

  it("attaches inherited images to the native background prompt", async () => {
    const mgr = new AgentSessionManager(config, "/tmp");
    mgr.setToolContext(toolCtx);
    const images = [
      {
        name: "feature-ui.png",
        mimeType: "image/png",
        base64: "screenshot",
      },
    ];

    const spawned = await mgr.spawnBackground({
      task: "review UI",
      message: "Review the supplied screenshot",
      images,
    });
    const session = (mgr as any).sessions.get(spawned.sessionId);

    expect(session.addUserMessage).toHaveBeenCalledWith(
      "Review the supplied screenshot",
      { images },
    );
  });

  it("rejects legacy background worktree placement with /worktree guidance", async () => {
    const mgr = new AgentSessionManager(config, "/tmp");
    mgr.setToolContext(toolCtx);

    await expect(
      mgr.spawnBackground({
        task: "isolated",
        message: "edit safely",
        worktree: "isolated",
      } as any),
    ).rejects.toThrow(
      "spawn_background_agent cannot create worktrees; use the explicit /worktree command instead",
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

  it("releases the waiter's slot so a queued child can run during get_background_result", async () => {
    let releaseParent: (() => void) | undefined;
    mocks.runBehavior
      .mockReturnValueOnce(
        (async function* () {
          await new Promise<void>((resolve) => {
            releaseParent = resolve;
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

    const parent = await mgr.spawnBackground({
      task: "parent",
      message: "hold",
      permissionProfile: "review-only",
    });
    await waitFor(
      () => releaseParent,
      (release) => typeof release === "function",
    );
    const child = await mgr.spawnBackground(
      { task: "child review", message: "review" },
      parent.sessionId,
    );
    expect(mgr.getBackgroundStatus(child.sessionId).status).toBe("queued");

    // The parent occupies the only slot, but blocking on the child's result
    // must release it so the queued child can start and finish.
    const result = await mgr.waitForAuthorizedBackground(
      parent.sessionId,
      child.sessionId,
    );

    expect(result).toBe("background result");
    expect(mgr.getBackgroundStatus(child.sessionId).done).toBe(true);
    expect(mgr.getBackgroundStatus(parent.sessionId).done).toBe(false);
    expect((mgr as any).bgResultWaitHolds.size).toBe(0);

    releaseParent?.();
    await waitFor(
      () => mgr.getBackgroundStatus(parent.sessionId),
      (status) => status.done,
    );
    expect(mgr.getBackgroundStatus(parent.sessionId).done).toBe(true);
  });

  it("returns wait_interrupted when a user message arrives while blocked on get_background_result", async () => {
    let releaseBackground: (() => void) | undefined;
    mocks.runBehavior.mockReturnValueOnce(
      (async function* () {
        await new Promise<void>((resolve) => {
          releaseBackground = resolve;
        });
        yield { type: "done" };
      })(),
    );
    const mgr = new AgentSessionManager(config, "/tmp");
    mgr.setToolContext(toolCtx);
    const foreground = await mgr.createSession("code");
    const spawned = await mgr.spawnBackground(
      { task: "slow lane", message: "keep working" },
      foreground.id,
    );
    await waitFor(
      () => releaseBackground,
      (release) => typeof release === "function",
    );

    const waitPromise = mgr.waitForAuthorizedBackground(
      foreground.id,
      spawned.sessionId,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    (foreground as any).setPendingInterjection("new instructions", "queue-1");

    const interrupted = JSON.parse(await waitPromise);
    expect(interrupted).toMatchObject({
      status: "wait_interrupted",
      reason: "user_message_pending",
      done: false,
      sessionId: spawned.sessionId,
      retrySafe: true,
    });
    expect(mgr.getBackgroundStatus(spawned.sessionId).done).toBe(false);
    expect((mgr as any).bgResultWaiters.get(spawned.sessionId) ?? []).toEqual(
      [],
    );

    // After the engine drains the interjection, waiting again returns the
    // real result once the background agent finishes.
    (foreground as any).consumePendingInterjection();
    const resumedWait = mgr.waitForAuthorizedBackground(
      foreground.id,
      spawned.sessionId,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseBackground?.();
    await expect(resumedWait).resolves.toBe("background result");
  });

  it("returns wait_interrupted immediately when an interjection is already pending", async () => {
    mocks.runBehavior.mockReturnValueOnce(
      (async function* () {
        await new Promise<never>(() => undefined);
        yield { type: "done" };
      })(),
    );
    const mgr = new AgentSessionManager(config, "/tmp");
    mgr.setToolContext(toolCtx);
    const foreground = await mgr.createSession("code");
    const spawned = await mgr.spawnBackground(
      { task: "slow lane", message: "keep working" },
      foreground.id,
    );
    (foreground as any).setPendingInterjection("urgent request", "queue-1");

    const interrupted = JSON.parse(
      await mgr.waitForAuthorizedBackground(foreground.id, spawned.sessionId),
    );
    expect(interrupted).toMatchObject({
      status: "wait_interrupted",
      reason: "user_message_pending",
      done: false,
    });
    expect(mgr.getBackgroundStatus(spawned.sessionId).done).toBe(false);
  });

  it("releases the blocked parent's wait hold when steering interrupts it", async () => {
    let releaseParent: (() => void) | undefined;
    let releaseChild: (() => void) | undefined;
    mocks.runBehavior
      .mockReturnValueOnce(
        (async function* () {
          await new Promise<void>((resolve) => {
            releaseParent = resolve;
          });
          yield { type: "done" };
        })(),
      )
      .mockReturnValueOnce(
        (async function* () {
          await new Promise<void>((resolve) => {
            releaseChild = resolve;
          });
          yield { type: "done" };
        })(),
      );
    const mgr = new AgentSessionManager(config, "/tmp");
    mgr.setToolContext(toolCtx);
    const parent = await mgr.spawnBackground({
      task: "parent",
      message: "go",
      permissionProfile: "review-only",
    });
    await waitFor(
      () => releaseParent,
      (release) => typeof release === "function",
    );
    const child = await mgr.spawnBackground(
      { task: "child", message: "go" },
      parent.sessionId,
    );
    await waitFor(
      () => releaseChild,
      (release) => typeof release === "function",
    );

    const waitPromise = mgr.waitForAuthorizedBackground(
      parent.sessionId,
      child.sessionId,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((mgr as any).bgResultWaitHolds.size).toBe(1);

    const parentSession = (mgr as any).sessions.get(parent.sessionId);
    parentSession.setPendingInterjection("stop and report", "steer-1");

    const interrupted = JSON.parse(await waitPromise);
    expect(interrupted).toMatchObject({ status: "wait_interrupted" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((mgr as any).bgResultWaitHolds.size).toBe(0);
    expect(mgr.getBackgroundStatus(child.sessionId).done).toBe(false);

    releaseChild?.();
    releaseParent?.();
  });

  it("exposes in-flight ACP output in background transcript snapshots", async () => {
    configHost.getBackgroundAgentSettings.mockReturnValue({
      acpAgents: [{ id: "claude", command: "claude-agent-acp" }],
    });
    let releaseRunner!: () => void;
    const runnerBlocked = new Promise<void>((resolve) => {
      releaseRunner = resolve;
    });
    let outputEmitted!: () => void;
    const emitted = new Promise<void>((resolve) => {
      outputEmitted = resolve;
    });
    const acpBackgroundRunner = {
      run: vi.fn(async (request: any) => {
        request.onEvent({
          type: "update",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Partial ACP output" },
          },
        });
        outputEmitted();
        await runnerBlocked;
        request.onEvent({
          type: "stop",
          response: { stopReason: "end_turn" },
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
    const parent = await mgr.createSession("code");
    mgr.setToolContext(toolCtx);

    const spawned = await mgr.spawnBackground(
      {
        task: "external review",
        message: "review this",
        provider: "acp:claude",
      },
      parent.id,
    );
    await emitted;

    expect(mgr.getBackgroundTranscriptMessages(spawned.sessionId)).toEqual([
      {
        role: "assistant",
        content: [{ type: "text", text: "Partial ACP output" }],
      },
    ]);
    const session = (mgr as any).sessions.get(spawned.sessionId);
    expect(session.appendAssistantTurn).not.toHaveBeenCalled();

    releaseRunner();
    await mgr.waitForBackground(spawned.sessionId);
    expect(session.appendAssistantTurn).toHaveBeenCalledOnce();
    expect(mgr.getBackgroundTranscriptMessages(spawned.sessionId)).toEqual([
      {
        role: "assistant",
        content: [{ type: "text", text: "Partial ACP output" }],
      },
    ]);
  });

  it("projects and persists ACP tool lifecycle updates without renaming tools", async () => {
    configHost.getBackgroundAgentSettings.mockReturnValue({
      acpAgents: [{ id: "claude", command: "claude-agent-acp" }],
    });
    let releaseRunner!: () => void;
    const runnerBlocked = new Promise<void>((resolve) => {
      releaseRunner = resolve;
    });
    let startEmitted!: () => void;
    const started = new Promise<void>((resolve) => {
      startEmitted = resolve;
    });
    const acpBackgroundRunner = {
      run: vi.fn(async (request: any) => {
        request.onEvent({
          type: "update",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "bash-1",
            title: "Bash",
            status: "in_progress",
            rawInput: { command: "npm test" },
          },
        });
        startEmitted();
        await runnerBlocked;
        const completed = {
          sessionUpdate: "tool_call_update",
          toolCallId: "bash-1",
          status: "completed",
          rawOutput: "initial output",
        };
        request.onEvent({ type: "update", update: completed });
        request.onEvent({ type: "update", update: completed });
        request.onEvent({
          type: "update",
          update: {
            ...completed,
            rawOutput: "initial output\nlate output",
          },
        });
        request.onEvent({
          type: "stop",
          response: { stopReason: "end_turn" },
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
    const events: any[] = [];
    mgr.onEvent = (sessionId, event) => {
      events.push({ sessionId, ...event });
    };

    const spawned = await mgr.spawnBackground({
      task: "run tests",
      message: "run tests",
      provider: "acp:claude",
    });
    await started;

    expect(mgr.getBackgroundTranscriptMessages(spawned.sessionId)).toEqual([
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "bash-1",
            name: "Bash",
            input: { command: "npm test" },
          },
        ],
      },
    ]);
    expect(
      events.filter(
        (event) =>
          event.sessionId === spawned.sessionId && event.type === "tool_start",
      ),
    ).toEqual([
      expect.objectContaining({
        toolCallId: "bash-1",
        toolName: "Bash",
        input: { command: "npm test" },
      }),
    ]);

    releaseRunner();
    await mgr.waitForBackground(spawned.sessionId);

    const resultEvents = events.filter(
      (event) =>
        event.sessionId === spawned.sessionId && event.type === "tool_result",
    );
    expect(resultEvents).toHaveLength(2);
    expect(resultEvents[0]).toMatchObject({
      toolCallId: "bash-1",
      toolName: "Bash",
      input: { command: "npm test" },
      result: [{ type: "text", text: "initial output" }],
    });
    expect(resultEvents[1]).toMatchObject({
      toolCallId: "bash-1",
      toolName: "Bash",
      result: [{ type: "text", text: "initial output\nlate output" }],
    });
    expect(mgr.getBackgroundTranscriptMessages(spawned.sessionId)).toEqual([
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "bash-1",
            name: "Bash",
            input: { command: "npm test" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "bash-1",
            content: [{ type: "text", text: "initial output\nlate output" }],
          },
        ],
      },
    ]);
  });

  it("finalizes ACP tools when cancellation resolves the runner normally", async () => {
    configHost.getBackgroundAgentSettings.mockReturnValue({
      acpAgents: [{ id: "claude", command: "claude-agent-acp" }],
    });
    let releaseRunner!: () => void;
    const runnerBlocked = new Promise<void>((resolve) => {
      releaseRunner = resolve;
    });
    let startEmitted!: () => void;
    const started = new Promise<void>((resolve) => {
      startEmitted = resolve;
    });
    const acpBackgroundRunner = {
      run: vi.fn(async (request: any) => {
        request.onEvent({
          type: "update",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "bash-cancelled",
            title: "Bash",
            status: "in_progress",
            rawInput: { command: "sleep 60" },
          },
        });
        startEmitted();
        await runnerBlocked;
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
    const events: any[] = [];
    mgr.onEvent = (sessionId, event) => {
      events.push({ sessionId, ...event });
    };

    const spawned = await mgr.spawnBackground({
      task: "cancel command",
      message: "run command",
      provider: "acp:claude",
    });
    await started;
    expect(mgr.killBackground(spawned.sessionId, "stop").killed).toBe(true);
    releaseRunner();
    const resultEvents = await waitFor(
      () =>
        events.filter(
          (event) =>
            event.sessionId === spawned.sessionId &&
            event.type === "tool_result",
        ),
      (matching) => matching.length > 0,
    );

    expect(resultEvents).toEqual([
      expect.objectContaining({
        toolCallId: "bash-cancelled",
        toolName: "Bash",
        result: [
          {
            type: "text",
            text: JSON.stringify({
              status: "failed",
              output: "ACP background agent cancelled.",
            }),
          },
        ],
      }),
    ]);
    expect(mgr.getBackgroundTranscriptMessages(spawned.sessionId)).toEqual([
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "bash-cancelled",
            name: "Bash",
            input: { command: "sleep 60" },
          },
        ],
      },
      {
        role: "user",
        content: [
          expect.objectContaining({
            type: "tool_result",
            tool_use_id: "bash-cancelled",
            is_error: true,
          }),
        ],
      },
    ]);
  });

  it("publishes ACP completion only after terminal metadata is durable", async () => {
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
          response: { stopReason: "end_turn" },
        });
      }),
    };
    let releaseTerminalSave: () => void = () => {};
    const terminalSaveBlocked = new Promise<void>((resolve) => {
      releaseTerminalSave = resolve;
    });
    let notifyTerminalSaveStarted: () => void = () => {};
    const terminalSaveStarted = new Promise<void>((resolve) => {
      notifyTerminalSaveStarted = resolve;
    });
    const saveSession = vi.fn(async ({ session: record }: any) => {
      if (
        record.summary.background &&
        record.metadata.fleet?.lifecycle === "completed"
      ) {
        notifyTerminalSaveStarted();
        await terminalSaveBlocked;
      }
      return { ok: true, revision: String(saveSession.mock.calls.length) };
    });
    const store = {
      list: vi.fn(() => []),
      listAll: vi.fn(() => []),
      saveSession,
    } as any;
    const mgr = new AgentSessionManager(
      config,
      "/tmp",
      undefined,
      false,
      store,
      undefined,
      { maxConcurrent: 3 },
      { host: { config: configHost, acpBackgroundRunner } },
    );
    const parent = await mgr.createSession("code");
    mgr.setToolContext(toolCtx);
    let doneLifecycle: string | undefined;
    let notifyDone: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      notifyDone = resolve;
    });
    mgr.onEvent = (sessionId, event) => {
      if (event.type !== "done") return;
      doneLifecycle = mgr.getSession(sessionId)?.fleetMetadata?.lifecycle;
      notifyDone();
    };

    await mgr.spawnBackground(
      {
        task: "external review",
        message: "review this",
        provider: "acp:claude",
      },
      parent.id,
    );
    await terminalSaveStarted;

    expect(doneLifecycle).toBeUndefined();
    releaseTerminalSave();
    await done;
    expect(doneLifecycle).toBe("completed");
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
    const parent = await mgr.createSession("code");
    const inheritSessionApprovalState = vi.fn();
    mgr.setToolContext({ ...toolCtx, inheritSessionApprovalState });

    const spawned = await mgr.spawnBackground(
      {
        task: "external review",
        message: "review this",
        provider: "acp:claude",
      },
      parent.id,
    );
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
    expect(inheritSessionApprovalState).toHaveBeenCalledWith(
      parent.id,
      spawned.sessionId,
    );
    expect(mocks.resolveBackgroundRoute).not.toHaveBeenCalled();
  });

  it("routes only opposite-provider review tasks through the configured ACP reviewer", async () => {
    configHost.getBackgroundAgentSettings.mockReturnValue({
      reviewAgent: "acp:claude",
      acpAgents: [
        {
          id: "claude",
          provider: "anthropic",
          command: "claude-agent-acp",
        },
      ],
    });
    const acpBackgroundRunner = {
      run: vi.fn(async (request: any) => {
        request.onEvent({
          type: "update",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Adversarial ACP review" },
          },
        });
        request.onEvent({
          type: "stop",
          response: { stopReason: "end_turn" },
        });
      }),
    };
    const mgr = new AgentSessionManager(
      { ...config, model: "gpt-5.6-sol" },

      "/tmp",
      undefined,
      false,
      undefined,
      undefined,
      { maxConcurrent: 3 },
      { host: { config: configHost, acpBackgroundRunner } },
    );
    const parent = await mgr.createSession("code");
    parent.providerId = "codex";
    mgr.setToolContext(toolCtx);

    const spawned = await mgr.spawnBackground(
      {
        task: "adversarial review",
        message: "review this",
        taskClass: "review_code",
      },
      parent.id,
    );
    const result = await mgr.waitForBackground(spawned.sessionId);

    expect(result).toBe("Adversarial ACP review");
    expect(spawned).toMatchObject({
      resolvedProvider: "acp",
      resolvedModel: "acp:claude",
      taskClass: "review_code",
      routingReason: "configured adversarial review ACP agent (acp:claude)",
    });
    expect(acpBackgroundRunner.run).toHaveBeenCalledOnce();
    expect(mocks.resolveBackgroundRoute).not.toHaveBeenCalled();
  });

  it("preserves ACP message and tool images for the caller", async () => {
    configHost.getBackgroundAgentSettings.mockReturnValue({
      acpAgents: [{ id: "image-agent", command: "image-agent-acp" }],
    });
    const acpBackgroundRunner = {
      run: vi.fn(async (request: any) => {
        request.onEvent({
          type: "update",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Here are the images." },
          },
        });
        request.onEvent({
          type: "update",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "image",
              mimeType: "image/png",
              data: "YWJjZA==",
            },
          },
        });
        request.onEvent({
          type: "update",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "generate-1",
            status: "completed",
            content: [
              {
                type: "content",
                content: {
                  type: "image",
                  mimeType: "image/webp",
                  data: "RUZH",
                },
              },
            ],
          },
        });
        request.onEvent({
          type: "stop",
          response: { stopReason: "end_turn" },
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
    const parent = await mgr.createSession("code");
    mgr.setToolContext(toolCtx);

    const spawned = await mgr.spawnBackground(
      {
        task: "generate images",
        message: "make two images",
        provider: "acp:image-agent",
      },
      parent.id,
    );
    await mgr.waitForBackground(spawned.sessionId);

    const session = (mgr as any).sessions.get(spawned.sessionId);
    expect(session.getAllMessages()).toEqual([
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "generate-1",
            name: "ACP tool",
            input: {},
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "generate-1",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/webp",
                  data: "RUZH",
                },
              },
            ],
          },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Here are the images." },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: "YWJjZA==",
            },
          },
        ],
      },
    ]);
    await expect(
      mgr.waitForAuthorizedBackgroundContent(parent.id, spawned.sessionId),
    ).resolves.toEqual({
      text: "Here are the images.",
      images: [
        { data: "YWJjZA==", mimeType: "image/png" },
        { data: "RUZH", mimeType: "image/webp" },
      ],
    });
  });

  it("publishes ACP stop usage before terminal finalization", async () => {
    configHost.getBackgroundAgentSettings.mockReturnValue({
      defaultAgent: "acp:claude",
      acpAgents: [{ id: "claude", command: "claude-agent-acp" }],
    });
    const projectionListener = vi.fn();
    const legacyListener = vi.fn();
    let mgr!: AgentSessionManager;
    let usageAtStop: number | undefined;
    const acpBackgroundRunner = {
      run: vi.fn(async (request: any) => {
        projectionListener.mockClear();
        legacyListener.mockClear();
        request.onEvent({
          type: "update",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "ACP intermediate output" },
          },
        });
        expect(projectionListener).toHaveBeenCalledTimes(1);
        expect(legacyListener).not.toHaveBeenCalled();

        projectionListener.mockClear();
        request.onEvent({
          type: "stop",
          response: {
            stopReason: "end_turn",
            usage: { inputTokens: 30, outputTokens: 12 },
          },
        });
        usageAtStop = mgr.getBgSessionInfos()[0]?.totalInputTokens;
        expect(projectionListener).toHaveBeenCalledTimes(1);
        expect(legacyListener).not.toHaveBeenCalled();
      }),
    };
    mgr = new AgentSessionManager(
      config,
      "/tmp",
      undefined,
      false,
      undefined,
      undefined,
      { maxConcurrent: 3 },
      { host: { config: configHost, acpBackgroundRunner } },
    );
    mgr.onDidChangeSessions(projectionListener);
    mgr.onSessionsChanged = legacyListener;
    mgr.setToolContext(toolCtx);

    const spawned = await mgr.spawnBackground({
      task: "ACP usage publication",
      message: "run",
    });
    await mgr.waitForBackground(spawned.sessionId);

    const session = (mgr as any).sessions.get(spawned.sessionId);
    expect(session.totalInputTokens).toBe(30);
    expect(session.totalOutputTokens).toBe(12);
    expect(usageAtStop).toBe(30);
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

  it("reuses inherited ACP write authority only for structured safe locations", async () => {
    configHost.getBackgroundAgentSettings.mockReturnValue({
      defaultAgent: "acp:claude",
      acpAgents: [
        {
          id: "claude",
          command: "claude-agent-acp",
          readonlyOnly: false,
        },
      ],
    });
    const permissionOutcomes: unknown[] = [];
    const acpBackgroundRunner = {
      run: vi.fn(async (request: any) => {
        permissionOutcomes.push(
          await request.onRequestPermission({
            toolCall: {
              toolCallId: "tc-edit",
              kind: "edit",
              title: "Edit source",
              locations: [{ path: "file.ts" }],
              rawInput: { path: "file.ts" },
            },
            options: [
              { optionId: "allow", name: "Allow", kind: "allow_once" },
              { optionId: "reject", name: "Reject", kind: "reject_once" },
            ],
          }),
          await request.onRequestPermission({
            toolCall: {
              toolCallId: "tc-protected",
              kind: "edit",
              title: "Edit instructions",
              locations: [{ path: "AGENTS.md" }],
              rawInput: { path: "AGENTS.md" },
            },
            options: [
              { optionId: "allow", name: "Allow", kind: "allow_once" },
              { optionId: "reject", name: "Reject", kind: "reject_once" },
            ],
          }),
          await request.onRequestPermission({
            toolCall: {
              toolCallId: "tc-outside",
              kind: "edit",
              title: "Edit outside workspace",
              locations: [{ path: "/outside/file.ts" }],
              rawInput: { path: "/outside/file.ts" },
            },
            options: [
              { optionId: "allow", name: "Allow", kind: "allow_once" },
              { optionId: "reject", name: "Reject", kind: "reject_once" },
            ],
          }),
        );
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
    const parent = await mgr.createSession("code");
    const onApprovalRequest = vi.fn(async () => "reject");
    const approvalManager = {
      bindSessionProject: vi.fn(),
      touchSession: vi.fn(),
      getAgentWriteAuthorization: vi.fn(() => ({
        allowed: true,
        basis: "blanket_approval",
        scope: "session",
      })),
      isPathTrusted: vi.fn(() => false),
      getFileWriteAuthorization: vi.fn(() => ({
        allowed: false,
        basis: "none",
      })),
    };
    mgr.setToolContext({
      ...toolCtx,
      approvalManager: approvalManager as any,
      onApprovalRequest,
      inheritSessionApprovalState: vi.fn(),
    });

    const spawned = await mgr.spawnBackground(
      {
        task: "external implementation",
        message: "edit this",
        provider: "acp:claude",
      },
      parent.id,
    );
    await mgr.waitForBackground(spawned.sessionId);

    expect(approvalManager.getAgentWriteAuthorization).toHaveBeenCalledOnce();
    expect(permissionOutcomes).toEqual([
      { outcome: { outcome: "selected", optionId: "allow" } },
      { outcome: { outcome: "selected", optionId: "reject" } },
      { outcome: { outcome: "selected", optionId: "reject" } },
    ]);
    expect(approvalManager.isPathTrusted).toHaveBeenCalledWith(
      spawned.sessionId,
      "/outside/file.ts",
    );
    expect(approvalManager.getFileWriteAuthorization).not.toHaveBeenCalled();
    expect(onApprovalRequest).toHaveBeenCalledTimes(2);
    expect(onApprovalRequest).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        kind: "write",
        backgroundTask: "external implementation",
      }),
      spawned.sessionId,
    );
  });

  it("lets read-only ACP run alongside a writable ACP lease", async () => {
    configHost.getBackgroundAgentSettings.mockReturnValue({
      acpAgents: [
        {
          id: "writer",
          command: "writer-acp",
          readonlyOnly: false,
        },
        {
          id: "reader",
          command: "reader-acp",
          readonlyOnly: true,
        },
      ],
    });
    let releaseWriter: (() => void) | undefined;
    const started: string[] = [];
    const acpBackgroundRunner = {
      run: vi.fn(async (request: any) => {
        started.push(request.agent.id);
        if (request.agent.id === "writer") {
          await new Promise<void>((resolve) => {
            releaseWriter = resolve;
          });
        }
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
      {
        host: {
          config: configHost,
          acpBackgroundRunner,
          workspaceMutationCoordinator: new WorkspaceMutationCoordinator(),
        },
      },
    );
    mgr.setToolContext(toolCtx);

    const writer = await mgr.spawnBackground({
      task: "write",
      message: "write",
      provider: "acp:writer",
    });
    await waitFor(
      () => started,
      (value) => value.includes("writer"),
    );
    const reader = await mgr.spawnBackground({
      task: "read",
      message: "read",
      provider: "acp:reader",
    });
    await mgr.waitForBackground(reader.sessionId);

    expect(started).toEqual(["writer", "reader"]);
    releaseWriter?.();
    await mgr.waitForBackground(writer.sessionId);
  });

  it("serializes writable ACP runs and releases the lease after failure", async () => {
    configHost.getBackgroundAgentSettings.mockReturnValue({
      defaultAgent: "acp:writer",
      acpAgents: [
        {
          id: "writer",
          command: "writer-acp",
          readonlyOnly: false,
        },
      ],
    });
    let rejectFirst: ((error: Error) => void) | undefined;
    const started: number[] = [];
    const acpBackgroundRunner = {
      run: vi.fn(async () => {
        const invocation = started.length + 1;
        started.push(invocation);
        if (invocation === 1) {
          await new Promise<void>((_resolve, reject) => {
            rejectFirst = reject;
          });
        }
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
      {
        host: {
          config: configHost,
          acpBackgroundRunner,
          workspaceMutationCoordinator: new WorkspaceMutationCoordinator(),
        },
      },
    );
    mgr.setToolContext(toolCtx);
    const foreground = await mgr.createSession("code");

    const first = await mgr.spawnBackground(
      {
        task: "first",
        message: "write",
      },
      foreground.id,
    );
    await waitFor(
      () => started.length,
      (value) => value === 1,
    );
    const second = await mgr.spawnBackground(
      {
        task: "second",
        message: "write",
      },
      foreground.id,
    );
    await Promise.resolve();
    expect(started).toEqual([1]);

    rejectFirst?.(new Error("writer failed"));
    await mgr.waitForBackground(first.sessionId);
    await mgr.waitForBackground(second.sessionId);
    expect(started).toEqual([1, 2]);
  });

  it("advances workspace generation before approving an ACP mutation", async () => {
    configHost.getBackgroundAgentSettings.mockReturnValue({
      defaultAgent: "acp:writer",
      acpAgents: [
        {
          id: "writer",
          command: "writer-acp",
          readonlyOnly: false,
        },
      ],
    });
    const coordinator = new WorkspaceMutationCoordinator(undefined, {
      createEpoch: () => "test-epoch",
    });
    let generationAtPermissionReturn = -1;
    let rootSessionId = "";
    const acpBackgroundRunner = {
      run: vi.fn(async (request: any) => {
        const outcome = await request.onRequestPermission({
          toolCall: {
            toolCallId: "tc-edit",
            kind: "edit",
            title: "Edit source",
            rawInput: { path: "file.ts" },
          },
          options: [
            { optionId: "allow", name: "Allow", kind: "allow_once" },
            { optionId: "reject", name: "Reject", kind: "reject_once" },
          ],
        });
        expect(outcome).toEqual({
          outcome: { outcome: "selected", optionId: "allow" },
        });
        generationAtPermissionReturn = coordinator.getSnapshot(
          "/tmp",
          "observer",
          rootSessionId,
        ).generation;
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
      {
        host: {
          config: configHost,
          acpBackgroundRunner,
          workspaceMutationCoordinator: coordinator,
        },
      },
    );
    mgr.setToolContext({
      ...toolCtx,
      onApprovalRequest: vi.fn(async () => "allow"),
    });
    const foreground = await mgr.createSession("code");
    rootSessionId = foreground.id;

    const spawned = await mgr.spawnBackground(
      {
        task: "edit",
        message: "edit",
      },
      foreground.id,
    );
    await mgr.waitForBackground(spawned.sessionId);

    expect(generationAtPermissionReturn).toBe(1);
  });

  it("rejects a shared writer child while its parent owns the mutation lease", async () => {
    const coordinator = new WorkspaceMutationCoordinator();
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
          config: configHost,
          workspaceMutationCoordinator: coordinator,
        },
      },
    );
    const parent = await mgr.createSession("code");
    const readOnlyTool = {
      name: "linear__list_issues",
      description: "List issues",
      input_schema: { type: "object", properties: {} },
    };
    const mcpHub = {
      getToolDefs: vi.fn().mockReturnValue([
        readOnlyTool,
        {
          name: "linear__create_issue",
          description: "Create issue",
          input_schema: { type: "object", properties: {} },
        },
      ]),
      getReadOnlyToolDefs: vi.fn().mockReturnValue([readOnlyTool]),
      getServerConfig: vi.fn().mockReturnValue(undefined),
    };
    mgr.setToolContext(toolCtx);
    (mgr as any).activeRequestToolContexts.set(parent.id, {
      ...toolCtx,
      sessionId: parent.id,
      mcpHub,
    });
    const leaseHolder = { sessionId: parent.id };
    await (mgr as any).ensureWorkspaceMutationLease(parent, leaseHolder);

    await expect(
      mgr.spawnBackground(
        {
          task: "writer child",
          message: "write",
          permissionProfile: "workspace-safe",
        },
        parent.id,
      ),
    ).rejects.toMatchObject({
      result: expect.objectContaining({ code: "workspace_conflict" }),
    });
    await expect(
      mgr.spawnBackground(
        {
          task: "reader child",
          message: "read",
          permissionProfile: "review-only",
        },
        parent.id,
      ),
    ).resolves.toMatchObject({ resolvedProvider: "anthropic" });
    await waitFor(
      () => mocks.runArgs.mock.calls.length,
      (calls) => calls === 1,
    );
    expect(mocks.runArgs.mock.calls[0]?.[1]).toMatchObject({
      toolProfile: "review",
      mcpToolDefinitions: [readOnlyTool],
    });
    expect(mcpHub.getReadOnlyToolDefs).toHaveBeenCalled();

    const readerChild = Array.from((mgr as any).sessions.values()).find(
      (session: any) => session.fleetMetadata?.parentSessionId === parent.id,
    );
    expect(readerChild).toBeDefined();
    expect(() =>
      (mgr as any).ensureParentWriterCanSpawnSharedChild(readerChild, false),
    ).toThrowError(
      expect.objectContaining({
        result: expect.objectContaining({ code: "workspace_conflict" }),
      }),
    );

    (mgr as any).releaseWorkspaceMutationLease(leaseHolder);
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
      resultState: "failed",
      retrySafe: true,
      agentRetryable: false,
      partialOutput: expect.stringContaining("Partial ACP result"),
    });
  });

  it("creates background engines through the host without caching an idle interactive engine", async () => {
    const providers = new ProviderRegistry();
    const backgroundEngine = {
      setToolRuntime: vi.fn(),
      run: vi.fn(() => mocks.runBehavior()),
      condenseSession: vi.fn(async function* () {}),
      isOverCondenseThreshold: vi.fn(() => false),
    };
    const createEngine = vi.fn(() => backgroundEngine);
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

    expect((mgr as any).activeInteractiveEngines.size).toBe(0);
    await mgr.spawnBackground({ task: "host engine", message: "run" });
    await waitFor(
      () => backgroundEngine.run.mock.calls.length,
      (calls) => calls === 1,
    );

    expect(createEngine).toHaveBeenCalledOnce();
    expect(createEngine).toHaveBeenCalledWith(providers, undefined);
    expect(backgroundEngine.setToolRuntime).toHaveBeenCalledTimes(1);
    expect(backgroundEngine.run).toHaveBeenCalledTimes(1);
    expect((mgr as any).activeInteractiveEngines.size).toBe(0);
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
      expect.stringContaining("planned tool call budget"),
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

  it("keeps the nominal cap soft when the backend cannot accept a wrap-up interjection", async () => {
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
      task: "bounded external task",
      message: "run",
      budget: { maxToolCalls: 2 },
    });
    const session = (mgr as any).sessions.get(spawned.sessionId);
    session.setPendingInterjection.mockReturnValue(false);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(session.abort).not.toHaveBeenCalled();
    expect(session.fleetMetadata).toEqual(
      expect.objectContaining({
        lifecycle: "completed",
        budgetUsage: expect.objectContaining({ toolCalls: 2 }),
      }),
    );
  });

  it("hard-stops only at triple the nominal budget and persists an explicit terminal reason", async () => {
    mocks.runBehavior.mockReturnValue(
      (async function* () {
        yield { type: "tool_start", toolCallId: "tc-1", toolName: "search" };
        yield { type: "tool_start", toolCallId: "tc-2", toolName: "read" };
        // 1.5x and 2x usage remain inside the safety backstop.
        yield { type: "tool_start", toolCallId: "tc-3", toolName: "read" };
        yield { type: "tool_start", toolCallId: "tc-4", toolName: "read" };
        yield { type: "tool_start", toolCallId: "tc-5", toolName: "read" };
        // Triple the nominal budget is the hard-stop boundary.
        yield { type: "tool_start", toolCallId: "tc-6", toolName: "read" };
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
        budgetUsage: expect.objectContaining({ toolCalls: 6 }),
      }),
    );
  });

  it("allows a full additional elapsed-time window before the hard stop", async () => {
    const mgr = new AgentSessionManager(config, "/tmp");
    mgr.setToolContext(toolCtx);
    const spawned = await mgr.spawnBackground({
      task: "elapsed budget",
      message: "run",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const session = (mgr as any).sessions.get(spawned.sessionId);
    const meta = (mgr as any).bgMeta.get(spawned.sessionId);
    session.fleetMetadata.lifecycle = "running";
    session.fleetMetadata.budget = { maxElapsedMs: 240_000 };
    meta.startedAt = 0;

    const now = vi.spyOn(Date, "now");
    try {
      now.mockReturnValue(240_000);
      expect((mgr as any).enforceBudgetOwner(session)).toBe(false);
      expect(session.abort).not.toHaveBeenCalled();

      // The old fixed two-minute grace would have stopped the agent here.
      now.mockReturnValue(360_000);
      expect((mgr as any).enforceBudgetOwner(session)).toBe(false);
      expect(session.abort).not.toHaveBeenCalled();

      now.mockReturnValue(480_000);
      expect((mgr as any).enforceBudgetOwner(session)).toBe(false);
      expect(session.abort).not.toHaveBeenCalled();

      now.mockReturnValue(720_000);
      expect((mgr as any).enforceBudgetOwner(session)).toBe(true);
      expect(session.abort).toHaveBeenCalled();
      expect(session.fleetMetadata.terminalReason).toBe(
        "budget_exhausted:elapsed_time",
      );
    } finally {
      now.mockRestore();
    }
  });

  it("hard-stops a tripled dimension even when another dimension was exhausted first", async () => {
    const mgr = new AgentSessionManager(config, "/tmp");
    mgr.setToolContext(toolCtx);
    const spawned = await mgr.spawnBackground({
      task: "multi-dimensional budget",
      message: "run",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const session = (mgr as any).sessions.get(spawned.sessionId);
    const meta = (mgr as any).bgMeta.get(spawned.sessionId);
    session.fleetMetadata.lifecycle = "running";
    session.fleetMetadata.budget = {
      maxToolCalls: 1,
      maxElapsedMs: 240_000,
    };
    meta.toolCalls = 1;
    meta.startedAt = 0;

    const now = vi.spyOn(Date, "now").mockReturnValue(720_000);
    try {
      expect((mgr as any).enforceBudgetOwner(session)).toBe(true);
      expect(session.fleetMetadata.terminalReason).toBe(
        "budget_exhausted:elapsed_time",
      );
    } finally {
      now.mockRestore();
    }
  });

  it("passes only the 3x hard backstop caps into the background engine run", async () => {
    const mgr = new AgentSessionManager(config, "/tmp");
    mgr.setToolContext(toolCtx);

    await mgr.spawnBackground({
      task: "capped",
      message: "run",
      budget: { maxToolCalls: 5, maxApiTurns: 7 },
    });
    await waitFor(
      () => mocks.runArgs.mock.calls.length,
      (calls) => calls === 1,
    );

    expect(mocks.runArgs).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ maxToolCalls: 15, maxApiTurns: 21 }),
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
    await waitFor(
      () => mocks.runArgs.mock.calls.length,
      (calls) => calls === 1,
    );

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
      permissionProfile: "review-only",
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
      permissionProfile: "review-only",
    });
    const child = await mgr.spawnBackground(
      { task: "child", message: "inspect" },
      parent.sessionId,
    );

    const childSession = (mgr as any).sessions.get(child.sessionId);
    childSession.fleetMetadata.parentSessionId = undefined;

    const infos = mgr.getBgSessionInfos();
    expect(mgr.getBackgroundParentSessionId(child.sessionId)).toBe(
      parent.sessionId,
    );
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

  it("notifies projection listeners when completed agents cross the visibility cutoff", async () => {
    let now = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const timeouts: Array<{ handler: () => void; delay: number }> = [];
    const timers = {
      setInterval: vi.fn(() => ({ kind: "interval" }) as never),
      clearInterval: vi.fn(),
      setTimeout: vi.fn((handler: () => void, delay: number) => {
        timeouts.push({ handler, delay });
        return { kind: "timeout", index: timeouts.length - 1 } as never;
      }),
      clearTimeout: vi.fn(),
    };
    try {
      const mgr = new AgentSessionManager(
        config,
        "/tmp",
        undefined,
        false,
        undefined,
        undefined,
        { maxConcurrent: 3 },
        { host: { timers } },
      );
      mgr.setToolContext(toolCtx);
      await mgr.createSession("code");
      const spawned = await mgr.spawnBackground({
        task: "expiring agent",
        message: "work",
      });
      await waitFor(
        () =>
          (mgr as any).sessions.get(spawned.sessionId).fleetMetadata.lifecycle,
        (lifecycle) => lifecycle === "completed",
      );
      const session = (mgr as any).sessions.get(spawned.sessionId);
      const completedAt = session.fleetMetadata.completedAt as number;
      const expiry = timeouts.find(
        ({ delay }) => delay === 6 * 60 * 60 * 1000 + 1,
      );
      expect(expiry).toBeDefined();
      const scheduledTimerCount = timers.setTimeout.mock.calls.length;
      (mgr as any).notifySessionsChanged();
      expect(timers.setTimeout).toHaveBeenCalledTimes(scheduledTimerCount);

      const listener = vi.fn();
      mgr.onDidChangeSessions(listener);
      now = completedAt + 6 * 60 * 60 * 1000 + 1;
      expiry?.handler();

      expect(listener).toHaveBeenCalledTimes(1);
      expect(mgr.getBgSessionInfos()).toEqual([]);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("cancels the visibility timer without late projection notifications", async () => {
    const timeouts: Array<{ handler: () => void; delay: number }> = [];
    const timers = {
      setInterval: vi.fn(() => ({ kind: "interval" }) as never),
      clearInterval: vi.fn(),
      setTimeout: vi.fn((handler: () => void, delay: number) => {
        timeouts.push({ handler, delay });
        return { kind: "timeout", index: timeouts.length - 1 } as never;
      }),
      clearTimeout: vi.fn(),
    };
    const mgr = new AgentSessionManager(
      config,
      "/tmp",
      undefined,
      false,
      undefined,
      undefined,
      { maxConcurrent: 3 },
      { host: { timers } },
    );
    mgr.setToolContext(toolCtx);
    await mgr.createSession("code");
    const spawned = await mgr.spawnBackground({
      task: "disposed timer",
      message: "work",
    });
    await waitFor(
      () =>
        (mgr as any).sessions.get(spawned.sessionId).fleetMetadata.lifecycle,
      (lifecycle) => lifecycle === "completed",
    );
    const expiry = timeouts.find(
      ({ delay }) => delay > 6 * 60 * 60 * 1000 - 100,
    );
    expect(expiry).toBeDefined();
    const listener = vi.fn();
    mgr.onDidChangeSessions(listener);

    mgr.disposeFleetVisibilityExpiry();
    expiry?.handler();

    expect(timers.clearTimeout).toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
  });

  it("serializes durable completion when transient background state is absent", async () => {
    const mgr = new AgentSessionManager(config, "/tmp");
    mgr.setToolContext(toolCtx);
    await mgr.createSession("code");
    const spawned = await mgr.spawnBackground({
      task: "durable completion",
      message: "work",
    });
    const session = (mgr as any).sessions.get(spawned.sessionId);
    await waitFor(
      () => session.fleetMetadata.lifecycle,
      (lifecycle) => lifecycle === "completed",
    );
    (mgr as any).bgCompletedAt.delete(spawned.sessionId);

    expect(
      mgr.getBgSessionInfos().find((info) => info.id === spawned.sessionId)
        ?.completedAt,
    ).toBe(session.fleetMetadata.completedAt);
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
    expect(mgr.getBackgroundResultSummary(spawned.sessionId)).toBe(
      "one-line summary",
    );
  });

  it("uses the set_task_status summary when a background turn has no other output", async () => {
    const mgr = new AgentSessionManager(config, "/tmp");
    mgr.setToolContext(toolCtx);
    await mgr.createSession("code");
    const spawned = await mgr.spawnBackground({
      task: "summary-only result",
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
      summary: "Summary supplied by set_task_status.",
      source: "tool",
    });
    (mgr as any).bgFinalResults.delete(spawned.sessionId);
    session.fleetMetadata.finalResult = undefined;

    expect(mgr.getBackgroundResult(spawned.sessionId)).toEqual({
      resultText: undefined,
      summary: "Summary supplied by set_task_status.",
    });
    expect(mgr.getBackgroundResultSummary(spawned.sessionId)).toBe(
      "Summary supplied by set_task_status.",
    );
  });

  it("preserves session ownership and evolving arguments through background interaction wrappers", async () => {
    const onApprovalRequest = vi.fn().mockResolvedValue("reject");
    const onQuestion = vi.fn().mockResolvedValue({ answers: {}, notes: {} });
    const mgr = new AgentSessionManager(config, "/tmp");
    const session = await mgr.createSession("code");
    const pendingQuestionRecovery = {
      schemaVersion: 1 as const,
      assistantContent: [],
      toolUseId: "tool-use-1",
      toolName: "ask_user" as const,
      toolInput: { context: "Need input.", questions: [] },
    };
    const overrides = (
      mgr as unknown as {
        buildBackgroundInteractionOverrides: (
          session: unknown,
          task: string,
          context: ToolDispatchContext,
        ) => Pick<ToolDispatchContext, "onApprovalRequest" | "onQuestion">;
      }
    ).buildBackgroundInteractionOverrides(session, "review task", {
      ...toolCtx,
      onApprovalRequest,
      onQuestion,
    });

    await overrides.onApprovalRequest?.({
      kind: "write",
      title: "Review write",
      choices: [],
    });
    await overrides.onApprovalRequest?.(
      { kind: "write", title: "Explicit owner", choices: [] },
      "distinct-session",
    );
    await overrides.onQuestion?.(
      "Need input.",
      [],
      session.id,
      "stale task",
      pendingQuestionRecovery,
    );

    expect(onApprovalRequest).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        title: "Review write",
        backgroundTask: "review task",
      }),
      session.id,
    );
    expect(onApprovalRequest).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ title: "Explicit owner" }),
      "distinct-session",
    );
    expect(onQuestion).toHaveBeenCalledWith(
      "Need input.",
      [],
      session.id,
      "review task",
      pendingQuestionRecovery,
    );
  });

  it("routes background questions through the root coordinator runtime", async () => {
    const onQuestion = vi.fn().mockResolvedValue({ answers: {}, notes: {} });
    const mgr = new AgentSessionManager(config, "/tmp");
    mgr.setToolContext({ ...toolCtx, onQuestion });
    const foreground = await mgr.createSession("code");
    foreground.status = "streaming";
    const setPendingInterjection = vi.mocked(foreground.setPendingInterjection);

    const spawned = await mgr.spawnBackground(
      {
        task: "review task",
        message: "run",
      },
      foreground.id,
    );

    const bgRuntime = mocks.setToolRuntime.mock.calls.at(-1)?.[0];
    expect(bgRuntime).toBeDefined();
    const backgroundAnswer = bgRuntime.executeTool({
      name: "ask_user",
      input: {
        context: "The ownership boundary needs one more exact path.",
        questions: [
          {
            id: "path",
            type: "text",
            question: "Which NUnit test file should I own?",
          },
        ],
      },
      context: { sessionId: spawned.sessionId },
    });

    await waitFor(
      () => setPendingInterjection.mock.calls.length,
      (calls) => calls === 1,
    );
    expect(onQuestion).not.toHaveBeenCalled();
    const [prompt, requestId, , displayText] =
      setPendingInterjection.mock.calls[0];
    expect(prompt).toContain("<background_agent_question");
    expect(prompt).toContain("respond_to_background_question");
    expect(prompt).toContain("Which NUnit test file should I own?");
    expect(displayText).toContain("review task");
    mgr.getSession(spawned.sessionId)!.status = "tool_executing";
    expect(mgr.getBackgroundStatus(spawned.sessionId)?.phase).toBe(
      "awaiting_coordinator",
    );
    expect(
      (mgr.getSession(spawned.sessionId)?.fleetMetadata?.events ?? []).some(
        (event) => event.type === "question",
      ),
    ).toBe(false);

    mgr.interruptSession(foreground.id);
    await mgr.sendMessage(foreground.id, "Handle this steering first.", "code");
    expect(setPendingInterjection).toHaveBeenCalledTimes(2);
    expect(setPendingInterjection.mock.calls[1]?.[1]).toBe(requestId);

    const coordinatorContext = (
      mgr as unknown as {
        captureSessionToolContext: (
          session: unknown,
        ) => ToolDispatchContext | undefined;
      }
    ).captureSessionToolContext(foreground);
    expect(coordinatorContext).toBeDefined();
    const coordinatorRuntime = createAgentToolRuntime(coordinatorContext!);
    const responseResult = await coordinatorRuntime.executeTool({
      name: "respond_to_background_question",
      input: {
        request_id: requestId,
        answers: { path: "tests/CoordinatorOwnedTests.cs" },
      },
      context: { sessionId: foreground.id },
    });
    expect(responseResult.content[0]).toMatchObject({
      type: "text",
      text: '{"accepted":true}',
    });

    const answerResult = await backgroundAnswer;
    expect(answerResult.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("tests/CoordinatorOwnedTests.cs"),
    });
    expect(mgr.getBackgroundStatus(spawned.sessionId)?.phase).not.toBe(
      "awaiting_coordinator",
    );
  });

  it("starts an internal coordinator turn when the foreground is idle", async () => {
    const onQuestion = vi.fn().mockResolvedValue({ answers: {}, notes: {} });
    const mgr = new AgentSessionManager(config, "/tmp");
    mgr.setToolContext({ ...toolCtx, onQuestion });
    const foreground = await mgr.createSession("code");
    const onEvent = vi.fn();
    mgr.onEvent = onEvent;

    const spawned = await mgr.spawnBackground(
      { task: "confirm scope", message: "run" },
      foreground.id,
    );
    const bgRuntime = mocks.setToolRuntime.mock.calls.at(-1)?.[0];
    const backgroundAnswer = bgRuntime.executeTool({
      name: "ask_user",
      input: {
        context: "The implementation scope is otherwise clear.",
        questions: [
          {
            id: "include_docs",
            type: "yes_no",
            question: "Should I update the delegated docs file too?",
          },
        ],
      },
      context: { sessionId: spawned.sessionId },
    });

    await waitFor(
      () => vi.mocked(foreground.addUserMessage).mock.calls.length,
      (calls) => calls === 1,
    );
    const [prompt, messageOptions] = vi.mocked(foreground.addUserMessage).mock
      .calls[0];
    const requestId = /request_id="([^"]+)"/.exec(prompt)?.[1];
    expect(requestId).toBeTruthy();
    expect(messageOptions).toMatchObject({
      displayText:
        "Background agent “confirm scope” needs a coordinator answer",
    });
    expect(onEvent).toHaveBeenCalledWith(
      foreground.id,
      expect.objectContaining({
        type: "user_interjection",
        queueId: requestId,
      }),
    );

    const coordinatorRuntime = mocks.setToolRuntime.mock.calls.at(-1)?.[0];
    await coordinatorRuntime.executeTool({
      name: "respond_to_background_question",
      input: {
        request_id: requestId,
        answers: { include_docs: true },
      },
      context: { sessionId: foreground.id },
    });
    const answerResult = await backgroundAnswer;
    expect(answerResult.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining('"answer":true'),
    });
    expect(onQuestion).not.toHaveBeenCalled();
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
      onSpawnBackground: (callerSessionId, request, skillAuthority) =>
        mgr.spawnBackground(request, callerSessionId, skillAuthority),
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
      input: {
        task: "child",
        message: "inspect",
        mode: "review",
        permissionProfile: "review-only",
      },
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

  it("keeps each foreground root authorized for only its own descendants after focus changes", async () => {
    const mgr = new AgentSessionManager(config, "/tmp");
    mgr.setToolContext(toolCtx);
    const firstForeground = await mgr.createSession("code");
    const firstChild = await mgr.spawnBackground(
      { task: "first child", message: "work" },
      firstForeground.id,
    );
    const secondForeground = await mgr.createSession("code");
    const secondChild = await mgr.spawnBackground(
      { task: "second child", message: "work" },
      secondForeground.id,
    );

    expect(
      mgr.getAuthorizedBackgroundStatus(
        firstForeground.id,
        firstChild.sessionId,
      ),
    ).not.toEqual(
      expect.objectContaining({ resultState: "authorization_lost" }),
    );
    expect(
      mgr.getAuthorizedBackgroundStatus(
        secondForeground.id,
        firstChild.sessionId,
      ),
    ).toEqual(
      expect.objectContaining({
        status: "error",
        resultState: "authorization_lost",
      }),
    );
    expect(
      mgr.getAuthorizedBackgroundStatus(
        firstForeground.id,
        secondChild.sessionId,
      ),
    ).toEqual(
      expect.objectContaining({
        status: "error",
        resultState: "authorization_lost",
      }),
    );
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
      permissionProfile: "review-only",
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

  it("persists and publishes child terminal reasons after parent completion", async () => {
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
      message: "work",
      permissionProfile: "review-only",
    });
    const child = await mgr.spawnBackground(
      { task: "child", message: "work" },
      parent.sessionId,
    );
    const savedReasons: Array<string | undefined> = [];
    vi.spyOn(mgr, "saveSession").mockImplementation((sessionId) => {
      if (sessionId === child.sessionId) {
        savedReasons.push(
          (mgr as any).sessions.get(sessionId).fleetMetadata.terminalReason,
        );
      }
    });
    const listener = vi.fn();
    mgr.onDidChangeSessions(listener);
    listener.mockClear();

    (mgr as any).cancelOwnedChildrenOnCompletion(parent.sessionId);

    expect(savedReasons).toContain("parent_completed_without_join");
    expect(
      (mgr as any).sessions.get(child.sessionId).fleetMetadata.terminalReason,
    ).toBe("parent_completed_without_join");
    expect(listener).toHaveBeenCalled();
  });

  it("persists and publishes child terminal reasons after parent budget exhaustion", async () => {
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
      message: "work",
      permissionProfile: "review-only",
    });
    const child = await mgr.spawnBackground(
      { task: "child", message: "work" },
      parent.sessionId,
    );
    const parentSession = (mgr as any).sessions.get(parent.sessionId);
    parentSession.fleetMetadata.budget = { maxToolCalls: 1 };
    (mgr as any).bgMeta.get(parent.sessionId).toolCalls = 3;
    const savedReasons: Array<string | undefined> = [];
    vi.spyOn(mgr, "saveSession").mockImplementation((sessionId) => {
      if (sessionId === child.sessionId) {
        savedReasons.push(
          (mgr as any).sessions.get(sessionId).fleetMetadata.terminalReason,
        );
      }
    });
    const listener = vi.fn();
    mgr.onDidChangeSessions(listener);
    listener.mockClear();

    expect((mgr as any).enforceBudgetOwner(parentSession)).toBe(true);

    expect(savedReasons).toContain("parent_budget_exhausted");
    expect(
      (mgr as any).sessions.get(child.sessionId).fleetMetadata.terminalReason,
    ).toBe("parent_budget_exhausted");
    expect(listener).toHaveBeenCalled();
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
      permissionProfile: "review-only",
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

  it("keeps background agents running when only the foreground turn is interrupted", async () => {
    mocks.runBehavior.mockImplementation(() =>
      (async function* () {
        await new Promise<never>(() => undefined);
        yield { type: "done" };
      })(),
    );
    const mgr = new AgentSessionManager(config, "/tmp");
    mgr.setToolContext(toolCtx);
    const foreground = await mgr.createSession("code");
    const child = await mgr.spawnBackground({
      task: "child",
      message: "keep working",
    });

    mgr.interruptSession(foreground.id);

    expect(foreground.status).toBe("idle");
    expect(mgr.getBackgroundStatus(child.sessionId).status).not.toBe(
      "cancelled",
    );
    expect((mgr as any).sessions.get(child.sessionId).isAborted).toBe(false);
    expect(
      (mgr as any).sessions.get(child.sessionId).fleetMetadata,
    ).not.toEqual(
      expect.objectContaining({
        lifecycle: "cancelled",
        terminalReason: "cancelled_by_user",
      }),
    );

    mgr.stopSession(foreground.id);
  });

  it("creates native review agents with the full prompt path", async () => {
    mocks.resolveBackgroundRoute.mockResolvedValueOnce({
      resolvedMode: "review",
      resolvedModel: "claude-sonnet-4-6",
      resolvedProvider: "anthropic",
      taskClass: "review_code",
      routingReason: "balanced bounded review",
      fallbackUsed: false,
      defaultBudget: {
        maxToolCalls: 72,
        maxApiTurns: 32,
        maxElapsedMs: 1_200_000,
        warningThresholdRatio: 0.8,
      },
    });
    const mgr = new AgentSessionManager(config, "/tmp");
    mgr.setToolContext(toolCtx);
    const createToolRuntime = vi.fn(() => ({ executeTool: vi.fn() }));
    (mgr as any).host.createToolRuntime = createToolRuntime;

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
    const session = Array.from((mgr as any).sessions.values()).at(-1) as any;
    expect(session.addUserMessage).toHaveBeenCalledWith("review thoroughly");
    expect(session.fleetMetadata).toEqual(
      expect.objectContaining({
        delegation: expect.objectContaining({
          permissionProfile: "review-only",
          expectedResult: "review_findings",
        }),
        budget: {
          maxToolCalls: 72,
          maxApiTurns: 32,
          maxElapsedMs: 1_200_000,
          warningThresholdRatio: 0.8,
        },
      }),
    );
    expect(mocks.runArgs).toHaveBeenCalledWith(
      session,
      expect.objectContaining({
        toolProfile: "review",
        maxToolCalls: 216,
        maxApiTurns: 96,
      }),
    );
    expect(createToolRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ commandExecutionPolicy: "read-only" }),
    );
    expect(
      mgr.getBgSessionInfos().find((info) => info.id === session.id)
        ?.capabilities,
    ).toEqual({
      canRead: true,
      canWrite: false,
      canExecute: true,
      canUseMcp: true,
      canDelegate: true,
      limitationReason:
        "The delegation can execute only classifier-approved read-only commands.",
    });
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

  it("honors explicit review execution overrides", async () => {
    mocks.resolveBackgroundRoute.mockResolvedValueOnce({
      resolvedMode: "review",
      resolvedModel: "claude-sonnet-4-6",
      resolvedProvider: "anthropic",
      taskClass: "review_code",
      routingReason: "balanced bounded review",
      fallbackUsed: false,
      defaultBudget: { maxToolCalls: 72, maxApiTurns: 32 },
    });
    const mgr = new AgentSessionManager(config, "/tmp");
    mgr.setToolContext(toolCtx);

    const spawned = await mgr.spawnBackground({
      task: "custom review",
      message: "review with caller controls",
      taskClass: "review_code",
      permissionProfile: "interactive",
      expectedResult: "text",
      budget: { maxToolCalls: 20, maxApiTurns: 11 },
    });
    const session = (mgr as any).sessions.get(spawned.sessionId);
    await waitFor(
      () => mocks.runArgs.mock.calls.length,
      (calls) => calls === 1,
    );

    expect(session.fleetMetadata).toEqual(
      expect.objectContaining({
        delegation: expect.objectContaining({
          permissionProfile: "interactive",
          expectedResult: "text",
        }),
        budget: { maxToolCalls: 20, maxApiTurns: 11 },
      }),
    );
    expect(mocks.runArgs).toHaveBeenCalledWith(
      session,
      expect.objectContaining({
        toolProfile: undefined,
        maxToolCalls: 60,
        maxApiTurns: 33,
      }),
    );
  });

  it("preserves a valid final marker across a later provider failure", () => {
    const mgr = new AgentSessionManager(config, "/tmp");
    const structuredResult = {
      type: "review_findings" as const,
      findings: [],
      reviewedScope: "src/agent",
      emptyDiff: false,
    };
    const session = {
      id: "bg-final-marker",
      status: "error",
      getLastFinalMarker: () => ({ result: structuredResult }),
      getLastAssistantText: () => "trailing progress prose",
      fleetMetadata: { delegation: { expectedResult: "review_findings" } },
    };
    (mgr as any).bgErrors.set(session.id, "transport disconnected");

    expect((mgr as any).resolveBackgroundResult(session, "fallback")).toEqual(
      expect.objectContaining({
        structuredResult,
        resultState: "completed",
      }),
    );
  });

  it("preserves a parsed expected envelope across a later provider failure", () => {
    const mgr = new AgentSessionManager(config, "/tmp");
    const envelope = {
      type: "review_findings" as const,
      findings: [],
      reviewedScope: "src/agent",
      emptyDiff: false,
    };
    const session = {
      id: "bg-parsed-envelope",
      status: "error",
      getLastFinalMarker: () => undefined,
      getLastAssistantText: () => JSON.stringify(envelope),
      fleetMetadata: { delegation: { expectedResult: "review_findings" } },
    };
    (mgr as any).bgErrors.set(session.id, "transport disconnected");

    expect((mgr as any).resolveBackgroundResult(session, "fallback")).toEqual(
      expect.objectContaining({
        structuredResult: envelope,
        resultState: "completed",
      }),
    );
  });

  it("marks missing expected envelopes incomplete and preserves prose", () => {
    const mgr = new AgentSessionManager(config, "/tmp");
    const session = {
      id: "bg-incomplete",
      status: "idle",
      getLastFinalMarker: () => undefined,
      getLastAssistantText: () =>
        "I inspected the change but did not finalize.",
      fleetMetadata: { delegation: { expectedResult: "review_findings" } },
    };

    const resolved = (mgr as any).resolveBackgroundResult(session, "fallback");
    expect(resolved).toMatchObject({
      resultState: "incomplete_expected_result",
      partialResult: "I inspected the change but did not finalize.",
    });
    expect(JSON.parse(resolved.resultText)).toEqual({
      status: "incomplete_expected_result",
      terminalReason: "incomplete_expected_result",
      retrySafe: true,
      agentRetryable: false,
      partialOutput: "I inspected the change but did not finalize.",
    });
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

  it("persists partial evidence and retryability for provider failures", async () => {
    let releaseFailure: () => void = () => {};
    mocks.runBehavior.mockReturnValue(
      (async function* () {
        yield { type: "text_delta", text: "Recovered partial findings" };
        await new Promise<void>((resolve) => {
          releaseFailure = resolve;
        });
        yield {
          type: "error",
          error: "Provider connection closed",
          retryable: true,
        };
        yield { type: "done" };
      })(),
    );
    const mgr = new AgentSessionManager(config, "/tmp");
    mgr.setToolContext(toolCtx);
    await mgr.createSession("code");
    const spawned = await mgr.spawnBackground({
      task: "transport failure",
      message: "inspect",
      expectedResult: "text",
    });
    const session = (mgr as any).sessions.get(spawned.sessionId);
    session.getLastAssistantText.mockReturnValue(undefined);
    await waitFor(
      () => session.fleetMetadata.partialResult,
      (partial) => partial === "Recovered partial findings",
    );
    releaseFailure();

    const result = JSON.parse(await mgr.waitForBackground(spawned.sessionId));
    expect(result).toEqual({
      status: "failed",
      terminalReason: "Provider connection closed",
      retrySafe: true,
      agentRetryable: true,
      partialOutput: "Recovered partial findings",
    });
    expect(session.fleetMetadata).toEqual(
      expect.objectContaining({
        lifecycle: "failed",
        resultState: "failed",
        terminalReason: "Provider connection closed",
        partialResult: "Recovered partial findings",
        agentRetryable: true,
      }),
    );
    expect(mgr.getBackgroundStatus(spawned.sessionId)).toMatchObject({
      done: true,
      resultState: "failed",
      terminalReason: "Provider connection closed",
      retrySafe: true,
      agentRetryable: true,
      partialOutput: "Recovered partial findings",
    });
  });

  it("publishes native completion only after terminal metadata is durable", async () => {
    let releaseTerminalSave: () => void = () => {};
    const terminalSaveBlocked = new Promise<void>((resolve) => {
      releaseTerminalSave = resolve;
    });
    let notifyTerminalSaveStarted: () => void = () => {};
    const terminalSaveStarted = new Promise<void>((resolve) => {
      notifyTerminalSaveStarted = resolve;
    });
    let terminalSavePending = false;
    const saveSession = vi.fn(async ({ session: record }: any) => {
      if (
        record.summary.background &&
        record.metadata.fleet?.lifecycle === "completed"
      ) {
        terminalSavePending = true;
        notifyTerminalSaveStarted();
        await terminalSaveBlocked;
        terminalSavePending = false;
      }
      return { ok: true, revision: String(saveSession.mock.calls.length) };
    });
    const store = {
      list: vi.fn(() => []),
      listAll: vi.fn(() => []),
      saveSession,
    } as any;
    const mgr = new AgentSessionManager(
      config,
      "/tmp",
      undefined,
      false,
      store,
    );
    mgr.setToolContext(toolCtx);
    await mgr.createSession("code");
    let doneLifecycle: string | undefined;
    let projectedWhileTerminalSavePending = false;
    mgr.onDidChangeSessions(() => {
      if (terminalSavePending) projectedWhileTerminalSavePending = true;
    });
    let notifyDone: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      notifyDone = resolve;
    });
    mgr.onEvent = (sessionId, event) => {
      if (event.type !== "done") return;
      doneLifecycle = mgr.getSession(sessionId)?.fleetMetadata?.lifecycle;
      notifyDone();
    };

    await mgr.spawnBackground({
      task: "review task",
      message: "review thoroughly",
      expectedResult: "text",
    });
    await terminalSaveStarted;

    expect(doneLifecycle).toBeUndefined();
    expect(projectedWhileTerminalSavePending).toBe(false);
    releaseTerminalSave();
    await done;
    expect(doneLifecycle).toBe("completed");
  });

  it("records durable native fleet identity and completion", async () => {
    const mgr = new AgentSessionManager(config, "/tmp");
    mgr.setToolContext(toolCtx);
    const foreground = await mgr.createSession("code");

    const spawned = await mgr.spawnBackground({
      task: "review task",
      message: "review thoroughly",
      taskClass: "review_code",
      expectedResult: "text",
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
        resultState: "completed",
      }),
    );
  });

  it("notifies after durable policy-audit mutations", async () => {
    mocks.runBehavior.mockReturnValue(
      (async function* () {
        await new Promise<never>(() => undefined);
        yield { type: "done" };
      })(),
    );
    const mgr = new AgentSessionManager(config, "/tmp");
    mgr.setToolContext(toolCtx);
    const spawned = await mgr.spawnBackground({
      task: "audited policy",
      message: "work",
    });
    const session = (mgr as any).sessions.get(spawned.sessionId);
    const listener = vi.fn();
    mgr.onDidChangeSessions(listener);
    listener.mockClear();

    (mgr as any).appendPolicyAudit(session, {
      decision: "denied",
      operation: "write_file",
      reason: "review-only delegation",
    });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(
      mgr.getBgSessionInfos().find((info) => info.id === spawned.sessionId)
        ?.policyAuditCount,
    ).toBe(1);
    mgr.stopSession(spawned.sessionId);
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
      partialResult: "work preserved before reload",
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
        resultState: "interrupted",
        terminalReason: "extension_reloaded_during_run",
      }),
    );
    expect(mgr.getBackgroundStatus("persisted-bg")).toEqual(
      expect.objectContaining({
        status: "error",
        done: true,
        resultState: "interrupted",
      }),
    );
    const completion = mgr.getBackgroundCompletionsForParent("foreground-1");
    expect(completion).toHaveLength(1);
    expect(completion[0]).toEqual(
      expect.objectContaining({
        sessionId: "persisted-bg",
        status: "error",
      }),
    );
    expect(JSON.parse(completion[0].resultText ?? "{}")).toEqual(
      expect.objectContaining({
        status: "interrupted",
        terminalReason: "extension_reloaded_during_run",
        retrySafe: true,
        partialOutput: "work preserved before reload",
      }),
    );
    expect(mgr.listPersistedFleetSessions().map((item) => item.id)).toEqual([
      "persisted-bg",
    ]);
    expect(saveSession).toHaveBeenCalledWith(
      expect.objectContaining({ expectedRevision: "1" }),
    );
  });

  it("excludes cancelled and already-announced results from parent completions", async () => {
    const makeSummary = (id: string, title: string) => ({
      schemaVersion: 1,
      id,
      mode: "review",
      model: "claude-sonnet-4-6",
      title,
      messageCount: 1,
      totalInputTokens: 20,
      totalOutputTokens: 10,
      createdAt: 1,
      lastActiveAt: 2,
      background: true,
    });
    const baseFleet = {
      schemaVersion: 1 as const,
      placement: "background" as const,
      parentSessionId: "foreground-1",
      rootSessionId: "foreground-1",
      depth: 1,
      backend: "native" as const,
      resolvedMode: "review",
      resolvedModel: "claude-sonnet-4-6",
      resolvedProvider: "anthropic",
      taskClass: "review_code",
      routingReason: "defaulted to foreground model",
      fallbackUsed: false,
    };
    const fleetById: Record<string, unknown> = {
      "cancelled-bg": {
        ...baseFleet,
        task: "Cancelled review",
        lifecycle: "cancelled" as const,
        terminalReason: "cancelled_by_user",
        resultState: "cancelled" as const,
        completedAt: 3,
      },
      "interrupted-bg": {
        ...baseFleet,
        task: "Interrupted review",
        lifecycle: "running" as const,
        partialResult: "work preserved before reload",
      },
    };
    const summaries = [
      makeSummary("cancelled-bg", "Cancelled review"),
      makeSummary("interrupted-bg", "Interrupted review"),
    ];
    const saveSession = vi.fn().mockResolvedValue({ ok: true, revision: "2" });
    const store = {
      list: vi.fn(() => []),
      listAll: vi.fn(() => summaries),
      readSession: vi.fn(async (id: string) => {
        const summary = summaries.find((candidate) => candidate.id === id);
        return {
          ok: true,
          revision: "1",
          value: {
            summary,
            messages: [{ role: "user", content: "review" }],
            metadata: {
              mode: "review",
              model: "claude-sonnet-4-6",
              totalInputTokens: 20,
              totalOutputTokens: 10,
              fleet: fleetById[id],
            },
          },
        };
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

    await mgr.restorePersistedBackgroundSessions("foreground-1");

    // The user-cancelled child was witnessed when cancelled; only the
    // reload-interrupted child is redelivered.
    expect(
      mgr
        .getBackgroundCompletionsForParent("foreground-1")
        .map((completion) => completion.sessionId),
    ).toEqual(["interrupted-bg"]);

    saveSession.mockClear();
    mgr.markBackgroundResultsAnnounced(["interrupted-bg"]);
    expect(
      mgr.getSession("interrupted-bg")?.fleetMetadata?.resultAnnouncedAt,
    ).toEqual(expect.any(Number));
    expect(saveSession).toHaveBeenCalledTimes(1);
    expect(mgr.getBackgroundCompletionsForParent("foreground-1")).toEqual([]);

    // Idempotent: an already-announced result is not re-stamped or re-saved.
    mgr.markBackgroundResultsAnnounced(["interrupted-bg"]);
    expect(saveSession).toHaveBeenCalledTimes(1);
  });

  it("restores and authorizes a persisted child when its foreground is loaded", async () => {
    const now = Date.now();
    const foregroundSummary = {
      schemaVersion: 1,
      id: "foreground-1",
      mode: "code",
      model: "claude-sonnet-4-6",
      title: "Foreground",
      messageCount: 1,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      createdAt: now - 3,
      lastActiveAt: now - 2,
      background: false,
    };
    const childSummary = {
      ...foregroundSummary,
      id: "persisted-child",
      title: "Persisted child",
      lastActiveAt: now - 1,
      background: true,
    };
    const store = {
      list: vi.fn(() => [foregroundSummary]),
      listAll: vi.fn(() => [foregroundSummary, childSummary]),
      readSession: vi.fn(async (id: string) => ({
        ok: true,
        revision: "1",
        value: {
          summary:
            id === foregroundSummary.id ? foregroundSummary : childSummary,
          messages: [{ role: "user", content: "work" }],
          metadata: {
            mode: "code",
            model: "claude-sonnet-4-6",
            totalInputTokens: 0,
            totalOutputTokens: 0,
            ...(id === childSummary.id
              ? {
                  fleet: {
                    schemaVersion: 1,
                    placement: "background",
                    parentSessionId: foregroundSummary.id,
                    rootSessionId: foregroundSummary.id,
                    task: childSummary.title,
                    depth: 1,
                    backend: "native",
                    resolvedMode: "review",
                    resolvedModel: "claude-sonnet-4-6",
                    resolvedProvider: "anthropic",
                    taskClass: "review_code",
                    routingReason: "persisted",
                    fallbackUsed: false,
                    lifecycle: "completed",
                    resultState: "completed",
                    completedAt: now - 1,
                    finalResult: "durable child result",
                  },
                }
              : {}),
          },
        },
      })),
      saveSession: vi.fn().mockResolvedValue({ ok: true, revision: "2" }),
    } as any;
    const mgr = new AgentSessionManager(
      config,
      "/tmp",
      undefined,
      false,
      store,
    );

    const foreground = await mgr.loadPersistedSession(foregroundSummary.id);

    expect(foreground?.id).toBe(foregroundSummary.id);
    expect(mgr.getBgSessionInfos().map((session) => session.id)).toEqual([
      childSummary.id,
    ]);
    expect(
      mgr.getBgSessionInfos().find((session) => session.id === childSummary.id),
    ).toEqual(
      expect.objectContaining({
        resultState: "completed",
        displayStatus: "Done",
      }),
    );
    expect(
      mgr.getAuthorizedBackgroundStatus(foregroundSummary.id, childSummary.id),
    ).toMatchObject({
      done: true,
      resultState: "completed",
      retrySafe: true,
    });
    await expect(
      mgr.waitForAuthorizedBackground(foregroundSummary.id, childSummary.id),
    ).resolves.toBe("durable child result");
    expect(mgr.getBackgroundCompletionsForParent(foregroundSummary.id)).toEqual(
      [
        {
          sessionId: childSummary.id,
          task: childSummary.title,
          status: "completed",
          resultText: "durable child result",
          summary: "durable child result",
          completedAt: now - 1,
        },
      ],
    );

    foreground!.lastActiveAt = now;
    expect(
      mgr.getBackgroundCompletionsForParent(foregroundSummary.id),
    ).toHaveLength(1);
  });

  it("keeps unannounced reload interruptions recoverable across activations", async () => {
    const now = Date.now();
    const summary = {
      schemaVersion: 1,
      id: "unannounced-interruption",
      mode: "review",
      model: "claude-sonnet-4-6",
      title: "Unannounced interrupted review",
      messageCount: 1,
      totalInputTokens: 20,
      totalOutputTokens: 10,
      createdAt: now - 3_000,
      lastActiveAt: now - 2_000,
      background: true,
    };
    const store = {
      identity: {
        ownerId: "test-owner",
        surface: "test",
        startedAt: now,
      },
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
            fleet: {
              schemaVersion: 1,
              placement: "background",
              parentSessionId: "foreground-1",
              rootSessionId: "foreground-1",
              task: summary.title,
              depth: 1,
              backend: "native",
              resolvedMode: "review",
              resolvedModel: summary.model,
              resolvedProvider: "anthropic",
              taskClass: "review_code",
              routingReason: "persisted",
              fallbackUsed: false,
              lifecycle: "interrupted",
              resultState: "interrupted",
              terminalReason: "extension_reloaded_during_run",
              completedAt: now - 1_000,
              reloadInterruptionRecordedAt: now - 1_000,
              partialResult: "recoverable partial output",
            },
          },
        },
      }),
      saveSession: vi.fn().mockResolvedValue({ ok: true, revision: "2" }),
    } as any;
    const mgr = new AgentSessionManager(
      config,
      "/tmp",
      undefined,
      false,
      store,
    );

    await mgr.restorePersistedBackgroundSessions("foreground-1");

    expect(mgr.getBackgroundCompletionsForParent("foreground-1")).toEqual([
      expect.objectContaining({
        sessionId: summary.id,
        status: "error",
      }),
    ]);
    expect(store.saveSession).not.toHaveBeenCalled();
  });

  it("does not replay legacy reload interruptions", async () => {
    const now = Date.now();
    const summary = {
      schemaVersion: 1,
      id: "old-interruption",
      mode: "review",
      model: "claude-sonnet-4-6",
      title: "Old interrupted review",
      messageCount: 1,
      totalInputTokens: 20,
      totalOutputTokens: 10,
      createdAt: now - 3_000,
      lastActiveAt: now - 2_000,
      background: true,
    };
    const saveSession = vi.fn().mockResolvedValue({ ok: true, revision: "2" });
    const store = {
      identity: {
        ownerId: "test-owner",
        surface: "test",
        startedAt: now,
      },
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
            fleet: {
              schemaVersion: 1,
              placement: "background",
              parentSessionId: "foreground-1",
              rootSessionId: "foreground-1",
              task: summary.title,
              depth: 1,
              backend: "native",
              resolvedMode: "review",
              resolvedModel: summary.model,
              resolvedProvider: "anthropic",
              taskClass: "review_code",
              routingReason: "persisted",
              fallbackUsed: false,
              lifecycle: "interrupted",
              resultState: "interrupted",
              terminalReason: "extension_reloaded_during_run",
              completedAt: now - 1_000,
              partialResult: "stale partial output",
            },
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

    await mgr.restorePersistedBackgroundSessions("foreground-1");

    expect(mgr.getBackgroundCompletionsForParent("foreground-1")).toEqual([]);
    expect(saveSession).not.toHaveBeenCalled();
  });

  it("restores background trees for all open tabs while preserving single-root pruning", async () => {
    const now = Date.now();
    const summaries = ["current-bg", "second-tab-bg", "historical-bg"].map(
      (id) => ({
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
      }),
    );
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
                  id === "current-bg"
                    ? "foreground-1"
                    : id === "second-tab-bg"
                      ? "foreground-2"
                      : "foreground-old",
                parentSessionId:
                  id === "current-bg"
                    ? "foreground-1"
                    : id === "second-tab-bg"
                      ? "foreground-2"
                      : "foreground-old",
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

    const restored = await mgr.restorePersistedBackgroundSessions(
      new Set(["foreground-1", "foreground-2"]),
    );

    expect(restored.map((session) => session.id)).toEqual([
      "current-bg",
      "second-tab-bg",
    ]);
    expect(mgr.getBgSessionInfos().map((session) => session.id)).toEqual([
      "current-bg",
      "second-tab-bg",
    ]);

    await mgr.restorePersistedBackgroundSessions("foreground-old");

    expect(mgr.getBackgroundStatus("current-bg")).toEqual(
      expect.objectContaining({
        status: "error",
        partialOutput: "Session not found",
      }),
    );
    expect(mgr.getBackgroundStatus("second-tab-bg")).toEqual(
      expect.objectContaining({
        status: "error",
        partialOutput: "Session not found",
      }),
    );
    expect(mgr.getBgSessionInfos().map((session) => session.id)).toEqual([
      "historical-bg",
    ]);
  });

  it("derives result state for legacy terminal fleet records", () => {
    const mgr = new AgentSessionManager(config, "/tmp");
    const session = {
      id: "legacy-failed-bg",
      status: "error",
      currentTool: undefined,
      createdAt: 1,
      lastActiveAt: 2,
      getLastAssistantText: () => undefined,
      fleetMetadata: {
        lifecycle: "failed",
        terminalReason: "legacy_failure",
      },
    };
    (mgr as any).sessions.set(session.id, session);

    expect(mgr.getBackgroundStatus(session.id)).toEqual(
      expect.objectContaining({
        done: true,
        resultState: "failed",
        terminalReason: "legacy_failure",
        retrySafe: true,
      }),
    );
  });

  it("disables reasoning effort and restricts commands when the background route disables thinking", async () => {
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
    const createToolRuntime = vi.fn(() => ({ executeTool: vi.fn() }));
    (mgr as any).host.createToolRuntime = createToolRuntime;

    const spawned = await mgr.spawnBackground({
      task: "plan review",
      message: "review the plan",
      taskClass: "review_plan",
    });

    const session = (mgr as any).sessions.get(spawned.sessionId);
    expect(session.reasoningEffort).toBe("none");
    expect(createToolRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: spawned.sessionId,
        commandExecutionPolicy: "read-only",
      }),
    );
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

  it("publishes native event batches without invoking the legacy session callback", async () => {
    let releaseEvent: (() => void) | undefined;
    let releaseCompletion: (() => void) | undefined;
    mocks.runBehavior.mockReturnValue(
      (async function* () {
        await new Promise<void>((resolve) => {
          releaseEvent = resolve;
        });
        yield { type: "text_delta", text: "visible intermediate output" };
        await new Promise<void>((resolve) => {
          releaseCompletion = resolve;
        });
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
      { maxConcurrent: 3 },
      { host: { config: configHost } },
    );
    mgr.setToolContext(toolCtx);
    const projectionListener = vi.fn();
    const legacyListener = vi.fn();
    mgr.onDidChangeSessions(projectionListener);
    mgr.onSessionsChanged = legacyListener;
    const spawned = await mgr.spawnBackground({
      task: "streaming publication",
      message: "work",
    });
    await waitFor(
      () => releaseEvent,
      (release) => typeof release === "function",
    );
    projectionListener.mockClear();
    legacyListener.mockClear();

    releaseEvent?.();
    await waitFor(
      () =>
        mgr.getBgSessionInfos().find((info) => info.id === spawned.sessionId)
          ?.streamingText,
      (text) => text === "visible intermediate output",
    );

    expect(projectionListener).toHaveBeenCalled();
    expect(legacyListener).not.toHaveBeenCalled();
    releaseCompletion?.();
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
    const createToolRuntime = vi.fn(() => ({ executeTool: vi.fn() }));
    (mgr as any).host.createToolRuntime = createToolRuntime;

    const spawned = await mgr.spawnBackground({
      task: "research tests",
      message: "inspect tests",
      taskClass: "readonly-research",
      budget: { maxToolCalls: 12, maxApiTurns: 6 },
    });

    await new Promise((r) => setTimeout(r, 0));

    const meta = (mgr as any).bgMeta.get(spawned.sessionId);
    meta.startedAt = 1_000;
    meta.lastProgressAt = 7_000;
    meta.phase = "waiting_for_provider";
    meta.phaseStartedAt = 6_000;
    meta.requestStartedAt = 8_000;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(10_000);
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
    expect(status.apiTurns).toBe(1);
    expect(status.phase).toBe("waiting_for_provider");
    expect(status.startedAt).toBe(1_000);
    expect(status.lastProgressAt).toBe(7_000);
    expect(status.phaseStartedAt).toBe(6_000);
    expect(status.requestStartedAt).toBe(8_000);
    expect(status.requestElapsedMs).toBe(2_000);
    expect(status.elapsedMs).toBe(9_000);
    expect(status.idleMs).toBe(3_000);
    expect(status.budget).toEqual({ maxToolCalls: 12, maxApiTurns: 6 });
    expect(status.budgetUsage).toEqual({
      tokens: 100,
      toolCalls: 1,
      apiTurns: 1,
      elapsedMs: 9_000,
    });
    expect(status.canSteer).toBe(true);
    expect(status.canKill).toBe(true);
    expect(status.partialOutput).toBeUndefined();
    const session = (mgr as any).sessions.get(spawned.sessionId);
    expect(mocks.runArgs).toHaveBeenCalledWith(
      session,
      expect.objectContaining({ toolProfile: "readonly-research" }),
    );
    expect(createToolRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: spawned.sessionId,
        commandExecutionPolicy: "read-only",
      }),
    );

    const info = mgr
      .getBgSessionInfos()
      .find((candidate) => candidate.id === spawned.sessionId);
    expect(info).toMatchObject({
      phase: "waiting_for_provider",
      startedAt: 1_000,
      lastProgressAt: 7_000,
      phaseStartedAt: 6_000,
      requestStartedAt: 8_000,
      requestElapsedMs: 2_000,
      canSteer: true,
      canKill: true,
    });
    nowSpy.mockRestore();

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

  it("does not resume an idle foreground session when a background result returns", async () => {
    mocks.runBehavior.mockReturnValueOnce(
      (async function* () {
        yield { type: "done" };
      })(),
    );

    const mgr = new AgentSessionManager(config, "/tmp");
    mgr.setToolContext(toolCtx);

    await mgr.createSession("code");
    const sendMessageSpy = vi.spyOn(mgr, "sendMessage");

    const result = await mgr.spawnBackground({
      task: "inspect failing tests",
      message: "run the investigation",
    });

    await new Promise((r) => setTimeout(r, 0));

    expect(sendMessageSpy).not.toHaveBeenCalled();
    expect(mgr.getBackgroundStatus(result.sessionId).status).toBe("idle");
    expect(mgr.getBackgroundResult(result.sessionId).resultText).toBeDefined();
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
      permissionProfile: "review-only",
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
    const firstOptions = mocks.runArgs.mock.calls[0]?.[1] as
      | Record<string, unknown>
      | undefined;
    const secondOptions = mocks.runArgs.mock.calls[1]?.[1] as
      | Record<string, unknown>
      | undefined;
    expect(firstOptions?.webAccessPolicy).toBe(secondOptions?.webAccessPolicy);
    expect(firstOptions?.mcpToolDisclosure).toBe(
      secondOptions?.mcpToolDisclosure,
    );
    expect(firstOptions?.mcpToolDefinitions).toBe(
      secondOptions?.mcpToolDefinitions,
    );
    expect(Object.isFrozen(firstOptions?.webAccessPolicy)).toBe(true);
    expect(Object.isFrozen(firstOptions?.mcpToolDefinitions)).toBe(true);
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

  it("auto-continues when pending todos remain at natural done", async () => {
    const mgr = new AgentSessionManager(config, "/tmp");
    mgr.setToolContext(toolCtx);

    const fg = await mgr.createSession("code");
    const addUserMessageSpy = vi.spyOn(fg, "addUserMessage");

    mocks.runBehavior
      .mockReturnValueOnce(
        (async function* () {
          yield {
            type: "todo_update",
            todos: [{ id: "1", content: "finish it", status: "pending" }],
          };
          yield { type: "done" };
        })(),
      )
      .mockReturnValueOnce(
        (async function* () {
          yield {
            type: "todo_update",
            todos: [{ id: "1", content: "finish it", status: "completed" }],
          };
          yield { type: "done" };
        })(),
      );

    await mgr.sendMessage(fg.id, "work on the task", fg.mode);

    expect(mocks.runBehavior).toHaveBeenCalledTimes(2);
    expect(addUserMessageSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "Before doing more work, reconcile the complete list against the conversation and current workspace",
      ),
    );
    expect(addUserMessageSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "Do not redo completed work merely because its TODO status is stale",
      ),
    );
  });

  it("does not auto-continue pending todos after an explicit final marker", async () => {
    const mgr = new AgentSessionManager(config, "/tmp");
    mgr.setToolContext(toolCtx);

    const fg = await mgr.createSession("code");
    const addUserMessageSpy = vi.spyOn(fg, "addUserMessage");

    mocks.runBehavior.mockReturnValueOnce(
      (async function* () {
        yield {
          type: "todo_update",
          todos: [{ id: "1", content: "finish it", status: "pending" }],
        };
        yield {
          type: "final_marker",
          marker: {
            status: "completed",
            source: "tool",
            summary: "Answered the user's question.",
          },
        };
        yield { type: "done" };
      })(),
    );

    await mgr.sendMessage(fg.id, "work on the task", fg.mode);

    expect(mocks.runBehavior).toHaveBeenCalledTimes(1);
    expect(addUserMessageSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("You stopped but the TODO list"),
    );
  });

  it("skips auto-continue when a UI surface has queued messages", async () => {
    const mgr = new AgentSessionManager(config, "/tmp");
    mgr.setToolContext(toolCtx);

    const fg = await mgr.createSession("code");
    (fg as any).hasQueuedUiMessages = true;
    const addUserMessageSpy = vi.spyOn(fg, "addUserMessage");
    const events: Array<{ type: string }> = [];
    mgr.onEvent = (_sessionId, event) => {
      events.push(event as { type: string });
    };

    mocks.runBehavior.mockReturnValueOnce(
      (async function* () {
        yield {
          type: "todo_update",
          todos: [{ id: "1", content: "finish it", status: "pending" }],
        };
        yield { type: "done" };
      })(),
    );

    await mgr.sendMessage(fg.id, "work on the task", fg.mode);

    // The queued message takes priority: no synthetic continue prompt, and
    // done is emitted so the UI can flush its queue.
    expect(mocks.runBehavior).toHaveBeenCalledTimes(1);
    expect(addUserMessageSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("You stopped but the TODO list"),
    );
    expect(events.filter((event) => event.type === "done")).toHaveLength(1);
  });

  it("skips auto-continue when an interjection is still pending", async () => {
    const mgr = new AgentSessionManager(config, "/tmp");
    mgr.setToolContext(toolCtx);

    const fg = await mgr.createSession("code");
    const addUserMessageSpy = vi.spyOn(fg, "addUserMessage");

    mocks.runBehavior.mockReturnValueOnce(
      (async function* () {
        (fg as any).setPendingInterjection("still pending", "queue-1");
        yield {
          type: "todo_update",
          todos: [{ id: "1", content: "finish it", status: "pending" }],
        };
        yield { type: "done" };
      })(),
    );

    await mgr.sendMessage(fg.id, "work on the task", fg.mode);

    expect(mocks.runBehavior).toHaveBeenCalledTimes(1);
    expect(addUserMessageSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("You stopped but the TODO list"),
    );
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
