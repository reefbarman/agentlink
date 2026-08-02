import * as fs from "node:fs";

import type { ApprovalManager } from "../approvals/ApprovalManager.js";
import type { ApprovalPanelProvider } from "../approvals/ApprovalPanelProvider.js";
import {
  actionApprovalActionKey,
  actionApprovalPolicyKey,
  createOneShotActionApproval,
  type ActionApprovalPolicySnapshot,
  type ActionApprovalReviewer,
  type ActionReviewHumanOnlyReason,
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

async function reviewOutsideRead(
  filePath: string,
  sessionId: string,
  options: GuardianOutsideReadOptions | undefined,
  signal?: AbortSignal,
): Promise<{
  approved: boolean;
  humanOnlyReason?: ActionReviewHumanOnlyReason | "guardian-denied";
  binding?: { actionKey: string; policyKey: string };
}> {
  if (!options?.reviewer) {
    return { approved: false, humanOnlyReason: "invalid-action" };
  }
  const reviewedAction = buildOutsideReadAction(
    filePath,
    sessionId,
    options,
    signal,
  );
  if (!reviewedAction) {
    return { approved: false, humanOnlyReason: "invalid-action" };
  }
  const actionKey = actionApprovalActionKey(reviewedAction);
  let outcome;
  try {
    outcome = await options.reviewer.review(reviewedAction);
  } catch {
    return { approved: false, humanOnlyReason: "invalid-action" };
  }
  if (outcome.disposition === "human-only") {
    return { approved: false, humanOnlyReason: outcome.reason };
  }
  if (!actionKey) {
    return { approved: false, humanOnlyReason: "invalid-action" };
  }
  const binding = {
    actionKey,
    policyKey: actionApprovalPolicyKey(reviewedAction.policy),
  };
  const approval = createOneShotActionApproval(outcome);
  if (!approval) {
    return { approved: false, humanOnlyReason: "guardian-denied", binding };
  }
  const currentAction = buildOutsideReadAction(
    filePath,
    sessionId,
    options,
    signal,
  );
  if (!currentAction) return { approved: false, binding };
  return {
    approved: approval.consume({
      sessionId,
      sessionActive: options.isSessionActive(),
      policy: currentAction.policy,
      action: currentAction,
    }).valid,
    binding,
  };
}

function outsideReadBindingMatches(
  filePath: string,
  sessionId: string,
  options: GuardianOutsideReadOptions | undefined,
  binding: { actionKey: string; policyKey: string } | undefined,
  signal?: AbortSignal,
): boolean {
  if (!binding || !options) return false;
  const currentAction = buildOutsideReadAction(
    filePath,
    sessionId,
    options,
    signal,
  );
  return Boolean(
    currentAction &&
    actionApprovalActionKey(currentAction) === binding.actionKey &&
    actionApprovalPolicyKey(currentAction.policy) === binding.policyKey &&
    options.isSessionActive(),
  );
}

export interface OutsideWorkspaceAccessResult {
  approved: boolean;
  reason?: string;
  /** Which tier resolved the request: guardian auto-review or the user card. */
  via: "guardian" | "user";
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
): Promise<OutsideWorkspaceAccessResult> {
  const review = await reviewOutsideRead(filePath, sessionId, guardian, signal);
  if (review.approved) return { approved: true, via: "guardian" };

  const { promise } = approvalPanel.enqueuePathApproval(
    filePath,
    sessionId,
    signal,
    review.humanOnlyReason,
  );
  let response = await promise;
  if (
    response.coordinatorApproval &&
    response.decision !== "reject" &&
    review.binding &&
    !outsideReadBindingMatches(
      filePath,
      sessionId,
      guardian,
      review.binding,
      signal,
    )
  ) {
    response = await approvalPanel.enqueuePathApproval(
      filePath,
      sessionId,
      signal,
      "canonical-target-drift",
    ).promise;
  }

  if (response.decision === "reject") {
    return { approved: false, reason: response.rejectionReason, via: "user" };
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
    const saved = approvalManager.addPathRule(
      sessionId,
      { pattern: response.rulePattern, mode: response.ruleMode },
      scope,
    );
    if (!saved) {
      return {
        approved: false,
        reason: `Could not save the ${scope} outside-path approval. Access was not authorized; check the approval config path and try again.`,
        via: "user",
      };
    }
  }

  return { approved: true, via: "user" };
}
