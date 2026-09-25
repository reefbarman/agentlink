import { describe, expect, it, vi } from "vitest";

import { createWorkspaceHost } from "./workspaceHostRuntime.js";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const mocks = vi.hoisted(() => ({
  calls: [] as Array<{ name: string; input: unknown }>,
  connects: 0,
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class MockClient {
    setRequestHandler() {}
    setNotificationHandler() {}
    async connect(transport: { fetch?: typeof globalThis.fetch; url?: URL }) {
      mocks.connects += 1;
      if (transport.fetch && transport.url) {
        await transport.fetch(transport.url.href);
      }
    }
    async listTools() {
      return {
        tools: [
          {
            name: "lookup",
            description: "Look up a fixture record",
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
    async listResources() {
      return { resources: [] };
    }
    async listPrompts() {
      return { prompts: [] };
    }
    async callTool(request: { name: string; arguments: unknown }) {
      mocks.calls.push({ name: request.name, input: request.arguments });
      return { content: [{ type: "text", text: "fixture MCP result" }] };
    }
    async close() {}
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class MockTransport {
    readonly fetch: typeof globalThis.fetch;
    readonly url: URL;
    constructor(url: URL, options: { fetch: typeof globalThis.fetch }) {
      this.url = url;
      this.fetch = options.fetch;
    }
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: class MockTransport {
    readonly fetch: typeof globalThis.fetch;
    readonly url: URL;
    constructor(url: URL, options: { fetch: typeof globalThis.fetch }) {
      this.url = url;
      this.fetch = options.fetch;
    }
  },
}));

function toolCall(name: string, input: Record<string, unknown>): Response {
  return new Response(
    `data: ${JSON.stringify({
      id: "tool-response",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call-1",
                type: "function",
                function: { name, arguments: JSON.stringify(input) },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    })}\n\ndata: [DONE]\n\n`,
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

function completion(text: string): Response {
  return new Response(
    `data: ${JSON.stringify({
      id: "response",
      choices: [
        {
          index: 0,
          delta: { content: text },
          finish_reason: "stop",
        },
      ],
    })}\n\ndata: [DONE]\n\n`,
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

async function fixture() {
  const parent = await fs.mkdtemp(
    path.join(os.tmpdir(), "workspace-host-mcp-"),
  );
  const projectRoot = path.join(parent, "project");
  const dataRoot = path.join(parent, "data");
  const globalConfigPath = path.join(parent, "mcp.json");
  await fs.mkdir(projectRoot);
  await fs.writeFile(
    globalConfigPath,
    JSON.stringify({
      schemaVersion: 1,
      trustedProjectServerIds: [],
      servers: [
        {
          id: "records",
          transport: "streamable-http",
          url: "https://mcp.example.test/rpc",
        },
      ],
    }),
  );
  const transportFetch = vi.fn(async () => new Response("ok"));
  const providers = (fetch: typeof globalThis.fetch) => [
    {
      type: "openai-compatible" as const,
      id: "fixture",
      baseURL: "https://example.invalid/v1",
      noAuth: true as const,
      models: [
        {
          id: "fixture-model",
          contextWindow: 32_768,
          maxOutputTokens: 4_096,
          supportsToolUse: true,
        },
      ],
      fetch,
    },
  ];
  const createHost = (fetch: typeof globalThis.fetch) =>
    createWorkspaceHost({
      projectRoot,
      dataRoot,
      ownerId: "mcp-test",
      providers: providers(fetch),
      defaultModel: { providerId: "fixture", modelId: "fixture-model" },
      mcp: {
        globalConfigPath,
        resolveCredential: async () => "unused",
        authorizeNetwork: async () => true,
        fetch: transportFetch,
      },
    });
  return {
    parent,
    projectRoot,
    dataRoot,
    providers,
    globalConfigPath,
    transportFetch,
    createHost,
  };
}

describe("workspace host MCP composition", () => {
  it("retains a shared MCP connection through approval and a second turn", async () => {
    mocks.calls.length = 0;
    mocks.connects = 0;
    const test = await fixture();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(toolCall("records__lookup", { query: "alpha" }))
      .mockResolvedValueOnce(completion("first reply"))
      .mockResolvedValueOnce(completion("second reply"));

    const host = await createWorkspaceHost({
      projectRoot: test.projectRoot,
      dataRoot: test.dataRoot,
      ownerId: "shared-mcp-test",
      providers: test.providers(fetch),
      defaultModel: { providerId: "fixture", modelId: "fixture-model" },
      sharedMcp: {
        resolveConfigs: async () => [
          {
            name: "records",
            type: "streamable-http",
            url: "https://mcp.example.test/rpc",
          },
        ],
        baseEnvironment: () => ({}),
        fetch: test.transportFetch,
        nativeFetch: test.transportFetch,
        clientVersion: "test",
        authorizeAdmission: async () => true,
        authorizeLaunch: async () => true,
        authorizeNetwork: async () => true,
      },
    });
    try {
      const sessionId = (await host.createSession()).sessionId;
      const suspended = await host.runTurn(sessionId, "look up alpha");
      expect(suspended).toMatchObject({
        status: "suspended",
        interaction: {
          displayContent: { kind: "shared_mcp_tool_call" },
        },
      });
      await expect(
        host.resumeInteraction(sessionId, "allow"),
      ).resolves.toMatchObject({ status: "completed", text: "first reply" });
      expect(mocks.calls).toEqual([
        { name: "lookup", input: { query: "alpha" } },
      ]);
      await expect(host.runTurn(sessionId, "continue")).resolves.toMatchObject({
        status: "completed",
        text: "second reply",
      });
      expect(mocks.connects).toBe(1);
      const firstRequest = JSON.parse(
        String(fetch.mock.calls[0]?.[1]?.body),
      ) as {
        messages: Array<{ content: string }>;
      };
      expect(firstRequest.messages[0]?.content).toContain(
        "MCP servers are unsandboxed external capabilities",
      );
      expect(firstRequest.messages[0]?.content).not.toContain(
        "MCP tools are not enabled",
      );
    } finally {
      await host.close();
      await fs.rm(test.parent, { recursive: true, force: true });
    }
  });

  it("denies a durable exact MCP call without invoking the server", async () => {
    mocks.calls.length = 0;
    const test = await fixture();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(toolCall("records__lookup", { query: "alpha" }))
      .mockResolvedValueOnce(completion("denied"));
    const host = await test.createHost(fetch);
    try {
      const sessionId = (await host.createSession()).sessionId;
      const suspended = await host.runTurn(sessionId, "look up alpha");
      expect(suspended).toMatchObject({
        status: "suspended",
        interaction: {
          displayContent: {
            kind: "mcp_tool_call",
            serverId: "records",
            serverToolName: "lookup",
            unsandboxed: true,
          },
        },
      });
      await expect(
        host.resumeInteraction(sessionId, "deny"),
      ).resolves.toMatchObject({ status: "completed", text: "denied" });
      expect(mocks.calls).toEqual([]);
    } finally {
      await host.close();
      await fs.rm(test.parent, { recursive: true, force: true });
    }
  });

  it("resumes an approved exact MCP call once and rejects changed config", async () => {
    mocks.calls.length = 0;
    const test = await fixture();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(toolCall("records__lookup", { query: "alpha" }))
      .mockResolvedValueOnce(completion("done"));
    const host = await test.createHost(fetch);
    try {
      const sessionId = (await host.createSession()).sessionId;
      await expect(
        host.runTurn(sessionId, "look up alpha"),
      ).resolves.toMatchObject({
        status: "suspended",
      });
      await expect(
        host.revalidatePendingInteraction(sessionId),
      ).resolves.toEqual({ ok: true });
      await expect(
        host.resumeInteraction(sessionId, "allow"),
      ).resolves.toMatchObject({ status: "completed", text: "done" });
      expect(mocks.calls).toEqual([
        { name: "lookup", input: { query: "alpha" } },
      ]);

      const secondFetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(toolCall("records__lookup", { query: "beta" }));
      const second = await test.createHost(secondFetch);
      const secondSession = (await second.createSession()).sessionId;
      await expect(
        second.runTurn(secondSession, "look up beta"),
      ).resolves.toMatchObject({
        status: "suspended",
      });
      await fs.writeFile(
        test.globalConfigPath,
        JSON.stringify({
          schemaVersion: 1,
          trustedProjectServerIds: [],
          servers: [],
        }),
      );
      await expect(
        second.revalidatePendingInteraction(secondSession),
      ).resolves.toEqual({
        ok: false,
        reason: "MCP tool proposal no longer matches config",
      });
      await second.close();
    } finally {
      await host.close();
      await fs.rm(test.parent, { recursive: true, force: true });
    }
  });
});
