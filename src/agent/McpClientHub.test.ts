import type * as vscode from "vscode";

import {
  ErrorCode,
  McpError,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { McpClientHub } from "./McpClientHub.js";
import type { McpServerConfig } from "./mcpConfig.js";

interface Page<T> {
  items: T[];
  nextCursor?: string;
}

const mocks = vi.hoisted(() => ({
  clientInfo: undefined as unknown,
  clientOptions: undefined as
    | {
        capabilities?: Record<string, unknown>;
        listChanged?: Record<
          string,
          { autoRefresh?: boolean; onChanged: (...args: unknown[]) => void }
        >;
      }
    | undefined,
  listTools: vi.fn(),
  listResources: vi.fn(),
  listPrompts: vi.fn(),
  callTool: vi.fn<() => Promise<CallToolResult>>(async () => ({ content: [] })),
  close: vi.fn(async () => {}),
}));

vi.mock("vscode", async () => {
  return vi.importActual<typeof import("../__mocks__/vscode.js")>(
    "../__mocks__/vscode.js",
  );
});

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class MockClient {
    constructor(info: unknown, options: typeof mocks.clientOptions) {
      mocks.clientInfo = info;
      mocks.clientOptions = options;
    }

    async connect(): Promise<void> {}
    async close(): Promise<void> {
      await mocks.close();
    }
    async listTools(params?: { cursor?: string }): Promise<unknown> {
      return mocks.listTools(params);
    }
    async listResources(params?: { cursor?: string }): Promise<unknown> {
      return mocks.listResources(params);
    }
    async listPrompts(params?: { cursor?: string }): Promise<unknown> {
      return mocks.listPrompts(params);
    }
    async callTool(): Promise<unknown> {
      return mocks.callTool();
    }
    setRequestHandler(): void {}
    setNotificationHandler(): void {}
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: class MockStdioClientTransport {
    onclose?: () => void;
  },
}));
vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: class MockSseClientTransport {
    onclose?: () => void;
  },
}));
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class MockHttpClientTransport {
    onclose?: () => void;
  },
}));

class FakeMemento implements vscode.Memento {
  get<T>(_key: string): T | undefined;
  get<T>(_key: string, defaultValue: T): T;
  get<T>(_key: string, defaultValue?: T): T | undefined {
    return defaultValue;
  }
  async update(): Promise<void> {}
  keys(): readonly string[] {
    return [];
  }
}

const config: McpServerConfig = {
  name: "fixture",
  type: "stdio",
  command: "node",
  args: ["fixture.js"],
};

function tool(name: string): Tool {
  return { name, inputSchema: { type: "object", properties: {} } };
}

function resource(name: string) {
  return { name, uri: `file:///${name}` };
}

function prompt(name: string) {
  return { name };
}

function setCatalogPages<T>(
  mock: ReturnType<typeof vi.fn>,
  key: "tools" | "resources" | "prompts",
  pages: Record<string, Page<T>>,
): void {
  mock.mockImplementation(async (params?: { cursor?: string }) => {
    const page = pages[params?.cursor ?? "first"];
    if (!page) throw new Error(`Unexpected ${key} cursor ${params?.cursor}`);
    return { [key]: page.items, nextCursor: page.nextCursor };
  });
}

async function flushRefresh(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await vi.waitFor(() => {
    expect(mocks.listTools).not.toHaveBeenCalledTimes(1);
  });
}

