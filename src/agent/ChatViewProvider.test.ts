import { beforeEach, describe, expect, it, vi } from "vitest";

type Listener<T> = (value: T) => void;

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

const mockPostMessage = vi.fn();
const mockOutputChannel = {
  appendLine: vi.fn(),
  info: vi.fn(),
  dispose: vi.fn(),
};

vi.mock("../extension.js", () => ({
  DIFF_VIEW_URI_SCHEME: "agentlink-diff",
}));

const mockGetConfiguration = vi.fn(() => ({
  get: vi.fn((key: string, fallback?: unknown) => {
    if (key === "modelCondenseThresholds") {
      return { "claude-sonnet-4-6": 0.8 };
    }
    return fallback;
  }),
  inspect: vi.fn(() => undefined),
  update: vi.fn(),
}));

vi.mock("vscode", () => ({
  EventEmitter: MockEventEmitter,
  window: {
    createOutputChannel: vi.fn(() => mockOutputChannel),
    showInformationMessage: vi.fn(),
    showWarningMessage: vi.fn(),
    showErrorMessage: vi.fn(),
    activeTextEditor: undefined,
  },
  env: {
    sessionId: "test-session",
    machineId: "test-machine",
    appName: "VS Code Test",
    appHost: "desktop",
    language: "en",
    uiKind: 1,
    remoteName: undefined,
  },
  UIKind: { Desktop: 1, Web: 2 },
  workspace: {
    getConfiguration: mockGetConfiguration,
    workspaceFolders: [],
    onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
    createFileSystemWatcher: vi.fn(() => ({
      onDidChange: vi.fn(),
      onDidCreate: vi.fn(),
      onDidDelete: vi.fn(),
      dispose: vi.fn(),
    })),
  },
  Uri: {
    joinPath: vi.fn(() => ({ fsPath: "/tmp/dist" })),
    file: vi.fn((fsPath: string) => ({ fsPath })),
  },
  ViewColumn: { Beside: 2 },
}));

describe("persisted session mutation failure messages", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("formats actionable conflict and recovery messages", async () => {
    const { formatPersistedSessionMutationFailureMessage } =
      await import("./ChatViewProvider.js");

    expect(
      formatPersistedSessionMutationFailureMessage({
        ok: false,
        operation: "rename",
        reason: "conflict",
        currentRevision: "2",
      }),
    ).toContain("changed on disk");
    expect(
      formatPersistedSessionMutationFailureMessage({
        ok: false,
        operation: "delete",
        reason: "not_owner",
      }),
    ).toContain("another AgentLink runtime owns it");
    expect(
      formatPersistedSessionMutationFailureMessage({
        ok: false,
        operation: "rename",
        reason: "not_found",
      }),
    ).toContain("no longer available");
    expect(
      formatPersistedSessionMutationFailureMessage({
        ok: false,
        operation: "delete",
        reason: "corrupt",
        message: "bad metadata",
      }),
    ).toContain("bad metadata");
    expect(
      formatPersistedSessionMutationFailureMessage({
        ok: false,
        operation: "rename",
        reason: "io_error",
        message: "disk full",
      }),
    ).toContain("disk full");
  });
});

describe("checkpoint revert failure messages", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("formats actionable conflict and recovery messages", async () => {
    const { formatCheckpointRevertFailureMessage } =
      await import("./ChatViewProvider.js");

    expect(
      formatCheckpointRevertFailureMessage({
        ok: false,
        reason: "session_conflict",
        currentRevision: "2",
      }),
    ).toContain("session changed after the preview");
    expect(
      formatCheckpointRevertFailureMessage({
        ok: false,
        reason: "checkpoint_stale",
      }),
    ).toContain("checkpoint no longer matches");
    expect(
      formatCheckpointRevertFailureMessage({
        ok: false,
        reason: "workspace_revert_failed",
      }),
    ).toContain("transcript was not changed");
    expect(
      formatCheckpointRevertFailureMessage({
        ok: false,
        reason: "persistence_failed",
      }),
    ).toContain("recorded recovery metadata");
    expect(
      formatCheckpointRevertFailureMessage({ ok: false, reason: "not_found" }),
    ).toContain("no longer available");
  });

  it("formats a user-visible revert recovery notice", async () => {
    const { formatRevertRecoveryNotice } =
      await import("./ChatViewProvider.js");

    const notice = formatRevertRecoveryNotice({
      checkpointId: "checkpoint-1",
      sessionRevision: "revision-2",
      workspaceRevision: "abcdef1234567890",
      startedAt: 123,
      reason: "workspace_reverted_session_save_failed",
    });

    expect(notice).toMatchObject({
      checkpointId: "checkpoint-1",
      sessionRevision: "revision-2",
      workspaceRevision: "abcdef1234567890",
      startedAt: 123,
      title: "Checkpoint revert needs transcript recovery",
    });
    expect(notice.message).toContain("could not save the reverted transcript");
    expect(notice.message).toContain("Recovery metadata is recorded");
    expect(notice.message).toContain("abcdef123456");
  });
});

