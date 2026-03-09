/**
 * Tool adapter for the built-in agent.
 *
 * Converts shared zod schemas to Claude SDK tool definitions and dispatches
 * tool calls to the existing handler functions in src/tools/*.ts.
 */

import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import * as vscode from "vscode";
import type { ApprovalManager } from "../approvals/ApprovalManager.js";
import type { ApprovalPanelProvider } from "../approvals/ApprovalPanelProvider.js";
import type { ToolResult } from "../shared/types.js";
import { TOOL_REGISTRY } from "../shared/toolRegistry.js";
import * as schemas from "../shared/toolSchemas.js";
import type { AgentMode } from "./modes.js";
import { getToolsForMode } from "./toolPermissions.js";
import { McpClientHub } from "./McpClientHub.js";
import {
  getMcpConfigFilePaths,
  persistMcpToolApproval,
  persistMcpServerApproval,
} from "./mcpConfig.js";

// --- Handler imports ---
import { handleReadFile } from "../tools/readFile.js";
import { handleListFiles } from "../tools/listFiles.js";
import { handleSearchFiles } from "../tools/searchFiles.js";
import { handleWriteFile } from "../tools/writeFile.js";
import { handleApplyDiff } from "../tools/applyDiff.js";
import { handleFindAndReplace } from "../tools/findAndReplace.js";
import { handleExecuteCommand } from "../tools/executeCommand.js";
import { handleGetTerminalOutput } from "../tools/getTerminalOutput.js";
import { handleCloseTerminals } from "../tools/closeTerminals.js";
import { handleOpenFile } from "../tools/openFile.js";
import { handleShowNotification } from "../tools/showNotification.js";
import { handleGetDiagnostics } from "../tools/getDiagnostics.js";
import { handleGoToDefinition } from "../tools/goToDefinition.js";
import { handleGoToImplementation } from "../tools/goToImplementation.js";
import { handleGoToTypeDefinition } from "../tools/goToTypeDefinition.js";
import { handleGetReferences } from "../tools/getReferences.js";
import { handleGetSymbols } from "../tools/getSymbols.js";
import { handleGetHover } from "../tools/getHover.js";
import { handleGetCompletions } from "../tools/getCompletions.js";
import {
  handleGetCodeActions,
  handleApplyCodeAction,
} from "../tools/codeActions.js";
import { handleGetCallHierarchy } from "../tools/getCallHierarchy.js";
import { handleGetTypeHierarchy } from "../tools/getTypeHierarchy.js";
import { handleGetInlayHints } from "../tools/getInlayHints.js";
import { handleRenameSymbol } from "../tools/renameSymbol.js";

// --- Read-only tools (safe to execute in parallel) ---

export const READ_ONLY_TOOLS = new Set([
  "read_file",
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
  "switch_mode",
  "spawn_background_agent",
  "get_background_status",
  "get_background_result",
]);

// --- Tools excluded from the agent (MCP-only or not applicable) ---

const EXCLUDED_TOOLS = new Set([
  "handshake",
  "send_feedback",
  "get_feedback",
  "delete_feedback",
]);

// --- Zod schema record → JSON Schema conversion ---

function zodSchemaToJsonSchema(
  schema: Record<string, z.ZodTypeAny>,
): Anthropic.Tool["input_schema"] {
  const obj = z.object(schema);
  // Zod v4 has built-in JSON Schema support (zod-to-json-schema doesn't support v4)
  const jsonSchema = z.toJSONSchema(obj) as Record<string, unknown>;
  const { $schema: _, ...rest } = jsonSchema;
  return rest as Anthropic.Tool["input_schema"];
}

// --- Tool name → zod schema mapping ---

