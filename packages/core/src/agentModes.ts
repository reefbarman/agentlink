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
