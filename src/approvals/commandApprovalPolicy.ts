export type CommandApprovalPolicy =
  | "manual"
  | "safe"
  | "approve-for-me"
  | "sensitive";

export type LegacyCommandAutoApproveTier = "off" | "safe" | "sensitive";

export function isCommandApprovalPolicy(
  value: unknown,
): value is CommandApprovalPolicy {
  return (
    value === "manual" ||
    value === "safe" ||
    value === "approve-for-me" ||
    value === "sensitive"
  );
}

export function commandApprovalPolicyFromLegacyTier(
  tier: LegacyCommandAutoApproveTier | undefined,
): Exclude<CommandApprovalPolicy, "approve-for-me"> {
  if (tier === "off") return "manual";
  if (tier === "sensitive") return "sensitive";
  return "safe";
}
