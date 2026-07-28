import type { BackgroundResultState } from "../../../core/capabilities/background";
import { StreamingText } from "./StreamingText";
import { getBackgroundResultPresentation } from "../../../shared/backgroundResultPresentation";

interface BgAgentResultBlockProps {
  sessionId: string;
  task: string;
  status: "completed" | "error" | "cancelled";
  resultState?: BackgroundResultState;
  terminalReason?: string;
  resultText?: string;
  partialOutput?: string;
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
  resultState,
  terminalReason,
  resultText,
  partialOutput,
  summary,
  resolvedModel,
  resolvedProvider,
  onOpenTranscript,
  onOpenFile,
}: BgAgentResultBlockProps) {
  const presentation = getBackgroundResultPresentation(
    resultState,
    status,
    terminalReason,
  );
  const statusClass = `bg-agent-result-${presentation.family}`;
  const trimmedResultText = resultText?.trim();
  const trimmedPartialOutput = partialOutput?.trim();
  const trimmedSummary = summary?.trim();
  const visibleResult =
    presentation.family === "success"
      ? trimmedResultText || trimmedSummary
      : trimmedPartialOutput || trimmedSummary;

  return (
    <div class={`bg-agent-result-block ${statusClass}`}>
      <div class="bg-agent-result-header">
        <i class={`codicon ${presentation.icon}`} />
        <span class="bg-agent-result-title">{presentation.title}</span>
        <span class="bg-agent-result-task">
          {task} — {presentation.statusText}
        </span>
        {resolvedModel && (
          <span class="bg-agent-result-model">
            {resolvedProvider ? `${resolvedProvider} / ` : ""}
            {resolvedModel}
          </span>
        )}
      </div>

      <div class="bg-result-content">
        {presentation.reason && (
          <div class="bg-result-reason">{presentation.reason}</div>
        )}
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
