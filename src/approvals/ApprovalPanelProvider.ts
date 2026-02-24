import * as vscode from "vscode";
import * as path from "path";
import { randomUUID } from "crypto";

// ── Response types ──────────────────────────────────────────────────────────

export interface CommandApprovalResponse {
  decision: "run-once" | "edit" | "session" | "project" | "global" | "reject";
  editedCommand?: string;
  rejectionReason?: string;
  rulePattern?: string;
  ruleMode?: "prefix" | "exact" | "regex";
  /** For compound commands: per-sub-command rules */
  rules?: Array<{
    pattern: string;
    mode: "prefix" | "exact" | "regex" | "skip";
  }>;
}

export interface PathApprovalResponse {
  decision:
    | "allow-once"
    | "allow-session"
    | "allow-project"
    | "allow-always"
    | "reject";
  rejectionReason?: string;
  rulePattern?: string;
  ruleMode?: "glob" | "prefix" | "exact";
}

export interface WriteApprovalResponse {
  decision:
    | "accept"
    | "reject"
    | "accept-session"
    | "accept-project"
    | "accept-always";
  rejectionReason?: string;
  /** For trust decisions: scope of the rule */
  trustScope?: "all-files" | "this-file" | "pattern";
  rulePattern?: string;
  ruleMode?: "glob" | "prefix" | "exact";
}

// ── Internal types ──────────────────────────────────────────────────────────

interface ApprovalRequest {
  kind: "command" | "path" | "write";
  id: string;
  /** For commands: the sub-command needing approval */
  command?: string;
  /** For commands: the full compound command */
  fullCommand?: string;
  /** For paths/writes: the file path */
  filePath?: string;
  /** For compound commands: the individual sub-commands */
  subCommands?: string[];
  /** For writes: create or modify */
  writeOperation?: "create" | "modify";
  /** For writes: whether the file is outside workspace */
  outsideWorkspace?: boolean;
}

interface QueueEntry {
  request: ApprovalRequest;
  resolve: (value: unknown) => void;
}

type ApprovalPosition = "beside" | "panel";

// ── Provider ────────────────────────────────────────────────────────────────

