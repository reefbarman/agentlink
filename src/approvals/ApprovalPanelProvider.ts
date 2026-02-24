import * as vscode from "vscode";
import { randomUUID } from "crypto";
import type { SubCommandEntry, ApprovalRequest } from "./webview/types.js";

// ── Response types ──────────────────────────────────────────────────────────

export interface CommandApprovalResponse {
  decision: "run-once" | "edit" | "session" | "project" | "global" | "reject";
  editedCommand?: string;
  rejectionReason?: string;
  rulePattern?: string;
  ruleMode?: "prefix" | "exact" | "regex";
  /** Per-sub-command rules with individual scopes */
  rules?: Array<{
    pattern: string;
    mode: "prefix" | "exact" | "regex" | "skip";
    scope: "session" | "project" | "global";
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

export interface RenameApprovalResponse {
  decision:
    | "accept"
    | "reject"
    | "accept-session"
    | "accept-project"
    | "accept-always";
  rejectionReason?: string;
  trustScope?: "all-files" | "this-file" | "pattern";
  rulePattern?: string;
  ruleMode?: "glob" | "prefix" | "exact";
}

// ── Internal types ──────────────────────────────────────────────────────────

interface InternalRequest {
  kind: "command" | "path" | "write" | "rename";
  id: string;
  command?: string;
  fullCommand?: string;
  filePath?: string;
  subCommands?: SubCommandEntry[];
  writeOperation?: "create" | "modify";
  outsideWorkspace?: boolean;
  oldName?: string;
  newName?: string;
  affectedFiles?: Array<{ path: string; changes: number }>;
  totalChanges?: number;
}

interface QueueEntry {
  request: InternalRequest;
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

  // Track whether the Preact app has signalled it's ready
  private webviewReady = false;

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
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };
    webviewView.webview.html = this.getShellHtml(webviewView.webview);

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
    options?: { subCommands?: SubCommandEntry[] },
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

  enqueueRenameApproval(
    oldName: string,
    newName: string,
    affectedFiles: Array<{ path: string; changes: number }>,
    totalChanges: number,
  ): { promise: Promise<RenameApprovalResponse>; id: string } {
    const id = randomUUID();
    const promise = this.enqueue({
      kind: "rename",
      id,
      oldName,
      newName,
      affectedFiles,
      totalChanges,
    }) as Promise<RenameApprovalResponse>;
    return { promise, id };
  }

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
    kind: InternalRequest["kind"],
  ):
    | CommandApprovalResponse
    | PathApprovalResponse
    | WriteApprovalResponse
    | RenameApprovalResponse {
    if (kind === "command") return { decision: "reject" };
    if (kind === "write") return { decision: "reject" };
    if (kind === "rename") return { decision: "reject" };
    return { decision: "reject" };
  }

  // ── Queue management ────────────────────────────────────────────────────

  private enqueue(request: InternalRequest): Promise<unknown> {
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
          : request.kind === "rename"
            ? "Rename approval required"
            : "Path access approval required",
    );
    vscode.commands.executeCommand("workbench.action.focusWindow");

    const position = this.getPosition();
    const webview = this.ensureWebview(position);
    if (!webview) {
      vscode.commands.executeCommand("nativeClaude.approvalView.focus");
      return;
    }

    // Send approval data to the Preact app via postMessage
    this.postApprovalToWebview(webview);

    // Reveal and focus
    if (position === "beside") {
      this.panel!.reveal(vscode.ViewColumn.Beside, false);
    } else if (this.view) {
      this.view.show(false);
      vscode.commands.executeCommand("nativeClaude.approvalView.focus");
    }
  }

  private postApprovalToWebview(webview: vscode.Webview): void {
    if (!this.currentEntry) return;

    const { request } = this.currentEntry;
    const queuePosition = 1;
    const queueTotal = 1 + this.queue.length;

    const msg: ApprovalRequest = {
      kind: request.kind,
      id: request.id,
      command: request.command,
      subCommands: request.subCommands,
      filePath: request.filePath,
      writeOperation: request.writeOperation,
      outsideWorkspace: request.outsideWorkspace,
      oldName: request.oldName,
      newName: request.newName,
      affectedFiles: request.affectedFiles,
      totalChanges: request.totalChanges,
      queuePosition,
      queueTotal,
    };

    webview.postMessage({ type: "showApproval", request: msg });
  }

  private handleMessage(message: {
    type: string;
    id?: string;
    decision?: string;
    editedCommand?: string;
    rejectionReason?: string;
    rulePattern?: string;
    ruleMode?: string;
    rules?: Array<{ pattern: string; mode: string; scope: string }>;
    trustScope?: string;
  }): void {
    // Handle webviewReady handshake
    if (message.type === "webviewReady") {
      this.webviewReady = true;
      // If there's a pending approval, send it now
      const webview = this.getActiveWebview();
      if (webview && this.currentEntry) {
        this.postApprovalToWebview(webview);
      }
      return;
    }

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
    } else if (entry.request.kind === "rename") {
      const response: RenameApprovalResponse = {
        decision: message.decision as RenameApprovalResponse["decision"],
        rejectionReason: message.rejectionReason || undefined,
        trustScope: message.trustScope as RenameApprovalResponse["trustScope"],
        rulePattern: message.rulePattern || undefined,
        ruleMode: message.ruleMode as RenameApprovalResponse["ruleMode"],
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

    entry.resolve(
      Object.assign(this.makeRejectResponse(entry.request.kind), {
        rejectionReason: reason,
      }),
    );
  }

  private rejectAll(): void {
    this.rejectCurrent();
    for (const entry of this.queue) {
      entry.resolve(this.makeRejectResponse(entry.request.kind));
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
      this.panel?.dispose();
      this.panel = undefined;
      this.webviewReady = false;
    } else {
      // Send idle message to Preact app
      const webview = this.getActiveWebview();
      if (webview) {
        webview.postMessage({ type: "idle" });
      }
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

  private getActiveWebview(): vscode.Webview | undefined {
    return this.panel?.webview ?? this.view?.webview;
  }

  private ensureWebview(
    position: ApprovalPosition,
  ): vscode.Webview | undefined {
    if (position === "beside") {
      if (!this.panel) {
        this.webviewReady = false;
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
          this.webviewReady = false;
          this.rejectAll();
        });
        this.panel.webview.onDidReceiveMessage((msg) =>
          this.handleMessage(msg),
        );
        this.panel.webview.html = this.getShellHtml(this.panel.webview);
      }
      return this.panel.webview;
    }

    // Panel mode
    if (this.view) {
      this.viewMessageDisposable?.dispose();
      this.viewMessageDisposable = this.view.webview.onDidReceiveMessage(
        (msg) => this.handleMessage(msg),
      );
      return this.view.webview;
    }

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

  // ── HTML shell (loads Preact bundle) ────────────────────────────────────

  private getShellHtml(webview: vscode.Webview): string {
    const nonce = randomUUID().replace(/-/g, "");
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "approval.js"),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "approval.css"),
    );
    const codiconsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "codicon.css"),
    );

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};">
  <link rel="stylesheet" href="${codiconsUri}">
  <link rel="stylesheet" href="${styleUri}">
  <title>Approval</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" type="module" src="${scriptUri}"></script>
</body>
</html>`;
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
