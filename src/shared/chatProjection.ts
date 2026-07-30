import type { CommandApprovalPolicy } from "../approvals/commandApprovalPolicy.js";
import type { ApprovalRequest } from "../approvals/webview/types.js";
import { isCoreReasoningEffort } from "../core/modelCatalog.js";
import type { CoreWebActivity, CoreWebCitation } from "../core/webAccess.js";
import type {
  ChatMessage,
  ChatState,
  ContentBlock,
  ModeInfo,
  Question,
  ReasoningEffort,
  SlashCommandInfo,
  TodoItem,
  WebviewModelInfo,
} from "../agent/webview/types.js";

import type { ComposeChildStatus, ComposeTrace } from "./composeTypes.js";
import type { BackgroundResultState } from "../core/capabilities/background.js";
import type { ContextHealthSnapshot } from "./contextHealth.js";
import type { DetectedQuestion } from "./questionDetection.js";
import { randomId } from "./randomId.js";
import { getToolCapabilityMetadata } from "../core/tools/toolCapabilities.js";
import type {
  BackgroundCompletionResult,
  InFlightAssistantBlock,
  McpApprovalPromotionMeta,
  RequestContextBreakdown,
  RevertRecoveryNotice,
} from "./types.js";
import {
  getFinalMessageContinueAction,
  type FinalMessageMarker,
} from "./finalStatus.js";

type DisplayMedia = NonNullable<ChatMessage["displayMedia"]>;
type RawImageMedia = { name: string; mimeType: string; base64: string };
type RawDocumentMedia = { name: string; mimeType: string; base64?: string };

function mediaToDisplayMedia(
  media:
    | {
        images?: RawImageMedia[];
        documents?: RawDocumentMedia[];
      }
    | undefined,
): DisplayMedia | undefined {
  if (!media?.images?.length && !media?.documents?.length) return undefined;
  return {
    images:
      media.images?.map((image) => ({
        name: image.name,
        mimeType: image.mimeType,
        src: `data:${image.mimeType};base64,${image.base64}`,
      })) ?? [],
    documents:
      media.documents?.map((document) => ({
        name: document.name,
        mimeType: document.mimeType,
      })) ?? [],
  };
}

function imageExtensionForMimeType(mimeType: string): string {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/webp") return "webp";
  if (mimeType === "image/gif") return "gif";
  return "png";
}

function resultImagesToDisplayMedia(
  images: Array<{ mimeType: string; data: string }> | undefined,
  startIndex = 0,
  namePrefix = "generated-image",
): DisplayMedia | undefined {
  if (!images?.length) return undefined;
  return {
    images: images.map((image, index) => ({
      name: `${namePrefix}-${startIndex + index + 1}.${imageExtensionForMimeType(image.mimeType)}`,
      mimeType: image.mimeType,
      src: `data:${image.mimeType};base64,${image.data}`,
    })),
    documents: [],
  };
}

