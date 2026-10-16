import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AgentPrincipal } from "@agentlink/core";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";

import {
  createAssistantMcpTools,
  isMcpCallDisplay,
  type McpCallRecord,
} from "./assistantMcpTools.js";
import { openMcpRegistry, type McpRegistry } from "./mcpRegistry.js";
import {
  approvalToolProxyRoutes,
  createRunnerApprovalGrants,
} from "./remoteHostTools.js";

const principal: AgentPrincipal = { tenantId: "local", subjectId: "owner" };
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function setup() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-tools-"));
  directories.push(dataRoot);
  const tools = { description: "Search the wiki" };
  const calls: unknown[] = [];
  const registry = await openMcpRegistry({
    dataRoot,
    redirectUrl: "https://assistant.example/mcp/callback",
    createTransport: () => {
      const [client, serverSide] = InMemoryTransport.createLinkedPair();
      const server = new Server(
        { name: "fake", version: "1.0.0" },
        { capabilities: { tools: {} } },
      );
      server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
          {
            name: "search",
            description: tools.description,
            inputSchema: { type: "object" as const, properties: {} },
          },
          {
            name: "create",
            description: "Create a page",
            inputSchema: { type: "object" as const, properties: {} },
          },
        ],
      }));
      server.setRequestHandler(CallToolRequestSchema, async (request) => {
        calls.push(request.params);
        return {
          content: [{ type: "text" as const, text: "secret result text" }],
        };
      });
      void server.connect(serverSide);
      return client;
    },
  });
  const server = await registry.add({
    label: "Wiki",
    url: "https://mcp.example.com/mcp",
    auth: "none",
  });
  await registry.refresh(server.id);
  const audit: McpCallRecord[] = [];
  const mcp = createAssistantMcpTools({
    registry,
    projectId: "home",
    audit: async (record) => {
      audit.push(record);
    },
  });
  return { registry, mcp, audit, calls, tools, serverId: server.id };
}

const request = (toolName: string, input: Record<string, unknown>) =>
  ({
    principal,
    sessionId: "s1",
    turnId: "t1",
    toolName,
    input,
    effect: "external",
  }) as never;

async function execute(
  mcp: Awaited<ReturnType<typeof setup>>["mcp"],
  toolName: string,
  input: Record<string, unknown>,
) {
  const tools = await mcp.approvalTools.resolveTools({
    principal,
    sessionId: "s1",
    turnId: "t1",
    input: { text: "", attachments: undefined },
  });
  const tool = tools.find((item) => item.definition.name === toolName)!;
  // As the engine runs an approved call: the prepared input as is.
  return await tool.executeValidated(input, {
    principal,
    sessionId: "s1",
    turnId: "t1",
    model: undefined as never,
    signal: new AbortController().signal,
  });
}

