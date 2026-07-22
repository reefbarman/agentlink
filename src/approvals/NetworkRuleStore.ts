import type { ConfigStore } from "./ConfigStore.js";
import type { NetworkRule } from "./networkRuleTypes.js";
import { ScopedRuleStore, type RuleSessionHost } from "./ScopedRuleStore.js";

export type {
  NetworkRule,
  NetworkRuleDecision,
  ScopedNetworkRules,
} from "./networkRuleTypes.js";
export type { RuleScope } from "./ruleTypes.js";

export interface SessionNetworkRuleState {
  networkRules: NetworkRule[];
  lastActivity: number;
}

export type NetworkRuleSessionHost = RuleSessionHost<SessionNetworkRuleState>;

export class NetworkRuleStore extends ScopedRuleStore<
  NetworkRule,
  SessionNetworkRuleState
> {
  constructor(configStore: ConfigStore, sessions: NetworkRuleSessionHost) {
    super(configStore, sessions, {
      getConfigRules: (config) => config.networkRules,
      setConfigRules: (config, rules) => {
        config.networkRules = rules;
      },
      getSessionRules: (session) => session.networkRules,
      setSessionRules: (session, rules) => {
        session.networkRules = rules;
      },
    });
  }
}
