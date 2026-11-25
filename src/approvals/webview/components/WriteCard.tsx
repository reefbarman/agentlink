import type {
  ApprovalRequest,
  DecisionMessage,
} from "@agentlink/protocol/approval-transport";
import {
  FilePermissionRuleEditor,
  ruleFolder,
  useFilePermissionRule,
  writeTrustFields,
} from "./FilePermissionRuleEditor.js";

import { ApprovalLayout } from "./ApprovalLayout.js";
import type { RefObject } from "preact";
import { useCallback } from "preact/hooks";

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

  // Same editor and defaults as the outside-path read card (folder prefix).
  // Blanket "All files" trust never covers outside-workspace targets, so it
  // is only offered inside the workspace.
  const folder = ruleFolder(filePath);
  const rule = useFilePermissionRule({
    filePath,
    allowAllFiles: !outsideWorkspace,
  });
  const { isSkipped, scope } = rule;
  const trust = writeTrustFields(rule);

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
      ...trust,
      followUp: followUpRef.current?.trim() || undefined,
    });
  }, [
    request.id,
    scope,
    trust.trustScope,
    trust.rulePattern,
    trust.ruleMode,
    submit,
    followUpRef,
  ]);

  // One click for the common case: trust this file's folder for the session.
  const handleAllowFolder = useCallback(() => {
    submit({
      id: request.id,
      decision: "accept-session",
      trustScope: "pattern",
      rulePattern: folder,
      ruleMode: "prefix",
      followUp: followUpRef.current?.trim() || undefined,
    });
  }, [request.id, folder, submit, followUpRef]);

  const handleReject = useCallback(
    (reason?: string) => {
      submit({ id: request.id, decision: "reject", rejectionReason: reason });
    },
    [request.id, submit],
  );

  const rulesJsx = (
    <FilePermissionRuleEditor
      label={filePath}
      modeGroupName={`write-rule-mode-${request.id}`}
      rule={rule}
    />
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
          : explicitChoices.length === 0 && folder && isSkipped
            ? {
                label: "Allow Folder for Session",
                title: `Accept now and auto-approve writes under ${folder} for this session`,
                onClick: handleAllowFolder,
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
