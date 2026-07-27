import { createHash, randomUUID } from "crypto";
import * as fs from "fs/promises";
import * as path from "path";
import type { AgentSession } from "./AgentSession.js";
import type {
  AgentEvent,
  AgentMessage,
  PreservedRuntimeContext,
} from "./types.js";
import {
  buildAgentErrorMessage,
  getAgentErrorActions,
  getAgentErrorCode,
  getAgentRetryDecision,
  hasAgentRetryableErrorFlag,
  isAgentAuthError,
  type AgentRetryCategory,
} from "../shared/agentErrors.js";
import type {
  AgentToolRuntime,
  AgentToolExecutionContext,
  ResolvedAgentToolCall,
  SkillAuthoritySnapshot,
} from "../core/tools/types.js";
import { ToolCallBudget } from "../core/tools/toolCallBudget.js";
import { createNativeToolDisclosureSnapshot } from "../core/tools/nativeToolDisclosure.js";
import {
  buildContextLedger,
  DEFAULT_CONTEXT_SAFETY_BUFFER_RATIO,
  getContextLedgerLayer,
  ORDINARY_TURN_RETRIEVED_MEMORY_TOKEN_BUDGET,
  type ContextLedgerSnapshot,
} from "../core/contextLedger.js";
import { BUILT_IN_MODES, buildUnionAgentMode } from "./modes.js";
import { buildToolContextBreakdown } from "./contextBreakdown.js";
import { parseMcpToolName } from "./mcpToolNames.js";
import { partitionMcpToolsForDisclosure } from "./mcpToolDisclosure.js";
import type { CoreResolvedWebAccessPolicy } from "../core/webAccess.js";
import { CORE_NATIVE_WEB_MAX_PAUSE_TURNS } from "../core/nativeWebTools.js";
import type { FinalMessageMarker } from "../shared/finalStatus.js";
import { handleToolError } from "../shared/types.js";
import type {
  McpApprovalPromotionMeta,
  PostCondenseProjection,
  ToolResult,
} from "../shared/types.js";
import {
  TODO_TOOL_NAME,
  todoTool,
  handleTodoWrite,
  completeTodos,
  getLatestTodoState,
  type TodoItem,
  type TodoToolInput,
} from "./todoTool.js";
import {
  summarizeConversation,
  injectSyntheticToolResults,
} from "./condense.js";
import type {
  ModelProvider,
  ContentBlock,
  ToolUseBlock,
  ToolDefinition,
  MessageParam,
  ImageBlock,
  ModelCapabilities,
  ReasoningEffort,
} from "./providers/types.js";
import { toSupportedImageMediaType } from "./providers/types.js";
import {
  toCoreModelDocumentMediaType,
  type CoreModelMessage,
  type CoreModelStopReason,
  type CoreModelToolResultBlock,
} from "../core/modelRuntime.js";
import {
  DEFAULT_PROVIDER_FIRST_EVENT_TIMEOUT_MS,
  DEFAULT_PROVIDER_INACTIVITY_TIMEOUT_MS,
  DEFAULT_PROVIDER_NO_PROGRESS_TIMEOUT_MS,
  ProviderStreamActivityMonitor,
  ProviderStreamTimeoutError,
} from "../core/providerStreamWatchdog.js";
import { sleep } from "../util/sleep.js";
import type {
  SessionTranscriptMessage,
  SessionTranscriptSnapshot,
} from "../core/sessionTranscriptRecall.js";
import { truncateMiddle } from "../util/truncateMiddle.js";
import { estimateTokensFromChars } from "../util/tokenEstimation.js";
import type { AutomaticMemoryContext } from "../core/capabilities/memory.js";
import { getAgentLinkHttpDiagnostics } from "../util/httpDispatcher.js";
import { collectSessionImages } from "./sessionImages.js";
import { resolveProjectAttachments } from "./attachmentResolver.js";
import type { ProviderRegistry } from "./providers/index.js";
import type { ModelRequestPermit } from "../core/modelRequestScheduler.js";
import { AnthropicProvider } from "./providers/anthropic/index.js";
export function buildSessionTranscriptSnapshot(
  messages: readonly AgentMessage[],
): SessionTranscriptSnapshot {
  let latestSummaryIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.isSummary) {
      latestSummaryIndex = index;
      break;
    }
  }

  const projected: SessionTranscriptMessage[] = messages.map(
    (message, sourceIndex) => ({
      sourceIndex,
      role: message.role,
      sourceKind: message.isSummary
        ? "summary"
        : message.isResumeContext
          ? "resume"
          : "source",
      condensed: latestSummaryIndex >= 0 && sourceIndex < latestSummaryIndex,
      content:
        typeof message.content === "string"
          ? message.content
          : structuredClone(message.content),
      runtimeError: message.runtimeError
        ? {
            message: message.runtimeError.message,
            retryable: message.runtimeError.retryable,
            code: message.runtimeError.code,
          }
        : undefined,
    }),
  );
  return { messages: projected };
}

const MAX_REQUEST_RETRIES = 4;
// Provider-side transient failures (5xx/429/529) get a much larger budget:
// they resolve on their own, and exhausting retries fails background tasks
// outright, so waiting out ~60s of provider outage is the cheaper outcome.
const MAX_TRANSIENT_REQUEST_RETRIES = 8;
const MAX_STREAM_RETRIES = 5;
const MAX_RETRY_DELAY_MS = 8_000;
const MAX_TRANSIENT_RETRY_DELAY_MS = 16_000;
const TRANSIENT_RETRY_CATEGORIES: ReadonlySet<AgentRetryCategory> = new Set([
  "rate_limit",
  "overloaded",
  "server",
]);
const MAX_EMPTY_RESPONSE_RETRIES = 2;

const buildErrorMessage = buildAgentErrorMessage;

function calculateProviderRetryDelayMs(
  category: AgentRetryCategory,
  attempt: number,
  retryAfterMs?: number,
): number {
  if (retryAfterMs !== undefined) return Math.ceil(retryAfterMs);
  const transient = TRANSIENT_RETRY_CATEGORIES.has(category);
  const baseMs = transient ? 500 : 200;
  const capMs = transient ? MAX_TRANSIENT_RETRY_DELAY_MS : MAX_RETRY_DELAY_MS;
  const exponential = Math.min(baseMs * 2 ** (attempt - 1), capMs);
  const jitter = 0.9 + Math.random() * 0.2;
  return Math.max(1, Math.floor(exponential * jitter));
}

function extractAgentDisplayArgs(
  toolName: string,
  input: Record<string, unknown>,
): string {
  switch (toolName) {
    case "execute_command":
      return String(input.command ?? "").slice(0, 80);
    case "get_terminal_output":
      return String(input.terminal_id ?? "");
    case "get_background_result":
      return String(input.sessionId ?? "");
    case "close_terminals":
      return Array.isArray(input.names)
        ? (input.names as string[]).join(", ")
        : "all";
    case "read_file":
    case "list_files":
    case "get_diagnostics":
    case "open_file":
    case "write_file":
    case "apply_diff":
      return String(input.path ?? "");
    case "search_files":
      return String(input.regex ?? "").slice(0, 60);
    case "show_notification":
      return String(input.message ?? "").slice(0, 60);
    case "rename_symbol":
      return String(input.new_name ?? "");
    case "find_and_replace":
      return `${String(input.find ?? "").slice(0, 30)} → ${String(input.replace ?? "").slice(0, 30)}`;
    default:
      return "";
  }
}

function buildProviderCacheKey(
  session: AgentSession,
  model = session.model,
): string {
  const projectHash = createHash("sha1")
    .update(session.projectScope.projectId)
    .digest("hex")
    .slice(0, 12);
  return `codex:${projectHash}:${session.id}:${model}`;
}

/** Custom error for auth failures, so the outer catch can mark them specially. */
class AuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthenticationError";
  }
}

const isAuthError = isAgentAuthError;

/**
 * Safety buffer percentage subtracted from the context window when computing
 * the hard-fit budget. This mirrors Roo Code's buffer concept and absorbs
 * mismatch between our local estimate and the provider's real token accounting.
 */
const CONTEXT_WINDOW_SAFETY_BUFFER = DEFAULT_CONTEXT_SAFETY_BUFFER_RATIO;

function normalizeReasoningEffort(
  effort: ReasoningEffort,
  capabilities: ModelCapabilities,
): ReasoningEffort {
  if (!capabilities.supportsThinking) return "none";
  const supported = capabilities.reasoningEfforts;
  if (!supported?.length || supported.includes(effort)) return effort;
  const defaultEffort = capabilities.defaultReasoningEffort ?? "high";
  if (supported.includes(defaultEffort)) return defaultEffort;
  return supported[0] ?? "none";
}

function estimateContentCharsForTokens(value: unknown): number {
  if (typeof value === "string") return value.length;
  if (value === null || value === undefined) return 0;
  if (typeof value !== "object") return String(value).length;

  if (Array.isArray(value)) {
    return value.reduce(
      (n, item) => n + estimateContentCharsForTokens(item),
      0,
    );
  }

  const record = value as Record<string, unknown>;
  if (record.type === "image" || record.type === "document") {
    return 1_024;
  }

  return Object.entries(record).reduce(
    (n, [key, nested]) =>
      n + key.length + estimateContentCharsForTokens(nested),
    0,
  );
}

/** Estimate the character size of a set of tool result contents. */
function estimateToolResultContentChars(
  contents: Array<string | ContentBlock[]>,
): number {
  return contents.reduce(
    (n, content) => n + estimateContentCharsForTokens(content),
    0,
  );
}

export function measureToolResultContentForAttribution(
  content: string | ContentBlock[],
): { retainedContent: string; estimatedTokens: number } {
  return {
    retainedContent:
      typeof content === "string" ? content : JSON.stringify(content),
    estimatedTokens: estimateTokensFromChars(
      estimateToolResultContentChars([content]),
    ),
  };
}

/**
 * Compute the effective output-token reservation for a model.
 *
 * Reserve the actual request budget (clamped to the model cap). This keeps the
 * hard-fit guardrail aligned with what the provider request is expected to
 * enforce server-side.
 */
function getOutputReservation(
  session: AgentSession,
  provider: ModelProvider,
  model = session.model,
): number {
  const caps = provider.getCapabilities(model);
  return Math.min(
    Math.max(session.maxTokens, session.thinkingBudget + 4096),
    caps.maxOutputTokens,
  );
}

function estimateProviderMessageTokens(messages: MessageParam[]): number {
  return estimateTokensFromChars(
    messages.reduce(
      (chars, message) =>
        chars + estimateContentCharsForTokens(message.content),
      0,
    ),
  );
}

function buildProviderMessages(
  effectiveMessages: AgentMessage[],
  modeInsertions: Array<{ beforeIndex: number; blockText: string }>,
  log?: (message: string) => void,
): MessageParam[] {
  const apiMessages: MessageParam[] = effectiveMessages.map(
    (msg, effectiveIdx) => {
      const { role, content, media, providerReplay } = msg;
      if (media) {
        log?.(
          `[media] found attached media at effectiveIdx=${effectiveIdx} role=${role} contentType=${typeof content === "string" ? "string" : Array.isArray(content) ? `array(${content.length})` : "other"} images=${media.images.length} documents=${media.documents.length}`,
        );
      }
      if (media && role === "user") {
        const imageBlocks: ImageBlock[] = media.images
          .map((img) => {
            let mediaType = toSupportedImageMediaType(img.mimeType);
            if (!mediaType && img.name) {
              const ext = img.name.split(".").pop()?.toLowerCase();
              const extMap: Record<string, string> = {
                png: "image/png",
                jpg: "image/jpeg",
                jpeg: "image/jpeg",
                gif: "image/gif",
                webp: "image/webp",
              };
              if (ext && extMap[ext]) {
                mediaType = toSupportedImageMediaType(extMap[ext]);
                log?.(
                  `[media] inferred mimeType="${extMap[ext]}" from filename "${img.name}" (original mimeType="${img.mimeType}")`,
                );
              }
            }
            if (!mediaType) {
              log?.(
                `[media] skipping unsupported image type: "${img.mimeType}" name="${img.name}"`,
              );
              return null;
            }
            return {
              type: "image" as const,
              source: {
                type: "base64" as const,
                media_type: mediaType,
                data: img.base64,
              },
            };
          })
          .filter((block): block is ImageBlock => block !== null);
        const textContent =
          typeof content === "string"
            ? content
            : Array.isArray(content)
              ? content
                  .filter(
                    (block): block is { type: "text"; text: string } =>
                      block.type === "text",
                  )
                  .map((block) => block.text)
                  .join("\n")
              : "";
        const existingBlocks: ContentBlock[] = Array.isArray(content)
          ? (content.filter((block) => block.type !== "text") as ContentBlock[])
          : [];
        const blocks: ContentBlock[] = [
          ...(textContent
            ? [{ type: "text" as const, text: textContent }]
            : []),
          ...imageBlocks,
          ...media.documents.flatMap((doc) => {
            const mediaType = toCoreModelDocumentMediaType(doc.mimeType);
            if (!mediaType) {
              log?.(
                `[media] skipping unsupported document type: "${doc.mimeType}" name="${doc.name}"`,
              );
              return [];
            }
            return [
              {
                type: "document" as const,
                source: {
                  type: "base64" as const,
                  media_type: mediaType,
                  data: doc.base64,
                },
                title: doc.name,
              },
            ];
          }),
          ...existingBlocks,
        ];
        log?.(
          `[media] injected media into user message: blockTypes=[${blocks.map((block) => block.type).join(",")}] imageBlocks=${imageBlocks.length} existingBlocks=${existingBlocks.length}`,
        );
        return { role, content: blocks };
      }
      return {
        role,
        content,
        ...(role === "assistant" && providerReplay ? { providerReplay } : {}),
      };
    },
  );
  for (let i = modeInsertions.length - 1; i >= 0; i--) {
    const insertion = modeInsertions[i]!;
    apiMessages.splice(insertion.beforeIndex, 0, {
      role: "user",
      content: insertion.blockText,
    });
  }
  return apiMessages;
}

