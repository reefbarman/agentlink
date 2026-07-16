import {
  commandApprovalPolicyFromLegacyTier,
  isCommandApprovalPolicy,
} from "./commandApprovalPolicy.js";
import { describe, expect, it } from "vitest";

describe("command approval policy", () => {
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
