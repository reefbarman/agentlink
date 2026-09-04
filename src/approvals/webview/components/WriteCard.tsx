import type {
  ApprovalRequest,
  DecisionMessage,
} from "@agentlink/protocol/approval-transport";
import { useCallback, useState } from "preact/hooks";

import { ApprovalLayout } from "./ApprovalLayout.js";
import {
  FilePermissionRuleEditor,
  type FilePermissionRuleMode,
  type FilePermissionRuleScope,
} from "./FilePermissionRuleEditor.js";
import type { RefObject } from "preact";

const TRUST_SCOPES = ["all-files", "this-file", "pattern"] as const;

interface WriteCardProps {
  request: ApprovalRequest;
  submit: (data: Omit<DecisionMessage, "type">) => void;
  followUpRef: RefObject<string>;
  onRevealDiff?: (requestId: string) => void;
}

export function WriteCard({
  request,
  submit,
  followUpRef,
  onRevealDiff,
}: WriteCardProps) {
  const filePath = request.filePath ?? "";
  const operation = request.writeOperation ?? "modify";
  const explicitChoices = request.writeChoices ?? [];
  const positiveChoices = explicitChoices.filter((choice) => !choice.isDanger);
  const primaryChoice =
    positiveChoices.find((choice) => choice.isPrimary) ?? positiveChoices[0];
  const secondaryChoice = positiveChoices.find(
    (choice) => choice !== primaryChoice,
  );
  const outsideWorkspace = request.outsideWorkspace ?? false;
  const purpose =
    explicitChoices.length > 0
      ? filePath
      : `${operation === "create" ? "Create" : "Modify"} ${outsideWorkspace ? "a file outside the workspace" : "a file"}`;

  const [trustScope, setTrustScope] = useState<(typeof TRUST_SCOPES)[number]>(
    outsideWorkspace ? "pattern" : "all-files",
  );
  const [pattern, setPattern] = useState(filePath);
  const [mode, setMode] = useState<FilePermissionRuleMode>(
    outsideWorkspace ? "exact" : "glob",
  );
  const [scope, setScope] = useState<FilePermissionRuleScope>("skip");

  const isSkipped = scope === "skip";

  const handleAccept = useCallback(() => {
    submit({
      id: request.id,
      decision: primaryChoice?.value ?? "accept",
      followUp: followUpRef.current?.trim() || undefined,
    });
  }, [request.id, primaryChoice?.value, submit, followUpRef]);

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
      followUp: followUpRef.current?.trim() || undefined,
    });
  }, [
    request.id,
    scope,
    trustScope,
    pattern,
    mode,
    filePath,
    submit,
    followUpRef,
  ]);

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
        <FilePermissionRuleEditor
          label={filePath}
          pattern={pattern}
          mode={mode}
          scope={scope}
          modeGroupName={`write-rule-mode-${request.id}`}
          onPatternChange={setPattern}
          onModeChange={setMode}
          onScopeChange={setScope}
        />
      )}

      {trustScope !== "pattern" && (
        <div class="rule-row-options">
          <div class="rule-row-option-line">
            <span class="rule-row-option-label">Scope:</span>
            <div class="toggle-group">
              {(["session", "project", "global", "skip"] as const).map(
                (candidate) => (
                  <button
                    key={candidate}
                    type="button"
                    class={`mode-btn ${scope === candidate ? "active" : ""} ${candidate === "skip" ? "mode-btn-skip" : ""}`}
                    onClick={() => setScope(candidate)}
                  >
                    {candidate.charAt(0).toUpperCase() + candidate.slice(1)}
                  </button>
                ),
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );

  return (
    <ApprovalLayout
      queuePosition={request.queuePosition}
      queueTotal={request.queueTotal}
      sourceProject={request.sourceProject}
      targetProject={request.targetProject}
      targetPath={request.targetPath}
      purpose={purpose}
      rulesContent={explicitChoices.length > 0 ? undefined : rulesJsx}
      rulesModified={explicitChoices.length > 0 ? false : !isSkipped}
      primaryLabel={primaryChoice?.label ?? "Accept"}
      primaryWithRulesLabel="Save Rule & Accept"
      onAccept={handleAccept}
      onSaveAndAccept={handleSaveAndAccept}
      secondaryAction={
        secondaryChoice
          ? {
              label: secondaryChoice.label,
              onClick: () =>
                submit({
                  id: request.id,
                  decision: secondaryChoice.value,
                  followUp: followUpRef.current?.trim() || undefined,
                }),
            }
          : undefined
      }
      onReject={handleReject}
      followUpRef={followUpRef}
    >
      {explicitChoices.length === 0 && (
        <div class="file-card">
          <div class="file-card-header">
            <span
              class={`codicon ${operation === "create" ? "codicon-new-file" : "codicon-edit"}`}
            />
            <span class="file-path">{filePath}</span>
            {onRevealDiff && (
              <button
                type="button"
                class="file-card-reveal-button"
                onClick={() => onRevealDiff(request.id)}
                aria-label="Reveal diff in editor"
                title="Reveal diff in editor"
              >
                <span class="codicon codicon-search" aria-hidden="true" />
              </button>
            )}
            <span class={`operation-badge ${operation}`}>{operation}</span>
          </div>
          {outsideWorkspace && (
            <div class="outside-badge">
              <span class="codicon codicon-warning" /> Outside workspace
            </div>
          )}
        </div>
      )}
      {request.detail && (
        <pre class="approval-detail-text">{request.detail}</pre>
      )}
    </ApprovalLayout>
  );
}
