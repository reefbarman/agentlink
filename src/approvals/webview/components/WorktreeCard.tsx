import type {
  ApprovalRequest,
  DecisionMessage,
} from "@agentlink/protocol/approval-transport";

import { ApprovalLayout } from "./ApprovalLayout.js";
import type { RefObject } from "preact";
import { useCallback } from "preact/hooks";

interface WorktreeCardProps {
  request: ApprovalRequest;
  submit: (data: Omit<DecisionMessage, "type">) => void;
  followUpRef: RefObject<string>;
}

export function WorktreeCard({
  request,
  submit,
  followUpRef,
}: WorktreeCardProps) {
  const choices = request.worktreeChoices ?? [];
  const positiveChoices = choices.filter((choice) => !choice.isDanger);
  const primaryChoice =
    positiveChoices.find((choice) => choice.isPrimary) ?? positiveChoices[0];
  const secondaryChoice = positiveChoices.find(
    (choice) => choice.value !== primaryChoice?.value,
  );
  const denyChoice = choices.find((choice) => choice.isDanger);

  const submitChoice = useCallback(
    (decision: string) => {
      submit({
        id: request.id,
        decision,
        followUp: followUpRef.current?.trim() || undefined,
      });
    },
    [request.id, submit, followUpRef],
  );

  const handleReject = useCallback(
    (reason?: string) => {
      submit({
        id: request.id,
        decision: denyChoice?.value ?? "deny",
        rejectionReason: reason,
      });
    },
    [request.id, denyChoice?.value, submit],
  );

  return (
    <ApprovalLayout
      queuePosition={request.queuePosition}
      queueTotal={request.queueTotal}
      sourceProject={request.sourceProject}
      targetProject={request.targetProject}
      targetPath={request.targetPath}
      purpose="Open an isolated worktree agent"
      rulesContent={null}
      rulesModified={false}
      primaryLabel={primaryChoice?.label ?? "Approve"}
      primaryWithRulesLabel=""
      onAccept={() =>
        submitChoice(primaryChoice?.value ?? "approve-autosubmit")
      }
      onSaveAndAccept={() =>
        submitChoice(primaryChoice?.value ?? "approve-autosubmit")
      }
      secondaryAction={
        secondaryChoice
          ? {
              label: secondaryChoice.label,
              onClick: () => submitChoice(secondaryChoice.value),
            }
          : undefined
      }
      onReject={handleReject}
      followUpRef={followUpRef}
    >
      <div class="card-label">
        <span class="codicon codicon-git-branch" /> Worktree agent
      </div>
      <div class="mode-switch-card">
        <div class="mode-switch-header">
          <span class="mode-switch-title">
            {request.command ?? "Start worktree agent"}
          </span>
        </div>
      </div>
      {request.detail && (
        <pre class="approval-detail-text">{request.detail}</pre>
      )}
    </ApprovalLayout>
  );
}
