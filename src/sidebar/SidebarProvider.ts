import * as vscode from "vscode";
import * as os from "os";
import * as path from "path";
import { randomUUID } from "crypto";
import type {
  ApprovalManager,
  CommandRule,
  PathRule,
  RuleScope,
} from "../approvals/ApprovalManager.js";
import type {
  ToolCallTracker,
  TrackedCallInfo,
} from "../server/ToolCallTracker.js";
import { readFeedback, deleteFeedback } from "../util/feedbackStore.js";

export interface SidebarState {
  serverRunning: boolean;
  port: number | null;
  sessions: number;
  authEnabled: boolean;
  claudeConfigured: boolean;
  masterBypass: boolean;
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
    masterBypass: false,
  };
  private approvalManager: ApprovalManager | undefined;
  private toolCallTracker: ToolCallTracker | undefined;
  private activeToolCalls: TrackedCallInfo[] = [];
  private log: (msg: string) => void;

  constructor(
    private readonly extensionUri: vscode.Uri,
    log?: (msg: string) => void,
  ) {
    this.log = log ?? (() => {});
  }

  setApprovalManager(manager: ApprovalManager): void {
    this.approvalManager = manager;
    manager.onDidChange(() => this.refreshApprovalState());
  }

  setToolCallTracker(tracker: ToolCallTracker): void {
    this.toolCallTracker = tracker;
    tracker.on("change", () => this.refreshToolCalls());
  }

  private refreshToolCalls(): void {
    if (!this.toolCallTracker) return;
    this.activeToolCalls = this.toolCallTracker.getActiveCalls();
    this.log(`refreshToolCalls: ${this.activeToolCalls.length} active calls, view=${!!this.view}`);
    // Send lightweight update to client instead of full re-render
    this.view?.webview.postMessage({
      type: "updateToolCalls",
      calls: this.activeToolCalls,
    });
    // Auto-refresh feedback after tool calls complete (may have auto-recorded failures)
    if (__DEV_BUILD__) {
      this.refreshFeedback();
    }
  }

  private refreshFeedback(): void {
    if (!this.view) return;
    try {
      const entries = readFeedback();
      this.view.webview.postMessage({
        type: "updateFeedback",
        entries,
      });
    } catch {
      // feedbackStore may not exist yet
    }
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist")],
    };

    webviewView.webview.html = this.getHtml();
    this.log("Webview resolved, HTML set");

    webviewView.webview.onDidReceiveMessage((message) => {
      switch (message.command) {
        case "webviewReady":
          this.log("Received webviewReady from Preact app");
          this.refreshApprovalState();
          this.refreshToolCalls();
          if (__DEV_BUILD__) {
            this.refreshFeedback();
          }
          break;
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
        case "cancelToolCall":
          if (message.id) {
            vscode.commands.executeCommand(
              "native-claude.cancelToolCall",
              message.id,
            );
          }
          break;
        case "completeToolCall":
          if (message.id) {
            vscode.commands.executeCommand(
              "native-claude.completeToolCall",
              message.id,
            );
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
        // Feedback handlers (dev builds only)
        case "refreshFeedback":
          if (__DEV_BUILD__) {
            this.refreshFeedback();
          }
          break;
        case "deleteFeedbackEntry":
          if (__DEV_BUILD__ && message.index != null) {
            deleteFeedback([Number(message.index)]);
            this.refreshFeedback();
          }
          break;
        case "clearAllFeedback":
          if (__DEV_BUILD__) {
            const entries = readFeedback();
            if (entries.length > 0) {
              deleteFeedback(entries.map((_, i) => i));
            }
            this.refreshFeedback();
          }
          break;
        case "openFeedbackFile":
          if (__DEV_BUILD__) {
            const feedbackPath = path.join(
              os.homedir(),
              ".claude",
              "native-claude-feedback.jsonl",
            );
            vscode.window.showTextDocument(vscode.Uri.file(feedbackPath));
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
    // Always sync tool call state before full re-render to avoid races
    // where a postMessage update is lost during webview reload.
    this.activeToolCalls = this.toolCallTracker?.getActiveCalls() ?? [];

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
    this.state.masterBypass = this.getMasterBypass();
    // Send state via postMessage instead of full HTML replacement
    this.view?.webview.postMessage({ type: "stateUpdate", state: this.state });
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

  private getHtml(): string {
    const webview = this.view!.webview;
    const nonce = randomUUID().replace(/-/g, "");

    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "sidebar.js"),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "sidebar.css"),
    );

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};">
  <link rel="stylesheet" href="${styleUri}">
  <title>Native Claude</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" type="module" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
