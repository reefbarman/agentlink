import { describe, expect, it, vi } from "vitest";

import {
  defineTool,
  type HostTool,
  type HostToolResolver,
} from "@agentlink/core";
import type {
  CreateNodeHostMcpRemoteToolsOptions,
  CreateNodeHostMcpStdioToolsOptions,
  NodeHostMcpResourcePromptProvider,
} from "@agentlink/node-host" with { "resolution-mode": "import" };

import { StandaloneAskAgentMcpRuntime } from "./StandaloneAskAgentMcpRuntime.js";

const request = {
  sessionId: "session-a",
  turnId: "turn-a",
  providerId: "openai-codex",
  modelId: "gpt-test",
};

function fixtureResources(
  serverName: string,
  transport: string,
): NodeHostMcpResourcePromptProvider {
  return {
    listResources: () => [
      {
        serverName,
        uri: `${transport}://${serverName}/fixture`,
        name: `${serverName} fixture`,
      },
    ],
    readResource: async ({ uri }) => ({
      content: [{ type: "text", text: `resource:${uri}` }],
    }),
    listPrompts: () => [
      {
        serverName,
        name: "summarize",
        arguments: [{ name: "topic", required: true }],
      },
    ],
    getPrompt: async ({ name, arguments: args }) => ({
      content: [
        {
          type: "text",
          text: `prompt:${serverName}:${name}:${args?.topic ?? ""}`,
        },
      ],
    }),
  };
}

function fixtureTool(name: string, result: string): HostTool {
  return defineTool({
    name,
    description: `Fixture ${name}`,
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      additionalProperties: false,
    },
    effect: "external",
    authorization: "required",
    handler: async (input) => ({
      modelContent: `${result}:${String(input.query ?? "")}`,
    }),
  });
}

