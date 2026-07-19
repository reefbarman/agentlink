/**
 * Tool adapter for the built-in agent.
 *
 * Converts shared zod schemas to Claude SDK tool definitions and dispatches
 * tool calls to the existing handler functions in src/tools/*.ts.
 */

import * as schemas from "../shared/toolSchemas.js";
import * as vscode from "vscode";

import type { JsonSchema, ToolDefinition } from "./providers/types.js";
import type {
  AgentToolExecutionRequest,
  AgentToolRuntime,
} from "../core/tools/types.js";
import type { BackgroundAgentStatusResult } from "../core/capabilities/background.js";
import { PARALLEL_SAFE_TOOLS } from "../core/tools/toolCapabilities.js";
import type {
  SpawnBackgroundRequest,
  SpawnBackgroundResult,
} from "./backgroundTypes.js";
import type {
  FleetWorkflowKind,
  FleetWorkflowOutcome,
  FleetWorkflowRequest,
} from "./FleetWorkflows.js";
import { isFleetResultEnvelope } from "./FleetWorkflows.js";
import type { FleetAutomation } from "./FleetAutomationStore.js";
import {
  getMcpConfigFilePaths,
  persistMcpServerApproval,
  persistMcpToolApproval,
} from "./mcpConfig.js";
import {
  handleApplyCodeAction,
  handleGetCodeActions,
} from "../tools/codeActions.js";

import type { AgentMode } from "./modes.js";
import type { ApprovalManager } from "../approvals/ApprovalManager.js";
import type { ApprovalPanelProvider } from "../approvals/ApprovalPanelProvider.js";
import type { CommandApprovalPolicy } from "../approvals/commandApprovalPolicy.js";
import type { CommandApprovalReviewer } from "../approvals/commandApprovalReview.js";
import type { FinalMessageMarker } from "../shared/finalStatus.js";
import { McpClientHub } from "./McpClientHub.js";
import type { Question } from "./webview/types.js";
import { TOOL_REGISTRY } from "../shared/toolRegistry.js";
import {
  CALL_MCP_TOOL_DEFINITION,
  MCP_META_TOOL_DEFINITIONS,
} from "../shared/mcpToolDefinitions.js";
import type { TodoItem } from "./todoTool.js";
import {
  errorResult,
  handleToolError,
  jsonResult,
  type ToolResult,
} from "../shared/types.js";
import { getToolsForMode } from "./toolPermissions.js";
import { handleApplyDiff } from "../tools/applyDiff.js";
import { handleCloseTerminals } from "../tools/closeTerminals.js";
import { handleDeleteFeedback } from "../tools/deleteFeedback.js";
import { handleExecuteCommand } from "../tools/executeCommand.js";
import { handleFindAndReplace } from "../tools/findAndReplace.js";
import { handleGenerateImage } from "../tools/generateImage.js";
import { handleGetCallHierarchy } from "../tools/getCallHierarchy.js";
import { handleGetCompletions } from "../tools/getCompletions.js";
import { handleGetContext } from "../tools/context/getContext.js";
import { handleGetDiagnostics } from "../tools/getDiagnostics.js";
import { handleGetFeedback } from "../tools/getFeedback.js";
import { handleGetHover } from "../tools/getHover.js";
import { handleGetInlayHints } from "../tools/getInlayHints.js";
import { handleGetModuleNeighbors } from "../tools/getModuleNeighbors.js";
import { handleGetReferences } from "../tools/getReferences.js";
import { handleGetRepoMap } from "../tools/getRepoMap.js";
import { handleGetSymbols } from "../tools/getSymbols.js";
import { handleGetTerminalOutput } from "../tools/getTerminalOutput.js";
import { handleGetTypeHierarchy } from "../tools/getTypeHierarchy.js";
import { handleGoToDefinition } from "../tools/goToDefinition.js";
import { handleGoToImplementation } from "../tools/goToImplementation.js";
import { handleGoToTypeDefinition } from "../tools/goToTypeDefinition.js";
import { handleListFiles } from "../tools/listFiles.js";
import {
  createVscodeEditorRevealProvider,
  createVscodeEditReviewProvider,
  createVscodeMultiFileEditReviewProvider,
  createVscodeRenameSymbolProvider,
  createVscodeWriteApprovalPolicyProvider,
} from "../adapters/vscode/editReviewCapabilities.js";
import {
  createVscodeCodeActionsProvider,
  createVscodeCompletionsProvider,
  createVscodeDiagnosticsProvider,
  createVscodeHierarchyProvider,
  createVscodeHoverProvider,
  createVscodeInlayHintsProvider,
  createVscodeNavigationProvider,
  createVscodeReferencesProvider,
  createVscodeSymbolsProvider,
} from "../adapters/vscode/languageCapabilities.js";
import {
  createVscodeAdvertisedArtifactProvider,
  createVscodeContextDocumentProvider,
  createVscodeContextEnrichmentProvider,
  createVscodeContextWorkingSetProvider,
  createVscodePathAccessProvider,
  createVscodeReadFileEnrichmentProvider,
  createVscodeStructuralGraphProvider,
  createVscodeWorkspaceFileProvider,
} from "../adapters/vscode/readSearchCapabilities.js";
import { createVscodeTerminalProvider } from "../adapters/vscode/terminalCapabilities.js";
import { createVscodeWorktreeAgentLaunchProvider } from "../adapters/vscode/worktreeAgentLaunchCapabilities.js";
import { getConfiguredDiagnosticDelay } from "../adapters/vscode/agentLinkConfig.js";
import { handleLoadRule } from "../tools/loadRule.js";
import { handleLoadSkill } from "../tools/loadSkill.js";
import { handleOpenFile } from "../tools/openFile.js";
import { handleProposeMemory } from "../tools/proposeMemory.js";
// --- Handler imports ---
import { handleReadFile } from "../tools/readFile.js";
import { handleRenameSymbol } from "../tools/renameSymbol.js";
import { handleSearchFiles } from "../tools/searchFiles.js";
import {
  handleReadSessionExcerpt,
  handleSearchSessionHistory,
} from "../tools/sessionTranscriptRecall.js";
import { handleSendFeedback } from "../tools/sendFeedback.js";
import { handleShowNotification } from "../tools/showNotification.js";

import { handleWriteFile } from "../tools/writeFile.js";
import type {
  EditReviewProvider,
  EditorRevealProvider,
  MultiFileEditReviewProvider,
  RenameSymbolProvider,
  WriteApprovalPolicyProvider,
} from "../core/capabilities/editReview.js";
import type {
  DiagnosticsProvider,
  LanguageCodeActionsProvider,
  LanguageCompletionsProvider,
  LanguageHierarchyProvider,
  LanguageHoverProvider,
  LanguageInlayHintsProvider,
  LanguageNavigationProvider,
  LanguageReferencesProvider,
  LanguageSymbolsProvider,
} from "../core/capabilities/language.js";
import type { SemanticSearchProvider } from "../core/capabilities/readSearch.js";
import type { TerminalProvider } from "../core/capabilities/terminal.js";
import type { WorktreeAgentLaunchProvider } from "../core/capabilities/worktree.js";
import type {
  BackgroundAgentProvider,
  BackgroundAgentResultContent,
} from "../core/capabilities/background.js";
import type { NativeWebToolExecutionProvider } from "../core/capabilities/web.js";
import type {
  ModeSwitchProvider,
  SessionStatusProvider,
  UserQuestionProvider,
  UserQuestionResponse,
} from "../core/capabilities/sessionControl.js";
import type {
  McpResourcePromptProvider,
  McpToolDiscoveryProvider,
  McpToolDiscoveryRequest,
  McpToolInvocationProvider,
} from "../core/capabilities/mcp.js";
import type {
  ToolUsageOutcome,
  ToolUsageTelemetry,
} from "../telemetry/ToolUsageTelemetry.js";
import { parseMcpToolName } from "./mcpToolNames.js";
import { randomUUID } from "crypto";
import * as os from "os";
import * as path from "path";
import { z } from "zod";
import {
  canonicalizePath,
  isPathWithinRoot,
  resolveAndValidatePath,
  withWorkspaceRoots,
} from "../util/paths.js";
import { isAgentlinkTmpArtifact } from "../util/agentlinkTmpArtifacts.js";
import { createComposeExecutionScope } from "./compose/composeScope.js";
import type { ComposeParams } from "./compose/composeRuntime.js";
import { loadComposeRuntime } from "./compose/composeRuntimeLoader.js";

// --- Read-only tools (safe to execute in parallel) ---

export const READ_ONLY_TOOLS = new Set(PARALLEL_SAFE_TOOLS);

// --- Tools excluded from the agent (MCP-only or not applicable) ---

const EXCLUDED_TOOLS = new Set(["handshake", "load_rule", "load_skill"]);

// --- Zod schema record → JSON Schema conversion ---

const jsonSchemaCache = new Map<string, JsonSchema>();

function zodSchemaToJsonSchema(
  schema: Record<string, z.ZodTypeAny>,
): JsonSchema {
  const obj = z.object(schema);
  // Zod v4 has built-in JSON Schema support (zod-to-json-schema doesn't support v4)
  const jsonSchema = z.toJSONSchema(obj) as Record<string, unknown>;
  const { $schema: _, ...rest } = jsonSchema;
  return rest as JsonSchema;
}

function cachedJsonSchemaFor(
  name: string,
  schema: Record<string, z.ZodTypeAny>,
): JsonSchema {
  const cached = jsonSchemaCache.get(name);
  if (cached) return cached;
  const converted = zodSchemaToJsonSchema(schema);
  jsonSchemaCache.set(name, converted);
  return converted;
}

// --- Tool name → zod schema mapping ---

const TOOL_SCHEMAS: Record<string, Record<string, z.ZodTypeAny>> = {
  web_search: schemas.webSearchSchema,
  web_fetch: schemas.webFetchSchema,
  read_file: schemas.readFileSchema,
  get_context: schemas.getContextSchema,
  get_repo_map: schemas.getRepoMapSchema,
  get_module_neighbors: schemas.getModuleNeighborsSchema,
  load_rule: schemas.loadRuleSchema,
  load_skill: schemas.loadSkillSchema,
  list_files: schemas.listFilesSchema,
  search_files: schemas.searchFilesSchema,
  search_session_history: schemas.searchSessionHistorySchema,
  read_session_excerpt: schemas.readSessionExcerptSchema,
  get_diagnostics: schemas.getDiagnosticsSchema,
  write_file: schemas.writeFileSchema,
  generate_image: schemas.generateImageSchema,
  apply_diff: schemas.applyDiffSchema,
  find_and_replace: schemas.findAndReplaceSchema,
  rename_symbol: schemas.renameSymbolSchema,
  propose_memory: schemas.proposeMemorySchema,
  open_file: schemas.openFileSchema,
  show_notification: schemas.showNotificationSchema,
  execute_command: schemas.executeCommandSchema,
  get_terminal_output: schemas.getTerminalOutputSchema,
  close_terminals: schemas.closeTerminalsSchema,
  start_worktree_agent: schemas.startWorktreeAgentSchema,
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
  compose: schemas.composeSchema,
  ...(__DEV_BUILD__
    ? {
        send_feedback: {
          tool_name: z
            .string()
            .describe("Name of the tool this feedback is about"),
          feedback: z
            .string()
            .describe(
              "Description of the issue, suggestion, or missing feature",
            ),
          tool_params: z
            .string()
            .optional()
            .describe(
              "Optional serialized params passed to the tool (helps reproduce)",
            ),
          tool_result_summary: z
            .string()
            .optional()
            .describe("Optional summary of what happened / unexpected result"),
        },
        get_feedback: {
          tool_name: z
            .string()
            .optional()
            .describe(
              "Filter to feedback about a specific tool (omit for all feedback)",
            ),
        },
        delete_feedback: {
          indices: z
            .array(z.coerce.number())
            .describe(
              "0-based feedback entry indices to delete (from get_feedback output)",
            ),
        },
      }
    : {}),
};

const CALL_MCP_TOOL: ToolDefinition = CALL_MCP_TOOL_DEFINITION;

function skillAllowlistAllowsMcpServer(
  allowlist: ReadonlySet<string> | undefined,
  serverName: string,
): boolean {
  if (!allowlist) return true;
  return (
    allowlist.has(serverName) ||
    allowlist.has(`${serverName}__*`) ||
    allowlist.has(`${serverName}.*`)
  );
}

function skillAllowlistAllowsMcpTool(
  allowlist: ReadonlySet<string> | undefined,
  fullToolName: string,
): boolean {
  if (!allowlist) return true;
  const parsed = parseMcpToolName(fullToolName);
  if (!parsed) return allowlist.has(fullToolName);
  return (
    allowlist.has(fullToolName) ||
    skillAllowlistAllowsMcpServer(allowlist, parsed.serverName)
  );
}

function skillAllowlistHasMcpTargets(
  allowlist: ReadonlySet<string> | undefined,
  mcpToolDefs: ToolDefinition[] | undefined,
): boolean {
  if (!allowlist || !mcpToolDefs?.length) return false;
  return mcpToolDefs.some((tool) =>
    skillAllowlistAllowsMcpTool(allowlist, tool.name),
  );
}

const MCP_META_TOOLS: ToolDefinition[] = MCP_META_TOOL_DEFINITIONS;

/** Schema for the ask_user tool (always available in all modes). */
const ASK_USER_TOOL: ToolDefinition = {
  name: "ask_user",
  description:
    "Ask the user one or more structured questions and wait for their responses before continuing. Prefer `questions[].context`: visible user-facing text for that specific question explaining why input is needed, the relevant trade-off/options, and your recommendation. Use top-level `context` only for a brief shared intro that applies to every question. For multi-question asks, split context across the individual questions instead of delivering one large block. Questions must be self-contained and must not rely on hidden thinking or prior invisible rationale. For multiple_choice and multiple_select questions, always include `recommended`. To combine a user choice with a mode change (e.g. 'plan first → architect, just implement → code'), use a `multiple_choice` question with a `modeSwitch` map instead of calling `switch_mode` separately — this avoids a redundant approval. Only one question per call may include `modeSwitch`.",
  input_schema: {
    type: "object",
    properties: {
      context: {
        type: "string",
        description:
          "Optional brief shared intro shown above the questions. Use only for context that applies to every question; put question-specific rationale in questions[].context.",
      },
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
              description: "Question type",
            },
            question: {
              type: "string",
              description: "The question text shown to the user",
            },
            context: {
              type: "string",
              description:
                "Visible context shown with this specific question. Prefer this over top-level context, especially when asking multiple questions. Explain the local trade-off/options and include your recommendation when relevant.",
            },
            options: {
              type: "array",
              items: { type: "string" },
              description:
                "Answer options (required for multiple_choice and multiple_select)",
            },
            recommended: {
              type: "string",
              description:
                "Recommended option value; required for multiple_choice and multiple_select.",
            },
            allowBlank: {
              type: "boolean",
              description:
                "Allows submitting a blank text answer. Only applies to text questions.",
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
            modeSwitch: {
              type: "object",
              description:
                "Maps answer values (option strings) to agent mode slugs. When the user picks a mapped answer, the agent switches mode as part of submission — no separate switch_mode approval is shown. Only valid on multiple_choice questions, and only one question per ask_user call may include modeSwitch. Available modes: code, architect, ask, debug, review (plus any custom modes).",
              additionalProperties: { type: "string" },
            },
          },
          required: ["id", "type", "question"],
        },
      },
    },
    required: ["questions"],
  },
};

