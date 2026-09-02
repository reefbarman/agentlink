import {
  defineTool,
  type AgentPrincipal,
  type CoreModelJsonSchema,
  type HostToolResolver,
} from "@agentlink/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  DEFAULT_INHERITED_ENV_VARS,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import * as path from "node:path";

const MAX_SERVERS = 20;
const MAX_TOOLS_PER_SERVER = 100;
const MAX_TOOL_RESULT_CHARS = 100_000;
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * One fully host-specified stdio MCP launch. Nothing is inferred from MCP
 * configuration, the current directory, or process.env.
 */
export interface NodeHostMcpStdioServer {
  readonly id: string;
  /** Absolute executable path; PATH lookup is deliberately unavailable. */
  readonly command: string;
  /** Explicit arguments; an empty array means no arguments. */
  readonly args: readonly string[];
  /** Explicit absolute working directory; the host current directory is never used. */
  readonly cwd: string;
  /** Explicit child environment; ambient process.env is never inherited. */
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}

export interface ResolveNodeHostMcpStdioServersRequest<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> {
  readonly principal: TPrincipal;
  readonly sessionId: string;
  readonly turnId: string;
}

/** Resolve launches separately for the authenticated principal, session, and turn. */
export type ResolveNodeHostMcpStdioServers<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> = (
  request: ResolveNodeHostMcpStdioServersRequest<TPrincipal>,
) =>
  | readonly NodeHostMcpStdioServer[]
  | Promise<readonly NodeHostMcpStdioServer[]>;

/** Required host policy check before every stdio discovery and invocation launch. */
export interface NodeHostMcpStdioLaunchRequest<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> extends ResolveNodeHostMcpStdioServersRequest<TPrincipal> {
  readonly server: Readonly<NodeHostMcpStdioServer>;
}

export interface CreateNodeHostMcpStdioToolsOptions<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> {
  readonly resolveServers: ResolveNodeHostMcpStdioServers<TPrincipal>;
  /** Required default-deny launch policy, evaluated for each spawned child. */
  readonly authorizeLaunch: (
    request: NodeHostMcpStdioLaunchRequest<TPrincipal>,
  ) => boolean | Promise<boolean>;
  readonly clientName?: string;
  readonly clientVersion?: string;
  readonly maxServers?: number;
  readonly maxToolsPerServer?: number;
  readonly maxToolResultChars?: number;
}

/**
 * Build dynamic stdio MCP tools without ambient config, plugin, filesystem, or
 * process-environment authority. The host supplies and authorizes every launch.
 */
export function createNodeHostMcpStdioTools<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
>(
  options: CreateNodeHostMcpStdioToolsOptions<TPrincipal>,
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

  return async (request) => {
    const servers = await resolveServers(
      options.resolveServers,
      request,
      maxServers,
    );
    const tools = [];
    const names = new Set<string>();
    for (const server of servers) {
      if (!(await options.authorizeLaunch({ ...request, server }))) continue;
      const client = new Client(
        { name: clientName, version: clientVersion },
        { capabilities: {} },
      );
      try {
        await client.connect(createTransport(server));
        const catalog = await client.listTools();
        for (const tool of catalog.tools.slice(0, maxToolsPerServer)) {
          const name = `${server.id}__${tool.name}`;
          if (!validToolName(name) || names.has(name)) continue;
          names.add(name);
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
                if (!sameTurn(request, context)) {
                  return launchError(
                    server,
                    tool.name,
                    "mcp_stdio_turn_mismatch",
                  );
                }
                try {
                  if (
                    !(await options.authorizeLaunch({ ...request, server }))
                  ) {
                    return launchError(
                      server,
                      tool.name,
                      "mcp_stdio_launch_not_authorized",
                    );
                  }
                  const result = await callStdioTool({
                    server,
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
                  return launchError(
                    server,
                    tool.name,
                    "mcp_stdio_call_failed",
                    error,
                  );
                }
              },
            }),
          );
        }
      } catch {
        // One unavailable or policy-denied child never exposes tools or blocks peers.
      } finally {
        await client.close().catch(() => undefined);
      }
    }
    return tools;
  };
}

