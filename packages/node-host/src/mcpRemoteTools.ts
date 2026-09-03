import {
  defineTool,
  type AgentPrincipal,
  type CoreModelJsonSchema,
  type HostToolResolver,
} from "@agentlink/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";

const MAX_SERVERS = 20;
const MAX_TOOLS_PER_SERVER = 100;
const MAX_TOOL_RESULT_CHARS = 100_000;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 60_000;

export type NodeHostMcpRemoteTransport = "sse" | "streamable-http";

/** One host-authorized remote MCP server. OAuth and stdio are separate C3 seams. */
export interface NodeHostMcpRemoteServer {
  readonly id: string;
  readonly transport: NodeHostMcpRemoteTransport;
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}

export interface ResolveNodeHostMcpRemoteServersRequest<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> {
  readonly principal: TPrincipal;
  readonly sessionId: string;
  readonly turnId: string;
}

export type ResolveNodeHostMcpRemoteServers<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> = (
  request: ResolveNodeHostMcpRemoteServersRequest<TPrincipal>,
) =>
  | readonly NodeHostMcpRemoteServer[]
  | Promise<readonly NodeHostMcpRemoteServer[]>;

export interface NodeHostMcpRemoteNetworkRequest<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> {
  readonly principal: TPrincipal;
  readonly sessionId: string;
  readonly turnId: string;
  readonly serverId: string;
  readonly url: URL;
}

