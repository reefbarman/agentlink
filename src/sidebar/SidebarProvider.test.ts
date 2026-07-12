import { beforeEach, describe, expect, it, vi } from "vitest";

type MessageHandler = (message: Record<string, unknown>) => void;

const commandExec = vi.fn();

const mockVscode = {
  window: {
    showWarningMessage: vi.fn(),
    showInformationMessage: vi.fn(),
    showTextDocument: vi.fn(),
    createTerminal: vi.fn(() => ({ show: vi.fn(), sendText: vi.fn() })),
  },
  workspace: {
    workspaceFolders: [],
    getConfiguration: vi.fn(() => ({
      get: vi.fn((_key: string, fallback?: unknown) => fallback),
      update: vi.fn(),
    })),
  },
  commands: {
    executeCommand: commandExec,
  },

  Uri: {
    joinPath: (...parts: Array<{ path?: string } | string>) => ({
      path: parts
        .map((p) => (typeof p === "string" ? p : (p.path ?? "")))
        .join("/"),
    }),
    file: (fsPath: string) => ({ fsPath }),
  },
  ConfigurationTarget: {
    Global: 1,
  },
  ViewColumn: {
    One: 1,
  },
};

vi.mock("vscode", () => mockVscode);

function makeApprovalManager() {
  return {
    onDidChange: () => ({ dispose: vi.fn() }),
    getActiveSessions: () => [
      {
        id: "session-a",
        writeApproved: true,
        agentWriteApproved: true,
        commandRuleCount: 1,
        pathRuleCount: 1,
        writeRuleCount: 1,
        lastActivity: Date.now(),
      },
    ],
    getAgentWriteApprovalState: () => "prompt",
    getWriteApprovalState: () => "prompt",
    getCommandRules: (sessionId: string) => ({
      session:
        sessionId === "session-a"
          ? [{ pattern: "npm test", mode: "exact" as const }]
          : [],
      project: [{ pattern: "npm", mode: "prefix" as const }],
      global: [{ pattern: "git status", mode: "exact" as const }],
    }),
    getPathRules: (sessionId: string) => ({
      session:
        sessionId === "session-a"
          ? [{ pattern: "src/**", mode: "glob" as const }]
          : [],
      project: [],
      global: [],
    }),
    getWriteRules: (sessionId: string) => ({
      session:
        sessionId === "session-a"
          ? [{ pattern: "src/**", mode: "glob" as const }]
          : [],
      project: [],
      global: [],
      settings: ["**/*.test.ts"],
    }),
    resetWriteApproval: vi.fn(),
    resetAgentWriteApproval: vi.fn(),
    setWriteApproval: vi.fn(),
    setAgentWriteApproval: vi.fn(),
  };
}

function makeWebviewView() {
  let onDidReceiveMessage: MessageHandler | undefined;
  let onDidChangeVisibility: (() => void) | undefined;
  const postMessage = vi.fn();
  const view = {
    webview: {
      options: {},
      html: "",
      cspSource: "vscode-resource:",
      postMessage,
      onDidReceiveMessage: (cb: MessageHandler) => {
        onDidReceiveMessage = cb;
        return { dispose: vi.fn() };
      },
      asWebviewUri: (uri: { path?: string }) => ({
        toString: () => `webview:${uri.path ?? ""}`,
      }),
    },
    visible: true,
    onDidChangeVisibility: (cb: () => void) => {
      onDidChangeVisibility = cb;
      return { dispose: vi.fn() };
    },
    onDidDispose: vi.fn(),
  };
  return {
    view,
    postMessage,
    getMessageHandler: () => onDidReceiveMessage,
    getVisibilityHandler: () => onDidChangeVisibility,
  };
}