const TOOL_SCHEMAS: Record<string, Record<string, z.ZodTypeAny>> = {
  read_file: schemas.readFileSchema,
  list_files: schemas.listFilesSchema,
  search_files: schemas.searchFilesSchema,
  get_diagnostics: schemas.getDiagnosticsSchema,
  write_file: schemas.writeFileSchema,
  apply_diff: schemas.applyDiffSchema,
  find_and_replace: schemas.findAndReplaceSchema,
  rename_symbol: schemas.renameSymbolSchema,
  open_file: schemas.openFileSchema,
  show_notification: schemas.showNotificationSchema,
  execute_command: schemas.executeCommandSchema,
  get_terminal_output: schemas.getTerminalOutputSchema,
  close_terminals: schemas.closeTerminalsSchema,
  go_to_definition: schemas.positionSchema,
  go_to_implementation: schemas.positionSchema,
  go_to_type_definition: schemas.positionSchema,
  get_hover: schemas.positionSchema,
  get_references: schemas.getReferencesSchema,
  get_symbols: schemas.getSymbolsSchema,
  get_completions: schemas.getCompletionsSchema,
  get_code_actions: schemas.getCodeActionsSchema,
  apply_code_action: schemas.applyCodeActionSchema,
  get_call_hierarchy: schemas.getCallHierarchySchema,
  get_type_hierarchy: schemas.getTypeHierarchySchema,
  get_inlay_hints: schemas.getInlayHintsSchema,
  codebase_search: schemas.codebaseSearchSchema,
};

const MCP_META_TOOLS: Anthropic.Tool[] = [
  {
    name: "list_mcp_resources",
    description: "List all resources available from connected MCP servers.",
    input_schema: {
      type: "object",
      properties: {},
    } as Anthropic.Tool["input_schema"],
  },
  {
    name: "read_mcp_resource",
    description: "Read a resource from an MCP server by URI.",
    input_schema: {
      type: "object",
      properties: {
        server: { type: "string", description: "Server name" },
        uri: { type: "string", description: "Resource URI" },
      },
      required: ["server", "uri"],
    } as Anthropic.Tool["input_schema"],
  },
  {
    name: "list_mcp_prompts",
    description:
      "List all prompt templates available from connected MCP servers.",
    input_schema: {
      type: "object",
      properties: {},
    } as Anthropic.Tool["input_schema"],
  },
  {
    name: "get_mcp_prompt",
    description:
      "Get a prompt template from an MCP server, optionally filling in arguments.",
    input_schema: {
      type: "object",
      properties: {
        server: { type: "string", description: "Server name" },
        name: { type: "string", description: "Prompt name" },
        arguments: { type: "object", description: "Optional prompt arguments" },
      },
      required: ["server", "name"],
    } as Anthropic.Tool["input_schema"],
  },
];

/** Schema for the ask_user tool (always available in all modes). */
const ASK_USER_TOOL: Anthropic.Tool = {
  name: "ask_user",
  description:
    "Ask the user one or more questions and wait for their responses before continuing. Use this proactively to clarify intent, gather preferences, or present choices — rather than guessing or making assumptions. Supports multiple question types in a single call.",
  input_schema: {
    type: "object",
    properties: {
      questions: {
        type: "array",
        description:
          "The questions to ask. All are shown at once; the user answers all before you continue.",
        items: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description:
                "Unique identifier for this question (used to map answers back)",
            },
            type: {
              type: "string",
              enum: [
                "multiple_choice",
                "multiple_select",
                "yes_no",
                "text",
                "scale",
                "confirmation",
              ],
              description:
                "multiple_choice: pick one; multiple_select: pick many; yes_no: boolean; text: free-form; scale: numeric rating; confirmation: acknowledgement gate",
            },
            question: {
              type: "string",
              description: "The question text shown to the user",
            },
            options: {
              type: "array",
              items: { type: "string" },
              description:
                "Answer options (required for multiple_choice and multiple_select)",
            },
            scale_min: {
              type: "number",
              description: "Scale minimum (default: 1)",
            },
            scale_max: {
              type: "number",
              description: "Scale maximum (default: 5)",
            },
            scale_min_label: {
              type: "string",
              description: "Label for the low end of the scale",
            },
            scale_max_label: {
              type: "string",
              description: "Label for the high end of the scale",
            },
          },
          required: ["id", "type", "question"],
        },
      },
    },
    required: ["questions"],
  } as Anthropic.Tool["input_schema"],
};

