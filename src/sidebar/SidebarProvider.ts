import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

import type {
  AgentToolCallTracker,
  TrackedCallInfo,
} from "../agent/AgentToolCallTracker.js";
import type {
  ApprovalManager,
  RuleScope,
} from "../approvals/ApprovalManager.js";
import type {
  IndexStatusInfo,
  SidebarState,
  WebviewCommand,
} from "./webview/types.js";
import { deleteFeedback, readFeedback } from "../util/feedbackStore.js";

import type { CommandRuleDecision } from "../approvals/CommandRuleStore.js";
import type { ContextHealthSnapshot } from "../shared/contextHealth.js";
import { editRuleViaQuickPick } from "./editRuleQuickPick.js";
import { getConfiguredMasterBypass } from "../adapters/vscode/agentLinkConfig.js";
import { renderWebviewShell } from "../adapters/vscode/webviewShell.js";
import { withPrimaryEditorColumn } from "../util/editorPlacement.js";

export type { SidebarState };

export class SidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "agentLink.statusView";

  private view: vscode.WebviewView | undefined;
  private state: SidebarState = {
    masterBypass: false,
    hasWorkspace: (vscode.workspace.workspaceFolders ?? []).length > 0,
  };
  private approvalManager: ApprovalManager | undefined;
  private toolCallTracker: AgentToolCallTracker | undefined;
  private activeToolCalls: TrackedCallInfo[] = [];
  private log: (msg: string) => void;

  constructor(
    private readonly extensionUri: vscode.Uri,
    log?: (msg: string) => void,
    private readonly showOutput?: () => void,
  ) {
    this.log = log ?? (() => {});
  }

  setApprovalManager(manager: ApprovalManager): void {
    this.approvalManager = manager;
    manager.onDidChange(() => this.refreshApprovalState());
  }

  setToolCallTracker(tracker: AgentToolCallTracker): void {
    this.toolCallTracker = tracker;
    tracker.on("change", () => this.refreshToolCalls());
  }

  private refreshToolCalls(): void {
    if (!this.toolCallTracker) return;
    this.activeToolCalls = this.toolCallTracker.getActiveCalls();
    this.log(
      `refreshToolCalls: ${this.activeToolCalls.length} active calls, view=${!!this.view}`,
    );
    // Send lightweight update to client instead of full re-render
    this.view?.webview.postMessage({
      type: "updateToolCalls",
      calls: this.activeToolCalls,
    });
    // Refresh feedback alongside tool activity in development builds.
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

  updateContextHealth(health: ContextHealthSnapshot): void {
    this.state.contextHealth = structuredClone(health);
    this.view?.webview.postMessage({
      type: "updateContextHealth",
      health,
    });
  }

  updateIndexStatus(status: IndexStatusInfo): void {
    this.state.indexStatus = status;
    this.view?.webview.postMessage({
      type: "updateIndexStatus",
      status,
    });
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

    // Refresh state when the sidebar becomes visible again — postMessage calls
    // are silently dropped while the webview is hidden (no retainContextWhenHidden).
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.restoreVisibleState();
      }
    });

    webviewView.onDidDispose(() => {
      this.view = undefined;
    });

    webviewView.webview.onDidReceiveMessage((message: WebviewCommand) => {
      switch (message.command) {
        case "webviewReady":
          this.log("Received webviewReady from Preact app");
          this.restoreVisibleState();
          break;
        case "openSettings":
          vscode.commands.executeCommand(
            "workbench.action.openSettings",
            "agentlink",
          );
          break;
        case "openOutput":
          if (this.showOutput) {
            this.showOutput();
          } else {
            vscode.commands.executeCommand("workbench.action.output.show");
          }
          break;
        case "openBrowserGateway":
          vscode.commands.executeCommand("agentlink.openBrowserGateway");
          break;
        case "setWriteApproval":
          if (this.approvalManager) {
            const mode = message.mode;
            // Reset everything first, then set the new level.
            // Keep legacy + agent tracks in sync for compatibility.
            this.approvalManager.resetWriteApproval();
            this.approvalManager.resetAgentWriteApproval();
            if (mode !== "prompt") {
              // For session scope, approve all active sessions
              if (mode === "session") {
                for (const s of this.approvalManager.getActiveSessions()) {
                  this.approvalManager.setWriteApproval(s.id, "session");
                  this.approvalManager.setAgentWriteApproval(s.id, "session");
                }
              } else {
                this.approvalManager.setWriteApproval("_sidebar", mode);
                this.approvalManager.setAgentWriteApproval("_sidebar", mode);
              }
            }
          }
          break;
        case "removeGlobalRule":
          if (message.pattern) {
            this.approvalManager?.removeCommandRule(
              message.pattern,
              "global",
              undefined,
              message.mode
                ? {
                    mode: message.mode as "prefix" | "regex" | "exact",
                    decision: message.decision,
                  }
                : undefined,
            );
          }
          break;
        case "editGlobalRule":
          if (message.pattern && message.mode) {
            this.editRule(
              message.pattern,
              message.mode,
              message.decision,
              "global",
            );
          }
          break;
        case "removeProjectRule":
          if (message.pattern) {
            this.approvalManager?.removeCommandRule(
              message.pattern,
              "project",
              undefined,
              message.mode
                ? {
                    mode: message.mode as "prefix" | "regex" | "exact",
                    decision: message.decision,
                  }
                : undefined,
            );
          }
          break;
        case "editProjectRule":
          if (message.pattern && message.mode) {
            this.editRule(
              message.pattern,
              message.mode,
              message.decision,
              "project",
            );
          }
          break;
        case "addGlobalRule":
          vscode.commands.executeCommand("agentlink.addTrustedCommand");
          break;
        case "removeSessionRule":
          if (message.sessionId && message.pattern) {
            this.approvalManager?.removeCommandRule(
              message.pattern,
              "session",
              message.sessionId,
              message.mode
                ? {
                    mode: message.mode as "prefix" | "regex" | "exact",
                    decision: message.decision,
                  }
                : undefined,
            );
          }
          break;
        case "editSessionRule":
          if (message.sessionId && message.pattern && message.mode) {
            this.editRule(
              message.pattern,
              message.mode,
              message.decision,
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
              "agentlink.cancelToolCall",
              message.id,
            );
          }
          break;
        case "completeToolCall":
          if (message.id) {
            vscode.commands.executeCommand(
              "agentlink.completeToolCall",
              message.id,
            );
          }
          break;
        case "continueToolCallInBackground":
          if (message.id) {
            vscode.commands.executeCommand(
              "agentlink.continueToolCallInBackground",
              message.id,
            );
          }
          break;
        case "clearAllSessions":
          vscode.commands.executeCommand("agentlink.clearSessionApprovals");
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
          if (__DEV_BUILD__) {
            deleteFeedback([message.index]);
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
              ".agentlink",
              "agentlink-feedback.jsonl",
            );
            vscode.window.showTextDocument(
              vscode.Uri.file(feedbackPath),
              withPrimaryEditorColumn(),
            );
          }
          break;
        // Codebase index commands
        case "rebuildIndex":
          vscode.commands.executeCommand("agentlink.rebuildIndex");
          break;
        case "cancelIndex":
          vscode.commands.executeCommand("agentlink.cancelIndex");
          break;
        case "resumeIndex":
          vscode.commands.executeCommand("agentlink.resumeIndex");
          break;
        case "setOpenaiApiKey":
          vscode.commands.executeCommand("agentlink.setOpenaiApiKey");
          break;
        case "setOpenaiModelsAndEmbeddingsApiKey":
          vscode.commands.executeCommand("agentlink.codexSignIn", "apiKeyOnly");
          break;
        case "setupSemanticSearch":
          vscode.commands.executeCommand(
            "agentlink.setupSemanticSearch",
            message.reason,
          );
          break;
      }
    });
  }

  private async editRule(
    oldPattern: string,
    oldMode: string,
    oldDecision: CommandRuleDecision | undefined,
    scope: RuleScope,
    sessionId?: string,
  ): Promise<void> {
    if (!this.approvalManager) return;
    const result = await editRuleViaQuickPick({
      oldPattern,
      oldMode,
      title: "Edit rule pattern, then pick match mode",
      modes: [
        {
          label: "$(symbol-text) Prefix Match",
          mode: "prefix" as const,
          alwaysShow: true as const,
        },
        {
          label: "$(symbol-key) Exact Match",
          mode: "exact" as const,
          alwaysShow: true as const,
        },
        {
          label: "$(regex) Regex Match",
          mode: "regex" as const,
          alwaysShow: true as const,
        },
      ],
    });
    if (!result) return;
    const decisions: Array<
      vscode.QuickPickItem & { decision: CommandRuleDecision | undefined }
    > = [
      {
        label: "Approval only (legacy)",
        description: "Skip repeat cards without granting native authority",
        decision: undefined,
        picked: oldDecision === undefined,
      },
      {
        label: result.mode === "regex" ? "Allow (sandboxed)" : "Allow (native)",
        description:
          result.mode === "regex"
            ? "Skip review but retain the Protected Terminal"
            : "Skip review and use normal user permissions when every segment matches",
        decision: "allow",
        picked: oldDecision === "allow",
      },
      {
        label: "Prompt",
        description: "Require the selected reviewer for matching commands",
        decision: "prompt",
        picked: oldDecision === "prompt",
      },
      {
        label: "Forbidden",
        description: "Reject matching commands before terminal preparation",
        decision: "forbidden",
        picked: oldDecision === "forbidden",
      },
    ];
    const decision = await vscode.window.showQuickPick(decisions, {
      title: "Rule Decision",
      placeHolder: "What should matching commands do?",
      ignoreFocusOut: true,
    });
    if (!decision) return;
    this.approvalManager.editCommandRule(
      oldPattern,
      { ...result, decision: decision.decision },
      scope,
      sessionId,
      {
        mode: oldMode as "prefix" | "regex" | "exact",
        decision: oldDecision,
      },
    );
  }

  private async editPathRule(
    oldPattern: string,
    oldMode: string,
    scope: RuleScope,
    sessionId?: string,
  ): Promise<void> {
    if (!this.approvalManager) return;
    const result = await editRuleViaQuickPick({
      oldPattern,
      oldMode,
      title: "Edit path pattern, then pick match mode",
      modes: [
        {
          label: "$(symbol-misc) Glob Match",
          mode: "glob" as const,
          alwaysShow: true as const,
        },
        {
          label: "$(symbol-text) Prefix Match",
          mode: "prefix" as const,
          alwaysShow: true as const,
        },
        {
          label: "$(symbol-key) Exact Match",
          mode: "exact" as const,
          alwaysShow: true as const,
        },
      ],
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
    const result = await editRuleViaQuickPick({
      oldPattern,
      oldMode,
      title: "Edit write rule pattern, then pick match mode",
      modes: [
        {
          label: "$(symbol-misc) Glob Match",
          mode: "glob" as const,
          alwaysShow: true as const,
        },
        {
          label: "$(symbol-text) Prefix Match",
          mode: "prefix" as const,
          alwaysShow: true as const,
        },
        {
          label: "$(symbol-key) Exact Match",
          mode: "exact" as const,
          alwaysShow: true as const,
        },
      ],
    });
    if (result) {
      this.approvalManager.editWriteRule(oldPattern, result, scope, sessionId);
    }
  }

  private restoreVisibleState(): void {
    this.refreshApprovalState();
    this.refreshToolCalls();
  }

  private refreshApprovalState(): void {
    // Always sync tool call state before full re-render to avoid races
    // where a postMessage update is lost during webview reload.
    this.activeToolCalls = this.toolCallTracker?.getActiveCalls() ?? [];

    if (this.approvalManager) {
      const sessions = this.approvalManager.getActiveSessions();
      // Show the "best" write approval state across all sessions.
      // Consider both legacy write approval and agent write approval tracks.
      const agentWriteState =
        this.approvalManager.getAgentWriteApprovalState("_none");
      const legacyWriteState =
        this.approvalManager.getWriteApprovalState("_none");
      if (
        agentWriteState === "global" ||
        agentWriteState === "project" ||
        legacyWriteState === "global" ||
        legacyWriteState === "project"
      ) {
        this.state.writeApproval =
          agentWriteState === "global" || legacyWriteState === "global"
            ? "global"
            : "project";
      } else if (
        sessions.some((s) => s.writeApproved || s.agentWriteApproved)
      ) {
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
        agentWriteApproved: s.agentWriteApproved,
        commandRules: this.approvalManager!.getCommandRules(s.id).session,
        pathRules: this.approvalManager!.getPathRules(s.id).session,
        writeRules: this.approvalManager!.getWriteRules(s.id).session,
      }));
    }
    this.state.masterBypass = getConfiguredMasterBypass();
    // Send state via postMessage instead of full HTML replacement
    this.view?.webview.postMessage({ type: "stateUpdate", state: this.state });
  }

  private getHtml(): string {
    const webview = this.view!.webview;
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "sidebar.js"),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "sidebar.css"),
    );

    return renderWebviewShell({
      title: "AgentLink",
      cspSource: webview.cspSource,
      scriptUri: scriptUri.toString(),
      styleUris: [styleUri.toString()],
    });
  }
}