describe("McpClientHub protocol correctness", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.clientInfo = undefined;
    mocks.clientOptions = undefined;
    setCatalogPages(mocks.listTools, "tools", {
      first: { items: [] },
    });
    setCatalogPages(mocks.listResources, "resources", {
      first: { items: [] },
    });
    setCatalogPages(mocks.listPrompts, "prompts", {
      first: { items: [] },
    });
  });

  it("uses installed identity, truthful capabilities, and complete paginated catalogs", async () => {
    setCatalogPages(mocks.listTools, "tools", {
      first: { items: [tool("one")], nextCursor: "tools-2" },
      "tools-2": { items: [tool("two")] },
    });
    setCatalogPages(mocks.listResources, "resources", {
      first: { items: [resource("one")], nextCursor: "resources-2" },
      "resources-2": { items: [resource("two")] },
    });
    setCatalogPages(mocks.listPrompts, "prompts", {
      first: { items: [prompt("one")], nextCursor: "prompts-2" },
      "prompts-2": { items: [prompt("two")] },
    });

    const hub = new McpClientHub(new FakeMemento(), "9.8.7");
    await hub.connect([config]);

    expect(mocks.clientInfo).toEqual({
      name: "agentlink",
      title: "AgentLink",
      version: "9.8.7",
    });
    expect(mocks.clientOptions?.capabilities).toEqual({
      elicitation: { form: { applyDefaults: true }, url: {} },
    });
    expect(mocks.clientOptions?.capabilities).not.toHaveProperty("roots");
    expect(mocks.clientOptions?.capabilities).not.toHaveProperty("sampling");
    expect(mocks.clientOptions?.listChanged).toEqual({
      tools: expect.objectContaining({ autoRefresh: false }),
      resources: expect.objectContaining({ autoRefresh: false }),
      prompts: expect.objectContaining({ autoRefresh: false }),
    });
    expect(mocks.listTools).toHaveBeenNthCalledWith(1, undefined);
    expect(mocks.listTools).toHaveBeenNthCalledWith(2, { cursor: "tools-2" });
    expect(mocks.listResources).toHaveBeenNthCalledWith(2, {
      cursor: "resources-2",
    });
    expect(mocks.listPrompts).toHaveBeenNthCalledWith(2, {
      cursor: "prompts-2",
    });
    expect(hub.getToolNames()).toEqual(["fixture__one", "fixture__two"]);
    expect(hub.getAllResources().map((item) => item.name)).toEqual([
      "one",
      "two",
    ]);
    expect(hub.getAllPrompts().map((item) => item.name)).toEqual([
      "one",
      "two",
    ]);
  });

  it("treats MCP read-only annotations as per-tool parallel opt-ins", async () => {
    setCatalogPages(mocks.listTools, "tools", {
      first: {
        items: [
          {
            ...tool("read"),
            annotations: { readOnlyHint: true },
          },
          tool("write"),
        ],
      },
    });
    const hub = new McpClientHub(new FakeMemento());
    await hub.connect([config]);

    expect(hub.isToolParallelSafe("fixture", "read")).toBe(true);
    expect(hub.isToolParallelSafe("fixture", "write")).toBe(false);
  });

  it("lets a server-wide opt-in make every MCP tool parallel-safe", async () => {
    setCatalogPages(mocks.listTools, "tools", {
      first: { items: [tool("write")] },
    });
    const hub = new McpClientHub(new FakeMemento());
    await hub.connect([{ ...config, supportsParallelToolCalls: true }]);

    expect(hub.isToolParallelSafe("fixture", "write")).toBe(true);
  });

  it("validates output schemas from every paginated tool page", async () => {
    setCatalogPages(mocks.listTools, "tools", {
      first: {
        items: [
          {
            ...tool("validated"),
            outputSchema: {
              type: "object" as const,
              properties: { count: { type: "number" } },
              required: ["count"],
            },
          },
        ],
        nextCursor: "tools-2",
      },
      "tools-2": { items: [tool("plain")] },
    });
    const hub = new McpClientHub(new FakeMemento());
    await hub.connect([config]);

    mocks.callTool.mockResolvedValueOnce({
      content: [],
      structuredContent: { count: "not-a-number" },
    });
    const invalid = await hub.callTool("fixture__validated", {});
    expect(invalid).toMatchObject({
      isError: true,
      error: { kind: "mcp_protocol_error" },
    });

    mocks.callTool.mockResolvedValueOnce({
      content: [],
      structuredContent: { count: 2 },
    });
    const valid = await hub.callTool("fixture__validated", {});
    expect(valid).toMatchObject({ data: { count: 2 } });
    expect(valid.isError).toBeUndefined();
  });

  it.each([
    [
      ErrorCode.InvalidRequest,
      "Tool validated has an output schema but did not return structured content",
    ],
    [
      ErrorCode.InvalidParams,
      "Structured content does not match the tool's output schema: count must be number",
    ],
  ])(
    "classifies SDK output-schema failures as protocol errors",
    async (code, message) => {
      const hub = new McpClientHub(new FakeMemento());
      await hub.connect([config]);
      mocks.callTool.mockRejectedValueOnce(new McpError(code, message));

      const result = await hub.callTool("fixture__validated", {});

      expect(result).toMatchObject({
        isError: true,
        error: { kind: "mcp_protocol_error" },
      });
      expect(result.content[0]).toMatchObject({
        type: "text",
        text: expect.stringContaining("output schema"),
      });
    },
  );

  it("does not reclassify unrelated MCP invalid-params errors", async () => {
    const hub = new McpClientHub(new FakeMemento());
    await hub.connect([config]);
    mocks.callTool.mockRejectedValueOnce(
      new McpError(ErrorCode.InvalidParams, "Server rejected tool arguments"),
    );

    const result = await hub.callTool("fixture__validated", {});

    expect(result.isError).toBeUndefined();
    expect(result.error).toBeUndefined();
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("Server rejected tool arguments"),
    });
  });

  it("refreshes changed catalogs and preserves the last good snapshot on failure", async () => {
    setCatalogPages(mocks.listTools, "tools", {
      first: { items: [tool("old")] },
    });
    const hub = new McpClientHub(new FakeMemento());
    const statusChange = vi.fn();
    hub.onStatusChange = statusChange;
    await hub.connect([config]);
    expect(hub.getToolNames()).toEqual(["fixture__old"]);

    mocks.listTools.mockRejectedValueOnce(new Error("temporary failure"));
    mocks.clientOptions?.listChanged?.tools?.onChanged();
    await flushRefresh();
    expect(hub.getToolNames()).toEqual(["fixture__old"]);

    setCatalogPages(mocks.listTools, "tools", {
      first: { items: [tool("new")] },
    });
    mocks.clientOptions?.listChanged?.tools?.onChanged();
    await vi.waitFor(() => {
      expect(hub.getToolNames()).toEqual(["fixture__new"]);
    });
    expect(statusChange).toHaveBeenCalled();
  });

  it("coalesces a notification during refresh into one follow-up", async () => {
    const hub = new McpClientHub(new FakeMemento());
    await hub.connect([config]);
    mocks.listTools.mockClear();
    let resolveFirst: ((value: { tools: Tool[] }) => void) | undefined;
    mocks.listTools
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce({ tools: [tool("follow-up")] });

    mocks.clientOptions?.listChanged?.tools?.onChanged();
    await vi.waitFor(() => expect(mocks.listTools).toHaveBeenCalledTimes(1));
    mocks.clientOptions?.listChanged?.tools?.onChanged();
    mocks.clientOptions?.listChanged?.tools?.onChanged();
    resolveFirst?.({ tools: [tool("first-refresh")] });

    await vi.waitFor(() => {
      expect(hub.getToolNames()).toEqual(["fixture__follow-up"]);
    });
    expect(mocks.listTools).toHaveBeenCalledTimes(2);
  });

  it("does not commit a refresh after its server disconnects", async () => {
    const hub = new McpClientHub(new FakeMemento());
    await hub.connect([config]);
    let resolveRefresh: ((value: { tools: Tool[] }) => void) | undefined;
    mocks.listTools.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRefresh = resolve;
        }),
    );

    mocks.clientOptions?.listChanged?.tools?.onChanged();
    await vi.waitFor(() => expect(resolveRefresh).toBeDefined());
    const disconnect = hub.disconnectAll();
    resolveRefresh?.({ tools: [tool("late")] });
    await disconnect;

    expect(hub.getToolNames()).toEqual([]);
    expect(hub.getServerInfos()).toEqual([]);
  });

  it("terminates repeated cursors and retains the collected pages", async () => {
    setCatalogPages(mocks.listTools, "tools", {
      first: { items: [tool("one")], nextCursor: "repeat" },
      repeat: { items: [tool("two")], nextCursor: "repeat" },
    });
    const log = vi.fn();
    const hub = new McpClientHub(new FakeMemento());
    hub.onLog = log;

    await hub.connect([config]);

    expect(hub.getToolNames()).toEqual(["fixture__one", "fixture__two"]);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("tools catalog repeated cursor 'repeat'"),
    );
  });
});
