import { describe, expect, expectTypeOf, it } from "vitest";

import {
  commandApprovalPolicyFromLegacyTier,
  isCommandApprovalPolicy,
  type CommandApprovalPolicy,
} from "./commandApprovalPolicy.js";

describe("command approval policy protocol", () => {
  it("keeps the serialized policy union stable", () => {
    expectTypeOf<CommandApprovalPolicy>().toEqualTypeOf<
      "manual" | "safe" | "approve-for-me" | "sensitive"
    >();
  });

  it.each(["manual", "safe", "approve-for-me", "sensitive"])(
    "accepts %s",
    (value) => {
      expect(isCommandApprovalPolicy(value)).toBe(true);
    },
  );

  it.each(["", "off", "dangerous", "always", undefined, null])(
    "rejects unsupported value %s",
    (value) => {
      expect(isCommandApprovalPolicy(value)).toBe(false);
    },
  );

  it.each([
    ["off", "manual"],
    ["safe", "safe"],
    ["sensitive", "sensitive"],
    [undefined, "safe"],
  ] as const)("maps legacy tier %s to %s", (tier, policy) => {
    expect(commandApprovalPolicyFromLegacyTier(tier)).toBe(policy);
  });
});
