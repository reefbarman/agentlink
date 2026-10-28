import { parseJsonWithComments } from "@agentlink/protocol/jsonc";

/**
 * Agent mode definitions shared by every agent surface. Loading custom modes
 * from disk stays with the host; this module holds the built-in catalogue and
 * the pure parsing and resolution rules.
 */
export interface AgentMode {
  slug: string;
  name: string;
  /** Icon name for surfaces that render one (a codicon name in VS Code). */
  icon: string;
  roleDefinition?: string;
  toolGroups: string[];
  customInstructions?: string;
}

/**
 * Synthetic mode whose tool groups are the union of the given modes'. Used to
 * advertise a mode-independent tool list so switching modes never changes the
 * provider request's tool definitions (which would invalidate the entire
 * prompt-cache prefix). Per-mode restrictions are enforced at dispatch time
 * instead. "read-only-command" is subsumed when full "command" is present so
 * the union does not downgrade execute_command's advertised schema.
 */
export function buildUnionAgentMode(modes: readonly AgentMode[]): AgentMode {
  const groups = new Set<string>();
  for (const mode of modes) {
    for (const group of mode.toolGroups) groups.add(group);
  }
  if (groups.has("command")) groups.delete("read-only-command");
  return {
    slug: "all-modes",
    name: "All Modes",
    icon: "circuit-board",
    toolGroups: [...groups].sort(),
  };
}

export const BUILT_IN_MODES: AgentMode[] = [
  {
    slug: "code",
    name: "Code",
    icon: "code",
    toolGroups: [
      "read",
      "edit",
      "command",
      "language",
      "search",
      "memory",
      "mcp",
    ],
  },
  {
    slug: "architect",
    name: "Architect",
    icon: "organization",
    toolGroups: [
      "read",
      "language",
      "search",
      "memory",
      "mcp",
      "media",
      "plan",
    ],
  },
  {
    slug: "orchestrate",
    name: "Orchestrate",
    icon: "server-process",
    toolGroups: ["read", "language", "search", "memory", "mcp"],
  },
  {
    slug: "ask",
    name: "Ask",
    icon: "question",
    toolGroups: ["read", "search", "read-only-command"],
  },
  {
    slug: "debug",
    name: "Debug",
    icon: "debug",
    toolGroups: ["read", "command", "language", "search", "memory", "mcp"],
  },
  {
    slug: "review",
    name: "Review",
    icon: "checklist",
    toolGroups: ["read", "command", "language", "search"],
  },
];

/**
 * Static tool groups. The 'mcp' group is populated dynamically at runtime
 * from connected MCP servers. Tools in no group (questions, todos, final
 * status, background agents) are available in every mode.
 */
export const TOOL_GROUPS: Record<string, string[]> = {
  read: [
    "web_fetch",
    "read_file",
    "get_context",
    "get_repo_map",
    "get_module_neighbors",
    "list_files",
    "open_file",
    "get_editor_state",
    "search_session_history",
    "read_session_excerpt",
    "search_workspace_sessions",
    "read_workspace_session_excerpt",
    "diagnose_activity",
    "present_images",
    "inspect_page_images",
    "recall_memory",
    "compose",
  ],
  edit: [
    "write_file",
    "save_editor",
    "apply_diff",
    "find_and_replace",
    "rename_symbol",
    "generate_image",
    "save_session_image",
    "propose_memory",
  ],
  media: ["generate_image", "save_session_image"],
  command: ["execute_command", "get_terminal_output", "close_terminals"],
  language: [
    "get_diagnostics",
    "get_hover",
    "get_symbols",
    "get_references",
    "go_to_definition",
    "go_to_implementation",
    "go_to_type_definition",
    "get_call_hierarchy",
    "get_type_hierarchy",
  ],
  "language-benchmark": [
    "get_completions",
    "get_inlay_hints",
    "get_code_actions",
    "apply_code_action",
  ],
  search: ["web_search", "search_files"],
  memory: ["manage_memory"],
  "read-only-command": ["execute_command"],
  plan: ["write_file", "apply_diff", "execute_command", "get_terminal_output"],
  mcp: [], // populated dynamically from McpClientHub
};

/**
 * Get the flat set of allowed tool names for a given mode.
 * The optional mcpTools parameter injects dynamically discovered MCP server tools.
 */
export function getToolsForMode(
  mode: AgentMode,
  mcpTools: string[] = [],
): Set<string> {
  const groups: Record<string, string[]> = { ...TOOL_GROUPS, mcp: mcpTools };
  const allowed = new Set<string>();
  for (const group of mode.toolGroups) {
    for (const tool of groups[group] ?? []) {
      allowed.add(tool);
    }
  }
  if (mode.slug === "review") {
    allowed.add("write_file");
  }
  return allowed;
}

/**
 * Project-level custom mode files, in priority order: later sources override
 * earlier ones for the same slug. Paths are relative to the project root.
 */
export const CUSTOM_MODE_FILE_PATHS: readonly (readonly string[])[] = [
  [".agents", "modes.json"],
  [".claude", "modes.json"],
  [".agentlink", "modes.json"],
];

/** Custom mode schema as stored in modes.json */
interface CustomModeJson {
  slug: string;
  name: string;
  icon?: string;
  roleDefinition?: string;
  toolGroups?: string[];
  customInstructions?: string;
}

/** Parse one modes.json file. Invalid content yields no modes. */
export function parseCustomModesJson(raw: string): AgentMode[] {
  try {
    const parsed = parseJsonWithComments<CustomModeJson[]>(raw);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter(
        (m): m is CustomModeJson =>
          typeof m?.slug === "string" && typeof m?.name === "string",
      )
      .map((m) => ({
        slug: m.slug,
        name: m.name,
        icon: m.icon ?? "symbol-misc",
        roleDefinition: m.roleDefinition,
        toolGroups: Array.isArray(m.toolGroups)
          ? m.toolGroups
          : ["read", "search"],
        customInstructions: m.customInstructions,
      }));
  } catch {
    return [];
  }
}

/**
 * Merge the parsed contents of the custom mode files, given in
 * `CUSTOM_MODE_FILE_PATHS` order. Missing files are passed as `undefined`.
 */
export function mergeCustomModeSources(
  sources: readonly (string | undefined)[],
): AgentMode[] {
  const merged = new Map<string, AgentMode>();
  for (const raw of sources) {
    if (raw === undefined) continue;
    for (const mode of parseCustomModesJson(raw)) {
      merged.set(mode.slug, mode);
    }
  }
  return Array.from(merged.values());
}

/**
 * Merge built-in and custom modes. Custom modes with the same slug as a
 * built-in replace the built-in (allows users to override descriptions/tools).
 */
export function getAllModes(customModes: AgentMode[] = []): AgentMode[] {
  const customSlugs = new Set(customModes.map((m) => m.slug));
  const builtIns = BUILT_IN_MODES.filter((m) => !customSlugs.has(m.slug));
  return [...builtIns, ...customModes];
}

/**
 * Look up a mode by slug. Falls back to the 'code' mode if not found.
 */
export function resolveMode(slug: string, allModes: AgentMode[]): AgentMode {
  return (
    allModes.find((m) => m.slug === slug) ??
    allModes.find((m) => m.slug === "code") ??
    BUILT_IN_MODES[0]
  );
}