/** Schema for the switch_mode meta-tool (always available, regardless of mode). */
const SWITCH_MODE_TOOL: Anthropic.Tool = {
  name: "switch_mode",
  description:
    "Request to switch the current agent mode (e.g. from 'code' to 'architect'). The user must approve the switch. Available modes: code, architect, ask, debug.",
  input_schema: {
    type: "object",
    properties: {
      mode: {
        type: "string",
        description: "Target mode slug (code | architect | ask | debug)",
      },
      reason: {
        type: "string",
        description: "Brief explanation of why switching mode is helpful",
      },
    },
    required: ["mode"],
  } as Anthropic.Tool["input_schema"],
};

/** Background agent management tools (only available in foreground sessions). */
const BG_AGENT_TOOLS: Anthropic.Tool[] = [
  {
    name: "spawn_background_agent",
    description:
      "Spawn a background agent to work on a task in parallel with the current session. Returns immediately with a sessionId — the background agent starts running concurrently. Use this when tasks can proceed independently: research while you implement, run diagnostics while you document, explore two approaches at once. Call get_background_result(sessionId) when you need the result.",
    input_schema: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "Short label shown in the UI (max 50 chars)",
        },
        message: {
          type: "string",
          description:
            "Full instruction for the background agent. Be specific and self-contained — it has no other context.",
        },
      },
      required: ["task", "message"],
    } as Anthropic.Tool["input_schema"],
  },
  {
    name: "get_background_status",
    description:
      "Non-blocking check on a background agent's progress. Returns immediately with current status and whether it's done. Use this to check if a background agent has finished before deciding whether to call get_background_result, or to show progress while doing other work.",
    input_schema: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          description: "The sessionId returned by spawn_background_agent",
        },
      },
      required: ["sessionId"],
    } as Anthropic.Tool["input_schema"],
  },
  {
    name: "get_background_result",
    description:
      "Wait for a background agent to finish and return its final response. Blocks until the session completes. Call this when you are ready to use the background agent's output.",
    input_schema: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          description: "The sessionId returned by spawn_background_agent",
        },
      },
      required: ["sessionId"],
    } as Anthropic.Tool["input_schema"],
  },
];

/** Return value of get_background_status — non-blocking snapshot. */
export interface BgStatusResult {
  status:
    | "streaming"
    | "tool_executing"
    | "awaiting_approval"
    | "idle"
    | "error";
  currentTool?: string;
  done: boolean;
  /** Last assistant message text, only present when done=true. */
  partialOutput?: string;
}

// --- Public API ---

/**
 * Get tool definitions formatted for the Claude SDK.
 * When mode is provided, only tools allowed by the mode's toolGroups are included.
 * MCP tools (prefixed 'server__tool') are passed as external Anthropic.Tool objects.
 * When isBackground is true, background agent management tools are excluded.
 */
export function getAgentTools(
  mode?: AgentMode,
  mcpToolDefs?: Anthropic.Tool[],
  isBackground?: boolean,
): Anthropic.Tool[] {
  const mcpToolNames = (mcpToolDefs ?? []).map((t) => t.name);
  const allowed = mode ? getToolsForMode(mode, mcpToolNames) : null;

  const nativeTools = Object.entries(TOOL_SCHEMAS)
    .filter(([name]) => !EXCLUDED_TOOLS.has(name))
    .filter(([name]) => !allowed || allowed.has(name))
    .map(([name, zodSchema]) => ({
      name,
      description: TOOL_REGISTRY[name]?.description ?? name,
      input_schema: zodSchemaToJsonSchema(
        zodSchema,
      ) as Anthropic.Tool["input_schema"],
    }));

  // Append MCP tools if the mode allows the 'mcp' group
  const allowedMcpTools =
    !mode || (mode.toolGroups.includes("mcp") && mcpToolDefs)
      ? (mcpToolDefs ?? [])
      : [];

  // Meta-tools and ask_user are always available regardless of mode restrictions.
  // Background agents are excluded from switch_mode and spawn tools to prevent
  // inadvertent foreground mode changes and nested spawning.
  return [
    ...nativeTools,
    ...allowedMcpTools,
    ...MCP_META_TOOLS,
    ASK_USER_TOOL,
    ...(isBackground ? [] : [SWITCH_MODE_TOOL, ...BG_AGENT_TOOLS]),
  ];
}