function isToolResultCarrier(message: AgentMessage): boolean {
  return (
    message.role === "user" &&
    Array.isArray(message.content) &&
    message.content.some((block) => block.type === "tool_result")
  );
}

function insertAutomaticMemoryContext(
  apiMessages: MessageParam[],
  effectiveMessages: AgentMessage[],
  modeInsertions: Array<{ beforeIndex: number; blockText: string }>,
  automaticMemoryContext: Readonly<AutomaticMemoryContext>,
  logicalTurnUserMessage?: AgentMessage,
): void {
  let sourceIndex = logicalTurnUserMessage
    ? effectiveMessages.indexOf(logicalTurnUserMessage)
    : -1;
  if (sourceIndex < 0) {
    for (let index = effectiveMessages.length - 1; index >= 0; index -= 1) {
      const message = effectiveMessages[index]!;
      if (message.role === "user" && !isToolResultCarrier(message)) {
        sourceIndex = index;
        break;
      }
    }
  }
  if (sourceIndex < 0) sourceIndex = 0;
  const modeInsertionsBeforeAnchor = modeInsertions.filter(
    (insertion) => insertion.beforeIndex <= sourceIndex,
  ).length;
  apiMessages.splice(sourceIndex + modeInsertionsBeforeAnchor, 0, {
    role: "user",
    content: automaticMemoryContext.rendering,
  });
}

function buildRequestContextLedger(
  session: AgentSession,
  capabilities: ModelCapabilities,
  messageTokens: number,
  modeInstructionTokens: number,
  toolTokens: number,
  retrievedMemoryTokens: number,
): Readonly<ContextLedgerSnapshot> {
  return buildContextLedger({
    capabilities,
    outputReservationTokens: Math.min(
      Math.max(session.maxTokens, session.thinkingBudget + 4096),
      capabilities.maxOutputTokens,
    ),
    safetyBufferRatio: CONTEXT_WINDOW_SAFETY_BUFFER,
    layers: [
      {
        layer: "system_prompt",
        requestedTokens: session.contextBreakdown.prompt.estimatedTokens,
      },
      { layer: "workspace_instructions", requestedTokens: 0 },
      { layer: "mode_instructions", requestedTokens: modeInstructionTokens },
      { layer: "pinned_memory", requestedTokens: 0 },
      { layer: "tool_definitions", requestedTokens: toolTokens },
      {
        layer: "conversation_history",
        requestedTokens: Math.max(0, messageTokens - modeInstructionTokens),
      },
      { layer: "working_set", requestedTokens: 0 },
      {
        layer: "retrieved_context",
        requestedTokens: retrievedMemoryTokens,
        budgetTokens: ORDINARY_TURN_RETRIEVED_MEMORY_TOKEN_BUDGET,
        required: false,
        allOrNothing: true,
      },
    ],
  });
}

function buildCurrentRequestContextLedger(
  session: AgentSession,
  provider: ModelProvider,
  model: string,
  tools?: ToolDefinition[],
  automaticMemoryContext?: Readonly<AutomaticMemoryContext>,
): {
  ledger: Readonly<ContextLedgerSnapshot>;
  toolBreakdown: ReturnType<typeof buildToolContextBreakdown>;
} {
  const effectiveMessages = session.getMessages();
  const modeInsertions =
    session.buildModeInstructionInsertions?.(effectiveMessages) ?? [];
  const modeInstructionTokens = estimateProviderMessageTokens(
    modeInsertions.map((insertion) => ({
      role: "user",
      content: insertion.blockText,
    })),
  );
  const providerMessageTokens = estimateProviderMessageTokens(
    buildProviderMessages(effectiveMessages, modeInsertions),
  );
  const toolBreakdown = tools
    ? buildToolContextBreakdown(tools)
    : (session.contextBreakdown.tools ?? buildToolContextBreakdown(undefined));
  return {
    ledger: buildRequestContextLedger(
      session,
      provider.getCapabilities(model),
      providerMessageTokens,
      modeInstructionTokens,
      toolBreakdown.estimatedTokens,
      automaticMemoryContext?.estimatedTokens ?? 0,
    ),
    toolBreakdown,
  };
}

function buildPostCondenseProjection(
  session: AgentSession,
  provider: ModelProvider,
  model: string,
  tools?: ToolDefinition[],
  automaticMemoryContext?: Readonly<AutomaticMemoryContext>,
): PostCondenseProjection {
  const { ledger, toolBreakdown } = buildCurrentRequestContextLedger(
    session,
    provider,
    model,
    tools,
    automaticMemoryContext,
  );
  const allocated = (layer: Parameters<typeof getContextLedgerLayer>[1]) =>
    getContextLedgerLayer(ledger, layer)?.allocatedTokens ?? 0;

  return {
    estimatedInputTokens: ledger.allocatedInputTokens,
    promptTokens: allocated("system_prompt"),
    historyTokens: allocated("conversation_history"),
    modeInstructionTokens: allocated("mode_instructions"),
    toolTokens: allocated("tool_definitions"),
    nativeToolTokens: toolBreakdown.native.estimatedTokens,
    mcpToolTokens: toolBreakdown.mcp.estimatedTokens,
    pinnedMemoryTokens: allocated("pinned_memory"),
    retrievedMemoryTokens: allocated("retrieved_context"),
    outputReservationTokens: ledger.outputReservationTokens,
    safetyBufferTokens: ledger.safetyBufferTokens,
    contextLedger: ledger,
  };
}

function hasVisibleOrActionableOutput(blocks: ContentBlock[]): boolean {
  return blocks.some((block) => {
    if (block.type === "text") return block.text.trim().length > 0;
    if (block.type === "thinking") return block.thinking.trim().length > 0;
    if (block.type === "tool_use") return true;
    return true;
  });
}

function getCondenseBudgetSnapshot(
  session: AgentSession,
  provider: ModelProvider,
  model = session.model,
  projectedLedger?: Readonly<ContextLedgerSnapshot>,
): {
  usedTokens: number;
  contextWindow: number;
  maxInputTokens: number;
  outputReservation: number;
  safetyBufferTokens: number;
  softThresholdBudget: number;
  hardBudget: number;
  effectiveThreshold: number;
  triggerReason: "soft_threshold" | "hard_budget" | null;
} {
  const caps = provider.getCapabilities(model);
  const outputReservation = getOutputReservation(session, provider, model);
  const derivedInputLimit = Math.max(
    0,
    caps.contextWindow - caps.maxOutputTokens,
  );
  const maxInputTokens = caps.maxInputTokens ?? derivedInputLimit;
  const safetyBufferTokens = Math.floor(
    maxInputTokens * CONTEXT_WINDOW_SAFETY_BUFFER,
  );
  // Providers reject oversized prompts based on request input, not previous output.
  // For fixed-envelope models, usable input is contextWindow - maxOutputTokens.
  const usedTokens = Math.max(
    session.estimatedInputUsed,
    projectedLedger?.allocatedInputTokens ?? 0,
  );
  const cacheHitRatio =
    session.lastInputTokens > 0
      ? session.lastCacheReadTokens / session.lastInputTokens
      : 0;
  const effectiveThreshold = Math.min(
    session.autoCondenseThreshold + cacheHitRatio * 0.1,
    0.95,
  );
  const softThresholdBudget = Math.floor(maxInputTokens * effectiveThreshold);
  const hardBudget = Math.max(0, maxInputTokens - safetyBufferTokens);
  const triggerReason =
    usedTokens >= hardBudget
      ? "hard_budget"
      : usedTokens >= softThresholdBudget
        ? "soft_threshold"
        : null;

  return {
    usedTokens,
    contextWindow: caps.contextWindow,
    maxInputTokens,
    outputReservation,
    safetyBufferTokens,
    softThresholdBudget,
    hardBudget,
    effectiveThreshold,
    triggerReason,
  };
}

function isOverCondenseThresholdInternal(
  session: AgentSession,
  provider: ModelProvider,
  model = session.model,
  projectedLedger?: Readonly<ContextLedgerSnapshot>,
): boolean {
  if (!session.autoCondense || session.lastInputTokens === 0) return false;
  return (
    getCondenseBudgetSnapshot(session, provider, model, projectedLedger)
      .triggerReason !== null
  );
}

function hasUnansweredUserTurn(session: AgentSession): boolean {
  const msgs = session.getAllMessages();
  const last = msgs[msgs.length - 1];
  const hasAnyAssistant = msgs.some((m) => m.role === "assistant");
  return (
    hasAnyAssistant &&
    !!last &&
    last.role === "user" &&
    typeof last.content === "string" &&
    !last.isSummary
  );
}

/** Internal result from a single tool call execution. */
interface ResolvedToolUseBlock extends ToolUseBlock {
  providerName: string;
  providerInput: Record<string, unknown>;
}

interface ToolCallResult {
  tool_use_id: string;
  toolName: string;
  result: ToolResult;
  historyContent?: CoreModelToolResultBlock["content"];
  durationMs: number;
  mcpApprovalPromotion?: McpApprovalPromotionMeta;
  composeTrace?: import("../shared/composeTypes.js").ComposeTrace;
}

function parseToolResultPayload(
  result: ToolResult,
): Record<string, unknown> | null {
  const text = result.content.find(
    (c): c is { type: "text"; text: string } => c.type === "text",
  )?.text;
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function getSuccessfulModeSwitch(
  result: ToolCallResult,
): { mode?: string } | null {
  if (result.toolName === "switch_mode") {
    const payload = parseToolResultPayload(result.result);
    if (!payload || payload.ok !== true) return null;
    return {
      mode: typeof payload.mode === "string" ? payload.mode : undefined,
    };
  }
  // ask_user can also perform a silent mode switch when the user picks an
  // answer mapped to a mode (per-question `modeSwitch` map). Treat that the
  // same as a successful switch_mode so the turn ends at the same boundary.
  if (result.toolName === "ask_user") {
    const payload = parseToolResultPayload(result.result);
    if (!payload) return null;
    const mode = payload.modeSwitched;
    if (typeof mode !== "string" || mode === "") return null;
    return { mode };
  }
  return null;
}

function buildModeSwitchSkippedResult(
  call: ToolUseBlock,
  switchedMode?: string,
): ToolCallResult {
  const payload: Record<string, unknown> = {
    status: "skipped",
    skipped_by: "mode_switch",
    reason:
      "Skipped because mode switched during this tool batch. Continue in the resumed turn.",
  };
  if (switchedMode) {
    payload.mode = switchedMode;
  }
  return {
    tool_use_id: call.id,
    toolName: call.name,
    result: {
      content: [{ type: "text", text: JSON.stringify(payload) }],
    },
    durationMs: 0,
  };
}

function buildFinalStatusSkippedResult(call: ToolUseBlock): ToolCallResult {
  return {
    tool_use_id: call.id,
    toolName: call.name,
    result: {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "skipped",
            skipped_by: "set_task_status",
            reason: "Skipped because final task status was set for this turn.",
          }),
        },
      ],
    },
    durationMs: 0,
  };
}

// Per-tool character limits for tool results kept in conversation history.
// Tools that self-paginate (read_file) get more headroom; repetitive/noisy
// tools get tighter caps. At ~4 chars/token:
const TOOL_RESULT_CHAR_LIMITS: Record<string, number> = {
  read_file: 80_000, // ~20k tokens — self-paginating; every line is high-value
  execute_command: 40_000, // ~10k tokens — VS Code terminal already caps at 200 lines
  search_files: 20_000, // ~5k tokens — results can be repetitive; agent can refine
  codebase_search: 20_000,
  list_files: 12_000, // ~3k tokens — just file paths
};
const DEFAULT_TOOL_RESULT_CHARS = 32_000; // ~8k tokens
const TOOL_RESULT_RETENTION_MIN_CHARS = 8_000; // ~2k tokens

// Truncated and retained tool results are saved here so the agent can read_file
// the full output when needed. Allowlisted in handleReadFile to bypass the
// approval gate.
const AGENTLINK_TMP_DIR = "/tmp/agentlink-results";
const RETAINED_TOOL_RESULT_DIR = path.join(AGENTLINK_TMP_DIR, "retained");

interface RetainedToolResultArtifact {
  hash: string;
  path: string;
  originalToolCallId: string;
  originalToolName: string;
  chars: number;
}

type ToolResultRetentionIndex = Map<
  string,
  Promise<RetainedToolResultArtifact | null>
>;

/**
 * Head+tail truncation with line-boundary snapping. Keeps the first and last
 * portions so both the start and end of output are visible (critical for
 * terminal output where errors appear at the end). Reports omitted tokens so
 * the agent can gauge how much was dropped. Saves full content to a tmp file
 * if toolUseId is provided so the agent can read_file the complete result.
 */
