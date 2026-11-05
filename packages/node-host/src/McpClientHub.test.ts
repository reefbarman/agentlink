import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  JSONRPCMessage,
  JSONRPCRequest,
  Transport,
  TransportSendOptions,
} from "@modelcontextprotocol/client";
import {
  McpClientHub,
  MCP_SESSION_CONTEXT_EXTENSION,
  type McpHubHost,
  type McpHubOAuthProvider,
  type McpSessionContext,
} from "./McpClientHub.js";
import { createInMemoryMcpProtocolVerdictStore } from "./mcpProtocolNegotiation.js";

const SUBSCRIPTION_ID = "io.modelcontextprotocol/subscriptionId";
const uri = "test://inbox/a";
const context: McpSessionContext = {
  sessionId: "session-a",
  label: "tab-a",
  kind: "foreground",
};

/** Real SDK client, deterministic peer wire. No sockets, subprocesses or sleeps. */
class PeerTransport implements Transport {
  onmessage?: Transport["onmessage"];
  onclose?: () => void;
  onerror?: (error: Error) => void;
  readonly messages: JSONRPCMessage[] = [];
  readonly streams = new Map<
    string | number,
    TransportSendOptions | undefined
  >();
  holdListen = false;
  holdSubscribe = false;
  rejectUri?: string;
  partialFilter = false;
  closeAfterAck = false;
  sessionMeta = true;
  onRead?: (request: JSONRPCRequest) => void;
  readStarted?: () => void;
  elicitationAnswered?: () => void;

  constructor(readonly modern: boolean) {}
  async start(): Promise<void> {}
  async close(): Promise<void> {
    this.onclose?.();
  }
  async send(
    message: JSONRPCMessage,
    options?: TransportSendOptions,
  ): Promise<void> {
    this.messages.push(message);
    if (!("method" in message) && message.id === "elicit")
      this.elicitationAnswered?.();
    if (!("method" in message) || !("id" in message)) return;
    const capabilities = {
      resources: { subscribe: true, listChanged: true },
      ...(this.sessionMeta
        ? { extensions: { [MCP_SESSION_CONTEXT_EXTENSION]: {} } }
        : {}),
    };
    if (message.method === "server/discover") {
      this.result(message.id, {
        supportedVersions: ["2026-07-28"],
        capabilities,
        serverInfo: { name: "peer", version: "1" },
      });
    } else if (message.method === "initialize") {
      this.result(message.id, {
        protocolVersion: "2025-11-25",
        capabilities,
        serverInfo: { name: "peer", version: "1" },
      });
    } else if (message.method === "subscriptions/listen") {
      this.streams.set(message.id, options);
      if (!this.holdListen) this.acknowledge(message);
      if (this.closeAfterAck)
        this.streams.get(message.id)?.onRequestStreamEnd?.();
    } else if (message.method === "tools/list") {
      this.result(message.id, { tools: [] });
    } else if (message.method === "prompts/list") {
      this.result(message.id, { prompts: [] });
    } else if (message.method === "resources/list") {
      this.result(message.id, { resources: [{ name: "Inbox", uri }] });
    } else if (
      message.method === "resources/subscribe" &&
      message.params?.uri === this.rejectUri
    ) {
      this.onmessage?.({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32602, message: "private server error token=secret" },
      });
    } else if (message.method === "resources/subscribe" && this.holdSubscribe) {
      // Test resolves the request explicitly.
    } else if (message.method === "resources/read") {
      this.readStarted?.();
      if (this.onRead) this.onRead(message);
      else this.result(message.id, { contents: [{ uri, text: "snapshot" }] });
    } else {
      this.result(message.id, {});
    }
  }
  result(id: string | number, result: Record<string, unknown>): void {
    this.onmessage?.({
      jsonrpc: "2.0",
      id,
      result: {
        ...(this.modern
          ? { resultType: "complete", ttlMs: 0, cacheScope: "private" }
          : {}),
        ...result,
      },
    });
  }
  acknowledge(request: JSONRPCRequest): void {
    this.onmessage?.({
      jsonrpc: "2.0",
      method: "notifications/subscriptions/acknowledged",
      params: {
        notifications: this.partialFilter ? {} : request.params?.notifications,
        _meta: { [SUBSCRIPTION_ID]: request.id },
      },
    });
  }
  update(resourceUri: string, subscriptionId?: string | number): void {
    this.onmessage?.({
      jsonrpc: "2.0",
      method: "notifications/resources/updated",
      params: {
        uri: resourceUri,
        ...(subscriptionId === undefined
          ? {}
          : { _meta: { [SUBSCRIPTION_ID]: subscriptionId } }),
      },
    });
  }
  requests(method: string): JSONRPCRequest[] {
    return this.messages.filter(
      (message): message is JSONRPCRequest =>
        "method" in message && "id" in message && message.method === method,
    );
  }
  resourceListens(): JSONRPCRequest[] {
    return this.requests("subscriptions/listen").filter(
      (message) =>
        (message.params?.notifications as { resourceSubscriptions?: string[] })
          ?.resourceSubscriptions,
    );
  }
}

