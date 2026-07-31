/** @vitest-environment jsdom */

import {
  BrowserGatewayApp,
  cacheDetachedSessionDetail,
  pruneDetachedSessionDetailCache,
} from "./BrowserGatewayApp";
import type {
  ChatMessage,
  ProjectInfo,
  TodoItem,
} from "../../agent/webview/types";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppState } from "../../shared/chatProjection";
import type { ApprovalRequest } from "../../approvals/webview/types";
import { BROWSER_GATEWAY_ASK_AGENT_OWNER_ID } from "../browserGatewayAskAgentIdentity";
import type { BgSessionInfo } from "../../shared/types";
import type { BrowserGatewayChatWorkspaceSummary } from "../dataPlane/protocol";
import { h } from "preact";
import { within } from "@testing-library/preact";

vi.mock("../../agent/webview/components/InputArea", () => ({
  InputArea: ({
    allowThinkingToggle,
    availableModels,
    onExecuteBuiltinCommand,
    onExportTranscript,
    onInterject,
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
    onInterject?: (text: string, attachments: string[]) => void;
    onSelectModel?: (modelId: string) => void;
    onSend?: (
      text: string,
      attachments: string[],
      displayText?: string,
      slashCommandLabel?: string,
    ) => void;
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
          "data-testid": "trigger-environment",
          onClick: () => onExecuteBuiltinCommand?.("environment", ""),
        },
        "Trigger /environment",
      ),
      h(
        "button",
        {
          type: "button",
          "data-testid": "trigger-memory",
          onClick: () => onExecuteBuiltinCommand?.("memory", ""),
        },
        "Trigger /memory",
      ),
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
          "data-testid": "trigger-remember",
          onClick: () =>
            onSend?.(
              "/remember Keep browser answers concise",
              [],
              undefined,
              "/remember",
            ),
        },
        "Trigger /remember",
      ),
      onInterject
        ? h(
            "button",
            {
              type: "button",
              "data-testid": "trigger-interject",
              onClick: () => onInterject("Change course", []),
            },
            "Trigger interject",
          )
        : null,
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
    projects: Array<{
      projectId: string;
      displayName: string;
      availability: "available" | "unavailable";
    }>;
    defaultProjectId: string | null;
    chatWorkspace?: BrowserGatewayChatWorkspaceSummary | null;
    repository: { projectId: string; branch?: string; dirty?: boolean } | null;
    sessions: never[];
    foreground: {
      project: {
        projectId: string;
        displayName: string;
        availability: "available" | "unavailable";
      };
      sessionId: string;
      title: string;
      mode: string;
      model: string;
      status: string;
      streaming: boolean;
      interrupted?: boolean;
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
      messageQueue: AppState["messageQueue"];
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
      debugInfo: Record<string, string | number> | null;
      systemPrompt: string | null;
      loadedInstructions: AppState["loadedInstructions"];
      restoringSession: boolean;
      condenseThreshold: number;
      agentWriteApproval: string;
    };
  };
  background: BgSessionInfo[];
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
      projects: [
        {
          projectId: "project-1",
          displayName: "Workspace",
          availability: "available",
        },
      ],
      defaultProjectId: "project-1",
      repository: null,
      sessions: [],
      foreground: {
        project: {
          projectId: "project-1",
          displayName: "Workspace",
          availability: "available",
        },
        sessionId: "session-1",
        title: "Test Session",
        mode: "code",
        model: "claude-sonnet-4-6",
        status: "idle",
        streaming: false,
        interrupted: false,
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
        debugInfo: null as Record<string, string | number> | null,
        systemPrompt: null as string | null,
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

function createGroupedSnapshot(): TestSnapshot {
  const snapshot = createSnapshot();
  snapshot.session.foreground.projectedMessages = [
    {
      id: "session-1-message",
      role: "assistant",
      content: "Foreground T1 transcript",
      timestamp: 1,
      blocks: [{ type: "text", text: "Foreground T1 transcript" }],
    },
  ];
  snapshot.session.chatWorkspace = {
    controllerEpoch: "controller-1",
    focusedTabId: "tab-1",
    tabs: [
      {
        tabId: "tab-1",
        displayNumber: 1,
        label: "T1",
        sessionId: "session-1",
        placement: "docked",
        title: "Foreground chat",
        status: "completed",
        busy: false,
      },
      {
        tabId: "tab-2",
        displayNumber: 2,
        label: "T2",
        sessionId: "session-2",
        placement: "popped",
        title: "Detached chat",
        status: "needs_input",
        busy: true,
      },
    ],
  };
  return snapshot;
}

function directSessionDetailResponse(
  ownerSnapshot: TestSnapshot,
  text: string,
): Response {
  const foreground = {
    ...ownerSnapshot.session.foreground,
    sessionId: "session-2",
    title: "Detached chat",
    projectedMessages: [
      {
        id: "session-2-message",
        role: "assistant" as const,
        content: text,
        timestamp: 2,
        blocks: [{ type: "text" as const, text }],
      },
    ],
  };
  return new Response(
    JSON.stringify({
      selection: {
        controllerEpoch: "controller-1",
        tabId: "tab-2",
        sessionId: "session-2",
      },
      session: foreground,
      ui: {
        approval: null,
        question: null,
        questionProgress: null,
        formElicitation: null,
        urlElicitation: null,
      },
      revertRecoveryState: null,
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    },
  );
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

  emit(type: string, value: unknown): void {
    for (const [eventName, listener] of this.addEventListener.mock.calls) {
      if (eventName === type) listener({ data: JSON.stringify(value) });
    }
  }
}

function getInstanceTabs(): HTMLElement[] {
  return within(
    screen.getByRole("tablist", { name: "Instances" }),
  ).getAllByRole("tab");
}

async function selectWorkspaceTab(): Promise<HTMLElement> {
  const workspaceTab = await screen.findByRole("tab", { name: /^Workspace/ });
  fireEvent.click(workspaceTab);
  let selectedWorkspaceTab: HTMLElement | undefined;
  await waitFor(() => {
    selectedWorkspaceTab = getInstanceTabs().find(
      (tab) =>
        !tab.textContent?.includes("Ask Agent") &&
        tab.getAttribute("aria-selected") === "true",
    );
    expect(selectedWorkspaceTab).toBeTruthy();
  });
  return selectedWorkspaceTab!;
}

describe("detached session detail cache", () => {
  it("caps retained transcripts and evicts the oldest entry", () => {
    const cache = new Map();
    for (let index = 1; index <= 3; index += 1) {
      cacheDetachedSessionDetail(
        cache,
        `instance-1\u0000controller-1\u0000tab-${index}\u0000session-${index}`,
        { selection: { sessionId: `session-${index}` } } as never,
        2,
      );
    }

    expect([...cache.keys()]).toEqual([
      "instance-1\u0000controller-1\u0000tab-2\u0000session-2",
      "instance-1\u0000controller-1\u0000tab-3\u0000session-3",
    ]);
  });

  it("prunes stale controller and session identities for one owner only", () => {
    const cache = new Map([
      [
        "instance-1\u0000controller-old\u0000tab-1\u0000session-old",
        {} as never,
      ],
      [
        "instance-1\u0000controller-new\u0000tab-1\u0000session-new",
        {} as never,
      ],
      [
        "instance-2\u0000controller-old\u0000tab-1\u0000session-other",
        {} as never,
      ],
    ]);
    const workspace: BrowserGatewayChatWorkspaceSummary = {
      controllerEpoch: "controller-new",
      focusedTabId: "tab-1",
      tabs: [
        {
          tabId: "tab-1",
          displayNumber: 1,
          label: "T1",
          sessionId: "session-new",
          placement: "docked",
          status: "completed",
          busy: false,
        },
      ],
    };

    pruneDetachedSessionDetailCache(cache, "instance-1", workspace);

    expect([...cache.keys()]).toEqual([
      "instance-1\u0000controller-new\u0000tab-1\u0000session-new",
      "instance-2\u0000controller-old\u0000tab-1\u0000session-other",
    ]);
  });
});

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
    window.sessionStorage.clear();
    installMatchMediaMock(false);
    document.documentElement.removeAttribute("style");

    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    globalThis.ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    } as unknown as typeof ResizeObserver;

    const snapshot = createSnapshot();
    snapshot.session.foreground.debugInfo = { platform: "darwin" };
    snapshot.session.foreground.systemPrompt = "workspace system prompt";
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
    window.sessionStorage.clear();
    document.documentElement.removeAttribute("style");
  });

  it("opens workspace environment details in the Activity Shelf", async () => {
    render(
      h(BrowserGatewayApp, {
        authToken: "token",
        currentInstanceId: "instance-1",
        workspaceName: "Workspace",
        routeByInstance: true,
      }),
    );

    await selectWorkspaceTab();
    expect(screen.queryByText("workspace system prompt")).toBeNull();
    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock.mockClear();

    fireEvent.click(await screen.findByTestId("trigger-environment"));
    expect(await screen.findByText("Environment")).toBeTruthy();
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([input, init]) =>
            String(input).includes("/api/debug/refresh") &&
            init?.method === "POST",
        ),
      ).toBe(true),
    );
    expect(screen.getByText("platform")).toBeTruthy();

    fireEvent.click(screen.getByText("System Prompt"));
    expect(screen.getByText("workspace system prompt")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Close Environment" }));
    expect(screen.queryByText("Environment")).toBeNull();
  });

  it("keeps an interrupted workspace session visible when resume is rejected", async () => {
    const interruptedSnapshot = createSnapshot();
    interruptedSnapshot.session.foreground.interrupted = true;
    const fallbackFetch = globalThis.fetch;
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/api/ui-state")) {
          return jsonResponse(interruptedSnapshot);
        }
        if (url.includes("/api/resume")) {
          return jsonResponse({ ok: false, error: "resume_not_started" }, 409);
        }
        return fallbackFetch(input, init);
      },
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    render(
      h(BrowserGatewayApp, {
        authToken: "test-token",
        currentInstanceId: "instance-1",
        workspaceName: "Workspace",
        routeByInstance: true,
      }),
    );

    await selectWorkspaceTab();
    expect(await screen.findByText("Session interrupted")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));

    expect(
      await screen.findByText("Resume failed: resume_not_started"),
    ).toBeTruthy();
    expect(screen.getByText("Session interrupted")).toBeTruthy();
  });

  it("retries a workspace turn without sending a synthetic user message", async () => {
    const errorSnapshot = createSnapshot();
    errorSnapshot.session.foreground.projectedMessages = [
      {
        id: "workspace-user-error",
        role: "user",
        content: "Run the command",
        timestamp: 1,
        blocks: [{ type: "text", text: "Run the command" }],
      },
      {
        id: "workspace-assistant-error",
        role: "assistant",
        content: "",
        timestamp: 2,
        blocks: [],
        error: {
          message: "Provider overloaded",
          retryable: true,
          code: "provider_overloaded",
        },
      },
    ];
    const fallbackFetch = globalThis.fetch;
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/api/ui-state")) return jsonResponse(errorSnapshot);
        if (url.includes("/api/retry")) return jsonResponse({ ok: true }, 202);
        return fallbackFetch(input, init);
      },
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    render(
      h(BrowserGatewayApp, {
        authToken: "test-token",
        currentInstanceId: "instance-1",
        workspaceName: "Workspace",
        routeByInstance: true,
      }),
    );

    await selectWorkspaceTab();
    fireEvent.click(await screen.findByText("Retry"));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([input]) =>
        String(input).includes("/api/retry?instanceId=instance-1"),
      );
      expect(call).toBeDefined();
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({
        sessionId: "session-1",
        projectId: "project-1",
      });
    });
    expect(
      fetchMock.mock.calls.some(([input, init]) => {
        if (!String(input).includes("/api/send")) return false;
        const body = JSON.parse(String((init as RequestInit).body ?? "{}")) as {
          text?: string;
        };
        return body.text === "Retry the last step.";
      }),
    ).toBe(false);
    expect(screen.queryByText("Retry the last step.")).toBeNull();
  });

  it("renders and safely resumes an interrupted workspace session", async () => {
    const interruptedSnapshot = createSnapshot();
    interruptedSnapshot.session.foreground.interrupted = true;
    const fallbackFetch = globalThis.fetch;
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/api/ui-state")) {
          return jsonResponse(interruptedSnapshot);
        }
        if (url.includes("/api/resume")) {
          return jsonResponse({ ok: true }, 202);
        }
        return fallbackFetch(input, init);
      },
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    render(
      h(BrowserGatewayApp, {
        authToken: "test-token",
        currentInstanceId: "instance-1",
        workspaceName: "Workspace",
        routeByInstance: true,
      }),
    );

    await selectWorkspaceTab();
    expect(await screen.findByText("Session interrupted")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([input]) =>
        String(input).includes("/api/resume?instanceId=instance-1"),
      );
      expect(call).toBeDefined();
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({
        sessionId: "session-1",
      });
    });
    await waitFor(() => {
      expect(screen.queryByText("Session interrupted")).toBeNull();
    });
  });

  for (const dataPlaneMode of ["on", "off"] as const) {
    it(`reloads once when helper authentication expires in ${dataPlaneMode} mode`, async () => {
      vi.useFakeTimers();
      const legacyFetch = globalThis.fetch;
      const reloadPage = vi.fn();
      globalThis.fetch = vi.fn(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          if (String(input).includes("/api/instances")) {
            return jsonResponse({ error: "unauthorized" }, 401);
          }
          return legacyFetch(input, init);
        },
      ) as unknown as typeof fetch;

      try {
        render(
          h(BrowserGatewayApp, {
            authToken: "test-token",
            currentInstanceId: "instance-1",
            workspaceName: "Workspace",
            routeByInstance: true,
            dataPlaneMode,
            reloadPage,
          }),
        );

        await act(async () => {
          await vi.advanceTimersByTimeAsync(15_000);
        });

        expect(reloadPage).toHaveBeenCalledTimes(1);
        expect(
          vi
            .mocked(globalThis.fetch)
            .mock.calls.filter(([input]) =>
              String(input).includes("/api/instances"),
            ).length,
        ).toBeGreaterThan(1);
      } finally {
        cleanup();
        vi.useRealTimers();
      }
    });
  }

  it("associates Browser Ask Agent model and send requests with the current VS Code instance", async () => {
    let resolveModelSelection!: () => void;
    let failModelSelection = false;
    const modelSelectionGate = new Promise<void>((resolve) => {
      resolveModelSelection = resolve;
    });
    const legacyFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/api/ask-agent/models?instanceId=instance-1")) {
          return jsonResponse({
            models: [
              {
                id: "moonshotai/kimi-k2",
                displayName: "Kimi K2",
                provider: "openai-compatible:openrouter-moonshotai-kimi-k3",
                contextWindow: 262_144,
                authenticated: true,
              },
            ],
            source: "cached",
            publishedByOwnerId: "workspace-owner",
            publishedAt: 1,
            modelCount: 1,
          });
        }
        if (url.includes("/api/relay/subscription")) {
          const request = JSON.parse(String(init?.body)) as {
            browserConnectionId: string;
            ownerId: string;
            ownerGenerationId: string;
          };
          return jsonResponse(
            {
              ok: true,
              protocolVersion: "1",
              helperGenerationId: "helper-1",
              browserConnectionId: request.browserConnectionId,
              subscriptionId: `subscription-${request.ownerId}`,
              ownerId: request.ownerId,
              ownerGenerationId: request.ownerGenerationId,
            },
            202,
          );
        }
        if (url === "/api/ask-agent/model") {
          await modelSelectionGate;
          if (failModelSelection) {
            return jsonResponse({ error: "invalid_model" }, 400);
          }
          const snapshot = createAskAgentSessionResponse().snapshot;
          delete (snapshot.session.foreground as { project?: ProjectInfo })
            .project;
          delete (snapshot.session as { projects?: ProjectInfo[] }).projects;
          snapshot.session.foreground.model = "moonshotai/kimi-k2";
          return jsonResponse({ ok: true, snapshot });
        }
        return legacyFetch(input, init);
      },
    ) as unknown as typeof fetch;

    render(
      h(BrowserGatewayApp, {
        authToken: "test-token",
        currentInstanceId: "instance-1",
        workspaceName: "Workspace",
        routeByInstance: true,
        dataPlaneMode: "on",
      }),
    );

    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1));
    const source = MockEventSource.instances[0]!;
    await act(async () => {
      source.emit("hello", {
        protocolVersion: "1",
        helperGenerationId: "helper-1",
        browserConnectionId: "connection-1",
        csrfNonce: "nonce-1",
        emittedAt: 1,
      });
      source.emit("catalog", {
        protocolVersion: "1",
        helperGenerationId: "helper-1",
        emittedAt: 1,
        owners: [
          {
            ownerId: BROWSER_GATEWAY_ASK_AGENT_OWNER_ID,
            ownerGenerationId: "ask-generation",
            ownerKind: "browser-gateway",
            displayName: "Ask Agent",
            scope: {
              kind: "projectless",
              scopeId: "ask-agent",
              displayName: "Ask Agent",
            },
            status: "connected",
            capabilities: [],
            lastHeartbeatAt: 1,
          },
          {
            ownerId: "workspace-owner",
            ownerGenerationId: "workspace-generation",
            ownerKind: "vscode",
            displayName: "Workspace",
            instanceId: "instance-1",
            scope: {
              kind: "workspace",
              workspaceId: "workspace-1",
              displayName: "Workspace",
            },
            status: "connected",
            capabilities: [],
            lastHeartbeatAt: 1,
          },
        ],
      });
    });
    await waitFor(() => {
      expect(
        vi
          .mocked(globalThis.fetch)
          .mock.calls.some(([input]) =>
            String(input).includes("/api/relay/subscription"),
          ),
      ).toBe(true);
    });
    await act(async () => {
      source.emit("checkpoint", {
        protocolVersion: "1",
        helperGenerationId: "helper-1",
        subscriptionId: `subscription-${BROWSER_GATEWAY_ASK_AGENT_OWNER_ID}`,
        ownerId: BROWSER_GATEWAY_ASK_AGENT_OWNER_ID,
        ownerGenerationId: "ask-generation",
        record: {
          kind: "checkpoint",
          relaySequence: 1,
          ownerSequence: 1,
          checkpoint: {
            protocolVersion: "1",
            helperGenerationId: "helper-1",
            ownerId: BROWSER_GATEWAY_ASK_AGENT_OWNER_ID,
            ownerGenerationId: "ask-generation",
            checkpointId: "checkpoint-ask-agent",
            checkpointSequence: 1,
            emittedAt: 2,
            foreground: {
              sessionId: "browser-gateway:ask-agent:default",
              title: "Ask Agent",
              mode: "ask",
              model: "gpt-5.3-codex",
              status: "idle",
              streaming: false,
            },
            catalog: {
              projects: [],
              sessions: [
                {
                  sessionId: "browser-gateway:ask-agent:default",
                  projectId: null,
                  title: "Ask Agent",
                  mode: "ask",
                  model: "gpt-5.3-codex",
                  messageCount: 0,
                  createdAt: 1,
                  updatedAt: 2,
                },
              ],
              defaultProjectId: null,
              foregroundSessionId: "browser-gateway:ask-agent:default",
            },
            transcript: {
              messages: [],
              earlierCursor: null,
              hasEarlier: false,
            },
            ui: {
              interaction: null,
              queue: [],
              todos: [],
              operations: [],
            },
            background: [],
            fleet: [],
            diffs: [],
            repository: null,
            theme: {
              revision: "theme-ask-agent",
              colorScheme: "dark",
              variables: [],
            },
            modelCatalogRevision: "models-ask-agent",
            capabilities: [],
          },
        },
      });
    });

    await waitFor(() => {
      expect(
        vi
          .mocked(globalThis.fetch)
          .mock.calls.some(([input]) =>
            String(input).includes(
              "/api/ask-agent/models?instanceId=instance-1",
            ),
          ),
      ).toBe(true);
      expect(screen.queryByText("Loading Ask Agent session…")).toBeNull();
      expect(screen.getByTestId("model-count").textContent).toBe("1");
    });

    fireEvent.click(screen.getByTestId("trigger-select-model"));
    await waitFor(() => {
      expect(
        vi
          .mocked(globalThis.fetch)
          .mock.calls.some(
            ([input]) => String(input) === "/api/ask-agent/model",
          ),
      ).toBe(true);
    });
    expect(screen.getByTestId("mock-input-area")).toBeTruthy();
    fireEvent.click(screen.getByTestId("trigger-send"));
    await waitFor(() => {
      expect(screen.getByText("Waiting for model switch…")).toBeTruthy();
    });
    expect(
      vi
        .mocked(globalThis.fetch)
        .mock.calls.some(([input]) => String(input) === "/api/ask-agent/send"),
    ).toBe(false);

    await act(async () => resolveModelSelection());

    await waitFor(() => {
      const modelCall = vi
        .mocked(globalThis.fetch)
        .mock.calls.find(([input]) => String(input) === "/api/ask-agent/model");
      const sendCall = vi
        .mocked(globalThis.fetch)
        .mock.calls.find(([input]) => String(input) === "/api/ask-agent/send");
      expect(modelCall).toBeTruthy();
      expect(sendCall).toBeTruthy();
      expect(JSON.parse(String(modelCall?.[1]?.body))).toMatchObject({
        model: "moonshotai/kimi-k2",
        instanceId: "instance-1",
      });
      expect(JSON.parse(String(sendCall?.[1]?.body))).toMatchObject({
        instanceId: "instance-1",
      });
      expect(
        vi
          .mocked(globalThis.fetch)
          .mock.calls.some(([input]) =>
            String(input).includes("/api/relay/commands"),
          ),
      ).toBe(false);
    });

    failModelSelection = true;
    fireEvent.click(screen.getByTestId("trigger-select-model"));
    fireEvent.click(screen.getByTestId("trigger-send"));
    await waitFor(() => {
      expect(
        screen.getByText("Message not sent because the model switch failed."),
      ).toBeTruthy();
    });
    expect(
      vi
        .mocked(globalThis.fetch)
        .mock.calls.filter(
          ([input]) => String(input) === "/api/ask-agent/send",
        ),
    ).toHaveLength(1);
  });

  it("opens workspace file mentions through the owning VS Code instance", async () => {
    const snapshot = createSnapshot();
    snapshot.session.foreground.projectedMessages = [
      {
        id: "user-file-mention",
        role: "user",
        content: "Review @README.md",
        timestamp: 1,
        blocks: [],
      },
    ];
    const legacyFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/api/ui-state")) return jsonResponse(snapshot);
        if (url.includes("/api/open-file")) return jsonResponse({ ok: true });
        return legacyFetch(input, init);
      },
    ) as unknown as typeof fetch;

    render(
      h(BrowserGatewayApp, {
        authToken: "test-token",
        currentInstanceId: "instance-1",
        workspaceName: "Workspace",
        routeByInstance: true,
        dataPlaneMode: "off",
      }),
    );

    await selectWorkspaceTab();
    fireEvent.click(await screen.findByText("@README.md"));

    await waitFor(() => {
      const openCall = vi
        .mocked(globalThis.fetch)
        .mock.calls.find(([input]) => String(input).includes("/api/open-file"));
      expect(openCall).toBeTruthy();
      expect(JSON.parse(String(openCall?.[1]?.body))).toEqual({
        path: "README.md",
        projectId: "project-1",
      });
    });
  });

  it("uses one relay EventSource across collision-safe tab subscriptions when mode is on", async () => {
    const legacyFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/api/relay/subscription")) {
          const request = JSON.parse(String(init?.body)) as {
            browserConnectionId: string;
            ownerId: string;
            ownerGenerationId: string;
          };
          return jsonResponse(
            {
              ok: true,
              protocolVersion: "1",
              helperGenerationId: "helper-1",
              browserConnectionId: request.browserConnectionId,
              subscriptionId: `subscription-${request.ownerId}`,
              ownerId: request.ownerId,
              ownerGenerationId: request.ownerGenerationId,
            },
            202,
          );
        }
        return legacyFetch(input, init);
      },
    ) as unknown as typeof fetch;

    render(
      h(BrowserGatewayApp, {
        authToken: "test-token",
        currentInstanceId: "instance-1",
        workspaceName: "Workspace",
        routeByInstance: true,
        dataPlaneMode: "on",
      }),
    );

    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1));
    const source = MockEventSource.instances[0]!;
    expect(source.url).toBe("/api/relay/events");
    await act(async () => {
      source.emit("hello", {
        protocolVersion: "1",
        helperGenerationId: "helper-1",
        browserConnectionId: "connection-1",
        csrfNonce: "nonce-1",
        emittedAt: 1,
      });
      source.emit("catalog", {
        protocolVersion: "1",
        helperGenerationId: "helper-1",
        emittedAt: 1,
        owners: [
          {
            ownerId: BROWSER_GATEWAY_ASK_AGENT_OWNER_ID,
            ownerGenerationId: "ask-generation",
            ownerKind: "browser-gateway",
            displayName: "Ask Agent",
            scope: {
              kind: "projectless",
              scopeId: "ask-agent",
              displayName: "Ask Agent",
            },
            status: "connected",
            capabilities: [],
            lastHeartbeatAt: 1,
          },
          {
            ownerId: "collision-adjusted-owner",
            ownerGenerationId: "workspace-generation",
            ownerKind: "vscode",
            displayName: "Workspace",
            instanceId: "instance-1",
            scope: {
              kind: "workspace",
              workspaceId: "workspace-1",
              displayName: "Workspace",
            },
            status: "connected",
            capabilities: [],
            lastHeartbeatAt: 1,
          },
        ],
      });
    });
    await selectWorkspaceTab();
    await waitFor(() => {
      const subscriptionCalls = vi
        .mocked(globalThis.fetch)
        .mock.calls.filter(([url]) =>
          String(url).includes("/api/relay/subscription"),
        );
      expect(subscriptionCalls).toHaveLength(2);
      expect(JSON.parse(String(subscriptionCalls[1]?.[1]?.body))).toMatchObject(
        {
          ownerId: "collision-adjusted-owner",
          ownerGenerationId: "workspace-generation",
        },
      );
    });

    expect(MockEventSource.instances).toHaveLength(1);
    expect(source.close).not.toHaveBeenCalled();
    expect(source.url).not.toContain("/events?instanceId=");
    expect(source.url).not.toBe("/api/ask-agent/events");
  });

  it("waits for the selected relay project before fetching workspace modes and slash commands", async () => {
    const legacyFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/api/instances")) {
          return jsonResponse({
            currentInstanceId: "openapi-generation-oss",
            instances: [
              {
                instanceId: "openapi-generation-oss",
                workspaceName: "Workspace",
                workspacePath: "/workspace",
                url: "http://127.0.0.1:3333",
                status: { kind: "idle", label: "Idle" },
              },
            ],
          });
        }
        if (url.includes("/api/relay/subscription")) {
          const request = JSON.parse(String(init?.body)) as {
            browserConnectionId: string;
            ownerId: string;
            ownerGenerationId: string;
          };
          return jsonResponse(
            {
              ok: true,
              protocolVersion: "1",
              helperGenerationId: "helper-1",
              browserConnectionId: request.browserConnectionId,
              subscriptionId: `subscription-${request.ownerId}`,
              ownerId: request.ownerId,
              ownerGenerationId: request.ownerGenerationId,
            },
            202,
          );
        }
        return legacyFetch(input, init);
      },
    ) as unknown as typeof fetch;

    render(
      h(BrowserGatewayApp, {
        authToken: "test-token",
        currentInstanceId: "openapi-generation-oss",
        workspaceName: "Workspace",
        routeByInstance: true,
        dataPlaneMode: "on",
      }),
    );

    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1));
    const source = MockEventSource.instances[0]!;
    await act(async () => {
      source.emit("hello", {
        protocolVersion: "1",
        helperGenerationId: "helper-1",
        browserConnectionId: "connection-1",
        csrfNonce: "nonce-1",
        emittedAt: 1,
      });
      source.emit("catalog", {
        protocolVersion: "1",
        helperGenerationId: "helper-1",
        emittedAt: 1,
        owners: [
          {
            ownerId: BROWSER_GATEWAY_ASK_AGENT_OWNER_ID,
            ownerGenerationId: "ask-generation",
            ownerKind: "browser-gateway",
            displayName: "Ask Agent",
            scope: {
              kind: "projectless",
              scopeId: "ask-agent",
              displayName: "Ask Agent",
            },
            status: "connected",
            capabilities: [],
            lastHeartbeatAt: 1,
          },
          {
            ownerId: "openapi-owner",
            ownerGenerationId: "openapi-generation",
            ownerKind: "vscode",
            displayName: "Workspace",
            instanceId: "openapi-generation-oss",
            scope: {
              kind: "workspace",
              workspaceId: "openapi-workspace",
              displayName: "Workspace",
            },
            status: "connected",
            capabilities: [],
            lastHeartbeatAt: 1,
          },
        ],
      });
    });
    await selectWorkspaceTab();
    await waitFor(() => {
      expect(
        vi
          .mocked(globalThis.fetch)
          .mock.calls.some(([url]) =>
            String(url).includes(
              "/api/models?instanceId=openapi-generation-oss",
            ),
          ),
      ).toBe(true);
    });

    const requestedUrls = () =>
      vi.mocked(globalThis.fetch).mock.calls.map(([url]) => String(url));
    expect(requestedUrls()).not.toContain(
      "/api/modes?instanceId=openapi-generation-oss",
    );
    expect(requestedUrls()).not.toContain(
      "/api/slash-commands?instanceId=openapi-generation-oss",
    );

    await act(async () => {
      source.emit("checkpoint", {
        protocolVersion: "1",
        helperGenerationId: "helper-1",
        subscriptionId: "subscription-openapi-owner",
        ownerId: "openapi-owner",
        ownerGenerationId: "openapi-generation",
        record: {
          kind: "checkpoint",
          relaySequence: 1,
          ownerSequence: 1,
          checkpoint: {
            protocolVersion: "1",
            helperGenerationId: "helper-1",
            ownerId: "openapi-owner",
            ownerGenerationId: "openapi-generation",
            checkpointId: "checkpoint-openapi",
            checkpointSequence: 1,
            emittedAt: 2,
            foreground: {
              sessionId: "session-openapi",
              title: "OpenAPI Session",
              mode: "code",
              model: "gpt-5.6-sol",
              status: "idle",
              streaming: false,
            },
            catalog: {
              projects: [
                {
                  projectId: "project-other",
                  displayName: "Other",
                  availability: "available",
                },
                {
                  projectId: "project-openapi",
                  displayName: "OpenAPI",
                  availability: "available",
                },
              ],
              sessions: [
                {
                  sessionId: "session-openapi",
                  projectId: "project-openapi",
                  title: "OpenAPI Session",
                  mode: "code",
                  model: "gpt-5.6-sol",
                  messageCount: 0,
                  createdAt: 1,
                  updatedAt: 2,
                },
              ],
              defaultProjectId: "project-openapi",
              foregroundSessionId: "session-openapi",
            },
            transcript: {
              messages: [],
              earlierCursor: null,
              hasEarlier: false,
            },
            ui: {
              interaction: null,
              queue: [],
              todos: [],
              operations: [],
            },
            background: [],
            fleet: [],
            diffs: [],
            repository: null,
            theme: {
              revision: "theme-openapi",
              colorScheme: "dark",
              variables: [],
            },
            modelCatalogRevision: "models-openapi",
            capabilities: [],
          },
        },
      });
    });

    await waitFor(() => {
      expect(requestedUrls()).toContain(
        "/api/modes?projectId=project-openapi&instanceId=openapi-generation-oss",
      );
      expect(requestedUrls()).toContain(
        "/api/slash-commands?projectId=project-openapi&instanceId=openapi-generation-oss",
      );
    });
    expect(requestedUrls()).not.toContain(
      "/api/modes?instanceId=openapi-generation-oss",
    );
    expect(requestedUrls()).not.toContain(
      "/api/slash-commands?instanceId=openapi-generation-oss",
    );
  });

  it("fetches project-scoped workspace metadata after a legacy SSE snapshot", async () => {
    render(
      h(BrowserGatewayApp, {
        authToken: "test-token",
        currentInstanceId: "instance-1",
        workspaceName: "Workspace",
        routeByInstance: true,
        dataPlaneMode: "off",
      }),
    );

    await selectWorkspaceTab();
    const source = MockEventSource.instances.at(-1)!;
    const snapshot = createSnapshot();
    snapshot.session.defaultProjectId = "project-legacy";
    snapshot.session.foreground.project.projectId = "project-legacy";
    snapshot.session.projects = [
      {
        projectId: "project-legacy",
        displayName: "Legacy",
        availability: "available",
      },
    ];
    source.emit("update", snapshot);

    await waitFor(() => {
      const urls = vi
        .mocked(globalThis.fetch)
        .mock.calls.map(([url]) => String(url));
      expect(urls).toContain(
        "/api/modes?projectId=project-legacy&instanceId=instance-1",
      );
      expect(urls).toContain(
        "/api/slash-commands?projectId=project-legacy&instanceId=instance-1",
      );
    });
  });

  it("ignores stale workspace metadata responses after an in-tab project switch", async () => {
    const legacyFetch = globalThis.fetch;
    let resolveProjectOneCommands!: (response: Response) => void;
    const projectOneCommands = new Promise<Response>((resolve) => {
      resolveProjectOneCommands = resolve;
    });
    globalThis.fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/api/slash-commands?projectId=project-1")) {
          return projectOneCommands;
        }
        if (url.includes("/api/slash-commands?projectId=project-2")) {
          return jsonResponse({
            commands: [
              {
                name: "project-two",
                description: "Project two command",
                source: "builtin",
                builtin: true,
              },
            ],
          });
        }
        return legacyFetch(input, init);
      },
    ) as unknown as typeof fetch;

    render(
      h(BrowserGatewayApp, {
        authToken: "test-token",
        currentInstanceId: "instance-1",
        workspaceName: "Workspace",
        routeByInstance: true,
        dataPlaneMode: "off",
      }),
    );

    await selectWorkspaceTab();
    const source = MockEventSource.instances.at(-1)!;
    const projectOneSnapshot = createSnapshot();
    source.emit("update", projectOneSnapshot);
    await waitFor(() => {
      expect(
        vi
          .mocked(globalThis.fetch)
          .mock.calls.some(([url]) =>
            String(url).includes("/api/slash-commands?projectId=project-1"),
          ),
      ).toBe(true);
    });

    const projectTwoSnapshot = createSnapshot();
    projectTwoSnapshot.session.defaultProjectId = "project-2";
    projectTwoSnapshot.session.foreground.project.projectId = "project-2";
    projectTwoSnapshot.session.projects = [
      {
        projectId: "project-2",
        displayName: "Project Two",
        availability: "available",
      },
    ];
    source.emit("update", projectTwoSnapshot);
    await waitFor(() => {
      expect(screen.getByTestId("slash-command-names").textContent).toBe(
        "project-two",
      );
    });

    resolveProjectOneCommands(
      jsonResponse({
        commands: [
          {
            name: "stale-project-one",
            description: "Stale project one command",
            source: "builtin",
            builtin: true,
          },
        ],
      }),
    );
    await act(async () => {});
    expect(screen.getByTestId("slash-command-names").textContent).toBe(
      "project-two",
    );
  });

  it("rolls a relay selection to a live workspace replacement without stale model errors or EventSource churn", async () => {
    vi.useFakeTimers();
    const legacyFetch = globalThis.fetch;
    let instanceGeneration: "old" | "new" = "old";
    let resolveOldModels!: (response: Response) => void;
    const oldModelsResponse = new Promise<Response>((resolve) => {
      resolveOldModels = resolve;
    });
    globalThis.fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/api/instances")) {
          const suffix = instanceGeneration === "old" ? "old" : "new";
          return jsonResponse({
            currentInstanceId: `workspace-${suffix}`,
            instances: [
              {
                instanceId: `workspace-${suffix}`,
                workspaceName: "Workspace",
                workspacePath: "/workspace",
                url: "http://127.0.0.1:3333",
                status: { kind: "idle", label: "Idle" },
              },
            ],
          });
        }
        if (url.includes("/api/relay/subscription")) {
          const request = JSON.parse(String(init?.body)) as {
            browserConnectionId: string;
            ownerId: string;
            ownerGenerationId: string;
          };
          return jsonResponse(
            {
              ok: true,
              protocolVersion: "1",
              helperGenerationId: "helper-1",
              browserConnectionId: request.browserConnectionId,
              subscriptionId: `subscription-${request.ownerId}`,
              ownerId: request.ownerId,
              ownerGenerationId: request.ownerGenerationId,
            },
            202,
          );
        }
        if (
          url.includes("/api/models") &&
          url.includes("instanceId=workspace-old")
        ) {
          return oldModelsResponse;
        }
        if (
          url.includes("/api/models") &&
          url.includes("instanceId=workspace-new")
        ) {
          return jsonResponse({
            models: [
              {
                id: "gpt-5.6-sol",
                displayName: "GPT-5.6 Sol",
                provider: "codex",
                contextWindow: 200000,
                authenticated: true,
              },
            ],
          });
        }
        return legacyFetch(input, init);
      },
    ) as unknown as typeof fetch;

    try {
      render(
        h(BrowserGatewayApp, {
          authToken: "test-token",
          currentInstanceId: "workspace-old",
          workspaceName: "Workspace",
          routeByInstance: true,
          dataPlaneMode: "on",
        }),
      );

      await waitFor(() => expect(MockEventSource.instances).toHaveLength(1));
      const source = MockEventSource.instances[0]!;
      await act(async () => {
        source.emit("hello", {
          protocolVersion: "1",
          helperGenerationId: "helper-1",
          browserConnectionId: "connection-1",
          csrfNonce: "nonce-1",
          emittedAt: 1,
        });
        source.emit("catalog", {
          protocolVersion: "1",
          helperGenerationId: "helper-1",
          emittedAt: 1,
          owners: [
            {
              ownerId: BROWSER_GATEWAY_ASK_AGENT_OWNER_ID,
              ownerGenerationId: "ask-generation",
              ownerKind: "browser-gateway",
              displayName: "Ask Agent",
              scope: {
                kind: "projectless",
                scopeId: "ask-agent",
                displayName: "Ask Agent",
              },
              status: "connected",
              capabilities: [],
              lastHeartbeatAt: 1,
            },
            {
              ownerId: "workspace-owner-old",
              ownerGenerationId: "workspace-generation-old",
              ownerKind: "vscode",
              displayName: "Workspace",
              instanceId: "workspace-old",
              scope: {
                kind: "workspace",
                workspaceId: "workspace-1",
                displayName: "Workspace",
              },
              status: "connected",
              capabilities: [],
              lastHeartbeatAt: 1,
            },
          ],
        });
      });
      await selectWorkspaceTab();
      await waitFor(() => {
        expect(
          vi
            .mocked(globalThis.fetch)
            .mock.calls.some(([url]) =>
              String(url).includes("/api/models?instanceId=workspace-old"),
            ),
        ).toBe(true);
      });

      instanceGeneration = "new";
      await act(async () => {
        source.emit("catalog", {
          protocolVersion: "1",
          helperGenerationId: "helper-1",
          emittedAt: 2,
          owners: [
            {
              ownerId: BROWSER_GATEWAY_ASK_AGENT_OWNER_ID,
              ownerGenerationId: "ask-generation",
              ownerKind: "browser-gateway",
              displayName: "Ask Agent",
              scope: {
                kind: "projectless",
                scopeId: "ask-agent",
                displayName: "Ask Agent",
              },
              status: "connected",
              capabilities: [],
              lastHeartbeatAt: 2,
            },
            {
              ownerId: "workspace-owner-new",
              ownerGenerationId: "workspace-generation-new",
              ownerKind: "vscode",
              displayName: "Workspace",
              instanceId: "workspace-new",
              scope: {
                kind: "workspace",
                workspaceId: "workspace-1",
                displayName: "Workspace",
              },
              status: "connected",
              capabilities: [],
              lastHeartbeatAt: 2,
            },
          ],
        });
        await vi.advanceTimersByTimeAsync(5_000);
      });

      await waitFor(() => {
        const tabs = screen.getAllByRole("tab", { name: /Workspace/ });
        expect(tabs).toHaveLength(1);
        expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
        expect(tabs[0]?.textContent).not.toContain("Disconnected");
      });
      await waitFor(() => {
        expect(
          vi
            .mocked(globalThis.fetch)
            .mock.calls.some(([url]) =>
              String(url).includes("/api/models?instanceId=workspace-new"),
            ),
        ).toBe(true);
      });

      await act(async () => resolveOldModels(jsonResponse({}, 404)));
      expect(screen.queryByText(/Model list unavailable/)).toBeNull();
      expect(MockEventSource.instances).toHaveLength(1);
      expect(source.close).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
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

    await selectWorkspaceTab();
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([input]) =>
          String(input).includes("/api/ui-state"),
        ),
      ).toBe(true);
      expect(screen.queryByText("Loading session…")).toBeNull();
    });
    fireEvent.click(await screen.findByTestId("trigger-send"));

    await waitFor(() => {
      expect(screen.getByText("Queued.")).toBeTruthy();
    });
  });

  it("marks a message from the browser composer as an interjection", async () => {
    const snapshot = createSnapshot();
    snapshot.session.foreground.status = "streaming";
    snapshot.session.foreground.streaming = true;
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/send")) {
        return jsonResponse({ ok: true, queued: true, interjected: true });
      }
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
              status: { kind: "streaming", label: "Streaming" },
            },
          ],
        });
      }
      if (url.includes("/api/slash-commands")) {
        return jsonResponse({ commands: [] });
      }
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

    await selectWorkspaceTab();
    await screen.findByText("Working…");
    fireEvent.click(await screen.findByTestId("trigger-interject"));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([input, init]) => {
          if (!String(input).includes("/api/send")) return false;
          const body = JSON.parse(String((init as RequestInit).body ?? "{}"));
          return body.text === "Change course" && body.interject === true;
        }),
      ).toBe(true);
      expect(
        screen.getByText("Ready to interject at the next break."),
      ).toBeTruthy();
    });
  });

  it("renders browser queue steering controls and posts queue actions", async () => {
    const queuedSnapshot = createSnapshot();
    queuedSnapshot.session.foreground.status = "streaming";
    queuedSnapshot.session.foreground.streaming = true;
    queuedSnapshot.session.foreground.messageQueue = [
      {
        id: "queue-1",
        text: "Please steer this",
        fullText: "Please steer this",
        source: "browser",
      },
    ];
    const interjectionSnapshot = createSnapshot();
    interjectionSnapshot.session.foreground.status = "streaming";
    interjectionSnapshot.session.foreground.streaming = true;
    interjectionSnapshot.session.foreground.messageQueue = [
      {
        id: "queue-1",
        text: "Please steer this",
        fullText: "Please steer this",
        source: "browser",
        interjectionReady: true,
      },
    ];
    const drainedSnapshot = createSnapshot();

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/ui-state")) return jsonResponse(queuedSnapshot);
      if (url.includes("/api/queue/interject")) {
        return jsonResponse({ ok: true, snapshot: interjectionSnapshot });
      }
      if (url.includes("/api/queue/steer")) {
        return jsonResponse({ ok: true, snapshot: drainedSnapshot });
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

    await selectWorkspaceTab();
    expect(await screen.findByText("Queued (1)")).toBeTruthy();
    expect(screen.getByTitle("Steer now")).toBeTruthy();
    expect(screen.getByTitle("Interject at next break")).toBeTruthy();

    fireEvent.click(screen.getByTitle("Interject at next break"));
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([input]) =>
          String(input).includes("/api/queue/interject"),
        ),
      ).toBe(true);
    });
    expect(
      await screen.findByTitle("Ready to interject at next break"),
    ).toBeTruthy();

    fireEvent.click(screen.getByTitle("Steer now"));
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([input]) =>
          String(input).includes("/api/queue/steer"),
        ),
      ).toBe(true);
    });
  });

  it("ignores a queue response after the browser selection changes", async () => {
    const queuedSnapshot = createSnapshot();
    queuedSnapshot.session.foreground.status = "streaming";
    queuedSnapshot.session.foreground.streaming = true;
    queuedSnapshot.session.foreground.messageQueue = [
      {
        id: "queue-1",
        text: "Origin queue item",
        fullText: "Origin queue item",
        source: "browser",
      },
    ];
    let resolveInterjection: ((response: Response) => void) | undefined;
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
          ],
        });
      }
      if (url.includes("/api/ask-agent/session")) {
        return jsonResponse(createAskAgentSessionResponse());
      }
      if (url.includes("/api/ui-state")) return jsonResponse(queuedSnapshot);
      if (url.includes("/api/queue/interject")) {
        return new Promise<Response>((resolve) => {
          resolveInterjection = resolve;
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
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    render(
      h(BrowserGatewayApp, {
        authToken: "test-token",
        currentInstanceId: "instance-1",
        workspaceName: "Workspace",
        routeByInstance: true,
      }),
    );

    await selectWorkspaceTab();
    fireEvent.click(await screen.findByTitle("Interject at next break"));
    expect(screen.getByTitle("Ready to interject at next break")).toBeTruthy();
    await waitFor(() => expect(resolveInterjection).toBeTypeOf("function"));
    const askAgentTab = screen.getByRole("tab", { name: /Ask Agent/ });
    fireEvent.click(askAgentTab);
    await waitFor(() =>
      expect(askAgentTab.getAttribute("aria-selected")).toBe("true"),
    );

    const lateSnapshot = createSnapshot();
    lateSnapshot.session.foreground.projectedMessages = [
      {
        id: "late-origin-message",
        role: "assistant",
        content: "Late origin response",
        timestamp: 3,
        blocks: [{ type: "text", text: "Late origin response" }],
      },
    ];
    await act(async () => {
      resolveInterjection?.(jsonResponse({ ok: true, snapshot: lateSnapshot }));
      await Promise.resolve();
    });

    expect(askAgentTab.getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByText("Late origin response")).toBeNull();
  });

  it("sends project final-marker Continue prompts through the selected project instance", async () => {
    const snapshot = createSnapshot();
    snapshot.session.foreground.projectedMessages = [
      {
        id: "assistant-final",
        role: "assistant",
        content: "Ready for the next slice.",
        timestamp: 100,
        blocks: [{ type: "text", text: "Ready for the next slice." }],
        finalMarker: {
          status: "completed",
          source: "tool",
          summary: "Ready for the next slice.",
          continueAction: {
            label: "Continue",
            prompt: "Please continue the next slice.",
          },
          toolCall: {
            id: "call-final",
            name: "set_task_status",
            inputJson: JSON.stringify({
              status: "completed",
              summary: "Ready for the next slice.",
              continueLabel: "Continue",
              continuePrompt: "Please continue the next slice.",
            }),
          },
        },
      },
    ];

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/ui-state")) return jsonResponse(snapshot);
      if (url.includes("/api/send")) {
        return jsonResponse({ ok: true, snapshot });
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

    await selectWorkspaceTab();
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([input, init]) => {
          if (!String(input).includes("/api/send")) return false;
          const body = JSON.parse(String((init as RequestInit).body ?? "{}"));
          return (
            body.text === "Please continue the next slice." &&
            body.sessionId === "session-1" &&
            body.projectId === "project-1"
          );
        }),
      ).toBe(true);
    });
  });

  it("sends Ask Agent final-marker Continue prompts through Ask Agent", async () => {
    const askSnapshot = createAskAgentSessionResponse().snapshot;
    askSnapshot.session.foreground.projectedMessages = [
      {
        id: "ask-assistant-final",
        role: "assistant",
        content: "Ready for the next Ask Agent step.",
        timestamp: 100,
        blocks: [{ type: "text", text: "Ready for the next Ask Agent step." }],
        finalMarker: {
          status: "completed",
          source: "tool",
          summary: "Ready for the next Ask Agent step.",
          continueAction: {
            label: "Continue",
            prompt: "Please continue in Ask Agent.",
          },
          toolCall: {
            id: "call-final",
            name: "set_task_status",
            inputJson: JSON.stringify({
              status: "completed",
              summary: "Ready for the next Ask Agent step.",
              continueLabel: "Continue",
              continuePrompt: "Please continue in Ask Agent.",
            }),
          },
        },
      },
    ];

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      const pathname = url.startsWith("http")
        ? new URL(url).pathname
        : url.split("?")[0];
      if (pathname === "/api/ask-agent/session") {
        return jsonResponse({
          ok: true,
          ownerRegistration: { capabilities: [] },
          session: { capabilities: [] },
          snapshot: askSnapshot,
        });
      }
      if (pathname === "/api/ask-agent/send") {
        return jsonResponse({ ok: true, snapshot: askSnapshot });
      }
      if (pathname === "/api/instances") {
        return jsonResponse({ currentInstanceId: "", instances: [] });
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

    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([input, init]) => {
          if (String(input) !== "/api/ask-agent/send") return false;
          const body = JSON.parse(String((init as RequestInit).body ?? "{}"));
          return (
            body.text === "Please continue in Ask Agent." &&
            body.sessionId === "browser-gateway:ask-agent:default"
          );
        }),
      ).toBe(true);
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

  it("opens routed browser pages on Ask Agent by default", async () => {
    render(
      h(BrowserGatewayApp, {
        authToken: "test-token",
        currentInstanceId: "instance-1",
        workspaceName: "Workspace",
        routeByInstance: true,
      }),
    );

    const askAgentTab = await screen.findByRole("tab", { name: /Ask Agent/ });
    await screen.findByRole("tab", { name: /Workspace/ });

    expect(askAgentTab.getAttribute("aria-selected")).toBe("true");
    await waitFor(() => {
      expect(MockEventSource.instances.at(-1)?.url).toBe(
        "/api/ask-agent/events",
      );
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

    expect(
      (await screen.findByRole("tab", { name: /Ask Agent/ })).getAttribute(
        "aria-selected",
      ),
    ).toBe("true");
    const workspaceTab = await selectWorkspaceTab();
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

  it("renders grouped logical tabs and hydrates detached detail without selecting the VS Code session", async () => {
    const groupedSnapshot = createGroupedSnapshot();
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
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
            ],
          });
        }
        if (url.includes("/api/ask-agent/session")) {
          return jsonResponse(createAskAgentSessionResponse());
        }
        if (url.includes("/api/ui-state")) return jsonResponse(groupedSnapshot);
        if (url.includes("/api/session-detail")) {
          expect(init).toMatchObject({
            credentials: "same-origin",
            headers: { Authorization: "Bearer test-token" },
          });
          return directSessionDetailResponse(
            groupedSnapshot,
            "Detached T2 transcript",
          );
        }
        if (url.includes("/api/models")) return jsonResponse({ models: [] });
        if (url.includes("/api/modes")) return jsonResponse({ modes: [] });
        if (url.includes("/api/slash-commands")) {
          return jsonResponse({ commands: [] });
        }
        if (url.includes("/api/sessions"))
          return jsonResponse({ sessions: [] });
        if (url.includes("/api/debug/refresh"))
          return jsonResponse({ ok: true });
        return jsonResponse({ error: "not_found" }, 404);
      },
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    render(
      h(BrowserGatewayApp, {
        authToken: "test-token",
        currentInstanceId: "instance-1",
        workspaceName: "Workspace",
        routeByInstance: true,
      }),
    );

    await selectWorkspaceTab();
    const t1 = await screen.findByRole("tab", {
      name: /T1.*Foreground chat/,
    });
    const t2 = screen.getByRole("tab", { name: /T2.*Detached chat/ });
    const tablist = screen.getByRole("tablist", { name: "Instances" });
    expect(tablist.contains(t1)).toBe(true);
    expect(tablist.contains(t2)).toBe(true);
    await waitFor(() => {
      expect(t1.getAttribute("aria-selected")).toBe("true");
    });
    expect(t2.getAttribute("aria-selected")).toBe("false");
    expect(
      t1.querySelector(".instance-tab-status .codicon-check"),
    ).toBeTruthy();
    expect(t2.querySelector(".instance-tab-status .codicon-check")).toBeNull();
    expect(screen.queryByRole("region", { name: "Workspace" })).toBeNull();

    fireEvent.click(t2);

    expect(await screen.findByText("Detached T2 transcript")).toBeTruthy();
    expect(t2.getAttribute("aria-selected")).toBe("true");
    const detailUrl = fetchMock.mock.calls
      .map(([input]) => String(input))
      .find((url) => url.includes("/api/session-detail"));
    expect(detailUrl).toContain("controllerEpoch=controller-1");
    expect(detailUrl).toContain("tabId=tab-2");
    expect(detailUrl).toContain("sessionId=session-2");
    expect(detailUrl).toContain("instanceId=instance-1");
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).includes("/api/session/load"),
      ),
    ).toBe(false);
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).includes("/api/ask-agent/session/load"),
      ),
    ).toBe(false);
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).includes("/api/relay/commands"),
      ),
    ).toBe(false);
  });

  it("restores the selected workspace and logical tab after remount", async () => {
    const groupedSnapshot = createGroupedSnapshot();
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
          ],
        });
      }
      if (url.includes("/api/ask-agent/session")) {
        return jsonResponse(createAskAgentSessionResponse());
      }
      if (url.includes("/api/ui-state")) return jsonResponse(groupedSnapshot);
      if (url.includes("/api/session-detail")) {
        return directSessionDetailResponse(
          groupedSnapshot,
          "Restored T2 transcript",
        );
      }
      if (url.includes("/api/models")) return jsonResponse({ models: [] });
      if (url.includes("/api/modes")) return jsonResponse({ modes: [] });
      if (url.includes("/api/slash-commands")) {
        return jsonResponse({ commands: [] });
      }
      if (url.includes("/api/sessions")) return jsonResponse({ sessions: [] });
      if (url.includes("/api/debug/refresh")) return jsonResponse({ ok: true });
      return jsonResponse({ error: "not_found" }, 404);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const props = {
      authToken: "test-token",
      currentInstanceId: "instance-1",
      workspaceName: "Workspace",
      routeByInstance: true,
      dataPlaneMode: "off" as const,
    };

    render(h(BrowserGatewayApp, props));
    await selectWorkspaceTab();
    fireEvent.click(
      await screen.findByRole("tab", { name: /T2.*Detached chat/ }),
    );
    await screen.findByText("Restored T2 transcript");

    cleanup();
    MockEventSource.instances = [];
    render(h(BrowserGatewayApp, props));

    const workspaceTab = await screen.findByRole("tab", { name: /Workspace/ });
    const logicalTab = await screen.findByRole("tab", {
      name: /T2.*Detached chat/,
    });
    await screen.findByText("Restored T2 transcript");
    expect(workspaceTab.getAttribute("aria-selected")).toBe("true");
    expect(logicalTab.getAttribute("aria-selected")).toBe("true");
    expect(MockEventSource.instances.at(-1)?.url).toContain(
      "instanceId=instance-1",
    );
  });

  it("discards a stale restored logical tab identity", async () => {
    const groupedSnapshot = createGroupedSnapshot();
    const fallbackFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes("/api/ui-state")) {
          return jsonResponse(groupedSnapshot);
        }
        return fallbackFetch(input, init);
      },
    );
    window.sessionStorage.setItem(
      "agentlink.browserGateway.selection.v1",
      JSON.stringify({
        kind: "workspace",
        instanceId: "instance-1",
        logical: {
          instanceId: "instance-1",
          controllerEpoch: "stale-controller",
          tabId: "tab-2",
          sessionId: "session-2",
        },
      }),
    );

    render(
      h(BrowserGatewayApp, {
        authToken: "test-token",
        currentInstanceId: "instance-1",
        workspaceName: "Workspace",
        routeByInstance: true,
        dataPlaneMode: "off",
      }),
    );

    await waitFor(() => {
      const canonicalTab = screen.getByRole("tab", {
        name: /T1.*Foreground chat.*Workspace/,
      });
      expect(canonicalTab.getAttribute("aria-selected")).toBe("true");
      expect(
        JSON.parse(
          window.sessionStorage.getItem(
            "agentlink.browserGateway.selection.v1",
          ) ?? "{}",
        ),
      ).toEqual({
        kind: "workspace",
        instanceId: "instance-1",
        workspacePath: "/workspace",
        logical: {
          instanceId: "instance-1",
          controllerEpoch: "controller-1",
          tabId: "tab-1",
          sessionId: "session-1",
        },
      });
    });
    expect(
      screen
        .getByRole("tab", { name: /T2.*Detached chat.*Workspace/ })
        .getAttribute("aria-selected"),
    ).toBe("false");
  });

  it("rebinds a restored logical tab to a replacement workspace activation", async () => {
    const groupedSnapshot = createGroupedSnapshot();
    const fallbackFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/api/ui-state")) {
          return jsonResponse(groupedSnapshot);
        }
        if (url.includes("/api/session-detail")) {
          return directSessionDetailResponse(
            groupedSnapshot,
            "Rebound T2 transcript",
          );
        }
        return fallbackFetch(input, init);
      },
    );
    window.sessionStorage.setItem(
      "agentlink.browserGateway.selection.v1",
      JSON.stringify({
        kind: "workspace",
        instanceId: "old-instance",
        workspacePath: "/workspace",
        logical: {
          instanceId: "old-instance",
          controllerEpoch: "controller-1",
          tabId: "tab-2",
          sessionId: "session-2",
        },
      }),
    );

    render(
      h(BrowserGatewayApp, {
        authToken: "test-token",
        currentInstanceId: "instance-1",
        workspaceName: "Workspace",
        routeByInstance: true,
        dataPlaneMode: "off",
      }),
    );

    await screen.findByText("Rebound T2 transcript");
    expect(
      screen
        .getByRole("tab", { name: /T2.*Detached chat.*Workspace/ })
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(
      JSON.parse(
        window.sessionStorage.getItem(
          "agentlink.browserGateway.selection.v1",
        ) ?? "{}",
      ),
    ).toEqual({
      kind: "workspace",
      instanceId: "instance-1",
      workspacePath: "/workspace",
      logical: {
        instanceId: "instance-1",
        controllerEpoch: "controller-1",
        tabId: "tab-2",
        sessionId: "session-2",
      },
    });
  });

  it("preserves a detached tab across a temporary workspace-less snapshot", async () => {
    const groupedSnapshot = createGroupedSnapshot();
    const fallbackFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/api/ui-state")) return jsonResponse(groupedSnapshot);
        if (url.includes("/api/session-detail")) {
          return directSessionDetailResponse(
            groupedSnapshot,
            "Durable T2 transcript",
          );
        }
        return fallbackFetch(input, init);
      },
    );

    render(
      h(BrowserGatewayApp, {
        authToken: "test-token",
        currentInstanceId: "instance-1",
        workspaceName: "Workspace",
        routeByInstance: true,
        dataPlaneMode: "off",
      }),
    );
    await selectWorkspaceTab();
    const logicalTab = await screen.findByRole("tab", {
      name: /T2.*Detached chat.*Workspace/,
    });
    fireEvent.click(logicalTab);
    await screen.findByText("Durable T2 transcript");

    const workspaceLessSnapshot = createSnapshot();
    workspaceLessSnapshot.session.chatWorkspace = null;
    await act(async () => {
      MockEventSource.instances.at(-1)?.emit("update", workspaceLessSnapshot);
    });

    const liveLogicalTab = screen.getByRole("tab", {
      name: /T2.*Detached chat.*Workspace/,
    });
    expect(liveLogicalTab.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("Durable T2 transcript")).toBeTruthy();
    const tabPanel = screen.getByRole("tabpanel");
    expect(
      document.getElementById(tabPanel.getAttribute("aria-labelledby")!),
    ).toBe(liveLogicalTab);
    expect(
      JSON.parse(
        window.sessionStorage.getItem(
          "agentlink.browserGateway.selection.v1",
        ) ?? "{}",
      ),
    ).toMatchObject({
      kind: "workspace",
      instanceId: "instance-1",
      workspacePath: "/workspace",
      logical: { tabId: "tab-2", sessionId: "session-2" },
    });
  });

  it("recovers from a stored instance that is no longer registered", async () => {
    window.sessionStorage.setItem(
      "agentlink.browserGateway.selection.v1",
      JSON.stringify({ kind: "workspace", instanceId: "dead-instance" }),
    );
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;

    render(
      h(BrowserGatewayApp, {
        authToken: "test-token",
        currentInstanceId: "instance-1",
        workspaceName: "Workspace",
        routeByInstance: true,
        dataPlaneMode: "off",
      }),
    );

    const workspaceTab = await screen.findByRole("tab", { name: /Workspace/ });
    await waitFor(() => {
      expect(workspaceTab.getAttribute("aria-selected")).toBe("true");
    });
    const instancesRequests = fetchMock.mock.calls
      .map(([input]) => String(input))
      .filter((url) => url.includes("/api/instances"));
    expect(instancesRequests.length).toBeGreaterThan(0);
    expect(
      instancesRequests.every((url) =>
        url.startsWith("/api/instances?instanceId="),
      ),
    ).toBe(true);
    expect(
      JSON.parse(
        window.sessionStorage.getItem(
          "agentlink.browserGateway.selection.v1",
        ) ?? "{}",
      ),
    ).toMatchObject({ kind: "workspace", instanceId: "instance-1" });
  });

  it("omits empty logical tabs and selects an available session", async () => {
    window.sessionStorage.setItem(
      "agentlink.browserGateway.selection.v1",
      JSON.stringify({
        kind: "workspace",
        instanceId: "instance-1",
        logical: {
          instanceId: "instance-1",
          controllerEpoch: "controller-1",
          tabId: "tab-1",
          sessionId: "stale-session",
        },
      }),
    );
    const snapshot = createGroupedSnapshot();
    snapshot.session.chatWorkspace = {
      controllerEpoch: "controller-1",
      focusedTabId: "tab-1",
      tabs: [
        {
          tabId: "tab-1",
          displayNumber: 1,
          label: "T1",
          sessionId: null,
          placement: "docked",
          title: undefined,
          status: "idle",
          busy: false,
        },
        {
          tabId: "tab-2",
          displayNumber: 2,
          label: "T2",
          sessionId: "session-1",
          placement: "docked",
          title: "Available chat",
          status: "completed",
          busy: false,
        },
      ],
    };
    const fallbackFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) =>
        String(input).includes("/api/ui-state")
          ? jsonResponse(snapshot)
          : fallbackFetch(input, init),
    ) as unknown as typeof fetch;

    render(
      h(BrowserGatewayApp, {
        authToken: "test-token",
        currentInstanceId: "instance-1",
        workspaceName: "Workspace",
        routeByInstance: true,
      }),
    );

    const availableTab = await screen.findByRole("tab", {
      name: /T2.*Available chat.*Workspace/,
    });
    expect(screen.queryByRole("tab", { name: /Empty chat/ })).toBeNull();
    await waitFor(() => {
      expect(availableTab.getAttribute("aria-selected")).toBe("true");
    });
    expect(
      getInstanceTabs().filter((tab) => tab.textContent?.includes("T1")),
    ).toEqual([]);
  });

  it("falls back to the workspace tab when every logical tab is empty", async () => {
    const snapshot = createGroupedSnapshot();
    const workspace = snapshot.session.chatWorkspace!;
    const selectedTab = workspace.tabs[0];
    workspace.tabs = [
      selectedTab,
      {
        ...workspace.tabs[1],
        sessionId: null,
        title: undefined,
        status: "idle",
        busy: false,
      },
    ];
    const fallbackFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) =>
        String(input).includes("/api/ui-state")
          ? jsonResponse(snapshot)
          : fallbackFetch(input, init),
    ) as unknown as typeof fetch;

    render(
      h(BrowserGatewayApp, {
        authToken: "test-token",
        currentInstanceId: "instance-1",
        workspaceName: "Workspace",
        routeByInstance: true,
      }),
    );

    const logicalTab = await screen.findByRole("tab", {
      name: /T1.*Foreground chat.*Workspace/,
    });
    fireEvent.click(logicalTab);
    await waitFor(() => {
      expect(logicalTab.getAttribute("aria-selected")).toBe("true");
    });

    workspace.tabs = workspace.tabs.map((tab) => ({
      ...tab,
      sessionId: null,
      title: undefined,
    }));
    await act(async () => {
      MockEventSource.instances
        .at(-1)
        ?.addEventListener.mock.calls.find(
          ([eventName]) => eventName === "snapshot",
        )?.[1]?.({ data: JSON.stringify(snapshot) });
    });

    const workspaceTab = await screen.findByRole("tab", { name: /^Workspace/ });
    await waitFor(() => {
      expect(workspaceTab.getAttribute("aria-selected")).toBe("true");
      expect(
        document
          .getElementById("browser-instance-panel")
          ?.getAttribute("aria-labelledby"),
      ).toBe("instance-tab-instance-1");
    });
    expect(screen.queryByRole("tab", { name: /Empty chat/ })).toBeNull();
  });

  it("hydrates every advertised workspace and renders adjacent tinted logical tabs", async () => {
    const workspaceSnapshot = createGroupedSnapshot();
    const workerSnapshot = createGroupedSnapshot();
    workerSnapshot.session.foreground.sessionId = "worker-session-1";
    workerSnapshot.session.foreground.title = "Worker foreground";
    workerSnapshot.session.chatWorkspace = {
      controllerEpoch: "worker-controller-1",
      focusedTabId: "worker-tab-1",
      tabs: [
        {
          tabId: "worker-tab-1",
          displayNumber: 1,
          label: "T1",
          sessionId: "worker-session-1",
          placement: "docked",
          title: "Worker foreground",
          status: "completed",
          busy: false,
        },
        {
          tabId: "worker-tab-2",
          displayNumber: 2,
          label: "T2",
          sessionId: "worker-session-2",
          placement: "docked",
          title: "Worker detached",
          status: "idle",
          busy: false,
        },
      ],
    };
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
              status: { kind: "idle", label: "Idle" },
            },
          ],
        });
      }
      if (url.includes("/api/ask-agent/session")) {
        return jsonResponse(createAskAgentSessionResponse());
      }
      if (url.includes("/api/ui-state")) {
        return jsonResponse(
          url.includes("instanceId=instance-2")
            ? workerSnapshot
            : workspaceSnapshot,
        );
      }
      if (url.includes("/api/models")) return jsonResponse({ models: [] });
      if (url.includes("/api/modes")) return jsonResponse({ modes: [] });
      if (url.includes("/api/slash-commands")) {
        return jsonResponse({ commands: [] });
      }
      if (url.includes("/api/sessions")) return jsonResponse({ sessions: [] });
      if (url.includes("/api/debug/refresh")) return jsonResponse({ ok: true });
      return jsonResponse({ error: "not_found" }, 404);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { container } = render(
      h(BrowserGatewayApp, {
        authToken: "test-token",
        currentInstanceId: "instance-1",
        workspaceName: "Workspace",
        routeByInstance: true,
      }),
    );

    const workerT1 = await screen.findByRole("tab", {
      name: /T1.*Worker foreground/,
    });
    const workerT2 = await screen.findByRole("tab", {
      name: /T2.*Worker detached/,
    });
    const workspaceT1 = await screen.findByRole("tab", {
      name: /T1.*Foreground chat/,
    });
    const workspaceT2 = await screen.findByRole("tab", {
      name: /T2.*Detached chat/,
    });

    const tabs = getInstanceTabs();
    expect(tabs).toEqual([
      screen.getByRole("tab", { name: /Ask Agent/ }),
      workerT1,
      workerT2,
      workspaceT1,
      workspaceT2,
    ]);
    expect(container.querySelector(".browser-instance-group")).toBeNull();
    expect(container.querySelector(".browser-instance-group-label")).toBeNull();
    expect(workerT1.style.getPropertyValue("--instance-group-color")).toBe(
      workerT2.style.getPropertyValue("--instance-group-color"),
    );
    expect(workspaceT1.style.getPropertyValue("--instance-group-color")).toBe(
      workspaceT2.style.getPropertyValue("--instance-group-color"),
    );
    expect(workerT1.style.getPropertyValue("--instance-group-color")).not.toBe(
      workspaceT1.style.getPropertyValue("--instance-group-color"),
    );
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).includes("/api/ui-state?instanceId=instance-2"),
      ),
    ).toBe(true);
  });

  it("refreshes detached session detail after accepted rapid sends", async () => {
    const groupedSnapshot = createGroupedSnapshot();
    let detailRequestCount = 0;
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
          ],
        });
      }
      if (url.includes("/api/ask-agent/session")) {
        return jsonResponse(createAskAgentSessionResponse());
      }
      if (url.includes("/api/ui-state")) return jsonResponse(groupedSnapshot);
      if (url.includes("/api/session-detail")) {
        detailRequestCount += 1;
        return directSessionDetailResponse(
          groupedSnapshot,
          detailRequestCount === 1
            ? "Detached before sends"
            : "Detached after rapid sends",
        );
      }
      if (url.includes("/api/send")) return jsonResponse({ ok: true });
      if (url.includes("/api/models")) return jsonResponse({ models: [] });
      if (url.includes("/api/modes")) return jsonResponse({ modes: [] });
      if (url.includes("/api/slash-commands")) {
        return jsonResponse({ commands: [] });
      }
      if (url.includes("/api/sessions")) return jsonResponse({ sessions: [] });
      if (url.includes("/api/debug/refresh")) {
        return jsonResponse({ ok: true });
      }
      return jsonResponse({ error: "not_found" }, 404);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    render(
      h(BrowserGatewayApp, {
        authToken: "test-token",
        currentInstanceId: "instance-1",
        workspaceName: "Workspace",
        routeByInstance: true,
      }),
    );

    await selectWorkspaceTab();
    fireEvent.click(
      await screen.findByRole("tab", { name: /T2.*Detached chat/ }),
    );
    await screen.findByText("Detached before sends");

    const send = screen.getByTestId("trigger-send");
    fireEvent.click(send);
    fireEvent.click(send);

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.filter(([input]) =>
          String(input).includes("/api/send"),
        ),
      ).toHaveLength(2);
      expect(detailRequestCount).toBeGreaterThanOrEqual(2);
      expect(screen.getByText("Detached after rapid sends")).toBeTruthy();
    });
    expect(
      screen
        .getByRole("tab", { name: /T2.*Detached chat/ })
        .getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("ignores detached detail resolved after another logical tab becomes active", async () => {
    const groupedSnapshot = createGroupedSnapshot();
    let resolveDetail: ((response: Response) => void) | undefined;
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
          ],
        });
      }
      if (url.includes("/api/ask-agent/session")) {
        return jsonResponse(createAskAgentSessionResponse());
      }
      if (url.includes("/api/ui-state")) return jsonResponse(groupedSnapshot);
      if (url.includes("/api/session-detail")) {
        return new Promise<Response>((resolve) => {
          resolveDetail = resolve;
        });
      }
      if (url.includes("/api/models")) return jsonResponse({ models: [] });
      if (url.includes("/api/modes")) return jsonResponse({ modes: [] });
      if (url.includes("/api/slash-commands")) {
        return jsonResponse({ commands: [] });
      }
      if (url.includes("/api/sessions")) return jsonResponse({ sessions: [] });
      if (url.includes("/api/debug/refresh")) return jsonResponse({ ok: true });
      return jsonResponse({ error: "not_found" }, 404);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    render(
      h(BrowserGatewayApp, {
        authToken: "test-token",
        currentInstanceId: "instance-1",
        workspaceName: "Workspace",
        routeByInstance: true,
      }),
    );

    await selectWorkspaceTab();
    const t1 = await screen.findByRole("tab", {
      name: /T1.*Foreground chat/,
    });
    const t2 = screen.getByRole("tab", { name: /T2.*Detached chat/ });
    const tablist = screen.getByRole("tablist", { name: "Instances" });
    expect(tablist.contains(t1)).toBe(true);
    expect(tablist.contains(t2)).toBe(true);
    fireEvent.click(t2);
    await waitFor(() => expect(resolveDetail).toBeTypeOf("function"));

    fireEvent.click(t1);
    await screen.findByText("Foreground T1 transcript");
    await act(async () => {
      resolveDetail?.(
        directSessionDetailResponse(
          groupedSnapshot,
          "Late detached transcript",
        ),
      );
      await Promise.resolve();
    });

    expect(t1.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("Foreground T1 transcript")).toBeTruthy();
    expect(screen.queryByText("Late detached transcript")).toBeNull();
  });

  it("keeps Ask Agent pinned when no routed VS Code instances are available", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
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
        if (pathname === "/api/ask-agent/autonomous-memory/health") {
          return jsonResponse({
            ok: true,
            health: {
              status: "ready",
              retrieval: "lexical-only",
              crud: true,
              dedupe: true,
              conflict: true,
              auditUndo: true,
              recordCount: 2,
              activeRecordCount: 1,
              auditEventCount: 3,
            },
          });
        }
        if (pathname === "/api/ask-agent/autonomous-memory/activity") {
          return jsonResponse({
            ok: true,
            events: [
              {
                id: "audit-browser-memory-reversible",
                operation: "remember",
                disposition: "created",
                occurredAt: "2026-07-25T12:00:00.000Z",
                actor: {
                  source: "foreground_agent",
                  observedAt: "2026-07-25T12:00:00.000Z",
                  evidence: "User stated a durable preference.",
                },
                scope: { kind: "global", id: "agentlink-user" },
                changes: [
                  {
                    recordId: "memory-browser-1",
                    before: null,
                    after: { statement: "Prefer concise browser answers." },
                  },
                ],
              },
            ],
            health: {
              status: "ready",
              retrieval: "lexical-only",
              crud: true,
              dedupe: true,
              conflict: true,
              auditUndo: true,
              recordCount: 2,
              activeRecordCount: 1,
              auditEventCount: 3,
            },
          });
        }
        if (pathname === "/api/ask-agent/autonomous-memory/query") {
          return jsonResponse({
            ok: true,
            result: { records: [], total: 0 },
            health: {
              status: "ready",
              retrieval: "lexical-only",
              crud: true,
              dedupe: true,
              conflict: true,
              auditUndo: true,
              recordCount: 2,
              activeRecordCount: 1,
              auditEventCount: 3,
            },
          });
        }
        if (pathname === "/api/ask-agent/autonomous-memory/manage") {
          const input = JSON.parse(String(init?.body ?? "{}")) as {
            operation?: string;
            statement?: string;
          };
          const response = createAskAgentSessionResponse();
          const disposition =
            input.operation === "undo"
              ? "undone"
              : input.statement === "Keep browser answers concise"
                ? "rejected-sensitive"
                : "created";
          return jsonResponse({
            ok: true,
            result: {
              disposition,
              relatedRecords: [],
              auditEventId: "audit-browser-memory-1",
            },
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
            matchedPhrase:
              "Going forward, always ask me before switching modes.",
            suggestedScope: "global",
            suggestedTier: "memory",
            title: "Remember from Ask Agent",
            rationale:
              "Ask Agent detected a possible durable user preference for low-authority memory.",
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
                name: "memory",
                description:
                  "Inspect and manage autonomous low-authority memory",
                source: "builtin",
                builtin: true,
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
        if (url.includes("/api/ui-state"))
          return jsonResponse(createSnapshot());
        if (url.includes("/api/slash-commands"))
          return jsonResponse({ commands: [] });
        if (url.includes("/api/modes")) return jsonResponse({ modes: [] });
        if (url.includes("/api/models")) return jsonResponse({ models: [] });
        if (url.includes("/api/sessions"))
          return jsonResponse({ sessions: [] });
        if (url.includes("/api/debug/refresh"))
          return jsonResponse({ ok: true });
        return jsonResponse({ error: "not_found" }, 404);
      },
    );

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
      expect(screen.getByTestId("slash-command-count").textContent).toBe("6");
    });
    expect(screen.getByTestId("slash-command-names").textContent).toBe(
      "remember,memory,mcp,mcp-config,mcp-refresh,skill:skill-writing",
    );
    expect(screen.getByTestId("thinking-visible").textContent).toBe("true");
    expect(screen.queryByText("Model credentials needed")).toBeNull();
    expect(screen.queryByText("Model list may be stale")).toBeNull();
    expect(screen.queryByText("No pending file diffs.")).toBeNull();
    expect(screen.queryByTestId("browser-diff-viewer")).toBeNull();

    const sendCallsBeforeMemory = fetchMock.mock.calls.filter(([input]) =>
      String(input).includes("/api/ask-agent/send"),
    ).length;
    fireEvent.click(screen.getByTestId("trigger-memory"));
    await screen.findByText("No matching memory records.");
    await waitFor(() => {
      const queryCall = fetchMock.mock.calls.find(
        ([input]) => String(input) === "/api/ask-agent/autonomous-memory/query",
      );
      expect(queryCall).toBeTruthy();
      expect(JSON.parse(String(queryCall?.[1]?.body ?? "{}"))).toEqual({
        limit: 100,
      });
    });
    expect(
      fetchMock.mock.calls.filter(([input]) =>
        String(input).includes("/api/ask-agent/send"),
      ),
    ).toHaveLength(sendCallsBeforeMemory);
    fireEvent.click(screen.getByTitle("Close memory manager"));
    await waitFor(() => {
      expect(screen.queryByText("No matching memory records.")).toBeNull();
    });

    fireEvent.click(screen.getByTitle("Ask Agent Memory"));
    await screen.findByText("Derived Ask Agent memory");
    await screen.findByText("Autonomous memory");
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
    expect(screen.getByText("Recent global activity")).toBeTruthy();
    expect(screen.getByText("remember · created")).toBeTruthy();
    expect(screen.getByText("Prefer concise browser answers.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([input]) =>
            String(input) === "/api/ask-agent/autonomous-memory/health",
        ),
      ).toBe(true);
      expect(
        fetchMock.mock.calls.some(
          ([input]) =>
            String(input) === "/api/ask-agent/autonomous-memory/activity",
        ),
      ).toBe(true);
    });
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([input, init]) => {
          if (String(input) !== "/api/ask-agent/autonomous-memory/manage") {
            return false;
          }
          const body = JSON.parse(String(init?.body ?? "{}")) as {
            operation?: string;
            source_evidence?: string;
            undo_audit_event_id?: string;
            scope?: string;
          };
          return (
            body.operation === "undo" &&
            body.source_evidence ===
              "Browser user selected undo from memory activity." &&
            body.undo_audit_event_id === "audit-browser-memory-reversible" &&
            body.scope === undefined
          );
        }),
      ).toBe(true);
    });
    expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
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

    fireEvent.click(screen.getByTitle("New Chat"));
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
    fireEvent.click(screen.getByText("Remember"));
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([input, init]) => {
          if (String(input) !== "/api/ask-agent/autonomous-memory/manage") {
            return false;
          }
          const body = JSON.parse(
            String((init as RequestInit).body ?? "{}"),
          ) as {
            nudgeId?: string;
            operation?: string;
            source_evidence?: string;
            kind?: string;
            statement?: string;
            scope?: string;
          };
          return (
            body.nudgeId === "ask-agent-memory-nudge-1" &&
            body.operation === "remember" &&
            body.kind === "preference" &&
            body.statement ===
              "Going forward, always ask me before switching modes." &&
            body.source_evidence ===
              "Ask Agent detected a possible durable user preference for low-authority memory." &&
            body.scope === undefined
          );
        }),
      ).toBe(true);
    });
    await waitFor(() => {
      expect(screen.queryByText("Possible durable memory")).toBeNull();
    });

    fireEvent.click(screen.getByTestId("trigger-remember"));
    await screen.findByText("Memory not changed (rejected-sensitive).");
    expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([input, init]) => {
          if (String(input) !== "/api/ask-agent/autonomous-memory/manage") {
            return false;
          }
          const body = JSON.parse(
            String((init as RequestInit).body ?? "{}"),
          ) as {
            operation?: string;
            source_evidence?: string;
            kind?: string;
            statement?: string;
            nudgeId?: string;
          };
          return (
            body.operation === "remember" &&
            body.kind === "preference" &&
            body.statement === "Keep browser answers concise" &&
            body.source_evidence ===
              "User invoked /remember in Browser Ask Agent." &&
            body.nudgeId === undefined
          );
        }),
      ).toBe(true);
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
        id: "ask-agent-assistant-web",
        role: "assistant",
        content: "Web-backed answer.",
        timestamp: 202,
        blocks: [
          {
            type: "tool_call",
            id: "search-export",
            name: "web_search",
            inputJson: JSON.stringify({ query: "AgentLink export" }),
            result: JSON.stringify({
              backend: "provider",
              provider: "openai-codex",
              operation: "search",
              input: { query: "AgentLink export" },
              activities: [
                {
                  id: "hosted-search-export",
                  kind: "search",
                  status: "completed",
                  backend: "provider",
                  query: "AgentLink export",
                },
              ],
              content: "Web-backed answer.",
              citations: [
                {
                  url: "https://example.com/export-source",
                  title: "Export source",
                  citedText: "Web-backed",
                  startIndex: 0,
                  endIndex: 10,
                },
              ],
            }),
            complete: true,
          },
        ],
      },
      {
        id: "ask-agent-assistant-export-error",
        role: "assistant",
        content: "",
        timestamp: 203,
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
        "Ask Agent detected a possible durable user preference for low-authority memory.",
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
    expect(exportedText).toContain("Web-backed answer.");
    expect(exportedText).toContain("[Tool: web_search]");
    expect(exportedText).toContain("Input:");
    expect(exportedText).toContain('"query":"AgentLink export"');
    expect(exportedText).toContain("Result:");
    expect(exportedText).toContain("https://example.com/export-source");
    expect(exportedText).toContain("Export source");
    expect(exportedText).not.toContain("PRIVATE_REPLAY_SENTINEL");
    expect(exportedText).not.toContain("providerReplay");
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

  it("waits for a new Ask Agent session before routing its first message", async () => {
    const fallbackFetch = globalThis.fetch;
    let resolveNewSession: ((response: Response) => void) | undefined;
    const sendBodies: Array<{ sessionId?: string; text?: string }> = [];
    const fetchMock = vi.fn(
      async (
        input: RequestInfo | URL,
        init?: RequestInit,
      ): Promise<Response> => {
        const pathname = String(input).split("?")[0];
        if (pathname === "/api/ask-agent/session/new") {
          return new Promise<Response>((resolve) => {
            resolveNewSession = resolve;
          });
        }
        if (pathname === "/api/ask-agent/send") {
          sendBodies.push(
            JSON.parse(String(init?.body ?? "{}")) as {
              sessionId?: string;
              text?: string;
            },
          );
          const response = createAskAgentSessionResponse();
          response.snapshot.session.foreground.sessionId =
            "browser-gateway:ask-agent:next";
          return jsonResponse({ ok: true, snapshot: response.snapshot });
        }
        return fallbackFetch(input, init);
      },
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    render(
      h(BrowserGatewayApp, {
        authToken: "test-token",
        currentInstanceId: "instance-1",
        workspaceName: "Workspace",
        routeByInstance: true,
      }),
    );

    fireEvent.click(await screen.findByTitle("New Chat"));
    await waitFor(() => expect(resolveNewSession).toBeTypeOf("function"));

    fireEvent.click(screen.getByTestId("trigger-send"));
    await screen.findByText("Waiting for new session…");
    expect(sendBodies).toEqual([]);

    const next = createAskAgentSessionResponse();
    next.snapshot.session.foreground.sessionId =
      "browser-gateway:ask-agent:next";
    await act(async () => {
      resolveNewSession?.(jsonResponse({ ok: true, snapshot: next.snapshot }));
    });

    await waitFor(() => {
      expect(sendBodies).toHaveLength(1);
      expect(sendBodies[0]).toMatchObject({
        sessionId: "browser-gateway:ask-agent:next",
        text: "Ship it",
      });
    });
  });

  it("keeps routing to the new Ask Agent session after a stale snapshot renders", async () => {
    const fallbackFetch = globalThis.fetch;
    let resolveNewSession: ((response: Response) => void) | undefined;
    const sendBodies: Array<{ sessionId?: string; text?: string }> = [];
    const fetchMock = vi.fn(
      async (
        input: RequestInfo | URL,
        init?: RequestInit,
      ): Promise<Response> => {
        const pathname = String(input).split("?")[0];
        if (pathname === "/api/ask-agent/session/new") {
          return new Promise<Response>((resolve) => {
            resolveNewSession = resolve;
          });
        }
        if (pathname === "/api/ask-agent/send") {
          sendBodies.push(
            JSON.parse(String(init?.body ?? "{}")) as {
              sessionId?: string;
              text?: string;
            },
          );
          const response = createAskAgentSessionResponse();
          response.snapshot.session.foreground.sessionId =
            "browser-gateway:ask-agent:next";
          return jsonResponse({ ok: true, snapshot: response.snapshot });
        }
        return fallbackFetch(input, init);
      },
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    render(
      h(BrowserGatewayApp, {
        authToken: "test-token",
        currentInstanceId: "instance-1",
        workspaceName: "Workspace",
        routeByInstance: true,
      }),
    );

    fireEvent.click(await screen.findByTitle("New Chat"));
    await waitFor(() => expect(resolveNewSession).toBeTypeOf("function"));

    const next = createAskAgentSessionResponse();
    next.snapshot.session.foreground.sessionId =
      "browser-gateway:ask-agent:next";
    await act(async () => {
      resolveNewSession?.(jsonResponse({ ok: true, snapshot: next.snapshot }));
    });

    const stale = createAskAgentSessionResponse().snapshot;
    await act(async () => {
      MockEventSource.instances
        .at(-1)
        ?.addEventListener.mock.calls.find(
          ([eventName]) => eventName === "snapshot",
        )?.[1]?.({ data: JSON.stringify(stale) });
    });

    fireEvent.click(screen.getByTestId("trigger-send"));

    await waitFor(() => {
      expect(sendBodies).toHaveLength(1);
      expect(sendBodies[0]).toMatchObject({
        sessionId: "browser-gateway:ask-agent:next",
        text: "Ship it",
      });
    });

    fireEvent.click(screen.getByTitle("New Chat"));
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.filter(
          ([input]) =>
            String(input).split("?")[0] === "/api/ask-agent/session/new",
        ),
      ).toHaveLength(2);
    });
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

  it("isolates same-id approval cards and ignores late snapshots from the previous tab", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const firstSnapshot = createSnapshot();
    firstSnapshot.ui.approval = {
      kind: "command",
      id: "shared-approval-id",
      command: "echo workspace",
    };
    const secondSnapshot = createSnapshot();
    secondSnapshot.ui.approval = {
      kind: "command",
      id: "shared-approval-id",
      command: "echo worker",
    };
    let resolveLateWorkspace: ((response: Response) => void) | undefined;
    let workspaceRequests = 0;

    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
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
              status: { kind: "awaiting_approval", label: "Approval" },
            },
            {
              instanceId: "instance-2",
              workspaceName: "Worker",
              workspacePath: "/worker",
              url: "http://127.0.0.1:3334",
              status: { kind: "awaiting_approval", label: "Approval" },
            },
          ],
        });
      }
      if (url.includes("/api/ask-agent/session")) {
        return jsonResponse(createAskAgentSessionResponse());
      }
      if (url.includes("/api/ui-state?instanceId=instance-1")) {
        workspaceRequests += 1;
        if (workspaceRequests <= 2) return jsonResponse(firstSnapshot);
        return await new Promise<Response>((resolve) => {
          resolveLateWorkspace = resolve;
        });
      }
      if (url.includes("/api/ui-state?instanceId=instance-2")) {
        return jsonResponse(secondSnapshot);
      }
      return jsonResponse({});
    });

    render(
      h(BrowserGatewayApp, {
        authToken: "token",
        currentInstanceId: "instance-1",
        workspaceName: "Workspace",
        routeByInstance: true,
      }),
    );

    await selectWorkspaceTab();
    const workspaceInput = await screen.findByDisplayValue("echo workspace");
    fireEvent.input(workspaceInput, { target: { value: "edited workspace" } });
    fireEvent.click(await screen.findByRole("tab", { name: /^Worker/ }));

    expect(await screen.findByDisplayValue("echo worker")).toBeTruthy();
    expect(screen.queryByDisplayValue("edited workspace")).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: /^Workspace/ }));
    fireEvent.click(screen.getByRole("tab", { name: /^Worker/ }));
    resolveLateWorkspace?.(jsonResponse(firstSnapshot));

    await waitFor(() => {
      expect(screen.getByDisplayValue("echo worker")).toBeTruthy();
      expect(screen.queryByDisplayValue("echo workspace")).toBeNull();
    });
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

    await waitFor(() => {
      expect(MockEventSource.instances.at(-1)?.url).toBe(
        "/api/ask-agent/events",
      );
    });

    const workspaceTab = await selectWorkspaceTab();
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

  it("paints the tab switch immediately and restores cached content after paint", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const workspaceSnapshot = createSnapshot();
    workspaceSnapshot.session.foreground.projectedMessages = [
      {
        id: "workspace-msg-1",
        role: "assistant",
        content: "Cached workspace transcript",
        timestamp: 1,
        blocks: [{ type: "text", text: "Cached workspace transcript" }],
      },
    ];
    let workspaceRequests = 0;

    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
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
          ],
        });
      }
      if (url.includes("/api/ask-agent/session")) {
        return jsonResponse(createAskAgentSessionResponse());
      }
      if (url.includes("/api/ui-state")) {
        workspaceRequests += 1;
        if (workspaceRequests === 1) return jsonResponse(workspaceSnapshot);
        // Never resolve again: restored content must come from the tab cache.
        return await new Promise<Response>(() => undefined);
      }
      return jsonResponse({});
    });

    render(
      h(BrowserGatewayApp, {
        authToken: "token",
        currentInstanceId: "instance-1",
        workspaceName: "Workspace",
        routeByInstance: true,
      }),
    );

    await selectWorkspaceTab();
    await screen.findByText("Cached workspace transcript");

    const askAgentTab = screen.getByRole("tab", { name: /Ask Agent/ });
    fireEvent.click(askAgentTab);
    expect(askAgentTab.getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByText("Cached workspace transcript")).toBeNull();

    const workspaceTab = screen.getByRole("tab", { name: /Workspace/ });
    fireEvent.click(workspaceTab);
    // The switch itself commits synchronously with a lightweight loading
    // state; the cached transcript mounts a paint later.
    expect(workspaceTab.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("Loading session…")).toBeTruthy();
    expect(await screen.findByText("Cached workspace transcript")).toBeTruthy();
  });

  it("does not restore cached content for a tab advertising newer activity", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const workspaceSnapshot = createSnapshot();
    workspaceSnapshot.session.foreground.projectedMessages = [
      {
        id: "workspace-msg-1",
        role: "assistant",
        content: "Stale cached workspace transcript",
        timestamp: 1,
        blocks: [{ type: "text", text: "Stale cached workspace transcript" }],
      },
    ];
    let workspaceRequests = 0;

    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
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
              status: { kind: "awaiting_approval", label: "Approval" },
            },
          ],
        });
      }
      if (url.includes("/api/ask-agent/session")) {
        return jsonResponse(createAskAgentSessionResponse());
      }
      if (url.includes("/api/ui-state")) {
        workspaceRequests += 1;
        if (workspaceRequests === 1) return jsonResponse(workspaceSnapshot);
        return await new Promise<Response>(() => undefined);
      }
      return jsonResponse({});
    });

    render(
      h(BrowserGatewayApp, {
        authToken: "token",
        currentInstanceId: "instance-1",
        workspaceName: "Workspace",
        routeByInstance: true,
      }),
    );

    const workspaceTab = await selectWorkspaceTab();
    expect(screen.queryByText("Stale cached workspace transcript")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: /Ask Agent/ }));
    expect(screen.queryByText("Stale cached workspace transcript")).toBeNull();

    fireEvent.click(workspaceTab);
    expect(workspaceTab.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("Loading session…")).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByText("Stale cached workspace transcript")).toBeNull();
  });

  it("coalesces rapid realtime stream updates to the latest payload", async () => {
    vi.useFakeTimers();
    try {
      render(
        h(BrowserGatewayApp, {
          authToken: "token",
          currentInstanceId: "instance-1",
          workspaceName: "Workspace",
          routeByInstance: true,
        }),
      );

      expect(MockEventSource.instances.length).toBeGreaterThan(0);
      const source = MockEventSource.instances.at(-1)!;
      const updateListener = source.addEventListener.mock.calls.find(
        ([eventName]) => eventName === "update",
      )?.[1];
      expect(updateListener).toBeTruthy();

      const buildUpdate = (text: string, id: string): string => {
        const snapshot = createAskAgentSessionResponse().snapshot;
        snapshot.session.foreground.projectedMessages = [
          {
            id,
            role: "assistant",
            content: text,
            timestamp: 1,
            blocks: [{ type: "text", text }],
          },
        ];
        return JSON.stringify(snapshot);
      };

      updateListener?.({ data: buildUpdate("First update", "update-1") });
      await act(async () => {});
      expect(screen.getByText("First update")).toBeTruthy();

      updateListener?.({ data: buildUpdate("Second update", "update-2") });
      updateListener?.({ data: buildUpdate("Third update", "update-3") });
      await act(async () => {});
      // Both land inside the coalesce window; nothing applies immediately.
      expect(screen.getByText("First update")).toBeTruthy();
      expect(screen.queryByText("Second update")).toBeNull();
      expect(screen.queryByText("Third update")).toBeNull();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });
      // Only the newest payload is parsed and rendered.
      expect(screen.getByText("Third update")).toBeTruthy();
      expect(screen.queryByText("Second update")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
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
      fireEvent.click(oldWorkspaceTab);
      await waitFor(() => {
        expect(oldWorkspaceTab.getAttribute("aria-selected")).toBe("true");
      });

      instanceGeneration = "new";
      await vi.advanceTimersByTimeAsync(5_000);

      await waitFor(() => {
        const tabs = screen.getAllByRole("tab", { name: /Workspace/ });
        expect(tabs).toHaveLength(1);
        expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
        expect(tabs[0]?.textContent).not.toContain("Disconnected");
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("selects an exact approval diff and hides ambiguous path matches", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const snapshot = createSnapshot();
    snapshot.ui.approval = {
      kind: "write",
      id: "diff-current",
      filePath: "src/file.ts",
      writeOperation: "modify",
    };
    snapshot.diffs = [
      {
        requestId: "diff-old",
        filePath: "src/file.ts",
        operation: "modify",
        originalPreview: "before old",
        proposedPreview: "after old",
        outsideWorkspace: false,
        createdAt: 1,
      },
      {
        requestId: "diff-current",
        filePath: "src/file.ts",
        operation: "modify",
        originalPreview: "before current",
        proposedPreview: "after current",
        outsideWorkspace: false,
        createdAt: 2,
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

    await selectWorkspaceTab();
    await waitFor(() => {
      expect(
        screen.getByRole("tablist", { name: "Pending file diffs" }),
      ).toBeTruthy();
    });
    expect(screen.getByRole("tab", { name: /src\/file\.ts/ })).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByTestId("browser-diff-viewer").textContent).toBe(
        "diff-current",
      );
    });
    expect(screen.queryByText("No pending file diffs.")).toBeNull();

    snapshot.ui.approval = {
      kind: "write",
      id: "diff-missing",
      filePath: "src/file.ts",
      writeOperation: "modify",
    };
    await act(async () => {
      MockEventSource.instances
        .at(-1)
        ?.addEventListener.mock.calls.find(
          ([eventName]) => eventName === "snapshot",
        )?.[1]?.({ data: JSON.stringify(snapshot) });
    });

    await waitFor(() => {
      expect(screen.queryByTestId("browser-diff-viewer")).toBeNull();
      expect(
        screen.queryByRole("tablist", { name: "Pending file diffs" }),
      ).toBeNull();
      expect(
        document.getElementById("browser-instance-panel")?.className,
      ).toContain("browser-layout-chat-only");
    });
  });

  it("hides retained diffs when the selected tab has no write approval", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const snapshot = createSnapshot();
    snapshot.session.foreground.agentWriteApproval = "session";
    snapshot.diffs = [
      {
        requestId: "diff-other-session",
        filePath: "src/other-session.ts",
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
              status: { kind: "working", label: "Working" },
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

    await selectWorkspaceTab();
    await waitFor(() => {
      expect(document.getElementById("browser-instance-panel")).toBeTruthy();
    });
    expect(screen.queryByTestId("browser-diff-viewer")).toBeNull();
    expect(
      screen.queryByRole("tablist", { name: "Pending file diffs" }),
    ).toBeNull();
    expect(
      document.getElementById("browser-instance-panel")?.className,
    ).toContain("browser-layout-chat-only");
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

    await selectWorkspaceTab();
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

  it("renders Ask Agent image approvals in the Ask Agent tab and submits to the Ask Agent approval endpoint", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const snapshot = createSnapshot();
    snapshot.ui.approval = {
      kind: "write",
      id: "ask-agent-generate-image-1",
      filePath: "Generate 1 image?",
      writeOperation: "modify",
      detail:
        "Generation prompt:\nCreate an avatar\nImages: 1\nBilling: ChatGPT/Codex OAuth quota (active account)\nOutput: Ask Agent chat display only (no files will be written)",
    };
    const askAgentResponse = createAskAgentSessionResponse(snapshot);
    const approvalRequests: Array<{ url: string; body: unknown }> = [];

    fetchMock.mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/api/ask-agent/session")) {
          return jsonResponse(askAgentResponse);
        }
        if (url.includes("/api/ask-agent/approval")) {
          approvalRequests.push({
            url,
            body: init?.body ? JSON.parse(String(init.body)) : null,
          });
          const next = createAskAgentSessionResponse(createSnapshot());
          return jsonResponse({ ok: true, snapshot: next.snapshot });
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
            ],
          });
        }
        if (url.includes("/api/slash-commands"))
          return jsonResponse({ commands: [] });
        if (url.includes("/api/modes")) return jsonResponse({ modes: [] });
        if (url.includes("/api/models")) return jsonResponse({ models: [] });
        if (url.includes("/api/sessions"))
          return jsonResponse({ sessions: [] });
        if (url.includes("/api/debug/refresh"))
          return jsonResponse({ ok: true });
        return jsonResponse({ ok: true });
      },
    );

    render(
      h(BrowserGatewayApp, {
        authToken: "test-token",
        currentInstanceId: "instance-1",
        workspaceName: "Workspace",
        routeByInstance: true,
      }),
    );

    await waitFor(() => {
      expect(screen.getByText(/Create an avatar/)).toBeTruthy();
      expect(
        screen.getByText(
          /Ask Agent chat display only \(no files will be written\)/,
        ),
      ).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));

    await waitFor(() => {
      expect(approvalRequests).toHaveLength(1);
    });
    expect(approvalRequests[0]).toEqual({
      url: "/api/ask-agent/approval",
      body: expect.objectContaining({
        id: "ask-agent-generate-image-1",
        decision: "accept",
      }),
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

    await selectWorkspaceTab();
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

    await selectWorkspaceTab();
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

    await selectWorkspaceTab();
    fireEvent.click(await screen.findByRole("button", { name: /View diff/ }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Back to chat/ })).toBeTruthy();
    });
    expect(screen.getByTestId("browser-diff-viewer").textContent).toBe(
      "diff-1",
    );
  });

  it("keeps unmatched review content hidden when approvals and questions are pending", async () => {
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

    await selectWorkspaceTab();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Accept" })).toBeTruthy();
    });
    expect(screen.queryByText("Pending question")).toBeNull();
    expect(
      screen.queryByRole("tablist", { name: "Pending file diffs" }),
    ).toBeNull();
    expect(screen.queryByTestId("browser-diff-viewer")).toBeNull();
    expect(
      document.getElementById("browser-instance-panel")?.className,
    ).toContain("browser-layout-chat-only");
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

    await selectWorkspaceTab();
    const workerTab = await screen.findByRole("tab", { name: /Worker/ });

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

    const workspaceTab = await selectWorkspaceTab();
    const workerTab = await screen.findByRole("tab", { name: /Worker/ });

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

    await selectWorkspaceTab();

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

  it("aborts an in-flight HTTP snapshot when SSE delivers newer state", async () => {
    vi.useFakeTimers();
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    let snapshotSignal: AbortSignal | undefined;

    fetchMock.mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/api/ui-state")) {
          snapshotSignal = init?.signal as AbortSignal | undefined;
          return await new Promise<Response>(() => undefined);
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
        return jsonResponse({});
      },
    );

    try {
      render(
        h(BrowserGatewayApp, {
          authToken: "test-token",
          currentInstanceId: "instance-1",
          workspaceName: "Workspace",
          routeByInstance: true,
        }),
      );
      await selectWorkspaceTab();
      await vi.advanceTimersByTimeAsync(500);
      expect(snapshotSignal?.aborted).toBe(false);

      const streamedSnapshot = createSnapshot();
      streamedSnapshot.session.foreground.status = "streaming";
      streamedSnapshot.session.foreground.streaming = true;
      streamedSnapshot.session.foreground.statusOverride = "SSE is newest";
      await act(async () => {
        MockEventSource.instances
          .at(-1)
          ?.addEventListener.mock.calls.find(
            ([eventName]) => eventName === "snapshot",
          )?.[1]?.({ data: JSON.stringify(streamedSnapshot) });
      });

      expect(snapshotSignal?.aborted).toBe(true);
      expect(screen.getByText("SSE is newest")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("refreshes an open background transcript when a later snapshot reports tool progress", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const startedSnapshot = createSnapshot();
    startedSnapshot.background = [
      {
        id: "bg-web-1",
        task: "Research AgentLink",
        status: "streaming",
        lifecycle: "running",
        phase: "responding",
        lastProgressAt: 1,
      },
    ];
    let webCompleted = false;

    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/ui-state")) return jsonResponse(startedSnapshot);
      if (url.includes("/api/background/open-transcript")) {
        return jsonResponse({
          ok: true,
          transcript: {
            sessionId: "bg-web-1",
            task: "Research AgentLink",
            messages: [
              {
                role: "assistant",
                content: [
                  {
                    type: "tool_use",
                    id: "search-live",
                    name: "web_search",
                    input: { query: "AgentLink live transcript" },
                  },
                ],
              },
              ...(webCompleted
                ? [
                    {
                      role: "user",
                      content: [
                        {
                          type: "tool_result",
                          tool_use_id: "search-live",
                          content: JSON.stringify({
                            results: [
                              {
                                url: "https://example.com/live-source",
                                title: "Live source",
                              },
                            ],
                          }),
                        },
                      ],
                    },
                    {
                      role: "assistant",
                      content: [
                        {
                          type: "text",
                          text: "The search completed.",
                        },
                      ],
                    },
                  ]
                : []),
            ],
          },
        });
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

    await selectWorkspaceTab();
    fireEvent.click(await screen.findByText(/Agent Fleet/));
    fireEvent.click(
      await screen.findByTitle("Open this agent's full transcript"),
    );
    await screen.findByText("web_search");

    const transcriptRequestsBeforeClose = fetchMock.mock.calls.filter(
      ([input]) => String(input).includes("/api/background/open-transcript"),
    ).length;
    fireEvent.click(screen.getByTitle("Close"));
    fireEvent.click(
      await screen.findByTitle("Open this agent's full transcript"),
    );
    expect(await screen.findByText("web_search")).toBeTruthy();
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.filter(([input]) =>
          String(input).includes("/api/background/open-transcript"),
        ).length,
      ).toBeGreaterThan(transcriptRequestsBeforeClose);
    });
    expect(screen.getByText("web_search")).toBeTruthy();

    const unrelatedSnapshot = createSnapshot();
    unrelatedSnapshot.session.foreground.statusOverride = "Unrelated update";
    unrelatedSnapshot.background = [{ ...startedSnapshot.background[0]! }];
    const emitSnapshot = async (nextSnapshot: TestSnapshot) => {
      await act(async () => {
        MockEventSource.instances
          .at(-1)
          ?.addEventListener.mock.calls.find(
            ([eventName]) => eventName === "snapshot",
          )?.[1]?.({ data: JSON.stringify(nextSnapshot) });
      });
    };

    await emitSnapshot(unrelatedSnapshot);
    const transcriptRequestsBeforeUpdate = fetchMock.mock.calls.filter(
      ([input]) => String(input).includes("/api/background/open-transcript"),
    ).length;

    await emitSnapshot({
      ...unrelatedSnapshot,
      background: [{ ...startedSnapshot.background[0]! }],
    });

    expect(
      fetchMock.mock.calls.filter(([input]) =>
        String(input).includes("/api/background/open-transcript"),
      ),
    ).toHaveLength(transcriptRequestsBeforeUpdate);

    const completedSnapshot = createSnapshot();
    completedSnapshot.background = [
      {
        ...startedSnapshot.background[0]!,
        status: "idle",
        lifecycle: "completed",
        phase: "completed",
        lastProgressAt: 2,
        completedAt: 2,
      },
    ];
    webCompleted = true;

    await emitSnapshot(completedSnapshot);

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.filter(([input]) =>
          String(input).includes("/api/background/open-transcript"),
        ).length,
      ).toBeGreaterThan(transcriptRequestsBeforeUpdate);
    });
    expect(await screen.findByText("The search completed.")).toBeTruthy();
  });

  it("falls back to snapshot polling when the realtime stream errors", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const recoveredSnapshot = createSnapshot();
    recoveredSnapshot.session.foreground.status = "streaming";
    recoveredSnapshot.session.foreground.streaming = true;
    recoveredSnapshot.session.foreground.statusOverride =
      "Recovered via fallback";
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/ui-state")) {
        return jsonResponse(recoveredSnapshot);
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

    await selectWorkspaceTab();
    await waitFor(() => {
      expect(MockEventSource.instances.length).toBeGreaterThan(0);
    });

    MockEventSource.instances.at(-1)?.onerror?.();

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

    await selectWorkspaceTab();
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
      expect(screen.getByText("Configuration sources")).toBeTruthy();
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

    await selectWorkspaceTab();
    await waitFor(() => {
      expect(screen.getByTitle("New Chat")).toBeTruthy();
    });

    fireEvent.click(screen.getByTitle("New Chat"));

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

  it("forwards managed-network approval evidence and the allow-once decision", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const approvalSnapshot = createSnapshot();
    approvalSnapshot.ui.approval = {
      kind: "network",
      id: "network-approval-1",
      managedNetwork: {
        requestId: "network-1",
        sessionId: "session-1",
        auditId: "audit-1",
        terminalId: "sandbox-1",
        commandId: "command-1",
        generation: 1,
        command: "npm view example version",
        cwd: "/workspace",
        host: "registry.npmjs.org",
        protocol: "https",
        port: 443,
        address: "104.16.24.34",
        family: 4,
        dnsAnswers: [
          { address: "104.16.24.34", family: 4 },
          { address: "104.16.25.34", family: 4 },
        ],
        destinationClass: "public",
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

    await selectWorkspaceTab();
    expect(
      await screen.findByText("https://registry.npmjs.org:443"),
    ).toBeTruthy();
    expect(screen.getByText("104.16.24.34 (IPv4)")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Allow Once" }));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([input]) =>
          String(input).includes("/api/approval"),
        ),
      ).toBe(true);
    });

    const approvalCall = fetchMock.mock.calls.find(([input]) =>
      String(input).includes("/api/approval"),
    );
    expect(JSON.parse(String(approvalCall?.[1]?.body))).toMatchObject({
      id: "network-approval-1",
      approvalKind: "network",
      decision: "allow-once",
    });
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

    await selectWorkspaceTab();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Accept" })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: "Accept" }));

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
    });

    const approvalCall = fetchMock.mock.calls.find(([input]) =>
      String(input).includes("/api/approval"),
    );
    expect(approvalCall).toBeDefined();
    expect(JSON.parse(String(approvalCall?.[1]?.body))).toMatchObject({
      id: "approval-1",
      approvalKind: "write",
      decision: "accept",
    });
  });
});
