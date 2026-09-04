import type { ToolResult } from "@agentlink/protocol/tool-result";

export type ToolSideEffect =
  | "read"
  | "write"
  | "execute"
  | "control"
  | "external";
export type ToolApprovalRequirement = "never" | "policy" | "always";
export type NativeToolAvailabilityKind =
  | "mode-group"
  | "native-bridge"
  | "artifact-loader"
  | "mcp-bridge"
  | "session-control"
  | "foreground-control"
  | "background-control"
  | "benchmark-only"
  | "dev-only"
  | "dormant";
export type NativeToolDefinitionSource =
  | "registry-schema"
  | "adapter-definition"
  | "engine-inline";
export type NativeToolExecutionRoute = "runtime-dispatch" | "engine-inline";
export type NativeToolTelemetryOwner = "runtime" | "engine";
export type NativeToolDisclosureClass =
  | "essential"
  | "eligible"
  | "hidden"
  | "dormant";

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
  /** Explicit opt-in for native read-only composition. */
  composable?: boolean;
  /** ToolResult.data/error fields are authoritative on every return path. */
  canonicalResult?: boolean;
  devOnly?: boolean;
  /** Primary runtime gate. Secondary mode/profile/skill gates can only narrow it. */
  availability: Readonly<{ kind: NativeToolAvailabilityKind }>;
  /** Current owner of the provider-facing definition and input schema. */
  definitionSource: NativeToolDefinitionSource;
  /** Current execution seam. Canonicalization must not bypass this route. */
  executionRoute: NativeToolExecutionRoute;
  /** Prevents contract migrations from double-recording or dropping usage. */
  telemetryOwner: NativeToolTelemetryOwner;
  /** Stage 10 eligibility only; it does not itself alter provider disclosure. */
  disclosure: NativeToolDisclosureClass;
}

const NATIVE_BRIDGE_TOOLS = new Set(["find_native_tools", "call_native_tool"]);
const ARTIFACT_LOADER_TOOLS = new Set(["load_rule", "load_skill"]);
const MCP_BRIDGE_TOOLS = new Set([
  "find_mcp_tools",
  "call_mcp_tool",
  "list_mcp_resources",
  "read_mcp_resource",
  "list_mcp_prompts",
  "get_mcp_prompt",
]);
const SESSION_CONTROL_TOOLS = new Set([
  "ask_user",
  "todo_write",
  "set_task_status",
  "switch_mode",
]);
const FOREGROUND_CONTROL_TOOLS = new Set(["respond_to_background_question"]);
const BACKGROUND_CONTROL_TOOLS = new Set([
  "spawn_background_agent",
  "get_background_status",
  "get_background_result",
  "kill_background_agent",
  "steer_background_agent",
  "detach_background_agent",
  "start_fleet_workflow",
  "schedule_fleet_workflow",
  "get_fleet_workflow_result",
  "manage_fleet_automations",
]);
const BENCHMARK_ONLY_TOOLS = new Set([
  "get_completions",
  "get_inlay_hints",
  "get_code_actions",
  "apply_code_action",
]);
const DORMANT_TOOLS = new Set(["show_notification"]);
const ESSENTIAL_TOOLS = new Set([
  "web_search",
  "web_fetch",
  "read_file",
  "get_context",
  "get_repo_map",
  "get_module_neighbors",
  "list_files",
  "search_files",
  "codebase_search",
  "write_file",
  "apply_diff",
  "find_and_replace",
  "execute_command",
  "get_terminal_output",
  "ask_user",
  "todo_write",
  "set_task_status",
  "switch_mode",
  "send_feedback",
  "load_rule",
  "load_skill",
  "find_native_tools",
  "call_native_tool",
  ...MCP_BRIDGE_TOOLS,
]);

