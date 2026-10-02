/** @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/preact";

import { DesktopMcpManager } from "./DesktopMcpManager";
import type { McpConfigBatchMutation } from "@agentlink/protocol/mcp-manager";
import { act } from "preact/test-utils";
import { h } from "preact";

vi.mock("./components/LazyMcpManagerPanel", async () => {
  const { h } = await import("preact");
  return {
    LazyMcpManagerPanel: ({
      snapshot,
      onServerAction,
      onMutateConfig,
      onOpenRawConfig,
    }: {
      snapshot: { version: number };
      onServerAction: (name: string, action: string) => void;
      onMutateConfig?: (mutation: McpConfigBatchMutation) => Promise<unknown>;
      onOpenRawConfig?: (scope: "global" | "ask-agent-global") => void;
    }) =>
      h(
        "div",
        null,
        h("span", null, `Snapshot ${snapshot.version}`),
        h(
          "button",
          { onClick: () => onServerAction("linear", "connect") },
          "Connect linear",
        ),
        h(
          "button",
          { onClick: () => onServerAction("linear", "reconnect") },
          "Reconnect linear",
        ),
        h(
          "button",
          {
            onClick: () =>
              void onMutateConfig?.({
                operationId: "mutation-id",
                profile: "main",
                scope: "global",
                expectedRevision: "revision",
                operations: [],
              }),
          },
          "Mutate config",
        ),
        h(
          "button",
          { onClick: () => onOpenRawConfig?.("ask-agent-global") },
          "Open raw config",
        ),
      ),
  };
});

const configSnapshot = {
  profile: "ask-agent",
  version: 1,
  sources: [],
  entries: [],
  statusInfos: [],
  capabilities: {
    canEditConfig: false,
    canOpenRawConfig: false,
    canReconnect: true,
    canReauthenticate: true,
    canDisable: false,
    canUseProjectConfig: false,
  },
};

afterEach(() => {
  cleanup();
  delete window.agentlinkDesktopShell;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Desktop MCP manager recovery actions", () => {
  it.each([
    ["Connect linear", "connect"],
    ["Reconnect linear", "reconnect"],
  ])("starts the dedicated operation in %s mode", async (label, mode) => {
    const setTimeout = vi.spyOn(window, "setTimeout");
    const setMcpOperation = vi.fn();
    const bridge = { setMcpOperation } as never;
    window.agentlinkDesktopShell = bridge;
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/ask-agent/mcp-config") {
          return new Response(JSON.stringify({ ok: true, configSnapshot }));
        }
        if (
          url === "/api/ask-agent/mcp-manager-operation" &&
          init?.method === "POST"
        ) {
          return new Response(JSON.stringify({ ok: true }));
        }
        if (url.startsWith("/api/ask-agent/mcp-manager-operation?")) {
          const operationId = new URL(url, "http://localhost").searchParams.get(
            "operationId",
          );
          return new Response(
            JSON.stringify({
              ok: true,
              operation: {
                id: operationId,
                serverName: "linear",
                status: "completed",
                approval: null,
              },
            }),
          );
        }
        return new Response(JSON.stringify({ ok: true, configSnapshot }));
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      h(DesktopMcpManager, {
        authToken: "desktop-token",
        initialRequest: { view: "status", action: "open" },
        onClose: vi.fn(),
      }),
    );

    await screen.findByRole("button", { name: label });
    fireEvent.click(screen.getByRole("button", { name: label }));
    await waitFor(() => {
      const start = fetchMock.mock.calls.find(
        ([url, init]) =>
          String(url) === "/api/ask-agent/mcp-manager-operation" &&
          init?.method === "POST",
      );
      expect(start).toBeTruthy();
      expect(JSON.parse(String(start?.[1]?.body))).toMatchObject({
        action: "start",
        serverName: "linear",
        mode,
      });
      const startIndex = fetchMock.mock.calls.indexOf(start!);
      expect(setMcpOperation.mock.invocationCallOrder[0]).toBeLessThan(
        fetchMock.mock.invocationCallOrder[startIndex],
      );
    });
    await screen.findByText("Operation completed");
    const dismiss = screen.getByRole("button", {
      name: "Dismiss MCP operation",
    });
    if (mode === "connect") {
      fireEvent.click(dismiss);
    } else {
      await waitFor(() =>
        expect(setTimeout.mock.calls.some(([, delay]) => delay === 5_000)).toBe(
          true,
        ),
      );
      const scheduled = setTimeout.mock.calls.find(
        ([, delay]) => delay === 5_000,
      );
      await act(async () => {
        (scheduled![0] as () => void)();
      });
    }
    expect(screen.queryByText("Operation completed")).toBeNull();
    expect(
      screen.queryByRole("region", { name: "MCP server operation" }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: label }));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(
          ([, init]) =>
            init?.method === "POST" &&
            JSON.parse(String(init.body)).action === "start",
        ),
      ).toHaveLength(2),
    );
  });

  it("forwards configuration mutations and opens raw config through Desktop IPC", async () => {
    const openMcpConfig = vi.fn(async () => undefined);
    window.agentlinkDesktopShell = { openMcpConfig } as never;
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "POST") {
          return new Response(
            JSON.stringify({
              operationId: "mutation-id",
              ok: true,
              configSaved: true,
              errors: [],
              configSnapshot,
            }),
          );
        }
        return new Response(JSON.stringify({ ok: true, configSnapshot }));
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    render(
      h(DesktopMcpManager, {
        authToken: "desktop-token",
        initialRequest: { view: "config", action: "open" },
        onClose: vi.fn(),
      }),
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Mutate config" }),
    );
    await waitFor(() => {
      const mutation = fetchMock.mock.calls.find(
        ([url, init]) =>
          String(url) === "/api/ask-agent/mcp-config/server" &&
          init?.method === "POST",
      );
      expect(mutation).toBeTruthy();
      expect(JSON.parse(String(mutation?.[1]?.body))).toMatchObject({
        profile: "ask-agent",
        scope: "ask-agent-global",
        target: {
          kind: "native",
          profile: "ask-agent",
          scope: "ask-agent-global",
        },
      });
    });
    fireEvent.click(screen.getByRole("button", { name: "Open raw config" }));
    await waitFor(() =>
      expect(openMcpConfig).toHaveBeenCalledExactlyOnceWith("ask-agent-global"),
    );
  });

  it("does not let an older status request overwrite a saved configuration snapshot", async () => {
    let finishInitial!: (response: Response) => void;
    const initialResponse = new Promise<Response>((resolve) => {
      finishInitial = resolve;
    });
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "POST") {
          return new Response(
            JSON.stringify({
              operationId: "mutation-id",
              ok: true,
              configSaved: true,
              errors: [],
              configSnapshot: { ...configSnapshot, version: 2 },
            }),
          );
        }
        return initialResponse;
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    render(
      h(DesktopMcpManager, {
        authToken: "desktop-token",
        initialRequest: { view: "config", action: "open" },
        onClose: vi.fn(),
      }),
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "Mutate config" }));
    await screen.findByText("Snapshot 2");
    await act(async () => {
      finishInitial(new Response(JSON.stringify({ ok: true, configSnapshot })));
      await initialResponse;
    });
    expect(screen.getByText("Snapshot 2")).toBeTruthy();
  });

  it("retains native cancellation ownership when closed before start responds", async () => {
    const setMcpOperation = vi.fn();
    window.agentlinkDesktopShell = { setMcpOperation } as never;
    let finishStart!: (response: Response) => void;
    const startResponse = new Promise<Response>((resolve) => {
      finishStart = resolve;
    });
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "POST") {
          const body = JSON.parse(String(init.body));
          if (body.action === "start") return startResponse;
          return new Response(JSON.stringify({ ok: true }));
        }
        return new Response(JSON.stringify({ ok: true, configSnapshot }));
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const view = render(
      h(DesktopMcpManager, {
        authToken: "desktop-token",
        initialRequest: { view: "status", action: "open" },
        onClose: vi.fn(),
      }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Connect linear" }),
    );
    expect(setMcpOperation).toHaveBeenCalledWith(expect.any(String));
    const operationId = setMcpOperation.mock.calls[0][0];
    view.rerender(
      h(DesktopMcpManager, {
        authToken: "desktop-token",
        initialRequest: { view: "status", action: "open" },
        onClose: vi.fn(),
      }),
    );
    view.unmount();
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([, init]) =>
            init?.method === "POST" &&
            JSON.parse(String(init.body)).action === "cancel" &&
            JSON.parse(String(init.body)).operationId === operationId,
        ),
      ).toBe(true),
    );
    expect(setMcpOperation).not.toHaveBeenCalledWith(null);
    finishStart(new Response(JSON.stringify({ ok: true })));
  });
});
