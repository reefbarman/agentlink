/** @vitest-environment jsdom */

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

vi.mock("../../agent/webview/components/InputArea", () => ({
  InputArea: ({
    onExecuteBuiltinCommand,
    onSend,
    submitOnEnter,
  }: {
    onExecuteBuiltinCommand?: (name: string, args: string) => void;
    onSend?: (text: string, attachments: string[]) => void;
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
          "data-testid": "trigger-send",
          onClick: () => onSend?.("Ship it", []),
        },
        "Trigger send",
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

type TestSnapshot = {
  ui: {
    approval: null | ApprovalRequest;
    question: null | {
      id: string;
      questions: Array<{
        id: string;
        type: "yes_no";
        question: string;
        recommended?: boolean;
      }>;
    };
    recentEvents: never[];
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
      projectedMessages: unknown[];
      statusOverride: string | null;
      thinkingEnabled: boolean;
      lastInputTokens: number;
      lastOutputTokens: number;
      lastCacheReadTokens: number;
      estimatedTotalUsed: number;
      messageQueue: never[];
      questionRequest: null | {
        id: string;
        questions: Array<{
          id: string;
          type: "yes_no";
          question: string;
          recommended?: boolean;
        }>;
      };
      detectedQuestion: null;
      todos: never[];
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

function createSnapshot(): TestSnapshot {
  return {
    ui: {
      approval: null,
      question: null,
      recentEvents: [],
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

  addEventListener = vi.fn();
  removeEventListener = vi.fn();
  close = vi.fn();

  constructor(_url: string) {
    MockEventSource.instances.push(this);
  }
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

    // The default mock lists Workspace before Worker; tabs sort by name.
    await waitFor(() => {
      expect(screen.getAllByRole("tab")).toHaveLength(2);
    });
    const tabs = screen.getAllByRole("tab");
    expect(tabs[0]?.textContent).toContain("Worker");
    expect(tabs[1]?.textContent).toContain("Workspace");
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
      questions: [
        {
          id: "q1",
          type: "yes_no",
          question: "Continue?",
          recommended: true,
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
      expect(
        fetchMock.mock.calls.some(([input]) =>
          String(input).includes("/api/sessions?instanceId=instance-1"),
        ),
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
      expect(screen.getByText("MCP Servers")).toBeTruthy();
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
