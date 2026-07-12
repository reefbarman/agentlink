import type { ConfigStore } from "./ConfigStore.js";
import {
  ScopedRuleStore,
  type RuleSessionHost,
  type ScopedRules,
} from "./ScopedRuleStore.js";

export interface CommandRule {
  pattern: string;
  mode: "prefix" | "regex" | "exact";
}

export type { RuleScope } from "./ScopedRuleStore.js";
export type ScopedCommandRules = ScopedRules<CommandRule>;

export interface SessionCommandRuleState {
  commandRules: CommandRule[];
  lastActivity: number;
}

export type CommandRuleSessionHost = RuleSessionHost<SessionCommandRuleState>;

export class CommandRuleStore extends ScopedRuleStore<
  CommandRule,
  SessionCommandRuleState
> {
  constructor(configStore: ConfigStore, sessions: CommandRuleSessionHost) {
    super(configStore, sessions, {
      getConfigRules: (config) => config.commandRules,
      setConfigRules: (config, rules) => {
        config.commandRules = rules;
      },
      getSessionRules: (session) => session.commandRules,
      setSessionRules: (session, rules) => {
        session.commandRules = rules;
      },
    });
  }
}
