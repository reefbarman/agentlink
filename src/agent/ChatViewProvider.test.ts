import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentMessage } from "./types.js";
import type { AppAction } from "../shared/chatProjection.js";
import type { ChatTab } from "./ChatTabController.js";

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
const mockExecuteCommand = vi.fn();
const mockFindFiles = vi.fn(async () => [] as Array<{ fsPath: string }>);
const mockOpenTextDocument = vi.fn(async (filePath: string) => ({ filePath }));
const mockShowTextDocument = vi.fn(async () => undefined);
const mockShowInformationMessage = vi.fn();
const mockShowErrorMessage = vi.fn();
const mockShowOpenDialog = vi.fn();
const mockOutputChannel = {
  appendLine: vi.fn(),
  info: vi.fn(),
  show: vi.fn(),
  dispose: vi.fn(),
};
const mockConfigUpdate = vi.fn();
const terminalSettings: Record<string, unknown> = {};
const mockWorkspaceFolders: Array<{
  uri: { fsPath: string; toString: () => string };
}> = [];

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
  it("repairs Approve for Me write authority after switching the startup mode", async () => {
    const { ChatViewProvider } = await import("./ChatViewProvider.js");
    const provider = new ChatViewProvider(
      { fsPath: "/tmp/ext" } as never,
      { get: vi.fn(), update: vi.fn() } as never,
    );
    const session = {
      id: "worktree-session",
      mode: "architect",
      projectScope: { rootPath: "/workspace/project" },
    };
    let writeApproval: "prompt" | "session" = "prompt";
    const setAgentWriteApprovalSelection = vi.fn(
      (_sessionId: string, selection: typeof writeApproval) => {
        writeApproval = selection;
        return true;
      },
    );
    provider.setApprovalManager({
      getAgentWriteApprovalState: vi.fn(() => writeApproval),
      setAgentWriteApprovalSelection,
      resetSessionAgentWriteApproval: vi.fn(),
      onDidChange: vi.fn(() => ({ dispose: vi.fn() })),
    } as never);
    provider.setSessionManager({
      getForegroundSession: vi.fn(() => session),
      getSession: vi.fn(() => session),
      switchForegroundMode: vi.fn(async () => session),
      getCommandApprovalPolicy: vi.fn(() => "approve-for-me"),
      setCommandApprovalPolicy: vi.fn(),
    } as never);
    (provider as unknown as { sendInitialState: () => void }).sendInitialState =
      vi.fn();
    vi.spyOn(provider, "injectPrompt").mockImplementation(() => undefined);

    await provider.startPromptInMode({
      prompt: "Run the isolated task",
      mode: "architect",
    });

    expect(setAgentWriteApprovalSelection).toHaveBeenCalledWith(
      "worktree-session",
      "session",
      "/workspace/project",
    );
    expect(writeApproval).toBe("session");
  }, 15_000);

  it("records a mode marker when a code action starts a prompt in another mode", async () => {
    const { ChatViewProvider } = await import("./ChatViewProvider.js");
    const provider = new ChatViewProvider(
      { fsPath: "/tmp/ext" } as never,
      { get: vi.fn(), update: vi.fn() } as never,
    );
    const appendSurfaceChange = vi.fn();
    const current = {
      id: "code-action-session",
      mode: "ask",
      projectScope: { rootPath: "/workspace/project" },
      getAllMessages: () => [{ role: "user" }],
      appendSurfaceChange,
    };
    const switched = { ...current, mode: "code" };
    const saveSession = vi.fn();
    provider.setSessionManager({
      getForegroundSession: vi.fn(() => current),
      switchForegroundMode: vi.fn(async () => switched),
      saveSession,
      getCommandApprovalPolicy: vi.fn(() => "safe"),
    } as never);
    (provider as unknown as { sendInitialState: () => void }).sendInitialState =
      vi.fn();
    vi.spyOn(provider, "injectPrompt").mockImplementation(() => undefined);

    await provider.startPromptInMode({
      prompt: "Explain this code",
      mode: "code",
    });

    expect(appendSurfaceChange).toHaveBeenCalledWith({
      mode: { previousMode: "ask", mode: "code" },
    });
    expect(saveSession).toHaveBeenCalledWith(current.id);
  });

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
  }, 15_000);
});

