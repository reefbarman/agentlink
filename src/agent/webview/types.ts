import type {
  BackgroundCompletionResult,
  McpApprovalPromotionMeta,
  RequestContextBreakdown,
  RevertRecoveryNotice,
} from "../../shared/types.js";
import type {
  ChatTabActionConfirmationRequest,
  ChatTabActionFailure,
  ChatTabActionRejection,
  ChatWorkspaceViewSnapshot,
} from "../chatTabProtocol.js";
import type {
  McpConfigMutationResult,
  McpConfigSnapshot,
  McpManagerView,
} from "../../shared/mcpManagerTypes.js";
import type {
  MemoryPanelSnapshot,
  MemoryToolScope,
} from "../../core/capabilities/memory.js";
import type {
  TerminalApprovalPolicy,
  TerminalApprovalReviewer,
  TerminalExecutionPreset,
} from "../../core/capabilities/terminal.js";

import type { CommandApprovalPolicy } from "../../approvals/commandApprovalPolicy.js";
import type { ComposeTrace } from "../../shared/composeTypes.js";
import type { ContextHealthSnapshot } from "../../shared/contextHealth.js";
import type { LoadedInstructionDebugInfo } from "../../shared/chatProjection.js";
import type { McpFormElicitationRequest } from "../../shared/mcpElicitation.js";
import type { McpUrlElicitationRequest } from "../../shared/mcpUrlElicitation.js";
import type { MemoryRecordDetail } from "../../core/memory/contracts.js";

export interface ProjectInfo {
  projectId: string;
  displayName: string;
  availability: "available" | "unavailable";
}

/** A mode available for selection */
export interface ModeInfo {
  slug: string;
  name: string;
  icon: string;
}

/** Model info sent from the extension via agentModelsUpdate. */
export type ReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export interface WebviewModelInfo {
  id: string;
  displayName: string;
  provider: string;
  providerDisplayName?: string;
  supportsToolUse?: boolean;
  supportsImages?: boolean;
  contextWindow: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  reasoningEfforts?: ReasoningEffort[];
  defaultReasoningEffort?: ReasoningEffort;
  authenticated: boolean;
  condenseThreshold?: number;
}

/** A slash command available for autocomplete */
export interface SlashCommandInfo {
  name: string;
  /** Optional presentation/search alias. `name` remains the canonical command id. */
  displayName?: string;
  description: string;
  source: "builtin" | "project" | "global" | "agentlink" | "skill";
  /** True if this is a built-in command that executes immediately */
  builtin: boolean;
  /** Body to inject into input (for file-based commands) */
  body?: string;
  /** Absolute SKILL.md path for generated skill commands. */
  skillPath?: string;
  /** Exact canonical identity for generated skill commands. */
  skillId?: string;
  /** SHA-256 content revision advertised with the generated skill command. */
  skillRevision?: string;
  /** Codicon name to show next to the command */
  icon?: string;
  /** Value shown right-aligned (e.g. current model name) */
  rightLabel?: string;
  /** Show a checkmark — used in sub-pickers for current selection */
  isCurrent?: boolean;
}

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

/** A question posed by the agent via the ask_user tool */
export interface QuestionRequest {
  id: string;
  /** Provider ask_user tool-call ID when it differs from the UI request ID. */
  toolCallId?: string;
  /** Visible explanation shown above structured questions. */
  context: string;
  questions: Question[];
  /** When set, the question is from a background agent with this task name. */
  backgroundTask?: string;
}

export interface Question {
  id: string;
  type:
    | "multiple_choice"
    | "multiple_select"
    | "yes_no"
    | "text"
    | "scale"
    | "confirmation";
  question: string;
  /** Visible explanation shown with this specific question. */
  context?: string;
  options?: string[];
  /** The option value the agent recommends (must match one of the options strings) */
  recommended?: string;
  /** Allows submitting a blank text answer. Only applies to text questions. */
  allowBlank?: boolean;
  scale_min?: number;
  scale_max?: number;
  scale_min_label?: string;
  scale_max_label?: string;
  /**
   * Maps answer values to agent mode slugs. When the user picks an answer
   * with a mapped mode, the agent switches to that mode as part of the
   * answer submission — no separate switch_mode approval is shown.
   * Only supported on `multiple_choice` questions. At most one question per
   * ask_user call may carry modeSwitch.
   */
  modeSwitch?: Record<string, string>;
}

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
      marker: import("../../shared/finalStatus.js").FinalMessageMarker | null;
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
        | import("../../shared/questionDetection").DetectedQuestion
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
      request: import("../../approvals/webview/types").ApprovalRequest;
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
      inFlight?: import("../../shared/types.js").InFlightAssistantBlock[];
      /** Whether the session's turn is still running at snapshot time. */
      streaming?: boolean;
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
      marker: import("../../shared/finalStatus.js").FinalMessageMarker | null;
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

