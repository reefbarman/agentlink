export interface ApprovalResultAnnotation {
  text: string;
  badge: "follow-up" | "rejection";
}

interface ApprovalResultPayload {
  follow_up?: unknown;
  status?: unknown;
  reason?: unknown;
  rejectionReason?: unknown;
}

function parsePayload(resultText: string): ApprovalResultPayload | undefined {
  try {
    return JSON.parse(resultText) as ApprovalResultPayload;
  } catch {
    try {
      // MCP tool results can append approval metadata as a trailing JSON block.
      return JSON.parse(
        resultText.trimEnd().split("\n").pop() ?? "",
      ) as ApprovalResultPayload;
    } catch {
      return undefined;
    }
  }
}

/** Extract the user-authored follow-up or rejection note from a tool result. */
export function getApprovalResultAnnotation(
  resultText: string,
): ApprovalResultAnnotation | undefined {
  if (
    !resultText.includes("follow_up") &&
    !resultText.includes("rejected_by_user") &&
    !resultText.includes("rejectionReason")
  ) {
    return undefined;
  }

  const payload = parsePayload(resultText);
  if (!payload) return undefined;

  if (typeof payload.follow_up === "string" && payload.follow_up.trim()) {
    return { text: payload.follow_up, badge: "follow-up" };
  }

  if (
    payload.status === "rejected_by_user" &&
    typeof payload.reason === "string" &&
    payload.reason.trim()
  ) {
    return { text: payload.reason, badge: "rejection" };
  }

  // Backward compatibility for propose_memory results emitted before its
  // rejection payload was aligned with the standard approval result shape.
  if (
    payload.status === "rejected" &&
    typeof payload.rejectionReason === "string" &&
    payload.rejectionReason.trim()
  ) {
    return { text: payload.rejectionReason, badge: "rejection" };
  }

  return undefined;
}
