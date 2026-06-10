export interface ParsedMcpToolName {
  serverName: string;
  bareToolName: string;
}

export function parseMcpToolName(toolName: string): ParsedMcpToolName | null {
  const sep = toolName.indexOf("__");
  if (sep === -1) return null;
  return {
    serverName: toolName.slice(0, sep),
    bareToolName: toolName.slice(sep + 2),
  };
}

export function isMcpToolName(toolName: string): boolean {
  return parseMcpToolName(toolName) !== null;
}
