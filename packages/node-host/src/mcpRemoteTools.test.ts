import { beforeEach, describe, expect, it, vi } from "vitest";

import { createNodeHostMcpRemoteTools } from "./mcpRemoteTools.js";

const mocks = vi.hoisted(() => ({
  listTools: vi.fn(async () => ({
    tools: [
      {
        name: "search",
        description: "Search remote records.",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
          additionalProperties: false,
        },
      },
    ],
  })),
  callTool: vi.fn<
    (
      params: unknown,
      metadata: unknown,
      options: unknown,
    ) => Promise<{ content: Array<{ type: "text"; text: string }> }>
  >(async () => ({ content: [{ type: "text", text: "found" }] })),
  close: vi.fn(async () => {}),
  fetches: [] as Array<typeof globalThis.fetch>,
  connectWithRequest: false,
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class MockClient {
    async connect(transport: {
      fetch?: typeof globalThis.fetch;
      url?: URL;
    }): Promise<void> {
      if (transport.fetch && transport.url) {
        await transport.fetch(
          mocks.connectWithRequest
            ? new Request(transport.url, {
                method: "POST",
                headers: { "x-fixture": "request-input" },
                body: "fixture-body",
              })
            : transport.url.href,
        );
      }
    }
    async listTools() {
      return mocks.listTools();
    }
    async callTool(params: unknown, metadata: unknown, options: unknown) {
      return mocks.callTool(params, metadata, options);
    }
    async close() {
      return mocks.close();
    }
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: class MockSseTransport {
    fetch: typeof globalThis.fetch;
    url: URL;
    constructor(url: URL, options: { fetch: typeof globalThis.fetch }) {
      this.fetch = options.fetch;
      this.url = url;
      mocks.fetches.push(options.fetch);
    }
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class MockHttpTransport {
    fetch: typeof globalThis.fetch;
    url: URL;
    constructor(url: URL, options: { fetch: typeof globalThis.fetch }) {
      this.fetch = options.fetch;
      this.url = url;
      mocks.fetches.push(options.fetch);
    }
  },
}));

const principal = { tenantId: "tenant-a", subjectId: "subject-a" };

describe("node host remote MCP tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetches.length = 0;
    mocks.connectWithRequest = false;
  });

  it("resolves only the current principal's HTTPS server and authorizes every transport use", async () => {
    const resolveServers = vi.fn(async () => [
      {
        id: "records",
        transport: "streamable-http" as const,
        url: "https://mcp.example.test/mcp",
      },
      {
        id: "insecure",
        transport: "sse" as const,
        url: "http://127.0.0.1:9999/mcp",
      },
    ]);
    const authorizeNetwork = vi.fn(async () => true);
    const resolver = createNodeHostMcpRemoteTools({
      resolveServers,
      authorizeNetwork,
      fetch: vi.fn(async () => new Response("ok")),
    });
    const resolved = await resolver({
      principal,
      sessionId: "session-a",
      turnId: "turn-a",
    });
    const remote = resolved.find(
      (candidate) => candidate.definition.name === "records__search",
    );
    if (!remote) throw new Error("Missing tool records__search");

    expect(resolveServers).toHaveBeenCalledWith({
      principal,
      sessionId: "session-a",
      turnId: "turn-a",
    });
    expect(authorizeNetwork).toHaveBeenCalledWith(
      expect.objectContaining({
        principal,
        sessionId: "session-a",
        turnId: "turn-a",
        serverId: "records",
        url: expect.objectContaining({
          protocol: "https:",
          href: "https://mcp.example.test/mcp",
        }),
      }),
    );
    expect(resolved).toHaveLength(1);
    expect(resolved).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ definition: { name: "insecure__search" } }),
      ]),
    );
    expect(remote).toMatchObject({
      effect: "external",
      authorization: "required",
      definition: { name: "records__search" },
    });

    await expect(
      remote.execute(
        { query: "recent" },
        {
          principal,
          sessionId: "session-a",
          turnId: "turn-a",
          model: {
            model: { providerId: "fixture", modelId: "fixture-model" },
            source: "runtime",
          },
          signal: undefined,
        },
      ),
    ).resolves.toMatchObject({
      modelContent: "found",
      displayContent: { server: "records", tool: "search" },
    });
    expect(mocks.callTool).toHaveBeenCalledWith(
      { name: "search", arguments: { query: "recent" } },
      undefined,
      expect.objectContaining({ timeout: 60_000 }),
    );
    const callOptions = mocks.callTool.mock.calls[0]?.[2];
    expect(callOptions).not.toHaveProperty("onprogress");
    expect(callOptions).not.toHaveProperty("resetTimeoutOnProgress");
    expect(authorizeNetwork).toHaveBeenCalledTimes(2);
  });

  it("keeps discovery scoped to its principal and rejects mismatched invocation context", async () => {
    const authorizeNetwork = vi.fn(async () => true);
    const resolver = createNodeHostMcpRemoteTools<{
      tenantId: string;
      subjectId: string;
      realm: string;
    }>({
      resolveServers: ({ principal: requestPrincipal }) =>
        requestPrincipal.subjectId === "subject-a"
          ? [
              {
                id: "records",
                transport: "streamable-http",
                url: "https://mcp.example.test/mcp",
              } as const,
            ]
          : [],
      authorizeNetwork,
      principalEquals: (left, right) =>
        left.tenantId === right.tenantId &&
        left.subjectId === right.subjectId &&
        left.realm === right.realm,
      fetch: vi.fn(async () => new Response("ok")),
    });
    const resolved = await resolver({
      principal: { ...principal, realm: "live" },
      sessionId: "session-a",
      turnId: "turn-a",
    });
    const remote = resolved.find(
      (candidate) => candidate.definition.name === "records__search",
    );
    if (!remote) throw new Error("Missing tool records__search");

    await expect(
      remote.execute(
        { query: "recent" },
        {
          principal: { ...principal, realm: "demo" },
          sessionId: "session-a",
          turnId: "turn-a",
          model: {
            model: { providerId: "fixture", modelId: "fixture-model" },
            source: "runtime",
          },
          signal: undefined,
        },
      ),
    ).resolves.toMatchObject({
      isError: true,
      modelContent: expect.stringContaining("mcp_remote_turn_mismatch"),
    });
    expect(mocks.callTool).not.toHaveBeenCalled();
    expect(authorizeNetwork).toHaveBeenCalledTimes(1);
  });

  it("preserves Request input while forcing redirect refusal", async () => {
    mocks.connectWithRequest = true;
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response("ok"),
    );
    const resolver = createNodeHostMcpRemoteTools({
      resolveServers: () => [
        {
          id: "records",
          transport: "streamable-http",
          url: "https://mcp.example.test/mcp",
        },
      ],
      authorizeNetwork: () => true,
      fetch,
    });

    await expect(
      resolver({ principal, sessionId: "session-a", turnId: "turn-a" }),
    ).resolves.toHaveLength(1);
    const forwarded = fetch.mock.calls[0]?.[0];
    expect(forwarded).toBeInstanceOf(Request);
    if (!(forwarded instanceof Request)) throw new Error("Expected Request");
    expect(forwarded.method).toBe("POST");
    expect(forwarded.headers.get("x-fixture")).toBe("request-input");
    await expect(forwarded.text()).resolves.toBe("fixture-body");
    expect(forwarded.redirect).toBe("error");
  });

  it("rejects returned redirects, invalid timeouts, and no-op catalog entries", async () => {
    const redirectFetch = vi.fn(async () =>
      Response.redirect("https://other.example.test/mcp", 302),
    );
    const redirected = createNodeHostMcpRemoteTools({
      resolveServers: () => [
        {
          id: "records",
          transport: "streamable-http",
          url: "https://mcp.example.test/mcp",
        },
      ],
      authorizeNetwork: () => true,
      fetch: redirectFetch,
    });
    await expect(
      redirected({ principal, sessionId: "session-a", turnId: "turn-a" }),
    ).resolves.toEqual([]);
    expect(redirectFetch).toHaveBeenCalledTimes(1);

    const authorizeNetwork = vi.fn(() => true);
    const invalidTimeout = createNodeHostMcpRemoteTools({
      resolveServers: () => [
        {
          id: "records",
          transport: "streamable-http",
          url: "https://mcp.example.test/mcp",
          timeoutMs: 60_001,
        },
      ],
      authorizeNetwork,
    });
    await expect(
      invalidTimeout({ principal, sessionId: "session-a", turnId: "turn-a" }),
    ).resolves.toEqual([]);
    expect(authorizeNetwork).not.toHaveBeenCalled();

    mocks.listTools.mockResolvedValueOnce({
      tools: [
        {
          name: "invalid name",
          description: "Invalid fixture tool.",
          inputSchema: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
            additionalProperties: false,
          },
        },
        {
          name: "valid",
          description: "Valid fixture tool.",
          inputSchema: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
            additionalProperties: false,
          },
        },
      ],
    });
    const bounded = createNodeHostMcpRemoteTools({
      resolveServers: () => [
        {
          id: "records",
          transport: "streamable-http",
          url: "https://mcp.example.test/mcp",
        },
      ],
      authorizeNetwork: () => true,
      maxToolsPerServer: 1,
      fetch: vi.fn(async () => new Response("ok")),
    });
    await expect(
      bounded({ principal, sessionId: "session-a", turnId: "turn-a" }),
    ).resolves.toEqual([
      expect.objectContaining({
        definition: expect.objectContaining({ name: "records__valid" }),
      }),
    ]);
  });

  it("fails closed when the host denies the remote destination", async () => {
    const resolver = createNodeHostMcpRemoteTools({
      resolveServers: () => [
        {
          id: "records",
          transport: "sse",
          url: "https://mcp.example.test/events",
        },
      ],
      authorizeNetwork: () => false,
      fetch: vi.fn(async () => new Response("ok")),
    });

    await expect(
      resolver({ principal, sessionId: "session-a", turnId: "turn-a" }),
    ).resolves.toEqual([]);
    expect(mocks.listTools).not.toHaveBeenCalled();
  });
});