const hubs: McpClientHub[] = [];
afterEach(async () => {
  await Promise.all(hubs.splice(0).map((hub) => hub.disconnectAll()));
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function setup(
  modern: boolean,
  sessionMeta = true,
  oauthProvider?: McpHubOAuthProvider,
) {
  const peer = new PeerTransport(modern);
  peer.sessionMeta = sessionMeta;
  const host: McpHubHost = {
    authorizeNativeConnection: () => true,
    notify: async () => undefined,
    baseEnvironment: () => ({}),
    buildPluginEnvironment: (base) => base,
    fetch: globalThis.fetch,
    createNativeFetch: (_config, fetch) => fetch,
    createPluginFetch: (_url, _headers, fetch) => fetch,
    createPluginSseTransport: () => {
      throw new Error("unused");
    },
    createSchemaValidator: async () => {
      const { AjvJsonSchemaValidator } =
        await import("@modelcontextprotocol/client/validators/ajv");
      return new AjvJsonSchemaValidator();
    },
    protocolVerdicts: createInMemoryMcpProtocolVerdictStore(),
    ...(oauthProvider
      ? { createOAuthProvider: async () => oauthProvider }
      : {}),
  };
  const hub = new McpClientHub(host, "test");
  hubs.push(hub);
  const transportFactory = vi
    .spyOn(
      hub as unknown as { createTransport(): Transport },
      "createTransport",
    )
    .mockReturnValue(peer);
  const config = {
    name: "peer",
    command: "unused",
    protocol: modern ? ("2026-07-28" as const) : ("legacy" as const),
    ...(oauthProvider
      ? { type: "http" as const, url: "https://example.test/mcp" }
      : {}),
  };
  await hub.connect([config], {
    interactiveForNewServers: Boolean(oauthProvider),
  });
  expect(
    hub.getServerInfos()[0]?.status,
    JSON.stringify(hub.getServerInfos()),
  ).toBe("connected");
  return { hub, peer, transportFactory, config };
}

const callbacks = () => ({
  onUpdated: vi.fn(),
  onError: vi.fn(),
  onReconnected: vi.fn(),
});
// Notification handlers are dispatched through the SDK's promise chain.
const notificationsDrained = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe.each([true, false])("resource transport (modern=%s)", (modern) => {
  it("uses one connection, routes only watched updates and releases handles idempotently", async () => {
    const { hub, peer, transportFactory } = await setup(modern);
    const a = callbacks();
    const b = callbacks();
    const first = await hub.subscribeResources("peer", "a", [uri, uri], {
      ...a,
      sessionContext: context,
    });
    const second = await hub.subscribeResources("peer", "b", [uri], b);
    expect(transportFactory).toHaveBeenCalledTimes(1);
    if (modern) {
      const listens = peer.resourceListens();
      expect(listens).toHaveLength(2);
      expect(listens[0].params?.notifications).toEqual({
        resourceSubscriptions: [uri],
      });
      expect(listens[0].params?._meta?.[MCP_SESSION_CONTEXT_EXTENSION]).toEqual(
        context,
      );
      peer.update(uri);
      peer.update(uri, "unknown-stream");
      peer.update("test://unwatched", listens[0].id);
      peer.update(uri, listens[0].id);
    } else {
      expect(peer.requests("resources/subscribe")).toHaveLength(1);
      expect(
        peer.requests("resources/subscribe")[0].params?._meta?.[
          MCP_SESSION_CONTEXT_EXTENSION
        ],
      ).toEqual(context);
      peer.update("test://unwatched");
      peer.update(uri);
    }
    await notificationsDrained();
    expect(a.onUpdated).toHaveBeenCalledExactlyOnceWith(uri);
    expect(b.onUpdated).toHaveBeenCalledTimes(modern ? 0 : 1);
    await first.dispose();
    await first.dispose();
    if (!modern) expect(peer.requests("resources/unsubscribe")).toHaveLength(0);
    peer.update(uri, modern ? peer.resourceListens()[0].id : undefined);
    await notificationsDrained();
    expect(a.onUpdated).toHaveBeenCalledTimes(1);
    await second.dispose();
    if (!modern) expect(peer.requests("resources/unsubscribe")).toHaveLength(1);
    else {
      const cancelled = peer.messages.filter(
        (message) =>
          "method" in message && message.method === "notifications/cancelled",
      );
      expect(cancelled).toHaveLength(2);
      // The catalog subscription is still open and refreshes normally.
      const refreshed = new Promise<void>((resolve) => {
        hub.onStatusChange = () => resolve();
      });
      const catalog = peer.requests("subscriptions/listen").find(
        (message) =>
          (
            message.params?.notifications as {
              resourcesListChanged?: boolean;
            }
          )?.resourcesListChanged,
      )!;
      peer.onmessage?.({
        jsonrpc: "2.0",
        method: "notifications/resources/list_changed",
        params: { _meta: { [SUBSCRIPTION_ID]: catalog.id } },
      });
      await refreshed;
      expect(peer.requests("resources/list")).toHaveLength(2);
    }
  });

  it("replaces a session safely, and the old handle cannot remove its replacement", async () => {
    const { hub, peer } = await setup(modern);
    const old = callbacks();
    const fresh = callbacks();
    const previous = await hub.subscribeResources("peer", "a", [uri], old);
    const current = await hub.subscribeResources(
      "peer",
      "a",
      ["test://inbox/b"],
      fresh,
    );
    await previous.dispose();
    peer.update(uri, modern ? peer.resourceListens()[0].id : undefined);
    peer.update(
      "test://inbox/b",
      modern ? peer.resourceListens()[1].id : undefined,
    );
    await notificationsDrained();
    expect(old.onUpdated).not.toHaveBeenCalled();
    expect(fresh.onUpdated).toHaveBeenCalledExactlyOnceWith("test://inbox/b");
    await current.dispose();
  });

  it("restores the same definition and calls catch-up only after subscription is live", async () => {
    const { hub, peer, transportFactory } = await setup(modern);
    const events = callbacks();
    const handle = await hub.subscribeResources("peer", "a", [uri], events);
    const replacement = new PeerTransport(modern);
    transportFactory.mockReturnValue(replacement);
    const restored = new Promise<void>((resolve) =>
      events.onReconnected.mockImplementation(resolve),
    );
    await hub.reconnectServer("peer");
    await restored;
    expect(events.onReconnected).toHaveBeenCalledTimes(1);
    expect(events.onUpdated).not.toHaveBeenCalled();
    peer.update(uri, modern ? peer.resourceListens()[0].id : undefined);
    replacement.update(
      uri,
      modern ? replacement.resourceListens()[0].id : undefined,
    );
    await notificationsDrained();
    expect(events.onUpdated).toHaveBeenCalledExactlyOnceWith(uri);
    await handle.dispose();
  });

  it("aborts pending subscription acquisition when the hub is disposed", async () => {
    const { hub, peer } = await setup(modern);
    peer.holdListen = modern;
    peer.holdSubscribe = !modern;
    const events = callbacks();
    const opening = hub.subscribeResources("peer", "a", [uri], events);
    await notificationsDrained();
    await hub.disconnectAll();
    const handle = await opening;
    await handle.dispose();
    expect(events.onError).not.toHaveBeenCalled();
    expect(events.onUpdated).not.toHaveBeenCalled();
  });

  it("forwards negotiated read metadata and returns structured cancellation without I/O", async () => {
    const { hub, peer } = await setup(modern);
    expect(
      await hub.readResource("peer", uri, {
        sessionContext: context,
        interactive: false,
      }),
    ).toEqual({ content: [{ type: "text", text: "snapshot" }] });
    expect(
      peer.requests("resources/read")[0].params?._meta?.[
        MCP_SESSION_CONTEXT_EXTENSION
      ],
    ).toEqual(context);
    const controller = new AbortController();
    controller.abort(new Error("secret abort reason"));
    expect(
      await hub.readResource("peer", uri, { signal: controller.signal }),
    ).toMatchObject({
      isError: true,
      error: { kind: "mcp_request_cancelled" },
    });
    expect(peer.requests("resources/read")).toHaveLength(1);
  });

  it("cancels in-flight reads and never returns raw protocol errors", async () => {
    const { hub, peer } = await setup(modern);
    peer.onRead = () => undefined;
    const started = new Promise<void>((resolve) => {
      peer.readStarted = resolve;
    });
    const controller = new AbortController();
    const pending = hub.readResource("peer", uri, {
      signal: controller.signal,
      interactive: false,
    });
    await started;
    controller.abort("secret-token");
    expect(await pending).toMatchObject({
      isError: true,
      error: { kind: "mcp_request_cancelled" },
    });
    peer.onRead = (request) =>
      peer.onmessage?.({
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code: -32603,
          message: "https://user:password@host/?token=secret",
        },
      });
    const failed = await hub.readResource("peer", uri, { interactive: false });
    expect(failed).toMatchObject({
      isError: true,
      error: { kind: "mcp_resource_read_paused" },
    });
    expect(JSON.stringify(failed)).not.toMatch(/password|token=secret/);
  });

  it("does not send session context to servers that did not negotiate it", async () => {
    const { hub, peer } = await setup(modern, false);
    await hub.readResource("peer", uri, { sessionContext: context });
    await hub.subscribeResources("peer", "a", [uri], {
      ...callbacks(),
      sessionContext: context,
    });
    expect(
      peer.requests("resources/read")[0].params?._meta?.[
        MCP_SESSION_CONTEXT_EXTENSION
      ],
    ).toBeUndefined();
    const request = modern
      ? peer.resourceListens()[0]
      : peer.requests("resources/subscribe")[0];
    expect(
      request.params?._meta?.[MCP_SESSION_CONTEXT_EXTENSION],
    ).toBeUndefined();
  });
});

describe("resource subscription edge cases", () => {
  it("isolates a rejected legacy URI from other sessions acquiring subscriptions", async () => {
    const { hub, peer } = await setup(false);
    peer.rejectUri = "test://denied";
    const accepted = callbacks();
    const rejected = callbacks();
    const good = hub.subscribeResources("peer", "a", [uri], accepted);
    const bad = expect(
      hub.subscribeResources("peer", "b", [peer.rejectUri], rejected),
    ).rejects.toThrow("subscription unavailable");
    const handle = await good;
    await bad;
    expect(JSON.stringify(rejected.onError.mock.calls)).not.toContain(
      "token=secret",
    );
    peer.update(uri);
    peer.update(peer.rejectUri);
    await notificationsDrained();
    expect(accepted.onUpdated).toHaveBeenCalledExactlyOnceWith(uri);
    expect(accepted.onError).not.toHaveBeenCalled();
    expect(rejected.onUpdated).not.toHaveBeenCalled();
    await handle.dispose();
  });

  it.each(["changed", "disabled"])(
    "does not restore subscriptions after a definition is %s",
    async (reason) => {
      const { hub, peer, config, transportFactory } = await setup(true);
      const events = callbacks();
      await hub.subscribeResources("peer", "a", [uri], events);
      const next = new PeerTransport(true);
      transportFactory.mockReturnValue(next);
      if (reason === "disabled") await hub.disableServer("peer");
      await hub.connect(
        [{ ...config, ...(reason === "changed" ? { args: ["new"] } : {}) }],
        { reconcileChangedServers: true },
      );
      peer.update(uri, peer.resourceListens()[0].id);
      await notificationsDrained();
      expect(events.onUpdated).not.toHaveBeenCalled();
      expect(events.onReconnected).not.toHaveBeenCalled();
      expect(next.resourceListens()).toHaveLength(0);
    },
  );

  it("blocks the provider's actual browser entry during automatic reads, even with an interactive connection", async () => {
    const browser = vi.fn(async () => undefined);
    const provider = {
      signal: new AbortController().signal,
      start: async () => undefined,
      stop: () => undefined,
      redirectToAuthorization: browser,
    } as unknown as McpHubOAuthProvider;
    const { hub, peer } = await setup(true, true, provider);
    expect(provider.authorizationAttempt?.authMode).toBe("interactive");
    peer.onRead = (request) => {
      void provider.redirectToAuthorization(
        new URL("https://example.test/authorize"),
      );
      peer.result(request.id, { contents: [{ uri, text: "authenticated" }] });
    };
    const automatic = await hub.readResource("peer", uri, {
      interactive: false,
    });
    expect(automatic).toMatchObject({
      isError: true,
      error: { kind: "mcp_resource_read_paused" },
    });
    expect(browser).not.toHaveBeenCalled();
    expect(await hub.readResource("peer", uri)).toEqual({
      content: [{ type: "text", text: "authenticated" }],
    });
    expect(browser).toHaveBeenCalledTimes(1);
  });

  it("does not turn binary resources into text snapshots for automatic reads", async () => {
    const { hub, peer } = await setup(true);
    peer.onRead = (request) =>
      peer.result(request.id, {
        contents: [{ uri, blob: "YQ==", mimeType: "application/octet-stream" }],
      });
    expect(
      await hub.readResource("peer", uri, { interactive: false }),
    ).toMatchObject({
      isError: true,
      error: { kind: "mcp_resource_unsupported_content" },
    });
    expect((await hub.readResource("peer", uri)).isError).not.toBe(true);
  });

  it("reopens only a dropped modern resource stream with catch-up and stops retrying after disposal", async () => {
    const { hub, peer } = await setup(true);
    const events = callbacks();
    const handle = await hub.subscribeResources("peer", "a", [uri], events);
    vi.useFakeTimers();
    const first = peer.resourceListens()[0];
    peer.streams.get(first.id)?.onRequestStreamEnd?.();
    await vi.advanceTimersByTimeAsync(1000);
    expect(peer.resourceListens()).toHaveLength(2);
    expect(peer.requests("subscriptions/listen")).toHaveLength(3);
    expect(events.onReconnected).toHaveBeenCalledTimes(1);
    peer.update(uri, first.id);
    await notificationsDrained();
    expect(events.onUpdated).not.toHaveBeenCalled();
    const next = peer.resourceListens()[1];
    peer.streams.get(next.id)?.onRequestStreamEnd?.();
    await handle.dispose();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(peer.resourceListens()).toHaveLength(2);
  });

  it("does not announce catch-up for a reopened stream closed immediately after acknowledgement", async () => {
    const { hub, peer } = await setup(true);
    const events = callbacks();
    const handle = await hub.subscribeResources("peer", "a", [uri], events);
    vi.useFakeTimers();
    peer.closeAfterAck = true;
    peer.streams.get(peer.resourceListens()[0].id)?.onRequestStreamEnd?.();
    await vi.advanceTimersByTimeAsync(1000);
    expect(peer.resourceListens()).toHaveLength(2);
    expect(events.onReconnected).not.toHaveBeenCalled();
    await handle.dispose();
  });

  it("cancels an opening replaced modern stream and ignores a late acknowledgement", async () => {
    const { hub, peer } = await setup(true);
    peer.holdListen = true;
    const old = callbacks();
    const opening = hub.subscribeResources("peer", "a", [uri], old);
    const first = peer.resourceListens()[0];
    peer.holdListen = false;
    const fresh = callbacks();
    const current = await hub.subscribeResources("peer", "a", [uri], fresh);
    const previous = await opening;
    peer.acknowledge(first);
    await previous.dispose();
    peer.update(uri, first.id);
    peer.update(uri, peer.resourceListens()[1].id);
    await notificationsDrained();
    expect(old.onUpdated).not.toHaveBeenCalled();
    expect(old.onError).not.toHaveBeenCalled();
    expect(fresh.onUpdated).toHaveBeenCalledExactlyOnceWith(uri);
    await current.dispose();
  });

  it("rejects a partially honored modern filter without routing any updates", async () => {
    const { hub, peer } = await setup(true);
    peer.partialFilter = true;
    const events = callbacks();
    await expect(
      hub.subscribeResources("peer", "a", [uri], events),
    ).rejects.toThrow("subscription unavailable");
    peer.update(uri, peer.resourceListens()[0].id);
    await notificationsDrained();
    expect(events.onUpdated).not.toHaveBeenCalled();
    expect(events.onError).toHaveBeenCalledTimes(1);
  });

  it("serializes legacy acquisition during replacement and unsubscribes the obsolete URI", async () => {
    const { hub, peer } = await setup(false);
    peer.holdSubscribe = true;
    const first = hub.subscribeResources("peer", "a", [uri], callbacks());
    await notificationsDrained();
    const request = peer.requests("resources/subscribe")[0];
    expect(request).toBeDefined();
    const next = hub.subscribeResources(
      "peer",
      "a",
      ["test://new"],
      callbacks(),
    );
    peer.holdSubscribe = false;
    peer.result(request.id, {});
    const old = await first;
    const current = await next;
    await old.dispose();
    expect(
      peer
        .requests("resources/subscribe")
        .map((message) => message.params?.uri),
    ).toEqual([uri, "test://new"]);
    expect(
      peer
        .requests("resources/unsubscribe")
        .map((message) => message.params?.uri),
    ).toEqual([uri]);
    await current.dispose();
  });

  it("blocks modern input_required without calling the elicitation UI", async () => {
    const { hub, peer } = await setup(true);
    hub.onElicitation = vi.fn();
    peer.onRead = (request) =>
      peer.result(request.id, {
        resultType: "input_required",
        inputRequests: {
          confirm: {
            type: "elicitation",
            mode: "form",
            message: "Confirm",
            requestedSchema: { type: "object", properties: {} },
          },
        },
      });
    const result = await hub.readResource("peer", uri, { interactive: false });
    expect(result).toMatchObject({
      isError: true,
      error: { kind: "mcp_interaction_required" },
    });
    expect(hub.onElicitation).not.toHaveBeenCalled();
  });

  it("cancels legacy elicitation during an automatic read but preserves ordinary interactive reads", async () => {
    const { hub, peer } = await setup(false);
    hub.onElicitation = vi.fn((_request, resolve) => resolve({}));
    let pending: JSONRPCRequest | undefined;
    peer.onRead = (request) => {
      pending = request;
      peer.onmessage?.({
        jsonrpc: "2.0",
        id: "elicit",
        method: "elicitation/create",
        params: {
          mode: "form",
          message: "Confirm",
          requestedSchema: { type: "object", properties: {} },
        },
      });
    };
    const answered = new Promise<void>((resolve) => {
      peer.elicitationAnswered = resolve;
    });
    const automatic = hub.readResource("peer", uri, { interactive: false });
    await answered;
    peer.result(pending!.id, { contents: [{ uri, text: "must not deliver" }] });
    expect(await automatic).toMatchObject({
      isError: true,
      error: { kind: "mcp_interaction_required" },
    });
    expect(hub.onElicitation).not.toHaveBeenCalled();
    const answeredInteractively = new Promise<void>((resolve) => {
      peer.elicitationAnswered = resolve;
    });
    const interactive = hub.readResource("peer", uri);
    await answeredInteractively;
    peer.result(pending!.id, { contents: [{ uri, text: "interactive" }] });
    expect(await interactive).toEqual({
      content: [{ type: "text", text: "interactive" }],
    });
    expect(hub.onElicitation).toHaveBeenCalledTimes(1);
  });
});
