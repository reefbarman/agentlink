import path from "node:path";

import {
  BUILT_IN_MODES,
  CUSTOM_MODE_FILE_PATHS,
  getAllModes,
  mergeCustomModeSources,
  resolveMode,
  TOOL_GROUPS,
  type AgentMode,
} from "@agentlink/core/agent-modes";
import {
  deriveSystemPromptCapabilities,
  type SystemPromptCapabilities,
} from "@agentlink/core/system-prompt";
import type { HostTool, HostToolResult } from "@agentlink/core";
import type { NodeHostFileSystem } from "@agentlink/node-host";

/** The mode a session without one runs in. */
export const DEFAULT_WORKSPACE_MODE = "code";

/**
 * Built-in modes this host cannot honour. Orchestrate delegates to tiered
 * background agents, which workspace-host's background tools do not offer.
 */
const UNAVAILABLE_BUILT_IN_MODES: ReadonlySet<string> = new Set([
  "orchestrate",
]);

/** workspace-host's MCP bridge tools, the `mcp` group here. */
const MCP_BRIDGE_TOOLS = [
  "find_mcp_tools",
  "call_mcp_tool",
  "list_mcp_resources",
  "read_mcp_resource",
  "list_mcp_prompts",
  "get_mcp_prompt",
];

/**
 * workspace-host's own names for tools in VS Code's groups. Its
 * `get_command_output`, `list_commands` and `stop_command` stand in for
 * VS Code's `get_terminal_output` and `close_terminals`.
 */
const HOST_GROUP_MEMBERS: Readonly<Record<string, readonly string[]>> = {
  command: ["get_command_output", "list_commands", "stop_command"],
  plan: ["get_command_output", "list_commands", "stop_command"],
  mcp: MCP_BRIDGE_TOOLS,
};

/**
 * Tools that some mode can withhold. Any other tool (questions, todos,
 * final status, background agents, skills, rules) is available in every
 * mode, as in VS Code.
 */
const MODE_GOVERNED_TOOLS: ReadonlySet<string> = new Set([
  ...Object.values(TOOL_GROUPS).flat(),
  ...Object.values(HOST_GROUP_MEMBERS).flat(),
]);

/**
 * Tool names a mode allows here. Follows VS Code's `getToolsForMode`,
 * except `read-only-command` (VS Code's read-only command review is not
 * ported, so it grants nothing) and Review mode's temporary-file
 * `write_file` (this host only writes inside the project).
 */
export function workspaceToolsForMode(mode: AgentMode): Set<string> {
  const allowed = new Set<string>();
  for (const group of mode.toolGroups) {
    if (group === "read-only-command") continue;
    for (const tool of group === "mcp" ? [] : (TOOL_GROUPS[group] ?? [])) {
      allowed.add(tool);
    }
    for (const tool of HOST_GROUP_MEMBERS[group] ?? []) allowed.add(tool);
  }
  return allowed;
}

export function isToolAllowedInWorkspaceMode(
  toolName: string,
  allowed: ReadonlySet<string>,
): boolean {
  return !MODE_GOVERNED_TOOLS.has(toolName) || allowed.has(toolName);
}

/** Whether a mode can change project files. */
export function workspaceModeAllowsWrites(mode: AgentMode): boolean {
  const allowed = workspaceToolsForMode(mode);
  return ["write_file", "apply_diff", "find_and_replace"].some((tool) =>
    allowed.has(tool),
  );
}

/**
 * Built-in modes this host offers (in VS Code's order) followed by the
 * project's custom modes from `.agents`, `.claude` and `.agentlink`
 * `modes.json`. A custom mode replaces a built-in with the same slug.
 */
export async function loadWorkspaceModes(
  projectRoot: string,
  fileSystem: Pick<NodeHostFileSystem, "readFile">,
): Promise<AgentMode[]> {
  const sources = await Promise.all(
    CUSTOM_MODE_FILE_PATHS.map(async (segments) => {
      try {
        return (
          await fileSystem.readFile(path.join(projectRoot, ...segments))
        ).toString("utf8");
      } catch {
        return undefined;
      }
    }),
  );
  const custom = mergeCustomModeSources(sources);
  const customSlugs = new Set(custom.map((mode) => mode.slug));
  return getAllModes(custom).filter(
    (mode) =>
      customSlugs.has(mode.slug) || !UNAVAILABLE_BUILT_IN_MODES.has(mode.slug),
  );
}

