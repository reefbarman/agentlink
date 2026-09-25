import type {
  McpCredentialRepository,
  McpPendingAuthorizationRepository,
} from "@agentlink/core";
import {
  createKeychainMcpCredentialRepository,
  createNodeHostMcpOAuthProvider,
  type CreateNodeHostMcpOAuthProviderOptions,
  type NodeHostMcpOAuthAuthorizationRequest,
  type NodeHostMcpRemoteOAuthRequest,
} from "@agentlink/node-host";
import { createHash } from "node:crypto";
import * as dns from "node:dns";
import { createServer, type Server } from "node:http";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { Agent } from "undici";

interface PendingAuthorization {
  readonly state: string;
  readonly serverName: string;
  readonly resolve: (value: { callbackUrl: string }) => void;
  readonly reject: (error: Error) => void;
  readonly signal?: AbortSignal;
  readonly abort: () => void;
  readonly timeout: NodeJS.Timeout;
}

type McpCredentialStore = McpCredentialRepository &
  McpPendingAuthorizationRepository;

type McpOAuthProviderFactory = (
  options: CreateNodeHostMcpOAuthProviderOptions,
) => ReturnType<typeof createNodeHostMcpOAuthProvider>;

export interface CliMcpPinnedFetch {
  fetch(
    baseFetch: typeof globalThis.fetch,
    input: Parameters<typeof globalThis.fetch>[0],
    init?: RequestInit,
  ): Promise<Response>;
  dispose(): Promise<void>;
}

export interface CreateCliMcpOAuthRuntimeOptions {
  readonly openExternal: (url: string) => Promise<void>;
  readonly confirmAuthorization: (
    request: Readonly<NodeHostMcpOAuthAuthorizationRequest>,
  ) => Promise<boolean>;
  readonly isSafeDestination?: (url: URL) => Promise<boolean>;
  readonly createCredentialRepository?: () => Promise<McpCredentialStore>;
  readonly createOAuthProvider?: McpOAuthProviderFactory;
}

/** CLI-owned browser and state-bound loopback callback handoff for MCP OAuth. */
export class CliMcpOAuthRuntime {
  readonly fetch: typeof globalThis.fetch;
  private readonly activeAuthorizations = new Set<string>();
  private readonly pending = new Map<string, PendingAuthorization>();
  private readonly server: Server;
  private readonly isSafeDestination: (url: URL) => Promise<boolean>;
  private readonly pinnedFetch: CliMcpPinnedFetch;
  private repositoryPromise: Promise<McpCredentialStore> | undefined;
  private closePromise: Promise<void> | undefined;
  private port = 0;