export interface CreateNodeHostMcpRemoteToolsOptions<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> {
  /** Resolve servers separately for every authenticated principal/session/turn. */
  readonly resolveServers: ResolveNodeHostMcpRemoteServers<TPrincipal>;
  /** Required default-deny network policy, evaluated before every transport request. */
  readonly authorizeNetwork: (
    request: NodeHostMcpRemoteNetworkRequest<TPrincipal>,
  ) => boolean | Promise<boolean>;
  /** Compare host-specific principal fields such as data realm as well as tenant/subject. */
  readonly principalEquals?: (left: TPrincipal, right: TPrincipal) => boolean;
  readonly clientName?: string;
  readonly clientVersion?: string;
  readonly maxServers?: number;
  readonly maxToolsPerServer?: number;
  readonly maxToolResultChars?: number;
  /** Host-selected transport implementation; authorization still wraps every request. */
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * Build dynamic remote MCP tools with no ambient configuration, OAuth, stdio,
 * plugin, or filesystem authority. Every URL and redirect is host-authorized.
 */
export function createNodeHostMcpRemoteTools<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
>(
  options: CreateNodeHostMcpRemoteToolsOptions<TPrincipal>,
): HostToolResolver<TPrincipal> {
  const maxServers = boundedInteger(
    options.maxServers ?? MAX_SERVERS,
    "maxServers",
    MAX_SERVERS,
  );
  const maxToolsPerServer = boundedInteger(
    options.maxToolsPerServer ?? MAX_TOOLS_PER_SERVER,
    "maxToolsPerServer",
    MAX_TOOLS_PER_SERVER,
  );
  const maxToolResultChars = boundedInteger(
    options.maxToolResultChars ?? MAX_TOOL_RESULT_CHARS,
    "maxToolResultChars",
    MAX_TOOL_RESULT_CHARS,
  );
  const clientName = options.clientName?.trim() || "agentlink-node-host";
  const clientVersion = options.clientVersion?.trim() || "0.1.0";
  const transportFetch = options.fetch ?? globalThis.fetch;

  return async (request) => {
    const servers = await resolveServers(
      options.resolveServers,
      request,
      maxServers,
    );
    const tools = [];
    const names = new Set<string>();
    for (const server of servers) {
      const endpoint = parseHttpsUrl(server.url);
      if (!endpoint) continue;
      const fetch = createAuthorizedFetch(
        options.authorizeNetwork,
        transportFetch,
        request,
        server.id,
      );
      const client = new Client(
        { name: clientName, version: clientVersion },
        { capabilities: {} },
      );
      try {
        const transport = createTransport(server, endpoint, fetch);
        await client.connect(transport);
        const catalog = await client.listTools();
        let acceptedTools = 0;
        for (const tool of catalog.tools) {
          if (acceptedTools >= maxToolsPerServer) break;
          const name = `${server.id}__${tool.name}`;
          if (!validToolName(name) || names.has(name)) continue;
          names.add(name);
          acceptedTools += 1;
          tools.push(
            defineTool<TPrincipal>({
              name,
              description: tool.description ?? `Call MCP tool ${tool.name}.`,
              inputSchema: asInputSchema(tool),
              effect: "external",
              authorization: "required",
              displayInput: (_input) => ({
                server: server.id,
                tool: tool.name,
              }),
              handler: async (input, context) => {
                if (!sameTurn(request, context, options.principalEquals)) {
                  return remoteCallError(
                    server,
                    tool.name,
                    "mcp_remote_turn_mismatch",
                  );
                }
                try {
                  const result = await callRemoteTool({
                    server,
                    endpoint,
                    fetch,
                    clientName,
                    clientVersion,
                    toolName: tool.name,
                    input,
                    signal: context.signal,
                  });
                  return {
                    modelContent: normalizeResult(result, maxToolResultChars),
                    displayContent: {
                      server: server.id,
                      tool: tool.name,
                      ...(result.isError ? { isError: true } : {}),
                    },
                    ...(result.isError ? { isError: true } : {}),
                  };
                } catch (error) {
                  return remoteCallError(
                    server,
                    tool.name,
                    "mcp_remote_call_failed",
                    error,
                  );
                }
              },
            }),
          );
        }
      } catch {
        // A single unavailable or unauthorized server never exposes tools or blocks sibling servers.
      } finally {
        await client.close().catch(() => undefined);
      }
    }
    return tools;
  };
}

async function resolveServers<TPrincipal extends AgentPrincipal>(
  resolve: ResolveNodeHostMcpRemoteServers<TPrincipal>,
  request: ResolveNodeHostMcpRemoteServersRequest<TPrincipal>,
  limit: number,
): Promise<readonly NodeHostMcpRemoteServer[]> {
  const servers = await resolve(request);
  const ids = new Set<string>();
  return servers
    .filter((server) => {
      if (
        ids.has(server.id) ||
        !validServerId(server.id) ||
        !validTimeout(server.timeoutMs)
      )
        return false;
      ids.add(server.id);
      return true;
    })
    .slice(0, limit);
}

function createTransport(
  server: NodeHostMcpRemoteServer,
  endpoint: URL,
  fetch: typeof globalThis.fetch,
) {
  const headers = server.headers ? { ...server.headers } : undefined;
  if (server.transport === "sse") {
    return new SSEClientTransport(endpoint, {
      fetch,
      ...(headers ? { requestInit: { headers } } : {}),
    });
  }
  return new StreamableHTTPClientTransport(endpoint, {
    fetch,
    ...(headers ? { requestInit: { headers } } : {}),
  });
}

function createAuthorizedFetch<TPrincipal extends AgentPrincipal>(
  authorize: CreateNodeHostMcpRemoteToolsOptions<TPrincipal>["authorizeNetwork"],
  transportFetch: typeof globalThis.fetch,
  request: ResolveNodeHostMcpRemoteServersRequest<TPrincipal>,
  serverId: string,
): typeof globalThis.fetch {
  return async (input, init) => {
    const url = new URL(
      input instanceof Request ? input.url : input.toString(),
    );
    const allowed = await authorize({ ...request, serverId, url });
    if (!allowed) throw new Error("mcp_remote_destination_not_authorized");
    const response = await (input instanceof Request
      ? transportFetch(new Request(input, { ...init, redirect: "error" }))
      : transportFetch(url, { ...init, redirect: "error" }));
    if (
      response.redirected ||
      (response.status >= 300 && response.status < 400)
    ) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("mcp_remote_redirect_not_allowed");
    }
    return response;
  };
}

