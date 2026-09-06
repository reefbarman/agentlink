import type {
  GetPromptResult,
  Prompt,
  ReadResourceResult,
  Resource,
} from "@modelcontextprotocol/sdk/types.js";

import type { AgentPrincipal } from "@agentlink/core";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { ToolResult } from "@agentlink/protocol/tool-result";

const MAX_CATALOG_PAGES = 100;
const MAX_CATALOG_ITEMS = 10_000;
const MAX_CATALOG_CHARS = 100_000;
const MAX_CATALOG_FIELD_CHARS = 8_192;
const MAX_PROMPT_ARGUMENTS = 100;
const MAX_RESULT_CHARS = 100_000;
const DEFAULT_TIMEOUT_MS = 60_000;

export interface NodeHostMcpResourceSummary {
  readonly serverName: string;
  readonly uri: string;
  readonly name?: string;
  readonly description?: string;
  readonly mimeType?: string;
}

export interface NodeHostMcpPromptSummary {
  readonly serverName: string;
  readonly name: string;
  readonly description?: string;
  readonly arguments?: readonly {
    readonly name: string;
    readonly description?: string;
    readonly required?: boolean;
  }[];
}

export interface NodeHostMcpResourcePromptContext<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> {
  readonly principal: TPrincipal;
  readonly sessionId: string;
  readonly turnId: string;
  readonly signal?: AbortSignal;
}

export interface NodeHostMcpReadResourceRequest<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> extends NodeHostMcpResourcePromptContext<TPrincipal> {
  readonly serverName: string;
  readonly uri: string;
}

export interface NodeHostMcpGetPromptRequest<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> extends NodeHostMcpResourcePromptContext<TPrincipal> {
  readonly serverName: string;
  readonly name: string;
  readonly arguments?: Readonly<Record<string, string>>;
}

/** Turn-bound MCP resource/prompt snapshot with fresh, host-authorized operation connections. */
export interface NodeHostMcpResourcePromptProvider<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> {
  listResources(): readonly NodeHostMcpResourceSummary[];
  readResource(
    request: NodeHostMcpReadResourceRequest<TPrincipal>,
  ): Promise<ToolResult>;
  listPrompts(): readonly NodeHostMcpPromptSummary[];
  getPrompt(
    request: NodeHostMcpGetPromptRequest<TPrincipal>,
  ): Promise<ToolResult>;
}

/** @internal Transport adapters use this without exposing an ambient connection. */
export interface NodeHostMcpResourcePromptConnection<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> {
  readonly serverName: string;
  readonly timeoutMs?: number;
  connect(
    context: NodeHostMcpResourcePromptContext<TPrincipal>,
  ): Promise<Client>;
}

