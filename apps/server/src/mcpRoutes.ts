import type { IncomingMessage, ServerResponse } from "node:http";

import type { AssistantServerAuth } from "./assistantServer.js";
import { HttpError, readJsonBody, sendJson } from "./httpJson.js";
import {
  McpError,
  MCP_SERVER_ID_PATTERN,
  type McpAuthKind,
  type McpRefreshResult,
  type McpRegistry,
  type McpServerRecord,
  type McpToolPolicy,
} from "./mcpRegistry.js";
import { alwaysAskReason, BUILT_IN_ALWAYS_ASK } from "./mcpToolGuard.js";

/**
 * Owner-only MCP servers. Secrets go in and never come back out.
 *
 * - `GET /api/mcp`: every server with its status and tools (no secrets),
 *   and the always-ask list (built in, and the owner's extra patterns)
 * - `PUT /api/mcp` (`{ alwaysAsk: string[] }`): the owner's extra patterns
 * - `POST /api/mcp` (`{ label, url, auth: "none" | "header" | "oauth",
 *   headerName?, headerValue?, network?: true }`): add one, then test it.
 *   `network` ("On my network", for Home Assistant and the like) accepts
 *   a private address over HTTP(S), never with OAuth
 * - `POST /api/mcp/:id/test`: connect and list its tools again
 * - `PATCH /api/mcp/:id` (`{ enabled?, label? }`)
 * - `DELETE /api/mcp/:id`: also forgets its secrets
 * - `PUT /api/mcp/:id/tools/:tool` (`{ policy: "ask" | "run" | "off",
 *   runWhen?: { [argument]: string[] } }`): Run is refused (409) for a
 *   tool on the always-ask list
 * - `POST /api/mcp/:id/sign-in`: the address to open for OAuth
 * - `GET /api/mcp/oauth/callback?state&code`: where sign-in finishes. The
 *   provider sends the browser to the public `/mcp/callback` page first,
 *   because the session cookie is not sent on a navigation from another
 *   site; that page forwards here from this origin.
 */

/** The public page OAuth providers send the owner back to. */
export const MCP_OAUTH_RETURN_PATH = "/mcp/callback";
/** The signed-in route that finishes sign-in. */
export const MCP_OAUTH_CALLBACK_PATH = "/api/mcp/oauth/callback";

const MAX_BODY_BYTES = 16 * 1024;
const SERVER_ROUTE =
  /^\/api\/mcp\/([a-z][a-z0-9-]{0,39})(?:\/(test|sign-in)|\/tools\/([^/]{1,128}))?$/u;
const ERROR_STATUS: Readonly<Record<string, number>> = {
  mcp_server_not_found: 404,
  mcp_tool_not_found: 404,
  mcp_server_limit: 409,
  mcp_run_refused: 409,
  mcp_not_oauth: 409,
  mcp_oauth_expired: 410,
};

export interface McpRoutesOptions {
  readonly registry: McpRegistry;
  readonly isOwner: (auth: AssistantServerAuth) => boolean;
  /** Test a server, telling the owner when tools changed. */
  readonly refresh: (serverId: string) => Promise<McpRefreshResult>;
  /** After any change, so open apps update. */
  readonly onChanged?: () => void;
}

export interface McpRoutes {
  handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
    auth: AssistantServerAuth,
  ): Promise<boolean>;
}

