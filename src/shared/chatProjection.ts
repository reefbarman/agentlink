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

import type { DetectedQuestion } from "./questionDetection.js";
import type {
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

const BUILTIN_TOOL_NAMES = new Set([
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

function getAskUserContextFromInput(input: unknown): string {
  if (!input || typeof input !== "object" || Array.isArray(input)) return "";
  const context = (input as Record<string, unknown>).context;
  return typeof context === "string" ? context.trim() : "";
}

function addQuestionContextMessage(
  messages: ChatMessage[],
  questionId: string,
  context: string,
): ChatMessage[] {
  const trimmed = context.trim();
  if (!trimmed) return messages;

  const messageId = `question-context-${questionId}`;
  if (messages.some((message) => message.id === messageId)) return messages;

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

function inferBgResultStatus(
  resultText: string,
): "completed" | "error" | "cancelled" {
  const normalized = resultText.trim().toLowerCase();
  if (!normalized) return "completed";
  if (normalized.startsWith("background agent stopped:")) {
    return normalized.includes("cancel") ? "cancelled" : "error";
  }
  return "completed";
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
  }>;
  questionRequest: {
    id: string;
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
  | { type: "SET_STATE"; state: ChatState }
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
      type: "API_REQUEST";
      requestId: string;
      model: string;
      inputTokens: number;
      uncachedInputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens?: number;
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
  | { type: "TOOL_START"; toolCallId: string; toolName: string }
  | { type: "TOOL_INPUT_DELTA"; toolCallId: string; partialJson: string }
  | {
      type: "TOOL_COMPLETE";
      toolCallId: string;
      toolName: string;
      result: string;
      durationMs: number;
      input?: unknown;
      mcpApprovalPromotion?: McpApprovalPromotionMeta;
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
  | { type: "REMOVE_FROM_QUEUE"; id: string }
  | { type: "CLEAR_QUEUE" }
  | {
      type: "ADD_INTERJECTION";
      text: string;
      isSlashCommand?: boolean;
      slashCommandLabel?: string;
      displayMedia?: DisplayMedia;
    }
  | {
      type: "SET_QUESTION";
      id: string;
      context: string;
      questions: Question[];
      backgroundTask?: string;
    }
  | { type: "CLEAR_QUESTION" }
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
      mode: string;
      model: string;
      messages: ChatMessage[];
      lastInputTokens?: number;
      lastOutputTokens?: number;
      /**
       * Checkpoints are keyed by user-turn count at snapshot time.
       * `turnIndex=1` maps to the first user message row, `2` to the second, etc.
       */
      checkpoints?: Array<{ turnIndex: number; checkpointId: string }>;
      userTurnOffset?: number;
      hasMoreBefore?: boolean;
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
      sessionId: string;
      task: string;
      status: "completed" | "error" | "cancelled";
      resultText?: string;
      summary?: string;
    }
  | { type: "TOKEN_ESTIMATE"; estimatedTotalUsed: number };

/**
 * Convert persisted AgentMessage[] (Anthropic API format) to ChatMessage[] (webview display format).
 * Tool-result user messages are filtered out as they're internal plumbing.
 * Condense summary messages are rendered as condense rows.
 */
export function agentMessagesToChatMessages(raw: unknown[]): ChatMessage[] {
  const stripSystemReminderBlocks = (text: string): string =>
    text
      .replace(/<system-reminder>[\s\S]*?<\/system-reminder>\n*/gi, "")
      .trim();

  const getSummaryText = (content: unknown): string => {
    if (typeof content === "string") return stripSystemReminderBlocks(content);
    if (!Array.isArray(content)) return "";
    const joined = (content as Array<{ type: string; text?: string }>)
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");
    return stripSystemReminderBlocks(joined);
  };

  // First pass: collect tool results keyed by tool_use_id
  const toolResults = new Map<string, string>();
  for (const msg of raw) {
    const m = msg as { role: string; content: unknown };
    if (m.role === "user" && Array.isArray(m.content)) {
      for (const block of m.content as Array<{
        type: string;
        tool_use_id?: string;
        content?: unknown;
      }>) {
        if (block.type === "tool_result" && block.tool_use_id) {
          const text = Array.isArray(block.content)
            ? (block.content as Array<{ type: string; text?: string }>)
                .filter((c) => c.type === "text")
                .map((c) => c.text ?? "")
                .join("\n")
            : typeof block.content === "string"
              ? block.content
              : "";
          toolResults.set(block.tool_use_id, text);
        }
      }
    }
  }

  // Second pass: build ChatMessages
  const result: ChatMessage[] = [];
  for (const msg of raw) {
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
      const summaryText = getSummaryText(m.content);
      const hint = m.uiHint?.condense;
      result.push({
        id: crypto.randomUUID(),
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
      if (summaryText) {
        result.push({
          id: crypto.randomUUID(),
          role: "assistant",
          content: "",
          timestamp: Date.now(),
          blocks: [{ type: "text", text: summaryText }],
        });
      }
      continue;
    }

    if (m.role === "user") {
      if (typeof m.content === "string") {
        const hint = m.uiHint?.userMessage;
        result.push({
          id: crypto.randomUUID(),
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
      for (const block of contentArr as Array<{
        type: string;
        text?: string;
        id?: string;
        name?: string;
        input?: unknown;
        thinking?: string;
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
        } else if (block.type === "thinking" && block.thinking?.trim()) {
          blocks.push({
            type: "thinking",
            id: block.id ?? crypto.randomUUID(),
            text: block.thinking,
            complete: true,
          });
        } else if (block.type === "tool_use") {
          const toolId = block.id ?? crypto.randomUUID();
          const toolName = normalizeProjectedToolName(block.name ?? "");
          const toolResult = toolResults.get(toolId) ?? "";
          const inputJson = JSON.stringify(block.input ?? {});
          if (toolName === "set_task_status" && toolId === finalMarkerToolId) {
            continue;
          }
          const askUserContext =
            toolName === "ask_user"
              ? getAskUserContextFromInput(block.input)
              : "";
          if (askUserContext) {
            blocks.push({ type: "text", text: askUserContext });
          }

          if (toolName === "load_skill") {
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
              complete: true,
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
              complete: true,
            });

            if (sessionId) {
              const status = inferBgResultStatus(toolResult);
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
                status,
                resultText: toolResult || undefined,
                summary: undefined,
              });
            }
          } else {
            blocks.push({
              type: "tool_call",
              id: toolId,
              name: toolName,
              inputJson,
              result: toolResult,
              complete: true,
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
      if (visibleBlocks.length > 0 || hasRuntimeError || finalMarker) {
        result.push({
          id: crypto.randomUUID(),
          role: "assistant",
          content: "",
          timestamp: Date.now(),
          blocks: visibleBlocks,
          finalMarker,
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
      id: crypto.randomUUID(),
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
    case "SET_STATE":
      return {
        ...state,
        chatState: action.state,
        streaming: action.state.streaming,
        thinkingEnabled: action.state.thinkingEnabled ?? state.thinkingEnabled,
        revertRecoveryNotice: Object.hasOwn(
          action.state,
          "revertRecoveryNotice",
        )
          ? (action.state.revertRecoveryNotice ?? null)
          : state.revertRecoveryNotice,
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
          id: action.id ?? crypto.randomUUID(),
          role: "user" as const,
          content: action.text,
          timestamp: Date.now(),
          blocks: [],
          isSlashCommand: action.isSlashCommand,
          slashCommandLabel: action.slashCommandLabel,
          displayMedia: action.displayMedia,
        },
        {
          id: crypto.randomUUID(),
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
            id: crypto.randomUUID(),
            role: "user",
            content: action.text,
            badge: action.badge,
            timestamp: Date.now(),
            blocks: [],
          },
          {
            id: crypto.randomUUID(),
            role: "assistant",
            content: "",
            timestamp: Date.now(),
            blocks: [],
          },
        ],
      };

    case "THINKING_START": {
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
      const all = ensureAssistant(state.messages);
      const { msgs, last } = cloneLast(all);
      last.blocks.push(
        action.toolName === "load_skill"
          ? {
              type: "skill_load",
              id: action.toolCallId,
              inputJson: "",
              result: "",
              complete: false,
            }
          : {
              type: "tool_call",
              id: action.toolCallId,
              name: action.toolName,
              inputJson: "",
              result: "",
              complete: false,
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
          ? { ...b, inputJson: b.inputJson + action.partialJson }
          : b,
      );
      tiMsgs[tiIdx] = tiTarget;
      return { ...state, messages: tiMsgs };
    }

    case "TOOL_COMPLETE": {
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
      if (targetIdx === -1) return state; // tool_call not found — no-op

      const msgs = [...state.messages];
      const target = { ...msgs[targetIdx] };
      target.blocks = target.blocks.map((b) => {
        if (
          (b.type === "tool_call" || b.type === "skill_load") &&
          b.id === action.toolCallId
        ) {
          const nextBase = {
            ...b,
            inputJson:
              b.inputJson !== "" || action.input === undefined
                ? b.inputJson
                : JSON.stringify(action.input),
            result: action.result,
            complete: true,
            durationMs: action.durationMs,
            ...(b.type === "tool_call"
              ? { mcpApprovalPromotion: action.mcpApprovalPromotion }
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

      // When ask_user completes, add a question_answer summary block
      if (action.toolName === "ask_user") {
        try {
          const parsed = JSON.parse(action.result);
          if (parsed.responses && Array.isArray(parsed.responses)) {
            const items = parsed.responses.map(
              (r: { question: string; answer: unknown; note?: string }) => ({
                question: r.question ?? "",
                answer: r.answer ?? null,
                ...(r.note ? { note: r.note } : {}),
              }),
            );
            if (items.length > 0) {
              target.blocks = [
                ...target.blocks,
                { type: "question_answer" as const, items },
              ];
              msgs[targetIdx] = target;
            }
          }
        } catch {
          // ignore parse error
        }
      }

      // When get_background_result completes, add a visible result block so
      // the output is not only available inside the raw tool-call details.
      if (action.toolName === "get_background_result") {
        const toolBlock = target.blocks.find(
          (b) => b.type === "tool_call" && b.id === action.toolCallId,
        );
        const sessionId = getBgSessionIdFromToolInput(
          action.input,
          toolBlock?.type === "tool_call" ? toolBlock.inputJson : undefined,
        );

        if (sessionId) {
          const alreadyAdded = target.blocks.some(
            (b) => b.type === "bg_agent_result" && b.sessionId === sessionId,
          );
          if (!alreadyAdded) {
            target.blocks = [
              ...target.blocks,
              {
                type: "bg_agent_result",
                sessionId,
                task: findBgTaskForSession(msgs, target.blocks, sessionId),
                status: inferBgResultStatus(action.result),
                resultText: action.result || undefined,
                summary: undefined,
              },
            ];
            msgs[targetIdx] = target;
          }
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

    case "API_REQUEST": {
      if (state.messages.length === 0) return state;
      const { msgs, last } = cloneLast(state.messages);
      last.apiRequest = {
        requestId: action.requestId,
        model: action.model,
        inputTokens: action.inputTokens,
        uncachedInputTokens: action.uncachedInputTokens,
        cacheReadTokens: action.cacheReadTokens,
        cacheCreationTokens: action.cacheCreationTokens,
        outputTokens: action.outputTokens,
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
      return { ...state, pendingFinalMarker: marker };
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
        secondToLast?.role === "condense"
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
        questionRequest: null,
        detectedQuestion: null,
        dismissedDetectedQuestionIds: [],
        statusOverride: null,
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
          id: crypto.randomUUID(),
          role: "user" as const,
          content: action.text,
          timestamp: Date.now(),
          blocks: [],
          isSlashCommand: action.isSlashCommand,
          slashCommandLabel: action.slashCommandLabel,
          displayMedia: action.displayMedia,
        },
        {
          id: crypto.randomUUID(),
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
          id: action.id ?? crypto.randomUUID(),
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
          id: crypto.randomUUID(),
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
        streaming: true,
        messages: appliedPending.messages,
        pendingCheckpoints: appliedPending.pending,
      };
    }

    case "SET_QUESTION": {
      const messages = addQuestionContextMessage(
        state.messages,
        action.id,
        action.context,
      );
      return {
        ...state,
        messages,
        questionRequest: {
          id: action.id,
          context: action.context,
          questions: action.questions,
          ...(action.backgroundTask
            ? { backgroundTask: action.backgroundTask }
            : {}),
        },
      };
    }

    case "CLEAR_QUESTION":
      return { ...state, questionRequest: null };

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
        tail?.role === "assistant" && tail.blocks.length === 0 && !tail.error
          ? state.messages.slice(0, -1)
          : state.messages;
      return {
        ...state,
        streaming: true,
        messages: [
          ...base,
          {
            id: crypto.randomUUID(),
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
      // Remove any trailing empty assistant placeholder (added optimistically by ADD_USER_MESSAGE)
      // Also remove the pending condense row (condensing: true) if present
      const filtered = state.messages.filter(
        (m) => !(m.role === "condense" && m.condenseInfo?.condensing),
      );
      return {
        ...state,
        messages: [
          ...filtered,
          {
            id: crypto.randomUUID(),
            role: "condense" as const,
            content: "",
            timestamp: Date.now(),
            blocks: [],
            condenseInfo: {
              prevInputTokens: action.prevInputTokens,
              newInputTokens: action.newInputTokens,
              durationMs: action.durationMs,
              validationWarnings: action.validationWarnings,
            },
          },
          // Add an empty assistant placeholder so the streaming dots appear
          // immediately after condensing while waiting for the next API response.
          // DONE strips this if the agent ends without producing any content.
          {
            id: crypto.randomUUID(),
            role: "assistant" as const,
            content: "",
            timestamp: Date.now(),
            blocks: [],
          },
        ],
        lastInputTokens: action.newInputTokens,
        lastOutputTokens: 0,
        lastCacheReadTokens: 0,
      };
    }

    case "ADD_WARNING": {
      return {
        ...state,
        messages: [
          ...state.messages,
          {
            id: crypto.randomUUID(),
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
            id: crypto.randomUUID(),
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
      const withCondenseRow = [
        ...filtered,
        {
          id: crypto.randomUUID(),
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
      ];

      if (!action.retryable && !action.code && !action.actions) {
        return {
          ...state,
          messages: withCondenseRow,
          statusOverride: null,
        };
      }

      const all = ensureAssistant(withCondenseRow);
      const { msgs, last } = cloneLast(all);
      last.error = {
        message: action.errorMessage,
        retryable: action.retryable ?? false,
        code: action.code,
        actions: action.actions,
      };

      return {
        ...state,
        messages: msgs,
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
      return {
        ...state,
        messages: applied.messages,
        streaming: false,
        restoringSession: false,
        loadedUserTurnOffset: userTurnOffset,
        pendingCheckpoints: applied.pending,
        pendingFinalMarker: null,
        lastInputTokens: action.lastInputTokens ?? 0,
        lastOutputTokens: action.lastOutputTokens ?? 0,
        todos: [],
        messageQueue: [],
        questionRequest: null,
        detectedQuestion: null,
        dismissedDetectedQuestionIds: [],
        chatState: {
          ...state.chatState,
          sessionId: action.sessionId,
          mode: action.mode,
          model: action.model,
          streaming: false,
        },
      };
    }

    case "PREPEND_SESSION_CHUNK": {
      const prepended = [...action.messages, ...state.messages];
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
      // Insert a bg_agent_result notification at the current position in chat.
      // If the last message is an assistant message, append the block to it.
      // Otherwise, create a new assistant message for the notification.
      const resultBlock: ContentBlock = {
        type: "bg_agent_result",
        sessionId: action.sessionId,
        task: action.task,
        status: action.status,
        resultText: action.resultText,
        summary: action.summary,
      };
      const lastMsg = state.messages[state.messages.length - 1];
      if (lastMsg?.role === "assistant") {
        const { msgs, last } = cloneLast(state.messages);
        last.blocks = [...last.blocks, resultBlock];
        return { ...state, messages: msgs };
      }
      return {
        ...state,
        messages: [
          ...state.messages,
          {
            id: crypto.randomUUID(),
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
  chatState: {
    sessionId: null,
    mode: "code",
    model: "claude-sonnet-4-6",
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
