import { randomUUID } from "node:crypto";

import type {
  AgentPrincipal,
  McpCredentialRecord,
  McpCredentialRepository,
  McpPendingAuthorizationRepository,
} from "@agentlink/core";
import {
  auth,
  type OAuthClientProvider,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

import { createNodeHostMcpOAuthCallbackHandler } from "./mcpOAuthCallback.js";
import { registerMcpOAuthFetch } from "./mcpOAuthFetch.js";

const DEFAULT_AUTHORIZATION_TIMEOUT_MS = 5 * 60_000;
const MAX_CREDENTIAL_WRITE_ATTEMPTS = 4;

export interface NodeHostMcpOAuthAuthorizationRequest<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> {
  readonly principal: TPrincipal;
  readonly serverId: string;
  readonly serverUrl: string;
  readonly authorizationUrl: string;
  readonly redirectUrl: string;
  readonly transactionId: string;
  readonly state: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

export type NodeHostMcpOAuthAuthorizationHandler<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> = (
  request: NodeHostMcpOAuthAuthorizationRequest<TPrincipal>,
) => Promise<{ readonly callbackUrl: string }>;

export interface CreateNodeHostMcpOAuthProviderOptions<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> {
  readonly principal: TPrincipal;
  readonly serverId: string;
  readonly serverUrl: string;
  readonly redirectUrl: string;
  readonly credentials: McpCredentialRepository<TPrincipal> &
    McpPendingAuthorizationRepository<TPrincipal>;
  readonly authorize: NodeHostMcpOAuthAuthorizationHandler<TPrincipal>;
  readonly signal?: AbortSignal;
  readonly clientName?: string;
  readonly authorizationTimeoutMs?: number;
  readonly now?: () => number;
  readonly createId?: () => string;
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * Repository-backed MCP SDK OAuth provider. The adapter owns protocol state and
 * token exchange; the embedding host owns browser launch and callback delivery.
 * The authorization handler must return only after receiving the exact callback
 * URL, allowing the transport to perform one bounded reconnect with stored tokens.
 */
export function createNodeHostMcpOAuthProvider<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
>(
  options: CreateNodeHostMcpOAuthProviderOptions<TPrincipal>,
): OAuthClientProvider {
  const serverUrl = parseHttpsUrl(options.serverUrl, "serverUrl");
  const redirectUrl = parseRedirectUrl(options.redirectUrl);
  const now = options.now ?? Date.now;
  const createId = options.createId ?? randomUUID;
  const authorizationTimeoutMs = boundedTimeout(options.authorizationTimeoutMs);
  let codeVerifier = "";
  let discoveryState: Awaited<
    ReturnType<NonNullable<OAuthClientProvider["discoveryState"]>>
  >;

  const provider: OAuthClientProvider = {
    redirectUrl,
    state: () => randomUUID(),
    discoveryState: () => discoveryState,
    saveDiscoveryState: (state) => {
      discoveryState = state;
    },
    clientMetadata: {
      client_name: options.clientName?.trim() || "AgentLink",
      redirect_uris: [redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    } satisfies OAuthClientMetadata,
    async clientInformation() {
      return (await readCredential()).record?.client as
        | OAuthClientInformationMixed
        | undefined;
    },
    async saveClientInformation(client) {
      await updateCredential({ client });
    },
    async tokens() {
      return (await readCredential()).record?.tokens as OAuthTokens | undefined;
    },
    async saveTokens(tokens) {
      await updateCredential({ tokens });
    },
    saveCodeVerifier(value) {
      codeVerifier = requiredText(value, "code_verifier");
    },
    codeVerifier() {
      return requiredText(codeVerifier, "code_verifier");
    },
    async redirectToAuthorization(authorizationUrl) {
      if (options.signal?.aborted) throw abortError();
      if (authorizationUrl.protocol !== "https:") {
        throw new Error("mcp_oauth_authorization_url_must_be_https");
      }
      const state = requiredText(
        authorizationUrl.searchParams.get("state") ?? "",
        "state",
      );
      const verifier = requiredText(codeVerifier, "code_verifier");
      const transactionId = requiredText(createId(), "transaction_id");
      const createdAt = now();
      const created = await options.credentials.createPendingAuthorization({
        authorization: {
          schemaVersion: 1,
          transactionId,
          principal: options.principal,
          serverId: options.serverId,
          redirectUri: redirectUrl,
          state,
          codeVerifier: verifier,
          createdAt,
          expiresAt: createdAt + authorizationTimeoutMs,
        },
      });
      if (!created.ok) throw new Error("mcp_oauth_transaction_conflict");

      const authorizationController = new AbortController();
      const relayAbort = () => authorizationController.abort();
      options.signal?.addEventListener("abort", relayAbort, { once: true });
      let callback: { readonly callbackUrl: string };
      try {
        callback = await waitForAuthorization(
          options.authorize({
            principal: options.principal,
            serverId: options.serverId,
            serverUrl: serverUrl.href,
            authorizationUrl: authorizationUrl.href,
            redirectUrl,
            transactionId,
            state,
            timeoutMs: authorizationTimeoutMs,
            signal: authorizationController.signal,
          }),
          authorizationTimeoutMs,
          authorizationController.signal,
        );
      } catch (error) {
        await options.credentials
          .consumePendingAuthorization({
            principal: options.principal,
            serverId: options.serverId,
            transactionId,
            state,
            consumedAt: Math.min(now(), createdAt + authorizationTimeoutMs),
          })
          .catch(() => undefined);
        throw error;
      } finally {
        authorizationController.abort();
        options.signal?.removeEventListener("abort", relayAbort);
      }
      const consume = createNodeHostMcpOAuthCallbackHandler({
        pendingAuthorizations: options.credentials,
      });
      const result = await consume({
        principal: options.principal,
        serverId: options.serverId,
        transactionId,
        callbackUrl: callback.callbackUrl,
        receivedAt: now(),
      });
      if (!result.ok) throw new Error(`mcp_oauth_callback_${result.reason}`);
      if (result.oauthError) {
        throw new Error(
          `mcp_oauth_authorization_${boundedError(result.oauthError)}`,
        );
      }
      if (!result.code) throw new Error("mcp_oauth_callback_missing_code");
      codeVerifier = result.authorization.codeVerifier;
      await auth(provider, {
        serverUrl,
        authorizationCode: result.code,
        fetchFn: options.fetch,
      });
    },
    async invalidateCredentials(scope) {
      if (scope === "verifier") {
        codeVerifier = "";
        return;
      }
      if (scope === "discovery" || scope === "all") discoveryState = undefined;
      if (scope === "discovery") return;
      await updateCredential(
        scope === "all"
          ? { client: null, tokens: null }
          : scope === "client"
            ? { client: null }
            : { tokens: null },
      );
    },
  };

  async function readCredential(): Promise<{
    record?: McpCredentialRecord<TPrincipal>;
    revision?: string;
  }> {
    const result = await options.credentials.readCredential({
      principal: options.principal,
      serverId: options.serverId,
    });
    return result.ok
      ? { record: result.record, revision: result.revision }
      : {};
  }

  async function updateCredential(patch: {
    client?: OAuthClientInformationMixed | null;
    tokens?: OAuthTokens | null;
  }): Promise<void> {
    for (
      let attempt = 0;
      attempt < MAX_CREDENTIAL_WRITE_ATTEMPTS;
      attempt += 1
    ) {
      const current = await readCredential();
      const client =
        patch.client === null
          ? undefined
          : patch.client !== undefined
            ? { ...patch.client }
            : current.record?.client;
      const tokens =
        patch.tokens === null
          ? undefined
          : patch.tokens !== undefined
            ? { ...patch.tokens }
            : current.record?.tokens;
      if (!client && !tokens) {
        if (!current.revision) return;
        const deleted = await options.credentials.deleteCredential({
          principal: options.principal,
          serverId: options.serverId,
          expectedRevision: current.revision,
        });
        if (deleted.ok || deleted.reason === "not_found") return;
        if (deleted.reason === "revision_conflict") continue;
        throw new Error(`mcp_oauth_credential_delete_${deleted.reason}`);
      }
      const saved = await options.credentials.saveCredential({
        record: {
          schemaVersion: 1,
          principal: options.principal,
          serverId: options.serverId,
          ...(client ? { client } : {}),
          ...(tokens ? { tokens } : {}),
          updatedAt: now(),
        },
        expectedRevision: current.revision,
      });
      if (saved.ok) return;
      if (
        saved.reason === "revision_conflict" ||
        saved.reason === "already_exists" ||
        saved.reason === "not_found"
      ) {
        continue;
      }
      throw new Error(`mcp_oauth_credential_save_${saved.reason}`);
    }
    throw new Error("mcp_oauth_credential_revision_conflict");
  }

  if (options.fetch)
    registerMcpOAuthFetch(provider, options.fetch, options.signal);
  return provider;
}

async function waitForAuthorization<T>(
  pending: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) throw abortError();
  return await new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(
      () => finish(() => reject(new Error("mcp_oauth_callback_timeout"))),
      timeoutMs,
    );
    timeout.unref?.();
    const abort = () => finish(() => reject(abortError()));
    const finish = (complete: () => void) => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      complete();
    };
    signal?.addEventListener("abort", abort, { once: true });
    pending.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

function parseHttpsUrl(value: string, field: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error(`mcp_oauth_${field}_invalid`);
  return url;
}

function parseRedirectUrl(value: string): string {
  const url = new URL(value);
  const loopback =
    url.hostname === "127.0.0.1" ||
    url.hostname === "localhost" ||
    url.hostname === "[::1]" ||
    url.hostname === "::1";
  if ((url.protocol !== "http:" || !loopback) && url.protocol !== "https:") {
    throw new Error("mcp_oauth_redirect_url_invalid");
  }
  url.search = "";
  url.hash = "";
  return url.href;
}

function boundedTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_AUTHORIZATION_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 15 * 60_000) {
    throw new Error("mcp_oauth_authorization_timeout_invalid");
  }
  return timeout;
}

function requiredText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 2_048) {
    throw new Error(`mcp_oauth_${field}_invalid`);
  }
  return normalized;
}

function boundedError(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 100) || "error";
}

function abortError(): Error {
  const error = new Error("mcp_oauth_authorization_cancelled");
  error.name = "AbortError";
  return error;
}
