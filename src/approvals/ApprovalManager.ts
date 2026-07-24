import * as path from "path";

import * as vscode from "vscode";
import picomatch from "picomatch";

import { parseMcpToolName } from "../agent/mcpToolNames.js";
import {
  createWorkspaceProjectId,
  type SessionProjectScope,
} from "../core/workspaceProjects.js";
import type { WriteAuthorizationDecision } from "../core/capabilities/editReview.js";
import type { ConfigStore } from "./ConfigStore.js";
import { CommandRuleStore, type CommandRule } from "./CommandRuleStore.js";
import { NetworkRuleStore, type NetworkRule } from "./NetworkRuleStore.js";
import {
  evaluateCommandRulePolicy,
  type CommandRulePolicyEvaluation,
  type MatchedCommandRule,
} from "./commandRulePolicy.js";
import {
  evaluateNetworkRulePolicy,
  type NetworkRuleDestination,
  type NetworkRulePolicyEvaluation,
} from "./networkRulePolicy.js";
import { PathRuleStore, type PathRule } from "./PathRuleStore.js";
import type { RuleScope } from "./ScopedRuleStore.js";
import { WriteRuleStore } from "./WriteRuleStore.js";

export type { CommandRule } from "./CommandRuleStore.js";
export type { NetworkRule } from "./NetworkRuleStore.js";
export type { PathRule } from "./PathRuleStore.js";
export type { RuleScope } from "./ScopedRuleStore.js";

interface SessionState {
  writeApproved: boolean;
  agentWriteApproved: boolean;
  commandRules: CommandRule[];
  networkRules: NetworkRule[];
  pathRules: PathRule[];
  writeRules: PathRule[];
  mcpToolApprovals: string[];
  mcpServerApprovals: string[];
  lastActivity: number;
}

interface PersistedApprovalSessions {
  version: 1;
  sessions: Record<string, SessionState>;
}

interface SessionProjectBinding {
  projectId: string;
  workspaceFolderUri: string;
  rootPath: string;
}

interface PendingSessionPersistence {
  snapshot?: string;
  value?: SessionState;
  baseSnapshot?: string;
}

export interface AgentWriteApprovalDiagnostics {
  effectiveScope: "prompt" | "session" | "project" | "global";
  globalBlanketApproved: boolean;
  projectBlanketApproved: boolean;
  sessionBlanketApproved: boolean;
  legacyGlobalBlanketApproved: boolean;
  legacyProjectBlanketApproved: boolean;
  legacySessionBlanketApproved: boolean;
  sessionProjectBound: boolean;
  sessionStatePresent: boolean;
  sessionStateAgeMs?: number;
  writeRuleCounts: {
    session: number;
    project: number;
    global: number;
    settings: number;
  };
}

const SESSION_TTL = 24 * 60 * 60_000; // 24 hours
const PRUNE_INTERVAL = 60 * 60_000; // 1 hour
const APPROVAL_SESSIONS_KEY = "approvalSessions";
const APPROVAL_SESSION_KEY_PREFIX = "approvalSession:";
const APPROVAL_SESSION_STORAGE_VERSION_KEY = "approvalSessionStorageVersion";
const APPROVAL_SESSION_STORAGE_VERSION = 3;

export class ApprovalManager {
  private pruneTimer: ReturnType<typeof setInterval>;
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  // Session-scoped approvals, keyed by chat session ID.
  // Persisted so restored chat sessions keep their session-level approvals.
  private sessions = new Map<string, SessionState>();
  /** Last locally observed value for differential, per-session persistence. */
  private persistedSessionSnapshots = new Map<string, string>();
  private pendingSessionPersistence = new Map<
    string,
    PendingSessionPersistence
  >();
  private activeSessionPersistence = new Map<string, Promise<void>>();
  private sessionProjects = new Map<string, SessionProjectBinding>();

  private configStoreListener: vscode.Disposable;
  private commandRuleStore: CommandRuleStore;
  private networkRuleStore: NetworkRuleStore;
  private pathRuleStore: PathRuleStore;
  private writeRuleStore: WriteRuleStore;

  constructor(
    private globalState: vscode.Memento, // kept for migration
    private configStore: ConfigStore,
  ) {
    this.loadPersistedSessions();
    const sessionHost = {
      get: (sessionId: string) => this.sessions.get(sessionId),
      create: (sessionId: string) => {
        const session = this.newSession();
        this.sessions.set(sessionId, session);
        return session;
      },
      persist: () => this.persistSessions(),
    };
    this.commandRuleStore = new CommandRuleStore(configStore, sessionHost);
    this.networkRuleStore = new NetworkRuleStore(configStore, sessionHost);
    this.pathRuleStore = new PathRuleStore(configStore, sessionHost);
    this.writeRuleStore = new WriteRuleStore(configStore, sessionHost);
    this.pruneExpiredSessions();
    this.pruneTimer = setInterval(
      () => this.pruneExpiredSessions(),
      PRUNE_INTERVAL,
    );
    // Forward config file changes to our own onDidChange
    this.configStoreListener = configStore.onDidChange(() =>
      this._onDidChange.fire(),
    );
  }

  bindSessionProject(
    sessionId: string,
    scope: Readonly<SessionProjectScope>,
  ): void {
    if (!scope.rootPath) {
      throw new Error(
        `Project '${scope.displayName}' is unavailable for approval routing.`,
      );
    }
    const existing = this.sessionProjects.get(sessionId);
    if (
      existing &&
      (existing.projectId !== scope.projectId ||
        existing.workspaceFolderUri !== scope.workspaceFolderUri ||
        existing.rootPath !== scope.rootPath)
    ) {
      throw new Error(
        `Approval session '${sessionId}' cannot be rebound to another project.`,
      );
    }
    this.sessionProjects.set(sessionId, {
      projectId: scope.projectId,
      workspaceFolderUri: scope.workspaceFolderUri,
      rootPath: scope.rootPath,
    });
  }

  // --- MCP tool approvals (persisted, session-scoped) ---

  /** True if this tool (or its server) has been approved for this session. */
  isMcpApproved(sessionId: string, toolName: string): boolean {
    const server = parseMcpToolName(toolName)?.serverName ?? "";
    const session = this.getSession(sessionId);
    return (
      session.mcpToolApprovals.includes(toolName) ||
      session.mcpServerApprovals.includes(server)
    );
  }

