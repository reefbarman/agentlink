import type { AgentLinkConfig, ConfigStore } from "./ConfigStore.js";
import type { RuleScope, ScopedRules, StoredRule } from "./ruleTypes.js";

export type { RuleScope, ScopedRules, StoredRule } from "./ruleTypes.js";

export interface RuleSessionHost<TSession> {
  get(sessionId: string): TSession | undefined;
  create(sessionId: string): TSession;
}

export interface RuleStoreDescriptor<
  TRule extends StoredRule,
  TSession extends { lastActivity: number },
> {
  getConfigRules(
    config: Readonly<AgentLinkConfig>,
  ): readonly TRule[] | undefined;
  setConfigRules(config: AgentLinkConfig, rules: TRule[]): void;
  getSessionRules(session: TSession): TRule[];
  setSessionRules(session: TSession, rules: TRule[]): void;
}

export class ScopedRuleStore<
  TRule extends StoredRule,
  TSession extends { lastActivity: number },
> {
  constructor(
    private readonly configStore: ConfigStore,
    private readonly sessions: RuleSessionHost<TSession>,
    private readonly descriptor: RuleStoreDescriptor<TRule, TSession>,
  ) {}

  add(
    sessionId: string,
    rule: TRule,
    scope: RuleScope,
    projectRoot?: string,
  ): boolean {
    if (scope === "global") {
      return this.configStore.updateGlobalConfig((config) => {
        this.addToConfig(config, rule);
      });
    }

    if (scope === "project") {
      if (!projectRoot) return false;
      return this.configStore.updateProjectConfig(projectRoot, (config) => {
        this.addToConfig(config, rule);
      });
    }

    const existing = this.sessions.get(sessionId);
    const session = existing ?? this.sessions.create(sessionId);
    const rules = this.descriptor.getSessionRules(session);
    upsertRule(rules, rule);
    this.descriptor.setSessionRules(session, rules);
    session.lastActivity = Date.now();
    return true;
  }

  edit(
    oldPattern: string,
    newRule: TRule,
    scope: RuleScope,
    sessionId?: string,
    projectRoot?: string,
    oldRule?: StoredRule,
  ): boolean {
    if (scope === "global") {
      this.configStore.updateGlobalConfig((config) => {
        this.editConfigRule(config, oldPattern, newRule, oldRule);
      });
      return true;
    }

    if (scope === "project") {
      if (!projectRoot) return false;
      this.configStore.updateProjectConfig(projectRoot, (config) => {
        this.editConfigRule(config, oldPattern, newRule, oldRule);
      });
      return true;
    }

    if (sessionId) {
      const session = this.sessions.get(sessionId);
      if (
        session &&
        editFirstRule(
          this.descriptor.getSessionRules(session),
          oldPattern,
          newRule,
          oldRule,
        )
      ) {
        session.lastActivity = Date.now();
      }
    }
    return true;
  }

  remove(
    pattern: string,
    scope: RuleScope,
    sessionId?: string,
    projectRoot?: string,
    rule?: StoredRule,
  ): boolean {
    if (scope === "global") {
      this.configStore.updateGlobalConfig((config) => {
        this.removeFromConfig(config, pattern, rule);
      });
      return true;
    }

    if (scope === "project") {
      if (!projectRoot) return false;
      this.configStore.updateProjectConfig(projectRoot, (config) => {
        this.removeFromConfig(config, pattern, rule);
      });
      return true;
    }

    if (sessionId) {
      const session = this.sessions.get(sessionId);
      if (session) {
        this.descriptor.setSessionRules(
          session,
          this.descriptor
            .getSessionRules(session)
            .filter(
              (candidate) => !matchesStoredRule(candidate, pattern, rule),
            ),
        );
        session.lastActivity = Date.now();
      }
    }
    return true;
  }

  get(sessionId: string, projectRoot?: string): ScopedRules<TRule> {
    const projectConfig = projectRoot
      ? this.configStore.getProjectConfig(projectRoot)
      : undefined;
    const session = this.sessions.get(sessionId);
    return {
      session: session ? [...this.descriptor.getSessionRules(session)] : [],
      project: [...(projectConfig ? this.getConfigRules(projectConfig) : [])],
      global: [...this.getConfigRules(this.configStore.getGlobalConfig())],
    };
  }

  clearSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      this.descriptor.setSessionRules(session, []);
      session.lastActivity = Date.now();
    }
  }

  private addToConfig(config: AgentLinkConfig, rule: TRule): void {
    const rules = this.getConfigRules(config);
    upsertRule(rules, rule);
    this.descriptor.setConfigRules(config, rules);
  }

  private editConfigRule(
    config: AgentLinkConfig,
    oldPattern: string,
    newRule: TRule,
    oldRule?: StoredRule,
  ): void {
    const rules = this.getConfigRules(config);
    if (editFirstRule(rules, oldPattern, newRule, oldRule)) {
      this.descriptor.setConfigRules(config, rules);
    }
  }

  private removeFromConfig(
    config: AgentLinkConfig,
    pattern: string,
    rule?: StoredRule,
  ): void {
    this.descriptor.setConfigRules(
      config,
      this.getConfigRules(config).filter(
        (candidate) => !matchesStoredRule(candidate, pattern, rule),
      ),
    );
  }

  private getConfigRules(config: Readonly<AgentLinkConfig>): TRule[] {
    return [...(this.descriptor.getConfigRules(config) ?? [])];
  }
}

function upsertRule<TRule extends StoredRule>(
  rules: TRule[],
  candidate: TRule,
): void {
  const index = rules.findIndex(
    (rule) =>
      rule.pattern === candidate.pattern && rule.mode === candidate.mode,
  );
  if (index === -1) {
    rules.push(candidate);
  } else {
    rules[index] = candidate;
  }
}

function matchesStoredRule<TRule extends StoredRule>(
  candidate: TRule,
  pattern: string,
  rule?: StoredRule,
): boolean {
  return (
    candidate.pattern === pattern &&
    (!rule ||
      (candidate.mode === rule.mode && candidate.decision === rule.decision))
  );
}

function editFirstRule<TRule extends StoredRule>(
  rules: TRule[],
  oldPattern: string,
  newRule: TRule,
  oldRule?: StoredRule,
): boolean {
  const index = rules.findIndex((rule) =>
    matchesStoredRule(rule, oldPattern, oldRule),
  );
  if (index === -1) return false;
  rules[index] = newRule;
  return true;
}
