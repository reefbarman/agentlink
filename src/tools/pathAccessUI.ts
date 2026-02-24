import * as path from "path";

import type { ApprovalManager } from "../approvals/ApprovalManager.js";
import type { ApprovalPanelProvider } from "../approvals/ApprovalPanelProvider.js";

/**
 * Gate for outside-workspace path access.
 * Shows a WebView-based approval panel where the user can allow/reject
 * and optionally configure a trust rule with pattern matching.
 */
export async function approveOutsideWorkspaceAccess(
  filePath: string,
  approvalManager: ApprovalManager,
  approvalPanel: ApprovalPanelProvider,
  sessionId: string,
): Promise<{ approved: boolean; reason?: string }> {
  const { promise } = approvalPanel.enqueuePathApproval(filePath);
  const response = await promise;

  if (response.decision === "reject") {
    return { approved: false, reason: response.rejectionReason };
  }

  if (
    response.decision !== "allow-once" &&
    response.rulePattern &&
    response.ruleMode
  ) {
    const scope: "session" | "project" | "global" =
      response.decision === "allow-session"
        ? "session"
        : response.decision === "allow-project"
          ? "project"
          : "global";
    approvalManager.addPathRule(
      sessionId,
      { pattern: response.rulePattern, mode: response.ruleMode },
      scope,
    );
  }

  return { approved: true };
}