const toolCapabilities = [
  // External web
  metadata(
    "web_search",
    "search",
    ["web.search", "network.external"],
    "external",
    "never",
    true,
  ),
  metadata(
    "web_fetch",
    "read",
    ["web.fetch", "network.external"],
    "external",
    "never",
    true,
  ),

  // Read/search/context
  metadata(
    "find_native_tools",
    "search",
    ["tools.native.discover"],
    "read",
    "never",
    true,
  ),
  metadata(
    "call_native_tool",
    "session",
    ["tools.native.invoke"],
    "control",
    "never",
    false,
  ),
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
  metadata(
    "search_session_history",
    "session",
    ["session.transcript.read", "search.text"],
    "read",
    "never",
    true,
  ),
  metadata(
    "read_session_excerpt",
    "session",
    ["session.transcript.read"],
    "read",
    "never",
    true,
  ),
  metadata(
    "diagnose_activity",
    "session",
    ["session.activity.read", "session.diagnostics"],
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
    "present_images",
    "media",
    ["media.present", "session.images.read", "ui.chat.display"],
    "control",
    "never",
    false,
  ),
  metadata(
    "manage_memory",
    "memory",
    ["memory.manage", "memory.audit", "memory.lowAuthority"],
    "write",
    "never",
    false,
  ),
  metadata(
    "recall_memory",
    "memory",
    ["memory.recall", "memory.lowAuthority"],
    "read",
    "never",
    true,
  ),
  metadata(
    "propose_memory",
    "memory",
    ["memory.propose.authoritative", "edit.review"],
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
    true,
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
  metadata(
    "list_mcp_resources",
    "mcp",
    ["mcp.resource.list"],
    "read",
    "never",
    true,
  ),
  metadata(
    "read_mcp_resource",
    "mcp",
    ["mcp.resource.read"],
    "read",
    "never",
    true,
  ),
  metadata(
    "list_mcp_prompts",
    "mcp",
    ["mcp.prompt.list"],
    "read",
    "never",
    true,
  ),
  metadata("get_mcp_prompt", "mcp", ["mcp.prompt.read"], "read", "never", true),
  metadata("ask_user", "session", ["user.question"], "control", "never", true),
  metadata(
    "todo_write",
    "session",
    ["session.todo"],
    "control",
    "never",
    false,
  ),
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
  metadata(
    "steer_background_agent",
    "background",
    ["agent.background.steer"],
    "control",
    "never",
    false,
  ),
  metadata(
    "respond_to_background_question",
    "background",
    ["agent.background.question.respond"],
    "control",
    "never",
    false,
  ),
  metadata(
    "detach_background_agent",
    "background",
    ["agent.background.detach"],
    "control",
    "never",
    false,
  ),
  metadata(
    "start_fleet_workflow",
    "background",
    ["agent.fleet.start"],
    "control",
    "policy",
    false,
  ),
  metadata(
    "schedule_fleet_workflow",
    "background",
    ["agent.fleet.schedule"],
    "control",
    "policy",
    false,
  ),
  metadata(
    "get_fleet_workflow_result",
    "background",
    ["agent.fleet.result"],
    "read",
    "never",
    false,
  ),
  metadata(
    "manage_fleet_automations",
    "background",
    ["agent.fleet.manage"],
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
    "compose",
    "read",
    ["tools.compose", "sandbox.quickjs"],
    "read",
    "never",
    false,
    true,
  ),
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
    "triage_feedback",
    "dev",
    ["dev.feedback"],
    "write",
    "policy",
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

export interface ComposabilityPolicyViolation {
  message: string;
}

export interface ComposabilityPolicy {
  readonly validateInput: (
    input: Readonly<Record<string, unknown>>,
  ) => ComposabilityPolicyViolation | undefined;
  readonly validateOutputContent: (
    content: ToolResult["content"],
  ) => ComposabilityPolicyViolation | undefined;
  readonly renderedConstraint: string;
  readonly canonicalResultEligible: boolean;
}

const ACCEPT_ANY_COMPOSABLE_INPUT: ComposabilityPolicy["validateInput"] = () =>
  undefined;

const REQUIRE_TEXT_COMPOSABLE_OUTPUT: ComposabilityPolicy["validateOutputContent"] =
  (content) =>
    content.some((item) => item.type === "image" || item.type === "document")
      ? { message: "image and document output is not composable" }
      : undefined;

function composabilityPolicy(
  renderedConstraint: string,
  validateInput: ComposabilityPolicy["validateInput"] = ACCEPT_ANY_COMPOSABLE_INPUT,
): ComposabilityPolicy {
  return Object.freeze({
    validateInput,
    validateOutputContent: REQUIRE_TEXT_COMPOSABLE_OUTPUT,
    renderedConstraint,
    canonicalResultEligible: true,
  });
}

/** Canonical source for every native tool and variant that Compose may bridge. */
export const COMPOSABILITY_POLICIES = Object.freeze({
  read_file: composabilityPolicy(
    "query omitted; text or extracted-PDF output only",
    (input) =>
      input.query !== undefined
        ? { message: "query input is not composable" }
        : undefined,
  ),
  get_context: composabilityPolicy("structured text output only"),
  get_repo_map: composabilityPolicy("structured text output only"),
  get_module_neighbors: composabilityPolicy("structured text output only"),
  list_files: composabilityPolicy(
    "query omitted; structured text output only",
    (input) =>
      input.query !== undefined
        ? { message: "query input is not composable" }
        : undefined,
  ),
  search_files: composabilityPolicy(
    "semantic omitted or false; structured text output only",
    (input) =>
      input.semantic === true
        ? { message: "semantic input is not composable" }
        : undefined,
  ),
  get_diagnostics: composabilityPolicy("structured text output only"),
  go_to_definition: composabilityPolicy("structured text output only"),
  go_to_implementation: composabilityPolicy("structured text output only"),
  go_to_type_definition: composabilityPolicy("structured text output only"),
  get_references: composabilityPolicy("structured text output only"),
  get_symbols: composabilityPolicy("structured text output only"),
  get_hover: composabilityPolicy("structured text output only"),
  get_completions: composabilityPolicy("structured text output only"),
  get_code_actions: composabilityPolicy("structured text output only"),
  get_call_hierarchy: composabilityPolicy("structured text output only"),
  get_type_hierarchy: composabilityPolicy("structured text output only"),
  get_inlay_hints: composabilityPolicy("structured text output only"),
} satisfies Readonly<Record<string, ComposabilityPolicy>>);

export type ComposableToolName = keyof typeof COMPOSABILITY_POLICIES;

export function getComposabilityPolicy(
  toolName: string,
): ComposabilityPolicy | undefined {
  return (
    COMPOSABILITY_POLICIES as Readonly<Record<string, ComposabilityPolicy>>
  )[toolName];
}

export function validateComposableToolInput(
  toolName: string,
  input: Readonly<Record<string, unknown>>,
): ComposabilityPolicyViolation | undefined {
  return getComposabilityPolicy(toolName)?.validateInput(input);
}

export function validateComposableToolOutputContent(
  toolName: string,
  content: ToolResult["content"],
): ComposabilityPolicyViolation | undefined {
  return getComposabilityPolicy(toolName)?.validateOutputContent(content);
}

export function isCanonicalComposableResultEligible(toolName: string): boolean {
  return getComposabilityPolicy(toolName)?.canonicalResultEligible === true;
}

export const COMPOSABLE_TOOLS: ReadonlySet<string> = new Set(
  Object.entries(COMPOSABILITY_POLICIES)
    .filter(([, policy]) => policy.canonicalResultEligible)
    .map(([name]) => name),
);

export function renderComposableToolConstraints(
  toolNames: Iterable<string> = COMPOSABLE_TOOLS,
): string {
  return [...toolNames]
    .flatMap((toolName) => {
      const policy = getComposabilityPolicy(toolName);
      return policy ? [`${toolName} (${policy.renderedConstraint})`] : [];
    })
    .join(", ");
}

export const TOOL_CAPABILITIES: Readonly<
  Record<string, ToolCapabilityMetadata>
> = Object.freeze(
  Object.fromEntries(
    toolCapabilities.map((entry) => {
      const composable = COMPOSABLE_TOOLS.has(entry.name);
      return [
        entry.name,
        composable
          ? { ...entry, composable: true, canonicalResult: true }
          : entry,
      ];
    }),
  ),
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
  composable?: boolean,
  canonicalResult?: boolean,
): ToolCapabilityMetadata {
  const availability = resolveAvailability(name, devOnly);
  const definitionSource: NativeToolDefinitionSource =
    name === "todo_write"
      ? "engine-inline"
      : availability.kind === "mcp-bridge" ||
          availability.kind === "session-control" ||
          availability.kind === "background-control"
        ? "adapter-definition"
        : "registry-schema";
  const engineInline = definitionSource === "engine-inline";
  return {
    name,
    cluster,
    capabilities,
    sideEffect,
    requiresApproval,
    parallelSafe,
    composable,
    canonicalResult,
    devOnly,
    availability,
    definitionSource,
    executionRoute: engineInline ? "engine-inline" : "runtime-dispatch",
    telemetryOwner: engineInline ? "engine" : "runtime",
    disclosure:
      availability.kind === "dormant"
        ? "dormant"
        : ESSENTIAL_TOOLS.has(name) || definitionSource === "adapter-definition"
          ? "essential"
          : availability.kind === "artifact-loader"
            ? "hidden"
            : "eligible",
  };
}

function resolveAvailability(
  name: string,
  devOnly: boolean | undefined,
): Readonly<{ kind: NativeToolAvailabilityKind }> {
  if (DORMANT_TOOLS.has(name)) return Object.freeze({ kind: "dormant" });
  if (devOnly) return Object.freeze({ kind: "dev-only" });
  if (NATIVE_BRIDGE_TOOLS.has(name)) {
    return Object.freeze({ kind: "native-bridge" });
  }
  if (ARTIFACT_LOADER_TOOLS.has(name)) {
    return Object.freeze({ kind: "artifact-loader" });
  }
  if (MCP_BRIDGE_TOOLS.has(name)) {
    return Object.freeze({ kind: "mcp-bridge" });
  }
  if (FOREGROUND_CONTROL_TOOLS.has(name)) {
    return Object.freeze({ kind: "foreground-control" });
  }
  if (BACKGROUND_CONTROL_TOOLS.has(name)) {
    return Object.freeze({ kind: "background-control" });
  }
  if (SESSION_CONTROL_TOOLS.has(name)) {
    return Object.freeze({ kind: "session-control" });
  }
  if (BENCHMARK_ONLY_TOOLS.has(name)) {
    return Object.freeze({ kind: "benchmark-only" });
  }
  return Object.freeze({ kind: "mode-group" });
}