export function truncateToolText(
  text: string,
  maxChars: number,
  toolUseId?: string,
): string {
  if (text.length <= maxChars) return text;

  let omissionSuffix: string | undefined;
  if (toolUseId) {
    const tmpPath = path.join(AGENTLINK_TMP_DIR, `${toolUseId}.txt`);
    // Fire-and-forget — save full content without blocking the response
    fs.mkdir(AGENTLINK_TMP_DIR, { recursive: true })
      .then(() => fs.writeFile(tmpPath, text, "utf-8"))
      .catch(() => {});
    omissionSuffix = `\nFull output saved to: ${tmpPath} — use read_file to access the complete result.`;
  }

  return truncateMiddle(text, maxChars, {
    lineBoundarySnapRatio: 0.15,
    omissionSuffix,
  });
}

function getRetainableToolResultText(result: ToolResult): string | null {
  if (
    result.content.some(
      (content) => content.type === "image" || content.type === "document",
    )
  ) {
    return null;
  }
  const text = result.content
    .filter((content) => content.type === "text")
    .map((content) => content.text)
    .join("\n");
  return text.length >= TOOL_RESULT_RETENTION_MIN_CHARS ? text : null;
}

function buildRetainedToolResultReference(
  artifact: RetainedToolResultArtifact,
): string {
  return [
    `[Unchanged large tool result; exact content retained from ${artifact.originalToolName} call ${artifact.originalToolCallId}.]`,
    `SHA-256: ${artifact.hash}`,
    `Original size: ${artifact.chars} characters`,
    `Full output: ${artifact.path} — use read_file to access the exact result.`,
  ].join("\n");
}

async function retainToolResultHistoryContent(
  result: ToolResult,
  canonicalContent: CoreModelToolResultBlock["content"],
  toolCallId: string,
  toolName: string,
  runArtifactId: string,
  index: ToolResultRetentionIndex,
): Promise<CoreModelToolResultBlock["content"]> {
  if (typeof canonicalContent !== "string") return canonicalContent;
  const exactText = getRetainableToolResultText(result);
  if (exactText === null) return canonicalContent;

  const hash = createHash("sha256").update(exactText).digest("hex");
  const existing = index.get(hash);
  if (existing) {
    const artifact = await existing;
    return artifact
      ? buildRetainedToolResultReference(artifact)
      : canonicalContent;
  }

  const artifactPath = path.join(
    RETAINED_TOOL_RESULT_DIR,
    runArtifactId,
    `${hash}.txt`,
  );
  const write = (async (): Promise<RetainedToolResultArtifact | null> => {
    try {
      await fs.mkdir(path.dirname(artifactPath), { recursive: true });
      await fs.writeFile(artifactPath, exactText, {
        encoding: "utf-8",
        mode: 0o600,
      });
      return {
        hash,
        path: artifactPath,
        originalToolCallId: toolCallId,
        originalToolName: toolName,
        chars: exactText.length,
      };
    } catch {
      return null;
    }
  })();
  index.set(hash, write);
  const artifact = await write;
  if (!artifact && index.get(hash) === write) index.delete(hash);
  return canonicalContent;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(
    ([a], [b]) => a.localeCompare(b),
  );
  return `{${entries.map(([key, val]) => `${JSON.stringify(key)}:${stableStringify(val)}`).join(",")}}`;
}

function intersectToolAllowlist(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): readonly string[] | undefined {
  if (!left) return right ? [...new Set(right)].sort() : undefined;
  if (!right) return [...new Set(left)].sort();
  const rightSet = new Set(right);
  return [...new Set(left)].filter((tool) => rightSet.has(tool)).sort();
}

function buildSkillAuthoritySnapshot(
  inherited: Readonly<SkillAuthoritySnapshot> | undefined,
  activeState: ReturnType<AgentSession["getActiveSkillState"]>,
  activeAllowedTools: readonly string[] | undefined,
): Readonly<SkillAuthoritySnapshot> | undefined {
  if (!inherited && !activeState && !activeAllowedTools) return undefined;
  const sources = [
    ...(inherited?.sources ?? []),
    ...(activeState
      ? [
          {
            catalogRevision: activeState.catalogRevision,
            activations: activeState.activations.map((activation) => ({
              ...activation,
            })),
            policyRevision: activeState.policy.revision,
          },
        ]
      : []),
  ];
  // Inherited allowlists may come from persisted fleet metadata, but they are
  // authority only as a narrowing ceiling: intersection can never grant a tool
  // that the active skill, mode, or permission profile would otherwise deny.
  const allowedTools = intersectToolAllowlist(
    inherited?.allowedTools,
    activeAllowedTools,
  );
  return Object.freeze({
    schemaVersion: 1 as const,
    sources: Object.freeze(
      sources.map((source) =>
        Object.freeze({
          ...source,
          activations: Object.freeze(
            source.activations.map((activation) =>
              Object.freeze({ ...activation }),
            ),
          ),
        }),
      ),
    ),
    ...(allowedTools ? { allowedTools: Object.freeze([...allowedTools]) } : {}),
  });
}

function buildToolFingerprint(tools: ToolDefinition[] | undefined): string {
  if (!tools) return "none";
  if (tools.length === 0) return "empty";
  return tools
    .map(
      (tool, index) =>
        `${index}:${tool.name}:${tool.description ?? ""}:${stableStringify(tool.input_schema)}`,
    )
    .join("|");
}

/** Convert our ToolResult content to provider-agnostic tool_result content. */
export function toolResultToContent(
  result: ToolResult,
  toolUseId: string | undefined,
  toolName: string,
): string | ContentBlock[] {
  const maxChars =
    TOOL_RESULT_CHAR_LIMITS[toolName] ?? DEFAULT_TOOL_RESULT_CHARS;
  const hasMedia = result.content.some(
    (content) => content.type === "image" || content.type === "document",
  );
  if (!hasMedia) {
    // Simple case: all text — join into a single string, then cap size.
    const joined = result.content
      .filter((c) => c.type === "text")
      .map((c) => (c as { type: "text"; text: string }).text)
      .join("\n");
    return truncateToolText(joined, maxChars, toolUseId);
  }
  // Mixed content: pass blocks so media is preserved; cap text blocks.
  return result.content
    .map((content): ContentBlock | null => {
      if (content.type === "text") {
        return {
          type: "text" as const,
          text: truncateToolText(content.text, maxChars, toolUseId),
        };
      }
      if (content.type === "document") {
        const mediaType = toCoreModelDocumentMediaType(content.mimeType);
        if (!mediaType) {
          return {
            type: "text" as const,
            text: `[Document with unsupported format: ${content.mimeType}]`,
          };
        }
        return {
          type: "document" as const,
          title: content.name,
          source: {
            type: "base64" as const,
            media_type: mediaType,
            data: content.data,
          },
        };
      }
      const mediaType = toSupportedImageMediaType(content.mimeType);
      if (!mediaType) {
        return {
          type: "text" as const,
          text: `[Image with unsupported format: ${content.mimeType}]`,
        };
      }
      return {
        type: "image" as const,
        source: {
          type: "base64" as const,
          media_type: mediaType,
          data: content.data,
        },
      };
    })
    .filter((b): b is ContentBlock => b !== null);
}

export class AgentEngine {
  private registry: ProviderRegistry;
  private log?: (msg: string) => void;
  private toolRuntime: AgentToolRuntime | null = null;

  constructor(registry: ProviderRegistry, log?: (msg: string) => void) {
    this.registry = registry;
    this.log = log;
  }

  setToolRuntime(runtime: AgentToolRuntime | null): void {
    this.toolRuntime = runtime;
  }

