import type * as vscode from "vscode";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { McpClientHub } from "./McpClientHub.js";
import { McpOAuthError } from "./McpOAuthProvider.js";
import type { McpServerConfig } from "./mcpConfig.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";

const mocks = vi.hoisted(() => ({
  showWarningMessage: vi.fn(
    async (
      _message: string,
      ..._items: string[]
    ): Promise<string | undefined> => undefined,
  ),
  showErrorMessage: vi.fn(
    async (
      _message: string,
      ..._items: string[]
    ): Promise<string | undefined> => undefined,
  ),
  showInformationMessage: vi.fn(
    async (
      _message: string,
      ..._items: string[]
    ): Promise<string | undefined> => undefined,
  ),
  createTransportConnect: vi.fn<() => Promise<void>>(async () => {
    throw new Error("not configured");
  }),
  createTransportClose: vi.fn(async () => {}),
  createTransportListTools: vi.fn(async () => ({ tools: [] })),
  createTransportListResources: vi.fn(async () => ({ resources: [] })),
  createTransportListPrompts: vi.fn(async () => ({ prompts: [] })),
  createTransportCallTool: vi.fn(async () => ({ content: [] })),
  providerStart: vi.fn(async () => {}),
  providerStop: vi.fn(() => {}),
  providerTokens: vi.fn<
    () => Promise<
      | {
          access_token: string;
          refresh_token?: string;
          token_type?: string;
          expires_in?: number;
        }
      | undefined
    >
  >(async () => undefined),
  providerInvalidateCredentials: vi.fn(async (_scope: string) => {}),
  providerClearTokens: vi.fn(async () => {}),
  providerForceReauth: vi.fn(async () => {}),
  providerDebugStateSnapshot: vi.fn(async (_label: string) => {}),
}));

vi.mock("vscode", async () => {
  const actual = await vi.importActual<typeof import("../__mocks__/vscode.js")>(
    "../__mocks__/vscode.js",
  );
  return {
    ...actual,
    window: {
      ...actual.window,
      showWarningMessage: mocks.showWarningMessage,
      showErrorMessage: mocks.showErrorMessage,
      showInformationMessage: mocks.showInformationMessage,
    },
  };
});

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class MockClient {
    async connect(
      transport: unknown,
      options?: { signal?: AbortSignal },
    ): Promise<void> {
      options?.signal?.throwIfAborted();
      return mocks.createTransportConnect.call(transport);
    }

    async close(): Promise<void> {
      return mocks.createTransportClose();
    }

    async listTools(): Promise<{ tools: unknown[] }> {
      return mocks.createTransportListTools();
    }

    async listResources(): Promise<{ resources: unknown[] }> {
      return mocks.createTransportListResources();
    }

    async listPrompts(): Promise<{ prompts: unknown[] }> {
      return mocks.createTransportListPrompts();
    }

    setRequestHandler(): void {
      // no-op for test
    }

    setNotificationHandler(): void {
      // no-op for test
    }

    async callTool(): Promise<{ content: unknown[] }> {
      return mocks.createTransportCallTool();
    }

    async readResource(): Promise<{ contents: unknown[] }> {
      return { contents: [] };
    }

    async getPrompt(): Promise<{ messages: unknown[] }> {
      return { messages: [] };
    }
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: class MockStdioClientTransport {
    onclose?: () => void;
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: class MockSSEClientTransport {
    onclose?: () => void;
    authProvider?: { suppressRefreshTokenReauthPrompt?: boolean };

    constructor(
      _url: URL,
      options?: {
        authProvider?: { suppressRefreshTokenReauthPrompt?: boolean };
      },
    ) {
      this.authProvider = options?.authProvider;
    }
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class MockStreamableHttpClientTransport {
    onclose?: () => void;
    authProvider?: { suppressRefreshTokenReauthPrompt?: boolean };

    constructor(
      _url: URL,
      options?: {
        authProvider?: { suppressRefreshTokenReauthPrompt?: boolean };
      },
    ) {
      this.authProvider = options?.authProvider;
    }
  },
}));