  private constructor(
    private readonly options: CreateCliMcpOAuthRuntimeOptions,
  ) {
    this.isSafeDestination =
      options.isSafeDestination ?? isSafePublicHttpsDestination;
    this.pinnedFetch = createCliMcpPinnedFetch();
    this.fetch = (input, init) =>
      this.pinnedFetch.fetch(globalThis.fetch, input, init);
    this.server = createServer((request, response) => {
      const requestUrl = new URL(
        request.url ?? "/",
        `http://127.0.0.1:${this.port || 1}`,
      );
      const handled = this.handleCallback(requestUrl.pathname, requestUrl);
      response.writeHead(handled.ok ? 200 : 400, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(
        handled.ok
          ? "AgentLink MCP authorization received. Return to the terminal.\n"
          : "Invalid or expired AgentLink MCP authorization callback.\n",
      );
    });
  }

  static async create(
    options: CreateCliMcpOAuthRuntimeOptions,
  ): Promise<CliMcpOAuthRuntime> {
    const runtime = new CliMcpOAuthRuntime(options);
    await runtime.listen();
    return runtime;
  }

  async resolveOAuthProvider(
    request: NodeHostMcpRemoteOAuthRequest,
    confirmAuthorization = this.options.confirmAuthorization,
  ): Promise<ReturnType<typeof createNodeHostMcpOAuthProvider>> {
    const identity = serverIdentity(request.server.id, request.url.href);
    const callbackId = createHash("sha256")
      .update(identity)
      .digest("hex")
      .slice(0, 32);
    const redirectUrl = `http://127.0.0.1:${this.port}/mcp/oauth/callback/${callbackId}`;
    this.repositoryPromise ??= this.options.createCredentialRepository
      ? this.options.createCredentialRepository()
      : createKeychainMcpCredentialRepository({
          account: "agentlink-cli-mcp-oauth-v1",
        });
    const createOAuthProvider =
      this.options.createOAuthProvider ?? createNodeHostMcpOAuthProvider;
    return createOAuthProvider({
      principal: request.principal,
      serverId: identity,
      serverUrl: request.url.href,
      redirectUrl,
      credentials: await this.repositoryPromise,
      signal: request.signal,
      clientName: "AgentLink CLI",
      fetch: request.fetch,
      authorize: (authorization) =>
        this.requestAuthorization(
          callbackId,
          request.server.id,
          authorization,
          confirmAuthorization,
        ),
    });
  }

  async close(): Promise<void> {
    this.closePromise ??= this.closeOnce();
    await this.closePromise;
  }

  private async closeOnce(): Promise<void> {
    for (const [callbackId, pending] of this.pending) {
      this.pending.delete(callbackId);
      clearTimeout(pending.timeout);
      pending.signal?.removeEventListener("abort", pending.abort);
      pending.reject(new Error("cli_mcp_oauth_closed"));
    }
    const closeServer = this.server.listening
      ? new Promise<void>((resolve, reject) => {
          this.server.close((error) => (error ? reject(error) : resolve()));
        })
      : Promise.resolve();
    const [serverResult, fetchResult] = await Promise.allSettled([
      closeServer,
      this.pinnedFetch.dispose(),
    ]);
    if (serverResult.status === "rejected") throw serverResult.reason;
    if (fetchResult.status === "rejected") throw fetchResult.reason;
  }

  private async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        this.server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        this.server.off("error", onError);
        resolve();
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(0, "127.0.0.1");
    });
    const address = this.server.address();
    if (!address || typeof address === "string") {
      throw new Error("cli_mcp_oauth_listener_unavailable");
    }
    this.port = address.port;
  }

  private handleCallback(
    pathname: string,
    requestUrl: URL,
  ): { readonly ok: boolean; readonly serverName?: string } {
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
    return { ok: true, serverName: pending.serverName };
  }

  private async requestAuthorization(
    callbackId: string,
    serverName: string,
    request: NodeHostMcpOAuthAuthorizationRequest,
    confirmAuthorization: CreateCliMcpOAuthRuntimeOptions["confirmAuthorization"],
  ): Promise<{ readonly callbackUrl: string }> {
    if (this.activeAuthorizations.has(callbackId)) {
      throw new Error("cli_mcp_oauth_authorization_in_progress");
    }
    this.activeAuthorizations.add(callbackId);
    try {
      if (request.signal?.aborted) throw abortError();
      const authorizationUrl = new URL(request.authorizationUrl);
      if (!(await this.isSafeDestination(authorizationUrl))) {
        throw new Error("cli_mcp_oauth_authorization_destination_blocked");
      }
      if (
        !(await confirmAuthorization({
          ...request,
          serverId: serverName,
        }))
      ) {
        throw new Error("cli_mcp_oauth_authorization_denied");
      }

      const callback = new Promise<{ callbackUrl: string }>(
        (resolve, reject) => {
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
        },
      );

      try {
        await this.options.openExternal(request.authorizationUrl);
        return await callback;
      } catch (error) {
        const pending = this.pending.get(callbackId);
        if (pending) {
          this.pending.delete(callbackId);
          clearTimeout(pending.timeout);
          pending.signal?.removeEventListener("abort", pending.abort);
        }
        throw error;
      }
    } finally {
      this.activeAuthorizations.delete(callbackId);
    }
  }
}