  async *run(
    session: AgentSession,
    opts?: {
      isBackground?: boolean;
      toolProfile?: string;
      maxApiTurns?: number;
      maxToolCalls?: number;
      /** Immutable low-authority memory evidence prepared once for this logical invocation. */
      automaticMemoryContext?: Readonly<AutomaticMemoryContext>;
      /** Immutable web backend/tool selection prepared at the logical turn boundary. */
      webAccessPolicy?: Readonly<CoreResolvedWebAccessPolicy>;
      /** MCP disclosure prepared from the same immutable tool-catalog snapshot. */
      mcpToolDisclosure?: Readonly<
        ReturnType<typeof partitionMcpToolsForDisclosure>
      >;
      /** Exact cloned MCP catalog used to build the prepared disclosure/policy. */
      mcpToolDefinitions?: readonly ToolDefinition[];
      /** Immutable skill authority inherited from the spawning request. */
      inheritedSkillAuthority?: Readonly<SkillAuthoritySnapshot>;
      /**
       * Persists a provider-complete assistant tool turn before dispatch starts.
       * The turn remains outside canonical live history until every tool result
       * is available, but can be recovered if the host reloads mid-dispatch.
       */
      onPendingToolTurn?: (
        assistantMessage: AgentMessage,
      ) => void | Promise<void>;
      /**
       * Signals that an assistant message and any paired tool-result carrier
       * are now present in canonical session history.
       */
      onAssistantTurnCommitted?: () => void;
      /** Reports transient foreground provider admission without persisting it as run recovery state. */
      onProviderAdmissionPhase?: (
        phase: "queued_for_provider" | "running",
      ) => void;
      /**
       * Reconciles trusted provider/profile/prompt state after a transport-owned
       * model fallback and before this run can issue another provider request.
       */
      onModelFallback?: (fallback: {
        requestedModel: string;
        effectiveModel: string;
      }) => void | Promise<void>;
      /** Time to first raw transport activity (normally response headers). */
      providerFirstEventTimeoutMs?: number;
      /** Maximum silence between raw response body chunks/provider events. */
      providerInactivityTimeoutMs?: number;
      /**
       * Maximum time between parsed provider stream events, regardless of raw
       * transport activity. Bounds "warm but dead" streams that keepalives
       * would otherwise keep alive forever.
       */
      providerNoProgressTimeoutMs?: number;
    },
  ): AsyncGenerator<AgentEvent> {
    const ac = session.createAbortController();
    // Capture signal locally — a subsequent run() call on the same session would
    // replace session._abortSignal via createAbortController(), causing session.isAborted
    // to return false in this (still-running) loop and allowing spurious API calls.
    const { signal } = ac;

    // Model selection updates are adopted between provider requests. An in-flight
    // stream completes under the provider/model pair that started it.
    await session.waitForModelSelectionUpdate();
    let activeModel = session.model;
    let provider = this.registry.resolveProvider(activeModel);
    let modelSelectionRevision = session.modelSelectionRevision;
    const logicalTurnUserMessage = [...session.getMessages()]
      .reverse()
      .find(
        (message) => message.role === "user" && !isToolResultCarrier(message),
      );

    // Cache assembled tool list across turns — rebuild only when the tool set changes.
    let cachedTools: ToolDefinition[] | undefined;
    let cachedToolContextBreakdown: ReturnType<
      typeof buildToolContextBreakdown
    > = buildToolContextBreakdown(undefined);
    let cachedToolFingerprint = "";

    const maxApiTurns = opts?.maxApiTurns ?? 0; // 0 = unlimited
    const maxToolCalls = opts?.maxToolCalls ?? 0; // 0 = unlimited
    const toolCallBudget = new ToolCallBudget(maxToolCalls);
    let apiTurnCount = 0;
    let providerPauseTurnCount = 0;
    let wrapUpAttempts = 0; // Track wrap-up injections to prevent infinite loops
    const MAX_WRAP_UP_ATTEMPTS = 2;
    let pendingFinalMarker: FinalMessageMarker | null = null;
    let pendingCompletedTodoUpdate: TodoItem[] | null = null;
    let currentTodos: TodoItem[] = getLatestTodoState(session.getAllMessages());
    const retainedToolResults: ToolResultRetentionIndex = new Map();
    const retainedToolResultRunId = randomUUID();

    try {
      let requestRetryCount = 0;
      let streamRetryCount = 0;
      let visibleTextFromRetriedStream = "";
      let emptyResponseRetryCount = 0;
      let pendingEmptyResponseNudge = false;
      let emptyResponseCondenseAttempted = false;
      let contextTooLongCondenseAttempted = false;
      let thinkingSignatureRetryAttempted = false;
      let toolPairingRepairAttempts = 0;
      const MAX_TOOL_PAIRING_REPAIR_ATTEMPTS = 2;
      let credentialRefreshCount = 0;
      // Sticky for the whole user turn: once we fall back from remote response
      // state to full local replay, keep reporting that on the eventual
      // successful api_request for this turn.
      let previousResponseIdFallback = false;
      let lastLoggedEffortDowngrade = "";
      const MAX_CREDENTIAL_REFRESHES = 3;
      const logTiming = (label: string, startedAt: number, details = "") => {
        this.log?.(
          `[perf] ${label} ${Date.now() - startedAt}ms${details ? ` ${details}` : ""}`,
        );
      };
      while (true) {
        if (signal.aborted) break;

        await session.waitForModelSelectionUpdate();
        if (signal.aborted) break;
        if (session.modelSelectionRevision !== modelSelectionRevision) {
          activeModel = session.model;
          provider = this.registry.resolveProvider(activeModel);
          modelSelectionRevision = session.modelSelectionRevision;
          requestRetryCount = 0;
          streamRetryCount = 0;
          visibleTextFromRetriedStream = "";
          credentialRefreshCount = 0;
          thinkingSignatureRetryAttempted = false;
          session.resetProviderResponseState();
          this.log?.(
            `[model] adopted live selection ${provider.id}/${activeModel} at provider request boundary`,
          );
        }

        const requestModelSelectionRevision = modelSelectionRevision;
        const requestSystemPrompt = session.systemPrompt;
        const toolSetupStartedAt = Date.now();
        // Include tools when dispatch context is available, filtered by mode.
        // Compute this before any condense path so both automatic and retry-triggered
        // condenses see the same preserved runtime context that future requests will use.
        const connectedMcpToolDefs = opts?.mcpToolDefinitions
          ? [...opts.mcpToolDefinitions]
          : (this.toolRuntime?.getConnectedMcpToolDefs?.() ?? []);
        if (opts?.mcpToolDisclosure) {
          session.mcpToolDisclosure = {
            inlineTools: [...opts.mcpToolDisclosure.inlineTools],
            deferredTools: [...opts.mcpToolDisclosure.deferredTools],
            catalog: [...opts.mcpToolDisclosure.catalog],
          };
        } else if (this.toolRuntime && connectedMcpToolDefs.length > 0) {
          const serverNames = new Set(
            connectedMcpToolDefs
              .map((tool) => parseMcpToolName(tool.name)?.serverName)
              .filter((name): name is string => name !== undefined),
          );
          session.mcpToolDisclosure = partitionMcpToolsForDisclosure(
            connectedMcpToolDefs,
            {
              serverConfigs: [...serverNames].map((serverName) => ({
                serverName,
                mode: this.toolRuntime?.getMcpToolDisclosureMode?.(serverName),
              })),
            },
          );
        } else {
          session.mcpToolDisclosure = undefined;
        }
        const providerMcpToolDefs =
          session.mcpToolDisclosure?.inlineTools ?? connectedMcpToolDefs;
        const backgroundExpectedResult = opts?.isBackground
          ? session.fleetMetadata?.delegation?.expectedResult
          : undefined;
        const narrowedExpectedResult:
          | "text"
          | "review_findings"
          | "patch"
          | "verification"
          | undefined =
          backgroundExpectedResult === "text" ||
          backgroundExpectedResult === "review_findings" ||
          backgroundExpectedResult === "patch" ||
          backgroundExpectedResult === "verification"
            ? backgroundExpectedResult
            : undefined;
        const activeSkillAllowedTools = session.getActiveSkillAllowedTools();
        const requestSkillAuthority = buildSkillAuthoritySnapshot(
          opts?.inheritedSkillAuthority,
          session.getActiveSkillState(),
          activeSkillAllowedTools,
        );
        const requestSkillAllowedTools = requestSkillAuthority?.allowedTools;
        const listToolsRequestBase = {
          mcpToolDefs: providerMcpToolDefs,
          nativeWebToolKinds: opts?.webAccessPolicy?.enabledKinds,
          isBackground: opts?.isBackground,
          toolProfile: opts?.toolProfile,
          skillAllowedTools: requestSkillAllowedTools,
          allMcpToolDefsForSkillAllowlist: connectedMcpToolDefs,
          backgroundExpectedResult: narrowedExpectedResult,
        };
        // Sessions with a cache-stable system prompt also advertise a
        // mode-independent tool union, so switching modes never invalidates
        // the prompt-cache prefix. The current mode's real allowance is
        // enforced at dispatch via modeAllowedToolNames.
        const useUnionToolAdvertisement =
          session.modeInstructionPlacement === "conversation" &&
          !opts?.isBackground &&
          !opts?.toolProfile;
        const advertisedMode = useUnionToolAdvertisement
          ? buildUnionAgentMode([...BUILT_IN_MODES, session.agentMode])
          : session.agentMode;
        const advertisedTools = this.toolRuntime
          ? [
              ...this.toolRuntime.listTools({
                ...listToolsRequestBase,
                mode: advertisedMode,
              }),
              todoTool,
            ]
          : undefined;
        const currentModeTools = this.toolRuntime
          ? useUnionToolAdvertisement
            ? [
                ...this.toolRuntime.listTools({
                  ...listToolsRequestBase,
                  mode: session.agentMode,
                }),
                todoTool,
              ]
            : advertisedTools
          : undefined;
        const advertisedDisclosure = advertisedTools
          ? createNativeToolDisclosureSnapshot(advertisedTools)
          : undefined;
        const nativeToolDisclosure = currentModeTools
          ? createNativeToolDisclosureSnapshot(currentModeTools)
          : undefined;
        const inlineToolNames = advertisedDisclosure
          ? new Set(advertisedDisclosure.inlineTools.map((tool) => tool.name))
          : undefined;
        const rawTools =
          advertisedTools && inlineToolNames
            ? advertisedTools.filter((tool) => inlineToolNames.has(tool.name))
            : undefined;
        const modeAllowedToolNames =
          useUnionToolAdvertisement && currentModeTools
            ? new Set(currentModeTools.map((tool) => tool.name))
            : undefined;
        const preservedContext = {
          toolNames: rawTools?.map((t) => t.name) ?? [],
          mcpServerNames: [
            ...new Set(
              connectedMcpToolDefs
                .map((t) => parseMcpToolName(t.name)?.serverName ?? "")
                .filter((name) => name.length > 0),
            ),
          ],
          activeSkills: [...session.loadedSkills],
          todos: currentTodos,
        };
        logTiming(
          "tool setup",
          toolSetupStartedAt,
          `tools=${rawTools?.length ?? 0} deferred=${nativeToolDisclosure?.deferredTools.length ?? 0} mcp=${connectedMcpToolDefs.length}`,
        );

        // --- Auto-condense check ---
        // Run before each API call (except the very first) to keep context in bounds.
        const resolveQueuedAttachments = async (
          text: string,
          attachments?: string[],
        ) => {
          if (!attachments?.length) {
            return { text, images: [], documents: [] };
          }
          const attachmentStartedAt = Date.now();
          const resolved = await resolveProjectAttachments(
            text,
            attachments,
            session.requireProjectRoot(),
          );
          logTiming(
            "queued attachments",
            attachmentStartedAt,
            `count=${attachments.length}`,
          );
          return resolved;
        };

        const projectedRequestLedger = buildCurrentRequestContextLedger(
          session,
          provider,
          activeModel,
          rawTools,
          opts?.automaticMemoryContext,
        ).ledger;
        if (
          isOverCondenseThresholdInternal(
            session,
            provider,
            activeModel,
            projectedRequestLedger,
          ) &&
          !hasUnansweredUserTurn(session)
        ) {
          const condensed = yield* this.condenseSession(
            session,
            true,
            provider,
            preservedContext,
            activeModel,
            {
              isBackground: opts?.isBackground,
              signal,
              onProviderAdmissionPhase: opts?.onProviderAdmissionPhase,
              tools: rawTools,
              automaticMemoryContext: opts?.automaticMemoryContext,
            },
          );
          if (condensed) retainedToolResults.clear();
          if (signal.aborted) break;
          // Drain every pending interjection FIFO so multiple queued messages
          // all land at this break, each as its own user message.
          for (
            let interjection = session.consumePendingInterjection();
            interjection !== null;
            interjection = session.consumePendingInterjection()
          ) {
            const resolvedInterjection = await resolveQueuedAttachments(
              interjection.text,
              interjection.attachments,
            );
            const images = [
              ...(interjection.images ?? []),
              ...resolvedInterjection.images,
            ];
            const documents = [
              ...(interjection.documents ?? []),
              ...resolvedInterjection.documents,
            ];
            session.addUserMessage(resolvedInterjection.text, {
              displayText: interjection.displayText,
              isSlashCommand: interjection.isSlashCommand === true,
              slashCommandLabel: interjection.slashCommandLabel,
              images: images.length > 0 ? images : undefined,
              documents: documents.length > 0 ? documents : undefined,
            });
            yield {
              type: "user_interjection" as const,
              text: interjection.text,
              queueId: interjection.queueId,
              displayText: interjection.displayText,
              isSlashCommand: interjection.isSlashCommand === true,
              slashCommandLabel: interjection.slashCommandLabel,
              images: images.length > 0 ? images : undefined,
              documents: documents.length > 0 ? documents : undefined,
            };
          }
        }

        const requestId = randomUUID();
        const startTime = Date.now();
        let timeToFirstToken = 0;
        let providerQueueWaitMs = 0;

        const capabilities = provider.getCapabilities(activeModel);
        const reasoningEffort = normalizeReasoningEffort(
          session.reasoningEffort,
          capabilities,
        );
        if (reasoningEffort !== session.reasoningEffort) {
          const downgradeKey = `${activeModel}:${session.reasoningEffort}->${reasoningEffort}`;
          if (downgradeKey !== lastLoggedEffortDowngrade) {
            lastLoggedEffortDowngrade = downgradeKey;
            this.log?.(
              `[agent] reasoning effort "${session.reasoningEffort}" is not supported by ${activeModel}; sending "${reasoningEffort}" instead`,
            );
          }
        }
        const useThinking = reasoningEffort !== "none";

        // When budget-based thinking is enabled, max_tokens must exceed budget_tokens.
        // Effort-based providers still benefit from a larger output reservation.
        const maxTokens = useThinking
          ? Math.max(session.maxTokens, session.thinkingBudget + 4096)
          : session.maxTokens;

        // Rebuild cache_control and tool context measurements only when the
        // effective ordered tool definitions change.
        const fingerprint = buildToolFingerprint(rawTools);
        if (fingerprint !== cachedToolFingerprint) {
          cachedTools = rawTools?.map((t, i) =>
            i === rawTools.length - 1
              ? { ...t, cache_control: { type: "ephemeral" as const } }
              : t,
          );
          cachedToolContextBreakdown = buildToolContextBreakdown(rawTools);
          cachedToolFingerprint = fingerprint;
        }
        const tools = rawTools ? cachedTools : undefined;
        const contextBreakdown = {
          ...session.contextBreakdown,
          tools: cachedToolContextBreakdown,
        };
        session.contextBreakdown = contextBreakdown;

        let contentBlocks: ContentBlock[] = [];
        let inputTokens = 0;
        let outputTokens = 0;
        let cacheReadTokens = 0;
        let cacheCreationTokens = 0;
        let usageEstimated: boolean | undefined;
        let providerResponseId: string | undefined;
        let assistantMessage: CoreModelMessage | undefined;
        let contextLedger: Readonly<ContextLedgerSnapshot> | undefined;
        let retrievedMemoryTokens = 0;
        let modelStopReason: CoreModelStopReason | undefined;
        let firstTokenReceived = false;
        let usedPreviousResponseId = false;
        let promptCacheKey: string | undefined;
        let promptCacheRetention: "in_memory" | "24h" | undefined;
        let storeResponseState = false;
        let transportMonitor: ProviderStreamActivityMonitor | undefined;
        const pendingRequestAttributionEvents: Array<
          Extract<AgentEvent, { type: "request_context_attribution" }>
        > = [];
        // Tool stream events are provisional until the provider completes the
        // response. Publishing them immediately leaves a permanently-running
        // tool card when the stream disconnects partway through its JSON, and
        // makes background accounting charge a tool that was never dispatched.
        const pendingToolInputDeltas = new Map<string, string[]>();
        const retryTextPrefix = visibleTextFromRetriedStream;
        let retryTextOffset = 0;
        let retryTextDiverged = false;
        let requestPermit: ModelRequestPermit | undefined;

        try {
          // Build a copy of messages for the API call, injecting any attached
          // media (pasted images/PDFs) as content blocks alongside the text.
          // Media lives on the message itself (msg.media) and is re-sent on
          // every request — the API is stateless, so omitting it would make
          // the model lose access to images after the first response. History
          // transforms preserve the field via object spread, and condensed
          // messages drop out of effective history along with their media.
          const messageAssemblyStartedAt = Date.now();
          const getMessagesStartedAt = Date.now();
          const effectiveMessages = session.getMessages();
          logTiming(
            "getMessages",
            getMessagesStartedAt,
            `messages=${effectiveMessages.length}`,
          );

          const modeInsertions =
            session.buildModeInstructionInsertions?.(effectiveMessages) ?? [];
          const apiMessages = buildProviderMessages(
            effectiveMessages,
            modeInsertions,
            this.log,
          );

          // Empty-response recovery input is request-local. It must reach the
          // provider without becoming a persisted/user-visible chat message.
          if (pendingEmptyResponseNudge) {
            apiMessages.push({
              role: "user",
              content:
                "Your previous response was empty. Continue from where you left off and provide the full response.",
            });
          }

          const modeInstructionTokens = estimateProviderMessageTokens(
            modeInsertions.map((insertion) => ({
              role: "user",
              content: insertion.blockText,
            })),
          );
          contextLedger = buildRequestContextLedger(
            session,
            capabilities,
            estimateProviderMessageTokens(apiMessages),
            modeInstructionTokens,
            contextBreakdown.tools?.estimatedTokens ?? 0,
            opts?.automaticMemoryContext?.estimatedTokens ?? 0,
          );
          const retrievedMemoryAllocation = getContextLedgerLayer(
            contextLedger,
            "retrieved_context",
          );
          if (
            opts?.automaticMemoryContext?.rendering &&
            retrievedMemoryAllocation?.allocatedTokens ===
              opts.automaticMemoryContext.estimatedTokens
          ) {
            insertAutomaticMemoryContext(
              apiMessages,
              effectiveMessages,
              modeInsertions,
              opts.automaticMemoryContext,
              logicalTurnUserMessage,
            );
            retrievedMemoryTokens = retrievedMemoryAllocation.allocatedTokens;
          }

          // Summary: count image/document blocks across all apiMessages only
          // when logging is enabled; this is otherwise pure hot-path overhead.
          if (this.log) {
            let imgCount = 0;
            let docCount = 0;
            for (const m of apiMessages) {
              if (Array.isArray(m.content)) {
                for (const b of m.content) {
                  if (b.type === "image") imgCount++;
                  if (b.type === "document") docCount++;
                }
              }
            }
            if (imgCount > 0 || docCount > 0) {
              this.log(
                `[media] final apiMessages: ${apiMessages.length} messages, ${imgCount} image(s), ${docCount} document(s)`,
              );
            }
          }

          const isCodex = provider.id === "codex";
          const useStatefulCodex =
            isCodex &&
            session.codexStatefulResponses &&
            session.providerId === "codex";
          const currentState = useStatefulCodex
            ? {
                previousResponseId: session.providerResponseId,
                store: session.codexStoreResponses,
              }
            : undefined;
          const currentCache = isCodex
            ? {
                key: buildProviderCacheKey(session, activeModel),
                retention: "24h" as const,
              }
            : undefined;
          usedPreviousResponseId = Boolean(currentState?.previousResponseId);
          promptCacheKey = currentCache?.key;
          promptCacheRetention = currentCache?.retention;
          storeResponseState = currentState?.store ?? false;
          logTiming(
            "message assembly",
            messageAssemblyStartedAt,
            `apiMessages=${apiMessages.length}`,
          );
          const schedulerQueued = !this.registry.requestScheduler.hasCapacity(
            provider.id,
            opts?.isBackground ? "background" : "interactive",
          );
          const requestPermitPromise = this.registry.requestScheduler.acquire(
            provider.id,
            opts?.isBackground ? "background" : "interactive",
            signal,
          );
          if (!opts?.isBackground) {
            opts?.onProviderAdmissionPhase?.(
              schedulerQueued ? "queued_for_provider" : "running",
            );
          }
          yield {
            type: "api_request_start",
            requestId,
            provider: provider.id,
            model: activeModel,
            startedAt: startTime,
            schedulerQueued,
          };
          requestPermit = await requestPermitPromise;
          providerQueueWaitMs += requestPermit.waitMs;
          if (!opts?.isBackground) {
            opts?.onProviderAdmissionPhase?.("running");
          }
          const requestController = new AbortController();
          const abortRequest = () => requestController.abort();
          signal.addEventListener("abort", abortRequest, { once: true });
          transportMonitor = new ProviderStreamActivityMonitor(
            opts?.providerFirstEventTimeoutMs ??
              DEFAULT_PROVIDER_FIRST_EVENT_TIMEOUT_MS,
            opts?.providerInactivityTimeoutMs ??
              DEFAULT_PROVIDER_INACTIVITY_TIMEOUT_MS,
            opts?.providerNoProgressTimeoutMs ??
              DEFAULT_PROVIDER_NO_PROGRESS_TIMEOUT_MS,
            requestController,
          );
          const estimatedInputTokens = contextLedger.allocatedInputTokens;
          const toolResultContextAttributions =
            session.toolResultContextAttributions.map((item) => ({ ...item }));
          const omittedToolResultContextAttributions =
            session.omittedToolResultContextAttributions;
          const streamGen = provider.stream({
            model: activeModel,
            systemPrompt: requestSystemPrompt,
            messages: apiMessages,
            tools,
            maxTokens,
            thinking: useThinking
              ? { budgetTokens: session.thinkingBudget }
              : undefined,
            reasoningEffort,
            reasoningMode: isCodex && session.codexProMode ? "pro" : "standard",
            cache: currentCache,
            state: currentState,
            signal: requestController.signal,
            onProviderRequestAttempt: ({ model }) => {
              pendingRequestAttributionEvents.push({
                type: "request_context_attribution",
                requestId: randomUUID(),
                requestKind: "agent",
                model,
                estimatedInputTokens,
                toolResultContextAttributions,
                omittedToolResultContextAttributions,
                pinnedMemoryTokens: 0,
                retrievedMemoryTokens,
                contextLedger,
              });
            },
            onTransportActivity: transportMonitor.recordActivity,
          });
          const streamIterator = streamGen[Symbol.asyncIterator]();

          try {
            while (true) {
              const next = await transportMonitor.next(streamIterator);
              while (pendingRequestAttributionEvents.length > 0) {
                yield pendingRequestAttributionEvents.shift()!;
              }
              if (next.done) break;
              const event = next.value;
              if (signal.aborted) break;

              // A yielded event is both transport liveness (custom/test
              // providers may not use agentLinkFetch) and parsed progress —
              // the only signal that re-arms the no-progress timer.
              transportMonitor.recordProgress();

              if (!firstTokenReceived) {
                firstTokenReceived = true;
                timeToFirstToken = Date.now() - startTime;
              }

              switch (event.type) {
                case "model_fallback":
                  activeModel = event.effectiveModel;
                  const fallbackStillSelected =
                    session.modelSelectionRevision ===
                    requestModelSelectionRevision;
                  if (fallbackStillSelected) {
                    session.model = activeModel;
                    await opts?.onModelFallback?.({
                      requestedModel: event.requestedModel,
                      effectiveModel: event.effectiveModel,
                    });
                  }
                  yield {
                    type: "warning",
                    message: fallbackStillSelected
                      ? `${event.requestedModel} is unavailable for this account. Switched to ${event.effectiveModel}.`
                      : `${event.requestedModel} is unavailable for this account. Its fallback to ${event.effectiveModel} was superseded by a newer model selection.`,
                    ...(fallbackStillSelected
                      ? {
                          modelFallback: {
                            requestedModel: event.requestedModel,
                            effectiveModel: event.effectiveModel,
                          },
                        }
                      : {}),
                  };
                  break;
                case "thinking_start":
                  yield {
                    type: "thinking_start",
                    thinkingId: event.thinkingId,
                  };
                  break;
                case "thinking_delta":
                  yield {
                    type: "thinking_delta",
                    thinkingId: event.thinkingId,
                    text: event.text,
                  };
                  break;
                case "thinking_end":
                  yield { type: "thinking_end", thinkingId: event.thinkingId };
                  break;
                case "text_delta":
                  {
                    let visibleText = event.text;
                    if (
                      !retryTextDiverged &&
                      retryTextOffset < retryTextPrefix.length
                    ) {
                      const remainingPrefix =
                        retryTextPrefix.slice(retryTextOffset);
                      let matchingLength = 0;
                      const limit = Math.min(
                        visibleText.length,
                        remainingPrefix.length,
                      );
                      while (
                        matchingLength < limit &&
                        visibleText[matchingLength] ===
                          remainingPrefix[matchingLength]
                      ) {
                        matchingLength++;
                      }
                      retryTextOffset += matchingLength;
                      visibleText = visibleText.slice(matchingLength);
                      if (visibleText.length > 0) retryTextDiverged = true;
                    }
                    if (visibleText.length > 0) {
                      visibleTextFromRetriedStream += visibleText;
                      yield { type: "text_delta", text: visibleText };
                    }
                  }
                  break;
                case "web_activity":
                  // Provider-hosted web activity is collected by delegated native
                  // tool execution or retained in private replay. It is not a
                  // separate public UI event; web tools render through ordinary
                  // tool_start/tool_result events.
                  break;
                case "tool_start":
                  pendingToolInputDeltas.set(event.toolCallId, []);
                  break;
                case "tool_input_delta":
                  pendingToolInputDeltas
                    .get(event.toolCallId)
                    ?.push(event.partialJson);
                  break;
                case "tool_done":
                  // Handled at content_blocks
                  break;
                case "content_blocks":
                  contentBlocks = event.blocks;
                  break;
                case "model_stop":
                  assistantMessage = event.assistantMessage;
                  modelStopReason = event.reason;
                  break;
                case "usage":
                  inputTokens = event.inputTokens;
                  outputTokens = event.outputTokens;
                  cacheReadTokens = event.cacheReadTokens ?? 0;
                  cacheCreationTokens = event.cacheCreationTokens ?? 0;
                  usageEstimated = event.estimated;
                  providerResponseId = event.providerResponseId;
                  break;
                case "done":
                  break;
              }
            }
          } finally {
            signal.removeEventListener("abort", abortRequest);
            transportMonitor.dispose();
            try {
              void streamIterator.return?.(undefined).catch(() => undefined);
            } catch {
              // Best-effort cancellation prevents abandoned streaming bodies
              // from occupying sockets after timeout/retry.
            }
          }
        } catch (streamErr: unknown) {
          while (pendingRequestAttributionEvents.length > 0) {
            yield pendingRequestAttributionEvents.shift()!;
          }
          if (signal.aborted) break;
          const streamErrMsg = buildErrorMessage(streamErr);
          if (streamErr instanceof ProviderStreamTimeoutError) {
            const http = getAgentLinkHttpDiagnostics();
            this.log?.(
              `[provider-timeout] ${streamErr.message} transportEstablished=${transportMonitor?.hasTransportActivity ?? false} lastActivityAt=${transportMonitor?.lastActivityAt ?? "none"} lastProgressAt=${transportMonitor?.lastProgressAt ?? "none"} activeHttp=${http.activeRequests} peakHttp=${http.peakActiveRequests} bodyChunks=${http.bodyChunks} transportErrors=${http.transportErrors}`,
            );
          }
          if (
            session.modelSelectionRevision !== requestModelSelectionRevision
          ) {
            continue;
          }

          // Broken tool_use/tool_result pairing (e.g. from an aborted run or
          // a bad history transform) causes a 400. Repair once and retry;
          // if the repair doesn't converge, surface the error instead of
          // retrying the same rejected payload forever.
          if (
            streamErrMsg.includes("tool_use") &&
            streamErrMsg.includes("tool_result") &&
            toolPairingRepairAttempts < MAX_TOOL_PAIRING_REPAIR_ATTEMPTS
          ) {
            toolPairingRepairAttempts++;
            session.replaceMessages(
              injectSyntheticToolResults(session.getAllMessages()),
            );
            yield {
              type: "warning",
              message: `Repaired orphaned tool calls, retrying. Error: ${streamErrMsg}`,
            };
            continue;
          }

          // previous_response_id can fail if the remote chain is unavailable
          // (e.g. non-stored state expired or couldn't be resolved). Clear the
          // local link and retry this turn with full replay.
          if (
            provider.id === "codex" &&
            session.codexStatefulResponses &&
            session.providerId === "codex" &&
            session.providerResponseId &&
            !previousResponseIdFallback &&
            /(previous_response_id|previous response|cannot be resolved|not found|invalid.*response)/i.test(
              streamErrMsg,
            )
          ) {
            previousResponseIdFallback = true;
            session.resetProviderResponseState();
            yield {
              type: "warning",
              message:
                "Codex could not resume the prior response state — retrying this turn with full local replay.",
            };
            continue;
          }

          if (
            provider.id === "anthropic" &&
            !thinkingSignatureRetryAttempted &&
            /Invalid `signature` in `thinking` block|invalid.*signature.*thinking/i.test(
              streamErrMsg,
            )
          ) {
            thinkingSignatureRetryAttempted = true;
            yield {
              type: "warning",
              message:
                "Anthropic rejected a thinking replay signature — retrying with sanitized replay history.",
            };
            continue;
          }

          // Context too long: auto-condense and retry rather than failing.
          // Catches both Anthropic ("prompt is too long") and Codex
          // ("exceeds the context window") errors.
          const isContextTooLong =
            streamErrMsg.includes("prompt is too long") ||
            streamErrMsg.includes("exceeds the context window") ||
            streamErrMsg.includes("context length exceeded") ||
            streamErrMsg.includes("maximum context length") ||
            (streamErr &&
              typeof streamErr === "object" &&
              "code" in streamErr &&
              (streamErr as { code?: string }).code ===
                "context_window_exceeded");
          if (isContextTooLong) {
            if (!contextTooLongCondenseAttempted) {
              contextTooLongCondenseAttempted = true;
              yield {
                type: "warning",
                message:
                  "Context limit exceeded — condensing conversation and retrying…",
              };
              requestPermit?.release();
              requestPermit = undefined;
              const condensed = yield* this.condenseSession(
                session,
                true,
                provider,
                preservedContext,
                activeModel,
                {
                  isBackground: opts?.isBackground,
                  signal,
                  onProviderAdmissionPhase: opts?.onProviderAdmissionPhase,
                  tools: rawTools,
                  automaticMemoryContext: opts?.automaticMemoryContext,
                },
              );
              if (signal.aborted) break;
              if (condensed) {
                retainedToolResults.clear();
                continue;
              }
            }
            throw streamErr;
          }

          // Auth errors: try refreshing credentials before failing.
          if (isAuthError(streamErr)) {
            const anthropicProvider =
              provider instanceof AnthropicProvider ? provider : null;
            if (
              !signal.aborted &&
              credentialRefreshCount < MAX_CREDENTIAL_REFRESHES &&
              anthropicProvider?.currentAuthSource === "cli-credentials"
            ) {
              credentialRefreshCount++;
              yield {
                type: "status_update",
                message: `Refreshing credentials… (attempt ${credentialRefreshCount}/${MAX_CREDENTIAL_REFRESHES} — ${streamErrMsg})`,
              };
              if (await anthropicProvider.refreshClient(signal)) {
                yield {
                  type: "status_update",
                  message: "Credentials refreshed — retrying…",
                };
                if (signal.aborted) break;
                continue;
              }
            }
            throw new AuthenticationError(streamErrMsg);
          }

          // Keep request establishment retries separate from reconnecting an
          // already-live stream. This mirrors the official harnesses and
          // prevents one failure class from consuming the other's budget.
          const retry = getAgentRetryDecision(streamErr);
          const isStreamFailure =
            firstTokenReceived ||
            (Boolean(transportMonitor?.hasTransportActivity) &&
              retry.status === undefined);
          const retryLayer = isStreamFailure ? "stream" : "request";
          const currentRetryCount = isStreamFailure
            ? streamRetryCount
            : requestRetryCount;
          const maxRetries = isStreamFailure
            ? MAX_STREAM_RETRIES
            : TRANSIENT_RETRY_CATEGORIES.has(retry.category)
              ? MAX_TRANSIENT_REQUEST_RETRIES
              : MAX_REQUEST_RETRIES;
          if (retry.retryable && currentRetryCount < maxRetries) {
            const retryAttempt = currentRetryCount + 1;
            if (isStreamFailure) {
              streamRetryCount = retryAttempt;
            } else {
              requestRetryCount = retryAttempt;
            }
            const delayMs = calculateProviderRetryDelayMs(
              retry.category,
              retryAttempt,
              retry.retryAfterMs,
            );
            const retryAt = Date.now() + delayMs;
            yield {
              type: "warning",
              message: `${streamErrMsg} — retrying ${retryLayer} in ${delayMs / 1000}s (attempt ${retryAttempt}/${maxRetries})`,
              retryDelayMs: delayMs,
              retryAt,
              retryAttempt,
              retryMaxAttempts: maxRetries,
            };
            await sleep(delayMs);
            if (signal.aborted) break;
            continue;
          }

          throw streamErr;
        } finally {
          requestPermit?.release();
          requestPermit = undefined;
        }

        // Successful API response resets both independently budgeted layers.
        requestRetryCount = 0;
        streamRetryCount = 0;
        visibleTextFromRetriedStream = "";
        apiTurnCount++;

        if (signal.aborted) break;

        // Always record usage and emit api_request — even for capped turns.
        const durationMs = Date.now() - startTime;
        // Snapshot the running accumulation before addUsage() resets it — the
        // api_request event carries it so consumers can attribute usage jumps.
        const accumulatedEstimatedTokens = session.estimatedAccumulatedTokens;
        const accumulatedEstimatedTokensBySource = {
          ...session.estimatedAccumulationBySource,
        };
        const toolResultContextAttributions =
          session.toolResultContextAttributions.map((item) => ({ ...item }));
        const omittedToolResultContextAttributions =
          session.omittedToolResultContextAttributions;
        session.addUsage(
          inputTokens,
          outputTokens,
          cacheReadTokens,
          cacheCreationTokens,
        );
        if (
          session.modelSelectionRevision === requestModelSelectionRevision &&
          session.model === activeModel
        ) {
          session.setProviderResponseId(providerResponseId);
        }

        // Provider inputTokens is normalized to the uncached prompt portion.
        // For context window tracking, report the total: uncached + cache reads + cache writes.
        const totalInputTokens =
          inputTokens + cacheReadTokens + cacheCreationTokens;
        session.contextBreakdown = {
          ...contextBreakdown,
          contextLedger,
        };

        yield {
          type: "api_request",
          requestId,
          model: activeModel,
          reasoningEffort,
          inputTokens: totalInputTokens,
          uncachedInputTokens: inputTokens,
          outputTokens,
          cacheReadTokens,
          cacheCreationTokens,
          ...(usageEstimated !== undefined ? { usageEstimated } : {}),
          durationMs,
          timeToFirstToken,
          providerQueueWaitMs,
          usedPreviousResponseId,
          previousResponseIdFallback,
          promptCacheKey,
          promptCacheRetention,
          storeResponseState,
          providerResponseId,
          contextBreakdown: {
            ...contextBreakdown,
            contextLedger,
          },
          accumulatedEstimatedTokens,
          accumulatedEstimatedTokensBySource,
          toolResultContextAttributions,
          omittedToolResultContextAttributions,
          pinnedMemoryTokens: 0,
          retrievedMemoryTokens,
        };

        const committedAssistantMessage: CoreModelMessage =
          assistantMessage ?? {
            role: "assistant",
            content: contentBlocks,
          };
        const appendCommittedAssistantMessage = () => {
          session.appendAssistantMessage(
            committedAssistantMessage as AgentMessage,
          );
        };

        if (modelStopReason === "pause_turn") {
          providerPauseTurnCount += 1;
          if (providerPauseTurnCount > CORE_NATIVE_WEB_MAX_PAUSE_TURNS) {
            throw new Error(
              `Provider native web continuation exceeded ${CORE_NATIVE_WEB_MAX_PAUSE_TURNS} pause turns.`,
            );
          }
          appendCommittedAssistantMessage();
          opts?.onAssistantTurnCommitted?.();
          continue;
        }
        providerPauseTurnCount = 0;

        if (modelStopReason === "max_tokens") {
          appendCommittedAssistantMessage();
          opts?.onAssistantTurnCommitted?.();
          yield {
            type: "warning",
            message:
              "The model reached its output-token limit. The partial response was preserved; increase the model output limit or ask it to continue.",
          };
          break;
        }

        // Safety-classifier refusal (Claude Opus 5 / Fable 5): the response is
        // empty or partial and retrying the identical request would trip the
        // classifier again, so surface it instead of entering the
        // empty-response retry loop below.
        if (modelStopReason === "refusal") {
          if (hasVisibleOrActionableOutput(contentBlocks)) {
            appendCommittedAssistantMessage();
            // Close out any tool calls in the partial output so the history
            // does not carry dangling tool_use blocks into the next request.
            const refusedToolUseBlocks = contentBlocks.filter(
              (b): b is ToolUseBlock => b.type === "tool_use",
            );
            if (refusedToolUseBlocks.length > 0) {
              session.appendToolResults(
                refusedToolUseBlocks.map((b) => ({
                  type: "tool_result" as const,
                  tool_use_id: b.id,
                  content:
                    "[Not executed — the provider declined the request before tool execution.]",
                })),
              );
            }
            opts?.onAssistantTurnCommitted?.();
          }
          yield {
            type: "warning",
            message:
              "The provider declined this request (safety refusal). Any partial response was preserved. Rephrase the request or retry on a different model (e.g. Claude Opus 4.8).",
          };
          break;
        }

        // Enforce maxApiTurns: when the limit is reached and the model wants
        // more tool calls, inject a "wrap up" message to force a final response.
        if (maxApiTurns > 0 && apiTurnCount >= maxApiTurns) {
          const hasToolCalls = contentBlocks.some((b) => b.type === "tool_use");
          if (hasToolCalls) {
            wrapUpAttempts++;
            // Hard stop after too many wrap-up attempts to prevent infinite loops
            if (wrapUpAttempts > MAX_WRAP_UP_ATTEMPTS) {
              appendCommittedAssistantMessage();
              opts?.onAssistantTurnCommitted?.();
              yield {
                type: "warning",
                message: `Background agent exceeded ${MAX_WRAP_UP_ATTEMPTS} wrap-up attempts. Force-stopping.`,
              };
              break;
            }
            // Append the assistant turn with tool calls so history is valid,
            // then add synthetic results asking to wrap up.
            appendCommittedAssistantMessage();
            const toolUseBlocksForWrapUp = contentBlocks.filter(
              (b): b is ToolUseBlock => b.type === "tool_use",
            );
            session.appendToolResults(
              toolUseBlocksForWrapUp.map((b) => ({
                type: "tool_result" as const,
                tool_use_id: b.id,
                content:
                  "[Turn limit reached — tool not executed. Deliver your findings now with the information you have.]",
              })),
            );
            opts?.onAssistantTurnCommitted?.();
            yield {
              type: "warning",
              message: `Background agent turn limit reached (${maxApiTurns}). Requesting wrap-up.`,
            };
            continue;
          }
        }

        if (!hasVisibleOrActionableOutput(contentBlocks)) {
          if (emptyResponseRetryCount < MAX_EMPTY_RESPONSE_RETRIES) {
            emptyResponseRetryCount++;
            if (emptyResponseRetryCount === 1) {
              // First retry: silent re-stream (transient failures often self-heal)
              yield {
                type: "warning",
                message: "Provider returned an empty response — retrying…",
                visible: false,
              };
            } else {
              // Subsequent retries: nudge the model with an explicit continuation prompt
              yield {
                type: "warning",
                message:
                  "Provider returned an empty response — asking it to continue…",
                visible: false,
              };
              // Intentionally do not append an empty assistant turn or retry
              // nudge to history. The next request receives it ephemerally.
              pendingEmptyResponseNudge = true;
            }
            session.status = "streaming";
            continue;
          }

          pendingEmptyResponseNudge = false;

          // Last resort: try auto-condensing and retrying once — this resets
          // the context and gives the model a fresh start. Only attempt once
          // to avoid an infinite condense → empty → condense loop.
          if (
            !emptyResponseCondenseAttempted &&
            !signal.aborted &&
            session.autoCondense
          ) {
            emptyResponseCondenseAttempted = true;
            yield {
              type: "warning",
              message:
                "Empty responses persisted — condensing conversation and retrying…",
            };
            const condensed = yield* this.condenseSession(
              session,
              true,
              provider,
              preservedContext,
              activeModel,
              {
                isBackground: opts?.isBackground,
                signal,
                onProviderAdmissionPhase: opts?.onProviderAdmissionPhase,
                tools: rawTools,
                automaticMemoryContext: opts?.automaticMemoryContext,
              },
            );
            if (signal.aborted) break;
            if (condensed) {
              retainedToolResults.clear();
              emptyResponseRetryCount = 0;
              continue;
            }
          }

          yield {
            type: "error",
            error: `Provider returned empty responses ${MAX_EMPTY_RESPONSE_RETRIES + 1} times in a row. Please retry.`,
            retryable: true,
            actions: { condense: true },
          };
          return;
        }

        emptyResponseRetryCount = 0;
        pendingEmptyResponseNudge = false;

        // Extract tool_use blocks
        const toolUseBlocks = contentBlocks.filter(
          (b): b is ToolUseBlock => b.type === "tool_use",
        );

        if (toolUseBlocks.length === 0) {
          // No tool calls — append the assistant turn on its own and finish.
          appendCommittedAssistantMessage();
          opts?.onAssistantTurnCommitted?.();
          break;
        }

        if (!this.toolRuntime) {
          // No dispatch runtime — append and finish without executing tools.
          appendCommittedAssistantMessage();
          opts?.onAssistantTurnCommitted?.();
          break;
        }

        // Enforce maxToolCalls: count only dispatch-eligible tools (exclude todo_write).
        const dispatchableToolCount = toolUseBlocks.filter(
          (b) => b.name !== TODO_TOOL_NAME,
        ).length;
        const toolCallReservation =
          dispatchableToolCount > 0
            ? toolCallBudget.tryReserve(dispatchableToolCount)
            : undefined;
        if (toolCallReservation && !toolCallReservation.ok) {
          wrapUpAttempts++;
          if (wrapUpAttempts > MAX_WRAP_UP_ATTEMPTS) {
            appendCommittedAssistantMessage();
            opts?.onAssistantTurnCommitted?.();
            yield {
              type: "warning",
              message: `Background agent exceeded ${MAX_WRAP_UP_ATTEMPTS} wrap-up attempts. Force-stopping.`,
            };
            break;
          }
          appendCommittedAssistantMessage();
          session.appendToolResults(
            toolUseBlocks.map((b) => ({
              type: "tool_result" as const,
              tool_use_id: b.id,
              content:
                "[Tool call budget exceeded — tool not executed. Deliver your findings now with the information you have.]",
            })),
          );
          opts?.onAssistantTurnCommitted?.();
          yield {
            type: "warning",
            message: `Background agent tool call limit reached (${maxToolCalls}). Requesting wrap-up.`,
          };
          continue;
        }

        // The response and its budget checks are now committed. Publish only
        // tool calls that will actually dispatch; provisional calls from
        // failed/retried streams and calls refused at a hard limit never reach
        // UI or background budget accounting.
        if (
          opts?.onPendingToolTurn &&
          toolUseBlocks.some((block) => block.name !== TODO_TOOL_NAME)
        ) {
          await opts.onPendingToolTurn(
            structuredClone(committedAssistantMessage as AgentMessage),
          );
        }
        // Arm recovery for the turn's ask_user call even when the model issued
        // sibling tool calls in parallel — the whole turn lives only in memory
        // until every tool resolves, so a reload while the question is pending
        // would otherwise lose it. Recovery replay substitutes synthetic
        // results for the sibling calls.
        const askUserBlocks = toolUseBlocks.filter(
          (block) => block.name === "ask_user",
        );
        const pendingQuestionRecovery =
          !opts?.isBackground && askUserBlocks.length === 1
            ? {
                schemaVersion: 1 as const,
                assistantContent: structuredClone(contentBlocks),
                toolUseId: askUserBlocks[0]!.id,
                toolName: "ask_user" as const,
                toolInput: structuredClone(
                  askUserBlocks[0]!.input as Record<string, unknown>,
                ),
              }
            : undefined;

        // Session-scoped tool context: use session.id so that per-session approvals
        // (MCP, command, write) are isolated between foreground chat sessions rather
        // than shared via the static "agent" synthetic ID.
        const sessionToolContext: AgentToolExecutionContext = {
          sessionId: session.id,
          mode: session.agentMode.slug,
          toolProfile: opts?.toolProfile,
          availableToolNames: new Set(rawTools?.map((tool) => tool.name) ?? []),
          modeAllowedToolNames,
          nativeToolDisclosure,
          skillAllowedTools: requestSkillAllowedTools,
          skillAuthority: requestSkillAuthority,
          toolCallBudget,
          commandExecutionPolicy:
            session.agentMode.toolGroups.includes("read-only-command") ||
            opts?.toolProfile === "review" ||
            opts?.toolProfile === "readonly-research"
              ? "read-only"
              : undefined,
          pendingQuestionRecovery,
          onFinalStatus: (marker) => {
            pendingFinalMarker = marker;
          },
          backgroundExpectedResult:
            backgroundExpectedResult === "text" ||
            backgroundExpectedResult === "review_findings" ||
            backgroundExpectedResult === "patch" ||
            backgroundExpectedResult === "verification"
              ? backgroundExpectedResult
              : undefined,
          onCompleteTodos: () => {
            currentTodos = completeTodos(currentTodos);
            pendingCompletedTodoUpdate = currentTodos;
            return currentTodos;
          },
          getSessionTranscript: () =>
            buildSessionTranscriptSnapshot(session.getAllMessages()),
          getSessionImages: () =>
            collectSessionImages(session.getAllMessages()),
        };
        const resolvedToolUseBlocks: ResolvedToolUseBlock[] = toolUseBlocks.map(
          (block) => {
            const providerInput = block.input as Record<string, unknown>;
            const resolved: ResolvedAgentToolCall =
              this.toolRuntime?.resolveToolCall?.({
                name: block.name,
                input: providerInput,
                context: sessionToolContext,
              }) ?? {
                providerName: block.name,
                providerInput,
                canonicalName: block.name,
                canonicalInput: providerInput,
                route: "direct",
              };
            return {
              ...block,
              name: resolved.canonicalName,
              input: resolved.canonicalInput,
              providerName: block.name,
              providerInput,
            };
          },
        );
        for (const block of resolvedToolUseBlocks) {
          session.currentTool = block.name;
          yield {
            type: "tool_start",
            toolCallId: block.id,
            toolName: block.name,
            input: block.input,
          };
          if (block.providerName === block.name) {
            for (const partialJson of pendingToolInputDeltas.get(block.id) ??
              []) {
              yield {
                type: "tool_input_delta",
                toolCallId: block.id,
                partialJson,
              };
            }
          }
        }

        // Execute tools (parallel for read-only, sequential for write)
        session.status = "tool_executing";

        // Separate internal tools (todo_write) from dispatch tools
        const internalResults: ToolCallResult[] = [];
        const dispatchBlocks: ResolvedToolUseBlock[] = [];
        for (const block of resolvedToolUseBlocks) {
          if (block.name === TODO_TOOL_NAME) {
            const start = Date.now();
            const { content, todos } = handleTodoWrite(
              block.input as unknown as TodoToolInput,
            );
            internalResults.push({
              tool_use_id: block.id,
              toolName: block.name,
              result: {
                content: [
                  {
                    type: "text",
                    text:
                      typeof content === "string"
                        ? content
                        : JSON.stringify(content),
                  },
                ],
              },
              durationMs: Date.now() - start,
            });
            currentTodos = todos;
            yield { type: "todo_update" as const, todos };
          } else {
            dispatchBlocks.push(block);
          }
        }

        const toolUseBlocksById = new Map(
          resolvedToolUseBlocks.map((block) => [block.id, block]),
        );
        let dispatchResults: ToolCallResult[] = [];
        if (dispatchBlocks.length > 0) {
          const toolExecutionStartedAt = Date.now();
          const dispatchEvents: AgentEvent[] = [];
          let wakeDispatchEvents: (() => void) | undefined;
          const waitForDispatchEvent = () =>
            new Promise<void>((resolve) => {
              wakeDispatchEvents = resolve;
            });
          const pushDispatchEvent = (event: AgentEvent) => {
            dispatchEvents.push(event);
            const wake = wakeDispatchEvents;
            wakeDispatchEvents = undefined;
            wake?.();
          };

          const dispatchPromise = this.executeToolCalls(
            dispatchBlocks,
            signal,
            {
              ...sessionToolContext,
              onNestedToolStart: (nested) =>
                pushDispatchEvent({
                  type: "tool_start",
                  toolCallId: nested.toolCallId,
                  toolName: nested.toolName,
                  parentCallId: nested.parentCallId,
                  input: nested.input,
                }),
              onNestedToolComplete: (nested) =>
                pushDispatchEvent({
                  type: "tool_result",
                  toolCallId: nested.toolCallId,
                  toolName: nested.toolName,
                  parentCallId: nested.parentCallId,
                  result: nested.result.content,
                  durationMs: nested.durationMs,
                  input: nested.input,
                }),
            },
            session,
            (tr) => {
              const toolUseBlock = toolUseBlocksById.get(tr.tool_use_id);
              pushDispatchEvent({
                type: "tool_result" as const,
                toolCallId: tr.tool_use_id,
                toolName: tr.toolName,
                result: tr.result.content,
                durationMs: tr.durationMs,
                input: toolUseBlock?.input,
                mcpApprovalPromotion: tr.mcpApprovalPromotion,
                composeTrace: tr.composeTrace,
              });
              if (
                tr.toolName === "set_task_status" &&
                pendingCompletedTodoUpdate
              ) {
                pushDispatchEvent({
                  type: "todo_update" as const,
                  todos: pendingCompletedTodoUpdate,
                });
                pendingCompletedTodoUpdate = null;
              }
            },
          );

          const dispatchDonePromise = dispatchPromise.then((results) => ({
            done: true as const,
            aborted: false,
            results,
          }));
          const abortPromise = new Promise<{
            done: true;
            aborted: true;
            results: ToolCallResult[];
          }>((resolve) => {
            if (signal.aborted) {
              resolve({ done: true, aborted: true, results: [] });
              return;
            }
            signal.addEventListener(
              "abort",
              () => resolve({ done: true, aborted: true, results: [] }),
              { once: true },
            );
          });
          let dispatchDone = false;

          while (!dispatchDone || dispatchEvents.length > 0) {
            if (signal.aborted) {
              dispatchEvents.length = 0;
              dispatchDone = true;
              break;
            }
            if (dispatchEvents.length === 0 && !dispatchDone) {
              const raced = await Promise.race([
                dispatchDonePromise,
                abortPromise,
                waitForDispatchEvent().then(() => ({
                  done: false as const,
                  aborted: false,
                })),
              ]);
              if (raced.done) {
                if (!raced.aborted) {
                  dispatchResults = raced.results;
                }
                dispatchDone = true;
              }
            }

            while (dispatchEvents.length > 0) {
              if (signal.aborted) {
                dispatchEvents.length = 0;
                break;
              }
              yield dispatchEvents.shift()!;
            }
          }
          logTiming(
            "tool execution",
            toolExecutionStartedAt,
            `dispatch=${dispatchBlocks.length} internal=${internalResults.length}`,
          );
        }

        if (signal.aborted) break;

        // Merge results back in original order
        const internalResultsById = new Map(
          internalResults.map((result) => [result.tool_use_id, result]),
        );
        const dispatchResultsById = new Map(
          dispatchResults.map((result) => [result.tool_use_id, result]),
        );
        const toolResults = toolUseBlocks.map((block) => {
          const internal = internalResultsById.get(block.id);
          if (internal) return internal;
          return dispatchResultsById.get(block.id)!;
        });

        // Finalize retained history before the atomic assistant/tool-result commit
        // so artifact I/O can never leave orphaned tool_use blocks in the session.
        const toolResultContents: CoreModelToolResultBlock["content"][] = [];
        for (const tr of toolResults) {
          const canonicalContent =
            tr.historyContent ??
            toolResultToContent(tr.result, tr.tool_use_id, tr.toolName);
          tr.historyContent = await retainToolResultHistoryContent(
            tr.result,
            canonicalContent,
            tr.tool_use_id,
            tr.toolName,
            retainedToolResultRunId,
            retainedToolResults,
          );
          toolResultContents.push(tr.historyContent);
        }

        // Append assistant turn + tool results atomically — no async gap between
        // them so the session is never left with orphaned tool_use blocks.
        const finalMarkerForTurn = pendingFinalMarker;
        appendCommittedAssistantMessage();
        if (finalMarkerForTurn) {
          session.applyFinalMarker(finalMarkerForTurn);
          yield { type: "final_marker", marker: finalMarkerForTurn };
          pendingFinalMarker = null;
        }
        session.appendToolResults(
          toolResults.map((tr, index) => ({
            type: "tool_result" as const,
            tool_use_id: tr.tool_use_id,
            content: toolResultContents[index]!,
            mcpApprovalPromotion: tr.mcpApprovalPromotion,
            composeTrace: tr.composeTrace,
          })),
        );
        opts?.onAssistantTurnCommitted?.();

        // Feed estimated token size of tool results to the running accumulator,
        // attributed per tool so jump telemetry can name the contributors.
        toolResults.forEach((tr, index) => {
          const measurement = measureToolResultContentForAttribution(
            toolResultContents[index]!,
          );
          session.addToolResultContextAttribution(
            tr.tool_use_id,
            tr.toolName,
            measurement.retainedContent,
            measurement.estimatedTokens,
          );
        });

        // Internal tools (todo_write) don't flow through executeToolCalls, so emit
        // their completion events now. Dispatch-tool completion events are emitted
        // by executeToolCalls as each call finishes.
        for (const tr of internalResults) {
          const toolUseBlock = toolUseBlocksById.get(tr.tool_use_id);
          yield {
            type: "tool_result" as const,
            toolCallId: tr.tool_use_id,
            toolName: tr.toolName,
            result: tr.result.content,
            durationMs: tr.durationMs,
            input: toolUseBlock?.input,
            mcpApprovalPromotion: tr.mcpApprovalPromotion,
          };
        }

        const successfulModeSwitch = toolResults.find((tr) =>
          getSuccessfulModeSwitch(tr),
        );
        const successfulFinalMarker = toolResults.some(
          (tr) => tr.toolName === "set_task_status" && finalMarkerForTurn,
        );
        // A queued interjection takes priority over ending the turn: fall
        // through to the drain below so the user's message is injected and the
        // model responds to it, instead of stopping at set_task_status.
        if (
          successfulFinalMarker &&
          (signal.aborted || !session.hasPendingInterjections)
        ) {
          break;
        }
        if (successfulModeSwitch) {
          // Enforce a hard boundary: after a successful mode switch, stop this turn
          // before another provider round-trip under the previous request contract.
          break;
        }

        // Post-batch condense check: tool results added estimated tokens to the
        // session accumulator above. Check if we've crossed the threshold.
        if (
          !signal.aborted &&
          session.modelSelectionRevision === requestModelSelectionRevision &&
          isOverCondenseThresholdInternal(session, provider, activeModel)
        ) {
          const condensed = yield* this.condenseSession(
            session,
            true,
            provider,
            preservedContext,
            activeModel,
            {
              isBackground: opts?.isBackground,
              signal,
              onProviderAdmissionPhase: opts?.onProviderAdmissionPhase,
              tools: rawTools,
              automaticMemoryContext: opts?.automaticMemoryContext,
            },
          );
          if (condensed) retainedToolResults.clear();
        }

        // Inject any pending user interjections between tool batches,
        // draining FIFO so multiple queued messages all land at this break.
        if (!signal.aborted) {
          for (
            let interjection = session.consumePendingInterjection();
            interjection !== null;
            interjection = session.consumePendingInterjection()
          ) {
            const resolvedInterjection = await resolveQueuedAttachments(
              interjection.text,
              interjection.attachments,
            );
            const images = [
              ...(interjection.images ?? []),
              ...resolvedInterjection.images,
            ];
            const documents = [
              ...(interjection.documents ?? []),
              ...resolvedInterjection.documents,
            ];
            session.addUserMessage(resolvedInterjection.text, {
              displayText: interjection.displayText,
              isSlashCommand: interjection.isSlashCommand === true,
              slashCommandLabel: interjection.slashCommandLabel,
              images: images.length > 0 ? images : undefined,
              documents: documents.length > 0 ? documents : undefined,
            });
            yield {
              type: "user_interjection" as const,
              text: interjection.text,
              queueId: interjection.queueId,
              displayText: interjection.displayText,
              isSlashCommand: interjection.isSlashCommand === true,
              slashCommandLabel: interjection.slashCommandLabel,
              images: images.length > 0 ? images : undefined,
              documents: documents.length > 0 ? documents : undefined,
            };
          }
        }

        session.status = "streaming";
      }
    } catch (err: unknown) {
      if (signal.aborted) return;
      // Retryable errors are handled inside the loop with auto-retry.
      // Anything reaching here is non-retryable or exhausted all retries.
      // Auth and exhausted transient errors are marked retryable so the UI can
      // always offer a sensible retry path.
      const errorMessage = buildErrorMessage(err);
      const isAuth = err instanceof AuthenticationError || isAuthError(err);
      const retryable =
        isAuth ||
        getAgentRetryDecision(err).retryable ||
        hasAgentRetryableErrorFlag(err);
      const code = getAgentErrorCode(err);
      const actions = getAgentErrorActions(err);
      yield {
        type: "error",
        error: errorMessage,
        retryable,
        code,
        actions,
      };
      return;
    } finally {
      session.status = "idle";
    }

    // Don't emit done if aborted — ChatViewProvider already posted agentDone on stop,
    // and a second done event could interrupt a new run that's already in progress.
    if (signal.aborted) return;

    yield {
      type: "done",
      totalInputTokens: session.totalInputTokens,
      totalOutputTokens: session.totalOutputTokens,
      totalCacheReadTokens: session.totalCacheReadTokens,
      totalCacheCreationTokens: session.totalCacheCreationTokens,
    };
  }

