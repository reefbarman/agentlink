import type * as vscode from "vscode";

import { createHash } from "crypto";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import {
  ErrorCode,
  McpError,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseErrorResponse } from "@modelcontextprotocol/sdk/client/auth.js";

import { McpClientHub } from "./McpClientHub.js";
import type { McpServerConfig } from "./mcpConfig.js";

interface Page<T> {
  items: T[];
  nextCursor?: string;
}

const mocks = vi.hoisted(() => ({
  clientInfo: undefined as unknown,
  sseTransportOptions: undefined as
    | {
        fetch?: typeof globalThis.fetch;
        requestInit?: RequestInit;
      }
    | undefined,
  httpTransportOptions: undefined as
    | {
        fetch?: typeof globalThis.fetch;
        requestInit?: RequestInit;
      }
    | undefined,
  pluginSseUrl: undefined as URL | undefined,
  pluginSseTransportOptions: undefined as
    | {
        mcpFetch: typeof globalThis.fetch;
        oauthFetch: typeof globalThis.fetch;
      }
    | undefined,
  stdioTransportOptions: undefined as
    | {
        command?: string;
        args?: string[];
        env?: Record<string, string>;
        cwd?: string;
      }
    | undefined,
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
  callTool: vi.fn<(...args: unknown[]) => Promise<CallToolResult>>(
    async () => ({ content: [] }),
  ),
  connect: vi.fn(async () => {}),
  close: vi.fn(async () => {}),
  stdioTransports: [] as Array<{ onclose?: () => void }>,
  fetch: vi.fn<typeof fetch>(),
}));