describe("SidebarProvider write approval sync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("setWriteApproval session updates both legacy and agent approval tracks", async () => {
    const { SidebarProvider } = await import("./SidebarProvider.js");

    const provider = new SidebarProvider({ path: "/ext" } as never);

    const resetWriteApproval = vi.fn();
    const resetAgentWriteApproval = vi.fn();
    const setWriteApproval = vi.fn();
    const setAgentWriteApproval = vi.fn();

    provider.setApprovalManager({
      onDidChange: () => ({ dispose: vi.fn() }),
      getActiveSessions: () => [
        {
          id: "session-a",
          writeApproved: false,
          agentWriteApproved: false,
          commandRuleCount: 0,
          pathRuleCount: 0,
          writeRuleCount: 0,
          lastActivity: Date.now(),
        },
        {
          id: "session-b",
          writeApproved: false,
          agentWriteApproved: false,
          commandRuleCount: 0,
          pathRuleCount: 0,
          writeRuleCount: 0,
          lastActivity: Date.now(),
        },
      ],
      getAgentWriteApprovalState: () => "prompt",
      getWriteApprovalState: () => "prompt",
      getCommandRules: () => ({ session: [], project: [], global: [] }),
      getPathRules: () => ({ session: [], project: [], global: [] }),
      getWriteRules: () => ({
        session: [],
        project: [],
        global: [],
        settings: [],
      }),
      resetWriteApproval,
      resetAgentWriteApproval,
      setWriteApproval,
      setAgentWriteApproval,
    } as never);

    let onDidReceiveMessage: MessageHandler | undefined;

    provider.resolveWebviewView(
      {
        webview: {
          options: {},
          html: "",
          postMessage: vi.fn(),
          onDidReceiveMessage: (cb: MessageHandler) => {
            onDidReceiveMessage = cb;
            return { dispose: vi.fn() };
          },
          asWebviewUri: (uri: unknown) => uri,
        },
        visible: true,
        onDidChangeVisibility: vi.fn(),
        onDidDispose: vi.fn(),
      } as never,
      {} as never,
      {} as never,
    );

    expect(onDidReceiveMessage).toBeTypeOf("function");

    onDidReceiveMessage!({ command: "setWriteApproval", mode: "session" });

    expect(resetWriteApproval).toHaveBeenCalledTimes(1);
    expect(resetAgentWriteApproval).toHaveBeenCalledTimes(1);

    expect(setWriteApproval).toHaveBeenCalledTimes(2);
    expect(setWriteApproval).toHaveBeenNthCalledWith(1, "session-a", "session");
    expect(setWriteApproval).toHaveBeenNthCalledWith(2, "session-b", "session");

    expect(setAgentWriteApproval).toHaveBeenCalledTimes(2);
    expect(setAgentWriteApproval).toHaveBeenNthCalledWith(
      1,
      "session-a",
      "session",
    );
    expect(setAgentWriteApproval).toHaveBeenNthCalledWith(
      2,
      "session-b",
      "session",
    );
  });
});

