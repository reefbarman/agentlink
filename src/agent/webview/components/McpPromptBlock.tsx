import type { McpPromptPresentation } from "../../../shared/mcpPromptPresentation.js";
import { useState } from "preact/hooks";

/** Display-only card. An MCP prompt is not a tool call or an approval grant. */
export function McpPromptBlock({ prompt }: { prompt: McpPromptPresentation }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div class="tool-call-block mcp-prompt-block">
      <button
        type="button"
        class="tool-call-header"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
      >
        <i
          class={`codicon codicon-chevron-${expanded ? "down" : "right"} tool-call-chevron`}
        />
        <i class="codicon codicon-server tool-call-status-icon" />
        <span class="tool-call-name">MCP prompt</span>
        <span class="tool-call-summary">
          {prompt.serverName} / {prompt.promptName}
        </span>
      </button>
      {expanded && (
        <div class="tool-call-details">
          <p>
            Server-provided text. Actions still require their usual approvals.
          </p>
          <pre class="tool-call-code">{prompt.body}</pre>
        </div>
      )}
    </div>
  );
}
