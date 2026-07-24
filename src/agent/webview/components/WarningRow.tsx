import { useEffect, useMemo, useState } from "preact/hooks";

import type { ChatMessage } from "../types";
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
      : messages.length > 1
        ? `${messages.length} retries`
        : undefined;
  const retryStatus = `${status}${attemptLabel ? ` · ${attemptLabel}` : ""}`;
  const resolvedStatus = `${messages.length} automatic ${messages.length === 1 ? "retry" : "retries"}`;

  return (
    <ErrorNotice
      tone={resolved ? "recovered" : "recovering"}
      title={getWarningTitle(message.warningMessage ?? "", resolved)}
      status={resolved ? resolvedStatus : retryStatus}
      hint={
        resolved
          ? "The agent continued successfully."
          : isOverloadedWarning(message.warningMessage ?? "")
            ? "The provider may be having issues on their end — there's nothing to fix here. The agent will keep retrying until it recovers."
            : "The agent is still running; no action is needed."
      }
      details={messages.map((warning) => warning.warningMessage ?? "")}
      actions={
        message.error && onRetry ? (
          <button type="button" class="error-retry-btn" onClick={onRetry}>
            <i class="codicon codicon-refresh" />
            Retry now
          </button>
        ) : undefined
      }
    />
  );
}