vi.mock("./McpOAuthProvider.js", async () => {
  const actual = await vi.importActual<typeof import("./McpOAuthProvider.js")>(
    "./McpOAuthProvider.js",
  );
  return {
    ...actual,
    McpOAuthProvider: class MockMcpOAuthProvider {
      private controller = new AbortController();
      get signal(): AbortSignal {
        return this.controller.signal;
      }
      onLog?: (message: string) => void;
      onBeforeAuthorizationOpen?: (...args: unknown[]) => unknown;
      onTokensSaved?: (...args: unknown[]) => unknown;
      readTokenGeneration?: (...args: unknown[]) => unknown;
      onAuthEvent?: (...args: unknown[]) => unknown;
      authorizationAttempt?: { authMode: "interactive" | "noninteractive" };
      suppressRefreshTokenReauthPrompt = false;

      constructor(
        _serverName: string,
        _serverUrl: string,
        _storage: vscode.Memento,
      ) {}

      async start(): Promise<void> {
        await mocks.providerStart();
      }

      stop(): void {
        this.controller.abort();
        mocks.providerStop();
      }

      async tokens() {
        return mocks.providerTokens();
      }

      async invalidateCredentials(
        _scope: "all" | "client" | "tokens" | "verifier" | "discovery",
      ): Promise<void> {
        await mocks.providerInvalidateCredentials(_scope);
      }

      async clearTokens(): Promise<void> {
        await mocks.providerClearTokens();
      }

      async forceReauth(): Promise<void> {
        await mocks.providerForceReauth();
      }

      async debugStateSnapshot(_label: string): Promise<void> {
        await mocks.providerDebugStateSnapshot(_label);
      }
    },
  };
});

