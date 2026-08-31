import type {
  BackgroundCompletionResult,
  InFlightAssistantBlock,
} from "@agentlink/protocol/session-hydration";
import type {
  ChatModeInfo,
  ChatModelInfo,
  ChatProjectInfo,
  ChatReasoningEffort,
  ChatSlashCommandInfo,
} from "@agentlink/protocol/chat-catalog";
import type {
  ChatTabActionConfirmationRequest,
  ChatTabActionFailure,
  ChatTabActionRejection,
  ChatWorkspaceViewSnapshot,
} from "@agentlink/protocol/chat-workspace";
import type {
  McpConfigMutationResult,
  McpConfigSnapshot,
  McpManagerView,
} from "@agentlink/protocol/mcp-manager";
import type {
  MemoryPanelSnapshot,
  MemoryToolScope,
} from "@agentlink/protocol/autonomous-memory";
import type {
  ChatMessage as ProtocolChatMessage,
  ContentBlock as ProtocolContentBlock,
  TodoItem as ProtocolTodoItem,
} from "@agentlink/protocol/chat-transcript";
import type {
  StructuredQuestionRequest,
  UserQuestion,
} from "@agentlink/protocol/structured-question";

import type { AgentPluginManagerSnapshot } from "@agentlink/protocol/agent-plugin-manager";
import type { ChatSessionHistorySummary } from "@agentlink/protocol/chat-session-history";
import type { ChatStateSnapshot } from "@agentlink/protocol/chat-state";
import type { CommandApprovalPolicy } from "@agentlink/protocol/command-approval-policy";
import type { ComposeTrace } from "@agentlink/protocol/compose";
import type { LoadedInstructionDebugInfo } from "../../shared/chatProjection.js";
import type { McpApprovalPromotionMeta } from "@agentlink/protocol/tool-result";
import type { McpFormElicitationRequest } from "@agentlink/protocol/mcp-elicitation";
import type { McpUrlElicitationRequest } from "@agentlink/protocol/mcp-url-elicitation";
import type { MemoryRecordDetail } from "@agentlink/protocol/autonomous-memory";
import type { RequestContextBreakdown } from "@agentlink/protocol/context-diagnostics";

export type ProjectInfo = ChatProjectInfo;
export type ModeInfo = ChatModeInfo;
export type ReasoningEffort = ChatReasoningEffort;
export type WebviewModelInfo = ChatModelInfo;
export type SlashCommandInfo = ChatSlashCommandInfo;

export interface ProviderUsageCardData {
  providers: Array<{
    providerId: string;
    providerName: string;
    available: boolean;
    reason?: string;
    accountLabel?: string;
    accountSource?: string;
    switchAccountInstructions?: string;
    planType?: string;
    rateLimits?: Array<{
      id: string;
      name?: string;
      primary?: { usedPercent: number; resetsAt: number | null };
      secondary?: { usedPercent: number; resetsAt: number | null };
    }>;
    lifetimeTokens?: number;
    peakDailyTokens?: number;
    resetCredits?: number;
  }>;
  queriedAt: number;
}

/** A question posed by the agent via the ask_user tool. */
export type Question = UserQuestion;
export type QuestionRequest = StructuredQuestionRequest;

/** Consumption vs. limits for a /btw side question, shown as a visible budget. */
export interface BtwBudget {
  apiTurns: number;
  maxApiTurns: number;
  toolCalls: number;
  maxToolCalls: number;
}

export interface WorktreeSetupConfig {
  task: string;
  prompt: string;
  sourcePath?: string;
  branch?: string;
  baseRef?: string;
  fetchRef?: {
    repository: string;
    ref: string;
  };
  worktreePath?: string;
  mode?: string;
  autoSubmit?: boolean;
}

