import { describe, expect, it, vi } from "vitest";

import type { HostToolResolveRequest } from "@agentlink/core";
import type {
  McpHubOAuthProvider,
  McpServerConfig,
} from "@agentlink/node-host";
import {
  createWorkspaceSharedMcpTools,
  type CreateWorkspaceSharedMcpToolsOptions,
} from "./sharedMcpTools.js";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(async () => undefined),
  callTool: vi.fn(async () => ({
    content: [{ type: "text", text: "server result" }],
  })),
  disconnectAll: vi.fn(async () => undefined),
  readResource: vi.fn(async () => ({
    content: [{ type: "text", text: "resource text" }],
  })),
  getPrompt: vi.fn(async () => ({
    content: [{ type: "text", text: "prompt text" }],
  })),
  hub: vi.fn(),
  instance: undefined as unknown,
}));

vi.mock("@agentlink/node-host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@agentlink/node-host")>();
  return {
    ...actual,
    McpClientHub: class {
      constructor(...args: unknown[]) {
        mocks.hub(...args);
        mocks.instance = this;
      }
      connect = mocks.connect;
      getToolDefs = () => [
        {
          name: "records__lookup",
          description: "Look up a record",
          input_schema: { type: "object", properties: {} },
        },
      ];
      callTool = mocks.callTool;
      readResource = mocks.readResource;
      getPrompt = mocks.getPrompt;
      getAllResources = () => [
        { serverName: "records", uri: "test://item", name: "Item" },
      ];
      getAllPrompts = () => [{ serverName: "records", name: "summary" }];
      onElicitation?: (
        request: { serverName: string; message: string; fields: never[] },
        resolve: (values: Record<string, unknown>) => void,
        cancel: () => void,
      ) => void;
      onStatusChange?: (servers: unknown[]) => void;
      disconnectAll = mocks.disconnectAll;
    },
  };
});

const request: HostToolResolveRequest = {
  principal: { tenantId: "tenant", subjectId: "user" },
  sessionId: "session",
  turnId: "turn",
  input: { text: "look up a record", attachments: undefined },
};
const executionContext = {
  ...request,
  model: {
    model: { providerId: "fixture", modelId: "fixture-model" },
    source: "runtime" as const,
  },
  signal: new AbortController().signal,
};
const config: McpServerConfig = {
  name: "records",
  type: "streamable-http",
  url: "https://example.test/mcp",
};

function fixture(resolveConfigs = async () => [config]) {
  const authorizeLaunch = vi.fn(async () => true);
  const authorizeNetwork = vi.fn(async () => true);
  mocks.connect.mockImplementation(async () => undefined);
  mocks.callTool.mockImplementation(async () => ({
    content: [{ type: "text", text: "server result" }],
  }));
  const tools = createWorkspaceSharedMcpTools({
    secret: "test-secret",
    resolveConfigs,
    baseEnvironment: () => ({}),
    fetch: vi.fn<typeof globalThis.fetch>(),
    authorizeAdmission: async () => true,
    authorizeLaunch,
    authorizeNetwork,
    clientVersion: "test",
  });
  return { tools, authorizeLaunch, authorizeNetwork };
}

