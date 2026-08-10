import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, it, expect, vi } from "vitest";
import {
  BENCHMARK_LANGUAGE_TOOLS,
  getAgentTools,
  dispatchToolCall,
  createAgentToolRuntime,
  getToolUsageOutcomeFromResult,
  READ_ONLY_TOOLS,
  STATIC_ADAPTER_TOOL_NAMES,
  type ToolDispatchContext,
} from "./toolAdapter.js";
import {
  COMPOSABLE_TOOLS,
  PARALLEL_SAFE_TOOLS,
  TOOL_CAPABILITIES,
} from "../core/tools/toolCapabilities.js";
import { createNativeToolDisclosureSnapshot } from "../core/tools/nativeToolDisclosure.js";
import { TOOL_REGISTRY } from "../shared/toolRegistry.js";
import { BUILT_IN_MODES } from "./modes.js";
import { TODO_TOOL_NAME } from "./todoTool.js";
import type { ToolDefinition } from "./providers/types.js";
import type { ToolResult } from "../shared/types.js";
import type { MemoryToolProvider } from "../core/capabilities/memory.js";
import { getWorkspaceRoots, resolveAndValidatePath } from "../util/paths.js";
import { handleLoadRule } from "../tools/loadRule.js";
import { handleLoadSkill } from "../tools/loadSkill.js";
import { handleReadFile } from "../tools/readFile.js";
import { handleGetContext } from "../tools/context/getContext.js";
import { handleGetCallHierarchy } from "../tools/getCallHierarchy.js";
import { handleGetModuleNeighbors } from "../tools/getModuleNeighbors.js";
import { handleGetRepoMap } from "../tools/getRepoMap.js";

const composeRuntimeMocks = vi.hoisted(() => ({
  handleCompose: vi.fn().mockResolvedValue({
    content: [{ type: "text", text: "compose result" }],
    data: { ok: true },
    isError: false,
    uiMeta: {
      composeTrace: {
        status: "completed",
        totalChildren: 5,
        completedChildren: 5,
        succeededChildren: 3,
        failedChildren: 1,
        cancelledChildren: 1,
        toolAllBatchCount: 2,
        toolAllSettledBatchCount: 1,
        bridgedBytes: 1234,
        children: [],
      },
    },
  }),
}));

const feedbackToolMocks = vi.hoisted(() => ({
  handleDeleteFeedback: vi.fn().mockResolvedValue({
    content: [{ type: "text", text: "deleted" }],
  }),
  handleGetFeedback: vi.fn().mockResolvedValue({
    content: [{ type: "text", text: "feedback" }],
  }),
  handleTriageFeedback: vi.fn().mockResolvedValue({
    content: [{ type: "text", text: "triaged" }],
  }),
}));

vi.mock("./compose/composeRuntimeLoader.js", () => ({
  loadComposeRuntime: vi.fn().mockResolvedValue({
    handleCompose: composeRuntimeMocks.handleCompose,
  }),
}));

