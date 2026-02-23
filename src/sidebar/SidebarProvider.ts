import * as vscode from "vscode";
import * as os from "os";
import * as path from "path";
import type {
  ApprovalManager,
  CommandRule,
  PathRule,
  RuleScope,
} from "../approvals/ApprovalManager.js";

export interface SidebarState {
  serverRunning: boolean;
  port: number | null;
  sessions: number;
  authEnabled: boolean;
  claudeConfigured: boolean;
  writeApproval?: "prompt" | "session" | "project" | "global";
  globalCommandRules?: CommandRule[];
  projectCommandRules?: CommandRule[];
  globalPathRules?: PathRule[];
  projectPathRules?: PathRule[];
  globalWriteRules?: PathRule[];
  projectWriteRules?: PathRule[];
  settingsWriteRules?: string[];
  activeSessions?: Array<{
    id: string;
    writeApproved: boolean;
    commandRules: CommandRule[];
    pathRules: PathRule[];
    writeRules: PathRule[];
  }>;
}

export class SidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "nativeClaude.statusView";

  private view: vscode.WebviewView | undefined;
  private state: SidebarState = {
    serverRunning: false,
    port: null,
    sessions: 0,
    authEnabled: true,
    claudeConfigured: false,
  };
  private approvalManager: ApprovalManager | undefined;

  constructor(private readonly extensionUri: vscode.Uri) {}

  setApprovalManager(manager: ApprovalManager): void {
    this.approvalManager = manager;
    manager.onDidChange(() => this.refreshApprovalState());
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
    };

    webviewView.webview.html = this.getHtml();

    webviewView.webview.onDidReceiveMessage((message) => {
      switch (message.command) {
        case "startServer":
          vscode.commands.executeCommand("native-claude.startServer");
          break;
        case "stopServer":
          vscode.commands.executeCommand("native-claude.stopServer");
          break;
        case "copyConfig":
          this.copyClaudeConfig();
          break;
        case "copyCliCommand":
          this.copyCliCommand();
          break;
        case "openSettings":
          vscode.commands.executeCommand(
            "workbench.action.openSettings",
            "native-claude",
          );
          break;
        case "openOutput":
          vscode.commands.executeCommand(
            "workbench.action.output.show",
            "Native Claude",
          );
          break;
        case "openGlobalConfig":
          this.openConfigFile("global");
          break;
        case "openProjectConfig":
          this.openConfigFile("project");
          break;
        case "installCli":
          this.installViaCli();
          break;
        case "resetWriteApproval":
          this.approvalManager?.resetWriteApproval();
          break;
        case "removeGlobalRule":
          if (message.pattern) {
            this.approvalManager?.removeCommandRule(message.pattern, "global");
          }
          break;
        case "editGlobalRule":
          if (message.pattern && message.mode) {
            this.editRule(message.pattern, message.mode, "global");
          }
          break;
        case "removeProjectRule":
          if (message.pattern) {
            this.approvalManager?.removeCommandRule(message.pattern, "project");
          }
          break;
        case "editProjectRule":
          if (message.pattern && message.mode) {
            this.editRule(message.pattern, message.mode, "project");
          }
          break;
        case "addGlobalRule":
          vscode.commands.executeCommand("native-claude.addTrustedCommand");
          break;
        case "removeSessionRule":
          if (message.sessionId && message.pattern) {
            this.approvalManager?.removeCommandRule(
              message.pattern,
              "session",
              message.sessionId,
            );
          }
          break;
        case "editSessionRule":
          if (message.sessionId && message.pattern && message.mode) {
            this.editRule(
              message.pattern,
              message.mode,
              "session",
              message.sessionId,
            );
          }
          break;
        case "clearSessionRules":
          if (message.sessionId) {
            this.approvalManager?.clearSessionCommandRules(message.sessionId);
          }
          break;
        case "clearAllSessions":
          vscode.commands.executeCommand("native-claude.clearSessionApprovals");
          break;
        // Path rule handlers
        case "removeGlobalPathRule":
          if (message.pattern) {
            this.approvalManager?.removePathRule(message.pattern, "global");
          }
          break;
        case "editGlobalPathRule":
          if (message.pattern && message.mode) {
            this.editPathRule(message.pattern, message.mode, "global");
          }
          break;
        case "removeProjectPathRule":
          if (message.pattern) {
            this.approvalManager?.removePathRule(message.pattern, "project");
          }
          break;
        case "editProjectPathRule":
          if (message.pattern && message.mode) {
            this.editPathRule(message.pattern, message.mode, "project");
          }
          break;
        case "removeSessionPathRule":
          if (message.sessionId && message.pattern) {
            this.approvalManager?.removePathRule(
              message.pattern,
              "session",
              message.sessionId,
            );
          }
          break;
        // Write rule handlers
        case "removeGlobalWriteRule":
          if (message.pattern) {
            this.approvalManager?.removeWriteRule(message.pattern, "global");
          }
          break;
        case "editGlobalWriteRule":
          if (message.pattern && message.mode) {
            this.editWriteRule(message.pattern, message.mode, "global");
          }
          break;
        case "removeProjectWriteRule":
          if (message.pattern) {
            this.approvalManager?.removeWriteRule(message.pattern, "project");
          }
          break;
        case "editProjectWriteRule":
          if (message.pattern && message.mode) {
            this.editWriteRule(message.pattern, message.mode, "project");
          }
          break;
        case "removeSessionWriteRule":
          if (message.sessionId && message.pattern) {
            this.approvalManager?.removeWriteRule(
              message.pattern,
              "session",
              message.sessionId,
            );
          }
          break;
      }
    });
  }

  updateState(partial: Partial<SidebarState>): void {
    Object.assign(this.state, partial);
    this.refreshApprovalState();
  }

  private async editRule(
    oldPattern: string,
    oldMode: string,
    scope: RuleScope,
    sessionId?: string,
  ): Promise<void> {
    if (!this.approvalManager) return;

    type RuleMode = "prefix" | "exact" | "regex";
    const modes: Array<{ label: string; mode: RuleMode; alwaysShow: true }> = [
      {
        label: "$(symbol-text) Prefix Match",
        mode: "prefix",
        alwaysShow: true,
      },
      { label: "$(symbol-key) Exact Match", mode: "exact", alwaysShow: true },
      { label: "$(regex) Regex Match", mode: "regex", alwaysShow: true },
    ];

    const qp = vscode.window.createQuickPick<
      vscode.QuickPickItem & { mode: RuleMode; alwaysShow: true }
    >();
    qp.title = "Edit rule pattern, then pick match mode";
    qp.placeholder = "Edit the pattern above, then select match mode";
    qp.value = oldPattern;
    qp.items = modes;
    // Pre-select the current mode
    const current = modes.find((m) => m.mode === oldMode);
    if (current) qp.activeItems = [current];
    qp.ignoreFocusOut = true;

    const result = await new Promise<{
      pattern: string;
      mode: RuleMode;
    } | null>((resolve) => {
      let resolved = false;
      qp.onDidAccept(() => {
        const selected = qp.selectedItems[0];
        if (selected && qp.value.trim()) {
          resolved = true;
          resolve({ pattern: qp.value.trim(), mode: selected.mode });
          qp.dispose();
        }
      });
      qp.onDidHide(() => {
        if (!resolved) resolve(null);
        qp.dispose();
      });
      qp.show();
    });

    if (result) {
      this.approvalManager.editCommandRule(
        oldPattern,
        result,
        scope,
        sessionId,
      );
    }
  }

  private async editPathRule(
    oldPattern: string,
    oldMode: string,
    scope: RuleScope,
    sessionId?: string,
  ): Promise<void> {
    if (!this.approvalManager) return;

    type RuleMode = "glob" | "prefix" | "exact";
    const modes: Array<{ label: string; mode: RuleMode; alwaysShow: true }> = [
      { label: "$(symbol-misc) Glob Match", mode: "glob", alwaysShow: true },
      {
        label: "$(symbol-text) Prefix Match",
        mode: "prefix",
        alwaysShow: true,
      },
      { label: "$(symbol-key) Exact Match", mode: "exact", alwaysShow: true },
    ];

    const qp = vscode.window.createQuickPick<
      vscode.QuickPickItem & { mode: RuleMode; alwaysShow: true }
    >();
    qp.title = "Edit path pattern, then pick match mode";
    qp.placeholder = "Edit the pattern above, then select match mode";
    qp.value = oldPattern;
    qp.items = modes;
    const current = modes.find((m) => m.mode === oldMode);
    if (current) qp.activeItems = [current];
    qp.ignoreFocusOut = true;

    const result = await new Promise<{
      pattern: string;
      mode: RuleMode;
    } | null>((resolve) => {
      let resolved = false;
      qp.onDidAccept(() => {
        const selected = qp.selectedItems[0];
        if (selected && qp.value.trim()) {
          resolved = true;
          resolve({ pattern: qp.value.trim(), mode: selected.mode });
          qp.dispose();
        }
      });
      qp.onDidHide(() => {
        if (!resolved) resolve(null);
        qp.dispose();
      });
      qp.show();
    });

    if (result) {
      this.approvalManager.editPathRule(oldPattern, result, scope, sessionId);
    }
  }

  private async editWriteRule(
    oldPattern: string,
    oldMode: string,
    scope: RuleScope,
    sessionId?: string,
  ): Promise<void> {
    if (!this.approvalManager) return;

    type RuleMode = "glob" | "prefix" | "exact";
    const modes: Array<{ label: string; mode: RuleMode; alwaysShow: true }> = [
      { label: "$(symbol-misc) Glob Match", mode: "glob", alwaysShow: true },
      {
        label: "$(symbol-text) Prefix Match",
        mode: "prefix",
        alwaysShow: true,
      },
      { label: "$(symbol-key) Exact Match", mode: "exact", alwaysShow: true },
    ];

    const qp = vscode.window.createQuickPick<
      vscode.QuickPickItem & { mode: RuleMode; alwaysShow: true }
    >();
    qp.title = "Edit write rule pattern, then pick match mode";
    qp.placeholder = "Edit the pattern above, then select match mode";
    qp.value = oldPattern;
    qp.items = modes;
    const current = modes.find((m) => m.mode === oldMode);
    if (current) qp.activeItems = [current];
    qp.ignoreFocusOut = true;

    const result = await new Promise<{
      pattern: string;
      mode: RuleMode;
    } | null>((resolve) => {
      let resolved = false;
      qp.onDidAccept(() => {
        const selected = qp.selectedItems[0];
        if (selected && qp.value.trim()) {
          resolved = true;
          resolve({ pattern: qp.value.trim(), mode: selected.mode });
          qp.dispose();
        }
      });
      qp.onDidHide(() => {
        if (!resolved) resolve(null);
        qp.dispose();
      });
      qp.show();
    });

    if (result) {
      this.approvalManager.editWriteRule(oldPattern, result, scope, sessionId);
    }
  }

  private refreshApprovalState(): void {
    if (this.approvalManager) {
      const sessions = this.approvalManager.getActiveSessions();
      // Show the "best" write approval state across all sessions
      const writeState = this.approvalManager.getWriteApprovalState("_none");
      if (writeState === "global" || writeState === "project") {
        this.state.writeApproval = writeState;
      } else if (sessions.some((s) => s.writeApproved)) {
        this.state.writeApproval = "session";
      } else {
        this.state.writeApproval = "prompt";
      }
      // Use a dummy session ID to get global/project rules
      const dummyId = "_sidebar";
      const commandRules = this.approvalManager.getCommandRules(dummyId);
      const pathRules = this.approvalManager.getPathRules(dummyId);
      const writeRules = this.approvalManager.getWriteRules(dummyId);
      this.state.globalCommandRules = commandRules.global;
      this.state.projectCommandRules = commandRules.project;
      this.state.globalPathRules = pathRules.global;
      this.state.projectPathRules = pathRules.project;
      this.state.globalWriteRules = writeRules.global;
      this.state.projectWriteRules = writeRules.project;
      this.state.settingsWriteRules = writeRules.settings;
      this.state.activeSessions = sessions.map((s) => ({
        id: s.id,
        writeApproved: s.writeApproved,
        commandRules: this.approvalManager!.getCommandRules(s.id).session,
        pathRules: this.approvalManager!.getPathRules(s.id).session,
        writeRules: this.approvalManager!.getWriteRules(s.id).session,
      }));
    }
    if (this.view) {
      this.view.webview.html = this.getHtml();
    }
  }

  private copyClaudeConfig(): void {
    if (!this.state.port) {
      vscode.window.showWarningMessage("Server is not running.");
      return;
    }

    const config = {
      "native-claude": {
        type: "http",
        url: `http://localhost:${this.state.port}/mcp`,
      },
    };

    vscode.env.clipboard.writeText(JSON.stringify(config, null, 2));
    vscode.window.showInformationMessage("MCP config copied to clipboard.");
  }

  private copyCliCommand(): void {
    if (!this.state.port) {
      vscode.window.showWarningMessage("Server is not running.");
      return;
    }

    const cmd = `claude mcp add --transport http native-claude http://localhost:${this.state.port}/mcp`;
    vscode.env.clipboard.writeText(cmd);
    vscode.window.showInformationMessage("CLI command copied to clipboard.");
  }

  private async installViaCli(): Promise<void> {
    if (!this.state.port) {
      vscode.window.showWarningMessage("Server is not running.");
      return;
    }

    const terminal = vscode.window.createTerminal({
      name: "Native Claude Setup",
    });
    terminal.show();
    terminal.sendText(
      `claude mcp add --transport http native-claude http://localhost:${this.state.port}/mcp`,
      true,
    );
  }

  private openConfigFile(scope: "global" | "project"): void {
    let filePath: string;
    if (scope === "global") {
      filePath = path.join(os.homedir(), ".claude", "native-claude.json");
    } else {
      const folders = vscode.workspace.workspaceFolders;
      if (!folders || folders.length === 0) {
        vscode.window.showWarningMessage("No workspace folder open.");
        return;
      }
      filePath = path.join(
        folders[0].uri.fsPath,
        ".claude",
        "native-claude.json",
      );
    }
    vscode.window.showTextDocument(vscode.Uri.file(filePath));
  }

  private getMasterBypass(): boolean {
    return vscode.workspace
      .getConfiguration("native-claude")
      .get<boolean>("masterBypass", false);
  }

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  private getHtml(): string {
    const {
      serverRunning,
      port,
      sessions,
      authEnabled,
      claudeConfigured,
      writeApproval,
      globalCommandRules,
      activeSessions,
    } = this.state;

    const statusDot = serverRunning
      ? `<span class="dot running"></span>`
      : `<span class="dot stopped"></span>`;

    const statusText = serverRunning ? `Running on port ${port}` : "Stopped";

    const serverButton = serverRunning
      ? `<button class="btn btn-secondary" onclick="send('stopServer')">Stop Server</button>`
      : `<button class="btn btn-primary" onclick="send('startServer')">Start Server</button>`;

    const sessionText = serverRunning
      ? `<div class="info-row"><span class="label">Sessions:</span><span class="value">${sessions}</span></div>`
      : "";

    const configStatus = claudeConfigured
      ? `<span class="badge badge-ok">Configured</span>`
      : `<span class="badge badge-warn">Not configured</span>`;

    const setupSection = serverRunning
      ? `
        <div class="section">
          <h3>Claude Code Integration</h3>
          <div class="info-row">
            <span class="label">~/.claude.json:</span>
            ${configStatus}
          </div>
          <p class="help-text">
            The extension auto-configures Claude Code on startup. If you need to set it up manually:
          </p>
          <div class="button-group">
            <button class="btn btn-secondary" onclick="send('installCli')">Run CLI Setup</button>
            <button class="btn btn-secondary" onclick="send('copyCliCommand')">Copy CLI Command</button>
            <button class="btn btn-secondary" onclick="send('copyConfig')">Copy JSON Config</button>
          </div>
        </div>`
      : `
        <div class="section">
          <h3>Claude Code Integration</h3>
          <p class="help-text">Start the server to configure Claude Code integration.</p>
        </div>`;

    // Write approval section
    const writeApprovalLabel =
      writeApproval === "global"
        ? "Always auto-accept"
        : writeApproval === "project"
          ? "Project auto-accept"
          : writeApproval === "session"
            ? "Session auto-accept"
            : "Prompt each time";
    const writeApprovalBadge =
      writeApproval === "global"
        ? `<span class="badge badge-warn">Global</span>`
        : writeApproval === "project"
          ? `<span class="badge badge-warn">Project</span>`
          : writeApproval === "session"
            ? `<span class="badge badge-warn">Session</span>`
            : `<span class="badge badge-ok">Active</span>`;
    const writeResetBtn =
      writeApproval !== "prompt"
        ? `<button class="btn btn-secondary" style="margin-top:6px" onclick="send('resetWriteApproval')">Reset to Prompt</button>`
        : "";

    // File-level write rules (shown inline in Write Approval section)
    const {
      globalPathRules,
      projectPathRules,
      globalWriteRules,
      projectWriteRules,
      settingsWriteRules,
    } = this.state;

    const settingsRulesHtml =
      (settingsWriteRules ?? []).length > 0
        ? (settingsWriteRules ?? [])
            .map(
              (p) =>
                `<div class="rule-row">
            <span class="rule-mode">glob</span>
            <span class="rule-pattern">${this.escapeHtml(p)}</span>
            <span class="help-text" style="margin:0;font-size:10px">(settings)</span>
          </div>`,
            )
            .join("")
        : "";

    const globalWriteRulesHtml =
      (globalWriteRules ?? []).length > 0
        ? (globalWriteRules ?? [])
            .map((r) => {
              const ep = this.escapeHtml(r.pattern);
              return `<div class="rule-row">
            <span class="rule-mode">${r.mode}</span>
            <span class="rule-pattern" onclick="sendRule('editGlobalWriteRule', '${ep}', '${r.mode}')" title="Click to edit">${ep}</span>
            <a class="rule-action" onclick="sendRule('editGlobalWriteRule', '${ep}', '${r.mode}')" title="Edit">✎</a>
            <a class="rule-action rule-delete" onclick="sendData('removeGlobalWriteRule', '${ep}')" title="Remove">✕</a>
          </div>`;
            })
            .join("")
        : "";

    const sessionsWithWriteRules = (activeSessions ?? []).filter(
      (s) => s.writeRules.length > 0,
    );
    const sessionWriteRulesHtml =
      sessionsWithWriteRules.length > 0
        ? sessionsWithWriteRules
            .map((s) => {
              const shortId =
                s.id.length > 12 ? s.id.substring(0, 12) + "..." : s.id;
              const eid = this.escapeHtml(s.id);
              const rules = s.writeRules
                .map((r) => {
                  const ep = this.escapeHtml(r.pattern);
                  return `<div class="rule-row">
              <span class="rule-mode">${r.mode}</span>
              <span class="rule-pattern" title="${ep}">${ep}</span>
              <a class="rule-action rule-delete" onclick="sendSessionData('removeSessionWriteRule', '${eid}', '${ep}')" title="Remove">✕</a>
            </div>`;
                })
                .join("");
              return `<div class="session-block">
            <div class="info-row">
              <span class="label" title="${this.escapeHtml(s.id)}">Session ${shortId}</span>
            </div>
            ${rules}
          </div>`;
            })
            .join("")
        : "";

    const sessionWriteSection =
      sessionsWithWriteRules.length > 0
        ? `<div style="margin-top:10px">
          <div class="subsection-label">Session Rules</div>
          ${sessionWriteRulesHtml}
        </div>`
        : "";

    const projectWriteRulesHtml =
      (projectWriteRules ?? []).length > 0
        ? (projectWriteRules ?? [])
            .map((r) => {
              const ep = this.escapeHtml(r.pattern);
              return `<div class="rule-row">
            <span class="rule-mode">${r.mode}</span>
            <span class="rule-pattern" onclick="sendRule('editProjectWriteRule', '${ep}', '${r.mode}')" title="Click to edit">${ep}</span>
            <a class="rule-action" onclick="sendRule('editProjectWriteRule', '${ep}', '${r.mode}')" title="Edit">✎</a>
            <a class="rule-action rule-delete" onclick="sendData('removeProjectWriteRule', '${ep}')" title="Remove">✕</a>
          </div>`;
            })
            .join("")
        : "";

    const hasAnyWriteRules =
      (settingsWriteRules ?? []).length > 0 ||
      (globalWriteRules ?? []).length > 0 ||
      (projectWriteRules ?? []).length > 0 ||
      sessionsWithWriteRules.length > 0;
    const fileRulesHtml = hasAnyWriteRules
      ? `<div style="margin-top:10px">
          <p class="help-text">Files matching these rules skip the diff view.</p>
          ${settingsRulesHtml}
          ${globalWriteRulesHtml ? `<div class="subsection-label">Global Rules</div>${globalWriteRulesHtml}` : ""}
          ${projectWriteRulesHtml ? `<div class="subsection-label">Project Rules</div>${projectWriteRulesHtml}` : ""}
          ${sessionWriteSection}
        </div>`
      : "";

    const approvalSection = `
      <div class="section">
        <h3>Write Approval</h3>
        <div class="info-row">
          <span class="label">${writeApprovalLabel}</span>
          ${writeApprovalBadge}
        </div>
        ${writeResetBtn}
        ${fileRulesHtml}
      </div>`;

    // Trusted paths section (outside-workspace access)
    const globalPathRulesHtml =
      (globalPathRules ?? []).length > 0
        ? (globalPathRules ?? [])
            .map((r) => {
              const ep = this.escapeHtml(r.pattern);
              return `<div class="rule-row">
            <span class="rule-mode">${r.mode}</span>
            <span class="rule-pattern" onclick="sendRule('editGlobalPathRule', '${ep}', '${r.mode}')" title="Click to edit">${ep}</span>
            <a class="rule-action" onclick="sendRule('editGlobalPathRule', '${ep}', '${r.mode}')" title="Edit">✎</a>
            <a class="rule-action rule-delete" onclick="sendData('removeGlobalPathRule', '${ep}')" title="Remove">✕</a>
          </div>`;
            })
            .join("")
        : `<p class="help-text">No trusted paths configured.</p>`;

    const sessionsWithPathRules = (activeSessions ?? []).filter(
      (s) => s.pathRules.length > 0,
    );
    const sessionPathRulesHtml =
      sessionsWithPathRules.length > 0
        ? sessionsWithPathRules
            .map((s) => {
              const shortId =
                s.id.length > 12 ? s.id.substring(0, 12) + "..." : s.id;
              const eid = this.escapeHtml(s.id);
              const rules = s.pathRules
                .map((r) => {
                  const ep = this.escapeHtml(r.pattern);
                  return `<div class="rule-row">
              <span class="rule-mode">${r.mode}</span>
              <span class="rule-pattern" title="${ep}">${ep}</span>
              <a class="rule-action rule-delete" onclick="sendSessionData('removeSessionPathRule', '${eid}', '${ep}')" title="Remove">✕</a>
            </div>`;
                })
                .join("");
              return `<div class="session-block">
            <div class="info-row">
              <span class="label" title="${this.escapeHtml(s.id)}">Session ${shortId}</span>
            </div>
            ${rules}
          </div>`;
            })
            .join("")
        : "";

    const sessionPathSection =
      sessionsWithPathRules.length > 0
        ? `<div style="margin-top:10px">
          <div class="subsection-label">Session Rules</div>
          ${sessionPathRulesHtml}
        </div>`
        : "";

    const projectPathRulesHtml =
      (projectPathRules ?? []).length > 0
        ? (projectPathRules ?? [])
            .map((r) => {
              const ep = this.escapeHtml(r.pattern);
              return `<div class="rule-row">
            <span class="rule-mode">${r.mode}</span>
            <span class="rule-pattern" onclick="sendRule('editProjectPathRule', '${ep}', '${r.mode}')" title="Click to edit">${ep}</span>
            <a class="rule-action" onclick="sendRule('editProjectPathRule', '${ep}', '${r.mode}')" title="Edit">✎</a>
            <a class="rule-action rule-delete" onclick="sendData('removeProjectPathRule', '${ep}')" title="Remove">✕</a>
          </div>`;
            })
            .join("")
        : "";

    const projectPathSection =
      (projectPathRules ?? []).length > 0
        ? `<div style="margin-top:10px">
          <div class="subsection-label">Project Rules</div>
          ${projectPathRulesHtml}
        </div>`
        : "";

    const trustedPathsSection = `
      <div class="section">
        <h3>Trusted Paths</h3>
        <p class="help-text">Outside-workspace paths that tools can access.</p>
        <div class="subsection-label">Global Rules</div>
        ${globalPathRulesHtml}
        ${projectPathSection}
        ${sessionPathSection}
      </div>`;

    // Trusted commands section
    const globalRulesHtml =
      (globalCommandRules ?? []).length > 0
        ? (globalCommandRules ?? [])
            .map((r) => {
              const ep = this.escapeHtml(r.pattern);
              return `<div class="rule-row">
            <span class="rule-mode">${r.mode}</span>
            <span class="rule-pattern" onclick="sendRule('editGlobalRule', '${ep}', '${r.mode}')" title="Click to edit">${ep}</span>
            <a class="rule-action" onclick="sendRule('editGlobalRule', '${ep}', '${r.mode}')" title="Edit">✎</a>
            <a class="rule-action rule-delete" onclick="sendData('removeGlobalRule', '${ep}')" title="Remove">✕</a>
          </div>`;
            })
            .join("")
        : `<p class="help-text">No global rules configured.</p>`;

    const sessionsWithRules = (activeSessions ?? []).filter(
      (s) => s.commandRules.length > 0,
    );
    const sessionRulesHtml =
      sessionsWithRules.length > 0
        ? sessionsWithRules
            .map((s) => {
              const shortId =
                s.id.length > 12 ? s.id.substring(0, 12) + "..." : s.id;
              const eid = this.escapeHtml(s.id);
              const rules = s.commandRules
                .map((r) => {
                  const ep = this.escapeHtml(r.pattern);
                  return `<div class="rule-row">
              <span class="rule-mode">${r.mode}</span>
              <span class="rule-pattern" onclick="sendSessionRuleEdit('${eid}', '${ep}', '${r.mode}')" title="Click to edit">${ep}</span>
              <a class="rule-action" onclick="sendSessionRuleEdit('${eid}', '${ep}', '${r.mode}')" title="Edit">✎</a>
              <a class="rule-action rule-delete" onclick="sendSessionRule('${eid}', '${ep}')" title="Remove">✕</a>
            </div>`;
                })
                .join("");
              return `<div class="session-block">
            <div class="info-row">
              <span class="label" title="${this.escapeHtml(s.id)}">Session ${shortId}</span>
              <a class="link" onclick="sendSession('clearSessionRules', '${eid}')">Clear</a>
            </div>
            ${rules}
          </div>`;
            })
            .join("")
        : "";

    const sessionSection =
      sessionsWithRules.length > 0
        ? `<div style="margin-top:10px">
          <div class="subsection-label">Session Rules</div>
          ${sessionRulesHtml}
          <a class="link" style="display:block;margin-top:6px" onclick="send('clearAllSessions')">Clear All Sessions</a>
        </div>`
        : "";

    // Project command rules
    const { projectCommandRules } = this.state;
    const projectRulesHtml =
      (projectCommandRules ?? []).length > 0
        ? (projectCommandRules ?? [])
            .map((r) => {
              const ep = this.escapeHtml(r.pattern);
              return `<div class="rule-row">
            <span class="rule-mode">${r.mode}</span>
            <span class="rule-pattern" onclick="sendRule('editProjectRule', '${ep}', '${r.mode}')" title="Click to edit">${ep}</span>
            <a class="rule-action" onclick="sendRule('editProjectRule', '${ep}', '${r.mode}')" title="Edit">✎</a>
            <a class="rule-action rule-delete" onclick="sendData('removeProjectRule', '${ep}')" title="Remove">✕</a>
          </div>`;
            })
            .join("")
        : "";

    const projectCommandSection =
      (projectCommandRules ?? []).length > 0
        ? `<div style="margin-top:10px">
          <div class="subsection-label">Project Rules</div>
          ${projectRulesHtml}
        </div>`
        : "";

    const trustedCommandsSection = `
      <div class="section">
        <h3>Trusted Commands</h3>
        <div class="subsection-label">Global Rules</div>
        ${globalRulesHtml}
        ${projectCommandSection}
        <button class="btn btn-secondary" style="margin-top:6px" onclick="send('addGlobalRule')">+ Add Rule</button>
        ${sessionSection}
      </div>`;

    const toolsList = `
      <div class="section">
        <h3>Available Tools</h3>
        <ul class="tools-list">
          <li><code>write_file</code> — Create/overwrite with diff review</li>
          <li><code>apply_diff</code> — Search/replace with diff review</li>
          <li><code>execute_command</code> — Integrated terminal</li>
          <li><code>read_file</code> — Read with line numbers</li>
          <li><code>list_files</code> — Directory listing</li>
          <li><code>search_files</code> — Regex search</li>
          <li><code>get_diagnostics</code> — Errors &amp; warnings</li>
        </ul>
      </div>`;

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      padding: 12px;
      line-height: 1.5;
    }

    .section {
      margin-bottom: 16px;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.2));
    }
    .section:last-child { border-bottom: none; }

    h3 {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--vscode-sideBarSectionHeader-foreground, var(--vscode-foreground));
      margin-bottom: 8px;
    }

    .status-header {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 8px;
    }

    .dot {
      display: inline-block;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .dot.running { background: var(--vscode-testing-iconPassed, #4ec94e); }
    .dot.stopped { background: var(--vscode-testing-iconFailed, #f44747); }

    .status-text {
      font-weight: 500;
    }

    .info-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 3px 0;
      font-size: 12px;
    }
    .info-row .label { color: var(--vscode-descriptionForeground); }
    .info-row .value { font-weight: 500; }

    .badge {
      font-size: 11px;
      padding: 1px 6px;
      border-radius: 3px;
      font-weight: 500;
    }
    .badge-ok {
      background: var(--vscode-testing-iconPassed, #4ec94e);
      color: #fff;
    }
    .badge-warn {
      background: var(--vscode-editorWarning-foreground, #cca700);
      color: #000;
    }

    .btn {
      display: block;
      width: 100%;
      padding: 6px 12px;
      border: none;
      border-radius: 3px;
      font-family: var(--vscode-font-family);
      font-size: 12px;
      cursor: pointer;
      text-align: center;
    }
    .btn + .btn { margin-top: 6px; }

    .btn-primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .btn-primary:hover { background: var(--vscode-button-hoverBackground); }

    .btn-secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    .btn-secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }

    .button-group { margin-top: 8px; }

    .help-text {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      margin: 6px 0;
    }

    .tools-list {
      list-style: none;
      padding: 0;
    }
    .tools-list li {
      font-size: 12px;
      padding: 3px 0;
      color: var(--vscode-descriptionForeground);
    }
    .tools-list code {
      font-family: var(--vscode-editor-font-family);
      font-size: 11px;
      color: var(--vscode-foreground);
      background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.15));
      padding: 1px 4px;
      border-radius: 3px;
    }

    .link-row {
      font-size: 12px;
      margin-top: 4px;
    }
    .link-row a {
      color: var(--vscode-textLink-foreground);
      text-decoration: none;
      cursor: pointer;
    }
    .link-row a:hover { text-decoration: underline; }

    .subsection-label {
      font-size: 11px;
      font-weight: 500;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 4px;
    }

    .rule-row {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 3px 0;
      font-size: 12px;
    }
    .rule-mode {
      font-size: 10px;
      padding: 1px 4px;
      border-radius: 3px;
      background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.15));
      color: var(--vscode-descriptionForeground);
      flex-shrink: 0;
    }
    .rule-pattern {
      font-family: var(--vscode-editor-font-family);
      font-size: 11px;
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      cursor: pointer;
    }
    .rule-pattern:hover {
      color: var(--vscode-textLink-foreground);
    }
    .rule-action {
      cursor: pointer;
      color: var(--vscode-descriptionForeground);
      flex-shrink: 0;
      font-size: 11px;
    }
    .rule-action:hover {
      color: var(--vscode-textLink-foreground);
    }
    .rule-delete:hover {
      color: var(--vscode-errorForeground, #f44747) !important;
    }

    .link {
      font-size: 12px;
      color: var(--vscode-textLink-foreground);
      cursor: pointer;
      text-decoration: none;
    }
    .link:hover { text-decoration: underline; }

    .session-block {
      margin-bottom: 8px;
      padding: 6px;
      border-radius: 4px;
      background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.08));
    }
  </style>