  /** Approve a single tool for the rest of this session. */
  approveMcpTool(sessionId: string, toolName: string): void {
    this.touchSession(sessionId);
    const session = this.sessions.get(sessionId)!;
    if (session.mcpToolApprovals.includes(toolName)) return;
    session.mcpToolApprovals.push(toolName);
    session.lastActivity = Date.now();
    this.persistSessions();
    this._onDidChange.fire();
  }

  /** Approve all tools from a server for the rest of this session. */
  approveMcpServer(sessionId: string, serverName: string): void {
    this.touchSession(sessionId);
    const session = this.sessions.get(sessionId)!;
    if (session.mcpServerApprovals.includes(serverName)) return;
    session.mcpServerApprovals.push(serverName);
    session.lastActivity = Date.now();
    this.persistSessions();
    this._onDidChange.fire();
  }

  dispose(): void {
    clearInterval(this.pruneTimer);
    this.configStoreListener.dispose();
    this._onDidChange.dispose();
  }

  // --- Migration from globalState to config files ---

  async migrateFromGlobalState(): Promise<void> {
    if (this.globalState.get<boolean>("configMigrated")) return;

    const oldCommands = this.globalState.get<CommandRule[]>(
      "globalCommandRules",
      [],
    );
    const oldWriteApproved = this.globalState.get<boolean>(
      "globalWriteApproved",
      false,
    );
    const oldPathRules = this.globalState.get<PathRule[]>(
      "globalPathRules",
      [],
    );
    const oldWriteRules = this.globalState.get<PathRule[]>(
      "globalWriteRules",
      [],
    );

    const hasData =
      oldCommands.length > 0 ||
      oldWriteApproved ||
      oldPathRules.length > 0 ||
      oldWriteRules.length > 0;

    if (hasData) {
      const migrated = this.configStore.updateGlobalConfig((config) => {
        config.writeApproved = config.writeApproved || oldWriteApproved;
        config.commandRules = deduplicateRules([
          ...(config.commandRules ?? []),
          ...oldCommands,
        ]);
        config.pathRules = deduplicateRules([
          ...(config.pathRules ?? []),
          ...oldPathRules,
        ]);
        config.writeRules = deduplicateRules([
          ...(config.writeRules ?? []),
          ...oldWriteRules,
        ]);
      });

      if (!migrated) return; // Don't mark as done if config write failed

      // Clear old globalState keys
      await this.globalState.update("globalCommandRules", undefined);
      await this.globalState.update("globalWriteApproved", undefined);
      await this.globalState.update("globalPathRules", undefined);
      await this.globalState.update("globalWriteRules", undefined);
    }

    await this.globalState.update("configMigrated", true);
  }

  // --- Session management ---

  touchSession(sessionId: string): void {
    const now = Date.now();
    let session = this.sessions.get(sessionId);
    const expired = Boolean(
      session && now - session.lastActivity > SESSION_TTL,
    );
    if (expired) {
      session = undefined;
    }
    session ??= this.newSession();
    session.lastActivity = now;
    this.sessions.set(sessionId, session);
    this.persistSessions();
    if (expired) this._onDidChange.fire();
  }

  clearSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.sessionProjects.delete(sessionId);
    this.persistSessions();
  }

  pruneExpiredSessions(): void {
    const now = Date.now();
    let changed = false;
    for (const [id, session] of this.sessions) {
      // Another VS Code window may own other persisted session IDs. Only the
      // window that has bound a session to a project may expire its authority.
      if (!this.sessionProjects.has(id)) continue;
      if (now - session.lastActivity > SESSION_TTL) {
        this.sessions.delete(id);
        this.sessionProjects.delete(id);
        changed = true;
      }
    }
    if (changed) {
      this.persistSessions();
      this._onDidChange.fire();
    }
  }

  // --- Write approval (MCP / sidebar path) ---

  isWriteApproved(sessionId: string, filePath?: string): boolean {
    // Global blanket approval
    if (this.configStore.getGlobalConfig().writeApproved) {
      return true;
    }
    // Project blanket approval follows the target file's owning workspace root.
    const projectConfig = this.getProjectConfig(sessionId, filePath);
    if (projectConfig?.writeApproved) {
      return true;
    }
    // Session blanket approval
    const session = this.getSession(sessionId);
    if (session.writeApproved) {
      return true;
    }
    // File-level checks (only when filePath provided)
    if (filePath) {
      return this.isFileWriteApproved(sessionId, filePath);
    }
    return false;
  }

  setWriteApproval(sessionId: string, scope: RuleScope): void {
    if (scope === "global") {
      this.configStore.updateGlobalConfig((c) => {
        c.writeApproved = true;
      });
    } else if (scope === "project") {
      const projectRoot = this.getProjectRoot(sessionId);
      if (!projectRoot) return;
      this.configStore.updateProjectConfig(projectRoot, (c) => {
        c.writeApproved = true;
      });
    } else {
      const session = this.sessions.get(sessionId) ?? this.newSession();
      session.writeApproved = true;
      session.lastActivity = Date.now();
      this.sessions.set(sessionId, session);
      this.persistSessions();
    }
    this._onDidChange.fire();
  }

  resetWriteApproval(): void {
    this.configStore.updateGlobalConfig((c) => {
      c.writeApproved = false;
    });
    // Also reset project-level
    for (const projectRoot of this.configStore.getProjectRoots()) {
      const config = this.configStore.getProjectConfig(projectRoot);
      if (config.writeApproved) {
        this.configStore.updateProjectConfig(projectRoot, (c) => {
          c.writeApproved = false;
        });
      }
    }
    // Also clear all session write approvals
    for (const session of this.sessions.values()) {
      session.writeApproved = false;
    }
    this.persistSessions();
    this._onDidChange.fire();
  }

  getWriteApprovalState(
    sessionId: string,
  ): "prompt" | "session" | "project" | "global" {
    if (this.configStore.getGlobalConfig().writeApproved) {
      return "global";
    }
    const projectConfig = this.getProjectConfig(sessionId);
    if (projectConfig?.writeApproved) {
      return "project";
    }
    const session = this.getSession(sessionId);
    if (session.writeApproved) {
      return "session";
    }
    return "prompt";
  }

  // --- Agent write approval (independent from MCP/sidebar path) ---

  isAgentWriteApproved(sessionId: string, filePath?: string): boolean {
    return this.getAgentWriteAuthorization(sessionId, filePath).allowed;
  }

  getAgentWriteAuthorization(
    sessionId: string,
    filePath?: string,
  ): WriteAuthorizationDecision {
    // Global blanket approval
    if (this.configStore.getGlobalConfig().agentWriteApproved) {
      return {
        allowed: true,
        basis: "blanket_approval",
        scope: "global",
      };
    }
    // Project blanket approval follows the target file's owning workspace root.
    const projectConfig = this.getProjectConfig(sessionId, filePath);
    if (projectConfig?.agentWriteApproved) {
      return {
        allowed: true,
        basis: "blanket_approval",
        scope: "project",
      };
    }
    // Session blanket approval
    const session = this.getSession(sessionId);
    if (session.agentWriteApproved) {
      return {
        allowed: true,
        basis: "blanket_approval",
        scope: "session",
      };
    }
    // File-level checks (only when filePath provided)
    if (filePath) {
      return this.getFileWriteAuthorization(sessionId, filePath);
    }
    return { allowed: false, basis: "none" };
  }

  setAgentWriteApproval(
    sessionId: string,
    scope: RuleScope,
    targetPath?: string,
  ): boolean {
    let saved = true;
    if (scope === "global") {
      saved = this.configStore.updateGlobalConfig((c) => {
        c.agentWriteApproved = true;
      });
    } else if (scope === "project") {
      const projectRoot = this.getProjectRoot(sessionId, targetPath);
      if (!projectRoot) return false;
      saved = this.configStore.updateProjectConfig(projectRoot, (c) => {
        c.agentWriteApproved = true;
      });
    } else {
      const session = this.sessions.get(sessionId) ?? this.newSession();
      session.agentWriteApproved = true;
      session.lastActivity = Date.now();
      this.sessions.set(sessionId, session);
      this.persistSessions();
    }
    if (saved) this._onDidChange.fire();
    return saved;
  }

  /**
   * Migrate all session-level approval state from one ID to another.
   * Used when a session is created after approval state was stored under
   * a placeholder ID (e.g. "agent").
   */
  migrateSessionState(fromId: string, toId: string): void {
    if (fromId === toId) return;

    const source = this.sessions.get(fromId);
    if (!source) return;

    const sourceProject = this.sessionProjects.get(fromId);
    const destinationProject = this.sessionProjects.get(toId);
    if (
      sourceProject &&
      destinationProject &&
      (destinationProject.projectId !== sourceProject.projectId ||
        destinationProject.workspaceFolderUri !==
          sourceProject.workspaceFolderUri ||
        destinationProject.rootPath !== sourceProject.rootPath)
    ) {
      throw new Error(
        `Approval session '${toId}' is already bound to another project.`,
      );
    }

    const destination = this.sessions.get(toId);
    if (destination) {
      destination.writeApproved ||= source.writeApproved;
      destination.agentWriteApproved ||= source.agentWriteApproved;
      destination.commandRules = deduplicateRules([
        ...destination.commandRules,
        ...source.commandRules,
      ]);
      destination.networkRules = deduplicateRules([
        ...(destination.networkRules ?? []),
        ...(source.networkRules ?? []),
      ]);
      destination.pathRules = deduplicateRules([
        ...(destination.pathRules ?? []),
        ...(source.pathRules ?? []),
      ]);
      destination.writeRules = deduplicateRules([
        ...(destination.writeRules ?? []),
        ...(source.writeRules ?? []),
      ]);
      destination.mcpToolApprovals = [
        ...new Set([
          ...destination.mcpToolApprovals,
          ...source.mcpToolApprovals,
        ]),
      ];
      destination.mcpServerApprovals = [
        ...new Set([
          ...destination.mcpServerApprovals,
          ...source.mcpServerApprovals,
        ]),
      ];
      destination.lastActivity = Math.max(
        destination.lastActivity,
        source.lastActivity,
        Date.now(),
      );
    } else {
      this.sessions.set(toId, {
        ...this.cloneSessionState(source),
        lastActivity: Date.now(),
      });
    }

    if (sourceProject) {
      this.sessionProjects.set(toId, sourceProject);
      this.sessionProjects.delete(fromId);
    }
    this.sessions.delete(fromId);
    this.persistSessions();
    this._onDidChange.fire();
  }

  /**
   * Add a same-project parent's session authority to a shared-process child.
   * Later calls are additive: child-only authority is retained and parent
   * revocations do not flow into an already-running child.
   */
  inheritSessionState(fromId: string, toId: string): boolean {
    if (fromId === toId) return false;

    const sourceProject = this.sessionProjects.get(fromId);
    const destinationProject = this.sessionProjects.get(toId);
    if (!sourceProject || !destinationProject) {
      throw new Error(
        "Approval inheritance requires both sessions to be project-bound.",
      );
    }
    if (
      sourceProject.projectId !== destinationProject.projectId ||
      sourceProject.workspaceFolderUri !==
        destinationProject.workspaceFolderUri ||
      sourceProject.rootPath !== destinationProject.rootPath
    ) {
      throw new Error(
        "Approval session cannot inherit authority from another project.",
      );
    }

    const now = Date.now();
    const restoredSource = this.sessions.get(fromId);
    if (restoredSource && now - restoredSource.lastActivity > SESSION_TTL) {
      this.sessions.delete(fromId);
      this.persistSessions();
      this._onDidChange.fire();
    }

    const source = this.sessions.get(fromId);
    const destination = this.sessions.get(toId);
    let changed = false;
    let sessionChanged = false;

    if (source) {
      const commandRules = mergeInheritedRules(
        destination?.commandRules ?? [],
        source.commandRules,
      );
      const networkRules = mergeInheritedRules(
        destination?.networkRules ?? [],
        source.networkRules,
      );
      const pathRules = mergeInheritedRules(
        destination?.pathRules ?? [],
        source.pathRules,
      );
      const writeRules = mergeInheritedRules(
        destination?.writeRules ?? [],
        source.writeRules,
      );
      const mcpToolApprovals = [
        ...new Set([
          ...(destination?.mcpToolApprovals ?? []),
          ...source.mcpToolApprovals,
        ]),
      ];
      const mcpServerApprovals = [
        ...new Set([
          ...(destination?.mcpServerApprovals ?? []),
          ...source.mcpServerApprovals,
        ]),
      ];
      sessionChanged =
        (!(destination?.writeApproved ?? false) && source.writeApproved) ||
        (!(destination?.agentWriteApproved ?? false) &&
          source.agentWriteApproved) ||
        !rulesEqual(commandRules, destination?.commandRules ?? []) ||
        !rulesEqual(networkRules, destination?.networkRules ?? []) ||
        !rulesEqual(pathRules, destination?.pathRules ?? []) ||
        !rulesEqual(writeRules, destination?.writeRules ?? []) ||
        !stringSetsEqual(
          mcpToolApprovals,
          destination?.mcpToolApprovals ?? [],
        ) ||
        !stringSetsEqual(
          mcpServerApprovals,
          destination?.mcpServerApprovals ?? [],
        );

      if (sessionChanged) {
        this.sessions.set(toId, {
          writeApproved:
            (destination?.writeApproved ?? false) || source.writeApproved,
          agentWriteApproved:
            (destination?.agentWriteApproved ?? false) ||
            source.agentWriteApproved,
          commandRules,
          networkRules,
          pathRules,
          writeRules,
          mcpToolApprovals,
          mcpServerApprovals,
          lastActivity: now,
        });
        changed = true;
      }
    }
    if (sessionChanged) this.persistSessions();
    if (changed) this._onDidChange.fire();
    return changed;
  }

  /** Reset session-level agent write approval for a single session (e.g. on mode switch). */
  resetSessionAgentWriteApproval(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session?.agentWriteApproved) {
      session.agentWriteApproved = false;
      this.persistSessions();
      this._onDidChange.fire();
    }
  }

  resetAgentWriteApproval(): void {
    this.configStore.updateGlobalConfig((c) => {
      c.agentWriteApproved = false;
    });
    for (const projectRoot of this.configStore.getProjectRoots()) {
      const config = this.configStore.getProjectConfig(projectRoot);
      if (config.agentWriteApproved) {
        this.configStore.updateProjectConfig(projectRoot, (c) => {
          c.agentWriteApproved = false;
        });
      }
    }
    for (const session of this.sessions.values()) {
      session.agentWriteApproved = false;
    }
    this.persistSessions();
    this._onDidChange.fire();
  }

  /**
   * Replace the effective agent-write scope for one foreground session without
   * clearing unrelated session or project approvals owned by other windows.
   */
  setAgentWriteApprovalSelection(
    sessionId: string,
    selection: "prompt" | RuleScope,
    targetPath?: string,
  ): boolean {
    const projectRoot = this.getProjectRoot(sessionId, targetPath);
    if (selection === "project" && !projectRoot) return false;

    // Establish the requested authority before clearing any broader/narrower
    // scope, so a config write failure cannot turn a valid grant into prompt.
    if (
      selection === "global" &&
      !this.configStore.getGlobalConfig().agentWriteApproved &&
      !this.configStore.updateGlobalConfig((config) => {
        config.agentWriteApproved = true;
      })
    ) {
      return false;
    }
    if (
      selection === "project" &&
      projectRoot &&
      !this.configStore.getProjectConfig(projectRoot).agentWriteApproved &&
      !this.configStore.updateProjectConfig(projectRoot, (config) => {
        config.agentWriteApproved = true;
      })
    ) {
      return false;
    }

    let localChanged = false;
    if (selection === "session") {
      const session = this.sessions.get(sessionId) ?? this.newSession();
      if (!session.agentWriteApproved) localChanged = true;
      session.agentWriteApproved = true;
      session.lastActivity = Date.now();
      this.sessions.set(sessionId, session);
      this.persistSessions();
    }

    let success = true;
    if (
      selection !== "global" &&
      this.configStore.getGlobalConfig().agentWriteApproved
    ) {
      success =
        this.configStore.updateGlobalConfig((config) => {
          config.agentWriteApproved = false;
        }) && success;
    }

    if (
      selection !== "project" &&
      projectRoot &&
      this.configStore.getProjectConfig(projectRoot).agentWriteApproved
    ) {
      success =
        this.configStore.updateProjectConfig(projectRoot, (config) => {
          config.agentWriteApproved = false;
        }) && success;
    }

    const session = this.sessions.get(sessionId);
    if (selection !== "session" && session?.agentWriteApproved) {
      session.agentWriteApproved = false;
      session.lastActivity = Date.now();
      this.persistSessions();
      localChanged = true;
    }

    if (localChanged || selection === "prompt") this._onDidChange.fire();
    return success;
  }

  getAgentWriteApprovalState(
    sessionId: string,
  ): "prompt" | "session" | "project" | "global" {
    if (this.configStore.getGlobalConfig().agentWriteApproved) {
      return "global";
    }
    const projectConfig = this.getProjectConfig(sessionId);
    if (projectConfig?.agentWriteApproved) {
      return "project";
    }
    const session = this.getSession(sessionId);
    if (session.agentWriteApproved) {
      return "session";
    }
    return "prompt";
  }

  getAgentWriteApprovalDiagnostics(
    sessionId: string,
    filePath?: string,
  ): AgentWriteApprovalDiagnostics {
    const globalConfig = this.configStore.getGlobalConfig();
    const projectConfig = this.getProjectConfig(sessionId, filePath);
    const globalBlanketApproved = Boolean(globalConfig.agentWriteApproved);
    const projectBlanketApproved = Boolean(projectConfig?.agentWriteApproved);
    const session = this.sessions.get(sessionId);
    const rules = this.getWriteRules(sessionId, filePath);
    return {
      effectiveScope: globalBlanketApproved
        ? "global"
        : projectBlanketApproved
          ? "project"
          : session?.agentWriteApproved
            ? "session"
            : "prompt",
      globalBlanketApproved,
      projectBlanketApproved,
      sessionBlanketApproved: Boolean(session?.agentWriteApproved),
      legacyGlobalBlanketApproved: Boolean(globalConfig.writeApproved),
      legacyProjectBlanketApproved: Boolean(projectConfig?.writeApproved),
      legacySessionBlanketApproved: Boolean(session?.writeApproved),
      sessionProjectBound: this.sessionProjects.has(sessionId),
      sessionStatePresent: Boolean(session),
      ...(session
        ? { sessionStateAgeMs: Math.max(0, Date.now() - session.lastActivity) }
        : {}),
      writeRuleCounts: {
        session: rules.session.length,
        project: rules.project.length,
        global: rules.global.length,
        settings: rules.settings.length,
      },
    };
  }

  // --- Path trust (outside-workspace access) ---

  isPathTrusted(sessionId: string, filePath: string): boolean {
    const rulesByScope = this.pathRuleStore.get(
      sessionId,
      this.getProjectRoot(sessionId),
    );
    return (["session", "project", "global"] as const).some((scope) =>
      rulesByScope[scope].some((rule) => this.matchesPathRule(filePath, rule)),
    );
  }

  addPathRule(sessionId: string, rule: PathRule, scope: RuleScope): boolean {
    const added = this.pathRuleStore.add(
      sessionId,
      rule,
      scope,
      this.getProjectRoot(sessionId),
    );
    if (added) this._onDidChange.fire();
    return added;
  }

  removePathRule(pattern: string, scope: RuleScope, sessionId?: string): void {
    if (
      this.pathRuleStore.remove(
        pattern,
        scope,
        sessionId,
        this.getProjectRoot(sessionId),
      )
    ) {
      this._onDidChange.fire();
    }
  }

  editPathRule(
    oldPattern: string,
    newRule: PathRule,
    scope: RuleScope,
    sessionId?: string,
  ): void {
    if (
      this.pathRuleStore.edit(
        oldPattern,
        newRule,
        scope,
        sessionId,
        this.getProjectRoot(sessionId),
      )
    ) {
      this._onDidChange.fire();
    }
  }

  getPathRules(sessionId: string): {
    session: PathRule[];
    project: PathRule[];
    global: PathRule[];
  } {
    return this.pathRuleStore.get(sessionId, this.getProjectRoot(sessionId));
  }

  // --- File-level write approval ---

  isFileWriteApproved(sessionId: string, filePath: string): boolean {
    return this.getFileWriteAuthorization(sessionId, filePath).allowed;
  }

  getFileWriteAuthorization(
    sessionId: string,
    filePath: string,
  ): WriteAuthorizationDecision {
    const projectBinding = this.getProjectBinding(sessionId, filePath);
    const relPath = projectBinding
      ? this.getProjectRelativePath(projectBinding.rootPath, filePath)
      : filePath;
    const candidates = relPath !== filePath ? [relPath, filePath] : [filePath];

    // Settings-based patterns (match against both relative and absolute)
    const settingsPatterns = this.getProjectConfiguration(projectBinding).get<
      string[]
    >("writeRules", []);
    for (const pattern of settingsPatterns) {
      const rule = { pattern, mode: "glob" as const };
      if (
        candidates.some((candidate) => this.matchesPathRule(candidate, rule))
      ) {
        return {
          allowed: true,
          basis: "settings_rule",
          scope: "workspace_setting",
          rule,
        };
      }
    }

    const rulesByScope = this.writeRuleStore.get(
      sessionId,
      projectBinding?.rootPath,
    );
    for (const scope of ["session", "project", "global"] as const) {
      for (const rule of rulesByScope[scope]) {
        if (
          candidates.some((candidate) => this.matchesPathRule(candidate, rule))
        ) {
          return {
            allowed: true,
            basis: "write_rule",
            scope,
            rule: { ...rule },
          };
        }
      }
    }
    return { allowed: false, basis: "none" };
  }

  addWriteRule(
    sessionId: string,
    rule: PathRule,
    scope: RuleScope,
    targetPath?: string,
  ): boolean {
    const added = this.writeRuleStore.add(
      sessionId,
      rule,
      scope,
      this.getProjectRoot(sessionId, targetPath),
    );
    if (added) this._onDidChange.fire();
    return added;
  }

  removeWriteRule(pattern: string, scope: RuleScope, sessionId?: string): void {
    if (
      this.writeRuleStore.remove(
        pattern,
        scope,
        sessionId,
        this.getProjectRoot(sessionId),
      )
    ) {
      this._onDidChange.fire();
    }
  }

  editWriteRule(
    oldPattern: string,
    newRule: PathRule,
    scope: RuleScope,
    sessionId?: string,
  ): void {
    if (
      this.writeRuleStore.edit(
        oldPattern,
        newRule,
        scope,
        sessionId,
        this.getProjectRoot(sessionId),
      )
    ) {
      this._onDidChange.fire();
    }
  }

  getWriteRules(
    sessionId: string,
    targetPath?: string,
  ): {
    session: PathRule[];
    project: PathRule[];
    global: PathRule[];
    settings: string[];
  } {
    const projectBinding = this.getProjectBinding(sessionId, targetPath);
    return {
      ...this.writeRuleStore.get(sessionId, projectBinding?.rootPath),
      settings: this.getProjectConfiguration(projectBinding).get<string[]>(
        "writeRules",
        [],
      ),
    };
  }

  // --- Command approval ---

  isCommandApproved(sessionId: string, command: string, cwd?: string): boolean {
    return this.evaluateCommandRules(sessionId, command, cwd)
      .allSegmentsApprovedByRule;
  }

  evaluateCommandRules(
    sessionId: string,
    command: string,
    cwd?: string,
  ): CommandRulePolicyEvaluation {
    return evaluateCommandRulePolicy(
      this.commandRuleStore.get(sessionId, this.getProjectRoot(sessionId, cwd)),
      command,
    );
  }

  /** Returns the most restrictive matching rule, preserving scope/insertion order for ties. */
  findMatchingCommandRule(
    sessionId: string,
    command: string,
    cwd?: string,
  ): MatchedCommandRule | null {
    const evaluation = this.evaluateCommandRules(sessionId, command, cwd);
    const matchingSegment = evaluation.segments.find(
      (segment) => segment.decision === evaluation.decision,
    );
    return (
      matchingSegment?.matches.find(
        ({ rule }) => (rule.decision ?? "legacy_allow") === evaluation.decision,
      ) ?? null
    );
  }

  evaluateNetworkRules(
    sessionId: string,
    destination: NetworkRuleDestination,
  ): NetworkRulePolicyEvaluation {
    return evaluateNetworkRulePolicy(
      this.networkRuleStore.get(sessionId, this.getProjectRoot(sessionId)),
      destination,
    );
  }

  addNetworkRule(
    sessionId: string,
    rule: NetworkRule,
    scope: RuleScope,
  ): boolean {
    const added = this.networkRuleStore.add(
      sessionId,
      rule,
      scope,
      this.getProjectRoot(sessionId),
    );
    if (added) this._onDidChange.fire();
    return added;
  }

  getNetworkRules(sessionId: string): {
    session: NetworkRule[];
    project: NetworkRule[];
    global: NetworkRule[];
  } {
    return this.networkRuleStore.get(sessionId, this.getProjectRoot(sessionId));
  }

  addCommandRule(
    sessionId: string,
    rule: CommandRule,
    scope: RuleScope,
    cwd?: string,
  ): boolean {
    const added = this.commandRuleStore.add(
      sessionId,
      rule,
      scope,
      this.getProjectRoot(sessionId, cwd),
    );
    if (added) this._onDidChange.fire();
    return added;
  }

  editCommandRule(
    oldPattern: string,
    newRule: CommandRule,
    scope: RuleScope,
    sessionId?: string,
    oldRule?: Pick<CommandRule, "mode" | "decision">,
  ): void {
    if (
      this.commandRuleStore.edit(
        oldPattern,
        newRule,
        scope,
        sessionId,
        this.getProjectRoot(sessionId),
        oldRule ? { pattern: oldPattern, ...oldRule } : undefined,
      )
    ) {
      this._onDidChange.fire();
    }
  }

  removeCommandRule(
    pattern: string,
    scope: RuleScope,
    sessionId?: string,
    rule?: Pick<CommandRule, "mode" | "decision">,
  ): void {
    if (
      this.commandRuleStore.remove(
        pattern,
        scope,
        sessionId,
        this.getProjectRoot(sessionId),
        rule ? { pattern, ...rule } : undefined,
      )
    ) {
      this._onDidChange.fire();
    }
  }

  getCommandRules(sessionId: string): {
    session: CommandRule[];
    project: CommandRule[];
    global: CommandRule[];
  } {
    return this.commandRuleStore.get(sessionId, this.getProjectRoot(sessionId));
  }

  clearSessionCommandRules(sessionId: string): void {
    this.commandRuleStore.clearSession(sessionId);
    this._onDidChange.fire();
  }

  // --- State for sidebar ---

  getActiveSessions(): Array<{
    id: string;
    writeApproved: boolean;
    agentWriteApproved: boolean;
    commandRuleCount: number;
    pathRuleCount: number;
    writeRuleCount: number;
    lastActivity: number;
  }> {
    return Array.from(this.sessions.entries()).map(([id, s]) => ({
      id,
      writeApproved: s.writeApproved,
      agentWriteApproved: s.agentWriteApproved,
      commandRuleCount: s.commandRules.length,
      networkRuleCount: (s.networkRules ?? []).length,
      pathRuleCount: (s.pathRules ?? []).length,
      writeRuleCount: (s.writeRules ?? []).length,
      lastActivity: s.lastActivity,
    }));
  }

  // --- Internal ---

  private getProjectBinding(
    sessionId: string | undefined,
    targetPath?: string,
  ): SessionProjectBinding | undefined {
    if (targetPath && path.isAbsolute(targetPath)) {
      const resolvedTarget = path.resolve(targetPath);
      const folder = (vscode.workspace.workspaceFolders ?? [])
        .filter((candidate) => {
          const root = path.resolve(candidate.uri.fsPath);
          const relative = path.relative(root, resolvedTarget);
          return (
            relative === "" ||
            (!relative.startsWith(`..${path.sep}`) &&
              relative !== ".." &&
              !path.isAbsolute(relative))
          );
        })
        .sort(
          (left, right) => right.uri.fsPath.length - left.uri.fsPath.length,
        )[0];
      if (folder) {
        const rootPath = path.resolve(folder.uri.fsPath);
        const workspaceFolderUri = folder.uri.toString();
        return {
          projectId: createWorkspaceProjectId(workspaceFolderUri),
          workspaceFolderUri,
          rootPath,
        };
      }
    }
    if (sessionId) {
      const binding = this.sessionProjects.get(sessionId);
      if (binding) return binding;
    }
    const roots = this.configStore.getProjectRoots();
    if (roots.length !== 1) return undefined;
    const rootPath = roots[0];
    return {
      projectId: "single-project-compatibility",
      workspaceFolderUri: vscode.Uri.file(rootPath).toString(),
      rootPath,
    };
  }

  private getProjectRoot(
    sessionId: string | undefined,
    targetPath?: string,
  ): string | undefined {
    return this.getProjectBinding(sessionId, targetPath)?.rootPath;
  }

  private getProjectConfig(
    sessionId: string,
    targetPath?: string,
  ): Readonly<import("./ConfigStore.js").AgentLinkConfig> | undefined {
    const projectRoot = this.getProjectRoot(sessionId, targetPath);
    return projectRoot
      ? this.configStore.getProjectConfig(projectRoot)
      : undefined;
  }

  private getProjectConfiguration(
    binding: SessionProjectBinding | undefined,
  ): vscode.WorkspaceConfiguration {
    const resource = binding
      ? vscode.Uri.parse(binding.workspaceFolderUri)
      : undefined;
    return vscode.workspace.getConfiguration("agentlink", resource);
  }

  private getProjectRelativePath(
    projectRoot: string,
    filePath: string,
  ): string {
    if (!path.isAbsolute(filePath)) return filePath.replace(/\\/g, "/");
    const relative = path.relative(projectRoot, filePath);
    if (
      relative === "" ||
      (!relative.startsWith(`..${path.sep}`) &&
        relative !== ".." &&
        !path.isAbsolute(relative))
    ) {
      return relative.replace(/\\/g, "/");
    }
    return filePath;
  }

  private matchesPathRule(filePath: string, rule: PathRule): boolean {
    try {
      const normalizedPath = this.normalizeRulePath(filePath);
      const normalizedPattern = this.normalizeRulePath(rule.pattern);

      switch (rule.mode) {
        case "exact":
          return normalizedPath === normalizedPattern;
        case "prefix":
          return this.matchesPrefixPath(normalizedPath, normalizedPattern);
        case "glob": {
          if (picomatch.isMatch(normalizedPath, normalizedPattern)) {
            return true;
          }
          const directoryGlob = this.toDirectoryGlob(normalizedPattern);
          return (
            directoryGlob !== undefined &&
            picomatch.isMatch(normalizedPath, directoryGlob)
          );
        }
      }
    } catch {
      return false;
    }
  }

  private normalizeRulePath(value: string): string {
    return value.replace(/\\/g, "/");
  }

  private toDirectoryPrefix(pattern: string): string | undefined {
    if (!pattern || pattern.endsWith("/")) {
      return undefined;
    }
    if (this.hasGlobSyntax(pattern)) {
      return undefined;
    }
    return `${pattern}/`;
  }

  private toDirectoryGlob(pattern: string): string | undefined {
    if (!pattern || pattern.endsWith("/")) {
      return undefined;
    }
    if (pattern.endsWith("/**")) {
      return undefined;
    }
    if (this.hasGlobSyntax(pattern)) {
      return undefined;
    }
    return `${pattern}/**`;
  }

  private matchesPrefixPath(filePath: string, pattern: string): boolean {
    const normalizedPattern = pattern.endsWith("/")
      ? pattern.slice(0, -1)
      : pattern;
    return (
      filePath === normalizedPattern ||
      filePath.startsWith(`${normalizedPattern}/`)
    );
  }

  private hasGlobSyntax(pattern: string): boolean {
    return (
      pattern.includes("*") ||
      pattern.includes("?") ||
      pattern.includes("[") ||
      pattern.includes("{") ||
      pattern.includes("(") ||
      pattern.includes("!")
    );
  }

  /** Get session state for reading. Returns an empty session if none exists (no side effect). */
  private getSession(sessionId: string): Readonly<SessionState> {
    return this.sessions.get(sessionId) ?? this.emptySession;
  }

  private loadPersistedSessions(): void {
    for (const key of this.globalState.keys()) {
      if (!key.startsWith(APPROVAL_SESSION_KEY_PREFIX)) continue;
      const sessionId = key.slice(APPROVAL_SESSION_KEY_PREFIX.length);
      const session = this.globalState.get<SessionState | undefined>(key);
      if (!sessionId || !session) continue;
      const normalized = this.normalizeSessionState(session);
      this.sessions.set(sessionId, normalized);
      this.persistedSessionSnapshots.set(sessionId, JSON.stringify(normalized));
    }

    const storageVersion = this.globalState.get<number>(
      APPROVAL_SESSION_STORAGE_VERSION_KEY,
      1,
    );
    if (storageVersion < APPROVAL_SESSION_STORAGE_VERSION) {
      const legacy = this.globalState.get<
        PersistedApprovalSessions | SessionState[] | undefined
      >(APPROVAL_SESSIONS_KEY);
      if (
        legacy &&
        !Array.isArray(legacy) &&
        legacy.version === 1 &&
        legacy.sessions
      ) {
        for (const [sessionId, session] of Object.entries(legacy.sessions)) {
          if (!this.sessions.has(sessionId)) {
            this.sessions.set(sessionId, this.normalizeSessionState(session));
          }
        }
      }

      const migrationSessionIds = Array.from(this.sessions.keys());
      const migrationWrites = migrationSessionIds.map((sessionId) =>
        this.queueSessionPersistence(sessionId, this.sessions.get(sessionId)),
      );
      void this.finishSessionStorageMigration(
        migrationSessionIds,
        migrationWrites,
      );
    }
  }

  private persistSessions(): void {
    for (const [sessionId, session] of this.sessions) {
      this.queueSessionPersistence(sessionId, session);
    }

    const knownSessionIds = new Set([
      ...this.persistedSessionSnapshots.keys(),
      ...this.pendingSessionPersistence.keys(),
    ]);
    for (const sessionId of knownSessionIds) {
      if (this.sessions.has(sessionId)) continue;
      this.queueSessionPersistence(sessionId);
    }
  }

  private queueSessionPersistence(
    sessionId: string,
    value?: SessionState,
  ): Promise<void> {
    const snapshot = value ? JSON.stringify(value) : undefined;
    const pending = this.pendingSessionPersistence.get(sessionId);
    if (pending?.snapshot === snapshot) {
      return this.startSessionPersistence(sessionId);
    }
    if (
      !this.activeSessionPersistence.has(sessionId) &&
      this.persistedSessionSnapshots.get(sessionId) === snapshot
    ) {
      this.pendingSessionPersistence.delete(sessionId);
      return Promise.resolve();
    }

    this.pendingSessionPersistence.set(sessionId, {
      snapshot,
      baseSnapshot:
        pending?.baseSnapshot ?? this.persistedSessionSnapshots.get(sessionId),
      ...(value ? { value: this.cloneSessionState(value) } : {}),
    });
    return this.startSessionPersistence(sessionId);
  }

  private startSessionPersistence(sessionId: string): Promise<void> {
    const active = this.activeSessionPersistence.get(sessionId);
    if (active) return active;

    let failedEntry: PendingSessionPersistence | undefined;
    const task = (async () => {
      while (true) {
        const entry = this.pendingSessionPersistence.get(sessionId);
        if (!entry) return;

        if (this.persistedSessionSnapshots.get(sessionId) === entry.snapshot) {
          if (this.pendingSessionPersistence.get(sessionId) === entry) {
            this.pendingSessionPersistence.delete(sessionId);
          }
          continue;
        }

        let committedValue = entry.value;
        if (entry.value) {
          const remote = this.globalState.get<SessionState | undefined>(
            `${APPROVAL_SESSION_KEY_PREFIX}${sessionId}`,
          );
          if (remote) {
            committedValue = mergeConcurrentSessionState(
              entry.baseSnapshot
                ? (JSON.parse(entry.baseSnapshot) as SessionState)
                : undefined,
              entry.value,
              this.normalizeSessionState(remote),
            );
          }
        }
        const committedSnapshot = committedValue
          ? JSON.stringify(committedValue)
          : undefined;
        try {
          await this.globalState.update(
            `${APPROVAL_SESSION_KEY_PREFIX}${sessionId}`,
            committedValue ? this.cloneSessionState(committedValue) : undefined,
          );
        } catch {
          // Keep the latest entry queued so the next session mutation or touch
          // retries it. The successful-snapshot cache must only advance after
          // Memento confirms the write.
          failedEntry = entry;
          return;
        }

        if (committedSnapshot === undefined) {
          this.persistedSessionSnapshots.delete(sessionId);
        } else {
          this.persistedSessionSnapshots.set(sessionId, committedSnapshot);
          const local = this.sessions.get(sessionId);
          if (local && JSON.stringify(local) === entry.snapshot) {
            this.sessions.set(
              sessionId,
              this.cloneSessionState(committedValue!),
            );
          }
        }
        if (this.pendingSessionPersistence.get(sessionId) === entry) {
          this.pendingSessionPersistence.delete(sessionId);
        }
      }
    })();

    const trackedTask = task.finally(() => {
      this.activeSessionPersistence.delete(sessionId);
      const pending = this.pendingSessionPersistence.get(sessionId);
      if (pending && pending !== failedEntry) {
        void this.startSessionPersistence(sessionId);
      }
    });
    this.activeSessionPersistence.set(sessionId, trackedTask);
    return trackedTask;
  }

  private async finishSessionStorageMigration(
    sessionIds: string[],
    migrationWrites: Promise<void>[],
  ): Promise<void> {
    await Promise.all(migrationWrites);
    const persisted = sessionIds.every((sessionId) => {
      const session = this.sessions.get(sessionId);
      return (
        !this.pendingSessionPersistence.has(sessionId) &&
        (!session ||
          this.persistedSessionSnapshots.get(sessionId) ===
            JSON.stringify(session))
      );
    });
    if (!persisted) return;

    try {
      await this.globalState.update(
        APPROVAL_SESSION_STORAGE_VERSION_KEY,
        APPROVAL_SESSION_STORAGE_VERSION,
      );
      await this.globalState.update(APPROVAL_SESSIONS_KEY, undefined);
    } catch {
      // Leave the legacy marker/data intact so startup can safely retry.
    }
  }

  private normalizeSessionState(session: SessionState): SessionState {
    return {
      writeApproved: !!session.writeApproved,
      agentWriteApproved: !!session.agentWriteApproved,
      commandRules: [...(session.commandRules ?? [])],
      networkRules: [...(session.networkRules ?? [])],
      pathRules: [...(session.pathRules ?? [])],
      writeRules: [...(session.writeRules ?? [])],
      mcpToolApprovals: [...(session.mcpToolApprovals ?? [])],
      mcpServerApprovals: [...(session.mcpServerApprovals ?? [])],
      lastActivity: session.lastActivity || Date.now(),
    };
  }

  private cloneSessionState(session: SessionState): SessionState {
    return {
      ...session,
      commandRules: session.commandRules.map((rule) => ({ ...rule })),
      networkRules: session.networkRules.map((rule) => ({ ...rule })),
      pathRules: session.pathRules.map((rule) => ({ ...rule })),
      writeRules: session.writeRules.map((rule) => ({ ...rule })),
      mcpToolApprovals: [...session.mcpToolApprovals],
      mcpServerApprovals: [...session.mcpServerApprovals],
    };
  }

  private readonly emptySession: Readonly<SessionState> = Object.freeze({
    writeApproved: false,
    agentWriteApproved: false,
    commandRules: [],
    networkRules: [],
    pathRules: [],
    writeRules: [],
    mcpToolApprovals: [],
    mcpServerApprovals: [],
    lastActivity: 0,
  });

  private newSession(): SessionState {
    return {
      writeApproved: false,
      agentWriteApproved: false,
      commandRules: [],
      networkRules: [],
      pathRules: [],
      writeRules: [],
      mcpToolApprovals: [],
      mcpServerApprovals: [],
      lastActivity: Date.now(),
    };
  }
}