describe("approval diff reveal messages", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("forwards the approval request id to the diff reveal command", async () => {
    const { ChatViewProvider } = await import("./ChatViewProvider.js");
    const provider = new ChatViewProvider(
      { fsPath: "/tmp/ext" } as never,
      { get: vi.fn(), update: vi.fn() } as never,
    );
    (provider as unknown as { sessionManager: unknown }).sessionManager = {
      getForegroundSession: () => undefined,
    };

    await (
      provider as unknown as {
        handleWebviewMessage(message: Record<string, unknown>): Promise<void>;
      }
    ).handleWebviewMessage({
      command: "revealPendingDiff",
      id: "diff-request-1",
    });

    expect(mockExecuteCommand).toHaveBeenCalledWith(
      "agentlink.revealDiff",
      "diff-request-1",
    );
  }, 15_000);
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

  it("polishes the composer draft with the provider's fast model", async () => {
    const { providerRegistry } = await import("./providers/index.js");
    const complete = vi.fn(async () => ({
      text: "Please fix the login bug in auth.ts.\n",
    }));
    providerRegistry.register({
      id: "polish-test",
      displayName: "Polish test",
      condenseModel: "polish-fast",
      listModels: () => [
        {
          id: "polish-foreground",
          displayName: "Polish foreground",
          provider: "polish-test",
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
      getForegroundSession: () => ({ model: "polish-foreground" }),
      getConfig: () => ({ model: "polish-foreground" }),
    };

    await expect(
      provider.polishPrompt({ draft: "plese fix the login bug in auth.ts" }),
    ).resolves.toBe("Please fix the login bug in auth.ts.");
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "polish-fast",
        reasoningEffort: "none",
        temperature: 0,
        messages: [
          expect.objectContaining({
            content: expect.stringContaining(
              "plese fix the login bug in auth.ts",
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
    showInformationMessage: mockShowInformationMessage,
    showWarningMessage: vi.fn(),
    showErrorMessage: mockShowErrorMessage,
    showOpenDialog: mockShowOpenDialog,
    showTextDocument: mockShowTextDocument,
    activeTextEditor: undefined,
    activeColorTheme: { kind: 2 },
  },
  commands: {
    executeCommand: mockExecuteCommand,
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
    get workspaceFolders() {
      return mockWorkspaceFolders;
    },
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

describe("tool-block file links", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("opens absolute files outside the workspace without requiring a project root", async () => {
    const externalFile = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-open-file-")),
      "tool-result.txt",
    );
    fs.writeFileSync(externalFile, "tool output", "utf8");

    try {
      const { ChatViewProvider } = await import("./ChatViewProvider.js");
      const provider = new ChatViewProvider(
        { fsPath: "/tmp/ext" } as never,
        { get: vi.fn(), update: vi.fn() } as never,
      );
      (provider as unknown as { sessionManager: unknown }).sessionManager = {
        getForegroundSession: () => undefined,
        getDefaultProjectScope: () => undefined,
      };

      await (
        provider as unknown as {
          handleWebviewMessage(message: Record<string, unknown>): Promise<void>;
        }
      ).handleWebviewMessage({ command: "agentOpenFile", path: externalFile });

      expect(mockShowTextDocument).toHaveBeenCalledWith(
        { fsPath: externalFile },
        expect.any(Object),
      );
    } finally {
      fs.rmSync(path.dirname(externalFile), { recursive: true, force: true });
    }
  });

  it("falls back to vscode.open when the file cannot open as text (images, binaries)", async () => {
    const imageFile = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-open-image-")),
      "concept.png",
    );
    fs.writeFileSync(imageFile, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    try {
      const { ChatViewProvider } = await import("./ChatViewProvider.js");
      const provider = new ChatViewProvider(
        { fsPath: "/tmp/ext" } as never,
        { get: vi.fn(), update: vi.fn() } as never,
      );
      (provider as unknown as { sessionManager: unknown }).sessionManager = {
        getForegroundSession: () => undefined,
        getDefaultProjectScope: () => undefined,
      };
      mockShowTextDocument.mockRejectedValueOnce(
        new Error("File seems to be binary and cannot be opened as text"),
      );

      await (
        provider as unknown as {
          handleWebviewMessage(message: Record<string, unknown>): Promise<void>;
        }
      ).handleWebviewMessage({ command: "agentOpenFile", path: imageFile });

      expect(mockExecuteCommand).toHaveBeenCalledWith(
        "vscode.open",
        { fsPath: imageFile },
        expect.any(Object),
      );
    } finally {
      fs.rmSync(path.dirname(imageFile), { recursive: true, force: true });
    }
  });

  it("replies with a not_found result when the clicked path does not exist", async () => {
    const { ChatViewProvider } = await import("./ChatViewProvider.js");
    const provider = new ChatViewProvider(
      { fsPath: "/tmp/ext" } as never,
      { get: vi.fn(), update: vi.fn() } as never,
    );
    (provider as unknown as { sessionManager: unknown }).sessionManager = {
      getForegroundSession: () => undefined,
      getDefaultProjectScope: () => undefined,
    };
    const connectionPostMessage = vi.fn();

    await (
      provider as unknown as {
        handleWebviewMessage(
          message: Record<string, unknown>,
          context: Record<string, unknown>,
        ): Promise<void>;
      }
    ).handleWebviewMessage(
      {
        command: "agentOpenFile",
        path: "/definitely/not/a/real/file.png",
        requestId: "open-req-1",
      },
      { connection: { postMessage: connectionPostMessage } },
    );

    expect(connectionPostMessage).toHaveBeenCalledWith({
      type: "agentOpenFileResult",
      requestId: "open-req-1",
      ok: false,
      error: "not_found",
    });
    expect(mockShowTextDocument).not.toHaveBeenCalled();
  });

  it("replies with an ok result after opening an existing file", async () => {
    const openableFile = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-open-ok-")),
      "notes.md",
    );
    fs.writeFileSync(openableFile, "hello", "utf8");

    try {
      const { ChatViewProvider } = await import("./ChatViewProvider.js");
      const provider = new ChatViewProvider(
        { fsPath: "/tmp/ext" } as never,
        { get: vi.fn(), update: vi.fn() } as never,
      );
      (provider as unknown as { sessionManager: unknown }).sessionManager = {
        getForegroundSession: () => undefined,
        getDefaultProjectScope: () => undefined,
      };
      const connectionPostMessage = vi.fn();

      await (
        provider as unknown as {
          handleWebviewMessage(
            message: Record<string, unknown>,
            context: Record<string, unknown>,
          ): Promise<void>;
        }
      ).handleWebviewMessage(
        {
          command: "agentOpenFile",
          path: openableFile,
          requestId: "open-req-2",
        },
        { connection: { postMessage: connectionPostMessage } },
      );

      expect(connectionPostMessage).toHaveBeenCalledWith({
        type: "agentOpenFileResult",
        requestId: "open-req-2",
        ok: true,
        error: undefined,
      });
    } finally {
      fs.rmSync(path.dirname(openableFile), { recursive: true, force: true });
    }
  });

  it("does not resolve relative tool-result paths without a project root", async () => {
    const { ChatViewProvider } = await import("./ChatViewProvider.js");
    const provider = new ChatViewProvider(
      { fsPath: "/tmp/ext" } as never,
      { get: vi.fn(), update: vi.fn() } as never,
    );
    (provider as unknown as { sessionManager: unknown }).sessionManager = {
      getForegroundSession: () => undefined,
      getDefaultProjectScope: () => undefined,
    };

    await (
      provider as unknown as {
        handleWebviewMessage(message: Record<string, unknown>): Promise<void>;
      }
    ).handleWebviewMessage({
      command: "agentOpenFile",
      path: "relative/tool-result.txt",
    });

    expect(mockShowTextDocument).not.toHaveBeenCalled();
  });

  it("resolves relative tool-result paths against the active project", async () => {
    const projectRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "agentlink-open-project-file-"),
    );
    const relativePath = path.join("src", "tool-result.ts");
    const projectFile = path.join(projectRoot, relativePath);
    fs.mkdirSync(path.dirname(projectFile), { recursive: true });
    fs.writeFileSync(projectFile, "export {};", "utf8");

    try {
      const { ChatViewProvider } = await import("./ChatViewProvider.js");
      const provider = new ChatViewProvider(
        { fsPath: "/tmp/ext" } as never,
        { get: vi.fn(), update: vi.fn() } as never,
      );
      (provider as unknown as { sessionManager: unknown }).sessionManager = {
        getForegroundSession: () => ({
          mode: "code",
          projectAvailability: "available",
          projectScope: {
            schemaVersion: 1,
            kind: "project",
            projectId: "project-a",
            workspaceFolderUri: `file://${projectRoot}`,
            displayName: "Project A",
            rootPath: projectRoot,
          },
        }),
      };

      await (
        provider as unknown as {
          handleWebviewMessage(message: Record<string, unknown>): Promise<void>;
        }
      ).handleWebviewMessage({ command: "agentOpenFile", path: relativePath });

      expect(mockShowTextDocument).toHaveBeenCalledWith(
        { fsPath: projectFile },
        expect.any(Object),
      );
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

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
    const insensitivePattern = "**/*[pP][rR][oO][jJ][eE][cC][tT]*";
    expect(mockFindFiles).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        base: "/workspace/b",
        pattern: insensitivePattern,
      }),
      "**/node_modules/**",
      50,
    );
    expect(mockFindFiles).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        base: "/workspace/b",
        pattern: insensitivePattern,
      }),
      null,
      200,
    );
  });

  it("finds files from a pasted absolute path inside the project", async () => {
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
      ],
    };
    mockFindFiles.mockResolvedValue([{ fsPath: "/workspace/a/src/Foo.ts" }]);

    await expect(
      provider.searchBrowserFiles("/workspace/a/src/Foo.ts", "project-a"),
    ).resolves.toEqual([{ path: "src/Foo.ts", kind: "file" }]);
    expect(mockFindFiles).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        base: "/workspace/a",
        pattern: "**/*[sS][rR][cC]/[fF][oO][oO].[tT][sS]*",
      }),
      "**/node_modules/**",
      50,
    );
  });

  it("includes gitignored files while still filtering dependency and Git internals", async () => {
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
      ],
    };
    mockFindFiles
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { fsPath: "/workspace/a/.ignored/generated.ts" },
        { fsPath: "/workspace/a/node_modules/pkg/generated.ts" },
        { fsPath: "/workspace/a/.git/generated.ts" },
      ]);

    await expect(
      provider.searchBrowserFiles("generated", "project-a"),
    ).resolves.toEqual([{ path: ".ignored/generated.ts", kind: "file" }]);
  });

  it("opens browser-requested files only when they resolve inside the selected project", async () => {
    const workspace = fs.mkdtempSync(
      path.join(os.tmpdir(), "agentlink-browser-open-file-"),
    );
    const projectRoot = path.join(workspace, "project");
    const projectFile = path.join(projectRoot, "README.md");
    const outsideFile = path.join(workspace, "outside.md");
    fs.mkdirSync(projectRoot);
    fs.writeFileSync(projectFile, "inside", "utf8");
    fs.writeFileSync(outsideFile, "outside", "utf8");

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

    await expect(
      provider.submitBrowserOpenFile("README.md", undefined, "project-a"),
    ).resolves.toEqual({ ok: true });
    expect(mockShowTextDocument).toHaveBeenCalledWith(
      { fsPath: fs.realpathSync(projectFile) },
      expect.any(Object),
    );

    await expect(
      provider.submitBrowserOpenFile(outsideFile, undefined, "project-a"),
    ).resolves.toEqual({ ok: false, error: "path_outside_project" });
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
          ): Promise<{
            text: string;
            images: Array<{
              name: string;
              mimeType: string;
              base64: string;
            }>;
            documents: Array<{
              name: string;
              mimeType: string;
              base64: string;
            }>;
          }>;
        }
      ).resolveAttachments(
        "[Attached: link.txt]\n\nInspect this",
        ["link.txt"],
        projectRoot,
      );

      expect(result.text).toContain("[Error: could not read file]");
      expect(result.text).not.toContain("must-not-leak");
      expect(result.images).toEqual([]);
      expect(result.documents).toEqual([]);
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
    mockWorkspaceFolders.length = 0;
    for (const key of Object.keys(terminalSettings))
      delete terminalSettings[key];
  });

  it("persists a no-folder model selection as the Ask preference", async () => {
    const { ChatViewProvider } = await import("./ChatViewProvider.js");
    const provider = new ChatViewProvider(
      { fsPath: "/tmp/ext" } as never,
      { get: vi.fn(), update: vi.fn() } as never,
    );
    const setModel = vi.fn(async () => "openrouter-moonshotai-kimi-k3");
    provider.setSessionManager({
      setModel,
      getForegroundSession: vi.fn(() => undefined),
      getDefaultProjectScope: vi.fn(() => ({
        projectId: "synthetic-root",
        workspaceFolderUri: "file:///",
        displayName: "/",
        rootPath: "/",
      })),
      getWorkspaceProjects: vi.fn(() => []),
    } as never);
    const sendInitialState = vi.fn();
    (provider as unknown as { sendInitialState: () => void }).sendInitialState =
      sendInitialState;

    await expect(
      provider.submitBrowserSetModel("openrouter-moonshotai-kimi-k3"),
    ).resolves.toEqual({ ok: true });

    expect(setModel).toHaveBeenCalledWith("openrouter-moonshotai-kimi-k3");
    expect(mockConfigUpdate).toHaveBeenCalledOnce();
    expect(mockConfigUpdate).toHaveBeenCalledWith(
      "modeModelPreferences",
      { ask: "openrouter-moonshotai-kimi-k3" },
      1,
    );
    expect(sendInitialState).toHaveBeenCalledOnce();
  });

  it("preserves the legacy foreground mode-switch path without an explicit session", async () => {
    const { ChatViewProvider } = await import("./ChatViewProvider.js");
    const provider = new ChatViewProvider(
      { fsPath: "/tmp/ext" } as never,
      { get: vi.fn(), update: vi.fn() } as never,
    );
    const projectScope = {
      schemaVersion: 1 as const,
      kind: "project" as const,
      projectId: "project-1",
      workspaceFolderUri: "file:///workspace/project",
      displayName: "Project",
      rootPath: "/workspace/project",
    };
    const session = {
      id: "session-1",
      mode: "code",
      projectScope,
      getAllMessages: () => [],
    };
    const updated = { ...session, mode: "debug" };
    const switchForegroundMode = vi.fn(async () => updated);
    const switchSessionMode = vi.fn(async () => updated);
    provider.setSessionManager({
      getForegroundSession: vi.fn(() => session),
      getWorkspaceProjects: vi.fn(() => [
        {
          id: projectScope.projectId,
          name: projectScope.displayName,
          uri: projectScope.workspaceFolderUri,
          rootPath: projectScope.rootPath,
          availability: { status: "available" },
        },
      ]),
      switchForegroundMode,
      switchSessionMode,
    } as never);
    (
      provider as unknown as {
        reconcileSessionApprovalAfterModeSwitch(sessionId: string): void;
        sendInitialState(): void;
      }
    ).reconcileSessionApprovalAfterModeSwitch = vi.fn();
    (
      provider as unknown as {
        reconcileSessionApprovalAfterModeSwitch(sessionId: string): void;
        sendInitialState(): void;
      }
    ).sendInitialState = vi.fn();

    await expect(
      provider.submitBrowserModeSwitch("debug", projectScope.projectId),
    ).resolves.toEqual({ approved: true, mode: "debug" });

    expect(switchForegroundMode).toHaveBeenCalledWith("debug");
    expect(switchSessionMode).not.toHaveBeenCalled();
  });

  it("persists model selection for the active session mode and publishes state", async () => {
    mockWorkspaceFolders.push({
      uri: {
        fsPath: "/workspace/project",
        toString: () => "file:///workspace/project",
      },
    });
    const { ChatViewProvider } = await import("./ChatViewProvider.js");
    const provider = new ChatViewProvider(
      { fsPath: "/tmp/ext" } as never,
      { get: vi.fn(), update: vi.fn() } as never,
    );
    const session = {
      mode: "debug",
      projectScope: {
        projectId: "project-1",
        workspaceFolderUri: "file:///workspace/project",
        displayName: "Project",
        rootPath: "/workspace/project",
      },
    };
    const setModel = vi.fn(async () => "openrouter-moonshotai-kimi-k3");
    provider.setSessionManager({
      setModel,
      getForegroundSession: vi.fn(() => session),
      getWorkspaceProjects: vi.fn(() => []),
    } as never);
    const sendInitialState = vi.fn();
    (provider as unknown as { sendInitialState: () => void }).sendInitialState =
      sendInitialState;

    await expect(
      provider.submitBrowserSetModel("openrouter-moonshotai-kimi-k3"),
    ).resolves.toEqual({ ok: true });

    expect(mockConfigUpdate).toHaveBeenCalledOnce();
    expect(mockConfigUpdate).toHaveBeenCalledWith(
      "modeModelPreferences",
      { debug: "openrouter-moonshotai-kimi-k3" },
      3,
    );
    expect(sendInitialState).toHaveBeenCalledOnce();
  });

  it("forces no-folder sends into projectless Ask mode without local attachments", async () => {
    const { ChatViewProvider } = await import("./ChatViewProvider.js");
    const provider = new ChatViewProvider(
      { fsPath: "/tmp/ext" } as never,
      { get: vi.fn(), update: vi.fn() } as never,
    );
    const projectlessSession = {
      id: "projectless-session",
      mode: "ask",
      model: "openrouter-moonshotai-kimi-k3",
      status: "idle",
      reasoningEffort: "none",
      activeFilePath: undefined,
      projectScope: {
        schemaVersion: 1,
        kind: "project",
        projectId: "projectless",
        workspaceFolderUri: "agentlink://projectless",
        displayName: "No folder",
      },
      projectAvailability: "unavailable",
    };
    const createSession = vi.fn(async () => projectlessSession);
    const sendMessage = vi.fn(async () => undefined);
    provider.setSessionManager({
      getForegroundSession: vi.fn(() => undefined),
      getSession: vi.fn((id: string) =>
        id === projectlessSession.id ? projectlessSession : undefined,
      ),
      getWorkspaceProjects: vi.fn(() => []),
      createSession,
      sendMessage,
    } as never);

    await (
      provider as unknown as {
        handleWebviewMessage(message: Record<string, unknown>): Promise<void>;
      }
    ).handleWebviewMessage({
      command: "agentSend",
      text: "What can you help me with?",
      mode: "code",
      images: [
        { name: "question.png", mimeType: "image/png", base64: "aW1hZ2U=" },
      ],
    });

    expect(createSession).toHaveBeenCalledWith("ask", {
      activeFilePath: undefined,
    });
    expect(sendMessage).toHaveBeenCalledWith(
      projectlessSession.id,
      "What can you help me with?",
      "ask",
      expect.objectContaining({
        origin: "vscode",
        images: [
          {
            name: "question.png",
            mimeType: "image/png",
            base64: "aW1hZ2U=",
          },
        ],
      }),
    );

    await expect(
      (
        provider as unknown as {
          handleWebviewMessage(message: Record<string, unknown>): Promise<void>;
        }
      ).handleWebviewMessage({
        command: "agentSend",
        text: "Read this file",
        mode: "ask",
        sessionId: projectlessSession.id,
        attachments: ["README.md"],
      }),
    ).rejects.toThrow("Open a folder before attaching local workspace files.");

    await expect(
      provider.submitBrowserSend({
        text: "Describe this image",
        mode: "code",
        sessionId: projectlessSession.id,
        images: [
          { name: "question.png", mimeType: "image/png", base64: "aW1hZ2U=" },
        ],
      }),
    ).resolves.toEqual({ ok: true });
    expect(sendMessage).toHaveBeenLastCalledWith(
      projectlessSession.id,
      "Describe this image",
      "ask",
      expect.objectContaining({
        origin: "browser",
        images: [
          {
            name: "question.png",
            mimeType: "image/png",
            base64: "aW1hZ2U=",
          },
        ],
      }),
    );
    await expect(
      provider.submitBrowserSend({
        text: "Read this file",
        mode: "ask",
        sessionId: projectlessSession.id,
        attachments: ["README.md"],
      }),
    ).resolves.toEqual({
      ok: false,
      error: "Open a folder before attaching local workspace files.",
    });
  });

  it("reuses the in-flight new-session transition when the webview sends sessionId null", async () => {
    const { ChatViewProvider } = await import("./ChatViewProvider.js");
    const provider = new ChatViewProvider(
      { fsPath: "/tmp/ext" } as never,
      { get: vi.fn(), update: vi.fn() } as never,
    );
    const transitionSession = {
      id: "transition-session",
      mode: "ask",
      model: "openrouter-moonshotai-kimi-k3",
      status: "idle",
      reasoningEffort: "none",
      activeFilePath: undefined,
      projectScope: {
        schemaVersion: 1,
        kind: "project",
        projectId: "projectless",
        workspaceFolderUri: "agentlink://projectless",
        displayName: "No folder",
      },
      projectAvailability: "unavailable",
    };
    const createSession = vi.fn(async () => transitionSession);
    const sendMessage = vi.fn(async () => undefined);
    provider.setSessionManager({
      getForegroundSession: vi.fn(() => undefined),
      getSession: vi.fn((id: string) =>
        id === transitionSession.id ? transitionSession : undefined,
      ),
      getWorkspaceProjects: vi.fn(() => []),
      createSession,
      sendMessage,
    } as never);
    (
      provider as unknown as { foregroundSessionTransition?: unknown }
    ).foregroundSessionTransition = {
      previousSessionId: "previous-session",
      promise: Promise.resolve(transitionSession),
    };

    await (
      provider as unknown as {
        handleWebviewMessage(message: Record<string, unknown>): Promise<void>;
      }
    ).handleWebviewMessage({
      command: "agentSend",
      text: "hello",
      mode: "ask",
      sessionId: null,
    });

    // Regression: sessionId null previously bypassed the transition wait and
    // minted a duplicate session for the same fresh chat.
    expect(createSession).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(
      "transition-session",
      "hello",
      "ask",
      expect.anything(),
    );
  });

  it("routes VS Code model selections through the shared selection path", async () => {
    const { ChatViewProvider } = await import("./ChatViewProvider.js");
    const provider = new ChatViewProvider(
      { fsPath: "/tmp/ext" } as never,
      { get: vi.fn(), update: vi.fn() } as never,
    );
    provider.setSessionManager({
      getForegroundSession: vi.fn(() => undefined),
      getWorkspaceProjects: vi.fn(() => []),
    } as never);
    const submitBrowserSetModel = vi
      .spyOn(provider, "submitBrowserSetModel")
      .mockResolvedValue({ ok: true });

    await (
      provider as unknown as {
        handleWebviewMessage(message: Record<string, unknown>): Promise<void>;
      }
    ).handleWebviewMessage({
      command: "agentSetModel",
      model: "openrouter-moonshotai-kimi-k3",
    });

    expect(submitBrowserSetModel).toHaveBeenCalledWith(
      "openrouter-moonshotai-kimi-k3",
    );
  });

  it("refreshes project skill projections in prompt, cache, then slash order", async () => {
    const { ChatViewProvider } = await import("./ChatViewProvider.js");
    const order: string[] = [];
    const customizationRegistry = {
      invalidate: vi.fn((projectId: string) => {
        order.push(`invalidate:${projectId}`);
      }),
      clear: vi.fn(),
    };
    const provider = new ChatViewProvider(
      { fsPath: "/tmp/ext" } as never,
      { get: vi.fn(), update: vi.fn() } as never,
      customizationRegistry as never,
    );
    const rebuildSystemPrompts = vi.fn(async (projectId?: string) => {
      order.push(`prompt:${projectId ?? "all"}`);
    });
    provider.setSessionManager({
      rebuildSystemPrompts,
      getForegroundSession: () => ({
        projectScope: { projectId: "project-a" },
      }),
    } as never);
    (
      provider as unknown as {
        getCustomizationSelection(): {
          scope: { projectId: string };
        };
        sendSlashCommands(): Promise<void>;
      }
    ).getCustomizationSelection = () => ({
      scope: { projectId: "project-a" },
    });
    (
      provider as unknown as {
        sendSlashCommands(): Promise<void>;
      }
    ).sendSlashCommands = vi.fn(async () => {
      order.push("slash");
    });

    await provider.refreshSkillConfiguration("project-a");

    expect(customizationRegistry.invalidate).toHaveBeenCalledWith("project-a");
    expect(customizationRegistry.clear).not.toHaveBeenCalled();
    expect(rebuildSystemPrompts).toHaveBeenCalledWith("project-a");
    expect(order).toEqual([
      "prompt:project-a",
      "invalidate:project-a",
      "slash",
    ]);

    provider.dispose();
  });

  it("retains cached and published skill commands when prompt rebuild fails", async () => {
    const { ChatViewProvider } = await import("./ChatViewProvider.js");
    const customizationRegistry = {
      invalidate: vi.fn(),
      clear: vi.fn(),
    };
    const provider = new ChatViewProvider(
      { fsPath: "/tmp/ext" } as never,
      { get: vi.fn(), update: vi.fn() } as never,
      customizationRegistry as never,
    );
    const rebuildSystemPrompts = vi
      .fn<(projectId?: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("prompt rebuild failed"))
      .mockResolvedValueOnce();
    provider.setSessionManager({
      rebuildSystemPrompts,
      getForegroundSession: () => undefined,
    } as never);
    (
      provider as unknown as {
        getCustomizationSelection(): {
          scope: { projectId: string };
        };
        sendSlashCommands(): Promise<void>;
      }
    ).getCustomizationSelection = () => ({
      scope: { projectId: "project-a" },
    });
    const sendSlashCommands = vi.fn(async () => {});
    (
      provider as unknown as {
        sendSlashCommands(): Promise<void>;
      }
    ).sendSlashCommands = sendSlashCommands;

    await provider.refreshSkillConfiguration("project-a");

    expect(customizationRegistry.invalidate).not.toHaveBeenCalled();
    expect(customizationRegistry.clear).not.toHaveBeenCalled();
    expect(sendSlashCommands).not.toHaveBeenCalled();

    await provider.refreshSkillConfiguration("project-a");

    expect(rebuildSystemPrompts).toHaveBeenCalledTimes(2);
    expect(customizationRegistry.invalidate).toHaveBeenCalledOnce();
    expect(customizationRegistry.invalidate).toHaveBeenCalledWith("project-a");
    expect(sendSlashCommands).toHaveBeenCalledOnce();
    provider.dispose();
  });

  it("suppresses a stale same-project slash load after refresh commits", async () => {
    const { ChatViewProvider } = await import("./ChatViewProvider.js");
    const customizationRegistry = {
      invalidate: vi.fn(),
      clear: vi.fn(),
    };
    const provider = new ChatViewProvider(
      { fsPath: "/tmp/ext" } as never,
      { get: vi.fn(), update: vi.fn() } as never,
      customizationRegistry as never,
    );
    provider.setSessionManager({
      rebuildSystemPrompts: vi.fn(async () => {}),
      getForegroundSession: () => undefined,
    } as never);
    const selection = {
      scope: {
        projectId: "project-a",
        workspaceFolderUri: "file:///workspace/a",
      },
      mode: "code",
    };
    (
      provider as unknown as {
        getCustomizationSelection(): typeof selection;
      }
    ).getCustomizationSelection = () => selection;
    type TestSlashCommand = { name: string; skillRevision?: string };
    let resolveStale!: (commands: TestSlashCommand[]) => void;
    const staleCommands = new Promise<TestSlashCommand[]>((resolve) => {
      resolveStale = resolve;
    });
    const getCurrentSlashCommands = vi
      .fn()
      .mockReturnValueOnce(staleCommands)
      .mockResolvedValueOnce([{ name: "fresh", skillRevision: "revision-2" }]);
    (
      provider as unknown as {
        getCurrentSlashCommands: typeof getCurrentSlashCommands;
      }
    ).getCurrentSlashCommands = getCurrentSlashCommands;
    const postMessage = vi.fn();
    (
      provider as unknown as {
        postMessage: typeof postMessage;
      }
    ).postMessage = postMessage;
    const sendSlashCommands = (
      provider as unknown as { sendSlashCommands(): Promise<void> }
    ).sendSlashCommands.bind(provider);

    const stalePublication = sendSlashCommands();
    await provider.refreshSkillConfiguration("project-a");
    resolveStale([{ name: "stale", skillRevision: "revision-1" }]);
    await stalePublication;

    const updates = postMessage.mock.calls
      .map(([message]) => message)
      .filter((message) => message.type === "agentSlashCommandsUpdate");
    expect(updates).toEqual([
      {
        type: "agentSlashCommandsUpdate",
        commands: [{ name: "fresh", skillRevision: "revision-2" }],
      },
    ]);
    provider.dispose();
  });

  it("does not cancel a foreground slash load when another project refreshes", async () => {
    const { ChatViewProvider } = await import("./ChatViewProvider.js");
    const customizationRegistry = {
      invalidate: vi.fn(),
      clear: vi.fn(),
    };
    const provider = new ChatViewProvider(
      { fsPath: "/tmp/ext" } as never,
      { get: vi.fn(), update: vi.fn() } as never,
      customizationRegistry as never,
    );
    provider.setSessionManager({
      rebuildSystemPrompts: vi.fn(async () => {}),
      getForegroundSession: () => undefined,
    } as never);
    const selection = {
      scope: {
        projectId: "project-a",
        workspaceFolderUri: "file:///workspace/a",
      },
      mode: "code",
    };
    (
      provider as unknown as {
        getCustomizationSelection(): typeof selection;
      }
    ).getCustomizationSelection = () => selection;
    let resolveProjectA!: (commands: Array<{ name: string }>) => void;
    const projectACommands = new Promise<Array<{ name: string }>>((resolve) => {
      resolveProjectA = resolve;
    });
    (
      provider as unknown as {
        getCurrentSlashCommands(): Promise<Array<{ name: string }>>;
      }
    ).getCurrentSlashCommands = vi.fn(() => projectACommands);
    const postMessage = vi.fn();
    (
      provider as unknown as {
        postMessage: typeof postMessage;
      }
    ).postMessage = postMessage;
    const sendSlashCommands = (
      provider as unknown as { sendSlashCommands(): Promise<void> }
    ).sendSlashCommands.bind(provider);

    const projectAPublication = sendSlashCommands();
    await provider.refreshSkillConfiguration("project-b");
    resolveProjectA([{ name: "project-a-current" }]);
    await projectAPublication;

    expect(customizationRegistry.invalidate).toHaveBeenCalledWith("project-b");
    expect(postMessage).toHaveBeenCalledWith({
      type: "agentSlashCommandsUpdate",
      commands: [{ name: "project-a-current" }],
    });
    provider.dispose();
  });

  it("shows workspace history from the immediate slash command", async () => {
    const { ChatViewProvider } = await import("./ChatViewProvider.js");
    const provider = new ChatViewProvider(
      { fsPath: "/tmp/ext" } as never,
      { get: vi.fn(), update: vi.fn() } as never,
    );
    const outputChannel = (
      provider as unknown as { outputChannel: typeof mockOutputChannel }
    ).outputChannel;
    outputChannel.appendLine.mockClear();
    outputChannel.show.mockClear();
    provider.setWorkspaceHistoryDiagnostic(() => ({
      status: "ready",
      workspaceIdentity: "workspace-id",
      directory: "/workspace/.agentlink/history",
      label: "Legacy single-folder history",
    }));

    provider.showWorkspaceHistory();

    expect(outputChannel.appendLine).toHaveBeenCalledWith(
      expect.stringContaining("Location: /workspace/.agentlink/history"),
    );
    expect(outputChannel.show).toHaveBeenCalledWith(true);
    provider.dispose();
  });

  it("serializes overlapping skill refresh transactions", async () => {
    const { ChatViewProvider } = await import("./ChatViewProvider.js");
    const order: string[] = [];
    const releaseFirst: { current?: () => void } = {};
    const customizationRegistry = {
      invalidate: vi.fn((projectId: string) => {
        order.push(`invalidate:${projectId}`);
      }),
      clear: vi.fn(),
    };
    const provider = new ChatViewProvider(
      { fsPath: "/tmp/ext" } as never,
      { get: vi.fn(), update: vi.fn() } as never,
      customizationRegistry as never,
    );
    const rebuildSystemPrompts = vi
      .fn<(projectId?: string) => Promise<void>>()
      .mockImplementationOnce(
        (projectId) =>
          new Promise<void>((resolve) => {
            order.push(`prompt:${projectId}:start`);
            releaseFirst.current = () => {
              order.push(`prompt:${projectId}:end`);
              resolve();
            };
          }),
      )
      .mockImplementationOnce(async (projectId) => {
        order.push(`prompt:${projectId}`);
      });
    provider.setSessionManager({
      rebuildSystemPrompts,
      getForegroundSession: () => undefined,
    } as never);
    (
      provider as unknown as {
        getCustomizationSelection(): {
          scope: { projectId: string };
        };
        sendSlashCommands(): Promise<void>;
      }
    ).getCustomizationSelection = () => ({
      scope: { projectId: "project-a" },
    });
    (
      provider as unknown as {
        sendSlashCommands(): Promise<void>;
      }
    ).sendSlashCommands = vi.fn(async () => {
      order.push("slash");
    });

    const first = provider.refreshSkillConfiguration("project-a");
    const second = provider.refreshSkillConfiguration("project-a");
    await Promise.resolve();
    await Promise.resolve();

    expect(rebuildSystemPrompts).toHaveBeenCalledTimes(1);
    expect(customizationRegistry.invalidate).not.toHaveBeenCalled();
    releaseFirst.current?.();
    await Promise.all([first, second]);

    expect(order).toEqual([
      "prompt:project-a:start",
      "prompt:project-a:end",
      "invalidate:project-a",
      "slash",
      "prompt:project-a",
      "invalidate:project-a",
      "slash",
    ]);

    provider.dispose();
  });

  it("routes manual slash refresh through the unified skill transaction", async () => {
    const { ChatViewProvider } = await import("./ChatViewProvider.js");
    const provider = new ChatViewProvider(
      { fsPath: "/tmp/ext" } as never,
      { get: vi.fn(), update: vi.fn() } as never,
    );
    const selection = { scope: { projectId: "project-a" } };
    provider.setSessionManager({
      getForegroundSession: () => undefined,
    } as never);
    (
      provider as unknown as {
        getCustomizationSelection(): typeof selection;
        getCurrentSlashCommands(): Promise<unknown[]>;
      }
    ).getCustomizationSelection = () => selection;
    (
      provider as unknown as {
        getCurrentSlashCommands(): Promise<unknown[]>;
      }
    ).getCurrentSlashCommands = vi.fn(async () => [{ name: "helper" }]);
    const refreshSkillConfiguration = vi
      .spyOn(provider, "refreshSkillConfiguration")
      .mockResolvedValue();

    await (
      provider as unknown as {
        handleWebviewMessage(message: Record<string, unknown>): Promise<void>;
      }
    ).handleWebviewMessage({ command: "agentRefreshSlashCommands" });

    expect(refreshSkillConfiguration).toHaveBeenCalledWith("project-a");
    provider.dispose();
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

  it("ignores MCP status changes from a hub that is no longer current", async () => {
    const { ChatViewProvider } = await import("./ChatViewProvider.js");
    const provider = new ChatViewProvider(
      { fsPath: "/tmp/ext" } as never,
      { get: vi.fn(), update: vi.fn() } as never,
    );
    const scope = {
      schemaVersion: 1 as const,
      kind: "project" as const,
      projectId: "project-a",
      workspaceFolderUri: "file:///workspace/a",
      displayName: "project-a",
      rootPath: "/workspace/a",
    };
    const registry = provider.getProjectMcpHubRegistry();
    (
      registry as unknown as {
        loadConfigs: () => Promise<[]>;
      }
    ).loadConfigs = async () => [];
    const retiredGeneration = registry.ensure(scope);
    const currentGeneration = await registry.reload(scope);
    const handleMcpStatusChange = vi.spyOn(
      provider as never,
      "handleMcpStatusChange" as never,
    );
    const infos = [
      {
        name: "linear",
        status: "error" as const,
        toolCount: 0,
        resourceCount: 0,
        promptCount: 0,
        tools: [],
        error: "stdio channel closed",
      },
    ];

    retiredGeneration.hub.onStatusChange?.(infos);
    expect(handleMcpStatusChange).not.toHaveBeenCalled();

    currentGeneration.hub.onStatusChange?.(infos);
    expect(handleMcpStatusChange).toHaveBeenCalledOnce();
    expect(handleMcpStatusChange).toHaveBeenCalledWith(infos, scope.projectId);

    provider.dispose();
  });

  it("coalesces duplicate startup MCP refreshes and skips an active generation", async () => {
    const { ChatViewProvider } = await import("./ChatViewProvider.js");
    const provider = new ChatViewProvider(
      { fsPath: "/tmp/ext" } as never,
      { get: vi.fn(), update: vi.fn() } as never,
    );
    const scope = {
      schemaVersion: 1 as const,
      kind: "project" as const,
      projectId: "project-a",
      workspaceFolderUri: "file:///workspace/a",
      displayName: "project-a",
      rootPath: "/workspace/a",
    };
    const registry = provider.getProjectMcpHubRegistry();
    registry.ensure(scope);
    let resolveRefresh!: () => void;
    const privateProvider = provider as unknown as {
      refreshMcpConnections(
        options?: { interactiveForNewServers?: boolean },
        scope?: Parameters<typeof registry.ensure>[0],
      ): Promise<void>;
      ensureStartupMcpConnection(
        scope: Parameters<typeof registry.ensure>[0],
      ): Promise<void>;
    };
    const refreshMcpConnections = vi
      .spyOn(privateProvider, "refreshMcpConnections")
      .mockReturnValue(
        new Promise<void>((resolve) => {
          resolveRefresh = resolve;
        }),
      );
    const ensureStartupMcpConnection =
      privateProvider.ensureStartupMcpConnection.bind(provider);

    const first = ensureStartupMcpConnection(scope);
    const second = ensureStartupMcpConnection(scope);
    expect(refreshMcpConnections).toHaveBeenCalledOnce();

    resolveRefresh();
    await Promise.all([first, second]);

    vi.spyOn(registry, "getCurrent").mockReturnValue({
      projectId: scope.projectId,
      generation: 1,
      hub: {} as never,
    });
    await ensureStartupMcpConnection(scope);
    expect(refreshMcpConnections).toHaveBeenCalledOnce();

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

  it("ignores non-foreground state updates in the browser projection", async () => {
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
      type: "stateUpdate",
      state: {
        sessionId: "popped-session",
        mode: "debug",
        model: "other-model",
        streaming: true,
      },
    });

    expect(provider.getBrowserProjectedForegroundState()).toMatchObject({
      sessionId: foreground.id,
      mode: foreground.mode,
      model: foreground.model,
      streaming: false,
    });
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
    mockWorkspaceFolders.push({
      uri: {
        fsPath: "/workspace/project",
        toString: () => "file:///workspace/project",
      },
    });
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
      title: "Session 1",
      mode: "code",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      thinkingBudget: 1024,
      lastInputTokens: 0,
      lastOutputTokens: 0,
      estimatedTotalUsed: 0,
      projectScope: {
        projectId: "project-a",
        workspaceFolderUri: "file:///workspace/project",
        rootPath: "/workspace/project",
      },
      getAllMessages: () => [
        {
          role: "user" as const,
          content: "Existing turn",
        },
      ],
      appendSurfaceChange: vi.fn(),
    };
    const setSessionReasoningEffort = vi.fn(
      (sessionId: string, effort: string) => {
        expect(sessionId).toBe(session.id);
        session.reasoningEffort = effort;
        return true;
      },
    );
    provider.setSessionManager({
      getForegroundSession: vi.fn(() => session),
      getSession: vi.fn(() => session),
      setSessionReasoningEffort,
      getConfig: vi.fn(() => ({ thinkingBudget: 1024 })),
      getSessionInfos: vi.fn(() => []),
      getBgSessionInfos: vi.fn(() => []),
      saveSession: vi.fn(),
    } as never);

    await expect(
      provider.submitBrowserSetReasoningEffort("max"),
    ).resolves.toEqual({
      ok: true,
    });
    expect(setSessionReasoningEffort).toHaveBeenCalledWith(session.id, "max");
    expect(session.reasoningEffort).toBe("max");
    expect(session.appendSurfaceChange).toHaveBeenCalledWith({
      reasoning: {
        previousReasoningEffort: "high",
        reasoningEffort: "max",
      },
    });
    expect(mockPostMessage).toHaveBeenCalledWith({
      type: "agentSurfaceChange",
      sessionId: session.id,
      change: {
        reasoning: {
          previousReasoningEffort: "high",
          reasoningEffort: "max",
        },
      },
    });
    expect(
      provider
        .getBrowserProjectedForegroundState()
        ?.projectedMessages.some(
          (message) =>
            message.surfaceChange?.reasoning?.reasoningEffort === "max",
        ),
    ).toBe(true);
    expect(provider.getBrowserProjectedForegroundState()?.reasoningEffort).toBe(
      "max",
    );
    expect(mockConfigUpdate).toHaveBeenCalledWith(
      "modeReasoningEffortPreferences",
      { code: "max" },
      3,
    );
  });

  it("couples browser Approve for Me changes to session write approval in order", async () => {
    const { ChatViewProvider } = await import("./ChatViewProvider.js");
    const provider = new ChatViewProvider(
      { fsPath: "/tmp/ext" } as never,
      { get: vi.fn(), update: vi.fn() } as never,
    );
    const order: string[] = [];
    let commandApprovalPolicy: "safe" | "approve-for-me" = "safe";
    let writeApproval: "prompt" | "session" = "prompt";
    const setCommandApprovalPolicy = vi.fn(
      (_sessionId: string, policy: typeof commandApprovalPolicy) => {
        order.push(`policy:${policy}`);
        commandApprovalPolicy = policy;
      },
    );
    const resetSessionAgentWriteApproval = vi.fn(() => {
      order.push("write:prompt");
      writeApproval = "prompt";
    });
    provider.setApprovalManager({
      getAgentWriteApprovalState: vi.fn(() => writeApproval),
      setAgentWriteApprovalSelection: vi.fn(
        (_sessionId: string, selection: typeof writeApproval) => {
          order.push(`write:${selection}`);
          writeApproval = selection;
          return true;
        },
      ),
      resetSessionAgentWriteApproval,
      onDidChange: vi.fn(() => ({ dispose: vi.fn() })),
    } as never);
    provider.setSessionManager({
      getForegroundSession: vi.fn(() => ({
        id: "foreground-session",
        projectScope: { rootPath: "/workspace/project" },
      })),
      getCommandApprovalPolicy: vi.fn(() => commandApprovalPolicy),
      setCommandApprovalPolicy,
    } as never);
    (provider as unknown as { sendInitialState: () => void }).sendInitialState =
      vi.fn();

    expect(
      provider.submitBrowserSetCommandApprovalPolicy("approve-for-me"),
    ).toEqual({ ok: true });
    expect(order).toEqual(["write:session", "policy:approve-for-me"]);

    order.length = 0;
    expect(provider.submitBrowserSetCommandApprovalPolicy("safe")).toEqual({
      ok: true,
    });
    expect(order).toEqual(["policy:safe", "write:prompt"]);
    expect(resetSessionAgentWriteApproval).toHaveBeenCalledWith(
      "foreground-session",
    );
  });

  it("sidebar Prompt disables only Approve for Me across live sessions", async () => {
    const { ChatViewProvider } = await import("./ChatViewProvider.js");
    const provider = new ChatViewProvider(
      { fsPath: "/tmp/ext" } as never,
      { get: vi.fn(), update: vi.fn() } as never,
    );
    const sessions = [
      {
        id: "manual-session",
        projectScope: {
          projectId: "project-a",
          rootPath: "/workspace/a",
        },
      },
      {
        id: "approve-for-me-session",
        projectScope: {
          projectId: "project-b",
          rootPath: "/workspace/b",
        },
      },
    ];
    const policies = new Map<string, "safe" | "manual" | "approve-for-me">([
      ["manual-session", "manual"],
      ["approve-for-me-session", "approve-for-me"],
    ]);
    const setCommandApprovalPolicy = vi.fn(
      (sessionId: string, policy: "safe" | "manual" | "approve-for-me") => {
        policies.set(sessionId, policy);
      },
    );
    provider.setApprovalManager({
      getAgentWriteApprovalState: vi.fn(() => "project"),
      setAgentWriteApprovalSelection: vi.fn(() => true),
      resetAgentWriteApproval: vi.fn(),
      resetSessionAgentWriteApproval: vi.fn(),
      onDidChange: vi.fn(() => ({ dispose: vi.fn() })),
    } as never);
    provider.setSessionManager({
      getForegroundSession: vi.fn(() => sessions[1]),
      getSession: vi.fn((sessionId: string) =>
        sessions.find((session) => session.id === sessionId),
      ),
      getSessionInfos: vi.fn(() => sessions.map(({ id }) => ({ id }))),
      getCommandApprovalPolicy: vi.fn(
        (sessionId: string) => policies.get(sessionId) ?? "safe",
      ),
      setCommandApprovalPolicy,
    } as never);
    (provider as unknown as { sendInitialState: () => void }).sendInitialState =
      vi.fn();

    expect(provider.setSidebarWriteApproval("prompt", [])).toBe(true);
    expect(setCommandApprovalPolicy).toHaveBeenCalledOnce();
    expect(setCommandApprovalPolicy).toHaveBeenCalledWith(
      "approve-for-me-session",
      "safe",
    );
    expect(policies.get("manual-session")).toBe("manual");
  });

  it("requeues pending command approvals only when Approve for Me becomes active", async () => {
    const { ChatViewProvider } = await import("./ChatViewProvider.js");
    const provider = new ChatViewProvider(
      { fsPath: "/tmp/ext" } as never,
      { get: vi.fn(), update: vi.fn() } as never,
    );
    let commandApprovalPolicy: "safe" | "approve-for-me" = "safe";
    let writeApproval: "prompt" | "session" = "prompt";
    provider.setApprovalManager({
      getAgentWriteApprovalState: vi.fn(() => writeApproval),
      setAgentWriteApprovalSelection: vi.fn(
        (_sessionId: string, selection: typeof writeApproval) => {
          writeApproval = selection;
          return true;
        },
      ),
      resetSessionAgentWriteApproval: vi.fn(() => {
        writeApproval = "prompt";
      }),
      onDidChange: vi.fn(() => ({ dispose: vi.fn() })),
    } as never);
    provider.setSessionManager({
      getForegroundSession: vi.fn(() => ({
        id: "foreground-session",
        projectScope: { rootPath: "/workspace/project" },
      })),
      getCommandApprovalPolicy: vi.fn(() => commandApprovalPolicy),
      setCommandApprovalPolicy: vi.fn(
        (_sessionId: string, policy: typeof commandApprovalPolicy) => {
          commandApprovalPolicy = policy;
        },
      ),
    } as never);
    (provider as unknown as { sendInitialState: () => void }).sendInitialState =
      vi.fn();
    const requeue = vi.fn(() => 1);
    provider.setCommandApprovalRequeueHandler(requeue);

    expect(
      provider.submitBrowserSetCommandApprovalPolicy("approve-for-me"),
    ).toEqual({ ok: true });
    expect(requeue).toHaveBeenCalledTimes(1);
    expect(requeue).toHaveBeenCalledWith("foreground-session");

    requeue.mockClear();
    expect(
      provider.submitBrowserSetCommandApprovalPolicy("approve-for-me"),
    ).toEqual({ ok: true });
    expect(requeue).not.toHaveBeenCalled();

    expect(provider.submitBrowserSetCommandApprovalPolicy("safe")).toEqual({
      ok: true,
    });
    expect(requeue).not.toHaveBeenCalled();
  });

  async function makeWriteApprovalSweepProvider() {
    const { ChatViewProvider } = await import("./ChatViewProvider.js");
    const provider = new ChatViewProvider(
      { fsPath: "/tmp/ext" } as never,
      { get: vi.fn(), update: vi.fn() } as never,
    );
    let commandApprovalPolicy: "safe" | "approve-for-me" = "safe";
    let writeApproval: "prompt" | "session" = "prompt";
    provider.setApprovalManager({
      getAgentWriteApprovalState: vi.fn(() => writeApproval),
      setAgentWriteApprovalSelection: vi.fn(
        (_sessionId: string, selection: typeof writeApproval) => {
          writeApproval = selection;
          return true;
        },
      ),
      resetSessionAgentWriteApproval: vi.fn(),
      isAgentWriteApproved: vi.fn(() => writeApproval !== "prompt"),
      isFileWriteApproved: vi.fn(() => false),
      onDidChange: vi.fn(() => ({ dispose: vi.fn() })),
    } as never);
    const session = {
      id: "foreground-session",
      projectScope: {
        projectId: "project-a",
        displayName: "Project A",
        rootPath: "/workspace/project",
      },
      projectAvailability: "available",
    };
    provider.setSessionManager({
      getForegroundSession: vi.fn(() => session),
      getSession: vi.fn(() => session),
      getWorkspaceProjects: vi.fn(() => []),
      getCommandApprovalPolicy: vi.fn(() => commandApprovalPolicy),
      setCommandApprovalPolicy: vi.fn(
        (_sessionId: string, policy: typeof commandApprovalPolicy) => {
          commandApprovalPolicy = policy;
        },
      ),
    } as never);
    (provider as unknown as { sendInitialState: () => void }).sendInitialState =
      vi.fn();
    return provider;
  }

  it("auto-accepts pending file write cards when Approve for Me becomes active", async () => {
    const { withWorkspaceRoots } = await import("../util/paths.js");
    const provider = await makeWriteApprovalSweepProvider();

    const writeCard = provider.requestApproval(
      {
        kind: "write",
        title: "Modify `file.ts`?",
        targetPath: "/workspace/project/file.ts",
        fileWrite: { operation: "modify", outsideWorkspace: false },
        choices: [],
      },
      "foreground-session",
    );
    // Same kind but no fileWrite marker (e.g. image-generation billing card):
    // a write-authority grant must never resolve it.
    let billingResolved = false;
    void provider
      .requestApproval(
        {
          kind: "write",
          title: "Generate 1 image?",
          targetPath: "/workspace/project/out.png",
          choices: [
            { label: "Generate", value: "accept", isPrimary: true },
            { label: "Deny", value: "reject", isDanger: true },
          ],
        },
        "foreground-session",
      )
      .then(() => {
        billingResolved = true;
      });

    expect(
      withWorkspaceRoots(["/workspace/project"], () =>
        provider.submitBrowserSetCommandApprovalPolicy("approve-for-me"),
      ),
    ).toEqual({ ok: true });

    await expect(writeCard).resolves.toEqual({ decision: "accept" });
    await Promise.resolve();
    expect(billingResolved).toBe(false);
  });

  it("auto-accepts pending file write cards when session write approval is granted", async () => {
    const { withWorkspaceRoots } = await import("../util/paths.js");
    const provider = await makeWriteApprovalSweepProvider();

    const writeCard = provider.requestApproval(
      {
        kind: "write",
        title: "Create `new.ts`?",
        targetPath: "/workspace/project/new.ts",
        fileWrite: { operation: "create", outsideWorkspace: false },
        choices: [],
      },
      "foreground-session",
    );
    // Outside-workspace targets are not covered by session write approval.
    let outsideResolved = false;
    void provider
      .requestApproval(
        {
          kind: "write",
          title: "Modify `outside.ts`?",
          targetPath: "/elsewhere/outside.ts",
          fileWrite: { operation: "modify", outsideWorkspace: true },
          choices: [],
        },
        "foreground-session",
      )
      .then(() => {
        outsideResolved = true;
      });

    expect(
      withWorkspaceRoots(["/workspace/project"], () =>
        provider.submitBrowserSetWriteApproval("session"),
      ),
    ).toEqual({ ok: true });

    await expect(writeCard).resolves.toEqual({ decision: "accept" });
    await Promise.resolve();
    expect(outsideResolved).toBe(false);
  });

  it("auto-accepts queued approvals covered by an MCP server grant", async () => {
    const { ChatViewProvider } = await import("./ChatViewProvider.js");
    const provider = new ChatViewProvider(
      { fsPath: "/tmp/ext" } as never,
      { get: vi.fn(), update: vi.fn() } as never,
    );
    const approvedServers = new Set<string>();
    let onApprovalChange: (() => void) | undefined;
    provider.setApprovalManager({
      isMcpServerApproved: vi.fn((sessionId: string, serverName: string) =>
        approvedServers.has(`${sessionId}:${serverName}`),
      ),
      onDidChange: vi.fn((listener: () => void) => {
        onApprovalChange = listener;
        return { dispose: vi.fn() };
      }),
    } as never);
    provider.setSessionManager({
      getForegroundSession: vi.fn(() => undefined),
      getSession: vi.fn(() => undefined),
      getWorkspaceProjects: vi.fn(() => []),
    } as never);
    (provider as unknown as { sendInitialState: () => void }).sendInitialState =
      vi.fn();

    const approvedRequests = [
      provider.requestApproval(
        {
          id: "linear-create",
          kind: "mcp",
          title: "Allow linear create_issue?",
          mcpServerName: "linear",
          mcpToolName: "create_issue",
          choices: [],
        },
        "session-a",
      ),
      provider.requestApproval(
        {
          id: "linear-list",
          kind: "mcp",
          title: "Allow linear list_issues?",
          mcpServerName: "linear",
          mcpToolName: "list_issues",
          choices: [],
        },
        "session-a",
      ),
    ];
    let differentServerResolved = false;
    void provider
      .requestApproval(
        {
          id: "github-create",
          kind: "mcp",
          title: "Allow github create_issue?",
          mcpServerName: "github",
          mcpToolName: "create_issue",
          choices: [],
        },
        "session-a",
      )
      .then(() => {
        differentServerResolved = true;
      });
    let differentSessionResolved = false;
    void provider
      .requestApproval(
        {
          id: "linear-other-session",
          kind: "mcp",
          title: "Allow linear list_issues?",
          mcpServerName: "linear",
          mcpToolName: "list_issues",
          choices: [],
        },
        "session-b",
      )
      .then(() => {
        differentSessionResolved = true;
      });

    approvedServers.add("session-a:linear");
    onApprovalChange?.();

    await expect(Promise.all(approvedRequests)).resolves.toEqual([
      { decision: "allow-once" },
      { decision: "allow-once" },
    ]);
    const internals = provider as unknown as {
      pendingApprovals: Map<string, unknown>;
      activeApprovalRequests: Map<string, unknown>;
      approvalSessionById: Map<string, string>;
      approvalSessionIndex: Map<string, Set<string>>;
    };
    for (const id of ["linear-create", "linear-list"]) {
      expect(internals.pendingApprovals.has(id)).toBe(false);
      expect(internals.activeApprovalRequests.has(id)).toBe(false);
      expect(internals.approvalSessionById.has(id)).toBe(false);
      expect(internals.approvalSessionIndex.get("session-a")?.has(id)).toBe(
        false,
      );
    }

    expect(() => onApprovalChange?.()).not.toThrow();
    await Promise.resolve();
    expect(differentServerResolved).toBe(false);
    expect(differentSessionResolved).toBe(false);
  });

  it("updates browser write approval without resetting unrelated sessions", async () => {
    const { ChatViewProvider } = await import("./ChatViewProvider.js");
    const provider = new ChatViewProvider(
      { fsPath: "/tmp/ext" } as never,
      { get: vi.fn(), update: vi.fn() } as never,
    );
    let commandApprovalPolicy: "safe" | "approve-for-me" = "approve-for-me";
    let writeApproval: "prompt" | "session" | "project" | "global" = "prompt";
    const setAgentWriteApprovalSelection = vi.fn(
      (_sessionId: string, selection: typeof writeApproval) => {
        writeApproval = selection;
        return true;
      },
    );
    const setCommandApprovalPolicy = vi.fn(
      (_sessionId: string, policy: typeof commandApprovalPolicy) => {
        commandApprovalPolicy = policy;
      },
    );
    provider.setApprovalManager({
      getAgentWriteApprovalState: vi.fn(() => writeApproval),
      setAgentWriteApprovalSelection,
      resetSessionAgentWriteApproval: vi.fn(),
      onDidChange: vi.fn(() => ({ dispose: vi.fn() })),
    } as never);
    provider.setSessionManager({
      getForegroundSession: vi.fn(() => ({
        id: "foreground-session",
        projectScope: { rootPath: "/workspace/project" },
      })),
      getCommandApprovalPolicy: vi.fn(() => commandApprovalPolicy),
      setCommandApprovalPolicy,
    } as never);
    (provider as unknown as { sendInitialState: () => void }).sendInitialState =
      vi.fn();

    expect(provider.submitBrowserSetWriteApproval("session")).toEqual({
      ok: true,
    });
    expect(setAgentWriteApprovalSelection).toHaveBeenCalledWith(
      "foreground-session",
      "session",
      "/workspace/project",
    );
    expect(provider.submitBrowserSetWriteApproval("prompt")).toEqual({
      ok: true,
    });
    expect(setCommandApprovalPolicy).toHaveBeenCalledWith(
      "foreground-session",
      "safe",
    );
    expect(commandApprovalPolicy).toBe("safe");

    setAgentWriteApprovalSelection.mockReturnValueOnce(false);
    expect(provider.submitBrowserSetWriteApproval("project")).toEqual({
      ok: false,
    });
    expect(provider.submitBrowserSetWriteApproval("invalid")).toEqual({
      ok: false,
    });
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
      transcriptRevision: 27,
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
        transcriptRevision: 27,
        originalPrompt: "original task",
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

  it("projects the provider tool-call ID separately from the UI question ID", async () => {
    const { ChatViewProvider } = await import("./ChatViewProvider.js");
    const provider = new ChatViewProvider(
      { fsPath: "/tmp/ext" } as never,
      { get: vi.fn(), update: vi.fn() } as never,
    );
    const session = {
      id: "session-1",
      title: "Session 1",
      mode: "code",
      model: "claude-sonnet-4-6",
      status: "tool_executing",
      estimatedTotalUsed: 0,
      lastInputTokens: 0,
      lastOutputTokens: 0,
      getAllMessages: () => [] as unknown[],
    };
    provider.setSessionManager({
      getForegroundSession: vi.fn(() => session),
      getConfig: vi.fn(() => ({
        model: "claude-sonnet-4-6",
        autoCondenseThreshold: 0.8,
      })),
      getSessionInfos: vi.fn(() => []),
      getBgSessionInfos: vi.fn(() => []),
      clearPendingQuestionRecovery: vi.fn(),
      onEvent: undefined,
      onSessionsChanged: undefined,
    } as never);
    const questions = [
      { id: "continue", type: "yes_no" as const, question: "Continue?" },
    ];

    const response = provider.handleToolQuestion(
      "Need a decision.",
      questions,
      "session-1",
      undefined,
      undefined,
      "toolu-live-ask",
    );
    const questionRequest =
      provider.getBrowserProjectedForegroundState()?.questionRequest;

    expect(questionRequest).toMatchObject({
      toolCallId: "toolu-live-ask",
      context: "Need a decision.",
    });
    expect(questionRequest?.id).not.toBe("toolu-live-ask");
    if (!questionRequest)
      throw new Error("Expected a pending question request");
    (
      provider as unknown as {
        pendingQuestions: Map<string, (raw: unknown) => void>;
      }
    ).pendingQuestions.get(questionRequest.id)?.({
      answers: { continue: true },
      notes: {},
    });
    await expect(response).resolves.toMatchObject({
      answers: { continue: true },
    });
  });

  it("forwards pending ask_user recovery through the production tool question handler", async () => {
    const { ChatViewProvider } = await import("./ChatViewProvider.js");

    const provider = new ChatViewProvider(
      { fsPath: "/tmp/ext" } as never,
      { get: vi.fn(), update: vi.fn() } as never,
    );
    const session = {
      id: "session-1",
      title: "Session 1",
      mode: "code",
      model: "claude-sonnet-4-6",
      status: "tool_executing",
      estimatedTotalUsed: 0,
      lastInputTokens: 0,
      lastOutputTokens: 0,
      getAllMessages: () => [] as unknown[],
    };
    const persistPendingQuestionRecovery = vi.fn(
      async (..._args: unknown[]) => {},
    );
    const clearPendingQuestionRecovery = vi.fn();
    provider.setSessionManager({
      getForegroundSession: vi.fn(() => session),
      getConfig: vi.fn(() => ({
        model: "claude-sonnet-4-6",
        autoCondenseThreshold: 0.8,
      })),
      getSessionInfos: vi.fn(() => []),
      getBgSessionInfos: vi.fn(() => []),
      persistPendingQuestionRecovery,
      clearPendingQuestionRecovery,
      onEvent: undefined,
      onSessionsChanged: undefined,
    } as never);
    const questions = [
      {
        id: "choice",
        type: "multiple_choice" as const,
        question: "Which path?",
        options: ["A", "B"],
      },
    ];
    const pendingQuestionRecovery = {
      schemaVersion: 1 as const,
      assistantContent: [
        {
          type: "tool_use" as const,
          id: "toolu-1",
          name: "ask_user",
          input: { context: "Pick one.", questions },
        },
      ],
      toolUseId: "toolu-1",
      toolName: "ask_user" as const,
      toolInput: { context: "Pick one.", questions },
    };

    const response = provider.handleToolQuestion(
      "Pick one.",
      questions,
      "session-1",
      undefined,
      pendingQuestionRecovery,
    );

    expect(persistPendingQuestionRecovery).toHaveBeenCalledWith(
      "session-1",
      expect.any(String),
      "Pick one.",
      questions,
      pendingQuestionRecovery,
    );
    const questionRequestId = persistPendingQuestionRecovery.mock.calls[0]?.[1];
    if (typeof questionRequestId !== "string") {
      throw new Error("Expected a persisted question request ID");
    }
    const pendingQuestions = (
      provider as unknown as {
        pendingQuestions: Map<string, (raw: unknown) => void>;
      }
    ).pendingQuestions;
    pendingQuestions.get(questionRequestId)?.({
      answers: { choice: "A" },
      notes: {},
    });

    await expect(response).resolves.toEqual({
      answers: { choice: "A" },
      notes: {},
      attachments: undefined,
    });
    expect(clearPendingQuestionRecovery).toHaveBeenCalledWith(
      "session-1",
      questionRequestId,
    );
  });

  it("uses the recovery-preserving question handler in extension composition", () => {
    const extensionSource = fs.readFileSync("src/extension.ts", "utf8");

    // A shorter callback is type-compatible and silently drops the optional
    // recovery argument, so keep the production composition on the typed handler.
    expect(extensionSource).toMatch(
      /\bonQuestion:\s*chatViewProvider\.handleToolQuestion\b/,
    );
  });

  it("routes browser and VS Code retries through the same manager path", async () => {
    const { ChatViewProvider } = await import("./ChatViewProvider.js");
    const provider = new ChatViewProvider(
      { fsPath: "/tmp/ext" } as never,
      { get: vi.fn(), update: vi.fn() } as never,
    );
    const session = {
      id: "session-1",
      background: false,
      status: "error",
    };
    let resolveRetry: (() => void) | undefined;
    const retrySession = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRetry = resolve;
        }),
    );
    provider.setSessionManager({
      getSession: vi.fn((sessionId: string) =>
        sessionId === session.id ? session : undefined,
      ),
      getForegroundSession: vi.fn(() => session),
      getConfig: vi.fn(() => ({
        model: "claude-sonnet-4-6",
        autoCondenseThreshold: 0.8,
      })),
      getSessionInfos: vi.fn(() => []),
      getBgSessionInfos: vi.fn(() => []),
      retrySession,
      onEvent: undefined,
      onSessionsChanged: undefined,
    } as never);
    const internals = provider as unknown as {
      applyProjectedAction: ReturnType<typeof vi.fn>;
      buildChatState: ReturnType<typeof vi.fn>;
      postMessage: ReturnType<typeof vi.fn>;
    };
    internals.applyProjectedAction = vi.fn();
    internals.buildChatState = vi.fn(() => ({ sessionId: "session-1" }));
    internals.postMessage = vi.fn();

    expect(provider.submitBrowserRetry("session-1")).toEqual({ ok: true });
    expect(internals.applyProjectedAction).toHaveBeenCalledWith({
      type: "CLEAR_ERROR",
    });
    expect(retrySession).toHaveBeenCalledWith("session-1");
    expect(internals.postMessage).not.toHaveBeenCalled();
    expect(provider.submitBrowserRetry("session-1")).toEqual({
      ok: false,
      error: "retry_in_progress",
    });
    expect(provider.submitBrowserRetry("missing-session")).toEqual({
      ok: false,
      error: "session_not_found",
    });
    expect(retrySession).toHaveBeenCalledTimes(1);

    resolveRetry?.();
    await vi.waitFor(() => {
      session.status = "idle";
      expect(provider.submitBrowserRetry("session-1")).toEqual({
        ok: false,
        error: "session_not_retryable",
      });
    });
  });

  it("routes an eligible browser resume through interrupted-session recovery", async () => {
    const { ChatViewProvider } = await import("./ChatViewProvider.js");
    const provider = new ChatViewProvider(
      { fsPath: "/tmp/ext" } as never,
      { get: vi.fn(), update: vi.fn() } as never,
    );
    const session = {
      id: "session-1",
      background: false,
      status: "idle",
      runState: { phase: "running", startedAt: 123 },
    };
    const resumeInterruptedSession = vi.fn(async () => true);
    provider.setSessionManager({
      getSession: vi.fn(() => session),
      getForegroundSession: vi.fn(() => session),
      getConfig: vi.fn(() => ({
        model: "claude-sonnet-4-6",
        autoCondenseThreshold: 0.8,
      })),
      getSessionInfos: vi.fn(() => []),
      getBgSessionInfos: vi.fn(() => []),
      resumeInterruptedSession,
      onEvent: undefined,
      onSessionsChanged: undefined,
    } as never);

    await expect(provider.submitBrowserResume("session-1")).resolves.toEqual({
      ok: true,
    });
    expect(resumeInterruptedSession).toHaveBeenCalledWith("session-1");

    session.runState = {
      phase: "awaiting_question",
      startedAt: 124,
    } as never;
    await expect(provider.submitBrowserResume("session-1")).resolves.toEqual({
      ok: false,
      error: "session_not_interrupted",
    });
  });

  it("reports when interrupted-session resume admission is rejected", async () => {
    const { ChatViewProvider } = await import("./ChatViewProvider.js");
    const provider = new ChatViewProvider(
      { fsPath: "/tmp/ext" } as never,
      { get: vi.fn(), update: vi.fn() } as never,
    );
    provider.setSessionManager({
      getSession: vi.fn(() => ({
        id: "session-1",
        background: false,
        status: "idle",
        runState: { phase: "running", startedAt: 123 },
      })),
      getForegroundSession: vi.fn(() => undefined),
      getConfig: vi.fn(() => ({
        model: "claude-sonnet-4-6",
        autoCondenseThreshold: 0.8,
      })),
      getSessionInfos: vi.fn(() => []),
      getBgSessionInfos: vi.fn(() => []),
      resumeInterruptedSession: vi.fn(async () => false),
      onEvent: undefined,
      onSessionsChanged: undefined,
    } as never);

    await expect(provider.submitBrowserResume("session-1")).resolves.toEqual({
      ok: false,
      error: "resume_not_started",
    });
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
    const session = {
      id: "session-1",
      mode: "code",
      model: "claude-sonnet-4-6",
      status: "idle",
      title: "Recovered session",
      estimatedTotalUsed: 0,
      lastInputTokens: 0,
      lastOutputTokens: 0,
      getAllMessages: vi.fn(() => [] as AgentMessage[]),
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
      mode: "code",
      model: "claude-sonnet-4-6",
      status: "idle",
      title: "Recovered session",
      estimatedTotalUsed: 0,
      lastInputTokens: 0,
      lastOutputTokens: 0,
      getAllMessages: vi.fn(() => [] as AgentMessage[]),
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

  it("resyncs both surfaces with the recovered ask_user turn after answering", async () => {
    const { ChatViewProvider } = await import("./ChatViewProvider.js");

    const provider = new ChatViewProvider(
      { fsPath: "/tmp/ext" } as never,
      { get: vi.fn(), update: vi.fn() } as never,
    );
    (provider as unknown as { view: unknown }).view = {
      webview: { postMessage: mockPostMessage },
    };
    (provider as unknown as { webviewReady: boolean }).webviewReady = true;

    const askUserResult = JSON.stringify({
      context: "Pick one.",
      responses: [{ question: "Which option?", answer: "A" }],
    });
    const recoveredMessages = [
      { role: "user", content: "original task" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu-ask-1",
            name: "ask_user",
            input: { context: "Pick one." },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu-ask-1",
            content: askUserResult,
          },
        ],
      },
    ] as unknown as AgentMessage[];
    const session = {
      id: "session-1",
      mode: "code",
      model: "claude-sonnet-4-6",
      status: "idle",
      title: "Recovered session",
      estimatedTotalUsed: 0,
      lastInputTokens: 0,
      lastOutputTokens: 0,
      getAllMessages: vi.fn(() => [] as AgentMessage[]),
    };
    const manager = {
      getForegroundSession: vi.fn(() => session),
      getPendingQuestionRecovery: vi.fn(() => ({
        questionRequestId: "question-1",
      })),
      // Production appends the recovered ask_user turn to session history
      // before resolving; simulate that so the resync has it to project.
      answerRecoveredQuestion: vi.fn(async () => {
        session.getAllMessages = vi.fn(() => recoveredMessages);
        return true;
      }),
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
      answers: { q1: "A" },
      notes: {},
    });

    expect(accepted).toBe(true);

    // VS Code webview boundary: the resync posts the recovered turn.
    const loaded = mockPostMessage.mock.calls.find(
      ([message]) =>
        message.type === "agentSessionLoaded" &&
        message.sessionId === "session-1",
    )?.[0];
    expect(loaded).toBeDefined();
    expect(JSON.stringify(loaded?.messages)).toContain("ask_user");
    expect(JSON.stringify(loaded?.messages)).toContain("toolu-ask-1");

    // Browser surface boundary: the projected foreground snapshot renders the
    // recovered tool call and its answer summary.
    const snapshot = provider.getBrowserProjectedForegroundState();
    const blocks =
      snapshot?.projectedMessages.flatMap((message) => message.blocks) ?? [];
    expect(
      blocks.some(
        (block) => block.type === "tool_call" && block.name === "ask_user",
      ),
    ).toBe(true);
    expect(blocks.some((block) => block.type === "question_answer")).toBe(true);
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

  it("opens /memory locally and derives project scope in the host", async () => {
    const { ChatViewProvider } = await import("./ChatViewProvider.js");
    const provider = new ChatViewProvider(
      { fsPath: "/tmp/ext" } as never,
      { get: vi.fn(), update: vi.fn() } as never,
    );
    const session = {
      id: "session-memory",
      mode: "code",
      model: "test-model",
      status: "idle",
      projectScope: {
        projectId: "project-host",
        workspaceFolderUri: "file:///workspace/host",
        displayName: "Host project",
        rootPath: "/workspace/host",
      },
    };
    const sendMessage = vi.fn();
    provider.setSessionManager({
      getForegroundSession: vi.fn(() => session),
      getSession: vi.fn(() => session),
      getWorkspaceProjects: vi.fn(() => [session.projectScope]),
      sendMessage,
      onEvent: undefined,
      onSessionsChanged: undefined,
    } as never);
    const health = {
      status: "ready" as const,
      retrieval: "lexical-only" as const,
      crud: true,
      dedupe: true,
      conflict: true,
      auditUndo: true,
      recordCount: 0,
      activeRecordCount: 0,
      auditEventCount: 0,
    };
    const query = vi.fn(async () => ({
      result: { records: [], total: 0 },
      health,
    }));
    const activity = vi.fn(async () => ({ events: [], health }));
    const manageAsUser = vi.fn();
    const clearScope = vi.fn();
    const importArchive = vi.fn();
    (
      provider as unknown as { sendInitialState: ReturnType<typeof vi.fn> }
    ).sendInitialState = vi.fn();
    (
      provider as unknown as { postMessage: ReturnType<typeof vi.fn> }
    ).postMessage = mockPostMessage;
    provider.setContextHealthSources({
      memory: { health: vi.fn(async () => health) },
      memoryInspection: {
        health: vi.fn(async () => health),
        query,
        activity,
        detail: vi.fn(async () => ({ detail: null, health })),
        manageAsUser,
        clearScope,
        exportArchive: vi.fn(),
        importArchive,
      },
      retrieval: {
        health: vi.fn(async () => ({
          status: "unavailable" as const,
          lexical: "unavailable" as const,
          scalar: "unavailable" as const,
          vector: "not_configured" as const,
          structural: "unavailable" as const,
          embeddingCredentials: "not_required" as const,
          reasons: ["generic_error" as const],
          fingerprintDisposition: "initialize" as const,
          pendingPublications: 0,
          sourceCount: 0,
          chunkCount: 0,
          relationCount: 0,
          staleSourceCount: 0,
        })),
      },
      semanticIndexEnabled: false,
    });
    mockPostMessage.mockClear();

    await (
      provider as unknown as {
        handleWebviewMessage(message: Record<string, unknown>): Promise<void>;
      }
    ).handleWebviewMessage({
      command: "agentSlashCommand",
      name: "memory",
      args: "",
    });

    expect(query).toHaveBeenCalledWith({ scope: "global", limit: 100 });
    expect(activity).toHaveBeenCalledWith({ scope: "global", limit: 50 });
    expect(mockPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "agentMemoryPanelUpdate",
        open: true,
        scope: "global",
        availableScopes: ["global", "project"],
        snapshot: expect.objectContaining({ records: [], total: 0, health }),
      }),
    );
    expect(sendMessage).not.toHaveBeenCalled();

    mockPostMessage.mockClear();
    await (
      provider as unknown as {
        handleWebviewMessage(message: Record<string, unknown>): Promise<void>;
      }
    ).handleWebviewMessage({
      command: "agentMemoryQuery",
      requestId: "memory-request-1",
      open: true,
      request: {
        scope: "project",
        projectId: "project-forged",
        query: "concise",
        limit: 500,
      },
    });

    expect(query).toHaveBeenLastCalledWith({
      scope: "project",
      projectId: "project-host",
      query: "concise",
      limit: 200,
    });
    expect(activity).toHaveBeenLastCalledWith({
      scope: "project",
      projectId: "project-host",
      limit: 50,
    });
    expect(mockPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "agentMemoryPanelUpdate",
        requestId: "memory-request-1",
        open: true,
        scope: "project",
        availableScopes: ["global", "project"],
      }),
    );
    expect(sendMessage).not.toHaveBeenCalled();

    for (const failure of [
      {
        operation: manageAsUser,
        message: {
          command: "agentMemoryManage",
          requestId: "memory-manage-failure",
          input: {
            operation: "forget",
            scope: "global",
            target_id: "memory-private",
            source_evidence: "User selected forget.",
          },
          request: { scope: "global" },
        },
        requestId: "memory-manage-failure",
      },
      {
        operation: clearScope,
        message: {
          command: "agentMemoryClear",
          requestId: "memory-clear-failure",
          scope: "global",
          confirm: true,
          request: { scope: "global" },
        },
        requestId: "memory-clear-failure",
      },
      {
        operation: importArchive,
        message: {
          command: "agentMemoryImport",
          requestId: "memory-import-failure",
          scope: "global",
          archive: {},
          request: { scope: "global" },
        },
        requestId: "memory-import-failure",
      },
    ]) {
      failure.operation.mockRejectedValueOnce(
        new Error("private memory path /Users/test/autonomous-memory"),
      );
      mockPostMessage.mockClear();
      await (
        provider as unknown as {
          handleWebviewMessage(message: Record<string, unknown>): Promise<void>;
        }
      ).handleWebviewMessage(failure.message);
      expect(mockPostMessage).toHaveBeenCalledWith({
        type: "agentMemoryPanelUpdate",
        requestId: failure.requestId,
        scope: "global",
        availableScopes: ["global", "project"],
        error: "The memory operation could not be completed.",
      });
      expect(JSON.stringify(mockPostMessage.mock.calls)).not.toContain(
        "/Users/test/autonomous-memory",
      );
    }
  });

  it("runs context doctor through the shared provider action without a model request", async () => {
    const { ChatViewProvider } = await import("./ChatViewProvider.js");
    const provider = new ChatViewProvider(
      { fsPath: "/tmp/ext" } as never,
      { get: vi.fn(), update: vi.fn() } as never,
    );
    const appendAssistantMessage = vi.fn();
    const session = {
      id: "session-doctor",
      mode: "code",
      model: "test-model",
      status: "idle",
      lastInputTokens: 4_200,
      lastOutputTokens: 300,
      lastCacheReadTokens: 1_000,
      contextBreakdown: {
        prompt: {
          sections: [{ label: "system", chars: 400, estimatedTokens: 100 }],
          totalChars: 400,
          estimatedTokens: 100,
          profile: "compatibility",
          profileSource: "compatibility-default",
        },
      },
      toolResultContextAttributions: [],
      omittedToolResultContextAttributions: 0,
      projectScope: {
        projectId: "project-doctor",
        workspaceFolderUri: "file:///workspace/doctor",
        displayName: "Doctor",
        rootPath: "/workspace/doctor",
      },
      getAllMessages: vi.fn(() => [
        { role: "user", content: "Inspect context" },
      ]),
      appendAssistantMessage,
    };
    const saveSession = vi.fn();
    const sendMessage = vi.fn();
    const getSession = vi.fn<(sessionId: string) => typeof session | undefined>(
      () => session,
    );
    const manager = {
      getForegroundSession: vi.fn(() => session),
      getSession,
      getWorkspaceProjects: vi.fn(() => [{ id: "project-doctor" }]),
      getCheckpoints: vi.fn(() => []),
      saveSession,
      sendMessage,
      onEvent: undefined,
      onSessionsChanged: undefined,
    };
    provider.setSessionManager(manager as never);
    const postSessionLoaded = vi.fn();
    (
      provider as unknown as {
        postSessionLoaded: (session: unknown, options: unknown) => void;
      }
    ).postSessionLoaded = postSessionLoaded;

    expect(provider.runContextDoctor("session-doctor")).toEqual({ ok: true });
    expect(appendAssistantMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "assistant",
        diagnosticOnly: true,
        content: [
          expect.objectContaining({
            type: "text",
            text: expect.stringContaining("# Context Doctor"),
          }),
        ],
      }),
    );
    expect(saveSession).toHaveBeenCalledWith("session-doctor");
    expect(postSessionLoaded).toHaveBeenCalledWith(session, {
      checkpoints: undefined,
      tailTurns: 0,
    });

    appendAssistantMessage.mockClear();
    saveSession.mockClear();
    postSessionLoaded.mockClear();
    await expect(
      provider.submitBrowserSend({
        text: "/context-doctor",
        sessionId: "session-doctor",
        projectId: "project-doctor",
        mode: "code",
        isSlashCommand: true,
        slashCommandLabel: "/context-doctor",
      }),
    ).resolves.toEqual({ ok: true });
    expect(appendAssistantMessage).toHaveBeenCalledTimes(1);
    expect(saveSession).toHaveBeenCalledWith("session-doctor");
    expect(postSessionLoaded).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(
      mockPostMessage.mock.calls.some(
        ([message]) => message.type === "agentCommittedUserMessage",
      ),
    ).toBe(false);
    expect(provider.runContextDoctor("other-session")).toEqual({
      ok: false,
      error: "session_not_foreground",
    });

    for (const status of [
      "queued",
      "streaming",
      "tool_executing",
      "awaiting_approval",
    ]) {
      (session as { status: string }).status = status;
      expect(provider.runContextDoctor("session-doctor")).toEqual({
        ok: false,
        error: "session_busy",
      });
    }
    expect(appendAssistantMessage).toHaveBeenCalledTimes(1);

    (session as { status: string }).status = "idle";
    (
      session as {
        projectScope: {
          projectId: string;
          workspaceFolderUri: string;
          displayName: string;
          rootPath?: string;
        };
      }
    ).projectScope = {
      projectId: "projectless",
      workspaceFolderUri: "agentlink://projectless",
      displayName: "No folder",
    };
    expect(provider.runContextDoctor("session-doctor")).toEqual({
      ok: false,
      error: "workspace_session_required",
    });

    (session as { status: string }).status = "queued";
    await (
      provider as unknown as {
        handleWebviewMessage(message: Record<string, unknown>): Promise<void>;
      }
    ).handleWebviewMessage({
      command: "agentSlashCommand",
      name: "context-doctor",
      args: "",
    });
    expect(mockShowInformationMessage).toHaveBeenCalledWith(
      "Context Doctor requires a workspace session.",
    );

    (session as { status: string }).status = "idle";
    getSession.mockReturnValueOnce(undefined);
    await expect(
      provider.submitBrowserSend({
        text: "/context-doctor",
        sessionId: "missing-session",
        mode: "code",
      }),
    ).resolves.toEqual({ ok: false, error: "no_active_session" });
    expect(sendMessage).not.toHaveBeenCalled();
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

  it("does not drain the foreground browser queue when another session completes", async () => {
    const { ChatViewProvider } = await import("./ChatViewProvider.js");
    const provider = new ChatViewProvider(
      { fsPath: "/tmp/ext" } as never,
      { get: vi.fn(), update: vi.fn() } as never,
    );
    const sessionA = {
      id: "session-a",
      mode: "code",
      model: "claude-sonnet-4-6",
      status: "streaming",
      title: "Session A",
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
    };
    const sessionB = {
      ...sessionA,
      id: "session-b",
      status: "streaming",
      title: "Session B",
      getAllMessages: () => [] as unknown[],
      setPendingInterjection: vi.fn(),
    };
    const sendMessage = vi.fn(async () => undefined);
    const manager = {
      getForegroundSession: vi.fn(() => sessionB),
      getSession: vi.fn((sessionId: string) =>
        sessionId === sessionA.id ? sessionA : sessionB,
      ),
      getConfig: vi.fn(() => ({
        model: "claude-sonnet-4-6",
        autoCondenseThreshold: 0.8,
      })),
      getSessionInfos: vi.fn(() => []),
      getBgSessionInfos: vi.fn(() => []),
      sendMessage,
      onEvent: undefined,
      onSessionsChanged: undefined,
    };
    provider.setSessionManager(manager as never);

    await provider.submitBrowserSend({
      text: "message for session B",
      sessionId: sessionB.id,
      mode: "code",
    });

    (
      provider as unknown as {
        drainBrowserQueuedMessage(sessionId: string): void;
      }
    ).drainBrowserQueuedMessage(sessionA.id);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(
      provider.getBrowserProjectedForegroundState()?.messageQueue,
    ).toMatchObject([
      {
        text: "message for session B",
        source: "browser",
      },
    ]);
  });

  it("sends browser workspace image attachments as model media", async () => {
    const projectRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "agentlink-browser-image-"),
    );
    const imageBytes = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00,
    ]);
    fs.writeFileSync(path.join(projectRoot, "canteen.png"), imageBytes);

    try {
      const { ChatViewProvider } = await import("./ChatViewProvider.js");
      const provider = new ChatViewProvider(
        { fsPath: "/tmp/ext" } as never,
        { get: vi.fn(), update: vi.fn() } as never,
      );
      const session = {
        id: "session-1",
        mode: "code",
        model: "claude-sonnet-4-6",
        status: "idle",
        reasoningEffort: "high",
        estimatedTotalUsed: 0,
        lastInputTokens: 0,
        lastOutputTokens: 0,
        activeFilePath: undefined,
        projectScope: {
          projectId: "project-a",
          workspaceFolderUri: `file://${projectRoot}`,
          displayName: "Project A",
          rootPath: projectRoot,
        },
        projectAvailability: "available",
      };
      const sendMessage = vi.fn(async () => undefined);
      provider.setSessionManager({
        getForegroundSession: vi.fn(() => session),
        getSession: vi.fn(() => session),
        getConfig: vi.fn(() => ({
          model: "claude-sonnet-4-6",
          autoCondenseThreshold: 0.8,
        })),
        getSessionInfos: vi.fn(() => []),
        getBgSessionInfos: vi.fn(() => []),
        sendMessage,
      } as never);

      await expect(
        provider.submitBrowserSend({
          text: "[Attached: canteen.png]\n\nInspect this image",
          displayText: "[Attached: canteen.png]\n\nInspect this image",
          attachments: ["canteen.png"],
          sessionId: "session-1",
          projectId: "project-a",
          mode: "code",
        }),
      ).resolves.toEqual({ ok: true });

      expect(sendMessage).toHaveBeenCalledWith(
        "session-1",
        "Inspect this image",
        "code",
        expect.objectContaining({
          images: [
            {
              name: "canteen.png",
              mimeType: "image/png",
              base64: imageBytes.toString("base64"),
            },
          ],
        }),
      );
      expect(JSON.stringify(sendMessage.mock.calls)).not.toContain("\uFFFD");
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("sends VS Code workspace image attachments as model media", async () => {
    const projectRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "agentlink-vscode-image-"),
    );
    const imageBytes = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00,
    ]);
    fs.writeFileSync(path.join(projectRoot, "canteen.png"), imageBytes);

    try {
      const { ChatViewProvider } = await import("./ChatViewProvider.js");
      const provider = new ChatViewProvider(
        { fsPath: "/tmp/ext" } as never,
        { get: vi.fn(), update: vi.fn() } as never,
      );
      const session = {
        id: "session-1",
        mode: "code",
        model: "claude-sonnet-4-6",
        status: "idle",
        reasoningEffort: "high",
        estimatedTotalUsed: 0,
        lastInputTokens: 0,
        lastOutputTokens: 0,
        activeFilePath: undefined,
        projectScope: {
          projectId: "project-a",
          workspaceFolderUri: `file://${projectRoot}`,
          displayName: "Project A",
          rootPath: projectRoot,
        },
        projectAvailability: "available",
      };
      const sendMessage = vi.fn(async () => undefined);
      provider.setSessionManager({
        getForegroundSession: vi.fn(() => session),
        getSession: vi.fn(() => session),
        getWorkspaceProjects: vi.fn(() => [
          {
            id: "project-a",
            name: "Project A",
            uri: `file://${projectRoot}`,
            rootPath: projectRoot,
            availability: { status: "available" },
          },
        ]),
        getConfig: vi.fn(() => ({
          model: "claude-sonnet-4-6",
          autoCondenseThreshold: 0.8,
        })),
        getSessionInfos: vi.fn(() => []),
        getBgSessionInfos: vi.fn(() => []),
        sendMessage,
      } as never);

      await (
        provider as unknown as {
          handleWebviewMessage(message: Record<string, unknown>): Promise<void>;
        }
      ).handleWebviewMessage({
        command: "agentSend",
        text: "[Attached: canteen.png]\n\nInspect this image",
        displayText: "[Attached: canteen.png]\n\nInspect this image",
        attachments: ["canteen.png"],
        sessionId: "session-1",
        mode: "code",
      });

      expect(sendMessage).toHaveBeenCalledWith(
        "session-1",
        "Inspect this image",
        "code",
        expect.objectContaining({
          origin: "vscode",
          images: [
            {
              name: "canteen.png",
              mimeType: "image/png",
              base64: imageBytes.toString("base64"),
            },
          ],
        }),
      );
      expect(JSON.stringify(sendMessage.mock.calls)).not.toContain("\uFFFD");
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
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

  it("interrupts only the foreground turn when steering a queued message", async () => {
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
      reasoningEffort: "high",
      estimatedTotalUsed: 0,
      lastInputTokens: 0,
      lastOutputTokens: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
      activeFilePath: undefined,
      projectScope: {
        projectId: "project-a",
        workspaceFolderUri: "file:///workspace/a",
        displayName: "Project A",
        rootPath: "/workspace/a",
      },
      projectAvailability: "available",
    };
    const interruptSession = vi.fn();
    const stopSession = vi.fn();
    const sendMessage = vi.fn(async () => undefined);
    provider.setSessionManager({
      getForegroundSession: vi.fn(() => session),
      getSession: vi.fn(() => session),
      getConfig: vi.fn(() => ({
        model: "claude-sonnet-4-6",
        autoCondenseThreshold: 0.8,
      })),
      getSessionInfos: vi.fn(() => []),
      getBgSessionInfos: vi.fn(() => []),
      interruptSession,
      stopSession,
      sendMessage,
    } as never);

    await (
      provider as unknown as {
        steerQueuedMessageFromUi(input: {
          sessionId: string;
          queueId: string;
          text: string;
          attachments: string[];
          images: Array<{ name: string; mimeType: string; base64: string }>;
          documents: Array<{ name: string; mimeType: string; base64: string }>;
        }): Promise<void>;
      }
    ).steerQueuedMessageFromUi({
      sessionId: session.id,
      queueId: "queue-1",
      text: "change direction",
      attachments: [],
      images: [],
      documents: [],
    });

    expect(interruptSession).toHaveBeenCalledWith(session.id);
    expect(stopSession).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(
      session.id,
      "change direction",
      "code",
      expect.any(Object),
    );
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

  it("clears optimistic interjection readiness when registration is rejected", async () => {
    const { ChatViewProvider } = await import("./ChatViewProvider.js");

    const provider = new ChatViewProvider(
      { fsPath: "/tmp/ext" } as never,
      { get: vi.fn(), update: vi.fn() } as never,
    );
    const session = { id: "session-1", status: "idle" };
    provider.setSessionManager({
      getForegroundSession: vi.fn(() => session),
      getSession: vi.fn(() => session),
    } as never);
    const postMessage = vi.fn();
    (provider as unknown as { postMessage: typeof postMessage }).postMessage =
      postMessage;

    await (
      provider as unknown as {
        handleWebviewMessage(msg: Record<string, unknown>): Promise<void>;
      }
    ).handleWebviewMessage({
      command: "agentInterjectQueuedMessage",
      sessionId: "session-1",
      queueId: "queue-1",
      text: "interject this",
    });

    expect(postMessage).toHaveBeenCalledWith({
      type: "agentQueueInterjectionReady",
      sessionId: "session-1",
      queueId: "queue-1",
      ready: false,
    });
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

  /**
   * Session stub replicating AgentSession's pending-interjection FIFO
   * semantics so webview message sequences can be verified end to end.
   */
  function createPendingInterjectionSession() {
    type Entry = {
      text: string;
      queueId: string;
      messageId?: string;
      displayText?: string;
      isSlashCommand?: boolean;
      slashCommandLabel?: string;
      attachments?: string[];
      images?: Array<{ name: string; mimeType: string; base64: string }>;
      documents?: Array<{ name: string; mimeType: string; base64: string }>;
    };
    const pending: Entry[] = [];
    return {
      id: "session-1",
      status: "tool_executing",
      setPendingInterjection(
        text: string,
        queueId: string,
        messageId?: string,
        displayText?: string,
        isSlashCommand?: boolean,
        slashCommandLabel?: string,
        attachments?: string[],
        images?: Entry["images"],
        documents?: Entry["documents"],
      ): boolean {
        const entry: Entry = {
          text,
          queueId,
          messageId,
          displayText,
          isSlashCommand,
          slashCommandLabel,
          attachments,
          images,
          documents,
        };
        const index = pending.findIndex((item) => item.queueId === queueId);
        if (index >= 0) pending[index] = entry;
        else pending.push(entry);
        return true;
      },
      updatePendingInterjection(
        queueId: string,
        updates: Omit<Entry, "queueId">,
      ): boolean {
        const index = pending.findIndex((item) => item.queueId === queueId);
        if (index < 0) return false;
        pending[index] = { queueId, ...updates };
        return true;
      },
      clearPendingInterjectionIf(queueId: string): Entry | null {
        const index = pending.findIndex((item) => item.queueId === queueId);
        if (index < 0) return null;
        return pending.splice(index, 1)[0];
      },
      consumePendingInterjection(): Entry | null {
        return pending.shift() ?? null;
      },
      setQueuedUiMessageCount: vi.fn(),
      pending,
    };
  }

  it("consumes the edited text after the webview edit sequence for a pending interjection", async () => {
    const { ChatViewProvider } = await import("./ChatViewProvider.js");

    const provider = new ChatViewProvider(
      { fsPath: "/tmp/ext" } as never,
      { get: vi.fn(), update: vi.fn() } as never,
    );
    const session = createPendingInterjectionSession();
    provider.setSessionManager({
      getForegroundSession: vi.fn(() => session),
      getSession: vi.fn(() => session),
    } as never);
    (
      provider as unknown as { postMessage: ReturnType<typeof vi.fn> }
    ).postMessage = vi.fn();

    const handle = (msg: Record<string, unknown>) =>
      (
        provider as unknown as {
          handleWebviewMessage(msg: Record<string, unknown>): Promise<void>;
        }
      ).handleWebviewMessage(msg);

    // Interject → pause (edit starts) → update (edit saved) → resume.
    await handle({
      command: "agentInterjectQueuedMessage",
      sessionId: "session-1",
      queueId: "queue-1",
      text: "original message",
      displayText: "original message",
    });
    await handle({
      command: "agentPauseQueuedMessageInterjection",
      sessionId: "session-1",
      queueId: "queue-1",
    });
    await handle({
      command: "agentUpdateQueuedMessage",
      sessionId: "session-1",
      queueId: "queue-1",
      text: "edited message",
      displayText: "edited message",
    });
    await handle({
      command: "agentInterjectQueuedMessage",
      sessionId: "session-1",
      queueId: "queue-1",
      text: "edited message",
      displayText: "edited message",
    });

    const consumed = session.consumePendingInterjection();
    expect(consumed).toMatchObject({
      queueId: "queue-1",
      text: "edited message",
    });
    expect(session.consumePendingInterjection()).toBeNull();
  });

  it("clears a pending interjection when the webview removes the queued message", async () => {
    const { ChatViewProvider } = await import("./ChatViewProvider.js");

    const provider = new ChatViewProvider(
      { fsPath: "/tmp/ext" } as never,
      { get: vi.fn(), update: vi.fn() } as never,
    );
    const session = createPendingInterjectionSession();
    provider.setSessionManager({
      getForegroundSession: vi.fn(() => session),
      getSession: vi.fn(() => session),
    } as never);
    (
      provider as unknown as { postMessage: ReturnType<typeof vi.fn> }
    ).postMessage = vi.fn();

    const handle = (msg: Record<string, unknown>) =>
      (
        provider as unknown as {
          handleWebviewMessage(msg: Record<string, unknown>): Promise<void>;
        }
      ).handleWebviewMessage(msg);

    await handle({
      command: "agentInterjectQueuedMessage",
      sessionId: "session-1",
      queueId: "queue-1",
      text: "delete me",
      displayText: "delete me",
    });
    expect(session.pending).toHaveLength(1);

    await handle({
      command: "agentRemoveQueuedMessage",
      sessionId: "session-1",
      queueId: "queue-1",
    });

    expect(session.pending).toHaveLength(0);
    expect(session.consumePendingInterjection()).toBeNull();
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
      getWorkspaceProjects: vi.fn(() => [
        {
          id: "project-1",
          name: "Project",
          uri: "file:///tmp/project",
          rootPath: "/tmp/project",
          availability: { status: "available" },
        },
      ]),
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

  it("stamps session mode and command approval policy through api_request into the projected transcript", async () => {
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
      title: "Session",
      mode: "architect",
      model: "claude-sonnet-4-6",
      status: "streaming",
      background: false,
      lastInputTokens: 0,
      lastOutputTokens: 0,
      estimatedTotalUsed: 0,
      getAllMessages: () => [
        {
          role: "assistant",
          content: [{ type: "text", text: "Prior response" }],
        },
      ],
    };
    const manager = {
      getForegroundSession: vi.fn(() => session),
      getSession: vi.fn(() => session),
      getCommandApprovalPolicy: vi.fn(() => "approve-for-me"),
      onEvent: undefined,
      onSessionsChanged: undefined,
    };
    provider.setSessionManager(manager as never);
    const recordContextUsage = vi.fn();
    provider.setContextUsageTelemetry({ record: recordContextUsage } as never);

    const handleAgentEvent = (
      provider as unknown as {
        handleAgentEvent: (
          sessionId: string,
          event: Record<string, unknown>,
        ) => void;
      }
    ).handleAgentEvent;
    handleAgentEvent.call(provider, "session-1", {
      type: "request_context_attribution",
      requestId: "request-1",
      requestKind: "agent",
      model: "claude-sonnet-4-6",
      estimatedInputTokens: 99,
      toolResultContextAttributions: [
        {
          toolCallId: "call-distinctive",
          toolName: "read_file",
          chars: 321,
          bytes: 654,
          estimatedTokens: 87,
        },
      ],
      omittedToolResultContextAttributions: 3,
      pinnedMemoryTokens: 456,
      retrievedMemoryTokens: 789,
      contextLedger: {
        contextWindowTokens: 200_000,
        maxInputTokens: 180_000,
        outputReservationTokens: 16_000,
        safetyBufferTokens: 9_000,
        hardInputLimitTokens: 171_000,
        requestedInputTokens: 99,
        allocatedInputTokens: 99,
        remainingInputTokens: 170_901,
        overflowTokens: 0,
        layers: [
          {
            layer: "retrieved_context",
            requestedTokens: 789,
            budgetTokens: 1_500,
            allocatedTokens: 789,
            omittedTokens: 0,
            required: false,
          },
        ],
      },
    });
    handleAgentEvent.call(provider, "session-1", {
      type: "api_request",
      requestId: "request-1",
      model: "claude-sonnet-4-6",
      reasoningEffort: "high",
      inputTokens: 100,
      uncachedInputTokens: 80,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      durationMs: 500,
      timeToFirstToken: 100,
    });

    const posted = mockPostMessage.mock.calls
      .map(([message]) => message)
      .find((message) => message.type === "agentApiRequest");
    expect(posted).toMatchObject({
      mode: "architect",
      commandApprovalPolicy: "approve-for-me",
    });
    expect(manager.getCommandApprovalPolicy).toHaveBeenCalledWith(
      "session-1",
      expect.anything(),
    );
    expect(recordContextUsage).toHaveBeenCalledWith({
      kind: "request_context_attribution",
      sessionId: "session-1",
      requestId: "request-1",
      requestKind: "agent",
      model: "claude-sonnet-4-6",
      estimatedInputTokens: 99,
      toolResultAttributions: [
        {
          toolCallId: "call-distinctive",
          toolName: "read_file",
          chars: 321,
          bytes: 654,
          estimatedTokens: 87,
        },
      ],
      omittedToolResultAttributions: 3,
      pinnedMemoryTokens: 456,
      retrievedMemoryTokens: 789,
      contextLedger: expect.objectContaining({
        hardInputLimitTokens: 171_000,
        remainingInputTokens: 170_901,
        layers: [
          expect.objectContaining({
            layer: "retrieved_context",
            allocatedTokens: 789,
          }),
        ],
      }),
    });

    const projected = (
      provider as unknown as {
        projectedForegroundState: {
          messages: Array<Record<string, unknown>>;
        };
      }
    ).projectedForegroundState;
    const lastMessage = projected.messages.at(-1);
    expect(lastMessage?.apiRequest).toMatchObject({
      mode: "architect",
      commandApprovalPolicy: "approve-for-me",
    });
  });

  it("ships a complete hydration snapshot: tail offset, in-flight blocks, streaming, focus origin", async () => {
    const { ChatViewProvider } = await import("./ChatViewProvider.js");

    const provider = new ChatViewProvider(
      { fsPath: "/tmp/ext" } as never,
      { get: vi.fn(), update: vi.fn() } as never,
    );

    const allMessages = [
      { role: "user", content: "turn one" },
      {
        role: "assistant",
        content: [{ type: "text", text: "answer one" }],
      },
      { role: "user", content: "turn two" },
    ];
    const session = {
      id: "session-live",
      title: "Live session",
      mode: "code",
      model: "claude-opus-5",
      status: "streaming",
      background: false,
      transcriptRevision: 7,
      lastInputTokens: 12,
      inFlightAssistantBlocks: [
        {
          type: "thinking",
          id: "think-live",
          text: "reasoning",
          complete: false,
        },
        { type: "text", text: "partial answer" },
      ],
      getAllMessages: () => allMessages,
    };

    const message = (
      provider as unknown as {
        buildSessionLoadedMessage(
          session: unknown,
          opts?: { tailTurns?: number; origin?: "focus" },
        ): Record<string, unknown>;
      }
    ).buildSessionLoadedMessage(session, { tailTurns: 1, origin: "focus" });

    expect(message).toMatchObject({
      type: "agentSessionLoaded",
      sessionId: "session-live",
      transcriptRevision: 7,
      streaming: true,
      origin: "focus",
      inFlight: [
        {
          type: "thinking",
          id: "think-live",
          text: "reasoning",
          complete: false,
        },
        { type: "text", text: "partial answer" },
      ],
    });
    // tailTurns 1 keeps only the last user turn; the offset points at its
    // absolute index so rehydrated ids stay deterministic across loads.
    expect(message.messages).toEqual([{ role: "user", content: "turn two" }]);
    expect(message.messageIndexOffset).toBe(2);

    const idle = (
      provider as unknown as {
        buildSessionLoadedMessage(session: unknown): Record<string, unknown>;
      }
    ).buildSessionLoadedMessage({
      ...session,
      status: "idle",
      inFlightAssistantBlocks: [],
    });
    expect(idle.streaming).toBe(false);
    expect(idle.inFlight).toBeUndefined();
    expect(idle.origin).toBeUndefined();
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

  it("posts the completed transcript revision on agentDone", async () => {
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
      id: "foreground-1",
      background: false,
      transcriptRevision: 41,
    };
    (provider as unknown as { sessionManager: unknown }).sessionManager = {
      getSession: () => session,
      getForegroundSession: () => session,
      listPersistedSessions: () => [],
    };

    const handleAgentEvent = (
      provider as unknown as {
        handleAgentEvent: (sessionId: string, event: unknown) => void;
      }
    ).handleAgentEvent;
    handleAgentEvent.call(provider, "foreground-1", {
      type: "done",
      totalInputTokens: 1,
      totalOutputTokens: 2,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
    });

    expect(mockPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "agentDone",
        sessionId: "foreground-1",
        transcriptRevision: 41,
      }),
    );
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
    const getBackgroundCompletion = vi.fn(() => ({
      sessionId: "bg-1",
      task: "Review implementation",
      status: "completed" as const,
      resultState: "completed" as const,
      resultText: "full structured report",
      summary: "one-line summary",
    }));
    const markBackgroundResultsAnnounced = vi.fn();
    (provider as unknown as { sessionManager: unknown }).sessionManager = {
      getSession: () => ({ background: true }),
      getForegroundSession: () => ({ id: "foreground-1" }),
      getBgSessionInfos: () => [{ id: "bg-1" }],
      getBackgroundParentSessionId: () => "foreground-1",
      getBackgroundCompletion,
      markBackgroundResultsAnnounced,
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

    expect(getBackgroundCompletion).toHaveBeenCalledWith("bg-1");
    expect(mockPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "agentBgDone",
        sessionId: "bg-1",
        parentSessionId: "foreground-1",
        completion: expect.objectContaining({
          sessionId: "bg-1",
          status: "completed",
          resultState: "completed",
          resultText: "full structured report",
          summary: "one-line summary",
        }),
      }),
    );
    expect(markBackgroundResultsAnnounced).toHaveBeenCalledWith(["bg-1"]);
  });

  it("rehydrates unpulled durable background results when loading a parent session", async () => {
    const { ChatViewProvider } = await import("./ChatViewProvider.js");
    const provider = new ChatViewProvider(
      { fsPath: "/tmp/ext" } as never,
      { get: vi.fn(), update: vi.fn() } as never,
    );
    (provider as unknown as { view: unknown }).view = {
      webview: { postMessage: mockPostMessage },
    };
    (provider as unknown as { webviewReady: boolean }).webviewReady = true;
    const markBackgroundResultsAnnounced = vi.fn();
    const session = {
      id: "foreground-1",
      title: "Foreground",
      mode: "code",
      model: "gpt-5.6-sol",
      lastInputTokens: 0,
      getAllMessages: () => [
        { role: "user", content: "Run both reviews" },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "pulled-result",
              name: "get_background_result",
              input: { sessionId: "bg-pulled" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "pulled-result",
              content: "Already persisted",
            },
          ],
        },
        ...Array.from({ length: 9 }, (_, index) => ({
          role: "user" as const,
          content: `Later turn ${index + 1}`,
        })),
      ],
    };
    provider.setSessionManager({
      getForegroundSession: vi.fn(() => session),
      getConfig: vi.fn(() => ({
        model: "gpt-5.6-sol",
        autoCondenseThreshold: 0.8,
      })),
      getSessionInfos: vi.fn(() => []),
      getBgSessionInfos: vi.fn(() => []),
      getBackgroundCompletionsForParent: vi.fn(() => [
        {
          sessionId: "bg-pulled",
          task: "Pulled review",
          status: "completed",
          resultText: "Already persisted",
          completedAt: 1,
        },
        {
          sessionId: "bg-pushed",
          task: "Pushed review",
          status: "completed",
          resultText: "Recover me",
          completedAt: 2,
        },
      ]),
      markBackgroundResultsAnnounced,
      onEvent: undefined,
      onSessionsChanged: undefined,
    } as never);

    (
      provider as unknown as {
        postSessionLoaded: (session: unknown) => void;
      }
    ).postSessionLoaded(session);

    const loadedMessage = mockPostMessage.mock.calls.find(
      ([message]) => message.type === "agentSessionLoaded",
    )?.[0];
    expect(loadedMessage?.backgroundResults).toEqual([
      expect.objectContaining({
        sessionId: "bg-pulled",
        resultText: "Already persisted",
      }),
      expect.objectContaining({
        sessionId: "bg-pushed",
        resultText: "Recover me",
      }),
    ]);
    expect(markBackgroundResultsAnnounced).toHaveBeenCalledWith([
      "bg-pulled",
      "bg-pushed",
    ]);
    expect(
      provider
        .getBrowserProjectedForegroundState()
        ?.projectedMessages.flatMap((message) => message.blocks)
        .filter((block) => block.type === "bg_agent_result")
        .map((block) => block.sessionId),
    ).toEqual(["bg-pulled", "bg-pushed"]);
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
      getBackgroundCompletion: () => ({
        sessionId: "bg-unresolved",
        task: "Nested review",
        status: "completed" as const,
        resultState: "completed" as const,
        resultText: "nested result",
      }),
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

  it("waits for startup restore and hydrates the foreground transcript on tab divergence", async () => {
    const { ChatViewProvider } = await import("./ChatViewProvider.js");

    let finishStartupRestore!: () => void;
    const startupRestore = new Promise<void>((resolve) => {
      finishStartupRestore = resolve;
    });
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
      getSession: vi.fn((sessionId: string) =>
        sessionId === foreground.id ? foreground : undefined,
      ),
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
    provider.setChatTabStartupRestore(startupRestore);
    const workspaceSnapshot = {
      controllerEpoch: "controller-startup",
      focusedTabId: "tab-selected",
      tabs: [
        {
          tabId: "tab-selected",
          displayNumber: 1,
          label: "T1",
          sessionId: "session-selected",
          placement: "docked",
          title: foreground.title,
          status: "completed",
          busy: false,
        },
      ],
    } as const;
    (
      provider as unknown as {
        getChatWorkspaceViewSnapshot: () => typeof workspaceSnapshot;
      }
    ).getChatWorkspaceViewSnapshot = () => workspaceSnapshot;

    const receiveListeners: Array<
      (msg: Record<string, unknown>) => void | Promise<void>
    > = [];
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
        ([message]) => message.type === "agentSessionLoaded",
      ),
    ).toBe(false);

    finishStartupRestore();
    await vi.waitFor(() =>
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
      ).toBe(true),
    );

    const published = mockPostMessage.mock.calls.map(([message]) => message);
    const workspaceIndex = published.findIndex(
      (message) =>
        message.type === "chatWorkspaceUpdate" &&
        message.snapshot === workspaceSnapshot,
    );
    const hydrationIndex = published.findIndex(
      (message) => message.type === "agentSessionLoaded",
    );
    const restoreDoneIndex = published.findIndex(
      (message) => message.type === "agentRestoreSessionDone",
    );
    expect(workspaceIndex).toBeGreaterThanOrEqual(0);
    expect(hydrationIndex).toBeGreaterThan(workspaceIndex);
    expect(restoreDoneIndex).toBeGreaterThan(hydrationIndex);
    expect(published[hydrationIndex]).toMatchObject({
      sessionId: foreground.id,
      restored: true,
    });
  });

  it("projects Ask mode before a session exists when no folder is open", async () => {
    const { ChatViewProvider } = await import("./ChatViewProvider.js");
    const provider = new ChatViewProvider(
      { fsPath: "/tmp/ext" } as never,
      { get: vi.fn(), update: vi.fn() } as never,
    );
    (provider as unknown as { view: unknown }).view = {
      webview: { postMessage: mockPostMessage },
    };
    (provider as unknown as { webviewReady: boolean }).webviewReady = true;
    provider.setSessionManager({
      getForegroundSession: vi.fn(() => undefined),
      getConfig: vi.fn(() => ({
        model: "openrouter-moonshotai-kimi-k3",
        autoCondenseThreshold: 0.8,
      })),
      getWorkspaceProjects: vi.fn(() => []),
      getDefaultProjectScope: vi.fn(() => undefined),
      getSessionInfos: vi.fn(() => []),
      getBgSessionInfos: vi.fn(() => []),
    } as never);
    mockPostMessage.mockClear();

    (provider as unknown as { sendInitialState(): void }).sendInitialState();

    expect(mockPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "stateUpdate",
        state: expect.objectContaining({
          projects: [],
          project: null,
          mode: "ask",
        }),
      }),
    );
  });

  it("returns refreshed environment details for the requested session", async () => {
    const { ChatViewProvider } = await import("./ChatViewProvider.js");
    const provider = new ChatViewProvider(
      { fsPath: "/tmp/ext" } as never,
      { get: vi.fn(), update: vi.fn() } as never,
    );
    (provider as unknown as { view: unknown }).view = {
      webview: { postMessage: mockPostMessage },
    };
    (provider as unknown as { webviewReady: boolean }).webviewReady = true;
    const requestedSession = {
      id: "session-requested",
      mode: "ask",
      model: "gpt-5.6-sol",
      systemPrompt: "requested session prompt",
    };
    provider.setSessionManager({
      getForegroundSession: vi.fn(() => ({
        id: "session-other",
        mode: "code",
        model: "claude-sonnet-4-6",
        systemPrompt: "other session prompt",
      })),
      getSession: vi.fn((sessionId: string) =>
        sessionId === requestedSession.id ? requestedSession : undefined,
      ),
      getRecentBgRoutingSummaries: vi.fn(() => []),
    } as never);
    mockPostMessage.mockClear();

    await (
      provider as unknown as {
        handleWebviewMessage(message: Record<string, unknown>): Promise<void>;
      }
    ).handleWebviewMessage({
      command: "agentRefreshDebugInfo",
      sessionId: requestedSession.id,
    });

    await vi.waitFor(() => {
      expect(mockPostMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "agentDebugInfo",
          sessionId: requestedSession.id,
          systemPrompt: requestedSession.systemPrompt,
        }),
      );
    });
  });

  it("normalizes health producer failures without exposing exception text", async () => {
    const { ChatViewProvider } = await import("./ChatViewProvider.js");
    const provider = new ChatViewProvider(
      { fsPath: "/tmp/ext" } as never,
      { get: vi.fn(), update: vi.fn() } as never,
    );
    const sendInitialState = vi.fn();
    (provider as unknown as { sendInitialState(): void }).sendInitialState =
      sendInitialState;

    provider.setContextHealthSources({
      memory: {
        health: vi.fn(async () => {
          throw new Error("private memory path /Users/test/memory");
        }),
      },
      retrieval: {
        health: vi.fn(async () => {
          throw new Error("private retrieval path /Users/test/retrieval");
        }),
      },
      semanticIndexEnabled: false,
    });
    await provider.refreshContextHealth();

    const snapshot = (
      provider as unknown as { contextHealth: Record<string, unknown> }
    ).contextHealth;
    expect(snapshot).toEqual({
      memory: {
        status: "unavailable",
        retrieval: "unavailable",
        reason: "Autonomous memory is unavailable.",
      },
      retrieval: {
        status: "unavailable",
        lexical: "unavailable",
        vector: "unavailable",
        structural: "unavailable",
        reason: "The retrieval store is unavailable.",
      },
      index: {
        status: "disabled",
        state: "disabled",
        reason: "Semantic indexing is disabled.",
      },
    });
    expect(JSON.stringify(snapshot)).not.toContain("/Users/test");
    expect(sendInitialState).toHaveBeenCalled();
  });

  it("keeps the latest index state and ignores stale health refreshes", async () => {
    const { ChatViewProvider } = await import("./ChatViewProvider.js");
    const provider = new ChatViewProvider(
      { fsPath: "/tmp/ext" } as never,
      { get: vi.fn(), update: vi.fn() } as never,
    );
    (provider as unknown as { sendInitialState(): void }).sendInitialState =
      vi.fn();

    let resolveFirstMemory!: (value: never) => void;
    let resolveFirstRetrieval!: (value: never) => void;
    let resolveSecondMemory!: (value: never) => void;
    let resolveSecondRetrieval!: (value: never) => void;
    const memoryHealth = vi
      .fn()
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveFirstMemory = resolve;
        }),
      )
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveSecondMemory = resolve;
        }),
      );
    const retrievalHealth = vi
      .fn()
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveFirstRetrieval = resolve;
        }),
      )
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveSecondRetrieval = resolve;
        }),
      );
    const privateProvider = provider as unknown as {
      memoryHealthProvider: { health(): Promise<never> };
      retrievalHealthProvider: { health(): Promise<never> };
      contextHealth: {
        memory: Record<string, unknown>;
        retrieval: Record<string, unknown>;
        index: Record<string, unknown>;
      };
    };
    privateProvider.memoryHealthProvider = { health: memoryHealth };
    privateProvider.retrievalHealthProvider = { health: retrievalHealth };

    const first = provider.refreshContextHealth();
    const second = provider.refreshContextHealth();
    provider.updateContextIndexHealth(
      { state: "indexing", current: 4, total: 10 },
      true,
    );
    resolveSecondMemory({
      status: "ready",
      retrieval: "hybrid",
      crud: true,
      dedupe: true,
      conflict: true,
      auditUndo: true,
      recordCount: 9,
      activeRecordCount: 8,
      auditEventCount: 3,
    } as never);
    resolveSecondRetrieval({
      status: "ready",
      lexical: "ready",
      scalar: "ready",
      vector: "ready",
      structural: "ready",
      embeddingCredentials: "available",
      reasons: [],
      fingerprintDisposition: "compatible",
      pendingPublications: 0,
      sourceCount: 12,
      chunkCount: 48,
      relationCount: 6,
      staleSourceCount: 0,
    } as never);
    await second;

    resolveFirstMemory({
      status: "degraded",
      retrieval: "lexical-only",
      crud: true,
      dedupe: true,
      conflict: true,
      auditUndo: true,
      recordCount: 1,
      activeRecordCount: 1,
      auditEventCount: 1,
    } as never);
    resolveFirstRetrieval({
      status: "unavailable",
      lexical: "unavailable",
      scalar: "unavailable",
      vector: "unavailable",
      structural: "unavailable",
      embeddingCredentials: "missing",
      reason: "store_unavailable",
      reasons: ["store_unavailable"],
      fingerprintDisposition: "initialize",
      pendingPublications: 0,
      sourceCount: 0,
      chunkCount: 0,
      relationCount: 0,
      staleSourceCount: 0,
    } as never);
    await first;

    expect(privateProvider.contextHealth).toMatchObject({
      memory: { status: "ready", activeRecordCount: 8 },
      retrieval: { status: "ready", sourceCount: 12, chunkCount: 48 },
      index: { status: "working", state: "indexing", current: 4, total: 10 },
    });
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
        contextHealth: {
          memory: {
            status: "not_measured",
            retrieval: "not_measured",
            reason: "Health has not been measured yet.",
          },
          retrieval: {
            status: "not_measured",
            lexical: "not_measured",
            vector: "not_measured",
            structural: "not_measured",
            reason: "Health has not been measured yet.",
          },
          index: {
            status: "not_measured",
            state: "not_measured",
            reason: "Health has not been measured yet.",
          },
        },
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

  it("maps only explicit non-file write choices to the shared write card", async () => {
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
            choices: Array<{ label: string; value: string }>;
            writeChoices?: Array<{ label: string; value: string }>;
          },
        ) => { writeChoices?: Array<{ label: string; value: string }> };
      }
    ).buildApprovalRequest.bind(provider);
    const choices = [
      { label: "Generate", value: "accept" },
      { label: "Generate for Session", value: "accept-session" },
    ];

    expect(
      buildApprovalRequest("image-approval", {
        kind: "write",
        title: "Generate 1 image?",
        choices,
        writeChoices: choices,
      }).writeChoices,
    ).toEqual(choices);
    expect(
      buildApprovalRequest("file-approval", {
        kind: "write",
        title: "Modify `file.ts`?",
        choices: [{ label: "Accept", value: "accept" }],
      }).writeChoices,
    ).toBeUndefined();
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

  it("maps structured inline command approvals onto the shared command card", async () => {
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
            commandText?: string;
            commandReason?: string;
            humanOnlyReason?: string;
            cwd?: string;
            choices: Array<{ label: string; value: string }>;
          },
        ) => {
          kind: string;
          command?: string;
          reason?: string;
          humanOnlyReason?: string;
          cwd?: string;
        };
      }
    ).buildApprovalRequest.bind(provider);

    const mapped = buildApprovalRequest("approval-cmd", {
      kind: "command",
      title: "Read-only background agent requests a command",
      detail: '{"rawInput":{"command":"grep -rn pattern src"}}',
      commandText: "grep -rn pattern src",
      commandReason: "Read-only review session: runs without a write lease.",
      humanOnlyReason: "Guardian review timed out.",
      cwd: "/workspace/project",
      choices: [{ label: "Allow once", value: "allow_once" }],
    });

    // The plain command must win over the JSON evidence blob in `detail`.
    expect(mapped).toMatchObject({
      kind: "command",
      command: "grep -rn pattern src",
      reason: "Read-only review session: runs without a write lease.",
      humanOnlyReason: "Guardian review timed out.",
      cwd: "/workspace/project",
    });

    const legacy = buildApprovalRequest("approval-legacy", {
      kind: "command",
      title: "Fallback title",
      detail: "plain detail",
      choices: [{ label: "Allow once", value: "allow_once" }],
    });
    expect(legacy).toMatchObject({ command: "plain detail" });
    expect(legacy.reason).toBeUndefined();
    expect(legacy.humanOnlyReason).toBeUndefined();
    expect(legacy.cwd).toBeUndefined();
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
            backgroundTask?: string;
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
        backgroundTask: "Review implementation",
        choices: [{ label: "Accept", value: "accept" }],
      },
      "session-b",
    );
    expect(backgroundApproval).toMatchObject({
      sourceProject: {
        projectId: "project-b",
        displayName: "Project B",
      },
      backgroundTask: "Review implementation",
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

  it("rejects unscoped built-in approval requests before publishing a card", async () => {
    const { ChatViewProvider } = await import("./ChatViewProvider.js");
    const provider = new ChatViewProvider(
      { fsPath: "/tmp/ext" } as never,
      { get: vi.fn(), update: vi.fn() } as never,
    );
    const uiPublisher = (
      provider as unknown as {
        uiPublisher: {
          publishApproval: (sessionId: string, request: unknown) => void;
        };
      }
    ).uiPublisher;
    const publishApprovalSpy = vi.spyOn(uiPublisher, "publishApproval");

    expect(() =>
      provider.requestApproval({
        id: "approval-unscoped",
        kind: "write",
        title: "Modify `src/file.ts`?",
        choices: [],
      }),
    ).toThrow("Built-in agent approval requests require a sessionId.");
    expect(publishApprovalSpy).not.toHaveBeenCalled();
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

    const approvalPromise = provider.requestApproval(
      {
        id: "approval-inline",
        kind: "write",
        title: "Modify `src/file.ts`?",
        choices: [
          { label: "Accept", value: "accept", isPrimary: true },
          { label: "Reject", value: "reject", isDanger: true },
        ],
      },
      "agent",
    );

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
        sessionId: "session-main",
        request: {
          kind: "command",
          id: "main-command",
          command: "npm test",
          subCommands: [],
        },
      },
      mainRespond,
    );

    const worktreePromise = provider.requestApproval(
      {
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
      },
      "agent",
    );

    expect(publishApprovalSpy).toHaveBeenLastCalledWith(
      "agent",
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
      "session-main",
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
          publishApproval: (sessionId: string, request: unknown) => void;
          publishApprovalIdle: (sessionId: string, id: string) => void;
        };
      }
    ).uiPublisher;
    const publishApprovalSpy = vi.spyOn(uiPublisher, "publishApproval");
    const publishApprovalIdleSpy = vi.spyOn(uiPublisher, "publishApprovalIdle");

    const forwardedRespond = vi.fn(() => true);
    provider.forwardApproval(
      {
        sessionId: "session-background",
        request: {
          kind: "command",
          id: "background-command",
          command: "npm test",
          subCommands: [],
        },
      },
      forwardedRespond,
    );

    const foregroundPromise = provider.requestApproval(
      {
        id: "foreground-write",
        kind: "write",
        title: "Modify `src/file.ts`?",
        choices: [
          { label: "Accept", value: "accept", isPrimary: true },
          { label: "Reject", value: "reject", isDanger: true },
        ],
      },
      "agent",
    );

    expect(publishApprovalSpy).toHaveBeenLastCalledWith(
      "agent",
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
      "session-background",
      expect.objectContaining({ id: "background-command" }),
    );
    expect(publishApprovalIdleSpy).toHaveBeenCalledWith(
      "agent",
      "foreground-write",
    );
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
          publishApproval: (sessionId: string, request: unknown) => void;
          publishApprovalIdle: (sessionId: string, id: string) => void;
        };
      }
    ).uiPublisher;
    const publishApprovalSpy = vi.spyOn(uiPublisher, "publishApproval");
    const publishApprovalIdleSpy = vi.spyOn(uiPublisher, "publishApprovalIdle");

    const foregroundPromise = provider.requestApproval(
      {
        id: "foreground-write",
        kind: "write",
        title: "Modify `src/file.ts`?",
        choices: [
          { label: "Accept", value: "accept", isPrimary: true },
          { label: "Reject", value: "reject", isDanger: true },
        ],
      },
      "agent",
    );
    const forwardedRespond = vi.fn(() => true);
    provider.forwardApproval(
      {
        sessionId: "session-background",
        request: {
          kind: "command",
          id: "background-command",
          command: "npm test",
          subCommands: [],
        },
      },
      forwardedRespond,
    );

    expect(publishApprovalSpy).toHaveBeenLastCalledWith(
      "session-background",
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
      "agent",
      expect.objectContaining({ id: "foreground-write" }),
    );
    expect(publishApprovalIdleSpy).toHaveBeenCalledWith(
      "session-background",
      "background-command",
    );

    provider.submitBrowserApprovalDecision({
      id: "foreground-write",
      approvalKind: "write",
      decision: "reject",
    });
    await expect(foregroundPromise).resolves.toMatchObject({
      decision: "reject",
    });
  });

  it("rejects only the stopped session's inline approvals", async () => {
    const { ChatViewProvider } = await import("./ChatViewProvider.js");
    const provider = new ChatViewProvider(
      { fsPath: "/tmp/ext" } as never,
      { get: vi.fn(), update: vi.fn() } as never,
    );
    provider.setSessionManager({
      getForegroundSession: vi.fn(() => undefined),
      getSession: vi.fn(() => ({
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheReadTokens: 0,
        totalCacheCreationTokens: 0,
        background: false,
      })),
      stopSession: vi.fn(),
      getWorkspaceProjects: vi.fn(() => []),
      onSessionsChanged: vi.fn(() => ({ dispose: vi.fn() })),
    } as never);
    const stoppedApproval = provider.requestApproval(
      { id: "stop-me", kind: "write", title: "Stop", choices: [] },
      "session-stop",
    );
    const retainedApproval = provider.requestApproval(
      { id: "keep-me", kind: "write", title: "Keep", choices: [] },
      "session-keep",
    );

    (
      provider as unknown as {
        stopSessionFromUi(sessionId: string): void;
      }
    ).stopSessionFromUi("session-stop");

    await expect(stoppedApproval).resolves.toBe("reject");
    expect(
      (
        provider as unknown as { pendingApprovals: Map<string, unknown> }
      ).pendingApprovals.has("keep-me"),
    ).toBe(true);
    provider.submitBrowserApprovalDecision({
      id: "keep-me",
      approvalKind: "write",
      decision: "accept",
    });
    await expect(retainedApproval).resolves.toMatchObject({
      decision: "accept",
    });
  });

  it("presents attached background approvals in their root chat session", async () => {
    const { ChatViewProvider } = await import("./ChatViewProvider.js");
    const provider = new ChatViewProvider(
      { fsPath: "/tmp/ext" } as never,
      { get: vi.fn(), update: vi.fn() } as never,
    );
    provider.setSessionManager({
      getForegroundSession: vi.fn(() => undefined),
      getSession: vi.fn((sessionId: string) => {
        if (sessionId === "background-session") {
          return {
            background: true,
            fleetMetadata: { rootSessionId: "root-session" },
          };
        }
        if (sessionId === "root-session") {
          return { id: "root-session", background: false };
        }
        return undefined;
      }),
      getWorkspaceProjects: vi.fn(() => []),
      onSessionsChanged: vi.fn(() => ({ dispose: vi.fn() })),
    } as never);
    const uiPublisher = (
      provider as unknown as {
        uiPublisher: {
          publishApproval: (sessionId: string, request: unknown) => void;
          publishApprovalIdle: (sessionId: string, id: string) => void;
        };
      }
    ).uiPublisher;
    const publishApprovalSpy = vi.spyOn(uiPublisher, "publishApproval");
    const publishApprovalIdleSpy = vi.spyOn(uiPublisher, "publishApprovalIdle");

    const approval = provider.requestApproval(
      {
        id: "background-write",
        kind: "write",
        title: "Modify `src/output.ts`?",
        backgroundTask: "Edit implementation",
        choices: [
          { label: "Accept", value: "accept", isPrimary: true },
          { label: "Reject", value: "reject", isDanger: true },
        ],
      },
      "background-session",
    );

    expect(publishApprovalSpy).toHaveBeenCalledWith(
      "root-session",
      expect.objectContaining({ id: "background-write" }),
    );

    provider.submitBrowserApprovalDecision({
      id: "background-write",
      approvalKind: "write",
      decision: "accept",
    });
    await expect(approval).resolves.toMatchObject({ decision: "accept" });
    expect(publishApprovalIdleSpy).toHaveBeenCalledWith(
      "root-session",
      "background-write",
    );
  });

  it("falls back to a global card when an attached background root has no chat tab", async () => {
    const { ChatViewProvider } = await import("./ChatViewProvider.js");
    const provider = new ChatViewProvider(
      { fsPath: "/tmp/ext" } as never,
      { get: vi.fn(), update: vi.fn() } as never,
    );
    provider.setSessionManager({
      getForegroundSession: vi.fn(() => undefined),
      getSession: vi.fn((sessionId: string) => {
        if (sessionId === "background-session") {
          return {
            background: true,
            fleetMetadata: { rootSessionId: "root-session" },
          };
        }
        if (sessionId === "root-session") {
          return { id: "root-session", background: false };
        }
        return undefined;
      }),
      getWorkspaceProjects: vi.fn(() => []),
      onSessionsChanged: vi.fn(() => ({ dispose: vi.fn() })),
    } as never);
    (
      provider as unknown as {
        chatTabController: { getTabForSession(sessionId: string): undefined };
      }
    ).chatTabController = { getTabForSession: vi.fn(() => undefined) };
    const uiPublisher = (
      provider as unknown as {
        uiPublisher: {
          publishApproval: (
            sessionId: string,
            request: unknown,
            options: unknown,
          ) => void;
          publishApprovalIdle: (
            sessionId: string,
            id: string,
            options: unknown,
          ) => void;
        };
      }
    ).uiPublisher;
    const publishApprovalSpy = vi.spyOn(uiPublisher, "publishApproval");
    const publishApprovalIdleSpy = vi.spyOn(uiPublisher, "publishApprovalIdle");

    const approval = provider.requestApproval(
      {
        id: "background-detached-write",
        kind: "write",
        title: "Modify `src/output.ts`?",
        backgroundTask: "Edit implementation",
        choices: [
          { label: "Accept", value: "accept", isPrimary: true },
          { label: "Reject", value: "reject", isDanger: true },
        ],
      },
      "background-session",
    );

    expect(publishApprovalSpy).toHaveBeenCalledWith(
      "background-session",
      expect.objectContaining({ id: "background-detached-write" }),
      { sessionId: "background-session", globallyVisible: true },
    );

    provider.submitBrowserApprovalDecision({
      id: "background-detached-write",
      approvalKind: "write",
      decision: "accept",
    });
    await expect(approval).resolves.toMatchObject({ decision: "accept" });
    expect(publishApprovalIdleSpy).toHaveBeenCalledWith(
      "background-session",
      "background-detached-write",
      { sessionId: "background-session", globallyVisible: true },
    );
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
        sessionId: "session-native",
        request: {
          kind: "command",
          id: "native-escalation",
          command: "dotnet build",
          cwd: "/workspace",
          reason: "Needs a host facility.",
        },
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

  it("shows session-targeted status attention until a question is answered", async () => {
    const { ChatViewProvider } = await import("./ChatViewProvider.js");
    const provider = new ChatViewProvider(
      { fsPath: "/tmp/ext" } as never,
      { get: vi.fn(), update: vi.fn() } as never,
    );
    const disposeAttention = vi.fn();
    const showAlert = vi.fn(() => ({ dispose: disposeAttention }));
    provider.setPendingInteractionAlertProvider(showAlert);

    const questionPromise = provider.requestQuestion(
      "Need input.",
      [{ id: "q1", type: "yes_no", question: "Proceed?" }],
      "session-1",
    );
    const questionId = (
      provider as unknown as { pendingQuestions: Map<string, unknown> }
    ).pendingQuestions
      .keys()
      .next().value as string;

    expect(showAlert).toHaveBeenCalledWith(
      "Question requires a response",
      expect.objectContaining({
        command: "agentLink.focusApproval",
        arguments: [{ sessionId: "session-1" }],
      }),
    );
    await expect(
      provider.submitBrowserQuestionResponse({
        id: questionId,
        answers: { q1: true },
      }),
    ).resolves.toBe(true);
    await expect(questionPromise).resolves.toMatchObject({
      answers: { q1: true },
    });
    expect(disposeAttention).toHaveBeenCalledOnce();
  });

  it("clears question attention when its session is no longer active", async () => {
    const { ChatViewProvider } = await import("./ChatViewProvider.js");
    const provider = new ChatViewProvider(
      { fsPath: "/tmp/ext" } as never,
      { get: vi.fn(), update: vi.fn() } as never,
    );
    const disposeAttention = vi.fn();
    provider.setPendingInteractionAlertProvider(() => ({
      dispose: disposeAttention,
    }));

    const questionPromise = provider.requestQuestion(
      "Need input.",
      [{ id: "q1", type: "yes_no", question: "Proceed?" }],
      "session-stopped",
    );
    (provider as unknown as { sessionManager: unknown }).sessionManager = {
      clearPendingQuestionRecovery: vi.fn(),
      getSession: vi.fn(() => undefined),
      getPendingQuestionRecovery: vi.fn(() => null),
    };

    (
      provider as unknown as { reconcileQuestionAttention(): void }
    ).reconcileQuestionAttention();

    await expect(questionPromise).resolves.toMatchObject({ answers: {} });
    expect(disposeAttention).toHaveBeenCalledOnce();
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

    const questionState = provider as unknown as {
      pendingQuestions: Map<string, (raw: unknown) => void>;
      questionSessionById: Map<string, string>;
    };
    const pendingQuestions = questionState.pendingQuestions;
    const resolveSpy = vi.fn();
    pendingQuestions.set("question-1", resolveSpy);
    questionState.questionSessionById.set("question-1", "session-1");

    const projection = provider as unknown as {
      applyProjectedAction: (action: AppAction) => void;
    };
    const questions = [
      {
        id: "q1",
        type: "yes_no" as const,
        question: "Proceed?",
      },
    ];
    projection.applyProjectedAction({
      type: "TOOL_START",
      toolCallId: "tool-ask-1",
      toolName: "ask_user",
      input: { context: "Need input.", questions },
    });
    projection.applyProjectedAction({
      type: "SET_QUESTION",
      id: "question-1",
      context: "Need input.",
      questions,
    });
    expect(
      (
        provider as unknown as {
          projectedForegroundState: {
            questionRequest: { toolCallId?: string } | null;
          };
        }
      ).projectedForegroundState.questionRequest,
    ).toMatchObject({ toolCallId: "tool-ask-1" });
    const applyProjectedActionSpy = vi.spyOn(
      projection,
      "applyProjectedAction",
    );

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
    expect(publishQuestionClearedSpy).toHaveBeenCalledWith(
      "session-1",
      "question-1",
    );
    expect(applyProjectedActionSpy).toHaveBeenCalledWith({
      type: "SUBMIT_QUESTION",
      id: "question-1",
      answers: { q1: "Yes" },
      notes: {},
    });
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
          publishQuestionProgress: (
            sessionId: string,
            progress: unknown,
          ) => void;
        };
      }
    ).uiPublisher;
    const publishProgressSpy = vi.spyOn(uiPublisher, "publishQuestionProgress");

    const questionState = provider as unknown as {
      pendingQuestions: Map<string, (raw: unknown) => void>;
      questionSessionById: Map<string, string>;
    };
    questionState.pendingQuestions.set("question-live", vi.fn());
    questionState.questionSessionById.set("question-live", "session-live");

    const ok = provider.publishBrowserQuestionProgress({
      id: "question-live",
      step: 2,
      answers: { q1: "Yes" },
      notes: { q1: "note" },
      origin: "origin-1",
    });

    expect(ok).toBe(true);
    expect(publishProgressSpy).toHaveBeenCalledWith("session-live", {
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
    projectScope: {
      schemaVersion: 1 as const,
      kind: "project" as const,
      projectId: "project-1",
      workspaceFolderUri: "file:///workspace/project",
      displayName: "Project",
      rootPath: "/workspace/project",
    },
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
    const getForegroundSession = manager.getForegroundSession as
      | (() => { id: string } | undefined)
      | undefined;
    const getSession =
      manager.getSession ??
      ((sessionId: string) => {
        const foreground = getForegroundSession?.();
        return foreground?.id === sessionId ? foreground : undefined;
      });
    provider.setSessionManager({ ...manager, getSession } as never);
    return provider;
  }

  it("switches seamlessly without Guardian or human approval under Approve for Me", async () => {
    const fg = session();
    const switchSessionMode = vi.fn(async () => ({ ...fg, mode: "code" }));
    const queueModeSwitchResume = vi.fn();
    const getSessionApprovalMode = vi.fn(() => ({
      commandApprovalPolicy: "approve-for-me" as const,
      approvalPolicy: "on-request" as const,
      approvalReviewer: "auto-review" as const,
      executionPreset: "workspace-write" as const,
    }));
    const resetSessionAgentWriteApproval = vi.fn();
    const provider = await makeProvider({
      getForegroundSession: vi.fn(() => fg),
      switchSessionMode,
      queueModeSwitchResume,
      getSessionApprovalMode,
      getCommandApprovalPolicy: vi.fn(() => "approve-for-me"),
      getConfig: vi.fn(() => ({
        model: "claude-sonnet-4-6",
        autoCondenseThreshold: 0.8,
      })),
      getSessionInfos: vi.fn(() => []),
      getBgSessionInfos: vi.fn(() => []),
    });
    provider.setApprovalManager({
      getAgentWriteApprovalState: vi.fn(() => "session"),
      setAgentWriteApprovalSelection: vi.fn(() => true),
      resetSessionAgentWriteApproval,
      onDidChange: vi.fn(() => ({ dispose: vi.fn() })),
    } as never);
    const requestApproval = vi.spyOn(provider, "requestApproval");

    const result = await provider.handleModeSwitch(
      "code",
      "Implement now",
      false,
      fg.id,
    );

    expect(result.rejectionReason).toBeUndefined();
    expect(result).toMatchObject({ approved: true, mode: "code" });
    expect(getSessionApprovalMode).toHaveBeenCalledWith(fg.id, "safe");
    expect(requestApproval).not.toHaveBeenCalled();
    expect(switchSessionMode).toHaveBeenCalledWith("session-1", "code");
    expect(resetSessionAgentWriteApproval).not.toHaveBeenCalled();
    expect(queueModeSwitchResume).toHaveBeenCalledOnce();
  });

  it("records an explicit mode-change marker when the agent switches mode", async () => {
    const appendSurfaceChange = vi.fn();
    const fg = {
      ...session(),
      getAllMessages: () => [{ role: "user" }],
      appendSurfaceChange,
    };
    const switched = { ...fg, mode: "code" };
    const saveSession = vi.fn();
    const provider = await makeProvider({
      getForegroundSession: vi.fn(() => switched),
      getSession: vi.fn(() => fg),
      switchSessionMode: vi.fn(async () => switched),
      queueModeSwitchResume: vi.fn(),
      saveSession,
      getConfig: vi.fn(() => ({
        model: "claude-sonnet-4-6",
        autoCondenseThreshold: 0.8,
      })),
      getSessionInfos: vi.fn(() => []),
      getBgSessionInfos: vi.fn(() => []),
    });

    await expect(
      provider.handleModeSwitch("code", "Implement now", true, fg.id),
    ).resolves.toMatchObject({ approved: true, mode: "code" });

    expect(appendSurfaceChange).toHaveBeenCalledWith({
      mode: { previousMode: "architect", mode: "code" },
    });
    expect(saveSession).toHaveBeenCalledWith(fg.id);
    expect(mockPostMessage).toHaveBeenCalledWith({
      type: "agentSurfaceChange",
      sessionId: fg.id,
      change: { mode: { previousMode: "architect", mode: "code" } },
    });
  });

  it("keeps the manual card for an incomplete Approve for Me policy", async () => {
    const fg = session();
    const switchSessionMode = vi.fn(async () => ({ ...fg, mode: "code" }));
    const provider = await makeProvider({
      getForegroundSession: vi.fn(() => fg),
      getSessionApprovalMode: vi.fn(() => ({
        commandApprovalPolicy: "approve-for-me",
        approvalPolicy: "on-request",
        approvalReviewer: "user",
        executionPreset: "workspace-write",
      })),
      switchSessionMode,
      queueModeSwitchResume: vi.fn(),
      getCommandApprovalPolicy: vi.fn(() => "approve-for-me"),
      getConfig: vi.fn(() => ({
        model: "claude-sonnet-4-6",
        autoCondenseThreshold: 0.8,
      })),
      getSessionInfos: vi.fn(() => []),
      getBgSessionInfos: vi.fn(() => []),
    });
    const requestApproval = vi
      .spyOn(provider, "requestApproval")
      .mockResolvedValue("run-once");

    const result = await provider.handleModeSwitch(
      "code",
      "Start implementation",
      false,
      fg.id,
    );

    expect(result).toMatchObject({ approved: true, mode: "code" });
    expect(requestApproval).toHaveBeenCalledOnce();
    expect(switchSessionMode).toHaveBeenCalledWith("session-1", "code");
  });

  it("keeps the manual mode-switch approval card outside Approve for Me", async () => {
    const fg = session();
    const switchSessionMode = vi.fn(async () => ({ ...fg, mode: "code" }));
    const queueModeSwitchResume = vi.fn();
    const provider = await makeProvider({
      getForegroundSession: vi.fn(() => fg),
      getSessionApprovalMode: vi.fn(() => ({
        commandApprovalPolicy: "safe",
        approvalPolicy: "on-request",
        approvalReviewer: "user",
        executionPreset: "native-manual",
      })),
      switchSessionMode,
      queueModeSwitchResume,
      getCommandApprovalPolicy: vi.fn(() => "safe"),
      getConfig: vi.fn(() => ({
        model: "claude-sonnet-4-6",
        autoCondenseThreshold: 0.8,
      })),
      getSessionInfos: vi.fn(() => []),
      getBgSessionInfos: vi.fn(() => []),
    });
    const requestApproval = vi
      .spyOn(provider, "requestApproval")
      .mockResolvedValue("run-once");

    const result = await provider.handleModeSwitch(
      "code",
      "Start implementation",
      false,
      fg.id,
    );

    expect(result).toMatchObject({ approved: true, mode: "code" });
    expect(requestApproval).toHaveBeenCalledOnce();
    expect(switchSessionMode).toHaveBeenCalledWith("session-1", "code");
    expect(queueModeSwitchResume).toHaveBeenCalledOnce();
  });

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

  it.each([
    ["approve-for-me", 0],
    ["safe", 1],
  ] as const)(
    "reconciles session writes after a %s mode switch",
    async (policy, expectedResets) => {
      const fg = session();
      const queueModeSwitchResume = vi.fn();
      const resetSessionAgentWriteApproval = vi.fn();
      const provider = await makeProvider({
        getForegroundSession: vi.fn(() => fg),
        switchSessionMode: vi.fn(async () => fg),
        queueModeSwitchResume,
        getCommandApprovalPolicy: vi.fn(() => policy),
        getConfig: vi.fn(() => ({
          model: "claude-sonnet-4-6",
          autoCondenseThreshold: 0.8,
        })),
        getSessionInfos: vi.fn(() => []),
        getBgSessionInfos: vi.fn(() => []),
      });
      provider.setApprovalManager({
        getAgentWriteApprovalState: vi.fn(() => "session"),
        setAgentWriteApprovalSelection: vi.fn(() => true),
        resetSessionAgentWriteApproval,
        onDidChange: vi.fn(() => ({ dispose: vi.fn() })),
      } as never);

      const result = await provider.handleModeSwitch(
        "code",
        "change implementation mode",
        true,
        fg.id,
      );

      expect(result).toMatchObject({ approved: true, mode: "code" });
      expect(resetSessionAgentWriteApproval).toHaveBeenCalledTimes(
        expectedResets,
      );
      expect(queueModeSwitchResume).toHaveBeenCalledOnce();
    },
  );

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

describe("chat tab host routing", () => {
  async function makeTabRoutingProvider() {
    const { ChatViewProvider } = await import("./ChatViewProvider.js");
    const provider = new ChatViewProvider(
      { fsPath: "/tmp/ext" } as never,
      { get: vi.fn(), update: vi.fn() } as never,
    );
    const postMessage = vi.fn();
    const snapshot = {
      controllerEpoch: "epoch-1",
      focusedTabId: "tab-1",
      tabs: [
        {
          tabId: "tab-1",
          displayNumber: 1,
          label: "T1",
          sessionId: "session-1",
          placement: "docked",
          title: "First session",
          status: "streaming",
          busy: true,
        },
      ],
    };
    const coordinator = {
      focus: vi.fn(),
      newTab: vi.fn(),
      newChat: vi.fn(),
      close: vi.fn(),
      loadSession: vi.fn(),
      reorder: vi.fn(),
    };
    const chatTabController = {
      getFocusedTabId: vi.fn(() => "tab-1"),
      getTabForSession: vi.fn<(sessionId: string) => ChatTab | undefined>(
        () => undefined,
      ),
      getWorkspaceSnapshot: vi.fn(() => ({ controllerEpoch: "epoch-1" })),
      validateAction: vi.fn(() => ({
        ok: true,
        tab: {
          id: "tab-1",
          displayNumber: 1,
          sessionId: "session-1",
          placement: "docked",
          terminalGeneration: 1,
        },
      })),
    };
    const panelHost = {
      popOut: vi.fn(async () => true),
      dock: vi.fn(async () => true),
      focusPanel: vi.fn(() => false),
      releaseTab: vi.fn(),
      isAuthoritativeAddress: vi.fn(() => false),
    };
    (
      provider as unknown as {
        postMessage: typeof postMessage;
        chatTabHostCoordinator: unknown;
        getChatWorkspaceViewSnapshot: () => typeof snapshot;
      }
    ).postMessage = postMessage;
    (provider as unknown as { sessionManager: unknown }).sessionManager = {
      getForegroundSession: vi.fn(() => undefined),
    };
    (
      provider as unknown as {
        chatTabHostCoordinator: unknown;
        chatTabController: unknown;
        chatTabPanelHost: unknown;
      }
    ).chatTabHostCoordinator = coordinator;
    (
      provider as unknown as {
        chatTabController: unknown;
        chatTabPanelHost: unknown;
      }
    ).chatTabController = chatTabController;
    (provider as unknown as { chatTabPanelHost: unknown }).chatTabPanelHost =
      panelHost;
    (
      provider as unknown as {
        getChatWorkspaceViewSnapshot: () => typeof snapshot;
      }
    ).getChatWorkspaceViewSnapshot = () => snapshot;
    const handle = (message: Record<string, unknown>) =>
      (
        provider as unknown as {
          handleWebviewMessage(message: Record<string, unknown>): Promise<void>;
        }
      ).handleWebviewMessage(message);
    return {
      chatTabController,
      coordinator,
      handle,
      panelHost,
      postMessage,
      provider,
      snapshot,
    };
  }

  it("focuses the docked chat tab that owns a pending interaction", async () => {
    const { provider, chatTabController, coordinator } =
      await makeTabRoutingProvider();
    const tab: ChatTab = {
      id: "tab-2",
      displayNumber: 2,
      sessionId: "session-2",
      placement: "docked",
      terminalGeneration: 1,
    };
    chatTabController.getTabForSession = vi.fn(() => tab);
    chatTabController.getWorkspaceSnapshot = vi.fn(() => ({
      controllerEpoch: "epoch-1",
    }));
    coordinator.focus.mockResolvedValue({ ok: true, tab });
    const revealPanel = vi.fn();
    const refresh = provider as unknown as {
      revealPanel: typeof revealPanel;
      sendChatWorkspaceUpdate(): void;
      sendInitialState(): void;
    };
    refresh.revealPanel = revealPanel;
    refresh.sendChatWorkspaceUpdate = vi.fn();
    refresh.sendInitialState = vi.fn();

    await expect(provider.focusPendingInteraction("session-2")).resolves.toBe(
      true,
    );

    expect(coordinator.focus).toHaveBeenCalledWith({
      controllerEpoch: "epoch-1",
      tabId: "tab-2",
      sessionId: "session-2",
    });
    expect(revealPanel).toHaveBeenCalledWith(false);
  });

  it("focuses the nearest open ancestor tab for a background interaction", async () => {
    const { provider, chatTabController, coordinator } =
      await makeTabRoutingProvider();
    const parentTab: ChatTab = {
      id: "tab-parent",
      displayNumber: 1,
      sessionId: "session-parent",
      placement: "docked",
      terminalGeneration: 1,
    };
    chatTabController.getTabForSession = vi.fn((sessionId: string) =>
      sessionId === "session-parent" ? parentTab : undefined,
    );
    coordinator.focus.mockResolvedValue({ ok: true, tab: parentTab });
    (provider as unknown as { sessionManager: unknown }).sessionManager = {
      getBackgroundParentSessionId: vi.fn((sessionId: string) =>
        sessionId === "session-child" ? "session-parent" : undefined,
      ),
    };
    const refresh = provider as unknown as {
      revealPanel(preserveFocus?: boolean): void;
      sendChatWorkspaceUpdate(): void;
      sendInitialState(): void;
    };
    refresh.revealPanel = vi.fn();
    refresh.sendChatWorkspaceUpdate = vi.fn();
    refresh.sendInitialState = vi.fn();

    await expect(
      provider.focusPendingInteraction("session-child"),
    ).resolves.toBe(true);

    expect(coordinator.focus).toHaveBeenCalledWith(
      expect.objectContaining({
        tabId: "tab-parent",
        sessionId: "session-parent",
      }),
    );
  });

  it("returns false when the docked tab can no longer be focused", async () => {
    const { provider, chatTabController, coordinator } =
      await makeTabRoutingProvider();
    chatTabController.getTabForSession = vi.fn(() => ({
      id: "tab-stale",
      displayNumber: 2,
      sessionId: "session-stale",
      placement: "docked",
      terminalGeneration: 1,
    }));
    coordinator.focus.mockResolvedValue({ ok: false, reason: "not_found" });

    await expect(
      provider.focusPendingInteraction("session-stale"),
    ).resolves.toBe(false);
  });

  it("focuses the popped-out chat panel that owns a pending interaction", async () => {
    const { provider, chatTabController, panelHost } =
      await makeTabRoutingProvider();
    chatTabController.getTabForSession = vi.fn(() => ({
      id: "tab-2",
      displayNumber: 2,
      sessionId: "session-2",
      placement: "popped",
      terminalGeneration: 1,
    }));
    panelHost.focusPanel = vi.fn(() => true);

    await expect(provider.focusPendingInteraction("session-2")).resolves.toBe(
      true,
    );

    expect(panelHost.focusPanel).toHaveBeenCalledWith("tab-2");
  });

  async function makeEditorRoutingProvider() {
    const fixture = await makeTabRoutingProvider();
    const address = {
      controllerEpoch: "epoch-1",
      tabId: "tab-source",
      sessionId: "source-session",
      surface: "editor" as const,
      paneEpoch: 3,
    };
    fixture.panelHost.isAuthoritativeAddress = vi.fn(() => true);
    const connection = {
      getAddress: vi.fn(() => address),
      postMessage: vi.fn(),
    };
    const handleEditor = (message: Record<string, unknown>) =>
      fixture.provider.handleEditorPaneMessage(message, connection as never);
    return { ...fixture, address, connection, handleEditor };
  }

  it("binds the first send to its exact empty tab before promoting the session", async () => {
    const { chatTabController, coordinator, provider } =
      await makeTabRoutingProvider();
    const projectScope = {
      schemaVersion: 1,
      kind: "project",
      projectId: "project-1",
      workspaceFolderUri: "file:///tmp/project",
      displayName: "Project",
      rootPath: "/tmp/project",
    };
    const createdSession = {
      id: "session-created-for-tab-4",
      title: "New task",
      mode: "code",
      model: "gpt-5.6-sol",
      status: "idle",
      projectScope,
      projectAvailability: "available",
      reasoningEffort: "high",
      lastInputTokens: 0,
      lastOutputTokens: 0,
      lastCacheReadTokens: 0,
      estimatedTotalUsed: 0,
      getAllMessages: vi.fn(() => []),
    };
    let foregroundSession: typeof createdSession | undefined;
    const createSession = vi.fn();
    const sendMessage = vi.fn(async () => undefined);
    const switchTo = vi.fn(() => {
      foregroundSession = createdSession;
    });
    (provider as unknown as { sessionManager: unknown }).sessionManager = {
      getSession: vi.fn((id: string) =>
        id === createdSession.id ? createdSession : undefined,
      ),
      getForegroundSession: vi.fn(() => foregroundSession),
      getWorkspaceProjects: vi.fn(() => [
        {
          id: "project-1",
          name: "Project",
          uri: "file:///tmp/project",
          rootPath: "/tmp/project",
          availability: { status: "available" },
        },
      ]),
      createSession,
      switchTo,
      sendMessage,
    };
    coordinator.newChat.mockResolvedValueOnce({
      ok: true,
      tab: {
        id: "tab-4",
        displayNumber: 4,
        sessionId: createdSession.id,
        placement: "docked",
        terminalGeneration: 1,
      },
      session: createdSession,
    });
    chatTabController.getFocusedTabId = vi.fn(() => "tab-4");
    (
      provider as unknown as {
        resolveAttachments(): Promise<{
          text: string;
          images: unknown[];
          documents: unknown[];
        }>;
        buildChatState(): Record<string, unknown>;
      }
    ).resolveAttachments = vi.fn(async () => ({
      text: "exact tab prompt",
      images: [],
      documents: [],
    }));
    (
      provider as unknown as { buildChatState(): Record<string, unknown> }
    ).buildChatState = vi.fn(() => ({ sessionId: createdSession.id }));
    const submitSessionSetModel = vi.fn(async () => ({ ok: true }));
    const setSessionWriteApproval = vi.fn(() => ({ ok: true }));
    const setSessionCommandApprovalPolicy = vi.fn(() => ({ ok: true }));
    Object.assign(provider as object, {
      submitSessionSetModel,
      setSessionWriteApproval,
      setSessionCommandApprovalPolicy,
      getBrowserModels: vi.fn(async () => [
        {
          id: "model-selected-before-send",
          displayName: "Selected model",
          provider: "test-provider",
          authenticated: true,
        },
      ]),
    });

    await (
      provider as unknown as {
        handleWebviewMessage(message: Record<string, unknown>): Promise<void>;
      }
    ).handleWebviewMessage({
      command: "agentSend",
      controllerEpoch: "epoch-1",
      tabId: "tab-4",
      sessionId: null,
      text: "exact tab prompt",
      mode: "code",
      model: "model-selected-before-send",
      agentWriteApproval: "project",
      commandApprovalPolicy: "approve-for-me",
    });

    expect(coordinator.newChat).toHaveBeenCalledWith(
      {
        controllerEpoch: "epoch-1",
        tabId: "tab-4",
        sessionId: null,
      },
      "code",
      { focus: false },
    );
    expect(createSession).not.toHaveBeenCalled();
    expect(switchTo).toHaveBeenCalledWith(createdSession.id);
    expect(submitSessionSetModel).toHaveBeenCalledWith(
      createdSession.id,
      "model-selected-before-send",
    );
    expect(setSessionWriteApproval).toHaveBeenCalledWith(
      createdSession.id,
      "project",
      projectScope.rootPath,
    );
    expect(setSessionCommandApprovalPolicy).toHaveBeenCalledWith(
      createdSession.id,
      "approve-for-me",
      projectScope.rootPath,
    );
    expect(submitSessionSetModel.mock.invocationCallOrder[0]).toBeLessThan(
      sendMessage.mock.invocationCallOrder[0]!,
    );
    expect(setSessionWriteApproval.mock.invocationCallOrder[0]).toBeLessThan(
      sendMessage.mock.invocationCallOrder[0]!,
    );
    expect(
      setSessionCommandApprovalPolicy.mock.invocationCallOrder[0],
    ).toBeLessThan(sendMessage.mock.invocationCallOrder[0]!);
    expect(sendMessage).toHaveBeenCalledWith(
      createdSession.id,
      "exact tab prompt",
      "code",
      expect.objectContaining({ origin: "vscode" }),
    );
  });

  it("hydrates the exact persisted session for a registered editor pane", async () => {
    const { provider } = await makeTabRoutingProvider();
    const address = {
      controllerEpoch: "epoch-1",
      tabId: "tab-source",
      sessionId: "source-session",
      surface: "editor" as const,
      paneEpoch: 3,
    };
    const session = { id: address.sessionId };
    const hydratePersistedSession = vi.fn(async () => session);
    const connection = {
      getAddress: vi.fn(() => address),
      postMessage: vi.fn(),
    };
    (provider as unknown as { sessionManager: unknown }).sessionManager = {
      getSession: vi.fn(() => undefined),
      hydratePersistedSession,
    };
    (provider as unknown as { chatTabController: unknown }).chatTabController =
      {
        getTab: vi.fn(() => ({
          id: address.tabId,
          sessionId: address.sessionId,
        })),
      };
    (provider as unknown as { chatTabPanelHost: unknown }).chatTabPanelHost = {
      isRegisteredConnection: vi.fn(() => true),
    };
    (
      provider as unknown as {
        getChatWorkspaceViewSnapshot(): undefined;
        getModesForSession(): Promise<unknown[]>;
        getBrowserModels(): Promise<unknown[]>;
        getSlashCommandsForSession(): Promise<unknown[]>;
        getWebviewSessionSummaries(): unknown[];
        buildSessionLoadedMessage(): Record<string, unknown>;
        buildChatState(): Record<string, unknown>;
      }
    ).getChatWorkspaceViewSnapshot = vi.fn(() => undefined);
    (
      provider as unknown as { getModesForSession(): Promise<unknown[]> }
    ).getModesForSession = vi.fn(async () => []);
    (
      provider as unknown as { getBrowserModels(): Promise<unknown[]> }
    ).getBrowserModels = vi.fn(async () => []);
    (
      provider as unknown as {
        getSlashCommandsForSession(): Promise<unknown[]>;
      }
    ).getSlashCommandsForSession = vi.fn(async () => []);
    (
      provider as unknown as { getWebviewSessionSummaries(): unknown[] }
    ).getWebviewSessionSummaries = vi.fn(() => []);
    (
      provider as unknown as {
        buildSessionLoadedMessage(): Record<string, unknown>;
      }
    ).buildSessionLoadedMessage = vi.fn(() => ({
      type: "agentSessionLoaded",
      sessionId: session.id,
    }));
    (
      provider as unknown as { buildChatState(): Record<string, unknown> }
    ).buildChatState = vi.fn(() => ({ sessionId: session.id }));

    await provider.hydrateEditorPane(address.tabId, connection as never);

    expect(hydratePersistedSession).toHaveBeenCalledWith(address.sessionId);
    expect(connection.postMessage).toHaveBeenCalledWith({
      type: "agentSessionLoaded",
      sessionId: session.id,
    });
  });

  it("rejects an editor pane whose address changes during persisted hydration", async () => {
    const { provider } = await makeTabRoutingProvider();
    let address = {
      controllerEpoch: "epoch-1",
      tabId: "tab-source",
      sessionId: "source-session",
      surface: "editor" as const,
      paneEpoch: 3,
    };
    let resolveHydration!: (session: { id: string }) => void;
    const hydratePersistedSession = vi.fn(
      () =>
        new Promise<{ id: string }>((resolve) => {
          resolveHydration = resolve;
        }),
    );
    const connection = {
      getAddress: vi.fn(() => address),
      postMessage: vi.fn(),
    };
    (provider as unknown as { sessionManager: unknown }).sessionManager = {
      getSession: vi.fn(() => undefined),
      hydratePersistedSession,
    };
    (provider as unknown as { chatTabController: unknown }).chatTabController =
      {
        getTab: vi.fn(() => ({
          id: address.tabId,
          sessionId: "source-session",
        })),
      };
    (provider as unknown as { chatTabPanelHost: unknown }).chatTabPanelHost = {
      isRegisteredConnection: vi.fn(() => true),
    };

    const hydration = provider.hydrateEditorPane(
      address.tabId,
      connection as never,
    );
    await vi.waitFor(() =>
      expect(hydratePersistedSession).toHaveBeenCalledOnce(),
    );
    address = { ...address, paneEpoch: 4 };
    resolveHydration({ id: "source-session" });

    await expect(hydration).rejects.toThrow(
      "editor pane no longer owns the selected chat tab",
    );
    expect(connection.postMessage).not.toHaveBeenCalled();
  });

  it("builds addressed chat state with the session project approval default", async () => {
    const { provider } = await makeTabRoutingProvider();
    const foregroundScope = {
      projectId: "project-foreground",
      workspaceFolderUri: "file:///workspace/foreground",
      displayName: "Foreground",
      rootPath: "/workspace/foreground",
    };
    const sourceScope = {
      projectId: "project-source",
      workspaceFolderUri: "file:///workspace/source",
      displayName: "Source",
      rootPath: "/workspace/source",
    };
    const source = {
      id: "source-session",
      mode: "code",
      model: "gpt-5.6-sol",
      status: "idle",
      reasoningEffort: "high",
      projectScope: sourceScope,
      projectAvailability: "unavailable",
    };
    (provider as unknown as { sessionManager: unknown }).sessionManager = {
      getForegroundSession: vi.fn(() => ({
        id: "foreground-session",
        projectScope: foregroundScope,
      })),
      getConfig: vi.fn(() => ({ model: source.model })),
      getWorkspaceProjects: vi.fn(() => []),
      getSessionApprovalMode: vi.fn(
        (_sessionId: string, configured: string) => ({
          commandApprovalPolicy: configured,
          approvalPolicy: "on-request",
          approvalReviewer: "user",
          executionPreset: "native-manual",
        }),
      ),
    };
    const getProjectConfiguration = vi.fn((scope: typeof sourceScope) => ({
      get: vi.fn((_key: string, fallback: string) =>
        scope.projectId === sourceScope.projectId ? "off" : fallback,
      ),
    }));
    (
      provider as unknown as {
        getProjectConfiguration: typeof getProjectConfiguration;
      }
    ).getProjectConfiguration = getProjectConfiguration;

    const state = (
      provider as unknown as {
        buildChatState(session: typeof source): {
          commandApprovalPolicy: string;
          configuredCommandApprovalPolicy: string;
        };
      }
    ).buildChatState(source);

    expect(state.commandApprovalPolicy).toBe("manual");
    expect(state.configuredCommandApprovalPolicy).toBe("manual");
    expect(getProjectConfiguration).toHaveBeenCalledWith(sourceScope);
  });

  it("routes editor-owned commands from the authoritative pane session", async () => {
    const { provider, handleEditor } = await makeEditorRoutingProvider();
    const source = {
      id: "source-session",
      mode: "code",
      projectScope: {
        projectId: "project-source",
        workspaceFolderUri: "file:///workspace/source",
        rootPath: "/workspace/source",
      },
    };
    const foreground = {
      id: "foreground-session",
      mode: "ask",
      projectScope: {
        projectId: "project-foreground",
        workspaceFolderUri: "file:///workspace/foreground",
        rootPath: "/workspace/foreground",
      },
    };
    const submitSessionSetModel = vi.fn(async () => ({ ok: true }));
    (
      provider as unknown as {
        submitSessionSetModel: typeof submitSessionSetModel;
      }
    ).submitSessionSetModel = submitSessionSetModel;
    const steerAuthorizedBackground = vi.fn();
    (provider as unknown as { sessionManager: unknown }).sessionManager = {
      getSession: vi.fn((sessionId: string) =>
        sessionId === source.id ? source : undefined,
      ),
      getForegroundSession: vi.fn(() => foreground),
      steerAuthorizedBackground,
    };

    await handleEditor({
      command: "agentSetModel",
      sessionId: "child-target",
      model: "model-next",
    });
    await handleEditor({
      command: "steerBgAgent",
      sessionId: "child-target",
      message: "change direction",
    });

    expect(submitSessionSetModel).toHaveBeenCalledWith(source.id, "model-next");
    expect(steerAuthorizedBackground).toHaveBeenCalledWith(
      source.id,
      "child-target",
      "change direction",
    );
  });

  it("loads editor history from the pane session instead of a payload target", async () => {
    const { provider, handleEditor, postMessage } =
      await makeEditorRoutingProvider();
    const sourceMessages: AgentMessage[] = [
      { role: "user", content: "source one" },
      { role: "assistant", content: "answer one" },
      { role: "user", content: "source two" },
      { role: "assistant", content: "answer two" },
      { role: "user", content: "source three" },
    ];
    const source = {
      id: "source-session",
      getAllMessages: vi.fn(() => sourceMessages),
    };
    const foreground = {
      id: "foreground-session",
      getAllMessages: vi.fn(() => [
        { role: "user", content: "wrong foreground" },
      ]),
    };
    (provider as unknown as { sessionManager: unknown }).sessionManager = {
      getSession: vi.fn((sessionId: string) =>
        sessionId === source.id ? source : undefined,
      ),
      getForegroundSession: vi.fn(() => foreground),
      getCheckpoints: vi.fn(() => []),
    };

    await handleEditor({
      command: "agentLoadEarlierSessionMessages",
      sessionId: "payload-target",
      beforeUserTurnOffset: 2,
    });

    expect(source.getAllMessages).toHaveBeenCalledOnce();
    expect(foreground.getAllMessages).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "agentSessionChunk",
        sessionId: source.id,
        messages: expect.arrayContaining([
          expect.objectContaining({ content: "source one" }),
        ]),
      }),
    );
  });

  it("publishes a new tab binding before its session-scoped hydration", async () => {
    const { coordinator, handle, provider } = await makeTabRoutingProvider();
    const publicationOrder: string[] = [];
    const session = { id: "session-2" };
    coordinator.newTab.mockResolvedValueOnce({
      ok: true,
      session,
    });
    (
      provider as unknown as {
        sendChatWorkspaceUpdate(): void;
        postSessionLoaded(session: unknown, options: unknown): void;
        sendInitialState(): void;
        sendModesUpdate(): Promise<void>;
        sendSlashCommands(): Promise<void>;
      }
    ).sendChatWorkspaceUpdate = vi.fn(() => publicationOrder.push("workspace"));
    (
      provider as unknown as {
        postSessionLoaded(session: unknown, options: unknown): void;
      }
    ).postSessionLoaded = vi.fn(() => publicationOrder.push("session"));
    (
      provider as unknown as {
        sendInitialState(): void;
      }
    ).sendInitialState = vi.fn(() => publicationOrder.push("state"));
    (
      provider as unknown as {
        sendModesUpdate(): Promise<void>;
      }
    ).sendModesUpdate = vi.fn(async () => {
      publicationOrder.push("modes");
    });
    (
      provider as unknown as {
        sendSlashCommands(): Promise<void>;
      }
    ).sendSlashCommands = vi.fn(async () => {
      publicationOrder.push("commands");
    });

    await handle({
      command: "chatTabNew",
      controllerEpoch: "epoch-1",
      tabId: "tab-1",
      sessionId: "session-1",
      mode: "code",
    });

    expect(publicationOrder).toEqual([
      "workspace",
      "session",
      "state",
      "modes",
      "commands",
    ]);
  });

  it("rejects omitted or stale tab identity with the latest snapshot", async () => {
    const { coordinator, handle, postMessage, snapshot } =
      await makeTabRoutingProvider();

    await handle({
      command: "chatTabFocus",
      controllerEpoch: "epoch-1",
      tabId: "tab-1",
    });
    expect(coordinator.focus).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenLastCalledWith({
      type: "chatTabActionRejected",
      rejection: {
        command: "chatTabFocus",
        reason: "invalid_address",
        snapshot,
      },
    });

    coordinator.focus.mockResolvedValueOnce({
      ok: false,
      reason: "stale_session",
    });
    await handle({
      command: "chatTabFocus",
      controllerEpoch: "epoch-1",
      tabId: "tab-1",
      sessionId: "stale-session",
    });
    expect(coordinator.focus).toHaveBeenCalledWith({
      controllerEpoch: "epoch-1",
      tabId: "tab-1",
      sessionId: "stale-session",
    });
    expect(postMessage).toHaveBeenLastCalledWith({
      type: "chatTabActionRejected",
      rejection: {
        command: "chatTabFocus",
        reason: "stale_session",
        snapshot,
      },
    });
  });

  it("forwards a busy New Chat confirmation with its exact replay identity", async () => {
    const { coordinator, handle, postMessage } = await makeTabRoutingProvider();
    coordinator.newChat.mockResolvedValueOnce({
      ok: false,
      reason: "confirmation_required",
      action: "new_chat",
      tab: {
        id: "tab-1",
        displayNumber: 1,
        sessionId: "session-1",
        placement: "docked",
        terminalGeneration: 1,
      },
    });

    await handle({
      command: "chatTabNewChat",
      controllerEpoch: "epoch-1",
      tabId: "tab-1",
      sessionId: "session-1",
      mode: "debug",
      projectId: "project-1",
    });

    expect(coordinator.newChat).toHaveBeenCalledWith(
      {
        controllerEpoch: "epoch-1",
        tabId: "tab-1",
        sessionId: "session-1",
      },
      "debug",
      { projectId: "project-1", stopRunning: false },
    );
    expect(postMessage).toHaveBeenLastCalledWith({
      type: "chatTabActionConfirmationRequested",
      request: {
        command: "chatTabNewChat",
        action: "new_chat",
        address: {
          controllerEpoch: "epoch-1",
          tabId: "tab-1",
          sessionId: "session-1",
        },
        mode: "debug",
        projectId: "project-1",
        targetSessionId: undefined,
      },
    });
  });

  it("routes validated pop-out and dock actions to the panel host", async () => {
    const { handle, panelHost } = await makeTabRoutingProvider();
    const address = {
      controllerEpoch: "epoch-1",
      tabId: "tab-1",
      sessionId: "session-1",
    };

    await handle({ command: "chatTabPopOut", ...address });
    await handle({ command: "chatTabDock", ...address });

    expect(panelHost.popOut).toHaveBeenCalledWith("tab-1");
    expect(panelHost.dock).toHaveBeenCalledWith("tab-1");
  });

  it("rejects stale placement actions and reports failed handoffs", async () => {
    const { chatTabController, handle, panelHost, postMessage, snapshot } =
      await makeTabRoutingProvider();
    chatTabController.validateAction.mockReturnValueOnce({
      ok: false,
      reason: "stale_session",
    } as never);
    const address = {
      controllerEpoch: "epoch-1",
      tabId: "tab-1",
      sessionId: "session-1",
    };

    await handle({ command: "chatTabPopOut", ...address });
    expect(panelHost.popOut).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenLastCalledWith({
      type: "chatTabActionRejected",
      rejection: {
        command: "chatTabPopOut",
        reason: "stale_session",
        snapshot,
      },
    });

    panelHost.dock.mockResolvedValueOnce(false);
    await handle({ command: "chatTabDock", ...address });
    expect(postMessage).toHaveBeenLastCalledWith({
      type: "chatTabActionFailed",
      failure: {
        command: "chatTabDock",
        reason: "placement_failed",
        snapshot,
      },
    });
  });

  it("releases the editor panel after a logical tab close", async () => {
    const { coordinator, handle, panelHost, provider } =
      await makeTabRoutingProvider();
    coordinator.close.mockResolvedValueOnce({
      ok: true,
      tab: {
        id: "tab-1",
        displayNumber: 1,
        sessionId: "session-1",
        placement: "popped",
        terminalGeneration: 1,
      },
    });
    (
      provider as unknown as {
        sendChatWorkspaceUpdate(): void;
        sendInitialState(): void;
        sendModelsUpdate(): Promise<void>;
      }
    ).sendChatWorkspaceUpdate = vi.fn();
    (provider as unknown as { sendInitialState(): void }).sendInitialState =
      vi.fn();
    (
      provider as unknown as { sendModelsUpdate(): Promise<void> }
    ).sendModelsUpdate = vi.fn(async () => {});

    await handle({
      command: "chatTabClose",
      controllerEpoch: "epoch-1",
      tabId: "tab-1",
      sessionId: "session-1",
    });

    expect(panelHost.releaseTab).toHaveBeenCalledWith("tab-1");
    expect(
      (provider as unknown as { sendModelsUpdate(): Promise<void> })
        .sendModelsUpdate,
    ).toHaveBeenCalledOnce();
  });

  it("forwards confirmed history replacement and exact reorder identity", async () => {
    const { coordinator, handle } = await makeTabRoutingProvider();
    coordinator.loadSession.mockResolvedValueOnce({
      ok: false,
      reason: "session_not_found",
    });
    coordinator.reorder.mockResolvedValueOnce({
      ok: false,
      reason: "invalid_order",
    });
    const address = {
      controllerEpoch: "epoch-1",
      tabId: "tab-1",
      sessionId: "session-1",
    };

    await handle({
      command: "chatTabLoadSession",
      ...address,
      targetSessionId: "session-2",
      stopRunning: true,
    });
    await handle({
      command: "chatTabReorder",
      ...address,
      tabIds: ["tab-2", "tab-1"],
    });

    expect(coordinator.loadSession).toHaveBeenCalledWith(address, "session-2", {
      stopRunning: true,
    });
    expect(coordinator.reorder).toHaveBeenCalledWith(address, [
      "tab-2",
      "tab-1",
    ]);
  });
});

