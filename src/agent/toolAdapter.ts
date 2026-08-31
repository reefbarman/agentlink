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
  ResolvedAgentToolCall,
} from "../core/tools/types.js";
import type { BackgroundAgentStatusResult } from "../core/capabilities/background.js";
import {
  COMPOSABLE_TOOLS,
  PARALLEL_SAFE_TOOLS,
} from "../core/tools/toolCapabilities.js";
import {
  discoverNativeTools,
  getDeferredNativeTool,
} from "../core/tools/nativeToolDisclosure.js";
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
  mcpMutationTarget,
  type McpPolicyMutationProvider,
} from "./McpPolicyMutationProvider.js";
import type { McpConfigProvenance } from "./mcpConfig.js";
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
import type { CommandApprovalPolicy } from "@agentlink/protocol/command-approval-policy";
import type { CommandApprovalReviewer } from "../approvals/commandApprovalReview.js";
import type { NetworkApprovalReviewer } from "../approvals/networkApprovalReview.js";
import type {
  ActionApprovalReviewer,
  OutsideReadOperation,
} from "../approvals/actionApprovalReview.js";
import type { FinalMessageMarker } from "@agentlink/protocol/final-status";
import { isTeaserOnlyFinalSummary } from "../shared/finalSummaryHeuristics.js";
import { McpClientHub } from "./McpClientHub.js";
import type { UserQuestion as Question } from "@agentlink/protocol/structured-question";
import { IS_DEV_BUILD } from "../shared/buildFlags.js";
import {
  getConfirmationOptions,
  isConfirmationOptions,
} from "@agentlink/protocol/question-confirmation";
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
} from "@agentlink/protocol/tool-result";
import { getToolsForMode } from "./toolPermissions.js";
import { handleApplyDiff } from "../tools/applyDiff.js";
import { handleCloseTerminals } from "../tools/closeTerminals.js";
import { handleDeleteFeedback } from "../tools/deleteFeedback.js";
import { handleExecuteCommand } from "../tools/executeCommand.js";
import { handleFindAndReplace } from "../tools/findAndReplace.js";
import { handleGenerateImage } from "../tools/generateImage.js";
import { handlePresentImages } from "../tools/presentImages.js";
import { handleGetCallHierarchy } from "../tools/getCallHierarchy.js";
import { handleGetCompletions } from "../tools/getCompletions.js";
import { handleGetContext } from "../tools/context/getContext.js";
import { handleGetDiagnostics } from "../tools/getDiagnostics.js";
import { handleDiagnoseActivity } from "../tools/diagnoseActivity.js";
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

import { getConfiguredDiagnosticDelay } from "../adapters/vscode/agentLinkConfig.js";
import { handleLoadRule } from "../tools/loadRule.js";
import { handleLoadSkill } from "../tools/loadSkill.js";
import { handleOpenFile } from "../tools/openFile.js";
import type { GuardianOutsideReadOptions } from "../tools/pathAccessUI.js";
import { createGuardianOutsideWriteAuthorizationPreparer } from "../tools/actionWriteApproval.js";
import { handleProposeMemory } from "../tools/proposeMemory.js";
import {
  handleManageMemory,
  handleRecallMemory,
} from "../tools/autonomousMemory.js";
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
import { handleTriageFeedback } from "../tools/triageFeedback.js";

import { handleWriteFile } from "../tools/writeFile.js";
import type {
  EditReviewProvider,
  EditorRevealProvider,
  MultiFileEditReviewProvider,
  RenameSymbolProvider,
  WriteApprovalPromptEvent,
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
import type {
  SemanticSearchProvider,
  SemanticSearchResult,
} from "../core/capabilities/readSearch.js";
import type { MemoryToolProvider } from "../core/capabilities/memory.js";
import type {
  ManageMemoryToolInput,
  RecallMemoryToolInput,
} from "@agentlink/protocol/autonomous-memory";
import type { TerminalProvider } from "../core/capabilities/terminal.js";
import type { WorktreeAgentLaunchProvider } from "../core/capabilities/worktree.js";

import type {
  BackgroundAgentProvider,
  BackgroundAgentResultContent,
} from "../core/capabilities/background.js";
import type { NativeWebToolExecutionProvider } from "../core/capabilities/web.js";
import type { UserQuestionResponse } from "@agentlink/protocol/structured-question";
import type {
  ModeSwitchProvider,
  SessionStatusProvider,
  UserQuestionProvider,
} from "../core/capabilities/sessionControl.js";
import type {
  McpResourcePromptProvider,
  McpToolDiscoveryProvider,
  McpToolDiscoveryRequest,
  McpToolInvocationProvider,
} from "../core/capabilities/mcp.js";
import type {
  ToolUsageOutcome,
  ToolUsageMetrics,
  ToolUsageTelemetry,
} from "../telemetry/ToolUsageTelemetry.js";
import { parseMcpToolName } from "@agentlink/protocol/mcp-tool-identity";
import { isProviderSafeToolName } from "../core/tools/providerToolNames.js";
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
import { isAgentInstructionReadPath } from "../approvals/protectedPaths.js";
import { isAgentlinkTmpArtifact } from "../util/agentlinkTmpArtifacts.js";
import { getCodeRetrievalStoreRoot } from "../indexer/codeRetrievalIdentity.js";
import { createComposeExecutionScope } from "./compose/composeScope.js";
import type { ComposeParams } from "./compose/composeRuntime.js";
import { loadComposeRuntime } from "./compose/composeRuntimeLoader.js";

// --- Tools whose implementations support overlapping execution ---

export const READ_ONLY_TOOLS = new Set(PARALLEL_SAFE_TOOLS);

// --- Tools excluded from the agent (MCP-only or not applicable) ---

const NATIVE_DISCOVERY_BRIDGE_TOOLS = new Set([
  "find_native_tools",
  "call_native_tool",
]);
const SKILL_SESSION_CONTEXT_TOOLS = new Set([
  "search_session_history",
  "read_session_excerpt",
]);
const ALWAYS_AVAILABLE_DEV_TOOLS = new Set(["send_feedback"]);

const EXCLUDED_TOOLS = new Set([
  "handshake",
  "load_rule",
  "load_skill",
  "respond_to_background_question",
]);

/**
 * Registered language tools hidden from ordinary model catalogs while their
 * unique value is benchmarked. A custom mode can opt in with the explicit
 * `language-benchmark` tool group without changing registration or dispatch.
 */
export const BENCHMARK_LANGUAGE_TOOLS = new Set([
  "get_completions",
  "get_inlay_hints",
  "get_code_actions",
  "apply_code_action",
]);

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
  find_native_tools: schemas.findNativeToolsSchema,
  call_native_tool: schemas.callNativeToolSchema,
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
  diagnose_activity: schemas.diagnoseActivitySchema,
  get_diagnostics: schemas.getDiagnosticsSchema,
  write_file: schemas.writeFileSchema,
  generate_image: schemas.generateImageSchema,
  present_images: schemas.presentImagesSchema,
  manage_memory: schemas.manageMemorySchema,
  recall_memory: schemas.recallMemorySchema,
  apply_diff: schemas.applyDiffSchema,
  find_and_replace: schemas.findAndReplaceSchema,
  rename_symbol: schemas.renameSymbolSchema,
  propose_memory: schemas.proposeMemorySchema,
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
  respond_to_background_question: schemas.respondToBackgroundQuestionSchema,
  compose: schemas.composeSchema,
  ...(IS_DEV_BUILD
    ? {
        send_feedback: schemas.sendFeedbackSchema,
        get_feedback: schemas.getFeedbackSchema,
        triage_feedback: schemas.triageFeedbackSchema,
        delete_feedback: schemas.deleteFeedbackSchema,
      }
    : {}),
};

/**
 * Read-only inventory of native adapter schemas. Stage 0 evaluation baselines
 * use this to detect drift across the currently fragmented tool registries
 * without making this adapter mapping a second mutable registry.
 */
