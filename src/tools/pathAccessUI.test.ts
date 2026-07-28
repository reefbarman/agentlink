import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  actionApprovalActionKey,
  actionApprovalPolicyKey,
  type ActionApprovalReviewInput,
} from "../approvals/actionApprovalReview.js";
import { approveOutsideWorkspaceAccess } from "./pathAccessUI.js";

const policy = {
  commandApprovalPolicy: "approve-for-me" as const,
  approvalPolicy: "on-request" as const,
  approvalReviewer: "auto-review" as const,
  executionPreset: "workspace-write" as const,
};

function reviewed(input: ActionApprovalReviewInput, outcome: "allow" | "deny") {
  return {
    disposition: "reviewed" as const,
    binding: {
      sessionId: input.sessionId,
      policyKey: actionApprovalPolicyKey(input.policy),
      actionKey: actionApprovalActionKey(input)!,
      kind: input.kind,
    },
    result: {
      outcome,
      risk: "low" as const,
      userAuthorization: "high" as const,
      rationale: outcome === "allow" ? "Allowed" : "Denied",
      status: "reviewed" as const,
      model: "guardian-model",
    },
  };
}

describe("approveOutsideWorkspaceAccess Guardian review", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  function outsideFile(): string {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-path-review-")),
    );
    roots.push(root);
    const filePath = path.join(root, "README.md");
    fs.writeFileSync(filePath, "safe\n");
    return filePath;
  }

  it("uses a reviewed one-shot allow without opening UI or persisting a rule", async () => {
    const filePath = outsideFile();
    const addPathRule = vi.fn();
    const enqueuePathApproval = vi.fn();
    const review = vi.fn(async (input: ActionApprovalReviewInput) =>
      reviewed(input, "allow"),
    );

    const result = await approveOutsideWorkspaceAccess(
      filePath,
      { addPathRule } as never,
      { enqueuePathApproval } as never,
      "session-1",
      undefined,
      {
        reviewer: { review },
        requestingTool: "read_file",
        operation: {
          kind: "read-file",
          offset: 1,
          limit: 20,
          includeSymbols: true,
          autoFollowSuggestion: false,
        },
        getPolicy: () => policy,
        isSessionActive: () => true,
      },
    );

    expect(result).toEqual({ approved: true });
    expect(review).toHaveBeenCalledOnce();
    expect(enqueuePathApproval).not.toHaveBeenCalled();
    expect(addPathRule).not.toHaveBeenCalled();
  });

  it("falls back to the human panel after a reviewed denial", async () => {
    const filePath = outsideFile();
    const addPathRule = vi.fn(() => true);
    const enqueuePathApproval = vi.fn(() => ({
      promise: Promise.resolve({
        decision: "allow-session",
        rulePattern: filePath,
        ruleMode: "exact",
      }),
    }));

    const result = await approveOutsideWorkspaceAccess(
      filePath,
      { addPathRule } as never,
      { enqueuePathApproval } as never,
      "session-1",
      undefined,
      {
        reviewer: {
          review: async (input) => reviewed(input, "deny"),
        },
        requestingTool: "read_file",
        operation: {
          kind: "read-file",
          includeSymbols: false,
          autoFollowSuggestion: false,
        },
        getPolicy: () => policy,
        isSessionActive: () => true,
      },
    );

    expect(result).toEqual({ approved: true });
    expect(enqueuePathApproval).toHaveBeenCalledWith(
      filePath,
      "session-1",
      undefined,
      "guardian-denied",
    );
    expect(addPathRule).toHaveBeenCalledWith(
      "session-1",
      { pattern: filePath, mode: "exact" },
      "session",
    );
  });

  it("rejects access when a persistent path rule cannot be saved", async () => {
    const filePath = outsideFile();
    const enqueuePathApproval = vi.fn(() => ({
      promise: Promise.resolve({
        decision: "allow-project",
        rulePattern: filePath,
        ruleMode: "exact",
      }),
    }));

    const result = await approveOutsideWorkspaceAccess(
      filePath,
      { addPathRule: vi.fn(() => false) } as never,
      { enqueuePathApproval } as never,
      "session-1",
    );

    expect(result).toEqual({
      approved: false,
      reason: expect.stringContaining(
        "Could not save the project outside-path approval",
      ),
    });
  });
});
