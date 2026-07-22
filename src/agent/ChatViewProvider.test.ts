import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentMessage } from "./types.js";

type Listener<T> = (value: T) => void;

class MockRelativePattern {
  constructor(
    readonly base: string,
    readonly pattern: string,
  ) {}
}

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
const mockFindFiles = vi.fn(async () => [] as Array<{ fsPath: string }>);
const mockOpenTextDocument = vi.fn(async (filePath: string) => ({ filePath }));
const mockShowTextDocument = vi.fn(async () => undefined);
const mockShowErrorMessage = vi.fn();
const mockShowOpenDialog = vi.fn();
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

describe("worktree startup prompt policy", () => {
  it("applies inherited Approve for Me before submitting the startup prompt exactly once", async () => {
    vi.useFakeTimers();
    const { ChatViewProvider } = await import("./ChatViewProvider.js");
    const provider = new ChatViewProvider(
      { fsPath: "/tmp/ext" } as never,
      { get: vi.fn(), update: vi.fn() } as never,
    );
    const order: string[] = [];
    const session = {
      id: "worktree-session",
      mode: "code",
      reasoningEffort: "low",
      activeFilePath: undefined,
    };
    const setSessionApprovalMode = vi.fn(() => order.push("policy"));
    const sendMessage = vi.fn(async () => {
      order.push("prompt");
    });
    (provider as unknown as { sessionManager: unknown }).sessionManager = {
      getForegroundSession: () => session,
      getSession: () => session,
      setSessionApprovalMode,
      sendMessage,
    };
    (provider as unknown as { sendInitialState: () => void }).sendInitialState =
      vi.fn();
    vi.spyOn(provider, "injectPrompt");

    await provider.startPromptInMode({
      prompt: "Run the isolated task",
      autoSubmit: true,
      commandApprovalPolicy: "approve-for-me",
      approvalPolicy: "on-request",
      approvalReviewer: "auto-review",
      executionPreset: "workspace-write",
    });

    expect(setSessionApprovalMode).toHaveBeenCalledWith("worktree-session", {
      commandApprovalPolicy: "approve-for-me",
      approvalPolicy: "on-request",
      approvalReviewer: "auto-review",
      executionPreset: "workspace-write",
    });
    expect(order).toEqual(["policy"]);
    expect(provider.injectPrompt).not.toHaveBeenCalled();

    await vi.runAllTimersAsync();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      "worktree-session",
      "Run the isolated task",
      "code",
      expect.objectContaining({
        displayText: "Run the isolated task",
        origin: "vscode",
      }),
    );
    expect(order).toEqual(["policy", "prompt"]);
    vi.useRealTimers();
  });
});

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
    (provider as unknown as { sessionManager: unknown }).sessionManager = {
      getForegroundSession: () => undefined,
    };
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
  }, 15_000);

  it("projects MCP parallel opt-ins to Browser Ask Agent", async () => {
    const { ChatViewProvider } = await import("./ChatViewProvider.js");
    const provider = new ChatViewProvider(
      { fsPath: "/tmp/ext" } as never,
      { get: vi.fn(), update: vi.fn() } as never,
    );
    (
      provider as unknown as {
        askAgentMcpHub: {
          getToolDefs(): unknown[];
          getParallelToolCallServerNames(): string[];
        };
      }
    ).askAgentMcpHub = {
      getToolDefs: () => [
        {
          name: "parallel__read",
          description: "Parallel read",
          input_schema: { type: "object" },
        },
        {
          name: "serial__read",
          description: "Serial read",
          input_schema: { type: "object" },
        },
      ],
      getParallelToolCallServerNames: () => ["parallel"],
    };

    expect(provider.submitBrowserAskAgentMcpTools()).toMatchObject({
      ok: true,
      parallelSafeToolNames: ["parallel__read"],
      parallelSafeServerNames: ["parallel"],
    });
  }, 15_000);

  it("uses the selected provider's fast model and enforces selector variants", async () => {
    const { providerRegistry } = await import("./providers/index.js");
    const complete = vi.fn(async () => ({
      text: String.raw`^TARGET=[A-Za-z0-9_.-]+[ \t]+make[ \t]+test-[A-Za-z0-9_.-]+$`,
    }));
    providerRegistry.register({
      id: "regex-suggestion-test",
      displayName: "Regex suggestion test",
      condenseModel: "regex-fast",
      listModels: () => [
        {
          id: "regex-foreground",
          displayName: "Regex foreground",
          provider: "regex-suggestion-test",
          capabilities: {},
        },
      ],
      isAuthenticated: vi.fn(async () => true),
      getCapabilities: vi.fn(() => ({})),
      stream: vi.fn(),
      complete,
    } as never);

    const { ChatViewProvider } = await import("./ChatViewProvider.js");
    const provider = new ChatViewProvider(
      { fsPath: "/tmp/ext" } as never,
      { get: vi.fn(), update: vi.fn() } as never,
    );
    (
      provider as unknown as {
        sessionManager: unknown;
      }
    ).sessionManager = {
      getForegroundSession: () => ({
        model: "regex-foreground",
        projectScope: { displayName: "compiler" },
        title: "Test language targets",
        mode: "code",
        filesRead: new Set(),
        getAllMessages: () => [
          { role: "user", content: "Run the Go test target" },
        ],
      }),
      getConfig: () => ({ model: "regex-foreground" }),
    };

    await expect(
      provider.suggestRegexForCommand({
        fullCommand: "TARGET=tertiary make test-go",
        subCommand: "TARGET=tertiary make test-go",
      }),
    ).resolves.toBe(
      String.raw`^TARGET=[A-Za-z0-9_.-]+[ \t]+make[ \t]+test-[A-Za-z0-9_.-]+$`,
    );
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "regex-fast",
        reasoningEffort: "none",
        messages: [
          expect.objectContaining({
            content: expect.stringContaining(
              "TARGET=tertiary make test-agentlink-variant",
            ),
          }),
        ],
      }),
    );
  }, 15_000);
});

