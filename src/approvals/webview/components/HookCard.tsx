import type {
  ApprovalRequest,
  DecisionMessage,
} from "@agentlink/protocol/approval-transport";

import { ApprovalLayout } from "./ApprovalLayout.js";
import type { RefObject } from "preact";
import { useCallback } from "preact/hooks";

interface HookCardProps {
  request: ApprovalRequest;
  submit: (data: Omit<DecisionMessage, "type">) => void;
  followUpRef: RefObject<string>;
}

export function HookCard({ request, submit, followUpRef }: HookCardProps) {
  const choices = request.hookChoices ?? [];
  const positive = choices.filter((choice) => !choice.isDanger);
  const primary = positive.find((choice) => choice.isPrimary) ?? positive[0];
  const secondary = positive.find((choice) => choice.value !== primary?.value);
  const deny = choices.find((choice) => choice.isDanger);

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

  return (
    <ApprovalLayout
      queuePosition={request.queuePosition}
      queueTotal={request.queueTotal}
      sourceProject={request.sourceProject}
      purpose="Run a lifecycle hook command"
      rulesContent={null}
      rulesModified={false}
      primaryLabel={primary?.label ?? "Run Once"}
      primaryWithRulesLabel=""
      onAccept={() => submitChoice(primary?.value ?? "allow-once")}
      onSaveAndAccept={() => submitChoice(primary?.value ?? "allow-once")}
      secondaryAction={
        secondary
          ? {
              label: secondary.label,
              onClick: () => submitChoice(secondary.value),
            }
          : undefined
      }
      onReject={(reason) =>
        submit({
          id: request.id,
          decision: deny?.value ?? "disable",
          rejectionReason: reason,
        })
      }
      followUpRef={followUpRef}
    >
      <div class="card-label">
        <span class="codicon codicon-run" /> Lifecycle hook
      </div>
      <div class="mode-switch-card">
        <div class="mode-switch-header">
          <span class="mode-switch-title">
            {request.command ?? "Hook command"}
          </span>
        </div>
      </div>
      {request.detail && (
        <pre class="approval-detail-text">{request.detail}</pre>
      )}
    </ApprovalLayout>
  );
}