/** What the web app sees of a server: never a secret. */
export function mcpServerView(
  server: McpServerRecord,
  hasCredentials: boolean,
  alwaysAsk: readonly string[] = [],
) {
  return {
    id: server.id,
    label: server.label,
    url: server.url,
    auth: server.auth,
    ...(server.headerName ? { headerName: server.headerName } : {}),
    enabled: server.enabled,
    status: server.status,
    ...(server.error ? { error: server.error } : {}),
    ...(server.testedAt !== undefined ? { testedAt: server.testedAt } : {}),
    origin: server.origin,
    ...(server.purpose ? { purpose: server.purpose } : {}),
    ...(server.network ? { network: true } : {}),
    hasCredentials,
    tools: server.tools.map((tool) => {
      const alwaysAsks = alwaysAskReason(server.id, tool, alwaysAsk, {
        network: server.network === true,
      });
      const properties = tool.inputSchema.properties;
      return {
        name: tool.name,
        description: tool.description,
        ...(tool.readOnlyHint !== undefined
          ? { readOnlyHint: tool.readOnlyHint }
          : {}),
        policy: tool.policy,
        ...(tool.runWhen ? { runWhen: tool.runWhen } : {}),
        ...(alwaysAsks ? { alwaysAsks } : {}),
        // Argument names, for a Run rule.
        arguments:
          properties && typeof properties === "object"
            ? Object.keys(properties).slice(0, 50)
            : [],
      };
    }),
  };
}

