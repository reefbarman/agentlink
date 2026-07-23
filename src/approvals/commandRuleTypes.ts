import type { ScopedRules } from "./ruleTypes.js";

export type CommandRuleDecision = "allow" | "prompt" | "forbidden";

export interface CommandRule {
  pattern: string;
  mode: "prefix" | "regex" | "exact";
  /**
   * Missing only on legacy AgentLink trust rules. Legacy rules skip the normal
   * approval card but never grant Codex-style native authority.
   */
  decision?: CommandRuleDecision;
}

export type ScopedCommandRules = ScopedRules<CommandRule>;
