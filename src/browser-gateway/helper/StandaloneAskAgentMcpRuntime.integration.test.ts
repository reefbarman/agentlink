import { afterEach, describe, expect, it, vi } from "vitest";

import type { CreateNodeHostMcpOAuthProviderOptions } from "@agentlink/node-host";
import { InMemoryMcpCredentialRepository } from "@agentlink/core";
import type { McpServerConfig } from "../../agent/mcpConfig.js";
import { StandaloneAskAgentMcpRuntime } from "./StandaloneAskAgentMcpRuntime.js";
import { StandaloneMcpOAuthRuntime } from "./StandaloneMcpOAuthRuntime.js";

const transport = vi.hoisted(() => ({
  connect: vi.fn(async () => undefined),
  close: vi.fn(async () => undefined),
  oauth: undefined as
    | import("@modelcontextprotocol/sdk/client/auth.js").OAuthClientProvider
    | undefined,
  callTool: vi.fn(async () => ({
    content: [{ type: "text", text: "records found" }],
  })),
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    connect = transport.connect;
    close = transport.close;
    callTool = transport.callTool;
    async listTools() {
      return {
        tools: [
          {
            name: "search",
            description: "Search records",
            inputSchema: { type: "object" },
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
    setRequestHandler() {}
    setNotificationHandler() {}
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: class {},
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class {
    constructor(
      _url: URL,
      options: {
        authProvider?: import("@modelcontextprotocol/sdk/client/auth.js").OAuthClientProvider;
      },
    ) {
      transport.oauth = options.authProvider;
    }
  },
}));

let runtime: StandaloneAskAgentMcpRuntime | undefined;
afterEach(async () => {
  await runtime?.dispose();
  runtime = undefined;
  transport.oauth = undefined;
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("Desktop targeted MCP activation through the production hub", () => {
  it("keeps a cold proxy pending until targeted, then discovers and calls its tool in the same turn", async () => {
    const configs: McpServerConfig[] = [
      {
        name: "records",
        command: "npx",
        args: ["mcp-remote", "https://mcp.example.test/records"],
        env: {
          MCP_REMOTE_CONFIG_DIR: "/nonexistent-agentlink-test-mcp-cache",
        },
        toolPolicy: "allow",
      },
    ];
    runtime = new StandaloneAskAgentMcpRuntime({
      loadConfigs: async () => configs,
      resolveExecutable: async () => "/opt/bin/npx",
    });
    await runtime.start();
    expect(transport.connect).not.toHaveBeenCalled();
    expect(runtime.getServerInfos()).toEqual([
      expect.objectContaining({
        name: "records",
        status: "disconnected",
        toolCount: 0,
      }),
    ]);

    const controller = new AbortController();
    const owner = { sessionId: "session-a", turnId: "turn-a" };
    const turn = await runtime.prepareTurn({
      ...owner,
      providerId: "openai-codex",
      modelId: "test",
      signal: controller.signal,
    });
    await turn.execute("find_mcp_tools", {}, controller.signal, owner);
    expect(transport.connect).not.toHaveBeenCalled();

    const catalog = await turn.execute(
      "find_mcp_tools",
      { server: "records" },
      controller.signal,
      owner,
    );
    expect(catalog.isError, JSON.stringify(catalog)).not.toBe(true);
    expect(JSON.stringify(catalog.data)).toContain("records__search");
    expect(transport.connect).toHaveBeenCalledOnce();
    expect(runtime.getServerInfos()).toEqual([
      expect.objectContaining({
        name: "records",
        status: "connected",
        toolCount: 1,
      }),
    ]);
    const result = await turn.execute(
      "call_mcp_tool",
      { server: "records", tool: "search", input: {} },
      controller.signal,
      owner,
    );
    expect(result).toMatchObject({
      content: [{ type: "text", text: "records found" }],
    });
    expect(transport.callTool).toHaveBeenCalledOnce();

    runtime.releaseTurn(owner.sessionId, owner.turnId);
    controller.abort();
    await runtime.start();
    expect(transport.close).not.toHaveBeenCalled();
    expect(transport.connect).toHaveBeenCalledOnce();
    configs.push({ name: "second", command: "npx", toolPolicy: "allow" });
    await runtime.start();
    expect(transport.connect).toHaveBeenCalledTimes(2);
    expect(transport.close).not.toHaveBeenCalled();
    const nextOwner = { sessionId: "session-b", turnId: "turn-b" };
    const nextSignal = new AbortController().signal;
    const nextTurn = await runtime.prepareTurn({
      ...nextOwner,
      providerId: "openai-codex",
      modelId: "test",
      signal: nextSignal,
    });
    expect(nextTurn.tools.map((tool) => tool.name)).toContain(
      "records__search",
    );
    const stale = await turn.execute(
      "call_mcp_tool",
      { server: "records", tool: "search", input: {} },
      nextSignal,
      owner,
    );
    expect(stale.isError).toBe(true);
    expect(transport.callTool).toHaveBeenCalledOnce();
    const nextResult = await nextTurn.execute(
      "call_mcp_tool",
      { server: "records", tool: "search", input: {} },
      nextSignal,
      nextOwner,
    );
    expect(nextResult.isError, JSON.stringify(nextResult)).not.toBe(true);
    expect(transport.callTool).toHaveBeenCalledTimes(2);
  });

  it("parks native HTTP sign-in silently and activates it only for targeted discovery", async () => {
    const redirect = vi.fn(async () => undefined);
    runtime = new StandaloneAskAgentMcpRuntime({
      loadConfigs: async () => [
        {
          name: "private",
          type: "http",
          url: "https://100.64.0.2/mcp",
          toolPolicy: "allow",
        },
      ],
      resolveConnectionOAuthProvider: async () => ({
        redirectUrl: "http://127.0.0.1:47138/callback",
        clientMetadata: { redirect_uris: ["http://127.0.0.1:47138/callback"] },
        clientInformation: () => undefined,
        tokens: () => undefined,
        saveTokens: () => undefined,
        redirectToAuthorization: redirect,
        saveCodeVerifier: () => undefined,
        codeVerifier: () => "verifier",
      }),
    });
    const requestSignIn = async (): Promise<undefined> => {
      if (!transport.oauth) throw new Error("Missing native OAuth provider");
      await transport.oauth.redirectToAuthorization(
        new URL("https://100.64.0.2/authorize"),
      );
      return undefined;
    };
    transport.connect.mockImplementationOnce(requestSignIn);
    await runtime.start();
    expect(redirect).not.toHaveBeenCalled();
    expect(runtime.getServerInfos()).toEqual([
      expect.objectContaining({ name: "private", status: "disconnected" }),
    ]);
    const owner = { sessionId: "native-session", turnId: "native-turn" };
    const signal = new AbortController().signal;
    const turn = await runtime.prepareTurn({
      ...owner,
      providerId: "openai-codex",
      modelId: "test",
      signal,
    });
    const pending = await turn.execute("find_mcp_tools", {}, signal, owner);
    expect(JSON.stringify(pending.data)).toContain("private");
    expect(redirect).not.toHaveBeenCalled();
    transport.connect.mockImplementationOnce(requestSignIn);
    const catalog = await turn.execute(
      "find_mcp_tools",
      { server: "private" },
      signal,
      owner,
    );
    expect(catalog.isError, JSON.stringify(catalog)).not.toBe(true);
    expect(JSON.stringify(catalog.data)).toContain("private__search");
    expect(redirect).toHaveBeenCalledOnce();
    expect(runtime.getServerInfos()).toEqual([
      expect.objectContaining({ name: "private", status: "connected" }),
    ]);
  });

  it("carries native private networking and config retirement through hub and OAuth wiring", async () => {
    const origin = "https://100.64.0.2";
    const config: McpServerConfig = {
      name: "records",
      type: "http",
      url: `${origin}/admin-mcp`,
    };
    const configs = [config];
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response("ok"),
    );
    vi.stubGlobal("fetch", fetch);
    let providerOptions: CreateNodeHostMcpOAuthProviderOptions | undefined;
    const openExternal = vi.fn(async () => true);
    const oauth = new StandaloneMcpOAuthRuntime({
      port: 47138,
      openExternal,
      confirmAuthorization: async () => {
        config.disabled = true;
        return true;
      },
      createCredentialRepository: async () =>
        new InMemoryMcpCredentialRepository(),
      createOAuthProvider: (options) => {
        providerOptions = options;
        return {
          redirectUrl: options.redirectUrl,
          clientMetadata: { redirect_uris: [options.redirectUrl] },
          clientInformation: () => undefined,
          tokens: () => undefined,
          saveTokens: () => undefined,
          redirectToAuthorization: () => undefined,
          saveCodeVerifier: () => undefined,
          codeVerifier: () => "verifier",
        };
      },
    });
    runtime = new StandaloneAskAgentMcpRuntime({
      loadConfigs: async () => configs,
      resolveConnectionOAuthProvider: (request) =>
        oauth.resolveConnectionOAuthProvider(request),
    });
    try {
      await runtime.start();
      const options = providerOptions;
      if (!options?.fetch)
        throw new Error("Missing composed OAuth provider fetch");
      await options.fetch(
        `${origin}/.well-known/oauth-authorization-server/admin-mcp`,
      );
      await options.fetch(`${origin}/token`, { method: "POST" });
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(fetch).toHaveBeenLastCalledWith(
        `${origin}/token`,
        expect.objectContaining({ method: "POST" }),
      );
      await expect(
        options.fetch("http://127.0.0.1:3000/token"),
      ).resolves.toBeInstanceOf(Response);
      await expect(
        options.authorize({
          principal: { tenantId: "agentlink-desktop", subjectId: "ask-agent" },
          serverId: options.serverId,
          serverUrl: config.url!,
          authorizationUrl: `${origin}/authorize`,
          redirectUrl: options.redirectUrl,
          transactionId: "config-retirement",
          state: "opaque-state",
          timeoutMs: 1000,
        }),
      ).rejects.toThrow("standalone_mcp_oauth_config_changed");
      expect(openExternal).not.toHaveBeenCalled();
      await expect(options.fetch(`${origin}/token`)).rejects.toThrow(
        "standalone_mcp_oauth_config_changed",
      );
      expect(fetch).toHaveBeenCalledTimes(3);
    } finally {
      oauth.dispose();
    }
  });

  it.each([false, true])(
    "manually connects a pending server (reconnect: %s)",
    async (reconnect) => {
      runtime = new StandaloneAskAgentMcpRuntime({
        loadConfigs: async () => [
          {
            name: "records",
            command: "npx",
            args: ["mcp-remote", "https://mcp.example.test/records"],
            env: {
              MCP_REMOTE_CONFIG_DIR: "/nonexistent-agentlink-test-mcp-cache",
            },
          },
        ],
        resolveExecutable: async () => "/opt/bin/npx",
      });
      await runtime.connectServer(
        "records",
        new AbortController().signal,
        reconnect,
      );
      expect(transport.connect).toHaveBeenCalledOnce();
      expect(runtime.getServerInfos()).toEqual([
        expect.objectContaining({
          name: "records",
          status: "connected",
          toolCount: 1,
        }),
      ]);
    },
  );
});