function normalizeResult(result: CallToolResult, maxChars: number): string {
  const text = result.content
    .map((item) => {
      if (item.type === "text") return item.text;
      if (item.type === "image")
        return `[Image: ${item.mimeType}; ${item.data.length} base64 characters]`;
      if (item.type === "resource_link")
        return `Resource link: ${item.name}\nURI: ${item.uri}`;
      if (item.type === "resource" && "text" in item.resource)
        return item.resource.text;
      return `[${item.type}]`;
    })
    .join("\n");
  const structured = result.structuredContent
    ? `\nStructured content:\n${safeJson(result.structuredContent)}`
    : "";
  return boundedText(`${text}${structured}` || "", maxChars);
}

function asInputSchema(tool: Tool): CoreModelJsonSchema {
  const schema = tool.inputSchema;
  return schema && typeof schema === "object" && !Array.isArray(schema)
    ? (schema as CoreModelJsonSchema)
    : { type: "object", properties: {}, additionalProperties: false };
}

async function callRemoteTool(options: {
  readonly server: NodeHostMcpRemoteServer;
  readonly endpoint: URL;
  readonly fetch: typeof globalThis.fetch;
  readonly clientName: string;
  readonly clientVersion: string;
  readonly toolName: string;
  readonly input: Record<string, unknown>;
  readonly signal: AbortSignal | undefined;
}): Promise<CallToolResult> {
  const client = new Client(
    { name: options.clientName, version: options.clientVersion },
    { capabilities: {} },
  );
  try {
    await client.connect(
      createTransport(options.server, options.endpoint, options.fetch),
    );
    const result = await client.callTool(
      { name: options.toolName, arguments: options.input },
      undefined,
      {
        signal: options.signal,
        timeout: boundedTimeout(options.server.timeoutMs),
      },
    );
    if (!isCallToolResult(result)) {
      throw new Error(
        "MCP server returned an unsupported task-based tool result",
      );
    }
    return result;
  } finally {
    await client.close().catch(() => undefined);
  }
}

function isCallToolResult(value: unknown): value is CallToolResult {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    Array.isArray((value as { content?: unknown }).content)
  );
}

function remoteCallError(
  server: Readonly<NodeHostMcpRemoteServer>,
  tool: string,
  code: string,
  error?: unknown,
) {
  return {
    modelContent: JSON.stringify({
      error: code,
      server: server.id,
      tool,
      ...(error
        ? {
            message: boundedText(
              error instanceof Error ? error.message : String(error),
              500,
            ),
          }
        : {}),
    }),
    displayContent: { server: server.id, tool, isError: true },
    isError: true,
  };
}

function sameTurn<TPrincipal extends AgentPrincipal>(
  discovery: ResolveNodeHostMcpRemoteServersRequest<TPrincipal>,
  invocation: {
    readonly principal: TPrincipal;
    readonly sessionId: string;
    readonly turnId: string;
  },
  principalEquals: CreateNodeHostMcpRemoteToolsOptions<TPrincipal>["principalEquals"],
): boolean {
  const principalMatches = principalEquals
    ? principalEquals(discovery.principal, invocation.principal)
    : discovery.principal.tenantId === invocation.principal.tenantId &&
      discovery.principal.subjectId === invocation.principal.subjectId;
  return (
    principalMatches &&
    discovery.sessionId === invocation.sessionId &&
    discovery.turnId === invocation.turnId
  );
}

function parseHttpsUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
}

function validServerId(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_-]{0,40}$/.test(value);
}

function validToolName(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value);
}

function boundedInteger(value: number, field: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(
      `${field} must be a positive integer no greater than ${maximum}`,
    );
  }
  return value;
}

function validTimeout(value: number | undefined): boolean {
  return (
    value === undefined ||
    (Number.isSafeInteger(value) && value >= 1 && value <= MAX_TIMEOUT_MS)
  );
}

function boundedTimeout(value: number | undefined): number {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  return boundedInteger(value, "timeoutMs", MAX_TIMEOUT_MS);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "[Unable to serialize]";
  }
}

function boundedText(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}
