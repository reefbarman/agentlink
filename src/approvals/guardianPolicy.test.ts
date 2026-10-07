import {
  GUARDIAN_POLICY_CLAUSES,
  GUARDIAN_POLICY_FINGERPRINT,
  GUARDIAN_POLICY_VERSION,
  GUARDIAN_REVIEW_SYSTEM_PROMPT,
  getGuardianPolicy,
} from "./guardianPolicy.js";
import { describe, expect, it } from "vitest";

import { COMMAND_REVIEW_POLICY_FINGERPRINT } from "./commandApprovalReview.js";
import { createHash } from "node:crypto";

describe("shared Guardian policy", () => {
  it("preserves the legacy primary prompt and fingerprint", () => {
    expect(COMMAND_REVIEW_POLICY_FINGERPRINT).toBe(
      createHash("sha256")
        .update(GUARDIAN_REVIEW_SYSTEM_PROMPT)
        .digest("hex")
        .slice(0, 16),
    );
    expect(COMMAND_REVIEW_POLICY_FINGERPRINT).toBe("b16322cd7bf83c41");
    expect(GUARDIAN_REVIEW_SYSTEM_PROMPT).toContain(
      "Ordinary Git and GitHub publishing workflow is authorized by default",
    );
  });

  it("provides stable shared clauses and a baseline variant", () => {
    expect(GUARDIAN_POLICY_VERSION).toBe("current-primary-v1");
    expect(GUARDIAN_POLICY_FINGERPRINT).toMatch(/^[0-9a-f]{16}$/);
    expect(getGuardianPolicy(false)).toEqual({
      version: GUARDIAN_POLICY_VERSION,
      fingerprint: GUARDIAN_POLICY_FINGERPRINT,
      systemPrompt: GUARDIAN_REVIEW_SYSTEM_PROMPT,
      clauses: [...GUARDIAN_POLICY_CLAUSES],
    });
  });

  it("adds scoped review-publication wording only to the variant", () => {
    const variant = getGuardianPolicy(true);
    const baseline = getGuardianPolicy(false);
    expect(variant.fingerprint).not.toBe(baseline.fingerprint);
    expect(variant.systemPrompt).toContain(
      "Review-publication policy variant:",
    );
    expect(variant.systemPrompt).toContain(
      "COMMENT, APPROVE, or REQUEST_CHANGES",
    );
    expect(baseline.systemPrompt).toBe(GUARDIAN_REVIEW_SYSTEM_PROMPT);
  });
});
