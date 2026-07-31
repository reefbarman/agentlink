import type { ScopedRules } from "./ruleTypes.js";

export type CommandRuleDecision = "allow" | "prompt" | "forbidden";

export interface CommandRule {
  pattern: string;
  mode: "prefix" | "regex" | "exact";
  /** Rule authority copied automatically from another session. */
  inherited?: true;
  /** Missing on legacy AgentLink trust rules and interpreted as "allow". */
  decision?: CommandRuleDecision;
}

export type ScopedCommandRules = ScopedRules<CommandRule>;
