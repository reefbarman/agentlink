import type {
  CondenseMetadata,
  McpApprovalPromotionMeta,
  RequestContextBreakdown,
  ToolResult,
  ToolResultContextAttribution,
} from "../shared/types.js";
import type { MessageParam, ReasoningEffort } from "./providers/types.js";

import type { CoreModelToolResultBlock } from "../core/modelRuntime.js";
import type { FinalMessageMarker } from "../shared/finalStatus.js";
import type { SessionProjectScope } from "../core/workspaceProjects.js";
import type { TodoItem } from "./todoTool.js";

// --- Agent Message (conversation history with condense metadata) ---

/**
 * Extends MessageParam with non-destructive condense tracking.
 * - isSummary: marks this message as a condensation summary
 * - condenseId: UUID set on the summary message
 * - condenseParent: UUID of the summary that replaced this message
 *   (messages with condenseParent are filtered from API history when their summary exists)
 */
export interface AgentErrorActions {
  signIn?: boolean;
  signInAnotherAccount?: boolean;
  condense?: boolean;
}

export interface AgentRuntimeError {
  message: string;
  retryable: boolean;
  code?: string;
  actions?: AgentErrorActions;
}

export interface PreservedRuntimeContext {
  toolNames: string[];
  mcpServerNames?: string[];
  activeSkills?: string[];
  /** Canonical task state reattached after context condensation. */
  todos?: TodoItem[];
}

export type AgentMessage = MessageParam & {
  /**
   * Pasted media (images/PDFs) attached to this user message. Kept out of
   * `content` so user turns stay string-typed (turn counting, checkpoints,
   * titles rely on that); AgentEngine injects these as image/document blocks
   * into every API request so the model retains access across turns. Persisted
   * with the message; dropped from API requests once the message is condensed.
   */
  media?: {
    images: Array<{ name: string; mimeType: string; base64: string }>;
    documents: Array<{ name: string; mimeType: string; base64: string }>;
  };
  isSummary?: boolean;
  isResumeContext?: boolean;
  condenseId?: string;
  condenseParent?: string;
  preservedContext?: PreservedRuntimeContext;
  runtimeError?: AgentRuntimeError;
  /** Persisted transcript-only diagnostic; never sent to providers or condensation. */
  diagnosticOnly?: boolean;
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
    surfaceChange?: {
      model?: { previousModel: string; model: string };
      reasoning?: {
        previousReasoningEffort: ReasoningEffort;
        reasoningEffort: ReasoningEffort;
      };
      mode?: { previousMode: string; mode: string };
    };
    /**
     * Display metadata for the ordinary first user turn of a fresh-session
     * handoff. The complete turn remains normal provider history.
     */
    handoff?: {
      schemaVersion: 1;
      sourceSessionId: string;
      sourceTitle: string;
      handoffId: string;
    };
    finalMarker?: FinalMessageMarker;
  };
};

// --- Agent Events (emitted by AgentEngine) ---

