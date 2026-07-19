export type BackgroundRuntimePhase =
  | "queued"
  | "waiting_for_provider"
  | "thinking"
  | "responding"
  | "executing_tool"
  | "awaiting_approval"
  | "retrying_provider"
  | "completed"
  | "failed"
  | "cancelled";

export interface BackgroundRuntimeStatus {
  phase?: BackgroundRuntimePhase;
  requestStartedAt?: number;
  retryAt?: number;
}

function formatDurationMs(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0
    ? `${minutes}:${seconds.toString().padStart(2, "0")}`
    : `${seconds}s`;
}

export function formatBackgroundRuntimeStatus(
  runtime: BackgroundRuntimeStatus | undefined,
  now = Date.now(),
): string | null {
  if (!runtime?.phase) return null;
  const requestElapsed = runtime.requestStartedAt
    ? formatDurationMs(now - runtime.requestStartedAt)
    : null;
  const requestSuffix = requestElapsed ? ` · request ${requestElapsed}` : "";

  switch (runtime.phase) {
    case "waiting_for_provider":
      return `Waiting for provider${requestSuffix}`;
    case "thinking":
      return `Thinking${requestSuffix}`;
    case "responding":
      return `Responding${requestSuffix}`;
    case "retrying_provider": {
      const retryIn = runtime.retryAt
        ? ` · retry in ${formatDurationMs(runtime.retryAt - now)}`
        : "";
      return `Retrying provider${requestSuffix}${retryIn}`;
    }
    case "executing_tool":
      return "Executing tool";
    case "awaiting_approval":
      return "Awaiting approval";
    case "queued":
      return "Queued";
    case "completed":
      return "Done";
    case "failed":
      return "Error";
    case "cancelled":
      return "Cancelled";
  }
}