/**
 * Context needed by the tool dispatcher.
 */
export interface QuestionResponse {
  answers: Record<string, string | string[] | number | boolean | undefined>;
  notes: Record<string, string>;
}

export interface ToolDispatchContext {
  approvalManager: ApprovalManager;
  approvalPanel: ApprovalPanelProvider;
  sessionId: string;
  extensionUri: import("vscode").Uri;
  mcpHub?: McpClientHub;
  onModeSwitch?: (mode: string, reason?: string) => void;
  onApprovalRequest?: import("../shared/types.js").OnApprovalRequest;
  onQuestion?: (
    questions: import("../agent/webview/types.js").Question[],
    sessionId: string,
  ) => Promise<QuestionResponse>;
  /** Called whenever the agent reads a file — used to track files for folded context on condense */
  onFileRead?: (filePath: string) => void;
  /** Spawn a background agent session. Returns the new session's ID immediately. */
  onSpawnBackground?: (task: string, message: string) => Promise<string>;
  /** Non-blocking status check for a background session. */
  onGetBackgroundStatus?: (sessionId: string) => BgStatusResult;
  /** Wait for a background session to finish and return its last assistant message. */
  onGetBackgroundResult?: (sessionId: string) => Promise<string>;
}

/**
 * Dispatch a tool call to the appropriate handler.
 * Returns ToolResult compatible with the Anthropic SDK.
 */
