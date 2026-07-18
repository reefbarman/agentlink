import type { AgentLinkConfig, ConfigStore } from "./ConfigStore.js";

export interface StoredRule {
  pattern: string;
  mode: string;
}

export type RuleScope = "session" | "project" | "global";

export interface ScopedRules<TRule extends StoredRule> {
  session: TRule[];
  project: TRule[];
  global: TRule[];
}

export interface RuleSessionHost<TSession> {
  get(sessionId: string): TSession | undefined;
  create(sessionId: string): TSession;
  persist(): void;
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
      this.configStore.updateGlobalConfig((config) => {
        this.addToConfig(config, rule);
      });
      return true;
    }

    if (scope === "project") {
      if (!projectRoot) return false;
      this.configStore.updateProjectConfig(projectRoot, (config) => {
        this.addToConfig(config, rule);
      });
      return true;
    }

    const existing = this.sessions.get(sessionId);
    if (existing && hasRule(this.descriptor.getSessionRules(existing), rule)) {
      return true;
    }
    const session = existing ?? this.sessions.create(sessionId);
    const rules = this.descriptor.getSessionRules(session);
    rules.push(rule);
    this.descriptor.setSessionRules(session, rules);
    session.lastActivity = Date.now();
    this.sessions.persist();
    return true;
  }

  edit(
    oldPattern: string,
    newRule: TRule,
    scope: RuleScope,
    sessionId?: string,
    projectRoot?: string,
  ): boolean {
    if (scope === "global") {
      this.configStore.updateGlobalConfig((config) => {
        this.editConfigRule(config, oldPattern, newRule);
      });
      return true;
    }

    if (scope === "project") {
      if (!projectRoot) return false;
      this.configStore.updateProjectConfig(projectRoot, (config) => {
        this.editConfigRule(config, oldPattern, newRule);
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
        )
      ) {
        this.sessions.persist();
      }
    }
    return true;
  }

  remove(
    pattern: string,
    scope: RuleScope,
    sessionId?: string,
    projectRoot?: string,
  ): boolean {
    if (scope === "global") {
      this.configStore.updateGlobalConfig((config) => {
        this.removeFromConfig(config, pattern);
      });
      return true;
    }

    if (scope === "project") {
      if (!projectRoot) return false;
      this.configStore.updateProjectConfig(projectRoot, (config) => {
        this.removeFromConfig(config, pattern);
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
            .filter((rule) => rule.pattern !== pattern),
        );
        this.sessions.persist();
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
      this.sessions.persist();
    }
  }

  private addToConfig(config: AgentLinkConfig, rule: TRule): void {
    const rules = this.getConfigRules(config);
    if (!hasRule(rules, rule)) {
      rules.push(rule);
      this.descriptor.setConfigRules(config, rules);
    }
  }

  private editConfigRule(
    config: AgentLinkConfig,
    oldPattern: string,
    newRule: TRule,
  ): void {
    const rules = this.getConfigRules(config);
    if (editFirstRule(rules, oldPattern, newRule)) {
      this.descriptor.setConfigRules(config, rules);
    }
  }

  private removeFromConfig(config: AgentLinkConfig, pattern: string): void {
    this.descriptor.setConfigRules(
      config,
      this.getConfigRules(config).filter((rule) => rule.pattern !== pattern),
    );
  }

  private getConfigRules(config: Readonly<AgentLinkConfig>): TRule[] {
    return [...(this.descriptor.getConfigRules(config) ?? [])];
  }
}

function hasRule<TRule extends StoredRule>(
  rules: TRule[],
  candidate: TRule,
): boolean {
  return rules.some(
    (rule) =>
      rule.pattern === candidate.pattern && rule.mode === candidate.mode,
  );
}

function editFirstRule<TRule extends StoredRule>(
  rules: TRule[],
  oldPattern: string,
  newRule: TRule,
): boolean {
  const index = rules.findIndex((rule) => rule.pattern === oldPattern);
  if (index === -1) return false;
  rules[index] = newRule;
  return true;
}
