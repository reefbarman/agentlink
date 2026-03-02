import type { AgentDefinition } from "./types.js";

export const KNOWN_AGENTS: AgentDefinition[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    configMethod: "claude-json",
    httpType: "http",
    instructionFile: "CLAUDE.md",
    instructionLocation: "~/.claude/CLAUDE.md",
    supportsHooks: true,
  },
  {
    id: "copilot",
    name: "GitHub Copilot",
    configMethod: "vscode-mcp-json",
    httpType: "http",
    instructionFile: "copilot-instructions.md",
    instructionLocation: ".github/copilot-instructions.md",
    supportsHooks: true,
  },
  {
    id: "roo-code",
    name: "Roo Code",
    configMethod: "roo-mcp-json",
    httpType: "streamable-http",
    instructionFile: ".md files",
    instructionLocation: ".roo/rules/",
    supportsHooks: false,
  },

  {
    id: "kilo-code",
    name: "Kilo Code",
    configMethod: "kilocode-mcp-json",
    httpType: "streamable-http",
    instructionFile: ".md files",
    instructionLocation: ".kilocode/rules/",
    supportsHooks: false,
  },
  {
    id: "cline",
    name: "Cline",
    configMethod: "cline-settings-json",
    httpType: undefined, // Cline auto-detects from url, no type field needed
    instructionFile: ".clinerules",
    instructionLocation: ".clinerules or .clinerules/",
    supportsHooks: false,
  },
  {
    id: "codex",
    name: "Codex",
    configMethod: "codex-toml",
    httpType: undefined, // Uses url field directly, no type
    instructionFile: "AGENTS.md",
    instructionLocation: "AGENTS.md (per-directory)",
    supportsHooks: false,
  },
];

export function getAgentById(id: string): AgentDefinition | undefined {
  return KNOWN_AGENTS.find((a) => a.id === id);
}

/**
 * Match an MCP client name (from the initialize handshake) to a known agent ID.
 * Returns undefined if no match is found.
 */
export function matchClientName(clientName: string): string | undefined {
  const lower = clientName.toLowerCase();
  for (const agent of KNOWN_AGENTS) {
    // Match against agent id (e.g. "claude-code") or display name (e.g. "Claude Code")
    if (
      lower.includes(agent.id) ||
      lower.includes(agent.name.toLowerCase())
    ) {
      return agent.id;
    }
  }
  return undefined;
}
