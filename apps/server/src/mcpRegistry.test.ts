import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";

import {
  isPublicHttps,
  openMcpRegistry,
  type McpTransportFactory,
} from "./mcpRegistry.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function tempDirectory() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-registry-"));
  directories.push(directory);
  return directory;
}

interface FakeTool {
  name: string;
  description: string;
  readOnly?: boolean;
}

/** An in-memory MCP server whose tools can change between connections. */
function fakeServer(tools: { current: FakeTool[] }) {
  const calls: Array<{ name: string; arguments: unknown }> = [];
  const headersSeen: Array<Record<string, string>> = [];
  const createTransport: McpTransportFactory = (_server, options) => {
    headersSeen.push({ ...options.headers });
    const [client, serverSide] = InMemoryTransport.createLinkedPair();
    const server = new Server(
      { name: "fake", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: tools.current.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: {
          type: "object" as const,
          properties: { q: { type: "string" } },
        },
        ...(tool.readOnly ? { annotations: { readOnlyHint: true } } : {}),
      })),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      calls.push({
        name: request.params.name,
        arguments: request.params.arguments,
      });
      return {
        content: [
          { type: "text" as const, text: `ran ${request.params.name}` },
        ],
      };
    });
    void server.connect(serverSide);
    return client;
  };
  return { createTransport, calls, headersSeen };
}