/** @internal Shared catalog/result behavior for the remote and stdio adapters. */
export async function createNodeHostMcpResourcePromptProvider<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
>(options: {
  readonly discovery: NodeHostMcpResourcePromptContext<TPrincipal>;
  readonly connections: readonly NodeHostMcpResourcePromptConnection<TPrincipal>[];
  readonly maxCatalogPages?: number;
  readonly maxCatalogItems?: number;
  readonly maxCatalogChars?: number;
  readonly maxResultChars?: number;
}): Promise<NodeHostMcpResourcePromptProvider<TPrincipal>> {
  const maxCatalogPages = boundedInteger(
    options.maxCatalogPages ?? MAX_CATALOG_PAGES,
    "maxCatalogPages",
    MAX_CATALOG_PAGES,
  );
  const maxCatalogItems = boundedInteger(
    options.maxCatalogItems ?? MAX_CATALOG_ITEMS,
    "maxCatalogItems",
    MAX_CATALOG_ITEMS,
  );
  const maxCatalogChars = boundedInteger(
    options.maxCatalogChars ?? MAX_CATALOG_CHARS,
    "maxCatalogChars",
    MAX_CATALOG_CHARS,
  );
  const maxResultChars = boundedInteger(
    options.maxResultChars ?? MAX_RESULT_CHARS,
    "maxResultChars",
    MAX_RESULT_CHARS,
  );
  const connections = new Map(
    options.connections.map((connection) => [
      connection.serverName,
      connection,
    ]),
  );
  const resources: NodeHostMcpResourceSummary[] = [];
  const prompts: NodeHostMcpPromptSummary[] = [];

  for (const connection of connections.values()) {
    let remainingCatalogChars = maxCatalogChars;
    let client: Client | undefined;
    try {
      client = await connection.connect(options.discovery);
      try {
        const listed = await walkCatalog<Resource>(
          (cursor) =>
            client!
              .listResources(
                cursor ? { cursor } : undefined,
                requestOptions(options.discovery.signal, connection.timeoutMs),
              )
              .then((result) => ({
                items: result.resources,
                nextCursor: result.nextCursor,
              })),
          maxCatalogPages,
          maxCatalogItems,
        );
        remainingCatalogChars = appendBoundedCatalogItems(
          resources,
          listed.map((resource) => ({
            serverName: connection.serverName,
            uri: boundedText(resource.uri, MAX_CATALOG_FIELD_CHARS),
            ...(resource.name
              ? { name: boundedText(resource.name, MAX_CATALOG_FIELD_CHARS) }
              : {}),
            ...(resource.description
              ? {
                  description: boundedText(
                    resource.description,
                    MAX_CATALOG_FIELD_CHARS,
                  ),
                }
              : {}),
            ...(resource.mimeType
              ? {
                  mimeType: boundedText(
                    resource.mimeType,
                    MAX_CATALOG_FIELD_CHARS,
                  ),
                }
              : {}),
          })),
          remainingCatalogChars,
        );
      } catch {
        // A server may support tools without resources.
      }
      try {
        const listed = await walkCatalog<Prompt>(
          (cursor) =>
            client!
              .listPrompts(
                cursor ? { cursor } : undefined,
                requestOptions(options.discovery.signal, connection.timeoutMs),
              )
              .then((result) => ({
                items: result.prompts,
                nextCursor: result.nextCursor,
              })),
          maxCatalogPages,
          maxCatalogItems,
        );
        appendBoundedCatalogItems(
          prompts,
          listed.map((prompt) => ({
            serverName: connection.serverName,
            name: boundedText(prompt.name, MAX_CATALOG_FIELD_CHARS),
            ...(prompt.description
              ? {
                  description: boundedText(
                    prompt.description,
                    MAX_CATALOG_FIELD_CHARS,
                  ),
                }
              : {}),
            ...(prompt.arguments
              ? {
                  arguments: prompt.arguments
                    .slice(0, MAX_PROMPT_ARGUMENTS)
                    .map((argument) => ({
                      name: boundedText(argument.name, MAX_CATALOG_FIELD_CHARS),
                      ...(argument.description
                        ? {
                            description: boundedText(
                              argument.description,
                              MAX_CATALOG_FIELD_CHARS,
                            ),
                          }
                        : {}),
                      ...(argument.required !== undefined
                        ? { required: argument.required }
                        : {}),
                    })),
                }
              : {}),
          })),
          remainingCatalogChars,
        );
      } catch {
        // A server may support tools without prompts.
      }
    } catch {
      // One unavailable or unauthorized server never blocks sibling catalogs.
    } finally {
      await client?.close().catch(() => undefined);
    }
  }

  const provider: NodeHostMcpResourcePromptProvider<TPrincipal> = {
    listResources: () => structuredClone(resources),
    listPrompts: () => structuredClone(prompts),
    readResource: async (request) => {
      const connection = connections.get(request.serverName);
      if (!connection || !request.uri.trim()) {
        return operationError("mcp_resource_not_available", request.serverName);
      }
      let client: Client | undefined;
      try {
        client = await connection.connect(request);
        const result = await client.readResource(
          { uri: request.uri },
          requestOptions(request.signal, connection.timeoutMs),
        );
        return normalizeResourceResult(result, request.uri, maxResultChars);
      } catch (error) {
        return operationError(
          "mcp_resource_read_failed",
          request.serverName,
          error,
        );
      } finally {
        await client?.close().catch(() => undefined);
      }
    },
    getPrompt: async (request) => {
      const connection = connections.get(request.serverName);
      if (!connection || !request.name.trim()) {
        return operationError("mcp_prompt_not_available", request.serverName);
      }
      let client: Client | undefined;
      try {
        client = await connection.connect(request);
        const result = await client.getPrompt(
          {
            name: request.name,
            ...(request.arguments
              ? { arguments: { ...request.arguments } }
              : {}),
          },
          requestOptions(request.signal, connection.timeoutMs),
        );
        return normalizePromptResult(result, maxResultChars);
      } catch (error) {
        return operationError(
          "mcp_prompt_get_failed",
          request.serverName,
          error,
        );
      } finally {
        await client?.close().catch(() => undefined);
      }
    },
  };
  return Object.freeze(provider);
}

