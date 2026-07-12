import type { ConfigStore } from "./ConfigStore.js";
import { tryGetFirstWorkspaceRoot } from "../util/paths.js";

export interface CommandRule {
  pattern: string;
  mode: "prefix" | "regex" | "exact";
}

export type RuleScope = "session" | "project" | "global";

export interface ScopedCommandRules {
  session: CommandRule[];
  project: CommandRule[];
  global: CommandRule[];
}

export interface SessionCommandRuleState {
  commandRules: CommandRule[];
  lastActivity: number;
}

export interface CommandRuleSessionHost {
  get(sessionId: string): SessionCommandRuleState | undefined;
  create(sessionId: string): SessionCommandRuleState;
  persist(): void;
}

export class CommandRuleStore {
  constructor(
    private readonly configStore: ConfigStore,
    private readonly sessions: CommandRuleSessionHost,
  ) {}

  add(sessionId: string, rule: CommandRule, scope: RuleScope): boolean {
    if (scope === "global") {
      this.configStore.updateGlobalConfig((config) => {
        const rules = config.commandRules ?? [];
        if (!hasRule(rules, rule)) {
          rules.push(rule);
          config.commandRules = rules;
        }
      });
      return true;
    }

    if (scope === "project") {
      const folder = tryGetFirstWorkspaceRoot();
      if (!folder) return false;
      this.configStore.updateProjectConfig(folder, (config) => {
        const rules = config.commandRules ?? [];
        if (!hasRule(rules, rule)) {
          rules.push(rule);
          config.commandRules = rules;
        }
      });
      return true;
    }

    const existing = this.sessions.get(sessionId);
    if (existing && hasRule(existing.commandRules, rule)) {
      return true;
    }
    const session = existing ?? this.sessions.create(sessionId);
    session.commandRules.push(rule);
    session.lastActivity = Date.now();
    this.sessions.persist();
    return true;
  }

  edit(
    oldPattern: string,
    newRule: CommandRule,
    scope: RuleScope,
    sessionId?: string,
  ): boolean {
    if (scope === "global") {
      this.configStore.updateGlobalConfig((config) => {
        editFirstRule(config.commandRules ?? [], oldPattern, newRule);
      });
      return true;
    }

    if (scope === "project") {
      const folder = tryGetFirstWorkspaceRoot();
      if (!folder) return false;
      this.configStore.updateProjectConfig(folder, (config) => {
        editFirstRule(config.commandRules ?? [], oldPattern, newRule);
      });
      return true;
    }

    if (sessionId) {
      const session = this.sessions.get(sessionId);
      if (session && editFirstRule(session.commandRules, oldPattern, newRule)) {
        this.sessions.persist();
      }
    }
    return true;
  }

  remove(pattern: string, scope: RuleScope, sessionId?: string): boolean {
    if (scope === "global") {
      this.configStore.updateGlobalConfig((config) => {
        config.commandRules = (config.commandRules ?? []).filter(
          (rule) => rule.pattern !== pattern,
        );
      });
      return true;
    }

    if (scope === "project") {
      const folder = tryGetFirstWorkspaceRoot();
      if (!folder) return false;
      this.configStore.updateProjectConfig(folder, (config) => {
        config.commandRules = (config.commandRules ?? []).filter(
          (rule) => rule.pattern !== pattern,
        );
      });
      return true;
    }

    if (sessionId) {
      const session = this.sessions.get(sessionId);
      if (session) {
        session.commandRules = session.commandRules.filter(
          (rule) => rule.pattern !== pattern,
        );
        this.sessions.persist();
      }
    }
    return true;
  }

  get(sessionId: string): ScopedCommandRules {
    const projectConfig = this.configStore.getProjectConfigForFirstRoot();
    return {
      session: [...(this.sessions.get(sessionId)?.commandRules ?? [])],
      project: [...(projectConfig?.commandRules ?? [])],
      global: [...(this.configStore.getGlobalConfig().commandRules ?? [])],
    };
  }

  clearSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.commandRules = [];
      this.sessions.persist();
    }
  }
}

function hasRule(rules: CommandRule[], candidate: CommandRule): boolean {
  return rules.some(
    (rule) =>
      rule.pattern === candidate.pattern && rule.mode === candidate.mode,
  );
}

function editFirstRule(
  rules: CommandRule[],
  oldPattern: string,
  newRule: CommandRule,
): boolean {
  const index = rules.findIndex((rule) => rule.pattern === oldPattern);
  if (index === -1) return false;
  rules[index] = newRule;
  return true;
}