  /**
   * Execute tool calls with parallel read-only and sequential write strategy.
   * Results are returned in the same order as the original tool_use blocks.
   */
  /**
   * Returns true if the session's estimated context usage exceeds the
   * auto-condense threshold. Uses session.estimatedTotalUsed which includes
   * accumulated estimates for content added since the last API response.
   */
  isOverCondenseThreshold(
    session: AgentSession,
    provider?: ModelProvider,
  ): boolean {
    const resolvedProvider =
      provider ?? this.registry.tryResolveProvider(session.model);
    if (!resolvedProvider) return false;
    return isOverCondenseThresholdInternal(session, resolvedProvider);
  }

  private async executeToolCalls(
    calls: ResolvedToolUseBlock[],
    signal: AbortSignal,
    ctx: AgentToolExecutionContext,
    session: AgentSession,
    onToolComplete?: (result: ToolCallResult) => void,
  ): Promise<Array<ToolCallResult>> {
    const batchSkillAllowedTools = ctx.skillAllowedTools;
    const resultSlots = Array.from<ToolCallResult | null>({
      length: calls.length,
    }).fill(null);

    const tracker = this.toolRuntime?.getToolCallTracker?.();
    const trackedCalls = new Map<
      string,
      {
        trackerCtx: unknown;
        forcePromise: Promise<ToolResult>;
        forceResolve: (result: ToolResult) => void;
        controller: AbortController;
      }
    >();

    for (const call of calls) {
      let forceResolve!: (result: ToolResult) => void;
      const forcePromise = new Promise<ToolResult>((resolve) => {
        forceResolve = resolve;
      });
      const controller = new AbortController();
      const trackerCtx = tracker?.registerAgentCall(
        call.id,
        call.name,
        extractAgentDisplayArgs(
          call.name,
          call.input as Record<string, unknown>,
        ),
        session.id,
        (result) => {
          controller.abort();
          forceResolve(result);
        },
        JSON.stringify(call.input, null, 2),
        ctx.parentCallId,
      );
      trackedCalls.set(call.id, {
        trackerCtx,
        forcePromise,
        forceResolve,
        controller,
      });
    }

    const forceAbortTrackedCalls = () => {
      const abortedResult: ToolResult = {
        content: [{ type: "text", text: JSON.stringify({ error: "Aborted" }) }],
      };
      for (const trackedCall of trackedCalls.values()) {
        trackedCall.controller.abort();
        trackedCall.forceResolve(abortedResult);
      }
    };

    if (signal.aborted) {
      forceAbortTrackedCalls();
    } else {
      signal.addEventListener("abort", forceAbortTrackedCalls, { once: true });
    }

    const runTrackedToolCall = async (
      call: ResolvedToolUseBlock,
      start: number,
    ): Promise<ToolCallResult> => {
      const trackedCall = trackedCalls.get(call.id);
      const trackerCtx = trackedCall?.trackerCtx;
      const forcePromise = trackedCall?.forcePromise;
      const controller = trackedCall?.controller;

      try {
        const result = await (forcePromise
          ? Promise.race([
              this.toolRuntime!.executeTool({
                name: call.name,
                input: call.input as Record<string, unknown>,
                context: {
                  ...ctx,
                  sessionId: session.id,
                  toolCallId: call.id,
                  ...(call.providerName !== call.name
                    ? {
                        providerToolName: call.providerName,
                        providerToolInput: call.providerInput,
                      }
                    : {}),
                  trackerCtx,
                  toolAbortSignal: controller?.signal,
                  getAdvertisedSkills: () =>
                    session.getAdvertisedSkills().map((skill) => ({
                      id: skill.id,
                      name: skill.name,
                      revision: skill.revision,
                      skillPath: skill.skillPath,
                      realSkillPath: skill.provenance.realSkillPath,
                    })),
                  getAdvertisedRules: () => session.getAdvertisedRules(),
                  onSkillLoad: (activation) =>
                    session.trackLoadedSkill(activation),
                  skillAllowedTools: batchSkillAllowedTools,
                },
              }),
              forcePromise,
            ])
          : this.toolRuntime!.executeTool({
              name: call.name,
              input: call.input as Record<string, unknown>,
              context: {
                ...ctx,
                sessionId: session.id,
                toolCallId: call.id,
                ...(call.providerName !== call.name
                  ? {
                      providerToolName: call.providerName,
                      providerToolInput: call.providerInput,
                    }
                  : {}),
                trackerCtx,
                toolAbortSignal: controller?.signal,
                getAdvertisedSkills: () =>
                  session.getAdvertisedSkills().map((skill) => ({
                    id: skill.id,
                    name: skill.name,
                    revision: skill.revision,
                    skillPath: skill.skillPath,
                    realSkillPath: skill.provenance.realSkillPath,
                  })),
                getAdvertisedRules: () => session.getAdvertisedRules(),
                onSkillLoad: (activation) =>
                  session.trackLoadedSkill(activation),
                skillAllowedTools: batchSkillAllowedTools,
              },
            }));
        return {
          tool_use_id: call.id,
          toolName: call.name,
          result,
          durationMs: Date.now() - start,
          mcpApprovalPromotion: result.uiMeta?.mcpApprovalPromotion,
          composeTrace: result.uiMeta?.composeTrace,
        };
      } catch (err) {
        return {
          tool_use_id: call.id,
          toolName: call.name,
          result: handleToolError(err),
          durationMs: Date.now() - start,
        };
      } finally {
        controller?.abort();
        tracker?.completeAgentCall(call.id);
      }
    };

    const executeAtIndex = async (i: number): Promise<void> => {
      if (signal.aborted) return;
      const call = calls[i];
      const start = Date.now();
      let callResult: ToolCallResult;
      try {
        callResult = await runTrackedToolCall(call, start);
      } catch (err) {
        callResult = {
          tool_use_id: call.id,
          toolName: call.name,
          result: handleToolError(err),
          durationMs: Date.now() - start,
        };
      }
      resultSlots[i] = callResult;
      onToolComplete?.(callResult);
    };

    // Preserve model order with exclusive barriers: adjacent parallel-safe
    // calls may overlap, while every non-parallel call waits for prior work and
    // blocks later work. This matches Codex's shared/exclusive dispatch gate.
    let nextIndex = 0;
    while (nextIndex < calls.length && !signal.aborted) {
      const call = calls[nextIndex];
      const parallelSafe =
        this.toolRuntime?.isParallelSafe(
          call.name,
          call.input as Record<string, unknown>,
        ) ?? false;
      if (parallelSafe) {
        const batch: number[] = [];
        while (nextIndex < calls.length) {
          const candidate = calls[nextIndex];
          if (
            !(
              this.toolRuntime?.isParallelSafe(
                candidate.name,
                candidate.input as Record<string, unknown>,
              ) ?? false
            )
          ) {
            break;
          }
          batch.push(nextIndex);
          nextIndex += 1;
        }
        await Promise.all(batch.map((index) => executeAtIndex(index)));
        continue;
      }

      const completedIndex = nextIndex;
      nextIndex += 1;
      await executeAtIndex(completedIndex);

      const completed = resultSlots[completedIndex];
      if (!completed) continue;
      const modeSwitch = getSuccessfulModeSwitch(completed);
      const finalStatusSet = completed.toolName === "set_task_status";
      if (!modeSwitch && !finalStatusSet) continue;

      // A successful mode switch or final status marker is a turn boundary.
      // Skip every trailing call, including parallel-safe calls that are now
      // correctly held behind this ordered barrier.
      for (let index = nextIndex; index < calls.length; index++) {
        if (resultSlots[index]) continue;
        const skipped = modeSwitch
          ? buildModeSwitchSkippedResult(calls[index], modeSwitch.mode)
          : buildFinalStatusSkippedResult(calls[index]);
        resultSlots[index] = skipped;
        tracker?.completeAgentCall(calls[index].id);
        onToolComplete?.(skipped);
      }
      break;
    }

    if (signal.aborted) {
      for (let i = 0; i < resultSlots.length; i++) {
        if (!resultSlots[i]) tracker?.completeAgentCall(calls[i].id);
      }
    }

    signal.removeEventListener("abort", forceAbortTrackedCalls);

    // Return results in original order, filling any gaps (from abort) with errors.
    // Calls are pre-registered with the sidebar tracker before execution, so any
    // never-executed slots must be completed here to avoid stale active rows.
    return resultSlots.map((slot, i) => {
      if (slot) return slot;
      tracker?.completeAgentCall(calls[i].id);
      return {
        tool_use_id: calls[i].id,
        toolName: calls[i].name,
        result: {
          content: [
            { type: "text", text: JSON.stringify({ error: "Aborted" }) },
          ],
        },
        durationMs: 0,
      };
    });
  }

