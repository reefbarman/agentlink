import type { ConfigStore } from "./ConfigStore.js";
import type { CommandRule } from "./commandRuleTypes.js";
import { ScopedRuleStore, type RuleSessionHost } from "./ScopedRuleStore.js";

export type {
  CommandRule,
  CommandRuleDecision,
  ScopedCommandRules,
} from "./commandRuleTypes.js";
export type { RuleScope } from "./ruleTypes.js";

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
