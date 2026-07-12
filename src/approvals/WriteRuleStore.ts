import type { ConfigStore } from "./ConfigStore.js";
import type { PathRule } from "./PathRuleStore.js";
import {
  ScopedRuleStore,
  type RuleSessionHost,
  type ScopedRules,
} from "./ScopedRuleStore.js";

export type ScopedWriteRules = ScopedRules<PathRule>;

export interface SessionWriteRuleState {
  writeRules: PathRule[];
  lastActivity: number;
}

export type WriteRuleSessionHost = RuleSessionHost<SessionWriteRuleState>;

export class WriteRuleStore extends ScopedRuleStore<
  PathRule,
  SessionWriteRuleState
> {
  constructor(configStore: ConfigStore, sessions: WriteRuleSessionHost) {
    super(configStore, sessions, {
      getConfigRules: (config) => config.writeRules,
      setConfigRules: (config, rules) => {
        config.writeRules = rules;
      },
      getSessionRules: (session) => session.writeRules,
      setSessionRules: (session, rules) => {
        session.writeRules = rules;
      },
    });
  }
}
