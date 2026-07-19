import * as path from "path";

import * as vscode from "vscode";
import picomatch from "picomatch";

import { parseMcpToolName } from "../agent/mcpToolNames.js";
import {
  createWorkspaceProjectId,
  type SessionProjectScope,
} from "../core/workspaceProjects.js";
import { scanShellLexWords } from "../util/shellLex.js";
import type { ConfigStore } from "./ConfigStore.js";
import { CommandRuleStore, type CommandRule } from "./CommandRuleStore.js";
import { PathRuleStore, type PathRule } from "./PathRuleStore.js";
import type { RuleScope } from "./ScopedRuleStore.js";
import { WriteRuleStore } from "./WriteRuleStore.js";

export type { CommandRule } from "./CommandRuleStore.js";
export type { PathRule } from "./PathRuleStore.js";
export type { RuleScope } from "./ScopedRuleStore.js";

interface SessionState {
  writeApproved: boolean;
  agentWriteApproved: boolean;
  commandRules: CommandRule[];
  pathRules: PathRule[];
  writeRules: PathRule[];
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

const SESSION_TTL = 24 * 60 * 60_000; // 24 hours
const PRUNE_INTERVAL = 60 * 60_000; // 1 hour
const APPROVAL_SESSIONS_KEY = "approvalSessions";

export class ApprovalManager {
  private pruneTimer: ReturnType<typeof setInterval>;
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  // Session-scoped approvals, keyed by chat session ID.
  // Persisted so restored chat sessions keep their session-level approvals.
  private sessions = new Map<string, SessionState>();
  private sessionProjects = new Map<string, SessionProjectBinding>();

  // Per-session MCP approvals, scoped to either one tool or an entire server.
  private mcpApprovals = new Set<string>();
  private configStoreListener: vscode.Disposable;
  private commandRuleStore: CommandRuleStore;
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

  // --- MCP tool approvals (in-memory, session-scoped) ---

  /** True if this tool (or its server) has been approved for this session. */
  isMcpApproved(sessionId: string, toolName: string): boolean {
    const server = parseMcpToolName(toolName)?.serverName ?? "";
    return (
      this.mcpApprovals.has(`${sessionId}:tool:${toolName}`) ||
      this.mcpApprovals.has(`${sessionId}:server:${server}`)
    );
  }

  /** Approve a single tool for the rest of this session. */
  approveMcpTool(sessionId: string, toolName: string): void {
    this.mcpApprovals.add(`${sessionId}:tool:${toolName}`);
  }

  /** Approve all tools from a server for the rest of this session. */
  approveMcpServer(sessionId: string, serverName: string): void {
    this.mcpApprovals.add(`${sessionId}:server:${serverName}`);
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
    const session = this.sessions.get(sessionId) ?? this.newSession();
    session.lastActivity = Date.now();
    this.sessions.set(sessionId, session);
    this.persistSessions();
  }

  clearSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.sessionProjects.delete(sessionId);
    this.clearMcpApprovalsForSession(sessionId);
    this.persistSessions();
  }

  pruneExpiredSessions(): void {
    const now = Date.now();
    let changed = false;
    for (const [id, session] of this.sessions) {
      if (now - session.lastActivity > SESSION_TTL) {
        this.sessions.delete(id);
        this.sessionProjects.delete(id);
        this.clearMcpApprovalsForSession(id);
        changed = true;
      }
    }
    if (changed) {
      this.persistSessions();
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
    // Global blanket approval
    if (this.configStore.getGlobalConfig().agentWriteApproved) {
      return true;
    }
    // Project blanket approval follows the target file's owning workspace root.
    const projectConfig = this.getProjectConfig(sessionId, filePath);
    if (projectConfig?.agentWriteApproved) {
      return true;
    }
    // Session blanket approval
    const session = this.getSession(sessionId);
    if (session.agentWriteApproved) {
      return true;
    }
    // File-level checks (only when filePath provided)
    if (filePath) {
      return this.isFileWriteApproved(sessionId, filePath);
    }
    return false;
  }

  setAgentWriteApproval(
    sessionId: string,
    scope: RuleScope,
    targetPath?: string,
  ): void {
    if (scope === "global") {
      this.configStore.updateGlobalConfig((c) => {
        c.agentWriteApproved = true;
      });
    } else if (scope === "project") {
      const projectRoot = this.getProjectRoot(sessionId, targetPath);
      if (!projectRoot) return;
      this.configStore.updateProjectConfig(projectRoot, (c) => {
        c.agentWriteApproved = true;
      });
    } else {
      const session = this.sessions.get(sessionId) ?? this.newSession();
      session.agentWriteApproved = true;
      session.lastActivity = Date.now();
      this.sessions.set(sessionId, session);
      this.persistSessions();
    }
    this._onDidChange.fire();
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
      destination.pathRules = deduplicateRules([
        ...(destination.pathRules ?? []),
        ...(source.pathRules ?? []),
      ]);
      destination.writeRules = deduplicateRules([
        ...(destination.writeRules ?? []),
        ...(source.writeRules ?? []),
      ]);
      destination.lastActivity = Math.max(
        destination.lastActivity,
        source.lastActivity,
        Date.now(),
      );
    } else {
      this.sessions.set(toId, { ...source, lastActivity: Date.now() });
    }

    if (sourceProject) {
      this.sessionProjects.set(toId, sourceProject);
      this.sessionProjects.delete(fromId);
    }
    this.sessions.delete(fromId);
    this.persistSessions();
    this._onDidChange.fire();
  }

