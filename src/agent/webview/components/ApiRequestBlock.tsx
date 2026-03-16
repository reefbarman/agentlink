import { useState } from "preact/hooks";

interface ApiRequestBlockProps {
  requestId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  timeToFirstToken: number;
}

export function ApiRequestBlock({
  model,
  inputTokens,
  outputTokens,
  durationMs,
  timeToFirstToken,
}: ApiRequestBlockProps) {
  const [expanded, setExpanded] = useState(false);

  const totalTokens = inputTokens + outputTokens;
  const summary = `${model} · ${totalTokens.toLocaleString()} tokens · ${(durationMs / 1000).toFixed(1)}s`;

  return (
    <div class="api-request-block">
      <button class="api-request-header" onClick={() => setExpanded(!expanded)}>
        <i class={`codicon codicon-chevron-${expanded ? "down" : "right"}`} />
        <i class="codicon codicon-pulse" />
        <span class="api-request-summary">{summary}</span>
      </button>
      {expanded && (
        <div class="api-request-content">
          <table>
            <tr>
              <td class="api-key">Model</td>
              <td class="api-value">{model}</td>
            </tr>
            <tr>
              <td class="api-key">Input tokens</td>
              <td class="api-value">{inputTokens.toLocaleString()}</td>
            </tr>
            <tr>
              <td class="api-key">Output tokens</td>
              <td class="api-value">{outputTokens.toLocaleString()}</td>
            </tr>
            <tr>
              <td class="api-key">Duration</td>
              <td class="api-value">{(durationMs / 1000).toFixed(2)}s</td>
            </tr>
            <tr>
              <td class="api-key">Time to first token</td>
              <td class="api-value">{(timeToFirstToken / 1000).toFixed(2)}s</td>
            </tr>
          </table>
        </div>
      )}
    </div>
  );
}
