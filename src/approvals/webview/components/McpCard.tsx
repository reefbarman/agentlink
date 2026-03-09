import { useCallback } from "preact/hooks";
import type { RefObject } from "preact";
import type { ApprovalRequest, DecisionMessage } from "../types.js";
import { ApprovalLayout } from "./ApprovalLayout.js";

interface McpCardProps {
  request: ApprovalRequest;
  submit: (data: Omit<DecisionMessage, "type">) => void;
  followUpRef: RefObject<string>;
}

/**
 * Rich approval card for MCP tool invocations.
 * Shows the tool title, input preview, and approval choices.
 */
export function McpCard({ request, submit, followUpRef }: McpCardProps) {
  const title = request.command ?? "MCP Tool";
  const detail = request.mcpDetail;
  const choices = request.mcpChoices ?? [];

  // Find the primary (accept) choice and the deny choice
  const primaryChoice = choices.find((c) => c.isPrimary);
  const denyChoice = choices.find((c) => c.isDanger);
  const secondaryChoices = choices.filter((c) => !c.isPrimary && !c.isDanger);

  const handleAccept = useCallback(() => {
    submit({
      id: request.id,
      decision: primaryChoice?.value ?? "allow-once",
      followUp: followUpRef.current?.trim() || undefined,
    });
  }, [request.id, primaryChoice, submit, followUpRef]);

  const handleReject = useCallback(
    (reason?: string) => {
      submit({
        id: request.id,
        decision: denyChoice?.value ?? "deny",
        rejectionReason: reason,
      });
    },
    [request.id, denyChoice, submit],
  );

  return (
    <ApprovalLayout
      queuePosition={request.queuePosition}
      queueTotal={request.queueTotal}
      rulesContent={null}
      rulesModified={false}
      primaryLabel={primaryChoice?.label ?? "Allow Once"}
      primaryWithRulesLabel=""
      onAccept={handleAccept}
      onSaveAndAccept={handleAccept}
      onReject={handleReject}
      followUpRef={followUpRef}
    >
      <div class="card-label">
        <span class="codicon codicon-server" /> {title}
      </div>
      {detail && <pre class="command-box">{detail}</pre>}
      {secondaryChoices.length > 0 && (
        <div class="mcp-secondary-choices">
          {secondaryChoices.map((choice) => (
            <button
              key={choice.value}
              class="btn btn-secondary mcp-choice-btn"
              onClick={() =>
                submit({
                  id: request.id,
                  decision: choice.value,
                  followUp: followUpRef.current?.trim() || undefined,
                })
              }
            >
              {choice.label}
            </button>
          ))}
        </div>
      )}
    </ApprovalLayout>
  );
}
