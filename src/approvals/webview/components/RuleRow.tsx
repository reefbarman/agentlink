import type { RuleEntry, SubCommandEntry } from "../types.js";

import { isBannedCommandRulePrefixSuggestion } from "../../commandRulePolicy.js";

const MODES = ["prefix", "exact", "regex"] as const;
const DECISIONS = ["legacy", "allow", "prompt", "forbidden"] as const;
const SCOPES = ["session", "project", "global", "skip"] as const;
const SCOPE_LABELS: Record<string, string> = {
  session: "Session",
  project: "Project",
  global: "Global",
  skip: "Skip",
};

const DECISION_LABELS = {
  legacy: "Approval only",
  allow: "Allow",
  prompt: "Prompt",
  forbidden: "Forbidden",
} as const;

const TIER_LABELS = {
  safe: "Safe",
  sensitive: "Sensitive",
  dangerous: "Dangerous",
} as const;

interface RuleRowProps {
  entry: SubCommandEntry;
  value: RuleEntry;
  modeGroupName: string;
  onChange: (value: RuleEntry) => void;
  onSuggestRegex?: () => void;
  /** Command broken into tokens with their cumulative prefixes, for the picker. */
  prefixTokens?: Array<{ token: string; prefix: string }>;
  /** Select a different prefix boundary (command vs. sub-command vs. …). */
  onSelectPrefix?: (prefix: string) => void;
  onAcceptSuggestion?: () => void;
  onDismissSuggestion?: () => void;
  suggestedPattern?: string;
  /** Which kind of suggestion `suggestedPattern` is, for labelling the block. */
  suggestKind?: "regex" | "prefix";
  suggestStatus?: "idle" | "loading" | "error";
  suggestError?: string;
}

export function RuleRow({
  entry,
  value,
  modeGroupName,
  onChange,
  onSuggestRegex,
  prefixTokens,
  onSelectPrefix,
  onAcceptSuggestion,
  onDismissSuggestion,
  suggestedPattern,
  suggestKind = "regex",
  suggestStatus = "idle",
  suggestError,
}: RuleRowProps) {
  const hasExisting = !!entry.existingRule;
  const isSkipped = value.scope === "skip";
  const canSuggest = !!onSuggestRegex;
  const isSuggesting = suggestStatus === "loading";
  const broadNativePrefix =
    !isSkipped &&
    value.mode === "prefix" &&
    (value.decision ?? "legacy") === "allow" &&
    isBannedCommandRulePrefixSuggestion(value.pattern);

  return (
    <div class={`rule-row ${isSkipped ? "rule-row-skipped" : ""}`}>
      <div class="rule-row-header">
        <span class="rule-row-label">
          Matching command: <code>{entry.command}</code>
        </span>
        {entry.tier && (
          <span
            class={`rule-row-badge rule-row-tier-badge tier-${entry.tier.tier}`}
            title={entry.tier.reason}
          >
            {TIER_LABELS[entry.tier.tier]}
          </span>
        )}
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
              {suggestKind === "prefix" ? (
                <>
                  <span class="codicon codicon-lightbulb" /> Suggested prefix
                </>
              ) : (
                <>
                  <span class="codicon codicon-sparkle" /> AI suggested regex
                </>
              )}
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
          {suggestKind === "prefix" &&
          prefixTokens &&
          prefixTokens.length > 0 ? (
            <>
              <div class="rule-prefix-tokens">
                {prefixTokens.map((t) => (
                  <button
                    type="button"
                    key={t.prefix}
                    class={`rule-prefix-token ${t.prefix.length <= (suggestedPattern?.length ?? 0) ? "active" : ""}`}
                    onClick={() => onSelectPrefix?.(t.prefix)}
                    title={`Allow commands starting with “${t.prefix}”; active exact/prefix allow rules may authorize native execution`}
                  >
                    {t.token}
                  </button>
                ))}
              </div>
              <code>{suggestedPattern}</code>
            </>
          ) : (
            <code>{suggestedPattern}</code>
          )}
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
        {!isSkipped && (value.decision ?? "legacy") === "allow" && (
          <div class="rule-row-authority-note">
            {value.mode === "regex"
              ? "This regex rule skips future approval but stays inside the Protected Terminal. Regex matches do not grant native execution authority."
              : broadNativePrefix
                ? "Broad native prefix: this rule can authorize any matching command outside the Protected Terminal with your normal user permissions. Narrow the prefix unless you intend to trust the entire command family."
                : "This rule skips future approval and may run matching commands outside the Protected Terminal with your normal user permissions. Every parsed command segment must have an explicit exact or prefix allow match."}
          </div>
        )}
        <div class="rule-row-option-line">
          <span class="rule-row-option-label">Decision:</span>
          <div class="toggle-group">
            {DECISIONS.map((decision) => (
              <button
                key={decision}
                type="button"
                class={`mode-btn ${(value.decision ?? "legacy") === decision ? "active" : ""}`}
                onClick={() =>
                  onChange({
                    ...value,
                    decision: decision === "legacy" ? undefined : decision,
                  })
                }
                disabled={isSkipped}
              >
                {decision === "allow"
                  ? value.mode === "regex"
                    ? "Allow (sandboxed)"
                    : "Allow (native)"
                  : DECISION_LABELS[decision]}
              </button>
            ))}
          </div>
        </div>
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