async function resolveServers<TPrincipal extends AgentPrincipal>(
  resolve: ResolveNodeHostMcpStdioServers<TPrincipal>,
  request: ResolveNodeHostMcpStdioServersRequest<TPrincipal>,
  limit: number,
): Promise<readonly NodeHostMcpStdioServer[]> {
  const servers = await resolve(request);
  const ids = new Set<string>();
  const valid: NodeHostMcpStdioServer[] = [];
  for (const server of servers) {
    if (ids.has(server.id) || !validServer(server)) continue;
    ids.add(server.id);
    valid.push(cloneServer(server));
    if (valid.length === limit) break;
  }
  return valid;
}

function createTransport(server: Readonly<NodeHostMcpStdioServer>) {
  return new StdioClientTransport({
    command: server.command,
    args: [...server.args],
    cwd: server.cwd,
    // The SDK otherwise merges its safe ambient list. Blank every inherited
    // key first so only values the host supplied for this launch can survive.
    env: {
      ...Object.fromEntries(
        DEFAULT_INHERITED_ENV_VARS.map((name) => [name, ""]),
      ),
      ...server.env,
    },
    // Do not inherit the host stderr or retain child output in an unread buffer.
    stderr: "ignore",
  });
}

async function callStdioTool(options: {
  readonly server: Readonly<NodeHostMcpStdioServer>;
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
    await client.connect(createTransport(options.server));
    const result = await client.callTool(
      { name: options.toolName, arguments: options.input },
      undefined,
      {
        signal: options.signal,
        timeout: boundedTimeout(options.server.timeoutMs),
        onprogress: () => {},
        // A server cannot extend the host's fixed child-process deadline merely
        // by emitting progress indefinitely.
        resetTimeoutOnProgress: false,
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

function launchError(
  server: Readonly<NodeHostMcpStdioServer>,
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
  discovery: ResolveNodeHostMcpStdioServersRequest<TPrincipal>,
  invocation: {
    readonly principal: TPrincipal;
    readonly sessionId: string;
    readonly turnId: string;
  },
): boolean {
  return (
    discovery.principal.tenantId === invocation.principal.tenantId &&
    discovery.principal.subjectId === invocation.principal.subjectId &&
    discovery.sessionId === invocation.sessionId &&
    discovery.turnId === invocation.turnId
  );
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

function isCallToolResult(value: unknown): value is CallToolResult {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    Array.isArray((value as { content?: unknown }).content)
  );
}

function validServer(server: NodeHostMcpStdioServer): boolean {
  return (
    validServerId(server.id) &&
    path.isAbsolute(server.command) &&
    path.isAbsolute(server.cwd) &&
    Array.isArray(server.args) &&
    server.args.every(validArgument) &&
    validEnvironment(server.env) &&
    (server.timeoutMs === undefined || validTimeout(server.timeoutMs))
  );
}

function validServerId(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_-]{0,40}$/.test(value);
}

function validToolName(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value);
}

function validArgument(value: unknown): value is string {
  return typeof value === "string" && !value.includes("\0");
}

function validEnvironment(
  value: unknown,
): value is Readonly<Record<string, string>> {
  return (
    isRecord(value) &&
    Object.entries(value).every(
      ([name, entry]) =>
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) &&
        typeof entry === "string" &&
        !entry.includes("\0"),
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validTimeout(value: number): boolean {
  return (
    Number.isSafeInteger(value) && value >= 1 && value <= DEFAULT_TIMEOUT_MS
  );
}

function boundedInteger(value: number, field: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(
      `${field} must be a positive integer no greater than ${maximum}`,
    );
  }
  return value;
}

function boundedTimeout(value: number | undefined): number {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  return boundedInteger(value, "timeoutMs", DEFAULT_TIMEOUT_MS);
}

function cloneServer(server: NodeHostMcpStdioServer): NodeHostMcpStdioServer {
  return {
    id: server.id,
    command: server.command,
    args: [...server.args],
    cwd: server.cwd,
    env: { ...server.env },
    ...(server.timeoutMs === undefined ? {} : { timeoutMs: server.timeoutMs }),
  };
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
