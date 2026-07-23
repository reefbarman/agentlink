import * as fs from "node:fs";

import type { ApprovalManager } from "../approvals/ApprovalManager.js";
import type { ApprovalPanelProvider } from "../approvals/ApprovalPanelProvider.js";
import {
  createOneShotActionApproval,
  type ActionApprovalPolicySnapshot,
  type ActionApprovalReviewer,
  type OutsideReadActionApprovalReviewInput,
  type OutsideReadOperation,
} from "../approvals/actionApprovalReview.js";
import type { CommandReviewContextEntry } from "../approvals/commandApprovalReview.js";

export interface GuardianOutsideReadOptions {
  reviewer?: ActionApprovalReviewer;
  requestingTool: string;
  operation: OutsideReadOperation;
  getPolicy(): ActionApprovalPolicySnapshot | undefined;
  isSessionActive(): boolean;
  getUserObjective?(): string | undefined;
  getContext?(): CommandReviewContextEntry[];
}

function resolveGuardianReadTarget(filePath: string) {
  try {
    return {
      status: "resolved" as const,
      canonicalPath: fs.realpathSync.native(filePath),
    };
  } catch {
    return { status: "unresolved" as const };
  }
}

function buildOutsideReadAction(
  filePath: string,
  sessionId: string,
  options: GuardianOutsideReadOptions,
  signal?: AbortSignal,
): OutsideReadActionApprovalReviewInput | undefined {
  const policy = options.getPolicy();
  if (!policy) return undefined;
  return {
    kind: "outside-read",
    sessionId,
    policy,
    requestingTool: options.requestingTool,
    target: resolveGuardianReadTarget(filePath),
    operation: options.operation,
    userObjective: options.getUserObjective?.(),
    context: options.getContext?.(),
    signal,
  };
}

async function guardianAllowsOutsideRead(
  filePath: string,
  sessionId: string,
  options: GuardianOutsideReadOptions | undefined,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!options?.reviewer) return false;
  const reviewedAction = buildOutsideReadAction(
    filePath,
    sessionId,
    options,
    signal,
  );
  if (!reviewedAction) return false;
  let outcome;
  try {
    outcome = await options.reviewer.review(reviewedAction);
  } catch {
    return false;
  }
  const approval = createOneShotActionApproval(outcome);
  if (!approval) return false;
  const currentAction = buildOutsideReadAction(
    filePath,
    sessionId,
    options,
    signal,
  );
  if (!currentAction) return false;
  return approval.consume({
    sessionId,
    sessionActive: options.isSessionActive(),
    policy: currentAction.policy,
    action: currentAction,
  }).valid;
}

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
  signal?: AbortSignal,
  guardian?: GuardianOutsideReadOptions,
): Promise<{ approved: boolean; reason?: string }> {
  if (await guardianAllowsOutsideRead(filePath, sessionId, guardian, signal)) {
    return { approved: true };
  }

  const { promise } = approvalPanel.enqueuePathApproval(
    filePath,
    sessionId,
    signal,
  );
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
