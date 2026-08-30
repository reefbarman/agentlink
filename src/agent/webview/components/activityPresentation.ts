import type { ContentBlock } from "@agentlink/protocol/chat-transcript";

export type ActivityMotion = "moving" | "attention" | "static";

export type AgentActivityPhase =
  | "working"
  | "reasoning"
  | "responding"
  | "tool"
  | "processing_results"
  | "awaiting_approval"
  | "awaiting_input"
  | "completed"
  | "failed"
  | "cancelled";

export interface AgentActivityPresentation {
  phase: AgentActivityPhase;
  motion: ActivityMotion;
  label: string;
}

const WORKING_ACTIVITY: AgentActivityPresentation = {
  phase: "working",
  motion: "moving",
  label: "Working…",
};

/**
 * Derive only the foreground phases proven by projected transcript blocks.
 * Provider waits and retries deliberately use the coarse Working label because
 * those phases are not explicitly projected to both foreground surfaces yet.
 */
export function getStreamingActivity(
  blocks: ContentBlock[],
): AgentActivityPresentation {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    switch (block.type) {
      case "text":
        return {
          phase: "responding",
          motion: "moving",
          label: "Responding…",
        };
      case "tool_call":
        return block.complete
          ? {
              phase: "processing_results",
              motion: "moving",
              label: "Processing tool results…",
            }
          : {
              phase: "tool",
              motion: "moving",
              label: "Running tool…",
            };
      case "skill_load":
        return block.complete
          ? {
              phase: "processing_results",
              motion: "moving",
              label: "Processing skill results…",
            }
          : {
              phase: "tool",
              motion: "moving",
              label: "Loading skill…",
            };
      case "thinking":
        return block.complete
          ? WORKING_ACTIVITY
          : {
              phase: "reasoning",
              motion: "moving",
              label: "Thinking…",
            };
      default:
        break;
    }
  }

  return WORKING_ACTIVITY;
}
