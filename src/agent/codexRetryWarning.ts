import type { AgentRetryDecision } from "../shared/agentErrors.js";
import { isResponsesInterruption } from "@agentlink/core/codex";

export type CodexRetryTransport = "websocket" | "http";

export interface CodexRetryWarningInput {
  /** Classification already used to choose the retry delay. */
  retry: Pick<AgentRetryDecision, "category" | "status">;
  /** The original provider error, used only to recognise stream interruptions. */
  error: unknown;
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  /** Transport the next attempt will use. */
  nextTransport: CodexRetryTransport;
  /** True when this retry switches from WebSocket to HTTP. */
  fallback: boolean;
}

/**
 * Bounded, user-facing description of why a Codex Responses request is being
 * retried. It names the classified cause, any known HTTP status, the retry
 * number, the scheduled delay and the next transport. It never includes raw
 * provider bodies or headers.
 */
export function formatCodexRetryWarning(input: CodexRetryWarningInput): string {
  const cause = describeCodexRetryCause(input.retry, input.error);
  const transport = input.nextTransport === "websocket" ? "WebSocket" : "HTTP";
  const schedule = `retry ${input.attempt} of ${input.maxAttempts} in ${formatRetryDelay(input.delayMs)} over ${transport}`;
  return input.fallback
    ? `${cause}. WebSocket retries exhausted; ${schedule}.`
    : `${cause}. ${capitalize(schedule)}.`;
}

export function describeCodexRetryCause(
  retry: Pick<AgentRetryDecision, "category" | "status">,
  error: unknown,
): string {
  const status = retry.status !== undefined ? ` (${retry.status})` : "";
  switch (retry.category) {
    case "overloaded":
      return `Codex is overloaded${status}`;
    case "rate_limit":
      return `Codex rate limit reached${status}`;
    case "server":
      return `Codex server error${status}`;
    case "timeout":
      return `Codex response timed out${status}`;
    case "network":
      return `Connection to Codex was interrupted${status}`;
    default:
      return isResponsesInterruption(error) && retry.status === undefined
        ? "Codex response stream was interrupted"
        : `Codex request failed${status}`;
  }
}

function formatRetryDelay(delayMs: number): string {
  const seconds = Math.max(0, delayMs) / 1000;
  const rounded = Math.round(seconds * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}s`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
