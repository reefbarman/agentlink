import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentMessage } from "./types.js";

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
const mockConfigUpdate = vi.fn();
const terminalSettings: Record<string, unknown> = {};

const mockGetConfiguration = vi.fn((section?: string) => ({
  get: vi.fn((key: string, fallback?: unknown) => {
    if (section === "terminal.integrated" && key in terminalSettings) {
      return terminalSettings[key];
    }
    if (key === "modelCondenseThresholds") {
      return { "claude-sonnet-4-6": 0.8 };
    }
    return fallback;
  }),
  inspect: vi.fn(() => undefined),
  update: mockConfigUpdate,
}));

describe("tool terminal reveal messages", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("forwards the running tool call id to the tracker", async () => {
    const { ChatViewProvider } = await import("./ChatViewProvider.js");
    const provider = new ChatViewProvider(
      { fsPath: "/tmp/ext" } as never,
      { get: vi.fn(), update: vi.fn() } as never,
    );
    const revealTerminal = vi.fn();
    (provider as unknown as { sessionManager: unknown }).sessionManager = {};
    provider.setToolCallTracker({ revealTerminal } as never);

    await (
      provider as unknown as {
        handleWebviewMessage(message: Record<string, unknown>): Promise<void>;
      }
    ).handleWebviewMessage({
      command: "revealToolCallTerminal",
      id: "tool-running",
    });

    expect(revealTerminal).toHaveBeenCalledWith("tool-running");
  });
});