export const NATIVE_TOOL_SCHEMA_NAMES: ReadonlySet<string> = new Set(
  Object.keys(TOOL_SCHEMAS),
);

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
    "Ask one or more structured questions and wait for responses before continuing. In a foreground session this asks the user. In a native background session the root foreground coordinator answers first and decides whether human escalation is necessary. Prefer `questions[].context`: visible text for that specific question explaining why input is needed, the relevant trade-off/options, and your recommendation. Use top-level `context` only for a brief shared intro that applies to every question. For multi-question asks, split context across the individual questions instead of delivering one large block. Questions must be self-contained and must not rely on hidden thinking or prior messages; preceding assistant text does not satisfy the context requirement. Use `recommended` whenever you recommend a choice: it must exactly match the option label (use `Yes` or `No` for `yes_no`, or the numeric value as a string for `scale`) and renders a recommendation badge. Do not write \"(recommended)\" into an option label. Use `confirmation` for a direct two-button decision: it submits immediately without a separate acknowledgement or Submit/Cancel control. It defaults to `Yes` and `No`; provide exactly two distinct `options` strings to name its buttons, and the selected label is returned as the answer. To combine a user choice with a mode change (e.g. 'plan first → architect, just implement → code'), use a `multiple_choice` question with a `modeSwitch` map instead of calling `switch_mode` separately — this avoids a redundant approval. Only one question per call may include `modeSwitch`.",
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
                "Answer options (required for multiple_choice and multiple_select). For confirmation, provide exactly two distinct labels to replace the default Yes/No buttons.",
            },
            recommended: {
              type: "string",
              description:
                "Recommended option value. Match an option label exactly (use Yes or No for yes_no), or use the numeric value as a string for scale; renders a recommendation badge.",
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
    "Mark the current turn's final status and end the current response unless another user interjection is already pending. Unfinished todos do not resume automatically after this tool. Use only when your response is final: completed, waiting_for_user, blocked, or cancelled. Do not call before ask_user, for intermediate progress updates, or to answer an interjected question when you intend to resume earlier work afterward; use ordinary visible text in those cases. The summary is the user-facing final response itself, not a meta-description of what you did. If the user asked for a concrete artifact (prompt, code, command, plan, review, answer), that artifact must be visible either in normal text before this tool call or fully inside summary. Never use summary as a teaser such as 'Here is the prompt' or 'See below'; content after this tool call is not a reliable place to deliver the answer. For code-modifying work, structure the summary around what changed, why it matters, validation run or skipped, and concrete follow-up. Include a short continuation button label and prompt when the user can safely continue with one click, especially when the summary mentions a concrete next phase, MVP slice, remaining plan item, follow-up task, or validation step.",
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
    "Request to switch the current agent mode (e.g. from 'code' to 'architect'). Approve for Me allows the switch automatically; otherwise the user must approve it. Available modes: code, architect, ask, debug.",
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

const RESPOND_TO_BACKGROUND_QUESTION_TOOL: ToolDefinition = {
  name: "respond_to_background_question",
  description:
    TOOL_REGISTRY.respond_to_background_question?.description ??
    "Answer a pending structured question from a background agent.",
  input_schema: cachedJsonSchemaFor(
    "respond_to_background_question",
    schemas.respondToBackgroundQuestionSchema,
  ),
};

/** Shared budget schema for spawn_background_agent and start_fleet_workflow. */
const AGENT_BUDGET_SCHEMA = {
  type: "object",
  description:
    "Optional soft resource-cap overrides for review and research task classes. Review and research agents receive automatic complexity-based tool-call, API-turn, and elapsed-time budgets; writable build, debug, design, verification, and general tasks run uncapped even if a budget is supplied. Review overrides merge only work-unit limits because token and cost caps are ignored when captured input can be large. Research overrides may also use token and cost caps. Reaching a cap asks the agent to finish promptly without blocking necessary tools; work is force-stopped only when observed usage reaches the 3x safety backstop.",
  properties: {
    maxTokens: {
      type: "number",
      description:
        "Cap on uncached input + output tokens summed across all API turns. Available for research tasks and ignored for review and writable task classes.",
    },
    maxToolCalls: {
      type: "number",
      description:
        "Soft cap on successfully committed tool invocations. Interrupted/provisional tool streams are not charged. Automatic review and research budgets allow substantially more tool calls than API turns so exploration is weighted less aggressively.",
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
}): Array<{ id: string; name: string; mimeType: string; base64: string }> {
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

  return unique.map(({ id, name, mimeType, base64 }) => ({
    id,
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
      "Spawn a background agent for work that genuinely benefits from running in parallel: research that cannot be answered with a few targeted reads, a non-conflicting workstream large enough to shorten time to the goal, an alternate debug hypothesis, or an end-of-task review of a substantial body of work. Prefer doing small or sequential work directly instead of delegating it. Returns immediately with a sessionId so the foreground can keep working; call get_background_status for non-blocking progress and get_background_result only when you need the final output. Automatic ACP routes fall back transparently to native when images require native handoff; an explicit ACP provider remains authoritative and rejects images.",
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

        imageIds: {
          type: "array",
          items: { type: "string" },
          description:
            "Specific image IDs from the current foreground session to copy into the background agent's first message. IDs follow image_1, image_2 order over the images currently visible in your context. The spawn result echoes attachedImages (id, name, mimeType) — verify it matches the images you intended. Native in-process backgrounds only; an automatic ACP default/review route falls back to native, while an explicit provider=acp:<id> request is rejected.",
        },
        useRecentImages: {
          oneOf: [{ type: "boolean" }, { type: "number" }],
          description:
            "Copy recent images from the foreground session into the background agent's first message. Includes user-attached images and screenshot/image tool results. Pass true for up to 4 recent images or a number for that many (maximum 8). Native in-process backgrounds only.",
        },
        reviewScope: {
          description:
            "Structured review target captured into an immutable snapshot when the background agent is spawned. Relative paths resolve from the executing project; absolute paths inside any open workspace root are accepted. working_tree defaults to unstaged tracked changes plus untracked files; Git scopes must stay within one root — in multi-root workspaces pass root (absolute path or folder name) to pick which one. files captures exact current files and may span roots, including non-Git workspaces. commit_range resolves Git diff output immediately. diff accepts already captured content. excludePaths is pushed into Git before output buffering and drops matching root-relative prefixes. Binary Git changes are captured as bounded metadata rather than binary patch payloads; oversized exact files are also recorded as metadata with content omitted.",
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
                excludePaths: { type: "array", items: { type: "string" } },
                root: { type: "string" },
              },
              required: ["kind"],
              additionalProperties: false,
            },
            {
              type: "object",
              properties: {
                kind: { type: "string", enum: ["files"] },
                paths: { type: "array", items: { type: "string" } },
                excludePaths: { type: "array", items: { type: "string" } },
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
                excludePaths: { type: "array", items: { type: "string" } },
                root: { type: "string" },
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
          description:
            "The exact sessionId returned by spawn_background_agent — copy it verbatim, a single dropped or altered character targets a different session",
        },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "get_background_result",
    description:
      "Wait for a background agent to finish and return its final response. Successful runs return the expected response; failed, interrupted, cancelled, unauthorized, or incomplete expected-result runs return structured JSON with status, terminalReason, retrySafe, agentRetryable, and preserved partialOutput when available. Use this for explicit pull/wait flows; skip it when a completion result was already pushed into context. Waiting releases your own background concurrency slot, so it is safe to block on a spawned agent that is still queued. If a user or steering message arrives for your own session while you wait, the call returns early with status wait_interrupted; the background agent keeps running untouched — handle the user's message first, then call get_background_result again.",
    input_schema: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          description:
            "The exact sessionId returned by spawn_background_agent — copy it verbatim, a single dropped or altered character targets a different session",
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

/**
 * Every static adapter-defined tool contract. Direct MCP target names are
 * intentionally excluded because connected catalogs make those names dynamic.
 * Engine-inline tools such as todo_write are reconciled separately.
 */
export const STATIC_ADAPTER_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...Object.keys(TOOL_REGISTRY),
  ...MCP_META_TOOLS.map((tool) => tool.name),
  CALL_MCP_TOOL.name,
  ASK_USER_TOOL.name,
  "set_task_status",
  SWITCH_MODE_TOOL.name,
  ...BG_AGENT_TOOLS.map((tool) => tool.name),
]);

/** Return value of get_background_status — non-blocking snapshot. */
export type BgStatusResult = BackgroundAgentStatusResult;

// --- Tool Profiles ---

/**
 * Named tool profiles that restrict the tool set for specific background task types.
 * Each profile is an allowlist of tool names from the native tool registry.
 */
const MCP_ENABLED_TOOL_PROFILES = new Set(["review", "readonly-research"]);

const MCP_APPROVAL_DETAIL_MAX_CHARS = 20_000;

const READ_ONLY_COMMAND_PROFILES = new Set([
  "review",
  "readonly-research",
  "worktree-setup",
]);

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
    "diagnose_activity",
    "recall_memory",
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
    "execute_command",
    "search_session_history",
    "read_session_excerpt",
    "diagnose_activity",
    "recall_memory",
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
    "search_session_history",
    "read_session_excerpt",
    "diagnose_activity",
  ]),
  "worktree-setup": new Set([
    "read_file",
    "get_context",
    "get_repo_map",
    "get_module_neighbors",
    "search_files",
    "list_files",
    "execute_command",
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
  skillAllowedTools?: readonly string[],
  allMcpToolDefsForSkillAllowlist?: ToolDefinition[],
  backgroundExpectedResult?: ExpectedBackgroundResult,
  nativeWebToolKinds: readonly import("../core/webAccess.js").CoreWebToolKind[] = [],
): ToolDefinition[] {
  const mcpToolNames = (mcpToolDefs ?? []).map((t) => t.name);
  const allowed = mode ? getToolsForMode(mode, mcpToolNames) : null;
  const benchmarkLanguageToolsEnabled =
    mode?.toolGroups.includes("language-benchmark") ?? false;
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
  const nativeToolEntries = Object.entries(TOOL_SCHEMAS)
    .sort(([a], [b]) => a.localeCompare(b))
    .filter(([name]) => !EXCLUDED_TOOLS.has(name))
    .filter(
      ([name]) =>
        !BENCHMARK_LANGUAGE_TOOLS.has(name) || benchmarkLanguageToolsEnabled,
    )
    .filter(([name]) => !(isBackground && name === "compose"))
    .filter(
      ([name]) =>
        (name !== "web_search" || nativeWebToolKinds.includes("search")) &&
        (name !== "web_fetch" || nativeWebToolKinds.includes("fetch")),
    )
    .filter(([name]) => IS_DEV_BUILD || !TOOL_REGISTRY[name]?.devOnly)
    .filter(
      ([name]) =>
        Boolean(profileAllowlist) ||
        !allowed ||
        allowed.has(name) ||
        NATIVE_DISCOVERY_BRIDGE_TOOLS.has(name) ||
        (IS_DEV_BUILD && TOOL_REGISTRY[name]?.devOnly),
    )
    .filter(
      ([name]) =>
        !profileAllowlist ||
        profileAllowlist.has(name) ||
        NATIVE_DISCOVERY_BRIDGE_TOOLS.has(name) ||
        ALWAYS_AVAILABLE_DEV_TOOLS.has(name),
    )
    .filter(
      ([name]) =>
        !skillAllowlist ||
        skillAllowlist.has(name) ||
        NATIVE_DISCOVERY_BRIDGE_TOOLS.has(name) ||
        SKILL_SESSION_CONTEXT_TOOLS.has(name) ||
        ALWAYS_AVAILABLE_DEV_TOOLS.has(name),
    );
  const composableChildNames = nativeToolEntries
    .map(([name]) => name)
    .filter((name) => COMPOSABLE_TOOLS.has(name));
  const nativeTools = nativeToolEntries.map(([name, zodSchema]) => ({
    name,
    description:
      name === "execute_command" && usesReadOnlyCommand
        ? "Run a recognized read-only command synchronously inside the workspace. Unknown, mutating, redirected, networked, privileged, opaque, background, timed, environment-bearing, forced, and inline-file commands are rejected. AgentLink disables interactive pagers; do not add routine `--no-pager`. Use `rg --no-config <pattern> [path ...]`. Place Git helper guards after the subcommand: `git diff --no-ext-diff --no-textconv ...`, `git show --no-ext-diff --no-textconv ...`, `git log --no-ext-diff --no-textconv ...`, and `git blame --no-textconv ...`. Plain commands such as `git status` and `git grep` need none of these flags."
        : name === "compose"
          ? `${TOOL_REGISTRY.compose.description} Composable children in this advertised tool union: ${composableChildNames.join(", ") || "none"}. list_files is composable only without query; search_files is composable only with semantic omitted or false.`
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
      ? mcpToolDefs
          .filter((tool) => isProviderSafeToolName(tool.name))
          .filter(
            (tool) =>
              !skillAllowlist ||
              skillAllowlistAllowsMcpTool(skillAllowlist, tool.name),
          )
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
    ...(!profileAllowlist && !isBackground
      ? [RESPOND_TO_BACKGROUND_QUESTION_TOOL]
      : []),
    ...(profileAllowlist ? [] : BG_AGENT_TOOLS),
  ];
}

/**
 * Context needed by the tool dispatcher.
 */
export type QuestionResponse = UserQuestionResponse;

export interface BackgroundQuestionAnswerRequest {
  callerSessionId: string;
  requestId: string;
  answers: QuestionResponse["answers"];
  notes: QuestionResponse["notes"];
}

export interface BackgroundQuestionAnswerResult {
  accepted: boolean;
  error?: string;
}

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

export function getToolUsageOutcomeFromResult(
  result: ToolResult,
): ToolUsageOutcome {
  const text = result.content.find((item) => item.type === "text")?.text;
  let structuredError = false;
  if (text) {
    try {
      const parsed = JSON.parse(text) as {
        error?: unknown;
        partial?: unknown;
        status?: unknown;
      };
      if (
        parsed.status === "rejected" ||
        parsed.status === "rejected_by_user"
      ) {
        return "rejected";
      }
      if (parsed.status === "cancelled") return "cancelled";
      if (parsed.partial === true || parsed.status === "partial")
        return "partial";
      structuredError =
        parsed.status === "error" || typeof parsed.error !== "undefined";
    } catch {
      // Plain text tool output is classified from canonical result fields below.
    }
  }
  if (result.isError) {
    return result.error?.kind === "aborted" ? "cancelled" : "error";
  }
  if (structuredError) return "error";
  return "ok";
}

const EXECUTE_COMMAND_ERROR_CODES = new Set([
  "sandbox_preparation_changed",
  "terminal_target_rejected",
  "sandbox_capability_launch_failed",
  "sandbox_pty_launch_failed",
]);
const EXECUTE_COMMAND_FAILURE_STAGES = new Set([
  "validation",
  "preparation",
  "approval",
  "launch",
]);
const SANDBOX_CAPABILITY_LAUNCH_FAILURES = new Set([
  "issue_failed",
  "compile_failed",
  "unknown_handle",
  "unknown_grant",
  "not_consumed",
  "consumed",
  "expired",
  "revoked",
  "wrong_session",
  "wrong_binding",
  "wrong_policy_version",
]);

/**
 * Approval-path and route dimensions for execute_command usage telemetry, so
 * the aggregate report can show how often commands were auto-approved
 * deterministically (tier/routine/sandbox verification), by the Guardian model
 * reviewer, or by a human, and which execution route served them.
 */
const WRITE_DURABILITY_REASONS = new Set([
  "save_failed",
  "preserving_save_failed",
  "save_reverted_edit",
  "editor_disk_diverged",
  "post_save_file_missing",
  "post_save_file_unreadable",
  "exact_preservation_failed",
  "missing_durability_evidence",
  "edit_review_state_missing",
]);

export function getWriteToolUsageMetrics(result: ToolResult): ToolUsageMetrics {
  const text = result.content.find((item) => item.type === "text")?.text;
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as {
      reason?: unknown;
      durability?: {
        status?: unknown;
        outcome?: unknown;
        policy?: unknown;
      };
    };
    const metrics: ToolUsageMetrics = {};
    if (
      parsed.durability?.status === "durable" ||
      parsed.durability?.status === "failed"
    ) {
      metrics.editDurabilityStatus = parsed.durability.status;
    }
    if (
      parsed.durability?.outcome === "exact" ||
      parsed.durability?.outcome === "transformed" ||
      parsed.durability?.outcome === "reverted" ||
      parsed.durability?.outcome === "diverged" ||
      parsed.durability?.outcome === "unverifiable"
    ) {
      metrics.editDurabilityOutcome = parsed.durability.outcome;
    }
    if (
      parsed.durability?.policy === "allow_transform" ||
      parsed.durability?.policy === "preserve_exact"
    ) {
      metrics.editDurabilityPolicy = parsed.durability.policy;
    }
    if (
      typeof parsed.reason === "string" &&
      WRITE_DURABILITY_REASONS.has(parsed.reason)
    ) {
      metrics.editDurabilityReason = parsed.reason;
    }
    return metrics;
  } catch {
    return {};
  }
}

export function getExecuteCommandUsageMetrics(
  result: ToolResult,
): ToolUsageMetrics {
  const text = result.content.find((item) => item.type === "text")?.text;
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as {
      approval?: { by?: unknown };
      security?: { route?: unknown };
      timed_out?: unknown;
      error_code?: unknown;
      failure_stage?: unknown;
      command_sent?: unknown;
      process_launched?: unknown;
      capability_failure?: unknown;
      retry_safe?: unknown;
      sandbox?: { grantTiming?: unknown };
    };
    const metrics: ToolUsageMetrics = {};
    if (typeof parsed.approval?.by === "string") {
      metrics.approval_by = parsed.approval.by;
    }
    if (typeof parsed.security?.route === "string") {
      metrics.route = parsed.security.route;
    }
    if (
      typeof parsed.error_code === "string" &&
      EXECUTE_COMMAND_ERROR_CODES.has(parsed.error_code)
    ) {
      metrics.error_code = parsed.error_code;
    }
    if (
      typeof parsed.failure_stage === "string" &&
      EXECUTE_COMMAND_FAILURE_STAGES.has(parsed.failure_stage)
    ) {
      metrics.failure_stage = parsed.failure_stage;
    }
    if (typeof parsed.command_sent === "boolean") {
      metrics.command_sent = parsed.command_sent;
    }
    if (typeof parsed.process_launched === "boolean") {
      metrics.process_launched = parsed.process_launched;
    }
    if (
      typeof parsed.capability_failure === "string" &&
      SANDBOX_CAPABILITY_LAUNCH_FAILURES.has(parsed.capability_failure)
    ) {
      metrics.capability_failure = parsed.capability_failure;
    }
    if (typeof parsed.retry_safe === "boolean") {
      metrics.retry_safe = parsed.retry_safe;
    }
    if (
      parsed.sandbox?.grantTiming === "preparation" ||
      parsed.sandbox?.grantTiming === "launch"
    ) {
      metrics.sandbox_grant_timing = parsed.sandbox.grantTiming;
    }
    if (parsed.timed_out === true) metrics.timed_out = true;
    return metrics;
  } catch {
    return {};
  }
}

const SEMANTIC_SEARCH_UNAVAILABLE_MESSAGE =
  "Semantic codebase search is unavailable in this runtime. Provide a SemanticSearchProvider to enable codebase_search.";

export function createUnavailableSemanticSearchProvider(): SemanticSearchProvider {
  return {
    async search() {
      return {
        payload: { error: SEMANTIC_SEARCH_UNAVAILABLE_MESSAGE },
        isError: true,
        error: {
          kind: "tool_error",
          message: SEMANTIC_SEARCH_UNAVAILABLE_MESSAGE,
        },
      };
    },
  };
}

function semanticSearchResultToToolResult(
  result: SemanticSearchResult,
): ToolResult {
  return {
    ...jsonResult(result.payload, true),
    ...(result.isError ? { isError: true } : {}),
    ...(result.error ? { error: result.error } : {}),
  };
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

function getMcpToolDefs(
  mcpHub: McpClientHub,
  access: ToolDispatchContext["mcpToolAccess"],
): ToolDefinition[] {
  return access === "read-only"
    ? mcpHub.getReadOnlyToolDefs()
    : mcpHub.getToolDefs();
}

function discoverMcpTools(
  mcpHub: McpClientHub,
  params: McpToolDiscoveryRequest,
  access?: ToolDispatchContext["mcpToolAccess"],
): ReturnType<McpToolDiscoveryProvider["discoverTools"]> {
  const queryTokens = discoveryTokens(String(params.query ?? ""));
  const serverFilter = String(params.server ?? "").trim();
  const skillAllowlist = params.skillAllowlist;
  const includeSchemas = params.includeSchemas === true;
  const schemaLimit = includeSchemas ? clampSchemaLimit(params.schemaLimit) : 0;
  const limit = clampToolLimit(params.limit);

  const rankedTools = getMcpToolDefs(mcpHub, access)
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
  access?: ToolDispatchContext["mcpToolAccess"],
): McpToolDiscoveryProvider {
  return {
    discoverTools(request) {
      return discoverMcpTools(mcpHub, request, access);
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
  access?: ToolDispatchContext["mcpToolAccess"],
): McpToolInvocationProvider {
  return {
    getToolDefs() {
      return getMcpToolDefs(mcpHub, access);
    },
    getServerConfig(serverName) {
      return mcpHub.getServerConfig(serverName);
    },
    callTool(request) {
      const parsed = parseMcpToolName(request.toolName);
      if (
        access === "read-only" &&
        (!parsed ||
          !mcpHub.isToolReadOnly(parsed.serverName, parsed.bareToolName))
      ) {
        throw new Error(
          `MCP tool is unavailable in this read-only background session: ${request.toolName}`,
        );
      }
      return mcpHub.callTool(request.toolName, request.input, {
        signal: request.signal,
        authorizedByCaller: request.authorizedByCaller,
      });
    },
  };
}

function createUserQuestionProvider(
  onQuestion: NonNullable<ToolDispatchContext["onQuestion"]>,
  pendingQuestionRecovery?: AgentToolExecutionRequest["context"]["pendingQuestionRecovery"],
  toolCallId?: string,
): UserQuestionProvider {
  return {
    ask(request) {
      if (toolCallId !== undefined) {
        return onQuestion(
          request.context,
          request.questions as Question[],
          request.sessionId,
          undefined,
          pendingQuestionRecovery,
          toolCallId,
        );
      }
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
  /** Whether this request belongs to an in-process background session. */
  isBackgroundSession?: boolean;
  /** Waits briefly for a user interjection without consuming it. */
  waitForPendingInterjection?: (timeoutMs: number) => Promise<boolean>;
  /** Immutable project identity captured for this request's tool runtime. */
  projectScope?: Readonly<
    import("@agentlink/protocol/workspace-project").SessionProjectScope
  >;
  /** Available local root captured with projectScope; absent for projectless runtimes. */
  projectRoot?: string;
  /** All available local project roots in the logical workspace. */
  workspaceProjectRoots?: readonly string[];
  /** Prepares checkpoint coverage for every workspace root before mutation. */
  prepareWorkspaceMutation?: () => Promise<void>;
  /** Resolves the active session command policy at dispatch time. */
  getCommandApprovalPolicy?: (sessionId: string) => CommandApprovalPolicy;
  /** Resolves the independent host-owned approval mode at dispatch time. */
  getCommandApprovalMode?: (
    sessionId: string,
  ) => import("@agentlink/protocol/terminal").TerminalApprovalModeSnapshot;
  /** Restricts execute_command independently of user approval settings. */
  commandExecutionPolicy?: import("@agentlink/protocol/terminal-security").CommandExecutionPolicy;
  /** Immutable lifecycle hook runtime captured for this logical turn. */
  hookRuntime?: import("../core/hooks/HookRuntime.js").HookRuntime;
  hookTurnId?: string;
  hookModel?: string;
  hookCwd?: string;
  /** Snapshots session-scoped approvals from a spawning session into its child. */
  inheritSessionApprovalState?: (
    parentSessionId: string,
    childSessionId: string,
  ) => void;
  commandApprovalReviewer?: CommandApprovalReviewer;
  networkApprovalReviewer?: NetworkApprovalReviewer;
  actionApprovalReviewer?: ActionApprovalReviewer;
  commandReviewTurnCircuit?: import("../approvals/commandApprovalReview.js").CommandReviewTurnCircuit;
  retainedCommandReviewDenials?: import("../approvals/commandApprovalReview.js").RetainedCommandReviewDenials;
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
  /** Provenance-routed durable MCP policy authority. */
  mcpPolicyMutationProvider?: McpPolicyMutationProvider;
  /** Restricts MCP discovery and invocation to explicitly annotated read-only tools. */
  mcpToolAccess?: "all" | "read-only";
  /** Owned stable MCP generation reference for this request. Internal lifecycle metadata. */
  mcpHubLease?: import("./ProjectMcpHubRegistry.js").ProjectMcpHubLease;
  /** Acquires the current MCP generation for one deferred MCP operation. */
  acquireCurrentMcpHub?: () => import("./ProjectMcpHubRegistry.js").ProjectMcpHubLease;
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
  onApprovalRequest?: import("@agentlink/protocol/inline-approval").OnApprovalRequest;
  onQuestion?: (
    context: string,
    questions: import("@agentlink/protocol/structured-question").UserQuestion[],
    sessionId: string,
    /**
     * When set, indicates the question is from a background agent with this
     * task name. The UI uses this for attribution on the question card.
     */
    backgroundTask?: string,
    pendingQuestionRecovery?: AgentToolExecutionRequest["context"]["pendingQuestionRecovery"],
    /** Exact provider tool-call identity used to correlate the result card. */
    toolCallId?: string,
  ) => Promise<QuestionResponse>;
  /** Resolves a background ask_user request after its root coordinator answers. */
  onRespondToBackgroundQuestion?: (
    request: BackgroundQuestionAnswerRequest,
  ) => BackgroundQuestionAnswerResult;
  /** Called whenever the agent reads a file — used to track files for folded context on condense */
  onFileRead?: (filePath: string) => void;
  /** Returns images available in this session, including attachments and image tool results. */
  getSessionImages?: () => SessionImageReference[];
  /** Returns an immutable projection of the executing session's full transcript. */
  getSessionTranscript?: AgentToolExecutionRequest["context"]["getSessionTranscript"];
  /** Resolves only the host-owned direct predecessor of this handoff successor. */
  getHandoffSourceTranscript?: AgentToolExecutionRequest["context"]["getHandoffSourceTranscript"];
  /** Returns bounded, redacted operation evidence for the executing session. */
  sessionActivityDiagnosticsProvider?: import("../core/sessionActivityDiagnostics.js").SessionActivityDiagnosticsProvider;
  /** Returns the set of skills explicitly advertised to the current session. */
  getAdvertisedSkills?: AgentToolExecutionRequest["context"]["getAdvertisedSkills"];
  /** Returns the set of deferred rules explicitly advertised to the current session. */
  getAdvertisedRules?: () => Array<{
    source: string;
    filePath: string;
    summary?: string;
  }>;
  /** Called whenever the agent loads a skill so the session can preserve it across condense. */
  onSkillLoad?: AgentToolExecutionRequest["context"]["onSkillLoad"];
  /** Spawn a background agent session. Returns routing metadata and new session ID. */
  onSpawnBackground?: (
    callerSessionId: string,
    request: SpawnBackgroundRequest,
    inheritedSkillAuthority: AgentToolExecutionRequest["context"]["skillAuthority"],
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
    inheritedSkillAuthority: AgentToolExecutionRequest["context"]["skillAuthority"],
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
  skillAllowedTools?: readonly string[];
  /** Exact immutable authority used only for internal descendant handoff. */
  skillAuthority?: AgentToolExecutionRequest["context"]["skillAuthority"];
  /** Abort signal for the current tool call, used to cancel in-flight MCP SDK requests. */
  toolAbortSignal?: AbortSignal;
  /** Durable recovery context for a foreground ask_user call waiting on input. */
  pendingQuestionRecovery?: AgentToolExecutionRequest["context"]["pendingQuestionRecovery"];
  /** Current provider tool-call identity for exact UI/result correlation. */
  toolCallId?: string;
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

  /** Background-agent lifecycle implementation for runtimes that can spawn/manage agent sessions. */
  backgroundAgentProvider?: BackgroundAgentProvider;
  /** Extension-owned launcher used only by the explicit /worktree shelf flow. */
  worktreeAgentLaunchProvider?: WorktreeAgentLaunchProvider;
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
  /** Typed low-authority memory implementation for autonomous management and recall. */
  memoryToolProvider?: MemoryToolProvider;
  /** Local aggregate usage recorder for tool/parameter deprecation analysis. */
  toolUsageTelemetry?: ToolUsageTelemetry;
}

export function resolveAgentToolCall(
  request: AgentToolExecutionRequest,
): ResolvedAgentToolCall {
  if (request.name !== "call_native_tool") {
    if (request.context.providerToolName === "call_native_tool") {
      const snapshot = request.context.nativeToolDisclosure;
      const target = snapshot
        ? getDeferredNativeTool(snapshot, request.name)
        : undefined;
      const targetSchema = target ? TOOL_SCHEMAS[target.name] : undefined;
      const parsedTarget = targetSchema
        ? z.object(targetSchema).safeParse(request.input)
        : undefined;
      if (!target || !parsedTarget?.success) {
        return nativeToolResolutionError(
          {
            ...request,
            name: "call_native_tool",
            input: {
              name: request.name,
              input: request.input,
            },
          },
          `Pre-resolved native tool '${request.name}' was not valid for this provider request`,
          "invalid_resolved_native_tool",
          parsedTarget && !parsedTarget.success
            ? parsedTarget.error.issues
            : undefined,
        );
      }
      return {
        providerName: "call_native_tool",
        providerInput: request.context.providerToolInput ?? {
          name: request.name,
          input: request.input,
        },
        canonicalName: target.name,
        canonicalInput: parsedTarget.data,
        route: "native-deferred",
      };
    }
    return {
      providerName: request.name,
      providerInput: request.input,
      canonicalName: request.name,
      canonicalInput: request.input,
      route: "direct",
    };
  }

  const parsedBridge = z
    .object(schemas.callNativeToolSchema)
    .safeParse(request.input);
  if (!parsedBridge.success) {
    return nativeToolResolutionError(
      request,
      "Invalid call_native_tool input",
      "invalid_bridge_input",
      parsedBridge.error.issues,
    );
  }

  const snapshot = request.context.nativeToolDisclosure;
  if (!snapshot) {
    return nativeToolResolutionError(
      request,
      "No deferred native tool catalog was captured for this provider request",
      "missing_native_catalog",
    );
  }

  const target = getDeferredNativeTool(snapshot, parsedBridge.data.name);
  if (!target) {
    return nativeToolResolutionError(
      request,
      `Native tool '${parsedBridge.data.name}' was not available in the deferred catalog for this provider request`,
      "native_tool_not_available",
    );
  }

  const targetSchema = TOOL_SCHEMAS[target.name];
  if (!targetSchema) {
    return nativeToolResolutionError(
      request,
      `Native tool '${target.name}' cannot be invoked through call_native_tool because it has no canonical runtime validator`,
      "native_tool_not_invocable",
    );
  }
  const parsedTarget = z
    .object(targetSchema)
    .safeParse(parsedBridge.data.input);
  if (!parsedTarget.success) {
    return nativeToolResolutionError(
      request,
      `Invalid input for native tool '${target.name}'`,
      "invalid_native_tool_input",
      parsedTarget.error.issues,
    );
  }

  return {
    providerName: request.name,
    providerInput: request.input,
    canonicalName: target.name,
    canonicalInput: parsedTarget.data,
    route: "native-deferred",
  };
}

function nativeToolResolutionError(
  request: AgentToolExecutionRequest,
  message: string,
  status: string,
  issues?: readonly z.core.$ZodIssue[],
): ResolvedAgentToolCall {
  return {
    providerName: request.name,
    providerInput: request.input,
    canonicalName: request.name,
    canonicalInput: request.input,
    route: "direct",
    resolutionError: errorResult(message, {
      status,
      tool: request.name,
      ...(issues ? { issues } : {}),
    }),
  };
}

function executeNativeToolDiscovery(
  request: AgentToolExecutionRequest,
): ToolResult {
  const parsed = z
    .object(schemas.findNativeToolsSchema)
    .safeParse(request.input);
  if (!parsed.success) {
    return errorResult("Invalid find_native_tools input", {
      status: "invalid_native_discovery_input",
      issues: parsed.error.issues,
    });
  }
  if (!request.context.nativeToolDisclosure) {
    return errorResult(
      "No deferred native tool catalog was captured for this provider request",
      { status: "missing_native_catalog" },
    );
  }
  const result = discoverNativeTools(request.context.nativeToolDisclosure, {
    query: parsed.data.query,
    limit: parsed.data.limit,
    offset: parsed.data.offset,
    includeSchemas: parsed.data.include_schemas,
    schemaLimit: parsed.data.schema_limit,
  });
  return jsonResult(result);
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
    resolveToolCall(request) {
      return resolveAgentToolCall(request);
    },
    async executeTool(originalRequest: AgentToolExecutionRequest) {
      const startedAt = Date.now();
      const resolved = resolveAgentToolCall(originalRequest);
      const request: AgentToolExecutionRequest = {
        name: resolved.canonicalName,
        input: { ...resolved.canonicalInput },
        context: {
          ...originalRequest.context,
          ...(resolved.route === "native-deferred"
            ? {
                providerToolName: resolved.providerName,
                providerToolInput: resolved.providerInput,
              }
            : {}),
        },
      };
      const providerToolName = request.context.providerToolName ?? request.name;
      try {
        if (resolved.resolutionError) return resolved.resolutionError;
        const hookRuntime = request.context.hookRuntime ?? ctx.hookRuntime;
        const hookTurnId = request.context.hookTurnId ?? ctx.hookTurnId ?? "";
        let preHookContext: readonly string[] = [];
        if (hookRuntime) {
          const preHook = await hookRuntime.preToolUse(
            {
              session_id: request.context.sessionId,
              turn_id: hookTurnId,
              transcript_path: null,
              cwd:
                request.context.hookCwd ?? ctx.hookCwd ?? ctx.projectRoot ?? "",
              hook_event_name: "PreToolUse",
              model: request.context.hookModel ?? ctx.hookModel ?? "",
              permission_mode: "default",
              tool_name: request.name,
              tool_input: request.input,
              tool_use_id: request.context.toolCallId ?? "",
            },
            request.name,
            request.context.toolAbortSignal,
            hookMatcherAliases(request.name),
          );
          preHookContext = preHook.additionalContext;
          if (preHook.preToolUse?.decision === "deny") {
            return errorResult(
              preHook.preToolUse.reason ??
                `Tool '${request.name}' was blocked by a PreToolUse hook.`,
              { status: "hook_blocked", tool: request.name },
            );
          }
          if (
            preHook.preToolUse?.updatedInput &&
            typeof preHook.preToolUse.updatedInput === "object" &&
            !Array.isArray(preHook.preToolUse.updatedInput)
          ) {
            request.input = {
              ...(preHook.preToolUse.updatedInput as Record<string, unknown>),
            };
          }
        }
        if (
          request.context.availableToolNames &&
          !request.context.availableToolNames.has(providerToolName)
        ) {
          return errorResult(
            `Tool '${providerToolName}' was not available in the provider request that emitted this call`,
            {
              status: "tool_not_available",
              tool: providerToolName,
            },
          );
        }
        // Advertised-but-out-of-mode tools (the advertised list is the
        // mode-independent union for cache stability) are rejected here with
        // the same semantics the per-mode advertisement used to enforce.
        if (
          request.context.modeAllowedToolNames &&
          !request.context.modeAllowedToolNames.has(request.name)
        ) {
          return errorResult(
            `Tool '${request.name}' is not available in ${request.context.mode ?? "the current"} mode. If this capability is genuinely needed, use switch_mode to change to a mode that allows it.`,
            {
              status: "tool_not_in_mode",
              tool: request.name,
            },
          );
        }
        enforceDelegatedPathPolicy(request.name, request.input, ctx);
        const mutationTarget = resolveWorkspaceMutationTarget(
          request.name,
          request.input,
          ctx,
        );
        if (
          PATH_MUTATING_TOOLS.has(request.name) &&
          !(
            request.name === "execute_command" &&
            (request.context.commandExecutionPolicy ??
              ctx.commandExecutionPolicy) === "read-only"
          )
        ) {
          await ctx.prepareWorkspaceMutation?.();
        }
        const preferredOperationRoot =
          mutationTarget?.projectRoot ?? ctx.projectRoot;
        const workspaceRoots =
          ctx.workspaceProjectRoots ??
          (ctx.projectRoot ? [ctx.projectRoot] : undefined);
        const operationRoots = preferredOperationRoot
          ? [
              preferredOperationRoot,
              ...(workspaceRoots ?? []).filter(
                (root) =>
                  canonicalizePath(root) !==
                  canonicalizePath(preferredOperationRoot),
              ),
            ]
          : workspaceRoots;
        if (request.context.interactionPolicy === "deny") {
          const enforceReadPathPolicy = () =>
            enforceNonInteractiveReadPathPolicy(
              request.name,
              request.input,
              request.context.sessionId,
              ctx.approvalManager,
              request.context.getAdvertisedSkills,
            );
          const denied = operationRoots
            ? withWorkspaceRoots(operationRoots, enforceReadPathPolicy)
            : enforceReadPathPolicy();
          if (denied) return denied;
        }
        const execute = async () =>
          request.name === "find_native_tools"
            ? executeNativeToolDiscovery(request)
            : request.name === "compose"
              ? IS_DEV_BUILD
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
                    retainArtifact: request.context.retainToolResultArtifact,
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
                  toolCallId: request.context.toolCallId,
                  getAdvertisedSkills: request.context.getAdvertisedSkills,
                  getAdvertisedRules: request.context.getAdvertisedRules,
                  onSkillLoad: request.context.onSkillLoad,
                  skillAllowedTools: request.context.skillAllowedTools,
                  skillAuthority: request.context.skillAuthority,
                  onFinalStatus: request.context.onFinalStatus,
                  onCompleteTodos: request.context.onCompleteTodos as
                    | ToolDispatchContext["onCompleteTodos"]
                    | undefined,
                  getSessionImages: request.context.getSessionImages,
                  getSessionTranscript: request.context.getSessionTranscript,
                  getHandoffSourceTranscript:
                    request.context.getHandoffSourceTranscript,
                  pendingQuestionRecovery:
                    request.context.pendingQuestionRecovery,
                });
        let result = operationRoots
          ? await withWorkspaceRoots(operationRoots, execute)
          : await execute();
        if (hookRuntime) {
          const postHook = await hookRuntime.postToolUse(
            {
              session_id: request.context.sessionId,
              turn_id: hookTurnId,
              transcript_path: null,
              cwd:
                request.context.hookCwd ?? ctx.hookCwd ?? ctx.projectRoot ?? "",
              hook_event_name: "PostToolUse",
              model: request.context.hookModel ?? ctx.hookModel ?? "",
              permission_mode: "default",
              tool_name: request.name,
              tool_input: request.input,
              tool_response: result,
              tool_use_id: request.context.toolCallId ?? "",
            },
            request.name,
            request.context.toolAbortSignal,
            hookMatcherAliases(request.name),
          );
          const hookContext = [
            ...preHookContext,
            ...postHook.additionalContext,
            ...postHook.feedback,
            ...(postHook.block?.reason ? [postHook.block.reason] : []),
          ];
          if (hookContext.length > 0) {
            result = {
              ...result,
              content: [
                ...result.content,
                {
                  type: "text",
                  text: `<hook_context event="PostToolUse">\n${hookContext.join("\n\n")}\n</hook_context>`,
                },
              ],
            };
          }
        }
        const composeTrace = result.uiMeta?.composeTrace;
        const executeCommandMetrics =
          request.name === "execute_command"
            ? getExecuteCommandUsageMetrics(result)
            : undefined;
        const writeToolMetrics =
          request.name === "write_file" || request.name === "apply_diff"
            ? getWriteToolUsageMetrics(result)
            : undefined;
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
                  succeededChildCount: composeTrace.succeededChildren ?? 0,
                  failedChildCount: composeTrace.failedChildren ?? 0,
                  cancelledChildCount: composeTrace.cancelledChildren ?? 0,
                  toolAllBatchCount: composeTrace.toolAllBatchCount ?? 0,
                  toolAllSettledBatchCount:
                    composeTrace.toolAllSettledBatchCount ?? 0,
                  bridgedBytes: composeTrace.bridgedBytes ?? 0,
                  ...(composeTrace.errorKind
                    ? { errorKind: composeTrace.errorKind }
                    : {}),
                  cancelled: composeTrace.status === "cancelled",
                },
              }
            : executeCommandMetrics && Object.keys(executeCommandMetrics).length
              ? { metrics: executeCommandMetrics }
              : writeToolMetrics && Object.keys(writeToolMetrics).length
                ? { metrics: writeToolMetrics }
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
    isParallelSafe(toolName, input) {
      if (toolName === "find_native_tools") return true;
      if (toolName === "call_native_tool") return false;
      if (READ_ONLY_TOOLS.has(toolName)) return true;
      if (toolName === "call_mcp_tool") {
        const serverName =
          typeof input?.server === "string" ? input.server.trim() : "";
        const bareToolName =
          typeof input?.tool === "string" ? input.tool.trim() : "";
        return Boolean(
          serverName &&
          bareToolName &&
          (ctx.mcpHub?.isToolParallelSafe?.(serverName, bareToolName) ??
            ctx.mcpHub?.supportsParallelToolCalls?.(serverName)),
        );
      }
      const parsedMcpTool = parseMcpToolName(toolName);
      return parsedMcpTool
        ? (ctx.mcpHub?.isToolParallelSafe?.(
            parsedMcpTool.serverName,
            parsedMcpTool.bareToolName,
          ) ??
            ctx.mcpHub?.supportsParallelToolCalls?.(parsedMcpTool.serverName) ??
            false)
        : false;
    },
    canOverlapLaterCall(runningToolName, _runningInput, laterToolName) {
      return (
        !ctx.isBackgroundSession &&
        runningToolName === "get_background_result" &&
        laterToolName === "close_terminals"
      );
    },
    getToolCallTracker() {
      return ctx.toolCallTracker;
    },
    getConnectedMcpToolDefs() {
      return ctx.mcpHub ? getMcpToolDefs(ctx.mcpHub, ctx.mcpToolAccess) : [];
    },
    getMcpToolDisclosureMode(serverName: string) {
      return ctx.mcpHub?.getServerConfig(serverName)?.toolDisclosure;
    },
  };
}

function hookMatcherAliases(toolName: string): readonly string[] {
  if (toolName === "execute_command") return ["Bash", "Shell", "shell_command"];
  if (toolName === "apply_diff" || toolName === "write_file") {
    return ["apply_patch", "Edit", "Write"];
  }
  return [];
}

function pathsMatch(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function isAdvertisedSkillRead(
  toolName: string,
  absolutePath: string,
  getAdvertisedSkills?: AgentToolExecutionRequest["context"]["getAdvertisedSkills"],
): boolean {
  if (toolName !== "load_skill" && toolName !== "read_file") return false;

  return (getAdvertisedSkills?.() ?? []).some((skill) => {
    const skillPath = canonicalizePath(skill.skillPath);
    const realSkillPath = canonicalizePath(skill.realSkillPath);
    if (toolName === "load_skill") {
      return (
        pathsMatch(absolutePath, skillPath) ||
        pathsMatch(absolutePath, realSkillPath) ||
        (skill.sourceScope === "builtin" &&
          (isPathWithinRoot(absolutePath, path.dirname(skillPath)) ||
            isPathWithinRoot(absolutePath, path.dirname(realSkillPath))))
      );
    }
    return (
      isPathWithinRoot(absolutePath, path.dirname(skillPath)) ||
      isPathWithinRoot(absolutePath, path.dirname(realSkillPath))
    );
  });
}

function enforceNonInteractiveReadPathPolicy(
  toolName: string,
  input: Record<string, unknown>,
  sessionId: string,
  approvalManager: ApprovalManager,
  getAdvertisedSkills?: AgentToolExecutionRequest["context"]["getAdvertisedSkills"],
): ToolResult | undefined {
  const inputPath = input.path;
  if (typeof inputPath !== "string" || inputPath.trim() === "")
    return undefined;

  const { absolutePath, inWorkspace } = resolveAndValidatePath(inputPath);
  if (
    inWorkspace ||
    isAgentlinkTmpArtifact(absolutePath) ||
    (toolName !== "load_skill" && isAgentInstructionReadPath(absolutePath)) ||
    isAdvertisedSkillRead(toolName, absolutePath, getAdvertisedSkills) ||
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
  "propose_memory",
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
    let allowedReason = "delegated_path_allowed";
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
      const hasMatchingOutsideWorkspaceAuthority =
        ctx.approvalManager.isPathTrusted(ctx.sessionId, targetPath) &&
        ctx.approvalManager.getFileWriteAuthorization(ctx.sessionId, targetPath)
          .allowed;
      if (hasMatchingOutsideWorkspaceAuthority) {
        allowedReason = "matching_outside_workspace_authority";
      } else {
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
      reason: allowedReason,
      path: targetPath,
    });
  }
}

function writeApprovalStateAgeBucket(ageMs: number | undefined): string {
  if (ageMs === undefined) return "absent";
  if (ageMs < 60_000) return "under_1m";
  if (ageMs < 60 * 60_000) return "1m_to_1h";
  if (ageMs < 24 * 60 * 60_000) return "1h_to_24h";
  return "over_24h";
}

function writeApprovalPromptReason(reason: string | undefined): string {
  switch (reason) {
    case "protected_memory_path":
    case "no_matching_write_authority":
    case "outside_workspace_requires_matching_rule":
    case "legacy_policy_provider":
      return reason;
    default:
      return reason ? "other_policy_denial" : "unspecified_policy_denial";
  }
}

function recordWriteApprovalPrompt(
  toolName: "write_file" | "apply_diff",
  event: WriteApprovalPromptEvent,
  ctx: ToolDispatchContext,
): void {
  const telemetry = ctx.toolUsageTelemetry;
  if (!telemetry) return;

  const metrics: ToolUsageMetrics = {
    writeApprovalPrompt: true,
    writeApprovalPromptReason: writeApprovalPromptReason(
      event.authorization.reason,
    ),
    writeApprovalAuthorizationBasis: event.authorization.basis,
    writeApprovalInWorkspace: event.inWorkspace,
    writeApprovalSessionKind: ctx.isBackgroundSession
      ? "background"
      : "foreground",
    writeApprovalMode: event.mode ?? ctx.mode ?? "unknown",
  };
  try {
    const diagnostics = ctx.approvalManager.getAgentWriteApprovalDiagnostics(
      event.sessionId,
      event.absolutePath,
    );
    Object.assign(metrics, {
      writeApprovalBlanketScope: diagnostics.effectiveScope,
      writeApprovalGlobalBlanketApproved: diagnostics.globalBlanketApproved,
      writeApprovalProjectBlanketApproved: diagnostics.projectBlanketApproved,
      writeApprovalSessionBlanketApproved: diagnostics.sessionBlanketApproved,
      writeApprovalLegacyGlobalBlanketApproved:
        diagnostics.legacyGlobalBlanketApproved,
      writeApprovalLegacyProjectBlanketApproved:
        diagnostics.legacyProjectBlanketApproved,
      writeApprovalLegacySessionBlanketApproved:
        diagnostics.legacySessionBlanketApproved,
      writeApprovalSessionProjectBound: diagnostics.sessionProjectBound,
      writeApprovalSessionStatePresent: diagnostics.sessionStatePresent,
      writeApprovalSessionStateAgeBucket: writeApprovalStateAgeBucket(
        diagnostics.sessionStateAgeMs,
      ),
      writeApprovalSessionRuleCount: diagnostics.writeRuleCounts.session,
      writeApprovalProjectRuleCount: diagnostics.writeRuleCounts.project,
      writeApprovalGlobalRuleCount: diagnostics.writeRuleCounts.global,
      writeApprovalSettingsRuleCount: diagnostics.writeRuleCounts.settings,
    });
  } catch {
    metrics.writeApprovalDiagnostics = "unavailable";
  }
  telemetry.recordMetrics(toolName, metrics);
}

/**
 * Dispatch a tool call to the appropriate handler.
 * Returns ToolResult compatible with the Anthropic SDK.
 */
export function createGuardianOutsideWritePreparer(
  ctx: ToolDispatchContext,
  sessionId: string,
  requestingTool: string,
  signal?: AbortSignal,
) {
  if (!ctx.actionApprovalReviewer) return undefined;
  return createGuardianOutsideWriteAuthorizationPreparer({
    reviewer: ctx.actionApprovalReviewer,
    sessionId,
    requestingTool,
    getPolicy: () => ctx.getCommandApprovalMode?.(sessionId),
    isSessionActive: () => ctx.isSessionActive?.(sessionId) ?? false,
    getUserObjective: () => ctx.getCommandReviewObjective?.(sessionId),
    getContext: () => ctx.getCommandReviewContext?.(sessionId) ?? [],
    signal,
  });
}

export function createGuardianOutsideReadOptions(
  ctx: ToolDispatchContext,
  sessionId: string,
  requestingTool: string,
  operation: OutsideReadOperation,
): GuardianOutsideReadOptions | undefined {
  if (!ctx.actionApprovalReviewer) return undefined;
  return {
    reviewer: ctx.actionApprovalReviewer,
    requestingTool,
    operation,
    getPolicy: () => ctx.getCommandApprovalMode?.(sessionId),
    isSessionActive: () => ctx.isSessionActive?.(sessionId) ?? false,
    getUserObjective: () => ctx.getCommandReviewObjective?.(sessionId),
    getContext: () => ctx.getCommandReviewContext?.(sessionId) ?? [],
  };
}

export async function dispatchToolCall(
  toolName: string,
  input: Record<string, unknown>,
  ctx: ToolDispatchContext,
): Promise<ToolResult> {
  if (!IS_DEV_BUILD && TOOL_REGISTRY[toolName]?.devOnly) {
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
      (mcpHub
        ? createMcpToolInvocationProvider(mcpHub, ctx.mcpToolAccess)
        : undefined);
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
    if (
      ctx.mcpToolAccess === "read-only" &&
      !mcpToolInvocationProvider
        .getToolDefs()
        .some((tool) => tool.name === toolName)
    ) {
      return errorResult(
        `MCP tool is unavailable in this read-only background session: ${toolName}`,
      );
    }
    const serverConfig = mcpToolInvocationProvider.getServerConfig(serverName);
    const sourceConfig = serverConfig as
      | (typeof serverConfig & {
          sourceServerName?: string;
          sourceProjectIds?: string[];
          sourceProjectRoots?: string[];
        })
      | undefined;
    const sourceServerName = sourceConfig?.sourceServerName ?? serverName;
    const opaqueProvenance = serverConfig?.provenance;
    const provenance: McpConfigProvenance =
      opaqueProvenance &&
      typeof opaqueProvenance === "object" &&
      "kind" in opaqueProvenance &&
      (opaqueProvenance.kind === "native" ||
        opaqueProvenance.kind === "agent-plugin")
        ? (opaqueProvenance as McpConfigProvenance)
        : {
            kind: "native",
            sourceServerName,
            sourceProjectIds: sourceConfig?.sourceProjectIds ?? [],
            sourceProjectRoots: sourceConfig?.sourceProjectRoots ?? [],
          };
    const sourceProjectIndex = ctx.projectScope
      ? sourceConfig?.sourceProjectIds?.indexOf(ctx.projectScope.projectId)
      : -1;
    const sourceProjectRoot =
      sourceProjectIndex !== undefined && sourceProjectIndex >= 0
        ? sourceConfig?.sourceProjectRoots?.[sourceProjectIndex]
        : sourceConfig?.sourceProjectRoots?.[0];
    const projectApprovalRoot = sourceProjectRoot ?? ctx.projectRoot;
    const isAutoApproved =
      serverConfig?.toolPolicy === "allow" ||
      serverConfig?.allowedTools?.includes(bareToolName) ||
      approvalManager.isMcpApproved(sessionId, toolName);

    let promotionMeta:
      | import("@agentlink/protocol/tool-result").McpApprovalPromotionMeta
      | undefined;

    let approvalFollowUp: string | undefined;

    if (!isAutoApproved) {
      const inputJson = JSON.stringify(input, null, 2) ?? "";
      // Inline approval cards render the detail in a scrollable box, so send
      // the full input; cap only pathological payloads (e.g. base64 blobs).
      const inputDetail =
        inputJson.length > MCP_APPROVAL_DETAIL_MAX_CHARS
          ? `${inputJson.slice(0, MCP_APPROVAL_DETAIL_MAX_CHARS)}\n… [input truncated: ${
              inputJson.length - MCP_APPROVAL_DETAIL_MAX_CHARS
            } more characters]`
          : inputJson;
      // The VS Code modal fallback cannot scroll, so keep a short preview.
      const inputPreview =
        inputJson.length > 600 ? `${inputJson.slice(0, 600)}…` : inputJson;
      let choice: string;
      let rejectionReason: string | undefined;

      if (onApprovalRequest) {
        const projectConfigPath = projectApprovalRoot
          ? getMcpConfigFilePaths(projectApprovalRoot).project
          : undefined;
        const raw = await onApprovalRequest(
          {
            kind: "mcp",
            title: `Allow MCP tool "${bareToolName}" from "${serverName}"?`,
            detail: inputDetail,
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

      const projectConfigPath = projectApprovalRoot
        ? getMcpConfigFilePaths(projectApprovalRoot).project
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
            mutationTarget: mcpMutationTarget(provenance, ctx.projectScope),
            scopes:
              provenance.kind === "agent-plugin"
                ? ["session", provenance.scope.kind]
                : [
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
          try {
            if (ctx.mcpPolicyMutationProvider && ctx.projectScope) {
              await ctx.mcpPolicyMutationProvider.persistToolApproval({
                provenance,
                bareToolName,
                scope: "project",
                requestingScope: ctx.projectScope,
              });
            } else {
              await persistMcpToolApproval(
                sourceServerName,
                bareToolName,
                filePath,
              );
            }
          } catch (error) {
            return errorResult(
              `Could not save the project MCP tool approval: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          approvalManager.approveMcpTool(sessionId, toolName);
          break;
        }
        case "always-tool-global":
          try {
            if (ctx.mcpPolicyMutationProvider && ctx.projectScope) {
              await ctx.mcpPolicyMutationProvider.persistToolApproval({
                provenance,
                bareToolName,
                scope: "global",
                requestingScope: ctx.projectScope,
              });
            } else {
              await persistMcpToolApproval(
                sourceServerName,
                bareToolName,
                globalConfigPath,
              );
            }
          } catch (error) {
            return errorResult(
              `Could not save the global MCP tool approval: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          approvalManager.approveMcpTool(sessionId, toolName);
          break;
        case "always-server-project": {
          const filePath = projectConfigPath;
          if (!filePath) {
            return errorResult(
              "MCP project approval is unavailable because this request has no executable project root.",
            );
          }
          try {
            if (ctx.mcpPolicyMutationProvider && ctx.projectScope) {
              await ctx.mcpPolicyMutationProvider.persistServerApproval({
                provenance,
                scope: "project",
                requestingScope: ctx.projectScope,
              });
            } else {
              await persistMcpServerApproval(sourceServerName, filePath);
            }
          } catch (error) {
            return errorResult(
              `Could not save the project MCP server approval: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          approvalManager.approveMcpServer(sessionId, serverName);
          break;
        }
        case "always-server-global":
          try {
            if (ctx.mcpPolicyMutationProvider && ctx.projectScope) {
              await ctx.mcpPolicyMutationProvider.persistServerApproval({
                provenance,
                scope: "global",
                requestingScope: ctx.projectScope,
              });
            } else {
              await persistMcpServerApproval(
                sourceServerName,
                globalConfigPath,
              );
            }
          } catch (error) {
            return errorResult(
              `Could not save the global MCP server approval: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          approvalManager.approveMcpServer(sessionId, serverName);
          break;
        // "allow-once" — no extra action needed
      }
    }

    const result = await mcpToolInvocationProvider
      .callTool({
        toolName,
        input,
        signal: toolAbortSignal,
        authorizedByCaller: true,
      })
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
        toolAbortSignal,
        ctx.actionApprovalReviewer
          ? createGuardianOutsideReadOptions(ctx, sessionId, "read_file", {
              kind: "read-file",
              offset: params.offset,
              limit: params.limit,
              includeSymbols: params.include_symbols !== false,
              autoFollowSuggestion: params.auto_follow_suggestion === true,
              ...(params.offset === undefined
                ? params.anchor !== undefined
                  ? {
                      selector: {
                        kind: "anchor" as const,
                        value: params.anchor,
                        offset: params.anchor_offset,
                      },
                    }
                  : params.anchor_regex !== undefined
                    ? {
                        selector: {
                          kind: "regex" as const,
                          value: params.anchor_regex,
                          offset: params.anchor_offset,
                        },
                      }
                    : params.query !== undefined
                      ? {
                          selector: {
                            kind: "query" as const,
                            value: params.query,
                            offset: params.anchor_offset,
                          },
                        }
                      : {}
                : {}),
            })
          : undefined,
        ctx.globalStorageUri
          ? {
              retrievalStoreRootForWorkspace: (workspaceRoot: string) =>
                getCodeRetrievalStoreRoot(
                  ctx.globalStorageUri!.fsPath,
                  workspaceRoot,
                ),
            }
          : {},
      );
    case "get_context":
      if (ctx.onFileRead && typeof params.path === "string") {
        ctx.onFileRead(params.path);
      }
      return handleGetContext(params, sessionId, {
        documentProvider: createVscodeContextDocumentProvider(
          approvalManager,
          approvalPanel,
          toolAbortSignal,
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
        createVscodeStructuralGraphProvider(
          ctx.globalStorageUri,
          vscode.workspace
            .getConfiguration("agentlink")
            .get<"standard" | "fine">("chunkGranularity", "fine"),
        ),
      );
    case "get_module_neighbors":
      if (ctx.onFileRead && typeof params.path === "string") {
        ctx.onFileRead(params.path);
      }
      return handleGetModuleNeighbors(
        params,
        createVscodeStructuralGraphProvider(
          ctx.globalStorageUri,
          vscode.workspace
            .getConfiguration("agentlink")
            .get<"standard" | "fine">("chunkGranularity", "fine"),
        ),
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
          const parsed = JSON.parse(text) as {
            skill_id?: string;
            skill_name?: string;
            revision?: string;
            skillPath?: string;
          };
          if (
            parsed.skill_id &&
            parsed.skill_name &&
            parsed.revision &&
            parsed.skillPath
          ) {
            ctx.onSkillLoad({
              id: parsed.skill_id,
              name: parsed.skill_name,
              revision: parsed.revision,
              skillPath: parsed.skillPath,
            });
          }
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
            {
              advertisedSkillPaths: (ctx.getAdvertisedSkills?.() ?? []).flatMap(
                (skill) => [skill.skillPath, skill.realSkillPath],
              ),
              signal: toolAbortSignal,
              guardian: createGuardianOutsideReadOptions(
                ctx,
                sessionId,
                "list_files",
                {
                  kind: "list",
                  recursive: params.recursive === true,
                  includeIgnored: params.include_ignored === true,
                  depth: params.depth,
                  pattern: params.pattern,
                  query: params.query,
                },
              ),
            },
          ),
          semanticQueryOptions: ctx.globalStorageUri
            ? {
                retrievalStoreRootForWorkspace: (workspaceRoot: string) =>
                  getCodeRetrievalStoreRoot(
                    ctx.globalStorageUri!.fsPath,
                    workspaceRoot,
                  ),
              }
            : undefined,
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
            {
              advertisedSkillPaths: (ctx.getAdvertisedSkills?.() ?? []).flatMap(
                (skill) => [skill.skillPath, skill.realSkillPath],
              ),
              signal: toolAbortSignal,
              guardian: createGuardianOutsideReadOptions(
                ctx,
                sessionId,
                "search_files",
                {
                  kind: "search",
                  pattern: params.regex,
                  patternKind: params.semantic ? "semantic" : "regex",
                  filePattern: params.file_pattern,
                  caseInsensitive: params.case_insensitive,
                  context: params.context,
                  contextBefore: params.context_before,
                  contextAfter: params.context_after,
                  multiline: params.multiline === true,
                  maxResults: params.max_results,
                  offset: params.offset,
                  outputMode: params.output_mode,
                },
              ),
            },
          ),
          semanticQueryOptions: ctx.globalStorageUri
            ? {
                retrievalStoreRootForWorkspace: (workspaceRoot: string) =>
                  getCodeRetrievalStoreRoot(
                    ctx.globalStorageUri!.fsPath,
                    workspaceRoot,
                  ),
              }
            : undefined,
        },
      );
    case "search_session_history":
      return handleSearchSessionHistory(
        params,
        ctx.getSessionTranscript,
        ctx.getHandoffSourceTranscript,
      );
    case "read_session_excerpt":
      return handleReadSessionExcerpt(
        params,
        ctx.getSessionTranscript,
        ctx.getHandoffSourceTranscript,
      );
    case "diagnose_activity":
      return handleDiagnoseActivity(
        params,
        ctx.sessionActivityDiagnosticsProvider,
      );

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
            createVscodeWriteApprovalPolicyProvider(
              approvalManager,
              ctx.getCommandApprovalMode,
            ),
          ...(ctx.toolUsageTelemetry
            ? {
                onApprovalPrompt: (event: WriteApprovalPromptEvent) =>
                  recordWriteApprovalPrompt("write_file", event, ctx),
              }
            : {}),
          prepareOneShotAuthorization: createGuardianOutsideWritePreparer(
            ctx,
            sessionId,
            "write_file",
            toolAbortSignal,
          ),
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
    case "present_images":
      return handlePresentImages(params, ctx.getSessionImages);
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
            createVscodeWriteApprovalPolicyProvider(
              approvalManager,
              ctx.getCommandApprovalMode,
            ),
          ...(ctx.toolUsageTelemetry
            ? {
                onApprovalPrompt: (event: WriteApprovalPromptEvent) =>
                  recordWriteApprovalPrompt("apply_diff", event, ctx),
              }
            : {}),
          prepareOneShotAuthorization: createGuardianOutsideWritePreparer(
            ctx,
            sessionId,
            "apply_diff",
            toolAbortSignal,
          ),
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
          pathAccessProvider: createVscodePathAccessProvider(
            approvalManager,
            approvalPanel,
            {
              signal: toolAbortSignal,
              guardian: createGuardianOutsideReadOptions(
                ctx,
                sessionId,
                "find_and_replace",
                {
                  kind: "search",
                  pattern: params.find,
                  patternKind: params.regex ? "regex" : "literal",
                  multiline: false,
                  outputMode: "content",
                },
              ),
            },
          ),
          prepareOneShotAuthorization: createGuardianOutsideWritePreparer(
            ctx,
            sessionId,
            "find_and_replace",
            toolAbortSignal,
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
          pathAccessProvider: createVscodePathAccessProvider(
            approvalManager,
            approvalPanel,
            {
              signal: toolAbortSignal,
              guardian: createGuardianOutsideReadOptions(
                ctx,
                sessionId,
                "rename_symbol",
                {
                  kind: "language-intelligence",
                  feature: "references",
                  line: params.line,
                  column: params.column,
                },
              ),
            },
          ),
        },
      );
    case "manage_memory":
      return handleManageMemory(
        params as unknown as ManageMemoryToolInput,
        {
          sessionId,
          projectId: ctx.projectScope?.projectId,
          isBackground: ctx.isBackgroundSession === true,
          observedAt: new Date().toISOString(),
        },
        ctx.memoryToolProvider,
      );
    case "recall_memory":
      return handleRecallMemory(
        params as unknown as RecallMemoryToolInput,
        {
          sessionId,
          projectId: ctx.projectScope?.projectId,
          isBackground: ctx.isBackgroundSession === true,
          observedAt: new Date().toISOString(),
        },
        ctx.memoryToolProvider,
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
          terminalProvider: ctx.terminalProvider,
          getCommandApprovalPolicy: ctx.getCommandApprovalPolicy,
          getCommandApprovalMode: ctx.getCommandApprovalMode,
          commandApprovalReviewer: ctx.commandApprovalReviewer,
          networkApprovalReviewer: ctx.networkApprovalReviewer,
          commandReviewTurnCircuit: ctx.commandReviewTurnCircuit,
          retainedCommandReviewDenials: ctx.retainedCommandReviewDenials,
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
      if (typeof params.terminal_id === "string" && params.terminal_id.trim()) {
        trackerCtx?.setTerminalId(params.terminal_id);
      }
      return handleGetTerminalOutput(params, {
        terminalProvider: ctx.terminalProvider,
        waitForPendingInterjection: ctx.waitForPendingInterjection,
        toolAbortSignal,
      });
    case "close_terminals":
      return handleCloseTerminals(params, {
        terminalProvider: ctx.terminalProvider,
      });

    // --- Editor ---
    case "open_file":
      return handleOpenFile(params, sessionId, {
        workspaceFileProvider: createVscodeWorkspaceFileProvider(),
        pathAccessProvider: createVscodePathAccessProvider(
          approvalManager,
          approvalPanel,
          {
            signal: toolAbortSignal,
            guardian: createGuardianOutsideReadOptions(
              ctx,
              sessionId,
              "open_file",
              {
                kind: "open-file",
                line: params.line,
                column: params.column,
                endLine: params.end_line,
                endColumn: params.end_column,
              },
            ),
          },
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
      const result = await provider.search({
        query: String(params.query),
        path: params.path ? String(params.path) : undefined,
        limit: typeof params.limit === "number" ? params.limit : undefined,
        exclude_globs: Array.isArray(params.exclude_globs)
          ? params.exclude_globs.map(String)
          : undefined,
      });
      return semanticSearchResultToToolResult(result);
    }

    case "find_mcp_tools": {
      const currentLease = ctx.mcpToolDiscoveryProvider
        ? undefined
        : ctx.acquireCurrentMcpHub?.();
      try {
        const currentHub = currentLease?.hub ?? mcpHub;
        const mcpToolDiscoveryProvider =
          ctx.mcpToolDiscoveryProvider ??
          (currentHub
            ? createMcpToolDiscoveryProvider(currentHub, ctx.mcpToolAccess)
            : undefined);
        if (!mcpToolDiscoveryProvider)
          return errorResult("MCP hub not available");
        return mcpDiscoveryResultToToolResult(
          mcpToolDiscoveryProvider.discoverTools({
            query:
              params.query !== undefined ? String(params.query) : undefined,
            server:
              params.server !== undefined ? String(params.server) : undefined,
            includeSchemas:
              params.includeSchemas === true ||
              params.includeSchemas === "true",
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
      } finally {
        currentLease?.release();
      }
    }

    case "call_mcp_tool": {
      const currentLease = ctx.mcpToolInvocationProvider
        ? undefined
        : ctx.acquireCurrentMcpHub?.();
      const currentHub = currentLease?.hub ?? mcpHub;
      const mcpToolInvocationProvider =
        ctx.mcpToolInvocationProvider ??
        (currentHub
          ? createMcpToolInvocationProvider(currentHub, ctx.mcpToolAccess)
          : undefined);
      try {
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
        const invocationContext = {
          ...ctx,
          mcpHub: currentHub,
          mcpToolInvocationProvider,
        };
        if (!ctx.toolCallTracker) {
          return await dispatchToolCall(toolName, toolInput, invocationContext);
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
              ...invocationContext,
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
      } finally {
        currentLease?.release();
      }
    }

    case "list_mcp_resources": {
      const currentLease = ctx.mcpResourcePromptProvider
        ? undefined
        : ctx.acquireCurrentMcpHub?.();
      try {
        const currentHub = currentLease?.hub ?? mcpHub;
        const mcpResourcePromptProvider =
          ctx.mcpResourcePromptProvider ??
          (currentHub
            ? createMcpResourcePromptProvider(currentHub)
            : undefined);
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
      } finally {
        currentLease?.release();
      }
    }

    case "read_mcp_resource": {
      const currentLease = ctx.mcpResourcePromptProvider
        ? undefined
        : ctx.acquireCurrentMcpHub?.();
      try {
        const currentHub = currentLease?.hub ?? mcpHub;
        const mcpResourcePromptProvider =
          ctx.mcpResourcePromptProvider ??
          (currentHub
            ? createMcpResourcePromptProvider(currentHub)
            : undefined);
        if (!mcpResourcePromptProvider)
          return errorResult("MCP hub not available");
        const server = String(params.server ?? "").trim();
        if (!skillAllowlistAllowsMcpServer(skillAllowlist, server)) {
          return errorResult(
            `MCP server is not allowed by the active skill allowed-tools allowlist: ${server}`,
          );
        }
        return await mcpResourcePromptProvider.readResource(
          server,
          String(params.uri ?? ""),
        );
      } finally {
        currentLease?.release();
      }
    }

    case "list_mcp_prompts": {
      const currentLease = ctx.mcpResourcePromptProvider
        ? undefined
        : ctx.acquireCurrentMcpHub?.();
      try {
        const currentHub = currentLease?.hub ?? mcpHub;
        const mcpResourcePromptProvider =
          ctx.mcpResourcePromptProvider ??
          (currentHub
            ? createMcpResourcePromptProvider(currentHub)
            : undefined);
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
      } finally {
        currentLease?.release();
      }
    }

    case "get_mcp_prompt": {
      const currentLease = ctx.mcpResourcePromptProvider
        ? undefined
        : ctx.acquireCurrentMcpHub?.();
      try {
        const currentHub = currentLease?.hub ?? mcpHub;
        const mcpResourcePromptProvider =
          ctx.mcpResourcePromptProvider ??
          (currentHub
            ? createMcpResourcePromptProvider(currentHub)
            : undefined);
        if (!mcpResourcePromptProvider)
          return errorResult("MCP hub not available");
        const server = String(params.server ?? "").trim();
        if (!skillAllowlistAllowsMcpServer(skillAllowlist, server)) {
          return errorResult(
            `MCP server is not allowed by the active skill allowed-tools allowlist: ${server}`,
          );
        }
        const args = params.arguments as Record<string, string> | undefined;
        return await mcpResourcePromptProvider.getPrompt(
          server,
          String(params.name ?? ""),
          args,
        );
      } finally {
        currentLease?.release();
      }
    }

    case "ask_user": {
      const userQuestionProvider =
        ctx.userQuestionProvider ??
        (ctx.onQuestion
          ? createUserQuestionProvider(
              ctx.onQuestion,
              ctx.pendingQuestionRecovery,
              ctx.toolCallId,
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
      const invalidConfirmation = rawQuestions.find((question) => {
        if (!question || typeof question !== "object") return false;
        const q = question as Question;
        return (
          q.type === "confirmation" &&
          q.options !== undefined &&
          !isConfirmationOptions(q.options)
        );
      }) as Question | undefined;
      const questions: Question[] = rawQuestions.flatMap((question) => {
        if (!question || typeof question !== "object") return [];
        const q = question as Question;
        return [
          {
            ...q,
            context:
              typeof q.context === "string" ? q.context.trim() : q.context,
            ...(q.type === "confirmation" && q.options !== undefined
              ? { options: getConfirmationOptions(q.options) }
              : {}),
          },
        ];
      });
      if (invalidConfirmation) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: `Confirmation question "${invalidConfirmation.id}" must have exactly two distinct non-empty options when custom button labels are provided`,
              }),
            },
          ],
        };
      }
      const hasQuestionContext = questions.some((q) => q.context?.trim());
      if (!context && !hasQuestionContext) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error:
                  "ask_user requires visible context in this tool call, either top-level context or questions[].context. Preceding assistant messages are intentionally not used because the question card must remain self-contained.",
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
              ctx.onSpawnBackground!(ctx.sessionId, request, ctx.skillAuthority)
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
      const resolvedImages = resolveBackgroundImages({
        imageIds: params.imageIds,
        useRecentImages: params.useRecentImages,
        getSessionImages: ctx.getSessionImages,
      });
      const images = resolvedImages.map(({ name, mimeType, base64 }) => ({
        name,
        mimeType,
        base64,
      }));
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

        ...(images.length ? { images } : {}),
        reviewScope:
          params.reviewScope && typeof params.reviewScope === "object"
            ? (() => {
                const scope = params.reviewScope as Record<string, unknown>;
                const paths = Array.isArray(scope.paths)
                  ? scope.paths.map(String)
                  : undefined;
                const excludePaths = Array.isArray(scope.excludePaths)
                  ? scope.excludePaths.map(String)
                  : undefined;
                const root =
                  typeof scope.root === "string" && scope.root.trim()
                    ? scope.root
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
                  return {
                    kind: "working_tree" as const,
                    include,
                    paths,
                    excludePaths,
                    root,
                  };
                }
                if (scope.kind === "files") {
                  return {
                    kind: "files" as const,
                    paths: paths ?? [],
                    excludePaths,
                  };
                }
                if (scope.kind === "commit_range") {
                  return {
                    kind: "commit_range" as const,
                    range: String(scope.range ?? ""),
                    paths,
                    excludePaths,
                    root,
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
      // Echo which images were actually attached (id -> name/type) so the
      // coordinator can detect a drifted image_N mapping instead of the
      // reviewer silently receiving the wrong captures.
      const attachedImages = resolvedImages.map(({ id, name, mimeType }) => ({
        id,
        name,
        mimeType,
      }));
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              attachedImages.length > 0
                ? { ...result, attachedImages }
                : result,
            ),
          },
        ],
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

    case "respond_to_background_question": {
      if (!ctx.onRespondToBackgroundQuestion) {
        return errorResult("Background question response is not available");
      }
      const rawAnswers =
        params.answers &&
        typeof params.answers === "object" &&
        !Array.isArray(params.answers)
          ? (params.answers as BackgroundQuestionAnswerRequest["answers"])
          : {};
      const rawNotes =
        params.notes &&
        typeof params.notes === "object" &&
        !Array.isArray(params.notes)
          ? (params.notes as BackgroundQuestionAnswerRequest["notes"])
          : {};
      const result = ctx.onRespondToBackgroundQuestion({
        callerSessionId: ctx.sessionId,
        requestId: String(params.request_id ?? ""),
        answers: rawAnswers,
        notes: rawNotes,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        isError: !result.accepted,
      };
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
      const result = await ctx.onStartFleetWorkflow(
        ctx.sessionId,
        {
          kind,
          task: String(params.task ?? ""),
          message: String(params.message ?? ""),
          goalId: typeof params.goalId === "string" ? params.goalId : undefined,
          candidates,
          budget:
            typeof params.budget === "object" && params.budget !== null
              ? (params.budget as FleetWorkflowRequest["budget"])
              : undefined,
        },
        ctx.skillAuthority,
      );
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
      if (!IS_DEV_BUILD) {
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
      if (!IS_DEV_BUILD) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: "Unknown tool: get_feedback" }),
            },
          ],
        };
      }
      let priorities: Array<"P0" | "P1" | "P2" | "P3"> | undefined;
      if (params.priorities !== undefined) {
        if (
          !Array.isArray(params.priorities) ||
          params.priorities.length === 0 ||
          params.priorities.some(
            (value: unknown) =>
              value !== "P0" &&
              value !== "P1" &&
              value !== "P2" &&
              value !== "P3",
          )
        ) {
          return errorResult(
            "get_feedback priorities must be a non-empty array containing only P0, P1, P2, or P3",
          );
        }
        priorities = params.priorities;
      }
      return handleGetFeedback({
        tool_name:
          params.tool_name !== undefined ? String(params.tool_name) : undefined,
        triaged:
          typeof params.triaged === "boolean" ? params.triaged : undefined,
        priorities,
      });
    }

    case "triage_feedback": {
      if (!IS_DEV_BUILD) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: "Unknown tool: triage_feedback" }),
            },
          ],
        };
      }
      if (typeof params.triaged !== "boolean") {
        return errorResult("triage_feedback requires a boolean triaged value");
      }
      const ids = Array.isArray(params.ids)
        ? params.ids.filter(
            (value: unknown): value is string => typeof value === "string",
          )
        : [];
      const priority =
        params.priority === "P0" ||
        params.priority === "P1" ||
        params.priority === "P2" ||
        params.priority === "P3"
          ? params.priority
          : undefined;
      return handleTriageFeedback({
        ids,
        triaged: params.triaged,
        priority,
      });
    }

    case "delete_feedback": {
      if (!IS_DEV_BUILD) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: "Unknown tool: delete_feedback" }),
            },
          ],
        };
      }
      const ids = Array.isArray(params.ids)
        ? params.ids.filter(
            (value: unknown): value is string => typeof value === "string",
          )
        : undefined;
      const indices = Array.isArray(params.indices)
        ? params.indices.filter(
            (value: unknown): value is number => typeof value === "number",
          )
        : undefined;
      return handleDeleteFeedback({ ids, indices });
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
