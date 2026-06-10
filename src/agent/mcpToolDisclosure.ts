import type { ToolDefinition } from "./providers/types.js";
import { estimateTokensFromChars } from "./contextBreakdown.js";
import { parseMcpToolName } from "./mcpToolNames.js";

export type McpToolDisclosureMode = "inline" | "deferred" | "auto";

export interface McpToolDisclosureConfig {
  serverName: string;
  mode?: McpToolDisclosureMode;
}

export interface McpToolDisclosureOptions {
  /** Defer an auto-mode server when its serialized schemas meet or exceed this estimate. */
  perServerTokenThreshold?: number;
  /** Maximum representative tool names to include in a deferred-server catalog entry. */
  representativeToolLimit?: number;
  serverConfigs?: McpToolDisclosureConfig[];
}

export interface McpToolDisclosureCatalogEntry {
  serverName: string;
  toolCount: number;
  estimatedTokens: number;
  representativeTools: string[];
}

export interface McpToolDisclosurePartition {
  inlineTools: ToolDefinition[];
  deferredTools: ToolDefinition[];
  catalog: McpToolDisclosureCatalogEntry[];
}

export const DEFAULT_MCP_DISCLOSURE_TOKEN_THRESHOLD = 2_000;
export const DEFAULT_MCP_DISCLOSURE_REPRESENTATIVE_TOOL_LIMIT = 5;

function measureTools(tools: ToolDefinition[]): {
  chars: number;
  estimatedTokens: number;
} {
  const chars = JSON.stringify(tools).length;
  return { chars, estimatedTokens: estimateTokensFromChars(chars) };
}

export function buildMcpToolCatalogSection(
  catalog: McpToolDisclosureCatalogEntry[] | undefined,
): string {
  if (!catalog?.length) return "";

  const lines = catalog.map((entry) => {
    const representatives = entry.representativeTools.length
      ? ` Representative tools: ${entry.representativeTools.join(", ")}.`
      : "";
    return `- ${entry.serverName}: ${entry.toolCount} tools, ~${entry.estimatedTokens} schema tokens deferred.${representatives}`;
  });

  return `\n\n## MCP Tool Catalog\n\nSome connected MCP servers have large tool schemas. Their full schemas may be deferred to reduce context bloat. Use MCP discovery tools before calling tools from these servers.\n\n${lines.join("\n")}`;
}

export function partitionMcpToolsForDisclosure(
  tools: ToolDefinition[],
  options: McpToolDisclosureOptions = {},
): McpToolDisclosurePartition {
  const perServerTokenThreshold =
    options.perServerTokenThreshold ?? DEFAULT_MCP_DISCLOSURE_TOKEN_THRESHOLD;
  const representativeToolLimit =
    options.representativeToolLimit ??
    DEFAULT_MCP_DISCLOSURE_REPRESENTATIVE_TOOL_LIMIT;
  const configuredModes = new Map(
    (options.serverConfigs ?? []).map((config) => [
      config.serverName,
      config.mode ?? "auto",
    ]),
  );

  const byServer = new Map<string, ToolDefinition[]>();
  const inlineTools: ToolDefinition[] = [];

  for (const tool of tools) {
    const parsed = parseMcpToolName(tool.name);
    if (!parsed) {
      inlineTools.push(tool);
      continue;
    }

    const existing = byServer.get(parsed.serverName) ?? [];
    existing.push(tool);
    byServer.set(parsed.serverName, existing);
  }

  const deferredTools: ToolDefinition[] = [];
  const catalog: McpToolDisclosureCatalogEntry[] = [];

  for (const [serverName, serverTools] of [...byServer.entries()].sort(
    ([a], [b]) => a.localeCompare(b),
  )) {
    const mode = configuredModes.get(serverName) ?? "auto";
    const measurement = measureTools(serverTools);
    const shouldDefer =
      mode === "deferred" ||
      (mode === "auto" &&
        measurement.estimatedTokens >= perServerTokenThreshold);

    if (!shouldDefer) {
      inlineTools.push(...serverTools);
      continue;
    }

    deferredTools.push(...serverTools);
    catalog.push({
      serverName,
      toolCount: serverTools.length,
      estimatedTokens: measurement.estimatedTokens,
      representativeTools: serverTools
        .map((tool) => parseMcpToolName(tool.name)?.bareToolName ?? tool.name)
        .sort((a, b) => a.localeCompare(b))
        .slice(0, representativeToolLimit),
    });
  }

  return {
    inlineTools,
    deferredTools,
    catalog,
  };
}
