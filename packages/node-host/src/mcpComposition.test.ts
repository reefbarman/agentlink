import {
  CoreModelBackendRegistry,
  DefaultCoreModelRuntime,
  InMemoryAgentStateRepository,
  InMemoryAgentTurnLeaseProvider,
  createTurnInteractionTokenService,
  type AgentTurnResult,
  type CoreModelBackend,
  type CoreModelCapabilities,
  type CoreModelCompleteRequest,
  type CoreModelCompleteResult,
  type CoreModelRequestContext,
  type CoreModelStreamEvent,
  type CoreModelStreamRequest,
} from "@agentlink/core";
import { describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createNodeHostArtifactCatalog,
  createNodeHostInstructionResolver,
} from "./instructionCatalog.js";
import { createNodeHostMcpRemoteTools } from "./mcpRemoteTools.js";
import { createNodeHostMcpStdioTools } from "./mcpStdioTools.js";
import { createNodeHostAgent } from "./nodeHostAgent.js";
import { createNodeHostReadTools } from "./readTools.js";

const mocks = vi.hoisted(() => ({
  calls: [] as Array<{ name: string; input: unknown }>,
  remoteFetch: vi.fn(async () => new Response("ok")),
  stdioLaunches: [] as Array<{
    command: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
  }>,
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class MockClient {
    private transport:
      | { kind?: "remote" | "stdio"; fetch?: typeof globalThis.fetch }
      | undefined;

    async connect(transport: {
      kind?: "remote" | "stdio";
      fetch?: typeof globalThis.fetch;
    }): Promise<void> {
      this.transport = transport;
      if (transport.fetch)
        await transport.fetch("https://mcp.example.test/fixture");
    }

    async listTools() {
      const toolName = this.transport?.kind === "stdio" ? "lookup" : "status";
      return {
        tools: [
          {
            name: toolName,
            description: `${toolName} fixture tool.`,
            inputSchema: {
              type: "object",
              properties: { query: { type: "string" } },
              required: ["query"],
              additionalProperties: false,
            },
          },
        ],
      };
    }

    async callTool(params: { name: string; arguments: unknown }) {
      mocks.calls.push({ name: params.name, input: params.arguments });
      return {
        content: [
          {
            type: "text" as const,
            text:
              this.transport?.kind === "stdio"
                ? "stdio fixture evidence"
                : "remote fixture evidence",
          },
        ],
      };
    }

    async close(): Promise<void> {}
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class MockHttpTransport {
    readonly kind = "remote" as const;
    readonly fetch: typeof globalThis.fetch;
    constructor(_url: URL, options: { fetch: typeof globalThis.fetch }) {
      this.fetch = options.fetch;
    }
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: class MockSseTransport {
    readonly kind = "remote" as const;
    readonly fetch: typeof globalThis.fetch;
    constructor(_url: URL, options: { fetch: typeof globalThis.fetch }) {
      this.fetch = options.fetch;
    }
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  DEFAULT_INHERITED_ENV_VARS: ["HOME", "PATH"],
  StdioClientTransport: class MockStdioTransport {
    readonly kind = "stdio" as const;
    constructor(options: (typeof mocks.stdioLaunches)[number]) {
      mocks.stdioLaunches.push(options);
    }
  },
}));

const principal = { tenantId: "tenant-a", subjectId: "subject-a" };
const model = { providerId: "fixture", modelId: "fixture-model" };
const capabilities: CoreModelCapabilities = {
  supportsThinking: false,
  supportsCaching: false,
  supportsImages: false,
  supportsToolUse: true,
  contextWindow: 8_192,
  maxOutputTokens: 1_024,
};

class FixtureBackend implements CoreModelBackend {
  readonly systemPrompts: string[] = [];
  readonly providerId = model.providerId;
  readonly displayName = "Fixture";
  readonly condenseModel = model.modelId;

  listModels() {
    return [
      {
        id: model.modelId,
        displayName: "Fixture model",
        providerId: this.providerId,
        providerDisplayName: this.displayName,
        supportsToolUse: true,
        supportsImages: false,
        contextWindow: capabilities.contextWindow,
        maxOutputTokens: capabilities.maxOutputTokens,
        authenticated: true,
      },
    ];
  }

  getCapabilities(): CoreModelCapabilities {
    return capabilities;
  }

  constructor(
    private readonly scratchDirectory: string,
    private readonly fixtureFile: string,
  ) {}

  async *stream(
    request: CoreModelStreamRequest,
    _context: CoreModelRequestContext,
  ): AsyncGenerator<CoreModelStreamEvent> {
    this.systemPrompts.push(request.systemPrompt);
    const hasToolResult = request.messages.some(
      (message) =>
        Array.isArray(message.content) &&
        message.content.some((block) => block.type === "tool_result"),
    );
    if (hasToolResult) {
      yield { type: "text_delta", text: "both MCP fixtures completed" };
      yield {
        type: "model_stop",
        reason: "end_turn",
        assistantMessage: {
          role: "assistant",
          content: [{ type: "text", text: "both MCP fixtures completed" }],
        },
      };
      yield { type: "done" };
      return;
    }

    const calls = [
      {
        id: "read-call",
        name: "read_file",
        input: { path: this.fixtureFile },
      },
      {
        id: "search-call",
        name: "search_files",
        input: { path: this.scratchDirectory, regex: "fixture" },
      },
      { id: "remote-call", name: "remote__status", input: { query: "remote" } },
      { id: "stdio-call", name: "stdio__lookup", input: { query: "stdio" } },
    ];
    for (const call of calls)
      yield {
        type: "tool_done",
        toolCallId: call.id,
        toolName: call.name,
        input: call.input,
      };
    yield {
      type: "model_stop",
      reason: "tool_use",
      assistantMessage: {
        role: "assistant",
        content: calls.map((call) => ({ type: "tool_use" as const, ...call })),
      },
    };
    yield { type: "done" };
  }

  async complete(
    _request: CoreModelCompleteRequest,
    _context: CoreModelRequestContext,
  ): Promise<CoreModelCompleteResult> {
    return { text: "fixture completion" };
  }
}

function createModels(scratchDirectory: string, fixtureFile: string) {
  const registry = new CoreModelBackendRegistry();
  const backend = new FixtureBackend(scratchDirectory, fixtureFile);
  registry.register(backend);
  return {
    backend,
    runtime: new DefaultCoreModelRuntime(registry, { ownerId: "mcp-fixture" }),
  };
}

async function collect<T>(stream: AsyncGenerator<T, AgentTurnResult>) {
  const events: T[] = [];
  for (;;) {
    const next = await stream.next();
    if (next.done) return { events, result: next.value };
    events.push(next.value);
  }
}

describe("C0-C4 headless Node-host composition", () => {
  it("runs granted reads, catalog instructions, approvals, and remote/stdio MCP tools through one core turn", async () => {
    mocks.calls.length = 0;
    mocks.stdioLaunches.length = 0;
    const scratch = await fs.mkdtemp(
      path.join(os.tmpdir(), "node-host-c0-c4-"),
    );
    const fixtureFile = path.join(scratch, "fixture.txt");
    const artifactRoot = path.join(scratch, "artifacts");
    await fs.writeFile(fixtureFile, "fixture evidence", "utf8");
    await fs.mkdir(path.join(artifactRoot, "skills", "fixture-skill"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(artifactRoot, "AGENTS.md"),
      "Use only the approved fixture capabilities.",
      "utf8",
    );
    await fs.writeFile(
      path.join(artifactRoot, "skills", "fixture-skill", "SKILL.md"),
      "---\nname: fixture-skill\ndescription: Fixture catalog skill\n---\nUse safely.",
      "utf8",
    );
    const catalog = createNodeHostArtifactCatalog({
      roots: [{ id: "fixture", scope: "project", rootPath: artifactRoot }],
    });
    const snapshot = await catalog.snapshot();
    const instructions = createNodeHostInstructionResolver({
      identity: "C0-C4 fixture",
      resolveCatalog: () => catalog,
    });
    const read = createNodeHostReadTools({
      resolveGrants: () => [{ rootPath: scratch, kind: "directory" }],
    });
    const authorizeNetwork = vi.fn(async () => true);
    const authorizeLaunch = vi.fn(async () => true);
    const remote = createNodeHostMcpRemoteTools({
      resolveServers: () => [
        {
          id: "remote",
          transport: "streamable-http",
          url: "https://mcp.example.test/fixture",
        },
      ],
      authorizeNetwork,
      fetch: mocks.remoteFetch,
    });
    const stdio = createNodeHostMcpStdioTools({
      resolveServers: () => [
        {
          id: "stdio",
          command: "/opt/mcp/fixture-server",
          args: ["--stdio"],
          cwd: "/var/empty/mcp",
          env: { MCP_FIXTURE_TOKEN: "principal-a" },
        },
      ],
      authorizeLaunch,
    });
    const { backend, runtime } = createModels(scratch, fixtureFile);
    const state = new InMemoryAgentStateRepository<typeof principal>();
    const authorizeToolCall = vi.fn(() => ({ decision: "allow" as const }));
    const agent = createNodeHostAgent({
      ownerId: "mcp-fixture",
      models: runtime,
      persistence: {
        sessions: state,
        turnLeases: new InMemoryAgentTurnLeaseProvider<typeof principal>(),
      },
      interactions: {
        interactions: state,
        interactionTokens: createTurnInteractionTokenService({
          secret: "0123456789abcdef0123456789abcdef",
          createResponseId: () => "fixture-response",
        }),
        authorizeToolCall,
      },
      instructions,
      defaultModel: model,
      maxOutputTokens: 512,
      limits: { maxToolCalls: 4 },
      tools: {
        resolveTools: async (request) => [
          ...(await read(request)),
          ...(await remote(request)),
          ...(await stdio(request)),
        ],
      },
    });

    await agent.sessions.create({ principal, sessionId: "session-a" });
    const { events, result } = await collect(
      agent.sessions.runTurn({
        principal,
        sessionId: "session-a",
        input: { text: "consult both fixtures", attachments: undefined },
        model: undefined,
      }),
    );

    if (result.status === "failed") throw new Error(result.error.message);
    expect(result).toMatchObject({
      status: "completed",
      text: "both MCP fixtures completed",
    });
    expect(snapshot.skills).toEqual([
      expect.objectContaining({ name: "fixture-skill" }),
    ]);
    expect(backend.systemPrompts[0]).toContain(
      "Use only the approved fixture capabilities.",
    );
    expect(authorizeToolCall).toHaveBeenCalledTimes(2);
    expect(mocks.calls).toEqual([
      { name: "status", input: { query: "remote" } },
      { name: "lookup", input: { query: "stdio" } },
    ]);
    expect(authorizeNetwork).toHaveBeenCalledTimes(2);
    expect(authorizeLaunch).toHaveBeenCalledTimes(2);
    expect(mocks.stdioLaunches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          command: "/opt/mcp/fixture-server",
          args: ["--stdio"],
          cwd: "/var/empty/mcp",
          env: expect.objectContaining({
            HOME: "",
            PATH: "",
            MCP_FIXTURE_TOKEN: "principal-a",
          }),
        }),
      ]),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool.completed",
        toolName: "read_file",
        displayContent: expect.objectContaining({
          path: expect.stringContaining(path.basename(fixtureFile)),
        }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool.completed",
        toolName: "search_files",
        displayContent: expect.objectContaining({
          path: expect.stringContaining(path.basename(scratch)),
        }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool.completed",
        toolName: "remote__status",
        displayContent: { server: "remote", tool: "status" },
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool.completed",
        toolName: "stdio__lookup",
        displayContent: { server: "stdio", tool: "lookup" },
      }),
    );
    await fs.rm(scratch, { recursive: true, force: true });
  });
});