export interface WorktreeSetupState {
  requestId: string;
  input: string;
  answer: string;
  phase:
    | "configuring"
    | "awaiting_input"
    | "ready"
    | "launching"
    | "opened"
    | "rejected"
    | "cancelled"
    | "error";
  config?: WorktreeSetupConfig;
  message?: string;
  tools?: string[];
  warnings?: string[];
  budget?: BtwBudget;
  conversation?: Array<{ role: "user" | "assistant"; text: string }>;
}

/** Messages from extension to webview */
export type ExtensionMessage =
  | { type: "stateUpdate"; state: ChatState }
  | {
      type: "agentHandoffDraft";
      draft: import("../sessionHandoff.js").SessionHandoffDraft;
    }
  | {
      type: "agentHandoffResult";
      ok: boolean;
      successorSessionId?: string;
      error?: string;
    }
  | { type: "hostHeartbeat"; at: number }
  | { type: "chatWorkspaceUpdate"; snapshot: ChatWorkspaceViewSnapshot }
  | {
      type: "chatTabActionConfirmationRequested";
      request: ChatTabActionConfirmationRequest;
    }
  | { type: "chatTabActionRejected"; rejection: ChatTabActionRejection }
  | { type: "chatTabActionFailed"; failure: ChatTabActionFailure }
  | { type: "agentThinkingStart"; sessionId: string; thinkingId: string }
  | {
      type: "agentThinkingDelta";
      sessionId: string;
      thinkingId: string;
      text: string;
    }
  | { type: "agentThinkingEnd"; sessionId: string; thinkingId: string }
  | { type: "agentTextDelta"; sessionId: string; text: string }
  | {
      type: "agentToolStart";
      sessionId: string;
      toolCallId: string;
      toolName: string;
      parentCallId?: string;
      input?: unknown;
    }
  | {
      type: "agentToolInputDelta";
      sessionId: string;
      toolCallId: string;
      partialJson: string;
    }
  | {
      type: "agentToolComplete";
      sessionId: string;
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
  | {
      type: "agentUserAnnotation";
      sessionId: string;
      text: string;
      badge: "follow-up" | "rejection";
    }
  | {
      type: "agentSurfaceChange";
      sessionId: string;
      change: NonNullable<ChatMessage["surfaceChange"]>;
    }
  | {
      type: "agentApiRequest";
      sessionId: string;
      requestId: string;
      model: string;
      reasoningEffort: ReasoningEffort;
      mode?: string;
      commandApprovalPolicy?: CommandApprovalPolicy;
      inputTokens: number;
      uncachedInputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
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
      type: "agentError";
      sessionId: string;
      error: string;
      retryable: boolean;
      code?: string;
      actions?: {
        signIn?: boolean;
        signInAnotherAccount?: boolean;
        condense?: boolean;
      };
    }
  | {
      type: "agentDone";
      sessionId: string;
      /** Transcript revision after the completed turn's final deltas were committed. */
      transcriptRevision?: number;
      totalInputTokens: number;
      totalOutputTokens: number;
      totalCacheReadTokens: number;
      totalCacheCreationTokens: number;
    }
  | { type: "agentInteractionPromptsCleared"; sessionId: string }
  | { type: "agentTodoUpdate"; sessionId: string; todos: TodoItem[] }
  | {
      type: "agentFinalMarker";
      sessionId: string;
      marker:
        | import("@agentlink/protocol/final-status").FinalMessageMarker
        | null;
    }
  | {
      type: "agentCheckpointCreated";
      sessionId: string;
      checkpointId: string;
      turnIndex: number;
    }
  | {
      type: "agentCondense";
      sessionId: string;
      prevInputTokens: number;
      newInputTokens: number;
      /** First ~200 chars of the summary for display */
      summary: string;
      durationMs: number;
      validationWarnings?: string[];
    }
  | {
      type: "agentCondenseError";
      sessionId: string;
      error: string;
      retryable?: boolean;
      code?: string;
      actions?: {
        signIn?: boolean;
        signInAnotherAccount?: boolean;
        condense?: boolean;
      };
    }
  | {
      type: "agentCondenseStart";
      sessionId: string;
      isAutomatic: boolean;
    }
  | {
      type: "agentTokenEstimate";
      sessionId: string;
      /** Running estimate of total context window usage (tokens). */
      estimatedTotalUsed: number;
    }
  | {
      type: "agentWarning";
      sessionId: string;
      message: string;
      retryDelayMs?: number;
      retryAt?: number;
      retryAttempt?: number;
      retryMaxAttempts?: number;
    }
  | {
      type: "agentStatusUpdate";
      sessionId: string;
      message: string;
    }
  | { type: "agentSessionUpdate"; sessions: SessionInfo[] }
  | {
      type: "agentDebugInfo";
      sessionId?: string;
      info: Record<string, string | number>;
      systemPrompt?: string;
      loadedInstructions?: LoadedInstructionDebugInfo[];
    }
  | {
      type: "agentFileSearchResults";
      requestId: string;
      files: Array<{ path: string; kind: "file" | "folder" }>;
    }
  | {
      type: "agentOpenFileResult";
      requestId: string;
      ok: boolean;
      error?: "not_found" | "open_failed";
    }
  | {
      type: "agentDetectQuestionResult";
      requestId: string;
      messageId: string;
      detected:
        | import("@agentlink/protocol/question-detection").DetectedQuestion
        | null;
      fallback: boolean;
    }
  | {
      type: "agentInjectPrompt";
      prompt: string;
      attachments: string[];
      autoSubmit?: boolean;
    }
  | { type: "agentInjectAttachment"; path: string }
  | { type: "agentInjectContext"; context: string }
  | { type: "agentModesUpdate"; modes: ModeInfo[] }
  | { type: "agentModelsUpdate"; models: WebviewModelInfo[] }
  | { type: "agentSlashCommandsUpdate"; commands: SlashCommandInfo[] }
  | { type: "agentProviderUsage"; data: ProviderUsageCardData }
  | { type: "agentModeSwitchRequest"; mode: string; reason?: string }
  | {
      type: "agentFormElicitationRequest";
      sessionId?: string;
      request: McpFormElicitationRequest;
    }
  | { type: "agentFormElicitationCleared"; sessionId?: string; id: string }
  | {
      type: "agentUrlElicitationRequest";
      sessionId?: string;
      request: McpUrlElicitationRequest;
    }
  | { type: "agentUrlElicitationCleared"; sessionId?: string; id: string }
  | {
      type: "agentMcpStatus";
      open?: boolean;
      view?: McpManagerView;
      infos: Array<{
        name: string;
        status: string;
        error?: string;
        toolCount: number;
        resourceCount: number;
        promptCount: number;
        tools: Array<{ name: string; description?: string }>;
      }>;
      configSnapshot?: McpConfigSnapshot;
    }
  | { type: "agentMcpConfigMutationResult"; result: McpConfigMutationResult }
  | {
      type: "agentPluginManagerSnapshot";
      open?: boolean;
      snapshot: AgentPluginManagerSnapshot;
    }
  | {
      type: "agentMemoryPanelUpdate";
      requestId?: string;
      open?: boolean;
      scope: MemoryToolScope;
      availableScopes: MemoryToolScope[];
      snapshot?: MemoryPanelSnapshot;
      selected?: MemoryRecordDetail | null;
      error?: string;
    }
  | {
      type: "showApproval";
      sessionId?: string;
      request: import("@agentlink/protocol/approval-transport").ApprovalRequest;
    }
  | { type: "idle"; sessionId?: string; id: string }
  | {
      type: "regexSuggestion";
      requestId: string;
      pattern?: string;
      error?: string;
    }
  | {
      type: "promptPolishResult";
      requestId: string;
      polished?: string;
      error?: string;
    }
  | ({
      type: "agentQuestionRequest";
      sessionId?: string;
    } & QuestionRequest)
  | { type: "agentQuestionCleared"; sessionId?: string; id: string }
  | {
      type: "agentQuestionProgress";
      sessionId?: string;
      id: string;
      step: number;
      answers: Record<string, string | string[] | number | boolean | undefined>;
      notes: Record<string, string>;
      origin: string;
    }
  | { type: "agentDroppedFilesResolved"; files: string[] }
  | {
      type: "agentSessionList";
      sessions: SessionSummary[];
    }
  | { type: "agentRestoreSessionStart" }
  | { type: "agentRestoreSessionDone" }
  | {
      type: "agentSessionLoaded";
      sessionId: string;
      /** Monotonic transcript mutation counter used to reject stale hydrations. */
      transcriptRevision?: number;
      title: string;
      /** Original visible user prompt, independent of the paginated message tail. */
      originalPrompt?: string;
      mode: string;
      model: string;
      messages: unknown[];
      /** Absolute index of `messages[0]` in the full persisted transcript (deterministic rehydration ids). */
      messageIndexOffset?: number;
      todos: TodoItem[];
      lastInputTokens: number;
      lastOutputTokens: number;
      /** Durable child results not already represented in persisted messages. */
      backgroundResults?: BackgroundCompletionResult[];
      /** True when this came from automatic startup restore rather than explicit user action. */
      restored?: boolean;
      /** Live tail: blocks of the model response currently streaming (not yet persisted). */
      inFlight?: InFlightAssistantBlock[];
      /** Whether the session's turn is still running at snapshot time. */
      streaming?: boolean;
      /** Whether the session has an interrupted run to resume (persisted runState). */
      interrupted?: boolean;
      /**
       * "focus" marks a hydration triggered by tab/pane focus, where the
       * webview may serve the session from its own caches. All other loads
       * (history load, checkpoint revert, recovered-question resync, webview
       * boot) must be applied.
       */
      origin?: "focus";
      /**
       * Restored checkpoints keyed by the number of visible user turns already
       * committed at that snapshot.
       */
      checkpoints?: Array<{ turnIndex: number; checkpointId: string }>;
      /** Number of user turns before the first message in this chunk. */
      userTurnOffset?: number;
      /** True when older messages still exist before this chunk. */
      hasMoreBefore?: boolean;
    }
  | {
      type: "agentSessionChunk";
      sessionId: string;
      messages: unknown[];
      /** Number of user turns before the first message in this chunk. */
      userTurnOffset: number;
      /** Absolute index of `messages[0]` in the full persisted transcript (deterministic rehydration ids). */
      messageIndexOffset?: number;
      /** True when older messages still exist before this chunk. */
      hasMoreBefore: boolean;
      checkpoints?: Array<{ turnIndex: number; checkpointId: string }>;
    }
  | {
      type: "agentInterjection";
      sessionId: string;
      text: string;
      queueId: string;
      /** Display text for the chat bubble */
      displayText?: string;
      /** Whether the interjection includes a slash command invocation */
      isSlashCommand?: boolean;
      /** Slash command label rendered in the inline command chip */
      slashCommandLabel?: string;
      /** Display-only previews for pasted or dropped media. */
      displayMedia?: ChatMessage["displayMedia"];
    }
  | {
      type: "agentQueuedMessage";
      sessionId: string;
      text: string;
      queueId: string;
      /** Display text for the queue chip */
      displayText?: string;
      /** Whether the queued message includes a slash command invocation */
      isSlashCommand?: boolean;
      /** Slash command label rendered in the inline command chip */
      slashCommandLabel?: string;
      attachments?: string[];
      images?: Array<{ name: string; mimeType: string; base64: string }>;
      documents?: Array<{ name: string; mimeType: string; base64: string }>;
      /** Display-only previews for pasted or dropped media. */
      displayMedia?: ChatMessage["displayMedia"];
      source?: "vscode" | "browser";
    }
  | {
      type: "agentRemoveQueuedMessage";
      sessionId: string;
      queueId: string;
    }
  | {
      type: "agentQueueInterjectionReady";
      sessionId: string;
      queueId: string;
      ready: boolean;
    }
  | {
      type: "agentCommittedUserMessage";
      sessionId: string;
      id?: string;
      text: string;
      displayText?: string;
      isSlashCommand?: boolean;
      slashCommandLabel?: string;
      origin?: "vscode" | "browser";
      /** Display-only previews for pasted or dropped media. */
      displayMedia?: ChatMessage["displayMedia"];
    }
  | {
      type: "agentBgSessionsUpdate";
      sessions: Array<{
        id: string;
        task: string;
        status:
          | "streaming"
          | "tool_executing"
          | "awaiting_approval"
          | "idle"
          | "error"
          | "cancelled";
        currentTool?: string;
        displayStatus?: string;
        displayStatusSource?: "terminal" | "model" | "heuristic";
        resolvedMode?: string;
        resolvedModel?: string;
        resolvedProvider?: string;
        reasoningEffort?: ReasoningEffort;
        taskClass?: string;
        routingReason?: string;
        fallbackUsed?: boolean;
        streamingText?: string;
        errorMessage?: string;
        completedAt?: number;
        summaryMeta?: {
          inFlight: boolean;
          generatedAt?: number;
          sourceModel?: string;
          fallbackUsed?: boolean;
          confidence?: number;
          lastAttemptAt?: number;
          lastFailureAt?: number;
          lastFailureReason?: string;
        };
      }>;
    }
  | {
      type: "agentFleetEvent";
      sessionId: string;
      event: unknown;
    }
  | { type: "agentBgThinkingStart"; sessionId: string; thinkingId: string }
  | {
      type: "agentBgThinkingDelta";
      sessionId: string;
      thinkingId: string;
      text: string;
    }
  | { type: "agentBgThinkingEnd"; sessionId: string; thinkingId: string }
  | { type: "agentBgTextDelta"; sessionId: string; text: string }
  | {
      type: "agentBgToolStart";
      sessionId: string;
      toolCallId: string;
      toolName: string;
      input?: unknown;
    }
  | {
      type: "agentBgToolInputDelta";
      sessionId: string;
      toolCallId: string;
      partialJson: string;
    }
  | {
      type: "agentBgToolComplete";
      sessionId: string;
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
    }
  | {
      type: "agentBgApiRequest";
      sessionId: string;
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
      usedPreviousResponseId?: boolean;
      previousResponseIdFallback?: boolean;
      promptCacheKey?: string;
      promptCacheRetention?: "in_memory" | "24h";
      storeResponseState?: boolean;
      providerResponseId?: string;
      contextBreakdown?: RequestContextBreakdown;
    }
  | {
      type: "agentBgError";
      sessionId: string;
      error: string;
      retryable: boolean;
      code?: string;
      actions?: {
        signIn?: boolean;
        signInAnotherAccount?: boolean;
        condense?: boolean;
      };
    }
  | { type: "agentBgTodoUpdate"; sessionId: string; todos: TodoItem[] }
  | {
      type: "agentBgWarning";
      sessionId: string;
      message: string;
      retryDelayMs?: number;
      retryAt?: number;
      retryAttempt?: number;
      retryMaxAttempts?: number;
    }
  | { type: "agentBgStatusUpdate"; sessionId: string; message: string }
  | {
      type: "agentBgFinalMarker";
      sessionId: string;
      marker:
        | import("@agentlink/protocol/final-status").FinalMessageMarker
        | null;
    }
  | {
      type: "agentBgCondenseStart";
      sessionId: string;
      isAutomatic: boolean;
    }
  | {
      type: "agentBgCondense";
      sessionId: string;
      prevInputTokens: number;
      newInputTokens: number;
      durationMs: number;
      validationWarnings?: string[];
    }
  | {
      type: "agentBgCondenseError";
      sessionId: string;
      error: string;
      retryable?: boolean;
      code?: string;
      actions?: {
        signIn?: boolean;
        signInAnotherAccount?: boolean;
        condense?: boolean;
      };
    }
  | {
      type: "agentBgInterjection";
      sessionId: string;
      text: string;
      displayText?: string;
      isSlashCommand?: boolean;
      slashCommandLabel?: string;
      displayMedia?: ChatMessage["displayMedia"];
    }
  | {
      type: "agentBgDone";
      sessionId: string;
      parentSessionId?: string | null;
      totalInputTokens: number;
      totalOutputTokens: number;
      totalCacheReadTokens: number;
      totalCacheCreationTokens: number;
      completion?: BackgroundCompletionResult;
    }
  | ShowBgTranscriptMessage
  | {
      type: "agentBtwLoading";
      sessionId: string;
      requestId: string;
      question: string;
    }
  | {
      type: "agentBtwProgress";
      sessionId: string;
      requestId: string;
      /** Full accumulated answer text so far. */
      answer: string;
      /** Tool names invoked so far, in order. */
      tools: string[];
      /** Warnings surfaced so far (retries, timeouts, limit notices). */
      warnings: string[];
      budget: BtwBudget;
    }
  | {
      type: "agentBtwResponse";
      sessionId: string;
      requestId: string;
      question: string;
      answer: string;
      error?: boolean;
      /** True when the run was cut short by cancellation or the deadline. */
      cancelled?: boolean;
      tools?: string[];
      warnings?: string[];
      budget?: BtwBudget;
    }
  | {
      type: "agentWorktreeSetupStarted";
      sessionId: string;
      requestId: string;
      input: string;
    }
  | {
      type: "agentWorktreeSetupProgress";
      sessionId: string;
      requestId: string;
      answer: string;
      tools: string[];
      warnings: string[];
      budget: BtwBudget;
    }
  | {
      type: "agentWorktreeSetupAwaitingInput";
      sessionId: string;
      requestId: string;
      answer: string;
      conversation: Array<{ role: "user" | "assistant"; text: string }>;
      tools: string[];
      warnings: string[];
      budget: BtwBudget;
    }
  | {
      type: "agentWorktreeSetupReady";
      sessionId: string;
      requestId: string;
      answer: string;
      config: WorktreeSetupConfig;
      tools: string[];
      warnings: string[];
      budget: BtwBudget;
    }
  | {
      type: "agentWorktreeSetupLaunching";
      sessionId: string;
      requestId: string;
      config: WorktreeSetupConfig;
    }
  | {
      type: "agentWorktreeSetupResult";
      sessionId: string;
      requestId: string;
      phase: "opened" | "rejected" | "cancelled" | "error";
      message: string;
      config?: WorktreeSetupConfig;
    }
  | {
      type: "agentPairingCode";
      pairingId: string;
      code: string;
      expiresAt: number;
      pairingUrls: string[];
    }
  | {
      type: "agentPairingStatus";
      pairingId: string;
      status: "pending" | "consumed" | "expired" | "cancelled";
      deviceId?: string;
      deviceLabel?: string;
    };

export type ShowBgTranscriptMessage = {
  type: "showBgTranscript";
  sessionId: string;
  task: string;
  /** Raw AgentMessage[] from the backend session */
  messages: unknown[];
  todos: TodoItem[];
};

export type ChatState = ChatStateSnapshot;

export interface SessionInfo {
  id: string;
  status: string;
  interactiveExecutionPhase?:
    | "queued_for_workspace_write"
    | "queued_for_provider"
    | "running"
    | "awaiting_input"
    | "stopping";
  mode: string;
  model: string;
  title: string;
  messageCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  background: boolean;
  createdAt: number;
  lastActiveAt: number;
}

/** Persisted session summary projected for chat history surfaces. */
export type SessionSummary = ChatSessionHistorySummary;

// ── Ordered content blocks ──

export type ContentBlock = ProtocolContentBlock;

/** A chat message in the webview state. */
export type ChatMessage = ProtocolChatMessage;

export type TodoItem = ProtocolTodoItem;
