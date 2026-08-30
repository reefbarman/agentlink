import {
  commandApprovalPolicyFromLegacyTier,
  isCommandApprovalPolicy,
  type CommandApprovalPolicy,
} from "./commandApprovalPolicy.js";
import { describe, expect, expectTypeOf, it } from "vitest";

describe("command approval policy protocol compatibility shim", () => {
  it("preserves the legacy policy union and normalization", () => {
    expectTypeOf<CommandApprovalPolicy>().toEqualTypeOf<
      "manual" | "safe" | "approve-for-me" | "sensitive"
    >();
    expect(isCommandApprovalPolicy("approve-for-me")).toBe(true);
    expect(commandApprovalPolicyFromLegacyTier("off")).toBe("manual");
    expect(commandApprovalPolicyFromLegacyTier(undefined)).toBe("safe");
  });
});