export type AgentEvent =
  | { type: "thinking_start"; thinkingId: string }
  | { type: "thinking_delta"; thinkingId: string; text: string }
  | { type: "thinking_end"; thinkingId: string }
  | { type: "text_delta"; text: string }
  | {
      type: "tool_start";
      toolCallId: string;
      toolName: string;
      parentCallId?: string;
      input?: unknown;
    }
  | {
      type: "tool_input_delta";
      toolCallId: string;
      partialJson: string;
    }
  | {
      type: "tool_result";
      toolCallId: string;
      toolName: string;
      result: ToolResult["content"];
      /** Canonical provider-history form, computed once by the engine. */
      historyContent?: CoreModelToolResultBlock["content"];
      durationMs: number;
      input?: unknown;
      parentCallId?: string;
      mcpApprovalPromotion?: McpApprovalPromotionMeta;
      composeTrace?: import("../shared/composeTypes.js").ComposeTrace;
    }
  | { type: "todo_update"; todos: TodoItem[] }
  | { type: "final_marker"; marker: FinalMessageMarker | null }
  | {
      type: "checkpoint_created";
      checkpointId: string;
      /** Number of visible user turns already committed at the checkpoint snapshot. */
      turnIndex: number;
    }
  | { type: "condense_start"; isAutomatic: boolean }
  | {
      type: "condense";
      /** Short summary of what was condensed (first ~100 chars of LLM output) */
      summary: string;
      /** Input tokens before condensing */
      prevInputTokens: number;
      /** Estimated input tokens after condensing */
      newInputTokens: number;
      /** Duration in ms for this condense operation */
      durationMs?: number;
      /** Non-fatal validator/retry warnings for this condense run */
      validationWarnings?: string[];
      metadata?: CondenseMetadata;
    }
  | {
      type: "condense_error";
      error: string;
      retryable?: boolean;
      code?: string;
      actions?: AgentErrorActions;
    }
  | {
      type: "api_request_start";
      requestId: string;
      provider: string;
      model: string;
      startedAt: number;
      schedulerQueued: boolean;
    }
  | {
      /** Privacy-safe composition snapshot for one physical provider invocation. */
      type: "request_context_attribution";
      requestId: string;
      requestKind: "agent" | "condense";
      model: string;
      estimatedInputTokens: number;
      toolResultContextAttributions: ToolResultContextAttribution[];
      omittedToolResultContextAttributions: number;
      pinnedMemoryTokens: number;
      retrievedMemoryTokens: number;
      contextLedger?: import("../core/contextLedger.js").ContextLedgerSnapshot;
    }
  | {
      type: "api_request";
      requestId: string;
      model: string;
      reasoningEffort: ReasoningEffort;
      inputTokens: number;
      uncachedInputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
      usageEstimated?: boolean;
      durationMs: number;
      timeToFirstToken: number;
      providerQueueWaitMs?: number;
      usedPreviousResponseId?: boolean;
      previousResponseIdFallback?: boolean;
      promptCacheKey?: string;
      promptCacheRetention?: "in_memory" | "24h";
      storeResponseState?: boolean;
      providerResponseId?: string;
      contextBreakdown?: RequestContextBreakdown;
      /** Engine-side estimate of content appended since the previous response. */
      accumulatedEstimatedTokens?: number;
      /** Per-source split of that estimate (e.g. "tool:read_file") for jump attribution. */
      accumulatedEstimatedTokensBySource?: Record<string, number>;
      /** Bounded per-result byte/token detail retained behind tool source totals. */
      toolResultContextAttributions?: ToolResultContextAttribution[];
      omittedToolResultContextAttributions?: number;
      /** Stage 0 ledger placeholders; populated by the typed memory path in later stages. */
      pinnedMemoryTokens?: number;
      retrievedMemoryTokens?: number;
    }
  | {
      type: "warning";
      message: string;
      modelFallback?: {
        requestedModel: string;
        effectiveModel: string;
      };
      /** Defaults to true. Set false for transient retry notices that should remain log/trace-only. */
      visible?: boolean;
      retryDelayMs?: number;
      retryAt?: number;
      retryAttempt?: number;
      retryMaxAttempts?: number;
    }
  | { type: "status_update"; message: string }
  | {
      type: "error";
      error: string;
      retryable: boolean;
      code?: string;
      actions?: AgentErrorActions;
    }
  | {
      type: "done";
      totalInputTokens: number;
      totalOutputTokens: number;
      totalCacheReadTokens: number;
      totalCacheCreationTokens: number;
    }
  | {
      type: "user_interjection";
      text: string;
      queueId: string;
      displayText?: string;
      isSlashCommand?: boolean;
      slashCommandLabel?: string;
      images?: Array<{ name: string; mimeType: string; base64: string }>;
      documents?: Array<{ name: string; mimeType: string; base64: string }>;
    };

// --- Session types ---

export type SessionStatus =
  | "queued"
  | "idle"
  | "streaming"
  | "tool_executing"
  | "awaiting_approval"
  | "error";

export type InteractiveExecutionPhase =
  | "queued_for_workspace_write"
  | "queued_for_provider"
  | "running"
  | "awaiting_input"
  | "stopping";

export interface SessionInfo {
  id: string;
  status: SessionStatus;
  interactiveExecutionPhase?: InteractiveExecutionPhase;
  mode: string;
  model: string;
  title: string;
  messageCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  background: boolean;
  createdAt: number;
  lastActiveAt: number;
  projectScope: SessionProjectScope;
  projectAvailability: import("./AgentSession.js").SessionProjectAvailabilityStatus;
}

// --- Configuration ---

export interface AgentConfig {
  model: string;
  maxTokens: number;
  thinkingBudget: number;
  showThinking: boolean;
  autoCondense: boolean;
  autoCondenseThreshold: number; // 0–1, e.g. 0.9 = 90%
  codexStatefulResponses?: boolean;
  codexStoreResponses?: boolean;
  codexProMode?: boolean;
  /** Exact model-ID prompt profile overrides from reviewed configuration. */
  promptProfileOverrides?: Record<
    string,
    import("../core/promptProfile.js").PromptProfile
  >;
  /** Exact canonical skill IDs disabled by reviewed workspace configuration. */
  disabledSkillIds?: string[];
}
