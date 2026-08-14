import { describe, expect, it } from "vitest";

import type { EditReviewResult } from "../core/capabilities/editReview.js";
import { finalizeEditReviewResult } from "./editReviewResult.js";

function durableResult(
  overrides: Partial<EditReviewResult> = {},
): EditReviewResult {
  return {
    status: "accepted",
    path: "src/example.ts",
    operation: "modified",
    finalContent: "saved content",
    decision: "accept-session",
    writeApprovalResponse: { decision: "accept-session" },
    durability: {
      status: "durable",
      outcome: "exact",
      policy: "allow_transform",
      baseline_exists: true,
      final_exists: true,
      disk_changed: true,
      baseline_content_hash: "baseline",
      approved_content_hash: "approved",
      expected_disk_content_hash: "expected",
      editor_content_hash: "editor",
      final_content_hash: "final",
      requires_reread: false,
    },
    ...overrides,
  };
}

describe("finalizeEditReviewResult", () => {
  it("returns durable accepted evidence without internal editor state", () => {
    const finalized = finalizeEditReviewResult(durableResult(), {
      authorization: { allowed: true, basis: "human" },
    });

    expect(finalized.accepted).toBe(true);
    if (!finalized.accepted) return;
    expect(finalized.response).toMatchObject({
      status: "accepted",
      path: "src/example.ts",
      post_edit_content_hash: "final",
      durability: { status: "durable", outcome: "exact" },
      authorization: { allowed: true, basis: "human" },
    });
    expect(finalized.response).not.toHaveProperty("finalContent");
    expect(finalized.response).not.toHaveProperty("decision");
    expect(finalized.response).not.toHaveProperty("writeApprovalResponse");
  });

  it("fails closed when accepted results lack durable evidence", () => {
    const finalized = finalizeEditReviewResult({
      status: "accepted",
      path: "src/example.ts",
      finalContent: "must not leak",
    });

    expect(finalized.accepted).toBe(false);
    if (finalized.accepted) return;
    expect(finalized.result.isError).toBe(true);
    expect(finalized.result.data).toMatchObject({
      status: "error",
      reason: "missing_durability_evidence",
      path: "src/example.ts",
    });
    expect(finalized.result.data).not.toHaveProperty("finalContent");
  });

  it("turns save and durability failures into canonical tool errors", () => {
    const finalized = finalizeEditReviewResult({
      status: "error",
      path: "src/example.ts",
      error: "Approved edit did not survive save",
      reason: "save_reverted_edit",
      finalContent: "baseline",
      durability: {
        status: "failed",
        outcome: "reverted",
        policy: "allow_transform",
        baseline_exists: true,
        final_exists: true,
        disk_changed: false,
        baseline_content_hash: "baseline",
        approved_content_hash: "approved",
        expected_disk_content_hash: "expected",
        editor_content_hash: "editor",
        final_content_hash: "baseline",
        requires_reread: true,
      },
      next_steps: ["Re-read the file before retrying."],
    });

    expect(finalized.accepted).toBe(false);
    if (finalized.accepted) return;
    expect(finalized.result.isError).toBe(true);
    expect(finalized.result.data).toMatchObject({
      status: "error",
      error: "Approved edit did not survive save",
      reason: "save_reverted_edit",
      durability: { status: "failed", outcome: "reverted" },
    });
    expect(finalized.result.data).not.toHaveProperty("finalContent");
  });

  it("keeps user rejection as a normal structured result", () => {
    const finalized = finalizeEditReviewResult({
      status: "rejected_by_user",
      path: "src/example.ts",
      reason: "Keep the original wording",
      decision: "reject",
    });

    expect(finalized.accepted).toBe(false);
    if (finalized.accepted) return;
    expect(finalized.result.isError).toBe(false);
    expect(finalized.result.data).toEqual({
      status: "rejected_by_user",
      path: "src/example.ts",
      reason: "Keep the original wording",
    });
  });
});
