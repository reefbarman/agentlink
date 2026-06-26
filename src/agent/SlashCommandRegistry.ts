import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { loadProjectlessSkills, loadSkills } from "./skillLoader.js";

export interface SlashCommand {
  name: string;
  description: string;
  source: "builtin" | "project" | "global" | "agentlink" | "skill";
  /** True if this is a built-in that executes immediately (not a prompt template) */
  builtin: boolean;
  /** Body to inject into the input when selected (for file-based commands) */
  body?: string;
  /** Absolute SKILL.md path for generated skill commands. */
  skillPath?: string;
}

/** Parse YAML frontmatter from a markdown file. Returns `{}` if not present. */
function parseFrontmatter(content: string): {
  frontmatter: Record<string, string>;
  body: string;
} {
  if (!content.startsWith("---")) {
    return { frontmatter: {}, body: content };
  }
  const end = content.indexOf("\n---", 3);
  if (end === -1) {
    return { frontmatter: {}, body: content };
  }
  const fmLines = content.slice(3, end).trim().split("\n");
  const frontmatter: Record<string, string> = {};
  for (const line of fmLines) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    frontmatter[key] = value;
  }
  return { frontmatter, body: content.slice(end + 4).trim() };
}

/**
 * Load slash commands from a directory of .md files.
 * Each file becomes a command named after its basename (without extension).
 */
export async function loadCommandsFromDir(
  dir: string,
  source: SlashCommand["source"],
  prefix = "",
): Promise<SlashCommand[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const commands: SlashCommand[] = [];

    for (const entry of entries) {
      if (entry.isDirectory()) {
        // Recurse: subdirectory "foo" gives prefix "foo:"
        const sub = await loadCommandsFromDir(
          path.join(dir, entry.name),
          source,
          prefix ? `${prefix}:${entry.name}` : entry.name,
        );
        commands.push(...sub);
      } else if (entry.name.endsWith(".md")) {
        const base = entry.name.slice(0, -3);
        const name = prefix ? `${prefix}:${base}` : base;
        try {
          const raw = await fs.readFile(path.join(dir, entry.name), "utf-8");
          const { frontmatter, body } = parseFrontmatter(raw);
          commands.push({
            name,
            description: frontmatter.description ?? `Run /${name}`,
            source,
            builtin: false,
            body,
          });
        } catch {
          // skip unreadable files
        }
      }
    }

    return commands;
  } catch {
    return [];
  }
}

const ASK_AGENT_SAFE_PROMPT_BUILTIN_COMMAND_NAMES = new Set(["remember"]);
const ASK_AGENT_SAFE_ACTION_BUILTIN_COMMAND_NAMES = new Set([
  "mcp",
  "mcp-config",
  "mcp-refresh",
]);

/** Built-in slash commands. */
export const BUILTIN_COMMANDS: SlashCommand[] = [
  {
    name: "new",
    description: "Start a new chat session",
    source: "builtin",
    builtin: true,
  },

  {
    name: "mode",
    description: "Switch mode: /mode <slug>",
    source: "builtin",
    builtin: true,
  },
  {
    name: "model",
    description: "Switch model: /model <name>",
    source: "builtin",
    builtin: true,
  },
  {
    name: "condense",
    description: "Condense conversation context",
    source: "builtin",
    builtin: true,
  },
  {
    name: "checkpoint",
    description: "Create a workspace checkpoint",
    source: "builtin",
    builtin: true,
  },
  {
    name: "revert",
    description: "Revert to the latest checkpoint or /revert <checkpoint-id>",
    source: "builtin",
    builtin: true,
  },
  {
    name: "help",
    description: "Show available slash commands",
    source: "builtin",
    builtin: true,
  },
  {
    name: "remember",
    description:
      "Review this session for durable learnings and propose approved memory/config updates",
    source: "builtin",
    builtin: false,
    body: "Review this session for durable cross-session learnings. If something qualifies, check the most appropriate target for duplicates or contradictions, then call propose_memory using the highest appropriate tier: instructions for stable rules/conventions, skill for reusable workflows, command for reusable slash-command prompts, or memory for lower-authority facts/preferences/gotchas. Prefer concise date-stamped entries, batch related learnings, and do not propose anything session-specific, unverified, secret, or easy to rediscover. If nothing qualifies, say so briefly.",
  },
  {
    name: "skills",
    description: "Show detected AgentLink skills for the current mode",
    source: "builtin",
    builtin: true,
  },
  {
    name: "mcp",
    description: "Show MCP server connection status",
    source: "builtin",
    builtin: true,
  },
  {
    name: "mcp-config",
    description: "Open MCP server config (status-only in Browser Ask Agent)",
    source: "builtin",
    builtin: true,
  },
  {
    name: "mcp-refresh",
    description: "Reconnect all MCP servers",
    source: "builtin",
    builtin: true,
  },
  {
    name: "btw",
    description: "Ask a quick side question: /btw <question>",
    source: "builtin",
    builtin: true,
  },
  {
    name: "pair",
    description:
      "Show a pairing code for a new browser device (or /pair list to manage)",
    source: "builtin",
    builtin: true,
  },
];