/** Whether this is an unmodified built-in mode rather than a custom one. */
export function isBuiltInWorkspaceMode(mode: AgentMode): boolean {
  return BUILT_IN_MODES.includes(mode);
}

/** The session's mode, falling back to Code for unknown or missing slugs. */
export function resolveWorkspaceMode(
  slug: string | undefined,
  modes: readonly AgentMode[],
): AgentMode {
  return resolveMode(slug ?? DEFAULT_WORKSPACE_MODE, [...modes]);
}

/** Built-in slugs this host offers, for the system prompt's modes overview. */
export const WORKSPACE_BUILT_IN_MODE_SLUGS: readonly string[] =
  BUILT_IN_MODES.map((mode) => mode.slug).filter(
    (slug) => !UNAVAILABLE_BUILT_IN_MODES.has(slug),
  );

/**
 * Prompt capabilities for mode instructions here: no `switch_mode`, no
 * VS Code background agent contract, no rich rendering, no temporary-file
 * writes in Review mode.
 */
export function workspaceModePromptCapabilities(
  toolNames: Iterable<string>,
): SystemPromptCapabilities {
  return {
    ...deriveSystemPromptCapabilities(toolNames),
    backgroundAgents: false,
  };
}

const MODE_BLOCK_PREFIX =
  /^<current_mode mode="[^"\n]*">\n[\s\S]*?\n<\/current_mode>\n\n/u;

/**
 * The `<current_mode>` block a user message starts with, if any. Hosts put
 * it in front of the first message after a mode change, as VS Code does
 * when it sends that message to the provider.
 */
export function readModeInstructionBlock(text: string): string | undefined {
  const match = MODE_BLOCK_PREFIX.exec(text);
  return match ? match[0].slice(0, -2) : undefined;
}

/** A user message's text without its leading `<current_mode>` block. */
export function stripModeInstructionBlock(text: string): string {
  return text.replace(MODE_BLOCK_PREFIX, "");
}

/** The most recent mode block in these messages' user text, if any. */
export function latestModeInstructionBlock(
  messages: readonly {
    readonly role: string;
    readonly content: unknown;
  }[],
): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role !== "user") continue;
    const text =
      typeof message.content === "string"
        ? message.content
        : Array.isArray(message.content)
          ? (
              message.content.find(
                (block: { type?: string; text?: unknown }) =>
                  block?.type === "text" && typeof block.text === "string",
              ) as { text?: string } | undefined
            )?.text
          : undefined;
    const block =
      text === undefined ? undefined : readModeInstructionBlock(text);
    if (block) return block;
  }
  return undefined;
}

/**
 * VS Code's out-of-mode rejection, without its `switch_mode` hint: the
 * model cannot change modes here, the user can.
 */
export function outOfModeTool<
  TPrincipal extends import("@agentlink/core").AgentPrincipal,
>(tool: HostTool<TPrincipal>, modeSlug: string): HostTool<TPrincipal> {
  const name = tool.definition.name;
  const result: HostToolResult = {
    modelContent: JSON.stringify({
      error: `Tool '${name}' is not available in ${modeSlug} mode. If this capability is genuinely needed, ask the user to switch to a mode that allows it.`,
      status: "tool_not_in_mode",
      tool: name,
    }),
    isError: true,
  };
  return {
    ...tool,
    // Refused whatever the input and before any approval card, as VS Code
    // checks the mode first: nothing runs.
    effect: "read",
    authorization: "none",
    validate: (input) => ({
      valid: true,
      input:
        input !== null && typeof input === "object" && !Array.isArray(input)
          ? (input as Record<string, unknown>)
          : {},
    }),
    execute: async () => result,
    executeValidated: async () => result,
  };
}
