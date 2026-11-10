import { expectTypeOf, it } from "vitest";

import type { BackgroundResultState } from "./backgroundResult.js";
import type { BrowserGatewayTranscriptBlock } from "./browserGatewayTranscriptBlock.js";
import type { BrowserGatewayTranscriptText } from "./browserGatewayTranscriptText.js";
import type { CoreReasoningEffort } from "./modelCatalog.js";

it("pins the complete browser gateway transcript-block contract", () => {
  expectTypeOf<BrowserGatewayTranscriptBlock>().toEqualTypeOf<
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
        progress?: { progress: number; total?: number; message?: string };
        detail?: {
          contentRevision: number;
          status?: "error" | "interrupted";
          imageCount?: number;
          documentCount?: number;
        };
        coordinationReply?: {
          requestId: string;
          status: "responding" | "answered" | "failed";
          answers: Record<string, string>;
          notes: Record<string, string>;
        };
      }
    | {
        type: "skill_load";
        blockId: string;
        origin?: "user_selection";
        skillName?: string;
        complete: boolean;
        durationMs?: number;
        detail?: {
          contentRevision: number;
          status?: "error" | "interrupted";
          imageCount?: number;
          documentCount?: number;
        };
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
        message?: BrowserGatewayTranscriptText;
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
      }
  >();
});
