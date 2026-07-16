import { beforeEach, describe, expect, it, vi } from "vitest";

import { BrowserGatewayService } from "./BrowserGatewayService.js";
import { InMemoryAgentUiEventHub } from "../agent/AgentUiPublisher.js";
import { diffSnapshotHub } from "./DiffSnapshotHub.js";

vi.mock("vscode", () => {
  type Listener<T> = (event: T) => void;

  class MockEventEmitter<T> {
    private listeners = new Set<Listener<T>>();

    event = (listener: Listener<T>) => {
      this.listeners.add(listener);
      return { dispose: () => this.listeners.delete(listener) };
    };

    fire(value: T): void {
      for (const listener of this.listeners) {
        listener(value);
      }
    }

    dispose(): void {
      this.listeners.clear();
    }
  }

  return {
    EventEmitter: MockEventEmitter,
    workspace: {
      getConfiguration: () => ({
        get: () => undefined,
      }),
    },
  };
});

function makeSessionManagerStub() {
  return {
    listPersistedSessions: vi.fn(() => [
      {
        schemaVersion: 1,
        id: "session-1",
        mode: "code",
        model: "claude-sonnet-4-6",
        title: "Test Session",
        messageCount: 2,
        totalInputTokens: 10,
        totalOutputTokens: 20,
        createdAt: 1,
        lastActiveAt: 2,
      },
    ]),
    getForegroundSession: vi.fn(() => ({
      id: "session-1",
      title: "Test Session",
      mode: "code",
      model: "claude-sonnet-4-6",
      status: "idle",
      lastInputTokens: 10,
      lastOutputTokens: 20,
      lastCacheReadTokens: 3,
      estimatedTotalUsed: 33,
      getAllMessages: vi.fn(() => [
        { role: "user", content: "hello" },
        { role: "assistant", content: [{ type: "text", text: "world" }] },
      ]),
    })),
    getPersistedSessionMessages: vi.fn(() => [
      { role: "user", content: "hello" },
      { role: "assistant", content: [{ type: "text", text: "world" }] },
    ]),
    getBgSessionInfos: vi.fn(() => []),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

function projectedForeground(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "session-1",
    mode: "code",
    model: "claude-sonnet-4-6",
    streaming: false,
    statusOverride: null,
    projectedMessages: [
      {
        id: "chat-1",
        role: "assistant",
        content: "hello",
        timestamp: 1,
        blocks: [{ type: "text", text: "hello" }],
      },
    ],
    lastInputTokens: 10,
    lastOutputTokens: 20,
    lastCacheReadTokens: 3,
    estimatedTotalUsed: 33,
    thinkingEnabled: true,
    reasoningEffort: "high",
    messageQueue: [],
    questionRequest: null,
    detectedQuestion: null,
    todos: [],
    debugInfo: null,
    systemPrompt: null,
    loadedInstructions: null,
    restoringSession: false,
    revertRecoveryNotice: null,
    ...overrides,
  };
}

const disabledPollTimers = {
  setInterval: vi.fn(() => ({ kind: "disabled-poll" }) as never),
  clearInterval: vi.fn(),
};

const themeSnapshotStub = {
  cssVariables: {
    "--vscode-editor-background": "#1e1e1e",
  },
  colorScheme: "dark" as const,
  themeLabel: "Dark",
  source: "vscode-theme-api" as const,
};

function makePollService(hub: InMemoryAgentUiEventHub): BrowserGatewayService {
  const sessionManager = makeSessionManagerStub();
  return new BrowserGatewayService(
    hub,
    sessionManager as never,
    () => themeSnapshotStub,
    () => "prompt",
    () => true,
    () => "high",
    () => null,
    () => [],
  );
}

describe("BrowserGatewayService", () => {
  it("publishes monotonic snapshots with their prebuilt wire payload", () => {
    const hub = new InMemoryAgentUiEventHub();
    const service = makePollService(hub);
    const publications = vi.fn();
    const subscription = service.onDidChange(publications);

    hub.publishApproval({
      kind: "write",
      id: "approval-1",
      filePath: "src/file.ts",
      writeOperation: "modify",
    });
    hub.publishApprovalIdle();

    expect(publications).toHaveBeenCalledTimes(2);
    const [first, second] = publications.mock.calls.map(
      ([publication]) =>
        publication as Parameters<Parameters<typeof service.onDidChange>[0]>[0],
    );
    expect([first.revision, second.revision]).toEqual([1, 2]);
    expect(first.serialized).toBe(JSON.stringify(first.snapshot));
    expect(first.bytes).toBe(Buffer.byteLength(first.serialized, "utf8"));
    expect(second.serialized).toBe(JSON.stringify(second.snapshot));
    expect(second.bytes).toBe(Buffer.byteLength(second.serialized, "utf8"));

    subscription.dispose();
    service.dispose();
    hub.dispose();
  });

  it("creates revisioned initial publications through the shared producer sequence", () => {
    const hub = new InMemoryAgentUiEventHub();
    const sessionManager = makeSessionManagerStub();
    const service = new BrowserGatewayService(
      hub,
      sessionManager as never,
      () => themeSnapshotStub,
      () => "prompt",
      () => true,
      () => "high",
      () => null,
      () => [],
    );

    const initial = service.createSnapshotPublication();
    hub.publishApproval({
      kind: "write",
      id: "approval-after-initial",
      filePath: "src/file.ts",
      writeOperation: "modify",
    });
    const next = service.createSnapshotPublication();

    expect([initial.revision, next.revision]).toEqual([1, 3]);
    expect(initial.serialized).toBe(JSON.stringify(initial.snapshot));
    expect(initial.bytes).toBe(Buffer.byteLength(initial.serialized, "utf8"));
    expect(next.serialized).toBe(JSON.stringify(next.snapshot));
    expect(next.bytes).toBe(Buffer.byteLength(next.serialized, "utf8"));

    service.dispose();
    hub.dispose();
  });

  it("tracks approval and question state from hub events", () => {
    const hub = new InMemoryAgentUiEventHub();
    const sessionManager = makeSessionManagerStub();
    let projectedQuestionRequest: {
      id: string;
      context: string;
      questions: Array<{ id: string; type: "yes_no"; question: string }>;
    } | null = null;
    const service = new BrowserGatewayService(
      hub,
      sessionManager as never,
      () => themeSnapshotStub,
      () => "prompt",
      () => true,
      () => "high",
      () => ({
        sessionId: "session-1",
        mode: "code",
        model: "claude-sonnet-4-6",
        streaming: false,
        statusOverride: null,
        projectedMessages: [
          {
            id: "chat-1",
            role: "assistant",
            content: "",
            timestamp: 1,
            blocks: [{ type: "text", text: "world" }],
          },
        ],
        lastInputTokens: 10,
        lastOutputTokens: 20,
        lastCacheReadTokens: 3,
        estimatedTotalUsed: 33,
        thinkingEnabled: true,
        reasoningEffort: "high",
        messageQueue: [],
        questionRequest: projectedQuestionRequest,
        detectedQuestion: null,
        todos: [],
        debugInfo: null,
        systemPrompt: null,
        loadedInstructions: null,
        restoringSession: false,
        revertRecoveryNotice: {
          checkpointId: "checkpoint-1",
          sessionRevision: "revision-2",
          workspaceRevision: "abcdef1234567890",
          startedAt: 123,
          title: "Checkpoint revert needs transcript recovery",
          message: "Recovery metadata is recorded.",
        },
        contextBudget: {
          contextWindow: 200000,
          maxInputTokens: 191808,
          usedInputTokens: 10,
          outputReservation: 8192,
          safetyBufferTokens: 4096,
          softThresholdBudget: 150000,
          hardBudget: 180000,
        },
        condenseThreshold: 0.8,
      }),
      () => [],
    );
    const onDidChange = vi.fn();
    const subscription = service.onDidChange(onDidChange);

    hub.publishApproval({
      kind: "write",
      id: "approval-1",
      filePath: "src/file.ts",
      writeOperation: "modify",
    });

    expect(service.getUiState()).toMatchObject({
      approval: {
        kind: "write",
        id: "approval-1",
        filePath: "src/file.ts",
        writeOperation: "modify",
      },
      question: undefined,
    });
    expect(service.getSerializableSessionState()).toEqual({
      sessions: [
        expect.objectContaining({
          id: "session-1",
          title: "Test Session",
        }),
      ],
      repository: null,
      foreground: {
        sessionId: "session-1",
        title: "Test Session",
        mode: "code",
        model: "claude-sonnet-4-6",
        status: "idle",
        streaming: false,
        projectedMessages: [
          {
            id: "chat-1",
            role: "assistant",
            content: "",
            timestamp: 1,
            blocks: [{ type: "text", text: "world" }],
          },
        ],
        statusOverride: null,
        thinkingEnabled: true,
        reasoningEffort: "high",
        lastInputTokens: 10,
        lastOutputTokens: 20,
        lastCacheReadTokens: 3,
        estimatedTotalUsed: 33,
        messageQueue: [],
        questionRequest: null,
        detectedQuestion: null,
        todos: [],
        debugInfo: null,
        systemPrompt: null,
        loadedInstructions: null,
        restoringSession: false,
        revertRecoveryNotice: {
          checkpointId: "checkpoint-1",
          sessionRevision: "revision-2",
          workspaceRevision: "abcdef1234567890",
          startedAt: 123,
          title: "Checkpoint revert needs transcript recovery",
          message: "Recovery metadata is recorded.",
        },
        contextBudget: {
          contextWindow: 200000,
          maxInputTokens: 191808,
          usedInputTokens: 10,
          outputReservation: 8192,
          safetyBufferTokens: 4096,
          softThresholdBudget: 150000,
          hardBudget: 180000,
        },
        condenseThreshold: 0.8,
        agentWriteApproval: "prompt",
        commandApprovalPolicy: "safe",
        configuredCommandApprovalPolicy: "safe",
      },
    });
    diffSnapshotHub.upsert({
      requestId: "approval-1",
      filePath: "src/file.ts",
      operation: "modify",
      originalContent: "before",
      proposedContent: "after",
      outsideWorkspace: false,
      createdAt: 1,
    });
    expect(service.getSerializableSnapshotState().diffs).toEqual([
      {
        requestId: "approval-1",
        filePath: "src/file.ts",
        operation: "modify",
        originalPreview: "before",
        proposedPreview: "after",
        outsideWorkspace: false,
        createdAt: 1,
      },
    ]);
    expect(onDidChange).toHaveBeenCalled();

    projectedQuestionRequest = {
      id: "question-1",
      context: "Need confirmation.",
      questions: [
        {
          id: "q1",
          type: "yes_no",
          question: "Continue?",
        },
      ],
    };
    hub.publishQuestionRequest(
      projectedQuestionRequest.id,
      projectedQuestionRequest.context,
      projectedQuestionRequest.questions,
    );

    expect(service.getUiState()).toMatchObject({
      approval: {
        kind: "write",
        id: "approval-1",
      },
      question: {
        id: "question-1",
        context: "Need confirmation.",
        questions: [
          {
            id: "q1",
            type: "yes_no",
            question: "Continue?",
          },
        ],
      },
    });

    hub.publishApprovalIdle();

    expect(service.getUiState()).toMatchObject({
      approval: undefined,
      question: {
        id: "question-1",
        context: "Need confirmation.",
        questions: [
          {
            id: "q1",
            type: "yes_no",
            question: "Continue?",
          },
        ],
      },
    });

    service.dispose();
    projectedQuestionRequest = null;
    hub.publishApproval({
      kind: "write",
      id: "approval-after-dispose",
      filePath: "src/ignored.ts",
      writeOperation: "modify",
    });
    expect(service.getUiState()).toEqual({
      approval: undefined,
      question: undefined,
      recentEvents: [],
    });
    subscription.dispose();
    diffSnapshotHub.remove("approval-1");
    hub.dispose();
  });

  it("seeds initial state from the hub snapshot, caps recent event history, and clears state on dispose", () => {
    const hub = new InMemoryAgentUiEventHub();
    const sessionManager = makeSessionManagerStub();
    hub.publishApproval({
      kind: "write",
      id: "approval-seeded",
      filePath: "src/seeded.ts",
      writeOperation: "create",
    });

    const service = new BrowserGatewayService(
      hub,
      sessionManager as never,
      () => themeSnapshotStub,
      () => "prompt",
      () => true,
      () => "high",
      () => ({
        sessionId: "session-1",
        mode: "code",
        model: "claude-sonnet-4-6",
        streaming: false,
        statusOverride: null,
        projectedMessages: [],
        lastInputTokens: 10,
        lastOutputTokens: 20,
        lastCacheReadTokens: 3,
        estimatedTotalUsed: 33,
        thinkingEnabled: true,
        reasoningEffort: "high",
        messageQueue: [],
        questionRequest: null,
        detectedQuestion: null,
        todos: [],
        debugInfo: null,
        systemPrompt: null,
        loadedInstructions: null,
        restoringSession: false,
        revertRecoveryNotice: null,
        contextBudget: {
          contextWindow: 200000,
          maxInputTokens: 191808,
          usedInputTokens: 10,
          outputReservation: 8192,
          safetyBufferTokens: 4096,
          softThresholdBudget: 150000,
          hardBudget: 180000,
        },
        condenseThreshold: 0.8,
      }),
      () => [],
      2,
    );

    expect(service.getUiState()).toMatchObject({
      approval: {
        id: "approval-seeded",
        filePath: "src/seeded.ts",
        writeOperation: "create",
      },
    });

    hub.publishQuestionRequest("question-2", "Need input.", []);
    hub.publishApprovalIdle();

    expect(service.getUiState().recentEvents).toEqual([
      {
        type: "agentQuestionRequest",
        id: "question-2",
        context: "Need input.",
        questions: [],
      },
      { type: "idle" },
    ]);

    service.dispose();
    expect(service.getUiState()).toEqual({
      approval: undefined,
      question: undefined,
      recentEvents: [],
    });
    hub.dispose();
  });

  it("does not expose stale foreground questions from the hub snapshot", () => {
    const hub = new InMemoryAgentUiEventHub();
    const sessionManager = makeSessionManagerStub();
    hub.publishQuestionRequest("stale-question", "Old question.", [
      {
        id: "continue",
        type: "yes_no",
        question: "Continue?",
      },
    ]);

    const service = new BrowserGatewayService(
      hub,
      sessionManager as never,
      () => themeSnapshotStub,
      () => "prompt",
      () => true,
      () => "high",
      () => ({
        sessionId: "session-1",
        mode: "code",
        model: "claude-sonnet-4-6",
        streaming: false,
        statusOverride: null,
        projectedMessages: [],
        lastInputTokens: 10,
        lastOutputTokens: 20,
        lastCacheReadTokens: 3,
        estimatedTotalUsed: 33,
        thinkingEnabled: true,
        reasoningEffort: "high",
        messageQueue: [],
        questionRequest: null,
        detectedQuestion: null,
        todos: [],
        debugInfo: null,
        systemPrompt: null,
        loadedInstructions: null,
        restoringSession: false,
        revertRecoveryNotice: null,
      }),
      () => [],
    );

    expect(service.getUiState().question).toBeUndefined();
    expect(service.getSerializableState().question).toBeNull();

    service.dispose();
    hub.dispose();
  });

  it("does not expose a question when the projected state belongs to another foreground session", () => {
    const hub = new InMemoryAgentUiEventHub();
    const sessionManager = makeSessionManagerStub();
    const service = new BrowserGatewayService(
      hub,
      sessionManager as never,
      () => themeSnapshotStub,
      () => "prompt",
      () => true,
      () => "high",
      () => ({
        sessionId: "session-2",
        mode: "code",
        model: "claude-sonnet-4-6",
        streaming: false,
        statusOverride: null,
        projectedMessages: [],
        lastInputTokens: 10,
        lastOutputTokens: 20,
        lastCacheReadTokens: 3,
        estimatedTotalUsed: 33,
        thinkingEnabled: true,
        reasoningEffort: "high",
        messageQueue: [],
        questionRequest: {
          id: "wrong-session-question",
          context: "Question for another session.",
          questions: [
            {
              id: "continue",
              type: "yes_no",
              question: "Continue?",
            },
          ],
        },
        detectedQuestion: null,
        todos: [],
        debugInfo: null,
        systemPrompt: null,
        loadedInstructions: null,
        restoringSession: false,
        revertRecoveryNotice: null,
      }),
      () => [],
    );

    hub.publishQuestionRequest(
      "wrong-session-question",
      "Question for another session.",
      [
        {
          id: "continue",
          type: "yes_no",
          question: "Continue?",
        },
      ],
    );

    expect(service.getUiState().question).toBeUndefined();
    expect(service.getSerializableState().question).toBeNull();

    service.dispose();
    hub.dispose();
  });

  it("keeps background-agent questions visible without a foreground projection", () => {
    const hub = new InMemoryAgentUiEventHub();
    const sessionManager = makeSessionManagerStub();
    const service = new BrowserGatewayService(
      hub,
      sessionManager as never,
      () => themeSnapshotStub,
      () => "prompt",
      () => true,
      () => "high",
      () => ({
        sessionId: "session-1",
        mode: "code",
        model: "claude-sonnet-4-6",
        streaming: false,
        statusOverride: null,
        projectedMessages: [],
        lastInputTokens: 10,
        lastOutputTokens: 20,
        lastCacheReadTokens: 3,
        estimatedTotalUsed: 33,
        thinkingEnabled: true,
        reasoningEffort: "high",
        messageQueue: [],
        questionRequest: null,
        detectedQuestion: null,
        todos: [],
        debugInfo: null,
        systemPrompt: null,
        loadedInstructions: null,
        restoringSession: false,
        revertRecoveryNotice: null,
      }),
      () => [],
    );

    hub.publishQuestionRequest(
      "background-question",
      "Background task needs input.",
      [],
      "Review implementation",
    );
    hub.publishQuestionProgress({
      id: "background-question",
      step: 1,
      answers: { continue: true },
      notes: {},
      origin: "browser",
    });

    expect(service.getSerializableState()).toMatchObject({
      question: {
        id: "background-question",
        context: "Background task needs input.",
        questions: [],
        backgroundTask: "Review implementation",
      },
      questionProgress: {
        id: "background-question",
        step: 1,
        answers: { continue: true },
      },
    });

    service.dispose();
    hub.dispose();
  });

  it("publishes surface and approval-policy changes with the recurring poll disabled", () => {
    vi.useFakeTimers();
    try {
      const hub = new InMemoryAgentUiEventHub();
      const sessionManager = makeSessionManagerStub();
      let theme = themeSnapshotStub;
      let effectivePolicy: "safe" | "approve-for-me" = "safe";
      let configuredPolicy: "safe" | "sensitive" = "safe";
      let surfaceListener: ((kind: "mcp" | "theme") => void) | undefined;
      const service = new BrowserGatewayService(
        hub,
        sessionManager as never,
        () => theme,
        () => "project",
        () => true,
        () => "high",
        () =>
          projectedForeground({
            commandApprovalPolicy: "safe",
            configuredCommandApprovalPolicy: "safe",
          }) as never,
        () => [],
        undefined,
        undefined,
        {
          ...disabledPollTimers,
          setTimeout,
          clearTimeout,
          foregroundCoalesceMs: 150,
        },
      );
      service.setCommandApprovalPolicyGetters(
        () => effectivePolicy,
        () => configuredPolicy,
      );
      service.setHasActiveClientsProbe(() => true);
      service.subscribeToSurfaceChanges((listener) => {
        surfaceListener = listener;
        return { dispose: vi.fn() } as never;
      });
      const onDidChange = vi.fn();
      const subscription = service.onDidChange(onDidChange);

      effectivePolicy = "approve-for-me";
      configuredPolicy = "sensitive";
      surfaceListener?.("mcp");
      vi.advanceTimersByTime(150);

      expect(onDidChange).toHaveBeenCalledTimes(1);
      expect(
        onDidChange.mock.calls[0][0].snapshot.session.foreground,
      ).toMatchObject({
        agentWriteApproval: "project",
        commandApprovalPolicy: "approve-for-me",
        configuredCommandApprovalPolicy: "sensitive",
      });

      theme = {
        ...themeSnapshotStub,
        themeLabel: "Updated Dark",
      };
      surfaceListener?.("theme");
      vi.advanceTimersByTime(150);
      expect(onDidChange).toHaveBeenCalledTimes(2);
      expect(onDidChange.mock.calls[1][0].snapshot.theme.themeLabel).toBe(
        "Updated Dark",
      );

      surfaceListener?.("mcp");
      vi.advanceTimersByTime(150);
      expect(onDidChange).toHaveBeenCalledTimes(2);

      subscription.dispose();
      service.dispose();
      hub.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("publishes theme changes without clients while skipping ordinary surface changes", () => {
    vi.useFakeTimers();
    try {
      const hub = new InMemoryAgentUiEventHub();
      let theme: {
        cssVariables: Record<string, string>;
        colorScheme: "light" | "dark";
        themeLabel: string;
        source: "vscode-theme-api";
      } = themeSnapshotStub;
      let surfaceListener: ((kind: "mcp" | "theme") => void) | undefined;
      const service = new BrowserGatewayService(
        hub,
        makeSessionManagerStub() as never,
        () => theme,
        () => "prompt",
        () => true,
        () => "high",
        () => projectedForeground() as never,
        () => [],
        undefined,
        undefined,
        {
          ...disabledPollTimers,
          setTimeout,
          clearTimeout,
          foregroundCoalesceMs: 150,
        },
      );
      service.setHasActiveClientsProbe(() => false);
      service.subscribeToSurfaceChanges((listener) => {
        surfaceListener = listener;
        return { dispose: vi.fn() } as never;
      });
      const onDidChange = vi.fn();
      const subscription = service.onDidChange(onDidChange);

      surfaceListener?.("mcp");
      vi.advanceTimersByTime(150);
      expect(onDidChange).not.toHaveBeenCalled();

      let hasClients = true;
      service.setHasActiveClientsProbe(() => hasClients);
      service.invalidateBrowserSnapshot();
      theme = { ...themeSnapshotStub, colorScheme: "light" };
      surfaceListener?.("theme");
      hasClients = false;
      vi.advanceTimersByTime(150);
      expect(onDidChange).toHaveBeenCalledTimes(1);
      expect(onDidChange.mock.calls[0][0].snapshot.theme.colorScheme).toBe(
        "light",
      );

      subscription.dispose();
      service.dispose();
      hub.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("publishes fallback foreground and persisted-session changes with the recurring poll disabled", () => {
    vi.useFakeTimers();
    try {
      const hub = new InMemoryAgentUiEventHub();
      const sessionManager = makeSessionManagerStub();
      let sessionListener: (() => void) | undefined;
      const sessionSubscriptionDispose = vi.fn();
      const service = new BrowserGatewayService(
        hub,
        sessionManager as never,
        () => themeSnapshotStub,
        () => "prompt",
        () => true,
        () => "high",
        () => null,
        () => [],
        undefined,
        undefined,
        {
          ...disabledPollTimers,
          setTimeout,
          clearTimeout,
          foregroundCoalesceMs: 150,
        },
      );
      service.setHasActiveClientsProbe(() => true);
      service.subscribeToSessionChanges((listener) => {
        sessionListener = listener;
        return { dispose: sessionSubscriptionDispose } as never;
      });
      const onDidChange = vi.fn();
      const subscription = service.onDidChange(onDidChange);

      sessionManager.listPersistedSessions.mockReturnValue([
        {
          schemaVersion: 1,
          id: "session-1",
          mode: "code",
          model: "claude-sonnet-4-6",
          title: "Renamed Session",
          messageCount: 2,
          totalInputTokens: 10,
          totalOutputTokens: 20,
          createdAt: 1,
          lastActiveAt: 3,
        },
      ]);
      sessionManager.getForegroundSession.mockReturnValue({
        ...sessionManager.getForegroundSession(),
        title: "Renamed Session",
        status: "tool_executing",
      });
      sessionListener?.();
      vi.advanceTimersByTime(150);

      expect(onDidChange).toHaveBeenCalledTimes(1);
      expect(onDidChange.mock.calls[0][0].snapshot.session).toMatchObject({
        sessions: [expect.objectContaining({ title: "Renamed Session" })],
        foreground: {
          title: "Renamed Session",
          status: "tool_executing",
          streaming: true,
        },
      });

      sessionManager.getForegroundSession.mockImplementation(
        () => undefined as never,
      );
      sessionListener?.();
      vi.advanceTimersByTime(150);

      expect(onDidChange).toHaveBeenCalledTimes(2);
      expect(
        onDidChange.mock.calls[1][0].snapshot.session.foreground,
      ).toBeNull();

      subscription.dispose();
      service.dispose();
      expect(sessionSubscriptionDispose).toHaveBeenCalledTimes(1);
      hub.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("publishes projected foreground changes through explicit invalidation with the recurring poll disabled", () => {
    vi.useFakeTimers();
    try {
      const hub = new InMemoryAgentUiEventHub();
      const sessionManager = makeSessionManagerStub();
      let projected = projectedForeground();
      let foregroundListener: (() => void) | undefined;
      const service = new BrowserGatewayService(
        hub,
        sessionManager as never,
        () => themeSnapshotStub,
        () => "prompt",
        () => true,
        () => "high",
        () => projected as never,
        () => [],
        undefined,
        undefined,
        {
          ...disabledPollTimers,
          setTimeout,
          clearTimeout,
          foregroundCoalesceMs: 150,
        },
      );
      service.setHasActiveClientsProbe(() => true);
      service.subscribeToProjectedForegroundChanges((listener) => {
        foregroundListener = listener;
        return { dispose: vi.fn() } as never;
      });
      const onDidChange = vi.fn();
      const subscription = service.onDidChange(onDidChange);

      projected = projectedForeground({ model: "gpt-5.6" });
      foregroundListener?.();
      vi.advanceTimersByTime(149);
      expect(onDidChange).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);

      expect(onDidChange).toHaveBeenCalledTimes(1);
      expect(
        onDidChange.mock.calls[0][0].snapshot.session.foreground,
      ).toMatchObject({
        model: "gpt-5.6",
      });

      subscription.dispose();
      service.dispose();
      hub.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses a fixed coalescing window that does not starve under continuous foreground invalidation", () => {
    vi.useFakeTimers();
    try {
      const hub = new InMemoryAgentUiEventHub();
      const sessionManager = makeSessionManagerStub();
      let projected = projectedForeground({
        projectedMessages: [
          {
            id: "chat-1",
            role: "assistant",
            content: "first",
            timestamp: 1,
            blocks: [{ type: "text", text: "first" }],
          },
        ],
      });
      const service = new BrowserGatewayService(
        hub,
        sessionManager as never,
        () => themeSnapshotStub,
        () => "prompt",
        () => true,
        () => "high",
        () => projected as never,
        () => [],
        undefined,
        undefined,
        {
          ...disabledPollTimers,
          setTimeout,
          clearTimeout,
          foregroundCoalesceMs: 150,
        },
      );
      service.setHasActiveClientsProbe(() => true);
      const onDidChange = vi.fn();
      const subscription = service.onDidChange(onDidChange);

      service.invalidateBrowserSnapshot();
      vi.advanceTimersByTime(149);
      projected = projectedForeground({
        projectedMessages: [
          {
            id: "chat-1",
            role: "assistant",
            content: "latest",
            timestamp: 1,
            blocks: [{ type: "text", text: "latest" }],
          },
        ],
      });
      service.invalidateBrowserSnapshot();
      expect(onDidChange).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(onDidChange).toHaveBeenCalledTimes(1);
      expect(
        onDidChange.mock.calls[0][0].snapshot.session.foreground
          .projectedMessages[0].content,
      ).toBe("latest");

      subscription.dispose();
      service.dispose();
      hub.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets immediate foreground invalidation cancel pending stale publication", () => {
    vi.useFakeTimers();
    try {
      const hub = new InMemoryAgentUiEventHub();
      const sessionManager = makeSessionManagerStub();
      let projected = projectedForeground({ model: "pending-model" });
      const service = new BrowserGatewayService(
        hub,
        sessionManager as never,
        () => themeSnapshotStub,
        () => "prompt",
        () => true,
        () => "high",
        () => projected as never,
        () => [],
        undefined,
        undefined,
        {
          ...disabledPollTimers,
          setTimeout,
          clearTimeout,
          foregroundCoalesceMs: 150,
        },
      );
      service.setHasActiveClientsProbe(() => true);
      const onDidChange = vi.fn();
      const subscription = service.onDidChange(onDidChange);

      service.invalidateBrowserSnapshot();
      projected = projectedForeground({ model: "immediate-model" });
      service.invalidateBrowserSnapshot({ immediate: true });

      expect(onDidChange).toHaveBeenCalledTimes(1);
      expect(
        onDidChange.mock.calls[0][0].snapshot.session.foreground,
      ).toMatchObject({
        model: "immediate-model",
      });

      vi.advanceTimersByTime(150);
      expect(onDidChange).toHaveBeenCalledTimes(1);

      subscription.dispose();
      service.dispose();
      hub.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("suppresses unchanged foreground invalidations and disposes the subscription", () => {
    vi.useFakeTimers();
    try {
      const hub = new InMemoryAgentUiEventHub();
      const sessionManager = makeSessionManagerStub();
      const projected = projectedForeground();
      const foregroundSubscriptionDispose = vi.fn();
      let foregroundListener: (() => void) | undefined;
      const service = new BrowserGatewayService(
        hub,
        sessionManager as never,
        () => themeSnapshotStub,
        () => "prompt",
        () => true,
        () => "high",
        () => projected as never,
        () => [],
        undefined,
        undefined,
        {
          ...disabledPollTimers,
          setTimeout,
          clearTimeout,
          foregroundCoalesceMs: 150,
        },
      );
      service.setHasActiveClientsProbe(() => true);
      service.createSnapshotPublication();
      service.subscribeToProjectedForegroundChanges((listener) => {
        foregroundListener = listener;
        return { dispose: foregroundSubscriptionDispose } as never;
      });
      const onDidChange = vi.fn();
      const subscription = service.onDidChange(onDidChange);

      foregroundListener?.();
      vi.advanceTimersByTime(150);
      expect(onDidChange).not.toHaveBeenCalled();

      service.invalidateBrowserSnapshot();
      service.dispose();
      vi.advanceTimersByTime(150);
      expect(onDidChange).not.toHaveBeenCalled();
      expect(foregroundSubscriptionDispose).toHaveBeenCalledTimes(1);

      subscription.dispose();
      hub.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not cancel an already pending foreground publication when a later invalidation has no connected clients", () => {
    vi.useFakeTimers();
    try {
      const hub = new InMemoryAgentUiEventHub();
      let projected = projectedForeground({ model: "connected-model" });
      let hasClients = true;
      const service = new BrowserGatewayService(
        hub,
        makeSessionManagerStub() as never,
        () => themeSnapshotStub,
        () => "prompt",
        () => true,
        () => "high",
        () => projected as never,
        () => [],
        undefined,
        undefined,
        {
          ...disabledPollTimers,
          setTimeout,
          clearTimeout,
          foregroundCoalesceMs: 150,
        },
      );
      service.setHasActiveClientsProbe(() => hasClients);
      const onDidChange = vi.fn();
      const subscription = service.onDidChange(onDidChange);

      service.invalidateBrowserSnapshot();
      vi.advanceTimersByTime(75);
      projected = projectedForeground({ model: "later-model" });
      hasClients = false;
      service.invalidateBrowserSnapshot();
      hasClients = true;
      vi.advanceTimersByTime(75);

      expect(onDidChange).toHaveBeenCalledTimes(1);
      expect(
        onDidChange.mock.calls[0][0].snapshot.session.foreground,
      ).toMatchObject({
        model: "later-model",
      });

      subscription.dispose();
      service.dispose();
      hub.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips explicit foreground invalidation when no browser client is connected", () => {
    vi.useFakeTimers();
    try {
      const hub = new InMemoryAgentUiEventHub();
      const service = new BrowserGatewayService(
        hub,
        makeSessionManagerStub() as never,
        () => themeSnapshotStub,
        () => "prompt",
        () => true,
        () => "high",
        () => projectedForeground() as never,
        () => [],
        undefined,
        undefined,
        {
          ...disabledPollTimers,
          setTimeout,
          clearTimeout,
          foregroundCoalesceMs: 150,
        },
      );
      const onDidChange = vi.fn();
      const subscription = service.onDidChange(onDidChange);

      service.setHasActiveClientsProbe(() => false);
      service.invalidateBrowserSnapshot();
      vi.advanceTimersByTime(150);
      expect(onDidChange).not.toHaveBeenCalled();

      subscription.dispose();
      service.dispose();
      hub.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips the poll snapshot build when no browser client is connected", () => {
    vi.useFakeTimers();
    try {
      const hub = new InMemoryAgentUiEventHub();
      const service = makePollService(hub);
      const onDidChange = vi.fn();
      const subscription = service.onDidChange(onDidChange);

      // No clients connected → poll ticks should not emit.
      service.setHasActiveClientsProbe(() => false);
      vi.advanceTimersByTime(450);
      expect(onDidChange).not.toHaveBeenCalled();

      // Client connects → next poll tick emits the (changed) snapshot.
      service.setHasActiveClientsProbe(() => true);
      vi.advanceTimersByTime(150);
      expect(onDidChange).toHaveBeenCalledTimes(1);

      subscription.dispose();
      service.dispose();
      hub.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