  /**
   * Condense the session's conversation history.
   * Yields condense or condense_error events. Updates session.messages on success.
   */
  async *condenseSession(
    session: AgentSession,
    isAutomatic: boolean,
    provider?: ModelProvider,
    preservedContext?: PreservedRuntimeContext,
    activeModel = session.model,
    opts?: {
      isBackground?: boolean;
      signal?: AbortSignal;
      automaticMemoryContext?: Readonly<AutomaticMemoryContext>;
      onProviderAdmissionPhase?: (
        phase: "queued_for_provider" | "running",
      ) => void;
      tools?: ToolDefinition[];
    },
  ): AsyncGenerator<AgentEvent, boolean> {
    const condenseStartedAt = Date.now();
    yield { type: "condense_start", isAutomatic };

    const prevInputTokens = session.lastInputTokens;

    // Resolve the provider for condensing — use the session's provider if available
    const resolvedProvider =
      provider ?? this.registry.resolveProvider(activeModel);

    const schedulerQueued = !this.registry.requestScheduler.hasCapacity(
      resolvedProvider.id,
      opts?.isBackground ? "background" : "interactive",
    );
    const permitPromise = this.registry.requestScheduler.acquire(
      resolvedProvider.id,
      opts?.isBackground ? "background" : "interactive",
      opts?.signal,
    );
    if (!opts?.isBackground) {
      opts?.onProviderAdmissionPhase?.(
        schedulerQueued ? "queued_for_provider" : "running",
      );
    }
    const permit = await permitPromise;
    if (!opts?.isBackground) {
      opts?.onProviderAdmissionPhase?.("running");
    }

    const requestAttributionEvents: Array<
      Extract<AgentEvent, { type: "request_context_attribution" }>
    > = [];
    let result: Awaited<ReturnType<typeof summarizeConversation>> | undefined;
    let summarizeError: unknown;
    let summarizeThrew = false;
    try {
      result = await summarizeConversation(
        {
          messages: session.getAllMessages(),
          provider: resolvedProvider,
          activeModel,
          systemPrompt: session.systemPrompt,
          isAutomatic,
          filesRead: [...session.filesRead],
          cwd: session.requireProjectRoot(),
          preservedContext,
          onProviderRequest: (request) => {
            requestAttributionEvents.push({
              type: "request_context_attribution",
              requestId: request.requestId,
              requestKind: "condense",
              model: request.model,
              estimatedInputTokens: request.estimatedInputTokens,
              // Condense converts tool carriers into bounded summary-source text,
              // so original call-level detail would not describe this request exactly.
              toolResultContextAttributions: [],
              omittedToolResultContextAttributions: 0,
              pinnedMemoryTokens: 0,
              retrievedMemoryTokens: 0,
            });
          },
        },
        prevInputTokens,
      );
    } catch (error) {
      summarizeThrew = true;
      summarizeError = error;
    } finally {
      permit.release();
    }

    for (const event of requestAttributionEvents) yield event;
    if (summarizeThrew) throw summarizeError;
    if (!result) throw new Error("Condense summarizer returned no result.");

    if (result.error) {
      yield {
        type: "condense_error",
        error: result.error,
        retryable: result.errorRetryable,
        code: result.errorCode,
        actions: result.errorActions,
      };
      return false;
    }

    const condenseDurationMs = Date.now() - condenseStartedAt;
    const messagesWithUiHints = result.messages.map((msg) =>
      msg.isSummary
        ? {
            ...msg,
            uiHint: {
              ...msg.uiHint,
              condense: {
                prevInputTokens: result.prevInputTokens,
                newInputTokens: result.newInputTokens,
                durationMs: condenseDurationMs,
                validationWarnings: result.validationWarnings,
              },
            },
          }
        : msg,
    );
    session.replaceMessages(messagesWithUiHints);
    const projection = buildPostCondenseProjection(
      session,
      resolvedProvider,
      activeModel,
      opts?.tools,
      opts?.automaticMemoryContext,
    );
    result.newInputTokens = projection.estimatedInputTokens;
    const metadata = result.metadata
      ? { ...result.metadata, postCondenseProjection: projection }
      : { postCondenseProjection: projection };
    for (const message of messagesWithUiHints) {
      if (message.isSummary && message.uiHint?.condense) {
        message.uiHint.condense.newInputTokens =
          projection.estimatedInputTokens;
      }
    }
    // Reset token accounting to the provider-comparable projected request input
    // so we don't immediately re-trigger from a summary-only underestimate.
    session.lastInputTokens = projection.estimatedInputTokens;
    session.lastOutputTokens = 0;
    session.lastCacheReadTokens = 0;
    session.estimatedAccumulatedTokens = 0;
    session.estimatedAccumulationBySource = {};
    session.toolResultContextAttributions = [];
    session.omittedToolResultContextAttributions = 0;

    yield {
      type: "condense",
      summary: result.summary,
      prevInputTokens: result.prevInputTokens,
      newInputTokens: result.newInputTokens,
      validationWarnings: result.validationWarnings,
      metadata,
      durationMs: condenseDurationMs,
    };
    return true;
  }
}
