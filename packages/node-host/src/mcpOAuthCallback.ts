import type {
  AgentPrincipal,
  McpPendingAuthorization,
  McpPendingAuthorizationRepository,
} from "@agentlink/core";

export interface NodeHostMcpOAuthCallbackRequest<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> {
  /** Authenticated host identity; never infer a principal from callback input. */
  readonly principal: TPrincipal;
  readonly serverId: string;
  readonly transactionId: string;
  readonly callbackUrl: string;
  readonly receivedAt: number;
}

export type NodeHostMcpOAuthCallbackResult<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> =
  | {
      readonly ok: true;
      readonly authorization: McpPendingAuthorization<TPrincipal>;
      readonly code?: string;
      readonly oauthError?: string;
      readonly oauthErrorDescription?: string;
    }
  | {
      readonly ok: false;
      readonly reason:
        | "invalid_callback"
        | "redirect_mismatch"
        | "not_found"
        | "expired"
        | "consumed";
    };

export interface CreateNodeHostMcpOAuthCallbackHandlerOptions<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> {
  readonly pendingAuthorizations: McpPendingAuthorizationRepository<TPrincipal>;
}

/**
 * Validate and atomically consume one authenticated OAuth callback transaction.
 * This adapter deliberately does not listen on a port, open a browser, exchange
 * the code, or persist credentials. The embedding host owns those behaviors.
 */
export function createNodeHostMcpOAuthCallbackHandler<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
>(
  options: CreateNodeHostMcpOAuthCallbackHandlerOptions<TPrincipal>,
): (
  request: NodeHostMcpOAuthCallbackRequest<TPrincipal>,
) => Promise<NodeHostMcpOAuthCallbackResult<TPrincipal>> {
  return async (request) => {
    const parsed = parseCallbackUrl(request.callbackUrl);
    if (!parsed) return { ok: false, reason: "invalid_callback" };

    const pending =
      await options.pendingAuthorizations.readPendingAuthorization({
        principal: request.principal,
        serverId: request.serverId,
        transactionId: request.transactionId,
      });
    if (!pending.ok) return pending;
    if (!sameCallbackBase(parsed, pending.authorization.redirectUri)) {
      return { ok: false, reason: "redirect_mismatch" };
    }

    const state = parsed.searchParams.get("state");
    if (!state) return { ok: false, reason: "invalid_callback" };
    const consumed =
      await options.pendingAuthorizations.consumePendingAuthorization({
        principal: request.principal,
        serverId: request.serverId,
        transactionId: request.transactionId,
        state,
        consumedAt: request.receivedAt,
      });
    if (!consumed.ok) return consumed;

    return {
      ok: true,
      authorization: consumed.authorization,
      ...(parsed.searchParams.get("code")
        ? { code: parsed.searchParams.get("code")! }
        : {}),
      ...(parsed.searchParams.get("error")
        ? { oauthError: parsed.searchParams.get("error")! }
        : {}),
      ...(parsed.searchParams.get("error_description")
        ? {
            oauthErrorDescription:
              parsed.searchParams.get("error_description")!,
          }
        : {}),
    };
  };
}

function parseCallbackUrl(value: string): URL | undefined {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:"
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

function sameCallbackBase(callback: URL, expectedValue: string): boolean {
  let expected: URL;
  try {
    expected = new URL(expectedValue);
  } catch {
    return false;
  }
  return (
    callback.protocol === expected.protocol &&
    callback.port === expected.port &&
    callback.pathname === expected.pathname &&
    sameCallbackHostname(callback.hostname, expected.hostname)
  );
}

function sameCallbackHostname(left: string, right: string): boolean {
  if (left.toLowerCase() === right.toLowerCase()) return true;
  return isLoopbackHostname(left) && isLoopbackHostname(right);
}

function isLoopbackHostname(value: string): boolean {
  const hostname = value.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1"
  );
}
