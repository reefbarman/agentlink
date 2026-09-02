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
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class MockClient {
    async connect(transport: {
      fetch?: typeof globalThis.fetch;
    }): Promise<void> {
      if (transport.fetch)
        await transport.fetch("https://mcp.example.test/mcp");
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
    constructor(_url: URL, options: { fetch: typeof globalThis.fetch }) {
      this.fetch = options.fetch;
      mocks.fetches.push(options.fetch);
    }
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class MockHttpTransport {
    fetch: typeof globalThis.fetch;
    constructor(_url: URL, options: { fetch: typeof globalThis.fetch }) {
      this.fetch = options.fetch;
      mocks.fetches.push(options.fetch);
    }
  },
}));

const principal = { tenantId: "tenant-a", subjectId: "subject-a" };

async function tool(
  resolver: ReturnType<typeof createNodeHostMcpRemoteTools>,
  name: string,
) {
  const tools = await resolver({
    principal,
    sessionId: "session-a",
    turnId: "turn-a",
  });
  const resolved = tools.find(
    (candidate) => candidate.definition.name === name,
  );
  if (!resolved) throw new Error(`Missing tool ${name}`);
  return resolved;
}

describe("node host remote MCP tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetches.length = 0;
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
    const remote = await tool(resolver, "records__search");

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
        url: expect.objectContaining({ protocol: "https:" }),
      }),
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
    expect(authorizeNetwork).toHaveBeenCalledTimes(2);
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
