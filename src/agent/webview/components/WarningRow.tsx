import { useEffect, useMemo, useState } from "preact/hooks";

import type { ChatMessage } from "@agentlink/protocol/chat-transcript";
import { ErrorNotice } from "./ErrorNotice";

interface WarningRowProps {
  messages: ChatMessage[];
  resolved?: boolean;
  onRetry?: () => void;
}

function formatRetryStatus(message: ChatMessage, nowMs: number): string {
  const retryAt = message.warningRetry?.retryAt;
  if (!retryAt) {
    return "Retrying automatically";
  }

  const remainingSeconds = Math.max(0, Math.ceil((retryAt - nowMs) / 1000));
  if (remainingSeconds === 0) {
    return "Retrying now";
  }

  return `Retrying in ${remainingSeconds}s`;
}

function isOverloadedWarning(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes("overloaded") || lower.includes("529");
}

function isTerminalTruncation(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("the model reached its output-token limit") ||
    lower.includes("automatic continuation stopped after two attempts")
  );
}

function isTruncationRecovery(message: ChatMessage): boolean {
  return (
    message.warningRetry?.retryAttempt !== undefined &&
    message.warningRetry.retryMaxAttempts !== undefined &&
    message.warningMessage
      ?.toLowerCase()
      .includes("continuing from the preserved partial response") === true
  );
}

function getWarningTitle(message: string, resolved: boolean): string {
  const lower = message.toLowerCase();
  if (lower.includes("rate_limit") || lower.includes("429")) {
    return resolved ? "Rate limit cleared" : "Rate limit reached";
  }
  if (isOverloadedWarning(message)) {
    return resolved ? "Provider recovered" : "Provider is overloaded";
  }
  if (lower.includes("timed out") || lower.includes("timeout")) {
    return resolved ? "Request resumed" : "Response timed out";
  }
  if (
    lower.includes("connection") ||
    lower.includes("eaddrnotavail") ||
    lower.includes("econn") ||
    lower.includes("fetch failed")
  ) {
    return resolved ? "Connection restored" : "Connection interrupted";
  }
  return resolved ? "Request resumed" : "Request interrupted";
}

export function WarningRow({
  messages,
  resolved = false,
  onRetry,
}: WarningRowProps) {
  const message = messages[messages.length - 1];
  const warningText = message.warningMessage ?? "";
  const terminalTruncation = isTerminalTruncation(warningText);
  const truncationRecovery = isTruncationRecovery(message);
  const retryAt = message.warningRetry?.retryAt;
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!retryAt) return;
    setNowMs(Date.now());

    const timer = setInterval(() => {
      const next = Date.now();
      setNowMs(next);
      if (next >= retryAt) {
        clearInterval(timer);
      }
    }, 250);

    return () => clearInterval(timer);
  }, [retryAt]);

  const status = useMemo(
    () => formatRetryStatus(message, nowMs),
    [message, nowMs],
  );
  const attempt = message.warningRetry?.retryAttempt;
  const maxAttempts = message.warningRetry?.retryMaxAttempts;
  const attemptLabel =
    attempt !== undefined
      ? `Attempt ${attempt}${maxAttempts !== undefined ? ` of ${maxAttempts}` : ""}`
      : undefined;
  const retryCount = messages.filter(
    (warning) => warning.warningRetry?.retryAttempt !== undefined,
  ).length;
  const retryStatus = truncationRecovery
    ? warningText
    : `${status}${attemptLabel ? ` · ${attemptLabel}` : ""}`;
  const resolvedStatus = retryCount
    ? `${retryCount} automatic ${retryCount === 1 ? "retry" : "retries"}`
    : undefined;
  const isResolved = resolved && !terminalTruncation;

  return (
    <ErrorNotice
      tone={
        terminalTruncation ? "error" : isResolved ? "recovered" : "recovering"
      }
      title={
        terminalTruncation || truncationRecovery
          ? "Response truncated"
          : getWarningTitle(warningText, isResolved)
      }
      status={
        terminalTruncation
          ? "Paused"
          : isResolved
            ? resolvedStatus
            : retryStatus
      }
      hint={
        terminalTruncation
          ? "Automatic continuation stopped. The partial response was preserved; send Continue to resume."
          : isResolved
            ? "The agent continued successfully."
            : isOverloadedWarning(warningText)
              ? "The provider may be having issues on their end — there's nothing to fix here. The agent will keep retrying until it recovers."
              : "The agent is still running; no action is needed."
      }
      details={messages.map((warning) => warning.warningMessage ?? "")}
      actions={
        !terminalTruncation && message.error && onRetry ? (
          <button type="button" class="error-retry-btn" onClick={onRetry}>
            <i class="codicon codicon-refresh" />
            Retry now
          </button>
        ) : undefined
      }
    />
  );
}
