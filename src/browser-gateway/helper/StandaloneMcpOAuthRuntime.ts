import { createHash } from "node:crypto";

import { execFile } from "node:child_process";

import type {
  CreateNodeHostMcpOAuthProviderOptions,
  NodeHostMcpOAuthAuthorizationRequest,
  NodeHostMcpRemoteOAuthRequest,
  NodeHostMcpRemoteServer,
} from "@agentlink/node-host" with { "resolution-mode": "import" };
import type {
  McpCredentialRepository,
  McpPendingAuthorizationRepository,
} from "@agentlink/core";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { isSupportedStandaloneMcpOAuthDestination } from "./standaloneMcpOAuthPolicy.js";

interface PendingAuthorization {
  readonly state: string;
  readonly serverName: string;
  readonly resolve: (value: { callbackUrl: string }) => void;
  readonly reject: (error: Error) => void;
  readonly signal?: AbortSignal;
  readonly abort: () => void;
  readonly timeout: NodeJS.Timeout;
}

type StandaloneMcpCredentialRepository = McpCredentialRepository &
  McpPendingAuthorizationRepository;

export interface StandaloneMcpConnectionOAuthRequest {
  readonly principal: NodeHostMcpRemoteOAuthRequest["principal"];
  readonly server: Readonly<NodeHostMcpRemoteServer>;
  readonly url: URL;
  readonly fetch: typeof globalThis.fetch;
  readonly assertConfigurationCurrent: (() => Promise<void>) | undefined;
  readonly getAuthorizationSignal: (request: {
    readonly serverName: string;
  }) => AbortSignal | undefined;
}

export interface StandaloneMcpOAuthRuntimeOptions {
  readonly port: number;
  readonly openExternal?: (url: string) => Promise<boolean>;
  readonly confirmAuthorization?: (
    request: Readonly<NodeHostMcpOAuthAuthorizationRequest>,
  ) => Promise<boolean>;

  readonly isSafeDestination?: (url: URL) => Promise<boolean>;
  readonly createCredentialRepository?: () => Promise<StandaloneMcpCredentialRepository>;
  readonly createOAuthProvider?: (
    options: CreateNodeHostMcpOAuthProviderOptions,
  ) => OAuthClientProvider;
}

/** Service-owned standalone MCP OAuth coordination for the desktop/helper host. */
export class StandaloneMcpOAuthRuntime {
  private readonly activeAuthorizations = new Set<string>();
  private readonly authorizationSignals = new Map<string, AbortSignal>();
  private readonly pending = new Map<string, PendingAuthorization>();
  private disposed = false;
  private readonly openExternal: (url: string) => Promise<boolean>;

  private repositoryPromise:
    | Promise<StandaloneMcpCredentialRepository>
    | undefined;

  constructor(private readonly options: StandaloneMcpOAuthRuntimeOptions) {
    this.openExternal = options.openExternal ?? openMacExternal;
  }

  async resolveOAuthProvider(
    request: NodeHostMcpRemoteOAuthRequest,
  ): Promise<OAuthClientProvider> {
    return await this.resolveConnectionOAuthProvider({
      principal: request.principal,
      server: request.server,
      url: request.url,
      fetch: request.fetch,
      assertConfigurationCurrent: undefined,
      getAuthorizationSignal: () => request.signal,
    });
  }