class FakeMemento implements vscode.Memento {
  private store = new Map<string, unknown>();

  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  get<T>(key: string, defaultValue?: T): T | undefined {
    if (this.store.has(key)) {
      return this.store.get(key) as T;
    }
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

describe("McpClientHub OAuth recovery", () => {
  const notionCfg: McpServerConfig = {
    name: "notion",
    type: "http",
    url: "https://mcp.notion.example",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createTransportConnect.mockReset();
    mocks.createTransportCallTool.mockReset();
    mocks.providerTokens.mockReset();
    mocks.providerInvalidateCredentials.mockReset();
    mocks.providerForceReauth.mockReset();
  });

  it("cancels a queued connection without running it or blocking the next hub", async () => {
    let release!: () => void;
    mocks.createTransportConnect
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      )
      .mockResolvedValue(undefined);
    const first = new McpClientHub(new FakeMemento());
    const cancelled = new McpClientHub(new FakeMemento());
    const next = new McpClientHub(new FakeMemento());
    const firstRun = first.connect([notionCfg]);
    await vi.waitFor(() =>
      expect(mocks.createTransportConnect).toHaveBeenCalledTimes(1),
    );
    const cancelledRun = cancelled.connect([notionCfg]);
    await vi.waitFor(() =>
      expect(cancelled.getServerInfos()[0]?.status).toBe("connecting"),
    );
    await cancelled.disableServer(notionCfg.name);
    await cancelledRun;
    const nextRun = next.connect([notionCfg]);
    expect(mocks.createTransportConnect).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([firstRun, nextRun]);
    expect(mocks.createTransportConnect).toHaveBeenCalledTimes(2);
    expect(cancelled.getServerInfos()[0]?.status).toBe("disabled");
    expect(next.getServerInfos()[0]?.status).toBe("connected");
    await Promise.all([
      first.disconnectAll(),
      cancelled.disconnectAll(),
      next.disconnectAll(),
    ]);
  });

  it("does not retry or publish a late connect failure after disconnect", async () => {
    let fail!: (error: Error) => void;
    mocks.createTransportConnect.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          fail = reject;
        }),
    );
    const hub = new McpClientHub(new FakeMemento());
    const run = hub.connect([notionCfg]);
    await vi.waitFor(() =>
      expect(mocks.createTransportConnect).toHaveBeenCalledTimes(1),
    );
    await hub.disconnectAll();
    await run;
    fail(new UnauthorizedError());
    await Promise.resolve();
    expect(hub.getServerInfos()).toEqual([]);
    expect(mocks.showWarningMessage).not.toHaveBeenCalled();
    expect(mocks.createTransportConnect).toHaveBeenCalledTimes(1);
  });

  it("cancels startup before the provider can register a late connection", async () => {
    let release!: () => void;
    mocks.providerStart.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const hub = new McpClientHub(new FakeMemento());
    const run = hub.connect([notionCfg]);
    await vi.waitFor(() =>
      expect(mocks.providerStart).toHaveBeenCalledTimes(1),
    );
    await hub.disableServer(notionCfg.name);
    release();
    await run;
    expect(mocks.providerStop).toHaveBeenCalledTimes(1);
    expect(mocks.createTransportConnect).not.toHaveBeenCalled();
    expect(hub.getServerInfos()[0]?.status).toBe("disabled");
    await hub.disconnectAll();
  });

  it("tracks manual reauthentication before it finishes and prevents a cancelled handoff", async () => {
    mocks.createTransportConnect.mockResolvedValue(undefined);
    let release!: () => void;
    mocks.providerForceReauth.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const hub = new McpClientHub(new FakeMemento());
    await hub.connect([notionCfg]);
    const reauth = hub.reauthenticateServer(notionCfg.name);
    await vi.waitFor(() =>
      expect(mocks.providerForceReauth).toHaveBeenCalledTimes(1),
    );
    await hub.disableServer(notionCfg.name);
    await reauth;
    release();
    await Promise.resolve();
    expect(mocks.createTransportConnect).toHaveBeenCalledTimes(1);
    expect(hub.getServerInfos()[0]?.status).toBe("disabled");
    await hub.disconnectAll();
  });

  it("clears cached oauth client registration (not all credentials) on stale_client_redirect and schedules recovery", async () => {
    mocks.providerTokens.mockResolvedValue({
      access_token: "a",
      refresh_token: "r",
      token_type: "bearer",
    });
    mocks.createTransportConnect.mockRejectedValueOnce(
      new McpOAuthError(
        "stale_client_redirect",
        "stale redirect uri/client registration",
      ),
    );

    const hub = new McpClientHub(new FakeMemento());
    await hub.connect([notionCfg]);

    expect(mocks.providerInvalidateCredentials).toHaveBeenCalledTimes(1);
    expect(mocks.providerInvalidateCredentials).toHaveBeenCalledWith("client");
    expect(mocks.showWarningMessage).toHaveBeenCalledWith(
      "AgentLink: Authentication did not succeed for 'notion' (redirect URI/client registration mismatch). Retrying once with fresh OAuth client registration…",
    );
    expect(hub.getServerInfos().find((s) => s.name === "notion")?.status).toBe(
      "error",
    );
  });

  it("pauses retries on a rejected OAuth client registration and keeps Reconnect working", async () => {
    class InvalidClientMetadataError extends Error {
      readonly errorCode = "invalid_client_metadata";
      constructor() {
        super("redacted");
        this.name = "InvalidClientMetadataError";
      }
    }
    mocks.createTransportConnect.mockRejectedValueOnce(
      new InvalidClientMetadataError(),
    );

    const hub = new McpClientHub(new FakeMemento());
    const logs: string[] = [];
    hub.onLog = (message) => logs.push(message);
    await hub.connect([notionCfg]);

    const info = hub.getServerInfos().find((s) => s.name === "notion");
    expect(info?.status).toBe("error");
    expect(info?.error).toBe(
      "OAuth client registration was rejected (invalid_client_metadata) for 'notion'. Automatic retries are paused. Use Reconnect or Reauthenticate to try again.",
    );
    expect(logs.some((line) => line.includes("scheduling reconnect"))).toBe(
      false,
    );
    expect(mocks.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining(
        "OAuth client registration was rejected (invalid_client_metadata)",
      ),
      "Reauthenticate",
    );
    expect(mocks.createTransportConnect).toHaveBeenCalledTimes(1);

    mocks.createTransportConnect.mockResolvedValue(undefined);
    await hub.reconnectServer("notion");
    expect(mocks.createTransportConnect).toHaveBeenCalledTimes(2);
    expect(hub.getServerInfos().find((s) => s.name === "notion")?.status).toBe(
      "connected",
    );
    await hub.disconnectAll();
  });

  it("stops temporary oauth provider if connect handoff does not reach connected", async () => {
    mocks.providerForceReauth.mockResolvedValue(undefined);
    mocks.createTransportConnect.mockRejectedValue(
      new Error("still unauthorized"),
    );

    const hub = new McpClientHub(new FakeMemento());
    await hub.connect([notionCfg]);

    const stopsBeforeReauth = mocks.providerStop.mock.calls.length;
    await hub.reauthenticateServer("notion");

    expect(mocks.providerForceReauth).toHaveBeenCalledTimes(1);
    expect(mocks.providerStop.mock.calls.length).toBeGreaterThan(
      stopsBeforeReauth,
    );
    expect(hub.getServerInfos().find((s) => s.name === "notion")?.status).toBe(
      "error",
    );
  });

  it("marks server as auth-error and clears stale client registration when runtime call hits redirect mismatch", async () => {
    mocks.createTransportConnect.mockResolvedValue(undefined);
    mocks.createTransportCallTool.mockRejectedValueOnce(
      new McpOAuthError(
        "stale_client_redirect",
        'OAuth client registration for "notion" does not match the active redirect URI',
      ),
    );

    const hub = new McpClientHub(new FakeMemento());
    const statusSnapshots: Array<ReturnType<typeof hub.getServerInfos>> = [];
    hub.onStatusChange = (infos) => {
      statusSnapshots.push(infos);
    };

    await hub.connect([notionCfg]);

    await hub.callTool("notion__get_page", { id: "p" });
    await vi.waitFor(() => {
      expect(
        hub.getServerInfos().find((server) => server.name === "notion")?.status,
      ).toBe("connected");
    });

    expect(mocks.providerInvalidateCredentials).toHaveBeenCalledWith("client");
    expect(
      statusSnapshots.some((infos) => {
        const notion = infos.find((s) => s.name === "notion");
        return (
          notion?.status === "error" &&
          notion.error?.includes("redirect URI/client registration mismatch")
        );
      }),
    ).toBe(true);
  });

  it("defers interactive reauth prompt when startup refresh-token fallback needs manual auth", async () => {
    mocks.createTransportConnect.mockImplementationOnce(
      async function (this: {
        authProvider?: { suppressRefreshTokenReauthPrompt?: boolean };
      }) {
        if (!this.authProvider?.suppressRefreshTokenReauthPrompt) {
          await mocks.showWarningMessage(
            'AgentLink: Automatic token refresh failed for "notion". Reauthenticate to continue.',
            "Reauthenticate now",
          );
        }
        throw new McpOAuthError(
          "authorization_error",
          'OAuth authorization blocked for "notion": manual reauthentication required after refresh token failure',
        );
      },
    );

    const hub = new McpClientHub(new FakeMemento());
    await hub.connect([notionCfg]);

    expect(mocks.showWarningMessage).not.toHaveBeenCalledWith(
      'AgentLink: Automatic token refresh failed for "notion". Reauthenticate to continue.',
      "Reauthenticate now",
    );
    expect(hub.getServerInfos().find((s) => s.name === "notion")?.status).toBe(
      "error",
    );
    expect(
      hub.getServerInfos().find((s) => s.name === "notion")?.error,
    ).toContain("Use Reauthenticate to try again");
  });

  it("keeps startup after-auth retry non-interactive when saved tokens are rejected", async () => {
    mocks.providerTokens.mockResolvedValue({
      access_token: "fresh",
      refresh_token: "refresh",
      token_type: "bearer",
    });
    mocks.createTransportConnect
      .mockRejectedValueOnce(new UnauthorizedError())
      .mockImplementationOnce(
        async function (this: {
          authProvider?: {
            authorizationAttempt?: {
              authMode: "interactive" | "noninteractive";
            };
            suppressRefreshTokenReauthPrompt?: boolean;
          };
        }) {
          expect(this.authProvider?.authorizationAttempt?.authMode).toBe(
            "noninteractive",
          );
          expect(this.authProvider?.suppressRefreshTokenReauthPrompt).toBe(
            false,
          );
          throw new McpOAuthError(
            "authorization_error",
            'OAuth authorization blocked for "notion": manual reauthentication required after refresh token failure',
          );
        },
      );

    const hub = new McpClientHub(new FakeMemento());
    await hub.connect([notionCfg]);

    expect(mocks.createTransportConnect).toHaveBeenCalledTimes(2);
    expect(mocks.showErrorMessage).toHaveBeenCalledWith(
      "AgentLink: Authentication is in manual reauthenticate mode for 'notion'. Use Reauthenticate to try again.",
      "Reauthenticate",
    );
    expect(mocks.showWarningMessage).not.toHaveBeenCalledWith(
      'AgentLink: Automatic token refresh failed for "notion". Reauthenticate to continue.',
      "Reauthenticate now",
    );
  });

  it("starts interactive reauthentication from the manual-auth notification action", async () => {
    mocks.createTransportConnect
      .mockRejectedValueOnce(
        new McpOAuthError(
          "authorization_error",
          'OAuth authorization blocked for "notion": manual reauthentication required after refresh token failure',
        ),
      )
      .mockResolvedValueOnce(undefined);
    mocks.showErrorMessage.mockResolvedValueOnce("Reauthenticate");

    const hub = new McpClientHub(new FakeMemento());
    await hub.connect([notionCfg]);

    await vi.waitFor(() => {
      expect(mocks.providerForceReauth).toHaveBeenCalledTimes(1);
    });
    expect(mocks.showErrorMessage).toHaveBeenCalledWith(
      "AgentLink: Authentication is in manual reauthenticate mode for 'notion'. Use Reauthenticate to try again.",
      "Reauthenticate",
    );
    expect(mocks.createTransportConnect).toHaveBeenCalledTimes(2);
  });

  it("allows interactive auth for newly added MCP servers when requested", async () => {
    mocks.createTransportConnect.mockImplementationOnce(
      async function (this: {
        authProvider?: {
          authorizationAttempt?: {
            authMode: "interactive" | "noninteractive";
          };
        };
      }) {
        expect(this.authProvider?.authorizationAttempt?.authMode).toBe(
          "interactive",
        );
      },
    );

    const hub = new McpClientHub(new FakeMemento());
    await hub.connect([notionCfg], { interactiveForNewServers: true });

    expect(hub.getServerInfos().find((s) => s.name === "notion")?.status).toBe(
      "connected",
    );
  });

  it("enters manual reauth-required state when runtime auth indicates deferred refresh-token fallback", async () => {
    mocks.createTransportConnect.mockResolvedValue(undefined);
    mocks.createTransportCallTool.mockRejectedValueOnce(
      new McpOAuthError(
        "authorization_error",
        'OAuth authorization blocked for "notion": manual reauthentication required after refresh token failure',
      ),
    );

    const hub = new McpClientHub(new FakeMemento());
    await hub.connect([notionCfg]);

    await hub.callTool("notion__get_page", { id: "p" });

    expect(hub.getServerInfos().find((s) => s.name === "notion")?.status).toBe(
      "error",
    );
    expect(
      hub.getServerInfos().find((s) => s.name === "notion")?.error,
    ).toContain("Use Reauthenticate to try again");

    await hub.reauthenticateServer("notion");
    expect(mocks.providerForceReauth).toHaveBeenCalledTimes(1);
  });

  it("serializes concurrent connects to the same server URL across hubs", async () => {
    const starts: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    mocks.createTransportConnect
      .mockImplementationOnce(async () => {
        starts.push("first");
        await firstGate;
      })
      .mockImplementationOnce(async () => {
        starts.push("second");
      });

    const hubA = new McpClientHub(new FakeMemento());
    const hubB = new McpClientHub(new FakeMemento());
    const connectA = hubA.connect([notionCfg]);
    const connectB = hubB.connect([notionCfg]);

    await vi.waitFor(() => expect(starts).toEqual(["first"]));
    // Second hub's connect must wait for the first to finish so it can reuse
    // any tokens the first connect refreshed instead of racing the rotation.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(starts).toEqual(["first"]);

    releaseFirst();
    await Promise.all([connectA, connectB]);
    expect(starts).toEqual(["first", "second"]);
  });

  it("reconnects automatically on generic runtime auth failure", async () => {
    mocks.createTransportConnect.mockResolvedValue(undefined);
    mocks.createTransportCallTool.mockRejectedValueOnce(
      new McpOAuthError("authorization_error", "oauth authorization failed"),
    );

    const hub = new McpClientHub(new FakeMemento());
    await hub.connect([notionCfg]);

    await hub.callTool("notion__get_page", { id: "p" });

    expect(mocks.showWarningMessage).toHaveBeenCalledWith(
      "AgentLink: Authentication did not succeed for 'notion'. Reconnecting automatically…",
    );
  });
});
