import type { CoreToolDefinition } from "./types.js";
import {
  getToolCapabilityMetadata,
  type NativeToolDisclosureClass,
} from "./toolCapabilities.js";

export const NATIVE_TOOL_DISCOVERY_DEFAULT_LIMIT = 10;
export const NATIVE_TOOL_DISCOVERY_MAX_LIMIT = 50;
export const NATIVE_TOOL_DISCOVERY_DEFAULT_SCHEMA_LIMIT = 1;
export const NATIVE_TOOL_DISCOVERY_MAX_SCHEMA_LIMIT = 10;

export interface NativeToolDisclosureSnapshot {
  readonly schemaVersion: 1;
  /** Direct definitions in their original provider order. */
  readonly inlineTools: readonly CoreToolDefinition[];
  /** Discoverable definitions in their original provider order. */
  readonly deferredTools: readonly CoreToolDefinition[];
  /** Canonical dormant definitions omitted from both provider and discovery catalogs. */
  readonly dormantToolNames: readonly string[];
}

export interface NativeToolDiscoveryRequest {
  readonly query?: string;
  readonly limit?: number;
  readonly offset?: number;
  readonly includeSchemas?: boolean;
  readonly schemaLimit?: number;
}

export interface NativeToolDiscoveryItem {
  readonly name: string;
  readonly description: string;
  readonly disclosure: NativeToolDisclosureClass;
  readonly input_schema?: CoreToolDefinition["input_schema"];
}

export interface NativeToolDiscoveryResult {
  readonly schemaVersion: 1;
  readonly tools: readonly NativeToolDiscoveryItem[];
  readonly total: number;
  readonly offset: number;
  readonly limit: number;
  readonly nextOffset?: number;
}

/**
 * Captures an immutable disclosure snapshot from an already-authorized tool list.
 * Unknown definitions are preserved inline so dynamic MCP/provider tools are not
 * accidentally reclassified by the native catalog.
 */
export function createNativeToolDisclosureSnapshot(
  definitions: readonly CoreToolDefinition[],
): NativeToolDisclosureSnapshot {
  const inlineTools: CoreToolDefinition[] = [];
  const deferredTools: CoreToolDefinition[] = [];
  const dormantToolNames: string[] = [];

  for (const definition of definitions) {
    const metadata = getToolCapabilityMetadata(definition.name);
    if (!metadata) {
      inlineTools.push(cloneAndFreezeDefinition(definition));
      continue;
    }

    switch (metadata.disclosure) {
      case "eligible":
        deferredTools.push(cloneAndFreezeDefinition(definition));
        break;
      case "dormant":
        dormantToolNames.push(definition.name);
        break;
      case "essential":
      case "hidden":
        inlineTools.push(cloneAndFreezeDefinition(definition));
        break;
    }
  }

  const discoveryToolIndex = inlineTools.findIndex(
    (tool) => tool.name === "find_native_tools",
  );
  if (discoveryToolIndex >= 0) {
    const discoveryTool = inlineTools[discoveryToolIndex]!;
    const deferredToolNames = deferredTools.map((tool) => tool.name).join(", ");
    inlineTools[discoveryToolIndex] = cloneAndFreezeDefinition({
      ...discoveryTool,
      description: `${discoveryTool.description} Deferred native tools in this catalog: ${deferredToolNames || "none"}.`,
    });
  }

  return Object.freeze({
    schemaVersion: 1 as const,
    inlineTools: Object.freeze(inlineTools),
    deferredTools: Object.freeze(deferredTools),
    dormantToolNames: Object.freeze(dormantToolNames),
  });
}

