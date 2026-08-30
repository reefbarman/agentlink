import type { BackgroundResultState } from "./backgroundResult.js";

/**
 * Serializable snapshot of the model response currently streaming. Captured
 * host-side while the persisted transcript has not yet committed the assistant
 * message, so hydration can preserve the visible live tail.
 */
export type InFlightAssistantBlock =
  | { type: "thinking"; id: string; text: string; complete: boolean }
  | { type: "text"; text: string }
  | {
      type: "tool_call";
      id: string;
      name: string;
      inputJson: string;
      complete: boolean;
    };

/** Durable background completion projected back into its parent transcript. */
export interface BackgroundCompletionResult {
  sessionId: string;
  task: string;
  status: "completed" | "error" | "cancelled";
  resultState: BackgroundResultState;
  terminalReason?: string;
  resultText?: string;
  partialOutput?: string;
  summary?: string;
  retrySafe?: boolean;
  agentRetryable?: boolean;
  completedAt: number;
}

/** Serializable recovery notice shown after a partially persisted checkpoint revert. */
export interface RevertRecoveryNotice {
  projectId: string;
  checkpointId: string;
  sessionRevision: string;
  workspaceRevision?: string;
  startedAt: number;
  title: string;
  message: string;
}
