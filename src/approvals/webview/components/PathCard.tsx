import { useState, useCallback } from "preact/hooks";
import type { RefObject } from "preact";
import type { ApprovalRequest, DecisionMessage } from "../types.js";
import { ApprovalLayout } from "./ApprovalLayout.js";

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
  followUpRef: RefObject<string>;
}

export function PathCard({ request, submit, followUpRef }: PathCardProps) {
  const filePath = request.filePath ?? "";
  const dirPath =
    filePath.substring(0, filePath.lastIndexOf("/") + 1) || filePath;

  const [pattern, setPattern] = useState(dirPath);
  const [mode, setMode] = useState<(typeof MODES)[number]>("prefix");
  const [scope, setScope] = useState<(typeof SCOPES)[number]>("skip");

  const isSkipped = scope === "skip";

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

  const rulesJsx = (
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
  );

  return (
    <ApprovalLayout
      queuePosition={request.queuePosition}
      queueTotal={request.queueTotal}
      rulesContent={rulesJsx}
      rulesModified={!isSkipped}
      primaryLabel="Allow Once"
      primaryWithRulesLabel="Save Rule & Allow"
      onAccept={handleAllowOnce}
      onSaveAndAccept={handleSaveAndAllow}
      onReject={handleReject}
      followUpRef={followUpRef}
    >
      <div class="card-label">Outside Workspace Access</div>
      <pre class="command-box">{filePath}</pre>
    </ApprovalLayout>
  );
}