  async resolveConnectionOAuthProvider(
    request: StandaloneMcpConnectionOAuthRequest,
  ): Promise<OAuthClientProvider> {
    const configuredUrl = new URL(request.server.url);
    if (
      !isSupportedStandaloneMcpOAuthDestination(configuredUrl) ||
      configuredUrl.href !== request.url.href
    ) {
      throw new Error("standalone_mcp_oauth_config_changed");
    }

    const identity = serverIdentity(request.server.id, request.url.href);
    const callbackId = createHash("sha256")
      .update(identity)
      .digest("hex")
      .slice(0, 32);
    const redirectUrl = `http://127.0.0.1:${this.options.port}/mcp/oauth/callback/${callbackId}`;
    const repository = await this.getRepository();
    const createOAuthProvider =
      this.options.createOAuthProvider ??
      (await import("@agentlink/node-host")).createNodeHostMcpOAuthProvider;
    const provider = createOAuthProvider({
      principal: request.principal,
      serverId: identity,
      serverUrl: request.url.href,
      redirectUrl,
      credentials: repository,
      clientName: "AgentLink Desktop",
      fetch: async (input, init) => {
        await request.assertConfigurationCurrent?.();
        const attemptSignal = this.authorizationSignals.get(callbackId);
        const signal = init?.signal
          ? attemptSignal
            ? AbortSignal.any([init.signal, attemptSignal])
            : init.signal
          : attemptSignal;
        if (this.disposed || signal?.aborted)
          return Promise.reject(abortError());
        return request
          .fetch(input, {
            ...init,
            ...(signal ? { signal } : {}),
          })
          .catch((error: unknown) => {
            if (this.authorizationSignals.get(callbackId) === attemptSignal) {
              this.authorizationSignals.delete(callbackId);
            }
            throw error;
          });
      },
      authorize: (authorization) =>
        this.requestAuthorization(
          callbackId,
          request.server.id,
          authorization,
          request.getAuthorizationSignal,
          request.assertConfigurationCurrent,
        ),
    });
    const redirectToAuthorization =
      provider.redirectToAuthorization?.bind(provider);
    if (redirectToAuthorization) {
      provider.redirectToAuthorization = async (authorizationUrl) => {
        const signal = request.getAuthorizationSignal({
          serverName: request.server.id,
        });
        if (this.disposed || signal?.aborted) throw abortError();
        if (signal) this.authorizationSignals.set(callbackId, signal);
        try {
          await redirectToAuthorization(authorizationUrl);
        } finally {
          if (this.authorizationSignals.get(callbackId) === signal) {
            this.authorizationSignals.delete(callbackId);
          }
        }
      };
    }
    const saveTokens = provider.saveTokens?.bind(provider);
    if (saveTokens) {
      provider.saveTokens = async (tokens) => {
        await request.assertConfigurationCurrent?.();
        const signal = this.authorizationSignals.get(callbackId);
        if (this.disposed || signal?.aborted) throw abortError();
        try {
          await saveTokens(tokens);
        } finally {
          if (this.authorizationSignals.get(callbackId) === signal) {
            this.authorizationSignals.delete(callbackId);
          }
        }
      };
    }
    return provider;
  }

  handleCallback(
    pathname: string,
    requestUrl: URL,
  ): {
    ok: boolean;
    serverName?: string;
    oauthError?: string;
  } {
    const callbackId = callbackIdFromPath(pathname);
    const pending = callbackId ? this.pending.get(callbackId) : undefined;
    if (!callbackId || !pending) return { ok: false };
    if (requestUrl.searchParams.get("state") !== pending.state) {
      return { ok: false };
    }
    this.pending.delete(callbackId);
    clearTimeout(pending.timeout);
    pending.signal?.removeEventListener("abort", pending.abort);
    pending.resolve({ callbackUrl: requestUrl.href });
    return {
      ok: true,
      serverName: pending.serverName,
      ...(requestUrl.searchParams.get("error")
        ? { oauthError: requestUrl.searchParams.get("error")! }
        : {}),
    };
  }

  dispose(): void {
    this.disposed = true;
    this.authorizationSignals.clear();
    for (const [callbackId, pending] of this.pending) {
      this.pending.delete(callbackId);
      clearTimeout(pending.timeout);
      pending.signal?.removeEventListener("abort", pending.abort);
      pending.reject(new Error("standalone_mcp_oauth_disposed"));
    }
  }

  private async getRepository(): Promise<StandaloneMcpCredentialRepository> {
    this.repositoryPromise ??= this.options.createCredentialRepository
      ? this.options.createCredentialRepository()
      : import("@agentlink/node-host").then(
          ({ createKeychainMcpCredentialRepository }) =>
            createKeychainMcpCredentialRepository({
              account: "agentlink-desktop-mcp-oauth-v1",
            }),
        );
    return await this.repositoryPromise;
  }

