import type { ApprovalRequest } from "@agentlink/protocol/approval-transport";
import type { BgSessionInfo } from "@agentlink/protocol/background-result";
import type { WorkspaceBackgroundRecord } from "@agentlink/workspace-host";

/**
 * Projects the workspace host's background children onto the shared UI's
 * Agent Fleet cards (`BgSessionInfo`) and approval cards.
 */

/** The fleet card preview keeps the tail of a running child's output. */
const PREVIEW_CHARS = 500;
const MAX_APPROVAL_DETAIL_LENGTH = 4_000;
const APPROVAL_ID_PREFIX = "agent-approval:";

const ACTIVE = new Set<WorkspaceBackgroundRecord["lifecycle"]>([
  "queued",
  "running",
  "awaiting_approval",
]);

export function isActiveAgent(record: WorkspaceBackgroundRecord): boolean {
  return ACTIVE.has(record.lifecycle);
}

export function toAgentCard(record: WorkspaceBackgroundRecord): BgSessionInfo {
  const active = isActiveAgent(record);
  const output = record.resultText ?? record.partialOutput;
  return {
    id: record.childSessionId,
    task: record.task,
    status: cardStatus(record),
    lifecycle:
      record.lifecycle === "awaiting_approval" ? "running" : record.lifecycle,
    phase: record.phase,
    resultState: record.resultState,
    parentSessionId: record.parentSessionId,
    rootSessionId: record.rootSessionId,
    depth: record.depth,
    placement: "background",
    createdAt: record.createdAt,
    lastActiveAt: record.updatedAt,
    ...(record.startedAt === undefined ? {} : { startedAt: record.startedAt }),
    ...(record.completedAt === undefined
      ? {}
      : { completedAt: record.completedAt }),
    ...(record.currentTool && active
      ? { currentTool: record.currentTool }
      : {}),
    ...(record.model
      ? {
          resolvedModel: record.model.modelId,
          resolvedProvider: record.model.providerId,
        }
      : {}),
    ...(record.reasoningEffort
      ? { reasoningEffort: record.reasoningEffort }
      : {}),
    ...(record.terminalReason ? { terminalReason: record.terminalReason } : {}),
    ...(record.lifecycle === "failed" || record.lifecycle === "interrupted"
      ? {
          errorMessage:
            record.terminalReason ?? "The background agent stopped early.",
        }
      : {}),
    ...(output ? { streamingText: output.slice(-PREVIEW_CHARS) } : {}),
    ...(!active && record.partialOutput && !record.resultText
      ? { partialResult: record.partialOutput }
      : {}),
    ...(record.lifecycle === "awaiting_approval"
      ? { attention: "approval" as const }
      : {}),
    canSteer: record.lifecycle === "queued" || record.lifecycle === "running",
    canKill: active,
  };
}

function cardStatus(
  record: WorkspaceBackgroundRecord,
): BgSessionInfo["status"] {
  switch (record.lifecycle) {
    case "queued":
      return "queued";
    case "running":
      return record.currentTool ? "tool_executing" : "streaming";
    case "awaiting_approval":
      return "awaiting_approval";
    case "completed":
      return "idle";
    case "cancelled":
      return "cancelled";
    case "failed":
    case "interrupted":
      return "error";
  }
}

/** The approval card for the first child waiting for the owner, if any. */
export function agentApprovalRequest(
  records: readonly WorkspaceBackgroundRecord[],
): ApprovalRequest | null {
  const record = records.find(
    (candidate) =>
      candidate.lifecycle === "awaiting_approval" && candidate.approval,
  );
  const approval = record?.approval;
  if (!record || !approval) return null;
  const display =
    approval.displayContent === undefined
      ? ""
      : truncate(
          stringify(approval.displayContent),
          MAX_APPROVAL_DETAIL_LENGTH,
        );
  return {
    kind: "write",
    id: `${APPROVAL_ID_PREFIX}${record.childSessionId}:${approval.interactionId}`,
    backgroundTask: record.task,
    filePath: truncate(approval.summary || `Allow ${approval.toolName}?`, 200),
    writeOperation: "modify",
    detail: [
      `Background agent: ${record.task}`,
      `Tool: ${approval.toolName}`,
      display,
    ]
      .filter(Boolean)
      .join("\n\n"),
    writeChoices: [
      { label: "Allow", value: "accept", isPrimary: true },
      { label: "Deny", value: "reject", isDanger: true },
    ],
  };
}

/** The child and interaction an approval card ID refers to. */
export function parseAgentApprovalId(
  id: string,
): { childSessionId: string; interactionId: string } | null {
  if (!id.startsWith(APPROVAL_ID_PREFIX)) return null;
  const rest = id.slice(APPROVAL_ID_PREFIX.length);
  const separator = rest.indexOf(":");
  if (separator <= 0 || separator === rest.length - 1) return null;
  return {
    childSessionId: rest.slice(0, separator),
    interactionId: rest.slice(separator + 1),
  };
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return "";
  }
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
