import { useEffect, useState } from "preact/hooks";
import type { ChatMessage } from "../types";
import { ErrorNotice } from "./ErrorNotice";

interface CondenseRowProps {
  message: ChatMessage;
}

function formatK(n: number): string {
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Spinner shown while condensing is in progress, with a live elapsed-time counter. */
function CondensingSpinner() {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const start = Date.now();
    const interval = setInterval(
      () => setElapsed(Math.floor((Date.now() - start) / 1000)),
      1000,
    );
    return () => clearInterval(interval);
  }, []);

  return (
    <div class="condense-row condense-row-condensing">
      <div class="condense-row-line" />
      <div class="condense-row-content">
        <div class="condense-row-badge">
          <i class="codicon codicon-loading codicon-modifier-spin" />
          <span class="condense-row-label">Condensing context…</span>
          <span class="condense-row-detail">{elapsed}s</span>
        </div>
      </div>
      <div class="condense-row-line" />
    </div>
  );
}

export function CondenseRow({ message }: CondenseRowProps) {
  const info = message.condenseInfo;
  const isError = !!info?.errorMessage;

  if (info?.condensing) {
    return <CondensingSpinner />;
  }

  if (isError) {
    return (
      <ErrorNotice
        tone="error"
        title="Context condensing failed"
        hint="The existing conversation context is unchanged."
        details={[info!.errorMessage!]}
      />
    );
  }

  const saved = info
    ? Math.max(0, info.prevInputTokens - info.newInputTokens)
    : 0;
  const savedPct =
    info && info.prevInputTokens > 0
      ? Math.round((saved / info.prevInputTokens) * 100)
      : 0;
  const validationWarnings = info?.validationWarnings ?? [];

  return (
    <div class="condense-row">
      <div class="condense-row-line" />
      <div
        class={`condense-row-content${validationWarnings.length > 0 ? " condense-row-content-with-warning" : ""}`}
      >
        <div class="condense-row-badge">
          <i class="codicon codicon-fold" />
          <span class="condense-row-label">Context condensed</span>
          {info && (
            <span class="condense-row-detail condense-row-stats">
              {formatK(info.prevInputTokens)} → {formatK(info.newInputTokens)}{" "}
              tokens
              {savedPct > 0 && (
                <span class="condense-row-saved"> (−{savedPct}%)</span>
              )}
              {info.durationMs !== undefined && (
                <span class="condense-row-duration">
                  {" · "}
                  {formatDuration(info.durationMs)}
                </span>
              )}
            </span>
          )}
        </div>
        {validationWarnings.length > 0 && (
          <div class="condense-row-warning">
            <i class="codicon codicon-warning" />
            <span>{validationWarnings.join(" · ")}</span>
          </div>
        )}
      </div>
      <div class="condense-row-line" />
    </div>
  );
}
