import type { ScopedRules } from "./ruleTypes.js";

export type NetworkRuleDecision = "allow" | "prompt" | "forbidden";

export interface NetworkRule {
  pattern: string;
  mode: "exact";
  decision: NetworkRuleDecision;
  /** Rule authority copied automatically from another session. */
  inherited?: true;
}

export type ScopedNetworkRules = ScopedRules<NetworkRule>;