function parseLoadSkillResult(result: string): {
  skillName?: string;
  path?: string;
  content?: string;
} {
  try {
    const parsed = JSON.parse(result) as {
      skill_name?: unknown;
      path?: unknown;
      content?: unknown;
    };
    return {
      skillName:
        typeof parsed.skill_name === "string" ? parsed.skill_name : undefined,
      path: typeof parsed.path === "string" ? parsed.path : undefined,
      content: typeof parsed.content === "string" ? parsed.content : undefined,
    };
  } catch {
    return {};
  }
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function sanitizeWebUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function sanitizeWebCitations(
  values: readonly CoreWebCitation[],
): CoreWebCitation[] {
  const citations: CoreWebCitation[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!value || typeof value !== "object") continue;
    const url = sanitizeWebUrl(value.url);
    if (!url) continue;
    const startIndex =
      typeof value.startIndex === "number" && Number.isFinite(value.startIndex)
        ? value.startIndex
        : undefined;
    const endIndex =
      typeof value.endIndex === "number" && Number.isFinite(value.endIndex)
        ? value.endIndex
        : undefined;
    const key = `${url}:${startIndex ?? ""}:${endIndex ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    citations.push({
      url,
      ...(typeof value.title === "string" && value.title.trim()
        ? { title: value.title.trim() }
        : {}),
      ...(typeof value.citedText === "string" && value.citedText.trim()
        ? { citedText: value.citedText.trim() }
        : {}),
      ...(startIndex !== undefined ? { startIndex } : {}),
      ...(endIndex !== undefined ? { endIndex } : {}),
    });
  }
  return citations;
}

function sanitizeWebActivity(value: CoreWebActivity): CoreWebActivity {
  const kind = value.kind === "fetch" ? "fetch" : "search";
  const status =
    value.status === "completed" || value.status === "failed"
      ? value.status
      : "started";
  const backend = value.backend === "mcp" ? "mcp" : "provider";
  const url = sanitizeWebUrl(value.url);
  return {
    id:
      typeof value.id === "string" && value.id
        ? value.id
        : `web-activity-${randomId()}`,
    kind,
    status,
    backend,
    ...(typeof value.query === "string" && value.query.trim()
      ? { query: value.query.trim() }
      : {}),
    ...(url ? { url } : {}),
    ...(value.citations?.length
      ? { citations: sanitizeWebCitations(value.citations) }
      : {}),
    ...(typeof value.error === "string" && value.error.trim()
      ? { error: value.error.trim() }
      : {}),
  };
}

const BUILTIN_TOOL_NAMES = new Set([
  "web_search",
  "web_fetch",
  "read_file",
  "get_context",
  "open_file",
  "search_files",
  "codebase_search",
  "list_files",
  "get_symbols",
  "get_hover",
  "get_references",
  "get_completions",
  "get_code_actions",
  "go_to_definition",
  "go_to_implementation",
  "go_to_type_definition",
  "get_call_hierarchy",
  "get_type_hierarchy",
  "get_inlay_hints",
  "get_module_neighbors",
  "get_repo_map",
  "get_diagnostics",
  "execute_command",
  "get_terminal_output",
  "write_file",
  "apply_diff",
  "find_and_replace",
  "rename_symbol",
  "todo_write",
  "ask_user",
  "load_skill",
  "spawn_background_agent",
  "get_background_status",
  "get_background_result",
  "kill_background_agent",
  "set_task_status",
]);

export function normalizeProjectedToolName(toolName: string): string {
  if (BUILTIN_TOOL_NAMES.has(toolName)) return toolName;
  const dotIndex = toolName.lastIndexOf(".");
  if (dotIndex < 0) return toolName;
  const suffix = toolName.slice(dotIndex + 1);
  return BUILTIN_TOOL_NAMES.has(suffix) ? suffix : toolName;
}

function projectedToolIdentity(
  name: string | undefined,
  input: unknown,
): { name: string; input: unknown } {
  const normalizedName = normalizeProjectedToolName(name ?? "");
  if (
    normalizedName !== "call_native_tool" ||
    !input ||
    typeof input !== "object" ||
    Array.isArray(input)
  ) {
    return { name: normalizedName, input };
  }
  const wrapper = input as Record<string, unknown>;
  if (
    typeof wrapper.name !== "string" ||
    !wrapper.input ||
    typeof wrapper.input !== "object" ||
    Array.isArray(wrapper.input)
  ) {
    return { name: normalizedName, input };
  }
  const canonicalName = normalizeProjectedToolName(wrapper.name);
  if (getToolCapabilityMetadata(canonicalName)?.disclosure !== "eligible") {
    return { name: normalizedName, input };
  }
  return {
    name: canonicalName,
    input: wrapper.input,
  };
}

type QuestionAnswerItem = Extract<
  ContentBlock,
  { type: "question_answer" }
>["items"][number];

function getAskUserContextFromInput(input: unknown): string {
  if (!input || typeof input !== "object" || Array.isArray(input)) return "";
  const context = (input as Record<string, unknown>).context;
  return typeof context === "string" ? context.trim() : "";
}

function normalizeAskUserAnswer(answer: unknown): QuestionAnswerItem["answer"] {
  if (answer === null || answer === undefined) return null;
  if (
    typeof answer === "string" ||
    typeof answer === "number" ||
    typeof answer === "boolean"
  ) {
    return answer;
  }
  if (Array.isArray(answer)) {
    return answer.filter((value): value is string => typeof value === "string");
  }
  return null;
}

function parseAskUserQuestionAnswerItems(result: string): QuestionAnswerItem[] {
  const parsed = parseJsonObject(result);
  const responses = parsed?.responses;
  if (!Array.isArray(responses)) return [];

  return responses.flatMap((response): QuestionAnswerItem[] => {
    if (!response || typeof response !== "object") return [];
    const record = response as Record<string, unknown>;
    const question =
      typeof record.question === "string" ? record.question.trim() : "";
    if (!question) return [];
    const note = typeof record.note === "string" ? record.note.trim() : "";
    return [
      {
        question,
        answer: normalizeAskUserAnswer(record.answer),
        ...(note ? { note } : {}),
      },
    ];
  });
}

function addQuestionContextMessage(
  messages: ChatMessage[],
  questionId: string,
  context: string,
): ChatMessage[] {
  const trimmed = context.trim();
  if (!trimmed) return messages;

  const messageId = `question-context-${questionId}`;
  // The same context paragraph is rendered inline by transcript rehydration
  // (a text block pushed just before the ask_user tool_call). Skip synthesis
  // whenever any message already shows this exact text, not only when our own
  // synthesized message id exists — otherwise every resync of a session that
  // is awaiting a question duplicates the preamble.
  if (
    messages.some(
      (message) =>
        message.id === messageId ||
        message.blocks.some(
          (block) => block.type === "text" && block.text.trim() === trimmed,
        ),
    )
  ) {
    return messages;
  }

  return [
    ...messages,
    {
      id: messageId,
      role: "assistant" as const,
      content: "",
      timestamp: Date.now(),
      blocks: [{ type: "text" as const, text: trimmed }],
    },
  ];
}

type ProjectedBackgroundResult = Extract<
  ContentBlock,
  { type: "bg_agent_result" }
>;

type ParsedBackgroundToolResult =
  | { kind: "non_terminal" }
  | {
      kind: "terminal";
      status: ProjectedBackgroundResult["status"];
      resultState: BackgroundResultState;
      terminalReason?: string;
      resultText?: string;
      partialOutput?: string;
      retrySafe?: boolean;
      agentRetryable?: boolean;
    };

const TERMINAL_BACKGROUND_STATES = new Set<BackgroundResultState>([
  "completed",
  "incomplete_expected_result",
  "failed",
  "cancelled",
  "budget_exhausted",
  "interrupted",
  "authorization_lost",
]);

function coarseBackgroundStatus(
  resultState: BackgroundResultState,
): ProjectedBackgroundResult["status"] {
  if (resultState === "completed") return "completed";
  if (resultState === "cancelled") return "cancelled";
  return "error";
}

function parseBackgroundToolResult(
  resultText: string,
): ParsedBackgroundToolResult {
  const trimmed = resultText.trim();
  const normalized = trimmed.toLowerCase();
  if (normalized.startsWith("background agent stopped:")) {
    const resultState: BackgroundResultState = normalized.includes("cancel")
      ? "cancelled"
      : "failed";
    return {
      kind: "terminal",
      status: coarseBackgroundStatus(resultState),
      resultState,
      terminalReason: trimmed,
      partialOutput: trimmed,
    };
  }

  const parsed = parseJsonObject(trimmed);
  if (!parsed) {
    return {
      kind: "terminal",
      status: "completed",
      resultState: "completed",
      resultText: resultText || undefined,
    };
  }
  if (
    parsed.done === false ||
    parsed.status === "continued-in-background" ||
    parsed.status === "wait_interrupted"
  ) {
    return { kind: "non_terminal" };
  }

  const status = parsed.status;
  if (
    typeof status !== "string" ||
    !TERMINAL_BACKGROUND_STATES.has(status as BackgroundResultState)
  ) {
    return {
      kind: "terminal",
      status: "completed",
      resultState: "completed",
      resultText: resultText || undefined,
    };
  }

  const terminalReason = parsed.terminalReason;
  const retrySafe = parsed.retrySafe;
  const agentRetryable = parsed.agentRetryable;
  const partialOutput = parsed.partialOutput;
  const valid =
    (terminalReason === undefined || typeof terminalReason === "string") &&
    (retrySafe === undefined || typeof retrySafe === "boolean") &&
    (agentRetryable === undefined || typeof agentRetryable === "boolean") &&
    (partialOutput === undefined || typeof partialOutput === "string") &&
    (parsed.done === undefined || parsed.done === true);
  const resultState: BackgroundResultState = valid
    ? (status as BackgroundResultState)
    : "failed";
  return {
    kind: "terminal",
    status: coarseBackgroundStatus(resultState),
    resultState,
    terminalReason: valid
      ? (terminalReason as string | undefined)
      : "Malformed background result metadata",
    partialOutput: valid
      ? (partialOutput as string | undefined)
      : "The background result could not be classified safely. See the tool details for the exact output.",
    retrySafe: valid ? (retrySafe as boolean | undefined) : false,
    agentRetryable: valid ? (agentRetryable as boolean | undefined) : false,
  };
}

function getBgSessionIdFromToolInput(
  input: unknown,
  fallbackInputJson?: string,
): string | undefined {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const sessionId = (input as Record<string, unknown>).sessionId;
    if (typeof sessionId === "string" && sessionId) return sessionId;
  }

  if (!fallbackInputJson) return undefined;
  const parsed = parseJsonObject(fallbackInputJson);
  const sessionId = parsed?.sessionId;
  return typeof sessionId === "string" && sessionId ? sessionId : undefined;
}

function findBgTaskForSession(
  messages: ChatMessage[],
  currentBlocks: ContentBlock[],
  sessionId: string,
): string {
  for (let i = currentBlocks.length - 1; i >= 0; i--) {
    const candidate = currentBlocks[i];
    if (candidate.type === "bg_agent" && candidate.sessionId === sessionId) {
      return candidate.task;
    }
  }

  for (let msgIdx = messages.length - 1; msgIdx >= 0; msgIdx--) {
    const prior = messages[msgIdx];
    if (prior.role !== "assistant") continue;
    for (let blockIdx = prior.blocks.length - 1; blockIdx >= 0; blockIdx--) {
      const candidate = prior.blocks[blockIdx];
      if (candidate.type === "bg_agent" && candidate.sessionId === sessionId) {
        return candidate.task;
      }
    }
  }

  return "Background Agent";
}

export interface LoadedInstructionDebugInfo {
  source: string;
  chars: number;
  promptChars?: number;
  kind?: "instruction" | "rule";
  deferred?: boolean;
  hasFrontmatter?: boolean;
  alwaysApply?: boolean;
  loadPath?: string;
  summary?: string;
  globs?: string[];
}

export interface AppState {
  messages: ChatMessage[];
  /** Original visible user prompt, kept independent of transcript pagination. */
  originalPrompt: string | null;
  chatState: ChatState;
  streaming: boolean;
  thinkingEnabled: boolean;
  lastInputTokens: number;
  lastOutputTokens: number;
  lastCacheReadTokens: number;
  debugInfo: Record<string, string | number> | null;
  systemPrompt: string | null;
  /** Running token estimate from the engine — updated between API calls. */
  estimatedTotalUsed: number;
  contextHealth: ContextHealthSnapshot | null;
  loadedInstructions: LoadedInstructionDebugInfo[] | null;
  todos: TodoItem[];
  modes: ModeInfo[];
  availableModels: WebviewModelInfo[];
  slashCommands: SlashCommandInfo[];
  messageQueue: Array<{
    id: string;
    text: string;
    fullText?: string;
    isSlashCommand?: boolean;
    slashCommandLabel?: string;
    attachments?: string[];
    images?: RawImageMedia[];
    documents?: RawDocumentMedia[];
    displayMedia?: DisplayMedia;
    source?: "vscode" | "browser";
    interjectionReady?: boolean;
  }>;
  approvalRequest: ApprovalRequest | null;
  questionRequest: {
    id: string;
    /** Correlates the UI request with the provider's ask_user tool call. */
    toolCallId?: string;
    /** Visible explanation shown above structured questions. */
    context: string;
    questions: Question[];
    /** When set, the question is from a background agent with this task name. */
    backgroundTask?: string;
  } | null;
  detectedQuestion: (DetectedQuestion & { messageId: string }) | null;
  dismissedDetectedQuestionIds: string[];
  /** Temporary status override shown in the streaming spinner (e.g. "Refreshing credentials…") */
  statusOverride: string | null;
  restoringSession: boolean;
  revertRecoveryNotice: RevertRecoveryNotice | null;
  /** Number of visible user turns before the first rendered message in `messages`. */
  loadedUserTurnOffset: number;
  /** Checkpoints that arrived before their target user message row was present. */
  pendingCheckpoints: Array<{ turnIndex: number; checkpointId: string }>;
  /** Explicit final marker intent recorded by set_task_status for the current turn. */
  pendingFinalMarker: FinalMessageMarker | null;
}

export type AppAction =
  | { type: "RESTORE_PROJECTION"; state: AppState }
  | { type: "SET_STATE"; state: ChatState }
  | {
      type: "SET_SESSIONLESS_SELECTIONS";
      selections: Partial<
        Pick<
          ChatState,
          | "mode"
          | "model"
          | "reasoningEffort"
          | "thinkingEnabled"
          | "agentWriteApproval"
          | "commandApprovalPolicy"
        >
      >;
    }
  | {
      type: "SET_DEBUG_INFO";
      info: Record<string, string | number>;
      systemPrompt?: string;
      loadedInstructions?: LoadedInstructionDebugInfo[];
    }
  | {
      type: "ADD_USER_MESSAGE";
      text: string;
      id?: string;
      isSlashCommand?: boolean;
      slashCommandLabel?: string;
      displayMedia?: DisplayMedia;
    }
  | {
      type: "ADD_COMMITTED_USER_MESSAGE";
      text: string;
      id?: string;
      isSlashCommand?: boolean;
      slashCommandLabel?: string;
      origin?: "vscode" | "browser";
      displayMedia?: DisplayMedia;
    }
  | { type: "THINKING_START"; thinkingId: string }
  | { type: "THINKING_DELTA"; thinkingId: string; text: string }
  | { type: "THINKING_END"; thinkingId: string }
  | { type: "TEXT_DELTA"; text: string }
  | {
      type: "ADD_SURFACE_CHANGE";
      change: NonNullable<ChatMessage["surfaceChange"]>;
    }
  | {
      type: "API_REQUEST";
      requestId: string;
      model: string;
      reasoningEffort: ReasoningEffort;
      mode?: string;
      commandApprovalPolicy?: CommandApprovalPolicy;
      inputTokens: number;
      uncachedInputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens?: number;
      usageEstimated?: boolean;
      durationMs: number;
      timeToFirstToken: number;
      usedPreviousResponseId?: boolean;
      previousResponseIdFallback?: boolean;
      promptCacheKey?: string;
      promptCacheRetention?: "in_memory" | "24h";
      storeResponseState?: boolean;
      providerResponseId?: string;
      contextBreakdown?: RequestContextBreakdown;
    }
  | {
      type: "TOOL_START";
      toolCallId: string;
      toolName: string;
      parentCallId?: string;
      input?: unknown;
    }
  | { type: "TOOL_INPUT_DELTA"; toolCallId: string; partialJson: string }
  | {
      type: "TOOL_COMPLETE";
      toolCallId: string;
      toolName: string;
      result: string;
      resultImages?: Array<{ mimeType: string; data: string }>;
      resultDocuments?: Array<{
        name: string;
        mimeType: string;
        data: string;
      }>;
      durationMs: number;
      input?: unknown;
      parentCallId?: string;
      mcpApprovalPromotion?: McpApprovalPromotionMeta;
      composeTrace?: ComposeTrace;
    }
  | { type: "TODO_UPDATE"; todos: TodoItem[] }
  | { type: "ADD_ANNOTATION"; text: string; badge: "follow-up" | "rejection" }
  | {
      type: "ERROR";
      error: string;
      retryable: boolean;
      code?: string;
      actions?: {
        signIn?: boolean;
        signInAnotherAccount?: boolean;
        condense?: boolean;
      };
    }
  | { type: "SET_FINAL_MARKER"; marker: FinalMessageMarker | null }
  | { type: "CLEAR_FINAL_MARKER_CONTINUE_ACTIONS" }
  | { type: "MARK_AUTO_CONTINUE_STOPPED"; messageId: string; reason: string }
  | { type: "CLEAR_INTERACTION_PROMPTS" }
  | { type: "DONE" }
  | { type: "NEW_SESSION" }
  | { type: "SET_REASONING_EFFORT"; effort: ReasoningEffort }
  | { type: "TOGGLE_THINKING" }
  | { type: "SET_MODES"; modes: ModeInfo[] }
  | { type: "SET_MODELS"; models: WebviewModelInfo[] }
  | { type: "SET_SLASH_COMMANDS"; commands: SlashCommandInfo[] }
  | {
      type: "ENQUEUE_MESSAGE";
      id: string;
      text: string;
      fullText?: string;
      isSlashCommand?: boolean;
      slashCommandLabel?: string;
      attachments?: string[];
      images?: RawImageMedia[];
      documents?: RawDocumentMedia[];
      displayMedia?: DisplayMedia;
      source?: "vscode" | "browser";
    }
  | { type: "EDIT_QUEUE_MESSAGE"; id: string; text: string }
  | { type: "MARK_QUEUE_INTERJECTION_READY"; id: string; ready: boolean }
  | { type: "REMOVE_FROM_QUEUE"; id: string }
  | { type: "CLEAR_QUEUE" }
  | {
      type: "ADD_INTERJECTION";
      text: string;
      isSlashCommand?: boolean;
      slashCommandLabel?: string;
      displayMedia?: DisplayMedia;
    }
  | { type: "SET_APPROVAL"; request: ApprovalRequest }
  | { type: "CLEAR_APPROVAL"; id: string }
  | {
      type: "SET_QUESTION";
      id: string;
      toolCallId?: string;
      context: string;
      questions: Question[];
      backgroundTask?: string;
    }
  | {
      type: "SUBMIT_QUESTION";
      id: string;
      answers: Record<string, string | string[] | number | boolean | undefined>;
      notes: Record<string, string>;
    }
  | { type: "CLEAR_QUESTION"; id?: string }
  | {
      type: "SET_DETECTED_QUESTION";
      detectedQuestion: (DetectedQuestion & { messageId: string }) | null;
    }
  | { type: "DISMISS_DETECTED_QUESTION"; messageId: string }
  | {
      type: "ADD_CONDENSE";
      prevInputTokens: number;
      newInputTokens: number;
      durationMs: number;
      validationWarnings?: string[];
    }
  | {
      type: "ADD_CONDENSE_ERROR";
      errorMessage: string;
      retryable?: boolean;
      code?: string;
      actions?: {
        signIn?: boolean;
        signInAnotherAccount?: boolean;
        condense?: boolean;
      };
    }
  | {
      type: "ADD_WARNING";
      message: string;
      retryDelayMs?: number;
      retryAt?: number;
      retryAttempt?: number;
      retryMaxAttempts?: number;
    }
  | {
      type: "ADD_PAIRING_CODE";
      pairingId: string;
      code: string;
      expiresAt: number;
      pairingUrls: string[];
    }
  | {
      type: "UPDATE_PAIRING_STATUS";
      pairingId: string;
      status: "pending" | "consumed" | "expired" | "cancelled";
      deviceLabel?: string;
    }
  | { type: "SET_STATUS_OVERRIDE"; message: string | null }
  | { type: "SET_RESTORING_SESSION"; restoring: boolean }
  | {
      type: "LOAD_SESSION";
      sessionId: string;
      title: string;
      originalPrompt?: string;
      mode: string;
      model: string;
      messages: ChatMessage[];
      todos: TodoItem[];
      lastInputTokens?: number;
      lastOutputTokens?: number;
      /** Durable child results reconciled against any tool-derived message state. */
      backgroundResults?: BackgroundCompletionResult[];
      /**
       * Checkpoints are keyed by user-turn count at snapshot time.
       * `turnIndex=1` maps to the first user message row, `2` to the second, etc.
       */
      checkpoints?: Array<{ turnIndex: number; checkpointId: string }>;
      userTurnOffset?: number;
      hasMoreBefore?: boolean;
      /**
       * Live tail: blocks of the model response currently streaming, which is
       * not yet part of the persisted transcript. Included so a hydration can
       * never regress content the user is watching stream.
       */
      inFlight?: InFlightAssistantBlock[];
      /**
       * Whether the session's turn is still running. A hydration of an active
       * session must not force the projection out of streaming mode, or
       * subsequent deltas get dropped and the text visibly re-streams.
       */
      streaming?: boolean;
    }
  | {
      type: "PREPEND_SESSION_CHUNK";
      messages: ChatMessage[];
      userTurnOffset: number;
      hasMoreBefore: boolean;
      /** Same turnIndex semantics as LOAD_SESSION.checkpoints. */
      checkpoints?: Array<{ turnIndex: number; checkpointId: string }>;
    }
  | {
      type: "SET_CHECKPOINT";
      checkpointId: string;
      /** Same turnIndex semantics as LOAD_SESSION.checkpoints. */
      turnIndex: number;
    }
  | { type: "CONDENSE_START" }
  | { type: "CLEAR_ERROR" }
  | {
      type: "BG_AGENT_DONE";
      completion: BackgroundCompletionResult;
    }
  | { type: "TOKEN_ESTIMATE"; estimatedTotalUsed: number };

/**
 * Convert persisted AgentMessage[] (Anthropic API format) to ChatMessage[] (webview display format).
 * Tool-result user messages are filtered out as they're internal plumbing.
 * Condense summary messages are rendered as condense rows.
 */
export function agentMessagesToChatMessages(
  raw: unknown[],
  opts?: {
    /**
     * Absolute index of `raw[0]` within the full persisted transcript. When
     * provided, rehydrated messages get deterministic ids (`t<absoluteIndex>`)
     * so repeated hydrations of the same content keep stable identity —
     * stable React keys, no remount churn, and cross-hydration reconciliation.
     * Without it every projection regenerates random ids.
     */
    baseIndex?: number;
  },
): ChatMessage[] {
  const baseIndex = opts?.baseIndex;
  const rehydratedMessageId = (rawIndex: number): string =>
    baseIndex === undefined ? randomId() : `t${baseIndex + rawIndex}`;
  const stripSystemReminderBlocks = (text: string): string =>
    text
      .replace(/<system-reminder>[\s\S]*?<\/system-reminder>\n*/gi, "")
      .trim();

  // First pass: collect tool results keyed by tool_use_id
  const toolResults = new Map<string, string>();
  const toolResultImages = new Map<
    string,
    Array<{ mimeType: string; data: string }>
  >();
  const toolResultDocuments = new Map<
    string,
    Array<{ name: string; mimeType: string; data: string }>
  >();
  const toolResultUiMeta = new Map<
    string,
    {
      mcpApprovalPromotion?: McpApprovalPromotionMeta;
      composeTrace?: ComposeTrace;
    }
  >();
  for (const msg of raw) {
    const m = msg as { role: string; content: unknown };
    if (m.role === "user" && Array.isArray(m.content)) {
      for (const block of m.content as Array<{
        type: string;
        tool_use_id?: string;
        content?: unknown;
        mcpApprovalPromotion?: McpApprovalPromotionMeta;
        composeTrace?: ComposeTrace;
      }>) {
        if (block.type === "tool_result" && block.tool_use_id) {
          const content = block.content;
          const text = Array.isArray(content)
            ? (content as Array<{ type: string; text?: string }>)
                .filter((c) => c.type === "text")
                .map((c) => c.text ?? "")
                .join("\n")
            : typeof content === "string"
              ? content
              : "";
          toolResults.set(block.tool_use_id, text);
          if (Array.isArray(content)) {
            const media = content as Array<{
              type: string;
              data?: string;
              mimeType?: string;
              name?: string;
              title?: string;
              source?: { data?: string; media_type?: string };
            }>;
            const images = media.flatMap((item) => {
              if (item.type !== "image") return [];
              const data = item.data ?? item.source?.data;
              const mimeType = item.mimeType ?? item.source?.media_type;
              return data && mimeType ? [{ data, mimeType }] : [];
            });
            if (images.length > 0) {
              toolResultImages.set(block.tool_use_id, images);
            }
            const documents = media.flatMap((item) => {
              if (item.type !== "document") return [];
              const data = item.data ?? item.source?.data;
              const mimeType = item.mimeType ?? item.source?.media_type;
              const name = item.name ?? item.title ?? "document";
              return data && mimeType ? [{ name, data, mimeType }] : [];
            });
            if (documents.length > 0) {
              toolResultDocuments.set(block.tool_use_id, documents);
            }
          }
          if (block.mcpApprovalPromotion || block.composeTrace) {
            toolResultUiMeta.set(block.tool_use_id, {
              mcpApprovalPromotion: block.mcpApprovalPromotion,
              composeTrace: block.composeTrace,
            });
          }
        }
      }
    }
  }

  // Second pass: build ChatMessages
  const result: ChatMessage[] = [];
  for (let rawIndex = 0; rawIndex < raw.length; rawIndex++) {
    const msg = raw[rawIndex];
    const m = msg as {
      role: string;
      content: unknown;
      media?: {
        images?: RawImageMedia[];
        documents?: RawDocumentMedia[];
      };
      isSummary?: boolean;
      uiHint?: {
        userMessage?: {
          displayText?: string;
          isSlashCommand?: boolean;
          slashCommandLabel?: string;
          origin?: "vscode" | "browser";
        };
        condense?: {
          prevInputTokens?: number;
          newInputTokens?: number;
          durationMs?: number;
          validationWarnings?: string[];
          errorMessage?: string;
          condensing?: boolean;
        };
        surfaceChange?: ChatMessage["surfaceChange"];
        finalMarker?: FinalMessageMarker;
      };
      runtimeError?: {
        message: string;
        retryable: boolean;
        code?: string;
        actions?: {
          signIn?: boolean;
          signInAnotherAccount?: boolean;
          condense?: boolean;
        };
      };
    };
    if (m.isSummary) {
      const hint = m.uiHint?.condense;
      result.push({
        id: rehydratedMessageId(rawIndex),
        role: "condense",
        content: "",
        timestamp: Date.now(),
        blocks: [],
        condenseInfo: {
          prevInputTokens: hint?.prevInputTokens ?? 0,
          newInputTokens: hint?.newInputTokens ?? 0,
          durationMs: hint?.durationMs,
          validationWarnings: hint?.validationWarnings,
          errorMessage: hint?.errorMessage,
          condensing: hint?.condensing,
        },
      });
      continue;
    }

    if (m.role === "user") {
      if (typeof m.content === "string") {
        const hint = m.uiHint?.userMessage;
        result.push({
          id: rehydratedMessageId(rawIndex),
          role: "user",
          content: hint?.displayText ?? m.content,
          timestamp: Date.now(),
          blocks: [],
          isSlashCommand: hint?.isSlashCommand,
          slashCommandLabel:
            hint?.slashCommandLabel ??
            (hint?.isSlashCommand ? hint.displayText : undefined),
          origin: hint?.origin,
          displayMedia: mediaToDisplayMedia(m.media),
        });
      }
      // Skip tool_result arrays — they're internal and shouldn't be displayed
    } else if (m.role === "assistant") {
      const blocks: ContentBlock[] = [];
      const contentArr = Array.isArray(m.content) ? m.content : [];
      const finalMarker = attachFinalMarkerToolCall(
        m.uiHint?.finalMarker,
        contentArr,
        toolResults,
      );
      const finalMarkerToolId = finalMarker?.toolCall?.id;
      const messageGeneratedImages: Array<{ mimeType: string; data: string }> =
        [];
      const messagePresentedImages: Array<{ mimeType: string; data: string }> =
        [];
      const messageDirectImages: Array<{ mimeType: string; data: string }> = [];
      for (const block of contentArr as Array<{
        type: string;
        text?: string;
        citations?: CoreWebCitation[];
        activity?: CoreWebActivity;
        id?: string;
        name?: string;
        input?: unknown;
        thinking?: string;
        source?: {
          type?: string;
          media_type?: string;
          data?: string;
        };
      }>) {
        if (block.type === "text" && block.text) {
          if (block.text.includes("<system-reminder>")) {
            const sanitized = stripSystemReminderBlocks(block.text);
            if (sanitized) {
              blocks.push({ type: "text", text: sanitized });
            }
          } else {
            blocks.push({ type: "text", text: block.text });
          }
          const citations = sanitizeWebCitations(block.citations ?? []);
          if (citations.length > 0) {
            for (let index = blocks.length - 1; index >= 0; index -= 1) {
              const candidate = blocks[index];
              if (
                candidate?.type !== "tool_call" ||
                (candidate.name !== "web_search" &&
                  candidate.name !== "web_fetch")
              ) {
                continue;
              }
              const result = parseJsonObject(candidate.result) ?? {};
              blocks[index] = {
                ...candidate,
                result: JSON.stringify({ ...result, citations }, null, 2),
              };
              break;
            }
          }
        } else if (block.type === "web_activity" && block.activity) {
          const activity = sanitizeWebActivity(block.activity);
          const input =
            activity.kind === "search"
              ? { query: activity.query ?? "" }
              : { url: activity.url ?? "" };
          blocks.push({
            type: "tool_call",
            id: activity.id,
            name: activity.kind === "search" ? "web_search" : "web_fetch",
            inputJson: JSON.stringify(input),
            result:
              activity.status === "started"
                ? ""
                : JSON.stringify(activity, null, 2),
            complete: activity.status !== "started",
          });
        } else if (block.type === "thinking" && block.thinking?.trim()) {
          blocks.push({
            type: "thinking",
            id: block.id ?? randomId(),
            text: block.thinking,
            complete: true,
          });
        } else if (
          block.type === "image" &&
          block.source?.type === "base64" &&
          typeof block.source.media_type === "string" &&
          typeof block.source.data === "string"
        ) {
          messageDirectImages.push({
            mimeType: block.source.media_type,
            data: block.source.data,
          });
        } else if (block.type === "tool_use") {
          const toolId = block.id ?? randomId();
          const projectedTool = projectedToolIdentity(block.name, block.input);
          const toolName = projectedTool.name;
          const toolInput = projectedTool.input;
          const toolResult = toolResults.get(toolId) ?? "";
          const resultImages = toolResultImages.get(toolId);
          const resultDocuments = toolResultDocuments.get(toolId);
          if (toolName === "generate_image" && resultImages) {
            messageGeneratedImages.push(...resultImages);
          } else if (toolName === "present_images" && resultImages) {
            messagePresentedImages.push(...resultImages);
          }
          const resultImageProps = resultImages ? { resultImages } : {};
          const resultDocumentProps = resultDocuments
            ? { resultDocuments }
            : {};
          const inputJson = JSON.stringify(toolInput ?? {});
          if (toolName === "set_task_status" && toolId === finalMarkerToolId) {
            continue;
          }
          const askUserContext =
            toolName === "ask_user"
              ? getAskUserContextFromInput(toolInput)
              : "";
          if (askUserContext) {
            blocks.push({ type: "text", text: askUserContext });
          }

          if (toolName === "ask_user") {
            blocks.push({
              type: "tool_call",
              id: toolId,
              name: toolName,
              inputJson,
              result: toolResult,
              ...resultImageProps,
              ...resultDocumentProps,
              complete: true,
              mcpApprovalPromotion:
                toolResultUiMeta.get(toolId)?.mcpApprovalPromotion,
            });
            const items = parseAskUserQuestionAnswerItems(toolResult);
            if (items.length > 0) {
              blocks.push({
                type: "question_answer",
                toolCallId: toolId,
                items,
              });
            }
          } else if (toolName === "load_skill") {
            const parsed = parseLoadSkillResult(toolResult);
            blocks.push({
              type: "skill_load",
              id: toolId,
              inputJson,
              result: toolResult,
              complete: true,
              skillName: parsed.skillName,
              path: parsed.path,
              content: parsed.content,
            });
          } else if (toolName === "spawn_background_agent") {
            const parsedResult = parseJsonObject(toolResult);
            const parsedInput =
              block.input &&
              typeof block.input === "object" &&
              !Array.isArray(block.input)
                ? (block.input as Record<string, unknown>)
                : null;
            const sessionId =
              typeof parsedResult?.sessionId === "string"
                ? parsedResult.sessionId
                : undefined;
            const task =
              typeof parsedInput?.task === "string" && parsedInput.task
                ? parsedInput.task
                : "Background Agent";
            const message =
              typeof parsedInput?.message === "string" && parsedInput.message
                ? parsedInput.message
                : undefined;

            blocks.push({
              type: "tool_call",
              id: toolId,
              name: toolName,
              inputJson,
              result: toolResult,
              ...resultImageProps,
              ...resultDocumentProps,
              complete: true,
              mcpApprovalPromotion:
                toolResultUiMeta.get(toolId)?.mcpApprovalPromotion,
            });

            if (sessionId) {
              blocks.push({
                type: "bg_agent",
                sessionId,
                task,
                message,
                resolvedModel:
                  typeof parsedResult?.resolvedModel === "string"
                    ? parsedResult.resolvedModel
                    : undefined,
                resolvedProvider:
                  typeof parsedResult?.resolvedProvider === "string"
                    ? parsedResult.resolvedProvider
                    : undefined,
                reasoningEffort: isCoreReasoningEffort(
                  parsedResult?.reasoningEffort,
                )
                  ? parsedResult.reasoningEffort
                  : undefined,
                resolvedMode:
                  typeof parsedResult?.resolvedMode === "string"
                    ? parsedResult.resolvedMode
                    : undefined,
                taskClass:
                  typeof parsedResult?.taskClass === "string"
                    ? parsedResult.taskClass
                    : undefined,
                routingReason:
                  typeof parsedResult?.routingReason === "string"
                    ? parsedResult.routingReason
                    : undefined,
              });
            }
          } else if (toolName === "get_background_result") {
            const parsedInput =
              block.input &&
              typeof block.input === "object" &&
              !Array.isArray(block.input)
                ? (block.input as Record<string, unknown>)
                : null;
            const sessionId =
              typeof parsedInput?.sessionId === "string"
                ? parsedInput.sessionId
                : undefined;

            blocks.push({
              type: "tool_call",
              id: toolId,
              name: toolName,
              inputJson,
              result: toolResult,
              ...resultImageProps,
              ...resultDocumentProps,
              complete: true,
              mcpApprovalPromotion:
                toolResultUiMeta.get(toolId)?.mcpApprovalPromotion,
            });

            const parsedBackgroundResult =
              parseBackgroundToolResult(toolResult);
            if (sessionId && parsedBackgroundResult.kind === "terminal") {
              let task = "Background Agent";
              for (let i = blocks.length - 1; i >= 0; i--) {
                const candidate = blocks[i];
                if (
                  candidate.type === "bg_agent" &&
                  candidate.sessionId === sessionId
                ) {
                  task = candidate.task;
                  break;
                }
              }
              if (task === "Background Agent") {
                for (let msgIdx = result.length - 1; msgIdx >= 0; msgIdx--) {
                  const prior = result[msgIdx];
                  if (prior.role !== "assistant") continue;
                  for (
                    let blockIdx = prior.blocks.length - 1;
                    blockIdx >= 0;
                    blockIdx--
                  ) {
                    const candidate = prior.blocks[blockIdx];
                    if (
                      candidate.type === "bg_agent" &&
                      candidate.sessionId === sessionId
                    ) {
                      task = candidate.task;
                      break;
                    }
                  }
                  if (task !== "Background Agent") break;
                }
              }
              blocks.push({
                type: "bg_agent_result",
                sessionId,
                task,
                status: parsedBackgroundResult.status,
                resultState: parsedBackgroundResult.resultState,
                terminalReason: parsedBackgroundResult.terminalReason,
                resultText: parsedBackgroundResult.resultText,
                partialOutput: parsedBackgroundResult.partialOutput,
                summary: undefined,
                retrySafe: parsedBackgroundResult.retrySafe,
                agentRetryable: parsedBackgroundResult.agentRetryable,
                sourceAuthority: "tool",
              });
            }
          } else {
            blocks.push({
              type: "tool_call",
              id: toolId,
              name: toolName,
              inputJson,
              result: toolResult,
              ...resultImageProps,
              ...resultDocumentProps,
              complete: true,
              mcpApprovalPromotion:
                toolResultUiMeta.get(toolId)?.mcpApprovalPromotion,
              composeTrace: toolResultUiMeta.get(toolId)?.composeTrace,
            });
          }
        }
      }
      const hasRuntimeError = Boolean(m.runtimeError?.message);
      const runtimeErrorMessage = m.runtimeError?.message?.trim();
      const visibleBlocks =
        hasRuntimeError && runtimeErrorMessage
          ? blocks.filter(
              (block) =>
                !(
                  block.type === "text" &&
                  block.text.trim() === runtimeErrorMessage
                ),
            )
          : blocks;
      const generatedDisplayImages = [
        ...messageDirectImages,
        ...messageGeneratedImages,
      ];
      if (
        visibleBlocks.length > 0 ||
        generatedDisplayImages.length > 0 ||
        messagePresentedImages.length > 0 ||
        hasRuntimeError ||
        m.uiHint?.surfaceChange ||
        finalMarker
      ) {
        const generatedDisplayMedia = resultImagesToDisplayMedia(
          generatedDisplayImages,
        );
        const presentedDisplayMedia = resultImagesToDisplayMedia(
          messagePresentedImages,
          generatedDisplayMedia?.images.length ?? 0,
          "presented-image",
        );
        const displayImages = [
          ...(generatedDisplayMedia?.images ?? []),
          ...(presentedDisplayMedia?.images ?? []),
        ];
        result.push({
          id: rehydratedMessageId(rawIndex),
          role: "assistant",
          content: "",
          timestamp: Date.now(),
          blocks: visibleBlocks,
          ...(displayImages.length > 0
            ? { displayMedia: { images: displayImages, documents: [] } }
            : {}),
          finalMarker,
          surfaceChange: m.uiHint?.surfaceChange,
          ...(hasRuntimeError
            ? {
                error: {
                  message: m.runtimeError!.message,
                  retryable: m.runtimeError!.retryable,
                  code: m.runtimeError!.code,
                  actions: m.runtimeError!.actions,
                },
              }
            : {}),
        });
      }
    }
  }
  return result;
}

/** Ensure the last message is an assistant message with blocks. */
function ensureAssistant(messages: ChatMessage[]): ChatMessage[] {
  const last = messages[messages.length - 1];
  if (last?.role === "assistant") return messages;
  return [
    ...messages,
    {
      id: randomId(),
      role: "assistant",
      content: "",
      timestamp: Date.now(),
      blocks: [],
    },
  ];
}

/** Get the last block of a given type, or null. */
function lastBlock(blocks: ContentBlock[], type: string) {
  const last = blocks[blocks.length - 1];
  return last?.type === type ? last : null;
}

/** Clone messages array with cloned last message. */
function cloneLast(messages: ChatMessage[]): {
  msgs: ChatMessage[];
  last: ChatMessage;
} {
  const msgs = [...messages];
  const last = {
    ...msgs[msgs.length - 1],
    blocks: [...msgs[msgs.length - 1].blocks],
  };
  msgs[msgs.length - 1] = last;
  return { msgs, last };
}

/**
 * Blocks at the tail of an assistant message that are still "live": running
 * tools, open thinking, or (while streaming) text that may still receive
 * deltas. A bg_agent_result arriving mid-turn is inserted before these so the
 * active end of the transcript stays last instead of a completed card landing
 * below the live indicator and making the turn look stalled.
 */
function isActiveTailBlock(block: ContentBlock, streaming: boolean): boolean {
  if (
    (block.type === "tool_call" ||
      block.type === "skill_load" ||
      block.type === "thinking") &&
    !block.complete
  ) {
    return true;
  }
  return streaming && block.type === "text";
}

function isEmptyAssistantShell(message: ChatMessage): boolean {
  if (
    message.role !== "assistant" ||
    message.blocks.length > 0 ||
    message.content.length > 0
  ) {
    return false;
  }
  const structuralKeys = new Set([
    "id",
    "role",
    "content",
    "timestamp",
    "blocks",
  ]);
  return Object.entries(message).every(
    ([key, value]) => structuralKeys.has(key) || value === undefined,
  );
}

function attachFinalMarkerToolCall(
  marker: FinalMessageMarker | undefined | null,
  contentArr: Array<{
    type: string;
    id?: string;
    name?: string;
    input?: unknown;
  }>,
  toolResults: Map<string, string>,
): FinalMessageMarker | undefined {
  if (!marker || marker.toolCall) return marker ?? undefined;
  const finalTool = [...contentArr]
    .reverse()
    .find(
      (block) => block.type === "tool_use" && block.name === "set_task_status",
    );
  if (!finalTool?.id) return marker;
  return {
    ...marker,
    toolCall: {
      id: finalTool.id,
      name: "set_task_status",
      inputJson: JSON.stringify(finalTool.input ?? {}),
      result: toolResults.get(finalTool.id),
    },
  };
}

function applyFinalMarkerToLatestAssistant(
  messages: ChatMessage[],
  marker: FinalMessageMarker,
): ChatMessage[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "assistant") continue;
    const next = [...messages];
    next[i] = { ...message, finalMarker: marker };
    return next;
  }
  return messages;
}

function normalizeAssistantBlocks(blocks: ContentBlock[]): ContentBlock[] {
  return blocks.filter(
    (block) => block.type !== "thinking" || block.text.trim().length > 0,
  );
}

function completeIncompleteRuntimeBlocks(
  messages: ChatMessage[],
): ChatMessage[] {
  return messages.map((m) => {
    const hasIncomplete = m.blocks.some(
      (b) =>
        ((b.type === "tool_call" || b.type === "skill_load") && !b.complete) ||
        (b.type === "thinking" && !b.complete),
    );
    if (!hasIncomplete) {
      const normalized = normalizeAssistantBlocks(m.blocks);
      return normalized.length === m.blocks.length
        ? m
        : { ...m, blocks: normalized };
    }
    return {
      ...m,
      blocks: normalizeAssistantBlocks(
        m.blocks.map((b) => {
          if (
            (b.type === "tool_call" || b.type === "skill_load") &&
            !b.complete
          ) {
            return {
              ...b,
              complete: true,
              result: b.result || '{"status":"stopped"}',
            };
          }
          if (b.type === "thinking" && !b.complete) {
            return { ...b, complete: true };
          }
          return b;
        }),
      ),
    };
  });
}

function clearFinalMarkerContinueActions(
  messages: ChatMessage[],
): ChatMessage[] {
  let changed = false;
  const next = messages.map((message) => {
    if (
      message.role !== "assistant" ||
      !message.finalMarker ||
      !getFinalMessageContinueAction(message.finalMarker)
    ) {
      return message;
    }
    changed = true;
    const { continueAction: _continueAction, ...finalMarker } =
      message.finalMarker;
    return {
      ...message,
      finalMarker: { ...finalMarker, continueActionConsumed: true },
    };
  });
  return changed ? next : messages;
}

function markAutoContinueStopped(
  messages: ChatMessage[],
  messageId: string,
  reason: string,
): ChatMessage[] {
  let changed = false;
  const next = messages.map((message) => {
    if (
      message.id !== messageId ||
      message.role !== "assistant" ||
      !message.finalMarker ||
      message.finalMarker.autoContinueStopReason === reason
    ) {
      return message;
    }
    changed = true;
    return {
      ...message,
      finalMarker: {
        ...message.finalMarker,
        autoContinueStopReason: reason,
      },
    };
  });
  return changed ? next : messages;
}

function applyCheckpointToMessages(
  messages: ChatMessage[],
  checkpoint: { turnIndex: number; checkpointId: string },
  userTurnOffset: number,
): { messages: ChatMessage[]; applied: boolean } {
  const targetUserIndex = checkpoint.turnIndex - 1 - userTurnOffset;
  if (targetUserIndex < 0) {
    return { messages, applied: false };
  }

  let userCount = 0;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role !== "user") continue;

    if (userCount === targetUserIndex) {
      const next = [...messages];
      next[i] = { ...next[i], checkpointId: checkpoint.checkpointId };
      return { messages: next, applied: true };
    }

    userCount++;
  }

  return { messages, applied: false };
}

function applyCheckpoints(
  messages: ChatMessage[],
  checkpoints: Array<{ turnIndex: number; checkpointId: string }> | undefined,
  userTurnOffset: number,
): {
  messages: ChatMessage[];
  pending: Array<{ turnIndex: number; checkpointId: string }>;
} {
  if (!checkpoints || checkpoints.length === 0) {
    return { messages, pending: [] };
  }

  let nextMessages = messages;
  const pending: Array<{ turnIndex: number; checkpointId: string }> = [];

  for (const checkpoint of checkpoints) {
    const applied = applyCheckpointToMessages(
      nextMessages,
      checkpoint,
      userTurnOffset,
    );
    nextMessages = applied.messages;
    if (!applied.applied) {
      pending.push(checkpoint);
    }
  }

  return { messages: nextMessages, pending };
}

export function shouldAcceptSessionChunk(
  chunkSessionId: string,
  currentSessionId: string | null,
  loadingSessionId: string | null,
): boolean {
  const targetSessionId = loadingSessionId ?? currentSessionId;
  return chunkSessionId === targetSessionId;
}

export function shouldProjectBackgroundCompletion(
  parentSessionId: string | null | undefined,
  transcriptSessionId: string | null,
): boolean {
  return (
    parentSessionId === undefined || parentSessionId === transcriptSessionId
  );
}

export function shouldDropSessionScopedEvent(
  eventType: string,
  eventSessionId: string | undefined,
  currentSessionId: string | null,
  isBackgroundEvent: boolean,
): boolean {
  if (!eventSessionId) return false;
  if (
    eventType === "agentSessionLoaded" ||
    eventType === "agentSessionChunk" ||
    eventType === "showBgTranscript"
  ) {
    return false;
  }
  if (isBackgroundEvent) return false;
  return eventSessionId !== currentSessionId;
}

export function reducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case "RESTORE_PROJECTION":
      // The session cache returns a projection owned by the active reducer.
      return action.state;

    case "SET_STATE":
      return {
        ...state,
        chatState: {
          ...state.chatState,
          ...action.state,
          projects: action.state.projects ?? state.chatState.projects,
          defaultProjectId: Object.hasOwn(action.state, "defaultProjectId")
            ? action.state.defaultProjectId
            : state.chatState.defaultProjectId,
          project: Object.hasOwn(action.state, "project")
            ? action.state.project
            : state.chatState.project,
        },
        streaming: action.state.streaming,
        thinkingEnabled: action.state.thinkingEnabled ?? state.thinkingEnabled,
        contextHealth: Object.hasOwn(action.state, "contextHealth")
          ? (action.state.contextHealth ?? null)
          : state.contextHealth,
        revertRecoveryNotice: Object.hasOwn(
          action.state,
          "revertRecoveryNotice",
        )
          ? (action.state.revertRecoveryNotice ?? null)
          : state.revertRecoveryNotice,
      };

    case "SET_SESSIONLESS_SELECTIONS":
      return {
        ...state,
        thinkingEnabled:
          action.selections.thinkingEnabled ?? state.thinkingEnabled,
        chatState: { ...state.chatState, ...action.selections },
      };

    case "SET_DEBUG_INFO":
      return {
        ...state,
        debugInfo: action.info,
        systemPrompt: action.systemPrompt ?? state.systemPrompt,
        loadedInstructions:
          action.loadedInstructions ?? state.loadedInstructions,
      };

    case "ADD_USER_MESSAGE": {
      const dismissedMessageId = state.detectedQuestion?.messageId;
      const messagesWithoutContinueActions = clearFinalMarkerContinueActions(
        state.messages,
      );
      const withNewRows = [
        ...messagesWithoutContinueActions,
        {
          id: action.id ?? randomId(),
          role: "user" as const,
          content: action.text,
          timestamp: Date.now(),
          blocks: [],
          isSlashCommand: action.isSlashCommand,
          slashCommandLabel: action.slashCommandLabel,
          displayMedia: action.displayMedia,
        },
        {
          id: randomId(),
          role: "assistant" as const,
          content: "",
          timestamp: Date.now(),
          blocks: [],
        },
      ];
      const appliedPending = applyCheckpoints(
        withNewRows,
        state.pendingCheckpoints,
        state.loadedUserTurnOffset,
      );
      return {
        ...state,
        originalPrompt: state.originalPrompt ?? action.text,
        chatState: { ...state.chatState, streaming: true, interrupted: false },
        streaming: true,
        detectedQuestion: null,
        dismissedDetectedQuestionIds:
          dismissedMessageId &&
          !state.dismissedDetectedQuestionIds.includes(dismissedMessageId)
            ? [...state.dismissedDetectedQuestionIds, dismissedMessageId]
            : state.dismissedDetectedQuestionIds,
        messages: appliedPending.messages,
        pendingCheckpoints: appliedPending.pending,
      };
    }

    case "ADD_ANNOTATION":
      return {
        ...state,
        messages: [
          ...state.messages,
          {
            id: randomId(),
            role: "user",
            content: action.text,
            badge: action.badge,
            timestamp: Date.now(),
            blocks: [],
          },
          {
            id: randomId(),
            role: "assistant",
            content: "",
            timestamp: Date.now(),
            blocks: [],
          },
        ],
      };

    case "THINKING_START": {
      // Idempotence: a replayed or hydration-overlapping start must not create
      // a second block with the same id — THINKING_DELTA appends to every
      // matching block, so duplicates would each receive the full text.
      if (
        state.messages.some((message) =>
          message.blocks.some(
            (block) =>
              block.type === "thinking" && block.id === action.thinkingId,
          ),
        )
      ) {
        return { ...state, statusOverride: null };
      }
      const all = ensureAssistant(state.messages);
      const { msgs, last } = cloneLast(all);
      last.blocks.push({
        type: "thinking",
        id: action.thinkingId,
        text: "",
        complete: false,
      });
      return { ...state, messages: msgs, statusOverride: null };
    }

    case "THINKING_DELTA": {
      // Self-heal: if the target block is missing (its start event was lost or
      // a hydration dropped it), create it instead of silently discarding the
      // text — an empty/absent block at THINKING_END renders as no thinking at
      // all.
      if (
        !state.messages[state.messages.length - 1]?.blocks.some(
          (b) => b.type === "thinking" && b.id === action.thinkingId,
        )
      ) {
        const all = ensureAssistant(state.messages);
        const { msgs, last } = cloneLast(all);
        last.blocks.push({
          type: "thinking",
          id: action.thinkingId,
          text: action.text,
          complete: false,
        });
        return { ...state, messages: msgs };
      }
      const { msgs, last } = cloneLast(state.messages);
      last.blocks = last.blocks.map((b) =>
        b.type === "thinking" && b.id === action.thinkingId
          ? { ...b, text: b.text + action.text }
          : b,
      );
      return { ...state, messages: msgs };
    }

    case "THINKING_END": {
      const { msgs, last } = cloneLast(state.messages);
      last.blocks = normalizeAssistantBlocks(
        last.blocks.map((b) =>
          b.type === "thinking" && b.id === action.thinkingId
            ? { ...b, complete: true }
            : b,
        ),
      );
      return { ...state, messages: msgs };
    }

    case "TOOL_START": {
      // Idempotence for every tool (not just ask_user): tool ids are
      // provider-stable, so a start event whose block already exists — via a
      // replay or a hydration that included it — must be a no-op.
      if (
        state.messages.some((message) =>
          message.blocks.some(
            (block) =>
              (block.type === "tool_call" || block.type === "skill_load") &&
              block.id === action.toolCallId,
          ),
        )
      ) {
        return { ...state, statusOverride: null };
      }

      if (action.parentCallId) {
        const messages = state.messages.map((message) => ({
          ...message,
          blocks: message.blocks.map((block) => {
            if (
              block.type !== "tool_call" ||
              block.id !== action.parentCallId
            ) {
              return block;
            }
            const trace = block.composeTrace ?? {
              status: "running" as const,
              totalChildren: 0,
              completedChildren: 0,
              children: [],
            };
            // Idempotence: a replayed child start must not double-count.
            if (
              trace.children.some((child) => child.id === action.toolCallId)
            ) {
              return block;
            }
            const inputSummary =
              action.input === undefined
                ? undefined
                : JSON.stringify(action.input).slice(0, 240);
            return {
              ...block,
              composeTrace: {
                ...trace,
                status: "running" as const,
                totalChildren: trace.totalChildren + 1,
                children: [
                  ...trace.children,
                  {
                    id: action.toolCallId,
                    name: action.toolName,
                    status: "running" as const,
                    inputSummary,
                  },
                ].slice(-64),
              },
            };
          }),
        }));
        return { ...state, messages, statusOverride: null };
      }

      const all = ensureAssistant(state.messages);
      const { msgs, last } = cloneLast(all);
      const inputJson =
        action.input === undefined ? "" : JSON.stringify(action.input);
      last.blocks.push(
        action.toolName === "load_skill"
          ? {
              type: "skill_load",
              id: action.toolCallId,
              inputJson,
              result: "",
              complete: false,
            }
          : {
              type: "tool_call",
              id: action.toolCallId,
              name: action.toolName,
              inputJson,
              result: "",
              complete: false,
              ...(action.toolName === "compose"
                ? {
                    composeTrace: {
                      status: "running" as const,
                      totalChildren: 0,
                      completedChildren: 0,
                      children: [],
                    },
                  }
                : {}),
            },
      );
      return { ...state, messages: msgs, statusOverride: null };
    }

    case "TOOL_INPUT_DELTA": {
      // Search backwards for the message containing this tool_call (same
      // rationale as TOOL_COMPLETE — events can push new messages).
      let tiIdx = state.messages.length - 1;
      for (; tiIdx >= 0; tiIdx--) {
        if (
          state.messages[tiIdx].blocks.some(
            (b) =>
              (b.type === "tool_call" || b.type === "skill_load") &&
              b.id === action.toolCallId,
          )
        ) {
          break;
        }
      }
      if (tiIdx < 0) return state;
      const tiMsgs = [...state.messages];
      const tiTarget = { ...tiMsgs[tiIdx] };
      tiTarget.blocks = tiTarget.blocks.map((b) =>
        (b.type === "tool_call" || b.type === "skill_load") &&
        b.id === action.toolCallId
          ? {
              ...b,
              // A confirmed tool start may already carry the complete input.
              // Retain streamed deltas as a fallback for providers/surfaces
              // that only know the arguments incrementally.
              inputJson:
                parseJsonObject(b.inputJson) === null
                  ? b.inputJson + action.partialJson
                  : b.inputJson,
            }
          : b,
      );
      tiMsgs[tiIdx] = tiTarget;
      return { ...state, messages: tiMsgs };
    }

    case "TOOL_COMPLETE": {
      if (action.parentCallId) {
        const messages = state.messages.map((message) => ({
          ...message,
          blocks: message.blocks.map((block) => {
            if (
              block.type !== "tool_call" ||
              block.id !== action.parentCallId
            ) {
              return block;
            }
            const trace = block.composeTrace;
            if (!trace) return block;
            const childStatus: ComposeChildStatus = parseJsonObject(
              action.result,
            )?.error
              ? "error"
              : "completed";
            return {
              ...block,
              composeTrace: {
                ...trace,
                completedChildren: Math.min(
                  trace.totalChildren,
                  trace.completedChildren + 1,
                ),
                children: trace.children.map((child) =>
                  child.id === action.toolCallId
                    ? {
                        ...child,
                        status: childStatus,
                        durationMs: action.durationMs,
                        ...(childStatus === "error"
                          ? { errorSummary: action.result.slice(0, 240) }
                          : {}),
                      }
                    : child,
                ),
              },
            };
          }),
        }));
        return { ...state, messages };
      }

      // Search ALL messages for the matching tool_call — not just the last one.
      // Events like ADD_ANNOTATION, ADD_INTERJECTION, BG_AGENT_DONE, or ADD_CONDENSE
      // can push new messages between TOOL_START and TOOL_COMPLETE, leaving the
      // tool_call block in an earlier message. This is especially common with
      // long-running tools like get_background_result.
      let targetIdx = -1;
      for (let i = state.messages.length - 1; i >= 0; i--) {
        if (
          state.messages[i].blocks.some(
            (b) =>
              (b.type === "tool_call" || b.type === "skill_load") &&
              b.id === action.toolCallId,
          )
        ) {
          targetIdx = i;
          break;
        }
      }
      if (targetIdx === -1) {
        // ask_user must never lose its durable answer: if the anchor block is
        // gone (a hydration replaced the message that held it), synthesize the
        // completed tool_call plus its answer instead of no-opping.
        if (action.toolName === "ask_user") {
          const items = parseAskUserQuestionAnswerItems(action.result);
          const ensured = ensureAssistant(state.messages);
          const cloned = cloneLast(ensured);
          cloned.last.blocks.push({
            type: "tool_call",
            id: action.toolCallId,
            name: action.toolName,
            inputJson:
              action.input === undefined ? "" : JSON.stringify(action.input),
            result: action.result,
            complete: true,
            durationMs: action.durationMs,
          });
          if (items.length > 0) {
            cloned.last.blocks.push({
              type: "question_answer",
              toolCallId: action.toolCallId,
              items,
            });
          }
          return { ...state, messages: cloned.msgs };
        }
        return state; // tool_call not found — no-op
      }

      const msgs = [...state.messages];
      const target = { ...msgs[targetIdx] };
      target.blocks = target.blocks.map((b) => {
        if (
          (b.type === "tool_call" || b.type === "skill_load") &&
          b.id === action.toolCallId
        ) {
          const nextBase = {
            ...b,
            ...(action.toolName.trim() ? { name: action.toolName } : {}),
            inputJson:
              b.inputJson !== "" || action.input === undefined
                ? b.inputJson
                : JSON.stringify(action.input),
            result: action.result,
            ...(b.type === "tool_call" && action.resultImages?.length
              ? { resultImages: action.resultImages }
              : {}),
            ...(b.type === "tool_call" && action.resultDocuments?.length
              ? { resultDocuments: action.resultDocuments }
              : {}),
            complete: true,
            durationMs: action.durationMs,
            ...(b.type === "tool_call"
              ? {
                  mcpApprovalPromotion: action.mcpApprovalPromotion,
                  composeTrace: action.composeTrace ?? b.composeTrace,
                }
              : {}),
          };
          if (b.type === "skill_load") {
            const parsed = parseLoadSkillResult(action.result);
            return {
              ...nextBase,
              skillName: parsed.skillName,
              path: parsed.path,
              content: parsed.content,
            };
          }
          return nextBase;
        }
        return b;
      });
      msgs[targetIdx] = target;
      const promotedDisplayMedia =
        action.toolName === "generate_image" ||
        action.toolName === "present_images"
          ? resultImagesToDisplayMedia(
              action.resultImages,
              target.displayMedia?.images.length ?? 0,
              action.toolName === "present_images"
                ? "presented-image"
                : "generated-image",
            )
          : undefined;
      if (promotedDisplayMedia) {
        target.displayMedia = {
          images: [
            ...(target.displayMedia?.images ?? []),
            ...promotedDisplayMedia.images,
          ],
          documents: target.displayMedia?.documents ?? [],
        };
        msgs[targetIdx] = target;
      }

      // When ask_user completes, reconcile the optimistic submitted-answer
      // summary with the durable tool result instead of appending a duplicate.
      if (action.toolName === "ask_user") {
        const items = parseAskUserQuestionAnswerItems(action.result);
        if (items.length > 0) {
          const answerIdx = target.blocks.findIndex(
            (block) =>
              block.type === "question_answer" &&
              block.toolCallId === action.toolCallId,
          );
          const answerBlock = {
            type: "question_answer" as const,
            toolCallId: action.toolCallId,
            items,
          };
          target.blocks =
            answerIdx >= 0
              ? target.blocks.map((block, index) =>
                  index === answerIdx ? answerBlock : block,
                )
              : [...target.blocks, answerBlock];
          msgs[targetIdx] = target;
        }
      }

      // When get_background_result completes, add a visible result block so
      // the output is not only available inside the raw tool-call details.
      if (action.toolName === "get_background_result") {
        const parsedBackgroundResult = parseBackgroundToolResult(action.result);
        if (parsedBackgroundResult.kind === "non_terminal") {
          return { ...state, messages: msgs };
        }
        const toolBlock = target.blocks.find(
          (b) => b.type === "tool_call" && b.id === action.toolCallId,
        );
        const sessionId = getBgSessionIdFromToolInput(
          action.input,
          toolBlock?.type === "tool_call" ? toolBlock.inputJson : undefined,
        );

        if (sessionId) {
          const existingResult = msgs
            .flatMap((message) => message.blocks)
            .find(
              (
                block,
              ): block is Extract<ContentBlock, { type: "bg_agent_result" }> =>
                block.type === "bg_agent_result" &&
                block.sessionId === sessionId,
            );
          const toolResultBlock: ProjectedBackgroundResult = {
            type: "bg_agent_result",
            sessionId,
            task: findBgTaskForSession(msgs, target.blocks, sessionId),
            status: parsedBackgroundResult.status,
            resultState: parsedBackgroundResult.resultState,
            terminalReason: parsedBackgroundResult.terminalReason,
            resultText: parsedBackgroundResult.resultText,
            partialOutput: parsedBackgroundResult.partialOutput,
            summary: undefined,
            retrySafe: parsedBackgroundResult.retrySafe,
            agentRetryable: parsedBackgroundResult.agentRetryable,
            sourceAuthority: "tool",
          };
          const toolContentIsCompatible =
            existingResult?.resultState === toolResultBlock.resultState ||
            (!existingResult?.resultState &&
              existingResult?.status === toolResultBlock.status);
          const bgResultBlock: ContentBlock =
            existingResult?.sourceAuthority === "canonical"
              ? {
                  ...existingResult,
                  resultText:
                    existingResult.resultText ??
                    (toolContentIsCompatible
                      ? toolResultBlock.resultText
                      : undefined),
                  partialOutput:
                    existingResult.partialOutput ??
                    (toolContentIsCompatible
                      ? toolResultBlock.partialOutput
                      : undefined),
                }
              : { ...toolResultBlock, summary: existingResult?.summary };
          const reconciledMessages = msgs
            .map((message) => ({
              ...message,
              blocks: message.blocks.filter(
                (block) =>
                  !(
                    block.type === "bg_agent_result" &&
                    block.sessionId === sessionId
                  ),
              ),
            }))
            .filter(
              (message, index, messages) =>
                message.id === target.id ||
                !isEmptyAssistantShell(message) ||
                (state.streaming &&
                  index === messages.length - 1 &&
                  isEmptyAssistantShell(msgs[index])),
            );
          const reconciledTargetIndex = reconciledMessages.findIndex(
            (message) => message.id === target.id,
          );
          const reconciledTarget = {
            ...reconciledMessages[reconciledTargetIndex],
            blocks: [...reconciledMessages[reconciledTargetIndex].blocks],
          };
          const toolIndex = reconciledTarget.blocks.findIndex(
            (block) =>
              block.type === "tool_call" && block.id === action.toolCallId,
          );
          reconciledTarget.blocks.splice(
            toolIndex >= 0 ? toolIndex + 1 : reconciledTarget.blocks.length,
            0,
            bgResultBlock,
          );
          reconciledMessages[reconciledTargetIndex] = reconciledTarget;
          return { ...state, messages: reconciledMessages };
        }
      }

      // When spawn_background_agent completes, add a bg_agent block to track progress
      if (action.toolName === "spawn_background_agent") {
        try {
          const parsed = JSON.parse(action.result);
          if (parsed.sessionId) {
            // Extract task and message from the tool_call input
            const toolBlock = target.blocks.find(
              (b) => b.type === "tool_call" && b.id === action.toolCallId,
            );
            let task = "Background Agent";
            let message: string | undefined;

            const finalInput =
              action.input &&
              typeof action.input === "object" &&
              !Array.isArray(action.input)
                ? action.input
                : null;
            if (finalInput) {
              const input = finalInput as { task?: unknown; message?: unknown };
              if (typeof input.task === "string" && input.task)
                task = input.task;
              if (typeof input.message === "string" && input.message) {
                message = input.message;
              }
            }

            if (toolBlock && toolBlock.type === "tool_call") {
              try {
                const input = JSON.parse(toolBlock.inputJson) as {
                  task?: unknown;
                  message?: unknown;
                };
                if (
                  task === "Background Agent" &&
                  typeof input.task === "string" &&
                  input.task
                ) {
                  task = input.task;
                }
                if (
                  !message &&
                  typeof input.message === "string" &&
                  input.message
                ) {
                  message = input.message;
                }
              } catch {
                // ignore parse error
              }
            }
            target.blocks = [
              ...target.blocks,
              {
                type: "bg_agent",
                sessionId: parsed.sessionId,
                task,
                message,
                resolvedModel: parsed.resolvedModel,
                resolvedProvider: parsed.resolvedProvider,
                reasoningEffort: isCoreReasoningEffort(parsed.reasoningEffort)
                  ? parsed.reasoningEffort
                  : undefined,
                resolvedMode: parsed.resolvedMode,
                taskClass: parsed.taskClass,
                routingReason: parsed.routingReason,
              },
            ];
            msgs[targetIdx] = target;
          }
        } catch {
          // ignore parse error
        }
      }
      return { ...state, messages: msgs };
    }

    case "TEXT_DELTA": {
      const all = ensureAssistant(state.messages);
      const { msgs, last } = cloneLast(all);
      // Append to existing text block or start a new one.
      // Each Claude API turn naturally produces interleaved text+tool blocks:
      //   [text: "Let me do X:"] → [tool_call] → [text: "Follow-up:"] → ...
      // The colon at the end of pre-tool text is Claude's natural lead-in style.
      const tail = lastBlock(last.blocks, "text");
      if (tail && tail.type === "text") {
        last.blocks[last.blocks.length - 1] = {
          ...tail,
          text: tail.text + action.text,
        };
      } else {
        last.blocks.push({ type: "text", text: action.text });
      }
      return { ...state, messages: msgs };
    }

    case "ADD_SURFACE_CHANGE": {
      const marker: ChatMessage = {
        id: randomId(),
        role: "assistant",
        content: "",
        timestamp: Date.now(),
        blocks: [],
        surfaceChange: action.change,
      };
      return {
        ...state,
        messages: [
          ...state.messages,
          marker,
          ...(state.streaming
            ? [
                {
                  id: randomId(),
                  role: "assistant" as const,
                  content: "",
                  timestamp: Date.now(),
                  blocks: [],
                },
              ]
            : []),
        ],
      };
    }

    case "API_REQUEST": {
      if (state.messages.length === 0) return state;
      const { msgs, last } = cloneLast(state.messages);
      last.apiRequest = {
        requestId: action.requestId,
        model: action.model,
        reasoningEffort: action.reasoningEffort,
        mode: action.mode,
        commandApprovalPolicy: action.commandApprovalPolicy,
        inputTokens: action.inputTokens,
        uncachedInputTokens: action.uncachedInputTokens,
        cacheReadTokens: action.cacheReadTokens,
        cacheCreationTokens: action.cacheCreationTokens,
        outputTokens: action.outputTokens,
        ...(action.usageEstimated !== undefined
          ? { usageEstimated: action.usageEstimated }
          : {}),
        durationMs: action.durationMs,
        timeToFirstToken: action.timeToFirstToken,
        usedPreviousResponseId: action.usedPreviousResponseId,
        previousResponseIdFallback: action.previousResponseIdFallback,
        promptCacheKey: action.promptCacheKey,
        promptCacheRetention: action.promptCacheRetention,
        storeResponseState: action.storeResponseState,
        providerResponseId: action.providerResponseId,
        contextBreakdown: action.contextBreakdown,
      };
      return {
        ...state,
        messages: msgs,
        lastInputTokens: action.inputTokens,
        lastOutputTokens: action.outputTokens,
        lastCacheReadTokens: action.cacheReadTokens,
        // Real API data resets the running estimate.
        estimatedTotalUsed: 0,
      };
    }

    case "TOKEN_ESTIMATE": {
      return { ...state, estimatedTotalUsed: action.estimatedTotalUsed };
    }

    case "TODO_UPDATE":
      return {
        ...state,
        todos: Array.isArray(action.todos) ? action.todos : [],
      };

    case "SET_FINAL_MARKER": {
      if (!action.marker) return { ...state, pendingFinalMarker: null };
      const finalTool = [...state.messages]
        .reverse()
        .flatMap((message) => [...message.blocks].reverse())
        .find(
          (block) =>
            block.type === "tool_call" && block.name === "set_task_status",
        );
      const marker =
        finalTool?.type === "tool_call"
          ? {
              ...action.marker,
              toolCall: {
                id: finalTool.id,
                name: "set_task_status" as const,
                inputJson: finalTool.inputJson,
                result: finalTool.result,
                durationMs: finalTool.durationMs,
              },
            }
          : action.marker;
      const messages = applyFinalMarkerToLatestAssistant(
        state.messages,
        marker,
      );
      return {
        ...state,
        messages,
        // A final marker normally arrives after TOOL_START has created its
        // assistant row, so attach it immediately. This matters when a queued
        // interjection keeps the overall run alive: the completed segment can
        // render its summary while the next segment continues streaming.
        // Retain the pending fallback only for an out-of-order marker that has
        // no assistant row to host it yet.
        pendingFinalMarker: messages === state.messages ? marker : null,
      };
    }

    case "CLEAR_FINAL_MARKER_CONTINUE_ACTIONS":
      return {
        ...state,
        messages: clearFinalMarkerContinueActions(state.messages),
      };

    case "MARK_AUTO_CONTINUE_STOPPED":
      return {
        ...state,
        messages: markAutoContinueStopped(
          state.messages,
          action.messageId,
          action.reason,
        ),
      };

    case "CLEAR_INTERACTION_PROMPTS":
      return {
        ...state,
        approvalRequest: null,
        questionRequest: null,
        detectedQuestion: null,
        messages: clearFinalMarkerContinueActions(state.messages),
      };

    case "ERROR": {
      const all = ensureAssistant(state.messages);
      const { msgs, last } = cloneLast(all);
      last.error = {
        message: action.error,
        retryable: action.retryable,
        code: action.code,
        actions: action.actions,
      };
      return {
        ...state,
        streaming: false,
        messages: completeIncompleteRuntimeBlocks(msgs),
        statusOverride: null,
      };
    }

    case "CLEAR_ERROR": {
      // Remove the error from the last message and set streaming=true for retry
      if (state.messages.length === 0) return state;
      const all2 = [...state.messages];
      const lastMsg2 = { ...all2[all2.length - 1] };
      delete lastMsg2.error;
      all2[all2.length - 1] = lastMsg2;
      return { ...state, messages: all2, streaming: true };
    }

    case "DONE": {
      // Mark any incomplete tool calls / thinking blocks as complete so
      // their spinners stop when the user clicks Stop.
      const doneMessages = completeIncompleteRuntimeBlocks(state.messages);

      // Mark any in_progress todos as pending so their spinners stop
      const stopTodos = (items: TodoItem[]): TodoItem[] =>
        items.map((t) => ({
          ...t,
          status: t.status === "in_progress" ? "pending" : t.status,
          children: t.children ? stopTodos(t.children) : t.children,
        }));

      // Remove the empty assistant placeholder added after condensing if the
      // agent ended before producing any content (e.g. manual /condense).
      const last = doneMessages[doneMessages.length - 1];
      const secondToLast = doneMessages[doneMessages.length - 2];
      const finalMessages =
        last?.role === "assistant" &&
        last.blocks.length === 0 &&
        !last.error &&
        (secondToLast?.role === "condense" ||
          Boolean(secondToLast?.surfaceChange))
          ? doneMessages.slice(0, -1)
          : doneMessages;

      const messagesWithMarker = state.pendingFinalMarker
        ? applyFinalMarkerToLatestAssistant(
            finalMessages,
            state.pendingFinalMarker,
          )
        : finalMessages;

      return {
        ...state,
        streaming: false,
        messages: messagesWithMarker,
        todos: stopTodos(state.todos),
        statusOverride: null,
        pendingFinalMarker: null,
      };
    }

    case "NEW_SESSION":
      return {
        ...state,
        messages: [],
        originalPrompt: null,
        streaming: false,
        loadedUserTurnOffset: 0,
        pendingCheckpoints: [],
        pendingFinalMarker: null,
        lastInputTokens: 0,
        lastOutputTokens: 0,
        lastCacheReadTokens: 0,
        estimatedTotalUsed: 0,
        todos: [],
        messageQueue: [],
        approvalRequest: null,
        questionRequest: null,
        detectedQuestion: null,
        dismissedDetectedQuestionIds: [],
        statusOverride: null,
        chatState: {
          ...state.chatState,
          sessionId: null,
          streaming: false,
          interrupted: false,
          commandApprovalPolicy:
            state.chatState.configuredCommandApprovalPolicy ?? "safe",
          approvalPolicy: "on-request",
          approvalReviewer: "user",
          executionPreset: "native-manual",
          agentWriteApproval:
            state.chatState.agentWriteApproval === "session"
              ? "prompt"
              : state.chatState.agentWriteApproval,
        },
      };

    case "SET_REASONING_EFFORT":
      return {
        ...state,
        thinkingEnabled: action.effort !== "none",
        chatState: {
          ...state.chatState,
          reasoningEffort: action.effort,
          thinkingEnabled: action.effort !== "none",
        },
      };

    case "TOGGLE_THINKING": {
      const nextEnabled = !state.thinkingEnabled;
      const nextEffort = nextEnabled
        ? state.chatState.reasoningEffort === "none"
          ? "high"
          : (state.chatState.reasoningEffort ?? "high")
        : "none";
      return {
        ...state,
        thinkingEnabled: nextEnabled,
        chatState: {
          ...state.chatState,
          reasoningEffort: nextEffort,
          thinkingEnabled: nextEnabled,
        },
      };
    }

    case "SET_MODES":
      return {
        ...state,
        modes: Array.isArray(action.modes) ? action.modes : state.modes,
      };

    case "SET_MODELS":
      return {
        ...state,
        availableModels: Array.isArray(action.models)
          ? action.models
          : state.availableModels,
      };

    case "SET_SLASH_COMMANDS":
      return {
        ...state,
        slashCommands: Array.isArray(action.commands)
          ? action.commands
          : state.slashCommands,
      };

    case "ENQUEUE_MESSAGE": {
      const dismissedMessageId = state.detectedQuestion?.messageId;
      return {
        ...state,
        detectedQuestion: null,
        dismissedDetectedQuestionIds:
          dismissedMessageId &&
          !state.dismissedDetectedQuestionIds.includes(dismissedMessageId)
            ? [...state.dismissedDetectedQuestionIds, dismissedMessageId]
            : state.dismissedDetectedQuestionIds,
        messageQueue: [
          ...state.messageQueue,
          {
            id: action.id,
            text: action.text,
            ...(action.fullText ? { fullText: action.fullText } : {}),
            ...(action.isSlashCommand ? { isSlashCommand: true } : {}),
            ...(action.slashCommandLabel
              ? { slashCommandLabel: action.slashCommandLabel }
              : {}),
            ...(action.attachments ? { attachments: action.attachments } : {}),
            ...(action.images ? { images: action.images } : {}),
            ...(action.documents ? { documents: action.documents } : {}),
            ...(action.displayMedia
              ? { displayMedia: action.displayMedia }
              : {}),
            ...(action.source ? { source: action.source } : {}),
          },
        ],
      };
    }

    case "EDIT_QUEUE_MESSAGE":
      return {
        ...state,
        messageQueue: state.messageQueue.map((q) =>
          q.id === action.id
            ? {
                ...q,
                text: action.text,
                fullText: action.text,
                isSlashCommand: false,
                slashCommandLabel: undefined,
              }
            : q,
        ),
      };

    case "MARK_QUEUE_INTERJECTION_READY":
      return {
        ...state,
        messageQueue: state.messageQueue.map((q) =>
          q.id === action.id ? { ...q, interjectionReady: action.ready } : q,
        ),
      };

    case "REMOVE_FROM_QUEUE":
      return {
        ...state,
        messageQueue: state.messageQueue.filter((q) => q.id !== action.id),
      };

    case "CLEAR_QUEUE":
      return { ...state, messageQueue: [] };

    case "ADD_INTERJECTION": {
      // Insert user interjection bubble mid-run without resetting streaming state
      const withInterjection = [
        ...state.messages,
        {
          id: randomId(),
          role: "user" as const,
          content: action.text,
          timestamp: Date.now(),
          blocks: [],
          isSlashCommand: action.isSlashCommand,
          slashCommandLabel: action.slashCommandLabel,
          displayMedia: action.displayMedia,
        },
        {
          id: randomId(),
          role: "assistant" as const,
          content: "",
          timestamp: Date.now(),
          blocks: [],
        },
      ];
      const appliedPending = applyCheckpoints(
        withInterjection,
        state.pendingCheckpoints,
        state.loadedUserTurnOffset,
      );
      return {
        ...state,
        messages: appliedPending.messages,
        pendingCheckpoints: appliedPending.pending,
      };
    }

    case "ADD_COMMITTED_USER_MESSAGE": {
      // Idempotence: a replayed commit (buffered-event replay, paired
      // surfaces) must not append the user row twice.
      if (
        action.id !== undefined &&
        state.messages.some((message) => message.id === action.id)
      ) {
        return state;
      }
      const lastMessage = state.messages[state.messages.length - 1];
      const previousMessage = state.messages[state.messages.length - 2];
      const optimisticUserPendingAssistant =
        lastMessage?.role === "assistant" &&
        lastMessage.blocks.length === 0 &&
        previousMessage?.role === "user" &&
        previousMessage.content === action.text;

      if (optimisticUserPendingAssistant) {
        const updatedMessages = clearFinalMarkerContinueActions([
          ...state.messages,
        ]);
        updatedMessages[updatedMessages.length - 2] = {
          ...previousMessage,
          isSlashCommand: action.isSlashCommand,
          slashCommandLabel: action.slashCommandLabel,
          origin: action.origin,
          displayMedia: action.displayMedia ?? previousMessage.displayMedia,
        };
        const appliedPending = applyCheckpoints(
          updatedMessages,
          state.pendingCheckpoints,
          state.loadedUserTurnOffset,
        );
        return {
          ...state,
          originalPrompt: state.originalPrompt ?? action.text,
          messages: appliedPending.messages,
          pendingCheckpoints: appliedPending.pending,
        };
      }

      const messagesWithoutContinueActions = clearFinalMarkerContinueActions(
        state.messages,
      );
      const withCommittedRows = [
        ...messagesWithoutContinueActions,
        {
          id: action.id ?? randomId(),
          role: "user" as const,
          content: action.text,
          timestamp: Date.now(),
          blocks: [],
          isSlashCommand: action.isSlashCommand,
          slashCommandLabel: action.slashCommandLabel,
          origin: action.origin,
          displayMedia: action.displayMedia,
        },
        {
          id: randomId(),
          role: "assistant" as const,
          content: "",
          timestamp: Date.now(),
          blocks: [],
        },
      ];
      const appliedPending = applyCheckpoints(
        withCommittedRows,
        state.pendingCheckpoints,
        state.loadedUserTurnOffset,
      );
      return {
        ...state,
        originalPrompt: state.originalPrompt ?? action.text,
        streaming: true,
        messages: appliedPending.messages,
        pendingCheckpoints: appliedPending.pending,
      };
    }

    case "SET_APPROVAL":
      return { ...state, approvalRequest: action.request };

    case "CLEAR_APPROVAL":
      return state.approvalRequest?.id === action.id
        ? { ...state, approvalRequest: null }
        : state;

    case "SET_QUESTION": {
      let messages = state.messages;
      if (
        action.toolCallId &&
        !action.backgroundTask &&
        !messages.some((message) =>
          message.blocks.some(
            (block) =>
              block.type === "tool_call" && block.id === action.toolCallId,
          ),
        )
      ) {
        const all = ensureAssistant(messages);
        const cloned = cloneLast(all);
        cloned.last.blocks.push({
          type: "tool_call",
          id: action.toolCallId,
          name: "ask_user",
          inputJson: JSON.stringify({
            context: action.context,
            questions: action.questions,
          }),
          result: "",
          complete: false,
        });
        messages = cloned.msgs;
      }
      messages = addQuestionContextMessage(messages, action.id, action.context);
      let toolCallId = action.toolCallId;
      if (!toolCallId && !action.backgroundTask) {
        for (
          let messageIdx = messages.length - 1;
          messageIdx >= 0;
          messageIdx -= 1
        ) {
          const toolCall = [...messages[messageIdx].blocks]
            .reverse()
            .find(
              (block) =>
                block.type === "tool_call" &&
                normalizeProjectedToolName(block.name) === "ask_user" &&
                !messages.some((message) =>
                  message.blocks.some(
                    (candidate) =>
                      candidate.type === "question_answer" &&
                      candidate.toolCallId === block.id,
                  ),
                ),
            );
          if (toolCall?.type === "tool_call") {
            toolCallId = toolCall.id;
            break;
          }
        }
      }
      return {
        ...state,
        messages,
        questionRequest: {
          id: action.id,
          ...(toolCallId ? { toolCallId } : {}),
          context: action.context,
          questions: action.questions,
          ...(action.backgroundTask
            ? { backgroundTask: action.backgroundTask }
            : {}),
        },
      };
    }

    case "SUBMIT_QUESTION": {
      const request = state.questionRequest;
      if (!request || request.id !== action.id) return state;

      const items = request.questions.map((question) => ({
        question: question.question,
        answer: normalizeAskUserAnswer(action.answers[question.id]),
        ...(action.notes[question.id]?.trim()
          ? { note: action.notes[question.id].trim() }
          : {}),
      }));
      const toolCallId = request.toolCallId;
      let targetIdx = -1;
      if (toolCallId) {
        for (let index = state.messages.length - 1; index >= 0; index -= 1) {
          if (
            state.messages[index].blocks.some(
              (block) => block.type === "tool_call" && block.id === toolCallId,
            )
          ) {
            targetIdx = index;
            break;
          }
        }
      }
      if (!toolCallId) {
        return { ...state, questionRequest: null };
      }
      let messages = [...state.messages];
      if (targetIdx < 0) {
        // The anchor tool_call was lost (e.g. a transcript hydration replaced
        // the message that held it). Synthesize it rather than silently
        // dropping the user's answer; TOOL_COMPLETE reconciles by id later.
        const ensured = ensureAssistant(messages);
        const cloned = cloneLast(ensured);
        cloned.last.blocks.push({
          type: "tool_call",
          id: toolCallId,
          name: "ask_user",
          inputJson: JSON.stringify({
            context: request.context,
            questions: request.questions,
          }),
          result: "",
          complete: false,
        });
        messages = cloned.msgs;
        targetIdx = messages.length - 1;
      }

      const target = { ...messages[targetIdx] };
      const answerBlock: ContentBlock = {
        type: "question_answer",
        toolCallId,
        items,
      };
      const existingIdx = target.blocks.findIndex(
        (block) =>
          block.type === "question_answer" && block.toolCallId === toolCallId,
      );
      target.blocks =
        existingIdx >= 0
          ? target.blocks.map((block, index) =>
              index === existingIdx ? answerBlock : block,
            )
          : [...target.blocks, answerBlock];
      messages[targetIdx] = target;
      return { ...state, messages, questionRequest: null };
    }

    case "CLEAR_QUESTION":
      return action.id && state.questionRequest?.id !== action.id
        ? state
        : { ...state, questionRequest: null };

    case "SET_DETECTED_QUESTION":
      return {
        ...state,
        detectedQuestion: action.detectedQuestion,
      };

    case "DISMISS_DETECTED_QUESTION":
      return {
        ...state,
        detectedQuestion:
          state.detectedQuestion?.messageId === action.messageId
            ? null
            : state.detectedQuestion,
        dismissedDetectedQuestionIds:
          state.dismissedDetectedQuestionIds.includes(action.messageId)
            ? state.dismissedDetectedQuestionIds
            : [...state.dismissedDetectedQuestionIds, action.messageId],
      };

    case "CONDENSE_START": {
      // Add a pending condense row — replaced with final stats when complete.
      // Set streaming: true so the input area queues messages during condense
      // (prevents racing with message history changes). Treat duplicate start
      // events as idempotent; browser snapshot replay or paired surfaces should
      // not stack multiple pending condense rows for one condense operation.
      if (
        state.messages.some(
          (m) => m.role === "condense" && m.condenseInfo?.condensing,
        )
      ) {
        return { ...state, streaming: true };
      }
      const tail = state.messages[state.messages.length - 1];
      const base =
        tail?.role === "assistant" &&
        tail.blocks.length === 0 &&
        !tail.error &&
        !tail.surfaceChange
          ? state.messages.slice(0, -1)
          : state.messages;
      return {
        ...state,
        streaming: true,
        messages: [
          ...base,
          {
            id: randomId(),
            role: "condense" as const,
            content: "",
            timestamp: Date.now(),
            blocks: [],
            condenseInfo: {
              prevInputTokens: 0,
              newInputTokens: 0,
              condensing: true,
            },
          },
        ],
      };
    }

    case "ADD_CONDENSE": {
      const pendingIndex = state.messages.findIndex(
        (message) =>
          message.role === "condense" && message.condenseInfo?.condensing,
      );
      const completedCondense: ChatMessage = {
        id: randomId(),
        role: "condense",
        content: "",
        timestamp: Date.now(),
        blocks: [],
        condenseInfo: {
          prevInputTokens: action.prevInputTokens,
          newInputTokens: action.newInputTokens,
          durationMs: action.durationMs,
          validationWarnings: action.validationWarnings,
        },
      };
      const messagesBeforeCondense = [...state.messages];
      const trailingMessage = messagesBeforeCondense.at(-1);
      if (
        trailingMessage?.role === "assistant" &&
        trailingMessage.blocks.length === 0 &&
        !trailingMessage.error
      ) {
        messagesBeforeCondense.pop();
      }
      const completedMessages =
        pendingIndex >= 0
          ? messagesBeforeCondense.map((message, index) =>
              index === pendingIndex ? completedCondense : message,
            )
          : [...messagesBeforeCondense, completedCondense];
      return {
        ...state,
        messages: [
          ...completedMessages,
          // Add an empty assistant placeholder so the streaming dots appear
          // immediately after condensing while waiting for the next API response.
          // DONE strips this if the agent ends without producing any content.
          {
            id: randomId(),
            role: "assistant" as const,
            content: "",
            timestamp: Date.now(),
            blocks: [],
          },
        ],
        lastInputTokens: action.newInputTokens,
        lastOutputTokens: 0,
        lastCacheReadTokens: 0,
        estimatedTotalUsed: 0,
      };
    }

    case "ADD_WARNING": {
      return {
        ...state,
        messages: [
          ...state.messages,
          {
            id: randomId(),
            role: "warning" as const,
            content: "",
            timestamp: Date.now(),
            blocks: [],
            warningMessage: action.message,
            warningRetry:
              action.retryDelayMs !== undefined ||
              action.retryAt !== undefined ||
              action.retryAttempt !== undefined ||
              action.retryMaxAttempts !== undefined
                ? {
                    retryDelayMs: action.retryDelayMs,
                    retryAt: action.retryAt,
                    retryAttempt: action.retryAttempt,
                    retryMaxAttempts: action.retryMaxAttempts,
                  }
                : undefined,
          },
        ],
      };
    }

    case "SET_STATUS_OVERRIDE": {
      return { ...state, statusOverride: action.message };
    }

    case "ADD_PAIRING_CODE": {
      return {
        ...state,
        messages: [
          ...state.messages,
          {
            id: randomId(),
            role: "assistant" as const,
            content: "",
            timestamp: Date.now(),
            blocks: [
              {
                type: "pairing_code" as const,
                pairingId: action.pairingId,
                code: action.code,
                expiresAt: action.expiresAt,
                pairingUrls: action.pairingUrls,
                status: "pending" as const,
              },
            ],
          },
        ],
      };
    }

    case "UPDATE_PAIRING_STATUS": {
      return {
        ...state,
        messages: state.messages.map((message) => {
          let changed = false;
          const nextBlocks = message.blocks.map((block) => {
            if (
              block.type !== "pairing_code" ||
              block.pairingId !== action.pairingId
            ) {
              return block;
            }
            changed = true;
            return {
              ...block,
              status: action.status,
              deviceLabel: action.deviceLabel ?? block.deviceLabel,
            };
          });
          return changed ? { ...message, blocks: nextBlocks } : message;
        }),
      };
    }

    case "SET_RESTORING_SESSION": {
      return { ...state, restoringSession: action.restoring };
    }

    case "ADD_CONDENSE_ERROR": {
      const filtered = state.messages.filter(
        (m) => !(m.role === "condense" && m.condenseInfo?.condensing),
      );

      if (!action.retryable && !action.code && !action.actions) {
        return {
          ...state,
          messages: [
            ...filtered,
            {
              id: randomId(),
              role: "condense" as const,
              content: "",
              timestamp: Date.now(),
              blocks: [],
              condenseInfo: {
                prevInputTokens: 0,
                newInputTokens: 0,
                errorMessage: action.errorMessage,
              },
            },
          ],
          statusOverride: null,
        };
      }

      // Structured failures render through the standard assistant ErrorBlock.
      // Do not also retain a legacy condense error row for the same event.
      return {
        ...state,
        messages: [
          ...filtered,
          {
            id: randomId(),
            role: "assistant" as const,
            content: "",
            timestamp: Date.now(),
            blocks: [],
            error: {
              message: action.errorMessage,
              retryable: action.retryable ?? false,
              code: action.code,
              actions: action.actions,
            },
          },
        ],
        statusOverride: null,
      };
    }

    case "LOAD_SESSION": {
      const userTurnOffset = action.userTurnOffset ?? 0;
      const applied = applyCheckpoints(
        action.messages,
        action.checkpoints,
        userTurnOffset,
      );
      let restoredMessages = applied.messages;
      for (const result of action.backgroundResults ?? []) {
        const existingResults = restoredMessages
          .flatMap((message) => message.blocks)
          .filter(
            (
              block,
            ): block is Extract<ContentBlock, { type: "bg_agent_result" }> =>
              block.type === "bg_agent_result" &&
              block.sessionId === result.sessionId,
          );
        const existingResult = existingResults.at(-1);
        const existingContentIsCompatible =
          existingResult?.resultState === result.resultState ||
          (!existingResult?.resultState &&
            existingResult?.status === result.status);
        const resultBlock: ContentBlock = {
          type: "bg_agent_result",
          sessionId: result.sessionId,
          task: result.task,
          status: result.status,
          resultState: result.resultState,
          terminalReason: result.terminalReason,
          resultText:
            result.resultText ??
            (existingContentIsCompatible
              ? existingResult?.resultText
              : undefined),
          partialOutput:
            result.partialOutput ??
            (existingContentIsCompatible
              ? existingResult?.partialOutput
              : undefined),
          summary: result.summary ?? existingResult?.summary,
          retrySafe: result.retrySafe,
          agentRetryable: result.agentRetryable,
          sourceAuthority: "canonical",
        };
        if (existingResult) {
          let resultOccurrence = 0;
          restoredMessages = restoredMessages.map((message) => ({
            ...message,
            blocks: message.blocks.flatMap((block) => {
              if (
                block.type !== "bg_agent_result" ||
                block.sessionId !== result.sessionId
              ) {
                return [block];
              }
              resultOccurrence += 1;
              return resultOccurrence === existingResults.length
                ? [resultBlock]
                : [];
            }),
          }));
          continue;
        }
        const lastMessage = restoredMessages.at(-1);
        if (lastMessage?.role === "assistant") {
          restoredMessages = [
            ...restoredMessages.slice(0, -1),
            {
              ...lastMessage,
              blocks: [...lastMessage.blocks, resultBlock],
            },
          ];
        } else {
          restoredMessages = [
            ...restoredMessages,
            {
              id: `bg-result-restored-${result.sessionId}`,
              role: "assistant",
              content: "",
              timestamp: result.completedAt,
              blocks: [resultBlock],
            },
          ];
        }
      }
      // Live tail: render the in-flight model response (not yet persisted) so
      // a hydration never regresses content the user is watching stream. Skip
      // blocks whose ids already landed in the restored transcript (a response
      // that committed between snapshot and hydration).
      const restoredBlockIds = new Set(
        restoredMessages.flatMap((message) =>
          message.blocks.flatMap((block) =>
            block.type === "thinking" ||
            block.type === "tool_call" ||
            block.type === "skill_load"
              ? [block.id]
              : [],
          ),
        ),
      );
      const inFlightBlocks: ContentBlock[] = (action.inFlight ?? []).flatMap(
        (block): ContentBlock[] => {
          if (block.type === "text") {
            return block.text ? [{ type: "text", text: block.text }] : [];
          }
          if (restoredBlockIds.has(block.id)) return [];
          if (block.type === "thinking") {
            return [
              {
                type: "thinking",
                id: block.id,
                text: block.text,
                complete: block.complete,
              },
            ];
          }
          return [
            {
              type: "tool_call",
              id: block.id,
              name: block.name,
              inputJson: block.inputJson,
              result: "",
              complete: block.complete,
            },
          ];
        },
      );
      if (inFlightBlocks.length > 0) {
        restoredMessages = [
          ...restoredMessages,
          {
            id: `live-${action.sessionId}`,
            role: "assistant",
            content: "",
            timestamp: Date.now(),
            blocks: inFlightBlocks,
          },
        ];
      }
      const streaming = action.streaming ?? false;
      const sameSession = state.chatState.sessionId === action.sessionId;
      return {
        ...state,
        messages: restoredMessages,
        originalPrompt:
          action.originalPrompt ??
          action.messages.find((message) => message.role === "user")?.content ??
          null,
        streaming,
        restoringSession: false,
        loadedUserTurnOffset: userTurnOffset,
        pendingCheckpoints: applied.pending,
        pendingFinalMarker: null,
        lastInputTokens: action.lastInputTokens ?? 0,
        lastOutputTokens: action.lastOutputTokens ?? 0,
        lastCacheReadTokens: sameSession ? state.lastCacheReadTokens : 0,
        estimatedTotalUsed: sameSession ? state.estimatedTotalUsed : 0,
        todos: Array.isArray(action.todos) ? action.todos : [],
        messageQueue: sameSession ? state.messageQueue : [],
        approvalRequest: sameSession ? state.approvalRequest : null,
        questionRequest: sameSession ? state.questionRequest : null,
        detectedQuestion: null,
        dismissedDetectedQuestionIds: [],
        chatState: {
          ...state.chatState,
          sessionId: action.sessionId,
          mode: action.mode,
          model: action.model,
          streaming,
          interrupted: false,
        },
      };
    }

    case "PREPEND_SESSION_CHUNK": {
      const activeBackgroundResultSessionIds = new Set(
        state.messages.flatMap((message) =>
          message.blocks.flatMap((block) =>
            block.type === "bg_agent_result" ? [block.sessionId] : [],
          ),
        ),
      );
      const prependedMessages = action.messages.map((message) => ({
        ...message,
        blocks: message.blocks.filter(
          (block) =>
            block.type !== "bg_agent_result" ||
            !activeBackgroundResultSessionIds.has(block.sessionId),
        ),
      }));
      const prepended = [...prependedMessages, ...state.messages];
      const mergedCheckpoints = [
        ...(state.pendingCheckpoints ?? []),
        ...(action.checkpoints ?? []),
      ];
      const combinedCheckpoints = mergedCheckpoints.filter(
        (checkpoint, index, all) =>
          all.findIndex(
            (candidate) =>
              candidate.turnIndex === checkpoint.turnIndex &&
              candidate.checkpointId === checkpoint.checkpointId,
          ) === index,
      );
      const applied = applyCheckpoints(
        prepended,
        combinedCheckpoints,
        action.userTurnOffset,
      );
      return {
        ...state,
        messages: applied.messages,
        loadedUserTurnOffset: action.userTurnOffset,
        pendingCheckpoints: applied.pending,
        pendingFinalMarker: null,
      };
    }

    case "BG_AGENT_DONE": {
      const completion = action.completion;
      // If get_background_result already completed for this session, keep the
      // result directly after that tool call. Otherwise, insert before any
      // still-active tail blocks so the live end of the transcript stays last.
      const existingResult = state.messages
        .flatMap((message) => message.blocks)
        .find(
          (
            block,
          ): block is Extract<ContentBlock, { type: "bg_agent_result" }> =>
            block.type === "bg_agent_result" &&
            block.sessionId === completion.sessionId,
        );
      const existingContentIsCompatible =
        existingResult?.resultState === completion.resultState ||
        (!existingResult?.resultState &&
          existingResult?.status === completion.status);
      const resultBlock: ContentBlock = {
        type: "bg_agent_result",
        sessionId: completion.sessionId,
        task: completion.task,
        status: completion.status,
        resultState: completion.resultState,
        terminalReason: completion.terminalReason,
        resultText:
          completion.resultText ??
          (existingContentIsCompatible
            ? existingResult?.resultText
            : undefined),
        partialOutput:
          completion.partialOutput ??
          (existingContentIsCompatible
            ? existingResult?.partialOutput
            : undefined),
        summary: completion.summary ?? existingResult?.summary,
        retrySafe: completion.retrySafe,
        agentRetryable: completion.agentRetryable,
        sourceAuthority: "canonical",
      };
      // Idempotence: hydration paths re-dispatch durable completions on every
      // tab switch. If the rendered block already carries this exact result,
      // keep it where it is instead of ripping it out and re-inserting at the
      // tail (which reads as the card jumping/duplicating).
      if (
        existingResult &&
        existingResult.resultState === resultBlock.resultState &&
        existingResult.status === resultBlock.status &&
        existingResult.resultText === resultBlock.resultText &&
        existingResult.summary === resultBlock.summary &&
        existingResult.sourceAuthority === "canonical"
      ) {
        return state;
      }
      const messagesWithoutPriorResult = state.messages
        .map((message) => ({
          ...message,
          blocks: message.blocks.filter(
            (block) =>
              !(
                block.type === "bg_agent_result" &&
                block.sessionId === completion.sessionId
              ),
          ),
        }))
        .filter(
          (message, index, messages) =>
            !isEmptyAssistantShell(message) ||
            (state.streaming &&
              index === messages.length - 1 &&
              isEmptyAssistantShell(state.messages[index])),
        );
      for (
        let messageIndex = messagesWithoutPriorResult.length - 1;
        messageIndex >= 0;
        messageIndex -= 1
      ) {
        const message = messagesWithoutPriorResult[messageIndex];
        const toolIndex = message.blocks.findIndex(
          (block) =>
            block.type === "tool_call" &&
            block.name === "get_background_result" &&
            block.complete &&
            getBgSessionIdFromToolInput(undefined, block.inputJson) ===
              completion.sessionId,
        );
        if (toolIndex < 0) continue;
        const messages = [...messagesWithoutPriorResult];
        messages[messageIndex] = {
          ...message,
          blocks: [
            ...message.blocks.slice(0, toolIndex + 1),
            resultBlock,
            ...message.blocks.slice(toolIndex + 1),
          ],
        };
        return { ...state, messages };
      }
      const lastMsg =
        messagesWithoutPriorResult[messagesWithoutPriorResult.length - 1];
      if (lastMsg?.role === "assistant") {
        const { msgs, last } = cloneLast(messagesWithoutPriorResult);
        let insertAt = last.blocks.length;
        while (
          insertAt > 0 &&
          isActiveTailBlock(last.blocks[insertAt - 1], state.streaming)
        ) {
          insertAt -= 1;
        }
        last.blocks = [
          ...last.blocks.slice(0, insertAt),
          resultBlock,
          ...last.blocks.slice(insertAt),
        ];
        return { ...state, messages: msgs };
      }
      return {
        ...state,
        messages: [
          ...messagesWithoutPriorResult,
          {
            id: randomId(),
            role: "assistant" as const,
            content: "",
            timestamp: Date.now(),
            blocks: [resultBlock],
          },
        ],
      };
    }

    case "SET_CHECKPOINT": {
      // Attach checkpointId to the user message immediately before this checkpoint.
      // `turnIndex` is a snapshot user-turn count, so the visible row is
      // `turnIndex - 1`, adjusted by any loaded history offset.
      const checkpoint = {
        turnIndex: action.turnIndex,
        checkpointId: action.checkpointId,
      };
      const applied = applyCheckpointToMessages(
        state.messages,
        checkpoint,
        state.loadedUserTurnOffset,
      );
      if (applied.applied) {
        return { ...state, messages: applied.messages };
      }
      const exists = state.pendingCheckpoints.some(
        (cp) =>
          cp.turnIndex === checkpoint.turnIndex &&
          cp.checkpointId === checkpoint.checkpointId,
      );
      if (exists) {
        return state;
      }
      return {
        ...state,
        pendingCheckpoints: [...state.pendingCheckpoints, checkpoint],
      };
    }

    default:
      return state;
  }
}

export const initialState: AppState = {
  messages: [],
  originalPrompt: null,
  chatState: {
    sessionId: null,
    mode: "code",
    model: "",
    streaming: false,
    reasoningEffort: "high",
    thinkingEnabled: true,
  },
  streaming: false,
  thinkingEnabled: true,
  lastInputTokens: 0,
  lastOutputTokens: 0,
  lastCacheReadTokens: 0,
  estimatedTotalUsed: 0,
  contextHealth: null,
  debugInfo: null,
  systemPrompt: null,
  loadedInstructions: null,
  todos: [],
  modes: [
    { slug: "code", name: "Code", icon: "code" },
    { slug: "architect", name: "Architect", icon: "organization" },
    { slug: "ask", name: "Ask", icon: "question" },
    { slug: "debug", name: "Debug", icon: "debug" },
    { slug: "review", name: "Review", icon: "checklist" },
  ],
  availableModels: [],
  slashCommands: [],
  messageQueue: [],
  approvalRequest: null,
  questionRequest: null,
  detectedQuestion: null,
  dismissedDetectedQuestionIds: [],
  statusOverride: null,
  restoringSession: false,
  revertRecoveryNotice: null,
  loadedUserTurnOffset: 0,
  pendingCheckpoints: [],
  pendingFinalMarker: null,
};
