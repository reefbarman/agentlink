import type {
  McpApprovalPromotionMeta,
  RequestContextBreakdown,
} from "../../shared/types.js";

import type { LoadedInstructionDebugInfo } from "../../shared/chatProjection.js";

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
  description: string;
  source: "builtin" | "project" | "global" | "agentlink" | "skill";
  /** True if this is a built-in command that executes immediately */
  builtin: boolean;
  /** Body to inject into input (for file-based commands) */
  body?: string;
  /** Absolute SKILL.md path for generated skill commands. */
  skillPath?: string;
  /** Codicon name to show next to the command */
  icon?: string;
  /** Value shown right-aligned (e.g. current model name) */
  rightLabel?: string;
  /** Show a checkmark — used in sub-pickers for current selection */
  isCurrent?: boolean;
}

/** A question posed by the agent via the ask_user tool */
export interface QuestionRequest {
  id: string;
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

/** Messages from extension to webview */
export type ExtensionMessage =
  | { type: "stateUpdate"; state: ChatState }
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
      durationMs: number;
      input?: unknown;
      mcpApprovalPromotion?: McpApprovalPromotionMeta;
    }
  | {
      type: "agentUserAnnotation";
      sessionId: string;
      text: string;
      badge: "follow-up" | "rejection";
    }
  | {
      type: "agentApiRequest";
      sessionId: string;
      requestId: string;
      model: string;
      inputTokens: number;
      uncachedInputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
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
      totalInputTokens: number;
      totalOutputTokens: number;
      totalCacheReadTokens: number;
      totalCacheCreationTokens: number;
    }
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
  | { type: "agentModeSwitchRequest"; mode: string; reason?: string }
  | {
      type: "agentElicitationRequest";
      id: string;
      serverName: string;
      message: string;
      fields: Record<
        string,
        {
          type: "string" | "number" | "boolean";
          title?: string;
          description?: string;
          enum?: string[];
          default?: unknown;
          minimum?: number;
          maximum?: number;
          minLength?: number;
          maxLength?: number;
        }
      >;
      required: string[];
    }
  | {
      type: "agentMcpStatus";
      open?: boolean;
      infos: Array<{
        name: string;
        status: string;
        error?: string;
        toolCount: number;
        resourceCount: number;
        promptCount: number;
      }>;
    }
  | {
      type: "showApproval";
      request: import("../../approvals/webview/types").ApprovalRequest;
    }
  | { type: "idle" }
  | {
      type: "regexSuggestion";
      requestId: string;
      pattern?: string;
      error?: string;
    }
  | ({
      type: "agentQuestionRequest";
    } & QuestionRequest)
  | { type: "agentQuestionCleared"; id: string }
  | {
      type: "agentQuestionProgress";
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
      title: string;
      mode: string;
      model: string;
      messages: unknown[];
      lastInputTokens: number;
      lastOutputTokens: number;
      /** True when this came from automatic startup restore rather than explicit user action. */
      restored?: boolean;
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
      type: "agentCommittedUserMessage";
      sessionId: string;
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
        taskClass?: string;
        routingReason?: string;
        fallbackUsed?: boolean;
        streamingText?: string;
        resultText?: string;
        errorMessage?: string;
        completedAt?: number;
        fullTranscript?: string;
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
      durationMs: number;
      input?: unknown;
    }
  | {
      type: "agentBgApiRequest";
      sessionId: string;
      requestId: string;
      model: string;
      inputTokens: number;
      uncachedInputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
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
  | {
      type: "agentBgDone";
      sessionId: string;
      totalInputTokens: number;
      totalOutputTokens: number;
      totalCacheReadTokens: number;
      totalCacheCreationTokens: number;
      resultText?: string;
      /** Concise summary for collapsed background-result UI */
      resultSummary?: string;
    }
  | ShowBgTranscriptMessage
  | { type: "agentBtwLoading"; requestId: string; question: string }
  | {
      type: "agentBtwResponse";
      requestId: string;
      question: string;
      answer: string;
      error?: boolean;
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
};

export interface ChatState {
  sessionId: string | null;
  mode: string;
  model: string;
  streaming: boolean;
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
  agentWriteApproval?: "prompt" | "session" | "project" | "global";
}

export interface SessionInfo {
  id: string;
  status: string;
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
      complete: boolean;
      durationMs?: number;
      mcpApprovalPromotion?: McpApprovalPromotionMeta;
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
      /** Completion status */
      status: "completed" | "error" | "cancelled";
      /** The final result text from the background agent */
      resultText?: string;
      /** Optional concise summary for collapsed rendering */
      summary?: string;
    }
  | {
      type: "question_answer";
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
  /**
   * Checkpoint ID rendered on the user message immediately preceding that
   * checkpoint snapshot.
   */
  checkpointId?: string;
  /** Final-turn status marker rendered on the last assistant response. */
  finalMarker?: import("../../shared/finalStatus.js").FinalMessageMarker;
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
  apiRequest?: {
    requestId: string;
    model: string;
    inputTokens: number;
    uncachedInputTokens?: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
    outputTokens: number;
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