// Mock all tool handlers so dispatchToolCall tests don't hit VS Code APIs
vi.mock("../tools/readFile.js", () => ({
  handleReadFile: vi
    .fn()
    .mockResolvedValue({ content: [{ type: "text", text: "file content" }] }),
  getGitStatus: vi.fn(() => undefined),
  detectLanguage: vi.fn(() => undefined),
  getSymbolOutline: vi.fn(async () => undefined),
  getDiagnosticsSummary: vi.fn(() => undefined),
}));
vi.mock("../tools/context/getContext.js", () => ({
  handleGetContext: vi
    .fn()
    .mockResolvedValue({ content: [{ type: "text", text: "context" }] }),
  getContextGitStatus: vi.fn(() => undefined),
  getContextDocumentSymbols: vi.fn(async () => undefined),
  getContextDiagnosticsSummary: vi.fn(() => undefined),
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
vi.mock("../tools/loadSkill.js", () => ({
  handleLoadSkill: vi.fn().mockResolvedValue({
    content: [{ type: "text", text: JSON.stringify({ skill_name: "helper" }) }],
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
vi.mock("../tools/generateImage.js", () => ({
  handleGenerateImage: vi
    .fn()
    .mockResolvedValue({ content: [{ type: "text", text: "generated" }] }),
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
vi.mock("../tools/deleteFeedback.js", () => ({
  handleDeleteFeedback: feedbackToolMocks.handleDeleteFeedback,
}));
vi.mock("../tools/getFeedback.js", () => ({
  handleGetFeedback: feedbackToolMocks.handleGetFeedback,
}));
vi.mock("../tools/triageFeedback.js", () => ({
  handleTriageFeedback: feedbackToolMocks.handleTriageFeedback,
}));

const mockOnApprovalRequest = vi.fn();
const mockCtx: ToolDispatchContext = {
  approvalManager: {} as any,
  approvalPanel: {} as any,
  sessionId: "test-session",
  projectRoot: "/tmp/project",
  extensionUri: {} as any,
  onApprovalRequest: mockOnApprovalRequest,
  terminalProvider: {} as any,
};

function parseRecallPayload(result: ToolResult): Record<string, any> {
  const text =
    result.content.find((entry) => entry.type === "text")?.text ?? "";
  const match = text.match(
    /<session-transcript-recall>\n[^\n]+\n([\s\S]*?)\n<\/session-transcript-recall>/,
  );
  if (!match?.[1]) throw new Error(`Missing recall payload: ${text}`);
  return JSON.parse(match[1]) as Record<string, any>;
}

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

describe("tool usage telemetry project attribution", () => {
  it("records only the request-bound project ID", async () => {
    const record = vi.fn();
    const runtime = createAgentToolRuntime({
      ...mockCtx,
      projectScope: {
        schemaVersion: 1,
        kind: "project",
        projectId: "project-0123456789abcdef",
        workspaceFolderUri: "file:///sensitive/project",
        displayName: "Sensitive Project Name",
        rootPath: "/sensitive/project",
      },
      toolUsageTelemetry: { record } as any,
    });

    await runtime.executeTool({
      name: "read_file",
      input: { path: "README.md" },
      context: { sessionId: "test-session", mode: "code" },
    });

    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "read_file",
        projectId: "project-0123456789abcdef",
      }),
    );
    expect(JSON.stringify(record.mock.calls)).not.toContain(
      "Sensitive Project Name",
    );
    expect(JSON.stringify(record.mock.calls)).not.toContain(
      "file:///sensitive/project",
    );
    expect(JSON.stringify(record.mock.calls)).not.toContain(
      "/sensitive/project",
    );
  });

  it("forwards the exact run-scoped artifact writer into compose", async () => {
    composeRuntimeMocks.handleCompose.mockClear();
    const retainToolResultArtifact = vi.fn(async () => null);
    const record = vi.fn();
    const runtime = createAgentToolRuntime({
      ...mockCtx,
      extensionUri: { fsPath: "/extension" } as any,
      toolUsageTelemetry: { record } as any,
    });

    const result = await runtime.executeTool({
      name: "compose",
      input: { script: "return null;" },
      context: {
        sessionId: "test-session",
        mode: "code",
        availableToolNames: new Set(["compose"]),
        toolCallBudget: new (
          await import("../core/tools/toolCallBudget.js")
        ).ToolCallBudget(4),
        toolCallId: "compose-call",
        retainToolResultArtifact,
      },
    });

    expect(result.isError).not.toBe(true);
    expect(composeRuntimeMocks.handleCompose).toHaveBeenCalledOnce();
    expect(composeRuntimeMocks.handleCompose).toHaveBeenCalledWith(
      expect.objectContaining({ retainArtifact: retainToolResultArtifact }),
    );
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "compose",
        metrics: expect.objectContaining({
          childCount: 5,
          completedChildCount: 5,
          succeededChildCount: 3,
          failedChildCount: 1,
          cancelledChildCount: 1,
          toolAllBatchCount: 2,
          toolAllSettledBatchCount: 1,
          bridgedBytes: 1234,
        }),
      }),
    );
  });

  it("rejects top-level calls that were not in the provider request snapshot", async () => {
    const runtime = createAgentToolRuntime(mockCtx);

    const result = await runtime.executeTool({
      name: "get_completions",
      input: { path: "src/file.ts", line: 1, column: 1 },
      context: {
        sessionId: "test-session",
        mode: "code",
        availableToolNames: new Set(["read_file"]),
      },
    });

    expect(result).toMatchObject({
      isError: true,
      data: {
        status: "tool_not_available",
        tool: "get_completions",
      },
    });
  });

  it("rejects advertised tools outside the current mode's allowance", async () => {
    const runtime = createAgentToolRuntime(mockCtx);

    const result = await runtime.executeTool({
      name: "write_file",
      input: { path: "src/file.ts", content: "x" },
      context: {
        sessionId: "test-session",
        mode: "ask",
        // The advertised union includes write_file for cache stability, but
        // ask mode's own allowance does not.
        availableToolNames: new Set(["read_file", "write_file"]),
        modeAllowedToolNames: new Set(["read_file"]),
      },
    });

    expect(result).toMatchObject({
      isError: true,
      data: {
        status: "tool_not_in_mode",
        tool: "write_file",
      },
    });
    const text = JSON.stringify(result.content);
    expect(text).toContain("not available in ask mode");
    expect(text).toContain("switch_mode");
  });

  it("keeps deferred image generation behind the active mode gate", async () => {
    const { handleGenerateImage } = await import("../tools/generateImage.js");
    vi.mocked(handleGenerateImage).mockClear();
    const runtime = createAgentToolRuntime(mockCtx);
    const target = getAgentTools().find(
      (tool) => tool.name === "generate_image",
    )!;
    const nativeToolDisclosure = createNativeToolDisclosureSnapshot([target]);
    const input = { prompt: "Generate a test image" };

    const rejected = await runtime.executeTool({
      name: "call_native_tool",
      input: { name: "generate_image", input },
      context: {
        sessionId: "test-session",
        mode: "ask",
        availableToolNames: new Set(["call_native_tool"]),
        modeAllowedToolNames: new Set(["read_file"]),
        nativeToolDisclosure,
      },
    });
    expect(rejected).toMatchObject({
      isError: true,
      data: { status: "tool_not_in_mode", tool: "generate_image" },
    });
    expect(handleGenerateImage).not.toHaveBeenCalled();

    const accepted = await runtime.executeTool({
      name: "call_native_tool",
      input: { name: "generate_image", input },
      context: {
        sessionId: "test-session",
        mode: "code",
        availableToolNames: new Set(["call_native_tool"]),
        modeAllowedToolNames: new Set(["generate_image"]),
        nativeToolDisclosure,
      },
    });
    expect(accepted.isError).not.toBe(true);
    expect(handleGenerateImage).toHaveBeenCalledOnce();
    expect(handleGenerateImage).toHaveBeenCalledWith(
      input,
      mockCtx.approvalManager,
      "test-session",
      mockCtx.onApprovalRequest,
      mockCtx.getSessionImages,
    );
  });

  it("discovers only deferred tools from the frozen request snapshot", async () => {
    const runtime = createAgentToolRuntime(mockCtx);
    const nativeToolDisclosure = createNativeToolDisclosureSnapshot([
      getAgentTools().find((tool) => tool.name === "read_file")!,
      getAgentTools().find((tool) => tool.name === "get_call_hierarchy")!,
      getAgentTools().find((tool) => tool.name === "manage_memory")!,
    ]);

    const result = await runtime.executeTool({
      name: "find_native_tools",
      input: { limit: 1, include_schemas: true, schema_limit: 1 },
      context: {
        sessionId: "test-session",
        mode: "code",
        availableToolNames: new Set(["find_native_tools", "call_native_tool"]),
        nativeToolDisclosure,
      },
    });

    expect(result.data).toMatchObject({
      schemaVersion: 1,
      total: 2,
      limit: 1,
      nextOffset: 1,
      tools: [
        {
          name: "get_call_hierarchy",
          disclosure: "eligible",
          input_schema: expect.objectContaining({ type: "object" }),
        },
      ],
    });
    expect(JSON.stringify(result.data)).not.toContain("read_file");
  });

  it("discovers multiple exact deferred tool names through the runtime bridge", async () => {
    const runtime = createAgentToolRuntime(mockCtx);
    const nativeToolDisclosure = createNativeToolDisclosureSnapshot([
      getAgentTools().find((tool) => tool.name === "get_call_hierarchy")!,
      getAgentTools().find((tool) => tool.name === "get_type_hierarchy")!,
      getAgentTools().find((tool) => tool.name === "manage_memory")!,
    ]);

    const result = await runtime.executeTool({
      name: "find_native_tools",
      input: {
        query: "get_call_hierarchy get_type_hierarchy",
        include_schemas: true,
        schema_limit: 2,
      },
      context: {
        sessionId: "test-session",
        mode: "code",
        availableToolNames: new Set(["find_native_tools", "call_native_tool"]),
        nativeToolDisclosure,
      },
    });

    expect(result.data).toMatchObject({
      total: 2,
      tools: [
        {
          name: "get_call_hierarchy",
          input_schema: expect.objectContaining({ type: "object" }),
        },
        {
          name: "get_type_hierarchy",
          input_schema: expect.objectContaining({ type: "object" }),
        },
      ],
    });
  });

  it("invokes an exact deferred target with canonical validation and telemetry", async () => {
    const record = vi.fn();
    const runtime = createAgentToolRuntime({
      ...mockCtx,
      toolUsageTelemetry: { record } as any,
    });
    const target = getAgentTools().find(
      (tool) => tool.name === "get_call_hierarchy",
    )!;
    const nativeToolDisclosure = createNativeToolDisclosureSnapshot([target]);
    vi.mocked(handleGetCallHierarchy).mockClear();

    const result = await runtime.executeTool({
      name: "call_native_tool",
      input: {
        name: "get_call_hierarchy",
        input: {
          path: "src/file.ts",
          line: 1,
          column: 1,
          direction: "both",
        },
      },
      context: {
        sessionId: "test-session",
        mode: "code",
        availableToolNames: new Set(["call_native_tool"]),
        modeAllowedToolNames: new Set(["get_call_hierarchy"]),
        nativeToolDisclosure,
      },
    });

    expect(result.isError).not.toBe(true);
    expect(handleGetCallHierarchy).toHaveBeenCalledOnce();
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "get_call_hierarchy",
        params: expect.objectContaining({
          path: "src/file.ts",
          direction: "both",
        }),
      }),
    );
  });

  it("rejects forged pre-resolved native calls outside the frozen snapshot", async () => {
    const runtime = createAgentToolRuntime(mockCtx);
    const nativeToolDisclosure = createNativeToolDisclosureSnapshot([
      getAgentTools().find((tool) => tool.name === "get_call_hierarchy")!,
    ]);
    vi.mocked(handleGetCallHierarchy).mockClear();

    const result = await runtime.executeTool({
      name: "get_type_hierarchy",
      input: {
        path: "src/file.ts",
        line: 1,
        column: 1,
        direction: "both",
      },
      context: {
        sessionId: "test-session",
        mode: "code",
        availableToolNames: new Set(["call_native_tool"]),
        providerToolName: "call_native_tool",
        providerToolInput: {
          name: "get_type_hierarchy",
          input: {
            path: "src/file.ts",
            line: 1,
            column: 1,
            direction: "both",
          },
        },
        nativeToolDisclosure,
      },
    });

    expect(result).toMatchObject({
      isError: true,
      data: { status: "invalid_resolved_native_tool" },
    });
    expect(handleGetCallHierarchy).not.toHaveBeenCalled();
  });

  it("rejects unknown and invalid deferred targets before handler execution", async () => {
    const runtime = createAgentToolRuntime(mockCtx);
    const target = getAgentTools().find(
      (tool) => tool.name === "get_call_hierarchy",
    )!;
    const nativeToolDisclosure = createNativeToolDisclosureSnapshot([target]);
    vi.mocked(handleGetCallHierarchy).mockClear();

    const unknown = await runtime.executeTool({
      name: "call_native_tool",
      input: { name: "read_file", input: { path: "README.md" } },
      context: {
        sessionId: "test-session",
        mode: "code",
        availableToolNames: new Set(["call_native_tool"]),
        nativeToolDisclosure,
      },
    });
    const invalid = await runtime.executeTool({
      name: "call_native_tool",
      input: {
        name: "get_call_hierarchy",
        input: { path: "src/file.ts", line: 1 },
      },
      context: {
        sessionId: "test-session",
        mode: "code",
        availableToolNames: new Set(["call_native_tool"]),
        nativeToolDisclosure,
      },
    });

    expect(unknown).toMatchObject({
      isError: true,
      data: { status: "native_tool_not_available" },
    });
    expect(invalid).toMatchObject({
      isError: true,
      data: { status: "invalid_native_tool_input" },
    });
    expect(handleGetCallHierarchy).not.toHaveBeenCalled();
  });

  it("allows mode-permitted tools through the mode gate", async () => {
    const record = vi.fn();
    const runtime = createAgentToolRuntime({
      ...mockCtx,
      toolUsageTelemetry: { record } as any,
    });

    const result = await runtime.executeTool({
      name: "read_file",
      input: { path: "README.md" },
      context: {
        sessionId: "test-session",
        mode: "ask",
        availableToolNames: new Set(["read_file", "write_file"]),
        modeAllowedToolNames: new Set(["read_file"]),
      },
    });

    expect(result).not.toMatchObject({
      data: { status: "tool_not_in_mode" },
    });
  });
});

const READ_ONLY_TOOLS_COMPATIBILITY_SNAPSHOT = [
  "read_file",
  "get_context",
  "get_repo_map",
  "get_module_neighbors",
  "load_rule",
  "load_skill",
  "list_files",
  "search_files",
  "web_search",
  "web_fetch",
  "search_session_history",
  "read_session_excerpt",
  "diagnose_activity",
  "recall_memory",
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
  "execute_command",
  "get_terminal_output",
  "ask_user",
  "find_mcp_tools",
  "find_native_tools",
  "list_mcp_resources",
  "read_mcp_resource",
  "list_mcp_prompts",
  "get_mcp_prompt",
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

  it("keeps the capability registry in exact parity with static adapter and engine definitions", () => {
    const implemented = new Set([...STATIC_ADAPTER_TOOL_NAMES, TODO_TOOL_NAME]);
    expect([...implemented].sort()).toEqual(
      Object.keys(TOOL_CAPABILITIES).sort(),
    );
  });

  it("classifies alternate definition, availability, and execution seams explicitly", () => {
    expect(TOOL_CAPABILITIES.todo_write).toMatchObject({
      availability: { kind: "session-control" },
      definitionSource: "engine-inline",
      executionRoute: "engine-inline",
      telemetryOwner: "engine",
      disclosure: "essential",
    });
    expect(TOOL_CAPABILITIES.find_native_tools).toMatchObject({
      availability: { kind: "native-bridge" },
      definitionSource: "registry-schema",
      executionRoute: "runtime-dispatch",
      telemetryOwner: "runtime",
      disclosure: "essential",
    });
    expect(TOOL_CAPABILITIES.call_native_tool).toMatchObject({
      availability: { kind: "native-bridge" },
      definitionSource: "registry-schema",
      executionRoute: "runtime-dispatch",
      telemetryOwner: "runtime",
      disclosure: "essential",
    });
    expect(TOOL_CAPABILITIES.send_feedback).toMatchObject({
      availability: { kind: "dev-only" },
      disclosure: "essential",
    });
    for (const name of ["get_feedback", "triage_feedback", "delete_feedback"]) {
      expect(TOOL_CAPABILITIES[name]).toMatchObject({
        availability: { kind: "dev-only" },
        disclosure: "eligible",
      });
    }
    expect(TOOL_CAPABILITIES.call_mcp_tool).toMatchObject({
      availability: { kind: "mcp-bridge" },
      definitionSource: "adapter-definition",
      executionRoute: "runtime-dispatch",
      telemetryOwner: "runtime",
    });
    expect(TOOL_CAPABILITIES.load_skill).toMatchObject({
      availability: { kind: "artifact-loader" },
      disclosure: "essential",
    });
    expect(TOOL_CAPABILITIES.get_code_actions).toMatchObject({
      availability: { kind: "benchmark-only" },
      disclosure: "eligible",
    });
    expect(TOOL_CAPABILITIES.show_notification).toMatchObject({
      availability: { kind: "dormant" },
      disclosure: "dormant",
    });
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
    expect(READ_ONLY_TOOLS.has("search_session_history")).toBe(true);
    expect(READ_ONLY_TOOLS.has("read_session_excerpt")).toBe(true);
    expect(READ_ONLY_TOOLS.has("diagnose_activity")).toBe(true);
    expect(READ_ONLY_TOOLS.has("web_search")).toBe(true);
    expect(READ_ONLY_TOOLS.has("web_fetch")).toBe(true);
  });

  it("includes commands but excludes write and terminal control tools", () => {
    expect(READ_ONLY_TOOLS.has("write_file")).toBe(false);
    expect(READ_ONLY_TOOLS.has("apply_diff")).toBe(false);
    expect(READ_ONLY_TOOLS.has("find_and_replace")).toBe(false);
    expect(READ_ONLY_TOOLS.has("execute_command")).toBe(true);
    expect(READ_ONLY_TOOLS.has("rename_symbol")).toBe(false);
    expect(READ_ONLY_TOOLS.has("switch_mode")).toBe(false);
    expect(READ_ONLY_TOOLS.has("set_task_status")).toBe(false);
  });

  it("only overlaps foreground background-result waits with terminal cleanup", () => {
    const runtime = createAgentToolRuntime(mockCtx);
    const canOverlap = runtime.canOverlapLaterCall;

    expect(canOverlap).toBeDefined();
    expect(
      canOverlap?.(
        "get_background_result",
        { sessionId: "bg-1" },
        "close_terminals",
        {},
      ),
    ).toBe(true);
    expect(
      canOverlap?.(
        "get_background_result",
        { sessionId: "bg-1" },
        "kill_background_agent",
        { sessionId: "bg-2" },
      ),
    ).toBe(false);
    expect(
      canOverlap?.(
        "get_background_result",
        { sessionId: "bg-1" },
        "read_file",
        {},
      ),
    ).toBe(false);
    expect(canOverlap?.("read_file", {}, "close_terminals", {})).toBe(false);

    const backgroundRuntime = createAgentToolRuntime({
      ...mockCtx,
      isBackgroundSession: true,
    });
    expect(
      backgroundRuntime.canOverlapLaterCall?.(
        "get_background_result",
        { sessionId: "bg-1" },
        "close_terminals",
        {},
      ),
    ).toBe(false);
  });

  it("uses per-tool MCP parallel safety for direct and deferred calls", () => {
    const isToolParallelSafe = vi.fn(
      (serverName: string, toolName: string) =>
        serverName === "parallel-server" || toolName === "annotated-read",
    );
    const runtime = createAgentToolRuntime({
      ...mockCtx,
      mcpHub: { isToolParallelSafe } as any,
    });

    expect(runtime.isParallelSafe("parallel-server__search", {})).toBe(true);
    expect(runtime.isParallelSafe("serial-server__search", {})).toBe(false);
    expect(runtime.isParallelSafe("serial-server__annotated-read", {})).toBe(
      true,
    );
    expect(
      runtime.isParallelSafe("call_mcp_tool", {
        server: "parallel-server",
        tool: "search",
        input: {},
      }),
    ).toBe(true);
    expect(
      runtime.isParallelSafe("call_mcp_tool", {
        server: "serial-server",
        tool: "annotated-read",
        input: {},
      }),
    ).toBe(true);
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

  it("defines present_images as an approval-free session image selector", () => {
    const tool = getAgentTools().find(
      (candidate) => candidate.name === "present_images",
    );
    expect(tool).toBeDefined();
    expect(tool?.description).toContain("main chat transcript");
    expect(tool?.input_schema.properties).toHaveProperty("image_ids");
    expect(tool?.input_schema.properties).toHaveProperty("use_recent_images");
    expect(tool?.input_schema.required).toBeUndefined();
    expect(TOOL_CAPABILITIES.present_images).toMatchObject({
      cluster: "media",
      sideEffect: "control",
      requiresApproval: "never",
      parallelSafe: false,
    });
  });

  it("reuses static native JSON schemas without caching MCP definitions", () => {
    const first = getAgentTools();
    const second = getAgentTools();

    expect(first.find((tool) => tool.name === "read_file")?.input_schema).toBe(
      second.find((tool) => tool.name === "read_file")?.input_schema,
    );
    expect(first.find((tool) => tool.name === "load_rule")?.input_schema).toBe(
      second.find((tool) => tool.name === "load_rule")?.input_schema,
    );

    const firstMcpSchema = {
      type: "object" as const,
      properties: { query: { type: "string" } },
      required: ["query"],
    };
    const secondMcpSchema = {
      type: "object" as const,
      properties: { query: { type: "string" }, limit: { type: "number" } },
      required: ["query"],
    };

    const firstMcp = getAgentTools(BUILT_IN_MODES[0], [
      {
        name: "demo__search",
        description: "Search demo",
        input_schema: firstMcpSchema,
      },
    ]).find((tool) => tool.name === "demo__search");
    const secondMcp = getAgentTools(BUILT_IN_MODES[0], [
      {
        name: "demo__search",
        description: "Search demo",
        input_schema: secondMcpSchema,
      },
    ]).find((tool) => tool.name === "demo__search");

    expect(firstMcp?.input_schema).toBe(firstMcpSchema);
    expect(secondMcp?.input_schema).toBe(secondMcpSchema);
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

  it("hides benchmark language tools by default and exposes them only through the explicit group", () => {
    const defaultNames = getAgentTools().map((tool) => tool.name);
    for (const name of BENCHMARK_LANGUAGE_TOOLS) {
      expect(defaultNames).not.toContain(name);
    }

    const benchmarkMode = {
      slug: "language-benchmark",
      name: "Language Benchmark",
      icon: "beaker",
      toolGroups: ["read", "language", "language-benchmark"],
    };
    const benchmarkNames = getAgentTools(benchmarkMode).map(
      (tool) => tool.name,
    );
    expect(benchmarkNames).toEqual(
      expect.arrayContaining([...BENCHMARK_LANGUAGE_TOOLS]),
    );
  });

  it("gates all registry dev-only tools by build type", () => {
    const devOnlyNames = Object.entries(TOOL_REGISTRY)
      .filter(([, metadata]) => metadata.devOnly)
      .map(([name]) => name);
    const names = getAgentTools().map((tool) => tool.name);

    for (const name of devOnlyNames) {
      expect(names.includes(name)).toBe(__DEV_BUILD__);
    }
  });

  it("keeps send_feedback available through restrictive profiles and skill allowlists", () => {
    const profileNames = getAgentTools(
      undefined,
      undefined,
      true,
      "review",
    ).map((tool) => tool.name);
    const skillNames = getAgentTools(undefined, undefined, false, undefined, [
      "read_file",
    ]).map((tool) => tool.name);

    expect(profileNames.includes("send_feedback")).toBe(__DEV_BUILD__);
    expect(skillNames.includes("send_feedback")).toBe(__DEV_BUILD__);
    expect(profileNames).not.toContain("get_feedback");
    expect(skillNames).not.toContain("get_feedback");
  });

  it("gates feedback tools by build type", () => {
    const tools = getAgentTools();
    const names = tools.map((tool) => tool.name);
    if (__DEV_BUILD__) {
      expect(names).toContain("send_feedback");
      expect(names).toContain("get_feedback");
      expect(names).toContain("triage_feedback");
      expect(names).toContain("delete_feedback");
      const sendFeedback = tools.find((tool) => tool.name === "send_feedback");
      const toolNameSchema = sendFeedback?.input_schema.properties
        ?.tool_name as { description?: string } | undefined;
      const getFeedback = tools.find((tool) => tool.name === "get_feedback");
      const triageFeedback = tools.find(
        (tool) => tool.name === "triage_feedback",
      );
      const deleteFeedback = tools.find(
        (tool) => tool.name === "delete_feedback",
      );
      expect(sendFeedback?.description).toContain(
        "report only problems with AgentLink's native MCP tools",
      );
      expect(sendFeedback?.description).toContain(
        "Never submit feedback about a specific MCP server or its native server__tool",
      );
      expect(toolNameSchema?.description).toContain(
        "use the native AgentLink MCP tool actually involved",
      );
      expect(toolNameSchema?.description).toContain(
        "Never report a specific MCP server or its server__tool",
      );
      expect(getFeedback?.description).toContain("stable ID");
      expect(getFeedback?.input_schema.properties).toHaveProperty("triaged");
      expect(getFeedback?.input_schema.properties).toHaveProperty("priorities");
      expect(triageFeedback?.description).toContain("P0-P3 priority");
      expect(triageFeedback?.input_schema.required).toEqual(
        expect.arrayContaining(["ids", "triaged"]),
      );
      expect(triageFeedback?.input_schema.properties).toHaveProperty(
        "priority",
      );
      expect(deleteFeedback?.description).toContain("stable ID");
      expect(deleteFeedback?.input_schema.required ?? []).not.toContain(
        "indices",
      );
      expect(deleteFeedback?.input_schema.properties).toHaveProperty("ids");
      expect(deleteFeedback?.input_schema.properties).toHaveProperty("indices");
    } else {
      expect(names).not.toContain("send_feedback");
      expect(names).not.toContain("get_feedback");
      expect(names).not.toContain("triage_feedback");
      expect(names).not.toContain("delete_feedback");
    }
  });

  it("advertises rule-aware native escalation only on full execute_command profiles", () => {
    const commandTools = BUILT_IN_MODES.flatMap((mode) => {
      const command = getAgentTools(mode).find(
        (tool) => tool.name === "execute_command",
      );
      return command ? [command] : [];
    });

    const fullCommandTools = commandTools.filter((command) =>
      Object.hasOwn(
        command.input_schema.properties ?? {},
        "sandbox_permissions",
      ),
    );
    expect(fullCommandTools.length).toBeGreaterThan(0);
    for (const command of fullCommandTools) {
      expect(
        command.input_schema.properties?.sandbox_permissions,
      ).toMatchObject({
        enum: [
          "use_default",
          "with_additional_permissions",
          "require_managed_network",
          "require_escalated",
        ],
      });
      expect(
        command.input_schema.properties?.additional_permissions,
      ).toBeDefined();
      expect(command.input_schema.properties).toHaveProperty("temporary_home");
      const temporaryHomeSchema = command.input_schema.properties
        ?.temporary_home as { description?: string } | undefined;
      const cwdSchema = command.input_schema.properties?.cwd as
        | { description?: string }
        | undefined;
      const sandboxPermissionsSchema = command.input_schema.properties
        ?.sandbox_permissions as { description?: string } | undefined;
      expect(temporaryHomeSchema?.description).toContain(
        "fresh writable per-command HOME",
      );
      expect(cwdSchema?.description).toContain("sandbox_cwd_outside_workspace");
      expect(sandboxPermissionsSchema?.description).toContain(
        "managed_network_ssh_git_transport",
      );
      expect(sandboxPermissionsSchema?.description).toContain(
        "managed_network_tls_trust",
      );
      expect(command.description).toContain(
        "default execution uses the native terminal",
      );
      expect(command.description).toContain("public destinations are mediated");
      expect(command.description).toContain("temporary_home=true");
      expect(command.description).toContain("allow_local_binding=true");
      expect(command.description).toContain(
        "every non-default intent requires authority from a matching native command rule or fresh approval",
      );
      expect(command.description).toContain("retry_guidance");
      expect(command.description).toContain("automatic_retry: false");
    }

    const readOnlyCommand = getAgentTools(
      undefined,
      undefined,
      true,
      "readonly-research",
    ).find((tool) => tool.name === "execute_command");
    expect(readOnlyCommand?.input_schema.properties).not.toHaveProperty(
      "sandbox_permissions",
    );
    expect(readOnlyCommand?.input_schema.properties).not.toHaveProperty(
      "temporary_home",
    );
    const readOnlyCwdSchema = readOnlyCommand?.input_schema.properties?.cwd as
      | { description?: string }
      | undefined;
    expect(readOnlyCwdSchema?.description).toContain(
      "sandbox_cwd_outside_workspace",
    );
  });

  it("keeps compose out of background, restrictive profile, and skill catalogs", () => {
    expect(
      getAgentTools(undefined, undefined, true).map((tool) => tool.name),
    ).not.toContain("compose");
    expect(
      getAgentTools(undefined, undefined, true, "readonly-research").map(
        (tool) => tool.name,
      ),
    ).not.toContain("compose");
    expect(
      getAgentTools(undefined, undefined, false, undefined, [
        "get_context",
      ]).map((tool) => tool.name),
    ).not.toContain("compose");
  });

  it("keeps composability metadata canonical and generates exact advertised child sets", () => {
    const benchmarkMode = {
      slug: "language-benchmark",
      name: "Language Benchmark",
      icon: "beaker",
      toolGroups: [
        "read",
        "edit",
        "command",
        "language",
        "language-benchmark",
        "search",
        "mcp",
      ],
    };
    const benchmarkTools = getAgentTools(benchmarkMode);
    const definitions = new Set(benchmarkTools.map((tool) => tool.name));
    for (const name of COMPOSABLE_TOOLS) {
      expect(TOOL_CAPABILITIES[name]).toMatchObject({
        composable: true,
        canonicalResult: true,
        sideEffect: "read",
        requiresApproval: "never",
      });
      expect(TOOL_REGISTRY[name]).toBeDefined();
      expect(definitions.has(name)).toBe(true);
    }
    expect(COMPOSABLE_TOOLS.has("compose")).toBe(false);
    expect(COMPOSABLE_TOOLS.has("read_file")).toBe(false);
    expect(COMPOSABLE_TOOLS.has("codebase_search")).toBe(false);

    const childNames = (tools: ToolDefinition[]): string[] => {
      const description = tools.find(
        (tool) => tool.name === "compose",
      )?.description;
      const match = description?.match(
        /Composable children in this advertised tool union: ([^.]+)\./,
      );
      return match?.[1]?.split(", ") ?? [];
    };
    const ordinaryChildren = [
      "get_call_hierarchy",
      "get_context",
      "get_diagnostics",
      "get_hover",
      "get_module_neighbors",
      "get_references",
      "get_repo_map",
      "get_symbols",
      "get_type_hierarchy",
      "go_to_definition",
      "go_to_implementation",
      "go_to_type_definition",
      "list_files",
      "search_files",
    ];
    expect(childNames(getAgentTools())).toEqual(ordinaryChildren);
    expect(childNames(benchmarkTools)).toEqual([
      "get_call_hierarchy",
      "get_code_actions",
      "get_completions",
      "get_context",
      "get_diagnostics",
      "get_hover",
      "get_inlay_hints",
      "get_module_neighbors",
      "get_references",
      "get_repo_map",
      "get_symbols",
      "get_type_hierarchy",
      "go_to_definition",
      "go_to_implementation",
      "go_to_type_definition",
      "list_files",
      "search_files",
    ]);
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
    expect(names).toContain("search_session_history");
    expect(names).toContain("read_session_excerpt");
    expect(names).toContain("diagnose_activity");
    expect(names).toContain("manage_memory");
    expect(names).toContain("recall_memory");
    expect(names).toContain("set_task_status");
  });

  it("applies the autonomous memory mode and background-profile matrix", () => {
    const byMode = new Map(
      BUILT_IN_MODES.map((mode) => [
        mode.slug,
        new Set(getAgentTools(mode).map((tool) => tool.name)),
      ]),
    );
    for (const mode of BUILT_IN_MODES) {
      expect(byMode.get(mode.slug)?.has("recall_memory"), mode.slug).toBe(true);
    }
    for (const mode of ["code", "architect", "debug"]) {
      expect(byMode.get(mode)?.has("manage_memory"), mode).toBe(true);
    }
    for (const mode of ["ask", "review"]) {
      expect(byMode.get(mode)?.has("manage_memory"), mode).toBe(false);
    }

    for (const profile of ["review", "readonly-research"]) {
      const names = getAgentTools(undefined, undefined, true, profile).map(
        (tool) => tool.name,
      );
      expect(names).toContain("recall_memory");
      expect(names).not.toContain("manage_memory");
    }
    expect(TOOL_CAPABILITIES.manage_memory).toMatchObject({
      cluster: "memory",
      sideEffect: "write",
      requiresApproval: "never",
    });
    expect(TOOL_CAPABILITIES.recall_memory).toMatchObject({
      cluster: "memory",
      sideEffect: "read",
      requiresApproval: "never",
      parallelSafe: true,
    });
  });

  it("exposes per-block occurrence and replace-all controls for apply_diff", () => {
    const tool = getAgentTools().find(
      (candidate) => candidate.name === "apply_diff",
    );
    const blockOptions = tool?.input_schema.properties?.block_options as
      | {
          type?: string;
          items?: { properties?: Record<string, unknown> };
        }
      | undefined;

    expect(tool?.input_schema.properties).toHaveProperty("atomic");
    expect(blockOptions?.type).toBe("array");
    expect(blockOptions?.items?.properties).toHaveProperty("index");
    expect(blockOptions?.items?.properties).toHaveProperty("occurrence");
    expect(blockOptions?.items?.properties).toHaveProperty("replace_all");
  });

  it("guides set_task_status continuations for concrete follow-up work", () => {
    const tool = getAgentTools().find((t) => t.name === "set_task_status");
    expect(tool?.description).toContain(
      "when the summary mentions a concrete next phase, MVP slice, remaining plan item, follow-up task, or validation step",
    );
    const properties = tool?.input_schema.properties as Record<
      string,
      { description?: string }
    >;
    expect(properties.continueLabel.description).toContain(
      "when the final summary names a concrete follow-up",
    );
    expect(properties.continuePrompt.description).toContain(
      "remaining work from the original plan",
    );
  });

  it("keeps final status and memory proposals available to background agents", () => {
    const tools = getAgentTools(undefined, undefined, true);
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(["set_task_status", "propose_memory"]),
    );
    expect(
      tools.find((tool) => tool.name === "set_task_status")?.input_schema
        .properties?.result,
    ).toBeDefined();
    expect(
      getAgentTools().find((tool) => tool.name === "set_task_status")
        ?.input_schema.properties?.result,
    ).toBeUndefined();
  });

  it("exposes the expected structured result on background final status", () => {
    const tool = getAgentTools(
      undefined,
      undefined,
      true,
      "review",
      undefined,
      undefined,
      "review_findings",
    ).find((candidate) => candidate.name === "set_task_status");
    expect(tool).toBeDefined();
    expect(tool?.description).toContain("instead of printing serialized JSON");
    expect(JSON.stringify(tool?.input_schema.properties?.result)).toContain(
      '"reviewedScope"',
    );
  });

  it("excludes final status from explicitly profile-restricted tool sets", () => {
    expect(
      getAgentTools(undefined, undefined, false, "review").map((t) => t.name),
    ).not.toContain("set_task_status");
  });

  it("allows session-scoped mode switching and recursive fleet controls in background sessions", () => {
    const names = getAgentTools(undefined, undefined, true).map((t) => t.name);
    expect(names).toContain("switch_mode");
    expect(names).toContain("spawn_background_agent");
    expect(names).toContain("get_background_status");
    expect(names).toContain("get_background_result");
    expect(names).toContain("kill_background_agent");
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
    expect(names).toContain("execute_command");
    expect(names).toContain("search_session_history");
    expect(names).toContain("read_session_excerpt");
    const executeCommand = reviewTools.find(
      (tool) => tool.name === "execute_command",
    );
    expect(executeCommand?.description).toContain(
      "recognized read-only command",
    );
    expect(executeCommand?.description).toContain(
      "rg --no-config <pattern> [path ...]",
    );
    expect(executeCommand?.description).toContain(
      "git diff --no-ext-diff --no-textconv",
    );
    expect(executeCommand?.description).toContain(
      "git log --no-ext-diff --no-textconv",
    );
    expect(executeCommand?.description).toContain("git blame --no-textconv");
    expect(executeCommand?.description).toContain(
      "do not add routine `--no-pager`",
    );
    expect(executeCommand?.input_schema.properties).toHaveProperty("command");
    expect(executeCommand?.input_schema.properties).not.toHaveProperty(
      "background",
    );
    expect(executeCommand?.input_schema.properties).not.toHaveProperty("env");
    // Should include MCP discovery/call tools and directly exposed ddg tools.
    expect(names).toContain("find_mcp_tools");
    expect(names).toContain("call_mcp_tool");
    expect(names).toContain("ddg-search__search");
    expect(names).toContain("ddg-search__fetch_content");

    // Should NOT include write tools or foreground-only helpers.
    expect(names).not.toContain("write_file");
    expect(names).not.toContain("apply_diff");
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
    expect(names).not.toContain("get_inlay_hints");
    expect(names).not.toContain("get_completions");
    expect(names).not.toContain("get_code_actions");
    expect(names).not.toContain("apply_code_action");
    expect(names).toContain("find_mcp_tools");
    expect(names).toContain("call_mcp_tool");
    expect(names).toContain("ddg-search__search");
    expect(names).toContain("ddg-search__fetch_content");
    expect(names).toContain("execute_command");
    expect(names).toContain("search_session_history");
    expect(names).toContain("read_session_excerpt");

    const executeCommand = tools.find(
      (tool) => tool.name === "execute_command",
    );
    expect(executeCommand?.description).toContain(
      "recognized read-only command",
    );
    expect(executeCommand?.description).toContain(
      "rg --no-config <pattern> [path ...]",
    );
    expect(executeCommand?.description).toContain(
      "git diff --no-ext-diff --no-textconv",
    );
    expect(executeCommand?.description).toContain(
      "git log --no-ext-diff --no-textconv",
    );
    expect(executeCommand?.description).toContain("git blame --no-textconv");
    expect(executeCommand?.description).toContain(
      "do not add routine `--no-pager`",
    );
    expect(executeCommand?.input_schema.properties).toHaveProperty("command");
    expect(executeCommand?.input_schema.properties).toHaveProperty("cwd");
    expect(executeCommand?.input_schema.properties).toHaveProperty(
      "output_grep",
    );
    for (const forbidden of [
      "terminal_id",
      "terminal_name",
      "split_from",
      "background",
      "timeout",
      "env",
      "files",
      "force",
      "force_reason",
    ]) {
      expect(executeCommand?.input_schema.properties).not.toHaveProperty(
        forbidden,
      );
    }

    expect(names).not.toContain("write_file");
    expect(names).not.toContain("apply_diff");
    expect(names).not.toContain("rename_symbol");
    expect(names).not.toContain("apply_code_action");
    expect(names).not.toContain("ask_user");
    expect(names).not.toContain("spawn_background_agent");
  });

  it("exposes the restricted command schema in ask mode and the full schema in code mode", () => {
    const askCommand = getAgentTools(BUILT_IN_MODES[2]).find(
      (tool) => tool.name === "execute_command",
    );
    const codeCommand = getAgentTools(BUILT_IN_MODES[0]).find(
      (tool) => tool.name === "execute_command",
    );

    expect(askCommand?.input_schema.properties).not.toHaveProperty(
      "background",
    );
    expect(askCommand?.input_schema.properties).not.toHaveProperty("env");
    expect(askCommand?.input_schema.properties).not.toHaveProperty(
      "temporary_home",
    );
    expect(codeCommand?.input_schema.properties).toHaveProperty("background");
    expect(codeCommand?.input_schema.properties).toHaveProperty("env");
    expect(codeCommand?.input_schema.properties).toHaveProperty(
      "temporary_home",
    );
  });

  it("uses the restricted command schema for custom modes with the read-only command capability", () => {
    const customMode = {
      slug: "research-custom",
      name: "Research Custom",
      icon: "search",
      toolGroups: ["read", "read-only-command"],
    };
    const command = getAgentTools(customMode).find(
      (tool) => tool.name === "execute_command",
    );

    expect(command).toBeDefined();
    expect(command?.input_schema.properties).not.toHaveProperty("background");
    expect(command?.input_schema.properties).not.toHaveProperty("env");
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
    expect(names).toContain("search_session_history");
    expect(names).toContain("read_session_excerpt");

    expect(names).not.toContain("write_file");
    expect(names).not.toContain("apply_diff");
    expect(names).not.toContain("execute_command");
    expect(names).not.toContain("ask_user");
    expect(names).not.toContain("find_mcp_tools");
    expect(names).not.toContain("call_mcp_tool");
    expect(names).not.toContain("ddg-search__search");
    expect(names).not.toContain("ddg-search__fetch_content");
  });

  it("gives worktree setup read-only inspection without write tools", () => {
    const tools = getAgentTools(
      BUILT_IN_MODES[2],
      ddgMcpTools,
      true,
      "worktree-setup",
    );
    const names = tools.map((tool) => tool.name);

    expect(names).toContain("read_file");
    expect(names).toContain("execute_command");
    expect(names).not.toContain("ask_user");
    expect(names).not.toContain("write_file");
    expect(names).not.toContain("start_worktree_agent");
    expect(names).not.toContain("spawn_background_agent");
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
  it("enforces delegated owned and forbidden paths before writes", async () => {
    const onDecision = vi.fn();
    const runtime = createAgentToolRuntime({
      ...mockCtx,
      delegationPolicy: {
        ownedPaths: ["src/agent"],
        forbiddenPaths: ["src/agent/secrets"],
        onDecision,
      },
    });
    await expect(
      runtime.executeTool({
        name: "write_file",
        input: { path: "src/sidebar/out.ts", content: "no" },
        context: { sessionId: "test-session", mode: "code" },
      }),
    ).rejects.toThrow(/outside owned paths/);
    await expect(
      runtime.executeTool({
        name: "write_file",
        input: { path: "src/agent/secrets/key.ts", content: "no" },
        context: { sessionId: "test-session", mode: "code" },
      }),
    ).rejects.toThrow(/forbidden path/);
    expect(onDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: "denied",
        reason: "outside_owned_paths",
      }),
    );
    expect(onDecision).toHaveBeenCalledWith(
      expect.objectContaining({ decision: "denied", reason: "forbidden_path" }),
    );
  });

  it("matches absolute delegated paths against relative scopes across workspace roots", async () => {
    const onDecision = vi.fn();
    const runtime = createAgentToolRuntime({
      ...mockCtx,
      projectRoot: "/tmp/project-a",
      workspaceProjectRoots: ["/tmp/project-a", "/tmp/project-b"],
      delegationPolicy: {
        ownedPaths: ["src/agent"],
        forbiddenPaths: ["src/agent/secrets"],
        onDecision,
      },
    });

    await expect(
      runtime.executeTool({
        name: "write_file",
        input: {
          path: "/tmp/project-b/src/agent/allowed.ts",
          content: "allowed",
        },
        context: { sessionId: "test-session", mode: "code" },
      }),
    ).resolves.toBeDefined();
    await expect(
      runtime.executeTool({
        name: "write_file",
        input: {
          path: "/tmp/project-b/src/agent/secrets/key.ts",
          content: "denied",
        },
        context: { sessionId: "test-session", mode: "code" },
      }),
    ).rejects.toThrow(/forbidden path/);

    expect(onDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: "allowed",
        path: expect.stringMatching(/\/project-b\/src\/agent\/allowed\.ts$/),
      }),
    );
    expect(onDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: "denied",
        reason: "forbidden_path",
        path: expect.stringMatching(
          /\/project-b\/src\/agent\/secrets\/key\.ts$/,
        ),
      }),
    );
  });

  it("canonicalizes relative forbidden scopes through symlinked directories", async () => {
    const projectRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "delegated-symlink-root-"),
    );
    try {
      const realSecrets = path.join(projectRoot, "real-secrets");
      const delegatedRoot = path.join(projectRoot, "src", "agent");
      fs.mkdirSync(realSecrets, { recursive: true });
      fs.mkdirSync(delegatedRoot, { recursive: true });
      fs.symlinkSync(realSecrets, path.join(delegatedRoot, "secrets"));
      const runtime = createAgentToolRuntime({
        ...mockCtx,
        projectRoot,
        workspaceProjectRoots: [projectRoot],
        delegationPolicy: {
          ownedPaths: ["src/agent"],
          forbiddenPaths: ["src/agent/secrets"],
        },
      });

      await expect(
        runtime.executeTool({
          name: "write_file",
          input: {
            path: path.join(delegatedRoot, "secrets", "key.ts"),
            content: "denied",
          },
          context: { sessionId: "test-session", mode: "code" },
        }),
      ).rejects.toThrow(/forbidden path/);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("denies and audits delegated writes outside workspace roots", async () => {
    const onDecision = vi.fn();
    const runtime = createAgentToolRuntime({
      ...mockCtx,
      projectRoot: "/tmp/project-a",
      workspaceProjectRoots: ["/tmp/project-a", "/tmp/project-b"],
      approvalManager: {
        ...mockCtx.approvalManager,
        isPathTrusted: vi.fn(() => false),
        getFileWriteAuthorization: vi.fn(() => ({
          allowed: false,
          basis: "none" as const,
        })),
      } as unknown as ToolDispatchContext["approvalManager"],
      delegationPolicy: {
        forbiddenPaths: ["blocked"],
        onDecision,
      },
    });

    await expect(
      runtime.executeTool({
        name: "write_file",
        input: { path: "/tmp/outside/file.ts", content: "denied" },
        context: { sessionId: "test-session", mode: "code" },
      }),
    ).rejects.toThrow(/outside workspace roots/);
    expect(onDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: "denied",
        reason: "outside_workspace_roots",
      }),
    );
  });

  it("allows delegated outside-workspace writes with matching inherited path and write authority", async () => {
    const onDecision = vi.fn();
    const outsideFile = path.join(
      fs.realpathSync("/tmp"),
      "outside",
      "file.ts",
    );
    const runtime = createAgentToolRuntime({
      ...mockCtx,
      projectRoot: "/tmp/project-a",
      workspaceProjectRoots: ["/tmp/project-a"],
      approvalManager: {
        ...mockCtx.approvalManager,
        isPathTrusted: vi.fn(
          (sessionId, filePath) =>
            sessionId === "background-session" && filePath === outsideFile,
        ),
        getFileWriteAuthorization: vi.fn((sessionId, filePath) =>
          sessionId === "background-session" && filePath === outsideFile
            ? {
                allowed: true,
                basis: "write_rule" as const,
                scope: "session" as const,
                rule: {
                  pattern: outsideFile,
                  mode: "exact" as const,
                },
              }
            : { allowed: false, basis: "none" as const },
        ),
      } as unknown as ToolDispatchContext["approvalManager"],
      sessionId: "background-session",
      delegationPolicy: {
        onDecision,
      },
    });

    await expect(
      runtime.executeTool({
        name: "write_file",
        input: { path: outsideFile, content: "allowed" },
        context: { sessionId: "background-session", mode: "code" },
      }),
    ).resolves.toBeDefined();
    expect(onDecision).toHaveBeenCalledWith({
      decision: "allowed",
      operation: "write_file",
      reason: "matching_outside_workspace_authority",
      path: outsideFile,
    });
  });

  it("keeps delegated outside-workspace writes denied when only read authority matches", async () => {
    const onDecision = vi.fn();
    const runtime = createAgentToolRuntime({
      ...mockCtx,
      projectRoot: "/tmp/project-a",
      workspaceProjectRoots: ["/tmp/project-a"],
      approvalManager: {
        ...mockCtx.approvalManager,
        isPathTrusted: vi.fn(() => true),
        getFileWriteAuthorization: vi.fn(() => ({
          allowed: false,
          basis: "none" as const,
        })),
      } as unknown as ToolDispatchContext["approvalManager"],
      sessionId: "background-session",
      delegationPolicy: {
        onDecision,
      },
    });

    await expect(
      runtime.executeTool({
        name: "write_file",
        input: { path: "/tmp/outside/file.ts", content: "denied" },
        context: { sessionId: "background-session", mode: "code" },
      }),
    ).rejects.toThrow(/outside workspace roots/);
    expect(onDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: "denied",
        reason: "outside_workspace_roots",
      }),
    );
  });

  it("still enforces owned paths for approved outside-workspace writes", async () => {
    const outsideFile = path.join(
      fs.realpathSync("/tmp"),
      "outside",
      "file.ts",
    );
    const runtime = createAgentToolRuntime({
      ...mockCtx,
      projectRoot: "/tmp/project-a",
      workspaceProjectRoots: ["/tmp/project-a"],
      approvalManager: {
        ...mockCtx.approvalManager,
        isPathTrusted: vi.fn(() => true),
        getFileWriteAuthorization: vi.fn(() => ({
          allowed: true,
          basis: "write_rule" as const,
          scope: "session" as const,
          rule: { pattern: outsideFile, mode: "exact" as const },
        })),
      } as unknown as ToolDispatchContext["approvalManager"],
      sessionId: "background-session",
      delegationPolicy: {
        ownedPaths: ["src"],
      },
    });

    await expect(
      runtime.executeTool({
        name: "write_file",
        input: { path: outsideFile, content: "denied" },
        context: { sessionId: "background-session", mode: "code" },
      }),
    ).rejects.toThrow(/outside owned paths/);
  });

  it("schema includes routing, delegation, and budget params", () => {
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
    expect(props.ownedPaths).toBeDefined();
    expect(props.forbiddenPaths).toBeDefined();
    expect(props.permissionProfile).toBeDefined();
    expect(props.imageIds).toBeDefined();
    expect(props.useRecentImages).toBeDefined();
    expect(props.reviewScope).toBeDefined();
    expect(props.budget).toBeDefined();
    expect(props.timeoutSeconds).toBeUndefined();
    expect(props.tokenBudget).toBeUndefined();
  });

  it("copies selected and recent foreground images into the spawn request", async () => {
    const onSpawnBackground = vi.fn().mockResolvedValue({
      sessionId: "bg-images",
      resolvedMode: "review",
      resolvedModel: "claude-sonnet-4-6",
      resolvedProvider: "anthropic",
      taskClass: "review_code",
      routingReason: "test",
      fallbackUsed: false,
    });
    const sessionImages = [
      {
        id: "image_1",
        name: "user-reference.png",
        mimeType: "image/png",
        base64: "first",
        messageIndex: 0,
        imageIndex: 0,
      },
      {
        id: "image_2",
        name: "captured-ui.png",
        mimeType: "image/png",
        base64: "second",
        messageIndex: 4,
        imageIndex: 0,
      },
    ];

    const result = await dispatchToolCall(
      "spawn_background_agent",
      {
        task: "Review UI",
        message: "Compare the supplied reference and current UI",
        imageIds: ["image_1"],
        useRecentImages: 1,
      },
      {
        ...mockCtx,
        onSpawnBackground,
        getSessionImages: () => sessionImages,
      },
    );

    expect(onSpawnBackground).toHaveBeenCalledWith(
      "test-session",
      expect.objectContaining({
        images: [
          {
            name: "user-reference.png",
            mimeType: "image/png",
            base64: "first",
          },
          {
            name: "captured-ui.png",
            mimeType: "image/png",
            base64: "second",
          },
        ],
      }),
      undefined,
    );

    // The result must echo which images were attached so the coordinator can
    // detect a drifted image_N mapping.
    const payload = JSON.parse(
      (result.content[0] as { type: "text"; text: string }).text,
    );
    expect(payload.attachedImages).toEqual([
      { id: "image_1", name: "user-reference.png", mimeType: "image/png" },
      { id: "image_2", name: "captured-ui.png", mimeType: "image/png" },
    ]);
  });

  it("dispatches present_images with images from the current session", async () => {
    const result = await dispatchToolCall(
      "present_images",
      { use_recent_images: 1 },
      {
        ...mockCtx,
        getSessionImages: () => [
          {
            id: "image_1",
            name: "screenshot.png",
            mimeType: "image/png",
            base64: "screenshot-data",
            messageIndex: 2,
            imageIndex: 0,
          },
        ],
      },
    );

    expect(result.content).toEqual([
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining('"status":"presented"'),
      }),
      {
        type: "image",
        data: "screenshot-data",
        mimeType: "image/png",
      },
    ]);
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
        ownedPaths: ["src/agent"],
        forbiddenPaths: ["src/server"],
        permissionProfile: "workspace-safe",
        reviewScope: {
          kind: "working_tree",
          include: ["unstaged", "untracked"],
          paths: ["src/agent"],
        },
        expectedResult: "patch",
        budget: { maxTokens: 20_000, maxToolCalls: 50 },
      },
      { ...mockCtx, onSpawnBackground },
    );

    expect(onSpawnBackground).toHaveBeenCalledWith(
      "test-session",
      {
        task: "Review patch",
        message: "Review the recent changes",
        mode: "review",
        model: "claude-sonnet-4-6",
        provider: "anthropic",
        taskClass: "review_code",
        modelTier: "deep_reasoning",
        ownedPaths: ["src/agent"],
        forbiddenPaths: ["src/server"],
        permissionProfile: "workspace-safe",
        worktree: undefined,
        reviewScope: {
          kind: "working_tree",
          include: ["unstaged", "untracked"],
          paths: ["src/agent"],
        },
        expectedResult: "patch",
        budget: {
          maxTokens: 20_000,
          maxToolCalls: 50,
          maxApiTurns: undefined,
          maxElapsedMs: undefined,
          maxEstimatedCostUsd: undefined,
          estimatedCostPerMillionTokens: undefined,
          warningThresholdRatio: undefined,
          scope: "session",
        },
        goalId: undefined,
      },
      undefined,
    );

    const text = (result.content[0] as { type: string; text: string }).text;
    expect(JSON.parse(text)).toMatchObject({
      sessionId: "bg-123",
      resolvedMode: "review",
      taskClass: "review_code",
      fallbackUsed: false,
    });
  });

  it("forwards exact skill authority outside the model-controlled spawn request", async () => {
    const onSpawnBackground = vi.fn().mockResolvedValue({
      sessionId: "bg-authority",
      resolvedMode: "review",
      resolvedModel: "model",
      resolvedProvider: "provider",
      taskClass: "general",
      routingReason: "test",
      fallbackUsed: false,
    });
    const skillAuthority = {
      schemaVersion: 1 as const,
      sources: [
        {
          catalogRevision: "catalog-revision",
          activations: [
            {
              id: "project:agentlink:.agentlink/skills/review",
              name: "review",
              revision: "skill-revision",
            },
          ],
          policyRevision: "policy-revision",
        },
      ],
      allowedTools: ["read_file"],
    };

    await dispatchToolCall(
      "spawn_background_agent",
      { task: "Child", message: "Inspect" },
      { ...mockCtx, onSpawnBackground, skillAuthority },
    );

    expect(onSpawnBackground).toHaveBeenCalledWith(
      "test-session",
      expect.not.objectContaining({ skillAuthority: expect.anything() }),
      skillAuthority,
    );
  });

  it("prefers backgroundAgentProvider over legacy spawn callback", async () => {
    const onSpawnBackground = vi.fn();
    const backgroundAgentProvider = {
      spawn: vi.fn().mockResolvedValue({
        sessionId: "bg-provider",
        resolvedMode: "code",
        resolvedModel: "model",
        resolvedProvider: "provider",
        taskClass: "general",
        routingReason: "provider",
        fallbackUsed: false,
      }),
      getStatus: vi.fn(),
      getResult: vi.fn(),
      kill: vi.fn(),
    };

    const result = await dispatchToolCall(
      "spawn_background_agent",
      { task: "Provider task", message: "Provider message" },
      { ...mockCtx, onSpawnBackground, backgroundAgentProvider },
    );

    expect(backgroundAgentProvider.spawn).toHaveBeenCalledWith({
      task: "Provider task",
      message: "Provider message",
      mode: undefined,
      model: undefined,
      provider: undefined,
      taskClass: undefined,
      modelTier: undefined,
      ownedPaths: undefined,
      forbiddenPaths: undefined,
      permissionProfile: undefined,
      worktree: undefined,
      reviewScope: undefined,
      expectedResult: undefined,
      budget: undefined,
      goalId: undefined,
    });
    expect(onSpawnBackground).not.toHaveBeenCalled();
    const text = (result.content[0] as { type: string; text: string }).text;
    expect(JSON.parse(text)).toMatchObject({ sessionId: "bg-provider" });
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

  it("dispatches descendant steering and detachment controls", async () => {
    const onSteerBackground = vi.fn(() => ({ accepted: true }));
    const onDetachBackground = vi.fn(() => ({ detached: true }));
    await dispatchToolCall(
      "steer_background_agent",
      { sessionId: "bg-child", message: "change direction" },
      { ...mockCtx, onSteerBackground },
    );
    await dispatchToolCall(
      "detach_background_agent",
      { sessionId: "bg-child" },
      { ...mockCtx, onDetachBackground },
    );
    expect(onSteerBackground).toHaveBeenCalledWith(
      "test-session",
      "bg-child",
      "change direction",
    );
    expect(onDetachBackground).toHaveBeenCalledWith("test-session", "bg-child");
  });

  it("exposes background question responses only to foreground agents", () => {
    const foregroundTool = getAgentTools().find(
      (tool) => tool.name === "respond_to_background_question",
    );
    const backgroundNames = getAgentTools(undefined, undefined, true).map(
      (tool) => tool.name,
    );

    expect(foregroundTool).toBeDefined();
    expect(foregroundTool?.description).toContain("call ask_user first");
    expect(foregroundTool?.input_schema.required).toEqual([
      "request_id",
      "answers",
    ]);
    expect(backgroundNames).not.toContain("respond_to_background_question");
  });

  it("forwards a complete background question response request", async () => {
    const onRespondToBackgroundQuestion = vi.fn(() => ({ accepted: true }));
    const result = await dispatchToolCall(
      "respond_to_background_question",
      {
        request_id: "question-123",
        answers: {
          path: "src/example.test.ts",
          confirmed: true,
          targets: ["unit", "integration"],
        },
        notes: { path: "Matches the delegated ownership boundary." },
      },
      { ...mockCtx, onRespondToBackgroundQuestion },
    );

    expect(onRespondToBackgroundQuestion).toHaveBeenCalledWith({
      callerSessionId: "test-session",
      requestId: "question-123",
      answers: {
        path: "src/example.test.ts",
        confirmed: true,
        targets: ["unit", "integration"],
      },
      notes: { path: "Matches the delegated ownership boundary." },
    });
    expect(result.isError).toBe(false);
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual({
      accepted: true,
    });
  });

  it("dispatches get_background_status to onGetBackgroundStatus callback", async () => {
    const onGetBackgroundStatus = vi.fn().mockReturnValue({
      status: "streaming",
      currentTool: "read_file",
      done: false,
      displayStatus: "Reading code",
      streamingPreview: "inspecting tests",
      progressSummary: "Reading code",
      resultState: "running",
      taskClass: "readonly-research",
      toolCalls: 1,
      tokenUsage: 100,
      apiTurns: 2,
      phase: "waiting_for_provider",
      elapsedMs: 12_000,
      idleMs: 3_000,
      canSteer: true,
      canKill: true,
    });

    const result = await dispatchToolCall(
      "get_background_status",
      { sessionId: "bg-456" },
      { ...mockCtx, onGetBackgroundStatus },
    );

    expect(onGetBackgroundStatus).toHaveBeenCalledWith(
      "test-session",
      "bg-456",
    );
    const text = (result.content[0] as { type: string; text: string }).text;
    expect(JSON.parse(text)).toMatchObject({
      status: "streaming",
      currentTool: "read_file",
      done: false,
      streamingPreview: "inspecting tests",
      resultState: "running",
      taskClass: "readonly-research",
      toolCalls: 1,
      tokenUsage: 100,
      apiTurns: 2,
      phase: "waiting_for_provider",
      elapsedMs: 12_000,
      idleMs: 3_000,
      canSteer: true,
      canKill: true,
    });
  });

  it("dispatches get_background_result through backgroundAgentProvider", async () => {
    const backgroundAgentProvider = {
      spawn: vi.fn(),
      getStatus: vi.fn(),
      getResult: vi.fn().mockResolvedValue("done output"),
      kill: vi.fn(),
    };

    const result = await dispatchToolCall(
      "get_background_result",
      { sessionId: "bg-789" },
      { ...mockCtx, backgroundAgentProvider },
    );

    expect(backgroundAgentProvider.getResult).toHaveBeenCalledWith("bg-789");
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: "done output",
    });
  });

  it("returns background images as tool result content", async () => {
    const onGetBackgroundResult = vi.fn().mockResolvedValue({
      text: "Generated two images",
      images: [
        { data: "YWJjZA==", mimeType: "image/png" },
        { data: "RUZH", mimeType: "image/webp" },
      ],
    });

    const result = await dispatchToolCall(
      "get_background_result",
      { sessionId: "bg-images" },
      { ...mockCtx, onGetBackgroundResult },
    );

    expect(onGetBackgroundResult).toHaveBeenCalledWith(
      "test-session",
      "bg-images",
    );
    expect(result.content).toEqual([
      { type: "text", text: "Generated two images" },
      { type: "image", data: "YWJjZA==", mimeType: "image/png" },
      { type: "image", data: "RUZH", mimeType: "image/webp" },
    ]);
  });

  it("preserves structured background terminal failure payloads", async () => {
    const failure = JSON.stringify({
      status: "failed",
      terminalReason: "provider disconnected",
      retrySafe: true,
      agentRetryable: true,
      partialOutput: "partial findings",
    });
    const backgroundAgentProvider = {
      spawn: vi.fn(),
      getStatus: vi.fn(),
      getResult: vi.fn().mockResolvedValue(failure),
      kill: vi.fn(),
    };

    const result = await dispatchToolCall(
      "get_background_result",
      { sessionId: "bg-failed" },
      { ...mockCtx, backgroundAgentProvider },
    );

    expect(result.content[0]).toEqual({ type: "text", text: failure });
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

    expect(onKillBackground).toHaveBeenCalledWith(
      "test-session",
      "bg-456",
      "taking too long",
    );
    const text = (result.content[0] as { type: string; text: string }).text;
    expect(JSON.parse(text)).toMatchObject({
      killed: true,
      partialOutput: "some partial work",
    });
  });
});