function skillToSlashCommand(skill: {
  name: string;
  description: string;
  skillPath: string;
}): SlashCommand {
  return {
    name: `skill:${skill.name}`,
    description: skill.description || `Use skill ${skill.name}`,
    source: "skill",
    builtin: false,
    body: `Use the skill "${skill.name}" by calling load_skill with path ${JSON.stringify(skill.skillPath)}, then follow its instructions for this request.`,
    skillPath: skill.skillPath,
  };
}

function skillToAskAgentSlashCommand(skill: {
  name: string;
  description: string;
  skillPath: string;
  body?: string;
}): SlashCommand {
  const body = skill.body?.trim();
  return {
    name: `skill:${skill.name}`,
    description: skill.description || `Use skill ${skill.name}`,
    source: "skill",
    builtin: false,
    body: body
      ? `Use the following AgentLink skill instructions for this request. Stay within Ask Agent's read-only, projectless constraints; do not run tools, edit files, or assume workspace access.\n\nSkill: ${skill.name}\nPath: ${skill.skillPath}\n\n${body}`
      : `Use the skill "${skill.name}" for this request. Stay within Ask Agent's read-only, projectless constraints; do not run tools, edit files, or assume workspace access.`,
    skillPath: skill.skillPath,
  };
}

function isAskAgentSafeSkill(skill: { allowedTools?: string[] }): boolean {
  // In projectless Ask Agent, skills must be prompt-only/manual initially. Any
  // declared tool allowlist can expand capabilities, so keep those out until the
  // Ask Agent runtime has explicit safe tool enforcement.
  return !skill.allowedTools || skill.allowedTools.length === 0;
}

async function loadAskAgentSkillCommands(
  modeSlug: string,
): Promise<SlashCommand[]> {
  const skills = await loadProjectlessSkills(modeSlug);
  return skills.filter(isAskAgentSafeSkill).map(skillToAskAgentSlashCommand);
}

function asAskAgentRuleCommand(command: SlashCommand): SlashCommand {
  return {
    ...command,
    description: command.description || `Apply global rule /${command.name}`,
    body: command.body
      ? `Apply the following global rule for this Ask Agent request. Stay within Ask Agent's read-only, projectless constraints; do not run tools, edit files, or assume workspace access.\n\n${command.body}`
      : command.body,
  };
}

async function loadProjectlessGlobalCommandPrompts(): Promise<SlashCommand[]> {
  const home = os.homedir();
  const sources = await Promise.all([
    loadCommandsFromDir(path.join(home, ".agents", "commands"), "global"),
    loadCommandsFromDir(path.join(home, ".claude", "commands"), "global"),
    loadCommandsFromDir(path.join(home, ".agentlink", "commands"), "global"),
  ]);

  const byName = new Map<string, SlashCommand>();
  for (const commands of sources) {
    for (const command of commands) {
      if (command.builtin) continue;
      byName.set(command.name, command);
    }
  }
  return Array.from(byName.values());
}