vi.mock("vscode", () => ({
  EventEmitter: MockEventEmitter,
  RelativePattern: MockRelativePattern,
  window: {
    createOutputChannel: vi.fn(() => mockOutputChannel),
    showInformationMessage: vi.fn(),
    showWarningMessage: vi.fn(),
    showErrorMessage: mockShowErrorMessage,
    showOpenDialog: mockShowOpenDialog,
    showTextDocument: mockShowTextDocument,
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
    findFiles: mockFindFiles,
    openTextDocument: mockOpenTextDocument,
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
    parse: vi.fn((value: string) => ({ fsPath: value, toString: () => value })),
  },
  ViewColumn: { One: 1, Beside: 2 },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  ColorThemeKind: {
    Light: 1,
    Dark: 2,
    HighContrast: 3,
    HighContrastLight: 4,
  },
}));

describe("browser project discovery", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("searches and relativizes files against the explicitly requested project", async () => {
    const { ChatViewProvider } = await import("./ChatViewProvider.js");
    const provider = new ChatViewProvider(
      { fsPath: "/tmp/ext" } as never,
      { get: vi.fn(), update: vi.fn() } as never,
    );
    (provider as unknown as { sessionManager: unknown }).sessionManager = {
      getWorkspaceProjects: () => [
        {
          id: "project-a",
          name: "Project A",
          uri: "file:///workspace/a",
          rootPath: "/workspace/a",
          availability: { status: "available" },
        },
        {
          id: "project-b",
          name: "Project B",
          uri: "file:///workspace/b",
          rootPath: "/workspace/b",
          availability: { status: "available" },
        },
      ],
    };
    mockFindFiles.mockResolvedValueOnce([
      { fsPath: "/workspace/b/src/project-b.ts" },
    ]);

    await expect(
      provider.searchBrowserFiles("project", "project-b"),
    ).resolves.toEqual([{ path: "src/project-b.ts", kind: "file" }]);
    expect(mockFindFiles).toHaveBeenCalledWith(
      expect.objectContaining({
        base: "/workspace/b",
        pattern: "**/*project*",
      }),
      "**/node_modules/**",
      50,
    );
  });
});

