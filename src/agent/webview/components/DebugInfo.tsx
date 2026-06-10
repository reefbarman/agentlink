import type { LoadedInstructionDebugInfo } from "../../../shared/chatProjection.js";
import { useState } from "preact/hooks";

interface DebugInfoProps {
  info: Record<string, string | number>;
  systemPrompt?: string | null;
  loadedInstructions?: LoadedInstructionDebugInfo[];
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

  const totalSourceChars =
    loadedInstructions?.reduce((sum, i) => sum + i.chars, 0) ?? 0;
  const totalPromptChars =
    loadedInstructions?.reduce(
      (sum, i) => sum + (i.promptChars ?? i.chars),
      0,
    ) ?? 0;
  const deferredCount =
    loadedInstructions?.filter((instruction) => instruction.deferred).length ??
    0;

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
                  {totalPromptChars.toLocaleString()} body prompt chars
                  {deferredCount > 0
                    ? ` · ${deferredCount.toLocaleString()} deferred · ${totalSourceChars.toLocaleString()} source chars`
                    : ""}
                  )
                </span>
              </button>
              {instructionsExpanded && (
                <div class="debug-info-scroll">
                  <table>
                    <tbody>
                      {loadedInstructions.map((inst) => {
                        const status = inst.deferred
                          ? "deferred"
                          : inst.alwaysApply
                            ? inst.kind === "rule" && !inst.hasFrontmatter
                              ? "inline · default"
                              : "inline · alwaysApply"
                            : "inline";
                        const promptChars = inst.promptChars ?? inst.chars;
                        const detailParts = [
                          `${status}`,
                          `${promptChars.toLocaleString()} body prompt chars`,
                          `${inst.chars.toLocaleString()} source chars`,
                          inst.summary ? `summary: ${inst.summary}` : undefined,
                          inst.globs?.length
                            ? `globs: ${inst.globs.join(", ")}`
                            : undefined,
                          inst.loadPath ? `load: ${inst.loadPath}` : undefined,
                        ].filter(Boolean);

                        return (
                          <tr key={inst.source}>
                            <td class="debug-key">{inst.source}</td>
                            <td class="debug-value">
                              <DebugValue value={detailParts.join(" · ")} />
                            </td>
                          </tr>
                        );
                      })}
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