export interface ChatState {
  sessionId: string | null;
  projects?: ProjectInfo[];
  defaultProjectId?: string | null;
  project?: ProjectInfo | null;
  mode: string;
  model: string;
  streaming: boolean;
  interrupted?: boolean;
  thinkingEnabled?: boolean;
  reasoningEffort?: ReasoningEffort;
  condenseThreshold?: number;
  contextBudget?: {
    contextWindow: number;
    maxInputTokens: number;
    usedInputTokens: number;
    outputReservation: number;
    safetyBufferTokens: number;
    softThresholdBudget: number;
    hardBudget: number;
  };
  contextHealth?: ContextHealthSnapshot | null;
  agentWriteApproval?: "prompt" | "session" | "project" | "global";
  commandApprovalPolicy?: CommandApprovalPolicy;
  approvalPolicy?: TerminalApprovalPolicy;
  approvalReviewer?: TerminalApprovalReviewer;
  executionPreset?: TerminalExecutionPreset;
  configuredCommandApprovalPolicy?: Exclude<
    CommandApprovalPolicy,
    "approve-for-me"
  >;
  revertRecoveryNotice?: RevertRecoveryNotice | null;
}

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

/** Persisted session summary from the SessionStore */
export interface SessionSummary {
  id: string;
  project?: ProjectInfo;
  mode: string;
  model: string;
  title: string;
  messageCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  createdAt: number;
  lastActiveAt: number;
}

// ── Ordered content blocks ──

export type ContentBlock =
  | { type: "thinking"; id: string; text: string; complete: boolean }
  | { type: "text"; text: string }
  | {
      type: "tool_call";
      id: string;
      name: string;
      inputJson: string;
      result: string;
      resultImages?: Array<{ mimeType: string; data: string }>;
      resultDocuments?: Array<{
        name: string;
        mimeType: string;
        data: string;
      }>;
      complete: boolean;
      durationMs?: number;
      startedAt?: number;
      mcpApprovalPromotion?: McpApprovalPromotionMeta;
      composeTrace?: ComposeTrace;
    }
  | {
      type: "skill_load";
      id: string;
      inputJson: string;
      result: string;
      complete: boolean;
      skillName?: string;
      path?: string;
      content?: string;
      durationMs?: number;
    }
  | {
      type: "bg_agent";
      /** The background session ID */
      sessionId: string;
      /** Short task label */
      task: string;
      /** The full message/prompt sent to the background agent */
      message?: string;
      /** Resolved model used by the background agent */
      resolvedModel?: string;
      /** Resolved provider */
      resolvedProvider?: string;
      /** Thinking level selected for the background agent */
      reasoningEffort?: ReasoningEffort;
      /** Resolved mode */
      resolvedMode?: string;
      /** Task class used for routing */
      taskClass?: string;
      /** Routing decision reason */
      routingReason?: string;
    }
  | {
      type: "bg_agent_result";
      /** The background session ID */
      sessionId: string;
      /** Short task label */
      task: string;
      /** Compatibility status for legacy transcript blocks. */
      status: "completed" | "error" | "cancelled";
      /** Authoritative terminal state for current transcript blocks. */
      resultState?: import("../../core/capabilities/background.js").BackgroundResultState;
      terminalReason?: string;
      /** The formatted successful result text from the background agent. */
      resultText?: string;
      /** Useful output preserved for non-success terminal states. */
      partialOutput?: string;
      /** Optional concise summary for collapsed rendering */
      summary?: string;
      retrySafe?: boolean;
      agentRetryable?: boolean;
      /** Internal projection authority used to make live/replay merge order deterministic. */
      sourceAuthority?: "canonical" | "tool" | "legacy";
    }
  | {
      type: "question_answer";
      /** Correlates live submissions with the eventual ask_user tool result. */
      toolCallId?: string;
      /** Array of Q&A pairs from the ask_user tool */
      items: Array<{
        question: string;
        answer: string | string[] | number | boolean | null;
        note?: string;
      }>;
    }
  | {
      type: "pairing_code";
      pairingId: string;
      code: string;
      /** Milliseconds-since-epoch expiry for the pending pairing. */
      expiresAt: number;
      /** Candidate URLs to hand to the new device (mDNS first, then LAN IPs). */
      pairingUrls: string[];
      status: "pending" | "consumed" | "expired" | "cancelled";
      /** Populated when status === "consumed". */
      deviceLabel?: string;
    };