describe("session artifact routing", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("returns only canonically contained files from the attachment picker", async () => {
    const workspace = fs.mkdtempSync(
      path.join(os.tmpdir(), "agentlink-attachment-picker-"),
    );
    const projectRoot = path.join(workspace, "project");
    const projectFile = path.join(projectRoot, "inside.txt");
    const externalFile = path.join(workspace, "outside.txt");
    fs.mkdirSync(projectRoot);
    fs.writeFileSync(projectFile, "inside", "utf8");
    fs.writeFileSync(externalFile, "outside", "utf8");
    const linkPath = path.join(projectRoot, "outside-link.txt");
    fs.symlinkSync(externalFile, linkPath);

    try {
      const { ChatViewProvider } = await import("./ChatViewProvider.js");
      const provider = new ChatViewProvider(
        { fsPath: "/tmp/ext" } as never,
        { get: vi.fn(), update: vi.fn() } as never,
      );
      (provider as unknown as { sessionManager: unknown }).sessionManager = {
        getWorkspaceProjects: () => [
          {
            id: "project-a",
            name: "Project A",
            uri: `file://${projectRoot}`,
            rootPath: projectRoot,
            availability: { status: "available" },
          },
        ],
      };
      mockShowOpenDialog.mockResolvedValueOnce([
        { fsPath: projectFile },
        { fsPath: externalFile },
        { fsPath: linkPath },
      ]);

      await expect(
        provider.submitBrowserAttachFile("project-a"),
      ).resolves.toEqual({ files: ["inside.txt"] });
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("rejects attachment symlinks that escape the session project", async () => {
    const workspace = fs.mkdtempSync(
      path.join(os.tmpdir(), "agentlink-attachment-containment-"),
    );
    const projectRoot = path.join(workspace, "project");
    const externalFile = path.join(workspace, "external-secret.txt");
    fs.mkdirSync(projectRoot);
    fs.writeFileSync(externalFile, "must-not-leak", "utf8");
    fs.symlinkSync(externalFile, path.join(projectRoot, "link.txt"));

    try {
      const { ChatViewProvider } = await import("./ChatViewProvider.js");
      const provider = new ChatViewProvider(
        { fsPath: "/tmp/ext" } as never,
        { get: vi.fn(), update: vi.fn() } as never,
      );
      const result = await (
        provider as unknown as {
          resolveAttachments(
            text: string,
            attachments: string[],
            projectRoot: string,
          ): Promise<string>;
        }
      ).resolveAttachments(
        "[Attached: link.txt]\n\nInspect this",
        ["link.txt"],
        projectRoot,
      );

      expect(result).toContain("[Error: could not read file]");
      expect(result).not.toContain("must-not-leak");
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("writes condense debug and transcript artifacts only under the session project", async () => {
    const workspace = fs.mkdtempSync(
      path.join(os.tmpdir(), "agentlink-artifact-projects-"),
    );
    const rootA = path.join(workspace, "project-a");
    const rootB = path.join(workspace, "project-b");
    fs.mkdirSync(rootA);
    fs.mkdirSync(rootB);

    try {
      const { ChatViewProvider } = await import("./ChatViewProvider.js");
      const provider = new ChatViewProvider(
        { fsPath: "/tmp/ext" } as never,
        { get: vi.fn(), update: vi.fn() } as never,
      );
      const session = {
        id: "session-b",
        projectScope: {
          projectId: "project-b",
          workspaceFolderUri: `file://${rootB}`,
          displayName: "Project B",
          rootPath: rootB,
        },
        projectAvailability: "available",
        getAllMessages: vi.fn(() => [
          { role: "user", content: "project B prompt" },
        ]),
      };
      (provider as unknown as { sessionManager: unknown }).sessionManager = {
        getSession: (sessionId: string) =>
          sessionId === session.id ? session : undefined,
        getForegroundSession: () => session,
        getWorkspaceProjects: () => [
          {
            id: "project-a",
            uri: `file://${rootA}`,
            rootPath: rootA,
            availability: { status: "available" },
          },
          {
            id: "project-b",
            uri: `file://${rootB}`,
            rootPath: rootB,
            availability: { status: "available" },
          },
        ],
      };

      await (
        provider as unknown as {
          writeCondenseDebug(
            sessionId: string,
            event: {
              prevInputTokens: number;
              newInputTokens: number;
              summary: string;
            },
          ): Promise<void>;
        }
      ).writeCondenseDebug(session.id, {
        prevInputTokens: 100,
        newInputTokens: 40,
        summary: "condensed project B",
      });
      await (
        provider as unknown as {
          exportTranscript(
            messages: Array<{
              role: string;
              content: string;
              timestamp: number;
              blocks: Array<{ type: string; text?: string }>;
            }>,
          ): Promise<void>;
        }
      ).exportTranscript([
        {
          role: "user",
          content: "project B prompt",
          timestamp: 1,
          blocks: [],
        },
      ]);

      expect(fs.existsSync(path.join(rootA, ".agentlink"))).toBe(false);
      const condenseRoot = path.join(
        rootB,
        ".agentlink",
        "debug",
        "condensing",
      );
      const condenseDirectories = fs.readdirSync(condenseRoot);
      expect(condenseDirectories).toHaveLength(1);
      expect(
        fs.existsSync(
          path.join(condenseRoot, condenseDirectories[0], "condense-result.md"),
        ),
      ).toBe(true);
      const transcriptRoot = path.join(rootB, ".agentlink", "transcripts");
      expect(fs.readdirSync(transcriptRoot)).toHaveLength(1);
      expect(mockOpenTextDocument).toHaveBeenCalledWith(
        expect.stringMatching(
          new RegExp(
            `^${transcriptRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
          ),
        ),
      );
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("fails closed without writing artifacts for an unavailable session project", async () => {
    const workspace = fs.mkdtempSync(
      path.join(os.tmpdir(), "agentlink-artifact-unavailable-"),
    );
    try {
      const { ChatViewProvider } = await import("./ChatViewProvider.js");
      const provider = new ChatViewProvider(
        { fsPath: "/tmp/ext" } as never,
        { get: vi.fn(), update: vi.fn() } as never,
      );
      const session = {
        id: "session-missing",
        projectScope: {
          projectId: "project-missing",
          workspaceFolderUri: `file://${workspace}`,
          displayName: "Missing Project",
          rootPath: workspace,
        },
        projectAvailability: "missing",
        getAllMessages: vi.fn(() => []),
      };
      (provider as unknown as { sessionManager: unknown }).sessionManager = {
        getSession: () => session,
        getForegroundSession: () => session,
        getWorkspaceProjects: () => [],
      };

      await expect(
        (
          provider as unknown as {
            writeCondenseDebug(
              sessionId: string,
              event: {
                prevInputTokens: number;
                newInputTokens: number;
                summary: string;
              },
            ): Promise<void>;
          }
        ).writeCondenseDebug(session.id, {
          prevInputTokens: 100,
          newInputTokens: 40,
          summary: "must not write",
        }),
      ).rejects.toThrow("unavailable for artifact export");
      await (
        provider as unknown as {
          exportTranscript(messages: []): Promise<void>;
        }
      ).exportTranscript([]);

      expect(fs.existsSync(path.join(workspace, ".agentlink"))).toBe(false);
      expect(mockOpenTextDocument).not.toHaveBeenCalled();
      expect(mockShowErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining("unavailable for artifact export"),
      );
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});

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
      projectId: "project-test",
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
    provider.setSessionManager({
      rebuildSystemPrompts,
      getForegroundSession: () => undefined,
    } as never);
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
      3,
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

  it("restores todos from full history when the todo_write call is outside the visible tail", async () => {
    const { ChatViewProvider } = await import("./ChatViewProvider.js");
    const todos = [
      {
        id: "resume",
        content: "Resume interrupted work",
        activeForm: "Resuming interrupted work",
        status: "in_progress" as const,
      },
    ];
    const messages: AgentMessage[] = [
      { role: "user", content: "original task" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "todo-1",
            name: "todo_write",
            input: { todos },
          },
        ],
      },
    ];
    for (let index = 2; index <= 10; index += 1) {
      messages.push(
        { role: "user", content: `follow-up ${index}` },
        { role: "assistant", content: `response ${index}` },
      );
    }
    const session = {
      id: "session-1",
      mode: "code",
      model: "claude-sonnet-4-6",
      status: "idle",
      title: "Interrupted session",
      estimatedTotalUsed: 0,
      lastInputTokens: 0,
      lastOutputTokens: 0,
      runState: { phase: "running", startedAt: 123 },
      getAllMessages: () => messages,
    };
    const provider = new ChatViewProvider(
      { fsPath: "/tmp/ext" } as never,
      { get: vi.fn(), update: vi.fn() } as never,
    );
    (provider as unknown as { view: unknown }).view = {
      webview: { postMessage: mockPostMessage },
    };
    (provider as unknown as { webviewReady: boolean }).webviewReady = true;
    provider.setSessionManager({
      getForegroundSession: vi.fn(() => session),
      getConfig: vi.fn(() => ({
        model: "claude-sonnet-4-6",
        autoCondenseThreshold: 0.8,
      })),
      getSessionInfos: vi.fn(() => []),
      getBgSessionInfos: vi.fn(() => []),
      onEvent: undefined,
      onSessionsChanged: undefined,
    } as never);

    (
      provider as unknown as {
        postSessionLoaded: (
          session: unknown,
          options: { restored: boolean },
        ) => void;
      }
    ).postSessionLoaded(session, { restored: true });

    expect(mockPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "agentSessionLoaded",
        sessionId: "session-1",
        todos,
        hasMoreBefore: true,
      }),
    );
    const loadedMessage = mockPostMessage.mock.calls.find(
      ([message]) => message.type === "agentSessionLoaded",
    )?.[0];
    expect(JSON.stringify(loadedMessage?.messages)).not.toContain("todo_write");
    expect(provider.getBrowserProjectedForegroundState()?.todos).toEqual(todos);
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

  it("does not mark a restored ask_user question as an interrupted session", async () => {
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
      reasoningEffort: "high",
      runState: {
        phase: "awaiting_question",
        startedAt: 123,
        question: { questionRequestId: "question-1" },
      },
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
      provider as unknown as { sendInitialState: () => void }
    ).sendInitialState();

    expect(mockPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "stateUpdate",
        state: expect.objectContaining({ interrupted: false }),
      }),
    );
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

  it("routes attachment context for restored ask_user questions through recovery", async () => {
    const { ChatViewProvider } = await import("./ChatViewProvider.js");
    const provider = new ChatViewProvider(
      { fsPath: "/tmp/ext" } as never,
      { get: vi.fn(), update: vi.fn() } as never,
    );
    const session = {
      id: "session-1",
      projectScope: { projectId: "project-1" },
    };
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
      answers: {},
      attachments: {
        choice: [
          {
            kind: "image",
            name: "screen.png",
            mimeType: "image/png",
            base64: "image-data",
          },
        ],
      },
    });

    expect(accepted).toBe(true);
    expect(manager.answerRecoveredQuestion).toHaveBeenCalledWith(
      "session-1",
      "question-1",
      {
        answers: {},
        notes: {},
        attachments: {
          choice: [
            {
              kind: "image",
              name: "screen.png",
              mimeType: "image/png",
              base64: "image-data",
            },
          ],
        },
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
        projectId: "project-test",
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
          projectId: "project-test",
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
          projectId: "project-test",
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
      projectScope: {
        projectId: "project-a",
        workspaceFolderUri: "file:///workspace/a",
        displayName: "Project A",
        rootPath: "/workspace/a",
      },
      projectAvailability: "available",
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

  it("marks a browser composer message as an interjection when queueing it", async () => {
    const { ChatViewProvider } = await import("./ChatViewProvider.js");

    const provider = new ChatViewProvider(
      { fsPath: "/tmp/ext" } as never,
      { get: vi.fn(), update: vi.fn() } as never,
    );

    const session = {
      id: "session-1",
      mode: "code",
      model: "claude-sonnet-4-6",
      status: "tool_executing",
      title: "Session 1",
      reasoningEffort: "high",
      estimatedTotalUsed: 0,
      lastInputTokens: 0,
      lastOutputTokens: 0,
      projectScope: {
        projectId: "project-a",
        workspaceFolderUri: "file:///workspace/a",
        displayName: "Project A",
        rootPath: "/workspace/a",
      },
      projectAvailability: "available",
      getAllMessages: () => [] as unknown[],
      setPendingInterjection: vi.fn(() => true),
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
      text: "change course now",
      displayText: "Change course now",
      sessionId: "session-1",
      mode: "code",
      interject: true,
    });

    expect(result).toEqual({ ok: true, queued: true, interjected: true });
    expect(session.setPendingInterjection).toHaveBeenCalledWith(
      "change course now",
      expect.any(String),
      undefined,
      "Change course now",
      false,
      undefined,
      undefined,
      undefined,
      undefined,
    );
    expect(
      provider.getBrowserProjectedForegroundState()?.messageQueue,
    ).toMatchObject([
      {
        text: "Change course now",
        source: "browser",
        interjectionReady: true,
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

  it("pauses a pending interjection while its queued message is edited", async () => {
    const { ChatViewProvider } = await import("./ChatViewProvider.js");

    const provider = new ChatViewProvider(
      { fsPath: "/tmp/ext" } as never,
      { get: vi.fn(), update: vi.fn() } as never,
    );
    const clearPendingInterjectionIf = vi.fn();
    (
      provider as unknown as {
        sessionManager: { getSession: ReturnType<typeof vi.fn> };
      }
    ).sessionManager = {
      getSession: vi.fn(() => ({ clearPendingInterjectionIf })),
    };
    const postMessage = vi.fn();
    (provider as unknown as { postMessage: typeof postMessage }).postMessage =
      postMessage;

    (
      provider as unknown as {
        pauseQueuedMessageInterjectionFromUi(
          sessionId: string,
          queueId: string,
        ): void;
      }
    ).pauseQueuedMessageInterjectionFromUi("session-1", "queue-1");

    expect(clearPendingInterjectionIf).toHaveBeenCalledWith("queue-1");
    expect(postMessage).toHaveBeenCalledWith({
      type: "agentQueueInterjectionReady",
      sessionId: "session-1",
      queueId: "queue-1",
      ready: false,
    });
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
      projectScope: { projectId: "project-1" },
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

    expect(result).toMatchObject({ ok: true, projectId: "project-1" });
    expect(manager.createForegroundSession).toHaveBeenCalledWith("code", {
      projectId: undefined,
    });
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

  it("routes a stale webview send to an in-flight new session", async () => {
    const { ChatViewProvider } = await import("./ChatViewProvider.js");

    const provider = new ChatViewProvider(
      { fsPath: "/tmp/ext" } as never,
      { get: vi.fn(), update: vi.fn() } as never,
    );
    (provider as unknown as { view: unknown }).view = {
      webview: { postMessage: mockPostMessage },
    };
    (provider as unknown as { webviewReady: boolean }).webviewReady = true;

    const projectScope = {
      projectId: "project-1",
      workspaceFolderUri: "file:///tmp/project",
      rootPath: "/tmp/project",
    };
    const oldSession = {
      id: "session-old",
      title: "Old Session",
      mode: "code",
      model: "claude-sonnet-4-6",
      status: "idle",
      projectScope,
      projectAvailability: "available",
      lastInputTokens: 0,
      lastOutputTokens: 0,
      estimatedInputUsed: 0,
      getAllMessages: () => [{ role: "user", content: "old task" }],
    };
    const newSession = {
      ...oldSession,
      id: "session-new",
      title: "New Session",
      getAllMessages: () => [],
    };

    let foregroundSession = oldSession;
    let resolveCreation!: (session: typeof newSession) => void;
    const creation = new Promise<typeof newSession>((resolve) => {
      resolveCreation = resolve;
    });
    const sendMessage = vi.fn(async () => undefined);
    const manager = {
      getForegroundSession: vi.fn(() => foregroundSession),
      getSession: vi.fn((sessionId: string) =>
        sessionId === oldSession.id
          ? oldSession
          : sessionId === newSession.id
            ? newSession
            : undefined,
      ),
      getConfig: vi.fn(() => ({
        model: "claude-sonnet-4-6",
        autoCondenseThreshold: 0.8,
      })),
      getSessionInfos: vi.fn(() => []),
      getBgSessionInfos: vi.fn(() => []),
      createForegroundSession: vi.fn(() => creation),
      sendMessage,
      onEvent: undefined,
      onSessionsChanged: undefined,
    };
    provider.setSessionManager(manager as never);

    const handleWebviewMessage = (
      provider as unknown as {
        handleWebviewMessage(message: Record<string, unknown>): Promise<void>;
      }
    ).handleWebviewMessage.bind(provider);

    await handleWebviewMessage({
      command: "agentNewSession",
      mode: "code",
    });
    const send = handleWebviewMessage({
      command: "agentSend",
      text: "new task",
      sessionId: oldSession.id,
      mode: "code",
    });

    await Promise.resolve();
    expect(sendMessage).not.toHaveBeenCalled();

    foregroundSession = newSession;
    resolveCreation(newSession);
    await send;
    await Promise.resolve();

    expect(sendMessage).toHaveBeenCalledWith(
      newSession.id,
      "new task",
      "code",
      expect.objectContaining({ origin: "vscode" }),
    );
    expect(sendMessage).not.toHaveBeenCalledWith(
      oldSession.id,
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
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

  it("refreshes the context budget snapshot when the foreground session condenses", async () => {
    const { providerRegistry } = await import("./providers/index.js");
    providerRegistry.register({
      id: "ctx-budget-test",
      displayName: "Context budget test",
      condenseModel: "ctx-test-model",
      listModels: () => [
        {
          id: "ctx-test-model",
          displayName: "Ctx test",
          provider: "ctx-budget-test",
          capabilities: {},
        },
      ],
      isAuthenticated: vi.fn(async () => true),
      getCapabilities: vi.fn(() => ({
        contextWindow: 200_000,
        maxOutputTokens: 8_000,
      })),
      stream: vi.fn(),
      complete: vi.fn(),
    } as never);

    const { ChatViewProvider } = await import("./ChatViewProvider.js");
    const provider = new ChatViewProvider(
      { fsPath: "/tmp/ext" } as never,
      { get: vi.fn(), update: vi.fn() } as never,
    );
    (provider as unknown as { view: unknown }).view = {
      webview: { postMessage: mockPostMessage },
    };
    (provider as unknown as { webviewReady: boolean }).webviewReady = true;

    // Post-condense session state: usage already reset to the new estimate.
    const session = {
      id: "fg-1",
      background: false,
      status: "streaming",
      title: "Chat",
      mode: "code",
      model: "ctx-test-model",
      lastInputTokens: 12_000,
      lastOutputTokens: 0,
      lastCacheReadTokens: 0,
      estimatedInputUsed: 12_000,
      estimatedTotalUsed: 12_000,
      getAllMessages: vi.fn(() => []),
    };
    (provider as unknown as { sessionManager: unknown }).sessionManager = {
      getSession: (sessionId: string) =>
        sessionId === session.id ? session : undefined,
      getForegroundSession: () => session,
      getConfig: () => ({ maxTokens: 8_000, thinkingBudget: 0 }),
    };

    const handleAgentEvent = (
      provider as unknown as {
        handleAgentEvent: (sessionId: string, event: unknown) => void;
      }
    ).handleAgentEvent;
    handleAgentEvent.call(provider, "fg-1", {
      type: "condense",
      summary: "summary",
      prevInputTokens: 180_000,
      newInputTokens: 12_000,
      durationMs: 500,
    });

    const stateUpdate = mockPostMessage.mock.calls
      .map(([message]) => message)
      .find((message) => message.type === "stateUpdate");
    expect(stateUpdate).toBeDefined();
    expect(stateUpdate.state.sessionId).toBe("fg-1");
    expect(stateUpdate.state.contextBudget).toMatchObject({
      usedInputTokens: 12_000,
      contextWindow: 200_000,
    });
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
        resultSummary: "one-line summary",
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
        projects: [],
        defaultProjectId: null,
        project: null,
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
        approvalPolicy: "on-request",
        approvalReviewer: "user",
        executionPreset: "native-manual",
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

    expect(mapped).toMatchObject({
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

    expect(mappedAsciiArrow).toMatchObject({
      kind: "rename",
      id: "approval-2",
      oldName: "fromName",
      newName: "toName",
      affectedFiles: [{ path: "src/file.ts", changes: 1 }],
      totalChanges: 1,
    });
  });

  it("attributes inline approvals to the initiating session and target project", async () => {
    const { ChatViewProvider } = await import("./ChatViewProvider.js");

    const provider = new ChatViewProvider(
      { fsPath: "/tmp/ext" } as never,
      { get: vi.fn(), update: vi.fn() } as never,
    );
    const sessions = {
      "session-a": {
        projectScope: {
          projectId: "project-a",
          displayName: "Project A",
          rootPath: "/workspace/a",
        },
        projectAvailability: "available",
      },
      "session-b": {
        projectScope: {
          projectId: "project-b",
          displayName: "Project B",
          rootPath: "/workspace/b",
        },
        projectAvailability: "available",
      },
    };
    (provider as unknown as { sessionManager: unknown }).sessionManager = {
      getForegroundSession: () => sessions["session-a"],
      getSession: (id: keyof typeof sessions) => sessions[id],
      getWorkspaceProjects: () => [
        {
          id: "project-a",
          name: "Project A",
          rootPath: "/workspace/a",
          availability: { status: "available" },
        },
        {
          id: "project-b",
          name: "Project B",
          rootPath: "/workspace/b",
          availability: { status: "available" },
        },
      ],
    };

    const buildApprovalRequest = (
      provider as unknown as {
        buildApprovalRequest: (
          id: string,
          request: {
            kind: string;
            title: string;
            targetPath?: string;
            choices: Array<{ label: string; value: string }>;
          },
          sessionId?: string,
        ) => {
          sourceProject?: { projectId: string; displayName: string };
          targetProject?: { projectId: string; displayName: string };
          targetPath?: string;
        };
      }
    ).buildApprovalRequest.bind(provider);

    const backgroundApproval = buildApprovalRequest(
      "approval-background",
      {
        kind: "write",
        title: "Modify `src/output.ts`?",
        targetPath: "src/output.ts",
        choices: [{ label: "Accept", value: "accept" }],
      },
      "session-b",
    );
    expect(backgroundApproval).toMatchObject({
      sourceProject: {
        projectId: "project-b",
        displayName: "Project B",
      },
      targetPath: "/workspace/b/src/output.ts",
    });
    expect(backgroundApproval.targetProject).toBeUndefined();

    const crossProjectApproval = buildApprovalRequest(
      "approval-cross-project",
      {
        kind: "write",
        title: "Modify `shared.ts`?",
        targetPath: "/workspace/b/shared.ts",
        choices: [{ label: "Accept", value: "accept" }],
      },
      "session-a",
    );
    expect(crossProjectApproval).toMatchObject({
      sourceProject: {
        projectId: "project-a",
        displayName: "Project A",
      },
      targetProject: {
        projectId: "project-b",
        displayName: "Project B",
      },
      targetPath: "/workspace/b/shared.ts",
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
      approvalKind: "write",
      decision: "accept",
    });

    await expect(approvalPromise).resolves.toMatchObject({
      decision: "accept",
    });
    expect(ok).toBe(true);
    expect(publishApprovalIdleSpy).toHaveBeenCalledOnce();
  });

  it("keeps a worktree launch approval distinct from an overlapping main-agent approval", async () => {
    const { ChatViewProvider } = await import("./ChatViewProvider.js");

    const provider = new ChatViewProvider(
      { fsPath: "/tmp/ext" } as never,
      { get: vi.fn(), update: vi.fn() } as never,
    );
    const uiPublisher = (
      provider as unknown as {
        uiPublisher: { publishApproval: (request: unknown) => void };
      }
    ).uiPublisher;
    const publishApprovalSpy = vi.spyOn(uiPublisher, "publishApproval");

    const mainRespond = vi.fn(() => true);
    provider.forwardApproval(
      {
        kind: "command",
        id: "main-command",
        command: "npm test",
        subCommands: [],
      },
      mainRespond,
    );

    const worktreePromise = provider.requestApproval({
      kind: "worktree",
      id: "worktree-launch",
      title: "Start worktree agent: Reliability pass",
      detail: "Destination: /workspace/reliability",
      choices: [
        {
          label: "Approve and autosubmit prompt",
          value: "approve-autosubmit",
          isPrimary: true,
        },
        {
          label: "Approve, prefill only",
          value: "approve-prefill",
        },
        { label: "Deny", value: "deny", isDanger: true },
      ],
    });

    expect(publishApprovalSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: "worktree-launch",
        kind: "worktree",
      }),
    );

    const ok = provider.submitBrowserApprovalDecision({
      id: "worktree-launch",
      approvalKind: "worktree",
      decision: "approve-autosubmit",
    });

    await expect(worktreePromise).resolves.toMatchObject({
      decision: "approve-autosubmit",
    });
    expect(ok).toBe(true);
    expect(mainRespond).not.toHaveBeenCalled();
    expect(publishApprovalSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "main-command" }),
    );
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

    const forwardedRespond = vi.fn(() => true);
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
      approvalKind: "write",
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
    const forwardedRespond = vi.fn(() => true);
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
      approvalKind: "command",
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
      approvalKind: "write",
      decision: "reject",
    });
    await expect(foregroundPromise).resolves.toMatchObject({
      decision: "reject",
    });
  });

  it("keeps a forwarded native command approval pending until the owner accepts it", async () => {
    const { ChatViewProvider } = await import("./ChatViewProvider.js");
    const provider = new ChatViewProvider(
      { fsPath: "/tmp/ext" } as never,
      { get: vi.fn(), update: vi.fn() } as never,
    );
    const respond = vi
      .fn<
        (
          message: import("../approvals/webview/types.js").DecisionMessage,
        ) => boolean
      >()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);

    provider.forwardApproval(
      {
        kind: "command",
        id: "native-escalation",
        command: "dotnet build",
        cwd: "/workspace",
        reason: "Needs a host facility.",
      },
      respond,
    );

    expect(
      provider.submitBrowserApprovalDecision({
        id: "native-escalation",
        approvalKind: "write",
        decision: "run-once",
      }),
    ).toBe(false);
    expect(respond).not.toHaveBeenCalled();

    expect(
      provider.submitBrowserApprovalDecision({
        id: "native-escalation",
        approvalKind: "command",
        decision: "edit",
        editedCommand: "dotnet test",
      }),
    ).toBe(false);
    expect(respond).toHaveBeenCalledTimes(1);

    expect(
      provider.submitBrowserApprovalDecision({
        id: "native-escalation",
        approvalKind: "command",
        decision: "run-once",
      }),
    ).toBe(true);
    expect(respond).toHaveBeenCalledTimes(2);
    expect(respond).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: "native-escalation",
        approvalKind: "command",
        decision: "run-once",
      }),
    );
    expect(
      provider.submitBrowserApprovalDecision({
        id: "native-escalation",
        approvalKind: "command",
        decision: "run-once",
      }),
    ).toBe(false);
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