export async function dispatchToolCall(
  toolName: string,
  input: Record<string, unknown>,
  ctx: ToolDispatchContext,
): Promise<ToolResult> {
  const {
    approvalManager,
    approvalPanel,
    sessionId,
    extensionUri,
    mcpHub,
    onApprovalRequest,
  } = ctx;

  // Route MCP tools (prefixed with 'servername__') to the MCP hub
  if (McpClientHub.isMcpTool(toolName)) {
    if (!mcpHub) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: "MCP hub not available" }),
          },
        ],
      };
    }

    // Check approval policy
    const serverName = toolName.split("__")[0];
    const serverConfig = mcpHub.getServerConfig(serverName);
    const bareToolName = toolName.slice(serverName.length + 2);
    const isAutoApproved =
      serverConfig?.toolPolicy === "allow" ||
      serverConfig?.allowedTools?.includes(bareToolName) ||
      approvalManager.isMcpApproved(sessionId, toolName);

    if (!isAutoApproved) {
      const inputPreview = JSON.stringify(input, null, 2).slice(0, 600);
      let choice: string;

      const cwd =
        vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
      const configPaths = getMcpConfigFilePaths(cwd);

      if (onApprovalRequest) {
        const raw = await onApprovalRequest({
          kind: "mcp",
          title: `Allow MCP tool "${bareToolName}" from "${serverName}"?`,
          detail: inputPreview,
          choices: [
            { label: "Allow once", value: "allow-once", isPrimary: true },
            {
              label: "Always allow tool (session)",
              value: "always-tool-session",
            },
            {
              label: "Always allow tool (project)",
              value: "always-tool-project",
            },
            {
              label: "Always allow tool (global)",
              value: "always-tool-global",
            },
            {
              label: `Always allow ${serverName} (project)`,
              value: "always-server-project",
            },
            {
              label: `Always allow ${serverName} (global)`,
              value: "always-server-global",
            },
            { label: "Deny", value: "deny", isDanger: true },
          ],
        });
        choice = typeof raw === "string" ? raw : raw.decision;
      } else {
        // Fallback VS Code modal (no inline card available)
        const alwaysAllowServer = `Always allow from ${serverName}` as const;
        const vsChoice = await vscode.window.showWarningMessage(
          `Allow MCP tool "${bareToolName}" from "${serverName}"?`,
          { modal: true, detail: inputPreview },
          "Allow once",
          "Always allow this tool",
          alwaysAllowServer,
          "Deny",
        );
        choice =
          vsChoice === "Allow once"
            ? "allow-once"
            : vsChoice === "Always allow this tool"
              ? "always-tool-project"
              : vsChoice === alwaysAllowServer
                ? "always-server-project"
                : "deny";
      }

      if (choice === "deny" || !choice) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: "User denied MCP tool execution" }),
            },
          ],
        };
      }

      switch (choice) {
        case "always-tool-session":
          approvalManager.approveMcpTool(sessionId, toolName);
          break;
        case "always-tool-project":
          approvalManager.approveMcpTool(sessionId, toolName);
          persistMcpToolApproval(
            serverName,
            bareToolName,
            configPaths.project,
          ).catch(() => undefined);
          break;
        case "always-tool-global":
          approvalManager.approveMcpTool(sessionId, toolName);
          persistMcpToolApproval(
            serverName,
            bareToolName,
            configPaths.global,
          ).catch(() => undefined);
          break;
        case "always-server-project":
          approvalManager.approveMcpServer(sessionId, serverName);
          persistMcpServerApproval(serverName, configPaths.project).catch(
            () => undefined,
          );
          break;
        case "always-server-global":
          approvalManager.approveMcpServer(sessionId, serverName);
          persistMcpServerApproval(serverName, configPaths.global).catch(
            () => undefined,
          );
          break;
        // "allow-once" — no extra action needed
      }
    }

    const result = await mcpHub.callTool(toolName, input);
    return result;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const params = input as any;

  switch (toolName) {
    // --- File reading ---
    case "read_file":
      if (ctx.onFileRead && typeof params.path === "string") {
        ctx.onFileRead(params.path);
      }
      return handleReadFile(params, approvalManager, approvalPanel, sessionId);
    case "list_files":
      return handleListFiles(params, approvalManager, approvalPanel, sessionId);
    case "search_files":
      return handleSearchFiles(
        params,
        approvalManager,
        approvalPanel,
        sessionId,
      );

    // --- File writing ---
    case "write_file":
      return handleWriteFile(
        params,
        approvalManager,
        approvalPanel,
        sessionId,
        onApprovalRequest,
      );
    case "apply_diff":
      return handleApplyDiff(
        params,
        approvalManager,
        approvalPanel,
        sessionId,
        onApprovalRequest,
      );
    case "find_and_replace":
      return handleFindAndReplace(
        params,
        approvalManager,
        approvalPanel,
        sessionId,
        extensionUri,
        onApprovalRequest,
      );
    case "rename_symbol":
      return handleRenameSymbol(
        params,
        approvalManager,
        approvalPanel,
        sessionId,
        onApprovalRequest,
      );

    // --- Terminal ---
    case "execute_command":
      return handleExecuteCommand(
        params,
        approvalManager,
        approvalPanel,
        sessionId,
        undefined,
        onApprovalRequest,
      );
    case "get_terminal_output":
      return handleGetTerminalOutput(params);
    case "close_terminals":
      return handleCloseTerminals(params);

    // --- Editor ---
    case "open_file":
      return handleOpenFile(params, approvalManager, approvalPanel, sessionId);
    case "show_notification":
      return handleShowNotification(params);

    // --- Diagnostics & language ---
    case "get_diagnostics":
      return handleGetDiagnostics(params);
    case "go_to_definition":
      return handleGoToDefinition(
        params,
        approvalManager,
        approvalPanel,
        sessionId,
      );
    case "go_to_implementation":
      return handleGoToImplementation(
        params,
        approvalManager,
        approvalPanel,
        sessionId,
      );
    case "go_to_type_definition":
      return handleGoToTypeDefinition(
        params,
        approvalManager,
        approvalPanel,
        sessionId,
      );
    case "get_references":
      return handleGetReferences(
        params,
        approvalManager,
        approvalPanel,
        sessionId,
      );
    case "get_symbols":
      return handleGetSymbols(
        params,
        approvalManager,
        approvalPanel,
        sessionId,
      );
    case "get_hover":
      return handleGetHover(params, approvalManager, approvalPanel, sessionId);
    case "get_completions":
      return handleGetCompletions(
        params,
        approvalManager,
        approvalPanel,
        sessionId,
      );
    case "get_code_actions":
      return handleGetCodeActions(
        params,
        approvalManager,
        approvalPanel,
        sessionId,
      );
    case "apply_code_action":
      return handleApplyCodeAction(params, sessionId);
    case "get_call_hierarchy":
      return handleGetCallHierarchy(
        params,
        approvalManager,
        approvalPanel,
        sessionId,
      );
    case "get_type_hierarchy":
      return handleGetTypeHierarchy(
        params,
        approvalManager,
        approvalPanel,
        sessionId,
      );
    case "get_inlay_hints":
      return handleGetInlayHints(
        params,
        approvalManager,
        approvalPanel,
        sessionId,
      );

    // --- Search ---
    case "codebase_search": {
      const { semanticSearch } = await import("../services/semanticSearch.js");
      const { resolveAndValidatePath, tryGetFirstWorkspaceRoot } =
        await import("../util/paths.js");
      const dirPath = params.path
        ? resolveAndValidatePath(String(params.path)).absolutePath
        : (tryGetFirstWorkspaceRoot() ?? ".");
      return semanticSearch(dirPath, String(params.query), params.limit);
    }

    case "list_mcp_resources": {
      if (!mcpHub)
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: "MCP hub not available" }),
            },
          ],
        };
      const resources = mcpHub.getAllResources();
      return {
        content: [{ type: "text", text: JSON.stringify(resources, null, 2) }],
      };
    }

    case "read_mcp_resource": {
      if (!mcpHub)
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: "MCP hub not available" }),
            },
          ],
        };
      return mcpHub.readResource(
        String(params.server ?? ""),
        String(params.uri ?? ""),
      );
    }

    case "list_mcp_prompts": {
      if (!mcpHub)
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: "MCP hub not available" }),
            },
          ],
        };
      const prompts = mcpHub.getAllPrompts();
      return {
        content: [{ type: "text", text: JSON.stringify(prompts, null, 2) }],
      };
    }

    case "get_mcp_prompt": {
      if (!mcpHub)
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: "MCP hub not available" }),
            },
          ],
        };
      const args = params.arguments as Record<string, string> | undefined;
      return mcpHub.getPrompt(
        String(params.server ?? ""),
        String(params.name ?? ""),
        args,
      );
    }

    case "ask_user": {
      if (!ctx.onQuestion) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: "Question handler not available" }),
            },
          ],
        };
      }
      const questions =
        params.questions as import("../agent/webview/types.js").Question[];
      const response = await ctx.onQuestion(questions, ctx.sessionId);
      // Format as a readable responses array so Claude sees question + answer + note together
      const responses = questions.map((q) => {
        const answer = response.answers[q.id];
        const note = response.notes[q.id];
        const entry: Record<string, unknown> = {
          question: q.question,
          answer: answer ?? null,
        };
        if (note) entry.note = note;
        return entry;
      });
      return {
        content: [{ type: "text", text: JSON.stringify({ responses }) }],
      };
    }

    case "switch_mode": {
      const mode = String(params.mode ?? "");
      const reason = params.reason ? String(params.reason) : undefined;
      ctx.onModeSwitch?.(mode, reason);
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: true, mode }) }],
      };
    }

    case "spawn_background_agent": {
      if (!ctx.onSpawnBackground) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: "Background agents not available",
              }),
            },
          ],
        };
      }
      const bgId = await ctx.onSpawnBackground(
        String(params.task ?? ""),
        String(params.message ?? ""),
      );
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ sessionId: bgId, status: "started" }),
          },
        ],
      };
    }

    case "get_background_status": {
      if (!ctx.onGetBackgroundStatus) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: "Background agents not available",
              }),
            },
          ],
        };
      }
      const statusResult = ctx.onGetBackgroundStatus(
        String(params.sessionId ?? ""),
      );
      return {
        content: [{ type: "text", text: JSON.stringify(statusResult) }],
      };
    }

    case "get_background_result": {
      if (!ctx.onGetBackgroundResult) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: "Background agents not available",
              }),
            },
          ],
        };
      }
      const bgResult = await ctx.onGetBackgroundResult(
        String(params.sessionId ?? ""),
      );
      return {
        content: [{ type: "text", text: bgResult }],
      };
    }

    default:
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: `Unknown tool: ${toolName}` }),
          },
        ],
      };
  }
}
