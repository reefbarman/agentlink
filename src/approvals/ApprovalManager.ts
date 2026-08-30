import * as path from "path";

import * as vscode from "vscode";
import picomatch from "picomatch";

import { parseMcpToolName } from "@agentlink/protocol/mcp-tool-identity";
import type { SessionProjectScope } from "@agentlink/protocol/workspace-project";
import { createWorkspaceProjectId } from "../core/workspaceProjects.js";
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
  /** Whether inherited rule provenance has been initialized for this session. */
  inheritanceInitialized: boolean;
  commandRules: CommandRule[];
  networkRules: NetworkRule[];
  pathRules: PathRule[];
  writeRules: PathRule[];
  builtInToolApprovals: string[];
  mcpToolApprovals: string[];
  mcpServerApprovals: string[];
  lastActivity: number;
}

interface SessionProjectBinding {
  projectId: string;
  workspaceFolderUri: string;
  rootPath: string;
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

const APPROVAL_SESSIONS_KEY = "approvalSessions";
const APPROVAL_SESSION_KEY_PREFIX = "approvalSession:";
const APPROVAL_SESSION_STORAGE_VERSION_KEY = "approvalSessionStorageVersion";
const APPROVAL_SESSION_CLEANUP_VERSION_KEY = "approvalSessionCleanupVersion";
const APPROVAL_SESSION_CLEANUP_VERSION = 1;

export class ApprovalManager {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  // Runtime-only session approvals, keyed by chat session ID.
  private sessions = new Map<string, SessionState>();
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
    const sessionHost = {
      get: (sessionId: string) => this.sessions.get(sessionId),
      create: (sessionId: string) => {
        const session = this.newSession();
        this.sessions.set(sessionId, session);
        return session;
      },
    };
    this.commandRuleStore = new CommandRuleStore(configStore, sessionHost);
    this.networkRuleStore = new NetworkRuleStore(configStore, sessionHost);
    this.pathRuleStore = new PathRuleStore(configStore, sessionHost);
    this.writeRuleStore = new WriteRuleStore(configStore, sessionHost);
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

  // --- Built-in tool approvals (runtime-only, session-scoped) ---

  isBuiltInToolApproved(sessionId: string, toolName: string): boolean {
    return this.getSession(sessionId).builtInToolApprovals.includes(toolName);
  }

  approveBuiltInTool(sessionId: string, toolName: string): void {
    this.touchSession(sessionId);
    const session = this.sessions.get(sessionId)!;
    if (session.builtInToolApprovals.includes(toolName)) return;
    session.builtInToolApprovals.push(toolName);
    session.lastActivity = Date.now();
    this._onDidChange.fire();
  }

  // --- MCP tool approvals (runtime-only, session-scoped) ---

  /** True if this tool (or its server) has been approved for this session. */
  isMcpApproved(sessionId: string, toolName: string): boolean {
    const server = parseMcpToolName(toolName)?.serverName ?? "";
    const session = this.getSession(sessionId);
    return (
      session.mcpToolApprovals.includes(toolName) ||
      session.mcpServerApprovals.includes(server)
    );
  }

  /** True if every tool from this server has been approved for this session. */
  isMcpServerApproved(sessionId: string, serverName: string): boolean {
    return this.getSession(sessionId).mcpServerApprovals.includes(serverName);
  }

  /** Approve a single tool for the rest of this session. */
  approveMcpTool(sessionId: string, toolName: string): void {
    this.touchSession(sessionId);
    const session = this.sessions.get(sessionId)!;
    if (session.mcpToolApprovals.includes(toolName)) return;
    session.mcpToolApprovals.push(toolName);
    session.lastActivity = Date.now();
    this._onDidChange.fire();
  }

  /** Approve all tools from a server for the rest of this session. */
  approveMcpServer(sessionId: string, serverName: string): void {
    this.touchSession(sessionId);
    const session = this.sessions.get(sessionId)!;
    if (session.mcpServerApprovals.includes(serverName)) return;
    session.mcpServerApprovals.push(serverName);
    session.lastActivity = Date.now();
    this._onDidChange.fire();
  }

  dispose(): void {
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
    const session = this.sessions.get(sessionId) ?? this.newSession();
    session.lastActivity = Date.now();
    this.sessions.set(sessionId, session);
  }

  clearSession(
    sessionId: string,
    options?: { forgetProjectBinding?: boolean },
  ): void {
    this.clearSessions([sessionId], options);
  }

  clearSessions(
    sessionIds: Iterable<string>,
    options?: { forgetProjectBinding?: boolean },
  ): void {
    let changed = false;
    for (const sessionId of new Set(sessionIds)) {
      changed = this.sessions.delete(sessionId) || changed;
      if (options?.forgetProjectBinding) {
        this.sessionProjects.delete(sessionId);
      }
    }
    if (changed) this._onDidChange.fire();
  }

