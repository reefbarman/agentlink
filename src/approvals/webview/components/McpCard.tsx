import type { ApprovalRequest, DecisionMessage } from "../types.js";

import { ApprovalLayout } from "./ApprovalLayout.js";
import { JsonHighlight } from "../../../shared/ui/JsonHighlight.js";
import type { RefObject } from "preact";
import { useCallback, useEffect, useState } from "preact/hooks";

const TARGETS = ["tool", "server"] as const;
const SCOPES = ["session", "project", "global", "skip"] as const;

const TARGET_LABELS: Record<(typeof TARGETS)[number], string> = {
  tool: "This Tool",
  server: "Whole MCP",
};

const SCOPE_LABELS: Record<(typeof SCOPES)[number], string> = {
  session: "Session",
  project: "Project",
  global: "Global",
  skip: "Skip",
};

interface McpCardProps {
  request: ApprovalRequest;
  submit: (data: Omit<DecisionMessage, "type">) => void;
  followUpRef: RefObject<string>;
}

export function McpCard({ request, submit, followUpRef }: McpCardProps) {
  const choices = request.mcpChoices ?? [];
  const titleMatch = request.command?.match(
    /Allow MCP tool "([^"]+)" from "([^"]+)"/,
  );
  const toolName = request.mcpToolName ?? titleMatch?.[1] ?? "MCP tool";
  const serverName = request.mcpServerName ?? titleMatch?.[2] ?? "MCP server";
  const allowOnce =
    choices.find((choice) => choice.isPrimary)?.value ?? "allow-once";
  const deny = choices.find((choice) => choice.isDanger)?.value ?? "deny";
  const choiceValues = new Set(choices.map((choice) => choice.value));

  const [target, setTarget] = useState<(typeof TARGETS)[number]>("tool");
  const [scope, setScope] = useState<(typeof SCOPES)[number]>("skip");

  useEffect(() => {
    setTarget("tool");
    setScope("skip");
  }, [request.id]);

  const ruleDecision =
    scope === "skip" ? undefined : `always-${target}-${scope}`;
  const rulesModified = Boolean(ruleDecision && choiceValues.has(ruleDecision));

  const handleAllowOnce = useCallback(() => {
    submit({
      id: request.id,
      decision: allowOnce,
      followUp: followUpRef.current?.trim() || undefined,
    });
  }, [request.id, allowOnce, submit, followUpRef]);

  const handleSaveAndAllow = useCallback(() => {
    if (!ruleDecision || !choiceValues.has(ruleDecision)) return;
    submit({
      id: request.id,
      decision: ruleDecision,
      followUp: followUpRef.current?.trim() || undefined,
    });
  }, [request.id, ruleDecision, choiceValues, submit, followUpRef]);

  const handleReject = useCallback(
    (reason?: string) => {
      submit({ id: request.id, decision: deny, rejectionReason: reason });
    },
    [request.id, deny, submit],
  );

  const rulesJsx = (
    <div class="rule-row">
      <div class="rule-row-header">
        <code class="rule-row-label">{`${serverName} / ${toolName}`}</code>
      </div>
      <div class="rule-row-toggles">
        <div class="toggle-group">
          {TARGETS.map((candidate) => (
            <button
              key={candidate}
              type="button"
              class={`mode-btn ${target === candidate ? "active" : ""}`}
              onClick={() => setTarget(candidate)}
              disabled={
                scope !== "skip" &&
                !choiceValues.has(`always-${candidate}-${scope}`)
              }
            >
              {TARGET_LABELS[candidate]}
            </button>
          ))}
        </div>
        <div class="toggle-group">
          {SCOPES.map((candidate) => (
            <button
              key={candidate}
              type="button"
              class={`mode-btn ${scope === candidate ? "active" : ""} ${
                candidate === "skip" ? "mode-btn-skip" : ""
              }`}
              onClick={() => setScope(candidate)}
              disabled={
                candidate !== "skip" &&
                !choiceValues.has(`always-${target}-${candidate}`)
              }
            >
              {SCOPE_LABELS[candidate]}
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
      sourceProject={request.sourceProject}
      targetProject={request.targetProject}
      purpose="Use an external MCP tool"
      rulesContent={rulesJsx}
      rulesModified={rulesModified}
      primaryLabel="Allow Once"
      primaryWithRulesLabel="Save Rule & Allow"
      onAccept={handleAllowOnce}
      onSaveAndAccept={handleSaveAndAllow}
      onReject={handleReject}
      followUpRef={followUpRef}
    >
      <div class="card-label">
        <span class="codicon codicon-server" /> MCP Tool
      </div>
      <pre class="command-box">{`${serverName} / ${toolName}`}</pre>
      {request.mcpDetail && (
        <JsonHighlight
          json={request.mcpDetail}
          className="approval-detail-text"
        />
      )}
    </ApprovalLayout>
  );
}
