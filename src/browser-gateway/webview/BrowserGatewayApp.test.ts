/** @vitest-environment jsdom */

import type { ChatMessage, TodoItem } from "../../agent/webview/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/preact";

import type { ApprovalRequest } from "../../approvals/webview/types";
import { BrowserGatewayApp } from "./BrowserGatewayApp";
import { h } from "preact";
import { within } from "@testing-library/preact";

vi.mock("../../agent/webview/components/InputArea", () => ({
  InputArea: ({
    allowThinkingToggle,
    availableModels,
    onExecuteBuiltinCommand,
    onExportTranscript,
    onSelectModel,
    onSend,
    onSetReasoningEffort,
    onStop,
    slashCommands,
    submitOnEnter,
  }: {
    allowThinkingToggle?: boolean;
    availableModels?: Array<{ id: string; displayName?: string }>;
    onExecuteBuiltinCommand?: (name: string, args: string) => void;
    onExportTranscript?: () => void;
    onSelectModel?: (modelId: string) => void;
    onSend?: (text: string, attachments: string[]) => void;
    onSetReasoningEffort?: (effort: "none" | "low" | "medium" | "high") => void;
    onStop?: () => void;
    slashCommands?: Array<{ name: string }>;
    submitOnEnter?: boolean;
  }) =>
    h("div", { "data-testid": "mock-input-area" }, [
      h(
        "button",
        {
          type: "button",
          "data-testid": "trigger-mcp",
          onClick: () => onExecuteBuiltinCommand?.("mcp", ""),
        },
        "Trigger /mcp",
      ),
      h(
        "button",
        {
          type: "button",
          "data-testid": "trigger-mcp-config",
          onClick: () => onExecuteBuiltinCommand?.("mcp-config", ""),
        },
        "Trigger /mcp-config",
      ),
      h(
        "button",
        {
          type: "button",
          "data-testid": "trigger-mcp-refresh",
          onClick: () => onExecuteBuiltinCommand?.("mcp-refresh", ""),
        },
        "Trigger /mcp-refresh",
      ),
      h(
        "button",
        {
          type: "button",
          "data-testid": "trigger-send",
          onClick: () => onSend?.("Ship it", []),
        },
        "Trigger send",
      ),
      h(
        "button",
        {
          type: "button",
          "data-testid": "trigger-select-model",
          onClick: () => onSelectModel?.(availableModels?.[0]?.id ?? "model-a"),
        },
        "Trigger model",
      ),
      h(
        "button",
        {
          type: "button",
          "data-testid": "trigger-stop",
          onClick: () => onStop?.(),
        },
        "Trigger stop",
      ),
      h(
        "button",
        {
          type: "button",
          "data-testid": "trigger-export-transcript",
          onClick: () => onExportTranscript?.(),
        },
        "Trigger export",
      ),
      h(
        "button",
        {
          type: "button",
          "data-testid": "trigger-thinking",
          onClick: () => onSetReasoningEffort?.("low"),
        },
        "Trigger thinking",
      ),
      h(
        "span",
        { "data-testid": "model-count" },
        String(availableModels?.length ?? 0),
      ),
      h(
        "span",
        { "data-testid": "thinking-visible" },
        allowThinkingToggle ? "true" : "false",
      ),
      h(
        "span",
        { "data-testid": "slash-command-count" },
        String(slashCommands?.length ?? 0),
      ),
      h(
        "span",
        { "data-testid": "slash-command-names" },
        slashCommands?.map((command) => command.name).join(",") ?? "",
      ),
      h(
        "span",
        { "data-testid": "submit-on-enter" },
        submitOnEnter ? "true" : "false",
      ),
    ]),
}));

vi.mock("./components/BrowserDiffViewer", () => ({
  BrowserDiffViewer: ({ requestId }: { requestId: string | null }) =>
    h("div", { "data-testid": "browser-diff-viewer" }, requestId ?? "none"),
}));

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function createAskAgentMcpConfigSnapshot() {
  const statusInfos = [
    {
      name: "linear",
      status: "connected",
      toolCount: 1,
      resourceCount: 0,
      promptCount: 0,
      tools: [{ name: "list_issues", description: "List issues" }],
    },
  ];
  return {
    profile: "ask-agent" as const,
    version: 1,
    sources: [
      {
        id: "ask-agent:3",
        profile: "ask-agent" as const,
        scope: "ask-agent-global" as const,
        label: "Ask Agent AgentLink",
        path: "/home/.agentlink/ask-agent/mcp.json",
        exists: true,
        editable: true,
        priority: 3,
      },
    ],
    entries: [
      {
        name: "linear",
        config: { name: "linear", command: "linear-mcp" },
        sourceIds: ["ask-agent:3"],
        editableScopes: ["ask-agent-global" as const],
        preferredEditScope: "ask-agent-global" as const,
        inherited: false,
        hasSecrets: false,
      },
    ],
    statusInfos,
    capabilities: {
      canEditConfig: true,
      canOpenRawConfig: true,
      canReconnect: true,
      canReauthenticate: true,
      canDisable: true,
      canUseProjectConfig: false,
    },
  };
}

type TestSnapshot = {
  ui: {
    approval: null | ApprovalRequest;
    question: null | {
      id: string;
      context: string;
      questions: Array<{
        id: string;
        type: "yes_no";
        question: string;
        recommended?: string;
      }>;
    };
    questionProgress: null | {
      id: string;
      step: number;
      answers: Record<string, string | string[] | number | boolean | undefined>;
      notes: Record<string, string>;
      origin: string;
    };
    recentEvents: never[];
    memoryCandidateNudge: null | {
      id: string;
      sessionId: string;
      createdAt: number;
      kind: "preference" | "correction" | "gotcha" | "workflow";
      matchedPhrase: string;
      suggestedScope: "global";
      suggestedTier: "memory";
      title: string;
      rationale: string;
      content: string;
    };
    projectHandoff: null | {
      id: string;
      sessionId: string;
      createdAt: number;
      targetInstanceId: string;
      targetWorkspaceName: string;
      targetWorkspacePath: string;
      mode: string;
      instruction: string;
      status: "pending" | "launching" | "completed" | "cancelled" | "failed";
      error?: string;
    };
    readGrants: Array<{
      id: string;
      createdAt: number;
      rootPath: string;
      label: string;
      kind: "file" | "directory";
    }>;
    mcpStatusInfos: never[];
  };
  session: {
    repository: { branch?: string; dirty?: boolean } | null;
    sessions: never[];
    foreground: {
      sessionId: string;
      title: string;
      mode: string;
      model: string;
      status: string;
      streaming: boolean;
      messages: never[];
      projectedMessages: ChatMessage[];
      statusOverride: string | null;
      thinkingEnabled: boolean;
      reasoningEffort?:
        | "none"
        | "minimal"
        | "low"
        | "medium"
        | "high"
        | "xhigh"
        | "max";
      lastInputTokens: number;
      lastOutputTokens: number;
      lastCacheReadTokens: number;
      estimatedTotalUsed: number;
      messageQueue: never[];
      questionRequest: null | {
        id: string;
        context: string;
        questions: Array<{
          id: string;
          type: "yes_no";
          question: string;
          recommended?: string;
        }>;
      };
      detectedQuestion: null;
      todos: TodoItem[];
      debugInfo: null;
      systemPrompt: null;
      loadedInstructions: null;
      restoringSession: boolean;
      condenseThreshold: number;
      agentWriteApproval: string;
    };
  };
  background: never[];
  diffs: Array<{
    requestId: string;
    filePath: string;
    operation: "create" | "modify";
    originalPreview: string;
    proposedPreview: string;
    outsideWorkspace: boolean;
    createdAt: number;
  }>;
  theme: {
    cssVariables: Record<string, string>;
    colorScheme: string;
    themeLabel: string;
    source: string;
  };
};

function createAskAgentSessionResponse(
  snapshot = createSnapshot(),
  capabilities: Array<{
    capabilityId: string;
    state: string;
    reason?: string;
  }> = [
    {
      capabilityId: "model-auth",
      state: "enabled",
      reason: "Browser gateway has cached openai-codex credentials.",
    },
  ],
): {
  ok: true;
  ownerRegistration: { capabilities: typeof capabilities };
  session: { capabilities: typeof capabilities };
  snapshot: TestSnapshot;
} {
  snapshot.session.foreground.sessionId = "browser-gateway:ask-agent:default";
  snapshot.session.foreground.title = "Ask Agent";
  snapshot.session.foreground.mode = "ask";
  snapshot.session.foreground.model = "gpt-5.3-codex";
  snapshot.session.foreground.statusOverride = null;
  snapshot.session.foreground.reasoningEffort = "low";
  snapshot.session.foreground.thinkingEnabled = true;
  snapshot.session.foreground.projectedMessages = [];
  return {
    ok: true,
    ownerRegistration: { capabilities },
    session: { capabilities },
    snapshot,
  };
}

function createSnapshot(): TestSnapshot {
  return {
    ui: {
      approval: null,
      question: null,
      questionProgress: null,
      recentEvents: [],
      memoryCandidateNudge: null,
      projectHandoff: null,
      readGrants: [],
      mcpStatusInfos: [],
    },
    session: {
      repository: null,
      sessions: [],
      foreground: {
        sessionId: "session-1",
        title: "Test Session",
        mode: "code",
        model: "claude-sonnet-4-6",
        status: "idle",
        streaming: false,
        messages: [],
        projectedMessages: [],
        statusOverride: null as string | null,
        thinkingEnabled: true,
        lastInputTokens: 0,
        lastOutputTokens: 0,
        lastCacheReadTokens: 0,
        estimatedTotalUsed: 0,
        messageQueue: [],
        questionRequest: null,
        detectedQuestion: null,
        todos: [],
        debugInfo: null,
        systemPrompt: null,
        loadedInstructions: null,
        restoringSession: false,
        condenseThreshold: 0.8,
        agentWriteApproval: "prompt",
      },
    },
    background: [],
    diffs: [],
    theme: {
      cssVariables: {},
      colorScheme: "dark",
      themeLabel: "Dark",
      source: "vscode-theme-api",
    },
  };
}

function installMatchMediaMock(
  matches: boolean | ((query: string) => boolean) = false,
): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn((query: string) => ({
      matches: typeof matches === "function" ? matches(query) : matches,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

class MockEventSource {
  static instances: MockEventSource[] = [];

  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly url: string;

  addEventListener = vi.fn();
  removeEventListener = vi.fn();
  close = vi.fn();

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }
}

function getInstanceTabs(): HTMLElement[] {
  return within(
    screen.getByRole("tablist", { name: "Instances" }),
  ).getAllByRole("tab");
}

function installLocalStorageMock(): Map<string, string> {
  const entries = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: vi.fn((key: string) => entries.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        entries.set(key, value);
      }),
      removeItem: vi.fn((key: string) => {
        entries.delete(key);
      }),
      clear: vi.fn(() => {
        entries.clear();
      }),
    },
  });
  return entries;
}

