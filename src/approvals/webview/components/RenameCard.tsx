import { useState, useCallback } from "preact/hooks";
import type { RefObject } from "preact";
import type { ApprovalRequest, DecisionMessage } from "../types.js";
import { ApprovalLayout } from "./ApprovalLayout.js";

const MODES = ["glob", "prefix", "exact"] as const;
const SCOPES = ["session", "project", "global", "skip"] as const;
const SCOPE_LABELS: Record<string, string> = {
  session: "Session",
  project: "Project",
  global: "Global",
  skip: "Skip",
};
const TRUST_SCOPES = ["all-files", "this-file", "pattern"] as const;

interface RenameCardProps {
  request: ApprovalRequest;
  submit: (data: Omit<DecisionMessage, "type">) => void;
  followUpRef: RefObject<string>;
}

export function RenameCard({ request, submit, followUpRef }: RenameCardProps) {
  const oldName = request.oldName ?? "?";
  const newName = request.newName ?? "?";
  const affectedFiles = request.affectedFiles ?? [];
  const totalChanges = request.totalChanges ?? 0;
  const fileCount = affectedFiles.length;

  const [trustScope, setTrustScope] =
    useState<(typeof TRUST_SCOPES)[number]>("all-files");
  const [pattern, setPattern] = useState("");
  const [mode, setMode] = useState<(typeof MODES)[number]>("glob");
  const [scope, setScope] = useState<(typeof SCOPES)[number]>("skip");

  const isSkipped = scope === "skip";

  const handleAccept = useCallback(() => {
    submit({ id: request.id, decision: "accept" });
  }, [request.id, submit]);

  const handleSaveAndAccept = useCallback(() => {
    const decision =
      scope === "session"
        ? "accept-session"
        : scope === "project"
          ? "accept-project"
          : "accept-always";
    submit({
      id: request.id,
      decision,
      trustScope,
      ...(trustScope === "pattern" && {
        rulePattern: pattern,
        ruleMode: mode,
      }),
      ...(trustScope === "this-file" && {
        rulePattern: affectedFiles[0]?.path ?? "",
        ruleMode: "exact",
      }),
    });
  }, [request.id, scope, trustScope, pattern, mode, affectedFiles, submit]);

  const handleReject = useCallback(
    (reason?: string) => {
      submit({ id: request.id, decision: "reject", rejectionReason: reason });
    },
    [request.id, submit],
  );

  const rulesJsx = (
    <>
      <div class="field">
        <label>Scope:</label>
        <div class="radio-group">
          {TRUST_SCOPES.map((ts) => (
            <label key={ts} class="radio-label">
              <input
                type="radio"
                name="trustScope"
                value={ts}
                checked={trustScope === ts}
                onChange={() => setTrustScope(ts)}
              />
              {ts === "all-files"
                ? "All files"
                : ts === "this-file"
                  ? "This file only"
                  : "Custom pattern"}
            </label>
          ))}
        </div>
      </div>

      {trustScope === "pattern" && (
        <div class="rule-row">
          <input
            type="text"
            class="text-input rule-pattern-input"
            value={pattern}
            onInput={(e) =>
              setPattern((e.target as HTMLInputElement).value)
            }
          />
          <div class="rule-row-toggles">
            <div class="toggle-group">
              {MODES.map((m) => (
                <button
                  key={m}
                  type="button"
                  class={`mode-btn ${mode === m ? "active" : ""}`}
                  onClick={() => setMode(m)}
                >
                  {m.charAt(0).toUpperCase() + m.slice(1)}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      <div class="rule-row-toggles" style={{ marginTop: "8px" }}>
        <div class="toggle-group">
          {SCOPES.map((s) => (
            <button
              key={s}
              type="button"
              class={`mode-btn ${scope === s ? "active" : ""} ${s === "skip" ? "mode-btn-skip" : ""}`}
              onClick={() => setScope(s)}
            >
              {SCOPE_LABELS[s]}
            </button>
          ))}
        </div>
      </div>
    </>
  );

  return (
    <ApprovalLayout
      queuePosition={request.queuePosition}
      queueTotal={request.queueTotal}
      rulesContent={rulesJsx}
      rulesModified={!isSkipped}
      primaryLabel="Accept"
      primaryWithRulesLabel="Save Rule & Accept"
      onAccept={handleAccept}
      onSaveAndAccept={handleSaveAndAccept}
      onReject={handleReject}
      followUpRef={followUpRef}
    >
      {/* Rename display */}
      <div class="rename-box">
        <div class="rename-header">
          <span class="codicon codicon-symbol-method" />
          <span>Rename Symbol</span>
        </div>
        <div class="rename-names">
          <span class="rename-old">{oldName}</span>
          <span class="codicon codicon-arrow-right rename-arrow" />
          <span class="rename-new">{newName}</span>
        </div>
      </div>

      {/* Affected files list */}
      <div class="rename-files">
        <div class="rename-files-header">
          Affected Files
          <span class="badge rename-summary-badge">
            {totalChanges} change{totalChanges !== 1 ? "s" : ""} across{" "}
            {fileCount} file{fileCount !== 1 ? "s" : ""}
          </span>
        </div>
        <div class="rename-files-list">
          {affectedFiles.map((file) => (
            <div key={file.path} class="rename-file-entry">
              <span class="codicon codicon-file" />
              <span class="rename-file-path">{file.path}</span>
              <span class="rename-change-count">{file.changes}</span>
            </div>
          ))}
        </div>
      </div>
    </ApprovalLayout>
  );
}