vi.mock("../util/httpDispatcher.js", () => ({
  agentLinkLongPollingFetch: mocks.fetch,
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

    async connect(transport: unknown): Promise<void> {
      await mocks.connect.call(transport);
    }
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
    async callTool(...args: unknown[]): Promise<unknown> {
      return mocks.callTool(...args);
    }
    setRequestHandler(): void {}
    setNotificationHandler(): void {}
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: class MockStdioClientTransport {
    onclose?: () => void;

    constructor(options: typeof mocks.stdioTransportOptions) {
      mocks.stdioTransportOptions = options;
      mocks.stdioTransports.push(this);
    }
  },
}));
vi.mock("./AgentPluginSseClientTransport.js", () => ({
  AgentPluginSseClientTransport: class MockAgentPluginSseClientTransport {
    onclose?: () => void;

    constructor(
      url: URL,
      options: {
        mcpFetch: typeof globalThis.fetch;
        oauthFetch: typeof globalThis.fetch;
      },
    ) {
      mocks.pluginSseUrl = url;
      mocks.pluginSseTransportOptions = options;
    }
  },
}));
vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: class MockSseClientTransport {
    onclose?: () => void;

    constructor(
      _url: URL,
      options:
        | { fetch?: typeof globalThis.fetch; requestInit?: RequestInit }
        | undefined,
    ) {
      mocks.sseTransportOptions = options;
    }
  },
}));
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class MockHttpClientTransport {
    onclose?: () => void;

    constructor(
      _url: URL,
      options:
        | { fetch?: typeof globalThis.fetch; requestInit?: RequestInit }
        | undefined,
    ) {
      mocks.httpTransportOptions = options;
    }
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
    mocks.sseTransportOptions = undefined;
    mocks.httpTransportOptions = undefined;
    mocks.pluginSseUrl = undefined;
    mocks.pluginSseTransportOptions = undefined;
    mocks.stdioTransportOptions = undefined;
    mocks.stdioTransports.length = 0;
    mocks.connect.mockReset();
    mocks.connect.mockResolvedValue(undefined);
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

  it("defers cache-cold mcp-remote until an active turn", async () => {
    const configDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), "agentlink-mcp-remote-cold-"),
    );
    const remoteConfig: McpServerConfig = {
      name: "datadog",
      type: "stdio",
      command: "npx",
      args: [
        "-y",
        "mcp-remote@latest",
        "https://mcp.datadoghq.com/api/unstable/mcp-server/mcp",
      ],
      env: { MCP_REMOTE_CONFIG_DIR: configDirectory },
    };
    const hub = new McpClientHub(new FakeMemento());

    try {
      await hub.connect([remoteConfig]);

      expect(mocks.connect).not.toHaveBeenCalled();
      expect(hub.getServerConfig("datadog")).toEqual(remoteConfig);
      expect(hub.getServerInfos()).toMatchObject([
        {
          name: "datadog",
          status: "disconnected",
          error: expect.stringContaining("agent turn"),
        },
      ]);

      await hub.activatePendingInteractiveServers();
      expect(mocks.connect).toHaveBeenCalledTimes(1);
      expect(hub.getServerInfos()[0]?.status).toBe("connected");

      await hub.activatePendingInteractiveServers();
      expect(mocks.connect).toHaveBeenCalledTimes(1);
    } finally {
      await hub.disconnectAll();
      await fs.rm(configDirectory, { recursive: true, force: true });
    }
  });

  it("starts cache-warm mcp-remote during background connection", async () => {
    const configDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), "agentlink-mcp-remote-warm-"),
    );
    const serverUrl = "https://mcp.example.test/service";
    const resource = "https://api.example.test/";
    const headers = { Authorization: "Bearer fixture", "X-Tenant": "demo" };
    const authorizeParams = { audience: "datadog", prompt: "consent" };
    const clientMetadataUrl = "https://client.example.test/metadata.json";
    const tokenEndpoint = "https://auth.example.test/token";
    const parts = [
      serverUrl,
      resource,
      JSON.stringify(authorizeParams, Object.keys(authorizeParams).sort()),
      JSON.stringify(headers, Object.keys(headers).sort()),
      clientMetadataUrl,
      tokenEndpoint,
    ];
    const serverHash = createHash("md5").update(parts.join("|")).digest("hex");
    const cacheDirectory = path.join(configDirectory, "mcp-remote-v1");
    await fs.mkdir(cacheDirectory);
    await fs.writeFile(
      path.join(cacheDirectory, `${serverHash}_tokens.json`),
      JSON.stringify({
        access_token: "cached-access",
        refresh_token: "cached-refresh",
        expires_at: Date.now() - 60_000,
      }),
    );
    const hub = new McpClientHub(new FakeMemento());

    try {
      await hub.connect([
        {
          name: "warm",
          type: "stdio",
          command: "mcp-remote",
          args: [
            serverUrl,
            "--resource",
            resource,
            "--authorize-param",
            "prompt=consent",
            "--authorize-param",
            "audience=datadog",
            "--header",
            "X-Tenant:demo",
            "--header",
            "Authorization: Bearer fixture",
            "--client-metadata-url",
            clientMetadataUrl,
            "--client-credentials",
            "--token-endpoint",
            tokenEndpoint,
          ],
          env: { MCP_REMOTE_CONFIG_DIR: configDirectory },
        },
      ]);

      expect(mocks.connect).toHaveBeenCalledTimes(1);
      expect(hub.getServerInfos()[0]?.status).toBe("connected");
    } finally {
      await hub.disconnectAll();
      await fs.rm(configDirectory, { recursive: true, force: true });
    }
  });

  it("pauses a failed mcp-remote startup without scheduling a retry", async () => {
    vi.useFakeTimers();
    const hub = new McpClientHub(new FakeMemento());
    mocks.connect.mockRejectedValue(new Error("proxy startup failed"));

    try {
      await hub.connect(
        [
          {
            name: "remote",
            type: "stdio",
            command: "mcp-remote",
            args: ["https://mcp.example.test/service"],
          },
        ],
        { interactiveServerNames: new Set(["remote"]) },
      );

      expect(mocks.connect).toHaveBeenCalledTimes(1);
      expect(hub.getServerInfos()[0]).toMatchObject({
        status: "error",
        error: expect.stringContaining("Automatic startup retries are paused"),
      });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(mocks.connect).toHaveBeenCalledTimes(1);
    } finally {
      await hub.disconnectAll();
      vi.useRealTimers();
    }
  });

  it("reconnects mcp-remote after a previously healthy transport drops", async () => {
    vi.useFakeTimers();
    const hub = new McpClientHub(new FakeMemento());

    try {
      await hub.connect(
        [
          {
            name: "remote",
            type: "stdio",
            command: "mcp-remote",
            args: ["https://mcp.example.test/service"],
          },
        ],
        { interactiveServerNames: new Set(["remote"]) },
      );
      expect(mocks.connect).toHaveBeenCalledTimes(1);

      mocks.stdioTransports[0]?.onclose?.();
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() => {
        expect(mocks.connect).toHaveBeenCalledTimes(2);
        expect(hub.getServerInfos()[0]?.status).toBe("connected");
      });
    } finally {
      await hub.disconnectAll();
      vi.useRealTimers();
    }
  });

  it.each(["sse", "streamable-http"] as const)(
    "uses the long-poll fetch for %s transports",
    async (type) => {
      const hub = new McpClientHub();
      await hub.connect([
        {
          name: "fixture",
          type,
          url: "https://example.test/mcp",
        },
      ]);

      const options =
        type === "sse" ? mocks.sseTransportOptions : mocks.httpTransportOptions;
      expect(options?.fetch).toEqual(expect.any(Function));
    },
  );

  it.each(["sse", "streamable-http"] as const)(
    "forwards caller and connection cancellation to the %s fetch consumer",
    async (type) => {
      const fetchMock = mocks.fetch.mockResolvedValue(new Response());
      const hub = new McpClientHub();
      try {
        await hub.connect([
          { name: "cancel-fetch", type, url: "https://mcp.example/cancel" },
        ]);
        const options =
          type === "sse"
            ? mocks.sseTransportOptions
            : mocks.httpTransportOptions;
        const caller = new AbortController();
        await options!.fetch!("https://mcp.example/cancel", {
          signal: caller.signal,
        });
        const firstSignal = fetchMock.mock.calls[0][1]!.signal!;
        expect(firstSignal.aborted).toBe(false);
        caller.abort();
        expect(firstSignal.aborted).toBe(true);
        await options!.fetch!("https://mcp.example/cancel");
        const secondSignal = fetchMock.mock.calls[1][1]!.signal!;
        expect(secondSignal.aborted).toBe(false);
        await hub.disconnectAll();
        expect(secondSignal.aborted).toBe(true);
      } finally {
        await hub.disconnectAll();
        fetchMock.mockReset();
      }
    },
  );

  it("passes a safe OAuth registration rejection through the configured HTTP fetch", async () => {
    const hub = new McpClientHub();
    const log = vi.fn();
    hub.onLog = log;
    await hub.connect([
      {
        name: "staff-admin-dev",
        type: "http",
        url: "https://mcp.example.test/admin-mcp",
      },
    ]);
    mocks.fetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: "invalid_client_metadata",
          error_description:
            "Unsupported client authentication method, secret=hidden",
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      ),
    );

    const response = await mocks.httpTransportOptions!.fetch!(
      "https://auth.example.test/register?code=hidden",
      { method: "POST", headers: { "content-type": "application/json" } },
    );
    const error = await parseErrorResponse(response);
    expect(error.message).toContain("unsupported_client_authentication_method");
    expect(error.message).not.toContain("hidden");
    expect(log).toHaveBeenCalledWith(
      "[mcp:staff-admin-dev] oauth endpoint=registration status=400 error=invalid_client_metadata description=unsupported_client_authentication_method",
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain("hidden");
    await hub.disconnectAll();
  });

  it("keeps native HTTP transports on the stock SDK path", async () => {
    const hub = new McpClientHub();
    await hub.connect([
      {
        name: "native-sse",
        type: "sse",
        url: "https://example.test/events",
        headers: { "X-Native": "sse" },
      },
      {
        name: "native-http",
        type: "streamable-http",
        url: "https://example.test/mcp",
        headers: { "X-Native": "http" },
      },
    ]);

    expect(mocks.sseTransportOptions).toMatchObject({
      fetch: expect.any(Function),
      requestInit: { headers: { "X-Native": "sse" } },
    });
    expect(mocks.httpTransportOptions).toMatchObject({
      fetch: expect.any(Function),
      requestInit: { headers: { "X-Native": "http" } },
    });
    expect(mocks.pluginSseTransportOptions).toBeUndefined();
  });

  it("uses the dedicated SSE transport and origin-bound fetches for plugin HTTP servers", async () => {
    const provenance = {
      kind: "agent-plugin" as const,
      scope: { kind: "global" as const },
      installInstanceId: "install-a",
      packageDigest: "a".repeat(64),
      portableServerName: "fixture",
      runtimeServerName: "fixture",
    };
    const hub = new McpClientHub();
    await hub.connect([
      {
        name: "plugin-sse",
        type: "sse",
        url: "https://example.test/events",
        headers: { "X-Plugin": "sse" },
        provenance,
      },
      {
        name: "plugin-http",
        type: "streamable-http",
        url: "https://example.test/mcp",
        headers: { "X-Plugin": "http" },
        provenance: {
          ...provenance,
          portableServerName: "http",
          runtimeServerName: "plugin-http",
        },
      },
    ]);

    expect(mocks.pluginSseUrl?.href).toBe("https://example.test/events");
    expect(mocks.pluginSseTransportOptions).toMatchObject({
      mcpFetch: expect.any(Function),
      oauthFetch: expect.any(Function),
    });
    expect(mocks.pluginSseTransportOptions?.mcpFetch).not.toBe(
      mocks.pluginSseTransportOptions?.oauthFetch,
    );
    expect(mocks.sseTransportOptions).toBeUndefined();
    expect(mocks.httpTransportOptions).toMatchObject({
      fetch: expect.any(Function),
      requestInit: undefined,
    });
  });

  it("isolates a plugin HTTP transport construction failure from sibling servers", async () => {
    const hub = new McpClientHub();
    await hub.connect([
      {
        name: "invalid-plugin",
        type: "streamable-http",
        url: "http://example.test/mcp",
        provenance: {
          kind: "agent-plugin",
          scope: { kind: "global" },
          installInstanceId: "install-a",
          packageDigest: "a".repeat(64),
          portableServerName: "invalid",
          runtimeServerName: "invalid-plugin",
        },
      },
      config,
    ]);

    expect(hub.getServerInfos()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "invalid-plugin",
          status: "error",
          error: expect.stringContaining("Plain HTTP is allowed only"),
        }),
        expect.objectContaining({ name: "fixture", status: "connected" }),
      ]),
    );
  });

  it("launches plugin stdio with its bounded environment and cwd", async () => {
    const hub = new McpClientHub(new FakeMemento());
    await hub.connect([
      {
        ...config,
        env: { FIXTURE: "yes" },
        cwd: "/plugin/data/runtime",
        pluginRoot: "/plugin/package",
        pluginData: "/plugin/data",
        provenance: {
          kind: "agent-plugin",
          scope: { kind: "global" },
          installInstanceId: "install-a",
          packageDigest: "a".repeat(64),
          portableServerName: "fixture",
          runtimeServerName: "fixture",
        },
      },
    ]);

    expect(mocks.stdioTransportOptions).toMatchObject({
      command: "node",
      args: ["fixture.js"],
      cwd: "/plugin/data/runtime",
      env: {
        FIXTURE: "yes",
        PLUGIN_ROOT: "/plugin/package",
        PLUGIN_DATA: "/plugin/data",
      },
    });
  });

  it("fails plugin stdio closed without authorized root/data boundaries", async () => {
    const hub = new McpClientHub(new FakeMemento());
    await hub.connect([
      {
        ...config,
        provenance: {
          kind: "agent-plugin",
          scope: { kind: "global" },
          installInstanceId: "install-a",
          packageDigest: "a".repeat(64),
          portableServerName: "fixture",
          runtimeServerName: "fixture",
        },
      },
    ]);

    expect(hub.getServerInfos()).toMatchObject([
      {
        name: "fixture",
        status: "error",
        error: expect.stringContaining("authorized root/data boundary"),
      },
    ]);
    expect(mocks.stdioTransportOptions).toBeUndefined();
  });

  it("does not dispatch stale or policy-denied plugin tool calls", async () => {
    const isConfigCurrent = vi.fn(async () => true);
    const onBeforeToolCall = vi.fn(async () => "deny" as const);
    const hub = new McpClientHub(new FakeMemento(), "unknown", {
      isConfigCurrent,
      onBeforeToolCall,
    });
    await hub.connect([config]);
    isConfigCurrent.mockResolvedValueOnce(false);

    const stale = await hub.callTool("fixture__write", {});
    expect(stale).toMatchObject({
      isError: true,
      error: { kind: "mcp_catalog_changed" },
    });
    expect(onBeforeToolCall).not.toHaveBeenCalled();
    expect(mocks.callTool).not.toHaveBeenCalled();

    const denied = await hub.callTool("fixture__write", { value: 1 });
    expect(denied).toMatchObject({
      isError: true,
      error: { kind: "mcp_tool_not_authorized" },
    });
    expect(onBeforeToolCall).toHaveBeenCalledWith({
      serverName: "fixture",
      bareToolName: "write",
      input: { value: 1 },
      config,
      approvedByCaller: false,
    });
    expect(mocks.callTool).not.toHaveBeenCalled();
  });

  it("forwards caller approval to the hub authorization boundary", async () => {
    const onBeforeToolCall = vi.fn(async () => "allow" as const);
    const hub = new McpClientHub(new FakeMemento(), "unknown", {
      onBeforeToolCall,
    });
    await hub.connect([config]);

    await hub.callTool("fixture__write", {}, { authorizedByCaller: true });

    expect(onBeforeToolCall).toHaveBeenCalledWith(
      expect.objectContaining({ approvedByCaller: true }),
    );
    expect(mocks.callTool).toHaveBeenCalledTimes(1);
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
    expect(hub.isToolReadOnly("fixture", "read")).toBe(true);
    expect(hub.isToolReadOnly("fixture", "write")).toBe(false);
    expect(hub.getReadOnlyToolDefs().map((tool) => tool.name)).toEqual([
      "fixture__read",
    ]);
  });

  it("lets a server-wide opt-in make every MCP tool parallel-safe", async () => {
    setCatalogPages(mocks.listTools, "tools", {
      first: { items: [tool("write")] },
    });
    const hub = new McpClientHub(new FakeMemento());
    await hub.connect([{ ...config, supportsParallelToolCalls: true }]);

    expect(hub.isToolParallelSafe("fixture", "write")).toBe(true);
    expect(hub.isToolReadOnly("fixture", "write")).toBe(false);
    expect(hub.getReadOnlyToolDefs()).toEqual([]);
  });

  it("forwards the configured timeout, progress keepalives, and exact nested arguments", async () => {
    const input = {
      import_settings: {
        textureType: "Default",
        sRGBTexture: true,
        nested_values: [false, 0, "", null],
      },
    };
    const expectedArguments = structuredClone(input);
    const hub = new McpClientHub(new FakeMemento());
    await hub.connect([{ ...config, timeout: 300_000 }]);

    await hub.callTool("fixture__set_import_settings", input);

    expect(mocks.callTool).toHaveBeenCalledWith(
      {
        name: "set_import_settings",
        arguments: expectedArguments,
      },
      undefined,
      {
        timeout: 300_000,
        onprogress: expect.any(Function),
        resetTimeoutOnProgress: true,
      },
    );
  });

  it.each([undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "uses the SDK-compatible default timeout for invalid config value %s",
    async (timeout) => {
      const hub = new McpClientHub(new FakeMemento());
      await hub.connect([{ ...config, timeout }]);

      await hub.callTool("fixture__read", {});

      expect(mocks.callTool).toHaveBeenCalledWith(
        { name: "read", arguments: {} },
        undefined,
        {
          timeout: 60_000,
          onprogress: expect.any(Function),
          resetTimeoutOnProgress: true,
        },
      );
    },
  );

  it("preserves configured timeouts longer than the former HTTP deadline", async () => {
    const hub = new McpClientHub(new FakeMemento());
    await hub.connect([{ ...config, timeout: 900_000 }]);

    await hub.callTool("fixture__read", {});

    expect(mocks.callTool).toHaveBeenCalledWith(
      { name: "read", arguments: {} },
      undefined,
      {
        timeout: 900_000,
        onprogress: expect.any(Function),
        resetTimeoutOnProgress: true,
      },
    );
  });

  it("returns a structured unknown-completion result when the MCP request times out", async () => {
    const hub = new McpClientHub(new FakeMemento());
    await hub.connect([{ ...config, timeout: 300_000 }]);
    mocks.callTool.mockRejectedValueOnce(
      new McpError(ErrorCode.RequestTimeout, "Request timed out"),
    );

    const result = await hub.callTool("fixture__write", {});

    expect(result).toMatchObject({
      isError: true,
      error: {
        kind: "mcp_request_timeout",
        message: "MCP tool 'write' timed out after 300000ms.",
      },
      data: {
        error: "mcp_request_timeout",
        server: "fixture",
        tool: "write",
        timeoutMs: 300_000,
        completionState: "unknown",
        retrySafe: false,
      },
    });
  });

  it("returns a structured cancellation result when the caller aborts", async () => {
    const controller = new AbortController();
    const hub = new McpClientHub(new FakeMemento());
    await hub.connect([config]);
    controller.abort();
    mocks.callTool.mockRejectedValueOnce(
      new McpError(ErrorCode.RequestTimeout, "This call was aborted"),
    );

    const result = await hub.callTool(
      "fixture__write",
      {},
      {
        signal: controller.signal,
      },
    );

    expect(result).toMatchObject({
      isError: true,
      error: {
        kind: "mcp_request_cancelled",
        message: "MCP tool 'write' was cancelled.",
      },
      data: {
        error: "mcp_request_cancelled",
        server: "fixture",
        tool: "write",
        completionState: "unknown",
        retrySafe: false,
      },
    });
  });

  it("returns a structured unknown-completion result when the MCP connection closes", async () => {
    const hub = new McpClientHub(new FakeMemento());
    await hub.connect([config]);
    mocks.callTool.mockRejectedValueOnce(
      new McpError(ErrorCode.ConnectionClosed, "Connection closed"),
    );

    const result = await hub.callTool("fixture__write", {});

    expect(result).toMatchObject({
      isError: true,
      error: {
        kind: "mcp_connection_closed",
        message: "MCP connection closed while calling 'write'.",
      },
      data: {
        error: "mcp_connection_closed",
        server: "fixture",
        tool: "write",
        completionState: "unknown",
        retrySafe: false,
      },
    });
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
