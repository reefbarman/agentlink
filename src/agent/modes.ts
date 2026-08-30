import * as fs from "fs/promises";
import * as path from "path";

import { parseJsonWithComments } from "@agentlink/protocol/jsonc";

export interface AgentMode {
  slug: string;
  name: string;
  /** VS Code codicon name (without 'codicon-' prefix) */
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
    toolGroups: ["read", "language", "search", "memory", "mcp", "plan"],
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

/** Custom mode schema as stored in modes.json */
interface CustomModeJson {
  slug: string;
  name: string;
  icon?: string;
  roleDefinition?: string;
  toolGroups?: string[];
  customInstructions?: string;
}

function parseModesJson(raw: string): AgentMode[] {
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
 * Load custom mode definitions from modes.json files (project-level only).
 *
 * Priority (.agents → .claude → .agentlink): later sources override
 * earlier for the same slug.
 */
export async function loadCustomModes(cwd: string): Promise<AgentMode[]> {
  const sources = [
    path.join(cwd, ".agents", "modes.json"),
    path.join(cwd, ".claude", "modes.json"),
    path.join(cwd, ".agentlink", "modes.json"),
  ];

  const merged = new Map<string, AgentMode>();
  for (const filePath of sources) {
    try {
      const raw = await fs.readFile(filePath, "utf-8");
      for (const mode of parseModesJson(raw)) {
        merged.set(mode.slug, mode);
      }
    } catch {
      // File doesn't exist or is unreadable — skip
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
