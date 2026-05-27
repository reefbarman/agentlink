export type FinalMessageStatus =
  | "completed"
  | "waiting_for_user"
  | "blocked"
  | "cancelled";

export interface FinalMessageMarker {
  status: FinalMessageStatus;
  summary?: string;
  source: "tool" | "engine";
  continueAction?: FinalMessageContinueAction;
  continueActionSuppressed?: boolean;
  autoContinueStopReason?: string;
}

export interface FinalMessageContinueAction {
  label: string;
  prompt: string;
}

export const DEFAULT_COMPLETED_CONTINUE_ACTION: FinalMessageContinueAction = {
  label: "Continue",
  prompt:
    "Continue working from where you left off. If there are remaining subtasks, do the next one; if everything is complete, briefly confirm that no further work is needed.",
};

export function getFinalMessageContinueAction(
  marker: FinalMessageMarker,
): FinalMessageContinueAction | undefined {
  if (marker.continueActionSuppressed) return undefined;
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
  const action =
    marker.continueAction ??
    (marker.status === "completed"
      ? DEFAULT_COMPLETED_CONTINUE_ACTION
      : undefined);
  if (!action) return undefined;
  return { messageId: latest.messageId, ...action };
}