  async clearLegacyPersistedSessions(): Promise<void> {
    const cleanupVersion = this.globalState.get<number>(
      APPROVAL_SESSION_CLEANUP_VERSION_KEY,
      0,
    );
    if (cleanupVersion >= APPROVAL_SESSION_CLEANUP_VERSION) return;

    const legacyKeys = this.globalState
      .keys()
      .filter((key) => key.startsWith(APPROVAL_SESSION_KEY_PREFIX));
    for (const key of legacyKeys) {
      await this.globalState.update(key, undefined);
    }
    await this.globalState.update(APPROVAL_SESSIONS_KEY, undefined);
    await this.globalState.update(
      APPROVAL_SESSION_STORAGE_VERSION_KEY,
      undefined,
    );
    await this.globalState.update(
      APPROVAL_SESSION_CLEANUP_VERSION_KEY,
      APPROVAL_SESSION_CLEANUP_VERSION,
    );
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
      destination.inheritanceInitialized ||= source.inheritanceInitialized;
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
      destination.builtInToolApprovals = [
        ...new Set([
          ...destination.builtInToolApprovals,
          ...source.builtInToolApprovals,
        ]),
      ];
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
        ...source,
        commandRules: source.commandRules.map((rule) => ({ ...rule })),
        networkRules: source.networkRules.map((rule) => ({ ...rule })),
        pathRules: source.pathRules.map((rule) => ({ ...rule })),
        writeRules: source.writeRules.map((rule) => ({ ...rule })),
        builtInToolApprovals: [...source.builtInToolApprovals],
        mcpToolApprovals: [...source.mcpToolApprovals],
        mcpServerApprovals: [...source.mcpServerApprovals],
        lastActivity: Date.now(),
      });
    }

    if (sourceProject) {
      this.sessionProjects.set(toId, sourceProject);
      this.sessionProjects.delete(fromId);
    }
    this.sessions.delete(fromId);
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
    const source = this.sessions.get(fromId);
    const destination = this.sessions.get(toId);
    let changed = false;
    let sessionChanged = false;

    if (source) {
      const firstInheritance = !(destination?.inheritanceInitialized ?? false);
      const commandRules = mergeInheritedRules(
        destination?.commandRules ?? [],
        source.commandRules.map(markRuleInherited),
        firstInheritance,
      );
      const networkRules = mergeInheritedRules(
        destination?.networkRules ?? [],
        source.networkRules.map(markRuleInherited),
        firstInheritance,
      );
      const pathRules = mergeInheritedRules(
        destination?.pathRules ?? [],
        source.pathRules.map(markRuleInherited),
        firstInheritance,
      );
      const writeRules = mergeInheritedRules(
        destination?.writeRules ?? [],
        source.writeRules.map(markRuleInherited),
        firstInheritance,
      );
      const builtInToolApprovals = [
        ...new Set([
          ...(destination?.builtInToolApprovals ?? []),
          ...source.builtInToolApprovals,
        ]),
      ];
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
        firstInheritance ||
        (!(destination?.writeApproved ?? false) && source.writeApproved) ||
        (!(destination?.agentWriteApproved ?? false) &&
          source.agentWriteApproved) ||
        !rulesEqual(commandRules, destination?.commandRules ?? []) ||
        !rulesEqual(networkRules, destination?.networkRules ?? []) ||
        !rulesEqual(pathRules, destination?.pathRules ?? []) ||
        !rulesEqual(writeRules, destination?.writeRules ?? []) ||
        !stringSetsEqual(
          builtInToolApprovals,
          destination?.builtInToolApprovals ?? [],
        ) ||
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
          inheritanceInitialized: true,
          commandRules,
          networkRules,
          pathRules,
          writeRules,
          builtInToolApprovals,
          mcpToolApprovals,
          mcpServerApprovals,
          lastActivity: now,
        });
        changed = true;
      }
    }
    if (changed) this._onDidChange.fire();
    return changed;
  }

  /** Reset session-level agent write approval for a single session (e.g. on mode switch). */
  resetSessionAgentWriteApproval(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session?.agentWriteApproved) {
      session.agentWriteApproved = false;
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
    return stripScopedRuleProvenance(
      this.pathRuleStore.get(sessionId, this.getProjectRoot(sessionId)),
    );
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
            rule: stripRuleProvenance(rule),
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
      ...stripScopedRuleProvenance(
        this.writeRuleStore.get(sessionId, projectBinding?.rootPath),
      ),
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
      stripScopedRuleProvenance(
        this.commandRuleStore.get(
          sessionId,
          this.getProjectRoot(sessionId, cwd, false),
        ),
      ),
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
        ({ rule }) => (rule.decision ?? "allow") === evaluation.decision,
      ) ?? null
    );
  }

  evaluateNetworkRules(
    sessionId: string,
    destination: NetworkRuleDestination,
  ): NetworkRulePolicyEvaluation {
    return evaluateNetworkRulePolicy(
      stripScopedRuleProvenance(
        this.networkRuleStore.get(sessionId, this.getProjectRoot(sessionId)),
      ),
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
    return stripScopedRuleProvenance(
      this.networkRuleStore.get(sessionId, this.getProjectRoot(sessionId)),
    );
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
    return stripScopedRuleProvenance(
      this.commandRuleStore.get(sessionId, this.getProjectRoot(sessionId)),
    );
  }

  clearSessionCommandRules(sessionId: string): void {
    this.commandRuleStore.clearSession(sessionId);
    this._onDidChange.fire();
  }

  // --- State for sidebar ---

  getExplicitSessionRules(sessionId: string): {
    commandRules: CommandRule[];
    pathRules: PathRule[];
    writeRules: PathRule[];
  } {
    const session = this.getSession(sessionId);
    return {
      commandRules: session.commandRules
        .filter((rule) => !rule.inherited)
        .map(stripRuleProvenance),
      pathRules: session.pathRules
        .filter((rule) => !rule.inherited)
        .map(stripRuleProvenance),
      writeRules: session.writeRules
        .filter((rule) => !rule.inherited)
        .map(stripRuleProvenance),
    };
  }

  getActiveSessions(): Array<{
    id: string;
    writeApproved: boolean;
    agentWriteApproved: boolean;
    commandRuleCount: number;
    pathRuleCount: number;
    writeRuleCount: number;
    lastActivity: number;
  }> {
    return Array.from(this.sessions.entries())
      .filter(
        ([, session]) =>
          session.writeApproved ||
          session.agentWriteApproved ||
          session.commandRules.length > 0 ||
          session.networkRules.length > 0 ||
          session.pathRules.length > 0 ||
          session.writeRules.length > 0 ||
          session.builtInToolApprovals.length > 0 ||
          session.mcpToolApprovals.length > 0 ||
          session.mcpServerApprovals.length > 0,
      )
      .map(([id, session]) => ({
        id,
        writeApproved: session.writeApproved,
        agentWriteApproved: session.agentWriteApproved,
        commandRuleCount: session.commandRules.length,
        networkRuleCount: session.networkRules.length,
        pathRuleCount: session.pathRules.length,
        writeRuleCount: session.writeRules.length,
        lastActivity: session.lastActivity,
      }));
  }

  // --- Internal ---

  private getProjectBinding(
    sessionId: string | undefined,
    targetPath?: string,
    fallbackWhenOutsideWorkspace = true,
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
      if (!fallbackWhenOutsideWorkspace) return undefined;
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
    fallbackWhenOutsideWorkspace = true,
  ): string | undefined {
    return this.getProjectBinding(
      sessionId,
      targetPath,
      fallbackWhenOutsideWorkspace,
    )?.rootPath;
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

  private readonly emptySession: Readonly<SessionState> = Object.freeze({
    writeApproved: false,
    agentWriteApproved: false,
    inheritanceInitialized: false,
    commandRules: [],
    networkRules: [],
    pathRules: [],
    writeRules: [],
    builtInToolApprovals: [],
    mcpToolApprovals: [],
    mcpServerApprovals: [],
    lastActivity: 0,
  });

  private newSession(): SessionState {
    return {
      writeApproved: false,
      agentWriteApproved: false,
      inheritanceInitialized: true,
      commandRules: [],
      networkRules: [],
      pathRules: [],
      writeRules: [],
      builtInToolApprovals: [],
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
  inherited?: true;
};

function markRuleInherited<T extends InheritableRule>(rule: T): T {
  return { ...rule, inherited: true };
}

function stripRuleProvenance<T extends InheritableRule>(
  rule: T,
): Omit<T, "inherited"> {
  const { inherited: _, ...explicitRule } = rule;
  return explicitRule;
}

function stripScopedRuleProvenance<T extends InheritableRule>(rules: {
  session: T[];
  project: T[];
  global: T[];
}): {
  session: Array<Omit<T, "inherited">>;
  project: Array<Omit<T, "inherited">>;
  global: Array<Omit<T, "inherited">>;
} {
  return {
    session: rules.session.map(stripRuleProvenance),
    project: rules.project.map(stripRuleProvenance),
    global: rules.global.map(stripRuleProvenance),
  };
}

function mergeInheritedRules<T extends InheritableRule>(
  destination: T[],
  source: T[],
  firstInheritance: boolean,
): T[] {
  const merged = new Map<string, T>();
  for (const rule of destination) {
    merged.set(`${rule.pattern}\0${rule.mode}`, { ...rule });
  }
  for (const rule of source) {
    const identity = `${rule.pattern}\0${rule.mode}`;
    const existing = merged.get(identity);
    if (firstInheritance || !existing || existing.inherited) {
      merged.set(identity, { ...rule });
    }
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
        rule.decision === other.decision &&
        rule.inherited === other.inherited
      );
    })
  );
}

function stringSetsEqual(left: string[], right: string[]): boolean {
  return (
    left.length === right.length && left.every((value) => right.includes(value))
  );
}