export function discoverNativeTools(
  snapshot: NativeToolDisclosureSnapshot,
  request: NativeToolDiscoveryRequest = {},
): NativeToolDiscoveryResult {
  const query = normalizeSearchText(request.query ?? "");
  const explicitNameMatches = query
    ? snapshot.deferredTools.filter((tool) =>
        containsSearchPhrase(query, normalizeSearchText(tool.name)),
      )
    : [];
  const remainingQuery = explicitNameMatches.reduce(
    (value, tool) => removeSearchPhrase(value, normalizeSearchText(tool.name)),
    query,
  );
  const remainingQueryTokens = discoveryQueryTokens(remainingQuery);
  const directNameMatches =
    query && explicitNameMatches.length === 0
      ? snapshot.deferredTools.filter((tool) =>
          normalizeSearchText(tool.name).includes(query),
        )
      : [];
  const rankedMatches =
    remainingQueryTokens.length > 0
      ? snapshot.deferredTools
          .map((tool, index) => ({
            tool,
            index,
            score: explicitNameMatches.includes(tool)
              ? 0
              : scoreDiscoveryMatch(tool, remainingQuery, remainingQueryTokens),
          }))
          .filter((candidate) => candidate.score > 0)
          .sort(
            (left, right) =>
              right.score - left.score || left.index - right.index,
          )
          .map((candidate) => candidate.tool)
      : [];
  const matches = explicitNameMatches.length
    ? [...explicitNameMatches, ...rankedMatches]
    : directNameMatches.length
      ? directNameMatches
      : remainingQueryTokens.length === 0
        ? [...snapshot.deferredTools]
        : rankedMatches;
  const limit = clampInteger(
    request.limit,
    NATIVE_TOOL_DISCOVERY_DEFAULT_LIMIT,
    1,
    NATIVE_TOOL_DISCOVERY_MAX_LIMIT,
  );
  const offset = clampInteger(request.offset, 0, 0, matches.length);
  const selected = matches.slice(offset, offset + limit);
  const schemaLimit = request.includeSchemas
    ? clampInteger(
        request.schemaLimit,
        NATIVE_TOOL_DISCOVERY_DEFAULT_SCHEMA_LIMIT,
        1,
        NATIVE_TOOL_DISCOVERY_MAX_SCHEMA_LIMIT,
      )
    : 0;
  const tools = selected.map((tool, index) => {
    const item: NativeToolDiscoveryItem = {
      name: tool.name,
      description: tool.description,
      disclosure: "eligible",
      ...(index < schemaLimit ? { input_schema: tool.input_schema } : {}),
    };
    return Object.freeze(item);
  });
  const nextOffset = offset + tools.length;

  return Object.freeze({
    schemaVersion: 1 as const,
    tools: Object.freeze(tools),
    total: matches.length,
    offset,
    limit,
    ...(nextOffset < matches.length ? { nextOffset } : {}),
  });
}

export function getDeferredNativeTool(
  snapshot: NativeToolDisclosureSnapshot,
  name: string,
): CoreToolDefinition | undefined {
  return snapshot.deferredTools.find((tool) => tool.name === name);
}

const DISCOVERY_QUERY_STOP_WORDS = new Set([
  "and",
  "deferred",
  "for",
  "from",
  "native",
  "please",
  "the",
  "tool",
  "tools",
  "with",
]);

function scoreDiscoveryMatch(
  tool: CoreToolDefinition,
  normalizedQuery: string,
  queryTokens: readonly string[],
): number {
  if (!normalizedQuery) return 1;
  const name = normalizeSearchText(tool.name);
  const description = normalizeSearchText(tool.description);
  if (name.includes(normalizedQuery)) return 1_000;

  let score = 0;
  for (const token of queryTokens) {
    if (name.split(" ").includes(token)) score += 20;
    else if (name.includes(token)) score += 12;
    else if (description.includes(token)) score += 4;
  }
  return score;
}

function discoveryQueryTokens(normalizedQuery: string): string[] {
  return [
    ...new Set(
      normalizedQuery
        .split(" ")
        .filter(
          (token) =>
            token.length >= 3 && !DISCOVERY_QUERY_STOP_WORDS.has(token),
        ),
    ),
  ];
}

function containsSearchPhrase(haystack: string, phrase: string): boolean {
  return ` ${haystack} `.includes(` ${phrase} `);
}

function removeSearchPhrase(value: string, phrase: string): string {
  return normalizeSearchText(` ${value} `.replace(` ${phrase} `, " "));
}

function normalizeSearchText(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function clampInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
}

function cloneAndFreezeDefinition(
  definition: CoreToolDefinition,
): CoreToolDefinition {
  return deepFreeze({
    ...definition,
    input_schema: deepClone(definition.input_schema),
    ...(definition.cache_control
      ? { cache_control: { ...definition.cache_control } }
      : {}),
  });
}

function deepClone<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => deepClone(item)) as T;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, deepClone(nested)]),
    ) as T;
  }
  return value;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}