/** Base schema for final task status; background result fields are added per run. */
const SET_TASK_STATUS_TOOL: ToolDefinition = {
  name: "set_task_status",
  description:
    "Mark the current turn's final status. Use only when your response is final: completed, waiting_for_user, blocked, or cancelled. Do not call before ask_user or for intermediate progress updates. The summary is the user-facing final response itself, not a meta-description of what you did. If the user asked for a concrete artifact (prompt, code, command, plan, review, answer), that artifact must be visible either in normal text before this tool call or fully inside summary. Never use summary as a teaser such as 'Here is the prompt' or 'See below'; content after this tool call is not a reliable place to deliver the answer. For code-modifying work, structure the summary around what changed, why it matters, validation run or skipped, and concrete follow-up. Include a short continuation button label and prompt when the user can safely continue with one click, especially when the summary mentions a concrete next phase, MVP slice, remaining plan item, follow-up task, or validation step.",
  input_schema: {
    type: "object",
    properties: {
      status: {
        type: "string",
        enum: ["completed", "waiting_for_user", "blocked", "cancelled"],
      },
      summary: {
        type: "string",
        description:
          "The user-facing final response itself, shown with the marker. Markdown is rendered. Must contain the actual substance the user asked for — the answer, explanation, findings, artifact, or result — not a meta-description of what you did. If the summary says 'here is', 'below', 'paste this', 'the prompt is', or otherwise promises an artifact, the complete artifact must be included in this same summary (for example, in a fenced code block) unless it was already sent as normal visible text before the tool call. Never rely on text after set_task_status to provide missing content. Never write 'Explained X', 'Answered Y', 'Reviewed Z', or similar past-tense recaps. For non-trivial code-modifying work, structure as what changed (key files/behavior), why it matters, validation run, validation skipped with reasons, and concrete follow-up. Use 3-6 bullets or 1-2 short paragraphs for non-trivial work; do not reduce meaningful work to 'Done' or 'All set'. Keep it final and avoid open-ended questions or generic offers for further assistance.",
      },
      continueLabel: {
        type: "string",
        description:
          "Button label for a clear next-step continuation. Provide this with continuePrompt when the final summary names a concrete follow-up, next phase, MVP slice, remaining plan item, subtask, or validation step.",
      },
      completeTodos: {
        type: "boolean",
        description:
          "When true with status='completed', mark all currently visible todos completed as part of this final status call. Use instead of a separate todo_write call only when the existing todo list accurately represents finished work.",
      },
      continuePrompt: {
        type: "string",
        description:
          "Visible user message sent when the continuation button is clicked. Make it specific enough to start the named next step, not just a generic 'continue', whenever there is remaining work from the original plan or a concrete follow-up in the summary.",
      },
    },
    required: ["status"],
  },
};

type ExpectedBackgroundResult =
  | "text"
  | "review_findings"
  | "patch"
  | "verification";

function getSetTaskStatusTool(
  expectedResult?: ExpectedBackgroundResult,
  isBackground = false,
): ToolDefinition {
  if (!isBackground) return SET_TASK_STATUS_TOOL;
  const resultSchemas: Record<
    ExpectedBackgroundResult,
    Record<string, unknown>
  > = {
    text: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["text"] },
        text: { type: "string" },
      },
      required: ["type", "text"],
      additionalProperties: false,
    },
    review_findings: {
      type: "object",
      description:
        "Resolve the exact requested change set before reviewing. Set emptyDiff=true when it is empty or unavailable; never use an empty findings list to imply a clean review unless the scope was actually found and reviewed.",
      properties: {
        type: { type: "string", enum: ["review_findings"] },
        findings: {
          type: "array",
          items: {
            type: "object",
            properties: {
              severity: {
                type: "string",
                enum: ["critical", "high", "medium", "low"],
              },
              message: { type: "string" },
              path: { type: "string" },
              line: { type: "number" },
            },
            required: ["severity", "message"],
            additionalProperties: false,
          },
        },
        reviewedScope: {
          type: "string",
          description:
            "The exact commit range, diff, or file list that was actually reviewed, or what was checked when no change set could be found.",
        },
        emptyDiff: { type: "boolean" },
      },
      required: ["type", "findings", "reviewedScope", "emptyDiff"],
      additionalProperties: false,
    },
    patch: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["patch"] },
        summary: { type: "string" },
        files: { type: "array", items: { type: "string" } },
        verification: { type: "string" },
      },
      required: ["type", "summary", "files"],
      additionalProperties: false,
    },
    verification: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["verification"] },
        passed: { type: "boolean" },
        summary: { type: "string" },
        screenshots: { type: "array", items: { type: "string" } },
        logs: { type: "array", items: { type: "string" } },
      },
      required: ["type", "passed", "summary"],
      additionalProperties: false,
    },
  };
  const resultSchema = expectedResult
    ? resultSchemas[expectedResult]
    : {
        type: "object",
        description:
          "Optional coordinator-facing result. Use type='text' with text for general information or summaries, type='review_findings' for reviews, type='patch' for implementation results, or type='verification' for verification evidence.",
        additionalProperties: true,
      };
  const resultGuidance = expectedResult
    ? `This background task expects a structured ${expectedResult} result; include it in the result field when completing the task instead of printing serialized JSON in assistant text.`
    : "For coordinator-facing information or summaries, you may return a structured result instead of serializing data into assistant text.";
  return {
    ...SET_TASK_STATUS_TOOL,
    description: `${SET_TASK_STATUS_TOOL.description} ${resultGuidance} The result field is the coordinator-facing output, so summary may be omitted and should not duplicate it.`,
    input_schema: {
      ...SET_TASK_STATUS_TOOL.input_schema,
      properties: {
        ...SET_TASK_STATUS_TOOL.input_schema.properties,
        result: resultSchema,
      },
    },
  };
}

/** Schema for the switch_mode meta-tool (always available, regardless of mode). */
const SWITCH_MODE_TOOL: ToolDefinition = {
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
  },
};

/** Shared budget schema for spawn_background_agent and start_fleet_workflow. */
const AGENT_BUDGET_SCHEMA = {
  type: "object",
  description:
    "Optional soft resource-cap overrides. Review task classes receive an automatic complexity-based session budget when this is omitted; other task classes remain uncapped. Reaching a cap asks the agent to finish promptly without blocking necessary tools; work is force-stopped only when observed usage reaches the 3x safety backstop.",
  properties: {
    maxTokens: {
      type: "number",
      description:
        "Cap on uncached input + output tokens summed across all API turns. Cache misses charge the full context, so reading a large diff or repo can cost 30k-100k tokens in a single turn; a typical diff review spends 100k-300k total. Do not set below 100000 for review tasks.",
    },
    maxToolCalls: {
      type: "number",
      description:
        "Soft cap on successfully committed tool invocations. Interrupted/provisional tool streams are not charged. Automatic review budgets allow substantially more tool calls than API turns so codebase inspection is weighted less aggressively.",
    },
    maxApiTurns: {
      type: "number",
      description:
        "Soft cap on successful model API turns. Provider retry attempts are not charged.",
    },
    maxElapsedMs: {
      type: "number",
      description: "Wall-clock cap in milliseconds.",
    },
    maxEstimatedCostUsd: {
      type: "number",
      description:
        "Estimated-cost cap in USD; only enforced when estimatedCostPerMillionTokens is also set.",
    },
    estimatedCostPerMillionTokens: { type: "number" },
    warningThresholdRatio: {
      type: "number",
      description:
        "Usage ratio (default 0.8) at which the agent is nudged to start wrapping up.",
    },
    scope: { type: "string", enum: ["session", "subtree", "goal"] },
  },
};

const DEFAULT_BACKGROUND_IMAGE_COUNT = 4;
const MAX_BACKGROUND_IMAGES = 8;

function resolveBackgroundImages(params: {
  imageIds?: unknown;
  useRecentImages?: unknown;
  getSessionImages?: () => SessionImageReference[];
}): Array<{ name: string; mimeType: string; base64: string }> {
  const sessionImages = params.getSessionImages?.() ?? [];
  const byId = new Map(sessionImages.map((image) => [image.id, image]));
  const selected: SessionImageReference[] = [];

  if (params.imageIds != null) {
    if (!Array.isArray(params.imageIds)) {
      throw new Error("imageIds must be an array of session image IDs");
    }
    for (const rawId of params.imageIds) {
      if (typeof rawId !== "string" || !rawId.trim()) {
        throw new Error("imageIds must be an array of session image IDs");
      }
      const id = rawId.trim();
      const image = byId.get(id);
      if (!image) {
        const available = sessionImages.map((item) => item.id).join(", ");
        throw new Error(
          `No session image found for imageIds entry "${id}"${available ? `. Available image IDs: ${available}` : ""}`,
        );
      }
      selected.push(image);
    }
  }

  if (params.useRecentImages != null && params.useRecentImages !== false) {
    const numeric =
      params.useRecentImages === true
        ? DEFAULT_BACKGROUND_IMAGE_COUNT
        : Number(params.useRecentImages);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      throw new Error("useRecentImages must be true or a positive number");
    }
    const count = Math.min(Math.floor(numeric), MAX_BACKGROUND_IMAGES);
    selected.push(...sessionImages.slice(-count));
  }

  const unique = Array.from(
    new Map(selected.map((image) => [image.id, image])).values(),
  );
  if (unique.length > MAX_BACKGROUND_IMAGES) {
    throw new Error(
      `spawn_background_agent supports at most ${MAX_BACKGROUND_IMAGES} inherited images`,
    );
  }
  if (
    (params.imageIds != null ||
      (params.useRecentImages != null && params.useRecentImages !== false)) &&
    unique.length === 0
  ) {
    throw new Error("No images are available in the current session");
  }

  return unique.map(({ name, mimeType, base64 }) => ({
    name,
    mimeType,
    base64,
  }));
}

