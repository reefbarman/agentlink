import type { BackgroundResultState } from "./backgroundResult.js";
import type { BrowserGatewayTranscriptText } from "./browserGatewayTranscriptText.js";
import type { CoreReasoningEffort } from "./modelCatalog.js";
import type { ToolCallProgress } from "./chatTranscript.js";

export interface BrowserGatewayTranscriptBlockDetailSummary {
  contentRevision: number;
  status?: "error" | "interrupted";
  imageCount?: number;
  documentCount?: number;
}

/**
 * Display summary of a `respond_to_background_question` reply, so remote
 * surfaces can pair it with its agent-communication card without loading the
 * lazily fetched tool input. Answers are pre-rendered display strings.
 */
export interface BrowserGatewayCoordinationReplySummary {
  requestId: string;
  status: "responding" | "answered" | "failed";
  answers: Record<string, string>;
  notes: Record<string, string>;
}

export type BrowserGatewayTranscriptBlock =
  | {
      type: "thinking";
      blockId: string;
      text: BrowserGatewayTranscriptText;
      complete: boolean;
    }
  | {
      type: "text";
      blockId: string;
      text: BrowserGatewayTranscriptText;
    }
  | {
      type: "tool_call";
      blockId: string;
      toolCallId: string;
      name: string;
      complete: boolean;
      durationMs?: number;
      startedAt?: number;
      /**
       * Live progress of a running tool. Sent only to helpers advertising
       * `transcript-tool-progress-v1`, so older strict validators never see it.
       */
      progress?: ToolCallProgress;
      detail?: BrowserGatewayTranscriptBlockDetailSummary;
      /** Negotiated with `transcript-agent-context-v1`. */
      coordinationReply?: BrowserGatewayCoordinationReplySummary;
    }
  | {
      type: "skill_load";
      blockId: string;
      skillName?: string;
      origin?: "user_selection";
      complete: boolean;
      durationMs?: number;
      detail?: BrowserGatewayTranscriptBlockDetailSummary;
    }
  | {
      type: "bg_agent";
      blockId: string;
      sessionId: string;
      task: string;
      resolvedModel?: string;
      resolvedProvider?: string;
      reasoningEffort?: CoreReasoningEffort;
      resolvedMode?: string;
      taskClass?: string;
      requestedModelTier?:
        | "cheap"
        | "balanced"
        | "deep_reasoning"
        | "foreground";
      modelTier?: "cheap" | "balanced" | "deep_reasoning";
      resolvedModelTier?: "cheap" | "balanced" | "deep_reasoning" | "unknown";
      resolvedModelTierSource?:
        | "configured"
        | "builtin"
        | "heuristic"
        | "unknown"
        | "external";
      modelGroup?: string;
      /** Prompt sent to the agent. Negotiated with `transcript-agent-context-v1`. */
      message?: BrowserGatewayTranscriptText;
      /** Negotiated with `transcript-agent-context-v1`. */
      routingReason?: string;
    }
  | {
      type: "bg_agent_result";
      blockId: string;
      sessionId: string;
      task: string;
      status: "completed" | "error" | "cancelled";
      resultState?: BackgroundResultState;
      terminalReason?: string;
      result?: BrowserGatewayTranscriptText;
      partialOutput?: BrowserGatewayTranscriptText;
      summary?: string;
      retrySafe?: boolean;
      agentRetryable?: boolean;
    }
  | {
      type: "question_answer";
      blockId: string;
      toolCallId?: string;
      items: Array<{
        question: string;
        answer: string | string[] | number | boolean | null;
        note?: string;
      }>;
    }
  | {
      type: "pairing_status";
      blockId: string;
      status: "pending" | "consumed" | "expired" | "cancelled";
      expiresAt: number;
      deviceLabel?: string;
    };
