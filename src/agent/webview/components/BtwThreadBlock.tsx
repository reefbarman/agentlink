import type { ParsedBtwThreadMessage } from "../../../shared/btwThread";
import { StreamingText } from "./StreamingText";
import { useState } from "preact/hooks";

/** Expandable /btw side thread attached to a user message. Display only. */
export function BtwThreadBlock({
  thread,
  onOpenFile,
}: {
  thread: ParsedBtwThreadMessage;
  onOpenFile?: (path: string, line?: number) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const canExpand = thread.exchanges.length > 0;
  const label = `${thread.count} exchange${thread.count === 1 ? "" : "s"}`;
  const firstQuestion = thread.exchanges[0]?.question.split("\n")[0];
  return (
    <div class="tool-call-block btw-thread-block">
      <button
        type="button"
        class="tool-call-header"
        aria-expanded={canExpand ? expanded : undefined}
        disabled={!canExpand}
        title={
          canExpand
            ? "Show the /btw side thread sent with this message"
            : "This message was sent before /btw threads were kept in the transcript"
        }
        onClick={() => canExpand && setExpanded(!expanded)}
      >
        {canExpand && (
          <i
            class={`codicon codicon-chevron-${expanded ? "down" : "right"} tool-call-chevron`}
          />
        )}
        <i class="codicon codicon-comment-discussion tool-call-status-icon" />
        <span class="tool-call-name">/btw thread</span>
        <span class="tool-call-summary">
          {label}
          {firstQuestion ? ` · ${firstQuestion}` : ""}
        </span>
      </button>
      {expanded && canExpand && (
        <div class="tool-call-details btw-thread-details">
          {thread.exchanges.map((exchange, index) => (
            <div class="btw-thread-exchange" key={index}>
              <div class="btw-thread-question">
                <i class="codicon codicon-comment" />
                <span>{exchange.question}</span>
              </div>
              <div class="btw-thread-answer">
                <StreamingText
                  text={exchange.answer}
                  streaming={false}
                  onOpenFile={onOpenFile}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
