import { afterEach, describe, expect, it, vi } from "vitest";

import { McpClientHub } from "./McpClientHub.js";

// Real MCP SDK client and Streamable HTTP transport; only the network fetch is
// replaced with an in-memory MCP server so a server restart can be simulated.
const mocks = vi.hoisted(() => ({ fetch: vi.fn<typeof fetch>() }));

vi.mock("../util/httpDispatcher.js", () => ({
  agentLinkLongPollingFetch: mocks.fetch,
}));

vi.mock("vscode", async () => {
  return vi.importActual<typeof import("../__mocks__/vscode.js")>(
    "../__mocks__/vscode.js",
  );
});

interface ObservedRequest {
  method: string;
  session: string | undefined;
}

function json(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

function fakeStreamableHttpServer() {
  const state = {
    session: undefined as string | undefined,
    sessionsCreated: 0,
    requests: [] as ObservedRequest[],
    toolCalls: 0,
  };
  mocks.fetch.mockImplementation(async (_input, init) => {
    const method = init?.method ?? "GET";
    const session =
      new Headers(init?.headers).get("mcp-session-id") ?? undefined;
    if (method === "GET") return new Response(null, { status: 405 });
    if (method === "DELETE") return new Response(null, { status: 200 });
    const body = JSON.parse(String(init?.body)) as {
      id?: number;
      method: string;
      params?: { protocolVersion?: string };
    };
    state.requests.push({ method: body.method, session });
    if (body.method === "initialize") {
      state.sessionsCreated += 1;
      state.session = `session-${state.sessionsCreated}`;
      return json(
        {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: body.params?.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "fixture", version: "1.0.0" },
          },
        },
        { "mcp-session-id": state.session },
      );
    }
    if (!session || session !== state.session) {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32001, message: "Session terminated" },
        }),
        { status: 404, headers: { "content-type": "application/json" } },
      );
    }
    if (body.id === undefined) return new Response(null, { status: 202 });
    switch (body.method) {
      case "tools/list":
        return json({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            tools: [{ name: "echo", inputSchema: { type: "object" } }],
          },
        });
      case "resources/list":
        return json({ jsonrpc: "2.0", id: body.id, result: { resources: [] } });
      case "prompts/list":
        return json({ jsonrpc: "2.0", id: body.id, result: { prompts: [] } });
      case "tools/call":
        state.toolCalls += 1;
        return json({
          jsonrpc: "2.0",
          id: body.id,
          result: { content: [{ type: "text", text: `ok-${state.session}` }] },
        });
      default:
        return json({
          jsonrpc: "2.0",
          id: body.id,
          error: { code: -32601, message: "Method not found" },
        });
    }
  });
  return {
    state,
    restart() {
      state.session = undefined;
    },
  };
}

const serverConfig = {
  name: "fixture",
  type: "streamable-http" as const,
  url: "https://mcp.example.test/mcp",
};

function initializeRequests(requests: readonly ObservedRequest[]) {
  return requests.filter((request) => request.method === "initialize");
}

async function waitForConnected(hub: McpClientHub, sessionsCreated: number) {
  await vi.waitFor(() => {
    expect(hub.getServerInfos()).toEqual([
      expect.objectContaining({ name: "fixture", status: "connected" }),
    ]);
  });
  expect(sessionsCreated).toBeGreaterThan(0);
}

describe("McpClientHub Streamable HTTP session recovery", () => {
  let hub: McpClientHub | undefined;

  afterEach(async () => {
    await hub?.disconnectAll();
    hub = undefined;
    mocks.fetch.mockReset();
  });

  it("starts a fresh session after the server forgets the old one, without replaying the call", async () => {
    const server = fakeStreamableHttpServer();
    hub = new McpClientHub();
    const logs: string[] = [];
    hub.onLog = (message) => logs.push(message);
    await hub.connect([serverConfig]);
    await waitForConnected(hub, server.state.sessionsCreated);

    await expect(hub.callTool("fixture__echo", {})).resolves.toMatchObject({
      content: [{ type: "text", text: "ok-session-1" }],
    });

    server.restart();
    const expired = await hub.callTool("fixture__echo", {});
    expect(expired).toMatchObject({
      isError: true,
      error: { kind: "mcp_session_expired" },
      data: { completionState: "unknown", retrySafe: false },
    });

    await vi.waitFor(() => expect(server.state.sessionsCreated).toBe(2));
    await waitForConnected(hub, server.state.sessionsCreated);

    // The fresh InitializeRequest must not carry the expired session ID.
    expect(initializeRequests(server.state.requests)).toEqual([
      { method: "initialize", session: undefined },
      { method: "initialize", session: undefined },
    ]);
    // The expired call was rejected by the server and never replayed.
    expect(server.state.toolCalls).toBe(1);

    await expect(hub.callTool("fixture__echo", {})).resolves.toMatchObject({
      content: [{ type: "text", text: "ok-session-2" }],
    });
    expect(server.state.toolCalls).toBe(2);
    expect(
      logs.some((line) => line.includes("reconnecting with a new session")),
    ).toBe(true);
    expect(JSON.stringify(logs)).not.toContain("session-1");
  });

  it("coalesces concurrent expired-session failures into one reconnect", async () => {
    const server = fakeStreamableHttpServer();
    hub = new McpClientHub();
    await hub.connect([serverConfig]);
    await waitForConnected(hub, server.state.sessionsCreated);

    server.restart();
    const results = await Promise.all([
      hub.callTool("fixture__echo", {}),
      hub.callTool("fixture__echo", {}),
      hub.callTool("fixture__echo", {}),
    ]);
    for (const result of results) {
      expect(result).toMatchObject({
        isError: true,
        error: { kind: "mcp_session_expired" },
      });
    }

    await waitForConnected(hub, server.state.sessionsCreated);
    await vi.waitFor(() => expect(server.state.sessionsCreated).toBe(2));
    // Give any duplicate reconnect a chance to surface before asserting.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(server.state.sessionsCreated).toBe(2);
    expect(server.state.toolCalls).toBe(0);
  });

  it("does not reconnect a server that was disconnected before recovery ran", async () => {
    const server = fakeStreamableHttpServer();
    hub = new McpClientHub();
    await hub.connect([serverConfig]);
    await waitForConnected(hub, server.state.sessionsCreated);

    server.restart();
    // The recovery log is emitted synchronously before the deferred
    // reconnect, so disconnecting here models a user disable/reload racing it.
    let disconnecting: Promise<void> | undefined;
    const activeHub = hub;
    activeHub.onLog = (message) => {
      if (message.includes("reconnecting with a new session")) {
        disconnecting = activeHub.disconnectAll();
      }
    };
    // Disconnecting closes the client synchronously, so the call may settle
    // as a closed connection instead; both report unknown completion.
    await expect(hub.callTool("fixture__echo", {})).resolves.toMatchObject({
      isError: true,
      data: { completionState: "unknown", retrySafe: false },
    });
    expect(disconnecting).toBeDefined();
    await disconnecting;
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(server.state.sessionsCreated).toBe(1);
    expect(hub.getServerInfos()).toEqual([]);
  });
});