describe("special block pop-out panel", () => {
  it("loads the bundled panel script and embeds breakout-safe source data", async () => {
    const vscode = await import("vscode");
    const { ChatViewProvider } = await import("./ChatViewProvider.js");
    const provider = new ChatViewProvider(
      { fsPath: "/tmp/ext" } as never,
      { get: vi.fn(), update: vi.fn() } as never,
    );
    const asWebviewUri = vi.fn(
      () => "https://webview.test/dist/special-block-panel.js",
    );
    const webview = { asWebviewUri, cspSource: "https://webview.test" };
    const source = 'graph TD\n  A["</script><b>x</b>"] --> B';

    const html = (
      provider as unknown as {
        getSpecialBlockPanelHtml: (
          webview: unknown,
          kind: string,
          source: string,
        ) => string;
      }
    ).getSpecialBlockPanelHtml(webview, "mermaid", source);

    // The panel must load the self-contained bundle from dist — raw
    // node_modules files are not shipped in the packaged .vsix.
    expect(
      vi
        .mocked(vscode.Uri.joinPath)
        .mock.calls.some((call) => call.includes("special-block-panel.js")),
    ).toBe(true);
    expect(html).toContain(
      'src="https://webview.test/dist/special-block-panel.js"',
    );
    expect(html).not.toContain("node_modules");

    const dataMatch = html.match(
      /<script id="special-block-data" type="application\/json">([\s\S]*?)<\/script>/,
    );
    expect(dataMatch).toBeTruthy();
    expect(dataMatch![1]).not.toContain("</script>");
    expect(JSON.parse(dataMatch![1]!)).toEqual({ kind: "mermaid", source });
  });
});

