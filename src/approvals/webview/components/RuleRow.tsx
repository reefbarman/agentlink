import type { RuleEntry, SubCommandEntry } from "../types.js";

const MODES = ["prefix", "exact", "regex"] as const;
const SCOPES = ["session", "project", "global", "skip"] as const;
const SCOPE_LABELS: Record<string, string> = {
  session: "Session",
  project: "Project",
  global: "Global",
  skip: "Skip",
};

interface RuleRowProps {
  entry: SubCommandEntry;
  value: RuleEntry;
  modeGroupName: string;
  onChange: (value: RuleEntry) => void;
  onSuggestRegex?: () => void;
  onAcceptSuggestion?: () => void;
  onDismissSuggestion?: () => void;
  suggestedPattern?: string;
  suggestStatus?: "idle" | "loading" | "error";
  suggestError?: string;
}

export function RuleRow({
  entry,
  value,
  modeGroupName,
  onChange,
  onSuggestRegex,
  onAcceptSuggestion,
  onDismissSuggestion,
  suggestedPattern,
  suggestStatus = "idle",
  suggestError,
}: RuleRowProps) {
  const hasExisting = !!entry.existingRule;
  const isSkipped = value.scope === "skip";
  const canSuggest = !!onSuggestRegex;
  const isSuggesting = suggestStatus === "loading";

  return (
    <div class={`rule-row ${isSkipped ? "rule-row-skipped" : ""}`}>
      <div class="rule-row-header">
        <span class="rule-row-label">
          Matching command: <code>{entry.command}</code>
        </span>
        {hasExisting && (
          <span class="rule-row-badge">
            Matched: {entry.existingRule!.scope}
          </span>
        )}
      </div>

      <div class="rule-row-input-line">
        <input
          type="text"
          class={`text-input rule-pattern-input ${isSkipped ? "skipped" : ""}`}
          value={value.pattern}
          onInput={(e) =>
            onChange({
              ...value,
              pattern: (e.target as HTMLInputElement).value,
            })
          }
          disabled={isSkipped}
        />
        <div class="radio-group">
          {MODES.map((mode) => (
            <label key={mode} class="radio-label">
              <input
                type="radio"
                name={modeGroupName}
                checked={value.mode === mode}
                onChange={() => onChange({ ...value, mode })}
                disabled={isSkipped}
              />
              {mode.charAt(0).toUpperCase() + mode.slice(1)}
              {mode === "regex" && canSuggest && (
                <button
                  type="button"
                  class="rule-suggest-btn"
                  onClick={onSuggestRegex}
                  disabled={isSuggesting}
                  title="Ask the current model to suggest a reviewable regex for this command and useful same-shape variants"
                >
                  <span
                    class={`codicon ${isSuggesting ? "codicon-loading codicon-modifier-spin" : "codicon-sparkle"}`}
                  />
                  <span>{isSuggesting ? "Suggesting…" : "Safe regex"}</span>
                </button>
              )}
            </label>
          ))}
        </div>
      </div>
      {suggestStatus === "error" && suggestError && (
        <div class="rule-row-suggest-error">{suggestError}</div>
      )}
      {suggestedPattern && (
        <div class="rule-row-suggestion">
          <div class="rule-row-suggestion-header">
            <span class="rule-row-suggestion-title">
              <span class="codicon codicon-sparkle" /> AI suggested regex
            </span>
            <button
              type="button"
              class="rule-row-suggestion-close"
              onClick={onDismissSuggestion}
              title="Dismiss suggestion"
            >
              <span class="codicon codicon-close" />
            </button>
          </div>
          <code>{suggestedPattern}</code>
          <div class="rule-row-suggestion-actions">
            <button
              type="button"
              class="rule-row-suggestion-accept"
              onClick={onAcceptSuggestion}
            >
              Accept suggestion
            </button>
          </div>
        </div>
      )}

      <div class="rule-row-options">
        <div class="rule-row-option-line">
          <span class="rule-row-option-label">Scope:</span>
          <div class="toggle-group">
            {SCOPES.map((scope) => (
              <button
                key={scope}
                type="button"
                class={`mode-btn ${value.scope === scope ? "active" : ""} ${scope === "skip" ? "mode-btn-skip" : ""}`}
                onClick={() =>
                  onChange({
                    ...value,
                    scope,
                    ...(value.scope === "skip" && scope !== "skip"
                      ? { mode: entry.existingRule?.mode ?? "prefix" }
                      : {}),
                  })
                }
              >
                {SCOPE_LABELS[scope]}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