export class ApprovalPanelProvider
  implements vscode.WebviewViewProvider, vscode.Disposable
{
  public static readonly viewType = "nativeClaude.approvalView";

  // Container references (only one is active at a time)
  private panel: vscode.WebviewPanel | undefined;
  private view: vscode.WebviewView | undefined;

  // Queue
  private queue: QueueEntry[] = [];
  private currentEntry: QueueEntry | undefined;

  // Alert
  private alertDisposable: vscode.Disposable | undefined;
  private statusBar: vscode.StatusBarItem;

  // Listener cleanup for panel mode
  private viewMessageDisposable: vscode.Disposable | undefined;

  constructor(private readonly extensionUri: vscode.Uri) {
    this.statusBar = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      9999,
    );
    this.statusBar.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.warningBackground",
    );
    this.statusBar.command = "nativeClaude.approvalView.focus";
  }

  // ── WebviewViewProvider (for "panel" mode) ──────────────────────────────

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.getIdleHtml(webviewView.webview);

    // If there's a pending approval waiting for the view to resolve, show it.
    // We need to show + focus explicitly since the initial showCurrentApproval()
    // bailed out before the view existed, so it never got revealed.
    if (this.currentEntry && this.getPosition() !== "beside") {
      this.showCurrentApproval();
      webviewView.show(false);
      vscode.commands.executeCommand("nativeClaude.approvalView.focus");
    }
  }

  // ── Public API ──────────────────────────────────────────────────────────

  enqueueCommandApproval(
    command: string,
    fullCommand: string,
    options?: { subCommands?: string[] },
  ): { promise: Promise<CommandApprovalResponse>; id: string } {
    const id = randomUUID();
    const promise = this.enqueue({
      kind: "command",
      id,
      command,
      fullCommand,
      subCommands: options?.subCommands,
    }) as Promise<CommandApprovalResponse>;
    return { promise, id };
  }

  enqueuePathApproval(filePath: string): {
    promise: Promise<PathApprovalResponse>;
    id: string;
  } {
    const id = randomUUID();
    const promise = this.enqueue({
      kind: "path",
      id,
      filePath,
    }) as Promise<PathApprovalResponse>;
    return { promise, id };
  }

  enqueueWriteApproval(
    relPath: string,
    options: { operation: "create" | "modify"; outsideWorkspace: boolean },
  ): { promise: Promise<WriteApprovalResponse>; id: string } {
    const id = randomUUID();
    const promise = this.enqueue({
      kind: "write",
      id,
      filePath: relPath,
      writeOperation: options.operation,
      outsideWorkspace: options.outsideWorkspace,
    }) as Promise<WriteApprovalResponse>;
    return { promise, id };
  }

  /**
   * Cancel a pending approval by ID.
   * Used when an external event (e.g. diff title bar button) resolves
   * the decision before the panel does.
   */
  cancelApproval(id: string): void {
    if (this.currentEntry?.request.id === id) {
      this.alertDisposable?.dispose();
      this.alertDisposable = undefined;
      const entry = this.currentEntry;
      this.currentEntry = undefined;
      entry.resolve(this.makeRejectResponse(entry.request.kind));
      this.processQueue();
      return;
    }
    const idx = this.queue.findIndex((e) => e.request.id === id);
    if (idx !== -1) {
      const entry = this.queue.splice(idx, 1)[0];
      entry.resolve(this.makeRejectResponse(entry.request.kind));
      this.updatePendingCount();
    }
  }

  private makeRejectResponse(
    kind: ApprovalRequest["kind"],
  ): CommandApprovalResponse | PathApprovalResponse | WriteApprovalResponse {
    if (kind === "command") return { decision: "reject" };
    if (kind === "write") return { decision: "reject" };
    return { decision: "reject" };
  }

  // ── Queue management ────────────────────────────────────────────────────

  private enqueue(request: ApprovalRequest): Promise<unknown> {
    return new Promise((resolve) => {
      this.queue.push({ request, resolve });
      this.updatePendingCount();
      this.processQueue();
    });
  }

  private processQueue(): void {
    if (this.currentEntry) return;
    if (this.queue.length === 0) {
      this.onQueueEmpty();
      return;
    }

    this.currentEntry = this.queue.shift()!;
    this.updatePendingCount();
    this.showCurrentApproval();
  }

  private showCurrentApproval(): void {
    if (!this.currentEntry) return;

    const { request } = this.currentEntry;

    // Always show alert and focus window, even if webview isn't ready yet
    this.alertDisposable?.dispose();
    this.alertDisposable = this.showAlert(
      request.kind === "command"
        ? "Command approval required"
        : request.kind === "write"
          ? "Write approval required"
          : "Path access approval required",
    );
    vscode.commands.executeCommand("workbench.action.focusWindow");

    const position = this.getPosition();
    const webview = this.ensureWebview(position);
    if (!webview) {
      // Panel mode but view not yet resolved — force VS Code to reveal the
      // view container, which triggers resolveWebviewView, which re-calls us.
      vscode.commands.executeCommand("nativeClaude.approvalView.focus");
      return;
    }

    const queuePosition = 1;
    const queueTotal = 1 + this.queue.length;

    webview.html = this.getApprovalHtml(
      webview,
      request,
      queuePosition,
      queueTotal,
    );

    // Reveal and focus
    if (position === "beside") {
      this.panel!.reveal(vscode.ViewColumn.Beside, false);
    } else if (this.view) {
      this.view.show(false);
      vscode.commands.executeCommand("nativeClaude.approvalView.focus");
    }
  }

  private handleMessage(message: {
    type: string;
    id?: string;
    decision?: string;
    editedCommand?: string;
    rejectionReason?: string;
    rulePattern?: string;
    ruleMode?: string;
    rules?: Array<{ pattern: string; mode: string }>;
    trustScope?: string;
  }): void {
    if (message.type !== "decision") return;
    if (!this.currentEntry || message.id !== this.currentEntry.request.id)
      return;

    this.alertDisposable?.dispose();
    this.alertDisposable = undefined;

    const entry = this.currentEntry;
    this.currentEntry = undefined;

    if (entry.request.kind === "command") {
      const response: CommandApprovalResponse = {
        decision: message.decision as CommandApprovalResponse["decision"],
        editedCommand: message.editedCommand,
        rejectionReason: message.rejectionReason || undefined,
        rulePattern: message.rulePattern || undefined,
        ruleMode: message.ruleMode as
          | CommandApprovalResponse["ruleMode"]
          | undefined,
        rules: message.rules as CommandApprovalResponse["rules"],
      };
      entry.resolve(response);
    } else if (entry.request.kind === "write") {
      const response: WriteApprovalResponse = {
        decision: message.decision as WriteApprovalResponse["decision"],
        rejectionReason: message.rejectionReason || undefined,
        trustScope: message.trustScope as WriteApprovalResponse["trustScope"],
        rulePattern: message.rulePattern || undefined,
        ruleMode: message.ruleMode as WriteApprovalResponse["ruleMode"],
      };
      entry.resolve(response);
    } else {
      const response: PathApprovalResponse = {
        decision: message.decision as PathApprovalResponse["decision"],
        rejectionReason: message.rejectionReason || undefined,
        rulePattern: message.rulePattern || undefined,
        ruleMode: message.ruleMode as
          | PathApprovalResponse["ruleMode"]
          | undefined,
      };
      entry.resolve(response);
    }

    this.processQueue();
  }

  private rejectCurrent(reason?: string): void {
    if (!this.currentEntry) return;
    this.alertDisposable?.dispose();
    this.alertDisposable = undefined;

    const entry = this.currentEntry;
    this.currentEntry = undefined;

    if (entry.request.kind === "command") {
      entry.resolve({
        decision: "reject",
        rejectionReason: reason,
      } as CommandApprovalResponse);
    } else {
      entry.resolve({
        decision: "reject",
        rejectionReason: reason,
      } as PathApprovalResponse);
    }
  }

  private rejectAll(): void {
    this.rejectCurrent();
    for (const entry of this.queue) {
      if (entry.request.kind === "command") {
        entry.resolve({ decision: "reject" } as CommandApprovalResponse);
      } else {
        entry.resolve({ decision: "reject" } as PathApprovalResponse);
      }
    }
    this.queue = [];
    this.updatePendingCount();
  }

  private onQueueEmpty(): void {
    this.alertDisposable?.dispose();
    this.alertDisposable = undefined;
    this.statusBar.hide();

    const position = this.getPosition();
    if (position === "beside") {
      // Dispose the panel entirely when queue empties
      this.panel?.dispose();
      this.panel = undefined;
    } else if (this.view) {
      // Show idle state
      this.view.webview.html = this.getIdleHtml(this.view.webview);
    }
  }

  // ── Webview lifecycle ───────────────────────────────────────────────────

  private getPosition(): ApprovalPosition {
    return (
      vscode.workspace
        .getConfiguration("native-claude")
        .get<ApprovalPosition>("approvalPosition") ?? "beside"
    );
  }

  private ensureWebview(
    position: ApprovalPosition,
  ): vscode.Webview | undefined {
    if (position === "beside") {
      if (!this.panel) {
        this.panel = vscode.window.createWebviewPanel(
          "nativeClaude.approval",
          "Approval Required",
          { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
          {
            enableScripts: true,
            localResourceRoots: [this.extensionUri],
          },
        );
        this.panel.iconPath = vscode.Uri.joinPath(
          this.extensionUri,
          "media",
          "claude.svg",
        );
        this.panel.onDidDispose(() => {
          this.panel = undefined;
          this.rejectAll();
        });
        this.panel.webview.onDidReceiveMessage((msg) =>
          this.handleMessage(msg),
        );
      }
      return this.panel.webview;
    }

    // Panel mode
    if (this.view) {
      // Re-register message listener (only once per view)
      this.viewMessageDisposable?.dispose();
      this.viewMessageDisposable = this.view.webview.onDidReceiveMessage(
        (msg) => this.handleMessage(msg),
      );
      return this.view.webview;
    }

    // View not yet resolved — will be handled in resolveWebviewView
    return undefined;
  }

  // ── Alert ───────────────────────────────────────────────────────────────

  private showAlert(message: string): vscode.Disposable {
    const alertBar = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      10000,
    );
    alertBar.text = `$(alert) ${message}`;
    alertBar.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.warningBackground",
    );
    alertBar.show();

    let flash = true;
    const interval = setInterval(() => {
      flash = !flash;
      alertBar.text = flash ? `$(alert) ${message}` : `     ${message}`;
    }, 800);

    return {
      dispose() {
        clearInterval(interval);
        alertBar.dispose();
      },
    };
  }

  private updatePendingCount(): void {
    const pending = this.queue.length;
    if (pending > 0) {
      this.statusBar.text = `$(ellipsis) ${pending} more approval${pending > 1 ? "s" : ""} pending`;
      this.statusBar.show();
    } else {
      this.statusBar.hide();
    }
  }

  // ── HTML generation ─────────────────────────────────────────────────────

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  private getCodiconsUri(webview: vscode.Webview): vscode.Uri {
    return webview.asWebviewUri(
      vscode.Uri.joinPath(
        this.extensionUri,
        "node_modules",
        "@vscode/codicons",
        "dist",
        "codicon.css",
      ),
    );
  }

  private getIdleHtml(webview: vscode.Webview): string {
    const codiconsUri = this.getCodiconsUri(webview);
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${codiconsUri}" rel="stylesheet" />
  <style>${this.getStyles()}</style>
</head>
<body>
  <div class="idle">
    <span class="codicon codicon-check"></span>
    <p>No pending approvals</p>
  </div>
</body>
</html>`;
  }

  private getApprovalHtml(
    webview: vscode.Webview,
    request: ApprovalRequest,
    position: number,
    total: number,
  ): string {
    const codiconsUri = this.getCodiconsUri(webview);
    const badge = total > 1 ? `${position} of ${total}` : "";
    const content =
      request.kind === "command"
        ? this.getCommandCardHtml(request)
        : request.kind === "write"
          ? this.getWriteCardHtml(request)
          : this.getPathCardHtml(request);

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${codiconsUri}" rel="stylesheet" />
  <style>${this.getStyles()}</style>
</head>
<body>
  <div class="header">
    <span class="header-title"><span class="codicon codicon-warning"></span> APPROVAL REQUIRED</span>
    ${badge ? `<span class="badge">${badge}</span>` : ""}
  </div>
  <div id="mainCard">
    ${content}
  </div>
  <div id="rejectionReason" class="expandable" style="display:none">
    ${this.getRejectionReasonHtml()}
  </div>
  <script>${this.getScript(request)}</script>
</body>
</html>`;
  }

  private getCommandCardHtml(request: ApprovalRequest): string {
    const escapedCommand = this.escapeHtml(request.command ?? "");
    const defaultPattern = this.escapeHtml(request.command ?? "");
    const subs = request.subCommands ?? [];
    const isCompound = subs.length > 1;

    // Build the inline pattern editor: single-entry for simple commands, multi-entry for compound
    let patternEditorHtml: string;
    if (isCompound) {
      const entries = subs
        .map(
          (sub, i) => `
        <div class="pattern-row">
          <input type="text" class="text-input pattern-input" value="${this.escapeHtml(sub)}" data-index="${i}" />
          <div class="pattern-row-modes">
            <button type="button" class="mode-btn active" data-index="${i}" data-mode="prefix">Prefix</button>
            <button type="button" class="mode-btn" data-index="${i}" data-mode="exact">Exact</button>
            <button type="button" class="mode-btn" data-index="${i}" data-mode="regex">Regex</button>
            <button type="button" class="mode-btn" data-index="${i}" data-mode="skip">Skip</button>
          </div>
        </div>`,
        )
        .join("\n");
      patternEditorHtml = `
      <div id="inlinePatternEditor" class="inline-pattern-editor" style="display:none">
        <div id="trustLevelHeader" class="trust-level-header"></div>
        ${entries}
        <div class="button-row" style="margin-top:12px">
          <button class="btn btn-primary" onclick="confirmPatterns()">
            <span class="codicon codicon-check"></span> Confirm All
          </button>
          <button class="btn btn-secondary" onclick="cancelInlinePattern()">Cancel</button>
        </div>
      </div>`;
    } else {
      patternEditorHtml = `
      <div id="inlinePatternEditor" class="inline-pattern-editor" style="display:none">
        <div class="field">
          <label for="patternInput">Pattern:</label>
          <input type="text" id="patternInput" value="${defaultPattern}" class="text-input" />
        </div>
        <div class="field">
          <label>Match mode:</label>
          <div class="radio-group">
            <label class="radio-label"><input type="radio" name="mode" value="prefix" checked /> Prefix</label>
            <label class="radio-label"><input type="radio" name="mode" value="exact" /> Exact</label>
            <label class="radio-label"><input type="radio" name="mode" value="regex" /> Regex</label>
          </div>
        </div>
        <div class="button-row">
          <button class="btn btn-primary" onclick="confirmPattern()">
            <span class="codicon codicon-check"></span> Confirm
          </button>
          <button class="btn btn-secondary" onclick="cancelInlinePattern()">Cancel</button>
        </div>
      </div>`;
    }

    return `
    <div class="terminal-box">
      <div class="terminal-header">
        <span class="codicon codicon-terminal"></span>
        <span>Command</span>
        <span id="editedBadge" class="edited-badge" style="display:none">
          <span class="codicon codicon-edit"></span> modified
        </span>
      </div>
      <div class="terminal-body">
        <span class="terminal-prompt">$</span>
        <textarea id="commandInput" class="terminal-input" spellcheck="false">${escapedCommand}</textarea>
      </div>
    </div>
    <div class="button-row">
      <button class="btn btn-primary" onclick="onAction('run-once')">
        <span class="codicon codicon-play"></span> Run
      </button>
      <button class="btn btn-danger" onclick="onAction('reject')">
        <span class="codicon codicon-close"></span> Reject
      </button>
    </div>
    <div class="trust-section">
      <div class="trust-label">Trust for future:</div>
      <div id="trustButtons" class="button-row">
        <button class="btn btn-outline" onclick="onAction('session')">
          <span class="codicon codicon-check"></span> Session
        </button>
        <button class="btn btn-outline" onclick="onAction('project')">
          <span class="codicon codicon-folder"></span> Project
        </button>
        <button class="btn btn-outline" onclick="onAction('global')">
          <span class="codicon codicon-globe"></span> Always
        </button>
      </div>
      ${patternEditorHtml}
    </div>`;
  }

  private getPathCardHtml(request: ApprovalRequest): string {
    const defaultPattern = this.escapeHtml(
      request.filePath ? path.dirname(request.filePath) + "/" : "",
    );
    return `
    <div class="card-label">Outside Workspace Access</div>
    <pre class="command-box">${this.escapeHtml(request.filePath ?? "")}</pre>
    <div class="button-row">
      <button class="btn btn-primary" onclick="onAction('allow-once')">
        <span class="codicon codicon-unlock"></span> Allow Once
      </button>
      <button class="btn btn-danger" onclick="onAction('reject')">
        <span class="codicon codicon-close"></span> Reject
      </button>
    </div>
    <div class="trust-section">
      <div class="trust-label">Trust for future:</div>
      <div id="trustButtons" class="button-row">
        <button class="btn btn-outline" onclick="onAction('allow-session')">
          <span class="codicon codicon-check"></span> Session
        </button>
        <button class="btn btn-outline" onclick="onAction('allow-project')">
          <span class="codicon codicon-folder"></span> Project
        </button>
        <button class="btn btn-outline" onclick="onAction('allow-always')">
          <span class="codicon codicon-globe"></span> Always
        </button>
      </div>
      <div id="inlinePatternEditor" class="inline-pattern-editor" style="display:none">
        <div class="field">
          <label for="patternInput">Pattern:</label>
          <input type="text" id="patternInput" value="${defaultPattern}" class="text-input" />
        </div>
        <div class="field">
          <label>Match mode:</label>
          <div class="radio-group">
            <label class="radio-label"><input type="radio" name="mode" value="prefix" checked /> Prefix</label>
            <label class="radio-label"><input type="radio" name="mode" value="exact" /> Exact</label>
            <label class="radio-label"><input type="radio" name="mode" value="glob" /> Glob</label>
          </div>
        </div>
        <div class="button-row">
          <button class="btn btn-primary" onclick="confirmPattern()">
            <span class="codicon codicon-check"></span> Confirm
          </button>
          <button class="btn btn-secondary" onclick="cancelInlinePattern()">Cancel</button>
        </div>
      </div>
    </div>`;
  }

  private getWriteCardHtml(request: ApprovalRequest): string {
    const filePath = this.escapeHtml(request.filePath ?? "");
    const op = request.writeOperation ?? "modify";
    const opIcon = op === "create" ? "codicon-new-file" : "codicon-edit";
    const outside = request.outsideWorkspace ?? false;
    const defaultPattern = this.escapeHtml(
      request.filePath ? path.dirname(request.filePath) + "/" : "",
    );

    // Scope options: in-workspace gets radio choices; outside-workspace goes straight to pattern
    const scopeOptionsHtml = outside
      ? ""
      : `
      <div id="scopeOptions" class="field">
        <label>Scope:</label>
        <div class="radio-group">
          <label class="radio-label"><input type="radio" name="scope" value="all-files" checked /> All files</label>
          <label class="radio-label"><input type="radio" name="scope" value="this-file" /> This file only</label>
          <label class="radio-label"><input type="radio" name="scope" value="pattern" /> Custom pattern</label>
        </div>
      </div>`;

    return `
    <div class="file-card">
      <div class="file-card-header">
        <span class="codicon ${opIcon}"></span>
        <span class="file-path">${filePath}</span>
        <span class="operation-badge ${op}">${op}</span>
      </div>
      ${outside ? '<div class="outside-badge"><span class="codicon codicon-warning"></span> Outside workspace</div>' : ""}
    </div>
    <div class="button-row">
      <button class="btn btn-primary" onclick="onAction('accept')">
        <span class="codicon codicon-check"></span> Accept
      </button>
      <button class="btn btn-danger" onclick="onAction('reject')">
        <span class="codicon codicon-close"></span> Reject
      </button>
    </div>
    <div class="trust-section">
      <div class="trust-label">Trust for future writes:</div>
      <div id="trustButtons" class="button-row">
        <button class="btn btn-outline" onclick="onAction('accept-session')">
          <span class="codicon codicon-check"></span> Session
        </button>
        <button class="btn btn-outline" onclick="onAction('accept-project')">
          <span class="codicon codicon-folder"></span> Project
        </button>
        <button class="btn btn-outline" onclick="onAction('accept-always')">
          <span class="codicon codicon-globe"></span> Always
        </button>
      </div>
      <div id="inlinePatternEditor" class="inline-pattern-editor" style="display:none">
        ${scopeOptionsHtml}
        <div id="patternFields" ${outside ? "" : 'style="display:none"'}>
          <div class="field">
            <label for="patternInput">Pattern:</label>
            <input type="text" id="patternInput" value="${defaultPattern}" class="text-input" />
          </div>
          <div class="field">
            <label>Match mode:</label>
            <div class="radio-group">
              <label class="radio-label"><input type="radio" name="mode" value="glob" checked /> Glob</label>
              <label class="radio-label"><input type="radio" name="mode" value="prefix" /> Prefix</label>
              <label class="radio-label"><input type="radio" name="mode" value="exact" /> Exact</label>
            </div>
          </div>
        </div>
        <div class="button-row">
          <button class="btn btn-primary" onclick="confirmWritePattern()">
            <span class="codicon codicon-check"></span> Confirm
          </button>
          <button class="btn btn-secondary" onclick="cancelInlinePattern()">Cancel</button>
        </div>
      </div>
    </div>`;
  }

  private getRejectionReasonHtml(): string {
    return `
    <div class="expandable-title">Rejection Reason (optional)</div>
    <div class="field">
      <textarea id="reasonInput" class="text-input textarea" rows="3" placeholder="Tell Claude why you rejected this..."></textarea>
    </div>
    <div class="button-row">
      <button class="btn btn-primary" onclick="submitRejection()">Submit</button>
      <button class="btn btn-secondary" onclick="skipRejection()">Skip</button>
    </div>`;
  }

  private getScript(request: ApprovalRequest): string {
    return `
    const vscode = acquireVsCodeApi();
    const requestId = "${request.id}";
    const requestKind = "${request.kind}";
    const subCommands = ${JSON.stringify(request.subCommands ?? [])};
    const isCompound = subCommands.length > 1;
    const originalCommand = ${JSON.stringify(request.command ?? "")};

    let pendingDecision = null;

    // Track command edits and auto-resize textarea
    (function() {
      const input = document.getElementById('commandInput');
      if (!input) return;
      const badge = document.getElementById('editedBadge');
      input.addEventListener('input', () => {
        const edited = input.value !== originalCommand;
        badge.style.display = edited ? '' : 'none';
        input.classList.toggle('edited', edited);
      });
      function autoResize() {
        input.style.height = 'auto';
        input.style.height = input.scrollHeight + 'px';
      }
      input.addEventListener('input', autoResize);
      autoResize();
    })();

    function onAction(decision) {
      if (decision === 'reject') {
        pendingDecision = 'reject';
        showSection('rejectionReason');
        const el = document.getElementById('reasonInput');
        if (el) el.focus();
        return;
      }
      // Trust decisions — show inline pattern editor (single or multi-entry)
      if (['session', 'project', 'global',
           'allow-session', 'allow-project', 'allow-always',
           'accept-session', 'accept-project', 'accept-always'].includes(decision)) {
        pendingDecision = decision;
        showInlinePatternEditor();
        return;
      }
      // Run once / allow once — check for command edits
      if (decision === 'run-once') {
        const input = document.getElementById('commandInput');
        if (input && input.value !== originalCommand) {
          submit({ decision: 'edit', editedCommand: input.value.trim() });
          return;
        }
      }
      submit({ decision });
    }

    function showSection(sectionId) {
      document.getElementById('mainCard').style.display = 'none';
      document.getElementById('rejectionReason').style.display = 'none';
      document.getElementById(sectionId).style.display = '';
    }

    function cancelExpanded() {
      pendingDecision = null;
      document.getElementById('mainCard').style.display = '';
      document.getElementById('rejectionReason').style.display = 'none';
    }

    function showInlinePatternEditor() {
      document.getElementById('trustButtons').style.display = 'none';
      document.getElementById('inlinePatternEditor').style.display = '';
      // Show trust level in header for compound commands
      const header = document.getElementById('trustLevelHeader');
      if (header && pendingDecision) {
        const labels = {
          session: 'Session', project: 'Project', global: 'Always',
          'accept-session': 'Session', 'accept-project': 'Project', 'accept-always': 'Always',
          'allow-session': 'Session', 'allow-project': 'Project', 'allow-always': 'Always',
        };
        header.textContent = 'Trust for ' + (labels[pendingDecision] || pendingDecision);
      }
      const el = document.getElementById('patternInput');
      if (el) { el.focus(); el.select(); }
      // Focus first pattern input for compound
      const firstInput = document.querySelector('.pattern-input');
      if (firstInput && !el) { firstInput.focus(); firstInput.select(); }
    }

    function cancelInlinePattern() {
      pendingDecision = null;
      document.getElementById('trustButtons').style.display = '';
      document.getElementById('inlinePatternEditor').style.display = 'none';
    }

    function confirmPattern() {
      const pattern = document.getElementById('patternInput').value.trim();
      if (!pattern) return;
      const mode = document.querySelector('input[name="mode"]:checked')?.value;
      const data = { decision: pendingDecision, rulePattern: pattern, ruleMode: mode };
      // Include edited command if applicable
      const input = document.getElementById('commandInput');
      if (input && input.value !== originalCommand) {
        data.editedCommand = input.value.trim();
      }
      submit(data);
    }

    function confirmPatterns() {
      const rows = document.querySelectorAll('.pattern-row');
      const rules = [];
      rows.forEach((row) => {
        const pattern = row.querySelector('.pattern-input').value.trim();
        const activeBtn = row.querySelector('.mode-btn.active');
        const mode = activeBtn ? activeBtn.dataset.mode : 'prefix';
        rules.push({ pattern, mode });
      });
      const data = { decision: pendingDecision, rules };
      // Include edited command if applicable
      const input = document.getElementById('commandInput');
      if (input && input.value !== originalCommand) {
        data.editedCommand = input.value.trim();
      }
      submit(data);
    }

    // Mode button toggle for compound pattern rows
    document.addEventListener('click', function(e) {
      const btn = e.target.closest('.mode-btn');
      if (!btn) return;
      const row = btn.closest('.pattern-row');
      if (!row) return;
      row.querySelectorAll('.mode-btn').forEach(function(b) { b.classList.remove('active'); });
      btn.classList.add('active');
      // If "Skip" is selected, dim the input
      const input = row.querySelector('.pattern-input');
      if (input) {
        input.classList.toggle('skipped', btn.dataset.mode === 'skip');
      }
    });

    function confirmWritePattern() {
      const scopeRadio = document.querySelector('input[name="scope"]:checked');
      const scope = scopeRadio ? scopeRadio.value : 'pattern';
      const data = { decision: pendingDecision, trustScope: scope };
      if (scope === 'pattern') {
        const pattern = document.getElementById('patternInput')?.value.trim();
        if (!pattern) return;
        const mode = document.querySelector('input[name="mode"]:checked')?.value || 'glob';
        data.rulePattern = pattern;
        data.ruleMode = mode;
      }
      submit(data);
    }

    // Write scope radio — toggle pattern fields visibility
    (function() {
      document.querySelectorAll('input[name="scope"]').forEach(function(radio) {
        radio.addEventListener('change', function() {
          const patternFields = document.getElementById('patternFields');
          if (patternFields) {
            patternFields.style.display = radio.value === 'pattern' ? '' : 'none';
          }
        });
      });
    })();

    function submitRejection() {
      const reason = document.getElementById('reasonInput').value.trim() || undefined;
      submit({ decision: 'reject', rejectionReason: reason });
    }

    function skipRejection() {
      submit({ decision: 'reject' });
    }

    function submit(data) {
      vscode.postMessage({ type: 'decision', id: requestId, ...data });
    }

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        // If inline pattern editor is open, close it first
        const inlineEditor = document.getElementById('inlinePatternEditor');
        if (inlineEditor && inlineEditor.style.display !== 'none') {
          cancelInlinePattern();
          e.preventDefault();
          return;
        }
        // If rejection reason is open, close it
        const mainCard = document.getElementById('mainCard');
        if (mainCard && mainCard.style.display === 'none') {
          cancelExpanded();
          e.preventDefault();
        }
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        const active = document.activeElement;
        if (active && active.tagName === 'TEXTAREA') return;
        const inlineEditor = document.getElementById('inlinePatternEditor');
        if (inlineEditor && inlineEditor.style.display !== 'none') {
          if (requestKind === 'write') {
            confirmWritePattern();
          } else if (isCompound) {
            confirmPatterns();
          } else {
            confirmPattern();
          }
          e.preventDefault();
        }
      }
    });
    `;
  }

  private getStyles(): string {
    return `
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      padding: 16px;
    }
    .idle {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100vh;
      opacity: 0.5;
      gap: 8px;
    }
    .idle .codicon { font-size: 32px; }
    .idle p { font-size: 13px; }

    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 16px;
      padding-bottom: 12px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .header-title {
      font-weight: 600;
      font-size: 14px;
      color: var(--vscode-editorWarning-foreground, #cca700);
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .badge {
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      padding: 2px 8px;
      border-radius: 10px;
      font-size: 11px;
      font-weight: 600;
    }

    .card-label {
      font-weight: 600;
      font-size: 13px;
      margin-bottom: 10px;
      color: var(--vscode-descriptionForeground);
    }

    /* File write card */
    .file-card {
      background: var(--vscode-textCodeBlock-background, var(--vscode-editor-background));
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      padding: 12px;
      margin-bottom: 16px;
    }
    .file-card-header {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .file-card-header .codicon {
      font-size: 16px;
      color: var(--vscode-symbolIcon-fileForeground, var(--vscode-foreground));
    }
    .file-path {
      font-family: var(--vscode-editor-font-family);
      font-size: var(--vscode-editor-font-size);
      word-break: break-all;
    }
    .operation-badge {
      margin-left: auto;
      font-size: 11px;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: 10px;
      text-transform: uppercase;
      flex-shrink: 0;
    }
    .operation-badge.modify {
      background: var(--vscode-editorWarning-foreground, #cca700);
      color: #000;
    }
    .operation-badge.create {
      background: var(--vscode-terminal-ansiGreen, #4ec9b0);
      color: #000;
    }
    .outside-badge {
      margin-top: 8px;
      font-size: 12px;
      color: var(--vscode-editorWarning-foreground, #cca700);
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .command-box {
      background: var(--vscode-textCodeBlock-background, var(--vscode-editor-background));
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      padding: 12px;
      font-family: var(--vscode-editor-font-family);
      font-size: var(--vscode-editor-font-size);
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-all;
      max-height: 300px;
      overflow-y: auto;
      margin-bottom: 16px;
    }

    /* Terminal-style command box */
    .terminal-box {
      background: var(--vscode-terminal-background, #1e1e1e);
      border: 1px solid var(--vscode-terminal-border, var(--vscode-panel-border));
      border-radius: 6px;
      margin-bottom: 16px;
      overflow: hidden;
    }
    .terminal-header {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 12px;
      background: rgba(0, 0, 0, 0.15);
      border-bottom: 1px solid var(--vscode-terminal-border, rgba(255,255,255,0.06));
      font-size: 11px;
      color: var(--vscode-terminal-foreground, var(--vscode-foreground));
      opacity: 0.7;
    }
    .terminal-header .codicon { font-size: 12px; }
    .terminal-body {
      display: flex;
      padding: 10px 12px;
      align-items: flex-start;
      gap: 8px;
    }
    .terminal-prompt {
      color: var(--vscode-terminal-ansiGreen, #4ec9b0);
      font-family: var(--vscode-terminal-fontFamily, var(--vscode-editor-font-family));
      font-size: var(--vscode-terminal-fontSize, var(--vscode-editor-font-size));
      line-height: 1.5;
      user-select: none;
      flex-shrink: 0;
      font-weight: 600;
    }
    .terminal-input {
      flex: 1;
      background: transparent;
      border: none;
      color: var(--vscode-terminal-foreground, var(--vscode-foreground));
      font-family: var(--vscode-terminal-fontFamily, var(--vscode-editor-font-family));
      font-size: var(--vscode-terminal-fontSize, var(--vscode-editor-font-size));
      line-height: 1.5;
      resize: none;
      outline: none;
      min-height: 22px;
      max-height: 250px;
      overflow-y: auto;
      padding: 0;
    }
    .terminal-input.edited {
      color: var(--vscode-terminal-ansiYellow, #e5c07b);
    }
    .edited-badge {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      margin-left: auto;
      font-size: 11px;
      color: var(--vscode-terminal-ansiYellow, #e5c07b);
    }
    .inline-pattern-editor {
      margin-top: 12px;
      padding: 12px;
      background: var(--vscode-textCodeBlock-background, var(--vscode-editor-background));
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
    }
    .trust-level-header {
      font-weight: 600;
      font-size: 13px;
      margin-bottom: 10px;
      color: var(--vscode-foreground);
    }
    .pattern-row {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-bottom: 6px;
    }
    .pattern-row .pattern-input {
      flex: 1;
      min-width: 0;
    }
    .pattern-row .pattern-input.skipped {
      opacity: 0.4;
    }
    .pattern-row-modes {
      display: flex;
      gap: 2px;
      flex-shrink: 0;
    }
    .mode-btn {
      padding: 4px 8px;
      font-size: 11px;
      border: 1px solid var(--vscode-panel-border);
      background: transparent;
      color: var(--vscode-descriptionForeground);
      border-radius: 2px;
      cursor: pointer;
      font-family: var(--vscode-font-family);
      white-space: nowrap;
    }
    .mode-btn:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .mode-btn.active {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border-color: var(--vscode-button-background);
    }

    .button-row {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-bottom: 8px;
    }
    .btn {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 6px 14px;
      border: 1px solid transparent;
      border-radius: 2px;
      font-size: 13px;
      cursor: pointer;
      font-family: var(--vscode-font-family);
      white-space: nowrap;
    }
    .btn:focus {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: 1px;
    }
    .btn-primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border-color: var(--vscode-button-border, transparent);
    }
    .btn-primary:hover { background: var(--vscode-button-hoverBackground); }
    .btn-secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    .btn-secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .btn-danger {
      background: var(--vscode-inputValidation-errorBackground, #5a1d1d);
      color: var(--vscode-errorForeground, #f48771);
      border-color: var(--vscode-inputValidation-errorBorder, #be1100);
    }
    .btn-danger:hover { opacity: 0.9; }
    .btn-outline {
      background: transparent;
      color: var(--vscode-foreground);
      border-color: var(--vscode-panel-border);
    }
    .btn-outline:hover {
      background: var(--vscode-list-hoverBackground);
    }

    .trust-section {
      margin-top: 16px;
      padding-top: 12px;
      border-top: 1px solid var(--vscode-panel-border);
    }
    .trust-label {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 8px;
    }

    .expandable {
      margin-top: 12px;
      padding: 14px;
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
    }
    .expandable-title {
      font-weight: 600;
      font-size: 13px;
      margin-bottom: 12px;
    }
    .field {
      margin-bottom: 12px;
    }
    .field label {
      display: block;
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 4px;
    }
    .text-input {
      width: 100%;
      padding: 6px 8px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      border-radius: 2px;
      font-family: var(--vscode-editor-font-family);
      font-size: var(--vscode-editor-font-size);
    }
    .text-input:focus {
      outline: 1px solid var(--vscode-focusBorder);
      border-color: var(--vscode-focusBorder);
    }
    .textarea {
      resize: vertical;
      font-family: var(--vscode-editor-font-family);
      font-size: var(--vscode-editor-font-size);
      line-height: 1.5;
    }
    .radio-group {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      margin-top: 4px;
    }
    .radio-label {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 13px;
      cursor: pointer;
    }
    .radio-label input[type="radio"] {
      accent-color: var(--vscode-focusBorder);
    }
    `;
  }

  // ── Dispose ─────────────────────────────────────────────────────────────

  dispose(): void {
    this.rejectAll();
    this.panel?.dispose();
    this.panel = undefined;
    this.viewMessageDisposable?.dispose();
    this.statusBar.dispose();
    this.alertDisposable?.dispose();
  }
}
