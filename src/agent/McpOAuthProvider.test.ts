import type * as http from "http";
import type * as vscode from "vscode";

import {
  McpOAuthProvider,
  cleanupOrphanedMcpOAuthState,
  renderMcpOAuthCallbackPage,
} from "./McpOAuthProvider.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { McpAuthorizationDecision } from "./mcpAuthCoordinator.js";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { getEventListeners } from "events";

const ui = vi.hoisted(() => ({
  prompt: vi.fn(),
  open: vi.fn(),
  information: vi.fn(),
}));
vi.mock("vscode", () => ({
  window: {
    showWarningMessage: ui.prompt,
    showInformationMessage: ui.information,
  },
  env: { openExternal: ui.open },
  Uri: { parse: (value: string) => value },
}));
vi.mock("@modelcontextprotocol/sdk/client/auth.js", () => ({ auth: vi.fn() }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class FakeMemento implements vscode.Memento {
  private store = new Map<string, unknown>();

  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  get<T>(key: string, defaultValue?: T): T | undefined {
    if (this.store.has(key)) return this.store.get(key) as T;
    return defaultValue;
  }

  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) {
      this.store.delete(key);
    } else {
      this.store.set(key, value);
    }
  }

  keys(): readonly string[] {
    return [...this.store.keys()];
  }
}

