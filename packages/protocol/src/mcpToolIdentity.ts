export interface ParsedMcpToolName {
  serverName: string;
  bareToolName: string;
}

/** Parses AgentLink's canonical `server__tool` MCP identity at the first separator. */
export function parseMcpToolName(toolName: string): ParsedMcpToolName | null {
  const separatorIndex = toolName.indexOf("__");
  if (separatorIndex === -1) return null;
  return {
    serverName: toolName.slice(0, separatorIndex),
    bareToolName: toolName.slice(separatorIndex + 2),
  };
}

export function isMcpToolName(toolName: string): boolean {
  return parseMcpToolName(toolName) !== null;
}
