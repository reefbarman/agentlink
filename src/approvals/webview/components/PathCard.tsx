import { useState, useCallback } from "preact/hooks";
import type { ApprovalRequest, DecisionMessage } from "../types.js";
import { RejectionSection } from "./RejectionSection.js";

const MODES = ["prefix", "exact", "glob"] as const;
const SCOPES = ["session", "project", "global", "skip"] as const;
const SCOPE_LABELS: Record<string, string> = {
  session: "Session",
  project: "Project",
  global: "Global",
  skip: "Skip",
};

interface PathCardProps {
  request: ApprovalRequest;
  submit: (data: Omit<DecisionMessage, "type">) => void;
}

export function PathCard({ request, submit }: PathCardProps) {
  const filePath = request.filePath ?? "";
  const dirPath = filePath.substring(0, filePath.lastIndexOf("/") + 1) || filePath;

  const [pattern, setPattern] = useState(dirPath);
  const [mode, setMode] = useState<(typeof MODES)[number]>("prefix");
  const [scope, setScope] = useState<(typeof SCOPES)[number]>("skip");
  const [showReject, setShowReject] = useState(false);

  const isSkipped = scope === "skip";
  const badge =
    request.queueTotal && request.queueTotal > 1
      ? `${request.queuePosition} of ${request.queueTotal}`
      : "";

  const handleAllowOnce = useCallback(() => {
    submit({ id: request.id, decision: "allow-once" });
  }, [request.id, submit]);

  const handleSaveAndAllow = useCallback(() => {
    const decision =
      scope === "session"
        ? "allow-session"
        : scope === "project"
          ? "allow-project"
          : "allow-always";
    submit({
      id: request.id,
      decision,
      rulePattern: pattern,
      ruleMode: mode,
    });
  }, [request.id, scope, pattern, mode, submit]);

  const handleReject = useCallback(
    (reason?: string) => {
      submit({ id: request.id, decision: "reject", rejectionReason: reason });
    },
    [request.id, submit],
  );

  if (showReject) {
    return (
      <RejectionSection
        onSubmit={handleReject}
        onCancel={() => setShowReject(false)}
      />
    );
  }

  return (
    <div>
      <div class="header">
        <span class="header-title">
          <span class="codicon codicon-warning" /> APPROVAL REQUIRED
        </span>
        {badge && <span class="badge">{badge}</span>}
      </div>

      <div class="card-label">Outside Workspace Access</div>
      <pre class="command-box">{filePath}</pre>

      <div class="button-row">
        <button class="btn btn-primary" onClick={handleAllowOnce}>
          Allow Once
        </button>
        <button class="btn btn-danger" onClick={() => setShowReject(true)}>
          Reject
        </button>
      </div>

      {/* Rule editor */}
      <div class="rules-section">
        <div class="rules-header">Trust Rule</div>
        <div class="rule-row">
          <div class="rule-row-header">
            <code class="rule-row-label">{filePath}</code>
          </div>
          <input
            type="text"
            class={`text-input rule-pattern-input ${isSkipped ? "skipped" : ""}`}
            value={pattern}
            onInput={(e) => setPattern((e.target as HTMLInputElement).value)}
            disabled={isSkipped}
          />
          <div class="rule-row-toggles">
            <div class="toggle-group">
              {MODES.map((m) => (
                <button
                  key={m}
                  type="button"
                  class={`mode-btn ${mode === m ? "active" : ""}`}
                  onClick={() => setMode(m)}
                  disabled={isSkipped}
                >
                  {m.charAt(0).toUpperCase() + m.slice(1)}
                </button>
              ))}
            </div>
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
        </div>
        {!isSkipped && (
          <button class="btn btn-primary save-rules-btn" onClick={handleSaveAndAllow}>
            Save Rule & Allow
          </button>
        )}
      </div>
    </div>
  );
}
