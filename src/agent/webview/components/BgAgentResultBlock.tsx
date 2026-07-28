import { StreamingText } from "./StreamingText";

interface BgAgentResultBlockProps {
  sessionId: string;
  task: string;
  status: "completed" | "error" | "cancelled";
  resultText?: string;
  summary?: string;
  resolvedModel?: string;
  resolvedProvider?: string;
  onOpenTranscript?: (sessionId: string) => void;
  onOpenFile?: (path: string, line?: number) => void;
}

export function BgAgentResultBlock({
  sessionId,
  task,
  status,
  resultText,
  summary,
  resolvedModel,
  resolvedProvider,
  onOpenTranscript,
  onOpenFile,
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

  const trimmedResultText = resultText?.trim();
  const trimmedSummary = summary?.trim();
  const visibleResult = trimmedResultText || trimmedSummary;

  return (
    <div class={`bg-agent-result-block ${statusClass}`}>
      <div class="bg-agent-result-header">
        <i class={`codicon ${icon}`} />
        <span class="bg-agent-result-title">Background Result</span>
        <span class="bg-agent-result-task">
          {task} — {statusText}
        </span>
        {resolvedModel && (
          <span class="bg-agent-result-model">
            {resolvedProvider ? `${resolvedProvider} / ` : ""}
            {resolvedModel}
          </span>
        )}
      </div>

      <div class="bg-result-content">
        {visibleResult ? (
          <StreamingText
            text={visibleResult}
            streaming={false}
            onOpenFile={onOpenFile}
          />
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