describe("ChatViewProvider session state sync", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockGetConfiguration.mockClear();
  });

  it("uses async detect result for projected detected question in browser state", async () => {
    const { ChatViewProvider } = await import("./ChatViewProvider.js");

    const provider = new ChatViewProvider(
      { fsPath: "/tmp/ext" } as never,
      { get: vi.fn(), update: vi.fn() } as never,
    );

    const foreground = {
      id: "session-1",
      mode: "code",
      model: "claude-sonnet-4-6",
      status: "idle",
      title: "Session 1",
      estimatedTotalUsed: 0,
      lastInputTokens: 0,
      lastOutputTokens: 0,
      getAllMessages: () =>
        [
          {
            role: "assistant",
            content: [{ type: "text", text: "Choose A or B." }],
          },
        ] as unknown[],
    };

    const manager = {
      getForegroundSession: vi.fn(() => foreground),
      getConfig: vi.fn(() => ({
        model: "claude-sonnet-4-6",
        autoCondenseThreshold: 0.8,
      })),
      getSessionInfos: vi.fn(() => []),
      getBgSessionInfos: vi.fn(() => []),
      onEvent: undefined,
      onSessionsChanged: undefined,
    };

    provider.setSessionManager(manager as never);

    const projectExtensionMessage = (msg: Record<string, unknown>) => {
      (
        provider as unknown as {
          projectExtensionMessage: (msg: Record<string, unknown>) => void;
        }
      ).projectExtensionMessage.call(provider, msg);
    };

    projectExtensionMessage({
      type: "agentSessionLoaded",
      sessionId: "session-1",
      title: "Session 1",
      mode: "code",
      model: "claude-sonnet-4-6",
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "Choose A or B." }],
        },
      ],
      lastInputTokens: 0,
      lastOutputTokens: 0,
      userTurnOffset: 0,
      hasMoreBefore: false,
    });

    const projectedDetectRequest = (
      provider as unknown as {
        projectedDetectRequest: {
          requestId: string;
          messageId: string;
          assistantText: string;
        } | null;
      }
    ).projectedDetectRequest;

    expect(projectedDetectRequest).not.toBeNull();

    projectExtensionMessage({
      type: "agentDetectQuestionResult",
      requestId: projectedDetectRequest!.requestId,
      messageId: projectedDetectRequest!.messageId,
      detected: {
        kind: "single_choice",
        prompt: "Use strict mode or permissive mode?",
        options: [
          { label: "Strict", payload: "Use strict mode" },
          { label: "Permissive", payload: "Use permissive mode" },
        ],
      },
      fallback: false,
    });

    const projected = provider.getBrowserProjectedForegroundState();
    expect(projected?.detectedQuestion?.prompt).toBe(
      "Use strict mode or permissive mode?",
    );
    expect(projected?.detectedQuestion?.kind).toBe("single_choice");
  });

  it("does not request projected detected question for final messages with Continue", async () => {
    const { ChatViewProvider } = await import("./ChatViewProvider.js");

    const provider = new ChatViewProvider(
      { fsPath: "/tmp/ext" } as never,
      { get: vi.fn(), update: vi.fn() } as never,
    );

    const projectExtensionMessage = (msg: Record<string, unknown>) => {
      (
        provider as unknown as {
          projectExtensionMessage: (msg: Record<string, unknown>) => void;
        }
      ).projectExtensionMessage.call(provider, msg);
    };

    projectExtensionMessage({
      type: "agentSessionLoaded",
      sessionId: "session-1",
      title: "Session 1",
      mode: "code",
      model: "claude-sonnet-4-6",
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "Should I continue?" }],
          uiHint: {
            finalMarker: {
              status: "completed",
              source: "tool",
              summary: "Ready for the next step.",
            },
          },
        },
      ],
      lastInputTokens: 0,
      lastOutputTokens: 0,
      userTurnOffset: 0,
      hasMoreBefore: false,
    });

    const projectedDetectRequest = (
      provider as unknown as {
        projectedDetectRequest: {
          requestId: string;
          messageId: string;
          assistantText: string;
        } | null;
      }
    ).projectedDetectRequest;

    expect(projectedDetectRequest).toBeNull();
    expect(
      provider.getBrowserProjectedForegroundState()?.detectedQuestion,
    ).toBeUndefined();
  });

  it("projects revert recovery notice into browser foreground state", async () => {
    const { ChatViewProvider } = await import("./ChatViewProvider.js");

    const provider = new ChatViewProvider(
      { fsPath: "/tmp/ext" } as never,
      { get: vi.fn(), update: vi.fn() } as never,
    );

    const foreground = {
      id: "session-1",
      mode: "code",
      model: "claude-sonnet-4-6",
      status: "idle",
      title: "Session 1",
      estimatedTotalUsed: 0,
      lastInputTokens: 0,
      lastOutputTokens: 0,
      getAllMessages: () => [] as unknown[],
    };

    const manager = {
      getForegroundSession: vi.fn(() => foreground),
      getRevertRecoveryState: vi.fn(() => ({
        checkpointId: "checkpoint-1",
        sessionRevision: "revision-2",
        workspaceRevision: "abcdef1234567890",
        startedAt: 123,
        reason: "workspace_reverted_session_save_failed",
      })),
      getConfig: vi.fn(() => ({
        model: "claude-sonnet-4-6",
        autoCondenseThreshold: 0.8,
      })),
      getSessionInfos: vi.fn(() => []),
      getBgSessionInfos: vi.fn(() => []),
      onEvent: undefined,
      onSessionsChanged: undefined,
    };

    provider.setSessionManager(manager as never);

    (
      provider as unknown as {
        projectExtensionMessage: (msg: Record<string, unknown>) => void;
      }
    ).projectExtensionMessage.call(provider, {
      type: "stateUpdate",
      state: {
        sessionId: foreground.id,
        mode: foreground.mode,
        model: foreground.model,
        streaming: false,
        revertRecoveryNotice: {
          checkpointId: "checkpoint-1",
          sessionRevision: "revision-2",
          workspaceRevision: "abcdef1234567890",
          startedAt: 123,
          title: "Checkpoint revert needs transcript recovery",
          message: "Recovery metadata is recorded.",
        },
      },
    });

    const projected = provider.getBrowserProjectedForegroundState();
    expect(projected?.revertRecoveryNotice).toMatchObject({
      checkpointId: "checkpoint-1",
      title: "Checkpoint revert needs transcript recovery",
    });
  });

  it("preserves revert recovery notice across partial state updates", async () => {
    const { ChatViewProvider } = await import("./ChatViewProvider.js");

    const provider = new ChatViewProvider(
      { fsPath: "/tmp/ext" } as never,
      { get: vi.fn(), update: vi.fn() } as never,
    );

    const foreground = {
      id: "session-1",
      mode: "code",
      model: "claude-sonnet-4-6",
      status: "streaming",
      title: "Session 1",
      estimatedTotalUsed: 0,
      lastInputTokens: 0,
      lastOutputTokens: 0,
      getAllMessages: () => [] as unknown[],
    };

    const manager = {
      getForegroundSession: vi.fn(() => foreground),
      getConfig: vi.fn(() => ({
        model: "claude-sonnet-4-6",
        autoCondenseThreshold: 0.8,
      })),
      getSessionInfos: vi.fn(() => []),
      getBgSessionInfos: vi.fn(() => []),
      onEvent: undefined,
      onSessionsChanged: undefined,
    };

    provider.setSessionManager(manager as never);

    const projectExtensionMessage = (msg: Record<string, unknown>) => {
      (
        provider as unknown as {
          projectExtensionMessage: (msg: Record<string, unknown>) => void;
        }
      ).projectExtensionMessage.call(provider, msg);
    };

    projectExtensionMessage({
      type: "stateUpdate",
      state: {
        sessionId: foreground.id,
        mode: foreground.mode,
        model: foreground.model,
        streaming: false,
        revertRecoveryNotice: {
          checkpointId: "checkpoint-1",
          sessionRevision: "revision-2",
          startedAt: 123,
          title: "Checkpoint revert needs transcript recovery",
          message: "Recovery metadata is recorded.",
        },
      },
    });

    projectExtensionMessage({
      type: "stateUpdate",
      state: {
        sessionId: foreground.id,
        mode: foreground.mode,
        model: foreground.model,
        streaming: true,
      },
    });

    expect(
      provider.getBrowserProjectedForegroundState()?.revertRecoveryNotice,
    ).toMatchObject({
      checkpointId: "checkpoint-1",
      title: "Checkpoint revert needs transcript recovery",
    });

    projectExtensionMessage({
      type: "stateUpdate",
      state: {
        sessionId: foreground.id,
        mode: foreground.mode,
        model: foreground.model,
        streaming: false,
        revertRecoveryNotice: null,
      },
    });

    expect(
      provider.getBrowserProjectedForegroundState()?.revertRecoveryNotice,
    ).toBeNull();
  });

  it("uses heuristic fallback for projected detected question when async detection falls back", async () => {
    const { ChatViewProvider } = await import("./ChatViewProvider.js");

    const provider = new ChatViewProvider(
      { fsPath: "/tmp/ext" } as never,
      { get: vi.fn(), update: vi.fn() } as never,
    );

    const foreground = {
      id: "session-1",
      mode: "code",
      model: "claude-sonnet-4-6",
      status: "idle",
      title: "Session 1",
      estimatedTotalUsed: 0,
      lastInputTokens: 0,
      lastOutputTokens: 0,
      getAllMessages: () =>
        [
          {
            role: "assistant",
            content: [{ type: "text", text: "Should I proceed?" }],
          },
        ] as unknown[],
    };

    const manager = {
      getForegroundSession: vi.fn(() => foreground),
      getConfig: vi.fn(() => ({
        model: "claude-sonnet-4-6",
        autoCondenseThreshold: 0.8,
      })),
      getSessionInfos: vi.fn(() => []),
      getBgSessionInfos: vi.fn(() => []),
      onEvent: undefined,
      onSessionsChanged: undefined,
    };

    provider.setSessionManager(manager as never);

    const projectExtensionMessage = (msg: Record<string, unknown>) => {
      (
        provider as unknown as {
          projectExtensionMessage: (msg: Record<string, unknown>) => void;
        }
      ).projectExtensionMessage.call(provider, msg);
    };

    projectExtensionMessage({
      type: "agentSessionLoaded",
      sessionId: "session-1",
      title: "Session 1",
      mode: "code",
      model: "claude-sonnet-4-6",
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "Should I proceed?" }],
        },
      ],
      lastInputTokens: 0,
      lastOutputTokens: 0,
      userTurnOffset: 0,
      hasMoreBefore: false,
    });

    const projectedDetectRequest = (
      provider as unknown as {
        projectedDetectRequest: {
          requestId: string;
          messageId: string;
          assistantText: string;
        } | null;
      }
    ).projectedDetectRequest;

    expect(projectedDetectRequest).not.toBeNull();

    projectExtensionMessage({
      type: "agentDetectQuestionResult",
      requestId: projectedDetectRequest!.requestId,
      messageId: projectedDetectRequest!.messageId,
      detected: null,
      fallback: true,
    });

    const projected = provider.getBrowserProjectedForegroundState();
    expect(projected?.detectedQuestion?.kind).toBe("yes_no");
    expect(projected?.detectedQuestion?.prompt).toContain("Should I proceed");
  });

  it("clears the projected transcript when creating a new browser session", async () => {
    const { ChatViewProvider } = await import("./ChatViewProvider.js");

    const provider = new ChatViewProvider(
      { fsPath: "/tmp/ext" } as never,
      { get: vi.fn(), update: vi.fn() } as never,
    );

    const fakeView = {
      webview: {
        postMessage: mockPostMessage,
      },
    };
    (provider as unknown as { view: unknown }).view = fakeView;
    (provider as unknown as { webviewReady: boolean }).webviewReady = true;

    const oldSession = {
      id: "session-old",
      title: "Old Session",
      mode: "code",
      model: "claude-sonnet-4-6",
      status: "idle",
      lastInputTokens: 0,
      lastOutputTokens: 0,
      getAllMessages: () =>
        [
          {
            role: "user",
            content: "old text",
          },
        ] as unknown[],
    };
    const newSession = {
      id: "session-new",
      title: "New Session",
      mode: "code",
      model: "claude-sonnet-4-6",
      status: "idle",
      lastInputTokens: 0,
      lastOutputTokens: 0,
      getAllMessages: () => [] as unknown[],
    };

    let foregroundSession = oldSession;
    const manager = {
      getForegroundSession: vi.fn(() => foregroundSession),
      getConfig: vi.fn(() => ({
        model: "claude-sonnet-4-6",
        autoCondenseThreshold: 0.8,
      })),
      getSessionInfos: vi.fn(() => []),
      getBgSessionInfos: vi.fn(() => []),
      createSession: vi.fn(async () => {
        foregroundSession = newSession;
        return newSession;
      }),
      onEvent: undefined,
      onSessionsChanged: undefined,
    };

    provider.setSessionManager(manager as never);

    (
      provider as unknown as {
        projectExtensionMessage: (msg: Record<string, unknown>) => void;
      }
    ).projectExtensionMessage.call(provider, {
      type: "agentSessionLoaded",
      sessionId: oldSession.id,
      title: oldSession.title,
      mode: oldSession.mode,
      model: oldSession.model,
      messages: oldSession.getAllMessages(),
      lastInputTokens: 0,
      lastOutputTokens: 0,
      userTurnOffset: 0,
      hasMoreBefore: false,
    });
    expect(
      provider.getBrowserProjectedForegroundState()?.projectedMessages,
    ).toHaveLength(1);

    const result = await provider.submitBrowserNewSession("code");

    expect(result.ok).toBe(true);
    expect(manager.createSession).toHaveBeenCalledWith("code");
    expect(provider.getBrowserProjectedForegroundState()?.sessionId).toBe(
      "session-new",
    );
    expect(
      provider.getBrowserProjectedForegroundState()?.projectedMessages,
    ).toEqual([]);
    expect(
      mockPostMessage.mock.calls.some(
        ([message]) =>
          message.type === "agentSessionLoaded" &&
          message.sessionId === "session-new" &&
          Array.isArray(message.messages) &&
          message.messages.length === 0,
      ),
    ).toBe(true);
  });

  it("replays queued webview messages after postMessage delivery fails", async () => {
    const { ChatViewProvider } = await import("./ChatViewProvider.js");

    const provider = new ChatViewProvider(
      { fsPath: "/tmp/ext" } as never,
      { get: vi.fn(), update: vi.fn() } as never,
    );

    const foreground = {
      id: "session-1",
      mode: "code",
      model: "claude-sonnet-4-6",
      status: "streaming",
      title: "Session 1",
      estimatedTotalUsed: 0,
      lastInputTokens: 0,
      lastOutputTokens: 0,
      getAllMessages: () => [] as unknown[],
    };
    const manager = {
      getForegroundSession: vi.fn(() => foreground),
      getConfig: vi.fn(() => ({
        model: "claude-sonnet-4-6",
        autoCondenseThreshold: 0.8,
      })),
      getSessionInfos: vi.fn(() => []),
      getBgSessionInfos: vi.fn(() => []),
      onEvent: undefined,
      onSessionsChanged: undefined,
    };
    provider.setSessionManager(manager as never);

    mockPostMessage.mockResolvedValueOnce(false).mockResolvedValue(true);

    (provider as unknown as { view: unknown }).view = {
      webview: { postMessage: mockPostMessage },
    };
    (provider as unknown as { webviewReady: boolean }).webviewReady = true;

    (
      provider as unknown as {
        postMessage: (msg: Record<string, unknown>) => void;
      }
    ).postMessage.call(provider, {
      type: "agentTextDelta",
      sessionId: "session-1",
      text: "missed text",
    });

    await Promise.resolve();

    expect(
      (provider as unknown as { webviewReady: boolean }).webviewReady,
    ).toBe(false);
    expect(
      (provider as unknown as { pendingMessages: unknown[] }).pendingMessages,
    ).toHaveLength(1);

    (provider as unknown as { webviewReady: boolean }).webviewReady = true;
    (
      provider as unknown as { flushPendingWebviewMessages: () => void }
    ).flushPendingWebviewMessages.call(provider);

    await Promise.resolve();

    expect(mockPostMessage).toHaveBeenCalledTimes(2);
    expect(mockPostMessage.mock.calls[1]?.[0]).toEqual({
      type: "agentTextDelta",
      sessionId: "session-1",
      text: "missed text",
    });
    expect(
      (provider as unknown as { pendingMessages: unknown[] }).pendingMessages,
    ).toHaveLength(0);
  });

  it("preserves send order when multiple webview messages fail asynchronously", async () => {
    const { ChatViewProvider } = await import("./ChatViewProvider.js");

    const provider = new ChatViewProvider(
      { fsPath: "/tmp/ext" } as never,
      { get: vi.fn(), update: vi.fn() } as never,
    );

    const foreground = {
      id: "session-1",
      mode: "code",
      model: "claude-sonnet-4-6",
      status: "streaming",
      title: "Session 1",
      estimatedTotalUsed: 0,
      lastInputTokens: 0,
      lastOutputTokens: 0,
      getAllMessages: () => [] as unknown[],
    };
    const manager = {
      getForegroundSession: vi.fn(() => foreground),
      getConfig: vi.fn(() => ({
        model: "claude-sonnet-4-6",
        autoCondenseThreshold: 0.8,
      })),
      getSessionInfos: vi.fn(() => []),
      getBgSessionInfos: vi.fn(() => []),
      onEvent: undefined,
      onSessionsChanged: undefined,
    };
    provider.setSessionManager(manager as never);

    mockPostMessage.mockResolvedValue(false);

    (provider as unknown as { view: unknown }).view = {
      webview: { postMessage: mockPostMessage },
    };
    (provider as unknown as { webviewReady: boolean }).webviewReady = true;

    const postMessage = (
      provider as unknown as {
        postMessage: (msg: Record<string, unknown>) => void;
      }
    ).postMessage;

    postMessage.call(provider, {
      type: "agentTextDelta",
      sessionId: "session-1",
      text: "first",
    });
    postMessage.call(provider, {
      type: "agentTextDelta",
      sessionId: "session-1",
      text: "second",
    });
    postMessage.call(provider, {
      type: "agentTextDelta",
      sessionId: "session-1",
      text: "third",
    });

    await Promise.resolve();

    expect(
      (
        provider as unknown as { pendingMessages: Array<{ text?: string }> }
      ).pendingMessages.map((msg) => msg.text),
    ).toEqual(["first", "second", "third"]);
  });

  it("hydrates the foreground transcript when the VS Code webview reconnects", async () => {
    const { ChatViewProvider } = await import("./ChatViewProvider.js");

    const provider = new ChatViewProvider(
      { fsPath: "/tmp/ext" } as never,
      { get: vi.fn(), update: vi.fn() } as never,
    );

    const foreground = {
      id: "session-1",
      mode: "code",
      model: "claude-sonnet-4-6",
      status: "idle",
      title: "Session 1",
      estimatedTotalUsed: 0,
      lastInputTokens: 12,
      lastOutputTokens: 0,
      getAllMessages: () =>
        [
          { role: "user", content: "prompt" },
          {
            role: "assistant",
            content: [{ type: "text", text: "missed response" }],
          },
        ] as unknown[],
    };
    const manager = {
      getForegroundSession: vi.fn(() => foreground),
      getConfig: vi.fn(() => ({
        model: "claude-sonnet-4-6",
        autoCondenseThreshold: 0.8,
      })),
      getSessionInfos: vi.fn(() => []),
      getBgSessionInfos: vi.fn(() => []),
      listPersistedSessions: vi.fn(() => []),
      getRecentBgRoutingSummaries: vi.fn(() => []),
      onEvent: undefined,
      onSessionsChanged: undefined,
    };
    provider.setSessionManager(manager as never);

    const receiveListeners: Array<(msg: Record<string, unknown>) => void> = [];
    (provider as unknown as { view: unknown }).view = {
      webview: {
        postMessage: mockPostMessage.mockResolvedValue(true),
        options: {},
        asWebviewUri: vi.fn((uri: unknown) => uri),
        onDidReceiveMessage: (
          listener: (msg: Record<string, unknown>) => void,
        ) => {
          receiveListeners.push(listener);
          return { dispose: vi.fn() };
        },
        html: "",
      },
      onDidDispose: vi.fn(),
      onDidChangeVisibility: vi.fn(),
    };

    provider.resolveWebviewView(
      (provider as unknown as { view: unknown }).view as never,
    );
    receiveListeners[0]?.({ command: "webviewReady" });
    await Promise.resolve();

    expect(
      mockPostMessage.mock.calls.some(
        ([message]) =>
          message.type === "agentSessionLoaded" &&
          message.sessionId === "session-1" &&
          Array.isArray(message.messages) &&
          message.messages.some(
            (msg: { role?: string; content?: unknown }) =>
              msg.role === "assistant" &&
              Array.isArray(msg.content) &&
              msg.content.some(
                (block: { type?: string; text?: string }) =>
                  block.type === "text" && block.text === "missed response",
              ),
          ),
      ),
    ).toBe(true);
  });

  it("pushes a fresh stateUpdate when sessions change", async () => {
    const { ChatViewProvider } = await import("./ChatViewProvider.js");

    const provider = new ChatViewProvider(
      { fsPath: "/tmp/ext" } as never,
      { get: vi.fn(), update: vi.fn() } as never,
    );

    const fakeView = {
      webview: {
        postMessage: mockPostMessage,
      },
    };

    (provider as unknown as { view: unknown }).view = fakeView;
    (provider as unknown as { webviewReady: boolean }).webviewReady = true;

    const foreground = {
      id: "session-1",
      mode: "code",
      model: "claude-sonnet-4-6",
      status: "tool_executing",
      reasoningEffort: "none",
    };

    const manager: {
      getForegroundSession: () => typeof foreground;
      getConfig: () => { model: string; autoCondenseThreshold: number };
      getSessionInfos: () => Array<{
        id: string;
        status: string;
        title: string;
        mode: string;
        model: string;
        lastActiveAt: number;
      }>;
      getBgSessionInfos: () => unknown[];
      onEvent?: unknown;
      onSessionsChanged?: () => void;
    } = {
      getForegroundSession: vi.fn(() => foreground),
      getConfig: vi.fn(() => ({
        model: "claude-sonnet-4-6",
        autoCondenseThreshold: 0.8,
      })),
      getSessionInfos: vi.fn(() => [
        {
          id: "session-1",
          status: "tool_executing",
          title: "Test",
          mode: "code",
          model: "claude-sonnet-4-6",
          lastActiveAt: Date.now(),
        },
      ]),
      getBgSessionInfos: vi.fn(() => []),
      onEvent: undefined,
      onSessionsChanged: undefined,
    };

    provider.setSessionManager(manager as never);
    manager.onSessionsChanged?.();

    expect(mockPostMessage).toHaveBeenCalledTimes(3);

    expect(mockPostMessage.mock.calls[0]?.[0]).toEqual({
      type: "stateUpdate",
      state: {
        sessionId: "session-1",
        mode: "code",
        model: "claude-sonnet-4-6",
        streaming: true,
        condenseThreshold: 0.8,
        contextBudget: undefined,
        reasoningEffort: "none",
        thinkingEnabled: false,
        agentWriteApproval: undefined,
        revertRecoveryNotice: null,
      },
    });

    expect(mockPostMessage.mock.calls[1]?.[0]).toEqual({
      type: "agentSessionUpdate",
      sessions: [
        expect.objectContaining({
          id: "session-1",
          status: "tool_executing",
          title: "Test",
          mode: "code",
          model: "claude-sonnet-4-6",
        }),
      ],
    });

    expect(mockPostMessage.mock.calls[2]?.[0]).toEqual({
      type: "agentBgSessionsUpdate",
      sessions: [],
    });
  });

  it("maps inline rename approvals to rename card payload", async () => {
    const { ChatViewProvider } = await import("./ChatViewProvider.js");

    const provider = new ChatViewProvider(
      { fsPath: "/tmp/ext" } as never,
      { get: vi.fn(), update: vi.fn() } as never,
    );

    const buildApprovalRequest = (
      provider as unknown as {
        buildApprovalRequest: (
          id: string,
          request: {
            kind: string;
            title: string;
            detail?: string;
            choices: Array<{
              label: string;
              value: string;
              isPrimary?: boolean;
              isDanger?: boolean;
            }>;
          },
        ) => {
          kind: string;
          id: string;
          oldName?: string;
          newName?: string;
          affectedFiles?: Array<{ path: string; changes: number }>;
          totalChanges?: number;
        };
      }
    ).buildApprovalRequest;

    const mapped = buildApprovalRequest("approval-1", {
      kind: "rename",
      title: "Rename `OldSymbol` → `NewSymbol`?",
      detail:
        "3 changes across 2 files:\nsrc/a.ts (2 changes)\nsrc/b.ts (1 change)",
      choices: [
        { label: "Accept", value: "accept", isPrimary: true },
        { label: "Reject", value: "reject", isDanger: true },
      ],
    });

    expect(mapped).toEqual({
      kind: "rename",
      id: "approval-1",
      oldName: "OldSymbol",
      newName: "NewSymbol",
      affectedFiles: [
        { path: "src/a.ts", changes: 2 },
        { path: "src/b.ts", changes: 1 },
      ],
      totalChanges: 3,
    });

    const mappedAsciiArrow = buildApprovalRequest("approval-2", {
      kind: "rename",
      title: "Rename `fromName` -> `toName`?",
      detail: "1 match across 1 file:\n src/file.ts (1 match)",
      choices: [
        { label: "Accept", value: "accept", isPrimary: true },
        { label: "Reject", value: "reject", isDanger: true },
      ],
    });

    expect(mappedAsciiArrow).toEqual({
      kind: "rename",
      id: "approval-2",
      oldName: "fromName",
      newName: "toName",
      affectedFiles: [{ path: "src/file.ts", changes: 1 }],
      totalChanges: 1,
    });
  });

  it("publishes approval idle after resolving an inline browser approval decision", async () => {
    const { ChatViewProvider } = await import("./ChatViewProvider.js");

    const provider = new ChatViewProvider(
      { fsPath: "/tmp/ext" } as never,
      { get: vi.fn(), update: vi.fn() } as never,
    );

    const uiPublisher = (
      provider as unknown as {
        uiPublisher: {
          publishApprovalIdle: () => void;
        };
      }
    ).uiPublisher;
    const publishApprovalIdleSpy = vi.spyOn(uiPublisher, "publishApprovalIdle");

    const approvalPromise = provider.requestApproval({
      id: "approval-inline",
      kind: "write",
      title: "Modify `src/file.ts`?",
      choices: [
        { label: "Accept", value: "accept", isPrimary: true },
        { label: "Reject", value: "reject", isDanger: true },
      ],
    });

    const ok = provider.submitBrowserApprovalDecision({
      id: "approval-inline",
      decision: "accept",
    });

    await expect(approvalPromise).resolves.toMatchObject({
      decision: "accept",
    });
    expect(ok).toBe(true);
    expect(publishApprovalIdleSpy).toHaveBeenCalledOnce();
  });

  it("restores an older forwarded approval after resolving an overlapping newer inline approval", async () => {
    const { ChatViewProvider } = await import("./ChatViewProvider.js");

    const provider = new ChatViewProvider(
      { fsPath: "/tmp/ext" } as never,
      { get: vi.fn(), update: vi.fn() } as never,
    );

    const uiPublisher = (
      provider as unknown as {
        uiPublisher: {
          publishApproval: (request: unknown) => void;
          publishApprovalIdle: () => void;
        };
      }
    ).uiPublisher;
    const publishApprovalSpy = vi.spyOn(uiPublisher, "publishApproval");
    const publishApprovalIdleSpy = vi.spyOn(uiPublisher, "publishApprovalIdle");

    const forwardedRespond = vi.fn();
    provider.forwardApproval(
      {
        kind: "command",
        id: "background-command",
        command: "npm test",
        subCommands: [],
      },
      forwardedRespond,
    );

    const foregroundPromise = provider.requestApproval({
      id: "foreground-write",
      kind: "write",
      title: "Modify `src/file.ts`?",
      choices: [
        { label: "Accept", value: "accept", isPrimary: true },
        { label: "Reject", value: "reject", isDanger: true },
      ],
    });

    expect(publishApprovalSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "foreground-write" }),
    );

    const ok = provider.submitBrowserApprovalDecision({
      id: "foreground-write",
      decision: "accept",
    });

    await expect(foregroundPromise).resolves.toMatchObject({
      decision: "accept",
    });
    expect(ok).toBe(true);
    expect(forwardedRespond).not.toHaveBeenCalled();
    expect(publishApprovalSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "background-command" }),
    );
    expect(publishApprovalIdleSpy).not.toHaveBeenCalled();
  });

  it("restores an older inline approval after resolving an overlapping newer forwarded approval", async () => {
    const { ChatViewProvider } = await import("./ChatViewProvider.js");

    const provider = new ChatViewProvider(
      { fsPath: "/tmp/ext" } as never,
      { get: vi.fn(), update: vi.fn() } as never,
    );

    const uiPublisher = (
      provider as unknown as {
        uiPublisher: {
          publishApproval: (request: unknown) => void;
          publishApprovalIdle: () => void;
        };
      }
    ).uiPublisher;
    const publishApprovalSpy = vi.spyOn(uiPublisher, "publishApproval");
    const publishApprovalIdleSpy = vi.spyOn(uiPublisher, "publishApprovalIdle");

    const foregroundPromise = provider.requestApproval({
      id: "foreground-write",
      kind: "write",
      title: "Modify `src/file.ts`?",
      choices: [
        { label: "Accept", value: "accept", isPrimary: true },
        { label: "Reject", value: "reject", isDanger: true },
      ],
    });
    const forwardedRespond = vi.fn();
    provider.forwardApproval(
      {
        kind: "command",
        id: "background-command",
        command: "npm test",
        subCommands: [],
      },
      forwardedRespond,
    );

    expect(publishApprovalSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "background-command" }),
    );

    const ok = provider.submitBrowserApprovalDecision({
      id: "background-command",
      decision: "accept",
    });

    expect(ok).toBe(true);
    expect(forwardedRespond).toHaveBeenCalledWith(
      expect.objectContaining({ id: "background-command", decision: "accept" }),
    );
    expect(publishApprovalSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "foreground-write" }),
    );
    expect(publishApprovalIdleSpy).not.toHaveBeenCalled();

    provider.submitBrowserApprovalDecision({
      id: "foreground-write",
      decision: "reject",
    });
    await expect(foregroundPromise).resolves.toMatchObject({
      decision: "reject",
    });
  });

  it("publishes question cleared after resolving a browser question response", async () => {
    const { ChatViewProvider } = await import("./ChatViewProvider.js");

    const provider = new ChatViewProvider(
      { fsPath: "/tmp/ext" } as never,
      { get: vi.fn(), update: vi.fn() } as never,
    );

    const uiPublisher = (
      provider as unknown as {
        uiPublisher: {
          publishQuestionCleared: (id: string) => void;
        };
      }
    ).uiPublisher;
    const publishQuestionClearedSpy = vi.spyOn(
      uiPublisher,
      "publishQuestionCleared",
    );

    const pendingQuestions = (
      provider as unknown as {
        pendingQuestions: Map<string, (raw: unknown) => void>;
      }
    ).pendingQuestions;
    const resolveSpy = vi.fn();
    pendingQuestions.set("question-1", resolveSpy);

    (
      provider as unknown as {
        projectedForegroundState: { questionRequest: unknown };
      }
    ).projectedForegroundState = {
      ...(
        provider as unknown as {
          projectedForegroundState: Record<string, unknown>;
        }
      ).projectedForegroundState,
      questionRequest: {
        id: "question-1",
        context: "Need input.",
        questions: [],
      },
    } as never;

    const ok = provider.submitBrowserQuestionResponse({
      id: "question-1",
      answers: { q1: "Yes" },
      notes: {},
    });

    expect(ok).toBe(true);
    expect(resolveSpy).toHaveBeenCalledWith({
      answers: { q1: "Yes" },
      notes: {},
    });
    expect(publishQuestionClearedSpy).toHaveBeenCalledWith("question-1");
    expect(
      (
        provider as unknown as {
          projectedForegroundState: { questionRequest: unknown };
        }
      ).projectedForegroundState.questionRequest,
    ).toBeNull();
    expect(pendingQuestions.has("question-1")).toBe(false);
  });

  it("publishes question progress through the ui publisher", async () => {
    const { ChatViewProvider } = await import("./ChatViewProvider.js");

    const provider = new ChatViewProvider(
      { fsPath: "/tmp/ext" } as never,
      { get: vi.fn(), update: vi.fn() } as never,
    );

    const uiPublisher = (
      provider as unknown as {
        uiPublisher: {
          publishQuestionProgress: (progress: unknown) => void;
        };
      }
    ).uiPublisher;
    const publishProgressSpy = vi.spyOn(uiPublisher, "publishQuestionProgress");

    const pendingQuestions = (
      provider as unknown as {
        pendingQuestions: Map<string, (raw: unknown) => void>;
      }
    ).pendingQuestions;
    pendingQuestions.set("question-live", vi.fn());

    const ok = provider.publishBrowserQuestionProgress({
      id: "question-live",
      step: 2,
      answers: { q1: "Yes" },
      notes: { q1: "note" },
      origin: "origin-1",
    });

    expect(ok).toBe(true);
    expect(publishProgressSpy).toHaveBeenCalledWith({
      id: "question-live",
      step: 2,
      answers: { q1: "Yes" },
      notes: { q1: "note" },
      origin: "origin-1",
    });

    const missing = provider.publishBrowserQuestionProgress({
      id: "unknown-question",
      step: 0,
      answers: {},
      notes: {},
      origin: "origin-1",
    });
    expect(missing).toBe(false);
  });
});
