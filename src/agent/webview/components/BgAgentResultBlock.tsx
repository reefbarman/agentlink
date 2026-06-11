import { StreamingText } from "./StreamingText";
import { summarizeTextForPreview } from "../../../shared/textSummary";

interface BgAgentResultBlockProps {
  sessionId: string;
  task: string;
  status: "completed" | "error" | "cancelled";
  resultText?: string;
  summary?: string;
  onOpenTranscript?: (sessionId: string) => void;
}

export function BgAgentResultBlock({
  sessionId,
  task,
  status,
  resultText,
  summary,
  onOpenTranscript,
}: BgAgentResultBlockProps) {
  const statusClass =
    status === "completed"
      ? "bg-agent-result-completed"
      : status === "error"
        ? "bg-agent-result-error"
        : "bg-agent-result-cancelled";

  const icon =
    status === "completed"
      ? "codicon-check"
      : status === "error"
        ? "codicon-error"
        : "codicon-circle-slash";

  const statusText =
    status === "completed"
      ? "completed"
      : status === "error"
        ? "failed"
        : "cancelled";

  const visibleSummary =
    summary?.trim() ||
    summarizeTextForPreview(resultText, {
      maxLength: 220,
      minSentenceLength: 20,
    }) ||
    null;

  return (
    <div class={`bg-agent-result-block ${statusClass}`}>
      <div class="bg-agent-result-header">
        <i class={`codicon ${icon}`} />
        <span class="bg-agent-result-title">Background Result</span>
        <span class="bg-agent-result-task">
          {task} — {statusText}
        </span>
      </div>

      {visibleSummary && <div class="bg-result-preview">{visibleSummary}</div>}

      <div class="bg-result-content">
        {resultText ? (
          <StreamingText text={resultText} streaming={false} />
        ) : (
          <div class="bg-result-empty">No output available.</div>
        )}
      </div>

      {onOpenTranscript && (
        <button
          class="bg-agent-transcript-btn"
          onClick={() => onOpenTranscript(sessionId)}
          type="button"
        >
          <i class="codicon codicon-open-preview" /> View Full Transcript
        </button>
      )}
    </div>
  );
}