function appendBoundedCatalogItems<T>(
  target: T[],
  items: readonly T[],
  remainingChars: number,
): number {
  let remaining = remainingChars;
  for (const item of items) {
    const chars = JSON.stringify(item).length;
    if (chars > remaining) break;
    target.push(item);
    remaining -= chars;
  }
  return remaining;
}

async function walkCatalog<T>(
  readPage: (
    cursor: string | undefined,
  ) => Promise<{ readonly items: readonly T[]; readonly nextCursor?: string }>,
  maxPages: number,
  maxItems: number,
): Promise<T[]> {
  const items: T[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < maxPages && items.length < maxItems; page += 1) {
    const result = await readPage(cursor);
    items.push(...result.items.slice(0, maxItems - items.length));
    const nextCursor = result.nextCursor?.trim();
    if (!nextCursor || cursors.has(nextCursor)) break;
    cursors.add(nextCursor);
    cursor = nextCursor;
  }
  return items;
}

function normalizeResourceResult(
  result: ReadResourceResult,
  uri: string,
  maxChars: number,
): ToolResult {
  let remaining = maxChars;
  const content: ToolResult["content"] = [];
  for (const item of result.contents) {
    if ("text" in item && typeof item.text === "string") {
      const text = boundedText(item.text, remaining);
      content.push({ type: "text", text });
      remaining = Math.max(0, remaining - text.length);
    } else if ("blob" in item && typeof item.blob === "string") {
      const mimeType = item.mimeType ?? "";
      if (mimeType.startsWith("image/") && item.blob.length <= remaining) {
        content.push({ type: "image", data: item.blob, mimeType });
        remaining -= item.blob.length;
      } else {
        const text = boundedText(`[Binary: ${uri}]`, remaining);
        content.push({ type: "text", text });
        remaining = Math.max(0, remaining - text.length);
      }
    }
    if (remaining === 0) break;
  }
  return { content: content.length ? content : [{ type: "text", text: "" }] };
}

function normalizePromptResult(
  result: GetPromptResult,
  maxChars: number,
): ToolResult {
  const text = result.messages
    .map((message) => {
      const content =
        message.content.type === "text"
          ? message.content.text
          : `[${message.content.type}]`;
      return `${message.role}: ${content}`;
    })
    .join("\n\n");
  return { content: [{ type: "text", text: boundedText(text, maxChars) }] };
}

function requestOptions(
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined,
) {
  return {
    signal,
    timeout: boundedTimeout(timeoutMs),
    onprogress: () => {},
    resetTimeoutOnProgress: false,
  };
}

function operationError(
  kind: string,
  serverName: string,
  error?: unknown,
): ToolResult {
  const message = error
    ? boundedText(error instanceof Error ? error.message : String(error), 500)
    : `MCP server '${serverName}' is not available`;
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ error: kind, server: serverName, message }),
      },
    ],
    isError: true,
    error: { kind, message },
  };
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
  return value === undefined
    ? DEFAULT_TIMEOUT_MS
    : boundedInteger(value, "timeoutMs", DEFAULT_TIMEOUT_MS);
}

function boundedText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  if (maxChars <= 0) return "";
  if (maxChars === 1) return "…";
  return `${value.slice(0, maxChars - 1)}…`;
}
