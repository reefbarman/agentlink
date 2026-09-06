import { createHash } from "node:crypto";
import { execFile } from "node:child_process";

import type {
  CreateNodeHostMcpOAuthProviderOptions,
  NodeHostMcpOAuthAuthorizationRequest,
  NodeHostMcpRemoteOAuthRequest,
} from "@agentlink/node-host" with { "resolution-mode": "import" };
import type {
  McpCredentialRepository,
  McpPendingAuthorizationRepository,
} from "@agentlink/core";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import {
  createStandaloneMcpOAuthPinnedFetch,
  isSafeStandaloneMcpOAuthDestination,
} from "./standaloneMcpOAuthPolicy.js";

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
  private readonly pending = new Map<string, PendingAuthorization>();
  private readonly openExternal: (url: string) => Promise<boolean>;
  private readonly pinnedFetch = createStandaloneMcpOAuthPinnedFetch();
  private repositoryPromise:
    | Promise<StandaloneMcpCredentialRepository>
    | undefined;

  constructor(private readonly options: StandaloneMcpOAuthRuntimeOptions) {
    this.openExternal = options.openExternal ?? openMacExternal;
  }

  async resolveOAuthProvider(
    request: NodeHostMcpRemoteOAuthRequest,
  ): Promise<OAuthClientProvider> {
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
    return createOAuthProvider({
      principal: request.principal,
      serverId: identity,
      serverUrl: request.url.href,
      redirectUrl,
      credentials: repository,
      signal: request.signal,
      clientName: "AgentLink Desktop",
      fetch: (input, init) =>
        this.pinnedFetch.fetch(request.fetch, input, init),
      authorize: (authorization) =>
        this.requestAuthorization(callbackId, request.server.id, authorization),
    });
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
    for (const [callbackId, pending] of this.pending) {
      this.pending.delete(callbackId);
      clearTimeout(pending.timeout);
      pending.signal?.removeEventListener("abort", pending.abort);
      pending.reject(new Error("standalone_mcp_oauth_disposed"));
    }
    void this.pinnedFetch.dispose();
  }

  private async getRepository(): Promise<StandaloneMcpCredentialRepository> {
    this.repositoryPromise ??= this.options.createCredentialRepository
      ? this.options.createCredentialRepository()
      : import("@agentlink/node-host").then(
          ({ createKeychainMcpCredentialRepository }) =>
            createKeychainMcpCredentialRepository(),
        );
    return await this.repositoryPromise;
  }

  private async requestAuthorization(
    callbackId: string,
    serverName: string,
    request: NodeHostMcpOAuthAuthorizationRequest,
  ): Promise<{ callbackUrl: string }> {
    if (this.pending.has(callbackId)) {
      throw new Error("standalone_mcp_oauth_authorization_in_progress");
    }
    if (request.signal?.aborted) throw abortError();
    const authorizationUrl = new URL(request.authorizationUrl);
    const isSafeDestination =
      this.options.isSafeDestination ?? isSafeStandaloneMcpOAuthDestination;
    if (!(await isSafeDestination(authorizationUrl))) {
      throw new Error("standalone_mcp_oauth_authorization_destination_blocked");
    }
    if (
      !(await this.options.confirmAuthorization?.({
        ...request,
        serverId: serverName,
      }))
    ) {
      throw new Error("standalone_mcp_oauth_authorization_denied");
    }

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
        signal: request.signal,
        abort,
        timeout,
      });
      request.signal?.addEventListener("abort", abort, { once: true });
    });

    try {
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
  if (url.protocol !== "https:") return false;
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