describe("openMcpRegistry", () => {
  it("adds a server with every tool on Ask, and keeps Run until a tool changes", async () => {
    const dataRoot = await tempDirectory();
    const tools = {
      current: [
        { name: "search", description: "Search", readOnly: true },
        { name: "create", description: "Create a page" },
      ],
    };
    const fake = fakeServer(tools);
    const registry = await openMcpRegistry({
      dataRoot,
      redirectUrl: "https://assistant.example/mcp/callback",
      createTransport: fake.createTransport,
    });
    const added = await registry.add({
      label: "Docs Wiki",
      url: "https://mcp.example.com/mcp",
      auth: "none",
    });
    expect(added).toMatchObject({ id: "docs-wiki", status: "untested" });

    const first = await registry.refresh(added.id);
    expect(first.added).toEqual(["search", "create"]);
    expect(first.server.status).toBe("ok");
    expect(first.server.tools.map((tool) => tool.policy)).toEqual([
      "ask",
      "ask",
    ]);
    expect(first.server.tools[0]?.readOnlyHint).toBe(true);

    await registry.setPolicy(added.id, "search", "run");
    await registry.setPolicy(added.id, "create", "off");
    // Unchanged tools keep the owner's choice.
    const same = await registry.refresh(added.id);
    expect(same.changed).toEqual([]);
    expect(same.server.tools.map((tool) => tool.policy)).toEqual([
      "run",
      "off",
    ]);

    // A changed description puts Run back on Ask; Off stays off.
    tools.current = [
      { name: "search", description: "Search, and also delete things" },
      { name: "create", description: "Create a page, differently" },
    ];
    const changed = await registry.refresh(added.id);
    expect(changed.changed).toEqual(["search", "create"]);
    expect(changed.server.tools.map((tool) => tool.policy)).toEqual([
      "ask",
      "off",
    ]);

    // Policies survive a restart.
    const reopened = await openMcpRegistry({
      dataRoot,
      redirectUrl: "https://assistant.example/mcp/callback",
      createTransport: fake.createTransport,
    });
    expect(reopened.get(added.id)?.tools.map((tool) => tool.policy)).toEqual([
      "ask",
      "off",
    ]);
  });

  it("calls a tool and returns its text", async () => {
    const dataRoot = await tempDirectory();
    const fake = fakeServer({
      current: [{ name: "search", description: "Search" }],
    });
    const registry = await openMcpRegistry({
      dataRoot,
      redirectUrl: "https://assistant.example/mcp/callback",
      createTransport: fake.createTransport,
    });
    const server = await registry.add({
      label: "Wiki",
      url: "https://mcp.example.com/mcp",
      auth: "none",
    });
    await registry.refresh(server.id);
    await expect(
      registry.call(server.id, "search", { q: "hello" }),
    ).resolves.toEqual({ text: "ran search", isError: false });
    expect(fake.calls).toEqual([{ name: "search", arguments: { q: "hello" } }]);
  });

  it("keeps a header secret sealed on disk and never in servers.json", async () => {
    const dataRoot = await tempDirectory();
    const fake = fakeServer({ current: [] });
    const registry = await openMcpRegistry({
      dataRoot,
      redirectUrl: "https://assistant.example/mcp/callback",
      createTransport: fake.createTransport,
    });
    const secret = "Bearer sk-very-secret-value";
    const server = await registry.add({
      label: "Tracker",
      url: "https://mcp.example.com/mcp",
      auth: "header",
      headerName: "Authorization",
      headerValue: secret,
    });
    expect(registry.hasCredentials(server.id)).toBe(true);
    await registry.refresh(server.id);
    expect(fake.headersSeen.at(-1)).toEqual({ Authorization: secret });

    const servers = await fs.readFile(
      path.join(dataRoot, "mcp", "servers.json"),
      "utf8",
    );
    const sealed = await fs.readFile(
      path.join(dataRoot, "credentials", "mcp", "secrets.json"),
      "utf8",
    );
    expect(servers).not.toContain("sk-very-secret");
    expect(sealed).not.toContain("sk-very-secret");
    expect(JSON.stringify(registry.get(server.id))).not.toContain(
      "sk-very-secret",
    );

    // Reopened with the same key, the secret is still there.
    const reopened = await openMcpRegistry({
      dataRoot,
      redirectUrl: "https://assistant.example/mcp/callback",
      createTransport: fake.createTransport,
    });
    expect(reopened.hasCredentials(server.id)).toBe(true);
    await reopened.remove(server.id);
    expect(reopened.hasCredentials(server.id)).toBe(false);
  });

  it("refuses addresses that are not public HTTPS", async () => {
    const registry = await openMcpRegistry({
      dataRoot: await tempDirectory(),
      redirectUrl: "https://assistant.example/mcp/callback",
    });
    for (const url of [
      "http://mcp.example.com/mcp",
      "https://localhost/mcp",
      "https://127.0.0.1/mcp",
      "https://192.168.1.5/mcp",
      "https://command-worker/mcp",
    ]) {
      await expect(
        registry.add({ label: "Bad", url, auth: "none" }),
      ).rejects.toMatchObject({ code: "mcp_url_invalid" });
    }
  });

  it("contacts only the saved host", async () => {
    const requested: string[] = [];
    const registry = await openMcpRegistry({
      dataRoot: await tempDirectory(),
      redirectUrl: "https://assistant.example/mcp/callback",
      fetch: async (input) => {
        requested.push(
          new URL(input instanceof Request ? input.url : input.toString()).host,
        );
        // Point the client somewhere else.
        return new Response(null, {
          status: 307,
          headers: { location: "https://elsewhere.example/" },
        });
      },
    });
    const server = await registry.add({
      label: "Wiki",
      url: "https://mcp.example.com/mcp",
      auth: "none",
    });
    const result = await registry.refresh(server.id);
    expect(result.server.status).toBe("error");
    expect(requested.every((host) => host === "mcp.example.com")).toBe(true);
  });
});

describe("isPublicHttps", () => {
  it.each([
    ["https://mcp.notion.com/mcp", true],
    ["https://8.8.8.8/", true],
    ["http://mcp.notion.com/mcp", false],
    ["https://user:pass@mcp.notion.com/", false],
    ["https://10.0.0.1/", false],
    ["https://172.20.0.1/", false],
    ["https://169.254.169.254/", false],
    ["https://100.64.0.1/", false],
    ["https://[::1]/", false],
    ["https://[fd00::1]/", false],
    ["https://app.localhost/", false],
    ["https://runner/", false],
  ])("%s → %s", (url, expected) => {
    expect(isPublicHttps(new URL(url))).toBe(expected);
  });
});
