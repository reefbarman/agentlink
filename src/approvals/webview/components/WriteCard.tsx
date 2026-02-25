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

interface WriteCardProps {
  request: ApprovalRequest;
  submit: (data: Omit<DecisionMessage, "type">) => void;
  followUpRef: RefObject<string>;
}

export function WriteCard({ request, submit, followUpRef }: WriteCardProps) {
  const filePath = request.filePath ?? "";
  const operation = request.writeOperation ?? "modify";
  const outsideWorkspace = request.outsideWorkspace ?? false;

  const [trustScope, setTrustScope] = useState<(typeof TRUST_SCOPES)[number]>(
    outsideWorkspace ? "pattern" : "all-files",
  );
  const [pattern, setPattern] = useState(filePath);
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
        rulePattern: filePath,
        ruleMode: "exact",
      }),
    });
  }, [request.id, scope, trustScope, pattern, mode, filePath, submit]);

  const handleReject = useCallback(
    (reason?: string) => {
      submit({ id: request.id, decision: "reject", rejectionReason: reason });
    },
    [request.id, submit],
  );

  const rulesJsx = (
    <>
      {!outsideWorkspace && (
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
      )}

      {trustScope === "pattern" && (
        <div class="rule-row">
          <input
            type="text"
            class="text-input rule-pattern-input"
            value={pattern}
            onInput={(e) => setPattern((e.target as HTMLInputElement).value)}
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
      <div class="file-card">
        <div class="file-card-header">
          <span
            class={`codicon ${operation === "create" ? "codicon-new-file" : "codicon-edit"}`}
          />
          <span class="file-path">{filePath}</span>
          <span class={`operation-badge ${operation}`}>{operation}</span>
        </div>
        {outsideWorkspace && (
          <div class="outside-badge">
            <span class="codicon codicon-warning" /> Outside workspace
          </div>
        )}
      </div>
    </ApprovalLayout>
  );
}
