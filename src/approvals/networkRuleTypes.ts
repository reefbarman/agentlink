import type { ScopedRules } from "./ruleTypes.js";

export type NetworkRuleDecision = "allow" | "prompt" | "forbidden";

export interface NetworkRule {
  pattern: string;
  mode: "exact";
  decision: NetworkRuleDecision;
}

export type ScopedNetworkRules = ScopedRules<NetworkRule>;