vi.mock("vscode", () => ({
  EventEmitter: MockEventEmitter,
  window: {
    createOutputChannel: vi.fn(() => mockOutputChannel),
    showInformationMessage: vi.fn(),
    showWarningMessage: vi.fn(),
    showErrorMessage: vi.fn(),
    activeTextEditor: undefined,
    activeColorTheme: { kind: 2 },
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
  SymbolKind: {
    File: 0,
    Module: 1,
    Namespace: 2,
    Package: 3,
    Class: 4,
    Method: 5,
    Property: 6,
    Field: 7,
    Constructor: 8,
    Enum: 9,
    Interface: 10,
    Function: 11,
    Variable: 12,
    Constant: 13,
    String: 14,
    Number: 15,
    Boolean: 16,
    Array: 17,
    Object: 18,
    Key: 19,
    Null: 20,
    EnumMember: 21,
    Struct: 22,
    Event: 23,
    Operator: 24,
    TypeParameter: 25,
  },
  CompletionItemKind: {
    Text: 0,
    Method: 1,
    Function: 2,
    Constructor: 3,
    Field: 4,
    Variable: 5,
    Class: 6,
    Interface: 7,
    Module: 8,
    Property: 9,
    Unit: 10,
    Value: 11,
    Enum: 12,
    Keyword: 13,
    Snippet: 14,
    Color: 15,
    File: 16,
    Reference: 17,
    Folder: 18,
    EnumMember: 19,
    Constant: 20,
    Struct: 21,
    Event: 22,
    Operator: 23,
    TypeParameter: 24,
  },
  InlayHintKind: {
    Type: 1,
    Parameter: 2,
  },
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
  ViewColumn: { One: 1, Beside: 2 },
  ConfigurationTarget: { Global: 1 },
  ColorThemeKind: {
    Light: 1,
    Dark: 2,
    HighContrast: 3,
    HighContrastLight: 4,
  },
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

describe("reasoning effort message validation", () => {
  it("accepts supported values and rejects malformed agentSend values", async () => {
    const { resolveReasoningEffortMessage } =
      await import("./ChatViewProvider.js");

    expect(resolveReasoningEffortMessage("max", true)).toBe("max");
    expect(resolveReasoningEffortMessage("unsupported", true)).toBeUndefined();
    expect(
      resolveReasoningEffortMessage({ effort: "high" }, true),
    ).toBeUndefined();
    expect(resolveReasoningEffortMessage("unsupported", false)).toBe("none");
  });
});

describe("restored session pagination", () => {
  it("keeps complete turns and loads older history in bounded chunks", async () => {
    const { getPreviousChunkByUserTurns, getTailChunkByUserTurns } =
      await import("./ChatViewProvider.js");
    const messages: AgentMessage[] = Array.from({ length: 20 }, (_, index) => [
      { role: "user" as const, content: `prompt ${index}` },
      {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: `response ${index}` }],
      },
    ]).flat();

    const tail = getTailChunkByUserTurns(messages, 8);
    expect(tail.userTurnOffset).toBe(12);
    expect(tail.chunk[0]).toEqual(
      expect.objectContaining({ role: "user", content: "prompt 12" }),
    );

    const previous = getPreviousChunkByUserTurns(
      messages,
      tail.userTurnOffset,
      5,
    );
    expect(previous.userTurnOffset).toBe(7);
    expect(previous.hasMoreBefore).toBe(true);
    expect(previous.messages[0]).toEqual(
      expect.objectContaining({ role: "user", content: "prompt 7" }),
    );
    expect(previous.messages.at(-1)).toEqual(
      expect.objectContaining({ role: "assistant" }),
    );
  });
});

describe("ChatViewProvider session state sync", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockGetConfiguration.mockClear();
    for (const key of Object.keys(terminalSettings))
      delete terminalSettings[key];
  });

  it("publishes MCP status changes through the existing owner callback", async () => {
    const { ChatViewProvider } = await import("./ChatViewProvider.js");
    const provider = new ChatViewProvider(
      { fsPath: "/tmp/ext" } as never,
      { get: vi.fn(), update: vi.fn() } as never,
    );
    const rebuildSystemPrompts = vi.fn(async () => {});
    provider.setSessionManager({ rebuildSystemPrompts } as never);
    const listener = vi.fn();
    const subscription = provider.onDidChangeBrowserGatewaySurface(listener);
    const handleMcpStatusChange = (
      provider as unknown as {
        handleMcpStatusChange(infos: unknown[]): void;
      }
    ).handleMcpStatusChange.bind(provider);

    handleMcpStatusChange([
      {
        name: "linear",
        status: "connected",
        toolCount: 1,
        resourceCount: 0,
        promptCount: 0,
        tools: [{ name: "list_issues", description: "List issues" }],
      },
    ]);
    await Promise.resolve();

    expect(listener).toHaveBeenCalledWith("mcp");
    expect(rebuildSystemPrompts).toHaveBeenCalledTimes(1);

    subscription.dispose();
    provider.dispose();
  });

  it("publishes semantic browser theme changes and overlays live terminal settings", async () => {
    const { ChatViewProvider } = await import("./ChatViewProvider.js");
    const provider = new ChatViewProvider(
      { fsPath: "/tmp/ext" } as never,
      { get: vi.fn(), update: vi.fn() } as never,
    );
    provider.setSessionManager({
      getForegroundSession: vi.fn(() => ({ id: "foreground-1" })),
    } as never);
    (provider as unknown as { view: unknown; webviewReady: boolean }).view = {};
    (
      provider as unknown as { view: unknown; webviewReady: boolean }
    ).webviewReady = true;
    const listener = vi.fn();
    const subscription = provider.onDidChangeBrowserGatewaySurface(listener);
    const handleWebviewMessage = (
      provider as unknown as {
        handleWebviewMessage(message: Record<string, unknown>): Promise<void>;
      }
    ).handleWebviewMessage.bind(provider);

    await handleWebviewMessage({
      command: "themeSnapshot",
      cssVariables: {
        "--vscode-editor-background": "#111111",
        "--vscode-terminal-fontSize": "11px",
      },
      colorScheme: "dark",
      themeLabel: "Dark",
    });
    expect(listener).toHaveBeenCalledWith("theme");
    listener.mockClear();

    await handleWebviewMessage({
      command: "themeSnapshot",
      cssVariables: {
        "--vscode-editor-background": "#111111",
        "--vscode-terminal-fontSize": "11px",
      },
      colorScheme: "dark",
      themeLabel: "Dark",
    });
    expect(listener).not.toHaveBeenCalled();

    terminalSettings.fontSize = 16;
    expect(provider.getBrowserGatewayThemeSnapshot()).toMatchObject({
      source: "webview-dom",
      cssVariables: {
        "--vscode-editor-background": "#111111",
        "--vscode-terminal-fontSize": "16px",
      },
    });

    subscription.dispose();
    provider.dispose();
  });

  it("keeps nested background results out of the browser foreground transcript", async () => {
    const { ChatViewProvider } = await import("./ChatViewProvider.js");
    const provider = new ChatViewProvider(
      { fsPath: "/tmp/ext" } as never,
      { get: vi.fn(), update: vi.fn() } as never,
    );
    const foreground = {
      id: "foreground-1",
      title: "Foreground",
      mode: "code",
      model: "gpt-5.6-sol",
      status: "idle",
      estimatedTotalUsed: 0,
      lastInputTokens: 0,
      lastOutputTokens: 0,
      getAllMessages: () => [],
    };
    provider.setSessionManager({
      getForegroundSession: vi.fn(() => foreground),
      getConfig: vi.fn(() => ({})),
      getSessionInfos: vi.fn(() => []),
      getBgSessionInfos: vi.fn(() => []),
    } as never);

    const projectExtensionMessage = (
      provider as unknown as {
        projectExtensionMessage: (message: Record<string, unknown>) => void;
      }
    ).projectExtensionMessage.bind(provider);
    projectExtensionMessage({
      type: "stateUpdate",
      state: {
        sessionId: foreground.id,
        mode: foreground.mode,
        model: foreground.model,
        streaming: false,
      },
    });
    projectExtensionMessage({
      type: "agentBgDone",
      sessionId: "nested-child",
      parentSessionId: "background-parent",
      totalInputTokens: 1,
      totalOutputTokens: 1,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
      resultText: "nested result",
    });

    expect(
      provider
        .getBrowserProjectedForegroundState()
        ?.projectedMessages.some((message) =>
          message.blocks.some(
            (block) =>
              block.type === "bg_agent_result" &&
              block.sessionId === "nested-child",
          ),
        ),
    ).toBe(false);
  });

  it("keeps browser reasoning snapshots in sync with the live session", async () => {
    const { ChatViewProvider } = await import("./ChatViewProvider.js");
    const provider = new ChatViewProvider(
      { fsPath: "/tmp/ext" } as never,
      { get: vi.fn(), update: vi.fn() } as never,
    );
    const session = {
      id: "session-1",
      title: "Session 1",
      mode: "code",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      thinkingBudget: 1024,
      lastInputTokens: 0,
      lastOutputTokens: 0,
      estimatedTotalUsed: 0,
      getAllMessages: () => [],
    };
    const setForegroundReasoningEffort = vi.fn((effort: string) => {
      session.reasoningEffort = effort;
      return true;
    });
    provider.setSessionManager({
      getForegroundSession: vi.fn(() => session),
      setForegroundReasoningEffort,
      getConfig: vi.fn(() => ({ thinkingBudget: 1024 })),
      getSessionInfos: vi.fn(() => []),
      getBgSessionInfos: vi.fn(() => []),
    } as never);

    await expect(
      provider.submitBrowserSetReasoningEffort("max"),
    ).resolves.toEqual({
      ok: true,
    });
    expect(setForegroundReasoningEffort).toHaveBeenCalledWith("max");
    expect(session.reasoningEffort).toBe("max");
    expect(provider.getBrowserProjectedForegroundState()?.reasoningEffort).toBe(
      "max",
    );
    expect(mockConfigUpdate).toHaveBeenCalledWith(
      "modeReasoningEffortPreferences",
      { code: "max" },
      1,
    );
  });

  it("rejects non-MCP native tools from the Ask Agent MCP bridge", async () => {
    const { ChatViewProvider } = await import("./ChatViewProvider.js");

    const provider = new ChatViewProvider(
      { fsPath: "/tmp/ext" } as never,
      { get: vi.fn(), update: vi.fn() } as never,
    );
    provider.setApprovalManager({
      isMcpApproved: vi.fn(() => false),
      approveMcpTool: vi.fn(),
      approveMcpServer: vi.fn(),
      onDidChange: vi.fn(() => ({ dispose: vi.fn() })),
    } as never);

    const result = await provider.submitBrowserAskAgentMcpTool({
      name: "execute_command",
      input: { command: "touch /tmp/should-not-run" },
      sessionId: "browser-gateway:ask-agent:default",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("tool_not_available");
    expect(result.tools?.map((tool) => tool.name)).not.toContain(
      "execute_command",
    );
  });

  it("restores a pending ask_user question when loading an awaiting-question session", async () => {
    const { ChatViewProvider } = await import("./ChatViewProvider.js");

    const provider = new ChatViewProvider(
      { fsPath: "/tmp/ext" } as never,
      { get: vi.fn(), update: vi.fn() } as never,
    );
    (provider as unknown as { view: unknown }).view = {
      webview: { postMessage: mockPostMessage },
    };
    (provider as unknown as { webviewReady: boolean }).webviewReady = true;

    const session = {
      id: "session-1",
      mode: "code",
      model: "claude-sonnet-4-6",
      status: "idle",
      title: "Session 1",
      estimatedTotalUsed: 0,
      lastInputTokens: 0,
      lastOutputTokens: 0,
      runState: {
        phase: "awaiting_question",
        startedAt: 123,
        question: {
          schemaVersion: 1,
          questionRequestId: "question-1",
          context: "Pick one.",
          questions: [
            {
              id: "choice",
              type: "multiple_choice",
              question: "Which path?",
              options: ["A", "B"],
              recommended: "A",
            },
          ],
          assistantContent: [],
          toolUseId: "toolu-1",
          toolName: "ask_user",
          toolInput: {},
        },
      },
      getAllMessages: () => [] as unknown[],
    };

    const manager = {
      getForegroundSession: vi.fn(() => session),
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
        postSessionLoaded: (session: unknown) => void;
      }
    ).postSessionLoaded(session);

    expect(
      provider.getBrowserProjectedForegroundState()?.questionRequest,
    ).toMatchObject({
      id: "question-1",
      context: "Pick one.",
    });
    expect(
      mockPostMessage.mock.calls.some(
        ([message]) =>
          message.type === "agentQuestionRequest" &&
          message.id === "question-1",
      ),
    ).toBe(true);
  });

  it("keeps a restored ask_user question visible when recovery rejects the answer", async () => {
    const { ChatViewProvider } = await import("./ChatViewProvider.js");

    const provider = new ChatViewProvider(
      { fsPath: "/tmp/ext" } as never,
      { get: vi.fn(), update: vi.fn() } as never,
    );
    const session = { id: "session-1" };
    const manager = {
      getForegroundSession: vi.fn(() => session),
      getPendingQuestionRecovery: vi.fn(() => ({
        questionRequestId: "question-1",
      })),
      answerRecoveredQuestion: vi.fn(async () => false),
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
        projectedForegroundState: Record<string, unknown>;
      }
    ).projectedForegroundState = {
      sessionId: "session-1",
      mode: "code",
      model: "claude-sonnet-4-6",
      streaming: false,
      thinkingEnabled: true,
      reasoningEffort: "high",
      todos: [],
      questionRequest: {
        id: "question-1",
        context: "Pick one.",
        questions: [],
      },
      detectedQuestion: null,
      dismissedDetectedQuestionIds: [],
      projectedMessages: [],
      messageQueue: [],
      interrupted: null,
    } as never;

    const accepted = await provider.submitBrowserQuestionResponse({
      id: "question-1",
      answers: { choice: "A" },
      notes: {},
    });

    expect(accepted).toBe(false);
    expect(
      (
        provider as unknown as {
          projectedForegroundState: { questionRequest: unknown };
        }
      ).projectedForegroundState.questionRequest,
    ).toMatchObject({
      id: "question-1",
    });
  });

  it("routes answers for restored ask_user questions through recovery", async () => {
    const { ChatViewProvider } = await import("./ChatViewProvider.js");

    const provider = new ChatViewProvider(
      { fsPath: "/tmp/ext" } as never,
      { get: vi.fn(), update: vi.fn() } as never,
    );
    const session = { id: "session-1" };
    const manager = {
      getForegroundSession: vi.fn(() => session),
      getPendingQuestionRecovery: vi.fn(() => ({
        questionRequestId: "question-1",
      })),
      answerRecoveredQuestion: vi.fn(async () => true),
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

    const accepted = await provider.submitBrowserQuestionResponse({
      id: "question-1",
      answers: { choice: "A" },
      notes: { choice: "Looks good" },
    });

    expect(accepted).toBe(true);
    expect(manager.answerRecoveredQuestion).toHaveBeenCalledWith(
      "session-1",
      "question-1",
      {
        answers: { choice: "A" },
        notes: { choice: "Looks good" },
      },
      expect.objectContaining({ switchMode: expect.any(Function) }),
    );
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

  it("queues browser sends during an active turn without registering an interjection", async () => {
    const { ChatViewProvider } = await import("./ChatViewProvider.js");

    const provider = new ChatViewProvider(
      { fsPath: "/tmp/ext" } as never,
      { get: vi.fn(), update: vi.fn() } as never,
    );

    const session = {
      id: "session-1",
      mode: "code",
      model: "claude-sonnet-4-6",
      status: "streaming",
      title: "Session 1",
      reasoningEffort: "high",
      estimatedTotalUsed: 0,
      lastInputTokens: 0,
      lastOutputTokens: 0,
      getAllMessages: () => [] as unknown[],
      setPendingInterjection: vi.fn(),
    };

    const manager = {
      getForegroundSession: vi.fn(() => session),
      getSession: vi.fn(() => session),
      getConfig: vi.fn(() => ({
        model: "claude-sonnet-4-6",
        autoCondenseThreshold: 0.8,
      })),
      getSessionInfos: vi.fn(() => []),
      getBgSessionInfos: vi.fn(() => []),
      sendMessage: vi.fn(),
      onEvent: undefined,
      onSessionsChanged: undefined,
    };

    provider.setSessionManager(manager as never);

    const result = await provider.submitBrowserSend({
      text: "please do this next",
      sessionId: "session-1",
      mode: "code",
    });

    expect(result).toEqual({ ok: true, queued: true });
    expect(session.setPendingInterjection).not.toHaveBeenCalled();
    expect(manager.sendMessage).not.toHaveBeenCalled();
    expect(
      provider.getBrowserProjectedForegroundState()?.messageQueue,
    ).toMatchObject([
      {
        text: "please do this next",
        source: "browser",
      },
    ]);
  });

  it("can register a queued message as a pending interjection", async () => {
    const { ChatViewProvider } = await import("./ChatViewProvider.js");

    const provider = new ChatViewProvider(
      { fsPath: "/tmp/ext" } as never,
      { get: vi.fn(), update: vi.fn() } as never,
    );

    const session = {
      id: "session-1",
      status: "tool_executing",
      setPendingInterjection: vi.fn(() => true),
    };
    const manager = {
      getForegroundSession: vi.fn(() => session),
      getSession: vi.fn(() => session),
    };
    provider.setSessionManager(manager as never);

    const accepted = (
      provider as unknown as {
        interjectQueuedMessageFromUi(input: {
          sessionId: string;
          queueId: string;
          text: string;
          displayText?: string;
          isSlashCommand?: boolean;
          slashCommandLabel?: string;
          attachments: string[];
          images: Array<{ name: string; mimeType: string; base64: string }>;
          documents: Array<{ name: string; mimeType: string; base64: string }>;
        }): boolean;
      }
    ).interjectQueuedMessageFromUi({
      sessionId: "session-1",
      queueId: "queue-1",
      text: "interject this",
      displayText: "Interject this",
      isSlashCommand: false,
      attachments: ["note.md"],
      images: [],
      documents: [],
    });

    expect(accepted).toBe(true);
    expect(session.setPendingInterjection).toHaveBeenCalledWith(
      "interject this",
      "queue-1",
      undefined,
      "Interject this",
      false,
      undefined,
      ["note.md"],
      undefined,
      undefined,
    );
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
      createForegroundSession: vi.fn(async () => {
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
    expect(manager.createForegroundSession).toHaveBeenCalledWith("code");
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

  it("keeps hidden agent warnings out of the webview transcript", async () => {
    const { ChatViewProvider } = await import("./ChatViewProvider.js");

    const provider = new ChatViewProvider(
      { fsPath: "/tmp/ext" } as never,
      { get: vi.fn(), update: vi.fn() } as never,
    );

    (provider as unknown as { view: unknown }).view = {
      webview: { postMessage: mockPostMessage },
    };
    (provider as unknown as { webviewReady: boolean }).webviewReady = true;

    const handleAgentEvent = (
      provider as unknown as {
        handleAgentEvent: (
          sessionId: string,
          event:
            | { type: "warning"; message: string; visible?: boolean }
            | { type: "error"; error: string; retryable: boolean },
        ) => void;
      }
    ).handleAgentEvent;

    handleAgentEvent.call(provider, "session-1", {
      type: "warning",
      message: "Provider returned an empty response — retrying…",
      visible: false,
    });

    expect(
      mockOutputChannel.appendLine.mock.calls.some(([line]) =>
        line.includes(
          "[agent] warning: Provider returned an empty response — retrying…",
        ),
      ),
    ).toBe(true);
    expect(
      mockPostMessage.mock.calls.some(
        ([message]) => message.type === "agentWarning",
      ),
    ).toBe(false);

    handleAgentEvent.call(provider, "session-1", {
      type: "error",
      error:
        "Provider returned empty responses 3 times in a row. Please retry.",
      retryable: true,
    });

    expect(
      mockPostMessage.mock.calls.some(
        ([message]) =>
          message.type === "agentError" &&
          message.error ===
            "Provider returned empty responses 3 times in a row. Please retry.",
      ),
    ).toBe(true);
  });

  it("emits background-only transcript events for background sessions", async () => {
    const { ChatViewProvider } = await import("./ChatViewProvider.js");
    const provider = new ChatViewProvider(
      { fsPath: "/tmp/ext" } as never,
      { get: vi.fn(), update: vi.fn() } as never,
    );

    (provider as unknown as { view: unknown }).view = {
      webview: { postMessage: mockPostMessage },
    };
    (provider as unknown as { webviewReady: boolean }).webviewReady = true;
    (provider as unknown as { sessionManager: unknown }).sessionManager = {
      getSession: () => ({ background: true }),
      getForegroundSession: () => undefined,
    };

    const handleAgentEvent = (
      provider as unknown as {
        handleAgentEvent: (sessionId: string, event: unknown) => void;
      }
    ).handleAgentEvent;
    handleAgentEvent.call(provider, "bg-1", {
      type: "warning",
      message: "Provider stream first event timed out after 90000ms",
    });
    handleAgentEvent.call(provider, "bg-1", {
      type: "todo_update",
      todos: [
        {
          id: "inspect",
          content: "Inspect changes",
          activeForm: "Inspecting changes",
          status: "in_progress",
        },
      ],
    });

    expect(mockPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "agentBgWarning", sessionId: "bg-1" }),
    );
    expect(mockPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "agentBgTodoUpdate",
        sessionId: "bg-1",
      }),
    );
    expect(
      mockPostMessage.mock.calls.some(
        ([message]) =>
          message.type === "agentWarning" || message.type === "agentTodoUpdate",
      ),
    ).toBe(false);
  });

  it("posts the resolved background result on agentBgDone", async () => {
    const { ChatViewProvider } = await import("./ChatViewProvider.js");
    const provider = new ChatViewProvider(
      { fsPath: "/tmp/ext" } as never,
      { get: vi.fn(), update: vi.fn() } as never,
    );

    (provider as unknown as { view: unknown }).view = {
      webview: { postMessage: mockPostMessage },
    };
    (provider as unknown as { webviewReady: boolean }).webviewReady = true;
    const getBackgroundResult = vi.fn(() => ({
      resultText: "full structured report",
      summary: "one-line summary",
    }));
    (provider as unknown as { sessionManager: unknown }).sessionManager = {
      getSession: () => ({ background: true }),
      getForegroundSession: () => undefined,
      getBgSessionInfos: () => [{ id: "bg-1" }],
      getBackgroundParentSessionId: () => "foreground-1",
      getBackgroundResult,
      getBackgroundResultSummary: () => "Reviewed the plan",
      listPersistedSessions: () => [],
    };

    const handleAgentEvent = (
      provider as unknown as {
        handleAgentEvent: (sessionId: string, event: unknown) => void;
      }
    ).handleAgentEvent;
    handleAgentEvent.call(provider, "bg-1", {
      type: "done",
      totalInputTokens: 1,
      totalOutputTokens: 2,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
    });

    expect(getBackgroundResult).toHaveBeenCalledWith("bg-1");
    expect(mockPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "agentBgDone",
        sessionId: "bg-1",
        parentSessionId: "foreground-1",
        resultText: "full structured report",
        resultSummary: "Reviewed the plan",
      }),
    );
  });

  it("fails closed when a background completion has no current parent metadata", async () => {
    const { ChatViewProvider } = await import("./ChatViewProvider.js");
    const provider = new ChatViewProvider(
      { fsPath: "/tmp/ext" } as never,
      { get: vi.fn(), update: vi.fn() } as never,
    );

    (provider as unknown as { view: unknown }).view = {
      webview: { postMessage: mockPostMessage },
    };
    (provider as unknown as { webviewReady: boolean }).webviewReady = true;
    (provider as unknown as { sessionManager: unknown }).sessionManager = {
      getSession: () => ({ background: true }),
      getForegroundSession: () => undefined,
      getBgSessionInfos: () => [],
      getBackgroundParentSessionId: () => undefined,
      getBackgroundResult: () => ({ resultText: "nested result" }),
      getBackgroundResultSummary: () => undefined,
      listPersistedSessions: () => [],
    };

    const handleAgentEvent = (
      provider as unknown as {
        handleAgentEvent: (sessionId: string, event: unknown) => void;
      }
    ).handleAgentEvent;
    handleAgentEvent.call(provider, "bg-unresolved", {
      type: "done",
      totalInputTokens: 1,
      totalOutputTokens: 2,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
    });

    expect(mockPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "agentBgDone",
        sessionId: "bg-unresolved",
        parentSessionId: null,
      }),
    );
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
        interrupted: false,
        condenseThreshold: 0.8,
        contextBudget: undefined,
        reasoningEffort: "none",
        thinkingEnabled: false,
        agentWriteApproval: undefined,
        commandApprovalPolicy: "safe",
        configuredCommandApprovalPolicy: "safe",
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

    const ok = await provider.submitBrowserQuestionResponse({
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

describe("handleModeSwitch resume queueing", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  const session = () => ({
    id: "session-1",
    mode: "architect",
    model: "claude-sonnet-4-6",
    background: false,
    status: "streaming",
    reasoningEffort: "high",
    lastInputTokens: 0,
    lastOutputTokens: 0,
    estimatedTotalUsed: 0,
    getAllMessages: () => [] as unknown[],
  });

  async function makeProvider(manager: Record<string, unknown>) {
    const { ChatViewProvider } = await import("./ChatViewProvider.js");
    const provider = new ChatViewProvider(
      { fsPath: "/tmp/ext" } as never,
      { get: vi.fn(), update: vi.fn() } as never,
    );
    (provider as unknown as { view: unknown }).view = {
      webview: { postMessage: mockPostMessage },
    };
    (provider as unknown as { webviewReady: boolean }).webviewReady = true;
    provider.setSessionManager(manager as never);
    return provider;
  }

  it("queues a mode-switch resume after an in-place silent switch", async () => {
    const fg = session();
    const queueModeSwitchResume = vi.fn();
    const provider = await makeProvider({
      getForegroundSession: vi.fn(() => fg),
      switchSessionMode: vi.fn(async () => fg),
      queueModeSwitchResume,
      getConfig: vi.fn(() => ({
        model: "claude-sonnet-4-6",
        autoCondenseThreshold: 0.8,
      })),
      getSessionInfos: vi.fn(() => []),
      getBgSessionInfos: vi.fn(() => []),
    });

    const result = await provider.handleModeSwitch(
      "code",
      'ask_user: "Looks good"',
      true,
      fg.id,
    );

    expect(result).toMatchObject({ approved: true, mode: "code" });
    expect(queueModeSwitchResume).toHaveBeenCalledWith("session-1", "code", {
      reason: 'ask_user: "Looks good"',
      followUp: undefined,
    });
  });

  it("does not report success when the target session no longer exists", async () => {
    const queueModeSwitchResume = vi.fn();
    const provider = await makeProvider({
      getForegroundSession: vi.fn(() => undefined),
      switchSessionMode: vi.fn(async () => null),
      queueModeSwitchResume,
      getConfig: vi.fn(() => ({
        model: "claude-sonnet-4-6",
        autoCondenseThreshold: 0.8,
      })),
      getSessionInfos: vi.fn(() => []),
      getBgSessionInfos: vi.fn(() => []),
    });

    const result = await provider.handleModeSwitch(
      "code",
      undefined,
      true,
      "stale-session",
    );

    expect(result.approved).toBe(false);
    expect(result.rejectionReason).toContain("session no longer exists");
    expect(queueModeSwitchResume).not.toHaveBeenCalled();
    // The legacy fallback must not fire: it makes the webview create a brand
    // new session mid-run.
    expect(
      mockPostMessage.mock.calls.some(
        ([message]) => message.type === "agentModeSwitchRequest",
      ),
    ).toBe(false);
  });

  it("does not report success when the in-place switch throws", async () => {
    const fg = session();
    const queueModeSwitchResume = vi.fn();
    const provider = await makeProvider({
      getForegroundSession: vi.fn(() => fg),
      switchSessionMode: vi.fn(async () => {
        throw new Error("prompt artifacts unavailable");
      }),
      queueModeSwitchResume,
      getConfig: vi.fn(() => ({
        model: "claude-sonnet-4-6",
        autoCondenseThreshold: 0.8,
      })),
      getSessionInfos: vi.fn(() => []),
      getBgSessionInfos: vi.fn(() => []),
    });

    const result = await provider.handleModeSwitch("code", undefined, true);

    expect(result.approved).toBe(false);
    expect(result.rejectionReason).toContain("prompt artifacts unavailable");
    expect(queueModeSwitchResume).not.toHaveBeenCalled();
    expect(
      mockPostMessage.mock.calls.some(
        ([message]) => message.type === "agentModeSwitchRequest",
      ),
    ).toBe(false);
  });

  it("still falls back to a new session when no session exists at all", async () => {
    const provider = await makeProvider({
      getForegroundSession: vi.fn(() => undefined),
      switchSessionMode: vi.fn(async () => null),
      queueModeSwitchResume: vi.fn(),
      getConfig: vi.fn(() => ({
        model: "claude-sonnet-4-6",
        autoCondenseThreshold: 0.8,
      })),
      getSessionInfos: vi.fn(() => []),
      getBgSessionInfos: vi.fn(() => []),
    });

    const result = await provider.handleModeSwitch("code", undefined, true);

    expect(result.approved).toBe(true);
    expect(
      mockPostMessage.mock.calls.some(
        ([message]) =>
          message.type === "agentModeSwitchRequest" && message.mode === "code",
      ),
    ).toBe(true);
  });
});