describe("dispatchToolCall", () => {
  it("forwards complete feedback read filters", async () => {
    feedbackToolMocks.handleGetFeedback.mockClear();

    await dispatchToolCall(
      "get_feedback",
      {
        tool_name: "execute_command",
        triaged: true,
        priorities: ["P0", "P2"],
      },
      mockCtx,
    );

    expect(feedbackToolMocks.handleGetFeedback).toHaveBeenCalledWith({
      tool_name: "execute_command",
      triaged: true,
      priorities: ["P0", "P2"],
    });
  });

  it("rejects invalid feedback priority filters", async () => {
    feedbackToolMocks.handleGetFeedback.mockClear();

    const result = await dispatchToolCall(
      "get_feedback",
      { priorities: ["P0", "invalid"] },
      mockCtx,
    );

    expect(result.isError).toBe(true);
    expect(feedbackToolMocks.handleGetFeedback).not.toHaveBeenCalled();
  });

  it("forwards complete feedback triage requests", async () => {
    feedbackToolMocks.handleTriageFeedback.mockClear();

    await dispatchToolCall(
      "triage_feedback",
      {
        ids: ["feedback-id", 7, null],
        triaged: true,
        priority: "P1",
      },
      mockCtx,
    );

    expect(feedbackToolMocks.handleTriageFeedback).toHaveBeenCalledWith({
      ids: ["feedback-id"],
      triaged: true,
      priority: "P1",
    });
  });

  it("forwards untriage requests without a priority", async () => {
    feedbackToolMocks.handleTriageFeedback.mockClear();

    await dispatchToolCall(
      "triage_feedback",
      { ids: ["feedback-id"], triaged: false },
      mockCtx,
    );

    expect(feedbackToolMocks.handleTriageFeedback).toHaveBeenCalledWith({
      ids: ["feedback-id"],
      triaged: false,
      priority: undefined,
    });
  });

  it("rejects triage requests without a boolean state", async () => {
    feedbackToolMocks.handleTriageFeedback.mockClear();

    const result = await dispatchToolCall(
      "triage_feedback",
      { ids: ["feedback-id"], priority: "P1" },
      mockCtx,
    );

    expect(result.isError).toBe(true);
    expect(feedbackToolMocks.handleTriageFeedback).not.toHaveBeenCalled();
  });

  it("forwards feedback IDs and strict numeric global indices", async () => {
    feedbackToolMocks.handleDeleteFeedback.mockClear();

    await dispatchToolCall(
      "delete_feedback",
      { ids: ["feedback-id"], indices: [7, "8", null] },
      mockCtx,
    );

    expect(feedbackToolMocks.handleDeleteFeedback).toHaveBeenCalledWith({
      ids: ["feedback-id"],
      indices: [7],
    });
  });
  it("forwards autonomous memory requests through the production context seam without approval", async () => {
    const onApprovalRequest = vi.fn();
    const manage = vi.fn<MemoryToolProvider["manage"]>().mockResolvedValue({
      result: {
        disposition: "created",
        relatedRecords: [],
        auditEventId: "audit-distinctive",
      },
      health: {
        status: "ready",
        retrieval: "lexical-only",
        crud: true,
        dedupe: true,
        conflict: true,
        auditUndo: true,
        recordCount: 1,
        activeRecordCount: 1,
        auditEventCount: 1,
      },
    });
    const recall = vi.fn<MemoryToolProvider["recall"]>().mockResolvedValue({
      result: { memories: [], mode: "lexical-only" },
      health: {
        status: "ready",
        retrieval: "lexical-only",
        crud: true,
        dedupe: true,
        conflict: true,
        auditUndo: true,
        recordCount: 1,
        activeRecordCount: 1,
        auditEventCount: 1,
      },
    });
    const memoryToolProvider: MemoryToolProvider = { manage, recall };
    const context: ToolDispatchContext = {
      ...mockCtx,
      sessionId: "session-distinctive",
      onApprovalRequest,
      isBackgroundSession: true,
      memoryToolProvider,
      projectScope: {
        schemaVersion: 1,
        kind: "project",
        projectId: "project-distinctive",
        workspaceFolderUri: "file:///workspace/distinctive",
        displayName: "Distinctive Project",
      },
    };

    const before = Date.now();
    await dispatchToolCall(
      "manage_memory",
      {
        operation: "remember",
        scope: "project",
        source_evidence: "Distinctive repository evidence",
        kind: "project_fact",
        statement: "The distinctive project uses npm.",
      },
      context,
    );
    const after = Date.now();

    expect(manage).toHaveBeenCalledOnce();
    expect(manage).toHaveBeenCalledWith({
      input: {
        operation: "remember",
        scope: "project",
        source_evidence: "Distinctive repository evidence",
        kind: "project_fact",
        statement: "The distinctive project uses npm.",
      },
      context: {
        sessionId: "session-distinctive",
        projectId: "project-distinctive",
        isBackground: true,
        observedAt: expect.any(String),
      },
    });
    const observedAt = Date.parse(manage.mock.calls[0]![0].context.observedAt);
    expect(observedAt).toBeGreaterThanOrEqual(before);
    expect(observedAt).toBeLessThanOrEqual(after);
    expect(onApprovalRequest).not.toHaveBeenCalled();
  });

  it("pins concurrent tool runtimes to their captured project roots", async () => {
    const { handleWriteFile } = await import("../tools/writeFile.js");
    vi.mocked(handleWriteFile).mockImplementationOnce(async (params) => {
      await Promise.resolve();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              roots: getWorkspaceRoots(),
              resolved: resolveAndValidatePath(params.path),
            }),
          },
        ],
      };
    });
    vi.mocked(handleWriteFile).mockImplementationOnce(async (params) => {
      await Promise.resolve();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              roots: getWorkspaceRoots(),
              resolved: resolveAndValidatePath(params.path),
            }),
          },
        ],
      };
    });

    const runtimeA = createAgentToolRuntime({
      ...mockCtx,
      projectRoot: "/workspace/project-a",
    });
    const runtimeB = createAgentToolRuntime({
      ...mockCtx,
      projectRoot: "/workspace/project-b",
    });
    const [resultA, resultB] = await Promise.all([
      runtimeA.executeTool({
        name: "write_file",
        input: { path: "src/index.ts", content: "A" },
        context: { sessionId: "session-a", mode: "code" },
      }),
      runtimeB.executeTool({
        name: "write_file",
        input: { path: "src/index.ts", content: "B" },
        context: { sessionId: "session-b", mode: "code" },
      }),
    ]);
    const parse = (result: ToolResult) =>
      JSON.parse((result.content[0] as { text: string }).text);

    expect(parse(resultA)).toEqual({
      roots: ["/workspace/project-a"],
      resolved: {
        absolutePath: "/workspace/project-a/src/index.ts",
        inWorkspace: true,
      },
    });
    expect(parse(resultB)).toEqual({
      roots: ["/workspace/project-b"],
      resolved: {
        absolutePath: "/workspace/project-b/src/index.ts",
        inWorkspace: true,
      },
    });
  });

  it("dispatches sibling-root mutations with workspace-wide checkpoint preparation", async () => {
    const { handleWriteFile } = await import("../tools/writeFile.js");
    const { handleGenerateImage } = await import("../tools/generateImage.js");
    const { handleExecuteCommand } = await import("../tools/executeCommand.js");
    vi.mocked(handleWriteFile).mockClear();
    vi.mocked(handleGenerateImage).mockClear();
    vi.mocked(handleExecuteCommand).mockClear();
    const prepareWorkspaceMutation = vi.fn().mockResolvedValue(undefined);
    const runtime = createAgentToolRuntime({
      ...mockCtx,
      projectRoot: "/workspace/project-a",
      workspaceProjectRoots: ["/workspace/project-a", "/workspace/project-b"],
      prepareWorkspaceMutation,
    });

    await runtime.executeTool({
      name: "write_file",
      input: {
        path: "/workspace/project-b/src/index.ts",
        content: "allowed",
      },
      context: { sessionId: "session-a", mode: "code" },
    });
    await runtime.executeTool({
      name: "generate_image",
      input: {
        prompt: "Generate a test image",
        output_path: "/workspace/project-b/media/output.png",
      },
      context: { sessionId: "session-a", mode: "code" },
    });
    await runtime.executeTool({
      name: "execute_command",
      input: { command: "touch output.txt", cwd: "/workspace/project-b" },
      context: { sessionId: "session-a", mode: "code" },
    });
    await runtime.executeTool({
      name: "propose_memory",
      input: {
        operation: "add",
        scope: "project",
        tier: "command",
        title: "Invalid proposal",
        rationale: "Exercise mutation preparation",
        content: "test",
      },
      context: { sessionId: "session-a", mode: "code" },
    });

    expect(prepareWorkspaceMutation).toHaveBeenCalledTimes(4);
    expect(handleWriteFile).toHaveBeenCalledTimes(1);
    expect(handleGenerateImage).toHaveBeenCalledTimes(1);
    expect(handleExecuteCommand).toHaveBeenCalledTimes(1);
  });

  it("does not prepare a mutation for a read-only command inherited from the runtime context", async () => {
    const prepareWorkspaceMutation = vi.fn().mockResolvedValue(undefined);
    const { handleExecuteCommand } = await import("../tools/executeCommand.js");
    vi.mocked(handleExecuteCommand).mockClear();
    const runtime = createAgentToolRuntime({
      ...mockCtx,
      commandExecutionPolicy: "read-only",
      prepareWorkspaceMutation,
    });

    await runtime.executeTool({
      name: "execute_command",
      input: { command: "git status --short", cwd: "/tmp/project" },
      context: { sessionId: "session-a", mode: "ask" },
    });

    expect(prepareWorkspaceMutation).not.toHaveBeenCalled();
    expect(handleExecuteCommand).toHaveBeenCalledOnce();
  });

  it("searches and hydrates the current session transcript with append-safe snapshots", async () => {
    const messages = [
      {
        sourceIndex: 0,
        role: "user" as const,
        sourceKind: "source" as const,
        condensed: true,
        content: "Investigate the stale cache key",
      },
      {
        sourceIndex: 1,
        role: "assistant" as const,
        sourceKind: "source" as const,
        condensed: true,
        content: "The stale cache key is the root cause.",
      },
    ];
    const getSessionTranscript = () => ({
      messages: structuredClone(messages),
    });
    const search = await dispatchToolCall(
      "search_session_history",
      { query: "stale cache", limit: 5 },
      { ...mockCtx, getSessionTranscript },
    );
    const searchPayload = parseRecallPayload(search);

    expect(searchPayload).toMatchObject({ ok: true, total_matches: 2 });
    expect(searchPayload.hits[0]).toMatchObject({
      message_index: 1,
      condensed: true,
    });
    expect(searchPayload.snapshot_message_count).toBe(2);
    expect(searchPayload.snapshot_revision).toMatch(/^[a-f0-9]{64}$/);

    messages.push({
      sourceIndex: 2,
      role: "user",
      sourceKind: "source",
      condensed: false,
      content: "Append-only continuation",
    });
    const excerpt = await dispatchToolCall(
      "read_session_excerpt",
      {
        start_message_index: 0,
        end_message_index: 1,
        snapshot_message_count: searchPayload.snapshot_message_count,
        snapshot_revision: searchPayload.snapshot_revision,
      },
      { ...mockCtx, getSessionTranscript },
    );
    const excerptPayload = parseRecallPayload(excerpt);
    expect(excerptPayload.ok).toBe(true);
    expect(excerptPayload.messages).toHaveLength(2);
    expect(excerptPayload.messages[1].content).toContain("root cause");

    messages[0]!.content = "Rewritten task";
    const stale = await dispatchToolCall(
      "read_session_excerpt",
      {
        start_message_index: 0,
        end_message_index: 1,
        snapshot_message_count: searchPayload.snapshot_message_count,
        snapshot_revision: searchPayload.snapshot_revision,
      },
      { ...mockCtx, getSessionTranscript },
    );
    expect(parseRecallPayload(stale)).toMatchObject({
      ok: false,
      error: { code: "stale_snapshot" },
    });
  });

  it("returns explicit unavailable behavior without a session transcript provider", async () => {
    const result = await dispatchToolCall(
      "search_session_history",
      { query: "anything" },
      mockCtx,
    );
    const text = result.content.find((entry) => entry.type === "text")?.text;
    expect(JSON.parse(text ?? "{}")).toMatchObject({
      ok: false,
      error: { code: "session_transcript_unavailable" },
    });
  });

  it("dispatches current-session diagnostic queries to the captured provider", async () => {
    const diagnose = vi.fn(() => ({
      sessionId: "session-1",
      eventCount: 1,
      recordedEventCount: 1,
      traceTruncated: false,
      filters: { toolName: "write_file", limit: 3 },
      evidence: [],
    }));
    const result = await dispatchToolCall(
      "diagnose_activity",
      { tool_name: "write_file", limit: 3 },
      {
        ...mockCtx,
        sessionActivityDiagnosticsProvider: { diagnose },
      },
    );

    expect(diagnose).toHaveBeenCalledWith({
      toolName: "write_file",
      path: undefined,
      toolCallId: undefined,
      limit: 3,
    });
    const text = result.content.find((entry) => entry.type === "text")?.text;
    expect(JSON.parse(text ?? "{}")).toMatchObject({
      sessionId: "session-1",
    });
  });

  it("allows non-interactive loading of an exact advertised skill path outside the workspace", async () => {
    const skillPath = "/outside/skills/helper/SKILL.md";
    const advertisedSkills = [
      {
        id: "global:agentlink:helper",
        name: "helper",
        revision: "a".repeat(64),
        skillPath,
        realSkillPath: skillPath,
      },
    ];
    const runtime = createAgentToolRuntime({
      ...mockCtx,
      approvalManager: {
        isPathTrusted: vi.fn(() => false),
      } as any,
    });
    vi.mocked(handleLoadSkill).mockClear();

    const result = await runtime.executeTool({
      name: "load_skill",
      input: { path: skillPath },
      context: {
        sessionId: "background-session",
        interactionPolicy: "deny",
        getAdvertisedSkills: () => advertisedSkills,
      },
    });

    expect(result).toMatchObject({
      content: [
        { type: "text", text: JSON.stringify({ skill_name: "helper" }) },
      ],
    });
    expect(handleLoadSkill).toHaveBeenCalledWith(
      { path: skillPath },
      expect.anything(),
      expect.anything(),
      "background-session",
      advertisedSkills,
      expect.anything(),
    );
    expect(mockOnApprovalRequest).not.toHaveBeenCalled();
  });

  it("allows non-interactive reads of resources associated with an advertised skill", async () => {
    const skillPath = "/outside/skills/helper/SKILL.md";
    const resourcePath = "/outside/skills/helper/references/guide.md";
    const advertisedSkills = [
      {
        id: "global:agentlink:helper",
        name: "helper",
        revision: "a".repeat(64),
        skillPath,
        realSkillPath: skillPath,
      },
    ];
    const runtime = createAgentToolRuntime({
      ...mockCtx,
      approvalManager: {
        isPathTrusted: vi.fn(() => false),
      } as any,
    });
    vi.mocked(handleReadFile).mockClear();

    await runtime.executeTool({
      name: "read_file",
      input: { path: resourcePath },
      context: {
        sessionId: "background-session",
        interactionPolicy: "deny",
        getAdvertisedSkills: () => advertisedSkills,
      },
    });

    expect(handleReadFile).toHaveBeenCalledWith(
      { path: resourcePath },
      expect.anything(),
      expect.anything(),
      "background-session",
      advertisedSkills,
      expect.anything(),
      undefined,
      undefined,
      expect.anything(),
    );
  });

  it("denies non-interactive loading of an unadvertised outside-workspace skill", async () => {
    const runtime = createAgentToolRuntime({
      ...mockCtx,
      approvalManager: {
        isPathTrusted: vi.fn(() => false),
      } as any,
    });
    vi.mocked(handleLoadSkill).mockClear();

    const result = await runtime.executeTool({
      name: "load_skill",
      input: { path: "/outside/skills/other/SKILL.md" },
      context: {
        sessionId: "background-session",
        interactionPolicy: "deny",
        getAdvertisedSkills: () => [],
      },
    });

    expect(result).toMatchObject({
      isError: true,
      data: {
        status: "rejected",
        reason: "interaction_denied",
      },
    });
    expect(handleLoadSkill).not.toHaveBeenCalled();
  });

  it("does not exempt other tools for an advertised outside-workspace skill path", async () => {
    const skillPath = "/outside/skills/helper/SKILL.md";
    const runtime = createAgentToolRuntime({
      ...mockCtx,
      approvalManager: {
        isPathTrusted: vi.fn(() => false),
      } as any,
    });
    vi.mocked(handleGetContext).mockClear();

    const result = await runtime.executeTool({
      name: "get_context",
      input: { path: skillPath },
      context: {
        sessionId: "background-session",
        interactionPolicy: "deny",
        getAdvertisedSkills: () => [
          {
            id: "global:agentlink:helper",
            name: "helper",
            revision: "a".repeat(64),
            skillPath,
            realSkillPath: skillPath,
          },
        ],
      },
    });

    expect(result).toMatchObject({
      isError: true,
      data: {
        status: "rejected",
        reason: "interaction_denied",
      },
    });
    expect(handleGetContext).not.toHaveBeenCalled();
  });

  it("denies untrusted nested read paths without invoking the handler", async () => {
    const runtime = createAgentToolRuntime({
      ...mockCtx,
      approvalManager: {
        isPathTrusted: vi.fn(() => false),
      } as any,
    });
    vi.mocked(handleGetContext).mockClear();

    const result = await runtime.executeTool({
      name: "get_context",
      input: { path: "/outside/private.ts" },
      context: {
        sessionId: "test-session",
        interactionPolicy: "deny",
      },
    });

    expect(result).toMatchObject({
      isError: true,
      data: {
        status: "rejected",
        path: "/outside/private.ts",
        reason: "interaction_denied",
      },
    });
    expect(handleGetContext).not.toHaveBeenCalled();
    expect(mockOnApprovalRequest).not.toHaveBeenCalled();
  });

  it("forwards the execution-scoped transcript getter through the tool runtime", async () => {
    const runtime = createAgentToolRuntime(mockCtx);
    const getSessionTranscript = vi.fn(() => ({
      messages: [
        {
          sourceIndex: 0,
          role: "user" as const,
          sourceKind: "source" as const,
          condensed: false,
          content: "execution scoped evidence",
        },
      ],
    }));
    const result = await runtime.executeTool({
      name: "search_session_history",
      input: { query: "scoped evidence" },
      context: {
        sessionId: "runtime-session",
        getSessionTranscript,
      },
    });

    expect(getSessionTranscript).toHaveBeenCalledTimes(1);
    expect(parseRecallPayload(result).total_matches).toBe(1);
  });

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

  it("records a validated structured background result", async () => {
    const onFinalStatus = vi.fn();
    const structuredResult = {
      type: "review_findings",
      findings: [],
      reviewedScope: "abc123..def456",
      emptyDiff: false,
    } as const;
    const result = await dispatchToolCall(
      "set_task_status",
      { status: "completed", result: structuredResult },
      {
        ...mockCtx,
        onFinalStatus,
        backgroundExpectedResult: "review_findings",
      },
    );

    expect(onFinalStatus).toHaveBeenCalledWith({
      status: "completed",
      source: "tool",
      result: structuredResult,
    });
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: JSON.stringify({ ok: true }),
    });
  });

  it("rejects missing or mismatched structured background results", async () => {
    const onFinalStatus = vi.fn();
    const result = await dispatchToolCall(
      "set_task_status",
      {
        status: "completed",
        result: { type: "text", text: "No issues" },
      },
      {
        ...mockCtx,
        onFinalStatus,
        backgroundExpectedResult: "review_findings",
      },
    );

    expect(onFinalStatus).not.toHaveBeenCalled();
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual({
      error:
        "Background completion requires a valid review_findings result in set_task_status.result",
    });
  });

  it("prefers sessionStatusProvider over legacy final status callbacks", async () => {
    const onFinalStatus = vi.fn();
    const onCompleteTodos = vi.fn(() => []);
    const sessionStatusProvider = {
      setFinalStatus: vi.fn(),
      completeTodos: vi.fn(() => ["todo-a", "todo-b"]),
    };

    const result = await dispatchToolCall(
      "set_task_status",
      { status: "completed", summary: "Done", completeTodos: true },
      { ...mockCtx, onFinalStatus, onCompleteTodos, sessionStatusProvider },
    );

    expect(sessionStatusProvider.setFinalStatus).toHaveBeenCalledWith({
      status: "completed",
      source: "tool",
      summary: "Done",
    });
    expect(sessionStatusProvider.completeTodos).toHaveBeenCalledTimes(1);
    expect(onFinalStatus).not.toHaveBeenCalled();
    expect(onCompleteTodos).not.toHaveBeenCalled();
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: JSON.stringify({ ok: true, completedTodos: 2 }),
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
      expect.objectContaining({
        resolvePath: expect.any(Function),
        normalizeExistingPath: expect.any(Function),
        readTextFile: expect.any(Function),
      }),
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

  it("dispatches get_context with context providers", async () => {
    const result = await dispatchToolCall(
      "get_context",
      { path: "src/foo.ts" },
      mockCtx,
    );

    expect(handleGetContext).toHaveBeenCalledWith(
      { path: "src/foo.ts" },
      mockCtx.sessionId,
      {
        documentProvider: expect.objectContaining({
          resolveDocument: expect.any(Function),
        }),
        workingSetProvider: expect.objectContaining({
          check: expect.any(Function),
        }),
        enrichmentProvider: expect.objectContaining({
          getGitStatus: expect.any(Function),
          getDocumentSymbols: expect.any(Function),
          getDiagnosticsSummary: expect.any(Function),
        }),
      },
    );
    expect(result.content[0]).toMatchObject({ type: "text", text: "context" });
  });

  it("dispatches read_file to handleReadFile", async () => {
    const advertisedSkills = [
      {
        id: "global:agentlink:helper",
        name: "helper",
        revision: "a".repeat(64),
        skillPath: "/outside/skills/helper/SKILL.md",
        realSkillPath: "/outside/skills/helper/SKILL.md",
      },
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
      expect.objectContaining({
        getGitStatus: expect.any(Function),
        detectLanguage: expect.any(Function),
        getSymbolOutline: expect.any(Function),
        getDiagnosticsSummary: expect.any(Function),
      }),
      undefined,
      undefined,
      {},
    );
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: "file content",
    });
  });

  it("dispatches get_repo_map with a structural graph provider", async () => {
    const result = await dispatchToolCall(
      "get_repo_map",
      { path: "src" },
      { ...mockCtx, globalStorageUri: { fsPath: "/global-storage" } as never },
    );

    expect(handleGetRepoMap).toHaveBeenCalledWith(
      { path: "src" },
      expect.objectContaining({
        resolveWorkspaceRoot: expect.any(Function),
        resolvePath: expect.any(Function),
        loadGraph: expect.any(Function),
      }),
    );
    expect(result.content[0]).toMatchObject({ type: "text", text: "repo map" });
  });

  it("dispatches get_module_neighbors with a structural graph provider", async () => {
    const result = await dispatchToolCall(
      "get_module_neighbors",
      { path: "src/foo.ts" },
      { ...mockCtx, globalStorageUri: { fsPath: "/global-storage" } as never },
    );

    expect(handleGetModuleNeighbors).toHaveBeenCalledWith(
      { path: "src/foo.ts" },
      expect.objectContaining({
        resolvePath: expect.any(Function),
        getWorkspaceRootForPath: expect.any(Function),
        loadGraph: expect.any(Function),
        getTargetFreshness: expect.any(Function),
      }),
    );
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: "module neighbors",
    });
  });

  it("dispatches codebase_search through the semantic search provider", async () => {
    const payload = {
      query: "auth flow",
      semantic: true,
      total_results: 1,
      results: "semantic results",
    };
    const search = vi.fn().mockResolvedValue({ payload });

    const result = await dispatchToolCall(
      "codebase_search",
      {
        query: "auth flow",
        path: "src/agent",
        limit: 3,
        exclude_globs: ["**/dist/**", 42],
      },
      { ...mockCtx, semanticSearchProvider: { search } },
    );

    expect(search).toHaveBeenCalledWith({
      query: "auth flow",
      path: "src/agent",
      limit: 3,
      exclude_globs: ["**/dist/**", "42"],
    });
    expect(result.data).toEqual(payload);
    expect(result.content[0]).toEqual({
      type: "text",
      text: JSON.stringify(payload, null, 2),
    });
  });

  it("preserves typed semantic provider errors at the tool boundary", async () => {
    const search = vi.fn().mockResolvedValue({
      payload: {
        error: "distinctive semantic failure",
        reason: "store_unavailable",
      },
      isError: true,
      error: {
        kind: "semantic_store_unavailable",
        message: "distinctive semantic failure",
      },
    });

    const result = await dispatchToolCall(
      "codebase_search",
      { query: "auth flow" },
      { ...mockCtx, semanticSearchProvider: { search } },
    );

    expect(result).toMatchObject({
      data: {
        error: "distinctive semantic failure",
        reason: "store_unavailable",
      },
      isError: true,
      error: {
        kind: "semantic_store_unavailable",
        message: "distinctive semantic failure",
      },
    });
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual(
      result.data,
    );
  });

  it("returns explicit unavailable behavior for codebase_search without a provider", async () => {
    const result = await dispatchToolCall(
      "codebase_search",
      { query: "auth flow" },
      mockCtx,
    );

    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(JSON.parse(text)).toMatchObject({
      error: expect.stringContaining(
        "Semantic codebase search is unavailable in this runtime",
      ),
    });
    expect(result).toMatchObject({
      isError: true,
      error: {
        kind: "tool_error",
        message: expect.stringContaining(
          "Semantic codebase search is unavailable in this runtime",
        ),
      },
    });
  });

  it("forwards explicit read-only command execution policy", async () => {
    const { handleExecuteCommand } = await import("../tools/executeCommand.js");
    const runtime = createAgentToolRuntime(mockCtx);

    await runtime.executeTool({
      name: "execute_command",
      input: { command: "pwd" },
      context: {
        sessionId: mockCtx.sessionId,
        mode: "research-custom",
        commandExecutionPolicy: "read-only",
      },
    });

    expect(handleExecuteCommand).toHaveBeenCalledWith(
      { command: "pwd" },
      mockCtx.approvalManager,
      mockCtx.approvalPanel,
      mockCtx.sessionId,
      undefined,
      expect.objectContaining({ commandExecutionPolicy: "read-only" }),
    );
  });

  it("enforces read-only execution for direct ask-mode dispatch", async () => {
    const { handleExecuteCommand } = await import("../tools/executeCommand.js");

    await dispatchToolCall(
      "execute_command",
      { command: "pwd" },
      { ...mockCtx, mode: "ask" },
    );

    expect(handleExecuteCommand).toHaveBeenCalledWith(
      { command: "pwd" },
      mockCtx.approvalManager,
      mockCtx.approvalPanel,
      mockCtx.sessionId,
      mockCtx.trackerCtx,
      expect.objectContaining({ commandExecutionPolicy: "read-only" }),
    );
  });

  it("dispatches the complete execute_command request to handleExecuteCommand", async () => {
    const { handleExecuteCommand } = await import("../tools/executeCommand.js");
    vi.mocked(handleExecuteCommand).mockClear();
    const result = await dispatchToolCall(
      "execute_command",
      { command: "npm test", temporary_home: true },
      mockCtx,
    );
    expect(handleExecuteCommand).toHaveBeenCalledWith(
      { command: "npm test", temporary_home: true },
      mockCtx.approvalManager,
      mockCtx.approvalPanel,
      mockCtx.sessionId,
      mockCtx.trackerCtx,
      expect.objectContaining({
        terminalProvider: mockCtx.terminalProvider,
      }),
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
      {
        editReviewProvider: expect.objectContaining({
          reviewAndApply: expect.any(Function),
        }),
        writeApprovalPolicyProvider: expect.objectContaining({
          canAutoApprove: expect.any(Function),
          recordDecision: expect.any(Function),
        }),
        diagnosticDelay: 1500,
      },
    );
  });

  it("dispatches apply_diff block options unchanged", async () => {
    const { handleApplyDiff } = await import("../tools/applyDiff.js");
    const params = {
      path: "foo.ts",
      diff: "diff",
      block_options: [
        { index: 0, occurrence: 2 },
        { index: 1, replace_all: true },
      ],
    };

    await dispatchToolCall("apply_diff", params, mockCtx);

    expect(handleApplyDiff).toHaveBeenCalledWith(
      params,
      mockCtx.approvalManager,
      mockCtx.approvalPanel,
      mockCtx.sessionId,
      mockCtx.onApprovalRequest,
      mockCtx.mode,
      expect.objectContaining({
        editReviewProvider: expect.objectContaining({
          reviewAndApply: expect.any(Function),
        }),
        writeApprovalPolicyProvider: expect.objectContaining({
          canAutoApprove: expect.any(Function),
          recordDecision: expect.any(Function),
        }),
      }),
    );
  });

  it("records bounded approval-state telemetry when write tools request a prompt", async () => {
    const { handleWriteFile } = await import("../tools/writeFile.js");
    const { handleApplyDiff } = await import("../tools/applyDiff.js");
    const recordMetrics = vi.fn();
    const getAgentWriteApprovalDiagnostics = vi.fn(() => ({
      effectiveScope: "session" as const,
      globalBlanketApproved: false,
      projectBlanketApproved: false,
      sessionBlanketApproved: true,
      legacyGlobalBlanketApproved: false,
      legacyProjectBlanketApproved: false,
      legacySessionBlanketApproved: true,
      sessionProjectBound: true,
      sessionStatePresent: true,
      sessionStateAgeMs: 90_000,
      writeRuleCounts: { session: 2, project: 1, global: 0, settings: 3 },
    }));
    const ctx: ToolDispatchContext = {
      ...mockCtx,
      mode: "code",
      isBackgroundSession: true,
      approvalManager: {
        getAgentWriteApprovalDiagnostics,
      } as any,
      toolUsageTelemetry: { recordMetrics } as any,
    };
    const prompt = {
      authorization: {
        allowed: false as const,
        basis: "none" as const,
        reason: "outside_workspace_requires_matching_rule",
      },
      sessionId: "test-session",
      absolutePath: "/sensitive/outside/file.ts",
      relativePath: "/sensitive/outside/file.ts",
      inWorkspace: false,
      mode: "code",
    };

    await dispatchToolCall(
      "write_file",
      { path: "foo.ts", content: "hello" },
      ctx,
    );
    const writeProviders = vi.mocked(handleWriteFile).mock.calls.at(-1)?.[6];
    writeProviders?.onApprovalPrompt?.(prompt);

    await dispatchToolCall("apply_diff", { path: "foo.ts", diff: "diff" }, ctx);
    const diffProviders = vi.mocked(handleApplyDiff).mock.calls.at(-1)?.[6];
    diffProviders?.onApprovalPrompt?.(prompt);

    expect(recordMetrics).toHaveBeenCalledTimes(2);
    expect(recordMetrics).toHaveBeenNthCalledWith(
      1,
      "write_file",
      expect.objectContaining({
        writeApprovalPrompt: true,
        writeApprovalPromptReason: "outside_workspace_requires_matching_rule",
        writeApprovalSessionKind: "background",
        writeApprovalMode: "code",
        writeApprovalBlanketScope: "session",
        writeApprovalSessionBlanketApproved: true,
        writeApprovalSessionProjectBound: true,
        writeApprovalSessionStateAgeBucket: "1m_to_1h",
        writeApprovalSessionRuleCount: 2,
        writeApprovalSettingsRuleCount: 3,
      }),
    );
    expect(recordMetrics).toHaveBeenNthCalledWith(
      2,
      "apply_diff",
      expect.any(Object),
    );
    expect(JSON.stringify(recordMetrics.mock.calls)).not.toContain(
      "/sensitive/outside/file.ts",
    );
  });

  it("dispatches open_file with editor reveal providers", async () => {
    const { handleOpenFile } = await import("../tools/openFile.js");
    const editorRevealProvider = {
      reveal: vi.fn(async () => ({
        content: [{ type: "text" as const, text: "opened" }],
      })),
    };

    const result = await dispatchToolCall(
      "open_file",
      { path: "src/foo.ts", line: 3 },
      { ...mockCtx, editorRevealProvider },
    );

    expect(handleOpenFile).toHaveBeenCalledWith(
      { path: "src/foo.ts", line: 3 },
      mockCtx.sessionId,
      {
        workspaceFileProvider: expect.objectContaining({
          resolvePath: expect.any(Function),
        }),
        pathAccessProvider: expect.objectContaining({
          ensureAccess: expect.any(Function),
        }),
        editorRevealProvider,
      },
    );
    expect(result.content[0]).toMatchObject({ type: "text", text: "opened" });
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
      {
        multiFileEditReviewProvider: expect.objectContaining({
          reviewAndApply: expect.any(Function),
        }),
        pathAccessProvider: expect.objectContaining({
          ensureAccess: expect.any(Function),
        }),
        prepareOneShotAuthorization: undefined,
      },
    );
  });

  it("dispatches rename_symbol with the rename provider", async () => {
    const { handleRenameSymbol } = await import("../tools/renameSymbol.js");
    const renameSymbolProvider = {
      rename: vi.fn(async () => ({
        content: [{ type: "text" as const, text: "renamed" }],
      })),
    };

    await dispatchToolCall(
      "rename_symbol",
      { path: "src/file.ts", line: 2, column: 3, new_name: "nextName" },
      { ...mockCtx, renameSymbolProvider },
    );

    expect(handleRenameSymbol).toHaveBeenCalledWith(
      { path: "src/file.ts", line: 2, column: 3, new_name: "nextName" },
      mockCtx.approvalPanel,
      mockCtx.sessionId,
      mockCtx.onApprovalRequest,
      {
        renameSymbolProvider,
        pathAccessProvider: expect.objectContaining({
          ensureAccess: expect.any(Function),
        }),
      },
    );
  });

  it("does not synthesize terminal authority when the host supplies no provider", async () => {
    const { handleExecuteCommand } = await import("../tools/executeCommand.js");
    const { handleGetTerminalOutput } =
      await import("../tools/getTerminalOutput.js");
    const { handleCloseTerminals } = await import("../tools/closeTerminals.js");
    const { terminalProvider: _terminalProvider, ...withoutTerminal } = mockCtx;

    await dispatchToolCall(
      "execute_command",
      { command: "pwd" },
      withoutTerminal,
    );
    await dispatchToolCall(
      "get_terminal_output",
      { terminal_id: "missing" },
      withoutTerminal,
    );
    await dispatchToolCall("close_terminals", {}, withoutTerminal);

    expect(handleExecuteCommand).toHaveBeenLastCalledWith(
      { command: "pwd" },
      mockCtx.approvalManager,
      mockCtx.approvalPanel,
      mockCtx.sessionId,
      mockCtx.trackerCtx,
      { terminalProvider: undefined },
    );
    expect(handleGetTerminalOutput).toHaveBeenLastCalledWith(
      { terminal_id: "missing" },
      {
        terminalProvider: undefined,
        waitForPendingInterjection: undefined,
      },
    );
    expect(handleCloseTerminals).toHaveBeenLastCalledWith(
      {},
      { terminalProvider: undefined },
    );
  });

  it("dispatches get_terminal_output with terminal and interjection providers", async () => {
    const { handleGetTerminalOutput } =
      await import("../tools/getTerminalOutput.js");
    const waitForPendingInterjection = vi.fn();
    await dispatchToolCall(
      "get_terminal_output",
      { terminal_id: "t1" },
      { ...mockCtx, waitForPendingInterjection },
    );
    expect(handleGetTerminalOutput).toHaveBeenCalledWith(
      { terminal_id: "t1" },
      {
        terminalProvider: mockCtx.terminalProvider,
        waitForPendingInterjection,
      },
    );
  });

  it("dispatches close_terminals with a terminal provider", async () => {
    const { handleCloseTerminals } = await import("../tools/closeTerminals.js");
    await dispatchToolCall("close_terminals", { names: ["Server"] }, mockCtx);
    expect(handleCloseTerminals).toHaveBeenCalledWith(
      { names: ["Server"] },
      { terminalProvider: mockCtx.terminalProvider },
    );
  });

  describe("tool usage outcome normalization", () => {
    it.each([
      [{ status: "rejected" }, "rejected"],
      [{ status: "rejected_by_user", error: "denied" }, "rejected"],
      [{ status: "cancelled" }, "cancelled"],
      [{ partial: true, failed_blocks: [1] }, "partial"],
      [{ status: "partial" }, "partial"],
      [{ status: "error" }, "error"],
      [{ error: "failed" }, "error"],
      [{ ok: true }, "ok"],
    ] as const)("normalizes %o as %s", (payload, expected) => {
      expect(
        getToolUsageOutcomeFromResult({
          content: [{ type: "text", text: JSON.stringify(payload) }],
        }),
      ).toBe(expected);
    });

    it("uses canonical error fields when output is not structured JSON", () => {
      expect(
        getToolUsageOutcomeFromResult({
          content: [{ type: "text", text: "aborted" }],
          isError: true,
          error: { kind: "aborted", message: "aborted" },
        }),
      ).toBe("cancelled");
      expect(
        getToolUsageOutcomeFromResult({
          content: [{ type: "text", text: "failed" }],
          isError: true,
          error: { kind: "tool_error", message: "failed" },
        }),
      ).toBe("error");
    });

    it("preserves canonical abort classification when the body is a generic structured error", () => {
      expect(
        getToolUsageOutcomeFromResult({
          content: [
            {
              type: "text",
              text: JSON.stringify({ status: "error", error: "aborted" }),
            },
          ],
          isError: true,
          error: { kind: "aborted", message: "aborted" },
        }),
      ).toBe("cancelled");
    });
  });

  describe("switch_mode", () => {
    it("dispatches mode switches through modeSwitchProvider when supplied", async () => {
      const onModeSwitch = vi.fn();
      const modeSwitchProvider = {
        switchMode: vi.fn().mockResolvedValue({
          approved: true,
          mode: "architect",
          followUp: "Use provider-owned approval state.",
        }),
      };

      const result = await dispatchToolCall(
        "switch_mode",
        { mode: "architect", reason: "Need a plan" },
        { ...mockCtx, onModeSwitch, modeSwitchProvider },
      );

      expect(modeSwitchProvider.switchMode).toHaveBeenCalledWith({
        mode: "architect",
        reason: "Need a plan",
      });
      expect(onModeSwitch).not.toHaveBeenCalled();
      const parsed = JSON.parse(
        (result.content[0] as { type: "text"; text: string }).text,
      );
      expect(parsed).toEqual({
        ok: true,
        mode: "architect",
        follow_up: "Use provider-owned approval state.",
      });
    });

    it("returns approval follow-up to the agent", async () => {
      const onModeSwitch = vi.fn().mockResolvedValue({
        approved: true,
        mode: "architect",
        followUp: "Use the RFC template first.",
      });

      const result = await dispatchToolCall(
        "switch_mode",
        { mode: "architect", reason: "Need a plan" },
        { ...mockCtx, onModeSwitch },
      );

      expect(onModeSwitch).toHaveBeenCalledWith(
        "test-session",
        "architect",
        "Need a plan",
      );
      const parsed = JSON.parse(
        (result.content[0] as { type: "text"; text: string }).text,
      );
      expect(parsed).toEqual({
        ok: true,
        mode: "architect",
        follow_up: "Use the RFC template first.",
      });
    });

    it("returns the typed rejection reason when rejected", async () => {
      const onModeSwitch = vi.fn().mockResolvedValue({
        approved: false,
        mode: "architect",
        rejectionReason: "Stay in code mode and make the small fix.",
        followUp: "Do not ask again; continue in code mode.",
      });

      const result = await dispatchToolCall(
        "switch_mode",
        { mode: "architect" },
        { ...mockCtx, onModeSwitch },
      );

      const parsed = JSON.parse(
        (result.content[0] as { type: "text"; text: string }).text,
      );
      expect(parsed).toEqual({
        status: "rejected_by_user",
        reason: "Stay in code mode and make the small fix.",
        follow_up: "Do not ask again; continue in code mode.",
      });
    });
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
      expect(askUserTool?.description).toContain(
        "preceding assistant text does not satisfy the context requirement",
      );
      expect(askUserTool?.input_schema.required).toEqual(["questions"]);
    });

    it("describes direct confirmation choices and rejects malformed labels", async () => {
      const askUserTool = getAgentTools().find(
        (tool) => tool.name === "ask_user",
      );
      expect(askUserTool?.description).toContain("direct two-button decision");

      const userQuestionProvider = { ask: vi.fn() };
      const result = await dispatchToolCall(
        "ask_user",
        {
          context: "Need a release decision.",
          questions: [
            {
              id: "release",
              type: "confirmation",
              question: "Ship this release?",
              options: ["Ship it"],
            },
          ],
        },
        { ...mockCtx, userQuestionProvider },
      );

      expect(userQuestionProvider.ask).not.toHaveBeenCalled();
      const content = result.content[0];
      expect(content.type).toBe("text");
      expect(JSON.parse(content.type === "text" ? content.text : "")).toEqual({
        error:
          'Confirmation question "release" must have exactly two distinct non-empty options when custom button labels are provided',
      });
    });

    it.each([
      ["duplicate labels", ["Ship it", "Ship it"]],
      ["whitespace-equivalent labels", ["Ship it", " Ship it "]],
      ["blank label", ["Ship it", " "]],
      ["non-array labels", "Ship it"],
    ])("rejects confirmation %s", async (_name, options) => {
      const userQuestionProvider = { ask: vi.fn() };

      const result = await dispatchToolCall(
        "ask_user",
        {
          context: "Need a release decision.",
          questions: [
            {
              id: "release",
              type: "confirmation",
              question: "Ship this release?",
              options,
            },
          ],
        },
        { ...mockCtx, userQuestionProvider },
      );

      expect(userQuestionProvider.ask).not.toHaveBeenCalled();
      const content = result.content[0];
      expect(content.type).toBe("text");
      expect(JSON.parse(content.type === "text" ? content.text : "")).toEqual({
        error:
          'Confirmation question "release" must have exactly two distinct non-empty options when custom button labels are provided',
      });
    });

    it("normalizes accepted confirmation labels before asking", async () => {
      const userQuestionProvider = {
        ask: vi.fn().mockResolvedValue({
          answers: { release: "Ship it" },
          notes: {},
        }),
      };

      await dispatchToolCall(
        "ask_user",
        {
          context: "Need a release decision.",
          questions: [
            {
              id: "release",
              type: "confirmation",
              question: "Ship this release?",
              options: [" Ship it ", "Keep working"],
            },
          ],
        },
        { ...mockCtx, userQuestionProvider },
      );

      expect(userQuestionProvider.ask).toHaveBeenCalledWith(
        expect.objectContaining({
          questions: [
            expect.objectContaining({
              options: ["Ship it", "Keep working"],
            }),
          ],
        }),
      );
    });

    it("forwards the provider tool-call ID through the production runtime", async () => {
      const onQuestion = vi.fn().mockResolvedValue({
        answers: { choice: "Provider fix" },
        notes: {},
      });
      const runtime = createAgentToolRuntime({ ...mockCtx, onQuestion });

      await runtime.executeTool({
        name: "ask_user",
        input: {
          context: "Choose the implementation path.",
          questions: [
            {
              id: "choice",
              type: "multiple_choice",
              question: "How should we proceed?",
              options: ["Provider fix", "UI-only fix"],
              recommended: "Provider fix",
            },
          ],
        },
        context: {
          sessionId: "test-session",
          mode: "code",
          toolCallId: "toolu-live-ask",
        },
      });

      expect(onQuestion).toHaveBeenCalledWith(
        "Choose the implementation path.",
        [expect.objectContaining({ id: "choice" })],
        "test-session",
        undefined,
        undefined,
        "toolu-live-ask",
      );
    });

    it("forwards pending recovery context through the production runtime", async () => {
      const onQuestion = vi.fn().mockResolvedValue({
        answers: { choice: "Provider fix" },
        notes: {},
      });
      const pendingQuestionRecovery = {
        schemaVersion: 1 as const,
        assistantContent: [
          {
            type: "tool_use" as const,
            id: "toolu-ask-1",
            name: "ask_user",
            input: {},
          },
        ],
        toolUseId: "toolu-ask-1",
        toolName: "ask_user" as const,
        toolInput: {},
      };
      const runtime = createAgentToolRuntime({ ...mockCtx, onQuestion });

      await runtime.executeTool({
        name: "ask_user",
        input: {
          context: "Choose the implementation path.",
          questions: [
            {
              id: "choice",
              type: "multiple_choice",
              question: "How should we proceed?",
              options: ["Provider fix", "UI-only fix"],
              recommended: "Provider fix",
            },
          ],
        },
        context: {
          sessionId: "test-session",
          mode: "code",
          pendingQuestionRecovery,
        },
      });

      expect(onQuestion).toHaveBeenCalledWith(
        "Choose the implementation path.",
        [expect.objectContaining({ id: "choice" })],
        "test-session",
        undefined,
        pendingQuestionRecovery,
      );
    });

    it("dispatches structured questions through userQuestionProvider when supplied", async () => {
      const onQuestion = vi.fn();
      const userQuestionProvider = {
        ask: vi.fn().mockResolvedValue({
          answers: { choice: "Provider fix" },
          notes: { choice: "Use provider seam" },
        }),
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
              context: "This affects the capability boundary.",
              options: ["Provider fix", "UI-only fix"],
              recommended: "Provider fix",
            },
          ],
        },
        {
          ...mockCtx,
          onQuestion,
          userQuestionProvider,
        },
      );

      expect(userQuestionProvider.ask).toHaveBeenCalledWith({
        context: "I need your input to choose the next step.",
        questions: [
          expect.objectContaining({
            id: "choice",
            context: "This affects the capability boundary.",
          }),
        ],
        sessionId: "test-session",
      });
      expect(onQuestion).not.toHaveBeenCalled();
      const parsed = JSON.parse(
        (result.content[0] as { type: "text"; text: string }).text,
      );
      expect(parsed).toEqual({
        context: "I need your input to choose the next step.",
        responses: [
          {
            question: "How should we proceed?",
            context: "This affects the capability boundary.",
            answer: "Provider fix",
            note: "Use provider seam",
          },
        ],
      });
    });

    it("returns question-ordered attachment metadata and native media blocks", async () => {
      const userQuestionProvider = {
        ask: vi.fn().mockResolvedValue({
          answers: { first: "A", second: "B" },
          notes: { first: "See context" },
          attachments: {
            second: [
              {
                kind: "document",
                name: "brief.pdf",
                mimeType: "application/pdf",
                base64: "pdf-data",
              },
            ],
            first: [
              {
                kind: "file",
                name: "config.ts",
                path: "src/config.ts",
              },
              {
                kind: "image",
                name: "screen.png",
                mimeType: "image/png",
                base64: "image-data",
              },
            ],
          },
        }),
      };

      const result = await dispatchToolCall(
        "ask_user",
        {
          context: "Need supporting context.",
          questions: [
            {
              id: "first",
              type: "multiple_choice",
              question: "First?",
              options: ["A", "B"],
              recommended: "A",
            },
            {
              id: "second",
              type: "multiple_choice",
              question: "Second?",
              options: ["A", "B"],
              recommended: "B",
            },
          ],
        },
        { ...mockCtx, userQuestionProvider },
      );

      expect(
        JSON.parse(
          result.content[0].type === "text" ? result.content[0].text : "",
        ),
      ).toEqual({
        context: "Need supporting context.",
        responses: [
          {
            question: "First?",
            answer: "A",
            note: "See context",
            attachments: [
              { kind: "file", name: "config.ts", path: "src/config.ts" },
              { kind: "image", name: "screen.png", mimeType: "image/png" },
            ],
          },
          {
            question: "Second?",
            answer: "B",
            attachments: [
              {
                kind: "document",
                name: "brief.pdf",
                mimeType: "application/pdf",
              },
            ],
          },
        ],
      });
      expect(result.content.slice(1)).toEqual([
        { type: "image", data: "image-data", mimeType: "image/png" },
        {
          type: "document",
          data: "pdf-data",
          mimeType: "application/pdf",
          name: "brief.pdf",
        },
      ]);
    });

    it("does not call userQuestionProvider when visible context validation fails", async () => {
      const userQuestionProvider = {
        ask: vi.fn(),
      };

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
        { ...mockCtx, userQuestionProvider },
      );

      expect(userQuestionProvider.ask).not.toHaveBeenCalled();
      const parsed = JSON.parse(
        (result.content[0] as { type: "text"; text: string }).text,
      );
      expect(parsed.error).toContain(
        "requires visible context in this tool call",
      );
      expect(parsed.error).toContain(
        "Preceding assistant messages are intentionally not used",
      );
      expect(parsed.error).toContain(
        "question card must remain self-contained",
      );
    });

    it("performs a silent mode switch through modeSwitchProvider when the user's answer is mapped", async () => {
      const onQuestion = vi.fn().mockResolvedValue({
        answers: { choice: "Plan first" },
        notes: { choice: "Use the RFC first" },
      });
      const onModeSwitch = vi.fn();
      const modeSwitchProvider = {
        switchMode: vi.fn().mockResolvedValue({
          approved: true,
          mode: "architect",
          followUp: "Start by drafting the risk section.",
        }),
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
        { ...mockCtx, onQuestion, onModeSwitch, modeSwitchProvider },
      );

      expect(modeSwitchProvider.switchMode).toHaveBeenCalledWith({
        mode: "architect",
        reason: 'ask_user: "Plan first" — Use the RFC first',
        silent: true,
      });
      expect(onModeSwitch).not.toHaveBeenCalled();
      const parsed = JSON.parse(
        (result.content[0] as { type: "text"; text: string }).text,
      );
      expect(parsed.modeSwitched).toBe("architect");
      expect(parsed.follow_up).toBe("Start by drafting the risk section.");
    });

    it("performs a silent mode switch when the user's answer is mapped", async () => {
      const onQuestion = vi.fn().mockResolvedValue({
        answers: { choice: "Plan first" },
        notes: {},
      });
      const onModeSwitch = vi.fn().mockResolvedValue({
        approved: true,
        mode: "architect",
        followUp: "Start by drafting the risk section.",
      });

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
        "test-session",
        "architect",
        expect.stringContaining("Plan first"),
        true,
      );

      const text = (result.content[0] as { type: "text"; text: string }).text;
      const parsed = JSON.parse(text);
      expect(parsed.modeSwitched).toBe("architect");
      expect(parsed.follow_up).toBe("Start by drafting the risk section.");
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

  it("restricts read-only MCP discovery to explicitly annotated tools", async () => {
    const readTool = {
      name: "linear__list_issues",
      description: "List Linear issues",
      input_schema: { type: "object", properties: {} },
    };
    const mcpHub = {
      getToolDefs: vi.fn().mockReturnValue([
        readTool,
        {
          name: "linear__create_issue",
          description: "Create a Linear issue",
          input_schema: { type: "object", properties: {} },
        },
      ]),
      getReadOnlyToolDefs: vi.fn().mockReturnValue([readTool]),
    };

    const result = await dispatchToolCall(
      "find_mcp_tools",
      { query: "", limit: 10 },
      {
        ...mockCtx,
        mcpHub: mcpHub as any,
        mcpToolAccess: "read-only",
      },
    );

    const parsed = JSON.parse(
      (result.content[0] as { type: string; text: string }).text,
    );
    expect(parsed.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "linear__list_issues",
    ]);
    expect(mcpHub.getReadOnlyToolDefs).toHaveBeenCalled();
    expect(mcpHub.getToolDefs).not.toHaveBeenCalled();
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

  it("dispatches MCP discovery through a provider with normalized params and active skill allowlist", async () => {
    const discoverTools = vi.fn().mockReturnValue({
      tools: [
        {
          server: "linear",
          tool: "list_issues",
          name: "linear__list_issues",
          description: "List Linear issues",
        },
      ],
      totalMatches: 1,
      truncated: false,
      schemaCount: 0,
      schemaLimited: false,
    });
    const skillAllowedTools = ["linear__list_issues"];

    const result = await dispatchToolCall(
      "find_mcp_tools",
      {
        query: "issues",
        server: "linear",
        includeSchemas: "true",
        schemaLimit: "2",
        limit: "10",
      },
      {
        ...mockCtx,
        mcpToolDiscoveryProvider: { discoverTools },
        skillAllowedTools,
      },
    );

    expect(discoverTools).toHaveBeenCalledTimes(1);
    const request = discoverTools.mock.calls[0][0];
    expect(request).toMatchObject({
      query: "issues",
      server: "linear",
      includeSchemas: true,
      schemaLimit: 2,
      limit: 10,
    });
    expect(request.skillAllowlist).toBeInstanceOf(Set);
    expect([...request.skillAllowlist]).toEqual(skillAllowedTools);
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
        },
      ],
      count: 1,
      totalMatches: 1,
      truncated: false,
      schemaCount: 0,
      schemaLimited: false,
    });
  });

  it("uses the current MCP generation for deferred discovery and releases its lease", async () => {
    const staleHub = {
      getToolDefs: vi.fn().mockReturnValue([]),
    };
    const currentHub = {
      getToolDefs: vi.fn().mockReturnValue([
        {
          name: "linear__list_issues",
          description: "List current issues",
          input_schema: { type: "object", properties: {} },
        },
      ]),
    };
    const release = vi.fn();
    const acquireCurrentMcpHub = vi.fn(() => ({
      projectId: "project",
      generation: 2,
      hub: currentHub as any,
      retain: vi.fn(),
      release,
    }));

    const result = await dispatchToolCall(
      "find_mcp_tools",
      { query: "issues" },
      {
        ...mockCtx,
        mcpHub: staleHub as any,
        acquireCurrentMcpHub,
      },
    );

    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "linear__list_issues",
    ]);
    expect(staleHub.getToolDefs).not.toHaveBeenCalled();
    expect(acquireCurrentMcpHub).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it("holds the current MCP generation lease through async resource reads", async () => {
    let resolveRead!: (result: ToolResult) => void;
    const readResult = new Promise<ToolResult>((resolve) => {
      resolveRead = resolve;
    });
    const currentHub = {
      readResource: vi.fn(() => readResult),
    };
    const release = vi.fn();

    const resultPromise = dispatchToolCall(
      "read_mcp_resource",
      { server: "linear", uri: "linear://issues" },
      {
        ...mockCtx,
        mcpHub: { readResource: vi.fn() } as any,
        acquireCurrentMcpHub: () => ({
          projectId: "project",
          generation: 2,
          hub: currentHub as any,
          retain: vi.fn(),
          release,
        }),
      },
    );

    await Promise.resolve();
    expect(currentHub.readResource).toHaveBeenCalledWith(
      "linear",
      "linear://issues",
    );
    expect(release).not.toHaveBeenCalled();

    resolveRead({ content: [{ type: "text", text: "current resource" }] });
    await expect(resultPromise).resolves.toEqual({
      content: [{ type: "text", text: "current resource" }],
    });
    expect(release).toHaveBeenCalledOnce();
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

  it("dispatches MCP resource and prompt listing through provider when supplied", async () => {
    const mcpHub = {
      getAllResources: vi.fn(),
      getAllPrompts: vi.fn(),
    };
    const mcpResourcePromptProvider = {
      listResources: vi.fn().mockReturnValue([
        { serverName: "linear", uri: "linear://issues" },
        { serverName: "notion", uri: "notion://pages" },
      ]),
      readResource: vi.fn(),
      listPrompts: vi.fn().mockReturnValue([
        { serverName: "linear", name: "issue-summary" },
        { serverName: "notion", name: "page-summary" },
      ]),
      getPrompt: vi.fn(),
    };

    const resources = await dispatchToolCall(
      "list_mcp_resources",
      {},
      {
        ...mockCtx,
        mcpHub: mcpHub as any,
        mcpResourcePromptProvider,
        skillAllowedTools: ["linear"],
      },
    );
    const prompts = await dispatchToolCall(
      "list_mcp_prompts",
      {},
      {
        ...mockCtx,
        mcpHub: mcpHub as any,
        mcpResourcePromptProvider,
        skillAllowedTools: ["linear"],
      },
    );

    expect(mcpResourcePromptProvider.listResources).toHaveBeenCalledTimes(1);
    expect(mcpResourcePromptProvider.listPrompts).toHaveBeenCalledTimes(1);
    expect(mcpHub.getAllResources).not.toHaveBeenCalled();
    expect(mcpHub.getAllPrompts).not.toHaveBeenCalled();
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

  it("dispatches MCP resource reads and prompt gets through provider when supplied", async () => {
    const mcpHub = {
      readResource: vi.fn(),
      getPrompt: vi.fn(),
    };
    const mcpResourcePromptProvider = {
      listResources: vi.fn(),
      readResource: vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "resource body" }],
      }),
      listPrompts: vi.fn(),
      getPrompt: vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "user: prompt body" }],
      }),
    };

    const resource = await dispatchToolCall(
      "read_mcp_resource",
      { server: "linear", uri: "linear://issues" },
      {
        ...mockCtx,
        mcpHub: mcpHub as any,
        mcpResourcePromptProvider,
        skillAllowedTools: ["linear"],
      },
    );
    const prompt = await dispatchToolCall(
      "get_mcp_prompt",
      {
        server: "linear",
        name: "issue-summary",
        arguments: { issueId: "AL-123" },
      },
      {
        ...mockCtx,
        mcpHub: mcpHub as any,
        mcpResourcePromptProvider,
        skillAllowedTools: ["linear"],
      },
    );

    expect(mcpResourcePromptProvider.readResource).toHaveBeenCalledWith(
      "linear",
      "linear://issues",
    );
    expect(mcpResourcePromptProvider.getPrompt).toHaveBeenCalledWith(
      "linear",
      "issue-summary",
      { issueId: "AL-123" },
    );
    expect(mcpHub.readResource).not.toHaveBeenCalled();
    expect(mcpHub.getPrompt).not.toHaveBeenCalled();
    expect(resource).toEqual({
      content: [{ type: "text", text: "resource body" }],
    });
    expect(prompt).toEqual({
      content: [{ type: "text", text: "user: prompt body" }],
    });
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

  it("dispatches direct MCP tool calls through invocation provider when supplied", async () => {
    const mcpHub = {
      getServerConfig: vi.fn(),
      callTool: vi.fn(),
    };
    const mcpToolInvocationProvider = {
      getToolDefs: vi.fn(),
      getServerConfig: vi.fn().mockReturnValue({ toolPolicy: "allow" }),
      callTool: vi.fn().mockResolvedValue({
        content: [{ type: "text", text: JSON.stringify({ ok: true }) }],
      }),
    };

    const result = await dispatchToolCall(
      "linear__list_issues",
      { query: "bug" },
      {
        ...mockCtx,
        approvalManager: {
          isMcpApproved: vi.fn().mockReturnValue(false),
        } as any,
        mcpHub: mcpHub as any,
        mcpToolInvocationProvider,
      },
    );

    expect(mcpToolInvocationProvider.getServerConfig).toHaveBeenCalledWith(
      "linear",
    );
    expect(mcpToolInvocationProvider.callTool).toHaveBeenCalledWith({
      toolName: "linear__list_issues",
      input: { query: "bug" },
      signal: undefined,
    });
    expect(mcpHub.getServerConfig).not.toHaveBeenCalled();
    expect(mcpHub.callTool).not.toHaveBeenCalled();
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: JSON.stringify({ ok: true }),
    });
  });

  it("uses invocation provider for call_mcp_tool target lookup and execution", async () => {
    const mcpHub = {
      getToolDefs: vi.fn(),
      getServerConfig: vi.fn(),
      callTool: vi.fn(),
    };
    const mcpToolInvocationProvider = {
      getToolDefs: vi.fn().mockReturnValue([
        {
          name: "linear__list_issues",
          description: "List issues",
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
      { server: "linear", tool: "list_issues", input: { query: "bug" } },
      {
        ...mockCtx,
        approvalManager: {
          isMcpApproved: vi.fn().mockReturnValue(false),
        } as any,
        mcpHub: mcpHub as any,
        mcpToolInvocationProvider,
      },
    );

    expect(mcpToolInvocationProvider.getToolDefs).toHaveBeenCalledTimes(1);
    expect(mcpToolInvocationProvider.callTool).toHaveBeenCalledWith({
      toolName: "linear__list_issues",
      input: { query: "bug" },
      signal: undefined,
    });
    expect(mcpHub.getToolDefs).not.toHaveBeenCalled();
    expect(mcpHub.getServerConfig).not.toHaveBeenCalled();
    expect(mcpHub.callTool).not.toHaveBeenCalled();
  });

  it("preserves nested MCP arguments through call_mcp_tool dispatch", async () => {
    const input = {
      import_settings: {
        textureType: "Default",
        sRGBTexture: true,
        nested_values: [false, 0, "", null],
      },
    };
    const mcpToolInvocationProvider = {
      getToolDefs: vi.fn().mockReturnValue([
        {
          name: "unityMCP__manage_texture",
          description: "Manage a texture",
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
      { server: "unityMCP", tool: "manage_texture", input },
      {
        ...mockCtx,
        approvalManager: {
          isMcpApproved: vi.fn().mockReturnValue(false),
        } as any,
        mcpToolInvocationProvider,
      },
    );

    expect(mcpToolInvocationProvider.callTool).toHaveBeenCalledWith({
      toolName: "unityMCP__manage_texture",
      input,
      signal: undefined,
    });
  });

  it("holds one current MCP generation across call_mcp_tool lookup, approval, and execution", async () => {
    let resolveApproval!: (choice: string) => void;
    const onApprovalRequest = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveApproval = resolve;
        }),
    );
    const staleHub = {
      getToolDefs: vi.fn().mockReturnValue([]),
      getServerConfig: vi.fn(),
      callTool: vi.fn(),
    };
    const currentHub = {
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
    const release = vi.fn();
    const acquireCurrentMcpHub = vi.fn(() => ({
      projectId: "project",
      generation: 2,
      hub: currentHub as any,
      retain: vi.fn(),
      release,
    }));

    const resultPromise = dispatchToolCall(
      "call_mcp_tool",
      { server: "linear", tool: "list_issues", input: { query: "bug" } },
      {
        ...mockCtx,
        approvalManager: {
          isMcpApproved: vi.fn().mockReturnValue(false),
        } as any,
        onApprovalRequest,
        mcpHub: staleHub as any,
        acquireCurrentMcpHub,
      },
    );

    await vi.waitFor(() => expect(onApprovalRequest).toHaveBeenCalledOnce());
    expect(currentHub.getToolDefs).toHaveBeenCalledOnce();
    expect(currentHub.getServerConfig).toHaveBeenCalledWith("linear");
    expect(currentHub.callTool).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect(staleHub.getToolDefs).not.toHaveBeenCalled();

    resolveApproval("allow-once");
    await resultPromise;

    expect(acquireCurrentMcpHub).toHaveBeenCalledOnce();
    expect(currentHub.callTool).toHaveBeenCalledWith(
      "linear__list_issues",
      { query: "bug" },
      { signal: undefined },
    );
    expect(staleHub.callTool).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
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
      projectRoot: "/tmp/project",
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
        mcpServerName: "linear",
        mcpToolName: "list_issues",
        targetPath: "/tmp/project/.agentlink/mcp.json",
        choices: expect.arrayContaining([
          expect.objectContaining({
            value: "always-server-session",
          }),
        ]),
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

  it("blocks unannotated deferred MCP calls in read-only backgrounds", async () => {
    const onApprovalRequest = vi.fn().mockResolvedValue("allow-once");
    const mcpHub = {
      getReadOnlyToolDefs: vi.fn().mockReturnValue([
        {
          name: "linear__list_issues",
          description: "List issues",
          input_schema: { type: "object", properties: {} },
        },
      ]),
      isToolReadOnly: vi.fn(
        (_server: string, tool: string) => tool === "list_issues",
      ),
      getServerConfig: vi.fn().mockReturnValue(undefined),
      callTool: vi.fn().mockResolvedValue({
        content: [{ type: "text", text: JSON.stringify({ ok: true }) }],
      }),
    };
    const ctx = {
      ...mockCtx,
      approvalManager: {
        isMcpApproved: vi.fn().mockReturnValue(true),
      } as any,
      onApprovalRequest,
      mcpHub: mcpHub as any,
      mcpToolAccess: "read-only" as const,
    };

    await expect(
      dispatchToolCall(
        "call_mcp_tool",
        { server: "linear", tool: "list_issues", input: {} },
        ctx,
      ),
    ).resolves.toMatchObject({ content: expect.any(Array) });
    const blocked = await dispatchToolCall(
      "call_mcp_tool",
      { server: "linear", tool: "create_issue", input: {} },
      ctx,
    );

    expect((blocked.content[0] as { text: string }).text).toContain(
      "MCP tool not found: linear__create_issue",
    );
    expect(mcpHub.callTool).toHaveBeenCalledTimes(1);
    expect(mcpHub.callTool).toHaveBeenCalledWith(
      "linear__list_issues",
      {},
      { signal: undefined },
    );
    expect(onApprovalRequest).not.toHaveBeenCalled();
  });

  it("sends the full MCP input in the approval detail and truncates only oversized payloads", async () => {
    const onApprovalRequest = vi.fn().mockResolvedValue("allow-once");
    const mcpHub = {
      getServerConfig: vi.fn().mockReturnValue(undefined),
      callTool: vi.fn().mockResolvedValue({
        content: [{ type: "text", text: JSON.stringify({ ok: true }) }],
      }),
    };
    const ctx = {
      ...mockCtx,
      approvalManager: {
        isMcpApproved: vi.fn().mockReturnValue(false),
        approveMcpTool: vi.fn(),
      } as any,
      onApprovalRequest,
      mcpHub: mcpHub as any,
    };

    const longInput = { description: "x".repeat(2_000) };
    await dispatchToolCall("linear__create_issue", longInput, ctx);
    expect(onApprovalRequest.mock.calls[0][0].detail).toBe(
      JSON.stringify(longInput, null, 2),
    );

    const oversizedInput = { blob: "y".repeat(30_000) };
    await dispatchToolCall("linear__create_issue", oversizedInput, ctx);
    const detail = onApprovalRequest.mock.calls[1][0].detail as string;
    expect(detail.length).toBeLessThan(21_000);
    expect(detail).toMatch(/… \[input truncated: \d+ more characters\]$/);
  });

  it("allows every tool from an MCP server for the rest of the session", async () => {
    const onApprovalRequest = vi
      .fn()
      .mockResolvedValue("always-server-session");
    const approveMcpServer = vi.fn();
    const approveMcpTool = vi.fn();
    const mcpHub = {
      getServerConfig: vi.fn().mockReturnValue(undefined),
      callTool: vi.fn().mockResolvedValue({
        content: [{ type: "text", text: JSON.stringify({ ok: true }) }],
      }),
    };

    await dispatchToolCall(
      "linear__list_issues",
      { query: "bug" },
      {
        ...mockCtx,
        approvalManager: {
          isMcpApproved: vi.fn().mockReturnValue(false),
          approveMcpServer,
          approveMcpTool,
        } as any,
        onApprovalRequest,
        mcpHub: mcpHub as any,
      },
    );

    expect(approveMcpServer).toHaveBeenCalledWith("test-session", "linear");
    expect(approveMcpTool).not.toHaveBeenCalled();
    expect(mcpHub.callTool).toHaveBeenCalledWith(
      "linear__list_issues",
      { query: "bug" },
      { signal: undefined },
    );
  });

  it("does not run an MCP tool when its persistent approval cannot be saved", async () => {
    const invalidProjectRoot = path.join(
      os.tmpdir(),
      `agentlink-mcp-approval-${Date.now()}`,
    );
    fs.writeFileSync(invalidProjectRoot, "not a directory");
    const approveMcpTool = vi.fn();
    const mcpHub = {
      getServerConfig: vi.fn().mockReturnValue(undefined),
      callTool: vi.fn(),
    };

    try {
      const result = await dispatchToolCall(
        "linear__list_issues",
        { query: "bug" },
        {
          ...mockCtx,
          projectRoot: invalidProjectRoot,
          approvalManager: {
            isMcpApproved: vi.fn().mockReturnValue(false),
            approveMcpTool,
          } as any,
          onApprovalRequest: vi.fn().mockResolvedValue("always-tool-project"),
          mcpHub: mcpHub as any,
        },
      );

      const payload = JSON.parse(
        (result.content[0] as { type: "text"; text: string }).text,
      );
      expect(payload.error).toMatch(
        /Could not save the project MCP tool approval/,
      );
      expect(approveMcpTool).not.toHaveBeenCalled();
      expect(mcpHub.callTool).not.toHaveBeenCalled();
    } finally {
      fs.unlinkSync(invalidProjectRoot);
    }
  });

  it("returns the typed rejection reason and follow-up when the user denies an MCP tool", async () => {
    const onApprovalRequest = vi.fn().mockResolvedValue({
      decision: "deny",
      rejectionReason: "Wrong Linear team; use the ENG workspace.",
      followUp: "List projects first so we can pick the right one.",
    });
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
      { server: "linear", tool: "list_issues", input: { query: "bug" } },
      {
        ...mockCtx,
        approvalManager: {
          isMcpApproved: vi.fn().mockReturnValue(false),
        } as any,
        onApprovalRequest,
        mcpHub: mcpHub as any,
      },
    );

    expect(mcpHub.callTool).not.toHaveBeenCalled();
    const parsed = JSON.parse(
      (result.content[0] as { type: "text"; text: string }).text,
    );
    expect(parsed).toEqual({
      status: "rejected_by_user",
      error: "User denied MCP tool execution",
      reason: "Wrong Linear team; use the ENG workspace.",
      follow_up: "List projects first so we can pick the right one.",
    });
  });

  it("treats unknown approval decisions as deny for MCP tools", async () => {
    const onApprovalRequest = vi.fn().mockResolvedValue("reject");
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
      { server: "linear", tool: "list_issues", input: {} },
      {
        ...mockCtx,
        approvalManager: {
          isMcpApproved: vi.fn().mockReturnValue(false),
        } as any,
        onApprovalRequest,
        mcpHub: mcpHub as any,
      },
    );

    expect(mcpHub.callTool).not.toHaveBeenCalled();
    const parsed = JSON.parse(
      (result.content[0] as { type: "text"; text: string }).text,
    );
    expect(parsed.status).toBe("rejected_by_user");
  });

  it("appends the approval follow-up to the MCP tool result", async () => {
    const onApprovalRequest = vi.fn().mockResolvedValue({
      decision: "allow-once",
      followUp: "Only look at issues from this sprint.",
    });
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
        content: [{ type: "text", text: JSON.stringify({ issues: [] }) }],
      }),
    };

    const result = await dispatchToolCall(
      "call_mcp_tool",
      { server: "linear", tool: "list_issues", input: { query: "bug" } },
      {
        ...mockCtx,
        approvalManager: {
          isMcpApproved: vi.fn().mockReturnValue(false),
        } as any,
        onApprovalRequest,
        mcpHub: mcpHub as any,
      },
    );

    expect(mcpHub.callTool).toHaveBeenCalled();
    expect(result.content).toHaveLength(2);
    const followUpBlock = JSON.parse(
      (result.content[1] as { type: "text"; text: string }).text,
    );
    expect(followUpBlock).toEqual({
      follow_up: "Only look at issues from this sprint.",
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

  it("validates and dispatches fleet automation management", async () => {
    const onManageFleetAutomations = vi.fn().mockResolvedValue([{ id: "a1" }]);
    const result = await dispatchToolCall(
      "manage_fleet_automations",
      { action: "history", id: "a1" },
      { ...mockCtx, onManageFleetAutomations },
    );

    expect(onManageFleetAutomations).toHaveBeenCalledWith({
      action: "history",
      id: "a1",
    });
    expect((result.content[0] as { text: string }).text).toContain("a1");

    const invalid = await dispatchToolCall(
      "manage_fleet_automations",
      { action: "destroy" },
      { ...mockCtx, onManageFleetAutomations },
    );
    expect((invalid.content[0] as { text: string }).text).toContain(
      "Invalid fleet automation action",
    );
    expect(onManageFleetAutomations).toHaveBeenCalledTimes(1);
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
      projectRoot: "/tmp/project",
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

  it("keeps MCP approval promotion metadata when invocation provider returns an error", async () => {
    const onApprovalRequest = vi.fn().mockResolvedValue("allow-once");
    const mcpToolInvocationProvider = {
      getToolDefs: vi.fn(),
      getServerConfig: vi.fn().mockReturnValue(undefined),
      callTool: vi.fn().mockRejectedValue(new Error("provider failed")),
    };

    const result = await dispatchToolCall(
      "notion__search",
      { query: "docs" },
      {
        ...mockCtx,
        approvalManager: {
          isMcpApproved: vi.fn().mockReturnValue(false),
        } as any,
        onApprovalRequest,
        mcpToolInvocationProvider,
      },
    );

    expect(onApprovalRequest).toHaveBeenCalled();
    expect(mcpToolInvocationProvider.callTool).toHaveBeenCalledWith({
      toolName: "notion__search",
      input: { query: "docs" },
      signal: undefined,
    });
    expect((result.content[0] as { text: string }).text).toContain(
      "provider failed",
    );
    expect(result.uiMeta?.mcpApprovalPromotion).toEqual({
      serverName: "notion",
      bareToolName: "search",
      scopes: ["session", "project", "global"],
    });
  });
});