describe("StandaloneAskAgentMcpRuntime", () => {
  it("maps shared Ask Agent config and keeps default-ask tools fail-closed", async () => {
    let stdioOptions: CreateNodeHostMcpStdioToolsOptions | undefined;
    let remoteOptions: CreateNodeHostMcpRemoteToolsOptions | undefined;
    const createStdioTools = vi.fn(
      (options: CreateNodeHostMcpStdioToolsOptions): HostToolResolver => {
        stdioOptions = options;
        return async () => [
          fixtureTool("records__search", "found"),
          fixtureTool("records__delete", "deleted"),
          fixtureTool("prompted__search", "prompted"),
          fixtureTool("empty__search", "empty"),
        ];
      },
    );
    const createRemoteTools = vi.fn(
      (options: CreateNodeHostMcpRemoteToolsOptions): HostToolResolver => {
        remoteOptions = options;
        return async () => [fixtureTool("remote__lookup", "remote")];
      },
    );
    const runtime = new StandaloneAskAgentMcpRuntime({
      loadConfigs: async () => [
        {
          name: "records",
          command: "records-server",
          args: ["--safe"],
          env: { MCP_TOKEN: "secret" },
          allowedTools: ["search"],
          supportsParallelToolCalls: true,
        },
        {
          name: "prompted",
          command: "/opt/mcp/prompted",
          toolPolicy: "ask",
        },
        {
          name: "empty",
          command: "/opt/mcp/empty",
          allowedTools: [""],
        },
        {
          name: "remote",
          type: "streamable-http",
          url: "https://mcp.example.test/path",
          headers: { Authorization: "Bearer secret" },
          toolPolicy: "allow",
        },
        {
          name: "insecure",
          type: "sse",
          url: "http://127.0.0.1:9000/mcp",
          toolPolicy: "allow",
        },
        {
          name: "disabled",
          command: "/opt/mcp/disabled",
          disabled: true,
          toolPolicy: "allow",
        },
      ],
      createStdioTools,
      createRemoteTools,
      createStdioResourcePrompts: async () =>
        fixtureResources("records", "stdio"),
      createRemoteResourcePrompts: async () =>
        fixtureResources("remote", "https"),
      resolveExecutable: async (command) =>
        command === "records-server" ? "/opt/mcp/records-server" : command,
      environment: { PATH: "/opt/mcp/bin", USER: "tester" },
      homeDirectory: "/Users/tester",
      temporaryDirectory: "/tmp/agentlink-test",
      clientVersion: "1.2.3",
    });

    const onElicitation = vi.fn(async () => ({ action: "cancel" as const }));
    const turn = await runtime.prepareTurn({ ...request, onElicitation });
    const names = turn.tools.map((tool) => tool.name);

    expect(names).toEqual([
      "records__search",
      "records__delete",
      "prompted__search",
      "empty__search",
      "remote__lookup",
      "find_mcp_tools",
      "call_mcp_tool",
      "list_mcp_resources",
      "read_mcp_resource",
      "list_mcp_prompts",
      "get_mcp_prompt",
    ]);
    expect(stdioOptions?.onElicitation).toBe(onElicitation);
    expect(remoteOptions?.onElicitation).toBe(onElicitation);
    expect(turn.parallelSafeServerNames).toEqual([]);
    expect(turn.parallelSafeToolNames).toContain("records__search");
    expect(turn.parallelSafeToolNames).not.toContain("records__delete");
    expect(
      await stdioOptions?.resolveServers({
        principal: { tenantId: "agentlink-desktop", subjectId: "ask-agent" },
        sessionId: "session-a",
        turnId: "turn-a",
      }),
    ).toEqual([
      expect.objectContaining({
        id: "records",
        command: "/opt/mcp/records-server",
        args: ["--safe"],
        cwd: "/Users/tester",
        env: {
          HOME: "/Users/tester",
          TMPDIR: "/tmp/agentlink-test",
          PATH: "/opt/mcp/bin",
          USER: "tester",
          MCP_TOKEN: "secret",
        },
      }),
      expect.objectContaining({ id: "prompted" }),
      expect.objectContaining({ id: "empty" }),
    ]);
    expect(
      await remoteOptions?.resolveServers({
        principal: { tenantId: "agentlink-desktop", subjectId: "ask-agent" },
        sessionId: "session-a",
        turnId: "turn-a",
      }),
    ).toEqual([
      expect.objectContaining({
        id: "remote",
        url: "https://mcp.example.test/path",
      }),
    ]);

    await expect(
      turn.execute(
        "records__search",
        { query: "recent" },
        new AbortController().signal,
        request,
      ),
    ).resolves.toMatchObject({
      content: [{ type: "text", text: "found:recent" }],
    });
    await expect(
      turn.execute(
        "call_mcp_tool",
        { server: "remote", tool: "lookup", input: { query: "current" } },
        new AbortController().signal,
        request,
      ),
    ).resolves.toMatchObject({
      content: [{ type: "text", text: "remote:current" }],
    });
    expect(
      turn.getApprovalRequirement?.("records__search", {}),
    ).toBeUndefined();
    expect(turn.getApprovalRequirement?.("records__delete", {})).toEqual({
      serverName: "records",
      bareToolName: "delete",
      input: {},
    });
    expect(turn.getApprovalRequirement?.("empty__search", {})).toEqual({
      serverName: "empty",
      bareToolName: "search",
      input: {},
    });
    expect(
      turn.getApprovalRequirement?.("call_mcp_tool", {
        server: "prompted",
        tool: "search",
        input: { query: "current" },
      }),
    ).toEqual({
      serverName: "prompted",
      bareToolName: "search",
      input: { query: "current" },
    });
    await expect(
      turn.execute(
        "list_mcp_resources",
        {},
        new AbortController().signal,
        request,
      ),
    ).resolves.toMatchObject({
      data: expect.arrayContaining([
        expect.objectContaining({ serverName: "records" }),
        expect.objectContaining({ serverName: "remote" }),
      ]),
    });
    await expect(
      turn.execute(
        "read_mcp_resource",
        { server: "remote", uri: "https://remote/fixture" },
        new AbortController().signal,
        request,
      ),
    ).resolves.toMatchObject({
      content: [{ type: "text", text: "resource:https://remote/fixture" }],
    });
    await expect(
      turn.execute(
        "list_mcp_prompts",
        {},
        new AbortController().signal,
        request,
      ),
    ).resolves.toMatchObject({
      data: expect.arrayContaining([
        expect.objectContaining({ serverName: "records", name: "summarize" }),
        expect.objectContaining({ serverName: "remote", name: "summarize" }),
      ]),
    });
    await expect(
      turn.execute(
        "get_mcp_prompt",
        {
          server: "records",
          name: "summarize",
          arguments: { topic: "MCP" },
        },
        new AbortController().signal,
        request,
      ),
    ).resolves.toMatchObject({
      content: [{ type: "text", text: "prompt:records:summarize:MCP" }],
    });
    await expect(
      turn.execute(
        "records__delete",
        {},
        new AbortController().signal,
        request,
      ),
    ).resolves.toMatchObject({ isError: true });
    await expect(
      turn.execute(
        "records__delete",
        {},
        new AbortController().signal,
        request,
        true,
      ),
    ).resolves.toMatchObject({
      content: [{ type: "text", text: "deleted:" }],
    });
  });

  it("allows deferred calls for every valid composed node-host tool name", async () => {
    const bareToolName = `1${"a".repeat(48)}`;
    const runtime = new StandaloneAskAgentMcpRuntime({
      loadConfigs: async () => [
        { name: "records", command: "/opt/mcp/records", toolPolicy: "allow" },
      ],
      createStdioTools: () => async () => [
        fixtureTool(`records__${bareToolName}`, "found"),
      ],
      createRemoteTools: () => async () => [],
      createStdioResourcePrompts: async () =>
        fixtureResources("records", "stdio"),
      createRemoteResourcePrompts: async () =>
        fixtureResources("remote", "https"),
      resolveExecutable: async (command) => command,
    });
    const turn = await runtime.prepareTurn(request);

    await expect(
      turn.execute(
        "call_mcp_tool",
        { server: "records", tool: bareToolName, input: { query: "current" } },
        new AbortController().signal,
        request,
      ),
    ).resolves.toMatchObject({
      content: [{ type: "text", text: "found:current" }],
    });
  });

  it("rejects a prepared turn reused under another session or turn", async () => {
    const runtime = new StandaloneAskAgentMcpRuntime({
      loadConfigs: async () => [
        { name: "records", command: "/opt/mcp/records", toolPolicy: "allow" },
      ],
      createStdioTools: () => async () => [
        fixtureTool("records__search", "found"),
      ],
      createRemoteTools: () => async () => [],
      createStdioResourcePrompts: async () =>
        fixtureResources("records", "stdio"),
      createRemoteResourcePrompts: async () =>
        fixtureResources("remote", "https"),
      resolveExecutable: async (command) => command,
    });
    const turn = await runtime.prepareTurn(request);

    await expect(
      turn.execute(
        "records__search",
        { query: "stale" },
        new AbortController().signal,
        { sessionId: "session-b", turnId: request.turnId },
      ),
    ).resolves.toMatchObject({
      isError: true,
      error: {
        message: "MCP tool invocation does not match the prepared turn",
      },
    });
    await expect(
      turn.execute(
        "read_mcp_resource",
        { server: "records", uri: "stdio://records/fixture" },
        new AbortController().signal,
        { sessionId: request.sessionId, turnId: "turn-b" },
      ),
    ).resolves.toMatchObject({ isError: true });
  });

  it("stops waiting for catalog preparation when the turn is cancelled", async () => {
    const never = new Promise<readonly HostTool[]>(() => {});
    const runtime = new StandaloneAskAgentMcpRuntime({
      loadConfigs: async () => [
        { name: "records", command: "/opt/mcp/records", toolPolicy: "allow" },
      ],
      createStdioTools: () => async () => await never,
      createRemoteTools: () => async () => [],
      createStdioResourcePrompts: async () =>
        fixtureResources("records", "stdio"),
      createRemoteResourcePrompts: async () =>
        fixtureResources("remote", "https"),
      resolveExecutable: async (command) => command,
    });
    const controller = new AbortController();
    const pending = runtime.prepareTurn({
      ...request,
      signal: controller.signal,
    });

    controller.abort(new Error("turn_cancelled"));

    await expect(pending).rejects.toThrow("turn_cancelled");
  });

  it("returns a bounded deferred catalog containing only authorized tools", async () => {
    const runtime = new StandaloneAskAgentMcpRuntime({
      loadConfigs: async () => [
        { name: "records", command: "/opt/mcp/records", toolPolicy: "allow" },
      ],
      createStdioTools: () => async () => [
        fixtureTool("records__search", "found"),
        fixtureTool("records__read", "read"),
      ],
      createRemoteTools: () => async () => [],
      createStdioResourcePrompts: async () =>
        fixtureResources("records", "stdio"),
      createRemoteResourcePrompts: async () =>
        fixtureResources("remote", "https"),
      resolveExecutable: async (command) => command,
    });
    const turn = await runtime.prepareTurn(request);
    const result = await turn.execute(
      "find_mcp_tools",
      {
        query: "search",
        includeSchemas: true,
        schemaLimit: 1,
        limit: 1,
      },
      new AbortController().signal,
      request,
    );

    expect(result.data).toEqual({
      tools: [
        expect.objectContaining({
          name: "records__search",
          input_schema: expect.any(Object),
        }),
      ],
      total: 1,
    });
  });
});
