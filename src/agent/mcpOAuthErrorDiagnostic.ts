type OAuthEndpoint = "discovery" | "registration" | "token";
const MAX_ERROR_BYTES = 4096;
const OAUTH_ERROR_CODES = new Set([
  "invalid_redirect_uri",
  "redirect_uri_mismatch",
  "access_denied",
  "invalid_target",
  "invalid_request",
  "invalid_client",
  "invalid_grant",
  "unauthorized_client",
  "unsupported_grant_type",
  "invalid_scope",
  "server_error",
  "temporarily_unavailable",
  "invalid_client_metadata",
]);

function endpointCategory(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  serverUrl: string,
): OAuthEndpoint | undefined {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const server = new URL(serverUrl);
  if (url.href === server.href) return undefined;
  if (url.pathname.startsWith("/.well-known/")) return "discovery";
  const method = (
    init?.method ?? (input instanceof Request ? input.method : "GET")
  ).toUpperCase();
  if (method !== "POST") return undefined;
  const headers = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  );
  // SSE message endpoints can also receive JSON POSTs. Require an OAuth
  // endpoint path as well as the request media type before rewriting a body.
  if (
    headers.has("mcp-protocol-version") ||
    headers.get("accept")?.includes("text/event-stream")
  )
    return undefined;
  const contentType = headers.get("content-type")?.toLowerCase() ?? "";
  if (
    /\/(?:token|exchange)\/?$/.test(url.pathname) &&
    contentType.startsWith("application/x-www-form-urlencoded")
  )
    return "token";
  if (
    /\/(?:register|registration)\/?$/.test(url.pathname) &&
    contentType.startsWith("application/json")
  )
    return "registration";
  return undefined;
}

function safeDescription(description: unknown): string {
  if (typeof description !== "string") return "redacted";
  const normalized = description.toLowerCase();
  if (normalized.includes("token_endpoint_auth_method"))
    return "unsupported_token_endpoint_auth_method";
  if (normalized === "unsupported_client_authentication_method")
    return "unsupported_client_authentication_method";
  if (normalized.includes("client authentication method"))
    return "unsupported_client_authentication_method";
  if (normalized.includes("public client"))
    return "public_client_not_supported";
  if (normalized.includes("invalid redirect uri"))
    return "invalid redirect uri";
  if (normalized.includes("redirect_uri_mismatch"))
    return "redirect_uri_mismatch";
  if (normalized.includes("client secret")) return "client_secret_required";
  return "redacted";
}

/** Keep SDK error parsing and connection logs free of raw OAuth response bodies. */
export async function inspectMcpOAuthResponse(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  serverUrl: string,
  response: Response,
  log: (message: string) => void,
): Promise<Response> {
  const endpoint = endpointCategory(input, init, serverUrl);
  if (!endpoint || response.status < 400) return response;
  if (endpoint === "discovery") return response;
  let code = "server_error";
  let description = "redacted";
  const length = response.headers.get("content-length");
  if (
    response.headers.get("content-type")?.includes("application/json") &&
    (!length || Number(length) <= MAX_ERROR_BYTES)
  ) {
    try {
      const reader = response.body?.getReader();
      if (reader) {
        const chunks: Uint8Array[] = [];
        let size = 0;
        while (size <= MAX_ERROR_BYTES) {
          const { done, value } = await reader.read();
          if (done) {
            const parsed: unknown = JSON.parse(
              new TextDecoder().decode(Buffer.concat(chunks)),
            );
            if (
              parsed &&
              typeof parsed === "object" &&
              !Array.isArray(parsed)
            ) {
              const error = parsed as Record<string, unknown>;
              if (
                typeof error.error === "string" &&
                /^[a-z][a-z0-9_]{0,63}$/.test(error.error) &&
                OAUTH_ERROR_CODES.has(error.error)
              )
                code = error.error;
              description = safeDescription(error.error_description);
            }
            break;
          }
          size += value.byteLength;
          if (size <= MAX_ERROR_BYTES) chunks.push(value);
        }
        if (size > MAX_ERROR_BYTES) void reader.cancel().catch(() => undefined);
      }
    } catch {
      // Never include an unreadable OAuth response body in connection errors.
    }
  }
  void response.body?.cancel().catch(() => undefined);
  log(
    `oauth endpoint=${endpoint} status=${response.status} error=${code} description=${description}`,
  );
  // Retain challenge and retry headers while withholding the untrusted body
  // from SDK errors, which otherwise include it verbatim in connection logs.
  const headers = new Headers({ "content-type": "application/json" });
  for (const key of ["www-authenticate", "retry-after"]) {
    const value = response.headers.get(key);
    if (value) headers.set(key, value);
  }
  return new Response(
    JSON.stringify({ error: code, error_description: description }),
    { status: response.status, headers },
  );
}
