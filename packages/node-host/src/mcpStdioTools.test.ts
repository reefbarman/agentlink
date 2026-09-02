import { beforeEach, describe, expect, it, vi } from "vitest";

import { createNodeHostMcpStdioTools } from "./mcpStdioTools.js";

const mocks = vi.hoisted(() => ({
  listTools: vi.fn(async () => ({
    tools: [
      {
        name: "search",
        description: "Search local records.",
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
  launches: [] as Array<{
    command: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
    stderr?: string;
  }>,
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class MockClient {
    async connect(_transport: unknown): Promise<void> {}
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

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  DEFAULT_INHERITED_ENV_VARS: ["HOME", "PATH", "USER"],
  StdioClientTransport: class MockStdioClientTransport {
    constructor(options: (typeof mocks.launches)[number]) {
      mocks.launches.push(options);
    }
  },
}));

const principal = { tenantId: "tenant-a", subjectId: "subject-a" };
const server = {
  id: "records",
  command: "/opt/mcp/records-server",
  args: ["--safe"],
  cwd: "/var/empty/mcp",
  env: { MCP_TOKEN: "current-principal-token", PATH: "/opt/mcp/bin" },
};

async function tool(
  resolver: ReturnType<typeof createNodeHostMcpStdioTools>,
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

function context(overrides = {}) {
  return {
    principal,
    sessionId: "session-a",
    turnId: "turn-a",
    model: {
      model: { providerId: "fixture", modelId: "fixture-model" },
      source: "runtime" as const,
    },
    signal: undefined,
    ...overrides,
  };
}

describe("node host stdio MCP tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.launches.length = 0;
  });

  it("requires an authorized explicit launch for discovery and invocation", async () => {
    const resolveServers = vi.fn(async () => [server]);
    const authorizeLaunch = vi.fn(async () => true);
    const resolver = createNodeHostMcpStdioTools({
      resolveServers,
      authorizeLaunch,
    });
    const stdio = await tool(resolver, "records__search");

    expect(resolveServers).toHaveBeenCalledWith({
      principal,
      sessionId: "session-a",
      turnId: "turn-a",
    });
    expect(authorizeLaunch).toHaveBeenCalledWith({
      principal,
      sessionId: "session-a",
      turnId: "turn-a",
      server,
    });
    expect(stdio).toMatchObject({
      effect: "external",
      authorization: "required",
      definition: { name: "records__search" },
    });
    expect(mocks.launches[0]).toMatchObject({
      command: server.command,
      args: server.args,
      cwd: server.cwd,
      stderr: "ignore",
      env: {
        HOME: "",
        USER: "",
        PATH: "/opt/mcp/bin",
        MCP_TOKEN: "current-principal-token",
      },
    });

    await expect(
      stdio.execute({ query: "recent" }, context()),
    ).resolves.toMatchObject({
      modelContent: "found",
      displayContent: { server: "records", tool: "search" },
    });
    expect(authorizeLaunch).toHaveBeenCalledTimes(2);
    expect(mocks.callTool).toHaveBeenCalledWith(
      { name: "search", arguments: { query: "recent" } },
      undefined,
      expect.objectContaining({
        signal: undefined,
        timeout: 60_000,
        resetTimeoutOnProgress: false,
      }),
    );
    expect(mocks.close).toHaveBeenCalledTimes(2);
  });

  it("fails closed without an allow decision or complete explicit launch authority", async () => {
    const denied = createNodeHostMcpStdioTools({
      resolveServers: () => [server],
      authorizeLaunch: () => false,
    });
    await expect(
      denied({ principal, sessionId: "session-a", turnId: "turn-a" }),
    ).resolves.toEqual([]);

    const incomplete = createNodeHostMcpStdioTools({
      resolveServers: () => [
        { ...server, command: "node" },
        { ...server, id: "no-cwd", cwd: "relative" },
        { ...server, id: "no-args", args: undefined as never },
        { ...server, id: "bad-env", env: { BAD: "x\0y" } },
      ],
      authorizeLaunch: () => true,
    });
    await expect(
      incomplete({ principal, sessionId: "session-a", turnId: "turn-a" }),
    ).resolves.toEqual([]);
    expect(mocks.launches).toEqual([]);
  });

  it("keeps discovery scoped to its principal and rejects mismatched invocation context", async () => {
    const resolveServers = vi.fn(({ principal: requestPrincipal }) =>
      requestPrincipal.subjectId === "subject-a" ? [server] : [],
    );
    const authorizeLaunch = vi.fn(() => true);
    const resolver = createNodeHostMcpStdioTools({
      resolveServers,
      authorizeLaunch,
    });
    const stdio = await tool(resolver, "records__search");

    await expect(
      stdio.execute(
        { query: "recent" },
        context({
          principal: { tenantId: "tenant-b", subjectId: "subject-b" },
        }),
      ),
    ).resolves.toMatchObject({
      isError: true,
      modelContent: expect.stringContaining("mcp_stdio_turn_mismatch"),
    });
    expect(mocks.callTool).not.toHaveBeenCalled();
    expect(authorizeLaunch).toHaveBeenCalledTimes(1);
  });

  it("bounds the exposed catalog and model result", async () => {
    mocks.listTools.mockResolvedValueOnce({
      tools: [
        {
          name: "first",
          description: "First.",
          inputSchema: { type: "object", properties: {}, required: [] },
        },
        {
          name: "second",
          description: "Second.",
          inputSchema: { type: "object", properties: {}, required: [] },
        },
      ],
    });
    mocks.callTool.mockResolvedValueOnce({
      content: [{ type: "text", text: "0123456789" }],
    });
    const resolver = createNodeHostMcpStdioTools({
      resolveServers: () => [server],
      authorizeLaunch: () => true,
      maxToolsPerServer: 1,
      maxToolResultChars: 5,
    });

    const stdio = await tool(resolver, "records__first");
    await expect(stdio.execute({}, context())).resolves.toMatchObject({
      modelContent: "0123…",
    });
    await expect(
      resolver({ principal, sessionId: "session-a", turnId: "turn-a" }),
    ).resolves.toHaveLength(1);
  });
});
