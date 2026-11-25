import { RulePatternInput } from "./RulePatternInput.js";
import { useState } from "preact/hooks";

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
/** What the rule matches: every file (blanket), or a path pattern. */
export type FilePermissionRuleMatch = "all" | FilePermissionRuleMode;

/**
 * Folder containing a file, keeping the trailing separator so prefix rules
 * read as folder rules. Empty when the path has no folder worth trusting on
 * its own (a bare file name, or a file directly under a filesystem root).
 */
export function ruleFolder(filePath: string): string {
  const separator = Math.max(
    filePath.lastIndexOf("/"),
    filePath.lastIndexOf("\\"),
  );
  const folder = filePath.substring(0, separator + 1);
  if (folder.length <= 1 || /^[A-Za-z]:[\\/]$/.test(folder)) return "";
  return folder;
}

/**
 * Starting pattern for each match mode: the containing folder (prefix), the
 * file itself (exact), or the files directly inside that folder (glob).
 */
export function defaultRulePattern(
  filePath: string,
  mode: FilePermissionRuleMode,
): string {
  const folder = ruleFolder(filePath);
  if (mode === "exact" || !folder) return filePath;
  return mode === "glob" ? `${folder}*` : folder;
}

const SCOPE_LABELS: Record<FilePermissionRuleScope, string> = {
  session: "Session",
  project: "Project",
  global: "Global",
  skip: "Skip",
};

const MATCH_LABELS: Record<FilePermissionRuleMatch, string> = {
  all: "All files",
  prefix: "Prefix",
  exact: "Exact",
  glob: "Glob",
};

export interface FilePermissionRuleState {
  match: FilePermissionRuleMatch;
  pattern: string;
  scope: FilePermissionRuleScope;
  isSkipped: boolean;
  allowAllFiles: boolean;
  setPattern: (pattern: string) => void;
  selectMatch: (match: FilePermissionRuleMatch) => void;
  selectScope: (scope: FilePermissionRuleScope) => void;
}

/**
 * Shared rule state for every file approval card, so the same clicks do the
 * same thing for reads and writes, inside and outside the workspace:
 * - the rule starts skipped, on a folder prefix unless `defaultMatch` says so;
 * - picking a scope or a match mode both switch the rule on (at Session);
 * - changing mode swaps an untouched pattern to that mode's default, while a
 *   hand-edited pattern is kept.
 */
export function useFilePermissionRule(options: {
  filePath: string;
  /** Offer the blanket "All files" option (in-workspace writes only). */
  allowAllFiles?: boolean;
  defaultMatch?: FilePermissionRuleMatch;
}): FilePermissionRuleState {
  const { filePath, allowAllFiles = false, defaultMatch = "prefix" } = options;
  const [match, setMatch] = useState<FilePermissionRuleMatch>(defaultMatch);
  const [pattern, setPattern] = useState(() =>
    defaultRulePattern(
      filePath,
      defaultMatch === "all" ? "prefix" : defaultMatch,
    ),
  );
  const [scope, setScope] = useState<FilePermissionRuleScope>("skip");

  const selectMatch = (next: FilePermissionRuleMatch) => {
    setMatch(next);
    if (next !== "all") {
      const untouched =
        !pattern.trim() ||
        FILE_PERMISSION_RULE_MODES.some(
          (mode) => pattern === defaultRulePattern(filePath, mode),
        );
      if (untouched) setPattern(defaultRulePattern(filePath, next));
    }
    if (scope === "skip") setScope("session");
  };

  return {
    match,
    pattern,
    scope,
    isSkipped: scope === "skip",
    allowAllFiles,
    setPattern,
    selectMatch,
    selectScope: setScope,
  };
}

/** Decision fields describing which files a saved write rule covers. */
export function writeTrustFields(rule: FilePermissionRuleState) {
  return rule.match === "all"
    ? { trustScope: "all-files" as const }
    : {
        trustScope: "pattern" as const,
        rulePattern: rule.pattern,
        ruleMode: rule.match,
      };
}

interface FilePermissionRuleEditorProps {
  label: string;
  modeGroupName: string;
  rule: FilePermissionRuleState;
}

/** Shared path-rule controls for file read, write, and rename approvals. */
export function FilePermissionRuleEditor({
  label,
  modeGroupName,
  rule,
}: FilePermissionRuleEditorProps) {
  const { isSkipped, match } = rule;
  const matches: readonly FilePermissionRuleMatch[] = rule.allowAllFiles
    ? ["all", ...FILE_PERMISSION_RULE_MODES]
    : FILE_PERMISSION_RULE_MODES;

  return (
    <div class={`rule-row ${isSkipped ? "rule-row-skipped" : ""}`}>
      {label && (
        <div class="rule-row-header">
          <span class="rule-row-label">
            Matching path: <code>{label}</code>
          </span>
        </div>
      )}
      <div class="rule-row-input-line">
        <RulePatternInput
          value={rule.pattern}
          ariaLabel="Path pattern"
          dimmed={isSkipped || match === "all"}
          disabled={isSkipped || match === "all"}
          onChange={rule.setPattern}
        />
        <div class="radio-group">
          {matches.map((candidate) => (
            <label key={candidate} class="radio-label">
              <input
                type="radio"
                name={modeGroupName}
                checked={match === candidate}
                onChange={() => rule.selectMatch(candidate)}
              />
              {MATCH_LABELS[candidate]}
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
                class={`mode-btn ${rule.scope === candidate ? "active" : ""} ${candidate === "skip" ? "mode-btn-skip" : ""}`}
                onClick={() => rule.selectScope(candidate)}
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
