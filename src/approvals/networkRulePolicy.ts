import type {
  NetworkRule,
  NetworkRuleDecision,
  ScopedNetworkRules,
} from "./networkRuleTypes.js";

import type { RuleScope } from "./ruleTypes.js";

export type EffectiveNetworkRuleDecision = NetworkRuleDecision | "unmatched";

export interface NetworkRuleDestination {
  protocol: "http" | "https" | "tcp";
  host: string;
  port: number;
}

export interface MatchedNetworkRule {
  rule: NetworkRule;
  scope: RuleScope;
}

export interface NetworkRulePolicyEvaluation {
  key: string;
  decision: EffectiveNetworkRuleDecision;
  matches: MatchedNetworkRule[];
}

const DECISION_PRIORITY: Record<EffectiveNetworkRuleDecision, number> = {
  unmatched: 0,
  allow: 1,
  prompt: 2,
  forbidden: 3,
};

export function canonicalNetworkDestinationKey(
  destination: NetworkRuleDestination,
): string {
  if (
    !["http", "https", "tcp"].includes(destination.protocol) ||
    !destination.host ||
    destination.host.includes("\0") ||
    !Number.isSafeInteger(destination.port) ||
    destination.port < 1 ||
    destination.port > 65_535
  ) {
    throw new Error("Invalid managed network destination");
  }
  const host = destination.host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  if (!host) throw new Error("Invalid managed network destination host");
  const authority = host.includes(":") ? `[${host}]` : host;
  return `${destination.protocol}://${authority}:${destination.port}`;
}

export function evaluateNetworkRulePolicy(
  rulesByScope: ScopedNetworkRules,
  destination: NetworkRuleDestination,
): NetworkRulePolicyEvaluation {
  const key = canonicalNetworkDestinationKey(destination);
  const matches: MatchedNetworkRule[] = [];
  for (const scope of ["session", "project", "global"] as const) {
    for (const rule of rulesByScope[scope]) {
      if (rule.mode === "exact" && rule.pattern === key) {
        matches.push({ rule, scope });
      }
    }
  }

  let decision: EffectiveNetworkRuleDecision = "unmatched";
  for (const { rule } of matches) {
    if (DECISION_PRIORITY[rule.decision] > DECISION_PRIORITY[decision]) {
      decision = rule.decision;
    }
  }
  return { key, decision, matches };
}