function deduplicateRules<T extends { pattern: string; mode: string }>(
  rules: T[],
): T[] {
  const seen = new Set<string>();
  return rules.filter((r) => {
    const key = `${r.pattern}\0${r.mode}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

type InheritableRule = {
  pattern: string;
  mode: string;
  decision?: string;
};

function mergeInheritedRules<T extends InheritableRule>(
  destination: T[],
  source: T[],
): T[] {
  const merged = new Map<string, T>();
  for (const rule of destination) {
    merged.set(`${rule.pattern}\0${rule.mode}`, { ...rule });
  }
  for (const rule of source) {
    // The parent's current decision replaces the child's previously inherited
    // decision for the same rule. Child-only rules remain additive.
    merged.set(`${rule.pattern}\0${rule.mode}`, { ...rule });
  }
  return Array.from(merged.values());
}

function rulesEqual<T extends InheritableRule>(left: T[], right: T[]): boolean {
  return (
    left.length === right.length &&
    left.every((rule, index) => {
      const other = right[index];
      return (
        rule.pattern === other?.pattern &&
        rule.mode === other.mode &&
        rule.decision === other.decision
      );
    })
  );
}

function stringSetsEqual(left: string[], right: string[]): boolean {
  return (
    left.length === right.length && left.every((value) => right.includes(value))
  );
}

function mergeConcurrentSessionState(
  base: SessionState | undefined,
  local: SessionState,
  remote: SessionState,
): SessionState {
  const baseline: SessionState = base ?? {
    writeApproved: false,
    agentWriteApproved: false,
    commandRules: [],
    networkRules: [],
    pathRules: [],
    writeRules: [],
    mcpToolApprovals: [],
    mcpServerApprovals: [],
    lastActivity: 0,
  };
  return {
    writeApproved:
      local.writeApproved !== baseline.writeApproved
        ? local.writeApproved
        : remote.writeApproved,
    agentWriteApproved:
      local.agentWriteApproved !== baseline.agentWriteApproved
        ? local.agentWriteApproved
        : remote.agentWriteApproved,
    commandRules: mergeConcurrentRules(
      baseline.commandRules,
      local.commandRules,
      remote.commandRules,
    ),
    networkRules: mergeConcurrentRules(
      baseline.networkRules,
      local.networkRules,
      remote.networkRules,
    ),
    pathRules: mergeConcurrentRules(
      baseline.pathRules,
      local.pathRules,
      remote.pathRules,
    ),
    writeRules: mergeConcurrentRules(
      baseline.writeRules,
      local.writeRules,
      remote.writeRules,
    ),
    mcpToolApprovals: [
      ...new Set([...remote.mcpToolApprovals, ...local.mcpToolApprovals]),
    ],
    mcpServerApprovals: [
      ...new Set([...remote.mcpServerApprovals, ...local.mcpServerApprovals]),
    ],
    lastActivity: Math.max(local.lastActivity, remote.lastActivity),
  };
}

function mergeConcurrentRules<T extends InheritableRule>(
  base: T[],
  local: T[],
  remote: T[],
): T[] {
  const identity = (rule: T) => `${rule.pattern}\0${rule.mode}`;
  const baseByIdentity = new Map(base.map((rule) => [identity(rule), rule]));
  const localByIdentity = new Map(local.map((rule) => [identity(rule), rule]));
  const changedIdentities = new Set<string>();
  for (const key of new Set([
    ...baseByIdentity.keys(),
    ...localByIdentity.keys(),
  ])) {
    if (
      JSON.stringify(baseByIdentity.get(key)) !==
      JSON.stringify(localByIdentity.get(key))
    ) {
      changedIdentities.add(key);
    }
  }

  return [
    ...remote
      .filter((rule) => !changedIdentities.has(identity(rule)))
      .map((rule) => ({ ...rule })),
    ...local
      .filter((rule) => changedIdentities.has(identity(rule)))
      .map((rule) => ({ ...rule })),
  ];
}