describe("createAssistantMcpTools", () => {
  it("asks for a new tool, whatever the chat's mode, and runs one on Run straight away", async () => {
    const { mcp, registry, serverId } = await setup();
    const asked = await mcp.approvalTools.prepare(
      request("call_mcp_tool", {
        server: serverId,
        tool: "search",
        arguments: { q: "x" },
      }),
    );
    expect(asked.decision).toBe("require_user");
    if (asked.decision === "deny") throw new Error("denied");
    expect(isMcpCallDisplay(asked.displayContent)).toBe(true);

    await registry.setPolicy(serverId, "search", "run");
    const allowed = await mcp.approvalTools.prepare(
      request("call_mcp_tool", { server: serverId, tool: "search" }),
    );
    expect(allowed.decision).toBe("allow");
  });

  it("refuses Off tools, unknown tools and turned-off servers", async () => {
    const { mcp, registry, serverId } = await setup();
    const decide = async (tool: string) =>
      (
        await mcp.approvalTools.prepare(
          request("call_mcp_tool", { server: serverId, tool }),
        )
      ).decision;
    await registry.setPolicy(serverId, "create", "off");
    expect(await decide("create")).toBe("deny");
    expect(await decide("nope")).toBe("deny");
    await registry.update(serverId, { enabled: false });
    expect(await decide("search")).toBe("deny");
  });

  it("runs an approved call and audits hashes only", async () => {
    const { mcp, serverId, audit, calls } = await setup();
    const approval = await mcp.approvalTools.prepare(
      request("call_mcp_tool", {
        server: serverId,
        tool: "search",
        arguments: { q: "private words" },
      }),
    );
    if (approval.decision === "deny") throw new Error("denied");
    const result = await execute(mcp, "call_mcp_tool", approval.preparedInput!);
    expect(result.modelContent).toContain("secret result text");
    expect(calls).toEqual([
      { name: "search", arguments: { q: "private words" } },
    ]);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      server: serverId,
      tool: "search",
      policy: "ask",
      approvedBy: "owner",
      outcome: "ok",
      sessionId: "s1",
      projectId: "home",
    });
    const recorded = JSON.stringify(audit);
    expect(recorded).not.toContain("private words");
    expect(recorded).not.toContain("secret result text");
  });

  it("cancels a pending call when the tool changes or the owner changes its policy", async () => {
    const { mcp, registry, serverId, tools, audit, calls } = await setup();
    await registry.setPolicy(serverId, "search", "run");
    const approval = await mcp.approvalTools.prepare(
      request("call_mcp_tool", { server: serverId, tool: "search" }),
    );
    if (approval.decision === "deny") throw new Error("denied");
    const pending = {
      sessionId: "s1",
      toolName: "call_mcp_tool",
      input: approval.preparedInput!,
    };
    expect(await mcp.approvalTools.validatePending!(pending)).toEqual({
      ok: true,
    });

    await registry.setPolicy(serverId, "search", "ask");
    expect(await mcp.approvalTools.validatePending!(pending)).toMatchObject({
      ok: false,
    });

    await registry.setPolicy(serverId, "search", "run");
    tools.description = "Search the wiki and delete pages";
    await registry.refresh(serverId);
    expect(await mcp.approvalTools.validatePending!(pending)).toMatchObject({
      ok: false,
    });
    // Even if it got as far as running, it is refused and recorded.
    const result = await execute(mcp, "call_mcp_tool", pending.input);
    expect(result.isError).toBe(true);
    expect(calls).toEqual([]);
    expect(audit.at(-1)).toMatchObject({ outcome: "refused" });
  });

  it("will not call without the server's prepared input", async () => {
    const { mcp, serverId, calls } = await setup();
    const result = await execute(mcp, "call_mcp_tool", {
      server: serverId,
      tool: "search",
    });
    expect(result.isError).toBe(true);
    expect(calls).toEqual([]);
  });

  it("adds a proposed server only after approval, with every tool on Ask", async () => {
    const { mcp, registry } = await setup();
    const approval = await mcp.approvalTools.prepare(
      request("propose_mcp_server", {
        label: "Tracker",
        url: "https://mcp.tracker.example/mcp",
        purpose: "Read my issues",
      }),
    );
    expect(approval.decision).toBe("require_user");
    if (approval.decision === "deny") throw new Error("denied");
    await execute(mcp, "propose_mcp_server", approval.preparedInput!);
    expect(
      registry.list().find((server) => server.label === "Tracker"),
    ).toMatchObject({ origin: "chat", purpose: "Read my issues" });
  });
});

describe("approvalToolProxyRoutes", () => {
  const context = {
    signal: new AbortController().signal,
    request: undefined as never,
    stream: undefined as never,
  };

  async function routes(registry: McpRegistry, serverId: string) {
    const mcp = createAssistantMcpTools({
      registry,
      projectId: "task:abc",
      audit: async () => undefined,
    });
    const grants = createRunnerApprovalGrants();
    const handlers = approvalToolProxyRoutes({
      tools: mcp.approvalTools,
      principal,
      grants,
    });
    const ids = { sessionId: "s1", turnId: "t1" };
    const prepare = async (tool: string) =>
      (await handlers["/approval-tools/prepare"]!(
        {
          ...ids,
          toolName: "call_mcp_tool",
          input: { server: serverId, tool },
        },
        context,
      )) as { decision: string; preparedInput?: Record<string, unknown> };
    const call = async (input: unknown) =>
      await handlers["/approval-tools/call"]!(
        { ...ids, toolName: "call_mcp_tool", input },
        context,
      );
    return { handlers, grants, prepare, call };
  }

  it("runs a runner's Ask call only after the owner allows it, once", async () => {
    const { registry, serverId, calls } = await setup();
    const { grants, prepare, call } = await routes(registry, serverId);
    const approval = await prepare("search");
    expect(approval.decision).toBe("require_user");
    // The runner cannot run it on its own say-so.
    await expect(call(approval.preparedInput)).rejects.toMatchObject({
      status: 403,
    });
    grants.decide("s1", "allow");
    await expect(call(approval.preparedInput)).resolves.toMatchObject({
      modelContent: expect.stringContaining("secret result text"),
    });
    expect(calls).toHaveLength(1);
    // Used up.
    await expect(call(approval.preparedInput)).rejects.toMatchObject({
      status: 403,
    });
  });

  it("runs a Run call without a card, and refuses forged or denied input", async () => {
    const { registry, serverId, calls } = await setup();
    await registry.setPolicy(serverId, "search", "run");
    const { grants, prepare, call } = await routes(registry, serverId);
    const allowed = await prepare("search");
    expect(allowed.decision).toBe("allow");
    await expect(
      call({ ...allowed.preparedInput, arguments: { q: "other" } }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(call(allowed.preparedInput)).resolves.toBeDefined();

    const asked = await prepare("create");
    grants.decide("s1", "deny");
    await expect(call(asked.preparedInput)).rejects.toMatchObject({
      status: 403,
    });
    expect(calls).toHaveLength(1);
  });
});
