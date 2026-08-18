import { validateAgentPluginMcpHttpUrl } from "../core/agentPlugins/httpPolicy.js";

const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

interface ReplayableBody {
  readonly body?: BodyInit;
  readonly replayable: boolean;
}

/**
 * Applies AgentLink's Agent Plugins HTTP policy around one MCP resource origin.
 * Streamable HTTP behavior is pinned to MCP 2025-11-25 as implemented by SDK
 * 1.29.0. OAuth requests routed through this wrapper are identified as non-MCP
 * legs so package headers never enter discovery, registration, authorization,
 * or token flows; a separately supplied OAuth fetch is preferable where the
 * SDK transport exposes one.
 */
export function createAgentPluginMcpFetch(
  configuredUrl: string | URL,
  configuredHeaders: Readonly<Record<string, string>> | undefined,
  baseFetch: typeof globalThis.fetch,
): typeof globalThis.fetch {
  const configured = toValidatedUrl(configuredUrl);
  const configuredOrigin = configured.origin;
  const packageHeaders = Object.entries(configuredHeaders ?? {});

  return async (input, init) => {
    const initial = requestParts(input, init);
    let currentUrl = toValidatedUrl(initial.url);
    let method = initial.method;
    let headers = initial.headers;
    let body = initial.body;
    const mcpTransportRequest = isMcpTransportRequest(
      method,
      headers,
      body.body,
    );
    const visited = new Set<string>();

    for (let hop = 0; ; hop++) {
      if (visited.has(currentUrl.href)) {
        throw new Error(
          `Plugin MCP redirect loop detected at '${currentUrl.href}'.`,
        );
      }
      visited.add(currentUrl.href);

      const outboundHeaders = new Headers(headers);
      if (currentUrl.origin === configuredOrigin) {
        if (mcpTransportRequest) {
          injectConfiguredHeaders(outboundHeaders, packageHeaders);
        }
      } else {
        stripCrossOriginCredentials(outboundHeaders);
      }
      const response = await baseFetch(currentUrl, {
        ...initial.init,
        method,
        headers: outboundHeaders,
        body: body.body,
        redirect: "manual",
      });
      if (!REDIRECT_STATUSES.has(response.status)) return response;
      if (hop >= MAX_REDIRECTS) {
        await response.body?.cancel();
        throw new Error(
          `Plugin MCP redirect limit exceeded after ${MAX_REDIRECTS} hops.`,
        );
      }
      const location = response.headers.get("location");
      if (!location) return response;
      const nextUrl = new URL(location, response.url || currentUrl);
      const validationError = validateAgentPluginMcpHttpUrl(nextUrl);
      if (validationError) {
        await response.body?.cancel();
        throw new Error(`Plugin MCP redirect rejected: ${validationError}`);
      }

      const rewritten = redirectRequest(response.status, method, body);
      method = rewritten.method;
      body = rewritten.body;
      if (!body.replayable) {
        await response.body?.cancel();
        throw new Error(
          "Plugin MCP redirect requires replaying a one-shot request body.",
        );
      }
      if (body.body === undefined) {
        headers = withoutEntityHeaders(headers);
      }
      await response.body?.cancel();
      currentUrl = nextUrl;
    }
  };
}

function requestParts(
  input: Parameters<typeof globalThis.fetch>[0],
  init: RequestInit | undefined,
): {
  readonly url: string | URL;
  readonly method: string;
  readonly headers: Headers;
  readonly body: ReplayableBody;
  readonly init: RequestInit;
} {
  if (input instanceof Request) {
    const body =
      init?.body !== undefined
        ? normalizeReplayableBody(init.body)
        : input.body === null
          ? { body: undefined, replayable: true }
          : { body: input.body, replayable: false };
    return {
      url: input.url,
      method: (init?.method ?? input.method).toUpperCase(),
      headers: mergeHeaders(input.headers, init?.headers),
      body,
      init: {
        credentials: input.credentials,
        cache: input.cache,
        integrity: input.integrity,
        keepalive: input.keepalive,
        mode: input.mode,
        referrer: input.referrer,
        referrerPolicy: input.referrerPolicy,
        signal: init?.signal ?? input.signal,
        ...init,
      },
    };
  }
  return {
    url: input,
    method: (init?.method ?? "GET").toUpperCase(),
    headers: new Headers(init?.headers),
    body: normalizeReplayableBody(init?.body),
    init: { ...init },
  };
}

function normalizeReplayableBody(
  body: BodyInit | null | undefined,
): ReplayableBody {
  if (body === undefined || body === null) {
    return { body: undefined, replayable: true };
  }
  if (
    typeof body === "string" ||
    body instanceof URLSearchParams ||
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body)
  ) {
    return { body, replayable: true };
  }
  return { body, replayable: false };
}

function redirectRequest(
  status: number,
  method: string,
  body: ReplayableBody,
): { readonly method: string; readonly body: ReplayableBody } {
  if (
    status === 303
      ? method !== "HEAD"
      : (status === 301 || status === 302) && method === "POST"
  ) {
    return {
      method: "GET",
      body: { body: undefined, replayable: true },
    };
  }
  return { method, body };
}

function mergeHeaders(
  base: HeadersInit | undefined,
  override: HeadersInit | undefined,
): Headers {
  const headers = new Headers(base);
  new Headers(override).forEach((value, name) => headers.set(name, value));
  return headers;
}

function isMcpTransportRequest(
  method: string,
  headers: Headers,
  body: BodyInit | undefined,
): boolean {
  const accept = headers.get("accept")?.toLowerCase() ?? "";
  if (accept.includes("text/event-stream")) return true;
  if (method === "DELETE" && headers.has("mcp-session-id")) return true;
  if (method !== "POST" || typeof body !== "string") return false;
  try {
    const parsed: unknown = JSON.parse(body);
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    return (
      messages.length > 0 &&
      messages.every(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          (message as { jsonrpc?: unknown }).jsonrpc === "2.0",
      )
    );
  } catch {
    return false;
  }
}

function injectConfiguredHeaders(
  headers: Headers,
  configuredHeaders: readonly (readonly [string, string])[],
): void {
  const existing = new Set(
    Array.from(headers.keys(), (name) => name.toLowerCase()),
  );
  for (const [name, value] of configuredHeaders) {
    if (!existing.has(name.toLowerCase())) headers.set(name, value);
  }
}

function stripCrossOriginCredentials(headers: Headers): void {
  for (const name of ["authorization", "cookie", "proxy-authorization"]) {
    headers.delete(name);
  }
}

function withoutEntityHeaders(headers: Headers): Headers {
  const result = new Headers(headers);
  for (const name of ["content-length", "content-type", "transfer-encoding"]) {
    result.delete(name);
  }
  return result;
}

function toValidatedUrl(value: string | URL): URL {
  const url = value instanceof URL ? new URL(value) : new URL(value);
  const error = validateAgentPluginMcpHttpUrl(url);
  if (error) throw new Error(`Invalid plugin MCP URL: ${error}`);
  return url;
}
