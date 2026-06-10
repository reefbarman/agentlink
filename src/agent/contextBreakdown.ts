import type {
  ContextBreakdownItem,
  ToolContextBreakdown,
} from "../shared/types.js";

import type { ToolDefinition } from "./providers/types.js";
import { parseMcpToolName } from "./mcpToolNames.js";

const APPROX_CHARS_PER_TOKEN = 4;

export function estimateTokensFromChars(chars: number): number {
  return Math.ceil(chars / APPROX_CHARS_PER_TOKEN);
}

export function measureContextItem(
  label: string,
  content: string,
  count?: number,
): ContextBreakdownItem {
  const chars = content.length;
  return {
    label,
    chars,
    estimatedTokens: estimateTokensFromChars(chars),
    ...(count === undefined ? {} : { count }),
  };
}

function measureTool(tool: ToolDefinition): number {
  return JSON.stringify(tool).length;
}

export function buildToolContextBreakdown(
  tools: ToolDefinition[] | undefined,
): ToolContextBreakdown {
  const allTools = tools ?? [];
  let nativeChars = 0;
  let nativeCount = 0;
  const mcpServers = new Map<string, { chars: number; count: number }>();

  for (const tool of allTools) {
    const chars = measureTool(tool);
    const serverName = parseMcpToolName(tool.name)?.serverName;
    if (!serverName) {
      nativeChars += chars;
      nativeCount += 1;
      continue;
    }
    const existing = mcpServers.get(serverName) ?? { chars: 0, count: 0 };
    existing.chars += chars;
    existing.count += 1;
    mcpServers.set(serverName, existing);
  }

  const mcpServerEntries = [...mcpServers.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([serverName, item]) => ({
      serverName,
      chars: item.chars,
      estimatedTokens: estimateTokensFromChars(item.chars),
      toolCount: item.count,
    }));
  const mcpChars = mcpServerEntries.reduce((sum, item) => sum + item.chars, 0);
  const totalChars = nativeChars + mcpChars;

  return {
    totalToolCount: allTools.length,
    totalChars,
    estimatedTokens: estimateTokensFromChars(totalChars),
    native: {
      label: "native+meta tools",
      chars: nativeChars,
      estimatedTokens: estimateTokensFromChars(nativeChars),
      count: nativeCount,
    },
    mcp: {
      totalServerCount: mcpServerEntries.length,
      totalToolCount: mcpServerEntries.reduce(
        (sum, item) => sum + item.toolCount,
        0,
      ),
      totalChars: mcpChars,
      estimatedTokens: estimateTokensFromChars(mcpChars),
      servers: mcpServerEntries,
    },
  };
}
