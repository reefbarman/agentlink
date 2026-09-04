export const FILE_PERMISSION_RULE_MODES = ["prefix", "exact", "glob"] as const;
export const FILE_PERMISSION_RULE_SCOPES = [
  "session",
  "project",
  "global",
  "skip",
] as const;

export type FilePermissionRuleMode =
  (typeof FILE_PERMISSION_RULE_MODES)[number];
export type FilePermissionRuleScope =
  (typeof FILE_PERMISSION_RULE_SCOPES)[number];

const SCOPE_LABELS: Record<FilePermissionRuleScope, string> = {
  session: "Session",
  project: "Project",
  global: "Global",
  skip: "Skip",
};

interface FilePermissionRuleEditorProps {
  label: string;
  pattern: string;
  mode: FilePermissionRuleMode;
  scope: FilePermissionRuleScope;
  modeGroupName: string;
  onPatternChange: (pattern: string) => void;
  onModeChange: (mode: FilePermissionRuleMode) => void;
  onScopeChange: (scope: FilePermissionRuleScope) => void;
}

/** Shared path-rule controls for outside-workspace read and write approvals. */
export function FilePermissionRuleEditor({
  label,
  pattern,
  mode,
  scope,
  modeGroupName,
  onPatternChange,
  onModeChange,
  onScopeChange,
}: FilePermissionRuleEditorProps) {
  const isSkipped = scope === "skip";

  return (
    <div class={`rule-row ${isSkipped ? "rule-row-skipped" : ""}`}>
      <div class="rule-row-header">
        <span class="rule-row-label">
          Matching path: <code>{label}</code>
        </span>
      </div>
      <div class="rule-row-input-line">
        <input
          type="text"
          class={`text-input rule-pattern-input ${isSkipped ? "skipped" : ""}`}
          value={pattern}
          onInput={(event) =>
            onPatternChange((event.target as HTMLInputElement).value)
          }
          disabled={isSkipped}
        />
        <div class="radio-group">
          {FILE_PERMISSION_RULE_MODES.map((candidate) => (
            <label key={candidate} class="radio-label">
              <input
                type="radio"
                name={modeGroupName}
                checked={mode === candidate}
                onChange={() => onModeChange(candidate)}
                disabled={isSkipped}
              />
              {candidate.charAt(0).toUpperCase() + candidate.slice(1)}
            </label>
          ))}
        </div>
      </div>
      <div class="rule-row-options">
        <div class="rule-row-option-line">
          <span class="rule-row-option-label">Scope:</span>
          <div class="toggle-group">
            {FILE_PERMISSION_RULE_SCOPES.map((candidate) => (
              <button
                key={candidate}
                type="button"
                class={`mode-btn ${scope === candidate ? "active" : ""} ${candidate === "skip" ? "mode-btn-skip" : ""}`}
                onClick={() => onScopeChange(candidate)}
              >
                {SCOPE_LABELS[candidate]}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