</head>
<body>
  <div class="section">
    <h3>Server Status</h3>
    <div class="status-header">
      ${statusDot}
      <span class="status-text">${statusText}</span>
    </div>
    ${sessionText}
    <div class="info-row">
      <span class="label">Auth:</span>
      <span class="value">${authEnabled ? "Enabled" : "Disabled"}</span>
    </div>
    <div class="info-row">
      <span class="label">Master Bypass:</span>
      <span class="value">${this.getMasterBypass() ? "ON" : "Off"}</span>
    </div>
    <div class="button-group">
      ${serverButton}
    </div>
    <div class="link-row" style="margin-top:8px">
      <a onclick="send('openSettings')">Settings</a> &middot;
      <a onclick="send('openOutput')">Output Log</a>
    </div>
    <div class="link-row">
      <a onclick="send('openGlobalConfig')">Global Config</a> &middot;
      <a onclick="send('openProjectConfig')">Project Config</a>
    </div>
  </div>

  ${setupSection}
  ${approvalSection}
  ${trustedPathsSection}
  ${trustedCommandsSection}
  ${toolsList}

  <script>
    const vscode = acquireVsCodeApi();
    function send(command) { vscode.postMessage({ command }); }
    function sendData(command, pattern) { vscode.postMessage({ command, pattern }); }
    function sendSession(command, sessionId) { vscode.postMessage({ command, sessionId }); }
    function sendRule(command, pattern, mode) { vscode.postMessage({ command, pattern, mode }); }
    function sendSessionRule(sessionId, pattern) { vscode.postMessage({ command: 'removeSessionRule', sessionId, pattern }); }
    function sendSessionRuleEdit(sessionId, pattern, mode) { vscode.postMessage({ command: 'editSessionRule', sessionId, pattern, mode }); }
    function sendSessionData(command, sessionId, pattern) { vscode.postMessage({ command, sessionId, pattern }); }
  </script>
</body>
</html>`;
  }
}