  /** Snapshot all session-scoped approvals into an independently mutable child. */
  inheritSessionApprovalState(
    parentSessionId: string,
    childSessionId: string,
  ): void {
    if (parentSessionId === childSessionId) return;

    const parent = this.sessions.get(parentSessionId);
    if (parent) {
      const child = this.sessions.get(childSessionId) ?? this.newSession();
      child.writeApproved ||= parent.writeApproved;
      child.agentWriteApproved ||= parent.agentWriteApproved;
      child.commandRules = deduplicateRules([
        ...child.commandRules,
        ...parent.commandRules,
      ]);
      child.pathRules = deduplicateRules([
        ...(child.pathRules ?? []),
        ...(parent.pathRules ?? []),
      ]);
      child.writeRules = deduplicateRules([
        ...(child.writeRules ?? []),
        ...(parent.writeRules ?? []),
      ]);
      child.lastActivity = Date.now();
      this.sessions.set(childSessionId, child);
      this.persistSessions();
    }

    const parentMcpPrefix = `${parentSessionId}:`;
    const childMcpPrefix = `${childSessionId}:`;
    let inheritedMcpApproval = false;
    for (const approval of Array.from(this.mcpApprovals)) {
      if (approval.startsWith(parentMcpPrefix)) {
        this.mcpApprovals.add(
          `${childMcpPrefix}${approval.slice(parentMcpPrefix.length)}`,
        );
        inheritedMcpApproval = true;
      }
    }

    if (parent || inheritedMcpApproval) {
      this._onDidChange.fire();
    }
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

  addPathRule(sessionId: string, rule: PathRule, scope: RuleScope): void {
    if (
      this.pathRuleStore.add(
        sessionId,
        rule,
        scope,
        this.getProjectRoot(sessionId),
      )
    ) {
      this._onDidChange.fire();
    }
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
    const projectBinding = this.getProjectBinding(sessionId, filePath);
    const relPath = projectBinding
      ? this.getProjectRelativePath(projectBinding.rootPath, filePath)
      : filePath;
    const candidates = relPath !== filePath ? [relPath, filePath] : [filePath];

    // Settings-based patterns (match against both relative and absolute)
    const settingsPatterns = this.getProjectConfiguration(projectBinding).get<
      string[]
    >("writeRules", []);
    if (
      settingsPatterns.some((p) =>
        candidates.some((c) =>
          this.matchesPathRule(c, { pattern: p, mode: "glob" }),
        ),
      )
    ) {
      return true;
    }

    const rulesByScope = this.writeRuleStore.get(
      sessionId,
      projectBinding?.rootPath,
    );
    return (["session", "project", "global"] as const).some((scope) =>
      rulesByScope[scope].some((rule) =>
        candidates.some((candidate) => this.matchesPathRule(candidate, rule)),
      ),
    );
  }

  addWriteRule(
    sessionId: string,
    rule: PathRule,
    scope: RuleScope,
    targetPath?: string,
  ): void {
    if (
      this.writeRuleStore.add(
        sessionId,
        rule,
        scope,
        this.getProjectRoot(sessionId, targetPath),
      )
    ) {
      this._onDidChange.fire();
    }
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

  getWriteRules(sessionId: string): {
    session: PathRule[];
    project: PathRule[];
    global: PathRule[];
    settings: string[];
  } {
    const projectBinding = this.getProjectBinding(sessionId);
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
    return this.findMatchingCommandRule(sessionId, command, cwd) !== null;
  }

  /**
   * Find the first command rule that matches the given command.
   * Returns the rule and its scope, or null if no match.
   * Checks session → project → global (same priority as isCommandApproved).
   */
  findMatchingCommandRule(
    sessionId: string,
    command: string,
    cwd?: string,
  ): { rule: CommandRule; scope: RuleScope } | null {
    const trimmed = command.trim();

    const rulesByScope = this.commandRuleStore.get(
      sessionId,
      this.getProjectRoot(sessionId, cwd),
    );
    for (const scope of ["session", "project", "global"] as const) {
      for (const rule of rulesByScope[scope]) {
        if (this.matchesRule(trimmed, rule)) return { rule, scope };
      }
    }

    return null;
  }

  addCommandRule(
    sessionId: string,
    rule: CommandRule,
    scope: RuleScope,
    cwd?: string,
  ): void {
    if (
      this.commandRuleStore.add(
        sessionId,
        rule,
        scope,
        this.getProjectRoot(sessionId, cwd),
      )
    ) {
      this._onDidChange.fire();
    }
  }

  editCommandRule(
    oldPattern: string,
    newRule: CommandRule,
    scope: RuleScope,
    sessionId?: string,
  ): void {
    if (
      this.commandRuleStore.edit(
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

  removeCommandRule(
    pattern: string,
    scope: RuleScope,
    sessionId?: string,
  ): void {
    if (
      this.commandRuleStore.remove(
        pattern,
        scope,
        sessionId,
        this.getProjectRoot(sessionId),
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

  private matchesRule(command: string, rule: CommandRule): boolean {
    try {
      switch (rule.mode) {
        case "exact":
          return command === rule.pattern.trim();
        case "prefix": {
          const patternWords = scanShellLexWords(rule.pattern.trim()).words;
          const commandWords = scanShellLexWords(command).words;
          return (
            patternWords.length > 0 &&
            patternWords.length <= commandWords.length &&
            patternWords.every(
              (word, index) => word.raw === commandWords[index]?.raw,
            )
          );
        }
        case "regex":
          return new RegExp(rule.pattern).test(command);
      }
    } catch {
      // Invalid regex — treat as no match
      return false;
    }
  }

  /** Get session state for reading. Returns an empty session if none exists (no side effect). */
  private getSession(sessionId: string): Readonly<SessionState> {
    return this.sessions.get(sessionId) ?? this.emptySession;
  }

  private clearMcpApprovalsForSession(sessionId: string): void {
    const prefix = `${sessionId}:`;
    for (const key of this.mcpApprovals) {
      if (key.startsWith(prefix)) {
        this.mcpApprovals.delete(key);
      }
    }
  }

  private loadPersistedSessions(): void {
    const persisted = this.globalState.get<
      PersistedApprovalSessions | SessionState[] | undefined
    >(APPROVAL_SESSIONS_KEY);
    if (!persisted) return;

    if (Array.isArray(persisted)) {
      return;
    }

    if (persisted.version !== 1 || !persisted.sessions) {
      return;
    }

    for (const [sessionId, session] of Object.entries(persisted.sessions)) {
      this.sessions.set(sessionId, {
        writeApproved: !!session.writeApproved,
        agentWriteApproved: !!session.agentWriteApproved,
        commandRules: [...(session.commandRules ?? [])],
        pathRules: [...(session.pathRules ?? [])],
        writeRules: [...(session.writeRules ?? [])],
        lastActivity: session.lastActivity || Date.now(),
      });
    }
  }

  private persistSessions(): void {
    const sessions = Object.fromEntries(this.sessions.entries());
    void this.globalState.update(APPROVAL_SESSIONS_KEY, {
      version: 1,
      sessions,
    } satisfies PersistedApprovalSessions);
  }

  private readonly emptySession: Readonly<SessionState> = Object.freeze({
    writeApproved: false,
    agentWriteApproved: false,
    commandRules: [],
    pathRules: [],
    writeRules: [],
    lastActivity: 0,
  });

  private newSession(): SessionState {
    return {
      writeApproved: false,
      agentWriteApproved: false,
      commandRules: [],
      pathRules: [],
      writeRules: [],
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
