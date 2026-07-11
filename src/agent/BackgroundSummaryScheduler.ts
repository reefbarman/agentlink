import type { AgentEvent } from "./types.js";
import type { BgSessionInfo } from "../shared/types.js";
import { inferBackgroundDisplayStatus } from "./backgroundDisplayStatus.js";

export type BackgroundSummaryTrigger =
  | "phase_change"
  | "important_tool"
  | "error"
  | "done";

export interface BackgroundSummaryScheduleInput {
  sessionId: string;
  event: AgentEvent;
  status: BgSessionInfo["status"];
  currentTool?: string;
  streamingText?: string;
  resultText?: string;
  errorMessage?: string;
  statusDetail?: string;
}

const IMPORTANT_TOOL_NAMES = [
  "execute_command",
  "apply_diff",
  "write_file",
  "ask_user",
] as const;

export class BackgroundSummaryScheduler {
  private readonly phases = new Map<string, string>();

  evaluate(
    args: BackgroundSummaryScheduleInput,
  ): BackgroundSummaryTrigger | null {
    const nextPhase = inferBackgroundDisplayStatus({
      status: args.status,
      currentTool: args.currentTool,
      streamingText: args.streamingText,
      resultText: args.resultText,
      errorMessage: args.errorMessage,
      statusDetail: args.statusDetail,
    });
    const previousPhase = this.phases.get(args.sessionId);
    if (previousPhase !== nextPhase) {
      this.phases.set(args.sessionId, nextPhase);
      return "phase_change";
    }

    if (args.event.type === "tool_result") {
      const toolName = args.event.toolName.toLowerCase();
      return IMPORTANT_TOOL_NAMES.some((name) => toolName.includes(name))
        ? "important_tool"
        : null;
    }
    if (args.event.type === "error") return "error";
    if (args.event.type === "done") return "done";
    return null;
  }
}
