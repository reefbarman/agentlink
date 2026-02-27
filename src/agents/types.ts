export interface AgentDefinition {
  /** Unique identifier, e.g. "claude-code" */
  id: string;
  /** Display name, e.g. "Claude Code" */
  name: string;
  /** How to write MCP config for this agent */
  configMethod:
    | "claude-json" // ~/.claude.json with mcpServers key
    | "vscode-mcp-json" // .vscode/mcp.json with servers key (Copilot)
    | "roo-mcp-json" // .roo/mcp.json with mcpServers key
    | "kilocode-mcp-json" // .kilocode/mcp.json with mcpServers key
    | "cline-settings-json" // ~/.cline/data/settings/cline_mcp_settings.json
    | "codex-toml" // ~/.codex/config.toml with [mcp_servers.*] sections
    | "manual"; // No auto-config — show manual instructions
  /** HTTP type value this agent expects (varies by agent) */
  httpType?: string;
  /** Instruction file name, e.g. "CLAUDE.md" */
  instructionFile?: string;
  /** Where the agent looks for instruction files */
  instructionLocation?: string;
  /** Whether the agent supports PreToolUse hooks */
  supportsHooks?: boolean;
}

export interface ConfigWriter {
  /** Write the MCP server config for this agent. Returns true if successful. */
  write(port: number, authToken?: string): boolean;
  /** Write per-project config for a specific folder. */
  writeForFolder?(folderPath: string, port: number, authToken?: string): void;
  /** Remove config entries on server stop. */
  cleanup(): void;
  /** Remove config for a specific folder. */
  cleanupFolder?(folderPath: string): void;
  /** Check if the agent is currently configured. */
  isConfigured(): boolean;
}
