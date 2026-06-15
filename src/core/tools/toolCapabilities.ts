export type ToolSideEffect =
  | "read"
  | "write"
  | "execute"
  | "control"
  | "external";
export type ToolApprovalRequirement = "never" | "policy" | "always";

export interface ToolCapabilityMetadata {
  name: string;
  cluster:
    | "read"
    | "search"
    | "edit"
    | "terminal"
    | "language"
    | "mcp"
    | "session"
    | "background"
    | "ui"
    | "memory"
    | "dev"
    | "media";
  capabilities: string[];
  sideEffect: ToolSideEffect;
  requiresApproval: ToolApprovalRequirement;
  parallelSafe: boolean;
  devOnly?: boolean;
}

const toolCapabilities = [
  // Read/search/context
  metadata(
    "read_file",
    "read",
    ["workspace.read", "language.context.optional"],
    "read",
    "never",
    true,
  ),
  metadata(
    "get_context",
    "read",
    ["workspace.read", "context.pack"],
    "read",
    "never",
    true,
  ),
  metadata(
    "get_repo_map",
    "search",
    ["index.structural"],
    "read",
    "never",
    true,
  ),
  metadata(
    "get_module_neighbors",
    "search",
    ["index.structural"],
    "read",
    "never",
    true,
  ),
  metadata("load_rule", "read", ["artifact.rules"], "read", "never", true),
  metadata("load_skill", "read", ["artifact.skills"], "read", "never", true),
  metadata(
    "list_files",
    "read",
    ["workspace.read", "search.files"],
    "read",
    "never",
    true,
  ),
  metadata(
    "search_files",
    "search",
    ["workspace.read", "search.text"],
    "read",
    "never",
    true,
  ),
  metadata(
    "codebase_search",
    "search",
    ["search.semantic"],
    "read",
    "never",
    true,
  ),

  // Edit/write/review
  metadata(
    "write_file",
    "edit",
    ["workspace.edit", "edit.review"],
    "write",
    "policy",
    false,
  ),
  metadata(
    "apply_diff",
    "edit",
    ["workspace.edit", "edit.review"],
    "write",
    "policy",
    false,
  ),
  metadata(
    "find_and_replace",
    "edit",
    ["workspace.edit", "edit.review"],
    "write",
    "policy",
    false,
  ),
  metadata(
    "rename_symbol",
    "language",
    ["language.refactor", "workspace.edit"],
    "write",
    "policy",
    false,
  ),
  metadata(
    "apply_code_action",
    "language",
    ["language.codeAction", "workspace.edit"],
    "write",
    "policy",
    false,
  ),
  metadata(
    "generate_image",
    "media",
    ["media.generate", "workspace.write"],
    "write",
    "always",
    false,
  ),
  metadata(
    "propose_memory",
    "memory",
    ["memory.propose", "edit.review"],
    "write",
    "always",
    false,
  ),

  // Terminal/process
  metadata(
    "execute_command",
    "terminal",
    ["process.execute"],
    "execute",
    "policy",
    false,
  ),
  metadata(
    "get_terminal_output",
    "terminal",
    ["terminal.output"],
    "read",
    "never",
    true,
  ),
  metadata(
    "close_terminals",
    "terminal",
    ["terminal.manage"],
    "control",
    "policy",
    false,
  ),
  metadata(
    "start_worktree_agent",
    "terminal",
    ["worktree.manage", "agent.launch"],
    "execute",
    "always",
    false,
  ),

  // Language intelligence
  metadata(
    "get_diagnostics",
    "language",
    ["language.diagnostics"],
    "read",
    "never",
    true,
  ),
  metadata(
    "go_to_definition",
    "language",
    ["language.navigation"],
    "read",
    "never",
    true,
  ),
  metadata(
    "go_to_implementation",
    "language",
    ["language.navigation"],
    "read",
    "never",
    true,
  ),
  metadata(
    "go_to_type_definition",
    "language",
    ["language.navigation"],
    "read",
    "never",
    true,
  ),
  metadata(
    "get_references",
    "language",
    ["language.references"],
    "read",
    "never",
    true,
  ),
  metadata(
    "get_symbols",
    "language",
    ["language.symbols"],
    "read",
    "never",
    true,
  ),
  metadata("get_hover", "language", ["language.hover"], "read", "never", true),
  metadata(
    "get_completions",
    "language",
    ["language.completions"],
    "read",
    "never",
    true,
  ),
  metadata(
    "get_code_actions",
    "language",
    ["language.codeAction"],
    "read",
    "never",
    true,
  ),
  metadata(
    "get_call_hierarchy",
    "language",
    ["language.hierarchy"],
    "read",
    "never",
    true,
  ),
  metadata(
    "get_type_hierarchy",
    "language",
    ["language.hierarchy"],
    "read",
    "never",
    true,
  ),
  metadata(
    "get_inlay_hints",
    "language",
    ["language.inlayHints"],
    "read",
    "never",
    true,
  ),

  // MCP/session/control
  metadata("find_mcp_tools", "mcp", ["mcp.discovery"], "read", "never", true),
  metadata("call_mcp_tool", "mcp", ["mcp.call"], "external", "policy", false),
  metadata("ask_user", "session", ["user.question"], "control", "never", true),
  metadata(
    "set_task_status",
    "session",
    ["session.status"],
    "control",
    "never",
    false,
  ),
  metadata(
    "switch_mode",
    "session",
    ["session.mode"],
    "control",
    "policy",
    false,
  ),
  metadata(
    "spawn_background_agent",
    "background",
    ["agent.background.spawn"],
    "control",
    "policy",
    true,
  ),
  metadata(
    "get_background_status",
    "background",
    ["agent.background.status"],
    "read",
    "never",
    true,
  ),
  metadata(
    "get_background_result",
    "background",
    ["agent.background.result"],
    "read",
    "never",
    true,
  ),
  metadata(
    "kill_background_agent",
    "background",
    ["agent.background.kill"],
    "control",
    "policy",
    false,
  ),

  // UI/front-end
  metadata("open_file", "ui", ["ui.editor.open"], "control", "never", true),
  metadata(
    "show_notification",
    "ui",
    ["ui.notification"],
    "control",
    "never",
    true,
  ),

  // Dev-only tools
  metadata(
    "send_feedback",
    "dev",
    ["dev.feedback"],
    "external",
    "never",
    false,
    true,
  ),
  metadata(
    "get_feedback",
    "dev",
    ["dev.feedback"],
    "read",
    "never",
    false,
    true,
  ),
  metadata(
    "delete_feedback",
    "dev",
    ["dev.feedback"],
    "write",
    "policy",
    false,
    true,
  ),
] as const satisfies readonly ToolCapabilityMetadata[];

export const TOOL_CAPABILITIES: Readonly<
  Record<string, ToolCapabilityMetadata>
> = Object.freeze(
  Object.fromEntries(toolCapabilities.map((entry) => [entry.name, entry])),
);

export const PARALLEL_SAFE_TOOLS: ReadonlySet<string> = new Set(
  toolCapabilities
    .filter((entry) => entry.parallelSafe)
    .map((entry) => entry.name),
);

export function getToolCapabilityMetadata(
  toolName: string,
): ToolCapabilityMetadata | undefined {
  return TOOL_CAPABILITIES[toolName];
}

function metadata(
  name: string,
  cluster: ToolCapabilityMetadata["cluster"],
  capabilities: string[],
  sideEffect: ToolSideEffect,
  requiresApproval: ToolApprovalRequirement,
  parallelSafe: boolean,
  devOnly?: boolean,
): ToolCapabilityMetadata {
  return {
    name,
    cluster,
    capabilities,
    sideEffect,
    requiresApproval,
    parallelSafe,
    devOnly,
  };
}
