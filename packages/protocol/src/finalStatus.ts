import type { FleetResultEnvelope } from "./fleetResult.js";

export type FinalMessageStatus =
  | "completed"
  | "waiting_for_user"
  | "blocked"
  | "cancelled";

export interface FinalMarkerToolCall {
  id: string;
  name: "set_task_status";
  inputJson: string;
  result?: string;
  durationMs?: number;
}

export interface FinalMessageMarker {
  status: FinalMessageStatus;
  summary?: string;
  /** Structured result returned by a background agent to its coordinator. */
  result?: FleetResultEnvelope;
  source: "tool" | "engine";
  continueAction?: FinalMessageContinueAction;
  /** UI-owned marker that hides a consumed/stale Continue action. */
  continueActionConsumed?: boolean;
  /** @deprecated Legacy tool-set field; ignored so completed markers stay resumable. */
  continueActionSuppressed?: boolean;
  autoContinueStopReason?: string;
  /** Raw set_task_status invocation shown in the final marker inspector. */
  toolCall?: FinalMarkerToolCall;
}

export interface FinalMessageContinueAction {
  label: string;
  prompt: string;
}

export const DEFAULT_COMPLETED_CONTINUE_ACTION: FinalMessageContinueAction = {
  label: "Continue",
  prompt:
    "Continue working from where you left off. Before deciding the overall task is complete, re-check the original user request. If the completed work is a phase, handover, or scoped subtask, treat that boundary as a navigation point—not proof of overall completion—and locate and inspect its parent/source-of-truth plan, following references outward through higher-level plans if nested. Within the user-approved scope, identify and begin the next explicit unfinished phase, plan item, subtask, or validation step. If it needs a missing decision or prerequisite, surface that blocker. Do not invent work or broaden scope. Only if the full approved scope is complete, briefly confirm that no work remains.",
};

export function getFinalMessageContinueAction(
  marker: FinalMessageMarker,
): FinalMessageContinueAction | undefined {
  if (marker.continueActionConsumed) return undefined;
  return (
    marker.continueAction ??
    (marker.status === "completed"
      ? DEFAULT_COMPLETED_CONTINUE_ACTION
      : undefined)
  );
}

export interface FinalMessageWithMarker {
  id: string;
  role: string;
  finalMarker?: FinalMessageMarker;
}

export interface AutoContinueAction extends FinalMessageContinueAction {
  messageId: string;
}

export interface LatestFinalMessageMarker {
  messageId: string;
  marker: FinalMessageMarker;
}

/**
 * Returns the latest assistant final marker. User messages after a marker make
 * it stale, so the scan stops at users rather than continuing backwards to an
 * older assistant response.
 */
export function getLatestFinalMessageMarker(
  messages: readonly FinalMessageWithMarker[],
): LatestFinalMessageMarker | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === "user") return undefined;
    if (message.role !== "assistant" || !message.finalMarker) continue;
    return { messageId: message.id, marker: message.finalMarker };
  }
  return undefined;
}

/**
 * Returns the continuation action for the latest assistant final marker.
 */
export function getLatestAutoContinueAction(
  messages: readonly FinalMessageWithMarker[],
): AutoContinueAction | undefined {
  const latest = getLatestFinalMessageMarker(messages);
  if (!latest) return undefined;
  const { marker } = latest;
  const action = getFinalMessageContinueAction(marker);
  if (!action) return undefined;
  return { messageId: latest.messageId, ...action };
}
