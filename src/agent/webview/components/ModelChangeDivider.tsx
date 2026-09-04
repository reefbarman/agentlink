import type { CommandApprovalPolicy } from "@agentlink/protocol/command-approval-policy";
import { Fragment } from "preact";
import type { ChatReasoningEffort as ReasoningEffort } from "@agentlink/protocol/chat-catalog";

interface ModelChangeDividerProps {
  modelChange?: {
    previousModel: string;
    model: string;
  };
  reasoningChange?: {
    previousReasoningEffort: ReasoningEffort;
    reasoningEffort: ReasoningEffort;
  };
  modeChange?: {
    previousMode: string;
    mode: string;
  };
  approvalChange?: {
    previousCommandApprovalPolicy: CommandApprovalPolicy;
    commandApprovalPolicy: CommandApprovalPolicy;
  };
}

const REASONING_EFFORT_LABELS: Record<ReasoningEffort, string> = {
  none: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "XHigh",
  max: "Max",
  ultra: "Ultra",
};

const COMMAND_APPROVAL_POLICY_LABELS: Record<CommandApprovalPolicy, string> = {
  manual: "Manual",
  safe: "Safe",
  "approve-for-me": "Approve for Me",
  sensitive: "Sensitive",
};

function modeLabel(slug: string): string {
  return slug.charAt(0).toUpperCase() + slug.slice(1);
}

function approvalChangeLabel(change: {
  previousCommandApprovalPolicy: CommandApprovalPolicy;
  commandApprovalPolicy: CommandApprovalPolicy;
}): string {
  if (change.commandApprovalPolicy === "approve-for-me") {
    return "Approve for Me turned on";
  }
  if (change.previousCommandApprovalPolicy === "approve-for-me") {
    return "Approve for Me turned off";
  }
  return `Command approval changed to ${COMMAND_APPROVAL_POLICY_LABELS[change.commandApprovalPolicy]}`;
}

/** Marks where subsequent transcript responses changed model, thinking level, mode, or command approval. */
export function ModelChangeDivider({
  modelChange,
  reasoningChange,
  modeChange,
  approvalChange,
}: ModelChangeDividerProps) {
  const accessibleChanges = [
    modelChange
      ? `Model changed from ${modelChange.previousModel} to ${modelChange.model}`
      : null,
    reasoningChange
      ? `Thinking level changed from ${REASONING_EFFORT_LABELS[reasoningChange.previousReasoningEffort]} to ${REASONING_EFFORT_LABELS[reasoningChange.reasoningEffort]}`
      : null,
    modeChange
      ? `Mode changed from ${modeLabel(modeChange.previousMode)} to ${modeLabel(modeChange.mode)}`
      : null,
    approvalChange ? approvalChangeLabel(approvalChange) : null,
  ].filter((change): change is string => Boolean(change));

  const badgeSegments: Array<{ text: string; value?: string }> = [];
  if (modelChange) {
    badgeSegments.push({ text: "Model changed to", value: modelChange.model });
  }
  if (reasoningChange) {
    badgeSegments.push({
      text: "Thinking level changed to",
      value: REASONING_EFFORT_LABELS[reasoningChange.reasoningEffort],
    });
  }
  if (modeChange) {
    badgeSegments.push({
      text: "Mode changed to",
      value: modeLabel(modeChange.mode),
    });
  }
  if (approvalChange) {
    badgeSegments.push({ text: approvalChangeLabel(approvalChange) });
  }

  return (
    <div
      class="model-change-divider"
      role="separator"
      aria-label={accessibleChanges.join("; ")}
    >
      <span class="model-change-divider-line" aria-hidden="true" />
      <span
        class="model-change-divider-badge"
        title={accessibleChanges.join("; ")}
      >
        <i class="codicon codicon-arrow-swap" aria-hidden="true" />
        {badgeSegments.map((segment, index) => (
          <Fragment key={segment.text}>
            {index > 0 && <span aria-hidden="true">·</span>}
            <span>{segment.text}</span>
            {segment.value && (
              <span class="model-change-divider-model">{segment.value}</span>
            )}
          </Fragment>
        ))}
      </span>
      <span class="model-change-divider-line" aria-hidden="true" />
    </div>
  );
}