describe("SidebarProvider retained activity behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the shared shell with sidebar resources", async () => {
    const { SidebarProvider } = await import("./SidebarProvider.js");
    const provider = new SidebarProvider({ path: "/ext" } as never);
    const webview = makeWebviewView();

    provider.resolveWebviewView(
      webview.view as never,
      {} as never,
      {} as never,
    );

    expect(webview.view.webview.html).toContain("<title>AgentLink</title>");
    expect(webview.view.webview.html).toContain(
      'href="webview:/ext/dist/sidebar.css"',
    );
    expect(webview.view.webview.html).toContain(
      'src="webview:/ext/dist/sidebar.js"',
    );
    expect(webview.view.webview.html).not.toContain("codicon.css");
  });

  it("restores approval, index, session, and tool-call state on webviewReady", async () => {
    const { SidebarProvider } = await import("./SidebarProvider.js");
    const provider = new SidebarProvider({ path: "/ext" } as never);
    provider.setApprovalManager(makeApprovalManager() as never);
    const toolCalls = [
      {
        id: "tool-1",
        toolName: "execute_command",
        displayArgs: "npm test",
        startedAt: 1,
        status: "active" as const,
        canContinueInBackground: true,
      },
    ];
    provider.setToolCallTracker({
      on: vi.fn(),
      getActiveCalls: () => toolCalls,
    } as never);
    provider.updateIndexStatus({
      state: "indexing",
      current: 2,
      total: 10,
      detail: "Indexing files",
    });
    const webview = makeWebviewView();

    provider.resolveWebviewView(
      webview.view as never,
      {} as never,
      {} as never,
    );
    webview.getMessageHandler()?.({ command: "webviewReady" });

    expect(webview.postMessage).toHaveBeenCalledWith({
      type: "stateUpdate",
      state: expect.objectContaining({
        writeApproval: "session",
        globalCommandRules: [{ pattern: "git status", mode: "exact" }],
        projectCommandRules: [{ pattern: "npm", mode: "prefix" }],
        activeSessions: [
          expect.objectContaining({
            id: "session-a",
            writeApproved: true,
            agentWriteApproved: true,
            commandRules: [{ pattern: "npm test", mode: "exact" }],
            pathRules: [{ pattern: "src/**", mode: "glob" }],
            writeRules: [{ pattern: "src/**", mode: "glob" }],
          }),
        ],
        indexStatus: expect.objectContaining({
          state: "indexing",
          current: 2,
          total: 10,
        }),
      }),
    });
    expect(webview.postMessage).toHaveBeenCalledWith({
      type: "updateToolCalls",
      calls: toolCalls,
    });
  });

  it("refreshes retained state when the Activity view becomes visible again", async () => {
    const { SidebarProvider } = await import("./SidebarProvider.js");
    const provider = new SidebarProvider({ path: "/ext" } as never);
    provider.setApprovalManager(makeApprovalManager() as never);
    const toolCalls = [
      {
        id: "tool-visible",
        toolName: "read_file",
        displayArgs: "src/index.ts",
        startedAt: 1,
        status: "active" as const,
      },
    ];
    provider.setToolCallTracker({
      on: vi.fn(),
      getActiveCalls: () => toolCalls,
    } as never);
    const webview = makeWebviewView();
    provider.resolveWebviewView(
      webview.view as never,
      {} as never,
      {} as never,
    );
    webview.postMessage.mockClear();

    webview.getVisibilityHandler()?.();

    expect(webview.postMessage).toHaveBeenCalledWith({
      type: "stateUpdate",
      state: expect.objectContaining({
        writeApproval: "session",
        activeSessions: [expect.objectContaining({ id: "session-a" })],
      }),
    });
    expect(webview.postMessage).toHaveBeenCalledWith({
      type: "updateToolCalls",
      calls: toolCalls,
    });
  });

  it.each([
    ["openSettings", ["workbench.action.openSettings", "agentlink"]],
    ["openOutput", ["workbench.action.output.show"]],
    ["openBrowserGateway", ["agentlink.openBrowserGateway"]],
    ["rebuildIndex", ["agentlink.rebuildIndex"]],
    ["cancelIndex", ["agentlink.cancelIndex"]],
    ["resumeIndex", ["agentlink.resumeIndex"]],
    ["setOpenaiApiKey", ["agentlink.setOpenaiApiKey"]],
    [
      "setOpenaiModelsAndEmbeddingsApiKey",
      ["agentlink.codexSignIn", "apiKeyOnly"],
    ],
  ])("forwards the retained %s shortcut", async (command, expected) => {
    const { SidebarProvider } = await import("./SidebarProvider.js");
    const provider = new SidebarProvider({ path: "/ext" } as never);
    const webview = makeWebviewView();
    provider.resolveWebviewView(
      webview.view as never,
      {} as never,
      {} as never,
    );

    webview.getMessageHandler()?.({ command });

    expect(commandExec).toHaveBeenCalledWith(...expected);
  });

  it("opens the configured AgentLink output channel", async () => {
    const { SidebarProvider } = await import("./SidebarProvider.js");
    const showOutput = vi.fn();
    const provider = new SidebarProvider(
      { path: "/ext" } as never,
      undefined,
      showOutput,
    );
    const webview = makeWebviewView();
    provider.resolveWebviewView(
      webview.view as never,
      {} as never,
      {} as never,
    );

    webview.getMessageHandler()?.({ command: "openOutput" });

    expect(showOutput).toHaveBeenCalledOnce();
    expect(commandExec).not.toHaveBeenCalledWith(
      "workbench.action.output.show",
    );
  });

  it.each([
    ["cancelToolCall", "agentlink.cancelToolCall"],
    ["completeToolCall", "agentlink.completeToolCall"],
    ["continueToolCallInBackground", "agentlink.continueToolCallInBackground"],
  ])(
    "forwards the retained %s control with its call id",
    async (command, id) => {
      const { SidebarProvider } = await import("./SidebarProvider.js");
      const provider = new SidebarProvider({ path: "/ext" } as never);
      const webview = makeWebviewView();
      provider.resolveWebviewView(
        webview.view as never,
        {} as never,
        {} as never,
      );

      webview.getMessageHandler()?.({ command, id: "tool-1" });

      expect(commandExec).toHaveBeenCalledWith(id, "tool-1");
    },
  );
});
