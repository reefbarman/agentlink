import { useState } from "preact/hooks";
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
  onChange: (value: RuleEntry) => void;
}

export function RuleRow({ entry, value, onChange }: RuleRowProps) {
  const hasExisting = !!entry.existingRule;
  const isSkipped = value.scope === "skip";

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
            onChange({ ...value, pattern: (e.target as HTMLInputElement).value })
          }
          disabled={isSkipped}
        />
        <div class="radio-group">
          {MODES.map((mode) => (
            <label key={mode} class="radio-label">
              <input
                type="radio"
                name={`mode-${entry.command}`}
                checked={value.mode === mode}
                onChange={() => onChange({ ...value, mode })}
                disabled={isSkipped}
              />
              {mode.charAt(0).toUpperCase() + mode.slice(1)}
            </label>
          ))}
        </div>
      </div>

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
