import { useState } from "preact/hooks";

interface DebugInfoProps {
  info: Record<string, string | number>;
  systemPrompt?: string | null;
  loadedInstructions?: Array<{ source: string; chars: number }>;
}

const MAX_VALUE_LENGTH = 60;

function DebugValue({ value }: { value: string }) {
  const [expanded, setExpanded] = useState(false);
  const text = String(value);

  if (text.length <= MAX_VALUE_LENGTH) {
    return <span>{text}</span>;
  }

  return (
    <span
      class={`debug-value-truncatable ${expanded ? "expanded" : ""}`}
      onClick={() => setExpanded(!expanded)}
      title={expanded ? "Click to collapse" : "Click to expand"}
    >
      {expanded ? text : `${text.slice(0, MAX_VALUE_LENGTH)}…`}
    </span>
  );
}

export function DebugInfo({
  info,
  systemPrompt,
  loadedInstructions,
}: DebugInfoProps) {
  const [expanded, setExpanded] = useState(false);
  const [promptExpanded, setPromptExpanded] = useState(false);
  const [instructionsExpanded, setInstructionsExpanded] = useState(false);

  const totalChars =
    loadedInstructions?.reduce((sum, i) => sum + i.chars, 0) ?? 0;

  return (
    <div class="debug-info">
      <button
        class="debug-info-header"
        onClick={() => setExpanded(!expanded)}
        type="button"
      >
        <i class={`codicon codicon-chevron-${expanded ? "down" : "right"}`} />
        <span>Environment</span>
      </button>
      {expanded && (
        <div class="debug-info-content">
          <div class="debug-info-scroll">
            <table>
              <tbody>
                {Object.entries(info).map(([key, value]) => (
                  <tr key={key}>
                    <td class="debug-key">{key}</td>
                    <td class="debug-value">
                      <DebugValue value={String(value)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {loadedInstructions && loadedInstructions.length > 0 && (
            <div class="debug-prompt-section">
              <button
                class="debug-prompt-toggle"
                onClick={() => setInstructionsExpanded(!instructionsExpanded)}
                type="button"
              >
                <i
                  class={`codicon codicon-chevron-${instructionsExpanded ? "down" : "right"}`}
                />
                <span>
                  Loaded Instructions ({loadedInstructions.length} file
                  {loadedInstructions.length !== 1 ? "s" : ""},{" "}
                  {totalChars.toLocaleString()} chars)
                </span>
              </button>
              {instructionsExpanded && (
                <div class="debug-info-scroll">
                  <table>
                    <tbody>
                      {loadedInstructions.map((inst) => (
                        <tr key={inst.source}>
                          <td class="debug-key">{inst.source}</td>
                          <td class="debug-value">
                            {inst.chars.toLocaleString()} chars
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
          {systemPrompt && (
            <div class="debug-prompt-section">
              <button
                class="debug-prompt-toggle"
                onClick={() => setPromptExpanded(!promptExpanded)}
                type="button"
              >
                <i
                  class={`codicon codicon-chevron-${promptExpanded ? "down" : "right"}`}
                />
                <span>System Prompt</span>
              </button>
              {promptExpanded && (
                <pre class="debug-prompt-content">{systemPrompt}</pre>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
