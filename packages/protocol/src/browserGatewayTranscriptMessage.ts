import type { BrowserGatewayTranscriptBlock } from "./browserGatewayTranscriptBlock.js";
import type { BrowserGatewayTranscriptText } from "./browserGatewayTranscriptText.js";

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
  finalMarker?: {
    status: "completed" | "waiting_for_user" | "blocked" | "cancelled";
    summary?: string;
    source: "tool" | "engine";
    continueAction?: { label: string; prompt: string };
    continueActionConsumed?: boolean;
    autoContinueStopReason?: string;
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
        | "max";
      reasoningEffort:
        | "none"
        | "minimal"
        | "low"
        | "medium"
        | "high"
        | "xhigh"
        | "max";
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
      | "max";
    mode?: string;
    commandApprovalPolicy?: "manual" | "safe" | "approve-for-me" | "sensitive";
    inputTokens: number;
    uncachedInputTokens?: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
    outputTokens: number;
    durationMs: number;
    timeToFirstToken: number;
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
