import type { ConfigStore } from "./ConfigStore.js";
import {
  ScopedRuleStore,
  type RuleSessionHost,
  type ScopedRules,
} from "./ScopedRuleStore.js";

export interface PathRule {
  pattern: string;
  mode: "glob" | "prefix" | "exact";
}

export type ScopedPathRules = ScopedRules<PathRule>;

export interface SessionPathRuleState {
  pathRules: PathRule[];
  lastActivity: number;
}

export type PathRuleSessionHost = RuleSessionHost<SessionPathRuleState>;

export class PathRuleStore extends ScopedRuleStore<
  PathRule,
  SessionPathRuleState
> {
  constructor(configStore: ConfigStore, sessions: PathRuleSessionHost) {
    super(configStore, sessions, {
      getConfigRules: (config) => config.pathRules,
      setConfigRules: (config, rules) => {
        config.pathRules = rules;
      },
      getSessionRules: (session) => session.pathRules,
      setSessionRules: (session, rules) => {
        session.pathRules = rules;
      },
    });
  }
}
