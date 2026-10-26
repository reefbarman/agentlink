import type { BrowserGatewayTranscriptBlock } from "./browserGatewayTranscriptBlock.js";
import type { BrowserGatewayTranscriptText } from "./browserGatewayTranscriptText.js";
import type { ImageAttribution } from "./toolResult.js";

/** Block id used by `display-image` detail requests for message display media. */
export const BROWSER_GATEWAY_DISPLAY_MEDIA_BLOCK_ID = "display-media";

/** Block id used by `work-summary` detail requests for a final marker's summary. */
export const BROWSER_GATEWAY_WORK_SUMMARY_BLOCK_ID = "work-summary";

/**
 * Byte-free descriptors for message-level display media. Image bytes are
 * fetched lazily through a `display-image` transcript detail request.
 */
export interface BrowserGatewayTranscriptDisplayMedia {
  contentRevision: number;
  /**
   * `attribution` is sent only to helpers advertising
   * `transcript-image-attribution-v1`, so older strict validators never see it.
   */
  images: Array<{
    name: string;
    mimeType: string;
    attribution?: ImageAttribution;
  }>;
  documents: Array<{ name: string; mimeType: string }>;
}

export interface BrowserGatewayTranscriptMessage {
  messageId: string;
  role: "user" | "assistant" | "condense" | "warning";
  revision: number;
  createdAt: number;
  content: BrowserGatewayTranscriptText;
  blocks: BrowserGatewayTranscriptBlock[];
  badge?: "follow-up" | "rejection";
  isSlashCommand?: boolean;
  slashCommandLabel?: string;
  origin?: "vscode" | "browser";
  checkpointId?: string;
  displayMedia?: BrowserGatewayTranscriptDisplayMedia;
  finalMarker?: {
    status: "completed" | "waiting_for_user" | "blocked" | "cancelled";
    summary?: string;
    source: "tool" | "engine";
    continueAction?: { label: string; prompt: string };
    continueActionConsumed?: boolean;
    autoContinueStopReason?: string;
    /**
     * Reference to the final marker's work summary, fetched lazily through a
     * `work-summary` detail request. Sent only to helpers advertising
     * `transcript-work-summary-v1`, so older strict validators never see it.
     */
    workSummary?: { contentRevision: number };
    /**
     * Wall-clock duration of the ask this marker ends. Sent only to helpers
     * advertising `transcript-final-elapsed-v1`.
     */
    elapsedMs?: number;
  };
  surfaceChange?: {
    model?: { previousModel: string; model: string };
    reasoning?: {
      previousReasoningEffort:
        | "none"
        | "minimal"
        | "low"
        | "medium"
        | "high"
        | "xhigh"
        | "max"
        | "ultra";
      reasoningEffort:
        | "none"
        | "minimal"
        | "low"
        | "medium"
        | "high"
        | "xhigh"
        | "max"
        | "ultra";
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
  apiRequest?: {
    requestId: string;
    model: string;
    reasoningEffort?:
      | "none"
      | "minimal"
      | "low"
      | "medium"
      | "high"
      | "xhigh"
      | "max"
      | "ultra";
    mode?: string;
    commandApprovalPolicy?: "manual" | "safe" | "approve-for-me" | "sensitive";
    inputTokens: number;
    uncachedInputTokens?: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
    outputTokens: number;
    durationMs: number;
    timeToFirstToken: number;
    transport?: "http" | "websocket";
  };
  condenseInfo?: {
    prevInputTokens: number;
    newInputTokens: number;
    durationMs?: number;
    errorMessage?: string;
    condensing?: boolean;
    validationWarnings?: string[];
  };
  warningMessage?: string;
  warningRetry?: {
    retryDelayMs?: number;
    retryAt?: number;
    retryAttempt?: number;
    retryMaxAttempts?: number;
  };
}
