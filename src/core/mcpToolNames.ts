export interface ParsedMcpToolName {
  serverName: string;
  bareToolName: string;
}

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
