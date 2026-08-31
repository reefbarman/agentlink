import type { BackgroundResultState } from "./backgroundResult.js";
import type { BrowserGatewayTranscriptText } from "./browserGatewayTranscriptText.js";
import type { CoreReasoningEffort } from "./modelCatalog.js";

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
    }
  | {
      type: "skill_load";
      blockId: string;
      skillName?: string;
      complete: boolean;
      durationMs?: number;
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