describe("provisional restore tail hydration", () => {
  it("paints the persisted tail before the startup restore resolves, then applies the complete hydration", async () => {
    const { ChatViewProvider } = await import("./ChatViewProvider.js");
    const provider = new ChatViewProvider(
      { fsPath: "/tmp/ext" } as never,
      { get: vi.fn(), update: vi.fn() } as never,
    );
    const posted: Array<Record<string, unknown>> = [];
    (provider as unknown as { view: unknown }).view = {
      webview: {
        postMessage: vi.fn(async (message: Record<string, unknown>) => {
          posted.push(message);
          return true;
        }),
      },
    };

    const fullMessages = [
      { role: "user", content: "first prompt" },
      { role: "assistant", content: "first reply" },
      { role: "user", content: "tail question" },
      { role: "assistant", content: "tail answer" },
    ];
    const tailSnapshot = {
      sessionId: "restored-1",
      totalMessages: 4,
      messageIndexOffset: 2,
      userTurnOffset: 1,
      hasMoreBefore: true,
      transcriptRevision: 5,
      title: "Restored session",
      mode: "code",
      model: "claude-sonnet-4-6",
      lastInputTokens: 111,
      todos: [],
      runStatePhase: "running",
      firstUserMessage: fullMessages[0],
      messages: fullMessages.slice(2),
    };
    const session = {
      id: "restored-1",
      title: "Restored session",
      mode: "code",
      model: "claude-sonnet-4-6",
      status: "idle",
      transcriptRevision: 5,
      lastInputTokens: 111,
      inFlightAssistantBlocks: [],
      runState: undefined,
      getAllMessages: () => fullMessages,
    };
    let liveSession: typeof session | null = null;
    const readPersistedSessionTail = vi.fn(async () => tailSnapshot);
    provider.setSessionManager({
      getForegroundSession: vi.fn(() => liveSession),
      getSession: vi.fn((id: string) =>
        id === "restored-1" ? (liveSession ?? undefined) : undefined,
      ),
      readPersistedSessionTail,
      getBackgroundCompletionsForParent: vi.fn(() => []),
    } as never);

    // Persisted tab layout is available before any session is hydrated.
    vi.spyOn(
      provider as unknown as { getChatWorkspaceViewSnapshot: () => unknown },
      "getChatWorkspaceViewSnapshot",
    ).mockReturnValue({
      controllerEpoch: 1,
      focusedTabId: "tab-1",
      tabs: [{ tabId: "tab-1", sessionId: "restored-1" }],
    });
    for (const stub of [
      "sendModesUpdate",
      "sendModelsUpdate",
      "sendSlashCommands",
      "sendSessionList",
      "sendInitialState",
      "sendDebugInfo",
      "startHostHeartbeat",
    ]) {
      vi.spyOn(
        provider as unknown as Record<string, () => unknown>,
        stub,
      ).mockImplementation(() => undefined);
    }

    let resolveRestore!: () => void;
    const restorePromise = new Promise<void>((resolve) => {
      resolveRestore = () => {
        liveSession = session;
        resolve();
      };
    });
    provider.setChatTabStartupRestore(restorePromise);

    const hydrate = (
      provider as unknown as { hydrateReadyWebview: () => Promise<void> }
    ).hydrateReadyWebview();

    // The provisional tail arrives while the full restore is still pending.
    await vi.waitFor(() => {
      expect(
        posted.some((message) => message.type === "agentSessionLoaded"),
      ).toBe(true);
    });
    expect(liveSession).toBeNull();
    const provisional = posted.find(
      (message) => message.type === "agentSessionLoaded",
    )!;
    expect(provisional).toMatchObject({
      sessionId: "restored-1",
      restored: true,
      title: "Restored session",
      originalPrompt: "first prompt",
      messages: fullMessages.slice(2),
      messageIndexOffset: 2,
      userTurnOffset: 1,
      hasMoreBefore: true,
      transcriptRevision: 5,
      lastInputTokens: 111,
      streaming: false,
      // The persisted run state marks an interrupted run, so the resume
      // controls can appear with the provisional paint.
      interrupted: true,
    });
    expect(readPersistedSessionTail).toHaveBeenCalledWith("restored-1");
    expect(
      posted.findIndex(
        (message) => message.type === "agentRestoreSessionStart",
      ),
    ).toBeLessThan(posted.indexOf(provisional));
    expect(
      posted.some((message) => message.type === "agentRestoreSessionDone"),
    ).toBe(false);

    resolveRestore();
    await hydrate;

    const loads = posted.filter(
      (message) => message.type === "agentSessionLoaded",
    );
    expect(loads).toHaveLength(2);
    // The complete hydration supersedes the provisional tail: full transcript
    // window, same deterministic index base semantics.
    expect(loads[1]).toMatchObject({
      sessionId: "restored-1",
      restored: true,
      originalPrompt: "first prompt",
      messages: fullMessages,
      messageIndexOffset: 0,
      hasMoreBefore: false,
      // The live session has no runState, so the complete hydration clears
      // the provisional interrupted flag.
      interrupted: false,
    });
    expect(
      posted.findIndex((message) => message.type === "agentRestoreSessionDone"),
    ).toBeGreaterThan(posted.indexOf(loads[1]!));
    provider.dispose();
  });

  it("skips the provisional paint when the startup restore already settled or the session is live", async () => {
    const { ChatViewProvider } = await import("./ChatViewProvider.js");
    const provider = new ChatViewProvider(
      { fsPath: "/tmp/ext" } as never,
      { get: vi.fn(), update: vi.fn() } as never,
    );
    const posted: Array<Record<string, unknown>> = [];
    (provider as unknown as { view: unknown; webviewReady: boolean }).view = {
      webview: {
        postMessage: vi.fn(async (message: Record<string, unknown>) => {
          posted.push(message);
          return true;
        }),
      },
    };
    (provider as unknown as { webviewReady: boolean }).webviewReady = true;
    const readPersistedSessionTail = vi.fn(async () => null);
    provider.setSessionManager({
      getForegroundSession: vi.fn(() => ({ id: "live-1" })),
      getSession: vi.fn(() => ({ id: "live-1" })),
      readPersistedSessionTail,
    } as never);

    // Settled restore (the constructor default): nothing to paint provisionally.
    await (
      provider as unknown as {
        postProvisionalRestoredTail: () => Promise<void>;
      }
    ).postProvisionalRestoredTail();
    expect(readPersistedSessionTail).not.toHaveBeenCalled();

    // Pending restore but the session is already live in memory: the live
    // transcript is authoritative.
    provider.setChatTabStartupRestore(new Promise(() => {}));
    await (
      provider as unknown as {
        postProvisionalRestoredTail: () => Promise<void>;
      }
    ).postProvisionalRestoredTail();
    expect(readPersistedSessionTail).not.toHaveBeenCalled();
    expect(
      posted.some((message) => message.type === "agentSessionLoaded"),
    ).toBe(false);
    provider.dispose();
  });

  it("defers a resume request until the startup restore has made the session live", async () => {
    const { ChatViewProvider } = await import("./ChatViewProvider.js");
    const provider = new ChatViewProvider(
      { fsPath: "/tmp/ext" } as never,
      { get: vi.fn(), update: vi.fn() } as never,
    );
    let liveSession: { id: string } | null = null;
    const resumeInterruptedSession = vi.fn(async () => true);
    const hydratePersistedSession = vi.fn(async () => {
      liveSession = { id: "restored-1" };
      return liveSession;
    });
    provider.setSessionManager({
      getForegroundSession: vi.fn(() => liveSession),
      getSession: vi.fn((id: string) =>
        id === "restored-1" ? (liveSession ?? undefined) : undefined,
      ),
      resumeInterruptedSession,
      hydratePersistedSession,
    } as never);

    let resolveRestore!: () => void;
    provider.setChatTabStartupRestore(
      new Promise<void>((resolve) => {
        resolveRestore = resolve;
      }),
    );

    const handleWebviewMessage = (
      provider as unknown as {
        handleWebviewMessage(message: Record<string, unknown>): Promise<void>;
      }
    ).handleWebviewMessage.bind(provider);
    await handleWebviewMessage({
      command: "agentResumeSession",
      sessionId: "restored-1",
    });

    // The resume click arrived while the restore was still running: it must
    // wait for the session instead of silently failing on a not-yet-live id.
    expect(resumeInterruptedSession).not.toHaveBeenCalled();

    resolveRestore();
    await vi.waitFor(() => {
      expect(resumeInterruptedSession).toHaveBeenCalledWith("restored-1");
    });
    // The restore had not made the session live, so the handler hydrated it
    // on demand before resuming.
    expect(hydratePersistedSession).toHaveBeenCalledWith("restored-1");
    provider.dispose();
  });
});
