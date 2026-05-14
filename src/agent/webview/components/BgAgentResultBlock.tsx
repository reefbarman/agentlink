import { DetailBlock } from "../../../shared/ui/Meta";
import { StreamingText } from "./StreamingText";
import { summarizeTextForPreview } from "../../../shared/textSummary";
import { useState } from "preact/hooks";

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
  const [expanded, setExpanded] = useState(false);

  const statusClass =
    status === "completed"
      ? "tool-success"
      : status === "error"
        ? "tool-error"
        : "tool-warning";

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

  const preview = !expanded
    ? summary?.trim() ||
      summarizeTextForPreview(resultText, {
        maxLength: 220,
        minSentenceLength: 20,
      }) ||
      null
    : null;

  return (
    <div class={`tool-call-block ${statusClass}`}>
      <button
        class="tool-call-header"
        onClick={() => setExpanded(!expanded)}
        type="button"
      >
        <i
          class={`codicon codicon-chevron-${expanded ? "down" : "right"} tool-call-chevron`}
        />
        <i class={`codicon tool-call-status-icon ${icon}`} />
        <span class="tool-call-name">Background Result</span>
        <span class="tool-call-summary">
          {task} — {statusText}
        </span>
      </button>
      {preview && <div class="bg-result-preview">{preview}</div>}

      {expanded && (
        <div class="tool-call-details">
          {resultText ? (
            <div class="bg-result-content">
              <StreamingText text={resultText} streaming={false} />
            </div>
          ) : (
            <DetailBlock label="Output" className="tool-call-section">
              <pre class="tool-call-code">No output available.</pre>
            </DetailBlock>
          )}
          <button
            class="bg-agent-transcript-btn"
            onClick={(e) => {
              e.stopPropagation();
              onOpenTranscript?.(sessionId);
            }}
          >
            <i class="codicon codicon-open-preview" /> View Full Transcript
          </button>
        </div>
      )}
    </div>
  );
}
