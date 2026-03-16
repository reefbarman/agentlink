import { useState } from "preact/hooks";
import type { ContentBlock } from "../types";

type ThinkingData = ContentBlock & { type: "thinking" };

interface ThinkingBlockProps {
  block: ThinkingData;
}

export function ThinkingBlock({ block }: ThinkingBlockProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div class={`thinking-block ${expanded ? "expanded" : "collapsed"}`}>
      <button
        class="thinking-header"
        onClick={() => setExpanded(!expanded)}
        type="button"
      >
        <i class={`codicon codicon-chevron-${expanded ? "down" : "right"}`} />
        <i class="codicon codicon-lightbulb thinking-icon" />
        <span class="thinking-label">
          {block.complete ? "Thinking" : "Thinking..."}
        </span>
        {!block.complete && (
          <i class="codicon codicon-loading thinking-spinner" />
        )}
      </button>
      {expanded && (
        <div class="thinking-content">
          <pre>{block.text}</pre>
        </div>
      )}
    </div>
  );
}