export function createMcpRoutes(options: McpRoutesOptions): McpRoutes {
  const { registry } = options;
  const view = (server: McpServerRecord) =>
    mcpServerView(
      server,
      registry.hasCredentials(server.id),
      registry.alwaysAsk(),
    );
  const alwaysAskView = () => ({
    builtIn: [...BUILT_IN_ALWAYS_ASK],
    extra: [...registry.alwaysAsk()],
  });
  const changed = () => options.onChanged?.();

  const route = async (
    request: IncomingMessage,
    response: ServerResponse,
    auth: AssistantServerAuth,
    url: URL,
    method: string,
  ): Promise<boolean> => {
    const pathname = url.pathname;
    if (pathname === "/api/mcp") {
      if (method === "GET") {
        sendJson(response, 200, {
          servers: registry.list().map(view),
          alwaysAsk: alwaysAskView(),
        });
        return true;
      }
      if (method === "PUT") {
        const body = await readJsonBody(request, MAX_BODY_BYTES, auth.signal);
        await registry.setAlwaysAsk(body.alwaysAsk as string[]);
        changed();
        sendJson(response, 200, {
          servers: registry.list().map(view),
          alwaysAsk: alwaysAskView(),
        });
        return true;
      }
      if (method !== "POST") throw new HttpError(405, "method_not_allowed");
      const body = await readJsonBody(request, MAX_BODY_BYTES, auth.signal);
      const auth_ = body.auth ?? "none";
      if (auth_ !== "none" && auth_ !== "header" && auth_ !== "oauth") {
        throw new HttpError(400, "auth_invalid");
      }
      if (body.network !== undefined && typeof body.network !== "boolean") {
        throw new HttpError(400, "network_invalid");
      }
      const added = await registry.add({
        ...(body.network === true ? { network: true } : {}),
        label: text(body.label, "label"),
        url: text(body.url, "url"),
        auth: auth_ as McpAuthKind,
        ...(typeof body.headerName === "string"
          ? { headerName: body.headerName.trim() }
          : {}),
        ...(typeof body.headerValue === "string"
          ? { headerValue: body.headerValue }
          : {}),
      });
      // A server that needs sign-in is tested once the owner signs in.
      const server =
        added.auth === "oauth"
          ? added
          : (await options.refresh(added.id)).server;
      changed();
      sendJson(response, 201, { server: view(server) });
      return true;
    }
    if (pathname === MCP_OAUTH_CALLBACK_PATH) {
      if (method !== "GET") throw new HttpError(405, "method_not_allowed");
      const state = url.searchParams.get("state") ?? "";
      const code = url.searchParams.get("code") ?? "";
      const providerError = url.searchParams.get("error");
      let outcome = "signed-in";
      if (providerError || !state || !code) outcome = "sign-in-failed";
      else {
        try {
          const server = await registry.finishSignIn(state, code);
          await options.refresh(server.id).catch(() => undefined);
        } catch {
          outcome = "sign-in-failed";
        }
      }
      changed();
      response.writeHead(303, {
        location: `/?mcp=${outcome}`,
        "content-length": 0,
      });
      response.end();
      return true;
    }
    const match = SERVER_ROUTE.exec(pathname);
    if (!match || !MCP_SERVER_ID_PATTERN.test(match[1]!)) {
      throw new HttpError(404, "not_found");
    }
    const id = match[1]!;
    const action = match[2];
    const toolName = match[3] ? decodeURIComponent(match[3]) : undefined;
    if (!registry.get(id)) throw new HttpError(404, "mcp_server_not_found");

    if (toolName !== undefined) {
      if (method !== "PUT") throw new HttpError(405, "method_not_allowed");
      const body = await readJsonBody(request, MAX_BODY_BYTES, auth.signal);
      const policy = body.policy;
      if (policy !== "ask" && policy !== "run" && policy !== "off") {
        throw new HttpError(400, "policy_invalid");
      }
      // A call waiting on the old policy is checked again before it runs.
      const server = await registry.setPolicy(
        id,
        toolName,
        policy as McpToolPolicy,
        body.runWhen === undefined || body.runWhen === null
          ? undefined
          : (body.runWhen as Record<string, string[]>),
      );
      changed();
      sendJson(response, 200, { server: view(server) });
      return true;
    }
    if (action === "test") {
      if (method !== "POST") throw new HttpError(405, "method_not_allowed");
      const result = await options.refresh(id);
      changed();
      sendJson(response, 200, {
        server: view(result.server),
        changed: result.changed,
        added: result.added,
        removed: result.removed,
      });
      return true;
    }
    if (action === "sign-in") {
      if (method !== "POST") throw new HttpError(405, "method_not_allowed");
      const started = await registry.beginSignIn(id);
      if (started.kind === "signed_in") {
        const result = await options.refresh(id);
        changed();
        sendJson(response, 200, { server: view(result.server) });
        return true;
      }
      sendJson(response, 200, { authorizationUrl: started.authorizationUrl });
      return true;
    }
    if (method === "PATCH") {
      const body = await readJsonBody(request, MAX_BODY_BYTES, auth.signal);
      if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
        throw new HttpError(400, "enabled_invalid");
      }
      const server = await registry.update(id, {
        ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
        ...(typeof body.label === "string" ? { label: body.label } : {}),
      });
      changed();
      sendJson(response, 200, { server: view(server) });
      return true;
    }
    if (method === "DELETE") {
      await registry.remove(id);
      changed();
      sendJson(response, 200, { ok: true });
      return true;
    }
    throw new HttpError(405, "method_not_allowed");
  };

  return {
    async handleRequest(request, response, auth) {
      const url = new URL(request.url ?? "/", "https://server.invalid");
      if (
        url.pathname !== "/api/mcp" &&
        !url.pathname.startsWith("/api/mcp/")
      ) {
        return false;
      }
      if (!options.isOwner(auth)) throw new HttpError(403, "mcp_forbidden");
      const method = (request.method ?? "GET").toUpperCase();
      try {
        return await route(request, response, auth, url, method);
      } catch (error) {
        if (error instanceof McpError) {
          // The registry's plain-language reason, so the owner can act on it.
          sendJson(response, ERROR_STATUS[error.code] ?? 400, {
            error: error.code,
            detail: error.message,
          });
          return true;
        }
        throw error;
      }
    },
  };
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new HttpError(400, `${name}_required`);
  }
  return value;
}

/**
 * The public page an OAuth provider returns to. It carries no session, so
 * it only forwards the browser to the signed-in callback on this origin.
 */
export function renderMcpReturnPage(search: URLSearchParams): string {
  const forward = new URLSearchParams();
  for (const name of ["state", "code", "error"]) {
    const value = search.get(name);
    if (value) forward.set(name, value.slice(0, 2_048));
  }
  const target = `${MCP_OAUTH_CALLBACK_PATH}?${forward.toString()}`
    .replace(/&/gu, "&amp;")
    .replace(/"/gu, "&quot;")
    .replace(/</gu, "&lt;");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="0;url=${target}">
<title>Finishing sign-in</title>
</head>
<body style="font-family: system-ui, sans-serif; padding: 2rem">
<p>Finishing sign-in… <a href="${target}">Continue</a></p>
</body>
</html>
`;
}
