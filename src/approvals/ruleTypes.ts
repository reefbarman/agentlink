export interface StoredRule {
  pattern: string;
  mode: string;
  decision?: string;
  /** Rule authority copied automatically from another session. */
  inherited?: true;
}

export type RuleScope = "session" | "project" | "global";

export interface ScopedRules<TRule extends StoredRule> {
  session: TRule[];
  project: TRule[];
  global: TRule[];
}