  private async requestAuthorization(
    callbackId: string,
    serverName: string,

    request: NodeHostMcpOAuthAuthorizationRequest,
    getAuthorizationSignal: StandaloneMcpConnectionOAuthRequest["getAuthorizationSignal"],
    assertConfigurationCurrent: StandaloneMcpConnectionOAuthRequest["assertConfigurationCurrent"],
  ): Promise<{ callbackUrl: string }> {
    if (this.activeAuthorizations.has(callbackId)) {
      throw new Error("standalone_mcp_oauth_authorization_in_progress");
    }
    this.activeAuthorizations.add(callbackId);
    try {
      return await this.authorize(
        callbackId,
        serverName,
        request,
        getAuthorizationSignal,
        assertConfigurationCurrent,
      );
    } catch (error) {
      this.authorizationSignals.delete(callbackId);
      throw error;
    } finally {
      this.activeAuthorizations.delete(callbackId);
    }
  }

  private async authorize(
    callbackId: string,
    serverName: string,

    request: NodeHostMcpOAuthAuthorizationRequest,
    getAuthorizationSignal: StandaloneMcpConnectionOAuthRequest["getAuthorizationSignal"],
    assertConfigurationCurrent: StandaloneMcpConnectionOAuthRequest["assertConfigurationCurrent"],
  ): Promise<{ callbackUrl: string }> {
    const signal = getAuthorizationSignal({ serverName }) ?? request.signal;
    if (this.disposed || signal?.aborted) throw abortError();
    await assertConfigurationCurrent?.();
    if (signal) this.authorizationSignals.set(callbackId, signal);
    const authorizationUrl = new URL(request.authorizationUrl);
    const isSafeDestination =
      this.options.isSafeDestination ??
      isSupportedStandaloneMcpOAuthDestination;
    if (!(await isSafeDestination(authorizationUrl))) {
      throw new Error("standalone_mcp_oauth_authorization_destination_blocked");
    }
    if (signal?.aborted) throw abortError();
    if (
      !(await this.options.confirmAuthorization?.({
        ...request,
        serverId: serverName,
        signal,
      }))
    ) {
      throw new Error("standalone_mcp_oauth_authorization_denied");
    }
    await assertConfigurationCurrent?.();
    if (this.disposed || signal?.aborted) throw abortError();

    const callback = new Promise<{ callbackUrl: string }>((resolve, reject) => {
      const rejectPending = (error: Error) => {
        const current = this.pending.get(callbackId);
        if (current?.abort !== abort) return;
        this.pending.delete(callbackId);
        clearTimeout(current.timeout);
        current.signal?.removeEventListener("abort", abort);
        reject(error);
      };
      const abort = () => rejectPending(abortError());
      const timeout = setTimeout(
        () => rejectPending(new Error("mcp_oauth_callback_timeout")),
        request.timeoutMs,
      );
      timeout.unref?.();
      this.pending.set(callbackId, {
        state: request.state,
        serverName,
        resolve,
        reject,
        signal,
        abort,
        timeout,
      });
      signal?.addEventListener("abort", abort, { once: true });
    });

    try {
      if (signal?.aborted) throw abortError();
      if (!(await this.openExternal(request.authorizationUrl))) {
        throw new Error("standalone_mcp_oauth_browser_open_failed");
      }
      return await callback;
    } catch (error) {
      const current = this.pending.get(callbackId);
      if (current) {
        this.pending.delete(callbackId);
        clearTimeout(current.timeout);
        current.signal?.removeEventListener("abort", current.abort);
      }
      throw error;
    }
  }
}

function serverIdentity(serverName: string, serverUrl: string): string {
  const digest = createHash("sha256")
    .update(`${serverName}\0${serverUrl}`)
    .digest("hex");
  return `${serverName}:${digest}`;
}

function callbackIdFromPath(pathname: string): string | undefined {
  const match = /^\/mcp\/oauth\/callback\/([a-f0-9]{32})$/.exec(pathname);
  return match?.[1];
}

async function openMacExternal(value: string): Promise<boolean> {
  const url = new URL(value);
  if (!isSupportedStandaloneMcpOAuthDestination(url)) return false;
  return await new Promise<boolean>((resolve) => {
    execFile("/usr/bin/open", [url.href], { timeout: 10_000 }, (error) => {
      resolve(!error);
    });
  });
}

function abortError(): Error {
  const error = new Error("standalone_mcp_oauth_authorization_cancelled");
  error.name = "AbortError";
  return error;
}
