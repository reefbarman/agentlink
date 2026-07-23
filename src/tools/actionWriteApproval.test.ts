import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  actionApprovalActionKey,
  actionApprovalPolicyKey,
  type ActionApprovalReviewInput,
} from "../approvals/actionApprovalReview.js";
import { createGuardianOutsideWriteAuthorizationPreparer } from "./actionWriteApproval.js";

const policy = {
  commandApprovalPolicy: "approve-for-me" as const,
  approvalPolicy: "on-request" as const,
  approvalReviewer: "auto-review" as const,
  executionPreset: "workspace-write" as const,
};

function reviewedAllow(input: ActionApprovalReviewInput) {
  return {
    disposition: "reviewed" as const,
    binding: {
      sessionId: input.sessionId,
      policyKey: actionApprovalPolicyKey(input.policy),
      actionKey: actionApprovalActionKey(input)!,
      kind: input.kind,
    },
    result: {
      outcome: "allow" as const,
      risk: "low" as const,
      userAuthorization: "high" as const,
      rationale: "Allowed",
      status: "reviewed" as const,
      model: "guardian-model",
    },
  };
}

describe("createGuardianOutsideWriteAuthorizationPreparer", () => {
  const proposal = {
    absolutePath: path.join(process.cwd(), "package.json"),
    baselineExists: true,
    baselineContent: "before\n",
    proposedContent: "after\n",
  };

  it("returns a one-use Guardian authorization bound to the exact proposal", async () => {
    const review = vi.fn(async (input: ActionApprovalReviewInput) =>
      reviewedAllow(input),
    );
    const prepare = createGuardianOutsideWriteAuthorizationPreparer({
      reviewer: { review },
      sessionId: "session-1",
      requestingTool: "write_file",
      getPolicy: () => policy,
      isSessionActive: () => true,
    });

    const authorization = await prepare(proposal);

    expect(authorization?.authorization).toMatchObject({
      allowed: true,
      basis: "guardian",
    });
    expect(authorization?.consume(proposal)).toBe(true);
    expect(authorization?.consume(proposal)).toBe(false);
  });

  it("binds an atomic proposal set independent of input ordering", async () => {
    const second = {
      ...proposal,
      absolutePath: path.join(process.cwd(), "package-lock.json"),
      baselineContent: "two before\n",
      proposedContent: "two after\n",
    };
    const review = vi.fn(async (input: ActionApprovalReviewInput) =>
      reviewedAllow(input),
    );
    const prepare = createGuardianOutsideWriteAuthorizationPreparer({
      reviewer: { review },
      sessionId: "session-1",
      requestingTool: "find_and_replace",
      getPolicy: () => policy,
      isSessionActive: () => true,
    });

    const authorization = await prepare([proposal, second]);

    expect(review).toHaveBeenCalledWith(
      expect.objectContaining({
        proposals: expect.arrayContaining([
          expect.objectContaining({
            target: expect.objectContaining({
              canonicalPath: proposal.absolutePath,
            }),
          }),
          expect.objectContaining({
            target: expect.objectContaining({
              canonicalPath: second.absolutePath,
            }),
          }),
        ]),
      }),
    );
    expect(authorization?.consume([second, proposal])).toBe(true);
    expect(authorization?.consume([proposal, second])).toBe(false);
  });

  it("rejects affected-set drift before atomic execution", async () => {
    const second = {
      ...proposal,
      absolutePath: path.join(process.cwd(), "package-lock.json"),
    };
    const prepare = createGuardianOutsideWriteAuthorizationPreparer({
      reviewer: { review: async (input) => reviewedAllow(input) },
      sessionId: "session-1",
      requestingTool: "find_and_replace",
      getPolicy: () => policy,
      isSessionActive: () => true,
    });

    const authorization = await prepare([proposal, second]);

    expect(authorization?.consume([proposal])).toBe(false);
  });

  it("treats a dangling symlink write target as human-only", async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "agentlink-write-review-"),
    );
    const danglingPath = path.join(tempDir, "dangling.txt");
    fs.symlinkSync(path.join(tempDir, "missing.txt"), danglingPath);
    const review = vi.fn(async (input: ActionApprovalReviewInput) => {
      const target =
        input.kind === "outside-write" ? input.proposals[0]?.target : undefined;
      expect(target).toEqual({ status: "unresolved" });
      return {
        disposition: "human-only" as const,
        reason: "unresolved" as const,
        result: {
          outcome: "deny" as const,
          risk: "medium" as const,
          userAuthorization: "unknown" as const,
          rationale: "Unresolved target",
          status: "reviewed" as const,
          model: "guardian-model",
        },
      };
    });
    const prepare = createGuardianOutsideWriteAuthorizationPreparer({
      reviewer: { review },
      sessionId: "session-1",
      requestingTool: "write_file",
      getPolicy: () => policy,
      isSessionActive: () => true,
    });

    try {
      await expect(
        prepare({
          ...proposal,
          absolutePath: danglingPath,
          baselineExists: false,
          baselineContent: "",
        }),
      ).resolves.toBeUndefined();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it.each([
    ["baseline", { ...proposal, baselineContent: "changed\n" }],
    ["proposal", { ...proposal, proposedContent: "different\n" }],
  ])("rejects %s drift before execution", async (_name, current) => {
    const prepare = createGuardianOutsideWriteAuthorizationPreparer({
      reviewer: { review: async (input) => reviewedAllow(input) },
      sessionId: "session-1",
      requestingTool: "apply_diff",
      getPolicy: () => policy,
      isSessionActive: () => true,
    });

    const authorization = await prepare(proposal);

    expect(authorization?.consume(current)).toBe(false);
  });
});