/** Background agent management tools (only available in foreground sessions). */
const BG_AGENT_TOOLS: ToolDefinition[] = [
  {
    name: "spawn_background_agent",
    description:
      "Spawn a background agent to work in parallel with the current session. Use proactively for independent research, non-conflicting code/test/docs work, alternate debug hypotheses, tangential checks, and quick or thorough reviews. Returns immediately with a sessionId so the foreground can keep working or coordinate other lanes; call get_background_status for non-blocking progress and get_background_result only when you need the final output.",
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
            "Full instruction for the background agent. Be specific and self-contained. For writable work, include explicit owned files/directories, files to avoid, allowed commands/tests, and how to report conflicts. For review work, use reviewScope to have the runtime capture the working tree, exact files, a commit range, or supplied diff at spawn time.",
        },
        mode: {
          type: "string",
          description: "Optional target mode override (e.g. review, code, ask)",
        },
        model: {
          type: "string",
          description: "Optional explicit model override",
        },
        provider: {
          type: "string",
          description:
            "Optional provider preference/constraint (e.g. anthropic, codex)",
        },
        taskClass: {
          type: "string",
          description:
            "Task class used for routing policy (e.g. review_code, review_plan, readonly-research, research, explore, debug, design, general). Use readonly-research for pure read-only lookup/exploration; use general or debug for non-conflicting writable lanes (general selects code mode by default).",
        },
        modelTier: {
          type: "string",
          description:
            'Optional routing tier override ("cheap", "balanced", or "deep_reasoning"). For review tasks, omit this to let the router infer complexity from the request.',
        },
        ownedPaths: {
          type: "array",
          items: { type: "string" },
          description: "Advisory paths delegated for this agent to own.",
        },
        forbiddenPaths: {
          type: "array",
          items: { type: "string" },
          description: "Paths the delegated agent must not modify.",
        },
        permissionProfile: {
          type: "string",
          enum: ["review-only", "workspace-safe", "interactive"],
        },
        worktree: { type: "string", enum: ["shared", "isolated"] },
        imageIds: {
          type: "array",
          items: { type: "string" },
          description:
            "Specific image IDs from the current foreground session to copy into the background agent's first message. IDs follow image_1, image_2 attachment/session order. Native in-process backgrounds only; not supported for ACP or isolated-worktree agents.",
        },
        useRecentImages: {
          oneOf: [{ type: "boolean" }, { type: "number" }],
          description:
            "Copy recent images from the foreground session into the background agent's first message. Includes user-attached images and screenshot/image tool results. Pass true for up to 4 recent images or a number for that many (maximum 8). Native in-process backgrounds only.",
        },
        reviewScope: {
          description:
            "Structured review target captured into an immutable snapshot when the background agent is spawned. Relative paths resolve from the executing project; absolute paths inside any open workspace root are accepted. working_tree defaults to unstaged tracked changes plus untracked files; Git scopes must stay within one root. files captures exact current files and may span roots, including non-Git workspaces. commit_range resolves Git diff output immediately. diff accepts already captured content.",
          oneOf: [
            {
              type: "object",
              properties: {
                kind: { type: "string", enum: ["working_tree"] },
                include: {
                  type: "array",
                  items: {
                    type: "string",
                    enum: ["staged", "unstaged", "untracked"],
                  },
                },
                paths: { type: "array", items: { type: "string" } },
              },
              required: ["kind"],
              additionalProperties: false,
            },
            {
              type: "object",
              properties: {
                kind: { type: "string", enum: ["files"] },
                paths: { type: "array", items: { type: "string" } },
              },
              required: ["kind", "paths"],
              additionalProperties: false,
            },
            {
              type: "object",
              properties: {
                kind: { type: "string", enum: ["commit_range"] },
                range: { type: "string" },
                paths: { type: "array", items: { type: "string" } },
              },
              required: ["kind", "range"],
              additionalProperties: false,
            },
            {
              type: "object",
              properties: {
                kind: { type: "string", enum: ["diff"] },
                content: { type: "string" },
                label: { type: "string" },
              },
              required: ["kind", "content"],
              additionalProperties: false,
            },
          ],
        },
        expectedResult: {
          type: "string",
          enum: ["text", "review_findings", "patch", "verification"],
          description:
            "Structured result envelope the agent must return. review_findings envelopes report reviewedScope (what was actually reviewed) and emptyDiff (true when the requested change set was empty or missing) — check emptyDiff before treating an empty findings list as a clean review.",
        },
        budget: AGENT_BUDGET_SCHEMA,
        goalId: { type: "string" },
      },
      required: ["task", "message"],
    },
  },
  {
    name: "get_background_status",
    description:
      "Non-blocking health and progress snapshot for a background agent. Returns phase/runtime telemetry, durable resultState/terminalReason/retry guidance when terminal, budget usage, canSteer/canKill controls, and preserved output. Use it while continuing independent work; do not poll tightly or infer a hang from elapsed time alone because a provider request or long tool can be quiet. If progress has gone quiet and the partial result is sufficient, steer it to stop using tools and return now. If steering cannot be delivered at a safe boundary, the idle time keeps growing, and the result is no longer worth waiting for, kill it. Call get_background_result only when ready to block for integration.",
    input_schema: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          description: "The sessionId returned by spawn_background_agent",
        },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "get_background_result",
    description:
      "Wait for a background agent to finish and return its final response. Successful runs return the expected response; failed, interrupted, cancelled, unauthorized, or incomplete expected-result runs return structured JSON with status, terminalReason, retrySafe, agentRetryable, and preserved partialOutput when available. Use this for explicit pull/wait flows; skip it when a completion result was already pushed into context.",
    input_schema: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          description: "The sessionId returned by spawn_background_agent",
        },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "kill_background_agent",
    description:
      "Immediately stop a background agent when get_background_status reports canKill and waiting is no longer worthwhile. Returns any partial output collected so far.",
    input_schema: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          description: "The sessionId of the background agent to stop",
        },
        reason: {
          type: "string",
          description:
            "Brief reason for killing the agent (logged for debugging)",
        },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "steer_background_agent",
    description:
      'Send a course-correction to a running authorized descendant. To ask for an early result, say "Stop using tools and return your best findings now." The instruction is queued for the next safe tool boundary, so it cannot interrupt an in-flight provider request or tool; check idleMs later and kill if the instruction cannot be delivered promptly.',
    input_schema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        message: { type: "string" },
      },
      required: ["sessionId", "message"],
    },
  },
  {
    name: "detach_background_agent",
    description:
      "Detach an authorized child subtree so it becomes an independent root and is not cancelled when its former parent completes.",
    input_schema: {
      type: "object",
      properties: { sessionId: { type: "string" } },
      required: ["sessionId"],
    },
  },
  {
    name: "start_fleet_workflow",
    description:
      "Start a structured diff review, browser verification, isolated best-of-N run, or persistent goal using the normal fleet scheduler and policies.",
    input_schema: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: [
            "structured_diff_review",
            "browser_verification",
            "best_of_n",
            "persistent_goal",
          ],
        },
        task: { type: "string" },
        message: { type: "string" },
        goalId: { type: "string" },
        candidates: {
          type: "array",
          items: {
            type: "object",
            properties: {
              model: { type: "string" },
              provider: { type: "string" },
            },
          },
        },
        budget: AGENT_BUDGET_SCHEMA,
      },
      required: ["kind", "task", "message"],
    },
  },
  {
    name: "schedule_fleet_workflow",
    description:
      "Persist a recurring or fleet-event-triggered workflow automation.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        everyMinutes: { type: "number" },
        eventType: { type: "string" },
        workflow: { type: "object" },
      },
      required: ["name", "workflow"],
    },
  },
  {
    name: "get_fleet_workflow_result",
    description:
      "Wait for all workflow candidates, collect structured evidence, and select a best-of-N winner when applicable.",
    input_schema: {
      type: "object",
      properties: {
        workflowId: { type: "string" },
        kind: {
          type: "string",
          enum: [
            "structured_diff_review",
            "browser_verification",
            "best_of_n",
            "persistent_goal",
          ],
        },
      },
      required: ["workflowId", "kind"],
    },
  },
  {
    name: "manage_fleet_automations",
    description:
      "List, inspect history, enable, disable, or delete persisted fleet automations.",
    input_schema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "history", "enable", "disable", "delete"],
        },
        id: { type: "string" },
      },
      required: ["action"],
    },
  },
];

/** Return value of get_background_status — non-blocking snapshot. */
export type BgStatusResult = BackgroundAgentStatusResult;

// --- Tool Profiles ---

/**
 * Named tool profiles that restrict the tool set for specific background task types.
 * Each profile is an allowlist of tool names from the native tool registry.
 */
const MCP_ENABLED_TOOL_PROFILES = new Set(["review", "readonly-research"]);

const READ_ONLY_COMMAND_PROFILES = new Set(["review", "readonly-research"]);

const TOOL_PROFILES: Record<string, Set<string>> = {
  review: new Set([
    "read_file",
    "get_context",
    "get_repo_map",
    "get_module_neighbors",
    "search_files",
    "codebase_search",
    "list_files",
    "get_diagnostics",
    "get_hover",
    "get_symbols",
    "get_references",
    "go_to_definition",
    "go_to_implementation",
    "get_type_hierarchy",
    "execute_command",
    "search_session_history",
    "read_session_excerpt",
  ]),
  "readonly-research": new Set([
    "read_file",
    "get_context",
    "get_repo_map",
    "get_module_neighbors",
    "search_files",
    "codebase_search",
    "list_files",
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
    "execute_command",
    "search_session_history",
    "read_session_excerpt",
  ]),
  btw: new Set([
    "read_file",
    "get_context",
    "get_repo_map",
    "get_module_neighbors",
    "search_files",
    "codebase_search",
    "list_files",
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
    "search_session_history",
    "read_session_excerpt",
  ]),
};

// --- Public API ---

/**
 * Get tool definitions formatted for the Claude SDK.
 * When mode is provided, only tools allowed by the mode's toolGroups are included.
 * MCP tools (prefixed 'server__tool') are passed as external Anthropic.Tool objects.
 * When isBackground is true, recursive fleet controls and mode switching are
 * excluded until those operations are session-scoped. Normal mode tools,
 * memory proposals, questions, and final task status remain available.
 * When toolProfile is set, further restricts to only the tools in that profile.
 * When skillAllowedTools is set, further restricts normal tools after a skill
 * with allowed-tools frontmatter has been loaded. Hidden control tools stay
 * available so the agent can ask questions, finish, switch mode, or load another skill.
 */
export function getAgentTools(
  mode?: AgentMode,
  mcpToolDefs?: ToolDefinition[],
  isBackground?: boolean,
  toolProfile?: string,
  skillAllowedTools?: string[],
  allMcpToolDefsForSkillAllowlist?: ToolDefinition[],
  backgroundExpectedResult?: ExpectedBackgroundResult,
  nativeWebToolKinds: readonly import("../core/webAccess.js").CoreWebToolKind[] = [],
): ToolDefinition[] {
  const mcpToolNames = (mcpToolDefs ?? []).map((t) => t.name);
  const allowed = mode ? getToolsForMode(mode, mcpToolNames) : null;
  const profileAllowlist = toolProfile
    ? (TOOL_PROFILES[toolProfile] ?? new Set<string>())
    : undefined;
  const profileAllowsMcp = Boolean(
    toolProfile && MCP_ENABLED_TOOL_PROFILES.has(toolProfile),
  );
  const skillAllowlist = skillAllowedTools
    ? new Set(skillAllowedTools)
    : undefined;

  const usesReadOnlyCommand =
    mode?.toolGroups.includes("read-only-command") ||
    (toolProfile !== undefined && READ_ONLY_COMMAND_PROFILES.has(toolProfile));
  const nativeTools = Object.entries(TOOL_SCHEMAS)
    .sort(([a], [b]) => a.localeCompare(b))
    .filter(([name]) => !EXCLUDED_TOOLS.has(name))
    .filter(([name]) => !(isBackground && name === "compose"))
    .filter(
      ([name]) =>
        (name !== "web_search" || nativeWebToolKinds.includes("search")) &&
        (name !== "web_fetch" || nativeWebToolKinds.includes("fetch")),
    )
    .filter(([name]) => __DEV_BUILD__ || !TOOL_REGISTRY[name]?.devOnly)
    .filter(
      ([name]) =>
        Boolean(profileAllowlist) ||
        !allowed ||
        allowed.has(name) ||
        (__DEV_BUILD__ && TOOL_REGISTRY[name]?.devOnly),
    )
    .filter(([name]) => !profileAllowlist || profileAllowlist.has(name))
    .filter(([name]) => !skillAllowlist || skillAllowlist.has(name))
    .map(([name, zodSchema]) => ({
      name,
      description:
        name === "execute_command" && usesReadOnlyCommand
          ? "Run a recognized read-only command synchronously inside the workspace. Unknown, mutating, redirected, networked, privileged, opaque, background, timed, environment-bearing, forced, and inline-file commands are rejected. Git diff/show/log/blame require --no-pager, --no-ext-diff, and --no-textconv; git grep requires --no-pager."
          : (TOOL_REGISTRY[name]?.description ?? name),
      input_schema:
        name === "execute_command" && usesReadOnlyCommand
          ? cachedJsonSchemaFor(
              "execute_command:read-only",
              schemas.readOnlyExecuteCommandSchema,
            )
          : cachedJsonSchemaFor(name, zodSchema),
    }));

  // Restrictive profiles are authoritative: native tools come from the profile
  // allowlist, and selected background profiles can opt into MCP or restricted
  // read-only command execution explicitly, while still blocking native write
  // tools, nested background spawning, and foreground-only controls.
  const canUseMcpTools =
    profileAllowsMcp ||
    (!profileAllowlist && (!mode || mode.toolGroups.includes("mcp")));
  const allowedMcpTools =
    canUseMcpTools && mcpToolDefs
      ? skillAllowlist
        ? mcpToolDefs.filter((tool) =>
            skillAllowlistAllowsMcpTool(skillAllowlist, tool.name),
          )
        : mcpToolDefs
      : [];
  const skillAllowsMcpTargets = skillAllowlistHasMcpTargets(
    skillAllowlist,
    allMcpToolDefsForSkillAllowlist ?? mcpToolDefs,
  );

  // MCP client meta-tools follow the same gate as direct MCP tools.
  // Background agents are excluded from switch_mode and spawn tools to prevent
  // inadvertent foreground mode changes and nested spawning.
  const metaTools =
    canUseMcpTools && (!skillAllowlist || skillAllowsMcpTargets)
      ? MCP_META_TOOLS
      : [];
  const hiddenAgentTools = profileAllowlist
    ? []
    : [
        {
          name: "load_rule",
          description:
            TOOL_REGISTRY.load_rule?.description ??
            "Load the full contents of an advertised local rule file.",
          input_schema: cachedJsonSchemaFor(
            "load_rule",
            schemas.loadRuleSchema,
          ),
        },
        {
          name: "load_skill",
          description:
            TOOL_REGISTRY.load_skill?.description ??
            "Load the full contents of an advertised skill file.",
          input_schema: cachedJsonSchemaFor(
            "load_skill",
            schemas.loadSkillSchema,
          ),
        },
      ];
  return [
    ...nativeTools,
    ...hiddenAgentTools,
    ...allowedMcpTools,
    ...metaTools,
    ...(canUseMcpTools && (!skillAllowlist || skillAllowsMcpTargets)
      ? [CALL_MCP_TOOL]
      : []),
    ...(profileAllowlist ? [] : [ASK_USER_TOOL]),
    ...(!profileAllowlist || isBackground
      ? [getSetTaskStatusTool(backgroundExpectedResult, Boolean(isBackground))]
      : []),
    ...(profileAllowlist ? [] : [SWITCH_MODE_TOOL]),
    ...(profileAllowlist ? [] : BG_AGENT_TOOLS),
  ];
}

/**
 * Context needed by the tool dispatcher.
 */
export type QuestionResponse = UserQuestionResponse;

export async function buildAskUserToolResult(args: {
  context: string;
  questions: Question[];
  response: QuestionResponse;
  modeSwitchProvider?: ModeSwitchProvider;
}): Promise<ToolResult> {
  const { context, questions, response, modeSwitchProvider } = args;
  const responses = questions.map((q) => {
    const answer = response.answers[q.id];
    const note = response.notes[q.id];
    const attachments = response.attachments?.[q.id] ?? [];
    const entry: Record<string, unknown> = {
      question: q.question,
      answer: answer ?? null,
    };
    if (q.context) entry.context = q.context;
    if (note) entry.note = note;
    if (attachments.length > 0) {
      entry.attachments = attachments.map((attachment) => ({
        kind: attachment.kind,
        name: attachment.name,
        ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
        ...(attachment.path ? { path: attachment.path } : {}),
      }));
    }
    return entry;
  });

  const modeSwitchQuestion = questions.find(
    (q) => q.modeSwitch && Object.keys(q.modeSwitch).length > 0,
  );
  let modeSwitched: string | undefined;
  let modeSwitchFollowUp: string | undefined;
  if (modeSwitchQuestion && modeSwitchProvider) {
    const answer = response.answers[modeSwitchQuestion.id];
    const mapping = modeSwitchQuestion.modeSwitch;
    if (mapping && typeof answer === "string") {
      const targetMode = mapping[answer];
      if (targetMode) {
        const note = response.notes[modeSwitchQuestion.id]?.trim();
        const switchReason = note
          ? `ask_user: "${answer}" — ${note}`
          : `ask_user: "${answer}"`;
        try {
          const switchResult = await modeSwitchProvider.switchMode({
            mode: targetMode,
            reason: switchReason,
            silent: true,
          });
          if (switchResult.approved) {
            modeSwitched = switchResult.mode;
            modeSwitchFollowUp = switchResult.followUp?.trim() || undefined;
          }
        } catch {
          // ignore — fall back to no switch; agent can call switch_mode if needed
        }
      }
    }
  }

  const payload: Record<string, unknown> = { context, responses };
  if (modeSwitched) payload.modeSwitched = modeSwitched;
  if (modeSwitchFollowUp) payload.follow_up = modeSwitchFollowUp;
  const media: ToolResult["content"] = [];
  for (const question of questions) {
    for (const attachment of response.attachments?.[question.id] ?? []) {
      if (!attachment.base64 || !attachment.mimeType) continue;
      if (attachment.kind === "image") {
        media.push({
          type: "image",
          data: attachment.base64,
          mimeType: attachment.mimeType,
        });
      } else if (attachment.kind === "document") {
        media.push({
          type: "document",
          data: attachment.base64,
          mimeType: attachment.mimeType,
          name: attachment.name,
        });
      }
    }
  }
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }, ...media],
  };
}