const BLOCKED_ADDRESSES = createBlockedAddresses();

/** Keep the public-address check attached to the actual MCP/OAuth socket. */
export function createCliMcpPinnedFetch(
  resolveLookup: LookupFunction = dns.lookup,
): CliMcpPinnedFetch {
  const dispatcher = new Agent({
    connect: { lookup: createPublicOnlyLookup(resolveLookup) },
  });
  return {
    async fetch(baseFetch, input, init) {
      return await baseFetch(input, {
        ...init,
        dispatcher,
      } as unknown as RequestInit);
    },
    async dispose() {
      await dispatcher.close();
    },
  };
}

export async function isSafePublicHttpsDestination(url: URL): Promise<boolean> {
  if (url.protocol !== "https:" || url.username || url.password) return false;
  const hostname = stripIpv6Brackets(url.hostname).toLowerCase();
  if (
    !hostname ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost")
  ) {
    return false;
  }
  const literalFamily = isIP(hostname);
  if (literalFamily) return isPublicAddress(hostname, literalFamily);
  try {
    const answers = await dns.promises.lookup(hostname, {
      all: true,
      verbatim: true,
    });
    return (
      answers.length > 0 &&
      answers.every(({ address, family }) => isPublicAddress(address, family))
    );
  } catch {
    return false;
  }
}

function serverIdentity(serverName: string, serverUrl: string): string {
  const digest = createHash("sha256")
    .update(`${serverName}\0${serverUrl}`)
    .digest("hex");
  return `${serverName}:${digest}`;
}

function callbackIdFromPath(pathname: string): string | undefined {
  return /^\/mcp\/oauth\/callback\/([a-f0-9]{32})$/u.exec(pathname)?.[1];
}

function stripIpv6Brackets(value: string): string {
  return value.startsWith("[") && value.endsWith("]")
    ? value.slice(1, -1)
    : value;
}

function createPublicOnlyLookup(resolveLookup: LookupFunction): LookupFunction {
  return (hostname, options, callback) => {
    const requestedFamily =
      options.family === "IPv4"
        ? 4
        : options.family === "IPv6"
          ? 6
          : options.family;
    resolveLookup(
      hostname,
      {
        all: true,
        verbatim: true,
        family: requestedFamily,
        hints: options.hints,
      },
      (error, addresses) => {
        if (error) {
          callback(error, [], 0);
          return;
        }
        const resolved = addresses as dns.LookupAddress[];
        if (
          resolved.length === 0 ||
          resolved.some(
            ({ address, family }) => !isPublicAddress(address, family),
          )
        ) {
          const blocked = new Error(
            "cli_mcp_destination_not_public",
          ) as NodeJS.ErrnoException;
          blocked.code = "EACCES";
          callback(blocked, [], 0);
          return;
        }
        if (options.all) {
          callback(null, resolved);
          return;
        }
        const selected = resolved[0]!;
        callback(null, selected.address, selected.family);
      },
    );
  };
}

function isPublicAddress(address: string, family: number): boolean {
  return !BLOCKED_ADDRESSES.check(
    stripIpv6Brackets(address),
    family === 4 ? "ipv4" : "ipv6",
  );
}

function createBlockedAddresses(): BlockList {
  const blockList = new BlockList();
  for (const [network, prefix] of [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ] as const) {
    blockList.addSubnet(network, prefix, "ipv4");
  }
  for (const [network, prefix] of [
    ["::", 128],
    ["::1", 128],
    ["64:ff9b::", 96],
    ["100::", 64],
    ["2001::", 32],
    ["2001:2::", 48],
    ["2001:db8::", 32],
    ["2002::", 16],
    ["fc00::", 7],
    ["fe80::", 10],
    ["ff00::", 8],
  ] as const) {
    blockList.addSubnet(network, prefix, "ipv6");
  }
  return blockList;
}

function abortError(): Error {
  const error = new Error("cli_mcp_oauth_authorization_cancelled");
  error.name = "AbortError";
  return error;
}
