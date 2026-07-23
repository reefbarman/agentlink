import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  createOneShotActionApproval,
  type ActionApprovalPolicySnapshot,
  type ActionApprovalReviewer,
  type OutsideWriteActionApprovalReviewInput,
} from "../approvals/actionApprovalReview.js";
import type { CommandReviewContextEntry } from "../approvals/commandApprovalReview.js";
import type {
  OneShotWriteAuthorization,
  PreparedWriteProposal,
  PreparedWriteProposalInput,
} from "../core/capabilities/editReview.js";

export interface GuardianOutsideWriteOptions {
  reviewer?: ActionApprovalReviewer;
  sessionId: string;
  requestingTool: string;
  getPolicy(): ActionApprovalPolicySnapshot | undefined;
  isSessionActive(): boolean;
  getUserObjective?(): string | undefined;
  getContext?(): CommandReviewContextEntry[];
  signal?: AbortSignal;
}

function contentSnapshot(content: string) {
  return {
    exists: true as const,
    bytes: Buffer.byteLength(content),
    sha256: createHash("sha256").update(content).digest("hex"),
  };
}

function asProposalArray(
  input: PreparedWriteProposalInput,
): readonly PreparedWriteProposal[] {
  return Array.isArray(input) ? input : [input as PreparedWriteProposal];
}

function resolveWriteTarget(proposal: PreparedWriteProposal) {
  const absolutePath = path.resolve(proposal.absolutePath);
  if (proposal.baselineExists) {
    try {
      return {
        status: "resolved" as const,
        canonicalPath: fs.realpathSync.native(absolutePath),
      };
    } catch {
      return { status: "unresolved" as const };
    }
  }

  try {
    fs.lstatSync(absolutePath);
    return { status: "unresolved" as const };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return { status: "unresolved" as const };
    }
  }

  const missingSegments: string[] = [path.basename(absolutePath)];
  let candidate = path.dirname(absolutePath);
  while (true) {
    try {
      fs.lstatSync(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        return { status: "unresolved" as const };
      }
      const parent = path.dirname(candidate);
      if (parent === candidate) return { status: "unresolved" as const };
      missingSegments.push(path.basename(candidate));
      candidate = parent;
      continue;
    }

    try {
      const canonicalParent = fs.realpathSync.native(candidate);
      return {
        status: "resolved" as const,
        canonicalPath: path.resolve(
          canonicalParent,
          ...missingSegments.reverse(),
        ),
      };
    } catch {
      return { status: "unresolved" as const };
    }
  }
}

function buildOutsideWriteAction(
  input: PreparedWriteProposalInput,
  options: GuardianOutsideWriteOptions,
): OutsideWriteActionApprovalReviewInput | undefined {
  const policy = options.getPolicy();
  if (!policy) return undefined;
  return {
    kind: "outside-write",
    sessionId: options.sessionId,
    policy,
    requestingTool: options.requestingTool,
    userObjective: options.getUserObjective?.(),
    context: options.getContext?.(),
    signal: options.signal,
    proposals: asProposalArray(input).map((proposal) => {
      const proposed = contentSnapshot(proposal.proposedContent);
      return proposal.baselineExists
        ? {
            operation: "modify" as const,
            target: resolveWriteTarget(proposal),
            base: contentSnapshot(proposal.baselineContent),
            proposed,
            evidence: {
              kind: "content" as const,
              text: proposal.proposedContent,
              bytes: proposed.bytes,
              complete: true as const,
            },
          }
        : {
            operation: "create" as const,
            target: resolveWriteTarget(proposal),
            base: { exists: false as const, bytes: 0 as const, sha256: null },
            proposed,
            evidence: {
              kind: "content" as const,
              text: proposal.proposedContent,
              bytes: proposed.bytes,
              complete: true as const,
            },
          };
    }),
  };
}

export function createGuardianOutsideWriteAuthorizationPreparer(
  options: GuardianOutsideWriteOptions,
): (
  proposal: PreparedWriteProposalInput,
) => Promise<OneShotWriteAuthorization | undefined> {
  return async (proposal) => {
    if (!options.reviewer) return undefined;
    const reviewedAction = buildOutsideWriteAction(proposal, options);
    if (!reviewedAction) return undefined;
    let outcome;
    try {
      outcome = await options.reviewer.review(reviewedAction);
    } catch {
      return undefined;
    }
    const approval = createOneShotActionApproval(outcome);
    if (!approval) return undefined;
    return {
      authorization: {
        allowed: true,
        basis: "guardian",
        reason: approval.review.rationale,
      },
      consume(current) {
        const currentAction = buildOutsideWriteAction(current, options);
        if (!currentAction) return false;
        return approval.consume({
          sessionId: options.sessionId,
          sessionActive: options.isSessionActive(),
          policy: currentAction.policy,
          action: currentAction,
        }).valid;
      },
    };
  };
}