function getToolUsageOutcomeFromResult(result: ToolResult): ToolUsageOutcome {
  if (result.isError) {
    return result.error?.kind === "aborted" ? "cancelled" : "error";
  }
  const text = result.content.find((item) => item.type === "text")?.text;
  if (!text) return "ok";
  try {
    const parsed = JSON.parse(text) as { error?: unknown; status?: unknown };
    if (typeof parsed.error !== "undefined") return "error";
    if (parsed.status === "cancelled") return "cancelled";
    if (parsed.status === "error") return "error";
  } catch {
    // Plain text tool output is a successful result.
  }
  return "ok";
}

const SEMANTIC_SEARCH_UNAVAILABLE_MESSAGE =
  "Semantic codebase search is unavailable in this runtime. Provide a SemanticSearchProvider to enable codebase_search.";

export function createUnavailableSemanticSearchProvider(): SemanticSearchProvider {
  return {
    async search() {
      return errorResult(SEMANTIC_SEARCH_UNAVAILABLE_MESSAGE);
    },
  };
}

function isTeaserOnlyFinalSummary(summary: string): boolean {
  const normalized = summary
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return false;

  const startsLikeTeaser =
    /^(?:you'?re right\s*[—-]\s*)?(?:here(?:'s| is)|below is|paste this|copy this)\b/.test(
      normalized,
    );
  const namesArtifact =
    /\b(prompt|answer|command|snippet|code|plan|review|message|response|text|artifact)\b/.test(
      normalized,
    );
  if (!startsLikeTeaser || !namesArtifact) return false;

  const hasObviousPayload =
    summary.includes("```") ||
    /`[^`]+`/.test(summary) ||
    /:\s*\S.{24,}/s.test(summary) ||
    summary.split(/\r?\n/).some((line) => {
      const trimmed = line.trim();
      if (trimmed.length < 40) return false;
      const normalizedLine = trimmed
        .toLowerCase()
        .replace(/[‘’]/g, "'")
        .replace(/\s+/g, " ")
        .trim();
      return !/^(?:you'?re right\s*[—-]\s*)?(?:here(?:'s| is)|below is|paste this|copy this)\b/.test(
        normalizedLine,
      );
    });
  return !hasObviousPayload;
}

function clampToolLimit(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 50;
  return Math.min(Math.floor(numeric), 200);
}

function clampSchemaLimit(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 1;
  return Math.min(Math.floor(numeric), 20);
}

function normalizeDiscoveryText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function discoveryTokens(value: string): string[] {
  return normalizeDiscoveryText(value)
    .split(" ")
    .filter((token) => token.length > 0)
    .map((token) =>
      token.length > 3 && token.endsWith("s") ? token.slice(0, -1) : token,
    );
}

function scoreMcpToolDiscovery(
  queryTokens: string[],
  tool: { server: string; tool: string; name: string; description: string },
): number {
  if (queryTokens.length === 0) return 1;

  const serverTokens = new Set(discoveryTokens(tool.server));
  const bareToolTokenList = discoveryTokens(tool.tool);
  const bareToolTokens = new Set(bareToolTokenList);
  const queryTokenSet = new Set(queryTokens);
  const nameTokens = new Set(discoveryTokens(tool.name));
  const descriptionTokens = new Set(discoveryTokens(tool.description));
  const normalizedHaystack = normalizeDiscoveryText(
    `${tool.server} ${tool.tool} ${tool.name} ${tool.description}`,
  );
  const normalizedQuery = queryTokens.join(" ");

  let score = normalizedHaystack.includes(normalizedQuery) ? 20 : 0;
  let bareToolMatchCount = 0;
  for (const token of queryTokens) {
    if (bareToolTokens.has(token)) {
      score += 12;
      bareToolMatchCount += 1;
    } else if (nameTokens.has(token)) score += 8;
    else if (serverTokens.has(token)) score += 5;
    else if (descriptionTokens.has(token)) score += 4;
    else if (normalizedHaystack.includes(token)) score += 1;
  }

  const extraBareToolTokens = bareToolTokenList.filter(
    (token) => !queryTokenSet.has(token),
  ).length;
  if (bareToolMatchCount > 0 && extraBareToolTokens === 0) score += 10;
  else if (bareToolMatchCount > 0) score -= extraBareToolTokens * 3;

  return score;
}

function discoverMcpTools(
  mcpHub: McpClientHub,
  params: McpToolDiscoveryRequest,
): ReturnType<McpToolDiscoveryProvider["discoverTools"]> {
  const queryTokens = discoveryTokens(String(params.query ?? ""));
  const serverFilter = String(params.server ?? "").trim();
  const skillAllowlist = params.skillAllowlist;
  const includeSchemas = params.includeSchemas === true;
  const schemaLimit = includeSchemas ? clampSchemaLimit(params.schemaLimit) : 0;
  const limit = clampToolLimit(params.limit);

  const rankedTools = mcpHub
    .getToolDefs()
    .map((tool) => {
      const parsed = parseMcpToolName(tool.name);
      if (!parsed) return null;
      return {
        server: parsed.serverName,
        tool: parsed.bareToolName,
        name: tool.name,
        description: tool.description ?? "",
        input_schema: tool.input_schema,
      };
    })
    .filter((tool): tool is NonNullable<typeof tool> => tool !== null)
    .filter((tool) => skillAllowlistAllowsMcpTool(skillAllowlist, tool.name))
    .filter((tool) => !serverFilter || tool.server === serverFilter)
    .map((tool) => ({
      tool,
      score: scoreMcpToolDiscovery(queryTokens, tool),
    }))
    .filter((item) => queryTokens.length === 0 || item.score > 0)
    .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
    .map((item) => item.tool);
  const tools = rankedTools.slice(0, limit).map((tool, index) => {
    const { input_schema, ...summary } = tool;
    return includeSchemas && index < schemaLimit
      ? { ...summary, input_schema }
      : summary;
  });

  return {
    tools,
    totalMatches: rankedTools.length,
    truncated: rankedTools.length > limit,
    schemaCount: includeSchemas ? Math.min(tools.length, schemaLimit) : 0,
    schemaLimited: includeSchemas && tools.length > schemaLimit,
  };
}

function mcpDiscoveryResultToToolResult(
  result: ReturnType<McpToolDiscoveryProvider["discoverTools"]>,
): ToolResult {
  return jsonResult(
    {
      ...result,
      count: result.tools.length,
    },
    true,
  );
}

function createMcpToolDiscoveryProvider(
  mcpHub: McpClientHub,
): McpToolDiscoveryProvider {
  return {
    discoverTools(request) {
      return discoverMcpTools(mcpHub, request);
    },
  };
}

function createMcpResourcePromptProvider(
  mcpHub: McpClientHub,
): McpResourcePromptProvider {
  return {
    listResources() {
      return mcpHub.getAllResources();
    },
    readResource(server, uri) {
      return mcpHub.readResource(server, uri);
    },
    listPrompts() {
      return mcpHub.getAllPrompts();
    },
    getPrompt(server, name, args) {
      return mcpHub.getPrompt(server, name, args);
    },
  };
}

function createMcpToolInvocationProvider(
  mcpHub: McpClientHub,
): McpToolInvocationProvider {
  return {
    getToolDefs() {
      return mcpHub.getToolDefs();
    },
    getServerConfig(serverName) {
      return mcpHub.getServerConfig(serverName);
    },
    callTool(request) {
      return mcpHub.callTool(request.toolName, request.input, {
        signal: request.signal,
      });
    },
  };
}

function createUserQuestionProvider(
  onQuestion: NonNullable<ToolDispatchContext["onQuestion"]>,
  pendingQuestionRecovery?: AgentToolExecutionRequest["context"]["pendingQuestionRecovery"],
): UserQuestionProvider {
  return {
    ask(request) {
      if (pendingQuestionRecovery) {
        return onQuestion(
          request.context,
          request.questions as Question[],
          request.sessionId,
          undefined,
          pendingQuestionRecovery,
        );
      }
      return onQuestion(
        request.context,
        request.questions as Question[],
        request.sessionId,
      );
    },
  };
}

function createSessionStatusProvider(
  ctx: ToolDispatchContext,
): SessionStatusProvider {
  return {
    setFinalStatus(marker) {
      ctx.onFinalStatus?.(marker);
    },
    completeTodos: ctx.onCompleteTodos
      ? () => ctx.onCompleteTodos?.() ?? []
      : undefined,
  };
}

function createModeSwitchProvider(
  onModeSwitch: NonNullable<ToolDispatchContext["onModeSwitch"]>,
  sessionId: string,
): ModeSwitchProvider {
  return {
    switchMode(request) {
      // Only ask_user modeSwitch consent passes the silent flag.
      return request.silent === undefined
        ? onModeSwitch(sessionId, request.mode, request.reason)
        : onModeSwitch(sessionId, request.mode, request.reason, request.silent);
    },
  };
}

export interface SessionImageReference {
  id: string;
  name: string;
  mimeType: string;
  base64: string;
  messageIndex: number;
  imageIndex: number;
}

export interface ToolDispatchContext {
  approvalManager: ApprovalManager;
  approvalPanel: ApprovalPanelProvider;
  sessionId: string;
  /** Immutable project identity captured for this request's tool runtime. */
  projectScope?: Readonly<
    import("../core/workspaceProjects.js").SessionProjectScope
  >;
  /** Available local root captured with projectScope; absent for projectless runtimes. */
  projectRoot?: string;
  /** All available local project roots in the logical workspace. */
  workspaceProjectRoots?: readonly string[];
  /** Prepares checkpoint coverage for every workspace root before mutation. */
  prepareWorkspaceMutation?: () => Promise<void>;
  /** Resolves the active session command policy at dispatch time. */
  getCommandApprovalPolicy?: (sessionId: string) => CommandApprovalPolicy;
  /** Restricts execute_command independently of user approval settings. */
  commandExecutionPolicy?: import("../core/capabilities/terminal.js").CommandExecutionPolicy;
  /** Snapshots session-scoped approvals from a spawning session into its child. */
  inheritSessionApprovalState?: (
    parentSessionId: string,
    childSessionId: string,
  ) => void;
  commandApprovalReviewer?: CommandApprovalReviewer;
  isSessionActive?: (sessionId: string) => boolean;
  getCommandReviewObjective?: (sessionId: string) => string | undefined;
  getCommandReviewContext?: (
    sessionId: string,
  ) => import("../approvals/commandApprovalReview.js").CommandReviewContextEntry[];
  delegationPolicy?: {
    ownedPaths?: string[];
    forbiddenPaths?: string[];
    onDecision?: (decision: {
      decision: "allowed" | "denied";
      operation: string;
      reason: string;
      path?: string;
    }) => void;
  };
  extensionUri: import("vscode").Uri;
  globalStorageUri?: import("vscode").Uri;
  trackerCtx?: import("./AgentToolCallTracker.js").TrackerContext;
  toolCallTracker?: import("./AgentToolCallTracker.js").AgentToolCallTracker;
  mcpHub?: McpClientHub;
  /** Owned stable MCP generation reference for this request. Internal lifecycle metadata. */
  mcpHubLease?: import("./ProjectMcpHubRegistry.js").ProjectMcpHubLease;
  /** Current agent mode slug (e.g. "architect", "code"). Used for mode-specific approval logic. */
  mode?: string;
  onModeSwitch?: (
    sessionId: string,
    mode: string,
    reason?: string,
    /**
     * When true, perform the mode switch without prompting the user for a
     * separate approval. Used by ask_user when the user's choice already
     * represents consent (per-question modeSwitch map).
     */
    silent?: boolean,
  ) => Promise<{
    approved: boolean;
    mode: string;
    followUp?: string;
    rejectionReason?: string;
  }>;
  onApprovalRequest?: import("../shared/types.js").OnApprovalRequest;
  onQuestion?: (
    context: string,
    questions: import("../agent/webview/types.js").Question[],
    sessionId: string,
    /**
     * When set, indicates the question is from a background agent with this
     * task name. The UI uses this for attribution on the question card.
     */
    backgroundTask?: string,
    pendingQuestionRecovery?: AgentToolExecutionRequest["context"]["pendingQuestionRecovery"],
  ) => Promise<QuestionResponse>;
  /** Called whenever the agent reads a file — used to track files for folded context on condense */
  onFileRead?: (filePath: string) => void;
  /** Returns images available in this session, including attachments and image tool results. */
  getSessionImages?: () => SessionImageReference[];
  /** Returns an immutable projection of the executing session's full transcript. */
  getSessionTranscript?: AgentToolExecutionRequest["context"]["getSessionTranscript"];
  /** Returns the set of skills explicitly advertised to the current session. */
  getAdvertisedSkills?: () => Array<{ name: string; skillPath: string }>;
  /** Returns the set of deferred rules explicitly advertised to the current session. */
  getAdvertisedRules?: () => Array<{
    source: string;
    filePath: string;
    summary?: string;
  }>;
  /** Called whenever the agent loads a skill so the session can preserve it across condense. */
  onSkillLoad?: (skillName: string) => void;
  /** Spawn a background agent session. Returns routing metadata and new session ID. */
  onSpawnBackground?: (
    callerSessionId: string,
    request: SpawnBackgroundRequest,
  ) => Promise<SpawnBackgroundResult>;
  /** Non-blocking status check for a background session. */
  onGetBackgroundStatus?: (
    callerSessionId: string,
    sessionId: string,
  ) => BgStatusResult;
  /** Wait for a background session to finish and return its last assistant message. */
  onGetBackgroundResult?: (
    callerSessionId: string,
    sessionId: string,
  ) => Promise<string | BackgroundAgentResultContent>;
  /** Kill a running background agent and return its partial output. */
  onKillBackground?: (
    callerSessionId: string,
    sessionId: string,
    reason?: string,
  ) => { killed: boolean; partialOutput?: string };
  onSteerBackground?: (
    callerSessionId: string,
    sessionId: string,
    message: string,
  ) => { accepted: boolean; reason?: string };
  onDetachBackground?: (
    callerSessionId: string,
    sessionId: string,
  ) => { detached: boolean; reason?: string };
  onStartFleetWorkflow?: (
    callerSessionId: string,
    request: FleetWorkflowRequest,
  ) => Promise<{
    workflowId: string;
    goalId?: string;
    sessions: SpawnBackgroundResult[];
  }>;
  onScheduleFleetAutomation?: (input: {
    name: string;
    workflow: FleetWorkflowRequest;
    everyMs?: number;
    eventType?: string;
  }) => Promise<FleetAutomation>;
  onCollectFleetWorkflow?: (
    workflowId: string,
    kind: FleetWorkflowKind,
  ) => Promise<FleetWorkflowOutcome>;
  onManageFleetAutomations?: (input: {
    action: "list" | "history" | "enable" | "disable" | "delete";
    id?: string;
  }) => Promise<unknown>;
  /** Active skill tool allowlist, enforced for direct and deferred MCP dispatch. */
  skillAllowedTools?: string[];
  /** Abort signal for the current tool call, used to cancel in-flight MCP SDK requests. */
  toolAbortSignal?: AbortSignal;
  /** Durable recovery context for a foreground ask_user call waiting on input. */
  pendingQuestionRecovery?: AgentToolExecutionRequest["context"]["pendingQuestionRecovery"];
  /** Records the intended final marker for the current foreground turn. */
  onFinalStatus?: (marker: FinalMessageMarker) => void;
  /** Structured result contract requested by the parent of a background session. */
  backgroundExpectedResult?: ExpectedBackgroundResult;
  /** Marks the current foreground todo list complete and returns the updated tree. */
  onCompleteTodos?: () => TodoItem[];
  /** Final status/todo implementation for runtimes that can own foreground session markers. */
  sessionStatusProvider?: SessionStatusProvider;
  /** Mode-switch implementation for runtimes that can request or perform agent mode changes. */
  modeSwitchProvider?: ModeSwitchProvider;
  /** Semantic codebase search implementation for runtimes that can provide an index. */
  semanticSearchProvider?: SemanticSearchProvider;
  /** Editor reveal implementation for runtimes that can open/highlight files. */
  editorRevealProvider?: EditorRevealProvider;
  /** Edit review/commit implementation for runtimes that can mutate files. */
  editReviewProvider?: EditReviewProvider;
  /** Write approval policy implementation for runtimes that can evaluate write trust. */
  writeApprovalPolicyProvider?: WriteApprovalPolicyProvider;
  /** Multi-file edit review/apply implementation for runtimes that can mutate files. */
  multiFileEditReviewProvider?: MultiFileEditReviewProvider;
  /** Rename-symbol implementation for runtimes with language refactor + workspace edit support. */
  renameSymbolProvider?: RenameSymbolProvider;
  /** Diagnostics implementation for runtimes with language diagnostics support. */
  diagnosticsProvider?: DiagnosticsProvider;
  /** Navigation implementation for runtimes with language definition/type/implementation support. */
  navigationProvider?: LanguageNavigationProvider;
  /** References implementation for runtimes with language reference support. */
  referencesProvider?: LanguageReferencesProvider;
  /** Symbols implementation for runtimes with document/workspace symbol support. */
  symbolsProvider?: LanguageSymbolsProvider;
  /** Hover implementation for runtimes with language hover support. */
  hoverProvider?: LanguageHoverProvider;
  /** Completion implementation for runtimes with language completion support. */
  completionsProvider?: LanguageCompletionsProvider;
  /** Inlay-hints implementation for runtimes with language inlay-hints support. */
  inlayHintsProvider?: LanguageInlayHintsProvider;
  /** Hierarchy implementation for runtimes with language call/type hierarchy support. */
  hierarchyProvider?: LanguageHierarchyProvider;
  /** Code-action retrieval/apply implementation for runtimes with language code-action support. */
  codeActionsProvider?: LanguageCodeActionsProvider;
  /** Terminal/process implementation for runtimes with managed terminal support. */
  terminalProvider?: TerminalProvider;
  /** Worktree/agent-launch implementation for runtimes that can create/open worktree agent sessions. */
  worktreeAgentLaunchProvider?: WorktreeAgentLaunchProvider;
  /** Background-agent lifecycle implementation for runtimes that can spawn/manage agent sessions. */
  backgroundAgentProvider?: BackgroundAgentProvider;
  /** Provider-hosted implementation for request-scoped AgentLink native web tools. */
  nativeWebToolProvider?: NativeWebToolExecutionProvider;
  /** Native web tool kinds exposed by the immutable request policy snapshot. */
  nativeWebToolKinds?: readonly import("../core/webAccess.js").CoreWebToolKind[];
  /** MCP tool discovery implementation for runtimes with connected MCP clients. */
  mcpToolDiscoveryProvider?: McpToolDiscoveryProvider;
  /** MCP resource/prompt implementation for runtimes with connected MCP clients. */
  mcpResourcePromptProvider?: McpResourcePromptProvider;
  /** MCP tool invocation implementation for runtimes with connected MCP clients. */
  mcpToolInvocationProvider?: McpToolInvocationProvider;
  /** User-question implementation for runtimes that can ask structured questions. */
  userQuestionProvider?: UserQuestionProvider;
  /** Local aggregate usage recorder for tool/parameter deprecation analysis. */
  toolUsageTelemetry?: ToolUsageTelemetry;
}

export function createAgentToolRuntime(
  ctx: ToolDispatchContext,
): AgentToolRuntime {
  return {
    listTools(request) {
      return getAgentTools(
        request.mode as AgentMode | undefined,
        request.mcpToolDefs,
        request.isBackground,
        request.toolProfile,
        request.skillAllowedTools,
        request.allMcpToolDefsForSkillAllowlist,
        request.backgroundExpectedResult,
        request.nativeWebToolKinds ?? ctx.nativeWebToolKinds,
      );
    },
    async executeTool(request: AgentToolExecutionRequest) {
      const startedAt = Date.now();
      try {
        enforceDelegatedPathPolicy(request.name, request.input, ctx);
        const mutationTarget = resolveWorkspaceMutationTarget(
          request.name,
          request.input,
          ctx,
        );
        if (PATH_MUTATING_TOOLS.has(request.name)) {
          await ctx.prepareWorkspaceMutation?.();
        }
        const operationRoots = mutationTarget
          ? [
              mutationTarget.projectRoot,
              ...(ctx.workspaceProjectRoots ?? []).filter(
                (root) =>
                  canonicalizePath(root) !==
                  canonicalizePath(mutationTarget.projectRoot),
              ),
            ]
          : (ctx.workspaceProjectRoots ??
            (ctx.projectRoot ? [ctx.projectRoot] : undefined));
        if (request.context.interactionPolicy === "deny") {
          const enforceReadPathPolicy = () =>
            enforceNonInteractiveReadPathPolicy(
              request.input,
              request.context.sessionId,
              ctx.approvalManager,
            );
          const denied = operationRoots
            ? withWorkspaceRoots(operationRoots, enforceReadPathPolicy)
            : enforceReadPathPolicy();
          if (denied) return denied;
        }
        const execute = async () =>
          request.name === "compose"
            ? __DEV_BUILD__
              ? await (
                  await loadComposeRuntime(ctx.extensionUri.fsPath)
                ).handleCompose({
                  params: request.input as unknown as ComposeParams,
                  scope: createComposeExecutionScope({
                    runtime: this,
                    parentContext: request.context,
                  }),
                  signal:
                    request.context.toolAbortSignal ??
                    new AbortController().signal,
                  wasmPath: path.join(
                    ctx.extensionUri.fsPath,
                    "dist",
                    "wasm",
                    "quickjs-release-asyncify.wasm",
                  ),
                })
              : errorResult("Tool 'compose' is available only in dev builds")
            : await dispatchToolCall(request.name, request.input, {
                ...ctx,
                sessionId: request.context.sessionId,
                mode: request.context.mode,
                commandExecutionPolicy:
                  request.context.commandExecutionPolicy ??
                  ctx.commandExecutionPolicy,
                backgroundExpectedResult:
                  request.context.backgroundExpectedResult,
                trackerCtx: request.context
                  .trackerCtx as ToolDispatchContext["trackerCtx"],
                toolAbortSignal: request.context.toolAbortSignal,
                getAdvertisedSkills: request.context.getAdvertisedSkills,
                getAdvertisedRules: request.context.getAdvertisedRules,
                onSkillLoad: request.context.onSkillLoad,
                skillAllowedTools: request.context.skillAllowedTools,
                onFinalStatus: request.context.onFinalStatus,
                onCompleteTodos: request.context.onCompleteTodos as
                  | ToolDispatchContext["onCompleteTodos"]
                  | undefined,
                getSessionImages: request.context.getSessionImages,
                getSessionTranscript: request.context.getSessionTranscript,
              });
        const result = operationRoots
          ? await withWorkspaceRoots(operationRoots, execute)
          : await execute();
        const composeTrace = result.uiMeta?.composeTrace;
        ctx.toolUsageTelemetry?.record({
          toolName: request.name,
          params:
            request.name === "compose"
              ? {
                  descriptionProvided:
                    typeof request.input.description === "string",
                }
              : request.input,
          source: "agent",
          mode: request.context.mode,
          projectId: ctx.projectScope?.projectId,
          outcome: getToolUsageOutcomeFromResult(result),
          durationMs: Date.now() - startedAt,
          ...(composeTrace
            ? {
                metrics: {
                  childCount: composeTrace.totalChildren,
                  completedChildCount: composeTrace.completedChildren,
                  toolAllBatchCount: composeTrace.toolAllBatchCount ?? 0,
                  bridgedBytes: composeTrace.bridgedBytes ?? 0,
                  ...(composeTrace.errorKind
                    ? { errorKind: composeTrace.errorKind }
                    : {}),
                  cancelled: composeTrace.status === "cancelled",
                },
              }
            : {}),
        });
        return result;
      } catch (err) {
        ctx.toolUsageTelemetry?.record({
          toolName: request.name,
          params: request.name === "compose" ? {} : request.input,
          source: "agent",
          mode: request.context.mode,
          projectId: ctx.projectScope?.projectId,
          outcome: "error",
          durationMs: Date.now() - startedAt,
        });
        throw err;
      }
    },
    isParallelSafe(toolName) {
      return READ_ONLY_TOOLS.has(toolName);
    },
    getToolCallTracker() {
      return ctx.toolCallTracker;
    },
    getConnectedMcpToolDefs() {
      return ctx.mcpHub?.getToolDefs() ?? [];
    },
    getMcpToolDisclosureMode(serverName: string) {
      return ctx.mcpHub?.getServerConfig(serverName)?.toolDisclosure;
    },
  };
}

function enforceNonInteractiveReadPathPolicy(
  input: Record<string, unknown>,
  sessionId: string,
  approvalManager: ApprovalManager,
): ToolResult | undefined {
  const inputPath = input.path;
  if (typeof inputPath !== "string" || inputPath.trim() === "")
    return undefined;

  const { absolutePath, inWorkspace } = resolveAndValidatePath(inputPath);
  if (
    inWorkspace ||
    isAgentlinkTmpArtifact(absolutePath) ||
    approvalManager.isPathTrusted(sessionId, absolutePath)
  ) {
    return undefined;
  }

  return errorResult(
    `Compose child path requires interactive approval and was denied: ${absolutePath}`,
    { status: "rejected", path: absolutePath, reason: "interaction_denied" },
  );
}

const PATH_MUTATING_TOOLS = new Set([
  "write_file",
  "apply_diff",
  "find_and_replace",
  "generate_image",
  "execute_command",
  "rename_symbol",
  "apply_code_action",
]);

function getMutationInputPaths(
  toolName: string,
  input: Record<string, unknown>,
): string[] {
  const keys =
    toolName === "generate_image"
      ? new Set(["output_path"])
      : toolName === "execute_command"
        ? new Set(["cwd"])
        : new Set(["path", "file", "directory"]);
  return Object.entries(input)
    .filter(([key]) => keys.has(key))
    .flatMap(([, value]) =>
      typeof value === "string"
        ? [value]
        : Array.isArray(value)
          ? value.filter((item): item is string => typeof item === "string")
          : [],
    );
}

function resolveWorkspaceMutationTarget(
  toolName: string,
  input: Record<string, unknown>,
  ctx: ToolDispatchContext,
): { targetPath: string; projectRoot: string } | undefined {
  if (!ctx.projectRoot || !PATH_MUTATING_TOOLS.has(toolName)) return undefined;
  const workspaceRoots = (ctx.workspaceProjectRoots ?? [ctx.projectRoot])
    .map(canonicalizePath)
    .sort((left, right) => right.length - left.length);

  for (const inputPath of getMutationInputPaths(toolName, input)) {
    const targetPath = canonicalizePath(
      path.isAbsolute(inputPath)
        ? inputPath
        : path.resolve(ctx.projectRoot, inputPath),
    );
    const projectRoot = workspaceRoots.find((root) =>
      isPathWithinRoot(targetPath, root),
    );
    if (projectRoot) return { targetPath, projectRoot };
  }
  return undefined;
}

function enforceDelegatedPathPolicy(
  toolName: string,
  input: Record<string, unknown>,
  ctx: ToolDispatchContext,
): void {
  const policy = ctx.delegationPolicy;
  if (!policy || !PATH_MUTATING_TOOLS.has(toolName)) return;
  const rawExecutionRoot = path.resolve(ctx.projectRoot ?? process.cwd());
  const rootKey = (value: string): string =>
    process.platform === "win32" ? value.toLowerCase() : value;
  const seenRoots = new Set<string>();
  const workspaceRoots = [
    rawExecutionRoot,
    ...(ctx.workspaceProjectRoots ?? []).map((root) => path.resolve(root)),
  ]
    .map((rawRoot) => ({ rawRoot, canonicalRoot: canonicalizePath(rawRoot) }))
    .filter(({ canonicalRoot }) => {
      const key = rootKey(canonicalRoot);
      if (seenRoots.has(key)) return false;
      seenRoots.add(key);
      return true;
    })
    .sort((left, right) => right.rawRoot.length - left.rawRoot.length);
  const canonicalizeWorkspacePath = (value: string): string => {
    const absolutePath = path.resolve(value);
    const canonicalPath = canonicalizePath(absolutePath);
    const canonicalOwner = workspaceRoots.find(({ canonicalRoot }) =>
      isPathWithinRoot(canonicalPath, canonicalRoot),
    );
    if (canonicalOwner) return canonicalPath;
    const lexicalOwner = workspaceRoots.find(({ rawRoot }) =>
      isPathWithinRoot(absolutePath, rawRoot),
    );
    return lexicalOwner
      ? path.resolve(
          lexicalOwner.canonicalRoot,
          path.relative(lexicalOwner.rawRoot, absolutePath),
        )
      : canonicalPath;
  };
  const canonicalExecutionRoot = canonicalizeWorkspacePath(rawExecutionRoot);
  const resolveInputPath = (value: string): string =>
    canonicalizeWorkspacePath(
      path.isAbsolute(value)
        ? value
        : path.resolve(canonicalExecutionRoot, value),
    );
  const resolveScopePaths = (value: string): string[] =>
    path.isAbsolute(value)
      ? [canonicalizeWorkspacePath(value)]
      : workspaceRoots.map(({ canonicalRoot }) =>
          canonicalizeWorkspacePath(path.resolve(canonicalRoot, value)),
        );
  const paths = Object.entries(input)
    .filter(([key]) => /(^|_)(path|file|directory)$/i.test(key))
    .flatMap(([, value]) =>
      typeof value === "string"
        ? [resolveInputPath(value)]
        : Array.isArray(value)
          ? value
              .filter((item): item is string => typeof item === "string")
              .map(resolveInputPath)
          : [],
    );
  if (paths.length === 0) return;
  const contains = (scope: string, targetPath: string) =>
    resolveScopePaths(scope).some((scopePath) =>
      isPathWithinRoot(targetPath, scopePath),
    );
  for (const targetPath of paths) {
    if (policy.forbiddenPaths?.some((scope) => contains(scope, targetPath))) {
      policy.onDecision?.({
        decision: "denied",
        operation: toolName,
        reason: "forbidden_path",
        path: targetPath,
      });
      throw new Error(
        `Delegation policy denied ${toolName} for forbidden path: ${targetPath}`,
      );
    }
    if (
      !workspaceRoots.some(({ canonicalRoot }) =>
        isPathWithinRoot(targetPath, canonicalRoot),
      )
    ) {
      policy.onDecision?.({
        decision: "denied",
        operation: toolName,
        reason: "outside_workspace_roots",
        path: targetPath,
      });
      throw new Error(
        `Delegation policy denied ${toolName} outside workspace roots: ${targetPath}`,
      );
    }
    if (
      policy.ownedPaths?.length &&
      !policy.ownedPaths.some((scope) => contains(scope, targetPath))
    ) {
      policy.onDecision?.({
        decision: "denied",
        operation: toolName,
        reason: "outside_owned_paths",
        path: targetPath,
      });
      throw new Error(
        `Delegation policy denied ${toolName} outside owned paths: ${targetPath}`,
      );
    }
    policy.onDecision?.({
      decision: "allowed",
      operation: toolName,
      reason: "delegated_path_allowed",
      path: targetPath,
    });
  }
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
  if (!__DEV_BUILD__ && TOOL_REGISTRY[toolName]?.devOnly) {
    return errorResult(`Tool '${toolName}' is available only in dev builds`);
  }

  const {
    approvalManager,
    approvalPanel,
    sessionId,
    extensionUri,
    mcpHub,
    onApprovalRequest,
    trackerCtx,
    toolAbortSignal,
  } = ctx;

  const skillAllowlist = ctx.skillAllowedTools
    ? new Set(ctx.skillAllowedTools)
    : undefined;

  if (toolName === "web_search" || toolName === "web_fetch") {
    const kind = toolName === "web_search" ? "search" : "fetch";
    if (!ctx.nativeWebToolKinds?.includes(kind) || !ctx.nativeWebToolProvider) {
      return errorResult(`Native ${kind} is not available for this request.`);
    }
    try {
      return jsonResult(
        await ctx.nativeWebToolProvider.execute({
          kind,
          input,
          signal: toolAbortSignal,
        }),
        true,
      );
    } catch (error) {
      return handleToolError(error, { tool: toolName, backend: "provider" });
    }
  }

  // Route MCP tools (prefixed with 'servername__') to the MCP hub
  if (McpClientHub.isMcpTool(toolName)) {
    if (!skillAllowlistAllowsMcpTool(skillAllowlist, toolName)) {
      return errorResult(
        `MCP tool is not allowed by the active skill allowed-tools allowlist: ${toolName}`,
      );
    }
    const mcpToolInvocationProvider =
      ctx.mcpToolInvocationProvider ??
      (mcpHub ? createMcpToolInvocationProvider(mcpHub) : undefined);
    if (!mcpToolInvocationProvider) {
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
    const parsedToolName = parseMcpToolName(toolName);
    if (!parsedToolName) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: `Invalid MCP tool name: ${toolName}`,
            }),
          },
        ],
      };
    }
    const { serverName, bareToolName } = parsedToolName;
    const serverConfig = mcpToolInvocationProvider.getServerConfig(serverName);
    const isAutoApproved =
      serverConfig?.toolPolicy === "allow" ||
      serverConfig?.allowedTools?.includes(bareToolName) ||
      approvalManager.isMcpApproved(sessionId, toolName);

    let promotionMeta:
      | import("../shared/types.js").McpApprovalPromotionMeta
      | undefined;

    let approvalFollowUp: string | undefined;

    if (!isAutoApproved) {
      const inputPreview = JSON.stringify(input, null, 2).slice(0, 600);
      let choice: string;
      let rejectionReason: string | undefined;

      if (onApprovalRequest) {
        const projectConfigPath = ctx.projectRoot
          ? getMcpConfigFilePaths(ctx.projectRoot).project
          : undefined;
        const raw = await onApprovalRequest(
          {
            kind: "mcp",
            title: `Allow MCP tool "${bareToolName}" from "${serverName}"?`,
            detail: inputPreview,
            mcpServerName: serverName,
            mcpToolName: bareToolName,
            targetPath: projectConfigPath,
            choices: [
              { label: "Allow once", value: "allow-once", isPrimary: true },
              {
                label: "Always allow tool (session)",
                value: "always-tool-session",
              },
              {
                label: `Always allow ${serverName} (session)`,
                value: "always-server-session",
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
          },
          sessionId,
        );
        if (typeof raw === "string") {
          choice = raw;
        } else {
          choice = raw.decision;
          approvalFollowUp = raw.followUp?.trim() || undefined;
          rejectionReason = raw.rejectionReason?.trim() || undefined;
        }
      } else {
        // Fallback VS Code modal (no inline card available)
        const alwaysAllowServer = `Always allow from ${serverName}` as const;
        const allowServerForSession =
          `Allow all ${serverName} tools for this session` as const;
        const vsChoice = await vscode.window.showWarningMessage(
          `Allow MCP tool "${bareToolName}" from "${serverName}"?`,
          { modal: true, detail: inputPreview },
          "Allow once",
          allowServerForSession,
          "Always allow this tool",
          alwaysAllowServer,
          "Deny",
        );
        choice =
          vsChoice === "Allow once"
            ? "allow-once"
            : vsChoice === allowServerForSession
              ? "always-server-session"
              : vsChoice === "Always allow this tool"
                ? "always-tool-project"
                : vsChoice === alwaysAllowServer
                  ? "always-server-project"
                  : "deny";
      }

      const allowChoices = new Set([
        "allow-once",
        "always-tool-session",
        "always-server-session",
        "always-tool-project",
        "always-tool-global",
        "always-server-project",
        "always-server-global",
      ]);
      if (!choice || !allowChoices.has(choice)) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "rejected_by_user",
                error: "User denied MCP tool execution",
                ...(rejectionReason && { reason: rejectionReason }),
                ...(approvalFollowUp && { follow_up: approvalFollowUp }),
              }),
            },
          ],
        };
      }

      const projectConfigPath = ctx.projectRoot
        ? getMcpConfigFilePaths(ctx.projectRoot).project
        : undefined;
      const globalConfigPath = path.join(
        os.homedir(),
        ".agentlink",
        "mcp.json",
      );

      switch (choice) {
        case "allow-once":
          promotionMeta = {
            serverName,
            bareToolName,
            scopes: [
              "session",
              ...(projectConfigPath ? (["project"] as const) : []),
              "global",
            ],
          };
          break;
        case "always-tool-session":
          approvalManager.approveMcpTool(sessionId, toolName);
          break;
        case "always-server-session":
          approvalManager.approveMcpServer(sessionId, serverName);
          break;
        case "always-tool-project": {
          const filePath = projectConfigPath;
          if (!filePath) {
            return errorResult(
              "MCP project approval is unavailable because this request has no executable project root.",
            );
          }
          approvalManager.approveMcpTool(sessionId, toolName);
          persistMcpToolApproval(serverName, bareToolName, filePath).catch(
            () => undefined,
          );
          break;
        }
        case "always-tool-global":
          approvalManager.approveMcpTool(sessionId, toolName);
          persistMcpToolApproval(
            serverName,
            bareToolName,
            globalConfigPath,
          ).catch(() => undefined);
          break;
        case "always-server-project": {
          const filePath = projectConfigPath;
          if (!filePath) {
            return errorResult(
              "MCP project approval is unavailable because this request has no executable project root.",
            );
          }
          approvalManager.approveMcpServer(sessionId, serverName);
          persistMcpServerApproval(serverName, filePath).catch(() => undefined);
          break;
        }
        case "always-server-global":
          approvalManager.approveMcpServer(sessionId, serverName);
          persistMcpServerApproval(serverName, globalConfigPath).catch(
            () => undefined,
          );
          break;
        // "allow-once" — no extra action needed
      }
    }

    const result = await mcpToolInvocationProvider
      .callTool({ toolName, input, signal: toolAbortSignal })
      .catch(handleToolError);
    if (promotionMeta) {
      result.uiMeta = {
        ...result.uiMeta,
        mcpApprovalPromotion: promotionMeta,
      };
    }
    if (approvalFollowUp) {
      // The user typed a follow-up message alongside their approval; surface
      // it to the agent as an extra content block since the MCP server owns
      // the shape of the primary result.
      result.content = [
        ...result.content,
        {
          type: "text",
          text: JSON.stringify({ follow_up: approvalFollowUp }),
        },
      ];
    }
    return result;
  }

  const params = input as any;

  switch (toolName) {
    case "set_task_status": {
      const status = params.status;
      if (
        status !== "completed" &&
        status !== "waiting_for_user" &&
        status !== "blocked" &&
        status !== "cancelled"
      ) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: "Invalid status" }),
            },
          ],
        };
      }
      const expectedResult = ctx.backgroundExpectedResult;
      const structuredResult = params.result;
      if (status === "completed" && expectedResult) {
        if (
          !isFleetResultEnvelope(structuredResult) ||
          structuredResult.type !== expectedResult ||
          (expectedResult === "review_findings" &&
            structuredResult.type === "review_findings" &&
            (typeof structuredResult.reviewedScope !== "string" ||
              typeof structuredResult.emptyDiff !== "boolean"))
        ) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: `Background completion requires a valid ${expectedResult} result in set_task_status.result`,
                }),
              },
            ],
          };
        }
      } else if (
        structuredResult !== undefined &&
        !isFleetResultEnvelope(structuredResult)
      ) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: "Invalid structured result" }),
            },
          ],
        };
      }
      let summary =
        typeof params.summary === "string" ? params.summary.trim() : "";
      if (isTeaserOnlyFinalSummary(summary)) {
        summary =
          "Task status was set, but the final summary only promised an artifact and did not include it. Expand the `set_task_status` tool input below to inspect what the agent attempted to send.";
      }
      const continueLabel =
        typeof params.continueLabel === "string"
          ? params.continueLabel.trim()
          : "";
      const continuePrompt =
        typeof params.continuePrompt === "string"
          ? params.continuePrompt.trim()
          : "";
      const marker: FinalMessageMarker = {
        status,
        source: "tool",
        ...(summary ? { summary } : {}),
        ...(structuredResult ? { result: structuredResult } : {}),
        ...(continueLabel && continuePrompt
          ? { continueAction: { label: continueLabel, prompt: continuePrompt } }
          : {}),
      };
      const sessionStatusProvider =
        ctx.sessionStatusProvider ?? createSessionStatusProvider(ctx);
      sessionStatusProvider.setFinalStatus(marker);
      const completeTodosRequested = params.completeTodos === true;
      const completedTodos =
        status === "completed" && completeTodosRequested
          ? sessionStatusProvider.completeTodos?.()
          : undefined;
      const completeTodosIgnored =
        completeTodosRequested && status !== "completed";
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: true,
              ...(completedTodos
                ? { completedTodos: completedTodos.length }
                : {}),
              ...(completeTodosIgnored
                ? {
                    completeTodosIgnored:
                      "completeTodos only applies when status is 'completed'",
                  }
                : {}),
            }),
          },
        ],
      };
    }

    // --- File reading ---
    case "read_file":
      if (ctx.onFileRead && typeof params.path === "string") {
        ctx.onFileRead(params.path);
      }
      return handleReadFile(
        params,
        approvalManager,
        approvalPanel,
        sessionId,
        ctx.getAdvertisedSkills?.() ?? [],
        createVscodeReadFileEnrichmentProvider(),
      );
    case "get_context":
      if (ctx.onFileRead && typeof params.path === "string") {
        ctx.onFileRead(params.path);
      }
      return handleGetContext(params, sessionId, {
        documentProvider: createVscodeContextDocumentProvider(
          approvalManager,
          approvalPanel,
        ),
        workingSetProvider: createVscodeContextWorkingSetProvider(),
        enrichmentProvider: createVscodeContextEnrichmentProvider(),
      });
    case "get_repo_map":
      if (ctx.onFileRead && typeof params.path === "string") {
        ctx.onFileRead(params.path);
      }
      return handleGetRepoMap(
        params,
        createVscodeStructuralGraphProvider(ctx.globalStorageUri),
      );
    case "get_module_neighbors":
      if (ctx.onFileRead && typeof params.path === "string") {
        ctx.onFileRead(params.path);
      }
      return handleGetModuleNeighbors(
        params,
        createVscodeStructuralGraphProvider(ctx.globalStorageUri),
      );
    case "load_rule":
      if (ctx.onFileRead && typeof params.path === "string") {
        ctx.onFileRead(params.path);
      }
      return handleLoadRule(
        params,
        approvalManager,
        approvalPanel,
        sessionId,
        ctx.getAdvertisedRules?.() ?? [],
        createVscodeAdvertisedArtifactProvider(),
      );
    case "load_skill": {
      const result = await handleLoadSkill(
        params,
        approvalManager,
        approvalPanel,
        sessionId,
        ctx.getAdvertisedSkills?.() ?? [],
        createVscodeAdvertisedArtifactProvider(),
      );
      try {
        const text = result.content.find((c) => c.type === "text")?.text;
        if (text && ctx.onSkillLoad) {
          const parsed = JSON.parse(text) as { skill_name?: string };
          if (parsed.skill_name) ctx.onSkillLoad(parsed.skill_name);
        }
      } catch {
        // ignore malformed/non-JSON results
      }
      return result;
    }
    case "list_files":
      return handleListFiles(
        params,
        approvalManager,
        approvalPanel,
        sessionId,
        {
          workspaceFileProvider: createVscodeWorkspaceFileProvider(),
          pathAccessProvider: createVscodePathAccessProvider(
            approvalManager,
            approvalPanel,
          ),
        },
      );
    case "search_files":
      return handleSearchFiles(
        params,
        approvalManager,
        approvalPanel,
        sessionId,
        {
          workspaceFileProvider: createVscodeWorkspaceFileProvider(),
          pathAccessProvider: createVscodePathAccessProvider(
            approvalManager,
            approvalPanel,
          ),
        },
      );
    case "search_session_history":
      return handleSearchSessionHistory(params, ctx.getSessionTranscript);
    case "read_session_excerpt":
      return handleReadSessionExcerpt(params, ctx.getSessionTranscript);

    // --- File writing ---
    case "write_file":
      return handleWriteFile(
        params,
        approvalManager,
        approvalPanel,
        sessionId,
        onApprovalRequest,
        ctx.mode,
        {
          editReviewProvider:
            ctx.editReviewProvider ?? createVscodeEditReviewProvider(),
          writeApprovalPolicyProvider:
            ctx.writeApprovalPolicyProvider ??
            createVscodeWriteApprovalPolicyProvider(approvalManager),
          diagnosticDelay: getConfiguredDiagnosticDelay(),
        },
      );
    case "generate_image":
      return handleGenerateImage(
        params,
        approvalManager,
        sessionId,
        onApprovalRequest,
        ctx.getSessionImages,
      );
    case "apply_diff":
      return handleApplyDiff(
        params,
        approvalManager,
        approvalPanel,
        sessionId,
        onApprovalRequest,
        ctx.mode,
        {
          editReviewProvider:
            ctx.editReviewProvider ?? createVscodeEditReviewProvider(),
          writeApprovalPolicyProvider:
            ctx.writeApprovalPolicyProvider ??
            createVscodeWriteApprovalPolicyProvider(approvalManager),
          diagnosticDelay: getConfiguredDiagnosticDelay(),
        },
      );
    case "find_and_replace":
      return handleFindAndReplace(
        params,
        approvalManager,
        approvalPanel,
        sessionId,
        extensionUri,
        onApprovalRequest,
        {
          multiFileEditReviewProvider:
            ctx.multiFileEditReviewProvider ??
            createVscodeMultiFileEditReviewProvider(
              approvalManager,
              extensionUri,
            ),
        },
      );
    case "rename_symbol":
      return handleRenameSymbol(
        params,
        approvalPanel,
        sessionId,
        onApprovalRequest,
        {
          renameSymbolProvider:
            ctx.renameSymbolProvider ??
            createVscodeRenameSymbolProvider(approvalManager),
        },
      );
    case "propose_memory":
      return handleProposeMemory(
        params as Parameters<typeof handleProposeMemory>[0],
        approvalPanel,
        onApprovalRequest,
        sessionId,
      );

    // --- Terminal ---
    case "execute_command":
      return handleExecuteCommand(
        params,
        approvalManager,
        approvalPanel,
        sessionId,
        trackerCtx,
        {
          terminalProvider:
            ctx.terminalProvider ?? createVscodeTerminalProvider(),
          getCommandApprovalPolicy: ctx.getCommandApprovalPolicy,
          commandApprovalReviewer: ctx.commandApprovalReviewer,
          isSessionActive: ctx.isSessionActive,
          toolAbortSignal,
          getUserObjective: ctx.getCommandReviewObjective,
          getReviewContext: ctx.getCommandReviewContext,
          commandExecutionPolicy:
            ctx.commandExecutionPolicy ??
            (ctx.mode === "ask" ? "read-only" : undefined),
        },
      );
    case "get_terminal_output":
      return handleGetTerminalOutput(params, {
        terminalProvider:
          ctx.terminalProvider ?? createVscodeTerminalProvider(),
      });
    case "close_terminals":
      return handleCloseTerminals(params, {
        terminalProvider:
          ctx.terminalProvider ?? createVscodeTerminalProvider(),
      });
    case "start_worktree_agent": {
      const worktreeAgentLaunchProvider =
        ctx.worktreeAgentLaunchProvider ??
        (ctx.globalStorageUri
          ? createVscodeWorktreeAgentLaunchProvider({
              globalStorageUri: ctx.globalStorageUri,
              onApprovalRequest,
              sessionId,
            })
          : undefined);
      if (!worktreeAgentLaunchProvider) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "error",
                error:
                  "Worktree agent startup is not available in this context.",
              }),
            },
          ],
        };
      }
      return worktreeAgentLaunchProvider.start({
        task: String(params.task ?? ""),
        prompt: String(params.prompt ?? ""),
        sourcePath:
          params.sourcePath !== undefined && params.sourcePath !== null
            ? String(params.sourcePath)
            : undefined,
        branch:
          params.branch !== undefined && params.branch !== null
            ? String(params.branch)
            : undefined,
        baseRef:
          params.baseRef !== undefined && params.baseRef !== null
            ? String(params.baseRef)
            : undefined,
        worktreePath:
          params.worktreePath !== undefined && params.worktreePath !== null
            ? String(params.worktreePath)
            : undefined,
        mode:
          params.mode !== undefined && params.mode !== null
            ? String(params.mode)
            : undefined,
        autoSubmit:
          typeof params.autoSubmit === "boolean"
            ? params.autoSubmit
            : undefined,
      });
    }

    // --- Editor ---
    case "open_file":
      return handleOpenFile(params, sessionId, {
        workspaceFileProvider: createVscodeWorkspaceFileProvider(),
        pathAccessProvider: createVscodePathAccessProvider(
          approvalManager,
          approvalPanel,
        ),
        editorRevealProvider:
          ctx.editorRevealProvider ?? createVscodeEditorRevealProvider(),
      });
    case "show_notification":
      return handleShowNotification(params);

    // --- Diagnostics & language ---
    case "get_diagnostics":
      return handleGetDiagnostics(params, {
        diagnosticsProvider:
          ctx.diagnosticsProvider ??
          createVscodeDiagnosticsProvider(ctx.projectRoot),
      });
    case "go_to_definition":
      return handleGoToDefinition(params, sessionId, {
        navigationProvider:
          ctx.navigationProvider ??
          createVscodeNavigationProvider(approvalManager, approvalPanel),
      });
    case "go_to_implementation":
      return handleGoToImplementation(params, sessionId, {
        navigationProvider:
          ctx.navigationProvider ??
          createVscodeNavigationProvider(approvalManager, approvalPanel),
      });
    case "go_to_type_definition":
      return handleGoToTypeDefinition(params, sessionId, {
        navigationProvider:
          ctx.navigationProvider ??
          createVscodeNavigationProvider(approvalManager, approvalPanel),
      });
    case "get_references":
      return handleGetReferences(params, sessionId, {
        referencesProvider:
          ctx.referencesProvider ??
          createVscodeReferencesProvider(approvalManager, approvalPanel),
      });
    case "get_symbols":
      return handleGetSymbols(params, sessionId, {
        symbolsProvider:
          ctx.symbolsProvider ??
          createVscodeSymbolsProvider(
            approvalManager,
            approvalPanel,
            ctx.projectRoot,
          ),
      });
    case "get_hover":
      return handleGetHover(params, sessionId, {
        hoverProvider:
          ctx.hoverProvider ??
          createVscodeHoverProvider(approvalManager, approvalPanel),
      });
    case "get_completions":
      return handleGetCompletions(params, sessionId, {
        completionsProvider:
          ctx.completionsProvider ??
          createVscodeCompletionsProvider(approvalManager, approvalPanel),
      });
    case "get_code_actions":
      return handleGetCodeActions(params, sessionId, {
        codeActionsProvider:
          ctx.codeActionsProvider ??
          createVscodeCodeActionsProvider(approvalManager, approvalPanel),
      });
    case "apply_code_action":
      return handleApplyCodeAction(params, sessionId, {
        codeActionsProvider:
          ctx.codeActionsProvider ??
          createVscodeCodeActionsProvider(approvalManager, approvalPanel),
      });
    case "get_call_hierarchy":
      return handleGetCallHierarchy(params, sessionId, {
        hierarchyProvider:
          ctx.hierarchyProvider ??
          createVscodeHierarchyProvider(approvalManager, approvalPanel),
      });
    case "get_type_hierarchy":
      return handleGetTypeHierarchy(params, sessionId, {
        hierarchyProvider:
          ctx.hierarchyProvider ??
          createVscodeHierarchyProvider(approvalManager, approvalPanel),
      });
    case "get_inlay_hints":
      return handleGetInlayHints(params, sessionId, {
        inlayHintsProvider:
          ctx.inlayHintsProvider ??
          createVscodeInlayHintsProvider(approvalManager, approvalPanel),
      });

    // --- Search ---
    case "codebase_search": {
      const provider =
        ctx.semanticSearchProvider ?? createUnavailableSemanticSearchProvider();
      return provider.search({
        query: String(params.query),
        path: params.path ? String(params.path) : undefined,
        limit: typeof params.limit === "number" ? params.limit : undefined,
        exclude_globs: Array.isArray(params.exclude_globs)
          ? params.exclude_globs.map(String)
          : undefined,
      });
    }

    case "find_mcp_tools": {
      const mcpToolDiscoveryProvider =
        ctx.mcpToolDiscoveryProvider ??
        (mcpHub ? createMcpToolDiscoveryProvider(mcpHub) : undefined);
      if (!mcpToolDiscoveryProvider)
        return errorResult("MCP hub not available");
      return mcpDiscoveryResultToToolResult(
        mcpToolDiscoveryProvider.discoverTools({
          query: params.query !== undefined ? String(params.query) : undefined,
          server:
            params.server !== undefined ? String(params.server) : undefined,
          includeSchemas:
            params.includeSchemas === true || params.includeSchemas === "true",
          schemaLimit:
            typeof params.schemaLimit === "number"
              ? params.schemaLimit
              : params.schemaLimit !== undefined
                ? Number(params.schemaLimit)
                : undefined,
          limit:
            typeof params.limit === "number"
              ? params.limit
              : params.limit !== undefined
                ? Number(params.limit)
                : undefined,
          skillAllowlist,
        }),
      );
    }

    case "call_mcp_tool": {
      const mcpToolInvocationProvider =
        ctx.mcpToolInvocationProvider ??
        (mcpHub ? createMcpToolInvocationProvider(mcpHub) : undefined);
      if (!mcpToolInvocationProvider)
        return errorResult("MCP hub not available");
      const server = String(params.server ?? "").trim();
      const tool = String(params.tool ?? "").trim();
      if (!server || !tool) {
        return errorResult("call_mcp_tool requires server and tool");
      }
      if (server.includes("__")) {
        return errorResult(
          "call_mcp_tool expects a server name without '__'; pass the bare tool name separately in tool",
        );
      }
      const toolName = `${server}__${tool}`;
      if (!skillAllowlistAllowsMcpTool(skillAllowlist, toolName)) {
        return errorResult(
          `MCP tool is not allowed by the active skill allowed-tools allowlist: ${toolName}`,
        );
      }
      if (
        !mcpToolInvocationProvider
          .getToolDefs()
          .some((toolDef) => toolDef.name === toolName)
      ) {
        return errorResult(
          `MCP tool not found: ${toolName}. Use find_mcp_tools to discover available tools.`,
        );
      }
      const toolInput =
        params.input &&
        typeof params.input === "object" &&
        !Array.isArray(params.input)
          ? (params.input as Record<string, unknown>)
          : {};
      if (!ctx.toolCallTracker) {
        return dispatchToolCall(toolName, toolInput, ctx);
      }

      const nestedToolCallId = `${ctx.trackerCtx?.toolCallId ?? `mcp-${randomUUID()}`}:${toolName}`;
      const controller = new AbortController();
      const abortNestedCall = () => controller.abort();
      if (ctx.toolAbortSignal?.aborted) {
        controller.abort();
      } else {
        ctx.toolAbortSignal?.addEventListener("abort", abortNestedCall, {
          once: true,
        });
      }
      let forceResolve!: (result: ToolResult) => void;
      const forcePromise = new Promise<ToolResult>((resolve) => {
        forceResolve = resolve;
      });
      const nestedTrackerCtx = ctx.toolCallTracker.registerAgentCall(
        nestedToolCallId,
        toolName,
        `${server}.${tool}`,
        ctx.sessionId,
        (result) => {
          controller.abort();
          forceResolve(result);
        },
        JSON.stringify(toolInput, null, 2),
      );

      try {
        return await Promise.race([
          dispatchToolCall(toolName, toolInput, {
            ...ctx,
            trackerCtx: nestedTrackerCtx,
            toolAbortSignal: controller.signal,
          }),
          forcePromise,
        ]);
      } finally {
        ctx.toolAbortSignal?.removeEventListener("abort", abortNestedCall);
        controller.abort();
        ctx.toolCallTracker.completeAgentCall(nestedToolCallId);
      }
    }

    case "list_mcp_resources": {
      const mcpResourcePromptProvider =
        ctx.mcpResourcePromptProvider ??
        (mcpHub ? createMcpResourcePromptProvider(mcpHub) : undefined);
      if (!mcpResourcePromptProvider)
        return errorResult("MCP hub not available");
      const resources = mcpResourcePromptProvider
        .listResources()
        .filter((resource) =>
          skillAllowlistAllowsMcpServer(skillAllowlist, resource.serverName),
        );
      return {
        content: [{ type: "text", text: JSON.stringify(resources, null, 2) }],
      };
    }

    case "read_mcp_resource": {
      const mcpResourcePromptProvider =
        ctx.mcpResourcePromptProvider ??
        (mcpHub ? createMcpResourcePromptProvider(mcpHub) : undefined);
      if (!mcpResourcePromptProvider)
        return errorResult("MCP hub not available");
      const server = String(params.server ?? "").trim();
      if (!skillAllowlistAllowsMcpServer(skillAllowlist, server)) {
        return errorResult(
          `MCP server is not allowed by the active skill allowed-tools allowlist: ${server}`,
        );
      }
      return mcpResourcePromptProvider.readResource(
        server,
        String(params.uri ?? ""),
      );
    }

    case "list_mcp_prompts": {
      const mcpResourcePromptProvider =
        ctx.mcpResourcePromptProvider ??
        (mcpHub ? createMcpResourcePromptProvider(mcpHub) : undefined);
      if (!mcpResourcePromptProvider)
        return errorResult("MCP hub not available");
      const prompts = mcpResourcePromptProvider
        .listPrompts()
        .filter((prompt) =>
          skillAllowlistAllowsMcpServer(skillAllowlist, prompt.serverName),
        );
      return {
        content: [{ type: "text", text: JSON.stringify(prompts, null, 2) }],
      };
    }

    case "get_mcp_prompt": {
      const mcpResourcePromptProvider =
        ctx.mcpResourcePromptProvider ??
        (mcpHub ? createMcpResourcePromptProvider(mcpHub) : undefined);
      if (!mcpResourcePromptProvider)
        return errorResult("MCP hub not available");
      const server = String(params.server ?? "").trim();
      if (!skillAllowlistAllowsMcpServer(skillAllowlist, server)) {
        return errorResult(
          `MCP server is not allowed by the active skill allowed-tools allowlist: ${server}`,
        );
      }
      const args = params.arguments as Record<string, string> | undefined;
      return mcpResourcePromptProvider.getPrompt(
        server,
        String(params.name ?? ""),
        args,
      );
    }

    case "ask_user": {
      const userQuestionProvider =
        ctx.userQuestionProvider ??
        (ctx.onQuestion
          ? createUserQuestionProvider(
              ctx.onQuestion,
              ctx.pendingQuestionRecovery,
            )
          : undefined);
      if (!userQuestionProvider) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: "Question handler not available" }),
            },
          ],
        };
      }
      const context = String(params.context ?? "").trim();
      const rawQuestions: unknown[] = Array.isArray(params.questions)
        ? params.questions
        : [];
      const questions: Question[] = rawQuestions.map((question: unknown) => {
        const q = question as Question;
        return {
          ...q,
          context: typeof q.context === "string" ? q.context.trim() : q.context,
        };
      });
      const hasQuestionContext = questions.some((q) => q.context?.trim());
      if (!context && !hasQuestionContext) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error:
                  "ask_user requires visible context, either top-level context or questions[].context, so the user can answer without relying on hidden thinking.",
              }),
            },
          ],
        };
      }

      // Reject calls that include modeSwitch on more than one question or on
      // unsupported question types — keeps a single, unambiguous mode change
      // per ask_user invocation.
      const modeSwitchQuestions = questions.filter(
        (q) => q.modeSwitch && Object.keys(q.modeSwitch).length > 0,
      );
      if (modeSwitchQuestions.length > 1) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error:
                  "Only one question per ask_user call may include modeSwitch",
              }),
            },
          ],
        };
      }
      const modeSwitchQuestion = modeSwitchQuestions[0];
      if (modeSwitchQuestion && modeSwitchQuestion.type !== "multiple_choice") {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error:
                  "modeSwitch is only supported on multiple_choice questions",
              }),
            },
          ],
        };
      }

      const response = await userQuestionProvider.ask({
        context,
        questions,
        sessionId: ctx.sessionId,
      });
      const modeSwitchProvider =
        ctx.modeSwitchProvider ??
        (ctx.onModeSwitch
          ? createModeSwitchProvider(ctx.onModeSwitch, ctx.sessionId)
          : undefined);
      return buildAskUserToolResult({
        context,
        questions,
        response,
        modeSwitchProvider,
      });
    }

    case "switch_mode": {
      const mode = String(params.mode ?? "");
      const reason = params.reason ? String(params.reason) : undefined;
      const modeSwitchProvider =
        ctx.modeSwitchProvider ??
        (ctx.onModeSwitch
          ? createModeSwitchProvider(ctx.onModeSwitch, ctx.sessionId)
          : undefined);
      if (!modeSwitchProvider) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: "Mode switching not available",
              }),
            },
          ],
        };
      }
      const switchResult = await modeSwitchProvider.switchMode({
        mode,
        reason,
      });
      if (!switchResult.approved) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "rejected_by_user",
                reason:
                  switchResult.rejectionReason?.trim() ||
                  `User denied mode switch to "${mode}"`,
                ...(switchResult.followUp?.trim()
                  ? { follow_up: switchResult.followUp.trim() }
                  : {}),
              }),
            },
          ],
        };
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: true,
              mode: switchResult.mode,
              ...(switchResult.followUp?.trim()
                ? { follow_up: switchResult.followUp.trim() }
                : {}),
            }),
          },
        ],
      };
    }

    case "spawn_background_agent": {
      const spawnBackground = ctx.backgroundAgentProvider
        ? (request: SpawnBackgroundRequest) =>
            ctx.backgroundAgentProvider!.spawn(request)
        : ctx.onSpawnBackground
          ? (request: SpawnBackgroundRequest) =>
              ctx.onSpawnBackground!(ctx.sessionId, request)
          : undefined;
      if (!spawnBackground) {
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
      const images = resolveBackgroundImages({
        imageIds: params.imageIds,
        useRecentImages: params.useRecentImages,
        getSessionImages: ctx.getSessionImages,
      });
      const result = await spawnBackground({
        task: String(params.task ?? ""),
        message: String(params.message ?? ""),
        mode:
          params.mode !== undefined && params.mode !== null
            ? String(params.mode)
            : undefined,
        model:
          params.model !== undefined && params.model !== null
            ? String(params.model)
            : undefined,
        provider:
          params.provider !== undefined && params.provider !== null
            ? String(params.provider)
            : undefined,
        taskClass:
          params.taskClass !== undefined && params.taskClass !== null
            ? String(params.taskClass)
            : undefined,
        modelTier:
          params.modelTier !== undefined && params.modelTier !== null
            ? String(params.modelTier) === "cheap" ||
              String(params.modelTier) === "balanced" ||
              String(params.modelTier) === "deep_reasoning"
              ? (String(
                  params.modelTier,
                ) as SpawnBackgroundRequest["modelTier"])
              : undefined
            : undefined,
        ownedPaths: Array.isArray(params.ownedPaths)
          ? params.ownedPaths.map(String)
          : undefined,
        forbiddenPaths: Array.isArray(params.forbiddenPaths)
          ? params.forbiddenPaths.map(String)
          : undefined,
        permissionProfile:
          params.permissionProfile === "review-only" ||
          params.permissionProfile === "workspace-safe" ||
          params.permissionProfile === "interactive"
            ? params.permissionProfile
            : undefined,
        worktree:
          params.worktree === "shared" || params.worktree === "isolated"
            ? params.worktree
            : undefined,
        ...(images.length ? { images } : {}),
        reviewScope:
          params.reviewScope && typeof params.reviewScope === "object"
            ? (() => {
                const scope = params.reviewScope as Record<string, unknown>;
                const paths = Array.isArray(scope.paths)
                  ? scope.paths.map(String)
                  : undefined;
                if (scope.kind === "working_tree") {
                  const include = Array.isArray(scope.include)
                    ? scope.include.filter(
                        (value): value is "staged" | "unstaged" | "untracked" =>
                          value === "staged" ||
                          value === "unstaged" ||
                          value === "untracked",
                      )
                    : undefined;
                  return { kind: "working_tree" as const, include, paths };
                }
                if (scope.kind === "files") {
                  return { kind: "files" as const, paths: paths ?? [] };
                }
                if (scope.kind === "commit_range") {
                  return {
                    kind: "commit_range" as const,
                    range: String(scope.range ?? ""),
                    paths,
                  };
                }
                if (scope.kind === "diff") {
                  return {
                    kind: "diff" as const,
                    content: String(scope.content ?? ""),
                    label:
                      scope.label === undefined
                        ? undefined
                        : String(scope.label),
                  };
                }
                return undefined;
              })()
            : undefined,
        expectedResult:
          params.expectedResult === "text" ||
          params.expectedResult === "review_findings" ||
          params.expectedResult === "patch" ||
          params.expectedResult === "verification"
            ? params.expectedResult
            : undefined,
        budget:
          params.budget && typeof params.budget === "object"
            ? (() => {
                const budget = params.budget as Record<string, unknown>;
                return {
                  maxTokens: Number(budget.maxTokens) || undefined,
                  maxToolCalls: Number(budget.maxToolCalls) || undefined,
                  maxApiTurns: Number(budget.maxApiTurns) || undefined,
                  maxElapsedMs: Number(budget.maxElapsedMs) || undefined,
                  maxEstimatedCostUsd:
                    Number(budget.maxEstimatedCostUsd) || undefined,
                  estimatedCostPerMillionTokens:
                    Number(budget.estimatedCostPerMillionTokens) || undefined,
                  warningThresholdRatio:
                    Number(budget.warningThresholdRatio) || undefined,
                  scope:
                    budget.scope === "subtree" || budget.scope === "goal"
                      ? budget.scope
                      : "session",
                };
              })()
            : undefined,
        goalId:
          typeof params.goalId === "string" ? params.goalId.trim() : undefined,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    }

    case "get_background_status": {
      const getBackgroundStatus = ctx.backgroundAgentProvider
        ? (sessionId: string) =>
            ctx.backgroundAgentProvider!.getStatus(sessionId)
        : ctx.onGetBackgroundStatus
          ? (sessionId: string) =>
              ctx.onGetBackgroundStatus!(ctx.sessionId, sessionId)
          : undefined;
      if (!getBackgroundStatus) {
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
      const statusResult = getBackgroundStatus(String(params.sessionId ?? ""));
      return {
        content: [{ type: "text", text: JSON.stringify(statusResult) }],
      };
    }

    case "get_background_result": {
      const getBackgroundResult = ctx.backgroundAgentProvider
        ? (sessionId: string) =>
            ctx.backgroundAgentProvider!.getResult(sessionId)
        : ctx.onGetBackgroundResult
          ? (sessionId: string) =>
              ctx.onGetBackgroundResult!(ctx.sessionId, sessionId)
          : undefined;
      if (!getBackgroundResult) {
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
      const bgResult = await getBackgroundResult(
        String(params.sessionId ?? ""),
      );
      if (typeof bgResult !== "string") {
        return {
          content: [
            { type: "text", text: bgResult.text },
            ...bgResult.images.map((image) => ({
              type: "image" as const,
              data: image.data,
              mimeType: image.mimeType,
            })),
          ],
        };
      }
      return {
        content: [{ type: "text", text: bgResult }],
      };
    }

    case "kill_background_agent": {
      const killBackground = ctx.backgroundAgentProvider
        ? (sessionId: string, reason?: string) =>
            ctx.backgroundAgentProvider!.kill(sessionId, reason)
        : ctx.onKillBackground
          ? (sessionId: string, reason?: string) =>
              ctx.onKillBackground!(ctx.sessionId, sessionId, reason)
          : undefined;
      if (!killBackground) {
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
      const killResult = killBackground(
        String(params.sessionId ?? ""),
        params.reason !== undefined ? String(params.reason) : undefined,
      );
      return {
        content: [{ type: "text", text: JSON.stringify(killResult) }],
      };
    }

    case "steer_background_agent": {
      if (!ctx.onSteerBackground) {
        return errorResult("Background steering not available");
      }
      const result = ctx.onSteerBackground(
        ctx.sessionId,
        String(params.sessionId ?? ""),
        String(params.message ?? ""),
      );
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }

    case "detach_background_agent": {
      if (!ctx.onDetachBackground) {
        return errorResult("Background detachment not available");
      }
      const result = ctx.onDetachBackground(
        ctx.sessionId,
        String(params.sessionId ?? ""),
      );
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }

    case "start_fleet_workflow": {
      if (!ctx.onStartFleetWorkflow) {
        return errorResult("Fleet workflows not available");
      }
      const allowedKinds = new Set<FleetWorkflowRequest["kind"]>([
        "structured_diff_review",
        "browser_verification",
        "best_of_n",
        "persistent_goal",
      ]);
      const kind = String(params.kind ?? "") as FleetWorkflowRequest["kind"];
      if (!allowedKinds.has(kind))
        return errorResult("Invalid fleet workflow kind");
      const candidates = Array.isArray(params.candidates)
        ? params.candidates
            .filter(
              (item: unknown): item is Record<string, unknown> =>
                typeof item === "object" && item !== null,
            )
            .map((item: Record<string, unknown>) => ({
              model: typeof item.model === "string" ? item.model : undefined,
              provider:
                typeof item.provider === "string" ? item.provider : undefined,
            }))
        : undefined;
      const result = await ctx.onStartFleetWorkflow(ctx.sessionId, {
        kind,
        task: String(params.task ?? ""),
        message: String(params.message ?? ""),
        goalId: typeof params.goalId === "string" ? params.goalId : undefined,
        candidates,
        budget:
          typeof params.budget === "object" && params.budget !== null
            ? (params.budget as FleetWorkflowRequest["budget"])
            : undefined,
      });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }

    case "schedule_fleet_workflow": {
      if (!ctx.onScheduleFleetAutomation) {
        return errorResult("Fleet automation scheduling not available");
      }
      if (!params.workflow || typeof params.workflow !== "object") {
        return errorResult("workflow is required");
      }
      const everyMinutes = Number(params.everyMinutes);
      const result = await ctx.onScheduleFleetAutomation({
        name: String(params.name ?? "Fleet automation"),
        workflow: params.workflow as unknown as FleetWorkflowRequest,
        everyMs:
          Number.isFinite(everyMinutes) && everyMinutes > 0
            ? everyMinutes * 60_000
            : undefined,
        eventType:
          typeof params.eventType === "string" ? params.eventType : undefined,
      });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }

    case "get_fleet_workflow_result": {
      if (!ctx.onCollectFleetWorkflow) {
        return errorResult("Fleet workflow collection not available");
      }
      const result = await ctx.onCollectFleetWorkflow(
        String(params.workflowId ?? ""),
        String(params.kind ?? "") as FleetWorkflowKind,
      );
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }

    case "manage_fleet_automations": {
      if (!ctx.onManageFleetAutomations) {
        return errorResult("Fleet automation management not available");
      }
      const action = String(params.action ?? "");
      if (
        !["list", "history", "enable", "disable", "delete"].includes(action)
      ) {
        return errorResult(`Invalid fleet automation action: ${action}`);
      }
      if (["enable", "disable", "delete"].includes(action) && !params.id) {
        return errorResult(`${action} requires an automation id`);
      }
      const result = await ctx.onManageFleetAutomations({
        action: action as "list" | "history" | "enable" | "disable" | "delete",
        id: typeof params.id === "string" ? params.id : undefined,
      });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }

    case "send_feedback": {
      if (!__DEV_BUILD__) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: "Unknown tool: send_feedback" }),
            },
          ],
        };
      }
      return handleSendFeedback(
        {
          tool_name: String(params.tool_name ?? ""),
          feedback: String(params.feedback ?? ""),
          tool_params:
            params.tool_params !== undefined
              ? String(params.tool_params)
              : undefined,
          tool_result_summary:
            params.tool_result_summary !== undefined
              ? String(params.tool_result_summary)
              : undefined,
        },
        sessionId,
        ctx.projectScope?.projectId,
      );
    }

    case "get_feedback": {
      if (!__DEV_BUILD__) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: "Unknown tool: get_feedback" }),
            },
          ],
        };
      }
      return handleGetFeedback({
        tool_name:
          params.tool_name !== undefined ? String(params.tool_name) : undefined,
      });
    }

    case "delete_feedback": {
      if (!__DEV_BUILD__) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: "Unknown tool: delete_feedback" }),
            },
          ],
        };
      }
      const indices = Array.isArray(params.indices)
        ? params.indices
            .map((v: unknown) => Number(v))
            .filter((n: number) => Number.isFinite(n))
        : [];
      return handleDeleteFeedback({ indices });
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