async function loadProjectlessGlobalRulePrompts(): Promise<SlashCommand[]> {
  const home = os.homedir();
  const sources = await Promise.all([
    loadCommandsFromDir(path.join(home, ".agents", "rules"), "global", "rule"),
    loadCommandsFromDir(path.join(home, ".claude", "rules"), "global", "rule"),
    loadCommandsFromDir(
      path.join(home, ".agentlink", "rules"),
      "global",
      "rule",
    ),
  ]);

  const byName = new Map<string, SlashCommand>();
  for (const commands of sources) {
    for (const command of commands) {
      if (!command.body?.trim()) continue;
      byName.set(command.name, asAskAgentRuleCommand(command));
    }
  }
  return Array.from(byName.values());
}

/**
 * Load slash commands for Browser Ask Agent's projectless/safe surface.
 *
 * This intentionally excludes workspace-local commands/skills and unsafe
 * execution built-ins. Only prompt-template built-ins, safe MCP status/config
 * action built-ins, global prompt commands, and safe packaged/global generated
 * skill prompt commands are exposed.
 */
export async function loadAskAgentSlashCommands(
  modeSlug = "ask",
): Promise<SlashCommand[]> {
  const safeBuiltins = BUILTIN_COMMANDS.filter((command) =>
    command.builtin
      ? ASK_AGENT_SAFE_ACTION_BUILTIN_COMMAND_NAMES.has(command.name)
      : ASK_AGENT_SAFE_PROMPT_BUILTIN_COMMAND_NAMES.has(command.name),
  );
  const sources = await Promise.all([
    loadProjectlessGlobalCommandPrompts(),
    loadProjectlessGlobalRulePrompts(),
    loadAskAgentSkillCommands(modeSlug),
  ]);

  const byName = new Map<string, SlashCommand>();
  // Keep Ask Agent executable built-ins authoritative so a prompt command named
  // /mcp cannot shadow the browser-safe action handler.
  for (const commands of [...sources, safeBuiltins]) {
    for (const command of commands) {
      byName.set(command.name, command);
    }
  }
  return Array.from(byName.values());
}

export class SlashCommandRegistry {
  private commands: SlashCommand[] = [...BUILTIN_COMMANDS];
  private cwd: string;
  private modeSlug: string;

  constructor(cwd: string, modeSlug = "code") {
    this.cwd = cwd;
    this.modeSlug = modeSlug;
  }

  setMode(modeSlug: string): void {
    this.modeSlug = modeSlug;
  }

  /**
   * Load all user-defined commands from disk. Call on startup and on file changes.
   *
   * Priority (later entries override earlier for the same command name):
   *   .agents → .claude → .agentlink, global → project
   */
  async reload(): Promise<void> {
    const home = os.homedir();
    const cwd = this.cwd;

    // Load all sources in ascending priority order
    const sources = await Promise.all([
      // Global .agents (lowest)
      loadCommandsFromDir(path.join(home, ".agents", "commands"), "global"),
      // Global .claude
      loadCommandsFromDir(path.join(home, ".claude", "commands"), "global"),
      // Global .agentlink
      loadCommandsFromDir(path.join(home, ".agentlink", "commands"), "global"),
      // Generated skill commands are lower precedence than explicit project file commands.
      this.loadSkillCommands(),
      // Project .agents
      loadCommandsFromDir(path.join(cwd, ".agents", "commands"), "project"),
      // Project .claude
      loadCommandsFromDir(path.join(cwd, ".claude", "commands"), "project"),
      // Project .agentlink (highest)
      loadCommandsFromDir(
        path.join(cwd, ".agentlink", "commands"),
        "agentlink",
      ),
    ]);

    // Build deduplicated list — later sources override earlier for same name
    const byName = new Map<string, SlashCommand>();
    for (const cmds of sources) {
      for (const cmd of cmds) {
        byName.set(cmd.name, cmd);
      }
    }

    this.commands = [...BUILTIN_COMMANDS, ...Array.from(byName.values())];
  }

  private async loadSkillCommands(): Promise<SlashCommand[]> {
    const skills = await loadSkills(this.cwd, this.modeSlug);
    return skills.map(skillToSlashCommand);
  }

  getAll(): SlashCommand[] {
    return this.commands;
  }

  getSkillCommands(): SlashCommand[] {
    return this.commands.filter((command) => command.source === "skill");
  }

  /** Filter commands matching a prefix query (case-insensitive). */
  search(query: string): SlashCommand[] {
    const lower = query.toLowerCase();
    return this.commands.filter((c) => c.name.toLowerCase().startsWith(lower));
  }
}