/** A chat message in the webview state */
export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "condense" | "warning";
  /** User messages: plain text. Assistant messages: empty (use blocks). */
  content: string;
  timestamp: number;
  /** Ordered content blocks — preserves interleaving of thinking/text/tool_call */
  blocks: ContentBlock[];
  /** Badge shown on approval follow-up and rejection annotation messages */
  badge?: "follow-up" | "rejection";
  /** True when this message includes a slash command invocation */
  isSlashCommand?: boolean;
  /** Slash command label shown in compact command chip rendering */
  slashCommandLabel?: string;
  /** Set when the user message originated from a remote browser client */
  origin?: "vscode" | "browser";
  /** Display-only previews for pasted or dropped media attached to a user turn. */
  displayMedia?: {
    images: Array<{ name: string; mimeType: string; src: string }>;
    documents: Array<{ name: string; mimeType: string }>;
  };
  /** Raw user-provided media retained server-side for model input; stripped from browser snapshots. */
  media?: {
    images?: Array<{ name: string; mimeType: string; base64: string }>;
    documents?: Array<{ name: string; mimeType: string; base64: string }>;
  };
  /**
   * Checkpoint ID rendered on the user message immediately preceding that
   * checkpoint snapshot.
   */
  checkpointId?: string;
  /** Final-turn status marker rendered on the last assistant response. */
  finalMarker?: import("../../shared/finalStatus.js").FinalMessageMarker;
  /** Explicit user-facing control change rendered at the point it occurred. */
  surfaceChange?: {
    model?: { previousModel: string; model: string };
    reasoning?: {
      previousReasoningEffort: ReasoningEffort;
      reasoningEffort: ReasoningEffort;
    };
    mode?: { previousMode: string; mode: string };
  };
  error?: {
    message: string;
    retryable: boolean;
    code?: string;
    actions?: {
      signIn?: boolean;
      signInAnotherAccount?: boolean;
      condense?: boolean;
    };
  };
  /** Display-only metadata for Ask Agent local conversation memory injected into a turn. */
  memoryDisclosure?: {
    status: "used";
    summaryCount: number;
    transcriptExcerptCount: number;
    sources: Array<{
      label: string;
      title?: string;
      score?: number;
      kind: "summary" | "transcript";
    }>;
  };
  apiRequest?: {
    requestId: string;
    model: string;
    reasoningEffort?: ReasoningEffort;
    /** Session mode slug active for this request; drives mode-change dividers. */
    mode?: string;
    /** Command approval policy active for this request; drives Approve for Me dividers. */
    commandApprovalPolicy?: CommandApprovalPolicy;
    inputTokens: number;
    uncachedInputTokens?: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
    outputTokens: number;
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
  };
  /** Set when role === "condense" */
  condenseInfo?: {
    prevInputTokens: number;
    newInputTokens: number;
    durationMs?: number;
    errorMessage?: string;
    condensing?: boolean;
    validationWarnings?: string[];
  };
  /** Set when role === "warning" */
  warningMessage?: string;
  warningRetry?: {
    retryDelayMs?: number;
    retryAt?: number;
    retryAttempt?: number;
    retryMaxAttempts?: number;
  };
}

export interface TodoItem {
  id: string;
  content: string;
  activeForm: string;
  status: "pending" | "in_progress" | "completed";
  children?: TodoItem[];
}
