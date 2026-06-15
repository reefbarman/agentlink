import { describe, it, expect, vi } from "vitest";
import {
  getAgentTools,
  dispatchToolCall,
  READ_ONLY_TOOLS,
  type ToolDispatchContext,
} from "./toolAdapter.js";
import { PARALLEL_SAFE_TOOLS } from "../core/tools/toolCapabilities.js";
import { BUILT_IN_MODES } from "./modes.js";
import type { ToolDefinition } from "./providers/types.js";
import type { ToolResult } from "../shared/types.js";
import { handleLoadRule } from "../tools/loadRule.js";

// Mock all tool handlers so dispatchToolCall tests don't hit VS Code APIs
vi.mock("../tools/readFile.js", () => ({
  handleReadFile: vi
    .fn()
    .mockResolvedValue({ content: [{ type: "text", text: "file content" }] }),
}));
vi.mock("../tools/context/getContext.js", () => ({
  handleGetContext: vi
    .fn()
    .mockResolvedValue({ content: [{ type: "text", text: "context" }] }),
}));
vi.mock("../tools/getModuleNeighbors.js", () => ({
  handleGetModuleNeighbors: vi.fn().mockResolvedValue({
    content: [{ type: "text", text: "module neighbors" }],
  }),
}));
vi.mock("../tools/getRepoMap.js", () => ({
  handleGetRepoMap: vi.fn().mockResolvedValue({
    content: [{ type: "text", text: "repo map" }],
  }),
}));
vi.mock("../tools/listFiles.js", () => ({
  handleListFiles: vi
    .fn()
    .mockResolvedValue({ content: [{ type: "text", text: "files" }] }),
}));
vi.mock("../tools/loadRule.js", () => ({
  handleLoadRule: vi.fn().mockResolvedValue({
    content: [{ type: "text", text: JSON.stringify({ rule_name: "rule" }) }],
  }),
}));
vi.mock("../tools/searchFiles.js", () => ({
  handleSearchFiles: vi
    .fn()
    .mockResolvedValue({ content: [{ type: "text", text: "matches" }] }),
}));
vi.mock("../tools/writeFile.js", () => ({
  handleWriteFile: vi
    .fn()
    .mockResolvedValue({ content: [{ type: "text", text: "written" }] }),
}));
vi.mock("../tools/applyDiff.js", () => ({
  handleApplyDiff: vi
    .fn()
    .mockResolvedValue({ content: [{ type: "text", text: "patched" }] }),
}));
vi.mock("../tools/findAndReplace.js", () => ({
  handleFindAndReplace: vi
    .fn()
    .mockResolvedValue({ content: [{ type: "text", text: "replaced" }] }),
}));
vi.mock("../tools/executeCommand.js", () => ({
  handleExecuteCommand: vi
    .fn()
    .mockResolvedValue({ content: [{ type: "text", text: "output" }] }),
}));
vi.mock("../tools/getTerminalOutput.js", () => ({
  handleGetTerminalOutput: vi
    .fn()
    .mockResolvedValue({ content: [{ type: "text", text: "terminal" }] }),
}));
vi.mock("../tools/closeTerminals.js", () => ({
  handleCloseTerminals: vi
    .fn()
    .mockResolvedValue({ content: [{ type: "text", text: "closed" }] }),
}));
vi.mock("../tools/openFile.js", () => ({
  handleOpenFile: vi
    .fn()
    .mockResolvedValue({ content: [{ type: "text", text: "opened" }] }),
}));
vi.mock("../tools/showNotification.js", () => ({
  handleShowNotification: vi
    .fn()
    .mockResolvedValue({ content: [{ type: "text", text: "shown" }] }),
}));
vi.mock("../tools/getDiagnostics.js", () => ({
  handleGetDiagnostics: vi
    .fn()
    .mockResolvedValue({ content: [{ type: "text", text: "diags" }] }),
}));
vi.mock("../tools/goToDefinition.js", () => ({
  handleGoToDefinition: vi
    .fn()
    .mockResolvedValue({ content: [{ type: "text", text: "def" }] }),
}));
vi.mock("../tools/goToImplementation.js", () => ({
  handleGoToImplementation: vi
    .fn()
    .mockResolvedValue({ content: [{ type: "text", text: "impl" }] }),
}));
vi.mock("../tools/goToTypeDefinition.js", () => ({
  handleGoToTypeDefinition: vi
    .fn()
    .mockResolvedValue({ content: [{ type: "text", text: "typedef" }] }),
}));
vi.mock("../tools/getReferences.js", () => ({
  handleGetReferences: vi
    .fn()
    .mockResolvedValue({ content: [{ type: "text", text: "refs" }] }),
}));
vi.mock("../tools/getSymbols.js", () => ({
  handleGetSymbols: vi
    .fn()
    .mockResolvedValue({ content: [{ type: "text", text: "symbols" }] }),
}));
vi.mock("../tools/getHover.js", () => ({
  handleGetHover: vi
    .fn()
    .mockResolvedValue({ content: [{ type: "text", text: "hover" }] }),
}));
vi.mock("../tools/getCompletions.js", () => ({
  handleGetCompletions: vi
    .fn()
    .mockResolvedValue({ content: [{ type: "text", text: "completions" }] }),
}));
vi.mock("../tools/codeActions.js", () => ({
  handleGetCodeActions: vi
    .fn()
    .mockResolvedValue({ content: [{ type: "text", text: "actions" }] }),
  handleApplyCodeAction: vi
    .fn()
    .mockResolvedValue({ content: [{ type: "text", text: "applied" }] }),
}));
vi.mock("../tools/getCallHierarchy.js", () => ({
  handleGetCallHierarchy: vi
    .fn()
    .mockResolvedValue({ content: [{ type: "text", text: "calls" }] }),
}));
vi.mock("../tools/getTypeHierarchy.js", () => ({
  handleGetTypeHierarchy: vi
    .fn()
    .mockResolvedValue({ content: [{ type: "text", text: "types" }] }),
}));
vi.mock("../tools/getInlayHints.js", () => ({
  handleGetInlayHints: vi
    .fn()
    .mockResolvedValue({ content: [{ type: "text", text: "hints" }] }),
}));
vi.mock("../tools/renameSymbol.js", () => ({
  handleRenameSymbol: vi
    .fn()
    .mockResolvedValue({ content: [{ type: "text", text: "renamed" }] }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockOnApprovalRequest = vi.fn();
const mockCtx: ToolDispatchContext = {
  approvalManager: {} as any,
  approvalPanel: {} as any,
  sessionId: "test-session",
  extensionUri: {} as any,
  onApprovalRequest: mockOnApprovalRequest,
};

const ddgMcpTools: ToolDefinition[] = [
  {
    name: "ddg-search__search",
    description: "Search the web using DuckDuckGo.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
  {
    name: "ddg-search__fetch_content",
    description: "Fetch and extract the main text content from a webpage.",
    input_schema: {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
    },
  },
];

const READ_ONLY_TOOLS_COMPATIBILITY_SNAPSHOT = [
  "read_file",
  "get_context",
  "get_repo_map",
  "get_module_neighbors",
  "load_rule",
  "load_skill",
  "list_files",
  "search_files",
  "codebase_search",
  "get_diagnostics",
  "get_hover",
  "get_symbols",
  "get_references",
  "go_to_definition",
  "go_to_implementation",
  "go_to_type_definition",
  "get_call_hierarchy",
  "get_type_hierarchy",
  "get_inlay_hints",
  "get_completions",
  "get_code_actions",
  "open_file",
  "show_notification",
  "get_terminal_output",
  "ask_user",
  "find_mcp_tools",
  "spawn_background_agent",
  "get_background_status",
  "get_background_result",
] as const;

describe("READ_ONLY_TOOLS", () => {
  it("matches the pre-core compatibility snapshot", () => {
    expect([...READ_ONLY_TOOLS].sort()).toEqual(
      [...READ_ONLY_TOOLS_COMPATIBILITY_SNAPSHOT].sort(),
    );
  });

  it("matches the core parallel-safe metadata", () => {
    expect([...PARALLEL_SAFE_TOOLS].sort()).toEqual(
      [...READ_ONLY_TOOLS_COMPATIBILITY_SNAPSHOT].sort(),
    );
  });

  it("includes expected read-only tools", () => {
    expect(READ_ONLY_TOOLS.has("read_file")).toBe(true);
    expect(READ_ONLY_TOOLS.has("get_context")).toBe(true);
    expect(READ_ONLY_TOOLS.has("get_repo_map")).toBe(true);
    expect(READ_ONLY_TOOLS.has("get_module_neighbors")).toBe(true);
    expect(READ_ONLY_TOOLS.has("load_rule")).toBe(true);
    expect(READ_ONLY_TOOLS.has("list_files")).toBe(true);
    expect(READ_ONLY_TOOLS.has("search_files")).toBe(true);
    expect(READ_ONLY_TOOLS.has("get_diagnostics")).toBe(true);
    expect(READ_ONLY_TOOLS.has("get_hover")).toBe(true);
    expect(READ_ONLY_TOOLS.has("get_symbols")).toBe(true);
    expect(READ_ONLY_TOOLS.has("go_to_definition")).toBe(true);
    expect(READ_ONLY_TOOLS.has("codebase_search")).toBe(true);
  });

  it("does not include write or terminal meta tools", () => {
    expect(READ_ONLY_TOOLS.has("write_file")).toBe(false);
    expect(READ_ONLY_TOOLS.has("apply_diff")).toBe(false);
    expect(READ_ONLY_TOOLS.has("find_and_replace")).toBe(false);
    expect(READ_ONLY_TOOLS.has("execute_command")).toBe(false);
    expect(READ_ONLY_TOOLS.has("rename_symbol")).toBe(false);
    expect(READ_ONLY_TOOLS.has("switch_mode")).toBe(false);
    expect(READ_ONLY_TOOLS.has("set_task_status")).toBe(false);
  });
});

describe("getAgentTools", () => {
  it("returns an array of tools", () => {
    const tools = getAgentTools();
    expect(Array.isArray(tools)).toBe(true);
    expect(tools.length).toBeGreaterThan(0);
  });

  it("every tool has name, description, and input_schema", () => {
    for (const tool of getAgentTools()) {
      expect(typeof tool.name).toBe("string");
      expect(tool.name.length).toBeGreaterThan(0);
      expect(typeof tool.description).toBe("string");
      expect((tool.description ?? "").length).toBeGreaterThan(0);
      expect(tool.input_schema).toBeDefined();
      expect(tool.input_schema.type).toBe("object");
    }
  });

  it("does not emit duplicate tool names", () => {
    for (const mode of [undefined, ...BUILT_IN_MODES]) {
      const names = getAgentTools(mode).map((tool) => tool.name);
      expect(new Set(names).size, mode?.slug ?? "default").toBe(names.length);
    }
  });

  it("does not include handshake", () => {
    const names = getAgentTools().map((t) => t.name);
    expect(names).not.toContain("handshake");
  });

  it("gates feedback tools by build type", () => {
    const names = getAgentTools().map((t) => t.name);
    if (__DEV_BUILD__) {
      expect(names).toContain("send_feedback");
      expect(names).toContain("get_feedback");
      expect(names).toContain("delete_feedback");
    } else {
      expect(names).not.toContain("send_feedback");
      expect(names).not.toContain("get_feedback");
      expect(names).not.toContain("delete_feedback");
    }
  });

  it("includes the core file tools and foreground task status tool", () => {
    const names = getAgentTools().map((t) => t.name);
    expect(names).toContain("read_file");
    expect(names).toContain("load_rule");
    expect(names).toContain("get_repo_map");
    expect(names).toContain("get_module_neighbors");
    expect(names).toContain("write_file");
    expect(names).toContain("apply_diff");
    expect(names).toContain("execute_command");
    expect(names).toContain("get_diagnostics");
    expect(names).toContain("set_task_status");
  });

  it("excludes set_task_status from background and profile-restricted tool sets", () => {
    expect(
      getAgentTools(undefined, undefined, true).map((t) => t.name),
    ).not.toContain("set_task_status");
    expect(
      getAgentTools(undefined, undefined, false, "review").map((t) => t.name),
    ).not.toContain("set_task_status");
  });

  it("restricts tools when toolProfile is set to 'review'", () => {
    const reviewTools = getAgentTools(
      BUILT_IN_MODES[4],
      ddgMcpTools,
      true,
      "review",
    );
    const names = reviewTools.map((t) => t.name);
    // Should include read-only review tools
    expect(names).toContain("read_file");
    expect(names).toContain("get_context");
    expect(names).toContain("get_repo_map");
    expect(names).toContain("get_module_neighbors");
    expect(names).toContain("search_files");
    expect(names).toContain("codebase_search");
    expect(names).toContain("get_diagnostics");
    expect(names).toContain("get_hover");
    expect(names).toContain("get_symbols");
    expect(names).toContain("get_references");
    // Should include MCP discovery/call tools and directly exposed ddg tools.
    expect(names).toContain("find_mcp_tools");
    expect(names).toContain("call_mcp_tool");
    expect(names).toContain("ddg-search__search");
    expect(names).toContain("ddg-search__fetch_content");

    // Should NOT include write tools, command tools, or foreground-only helpers.
    expect(names).not.toContain("write_file");
    expect(names).not.toContain("apply_diff");
    expect(names).not.toContain("execute_command");
    expect(names).not.toContain("find_and_replace");
    expect(names).not.toContain("load_rule");
    expect(names).not.toContain("ask_user");
  });

  it("restricts tools when toolProfile is set to 'readonly-research'", () => {
    const tools = getAgentTools(
      BUILT_IN_MODES[2],
      ddgMcpTools,
      true,
      "readonly-research",
    );
    const names = tools.map((t) => t.name);

    expect(names).toContain("read_file");
    expect(names).toContain("get_context");
    expect(names).toContain("get_repo_map");
    expect(names).toContain("get_module_neighbors");
    expect(names).toContain("search_files");
    expect(names).toContain("codebase_search");
    expect(names).toContain("get_diagnostics");
    expect(names).toContain("go_to_type_definition");
    expect(names).toContain("get_call_hierarchy");
    expect(names).toContain("get_inlay_hints");
    expect(names).toContain("find_mcp_tools");
    expect(names).toContain("call_mcp_tool");
    expect(names).toContain("ddg-search__search");
    expect(names).toContain("ddg-search__fetch_content");

    expect(names).not.toContain("write_file");
    expect(names).not.toContain("apply_diff");
    expect(names).not.toContain("execute_command");
    expect(names).not.toContain("rename_symbol");
    expect(names).not.toContain("apply_code_action");
    expect(names).not.toContain("ask_user");
    expect(names).not.toContain("spawn_background_agent");
  });

  it("restricts tools when toolProfile is set to 'btw'", () => {
    const tools = getAgentTools(BUILT_IN_MODES[2], ddgMcpTools, true, "btw");
    const names = tools.map((t) => t.name);

    expect(names).toContain("read_file");
    expect(names).toContain("get_context");
    expect(names).toContain("get_repo_map");
    expect(names).toContain("get_module_neighbors");
    expect(names).toContain("codebase_search");
    expect(names).toContain("get_call_hierarchy");

    expect(names).not.toContain("write_file");
    expect(names).not.toContain("apply_diff");
    expect(names).not.toContain("execute_command");
    expect(names).not.toContain("ask_user");
    expect(names).not.toContain("find_mcp_tools");
    expect(names).not.toContain("call_mcp_tool");
    expect(names).not.toContain("ddg-search__search");
    expect(names).not.toContain("ddg-search__fetch_content");
  });

  it("restricts normal tools to the active skill allowed-tools allowlist", () => {
    const names = getAgentTools(
      BUILT_IN_MODES[0],
      ddgMcpTools,
      false,
      undefined,
      ["read_file"],
    ).map((t) => t.name);

    expect(names).toContain("read_file");
    expect(names).not.toContain("ddg-search__search");
    expect(names).not.toContain("write_file");
    expect(names).not.toContain("execute_command");
    expect(names).not.toContain("find_mcp_tools");
    expect(names).not.toContain("call_mcp_tool");
    expect(names).toContain("load_skill");
    expect(names).toContain("ask_user");
    expect(names).toContain("set_task_status");
  });

  it("allows skill allowlists to reference full MCP tool names", () => {
    const names = getAgentTools(
      BUILT_IN_MODES[0],
      ddgMcpTools,
      false,
      undefined,
      ["ddg-search__fetch_content"],
    ).map((t) => t.name);

    expect(names).toContain("ddg-search__fetch_content");
    expect(names).not.toContain("ddg-search__search");
    expect(names).toContain("find_mcp_tools");
    expect(names).toContain("call_mcp_tool");
  });

  it("allows skill allowlists to reference MCP servers for deferred calls", () => {
    const names = getAgentTools(
      BUILT_IN_MODES[0],
      ddgMcpTools,
      false,
      undefined,
      ["ddg-search"],
    ).map((t) => t.name);

    expect(names).toContain("ddg-search__search");
    expect(names).toContain("ddg-search__fetch_content");
    expect(names).toContain("find_mcp_tools");
    expect(names).toContain("call_mcp_tool");
  });

  it("does not treat native-looking allowlist entries as MCP bare tool grants", () => {
    const names = getAgentTools(
      BUILT_IN_MODES[0],
      [
        {
          name: "filesystem__read_file",
          description: "Read file through MCP",
          input_schema: { type: "object", properties: {} },
        },
      ],
      false,
      undefined,
      ["read_file"],
    ).map((t) => t.name);

    expect(names).toContain("read_file");
    expect(names).not.toContain("filesystem__read_file");
    expect(names).not.toContain("find_mcp_tools");
    expect(names).not.toContain("call_mcp_tool");
  });

  it("allows skill allowlists to reference MCP server wildcards", () => {
    const names = getAgentTools(
      BUILT_IN_MODES[0],
      ddgMcpTools,
      false,
      undefined,
      ["ddg-search__*"],
    ).map((t) => t.name);

    expect(names).toContain("ddg-search__search");
    expect(names).toContain("ddg-search__fetch_content");
    expect(names).toContain("call_mcp_tool");
  });

  it("exposes deferred MCP meta-tools when active skill allowlist names a deferred MCP target", () => {
    const deferredOnlyMcpTools: ToolDefinition[] = [
      {
        name: "linear__list_issues",
        description: "List issues",
        input_schema: { type: "object", properties: {} },
      },
    ];
    const names = getAgentTools(
      BUILT_IN_MODES[0],
      [],
      false,
      undefined,
      ["linear__list_issues"],
      deferredOnlyMcpTools,
    ).map((t) => t.name);

    expect(names).not.toContain("linear__list_issues");
    expect(names).toContain("find_mcp_tools");
    expect(names).toContain("call_mcp_tool");
  });

  it("gates MCP discovery and calls to MCP-capable modes", () => {
    const codeNames = getAgentTools(BUILT_IN_MODES[0]).map((t) => t.name);
    const askNames = getAgentTools(BUILT_IN_MODES[2]).map((t) => t.name);
    const reviewNames = getAgentTools(BUILT_IN_MODES[4]).map((t) => t.name);

    expect(codeNames).toContain("find_mcp_tools");
    expect(codeNames).toContain("call_mcp_tool");
    expect(askNames).not.toContain("find_mcp_tools");
    expect(askNames).not.toContain("call_mcp_tool");
    expect(reviewNames).not.toContain("find_mcp_tools");
    expect(reviewNames).not.toContain("call_mcp_tool");
  });

  it("includes structural repo map tools in all built-in mode-filtered tool sets", () => {
    for (const mode of BUILT_IN_MODES) {
      const names = getAgentTools(mode).map((t) => t.name);
      expect(names, mode.slug).toContain("get_repo_map");
      expect(names, mode.slug).toContain("get_module_neighbors");
    }
  });

  it("does not restrict tools when toolProfile is undefined", () => {
    const allTools = getAgentTools(undefined, undefined, true);
    const reviewTools = getAgentTools(undefined, undefined, true, "review");
    expect(allTools.length).toBeGreaterThan(reviewTools.length);
  });

  it("returns tools with valid JSON Schema input_schema (properties + type)", () => {
    for (const tool of getAgentTools()) {
      // Schema must be an object type with properties
      expect(tool.input_schema.type).toBe("object");
    }
  });

  it("returns the native tool segment in deterministic name order", () => {
    const tools = getAgentTools(undefined, undefined, true);
    const names = tools.map((t) => t.name);
    const start = names.indexOf("apply_diff");
    const end = names.indexOf("write_file");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);

    const nativeSegment = names.slice(start, end + 1);
    expect(nativeSegment).toEqual(
      [...nativeSegment].sort((a, b) => a.localeCompare(b)),
    );
  });
});

describe("spawn_background_agent tool", () => {
  it("schema includes routing params but not guardrail params", () => {
    const spawnTool = getAgentTools().find(
      (t) => t.name === "spawn_background_agent",
    );
    expect(spawnTool).toBeDefined();
    const props = (spawnTool?.input_schema.properties ?? {}) as Record<
      string,
      unknown
    >;
    expect(props.mode).toBeDefined();
    expect(props.model).toBeDefined();
    expect(props.provider).toBeDefined();
    expect(props.taskClass).toBeDefined();
    expect(props.modelTier).toBeDefined();
    expect(JSON.stringify(spawnTool)).toContain("readonly-research");
    expect(JSON.stringify(spawnTool)).toContain("non-conflicting");
    // Guardrail params removed — background agents run without limits
    expect(props.timeoutSeconds).toBeUndefined();
    expect(props.tokenBudget).toBeUndefined();
    expect(props.maxToolCalls).toBeUndefined();
  });

  it("dispatches structured request and returns structured result", async () => {
    const onSpawnBackground = vi.fn().mockResolvedValue({
      sessionId: "bg-123",
      resolvedMode: "review",
      resolvedModel: "claude-sonnet-4-6",
      resolvedProvider: "anthropic",
      taskClass: "review_code",
      routingReason: "routed by opposite provider strategy",
      fallbackUsed: false,
    });

    const result = await dispatchToolCall(
      "spawn_background_agent",
      {
        task: "Review patch",
        message: "Review the recent changes",
        mode: "review",
        model: "claude-sonnet-4-6",
        provider: "anthropic",
        taskClass: "review_code",
        modelTier: "deep_reasoning",
      },
      { ...mockCtx, onSpawnBackground },
    );

    expect(onSpawnBackground).toHaveBeenCalledWith({
      task: "Review patch",
      message: "Review the recent changes",
      mode: "review",
      model: "claude-sonnet-4-6",
      provider: "anthropic",
      taskClass: "review_code",
      modelTier: "deep_reasoning",
    });

    const text = (result.content[0] as { type: string; text: string }).text;
    expect(JSON.parse(text)).toMatchObject({
      sessionId: "bg-123",
      resolvedMode: "review",
      taskClass: "review_code",
      fallbackUsed: false,
    });
  });

  it("kill_background_agent tool exists in schema", () => {
    const killTool = getAgentTools().find(
      (t) => t.name === "kill_background_agent",
    );
    expect(killTool).toBeDefined();
    const props = (killTool?.input_schema.properties ?? {}) as Record<
      string,
      unknown
    >;
    expect(props.sessionId).toBeDefined();
    expect(props.reason).toBeDefined();
  });

  it("dispatches get_background_status to onGetBackgroundStatus callback", async () => {
    const onGetBackgroundStatus = vi.fn().mockReturnValue({
      status: "streaming",
      currentTool: "read_file",
      done: false,
      displayStatus: "Reading code",
      streamingPreview: "inspecting tests",
      progressSummary: "Reading code",
      taskClass: "readonly-research",
      toolCalls: 1,
      tokenUsage: 100,
    });

    const result = await dispatchToolCall(
      "get_background_status",
      { sessionId: "bg-456" },
      { ...mockCtx, onGetBackgroundStatus },
    );

    expect(onGetBackgroundStatus).toHaveBeenCalledWith("bg-456");
    const text = (result.content[0] as { type: string; text: string }).text;
    expect(JSON.parse(text)).toMatchObject({
      status: "streaming",
      currentTool: "read_file",
      done: false,
      streamingPreview: "inspecting tests",
      taskClass: "readonly-research",
      toolCalls: 1,
      tokenUsage: 100,
    });
  });

  it("dispatches kill_background_agent to onKillBackground callback", async () => {
    const onKillBackground = vi.fn().mockReturnValue({
      killed: true,
      partialOutput: "some partial work",
    });

    const result = await dispatchToolCall(
      "kill_background_agent",
      { sessionId: "bg-456", reason: "taking too long" },
      { ...mockCtx, onKillBackground },
    );

    expect(onKillBackground).toHaveBeenCalledWith("bg-456", "taking too long");
    const text = (result.content[0] as { type: string; text: string }).text;
    expect(JSON.parse(text)).toMatchObject({
      killed: true,
      partialOutput: "some partial work",
    });
  });
});

describe("dispatchToolCall", () => {
  it("returns an error result for unknown tool names", async () => {
    const result = await dispatchToolCall("not_a_real_tool", {}, mockCtx);
    expect(result.content).toHaveLength(1);
    const text = (result.content[0] as { type: string; text: string }).text;
    expect(JSON.parse(text)).toMatchObject({
      error: expect.stringContaining("not_a_real_tool"),
    });
  });

  it("records final task status intent", async () => {
    const onFinalStatus = vi.fn();
    const result = await dispatchToolCall(
      "set_task_status",
      {
        status: "waiting_for_user",
        summary: "Ready to implement",
        continueLabel: "Implement this",
        continuePrompt: "Please implement this plan.",
      },
      { ...mockCtx, onFinalStatus },
    );

    expect(onFinalStatus).toHaveBeenCalledWith({
      status: "waiting_for_user",
      source: "tool",
      summary: "Ready to implement",
      continueAction: {
        label: "Implement this",
        prompt: "Please implement this plan.",
      },
    });
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: JSON.stringify({ ok: true }),
    });
  });

  it("can mark current todos complete with final completed status", async () => {
    const onCompleteTodos = vi.fn(() => [
      {
        id: "1",
        content: "Finish work",
        activeForm: "Finishing work",
        status: "completed" as const,
      },
    ]);

    const result = await dispatchToolCall(
      "set_task_status",
      { status: "completed", summary: "Done", completeTodos: true },
      { ...mockCtx, onFinalStatus: vi.fn(), onCompleteTodos },
    );

    expect(onCompleteTodos).toHaveBeenCalledTimes(1);
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: JSON.stringify({ ok: true, completedTodos: 1 }),
    });
  });

  it("does not complete todos for non-completed final statuses", async () => {
    const onCompleteTodos = vi.fn(() => []);

    const result = await dispatchToolCall(
      "set_task_status",
      {
        status: "waiting_for_user",
        summary: "Need input",
        completeTodos: true,
      },
      { ...mockCtx, onFinalStatus: vi.fn(), onCompleteTodos },
    );

    expect(onCompleteTodos).not.toHaveBeenCalled();
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(JSON.parse(text)).toMatchObject({
      ok: true,
      completeTodosIgnored: expect.stringContaining("status is 'completed'"),
    });
  });

  it("loads advertised rules through the session rule allowlist", async () => {
    const onFileRead = vi.fn();
    const getAdvertisedRules = vi.fn(() => [
      {
        source: ".agentlink/rules/typescript.md",
        filePath: "/workspace/.agentlink/rules/typescript.md",
        summary: "TypeScript standards",
      },
    ]);

    const result = await dispatchToolCall(
      "load_rule",
      { path: "/workspace/.agentlink/rules/typescript.md" },
      { ...mockCtx, getAdvertisedRules, onFileRead },
    );

    expect(handleLoadRule).toHaveBeenCalledWith(
      { path: "/workspace/.agentlink/rules/typescript.md" },
      mockCtx.approvalManager,
      mockCtx.approvalPanel,
      mockCtx.sessionId,
      [
        {
          source: ".agentlink/rules/typescript.md",
          filePath: "/workspace/.agentlink/rules/typescript.md",
          summary: "TypeScript standards",
        },
      ],
    );
    expect(onFileRead).toHaveBeenCalledWith(
      "/workspace/.agentlink/rules/typescript.md",
    );
    expect(result.content[0]).toMatchObject({ type: "text" });
  });

  it("replaces teaser-only final summaries with a diagnostic", async () => {
    const onFinalStatus = vi.fn();
    const result = await dispatchToolCall(
      "set_task_status",
      {
        status: "completed",
        summary: "Here’s a ready-to-paste prompt for the next agent.",
      },
      { ...mockCtx, onFinalStatus },
    );

    expect(onFinalStatus).toHaveBeenCalledWith({
      status: "completed",
      source: "tool",
      summary: expect.stringContaining("only promised an artifact"),
    });
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: JSON.stringify({ ok: true }),
    });
  });

  it("does not replace concise self-contained final summaries", async () => {
    const onFinalStatus = vi.fn();
    await dispatchToolCall(
      "set_task_status",
      {
        status: "completed",
        summary: "The answer is 42.",
      },
      { ...mockCtx, onFinalStatus },
    );

    expect(onFinalStatus).toHaveBeenCalledWith({
      status: "completed",
      source: "tool",
      summary: "The answer is 42.",
    });
  });

  it("allows final task status summaries that include inline command artifacts", async () => {
    const onFinalStatus = vi.fn();
    await dispatchToolCall(
      "set_task_status",
      {
        status: "completed",
        summary: "Paste this command: `npm test`.",
      },
      { ...mockCtx, onFinalStatus },
    );

    expect(onFinalStatus).toHaveBeenCalledWith({
      status: "completed",
      source: "tool",
      summary: "Paste this command: `npm test`.",
    });
  });

  it("allows final task status summaries that include the promised artifact", async () => {
    const onFinalStatus = vi.fn();
    const result = await dispatchToolCall(
      "set_task_status",
      {
        status: "completed",
        summary:
          "Paste this prompt into the next agent:\n\n```text\nDesign and implement the memory feature.\n```",
      },
      { ...mockCtx, onFinalStatus },
    );

    expect(onFinalStatus).toHaveBeenCalledWith({
      status: "completed",
      source: "tool",
      summary:
        "Paste this prompt into the next agent:\n\n```text\nDesign and implement the memory feature.\n```",
    });
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: JSON.stringify({ ok: true }),
    });
  });

  it("ignores legacy suppressContinue input", async () => {
    const onFinalStatus = vi.fn();
    const result = await dispatchToolCall(
      "set_task_status",
      {
        status: "completed",
        summary: "All done",
        suppressContinue: true,
      },
      { ...mockCtx, onFinalStatus },
    );

    expect(onFinalStatus).toHaveBeenCalledWith({
      status: "completed",
      source: "tool",
      summary: "All done",
    });
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: JSON.stringify({ ok: true }),
    });
  });

  it("honors custom continuation when legacy suppressContinue input is present", async () => {
    const onFinalStatus = vi.fn();
    await dispatchToolCall(
      "set_task_status",
      {
        status: "completed",
        summary: "All done",
        continueLabel: "Continue anyway",
        continuePrompt: "Please continue anyway.",
        suppressContinue: true,
      },
      { ...mockCtx, onFinalStatus },
    );

    expect(onFinalStatus).toHaveBeenCalledWith({
      status: "completed",
      source: "tool",
      summary: "All done",
      continueAction: {
        label: "Continue anyway",
        prompt: "Please continue anyway.",
      },
    });
  });

  it("rejects invalid final task status values", async () => {
    const onFinalStatus = vi.fn();
    const result = await dispatchToolCall(
      "set_task_status",
      { status: "done-ish" },
      { ...mockCtx, onFinalStatus },
    );

    expect(onFinalStatus).not.toHaveBeenCalled();
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(JSON.parse(text)).toMatchObject({ error: "Invalid status" });
  });

  it("dispatches read_file to handleReadFile", async () => {
    const { handleReadFile } = await import("../tools/readFile.js");
    const advertisedSkills = [
      { name: "helper", skillPath: "/outside/skills/helper/SKILL.md" },
    ];
    const result = await dispatchToolCall(
      "read_file",
      { path: "src/foo.ts" },
      { ...mockCtx, getAdvertisedSkills: () => advertisedSkills },
    );
    expect(handleReadFile).toHaveBeenCalledWith(
      { path: "src/foo.ts" },
      mockCtx.approvalManager,
      mockCtx.approvalPanel,
      mockCtx.sessionId,
      advertisedSkills,
    );
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: "file content",
    });
  });

  it("dispatches execute_command to handleExecuteCommand", async () => {
    const { handleExecuteCommand } = await import("../tools/executeCommand.js");
    const result = await dispatchToolCall(
      "execute_command",
      { command: "ls" },
      mockCtx,
    );
    expect(handleExecuteCommand).toHaveBeenCalledWith(
      { command: "ls" },
      mockCtx.approvalManager,
      mockCtx.approvalPanel,
      mockCtx.sessionId,
      mockCtx.trackerCtx,
    );
    expect(result.content[0]).toMatchObject({ type: "text", text: "output" });
  });

  it("dispatches write_file to handleWriteFile", async () => {
    const { handleWriteFile } = await import("../tools/writeFile.js");
    await dispatchToolCall(
      "write_file",
      { path: "foo.ts", content: "hello" },
      mockCtx,
    );
    expect(handleWriteFile).toHaveBeenCalledWith(
      { path: "foo.ts", content: "hello" },
      mockCtx.approvalManager,
      mockCtx.approvalPanel,
      mockCtx.sessionId,
      mockCtx.onApprovalRequest,
      mockCtx.mode,
    );
  });

  it("dispatches show_notification to handleShowNotification", async () => {
    const { handleShowNotification } =
      await import("../tools/showNotification.js");
    const result = await dispatchToolCall(
      "show_notification",
      { message: "hi" },
      mockCtx,
    );
    expect(handleShowNotification).toHaveBeenCalledWith({ message: "hi" });
    expect(result.content[0]).toMatchObject({ type: "text", text: "shown" });
  });

  it("dispatches find_and_replace with extensionUri", async () => {
    const { handleFindAndReplace } = await import("../tools/findAndReplace.js");
    await dispatchToolCall(
      "find_and_replace",
      { path: "**/*.ts", search: "old", replace: "new" },
      mockCtx,
    );
    expect(handleFindAndReplace).toHaveBeenCalledWith(
      { path: "**/*.ts", search: "old", replace: "new" },
      mockCtx.approvalManager,
      mockCtx.approvalPanel,
      mockCtx.sessionId,
      mockCtx.extensionUri,
      mockCtx.onApprovalRequest,
    );
  });

  it("dispatches get_terminal_output without ctx (params only)", async () => {
    const { handleGetTerminalOutput } =
      await import("../tools/getTerminalOutput.js");
    await dispatchToolCall(
      "get_terminal_output",
      { terminal_id: "t1" },
      mockCtx,
    );
    expect(handleGetTerminalOutput).toHaveBeenCalledWith({ terminal_id: "t1" });
  });

  describe("ask_user", () => {
    it("describes per-question context as the preferred shape", () => {
      const askUserTool = getAgentTools().find(
        (tool) => tool.name === "ask_user",
      );

      expect(askUserTool?.description).toContain("questions[].context");
      expect(askUserTool?.description).toContain(
        "split context across the individual questions",
      );
      expect(askUserTool?.input_schema.required).toEqual(["questions"]);
    });

    it("performs a silent mode switch when the user's answer is mapped", async () => {
      const onQuestion = vi.fn().mockResolvedValue({
        answers: { choice: "Plan first" },
        notes: {},
      });
      const onModeSwitch = vi
        .fn()
        .mockResolvedValue({ approved: true, mode: "architect" });

      const ctx: ToolDispatchContext = {
        ...mockCtx,
        onQuestion,
        onModeSwitch,
      };

      const result = await dispatchToolCall(
        "ask_user",
        {
          context: "I need your input to choose the next step.",
          questions: [
            {
              id: "choice",
              type: "multiple_choice",
              question: "How should we proceed?",
              options: ["Plan first", "Just implement"],
              recommended: "Plan first",
              modeSwitch: {
                "Plan first": "architect",
                "Just implement": "code",
              },
            },
          ],
        },
        ctx,
      );

      // Mode switch was triggered silently (third arg `true`)
      expect(onQuestion).toHaveBeenCalledWith(
        "I need your input to choose the next step.",
        expect.any(Array),
        "test-session",
      );
      expect(onModeSwitch).toHaveBeenCalledWith(
        "architect",
        expect.stringContaining("Plan first"),
        true,
      );

      const text = (result.content[0] as { type: "text"; text: string }).text;
      const parsed = JSON.parse(text);
      expect(parsed.modeSwitched).toBe("architect");
      expect(parsed.context).toBe("I need your input to choose the next step.");
      expect(parsed.responses).toEqual([
        {
          question: "How should we proceed?",
          answer: "Plan first",
        },
      ]);
    });

    it("omits modeSwitched when the chosen answer has no mapping", async () => {
      const onQuestion = vi.fn().mockResolvedValue({
        answers: { choice: "Just implement" },
        notes: {},
      });
      const onModeSwitch = vi.fn();

      const ctx: ToolDispatchContext = {
        ...mockCtx,
        onQuestion,
        onModeSwitch,
      };

      const result = await dispatchToolCall(
        "ask_user",
        {
          context: "I need your input to choose the next step.",
          questions: [
            {
              id: "choice",
              type: "multiple_choice",
              question: "How should we proceed?",
              options: ["Plan first", "Just implement"],
              modeSwitch: { "Plan first": "architect" },
            },
          ],
        },
        ctx,
      );

      expect(onModeSwitch).not.toHaveBeenCalled();
      const parsed = JSON.parse(
        (result.content[0] as { type: "text"; text: string }).text,
      );
      expect(parsed.modeSwitched).toBeUndefined();
    });

    it("accepts visible context on individual questions", async () => {
      const onQuestion = vi.fn().mockResolvedValue({
        answers: { choice: "Provider fix" },
        notes: {},
      });
      const ctx: ToolDispatchContext = { ...mockCtx, onQuestion };
      const result = await dispatchToolCall(
        "ask_user",
        {
          questions: [
            {
              id: "choice",
              type: "multiple_choice",
              context: "This choice affects how much shared code changes.",
              question: "How should we proceed?",
              options: ["Provider fix", "UI-only fix"],
              recommended: "Provider fix",
            },
          ],
        },
        ctx,
      );

      expect(onQuestion).toHaveBeenCalledWith(
        "",
        [
          expect.objectContaining({
            id: "choice",
            context: "This choice affects how much shared code changes.",
          }),
        ],
        "test-session",
      );
      const parsed = JSON.parse(
        (result.content[0] as { type: "text"; text: string }).text,
      );
      expect(parsed.responses).toEqual([
        {
          question: "How should we proceed?",
          context: "This choice affects how much shared code changes.",
          answer: "Provider fix",
        },
      ]);
    });

    it("rejects ask_user calls without visible context", async () => {
      const onQuestion = vi.fn();
      const ctx: ToolDispatchContext = { ...mockCtx, onQuestion };
      const result = await dispatchToolCall(
        "ask_user",
        {
          questions: [
            {
              id: "choice",
              type: "multiple_choice",
              question: "How should we proceed?",
              options: ["Plan first", "Just implement"],
            },
          ],
        },
        ctx,
      );

      expect(onQuestion).not.toHaveBeenCalled();
      const parsed = JSON.parse(
        (result.content[0] as { type: "text"; text: string }).text,
      );
      expect(parsed.error).toContain("requires visible context");
      expect(parsed.error).toContain("questions[].context");
    });

    it("rejects ask_user calls with multiple modeSwitch questions", async () => {
      const onQuestion = vi.fn();
      const ctx: ToolDispatchContext = { ...mockCtx, onQuestion };
      const result = await dispatchToolCall(
        "ask_user",
        {
          context: "I need your input to choose the next step.",
          questions: [
            {
              id: "a",
              type: "multiple_choice",
              question: "A?",
              options: ["x", "y"],
              modeSwitch: { x: "code" },
            },
            {
              id: "b",
              type: "multiple_choice",
              question: "B?",
              options: ["x", "y"],
              modeSwitch: { y: "architect" },
            },
          ],
        },
        ctx,
      );

      expect(onQuestion).not.toHaveBeenCalled();
      const parsed = JSON.parse(
        (result.content[0] as { type: "text"; text: string }).text,
      );
      expect(parsed.error).toContain("Only one question");
    });

    it("rejects modeSwitch on non-multiple_choice questions", async () => {
      const onQuestion = vi.fn();
      const ctx: ToolDispatchContext = { ...mockCtx, onQuestion };
      const result = await dispatchToolCall(
        "ask_user",
        {
          context: "I need your input to choose the next step.",
          questions: [
            {
              id: "a",
              type: "yes_no",
              question: "Plan first?",
              modeSwitch: { true: "architect" },
            },
          ],
        },
        ctx,
      );

      expect(onQuestion).not.toHaveBeenCalled();
      const parsed = JSON.parse(
        (result.content[0] as { type: "text"; text: string }).text,
      );
      expect(parsed.error).toContain("multiple_choice");
    });
  });

  it("discovers MCP tools with filtering and optional schemas", async () => {
    const mcpHub = {
      getToolDefs: vi.fn().mockReturnValue([
        {
          name: "linear__list_issues",
          description: "List Linear issues",
          input_schema: {
            type: "object",
            properties: { query: { type: "string" } },
          },
        },
        {
          name: "notion__notion-search",
          description: "Search Notion workspace",
          input_schema: { type: "object", properties: {} },
        },
        {
          name: "local_tool",
          description: "Not an MCP tool",
          input_schema: { type: "object", properties: {} },
        },
      ]),
    };

    const result = await dispatchToolCall(
      "find_mcp_tools",
      { query: "issues", includeSchemas: true },
      { ...mockCtx, mcpHub: mcpHub as any },
    );

    const parsed = JSON.parse(
      (result.content[0] as { type: string; text: string }).text,
    );
    expect(parsed).toEqual({
      tools: [
        {
          server: "linear",
          tool: "list_issues",
          name: "linear__list_issues",
          description: "List Linear issues",
          input_schema: {
            type: "object",
            properties: { query: { type: "string" } },
          },
        },
      ],
      count: 1,
      totalMatches: 1,
      truncated: false,
      schemaCount: 1,
      schemaLimited: false,
    });
  });

  it("filters MCP discovery results by the active skill allowlist", async () => {
    const mcpHub = {
      getToolDefs: vi.fn().mockReturnValue([
        {
          name: "linear__list_issues",
          description: "List Linear issues",
          input_schema: { type: "object", properties: {} },
        },
        {
          name: "notion__notion-search",
          description: "Search Notion workspace",
          input_schema: { type: "object", properties: {} },
        },
      ]),
    };

    const result = await dispatchToolCall(
      "find_mcp_tools",
      { query: "", limit: 10 },
      {
        ...mockCtx,
        mcpHub: mcpHub as any,
        skillAllowedTools: ["linear__list_issues"],
      },
    );

    const parsed = JSON.parse(
      (result.content[0] as { type: string; text: string }).text,
    );
    expect(parsed.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "linear__list_issues",
    ]);
    expect(parsed.totalMatches).toBe(1);
  });

  it("filters MCP resources and prompts by active skill server allowlist", async () => {
    const mcpHub = {
      getAllResources: vi.fn().mockReturnValue([
        { serverName: "linear", uri: "linear://issues" },
        { serverName: "notion", uri: "notion://pages" },
      ]),
      getAllPrompts: vi.fn().mockReturnValue([
        { serverName: "linear", name: "issue-summary" },
        { serverName: "notion", name: "page-summary" },
      ]),
    };

    const resources = await dispatchToolCall(
      "list_mcp_resources",
      {},
      {
        ...mockCtx,
        mcpHub: mcpHub as any,
        skillAllowedTools: ["linear"],
      },
    );
    const prompts = await dispatchToolCall(
      "list_mcp_prompts",
      {},
      {
        ...mockCtx,
        mcpHub: mcpHub as any,
        skillAllowedTools: ["linear"],
      },
    );

    expect(JSON.parse((resources.content[0] as { text: string }).text)).toEqual(
      [{ serverName: "linear", uri: "linear://issues" }],
    );
    expect(JSON.parse((prompts.content[0] as { text: string }).text)).toEqual([
      { serverName: "linear", name: "issue-summary" },
    ]);
  });

  it("rejects MCP resource and prompt reads outside the active skill server allowlist", async () => {
    const mcpHub = {
      readResource: vi.fn(),
      getPrompt: vi.fn(),
    };

    const resource = await dispatchToolCall(
      "read_mcp_resource",
      { server: "notion", uri: "notion://pages" },
      {
        ...mockCtx,
        mcpHub: mcpHub as any,
        skillAllowedTools: ["linear"],
      },
    );
    const prompt = await dispatchToolCall(
      "get_mcp_prompt",
      { server: "notion", name: "page-summary" },
      {
        ...mockCtx,
        mcpHub: mcpHub as any,
        skillAllowedTools: ["linear"],
      },
    );

    expect(mcpHub.readResource).not.toHaveBeenCalled();
    expect(mcpHub.getPrompt).not.toHaveBeenCalled();
    expect((resource.content[0] as { text: string }).text).toContain(
      "not allowed by the active skill allowed-tools allowlist",
    );
    expect((prompt.content[0] as { text: string }).text).toContain(
      "not allowed by the active skill allowed-tools allowlist",
    );
  });

  it("limits broad MCP discovery schema output by default", async () => {
    const mcpHub = {
      getToolDefs: vi.fn().mockReturnValue([
        {
          name: "linear__list_issues",
          description: "List issues in the user's Linear workspace",
          input_schema: {
            type: "object",
            properties: { assignee: { type: "string" } },
          },
        },
        {
          name: "linear__list_issue_labels",
          description:
            "List available issue labels in a Linear workspace or team",
          input_schema: {
            type: "object",
            properties: { team: { type: "string" } },
          },
        },
      ]),
    };

    const result = await dispatchToolCall(
      "find_mcp_tools",
      {
        server: "linear",
        query: "issue list",
        includeSchemas: true,
        limit: 10,
      },
      { ...mockCtx, mcpHub: mcpHub as any },
    );

    const parsed = JSON.parse(
      (result.content[0] as { type: string; text: string }).text,
    );
    expect(parsed.tools).toHaveLength(2);
    expect(parsed.tools[0].input_schema).toBeDefined();
    expect(parsed.tools[1].input_schema).toBeUndefined();
    expect(parsed.schemaCount).toBe(1);
    expect(parsed.schemaLimited).toBe(true);
  });

  it("honors schemaLimit when including MCP discovery schemas", async () => {
    const mcpHub = {
      getToolDefs: vi.fn().mockReturnValue([
        {
          name: "linear__list_issues",
          description: "List issues in the user's Linear workspace",
          input_schema: {
            type: "object",
            properties: { a: { type: "string" } },
          },
        },
        {
          name: "linear__get_issue",
          description: "Retrieve detailed information about an issue by ID",
          input_schema: {
            type: "object",
            properties: { b: { type: "string" } },
          },
        },
        {
          name: "linear__list_issue_labels",
          description:
            "List available issue labels in a Linear workspace or team",
          input_schema: {
            type: "object",
            properties: { c: { type: "string" } },
          },
        },
      ]),
    };

    const result = await dispatchToolCall(
      "find_mcp_tools",
      {
        server: "linear",
        query: "issue",
        includeSchemas: true,
        schemaLimit: 2,
        limit: 10,
      },
      { ...mockCtx, mcpHub: mcpHub as any },
    );

    const parsed = JSON.parse(
      (result.content[0] as { type: string; text: string }).text,
    );
    expect(
      parsed.tools.filter(
        (tool: { input_schema?: unknown }) => tool.input_schema,
      ),
    ).toHaveLength(2);
    expect(parsed.schemaCount).toBe(2);
    expect(parsed.schemaLimited).toBe(true);
  });

  it("ranks MCP discovery results using token overlap instead of exact substring order", async () => {
    const mcpHub = {
      getToolDefs: vi.fn().mockReturnValue([
        {
          name: "linear__list_projects",
          description: "List projects in the user's Linear workspace",
          input_schema: { type: "object", properties: {} },
        },
        {
          name: "linear__list_issue_labels",
          description:
            "List available issue labels in a Linear workspace or team",
          input_schema: { type: "object", properties: {} },
        },
        {
          name: "linear__list_issue_statuses",
          description: "List available issue statuses in a Linear team",
          input_schema: { type: "object", properties: {} },
        },
        {
          name: "linear__list_issues",
          description:
            'List issues in the user\'s Linear workspace. For my issues, use "me" as the assignee.',
          input_schema: { type: "object", properties: {} },
        },
        {
          name: "linear__get_issue",
          description: "Retrieve detailed information about an issue by ID",
          input_schema: { type: "object", properties: {} },
        },
      ]),
    };

    const result = await dispatchToolCall(
      "find_mcp_tools",
      { server: "linear", query: "issue list recent", limit: 10 },
      { ...mockCtx, mcpHub: mcpHub as any },
    );

    const parsed = JSON.parse(
      (result.content[0] as { type: string; text: string }).text,
    );
    expect(parsed.tools[0]).toMatchObject({
      server: "linear",
      tool: "list_issues",
      name: "linear__list_issues",
    });
    expect(parsed.tools.map((tool: { name: string }) => tool.name)).toContain(
      "linear__get_issue",
    );
    expect(
      parsed.tools.slice(1).map((tool: { name: string }) => tool.name),
    ).toContain("linear__list_issue_labels");
  });

  it("allows call_mcp_tool bare tool names containing the MCP separator", async () => {
    const mcpHub = {
      getToolDefs: vi.fn().mockReturnValue([
        {
          name: "server__name__tool",
          description: "Tool with separator in bare name",
          input_schema: { type: "object", properties: {} },
        },
      ]),
      getServerConfig: vi.fn().mockReturnValue({ toolPolicy: "allow" }),
      callTool: vi.fn().mockResolvedValue({
        content: [{ type: "text", text: JSON.stringify({ ok: true }) }],
      }),
    };

    await dispatchToolCall(
      "call_mcp_tool",
      { server: "server", tool: "name__tool", input: { ok: true } },
      {
        ...mockCtx,
        approvalManager: {
          isMcpApproved: vi.fn().mockReturnValue(false),
        } as any,
        mcpHub: mcpHub as any,
      },
    );

    expect(mcpHub.callTool).toHaveBeenCalledWith(
      "server__name__tool",
      {
        ok: true,
      },
      { signal: undefined },
    );
  });

  it("rejects call_mcp_tool targets outside the active skill allowlist", async () => {
    const onApprovalRequest = vi.fn().mockResolvedValue("allow-once");
    const mcpHub = {
      getToolDefs: vi.fn().mockReturnValue([
        {
          name: "linear__list_issues",
          description: "List issues",
          input_schema: { type: "object", properties: {} },
        },
        {
          name: "linear__delete_issue",
          description: "Delete issue",
          input_schema: { type: "object", properties: {} },
        },
      ]),
      getServerConfig: vi.fn().mockReturnValue(undefined),
      callTool: vi.fn(),
    };

    const result = await dispatchToolCall(
      "call_mcp_tool",
      { server: "linear", tool: "delete_issue", input: { id: "LIN-1" } },
      {
        ...mockCtx,
        onApprovalRequest,
        mcpHub: mcpHub as any,
        skillAllowedTools: ["linear__list_issues"],
      },
    );

    expect(onApprovalRequest).not.toHaveBeenCalled();
    expect(mcpHub.callTool).not.toHaveBeenCalled();
    expect((result.content[0] as { text: string }).text).toContain(
      "not allowed by the active skill allowed-tools allowlist",
    );
  });

  it("rejects direct MCP tools that only match a native-looking bare allowlist entry", async () => {
    const onApprovalRequest = vi.fn().mockResolvedValue("allow-once");
    const mcpHub = {
      getServerConfig: vi.fn().mockReturnValue(undefined),
      callTool: vi.fn(),
    };

    const result = await dispatchToolCall(
      "filesystem__read_file",
      { path: "secret.txt" },
      {
        ...mockCtx,
        onApprovalRequest,
        mcpHub: mcpHub as any,
        skillAllowedTools: ["read_file"],
      },
    );

    expect(onApprovalRequest).not.toHaveBeenCalled();
    expect(mcpHub.callTool).not.toHaveBeenCalled();
    expect((result.content[0] as { text: string }).text).toContain(
      "not allowed by the active skill allowed-tools allowlist",
    );
  });

  it("allows call_mcp_tool targets inside the active skill MCP server allowlist", async () => {
    const onApprovalRequest = vi.fn().mockResolvedValue("allow-once");
    const mcpHub = {
      getToolDefs: vi.fn().mockReturnValue([
        {
          name: "linear__list_issues",
          description: "List issues",
          input_schema: { type: "object", properties: {} },
        },
      ]),
      getServerConfig: vi.fn().mockReturnValue(undefined),
      callTool: vi.fn().mockResolvedValue({
        content: [{ type: "text", text: JSON.stringify({ ok: true }) }],
      }),
    };

    await dispatchToolCall(
      "call_mcp_tool",
      { server: "linear", tool: "list_issues", input: { query: "bug" } },
      {
        ...mockCtx,
        approvalManager: {
          isMcpApproved: vi.fn().mockReturnValue(false),
        } as any,
        onApprovalRequest,
        mcpHub: mcpHub as any,
        skillAllowedTools: ["linear"],
      },
    );

    expect(onApprovalRequest).toHaveBeenCalled();
    expect(mcpHub.callTool).toHaveBeenCalledWith(
      "linear__list_issues",
      {
        query: "bug",
      },
      { signal: undefined },
    );
  });

  it("calls MCP tools through call_mcp_tool using the standard approval path", async () => {
    const onApprovalRequest = vi.fn().mockResolvedValue("allow-once");
    const mcpHub = {
      getToolDefs: vi.fn().mockReturnValue([
        {
          name: "linear__list_issues",
          description: "List issues",
          input_schema: { type: "object", properties: {} },
        },
      ]),
      getServerConfig: vi.fn().mockReturnValue(undefined),
      callTool: vi.fn().mockResolvedValue({
        content: [{ type: "text", text: JSON.stringify({ ok: true }) }],
      }),
    };

    const ctx: ToolDispatchContext = {
      approvalManager: {
        isMcpApproved: vi.fn().mockReturnValue(false),
        approveMcpTool: vi.fn(),
      } as any,
      approvalPanel: {} as any,
      sessionId: "test-session",
      extensionUri: {} as any,
      onApprovalRequest,
      mcpHub: mcpHub as any,
    };

    const result = await dispatchToolCall(
      "call_mcp_tool",
      { server: "linear", tool: "list_issues", input: { query: "bug" } },
      ctx,
    );

    expect(onApprovalRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "mcp",
        title: 'Allow MCP tool "list_issues" from "linear"?',
      }),
      "test-session",
    );
    expect(mcpHub.callTool).toHaveBeenCalledWith(
      "linear__list_issues",
      {
        query: "bug",
      },
      { signal: undefined },
    );
    expect(result.uiMeta?.mcpApprovalPromotion).toEqual({
      serverName: "linear",
      bareToolName: "list_issues",
      scopes: ["session", "project", "global"],
    });
  });

  it("tracks nested call_mcp_tool targets and aborts the MCP request when cancelled", async () => {
    let nestedForceResolve: ((result: ToolResult) => void) | undefined;
    const mcpHub = {
      getToolDefs: vi.fn().mockReturnValue([
        {
          name: "linear__list_issues",
          description: "List issues",
          input_schema: { type: "object", properties: {} },
        },
      ]),
      getServerConfig: vi.fn().mockReturnValue({ toolPolicy: "allow" }),
      callTool: vi.fn(
        async (
          _toolName: string,
          _input: Record<string, unknown>,
          options?: { signal?: AbortSignal },
        ) =>
          new Promise<ToolResult>((resolve, reject) => {
            options?.signal?.addEventListener("abort", () => {
              reject(new DOMException("Aborted", "AbortError"));
            });
          }),
      ),
    };
    const toolCallTracker = {
      registerAgentCall: vi.fn(
        (
          _id: string,
          _toolName: string,
          _displayArgs: string,
          _sessionId: string,
          forceResolve: (result: ToolResult) => void,
        ) => {
          nestedForceResolve = forceResolve;
          return {
            toolCallId: "nested-call",
            setApprovalId: vi.fn(),
            setTerminalId: vi.fn(),
          };
        },
      ),
      completeAgentCall: vi.fn(),
    };

    const dispatchPromise = dispatchToolCall(
      "call_mcp_tool",
      { server: "linear", tool: "list_issues", input: { query: "bug" } },
      {
        ...mockCtx,
        approvalManager: {
          isMcpApproved: vi.fn().mockReturnValue(false),
        } as any,
        mcpHub: mcpHub as any,
        toolCallTracker: toolCallTracker as any,
        trackerCtx: {
          toolCallId: "outer-call",
          setApprovalId: vi.fn(),
          setTerminalId: vi.fn(),
        },
      },
    );

    await vi.waitFor(() => expect(mcpHub.callTool).toHaveBeenCalled());
    const signal = mcpHub.callTool.mock.calls[0][2]?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);

    nestedForceResolve?.({
      content: [
        { type: "text", text: JSON.stringify({ status: "cancelled" }) },
      ],
    });

    const result = await dispatchPromise;
    expect(signal?.aborted).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("cancelled");
    expect(toolCallTracker.registerAgentCall).toHaveBeenCalledWith(
      "outer-call:linear__list_issues",
      "linear__list_issues",
      "linear.list_issues",
      "test-session",
      expect.any(Function),
      JSON.stringify({ query: "bug" }, null, 2),
    );
    expect(toolCallTracker.completeAgentCall).toHaveBeenCalledWith(
      "outer-call:linear__list_issues",
    );
  });

  it("propagates outer call_mcp_tool cancellation to the nested MCP request", async () => {
    const outerController = new AbortController();
    const mcpHub = {
      getToolDefs: vi.fn().mockReturnValue([
        {
          name: "linear__list_issues",
          description: "List issues",
          input_schema: { type: "object", properties: {} },
        },
      ]),
      getServerConfig: vi.fn().mockReturnValue({ toolPolicy: "allow" }),
      callTool: vi.fn(
        async (
          _toolName: string,
          _input: Record<string, unknown>,
          options?: { signal?: AbortSignal },
        ) =>
          new Promise<ToolResult>((resolve, reject) => {
            options?.signal?.addEventListener("abort", () => {
              reject(new DOMException("Aborted", "AbortError"));
            });
          }),
      ),
    };
    const toolCallTracker = {
      registerAgentCall: vi.fn(
        (
          _id: string,
          _toolName: string,
          _displayArgs: string,
          _sessionId: string,
          _forceResolve: (result: ToolResult) => void,
        ) => ({
          toolCallId: "nested-call",
          setApprovalId: vi.fn(),
          setTerminalId: vi.fn(),
        }),
      ),
      completeAgentCall: vi.fn(),
    };

    const dispatchPromise = dispatchToolCall(
      "call_mcp_tool",
      { server: "linear", tool: "list_issues", input: { query: "bug" } },
      {
        ...mockCtx,
        approvalManager: {
          isMcpApproved: vi.fn().mockReturnValue(false),
        } as any,
        mcpHub: mcpHub as any,
        toolAbortSignal: outerController.signal,
        toolCallTracker: toolCallTracker as any,
        trackerCtx: {
          toolCallId: "outer-call",
          setApprovalId: vi.fn(),
          setTerminalId: vi.fn(),
        },
      },
    );

    await vi.waitFor(() => expect(mcpHub.callTool).toHaveBeenCalled());
    const signal = mcpHub.callTool.mock.calls[0][2]?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);

    outerController.abort();

    const result = await dispatchPromise;
    expect(signal?.aborted).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("Aborted");
    expect(toolCallTracker.completeAgentCall).toHaveBeenCalledWith(
      "outer-call:linear__list_issues",
    );
  });

  it("rejects unknown call_mcp_tool targets before requesting approval", async () => {
    const onApprovalRequest = vi.fn().mockResolvedValue("allow-once");
    const mcpHub = {
      getToolDefs: vi.fn().mockReturnValue([
        {
          name: "linear__list_issues",
          description: "List issues",
          input_schema: { type: "object", properties: {} },
        },
      ]),
      getServerConfig: vi.fn().mockReturnValue(undefined),
      callTool: vi.fn(),
    };

    const result = await dispatchToolCall(
      "call_mcp_tool",
      { server: "linear", tool: "missing_tool", input: {} },
      { ...mockCtx, onApprovalRequest, mcpHub: mcpHub as any },
    );

    expect(onApprovalRequest).not.toHaveBeenCalled();
    expect(mcpHub.callTool).not.toHaveBeenCalled();
    expect((result.content[0] as { text: string }).text).toContain(
      "MCP tool not found: linear__missing_tool",
    );
  });

  it("attaches MCP approval promotion metadata after allow-once approvals", async () => {
    const onApprovalRequest = vi.fn().mockResolvedValue("allow-once");
    const approveMcpTool = vi.fn();
    const mcpHub = {
      getServerConfig: vi.fn().mockReturnValue(undefined),
      callTool: vi.fn().mockResolvedValue({
        content: [{ type: "text", text: JSON.stringify({ ok: true }) }],
      }),
    };

    const ctx: ToolDispatchContext = {
      approvalManager: {
        isMcpApproved: vi.fn().mockReturnValue(false),
        approveMcpTool,
      } as any,
      approvalPanel: {} as any,
      sessionId: "test-session",
      extensionUri: {} as any,
      onApprovalRequest,
      mcpHub: mcpHub as any,
    };

    const result = await dispatchToolCall(
      "notion__search",
      { query: "docs" },
      ctx,
    );

    expect(onApprovalRequest).toHaveBeenCalled();
    expect(approveMcpTool).not.toHaveBeenCalled();
    expect(result.uiMeta?.mcpApprovalPromotion).toEqual({
      serverName: "notion",
      bareToolName: "search",
      scopes: ["session", "project", "global"],
    });
  });
});
