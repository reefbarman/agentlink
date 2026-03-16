import { useCallback } from "preact/hooks";
import type { RefObject } from "preact";
import type { ApprovalRequest, DecisionMessage } from "../types.js";
import { ApprovalLayout } from "./ApprovalLayout.js";

interface ModeSwitchCardProps {
  request: ApprovalRequest;
  submit: (data: Omit<DecisionMessage, "type">) => void;
  followUpRef: RefObject<string>;
}

/**
 * Rich approval card for agent-initiated mode switches.
 * Clearly shows the target mode and the reason for the switch.
 */
export function ModeSwitchCard({
  request,
  submit,
  followUpRef,
}: ModeSwitchCardProps) {
  const title = request.command ?? "Mode Switch";
  const reason = request.mcpDetail;

  const handleAccept = useCallback(() => {
    submit({
      id: request.id,
      decision: "run-once",
      followUp: followUpRef.current?.trim() || undefined,
    });
  }, [request.id, submit, followUpRef]);

  const handleReject = useCallback(
    (reason?: string) => {
      submit({
        id: request.id,
        decision: "reject",
        rejectionReason: reason,
      });
    },
    [request.id, submit],
  );

  return (
    <ApprovalLayout
      queuePosition={request.queuePosition}
      queueTotal={request.queueTotal}
      rulesContent={null}
      rulesModified={false}
      primaryLabel="Allow"
      primaryWithRulesLabel=""
      onAccept={handleAccept}
      onSaveAndAccept={handleAccept}
      onReject={handleReject}
      followUpRef={followUpRef}
    >
      <div class="mode-switch-card">
        <div class="mode-switch-header">
          <span class="codicon codicon-symbol-enum" />
          <span class="mode-switch-title">{title}</span>
        </div>
        {reason && (
          <div class="mode-switch-reason">
            <span class="mode-switch-reason-label">Reason:</span> {reason}
          </div>
        )}
      </div>
    </ApprovalLayout>
  );
}
