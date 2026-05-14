/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/preact";

import { BrowserGatewayApp } from "./BrowserGatewayApp";
import { h } from "preact";

vi.mock("@xterm/xterm", () => ({
  Terminal: class MockTerminal {
    loadAddon() {}
    open() {}
    reset() {}
    write(_text: string, callback?: () => void) {
      callback?.();
    }
    scrollToBottom() {}
    dispose() {}
  },
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class MockFitAddon {
    fit() {}
  },
}));

vi.mock("../../agent/webview/components/InputArea", () => ({
  InputArea: ({
    onExecuteBuiltinCommand,
  }: {
    onExecuteBuiltinCommand?: (name: string, args: string) => void;
  }) =>
    h(
      "button",
      {
        type: "button",
        "data-testid": "trigger-mcp",
        onClick: () => onExecuteBuiltinCommand?.("mcp", ""),
      },
      "Trigger /mcp",
    ),
}));

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function createSnapshot() {
  return {
    ui: {
      approval: null,
      question: null,
      recentEvents: [],
      mcpStatusInfos: [],
    },
    session: {
      terminals: [],
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
        statusOverride: null,
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

class MockEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;

  addEventListener = vi.fn();
  removeEventListener = vi.fn();
  close = vi.fn();

  constructor(_url: string) {}
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
    installLocalStorageMock();
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

  it("renders instance tabs with status and switches selected instance", async () => {
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
    const workerTab = screen.getByRole("tab", { name: /Worker/ });
    expect(workspaceTab.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("Idle")).toBeTruthy();
    expect(screen.getByText("Working")).toBeTruthy();

    fireEvent.click(workerTab);

    await waitFor(() => {
      expect(workerTab.getAttribute("aria-selected")).toBe("true");
    });
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
