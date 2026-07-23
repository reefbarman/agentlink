export interface StoredRule {
  pattern: string;
  mode: string;
  decision?: string;
}

export type RuleScope = "session" | "project" | "global";

export interface ScopedRules<TRule extends StoredRule> {
  session: TRule[];
  project: TRule[];
  global: TRule[];
}
