import type { BackgroundResultState } from "./backgroundResult.js";
import type { ChatReasoningEffort } from "./chatCatalog.js";
import type { CommandApprovalPolicy } from "./commandApprovalPolicy.js";
import type { ComposeTrace } from "./compose.js";
import type { FinalMessageMarker } from "./finalStatus.js";
import type { McpApprovalPromotionMeta } from "./toolResult.js";
import type { RequestContextBreakdown } from "./contextDiagnostics.js";

/** Ordered, serializable content projected into an assistant transcript message. */
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
      /** The background session ID. */
      sessionId: string;
      /** Short task label. */
      task: string;
      /** The full message/prompt sent to the background agent. */
      message?: string;
      /** Resolved model used by the background agent. */
      resolvedModel?: string;
      /** Resolved provider. */
      resolvedProvider?: string;
      /** Thinking level selected for the background agent. */
      reasoningEffort?: ChatReasoningEffort;
      /** Resolved mode. */
      resolvedMode?: string;
      /** Task class used for routing. */
      taskClass?: string;
      /** Routing decision reason. */
      routingReason?: string;
    }
  | {
      type: "bg_agent_result";
      /** The background session ID. */
      sessionId: string;
      /** Short task label. */
      task: string;
      /** Compatibility status for legacy transcript blocks. */
      status: "completed" | "error" | "cancelled";
      /** Authoritative terminal state for current transcript blocks. */
      resultState?: BackgroundResultState;
      terminalReason?: string;
      /** The formatted successful result text from the background agent. */
      resultText?: string;
      /** Useful output preserved for non-success terminal states. */
      partialOutput?: string;
      /** Optional concise summary for collapsed rendering. */
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
      /** Array of Q&A pairs from the ask_user tool. */
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

/** A serializable chat message shared by host runtimes and UI surfaces. */
export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "condense" | "warning";
  /** User messages: plain text. Assistant messages: empty (use blocks). */
  content: string;
  timestamp: number;
  /** Ordered content blocks preserving thinking/text/tool-call interleaving. */
  blocks: ContentBlock[];
  /** Badge shown on approval follow-up and rejection annotation messages. */
  badge?: "follow-up" | "rejection";
  /** True when this message includes a slash command invocation. */
  isSlashCommand?: boolean;
  /** Slash command label shown in compact command chip rendering. */
  slashCommandLabel?: string;
  /** Set when the user message originated from a remote browser client. */
  origin?: "vscode" | "browser";
  /** Compact presentation metadata for a linked fresh-session handoff turn. */
  handoff?: {
    sourceSessionId: string;
    sourceTitle: string;
    handoffId: string;
  };
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
  /** Checkpoint rendered on the user message immediately preceding its snapshot. */
  checkpointId?: string;
  /** Final-turn status marker rendered on the last assistant response. */
  finalMarker?: FinalMessageMarker;
  /** Explicit user-facing control change rendered at the point it occurred. */
  surfaceChange?: {
    model?: { previousModel: string; model: string };
    reasoning?: {
      previousReasoningEffort: ChatReasoningEffort;
      reasoningEffort: ChatReasoningEffort;
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
    reasoningEffort?: ChatReasoningEffort;
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
  /** Set when role === "condense". */
  condenseInfo?: {
    prevInputTokens: number;
    newInputTokens: number;
    durationMs?: number;
    errorMessage?: string;
    condensing?: boolean;
    validationWarnings?: string[];
  };
  /** Set when role === "warning". */
  warningMessage?: string;
  warningRetry?: {
    retryDelayMs?: number;
    retryAt?: number;
    retryAttempt?: number;
    retryMaxAttempts?: number;
  };
}

/** Recursive task projection rendered alongside a transcript. */
export interface TodoItem {
  id: string;
  content: string;
  activeForm: string;
  status: "pending" | "in_progress" | "completed";
  children?: TodoItem[];
}