describe("McpOAuthProvider cancellation", () => {
  const providers: McpOAuthProvider[] = [];
  function setup() {
    const storage = new FakeMemento();
    const provider = new McpOAuthProvider(
      "notion",
      "https://mcp.notion.example",
      storage,
    );
    provider.authorizationAttempt = {
      serverName: "notion",
      serverUrl: "https://mcp.notion.example",
      serverIdentityHash: "notion-identity",
      trigger: "manual-reauth",
      userInitiated: true,
      authMode: "interactive",
      attemptId: "attempt",
      rootAttemptId: "attempt",
      retryCount: 0,
      tokenGenerationBefore: 0,
    };
    const complete = vi.fn(async () => {});
    const decision = {
      allowed: true as const,
      dialogOpenCount: 1,
      lease: { outcome: "acquired" as const, waitMs: 0, complete },
    };
    provider.onBeforeAuthorizationOpen = vi.fn(async () => decision);
    providers.push(provider);
    return { provider, storage, complete, decision };
  }
  const authorizationUrl = new URL("https://auth.example/authorize");
  const tokens = {
    access_token: "old",
    refresh_token: "refresh",
    token_type: "bearer",
  };

  beforeEach(() => {
    ui.prompt.mockReset();
    ui.open.mockReset().mockResolvedValue(true);
    ui.information.mockReset();
    vi.mocked(auth).mockReset();
  });
  afterEach(() => {
    for (const provider of providers.splice(0)) provider.stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each(["timeout", "stop"])(
    "settles the refresh prompt on %s and ignores late acceptance",
    async (end) => {
      vi.useFakeTimers();
      const { provider, complete } = setup();
      await provider.saveTokens(tokens);
      const prompt = deferred<string>();
      ui.prompt.mockReturnValue(prompt.promise);
      const result = provider.redirectToAuthorization(authorizationUrl);
      const rejected = expect(result).rejects.toMatchObject(
        end === "stop"
          ? { name: "AbortError" }
          : {
              kind: "authorization_error",
              message: expect.stringContaining(
                "manual reauthentication required",
              ),
            },
      );
      await vi.waitFor(() => expect(ui.prompt).toHaveBeenCalledOnce());
      if (end === "stop") provider.stop();
      else await vi.advanceTimersByTimeAsync(60_000);
      await rejected;
      expect(complete).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
      expect(getEventListeners(provider.signal, "abort")).toHaveLength(0);
      prompt.resolve("Reauthenticate now");
      await Promise.resolve();
      expect(ui.open).not.toHaveBeenCalled();
      expect(auth).not.toHaveBeenCalled();
    },
  );

  it.each(["redirect", "force"])(
    "releases a lease arriving after cancellation during %s acquisition",
    async (flow) => {
      const { provider, decision, complete, storage } = setup();
      const pending = deferred<McpAuthorizationDecision>();
      provider.onBeforeAuthorizationOpen = vi.fn(() => pending.promise);
      const result =
        flow === "force"
          ? provider.forceReauth()
          : provider.redirectToAuthorization(authorizationUrl);
      const rejected = expect(result).rejects.toMatchObject({
        name: "AbortError",
      });
      await vi.waitFor(() =>
        expect(provider.onBeforeAuthorizationOpen).toHaveBeenCalledOnce(),
      );
      provider.stop();
      await rejected;
      pending.resolve(decision);
      await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce());
      expect(storage.keys()).toEqual([]);
      expect(getEventListeners(provider.signal, "abort")).toHaveLength(0);
      expect(ui.open).not.toHaveBeenCalled();
      expect(auth).not.toHaveBeenCalled();
    },
  );

  it("settles callback wait on stop and removes the callback timer and listener", async () => {
    const { provider, complete } = setup();
    await provider.start();
    const server = (provider as unknown as { _server: http.Server })._server;
    vi.useFakeTimers();
    const result = provider.redirectToAuthorization(authorizationUrl);
    const rejected = expect(result).rejects.toMatchObject({
      name: "AbortError",
    });
    await vi.waitFor(() => expect(server.listenerCount("request")).toBe(1));
    provider.stop();
    await rejected;
    expect(server.listenerCount("request")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(complete).toHaveBeenCalledOnce();
    expect(auth).not.toHaveBeenCalled();
  });

  it("retains the five-minute callback deadline", async () => {
    const { provider, complete } = setup();
    await provider.start();
    const server = (provider as unknown as { _server: http.Server })._server;
    vi.useFakeTimers();
    const result = provider.redirectToAuthorization(authorizationUrl);
    const rejected = expect(result).rejects.toMatchObject({
      kind: "callback_timeout",
    });
    await vi.waitFor(() => expect(server.listenerCount("request")).toBe(1));
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await rejected;
    expect(server.listenerCount("request")).toBe(0);
    expect(complete).toHaveBeenCalledOnce();
  });

  it("completes a forceReauth lease once when cancellation interrupts its nested redirect", async () => {
    const { provider, complete } = setup();
    await provider.start();
    const server = (provider as unknown as { _server: http.Server })._server;
    vi.mocked(auth).mockImplementation(async () => {
      await provider.redirectToAuthorization(authorizationUrl);
      return "REDIRECT";
    });
    const result = provider.forceReauth();
    const rejected = expect(result).rejects.toMatchObject({
      name: "AbortError",
    });
    await vi.waitFor(() => expect(server.listenerCount("request")).toBe(1));
    provider.stop();
    await rejected;
    expect(complete).toHaveBeenCalledOnce();
    expect(provider.onBeforeAuthorizationOpen).toHaveBeenCalledOnce();
    expect(server.listenerCount("request")).toBe(0);
  });

  it("ignores late browser-launch completion after stop", async () => {
    const { provider, complete } = setup();
    const open = deferred<boolean>();
    ui.open.mockReturnValue(open.promise);
    const result = provider.redirectToAuthorization(authorizationUrl);
    const rejected = expect(result).rejects.toMatchObject({
      name: "AbortError",
    });
    await vi.waitFor(() => expect(ui.open).toHaveBeenCalledOnce());
    provider.stop();
    await rejected;
    open.resolve(true);
    await Promise.resolve();
    expect(complete).toHaveBeenCalledOnce();
    expect(auth).not.toHaveBeenCalled();
    expect(getEventListeners(provider.signal, "abort")).toHaveLength(0);
  });

  it("cannot start or save credentials after stop, including an interrupted startup", async () => {
    const { provider, storage } = setup();
    const starting = provider.start();
    provider.stop();
    await expect(starting).rejects.toMatchObject({ name: "AbortError" });
    await expect(provider.start()).rejects.toMatchObject({
      name: "AbortError",
    });
    await expect(provider.saveTokens(tokens)).rejects.toMatchObject({
      name: "AbortError",
    });
    await expect(
      provider.saveClientInformation({ client_id: "late" }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(storage.keys()).toEqual([]);
    expect(provider.redirectUrl).toContain(":0/");
  });

  it("closes a callback server when stop races its listen operation", async () => {
    const { provider } = setup();
    const starting = provider.start();
    const rejected = expect(starting).rejects.toMatchObject({
      name: "AbortError",
    });
    // Reach listen(), but stop before Node emits listening.
    for (let turn = 0; turn < 10; turn++) await Promise.resolve();
    const server = (provider as unknown as { _server: http.Server })._server;
    expect(server).toBeTruthy();
    provider.stop();
    await rejected;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(server.listening).toBe(false);
    // Node's HTTP server retains its own connection-tracking listener.
    expect(
      server.listeners("listening").map((listener) => listener.name),
    ).not.toContain("onListening");
    expect(server.listenerCount("error")).toBe(0);
    expect(provider.redirectUrl).toContain(":0/");
  });

  it("does not exchange a callback code after cancellation during the pre-exchange snapshot", async () => {
    const { provider, complete } = setup();
    await provider.start();
    const server = (provider as unknown as { _server: http.Server })._server;
    const snapshot = deferred<void>();
    const snapshotSpy = vi
      .spyOn(provider, "debugStateSnapshot")
      .mockReturnValue(snapshot.promise);
    const result = provider.redirectToAuthorization(authorizationUrl);
    const rejected = expect(result).rejects.toMatchObject({
      name: "AbortError",
    });
    await vi.waitFor(() => expect(server.listenerCount("request")).toBe(1));
    const response = await fetch(`${provider.redirectUrl}?code=test-code`);
    await response.text();
    await vi.waitFor(() => expect(snapshotSpy).toHaveBeenCalledOnce());
    provider.stop();
    await rejected;
    snapshot.resolve();
    await Promise.resolve();
    expect(auth).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledOnce();
  });

  it("aborts forceReauth fetch and rejects late token saves while releasing its lease", async () => {
    const { provider, complete, storage } = setup();
    const response = deferred<Response>();
    const fetchMock = vi.fn(() => response.promise);
    vi.stubGlobal("fetch", fetchMock);
    let lateSave: Promise<unknown> | undefined;
    vi.mocked(auth).mockImplementation(async (_provider, options) => {
      await options.fetchFn!("https://auth.example/token");
      lateSave = provider.saveTokens(tokens);
      await lateSave;
      return "AUTHORIZED";
    });
    const result = provider.forceReauth();
    const rejected = expect(result).rejects.toMatchObject({
      name: "AbortError",
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const signal = (
      fetchMock.mock.calls[0] as unknown as [unknown, RequestInit]
    )[1].signal!;
    expect(signal.aborted).toBe(false);
    provider.stop();
    await rejected;
    expect(signal.aborted).toBe(true);
    expect(complete).toHaveBeenCalledOnce();
    response.resolve(new Response());
    await vi.waitFor(() => expect(lateSave).toBeDefined());
    await expect(lateSave).rejects.toMatchObject({ name: "AbortError" });
    expect(storage.keys()).toEqual([]);
  });
});

describe("MCP OAuth callback page", () => {
  it("renders a branded auto-closing success state", () => {
    const html = renderMcpOAuthCallbackPage({ serverName: "linear" });

    expect(html).toContain("AgentLink");
    expect(html).toContain("#4EC9B0");
    expect(html).toContain("You're connected");
    expect(html).toContain("linear is now ready to use in AgentLink.");
    expect(html).toContain("window.setTimeout(() => window.close(), 1800)");
    expect(html).toContain("prefers-color-scheme: light");
  });

  it("renders and escapes a branded error state", () => {
    const html = renderMcpOAuthCallbackPage({
      serverName: '<linear & "friends">',
      oauthError: "access_denied<script>",
      oauthErrorDescription: "No <access> & try again",
    });

    expect(html).toContain("Authorization failed");
    expect(html).not.toContain("access_denied");
    expect(html).not.toContain("No &lt;access&gt; &amp; try again");
    expect(html).toContain(
      "Authorization was declined or could not be completed.",
    );
    expect(html).toContain("&lt;linear &amp; &quot;friends&quot;&gt;");
    expect(html).not.toContain("access_denied<script>");
    expect(html).toContain("window.setTimeout(() => window.close(), 8000)");
  });
});

describe("McpOAuthProvider callback port reuse", () => {
  it("reuses cached localhost redirect port when available", async () => {
    const storage = new FakeMemento();
    await storage.update("mcp_oauth_notion_client", {
      client_id: "cid",
      redirect_uris: ["http://localhost:45671/callback"],
    });

    const provider = new McpOAuthProvider(
      "notion",
      "https://mcp.notion.example",
      storage,
    );

    await provider.start();

    try {
      expect(provider.redirectUrl).toBe("http://localhost:45671/callback");
    } finally {
      provider.stop();
    }
  });

  it("falls back to ephemeral port when cached localhost redirect port is unavailable", async () => {
    const storage = new FakeMemento();
    await storage.update("mcp_oauth_notion_client", {
      client_id: "cid",
      redirect_uris: ["http://localhost:45672/callback"],
    });

    const first = new McpOAuthProvider(
      "notion",
      "https://mcp.notion.example",
      storage,
    );
    await first.start();

    const second = new McpOAuthProvider(
      "notion",
      "https://mcp.notion.example",
      storage,
    );

    try {
      await second.start();
      expect(second.redirectUrl).not.toBe("http://localhost:45672/callback");
      expect(second.redirectUrl).toMatch(/^http:\/\/localhost:\d+\/callback$/);
    } finally {
      second.stop();
      first.stop();
    }
  });
});

describe("McpOAuthProvider credential storage", () => {
  const serverUrl = "https://mcp.notion.example";
  const tokens = {
    access_token: "at",
    refresh_token: "rt",
    token_type: "bearer",
  };

  it("shares tokens between provider instances for the same server identity", async () => {
    const storage = new FakeMemento();
    const first = new McpOAuthProvider("notion", serverUrl, storage);
    await first.saveTokens(tokens);

    // A fresh provider (e.g. after a hub reload/new generation) must see the
    // same credentials — this was the reauth-loop regression.
    const second = new McpOAuthProvider("notion", serverUrl, storage);
    expect(await second.tokens()).toEqual(tokens);
  });

  it("isolates tokens between different server URLs with the same name", async () => {
    const storage = new FakeMemento();
    const first = new McpOAuthProvider("notion", serverUrl, storage);
    await first.saveTokens(tokens);

    const other = new McpOAuthProvider(
      "notion",
      "https://mcp.other.example",
      storage,
    );
    expect(await other.tokens()).toBeUndefined();
  });

  it("migrates legacy un-namespaced tokens to the server-identity key", async () => {
    const storage = new FakeMemento();
    await storage.update("mcp_oauth_notion_tokens", tokens);

    const provider = new McpOAuthProvider("notion", serverUrl, storage);
    expect(await provider.tokens()).toEqual(tokens);
    expect(storage.get("mcp_oauth_notion_tokens")).toBeUndefined();

    const migratedKey = storage
      .keys()
      .find(
        (key) => key.startsWith("mcp_oauth_notion_") && key.endsWith("_tokens"),
      );
    expect(migratedKey).toBeDefined();
  });

  it("migrates legacy ask-agent-namespaced tokens", async () => {
    const storage = new FakeMemento();
    await storage.update("mcp_oauth_ask-agent_notion_tokens", tokens);

    const provider = new McpOAuthProvider("notion", serverUrl, storage);
    expect(await provider.tokens()).toEqual(tokens);
    expect(storage.get("mcp_oauth_ask-agent_notion_tokens")).toBeUndefined();
  });

  it("does not resurrect invalidated credentials from legacy keys", async () => {
    const storage = new FakeMemento();
    await storage.update("mcp_oauth_notion_tokens", tokens);
    await storage.update("mcp_oauth_ask-agent_notion_tokens", tokens);

    const provider = new McpOAuthProvider("notion", serverUrl, storage);
    await provider.invalidateCredentials("all");

    expect(await provider.tokens()).toBeUndefined();
    expect(storage.keys()).toEqual([]);
  });

  it("cleans up orphaned generation-scoped project credentials", async () => {
    const storage = new FakeMemento();
    await storage.update("mcp_oauth_project-abc123-4_notion_tokens", tokens);
    await storage.update("mcp_oauth_project-mcp-2_notion_client", {
      client_id: "cid",
    });
    await storage.update("mcp_oauth_notion_tokens", tokens);
    await storage.update("unrelated_key", "keep");

    await cleanupOrphanedMcpOAuthState(storage);

    expect([...storage.keys()].sort()).toEqual([
      "mcp_oauth_notion_tokens",
      "unrelated_key",
    ]);
  });
});
