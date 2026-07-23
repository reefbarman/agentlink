import { useState } from "preact/hooks";
import type { ContentBlock } from "../types";
import { ThinkingContent } from "./ThinkingContent";

type ThinkingData = ContentBlock & { type: "thinking" };

interface ThinkingBlockProps {
  block: ThinkingData;
}

export function ThinkingBlock({ block }: ThinkingBlockProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      class={`thinking-block thinking-block-complete ${expanded ? "expanded" : "collapsed"}`}
    >
      <button
        class="thinking-header"
        onClick={() => setExpanded(!expanded)}
        type="button"
        aria-expanded={expanded}
      >
        <i class={`codicon codicon-chevron-${expanded ? "down" : "right"}`} />
        <i class="codicon codicon-lightbulb thinking-icon" />
        <span class="thinking-label">Thinking</span>
      </button>
      {expanded && (
        <div class="thinking-content">
          <ThinkingContent text={block.text} />
        </div>
      )}
    </div>
  );
}