describe("BrowserGatewayApp /mcp behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    MockEventSource.instances = [];
    installLocalStorageMock();
    installMatchMediaMock(false);
    document.documentElement.removeAttribute("style");

    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;

    const snapshot = createSnapshot();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url.includes("/api/instances")) {
        return jsonResponse({
          currentInstanceId: "instance-1",
          instances: [
            {
              instanceId: "instance-1",

              workspaceName: "Workspace",

              workspacePath: "/workspace",

              url: "http://127.0.0.1:3333",

              status: { kind: "idle", label: "Idle" },
            },

            {
              instanceId: "instance-2",

              workspaceName: "Worker",

              workspacePath: "/worker",

              url: "http://127.0.0.1:3334",

              status: { kind: "working", label: "Working" },
            },
          ],
        });
      }
      if (url.includes("/api/ask-agent/session")) {
        return jsonResponse(createAskAgentSessionResponse());
      }
      if (url.includes("/api/ask-agent/send")) {
        const snapshot = createAskAgentSessionResponse().snapshot;
        snapshot.session.foreground.projectedMessages.push(
          {
            id: "ask-agent-user-1",
            role: "user",
            content: "Ship it",
            timestamp: 200,
            blocks: [{ type: "text", text: "Ship it" }],
          },
          {
            id: "ask-agent-assistant-1",
            role: "assistant",
            content:
              "I received your message, but Ask Agent model turns are not connected yet.",
            timestamp: 201,
            blocks: [
              {
                type: "text",
                text: "I received your message, but Ask Agent model turns are not connected yet.",
              },
            ],
          },
        );
        return jsonResponse({ ok: true, snapshot });
      }
      if (url.includes("/api/ui-state")) {
        return jsonResponse(snapshot);
      }
      if (url.includes("/api/slash-commands")) {
        return jsonResponse({
          commands: [
            {
              name: "mcp",
              description: "Open MCP status",
              source: "builtin",
              builtin: true,
            },
          ],
        });
      }
      if (url.includes("/api/modes")) {
        return jsonResponse({
          modes: [{ slug: "code", name: "Code", icon: "symbol-misc" }],
        });
      }
      if (url.includes("/api/models")) {
        return jsonResponse({
          models: [
            {
              id: "claude-sonnet-4-6",
              displayName: "Claude Sonnet 4.6",
              provider: "anthropic",
              contextWindow: 200000,
              authenticated: true,
            },
          ],
        });
      }
      if (url.includes("/api/sessions")) {
        return jsonResponse({ sessions: [] });
      }
      if (url.includes("/api/debug/refresh")) {
        return jsonResponse({ ok: true });
      }
      if (url.includes("/api/session/new")) {
        return jsonResponse({ ok: true });
      }
      if (url.includes("/api/send")) {
        return jsonResponse({ ok: true });
      }

      return jsonResponse({ error: "not_found" }, 404);
    });

    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    document.documentElement.removeAttribute("style");
  });

  it("applies injected initial theme when no cached theme exists", () => {
    render(
      h(BrowserGatewayApp, {
        authToken: "test-token",
        currentInstanceId: "instance-1",
        workspaceName: "Workspace",
        routeByInstance: true,
        initialTheme: {
          cssVariables: {
            "--vscode-editor-background": "rgb(9, 8, 7)",
            "--vscode-foreground": "rgb(6, 5, 4)",
          },
          colorScheme: "dark",
          themeLabel: "Initial Dark",
          source: "baked-default",
        },
      }),
    );

    expect(
      document.documentElement.style.getPropertyValue(
        "--vscode-editor-background",
      ),
    ).toBe("rgb(9, 8, 7)");
    expect(document.documentElement.style.colorScheme).toBe("dark");
  });

  it("applies cached runtime theme variables before the live snapshot arrives", async () => {
    window.localStorage.setItem(
      "agentlink.browserGateway.themeSnapshot.v1",
      JSON.stringify({
        cssVariables: {
          "--vscode-editor-background": "rgb(1, 2, 3)",
          "--vscode-foreground": "rgb(4, 5, 6)",
        },
        colorScheme: "light",
        themeLabel: "Cached Light",
        source: "webview-dom",
      }),
    );

    render(
      h(BrowserGatewayApp, {
        authToken: "test-token",
        currentInstanceId: "instance-1",
        workspaceName: "Workspace",
        routeByInstance: true,
      }),
    );

    expect(
      document.documentElement.style.getPropertyValue(
        "--vscode-editor-background",
      ),
    ).toBe("rgb(1, 2, 3)");
    expect(document.documentElement.style.colorScheme).toBe("light");

    await waitFor(() => {
      expect(
        window.localStorage.getItem(
          "agentlink.browserGateway.themeSnapshot.v1",
        ),
      ).toContain("Dark");
    });
  });

  it("shows queued status for queued browser sends", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/send"))
        return jsonResponse({ ok: true, queued: true });
      if (url.includes("/api/ui-state")) return jsonResponse(createSnapshot());
      if (url.includes("/api/instances")) {
        return jsonResponse({
          currentInstanceId: "instance-1",
          instances: [
            {
              instanceId: "instance-1",
              workspaceName: "Workspace",
              workspacePath: "/workspace",
              url: "http://127.0.0.1:3333",
              status: { kind: "idle", label: "Idle" },
            },
          ],
        });
      }
      if (url.includes("/api/slash-commands"))
        return jsonResponse({ commands: [] });
      if (url.includes("/api/modes")) return jsonResponse({ modes: [] });
      if (url.includes("/api/models")) return jsonResponse({ models: [] });
      if (url.includes("/api/sessions")) return jsonResponse({ sessions: [] });
      if (url.includes("/api/debug/refresh")) return jsonResponse({ ok: true });
      return jsonResponse({ error: "not_found" }, 404);
    });

    render(
      h(BrowserGatewayApp, {
        authToken: "test-token",
        currentInstanceId: "instance-1",
        workspaceName: "Workspace",
        routeByInstance: true,
      }),
    );

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([input]) =>
          String(input).includes("/api/ui-state"),
        ),
      ).toBe(true);
    });
    fireEvent.click(await screen.findByTestId("trigger-send"));

    await waitFor(() => {
      expect(screen.getByText("Queued.")).toBeTruthy();
    });
  });

  it("disables submit-on-enter for coarse pointer browser input", async () => {
    installMatchMediaMock((query) => query.includes("pointer: coarse"));

    render(
      h(BrowserGatewayApp, {
        authToken: "test-token",
        currentInstanceId: "instance-1",
        workspaceName: "Workspace",
        routeByInstance: true,
      }),
    );

    await waitFor(() => {
      expect(screen.getByTestId("submit-on-enter").textContent).toBe("false");
    });
  });

  it("keeps the current instance selected instead of jumping to an active one", async () => {
    render(
      h(BrowserGatewayApp, {
        authToken: "test-token",
        currentInstanceId: "instance-1",
        workspaceName: "Workspace",
        routeByInstance: true,
      }),
    );

    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /Workspace/ })).toBeTruthy();
    });

    const workspaceTab = screen.getByRole("tab", { name: /Workspace/ });
    const workerTab = await screen.findByRole("tab", { name: /Worker/ });

    // Worker is "working" in the default mock, but selection must stay put.
    await waitFor(() => {
      expect(workspaceTab.getAttribute("aria-selected")).toBe("true");
    });
    expect(workerTab.getAttribute("aria-selected")).toBe("false");

    fireEvent.click(workerTab);

    await waitFor(() => {
      expect(workerTab.getAttribute("aria-selected")).toBe("true");
    });
  });

  it("renders instance tabs sorted by name regardless of response order", async () => {
    render(
      h(BrowserGatewayApp, {
        authToken: "test-token",
        currentInstanceId: "instance-1",
        workspaceName: "Workspace",
        routeByInstance: true,
      }),
    );

    // The default mock lists Workspace before Worker; workspace tabs sort by name
    // after the pinned projectless Ask Agent tab.
    await waitFor(() => {
      expect(getInstanceTabs()).toHaveLength(3);
    });
    const tabs = getInstanceTabs();
    expect(tabs[0]?.textContent).toContain("Ask Agent");
    expect(tabs[1]?.textContent).toContain("Worker");
    expect(tabs[2]?.textContent).toContain("Workspace");
  });

  it("keeps Ask Agent pinned when no routed VS Code instances are available", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      const pathname = url.startsWith("http")
        ? new URL(url).pathname
        : url.split("?")[0];
      if (url.includes("/api/instances")) {
        return jsonResponse({ currentInstanceId: "", instances: [] });
      }
      if (pathname === "/api/ask-agent/session") {
        return jsonResponse(createAskAgentSessionResponse());
      }
      if (pathname === "/api/ask-agent/sessions") {
        return jsonResponse({
          sessions: [
            {
              id: "browser-gateway:ask-agent:default",
              mode: "ask",
              model: "gpt-5.3-codex",
              title: "Saved Ask Agent chat",
              messageCount: 2,
              totalInputTokens: 0,
              totalOutputTokens: 0,
              createdAt: 100,
              lastActiveAt: 200,
            },
          ],
        });
      }
      if (pathname === "/api/ask-agent/session/new") {
        const response = createAskAgentSessionResponse();
        response.snapshot.session.foreground.sessionId =
          "browser-gateway:ask-agent:next";
        return jsonResponse({ ok: true, snapshot: response.snapshot });
      }
      if (pathname === "/api/ask-agent/session/copy-first-prompt") {
        return jsonResponse({ ok: true, prompt: "Copied first prompt" });
      }
      if (pathname === "/api/ask-agent/memory") {
        return jsonResponse({
          ok: true,
          memory: {
            sessionSummaryCount: 1,
            chunkSummaryCount: 2,
            totalSummaryCount: 3,
            lastUpdatedAt: 123456,
            recentSessions: [
              {
                sessionId: "browser-gateway:ask-agent:default",
                title: "Derived summary title",
                messageCount: 4,
                updatedAt: 123456,
              },
            ],
          },
        });
      }
      if (pathname === "/api/ask-agent/memory/clear") {
        return jsonResponse({
          ok: true,
          memory: {
            sessionSummaryCount: 0,
            chunkSummaryCount: 0,
            totalSummaryCount: 0,
            lastUpdatedAt: null,
            recentSessions: [],
          },
        });
      }
      if (pathname === "/api/ask-agent/memory/proposal") {
        const response = createAskAgentSessionResponse();
        response.snapshot.ui.approval = {
          kind: "memory",
          id: "ask-agent-memory-approval-1",
          memoryTier: "memory",
          memoryScope: "global",
          memoryOperation: "add",
          memoryTitle: "Remember from Ask Agent",
          memoryRationale:
            "Ask Agent detected a possible durable user preference.",
          memoryTargetPath: "~/.agentlink/memory.md",
          memoryContent: "Going forward, always ask me before switching modes.",
        } as ApprovalRequest;
        return jsonResponse({
          ok: true,
          approval: response.snapshot.ui.approval,
          snapshot: response.snapshot,
        });
      }
      if (pathname === "/api/ask-agent/memory/nudge/dismiss") {
        const response = createAskAgentSessionResponse();
        response.snapshot.session.foreground.projectedMessages = [
          {
            id: "ask-agent-user-1",
            role: "user",
            content: "Ship it",
            timestamp: 200,
            blocks: [{ type: "text", text: "Ship it" }],
          },
          {
            id: "ask-agent-assistant-1",
            role: "assistant",
            content:
              "I received your message, but Ask Agent model turns are not connected yet.",
            timestamp: 201,
            blocks: [
              {
                type: "text",
                text: "I received your message, but Ask Agent model turns are not connected yet.",
              },
            ],
          },
        ];
        response.snapshot.ui.memoryCandidateNudge = null;
        return jsonResponse({ ok: true, snapshot: response.snapshot });
      }
      if (pathname === "/api/ask-agent/retry") {
        const response = createAskAgentSessionResponse();
        response.snapshot.session.foreground.projectedMessages.push(
          {
            id: "ask-agent-user-retry",
            role: "user",
            content: "Retry me",
            timestamp: 250,
            blocks: [{ type: "text", text: "Retry me" }],
          },
          {
            id: "ask-agent-assistant-retry",
            role: "assistant",
            content: "Retried successfully.",
            timestamp: 251,
            blocks: [{ type: "text", text: "Retried successfully." }],
          },
        );
        return jsonResponse({ ok: true, snapshot: response.snapshot });
      }
      if (pathname === "/api/ask-agent/stop") {
        const response = createAskAgentSessionResponse();
        return jsonResponse({
          ok: true,
          stopped: true,
          snapshot: response.snapshot,
        });
      }
      if (url.includes("/api/ask-agent/send")) {
        const snapshot = createAskAgentSessionResponse().snapshot;
        snapshot.ui.memoryCandidateNudge = {
          id: "ask-agent-memory-nudge-1",
          sessionId: "browser-gateway:ask-agent:default",
          createdAt: 200,
          kind: "preference",
          matchedPhrase: "Going forward, always ask me before switching modes.",
          suggestedScope: "global",
          suggestedTier: "memory",
          title: "Remember from Ask Agent",
          rationale:
            "Ask Agent detected a possible durable user preference. Review before saving; persistence requires explicit approval.",
          content: "Going forward, always ask me before switching modes.",
        };
        snapshot.session.foreground.projectedMessages.push(
          {
            id: "ask-agent-user-1",
            role: "user",
            content: "Ship it",
            timestamp: 200,
            blocks: [{ type: "text", text: "Ship it" }],
          },
          {
            id: "ask-agent-assistant-1",
            role: "assistant",
            content:
              "I received your message, but Ask Agent model turns are not connected yet.",
            timestamp: 201,
            blocks: [
              {
                type: "text",
                text: "I received your message, but Ask Agent model turns are not connected yet.",
              },
            ],
          },
        );
        return jsonResponse({ ok: true, snapshot });
      }
      if (pathname === "/api/ask-agent/slash-commands") {
        return jsonResponse({
          commands: [
            {
              name: "remember",
              description: "Remember durable preferences",
              source: "builtin",
              builtin: false,
              body: "Review this session for durable learnings.",
            },
            {
              name: "mcp",
              description: "Show Ask Agent MCP server connection status",
              source: "builtin",
              builtin: true,
            },
            {
              name: "mcp-config",
              description: "Show Ask Agent MCP configuration status",
              source: "builtin",
              builtin: true,
            },
            {
              name: "mcp-refresh",
              description: "Reconnect Ask Agent MCP servers",
              source: "builtin",
              builtin: true,
            },
            {
              name: "skill:skill-writing",
              description: "Write Agent Skills",
              source: "skill",
              builtin: false,
              body: "Use the skill by calling load_skill.",
            },
          ],
        });
      }
      if (pathname === "/api/ask-agent/mcp-config") {
        const configSnapshot = createAskAgentMcpConfigSnapshot();
        return jsonResponse({
          ok: true,
          infos: configSnapshot.statusInfos,
          configSnapshot,
        });
      }
      if (pathname === "/api/ask-agent/mcp-refresh") {
        const configSnapshot = createAskAgentMcpConfigSnapshot();
        return jsonResponse({
          ok: true,
          infos: configSnapshot.statusInfos,
          configSnapshot,
        });
      }
      if (pathname === "/api/ask-agent/models") {
        return jsonResponse({
          models: [
            {
              id: "gpt-5.3-codex",
              displayName: "GPT-5.3 Codex",
              provider: "browser-gateway",
              contextWindow: 200000,
              authenticated: true,
            },
            {
              id: "gpt-5.2-codex",
              displayName: "GPT-5.2 Codex",
              provider: "browser-gateway",
              contextWindow: 200000,
              authenticated: true,
            },
            {
              id: "gpt-5.1-codex",
              displayName: "GPT-5.1 Codex",
              provider: "browser-gateway",
              contextWindow: 200000,
              authenticated: true,
            },
          ],
          source: "cached",
          publishedByOwnerId: "vscode-owner",
          publishedAt: 123,
        });
      }
      if (pathname === "/api/ask-agent/model") {
        const response = createAskAgentSessionResponse();
        response.snapshot.session.foreground.model = "gpt-5.3-codex";
        return jsonResponse({ ok: true, snapshot: response.snapshot });
      }
      if (url.includes("/api/ask-agent/thinking")) {
        const response = createAskAgentSessionResponse();
        response.snapshot.session.foreground.reasoningEffort = "low";
        response.snapshot.session.foreground.thinkingEnabled = true;
        return jsonResponse({ ok: true, snapshot: response.snapshot });
      }
      if (url.includes("/api/ui-state")) return jsonResponse(createSnapshot());
      if (url.includes("/api/slash-commands"))
        return jsonResponse({ commands: [] });
      if (url.includes("/api/modes")) return jsonResponse({ modes: [] });
      if (url.includes("/api/models")) return jsonResponse({ models: [] });
      if (url.includes("/api/sessions")) return jsonResponse({ sessions: [] });
      if (url.includes("/api/debug/refresh")) return jsonResponse({ ok: true });
      return jsonResponse({ error: "not_found" }, 404);
    });

    render(
      h(BrowserGatewayApp, {
        authToken: "test-token",
        currentInstanceId: "",
        workspaceName: "Workspace",
        routeByInstance: true,
      }),
    );

    await waitFor(() => {
      expect(getInstanceTabs()).toHaveLength(1);
    });
    const askAgentTab = screen.getByRole("tab", { name: /Ask Agent/ });
    expect(askAgentTab.getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByText(/Ask Agent session is ready/)).toBeNull();
    await waitFor(() => {
      expect(screen.queryByText("Loading Ask Agent session…")).toBeNull();
      expect(screen.getByText("Ask anything to get started")).toBeTruthy();
    });
    expect(screen.getByTestId("mock-input-area")).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByTestId("model-count").textContent).toBe("3");
    });
    await waitFor(() => {
      expect(screen.getByTestId("slash-command-count").textContent).toBe("5");
    });
    expect(screen.getByTestId("slash-command-names").textContent).toBe(
      "remember,mcp,mcp-config,mcp-refresh,skill:skill-writing",
    );
    expect(screen.getByTestId("thinking-visible").textContent).toBe("true");
    expect(screen.queryByText("Model credentials needed")).toBeNull();
    expect(screen.queryByText("Model list may be stale")).toBeNull();
    expect(screen.queryByText("No pending file diffs.")).toBeNull();
    expect(screen.queryByTestId("browser-diff-viewer")).toBeNull();

    fireEvent.click(screen.getByTitle("Ask Agent Memory"));
    await screen.findByText("Derived Ask Agent memory");
    expect(screen.getByText("Session summaries")).toBeTruthy();
    expect(screen.getByText("Turn summaries")).toBeTruthy();
    expect(screen.getByText("Derived summary title")).toBeTruthy();
    expect(
      screen.getByText(
        "Local summaries used for recall. Raw transcripts and durable memory are separate.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("Private derived session summary")).toBeNull();
    expect(screen.queryByText("Raw transcript text")).toBeNull();
    fireEvent.click(screen.getByText("Clear summaries…"));
    await screen.findByText(/Clear derived summaries only\?/);
    fireEvent.click(screen.getByText("Confirm clear"));
    await screen.findByText("No derived memory summaries yet.");
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([input, init]) => {
          if (String(input) !== "/api/ask-agent/memory/clear") return false;
          const body = JSON.parse(
            String((init as RequestInit).body ?? "{}"),
          ) as {
            confirm?: boolean;
          };
          return body.confirm === true;
        }),
      ).toBe(true);
    });

    fireEvent.click(screen.getByTitle("Session History"));
    await screen.findByText("Saved Ask Agent chat");
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([input]) =>
          String(input).includes("/api/ask-agent/sessions"),
        ),
      ).toBe(true);
    });

    fireEvent.click(screen.getByTitle("Copy first prompt to new session"));
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([input]) =>
          String(input).includes("/api/ask-agent/session/copy-first-prompt"),
        ),
      ).toBe(true);
    });
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([input, init]) => {
          if (!String(input).includes("/api/ask-agent/send")) return false;
          const body = JSON.parse(
            String((init as RequestInit).body ?? "{}"),
          ) as {
            sessionId?: string;
            text?: string;
          };
          return (
            body.sessionId === "browser-gateway:ask-agent:next" &&
            body.text === "Copied first prompt"
          );
        }),
      ).toBe(true);
    });
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).includes("/api/session/copy-first-prompt"),
      ),
    ).toBe(false);

    fireEvent.click(screen.getByTitle("New Session"));
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([input]) =>
          String(input).includes("/api/ask-agent/session/new"),
        ),
      ).toBe(true);
    });

    fireEvent.click(screen.getByTestId("trigger-select-model"));
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([input]) =>
          String(input).includes("/api/ask-agent/model"),
        ),
      ).toBe(true);
    });
    fireEvent.click(screen.getByTestId("trigger-thinking"));
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([input]) =>
          String(input).includes("/api/ask-agent/thinking"),
        ),
      ).toBe(true);
    });

    fireEvent.click(screen.getByTestId("trigger-send"));
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([input, init]) =>
            String(input).includes("/api/ask-agent/send") &&
            (init as RequestInit | undefined)?.credentials === "same-origin",
        ),
      ).toBe(true);
    });
    await waitFor(() => {
      expect(screen.getAllByText("Ship it").length).toBeGreaterThan(0);
    });
    await screen.findByText(
      "I received your message, but Ask Agent model turns are not connected yet.",
    );
    await screen.findByText("Possible durable memory");
    expect(
      screen.getByText("Going forward, always ask me before switching modes."),
    ).toBeTruthy();
    fireEvent.click(screen.getByText("Review memory proposal"));
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([input, init]) => {
          if (String(input) !== "/api/ask-agent/memory/proposal") return false;
          const body = JSON.parse(
            String((init as RequestInit).body ?? "{}"),
          ) as {
            nudgeId?: string;
            content?: string;
            scope?: string;
          };
          return (
            body.nudgeId === "ask-agent-memory-nudge-1" &&
            body.content ===
              "Going forward, always ask me before switching modes." &&
            body.scope === "global"
          );
        }),
      ).toBe(true);
    });
    await waitFor(() => {
      expect(screen.queryByText("Possible durable memory")).toBeNull();
    });

    const dismissSnapshot = createAskAgentSessionResponse().snapshot;
    dismissSnapshot.session.foreground.projectedMessages = [
      {
        id: "ask-agent-user-1",
        role: "user",
        content: "Ship it",
        timestamp: 200,
        blocks: [{ type: "text", text: "Ship it" }],
      },
      {
        id: "ask-agent-assistant-1",
        role: "assistant",
        content:
          "I received your message, but Ask Agent model turns are not connected yet.",
        timestamp: 201,
        blocks: [
          {
            type: "text",
            text: "I received your message, but Ask Agent model turns are not connected yet.",
          },
        ],
      },
      {
        id: "ask-agent-assistant-export-error",
        role: "assistant",
        content: "",
        timestamp: 202,
        blocks: [],
        error: {
          message: "Codex API error 500: backend failed",
          retryable: true,
          code: "model_error",
        },
      },
    ];
    dismissSnapshot.ui.memoryCandidateNudge = {
      id: "ask-agent-memory-nudge-dismiss",
      sessionId: "browser-gateway:ask-agent:default",
      createdAt: 220,
      kind: "preference",
      matchedPhrase: "Remember that I prefer concise answers.",
      suggestedScope: "global",
      suggestedTier: "memory",
      title: "Remember from Ask Agent",
      rationale:
        "Ask Agent detected a possible durable user preference. Review before saving; persistence requires explicit approval.",
      content: "Remember that I prefer concise answers.",
    };
    MockEventSource.instances[0]?.addEventListener.mock.calls.find(
      ([eventName]) => eventName === "snapshot",
    )?.[1]?.({ data: JSON.stringify(dismissSnapshot) });
    await screen.findByText("Remember that I prefer concise answers.");
    fireEvent.click(screen.getByText("Dismiss"));
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([input, init]) => {
          if (String(input) !== "/api/ask-agent/memory/nudge/dismiss") {
            return false;
          }
          const body = JSON.parse(
            String((init as RequestInit).body ?? "{}"),
          ) as { id?: string };
          return body.id === "ask-agent-memory-nudge-dismiss";
        }),
      ).toBe(true);
    });
    await waitFor(() => {
      expect(
        screen.queryByText("Remember that I prefer concise answers."),
      ).toBeNull();
    });

    MockEventSource.instances[0]?.addEventListener.mock.calls.find(
      ([eventName]) => eventName === "snapshot",
    )?.[1]?.({ data: JSON.stringify(dismissSnapshot) });
    await screen.findByText("Codex API error 500: backend failed");

    const createObjectUrl = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:ask-agent-transcript");
    const revokeObjectUrl = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => undefined);
    const anchorClicks: HTMLAnchorElement[] = [];
    const originalCreateElement = document.createElement.bind(document);
    const createElement = vi
      .spyOn(document, "createElement")
      .mockImplementation(
        (tagName: string, options?: ElementCreationOptions) => {
          const element = originalCreateElement(tagName, options);
          if (tagName.toLowerCase() === "a") {
            vi.spyOn(element as HTMLAnchorElement, "click").mockImplementation(
              function click(this: HTMLAnchorElement) {
                anchorClicks.push(this);
              },
            );
          }
          return element;
        },
      );

    fireEvent.click(screen.getByTestId("trigger-export-transcript"));
    expect(createObjectUrl).toHaveBeenCalledWith(expect.any(Blob));
    const exportedBlob = createObjectUrl.mock.calls[0]?.[0] as Blob;
    const exportedText = await exportedBlob.text();
    expect(exportedText).toContain("# Ask Agent");
    expect(exportedText).toContain("Ship it");
    expect(exportedText).toContain(
      "I received your message, but Ask Agent model turns are not connected yet.",
    );
    expect(exportedText).toContain(
      "> Error: Codex API error 500: backend failed",
    );
    expect(
      exportedText.match(/Codex API error 500: backend failed/g) ?? [],
    ).toHaveLength(1);
    expect(anchorClicks).toHaveLength(1);
    expect(anchorClicks[0]?.download).toBe(
      `ask-agent-${new Date().toISOString().slice(0, 10)}.md`,
    );
    expect(anchorClicks[0]?.href).toBe("blob:ask-agent-transcript");
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:ask-agent-transcript");
    await screen.findByText("Exported Ask Agent transcript.");

    const errorSnapshot = createAskAgentSessionResponse().snapshot;
    errorSnapshot.session.foreground.projectedMessages.push(
      {
        id: "ask-agent-user-error",
        role: "user",
        content: "Retry me",
        timestamp: 240,
        blocks: [{ type: "text", text: "Retry me" }],
      },
      {
        id: "ask-agent-assistant-error",
        role: "assistant",
        content: "",
        timestamp: 241,
        blocks: [],
        error: {
          message: "fetch failed: ETIMEDOUT",
          retryable: true,
          code: "model_error",
        },
      },
    );
    MockEventSource.instances[0]?.addEventListener.mock.calls.find(
      ([eventName]) => eventName === "snapshot",
    )?.[1]?.({ data: JSON.stringify(errorSnapshot) });
    fireEvent.click(await screen.findByText("Retry"));
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([input, init]) =>
            String(input).includes("/api/ask-agent/retry") &&
            (init as RequestInit | undefined)?.credentials === "same-origin",
        ),
      ).toBe(true);
    });
    await screen.findByText("Retried successfully.");
    expect(
      fetchMock.mock.calls.some(([input, init]) => {
        if (!String(input).includes("/api/ask-agent/send")) return false;
        const body = JSON.parse(String((init as RequestInit).body ?? "{}")) as {
          text?: string;
        };
        return body.text === "Retry the last step.";
      }),
    ).toBe(false);

    fireEvent.click(screen.getByTestId("trigger-stop"));
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([input, init]) =>
            String(input).includes("/api/ask-agent/stop") &&
            (init as RequestInit | undefined)?.credentials === "same-origin",
        ),
      ).toBe(true);
    });
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).includes("/api/stop"),
      ),
    ).toBe(false);

    createElement.mockRestore();
    createObjectUrl.mockRestore();
    revokeObjectUrl.mockRestore();
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).includes("/api/send"),
      ),
    ).toBe(false);
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).includes("/api/ask-agent/slash-commands"),
      ),
    ).toBe(true);
    const askAgentSlashCommandNames = screen.getAllByTestId(
      "slash-command-names",
    )[0]?.textContent;
    expect(askAgentSlashCommandNames).toContain("mcp");
    expect(askAgentSlashCommandNames).toContain("mcp-config");
    expect(askAgentSlashCommandNames).toContain("mcp-refresh");
    for (const proxyablePath of [
      "/api/slash-commands",
      "/api/sessions?instanceId=",
      "/api/debug/refresh",
    ]) {
      expect(
        fetchMock.mock.calls.some(([input]) =>
          String(input).includes(proxyablePath),
        ),
      ).toBe(false);
    }
  });

  it("renders Ask Agent question and todo snapshots and routes question responses locally", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const askSnapshot = createAskAgentSessionResponse().snapshot;
    askSnapshot.ui.question = {
      id: "ask-agent-question-1",
      context: "Need a bounded decision before continuing.",
      questions: [
        {
          id: "continue",
          type: "yes_no",
          question: "Should Ask Agent continue with the read-only plan?",
          recommended: "Yes",
        },
      ],
    };
    askSnapshot.session.foreground.questionRequest = askSnapshot.ui.question;
    askSnapshot.session.foreground.todos = [
      {
        id: "audit",
        content: "Audit parity",
        activeForm: "Auditing parity",
        status: "in_progress",
      },
    ];

    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      const pathname = url.startsWith("http")
        ? new URL(url).pathname
        : url.split("?")[0];
      if (pathname === "/api/instances") {
        return jsonResponse({ currentInstanceId: "", instances: [] });
      }
      if (pathname === "/api/ask-agent/session") {
        return jsonResponse(createAskAgentSessionResponse(askSnapshot));
      }
      if (pathname === "/api/ask-agent/question-progress") {
        return jsonResponse({ ok: true, snapshot: askSnapshot });
      }
      if (pathname === "/api/ask-agent/question") {
        const nextSnapshot = createAskAgentSessionResponse().snapshot;
        nextSnapshot.session.foreground.todos =
          askSnapshot.session.foreground.todos;
        return jsonResponse({ ok: true, snapshot: nextSnapshot });
      }
      if (pathname === "/api/ask-agent/sessions") {
        return jsonResponse({ sessions: [] });
      }
      if (pathname === "/api/ask-agent/models") {
        return jsonResponse({ models: [], source: "fallback", modelCount: 0 });
      }
      if (pathname === "/api/ask-agent/slash-commands") {
        return jsonResponse({ commands: [] });
      }
      if (pathname === "/api/ask-agent/log") {
        return jsonResponse({ ok: true });
      }
      return jsonResponse({ error: "not_found" }, 404);
    });

    render(
      h(BrowserGatewayApp, {
        authToken: "test-token",
        currentInstanceId: "",
        workspaceName: "Workspace",
        routeByInstance: true,
      }),
    );

    await screen.findByText(
      "Should Ask Agent continue with the read-only plan?",
    );
    expect(screen.getAllByText("Auditing parity").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByText("Yes"));
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([input]) =>
          String(input).includes("/api/ask-agent/question-progress"),
        ),
      ).toBe(true);
    });
    fireEvent.click(screen.getByText("Submit"));
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([input, init]) => {
          if (String(input) !== "/api/ask-agent/question") return false;
          const body = JSON.parse(
            String((init as RequestInit).body ?? "{}"),
          ) as {
            id?: string;
            answers?: Record<string, boolean>;
          };
          return (
            body.id === "ask-agent-question-1" &&
            body.answers?.continue === true
          );
        }),
      ).toBe(true);
    });
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).includes("/api/question"),
      ),
    ).toBe(false);
  });

  it("routes Ask Agent read-only grant and revoke actions locally", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const askSnapshot = createAskAgentSessionResponse().snapshot;
    let granted = false;

    fetchMock.mockImplementation(async (input: RequestInfo | URL, init) => {
      const url = String(input);
      const pathname = url.startsWith("http")
        ? new URL(url).pathname
        : url.split("?")[0];
      if (pathname === "/api/instances") {
        return jsonResponse({ currentInstanceId: "", instances: [] });
      }
      if (pathname === "/api/ask-agent/session") {
        return jsonResponse(createAskAgentSessionResponse(askSnapshot));
      }
      if (pathname === "/api/ask-agent/read-grants") {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          path?: string;
          confirm?: boolean;
        };
        expect(body).toEqual({ path: "/tmp/ask-agent-read", confirm: true });
        granted = true;
        const next = createAskAgentSessionResponse().snapshot;
        next.ui.readGrants = [
          {
            id: "grant-1",
            createdAt: 100,
            rootPath: "/tmp/ask-agent-read",
            label: "ask-agent-read",
            kind: "directory",
          },
        ];
        return jsonResponse({ ok: true, snapshot: next });
      }
      if (pathname === "/api/ask-agent/read-grants/revoke") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { id?: string };
        expect(body).toEqual({ id: "grant-1" });
        const next = createAskAgentSessionResponse().snapshot;
        next.ui.readGrants = [];
        return jsonResponse({ ok: true, snapshot: next });
      }
      if (pathname === "/api/ask-agent/sessions") {
        return jsonResponse({ sessions: [] });
      }
      if (pathname === "/api/ask-agent/models") {
        return jsonResponse({ models: [], source: "fallback", modelCount: 0 });
      }
      if (pathname === "/api/ask-agent/slash-commands") {
        return jsonResponse({ commands: [] });
      }
      if (pathname === "/api/ask-agent/log") {
        return jsonResponse({ ok: true });
      }
      return jsonResponse({ error: "not_found" }, 404);
    });

    render(
      h(BrowserGatewayApp, {
        authToken: "test-token",
        currentInstanceId: "",
        workspaceName: "Workspace",
        routeByInstance: true,
      }),
    );

    fireEvent.click(await screen.findByTitle("Read-only local file grants"));
    await screen.findByText("Read-only local file access");
    expect(
      screen.getByText("No local paths have been granted to Ask Agent."),
    ).toBeTruthy();

    fireEvent.input(
      screen.getByPlaceholderText("/Users/name/project or /Users/name/file.md"),
      {
        target: { value: "/tmp/ask-agent-read" },
      },
    );
    fireEvent.click(screen.getByText("Confirm read grant"));

    await screen.findByText("ask-agent-read");
    await screen.findByText((content) =>
      content.includes("/tmp/ask-agent-read"),
    );
    await screen.findByText("Read-only access granted for Ask Agent.");
    expect(granted).toBe(true);

    fireEvent.click(screen.getByText("Revoke"));
    await screen.findByText("Read-only access revoked.");
    await screen.findByText("No local paths have been granted to Ask Agent.");
    expect(
      fetchMock.mock.calls.some(
        ([input]) => String(input) === "/api/read-grants",
      ),
    ).toBe(false);
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).includes("/api/send"),
      ),
    ).toBe(false);
  });

  it("renders approved Ask Agent project handoffs without direct workspace sends", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const askSnapshot = createAskAgentSessionResponse().snapshot;
    askSnapshot.ui.projectHandoff = {
      id: "handoff-1",
      sessionId: "browser-gateway:ask-agent:default",
      createdAt: 100,
      targetInstanceId: "instance-workspace",
      targetWorkspaceName: "Workspace",
      targetWorkspacePath: "/workspace/project",
      mode: "code",
      instruction: "Continue implementing the approved plan.",
      status: "pending",
    };

    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      const pathname = url.startsWith("http")
        ? new URL(url).pathname
        : url.split("?")[0];
      if (pathname === "/api/instances") {
        return jsonResponse({
          currentInstanceId: "",
          instances: [
            {
              instanceId: "instance-workspace",
              workspaceName: "Workspace",
              workspacePath: "/workspace/project",
              url: "http://127.0.0.1:12345",
              pid: 123,
              port: 12345,
              protocolVersion: 1,
              startedAt: new Date().toISOString(),
              lastSeenAt: Date.now(),
              status: { kind: "idle", label: "Idle" },
            },
          ],
        });
      }
      if (pathname === "/api/ask-agent/session") {
        return jsonResponse(createAskAgentSessionResponse(askSnapshot));
      }
      if (pathname === "/api/ask-agent/project-handoff/approve") {
        const next = createAskAgentSessionResponse(askSnapshot).snapshot;
        next.ui.projectHandoff = {
          ...askSnapshot.ui.projectHandoff!,
          status: "completed",
        };
        return jsonResponse({ ok: true, snapshot: next });
      }
      if (pathname === "/api/ask-agent/project-handoff/cancel") {
        const next = createAskAgentSessionResponse(askSnapshot).snapshot;
        next.ui.projectHandoff = null;
        return jsonResponse({ ok: true, snapshot: next });
      }
      if (pathname === "/api/ask-agent/sessions") {
        return jsonResponse({ sessions: [] });
      }
      if (pathname === "/api/ask-agent/models") {
        return jsonResponse({ models: [], source: "fallback", modelCount: 0 });
      }
      if (pathname === "/api/ask-agent/slash-commands") {
        return jsonResponse({ commands: [] });
      }
      if (pathname === "/api/ask-agent/log") {
        return jsonResponse({ ok: true });
      }
      return jsonResponse({ error: "not_found" }, 404);
    });

    render(
      h(BrowserGatewayApp, {
        authToken: "test-token",
        currentInstanceId: "",
        workspaceName: "Workspace",
        routeByInstance: true,
      }),
    );

    await screen.findByText("Project session handoff");
    expect(screen.getAllByText("Workspace").length).toBeGreaterThan(0);
    expect(screen.getByText("/workspace/project")).toBeTruthy();
    expect(screen.getByText("code")).toBeTruthy();
    expect(
      screen.getByText("Continue implementing the approved plan."),
    ).toBeTruthy();

    fireEvent.click(screen.getByText("Approve and launch"));
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([input, init]) => {
          if (String(input) !== "/api/ask-agent/project-handoff/approve") {
            return false;
          }
          const body = JSON.parse(
            String((init as RequestInit).body ?? "{}"),
          ) as {
            id?: string;
          };
          return body.id === "handoff-1";
        }),
      ).toBe(true);
    });
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).includes("/api/send"),
      ),
    ).toBe(false);
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).includes("/api/session/new"),
      ),
    ).toBe(false);
  });

  it("does not send copied Ask Agent prompts when prompt lookup or new session fails", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    let copyFirstPromptBody: { ok: boolean; prompt?: string } = { ok: false };
    let newSessionStatus = 200;
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      const pathname = url.startsWith("http")
        ? new URL(url).pathname
        : url.split("?")[0];
      if (pathname === "/api/instances") {
        return jsonResponse({ currentInstanceId: "", instances: [] });
      }
      if (pathname === "/api/ask-agent/session") {
        return jsonResponse(createAskAgentSessionResponse());
      }
      if (pathname === "/api/ask-agent/sessions") {
        return jsonResponse({
          sessions: [
            {
              id: "browser-gateway:ask-agent:default",
              mode: "ask",
              model: "gpt-5.3-codex",
              title: "Saved Ask Agent chat",
              messageCount: 2,
              totalInputTokens: 0,
              totalOutputTokens: 0,
              createdAt: 100,
              lastActiveAt: 200,
            },
          ],
        });
      }
      if (pathname === "/api/ask-agent/session/copy-first-prompt") {
        return jsonResponse(copyFirstPromptBody);
      }
      if (pathname === "/api/ask-agent/session/new") {
        const response = createAskAgentSessionResponse();
        response.snapshot.session.foreground.sessionId =
          "browser-gateway:ask-agent:next";
        return jsonResponse(
          newSessionStatus === 200
            ? { ok: true, snapshot: response.snapshot }
            : { ok: false },
          newSessionStatus,
        );
      }
      if (pathname === "/api/ask-agent/models") {
        return jsonResponse({
          models: [
            {
              id: "gpt-5.3-codex",
              displayName: "GPT-5.3 Codex",
              provider: "browser-gateway",
              contextWindow: 200000,
              authenticated: true,
            },
          ],
        });
      }
      if (pathname === "/api/ask-agent/slash-commands") {
        return jsonResponse({ commands: [] });
      }
      if (pathname === "/api/ask-agent/log") {
        return jsonResponse({ ok: true });
      }
      if (pathname === "/api/ask-agent/send") {
        return jsonResponse({
          ok: true,
          snapshot: createAskAgentSessionResponse().snapshot,
        });
      }
      return jsonResponse({ error: "not_found" }, 404);
    });

    render(
      h(BrowserGatewayApp, {
        authToken: "test-token",
        currentInstanceId: "",
        workspaceName: "Workspace",
        routeByInstance: true,
      }),
    );

    fireEvent.click(await screen.findByTitle("Session History"));
    await screen.findByText("Saved Ask Agent chat");
    fireEvent.click(screen.getByTitle("Copy first prompt to new session"));

    await screen.findByText(
      "Unable to copy the first prompt for this session.",
    );
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).includes("/api/ask-agent/session/new"),
      ),
    ).toBe(false);
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).includes("/api/ask-agent/send"),
      ),
    ).toBe(false);

    copyFirstPromptBody = { ok: true, prompt: "Copied first prompt" };
    newSessionStatus = 500;
    fireEvent.click(screen.getByTitle("Copy first prompt to new session"));

    await screen.findByText(
      "Unable to start a new session for the copied prompt.",
    );
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).includes("/api/ask-agent/session/new"),
      ),
    ).toBe(true);
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).includes("/api/ask-agent/send"),
      ),
    ).toBe(false);
  });

  it("surfaces actionable Ask Agent auth and catalog status without a ready banner", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      const pathname = url.startsWith("http")
        ? new URL(url).pathname
        : url.split("?")[0];
      if (pathname === "/api/instances") {
        return jsonResponse({ currentInstanceId: "", instances: [] });
      }
      if (pathname === "/api/ask-agent/session") {
        return jsonResponse(
          createAskAgentSessionResponse(createSnapshot(), [
            {
              capabilityId: "model-auth",
              state: "unavailable",
              reason: "Open a VS Code AgentLink window to grant credentials.",
            },
          ]),
        );
      }
      if (pathname === "/api/ask-agent/models") {
        return jsonResponse({
          models: [
            {
              id: "gpt-5.3-codex",
              displayName: "GPT-5.3 Codex",
              provider: "browser-gateway",
              contextWindow: 200000,
              authenticated: true,
            },
          ],
          source: "fallback",
        });
      }
      if (pathname === "/api/ask-agent/slash-commands") {
        return jsonResponse({ commands: [] });
      }
      if (pathname === "/api/ask-agent/log") {
        return jsonResponse({ ok: true });
      }
      return jsonResponse({ error: "not_found" }, 404);
    });

    render(
      h(BrowserGatewayApp, {
        authToken: "test-token",
        currentInstanceId: "",
        workspaceName: "Workspace",
        routeByInstance: true,
      }),
    );

    await screen.findByText("Model credentials needed");
    expect(
      screen.getByText("Open a VS Code AgentLink window to grant credentials."),
    ).toBeTruthy();
    expect(screen.queryByText("Ask Agent session is ready")).toBeNull();
    expect(screen.queryByText("Model list may be stale")).toBeNull();
  });

  it("surfaces fallback Ask Agent model catalogs after credentials are ready", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      const pathname = url.startsWith("http")
        ? new URL(url).pathname
        : url.split("?")[0];
      if (pathname === "/api/instances") {
        return jsonResponse({ currentInstanceId: "", instances: [] });
      }
      if (pathname === "/api/ask-agent/session") {
        return jsonResponse(createAskAgentSessionResponse());
      }
      if (pathname === "/api/ask-agent/models") {
        return jsonResponse({
          models: [
            {
              id: "gpt-5.3-codex",
              displayName: "GPT-5.3 Codex",
              provider: "browser-gateway",
              contextWindow: 200000,
              authenticated: true,
            },
          ],
          source: "fallback",
        });
      }
      if (pathname === "/api/ask-agent/slash-commands") {
        return jsonResponse({ commands: [] });
      }
      if (pathname === "/api/ask-agent/log") {
        return jsonResponse({ ok: true });
      }
      return jsonResponse({ error: "not_found" }, 404);
    });

    render(
      h(BrowserGatewayApp, {
        authToken: "test-token",
        currentInstanceId: "",
        workspaceName: "Workspace",
        routeByInstance: true,
      }),
    );

    await screen.findByText("Model list may be stale");
    expect(
      screen.getByText(
        "Ask Agent is using the fallback model list until a VS Code AgentLink window publishes the current catalog.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("Model credentials needed")).toBeNull();
  });

  it("keeps Ask Agent pinned when non-routed instance discovery is empty", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/instances")) {
        return jsonResponse({ currentInstanceId: "", instances: [] });
      }
      if (url.includes("/api/ask-agent/session")) {
        return jsonResponse(createAskAgentSessionResponse());
      }
      if (url.includes("/api/ui-state")) return jsonResponse(createSnapshot());
      if (url.includes("/api/slash-commands"))
        return jsonResponse({ commands: [] });
      if (url.includes("/api/modes")) return jsonResponse({ modes: [] });
      if (url.includes("/api/models")) return jsonResponse({ models: [] });
      if (url.includes("/api/sessions")) return jsonResponse({ sessions: [] });
      if (url.includes("/api/debug/refresh")) return jsonResponse({ ok: true });
      return jsonResponse({ error: "not_found" }, 404);
    });

    render(
      h(BrowserGatewayApp, {
        authToken: "test-token",
        currentInstanceId: "",
        workspaceName: "Workspace",
        routeByInstance: false,
      }),
    );

    await waitFor(() => {
      expect(getInstanceTabs()).toHaveLength(1);
    });
    expect(
      screen
        .getByRole("tab", { name: /Ask Agent/ })
        .getAttribute("aria-selected"),
    ).toBe("true");
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([input]) =>
          String(input).includes("/api/ask-agent/session"),
        ),
      ).toBe(true);
    });
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).includes("/api/ui-state?instanceId="),
      ),
    ).toBe(false);
    for (const proxyablePath of [
      "/api/slash-commands",
      "/api/sessions",
      "/api/debug/refresh",
    ]) {
      expect(
        fetchMock.mock.calls.some(([input]) =>
          String(input).includes(proxyablePath),
        ),
      ).toBe(false);
    }
  });

  it("switches realtime stream routing between workspace tabs and Ask Agent", async () => {
    render(
      h(BrowserGatewayApp, {
        authToken: "test-token",
        currentInstanceId: "instance-1",
        workspaceName: "Workspace",
        routeByInstance: true,
      }),
    );

    const workspaceTab = await screen.findByRole("tab", { name: /Workspace/ });
    await waitFor(() => {
      expect(MockEventSource.instances.at(-1)?.url).toContain(
        "/events?instanceId=instance-1",
      );
    });

    fireEvent.click(screen.getByRole("tab", { name: /Ask Agent/ }));

    await waitFor(() => {
      expect(MockEventSource.instances.at(-1)?.url).toBe(
        "/api/ask-agent/events",
      );
    });
    expect(workspaceTab.getAttribute("aria-selected")).toBe("false");
    expect(
      screen
        .getByRole("tab", { name: /Ask Agent/ })
        .getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("keeps missing instance tabs as disconnected before pruning them", async () => {
    vi.useFakeTimers();
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    let includeWorker = true;
    const snapshot = createSnapshot();

    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/ui-state")) return jsonResponse(snapshot);
      if (url.includes("/api/instances")) {
        return jsonResponse({
          currentInstanceId: "instance-1",
          instances: [
            {
              instanceId: "instance-1",
              workspaceName: "Workspace",
              workspacePath: "/workspace",
              url: "http://127.0.0.1:3333",
              status: { kind: "idle", label: "Idle" },
            },
            ...(includeWorker
              ? [
                  {
                    instanceId: "instance-2",
                    workspaceName: "Worker",
                    workspacePath: "/worker",
                    url: "http://127.0.0.1:3334",
                    status: { kind: "working", label: "Working" },
                  },
                ]
              : []),
          ],
        });
      }
      if (url.includes("/api/slash-commands"))
        return jsonResponse({ commands: [] });
      if (url.includes("/api/modes")) return jsonResponse({ modes: [] });
      if (url.includes("/api/models")) return jsonResponse({ models: [] });
      if (url.includes("/api/sessions")) return jsonResponse({ sessions: [] });
      if (url.includes("/api/debug/refresh")) return jsonResponse({ ok: true });
      return jsonResponse({ error: "not_found" }, 404);
    });

    try {
      render(
        h(BrowserGatewayApp, {
          authToken: "test-token",
          currentInstanceId: "instance-1",
          workspaceName: "Workspace",
          routeByInstance: true,
        }),
      );

      await waitFor(() => {
        expect(screen.getByRole("tab", { name: /Worker/ })).toBeTruthy();
      });

      includeWorker = false;
      await vi.advanceTimersByTimeAsync(5_000);

      await waitFor(() => {
        expect(
          screen.getByRole("tab", { name: /Worker/ }).textContent,
        ).toContain("Disconnected");
      });

      await vi.advanceTimersByTimeAsync(3 * 60 * 1_000);

      await waitFor(() => {
        expect(screen.queryByRole("tab", { name: /Worker/ })).toBeNull();
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("switches a selected disconnected tab to a live replacement for the same workspace", async () => {
    vi.useFakeTimers();
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    let instanceGeneration: "old" | "new" = "old";
    const snapshot = createSnapshot();

    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/ui-state")) return jsonResponse(snapshot);
      if (url.includes("/api/instances")) {
        return jsonResponse({
          currentInstanceId:
            instanceGeneration === "old" ? "workspace-old" : "workspace-new",
          instances: [
            {
              instanceId:
                instanceGeneration === "old"
                  ? "workspace-old"
                  : "workspace-new",
              workspaceName: "Workspace",
              workspacePath: "/workspace",
              url: "http://127.0.0.1:3333",
              status: { kind: "idle", label: "Idle" },
            },
          ],
        });
      }
      if (url.includes("/api/slash-commands"))
        return jsonResponse({ commands: [] });
      if (url.includes("/api/modes")) return jsonResponse({ modes: [] });
      if (url.includes("/api/models")) return jsonResponse({ models: [] });
      if (url.includes("/api/sessions")) return jsonResponse({ sessions: [] });
      if (url.includes("/api/debug/refresh")) return jsonResponse({ ok: true });
      return jsonResponse({ error: "not_found" }, 404);
    });

    try {
      render(
        h(BrowserGatewayApp, {
          authToken: "test-token",
          currentInstanceId: "workspace-old",
          workspaceName: "Workspace",
          routeByInstance: true,
        }),
      );

      const oldWorkspaceTab = await screen.findByRole("tab", {
        name: /Workspace/,
      });
      await waitFor(() => {
        expect(oldWorkspaceTab.getAttribute("aria-selected")).toBe("true");
      });

      instanceGeneration = "new";
      await vi.advanceTimersByTimeAsync(5_000);

      await waitFor(() => {
        const tabs = screen.getAllByRole("tab", { name: /Workspace/ });
        const liveTab = tabs.find(
          (tab) => !tab.textContent?.includes("Disconnected"),
        );
        const disconnectedTab = tabs.find((tab) =>
          tab.textContent?.includes("Disconnected"),
        );
        expect(liveTab?.getAttribute("aria-selected")).toBe("true");
        expect(disconnectedTab?.getAttribute("aria-selected")).toBe("false");
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders pending diffs in the Review pane", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const snapshot = createSnapshot();
    snapshot.diffs = [
      {
        requestId: "diff-1",
        filePath: "src/file.ts",
        operation: "modify",
        originalPreview: "before",
        proposedPreview: "after",
        outsideWorkspace: false,
        createdAt: 1,
      },
    ];

    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/ui-state")) return jsonResponse(snapshot);
      if (url.includes("/api/instances")) {
        return jsonResponse({
          currentInstanceId: "instance-1",
          instances: [
            {
              instanceId: "instance-1",
              workspaceName: "Workspace",
              workspacePath: "/workspace",
              url: "http://127.0.0.1:3333",
              status: { kind: "idle", label: "Idle" },
            },
          ],
        });
      }
      if (url.includes("/api/slash-commands"))
        return jsonResponse({ commands: [] });
      if (url.includes("/api/modes")) return jsonResponse({ modes: [] });
      if (url.includes("/api/models")) return jsonResponse({ models: [] });
      if (url.includes("/api/sessions")) return jsonResponse({ sessions: [] });
      if (url.includes("/api/debug/refresh")) return jsonResponse({ ok: true });
      return jsonResponse({ ok: true });
    });

    render(
      h(BrowserGatewayApp, {
        authToken: "test-token",
        currentInstanceId: "instance-1",
        workspaceName: "Workspace",
        routeByInstance: true,
      }),
    );

    await waitFor(() => {
      expect(
        screen.getByRole("tablist", { name: "Pending file diffs" }),
      ).toBeTruthy();
    });
    expect(screen.getByRole("tab", { name: /src\/file\.ts/ })).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByTestId("browser-diff-viewer").textContent).toBe(
        "diff-1",
      );
    });
    expect(screen.queryByText("No pending file diffs.")).toBeNull();
  });

  it("opens the mobile review pane from a pending approval", async () => {
    installMatchMediaMock(true);

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const snapshot = createSnapshot();
    snapshot.ui.approval = {
      kind: "write",
      id: "approval-1",
      filePath: "src/file.ts",
      writeOperation: "modify",
    };
    snapshot.diffs = [
      {
        requestId: "diff-1",
        filePath: "src/file.ts",
        operation: "modify",
        originalPreview: "before",
        proposedPreview: "after",
        outsideWorkspace: false,
        createdAt: 1,
      },
    ];

    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/ui-state")) return jsonResponse(snapshot);
      if (url.includes("/api/instances")) {
        return jsonResponse({
          currentInstanceId: "instance-1",
          instances: [
            {
              instanceId: "instance-1",
              workspaceName: "Workspace",
              workspacePath: "/workspace",
              url: "http://127.0.0.1:3333",
              status: { kind: "awaiting_approval", label: "Approval" },
            },
          ],
        });
      }
      if (url.includes("/api/slash-commands"))
        return jsonResponse({ commands: [] });
      if (url.includes("/api/modes")) return jsonResponse({ modes: [] });
      if (url.includes("/api/models")) return jsonResponse({ models: [] });
      if (url.includes("/api/sessions")) return jsonResponse({ sessions: [] });
      if (url.includes("/api/debug/refresh")) return jsonResponse({ ok: true });
      return jsonResponse({ ok: true });
    });

    render(
      h(BrowserGatewayApp, {
        authToken: "test-token",
        currentInstanceId: "instance-1",
        workspaceName: "Workspace",
        routeByInstance: true,
      }),
    );

    const viewDiffButton = await screen.findByRole("button", {
      name: /View diff/,
    });
    expect(screen.getByRole("button", { name: "Accept" })).toBeTruthy();

    fireEvent.click(viewDiffButton);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Back to chat/ })).toBeTruthy();
    });
    expect(
      screen.getAllByRole("tablist", { name: "Pending file diffs" }),
    ).toHaveLength(1);
    expect(screen.getByTestId("browser-diff-viewer").textContent).toBe(
      "diff-1",
    );
    expect(screen.getByRole("button", { name: "Accept" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Back to chat/ }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /View diff/ })).toBeTruthy();
    });
  });

  it("hides the mobile View diff action for approvals without matching diffs", async () => {
    installMatchMediaMock(true);

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const snapshot = createSnapshot();
    snapshot.ui.approval = {
      kind: "command",
      id: "approval-1",
      command: "npm test",
    };
    snapshot.diffs = [
      {
        requestId: "diff-1",
        filePath: "src/file.ts",
        operation: "modify",
        originalPreview: "before",
        proposedPreview: "after",
        outsideWorkspace: false,
        createdAt: 1,
      },
    ];

    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/ui-state")) return jsonResponse(snapshot);
      if (url.includes("/api/instances")) {
        return jsonResponse({
          currentInstanceId: "instance-1",
          instances: [
            {
              instanceId: "instance-1",
              workspaceName: "Workspace",
              workspacePath: "/workspace",
              url: "http://127.0.0.1:3333",
              status: { kind: "awaiting_approval", label: "Approval" },
            },
          ],
        });
      }
      if (url.includes("/api/slash-commands"))
        return jsonResponse({ commands: [] });
      if (url.includes("/api/modes")) return jsonResponse({ modes: [] });
      if (url.includes("/api/models")) return jsonResponse({ models: [] });
      if (url.includes("/api/sessions")) return jsonResponse({ sessions: [] });
      if (url.includes("/api/debug/refresh")) return jsonResponse({ ok: true });
      return jsonResponse({ ok: true });
    });

    render(
      h(BrowserGatewayApp, {
        authToken: "test-token",
        currentInstanceId: "instance-1",
        workspaceName: "Workspace",
        routeByInstance: true,
      }),
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Run" })).toBeTruthy();
    });
    expect(screen.queryByRole("button", { name: /View diff/ })).toBeNull();
  });

  it("renders inline command file previews in browser approvals", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const snapshot = createSnapshot();
    snapshot.ui.approval = {
      kind: "command",
      id: "approval-1",
      command: "gh pr comment 1 --body-file '/tmp/agentlink-cmd/body.md'",
      inlineFiles: [
        {
          name: "body",
          path: "/tmp/agentlink-cmd/body.md",
          ext: "md",
          bytes: 19,
          sha256:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          truncated: false,
          executable: false,
          preview: "hello `code` world",
        },
      ],
    };

    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/ui-state")) return jsonResponse(snapshot);
      if (url.includes("/api/instances")) {
        return jsonResponse({
          currentInstanceId: "instance-1",
          instances: [
            {
              instanceId: "instance-1",
              workspaceName: "Workspace",
              workspacePath: "/workspace",
              url: "http://127.0.0.1:3333",
              status: { kind: "awaiting_approval", label: "Approval" },
            },
          ],
        });
      }
      if (url.includes("/api/slash-commands"))
        return jsonResponse({ commands: [] });
      if (url.includes("/api/modes")) return jsonResponse({ modes: [] });
      if (url.includes("/api/models")) return jsonResponse({ models: [] });
      if (url.includes("/api/sessions")) return jsonResponse({ sessions: [] });
      if (url.includes("/api/debug/refresh")) return jsonResponse({ ok: true });
      return jsonResponse({ ok: true });
    });

    render(
      h(BrowserGatewayApp, {
        authToken: "test-token",
        currentInstanceId: "instance-1",
        workspaceName: "Workspace",
        routeByInstance: true,
      }),
    );

    await waitFor(() => {
      expect(screen.getByText("Attached temp files")).toBeTruthy();
    });
    expect(screen.getByText("body")).toBeTruthy();
    expect(screen.getByText(".md")).toBeTruthy();
    expect(screen.getByText(/0123456789ab/)).toBeTruthy();
    expect(screen.getByText("/tmp/agentlink-cmd/body.md")).toBeTruthy();
    expect(screen.getByText("hello `code` world")).toBeTruthy();
  });

  it("opens the mobile review pane for diff approvals matched by request id", async () => {
    installMatchMediaMock(true);

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const snapshot = createSnapshot();
    snapshot.ui.approval = {
      kind: "write",
      id: "diff-1",
      writeOperation: "modify",
    };
    snapshot.diffs = [
      {
        requestId: "diff-1",
        filePath: "src/file.ts",
        operation: "modify",
        originalPreview: "before",
        proposedPreview: "after",
        outsideWorkspace: false,
        createdAt: 1,
      },
    ];

    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/ui-state")) return jsonResponse(snapshot);
      if (url.includes("/api/instances")) {
        return jsonResponse({
          currentInstanceId: "instance-1",
          instances: [
            {
              instanceId: "instance-1",
              workspaceName: "Workspace",
              workspacePath: "/workspace",
              url: "http://127.0.0.1:3333",
              status: { kind: "awaiting_approval", label: "Approval" },
            },
          ],
        });
      }
      if (url.includes("/api/slash-commands"))
        return jsonResponse({ commands: [] });
      if (url.includes("/api/modes")) return jsonResponse({ modes: [] });
      if (url.includes("/api/models")) return jsonResponse({ models: [] });
      if (url.includes("/api/sessions")) return jsonResponse({ sessions: [] });
      if (url.includes("/api/debug/refresh")) return jsonResponse({ ok: true });
      return jsonResponse({ ok: true });
    });

    render(
      h(BrowserGatewayApp, {
        authToken: "test-token",
        currentInstanceId: "instance-1",
        workspaceName: "Workspace",
        routeByInstance: true,
      }),
    );

    fireEvent.click(await screen.findByRole("button", { name: /View diff/ }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Back to chat/ })).toBeTruthy();
    });
    expect(screen.getByTestId("browser-diff-viewer").textContent).toBe(
      "diff-1",
    );
  });

  it("keeps the Review pane diff-only when approvals and questions are pending", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const snapshot = createSnapshot();
    snapshot.ui.approval = {
      kind: "write",
      id: "approval-1",
      filePath: "src/file.ts",
      writeOperation: "modify",
    };
    snapshot.ui.question = {
      id: "question-1",
      context: "Need a decision.",
      questions: [
        {
          id: "q1",
          type: "yes_no",
          question: "Continue?",
          recommended: "Yes",
        },
      ],
    };

    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/ui-state")) return jsonResponse(snapshot);
      if (url.includes("/api/instances")) {
        return jsonResponse({
          currentInstanceId: "instance-1",
          instances: [
            {
              instanceId: "instance-1",
              workspaceName: "Workspace",
              workspacePath: "/workspace",
              url: "http://127.0.0.1:3333",
              status: { kind: "awaiting_approval", label: "Approval" },
            },
          ],
        });
      }
      if (url.includes("/api/slash-commands"))
        return jsonResponse({ commands: [] });
      if (url.includes("/api/modes")) return jsonResponse({ modes: [] });
      if (url.includes("/api/models")) return jsonResponse({ models: [] });
      if (url.includes("/api/sessions")) return jsonResponse({ sessions: [] });
      if (url.includes("/api/debug/refresh")) return jsonResponse({ ok: true });
      return jsonResponse({ ok: true });
    });

    render(
      h(BrowserGatewayApp, {
        authToken: "test-token",
        currentInstanceId: "instance-1",
        workspaceName: "Workspace",
        routeByInstance: true,
      }),
    );

    await waitFor(() => {
      expect(screen.getByText("No pending file diffs.")).toBeTruthy();
    });
    expect(screen.queryByText("Pending question")).toBeNull();
    expect(
      screen.queryByRole("tablist", { name: "Pending file diffs" }),
    ).toBeNull();
    expect(screen.queryByTestId("browser-diff-viewer")).toBeNull();
  });

  it("switches instance tabs from touch pointer taps on mobile", async () => {
    render(
      h(BrowserGatewayApp, {
        authToken: "test-token",
        currentInstanceId: "instance-1",
        workspaceName: "Workspace",
        routeByInstance: true,
      }),
    );

    const workspaceTab = await screen.findByRole("tab", { name: /Workspace/ });
    const workerTab = await screen.findByRole("tab", { name: /Worker/ });

    await waitFor(() => {
      expect(workspaceTab.getAttribute("aria-selected")).toBe("true");
    });

    fireEvent.pointerDown(workerTab, {
      pointerType: "touch",
      pointerId: 1,
      clientX: 12,
      clientY: 8,
    });
    fireEvent.pointerUp(workerTab, {
      pointerType: "touch",
      pointerId: 1,
      clientX: 14,
      clientY: 9,
    });

    await waitFor(() => {
      expect(workerTab.getAttribute("aria-selected")).toBe("true");
    });
  });

  it("does not switch instance tabs from touch scroll gestures", async () => {
    render(
      h(BrowserGatewayApp, {
        authToken: "test-token",
        currentInstanceId: "instance-1",
        workspaceName: "Workspace",
        routeByInstance: true,
      }),
    );

    const workspaceTab = await screen.findByRole("tab", { name: /Workspace/ });
    const workerTab = await screen.findByRole("tab", { name: /Worker/ });

    await waitFor(() => {
      expect(workspaceTab.getAttribute("aria-selected")).toBe("true");
    });

    fireEvent.pointerDown(workerTab, {
      pointerType: "touch",
      pointerId: 1,
      clientX: 12,
      clientY: 8,
    });
    fireEvent.pointerUp(workerTab, {
      pointerType: "touch",
      pointerId: 1,
      clientX: 32,
      clientY: 28,
    });

    expect(workspaceTab.getAttribute("aria-selected")).toBe("true");
    expect(workerTab.getAttribute("aria-selected")).toBe("false");
  });

  it("recovers from a stale bootstrap instance id before fetching routed sessions", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;

    render(
      h(BrowserGatewayApp, {
        authToken: "test-token",
        currentInstanceId: "stale-instance",
        workspaceName: "Workspace",
        routeByInstance: true,
      }),
    );

    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /Workspace/ })).toBeTruthy();
    });

    await waitFor(() => {
      const fetchUrls = fetchMock.mock.calls.map(([input]) => String(input));
      expect(
        fetchUrls.some((url) =>
          url.includes("/api/sessions?instanceId=instance-1"),
        ),
        fetchUrls.join("\n"),
      ).toBe(true);
    });

    expect(
      screen
        .getByRole("tab", { name: /Workspace/ })
        .getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("falls back to snapshot polling when the realtime stream errors", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const initialSnapshot = createSnapshot();
    const recoveredSnapshot = createSnapshot();
    recoveredSnapshot.session.foreground.status = "streaming";
    recoveredSnapshot.session.foreground.streaming = true;
    recoveredSnapshot.session.foreground.statusOverride =
      "Recovered via fallback";
    let uiStateCalls = 0;

    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/ui-state")) {
        uiStateCalls += 1;
        return jsonResponse(
          uiStateCalls === 1 ? initialSnapshot : recoveredSnapshot,
        );
      }
      if (url.includes("/api/instances")) {
        return jsonResponse({
          currentInstanceId: "instance-1",
          instances: [
            {
              instanceId: "instance-1",
              workspaceName: "Workspace",
              workspacePath: "/workspace",
              url: "http://127.0.0.1:3333",
              status: { kind: "working", label: "Working" },
            },
          ],
        });
      }
      if (url.includes("/api/slash-commands")) {
        return jsonResponse({ commands: [] });
      }
      if (url.includes("/api/modes")) {
        return jsonResponse({
          modes: [{ slug: "code", name: "Code", icon: "symbol-misc" }],
        });
      }
      if (url.includes("/api/models")) {
        return jsonResponse({ models: [] });
      }
      if (url.includes("/api/sessions")) {
        return jsonResponse({ sessions: [] });
      }
      if (url.includes("/api/debug/refresh")) {
        return jsonResponse({ ok: true });
      }
      return jsonResponse({ ok: true });
    });

    render(
      h(BrowserGatewayApp, {
        authToken: "test-token",
        currentInstanceId: "instance-1",
        workspaceName: "Workspace",
        routeByInstance: true,
      }),
    );

    await waitFor(() => {
      expect(MockEventSource.instances.length).toBeGreaterThan(0);
    });

    MockEventSource.instances[0]?.onerror?.();

    await waitFor(() => {
      expect(screen.getByText("Recovered via fallback")).toBeTruthy();
    });

    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).includes("/api/ui-state?instanceId=instance-1"),
      ),
    ).toBe(true);
  });

  it("opens MCP panel without posting /api/send", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;

    render(
      h(BrowserGatewayApp, {
        authToken: "test-token",
        currentInstanceId: "instance-1",
        workspaceName: "Workspace",
        routeByInstance: true,
      }),
    );

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([input]) =>
          String(input).includes("/api/ui-state"),
        ),
      ).toBe(true);
    });

    const trigger = await screen.findByTestId("trigger-mcp");
    fireEvent.click(trigger);

    await waitFor(() => {
      expect(screen.getByText("MCP Manager")).toBeTruthy();
    });

    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).includes("/api/send"),
      ),
    ).toBe(false);
  });

  it("executes Ask Agent MCP slash commands through Ask Agent helper APIs", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      const pathname = url.startsWith("http")
        ? new URL(url).pathname
        : url.split("?")[0];

      if (pathname === "/api/instances") {
        return jsonResponse({ currentInstanceId: "", instances: [] });
      }
      if (pathname === "/api/ask-agent/session") {
        return jsonResponse(createAskAgentSessionResponse());
      }
      if (pathname === "/api/ask-agent/sessions") {
        return jsonResponse({ sessions: [] });
      }
      if (pathname === "/api/ask-agent/models") {
        return jsonResponse({ models: [], source: "fallback", modelCount: 0 });
      }
      if (pathname === "/api/ask-agent/slash-commands") {
        return jsonResponse({
          commands: [
            {
              name: "mcp",
              description: "Show Ask Agent MCP server connection status",
              source: "builtin",
              builtin: true,
            },
            {
              name: "mcp-config",
              description: "Show Ask Agent MCP configuration status",
              source: "builtin",
              builtin: true,
            },
            {
              name: "mcp-refresh",
              description: "Reconnect Ask Agent MCP servers",
              source: "builtin",
              builtin: true,
            },
          ],
        });
      }
      if (pathname === "/api/ask-agent/mcp-config") {
        const configSnapshot = createAskAgentMcpConfigSnapshot();
        return jsonResponse({
          ok: true,
          infos: configSnapshot.statusInfos,
          configSnapshot,
        });
      }
      if (pathname === "/api/ask-agent/mcp-refresh") {
        const configSnapshot = createAskAgentMcpConfigSnapshot();
        return jsonResponse({
          ok: true,
          infos: configSnapshot.statusInfos,
          configSnapshot,
        });
      }
      if (pathname === "/api/ask-agent/log") {
        return jsonResponse({ ok: true });
      }
      return jsonResponse({ error: "not_found" }, 404);
    });

    render(
      h(BrowserGatewayApp, {
        authToken: "test-token",
        currentInstanceId: "",
        workspaceName: "Ask Agent",
        routeByInstance: true,
      }),
    );

    await waitFor(() => {
      expect(screen.getByTestId("slash-command-names").textContent).toContain(
        "mcp-refresh",
      );
    });

    fireEvent.click(screen.getByTestId("trigger-mcp"));
    await waitFor(() => {
      expect(screen.getByText("Ask Agent MCP Manager")).toBeTruthy();
      expect(screen.getByText("linear")).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId("trigger-mcp-config"));
    await waitFor(() => {
      expect(screen.getByText("Config sources")).toBeTruthy();
      expect(
        fetchMock.mock.calls.filter(([input]) =>
          String(input).includes("/api/ask-agent/mcp-config"),
        ).length,
      ).toBeGreaterThanOrEqual(2);
    });
    expect(screen.queryByText("Open raw")).toBeNull();
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).includes("/api/ask-agent/mcp-config/open-raw"),
      ),
    ).toBe(false);

    fireEvent.click(screen.getByTestId("trigger-mcp-refresh"));
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([input, init]) =>
            String(input) === "/api/ask-agent/mcp-refresh" &&
            (init as RequestInit | undefined)?.method === "POST",
        ),
      ).toBe(true);
    });

    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).includes("/api/send"),
      ),
    ).toBe(false);
  });

  it("creates a new session from the toolbar button via /api/session/new", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;

    render(
      h(BrowserGatewayApp, {
        authToken: "test-token",
        currentInstanceId: "instance-1",
        workspaceName: "Workspace",
        routeByInstance: true,
      }),
    );

    await waitFor(() => {
      expect(screen.getByTitle("New Session")).toBeTruthy();
    });

    fireEvent.click(screen.getByTitle("New Session"));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([input, init]) =>
            String(input).includes("/api/session/new") &&
            init?.method === "POST",
        ),
      ).toBe(true);
    });

    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).includes("/api/send"),
      ),
    ).toBe(false);
  });

  it("optimistically dismisses visible approval card after submitting a decision", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const approvalSnapshot = {
      ...createSnapshot(),
      ui: {
        approval: {
          kind: "write",
          id: "approval-1",
          filePath: "src/file.ts",
          writeOperation: "modify",
        },
        question: null,
        recentEvents: [],
        mcpStatusInfos: [],
      },
    };

    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/ui-state")) {
        return jsonResponse(approvalSnapshot);
      }
      if (url.includes("/api/approval")) {
        return jsonResponse({ ok: true });
      }
      if (url.includes("/api/instances")) {
        return jsonResponse({
          currentInstanceId: "instance-1",
          instances: [
            {
              instanceId: "instance-1",

              workspaceName: "Workspace",

              workspacePath: "/workspace",

              url: "http://127.0.0.1:3333",

              status: { kind: "idle", label: "Idle" },
            },

            {
              instanceId: "instance-2",

              workspaceName: "Worker",

              workspacePath: "/worker",

              url: "http://127.0.0.1:3334",

              status: { kind: "working", label: "Working" },
            },
          ],
        });
      }
      if (url.includes("/api/slash-commands")) {
        return jsonResponse({ commands: [] });
      }
      if (url.includes("/api/modes")) {
        return jsonResponse({
          modes: [{ slug: "code", name: "Code", icon: "symbol-misc" }],
        });
      }
      if (url.includes("/api/models")) {
        return jsonResponse({
          models: [
            {
              id: "claude-sonnet-4-6",
              displayName: "Claude Sonnet 4.6",
              provider: "anthropic",
              contextWindow: 200000,
              authenticated: true,
            },
          ],
        });
      }
      if (url.includes("/api/sessions")) {
        return jsonResponse({ sessions: [] });
      }
      if (url.includes("/api/debug/refresh")) {
        return jsonResponse({ ok: true });
      }
      return jsonResponse({ ok: true });
    });

    render(
      h(BrowserGatewayApp, {
        authToken: "test-token",
        currentInstanceId: "instance-1",
        workspaceName: "Workspace",
        routeByInstance: true,
      }),
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Accept" })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: "Accept" }));

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
    });

    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).includes("/api/approval"),
      ),
    ).toBe(true);
  });
});