describe("shared MCP workspace tools", () => {
  it("lists and reads resources and prompts from the active MCP turn", async () => {
    vi.clearAllMocks();
    const { tools } = fixture();
    const resolved = await tools.resolveTools(request);
    if (Array.isArray(resolved)) throw new Error("Missing lifecycle disposer");
    const byName = (name: string) =>
      resolved.tools.find((tool) => tool.definition.name === name)!;
    expect(
      (await byName("list_mcp_resources").execute({}, executionContext))
        .modelContent,
    ).toContain("test://item");
    expect(
      (await byName("list_mcp_prompts").execute({}, executionContext))
        .modelContent,
    ).toContain("summary");
    expect(
      (
        await byName("read_mcp_resource").execute(
          { server: "records", uri: "test://item" },
          executionContext,
        )
      ).modelContent,
    ).toBe("resource text");
    expect(
      (
        await byName("get_mcp_prompt").execute(
          { server: "records", name: "summary" },
          executionContext,
        )
      ).modelContent,
    ).toBe("prompt text");
    expect(mocks.readResource).toHaveBeenCalledWith("records", "test://item");
    expect(mocks.getPrompt).toHaveBeenCalledWith(
      "records",
      "summary",
      undefined,
    );
    await resolved.dispose?.();
    expect(
      (
        await byName("read_mcp_resource").execute(
          { server: "records", uri: "test://item" },
          executionContext,
        )
      ).isError,
    ).toBe(true);
    await tools.close();
  });

  it("omits changed servers from catalogs and rejects malformed prompt arguments", async () => {
    vi.clearAllMocks();
    let current: McpServerConfig[] = [config];
    const { tools } = fixture(async () => current);
    const resolved = await tools.resolveTools(request);
    if (Array.isArray(resolved)) throw new Error("Missing lifecycle disposer");
    const byName = (name: string) =>
      resolved.tools.find((tool) => tool.definition.name === name)!;
    expect(
      (
        await byName("get_mcp_prompt").execute(
          { server: "records", name: "summary", arguments: { topic: 42 } },
          executionContext,
        )
      ).isError,
    ).toBe(true);
    expect(mocks.getPrompt).not.toHaveBeenCalled();
    current = [{ ...config, disabled: true }];
    expect(
      (await byName("list_mcp_resources").execute({}, executionContext))
        .modelContent,
    ).toBe("[]");
    expect(
      (await byName("list_mcp_prompts").execute({}, executionContext))
        .modelContent,
    ).toBe("[]");
    await resolved.dispose?.();
    await tools.close();
  });

  it("routes concurrent calls on one server to one elicitation owner and reports status", async () => {
    vi.clearAllMocks();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let invoked = 0;
    mocks.callTool.mockImplementation(async () => {
      invoked++;
      await held;
      return { content: [{ type: "text", text: "server result" }] };
    });
    const onElicitation = vi.fn(async () => ({
      action: "accept" as const,
      content: { answer: "ok" },
    }));
    const onStatus = vi.fn();
    const tools = createWorkspaceSharedMcpTools({
      secret: "test-secret",
      resolveConfigs: async () => [config],
      baseEnvironment: () => ({}),
      fetch: vi.fn<typeof globalThis.fetch>(),
      authorizeAdmission: async () => true,
      authorizeLaunch: async () => true,
      authorizeNetwork: async () => true,
      clientVersion: "test",
      onElicitation,
      onStatus,
    });
    const resolved = await tools.resolveTools(request);
    if (Array.isArray(resolved)) throw new Error("Missing lifecycle disposer");
    const tool = resolved.tools.find(
      (item) => item.definition.name === "records__lookup",
    )!;
    const first = tool.execute({}, executionContext);
    const second = tool.execute({}, executionContext);
    await vi.waitFor(() => expect(invoked).toBe(2));
    const hub = mocks.hub.mock.lastCall![0] as {
      notify: (level: string, message: string) => Promise<unknown>;
    };
    await hub.notify("warning", "connection notice");
    expect(onStatus).toHaveBeenCalledWith("connection notice");
    const instance = mocks.instance as
      | {
          onElicitation?: (
            input: unknown,
            resolve: (value: unknown) => void,
            cancel: () => void,
          ) => void;
        }
      | undefined;
    expect(instance).toBeDefined();
    const resolve = vi.fn();
    const cancel = vi.fn();
    instance?.onElicitation?.(
      {
        serverName: "records",
        message: "Enter answer",
        fields: [{ name: "answer", kind: "string", required: true }],
      },
      resolve,
      cancel,
    );
    await vi.waitFor(() =>
      expect(resolve).toHaveBeenCalledWith({ answer: "ok" }),
    );
    expect(cancel).not.toHaveBeenCalled();
    release();
    await Promise.all([first, second]);
    await resolved.dispose?.();
    await tools.close();
  });

  it("binds admission, tool policy and disposal to the resolving turn", async () => {
    vi.clearAllMocks();
    const { tools, authorizeNetwork } = fixture();
    mocks.connect.mockImplementation(async () => {
      const [host] = mocks.hub.mock.lastCall!;
      expect(host.getRequestContext()).toEqual(request);
      expect(
        await host.authorizeNativeConnection({
          config,
          context: request,
          transport: "streamable-http",
          url: config.url,
        }),
      ).toBe(true);
    });
    const resolved = await tools.resolveTools(request);
    expect(Array.isArray(resolved)).toBe(false);
    if (Array.isArray(resolved)) throw new Error("Missing lifecycle disposer");
    const [host, , policy] = mocks.hub.mock.lastCall!;
    expect(host.getRequestContext()).toBeUndefined();
    expect(authorizeNetwork).toHaveBeenCalledWith(
      expect.objectContaining({
        serverId: "records",
        destination: "https://example.test/mcp",
      }),
      request,
    );
    expect(
      await policy.onBeforeToolCall({
        context: request,
        config,
        bareToolName: "lookup",
        approvedByCaller: true,
      }),
    ).toBe("allow");
    const proposed = await tools.toolApproval("records__lookup", { id: 1 });
    expect(proposed).toMatchObject({
      kind: "shared_mcp_tool_call",
      serverToolName: "lookup",
    });
    const changed = await tools.toolApproval("records__lookup", { id: 2 });
    expect(changed?.operationDigest).not.toBe(proposed?.operationDigest);
    expect(await tools.toolPolicy(proposed!)).toBe("ask");
    await resolved.dispose?.();
    expect(mocks.disconnectAll).not.toHaveBeenCalled();
    await tools.close();
    expect(mocks.disconnectAll).toHaveBeenCalledOnce();
  });

  it("rejects project definitions before transport admission when project trust is denied", async () => {
    vi.clearAllMocks();
    const projectConfig: McpServerConfig = {
      ...config,
      sourceProjectRoots: ["/project"],
    };
    const authorizeAdmission = vi.fn(async () => false);
    const authorizeNetwork = vi.fn(async () => true);
    const tools = createWorkspaceSharedMcpTools({
      secret: "test-secret",
      resolveConfigs: async () => [projectConfig],
      baseEnvironment: () => ({}),
      fetch: vi.fn<typeof globalThis.fetch>(),
      authorizeAdmission,
      authorizeLaunch: async () => true,
      authorizeNetwork,
      clientVersion: "test",
    });
    mocks.connect.mockImplementation(async () => {
      const [host] = mocks.hub.mock.lastCall!;
      expect(
        await host.authorizeNativeConnection({
          config: projectConfig,
          context: request,
          transport: "streamable-http",
          url: projectConfig.url,
        }),
      ).toBe(false);
    });
    const resolved = await tools.resolveTools(request);
    if (Array.isArray(resolved)) throw new Error("Missing lifecycle disposer");
    expect(authorizeAdmission).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "shared_mcp_project_admission",
        serverId: "records",
        projectRoot: "/project",
      }),
      request,
    );
    expect(authorizeNetwork).not.toHaveBeenCalled();
    await resolved.dispose?.();
    await tools.close();
  });

  it("keeps connections across turns without retaining old turn authority", async () => {
    vi.clearAllMocks();
    const { tools } = fixture();
    let staleFetch: (() => Promise<Response>) | undefined;
    mocks.connect.mockImplementation(async () => {
      const [host] = mocks.hub.mock.lastCall!;
      const native = host.createNativeFetch(config);
      staleFetch = () => native(config.url!);
    });
    const first = await tools.resolveTools(request);
    if (Array.isArray(first)) throw new Error("Missing lifecycle disposer");
    const [host, , policy] = mocks.hub.mock.lastCall!;
    const native = host.createNativeFetch(config);
    await first.dispose?.();
    expect(host.getRequestContext()).toBeUndefined();
    await expect(native(config.url)).rejects.toThrow(
      "mcp_remote_destination_not_authorized",
    );
    expect(
      await policy.onBeforeToolCall({
        context: request,
        config,
        bareToolName: "lookup",
        approvedByCaller: true,
      }),
    ).toBe("deny");
    const next = { ...request, turnId: "next-turn" };
    const second = await tools.resolveTools(next);
    if (Array.isArray(second)) throw new Error("Missing lifecycle disposer");
    expect(mocks.hub).toHaveBeenCalledOnce();
    expect(mocks.disconnectAll).not.toHaveBeenCalled();
    expect(host.getRequestContext()).toBeUndefined();
    await expect(staleFetch!()).rejects.toThrow(
      "mcp_remote_destination_not_authorized",
    );
    expect(
      await policy.onBeforeToolCall({
        context: request,
        config,
        bareToolName: "lookup",
        approvedByCaller: true,
      }),
    ).toBe("deny");
    expect(
      await policy.onBeforeToolCall({
        context: next,
        config,
        bareToolName: "lookup",
        approvedByCaller: true,
      }),
    ).toBe("allow");
    await second.dispose?.();
    await tools.closeSession(request.sessionId);
    expect(mocks.disconnectAll).toHaveBeenCalledOnce();
  });

  it("rejects a concurrent operation in the same session", async () => {
    vi.clearAllMocks();
    const { tools } = fixture();
    const first = await tools.resolveTools(request);
    if (Array.isArray(first)) throw new Error("Missing lifecycle disposer");
    await expect(
      tools.resolveTools({ ...request, turnId: "overlapping-turn" }),
    ).rejects.toThrow("mcp_session_operation_already_active");
    expect(mocks.hub).toHaveBeenCalledOnce();
    await first.dispose?.();
    await tools.close();
  });

  it("separates session connections and retires changed config", async () => {
    vi.clearAllMocks();
    let current = [config];
    const { tools } = fixture(async () => current);
    const first = await tools.resolveTools(request);
    if (Array.isArray(first)) throw new Error("Missing lifecycle disposer");
    await first.dispose?.();
    const child = await tools.resolveTools({
      ...request,
      sessionId: "child-session",
      turnId: "child-turn",
    });
    if (Array.isArray(child)) throw new Error("Missing lifecycle disposer");
    expect(mocks.hub).toHaveBeenCalledTimes(2);
    await child.dispose?.();
    current = [{ ...config, url: "https://changed.example.test/mcp" }];
    const next = await tools.resolveTools({ ...request, turnId: "next-turn" });
    if (Array.isArray(next)) throw new Error("Missing lifecycle disposer");
    expect(mocks.hub).toHaveBeenCalledTimes(3);
    expect(mocks.disconnectAll).toHaveBeenCalledOnce();
    await next.dispose?.();
    await tools.close();
    expect(mocks.disconnectAll).toHaveBeenCalledTimes(3);
  });

  it("uses the same native policy for proposal and dispatch", async () => {
    vi.clearAllMocks();
    let active: McpServerConfig = { ...config, allowedTools: ["lookup"] };
    const { tools } = fixture(async () => [active]);
    const approved = await tools.toolApproval("records__lookup", { id: 1 });
    expect(await tools.toolPolicy(approved!)).toBe("allow");
    const resolved = await tools.resolveTools(request);
    const [, , policy] = mocks.hub.mock.lastCall!;
    expect(
      await policy.onBeforeToolCall({
        context: request,
        config: active,
        bareToolName: "lookup",
        approvedByCaller: false,
      }),
    ).toBe("allow");
    active = { ...config, toolPolicy: "ask" };
    expect(await tools.toolPolicy(approved!)).toBe("deny");
    await resolved.dispose?.();
    await tools.close();
  });

  it("does not grant a prefix server's policy to an unaddressable server", async () => {
    vi.clearAllMocks();
    const { tools } = fixture(async () => [
      { ...config, name: "records__private", toolPolicy: "allow" },
    ]);
    expect(
      await tools.toolApproval("records__private__lookup", {}),
    ).toBeUndefined();
  });

  it("uses separate fetch paths for approved native HTTP and public OAuth", async () => {
    vi.clearAllMocks();
    const nativeFetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response("ok"),
    );
    const oauthFetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response("ok"),
    );
    const authorizeNetwork = vi.fn(async () => true);
    let oauthRequestFetch: typeof globalThis.fetch | undefined;
    const createOAuthProvider: NonNullable<
      CreateWorkspaceSharedMcpToolsOptions["createOAuthProvider"]
    > = async (_config, _turn, fetch) => {
      oauthRequestFetch = fetch;
      return {} as McpHubOAuthProvider;
    };
    const localConfig = { ...config, url: "http://127.0.0.1:8000/mcp" };
    const tools = createWorkspaceSharedMcpTools({
      secret: "test-secret",
      resolveConfigs: async () => [localConfig],
      baseEnvironment: () => ({}),
      fetch: oauthFetch,
      nativeFetch,
      authorizeAdmission: async () => true,
      authorizeLaunch: async () => true,
      authorizeNetwork,
      createOAuthProvider,
      clientVersion: "test",
    });
    mocks.connect.mockImplementation(async () => {
      const [host] = mocks.hub.mock.lastCall!;
      const native = host.createNativeFetch(localConfig);
      await native("http://127.0.0.1:8000/mcp");
      expect(nativeFetch).toHaveBeenCalledOnce();
      expect(oauthFetch).not.toHaveBeenCalled();
      const oauth = host.createOAuthProvider;
      await oauth("records", "http://127.0.0.1:8000/mcp");
      expect(oauthRequestFetch).toBeDefined();
      await expect(
        oauthRequestFetch!("http://127.0.0.1:8000/token"),
      ).rejects.toThrow("mcp_remote_destination_not_authorized");
      await oauthRequestFetch!("https://example.test/token");
    });
    const resolved = await tools.resolveTools(request);
    if (Array.isArray(resolved)) throw new Error("Missing lifecycle disposer");
    expect(nativeFetch).toHaveBeenCalledOnce();
    expect(oauthFetch).toHaveBeenCalledOnce();
    await resolved.dispose?.();
    await tools.close();
  });

  it("requires destination approval before launching mcp-remote", async () => {
    vi.clearAllMocks();
    const remote: McpServerConfig = {
      name: "records",
      command: "mcp-remote",
      args: ["https://example.test/mcp"],
    };
    const { tools, authorizeLaunch, authorizeNetwork } = fixture(async () => [
      remote,
    ]);
    mocks.connect.mockImplementation(async () => {
      const [host] = mocks.hub.mock.lastCall!;
      expect(
        await host.authorizeNativeConnection({
          config: remote,
          context: request,
          transport: "stdio",
          command: remote.command,
          args: remote.args,
          env: {},
          remoteServerUrl: remote.args?.[0],
        }),
      ).toBe(true);
    });
    const resolved = await tools.resolveTools(request);
    if (Array.isArray(resolved)) throw new Error("Missing lifecycle disposer");
    expect(authorizeNetwork).toHaveBeenCalledOnce();
    expect(authorizeLaunch).toHaveBeenCalledOnce();
    await resolved.dispose?.();
    await tools.close();
  });

  it("denies stale configs and prevents tool calls after a config change", async () => {
    vi.clearAllMocks();
    let current: McpServerConfig[] = [config];
    const { tools, authorizeNetwork } = fixture(async () => current);
    const resolved = await tools.resolveTools(request);
    if (Array.isArray(resolved)) throw new Error("Missing lifecycle disposer");
    const [host] = mocks.hub.mock.lastCall!;
    current = [];
    expect(
      await host.authorizeNativeConnection({
        config,
        context: request,
        transport: "streamable-http",
        url: config.url,
      }),
    ).toBe(false);
    expect(authorizeNetwork).not.toHaveBeenCalled();
    const proposed = await tools.toolApproval("records__lookup", { id: 1 });
    expect(proposed).toBeUndefined();
    const execution = await resolved.tools[0].execute(
      { id: 1 },
      {
        ...request,
        model: {
          model: { providerId: "fixture", modelId: "fixture-model" },
          source: "runtime",
        },
        signal: new AbortController().signal,
      },
    );
    expect(execution.isError).toBe(true);
    expect(mocks.callTool).not.toHaveBeenCalled();
    await resolved.dispose?.();
    await tools.close();
    expect(mocks.disconnectAll).toHaveBeenCalledOnce();
  });
});
