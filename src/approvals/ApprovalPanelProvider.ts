import * as vscode from "vscode";

import type {
  ApprovalRequest,
  DecisionMessage,
  InlineCommandFilePreview,
  MemoryOperation,
  MemoryScope,
  MemoryTier,
  SubCommandEntry,
} from "./webview/types.js";

import type { StatusBarManager } from "../util/StatusBarManager.js";
import { isMemoryProtectedPath } from "./protectedPaths.js";
import path from "path";
import picomatch from "picomatch";
import { randomUUID } from "crypto";
import { tryGetFirstWorkspaceRoot } from "../util/paths.js";

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
  /** Optional follow-up message from the user */
  followUp?: string;
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
  /** Optional follow-up message from the user */
  followUp?: string;
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
  /** Optional follow-up message from the user */
  followUp?: string;
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
  /** Optional follow-up message from the user */
  followUp?: string;
}

export interface MemoryApprovalResponse {
  decision: "accept" | "reject";
  rejectionReason?: string;
  editedContent?: string;
  memoryTier?: MemoryTier;
  memoryScope?: MemoryScope;
  memoryName?: string;
  /** Optional follow-up message from the user */
  followUp?: string;
}

// ── Internal types ──────────────────────────────────────────────────────────

interface InternalRequest {
  kind: "command" | "path" | "write" | "rename" | "memory";
  id: string;
  command?: string;
  fullCommand?: string;
  filePath?: string;
  subCommands?: SubCommandEntry[];
  inlineFiles?: InlineCommandFilePreview[];
  /** Agent-provided reason for running a command */
  reason?: string;
  /** Working directory a command will run in */
  cwd?: string;
  writeOperation?: "create" | "modify";
  outsideWorkspace?: boolean;
  oldName?: string;
  newName?: string;
  affectedFiles?: Array<{ path: string; changes: number }>;
  totalChanges?: number;
  memoryTier?: MemoryTier;
  memoryScope?: MemoryScope;
  memoryOperation?: MemoryOperation;
  memoryName?: string;
  memoryTitle?: string;
  memoryRationale?: string;
  memoryTargetPath?: string;
  memoryContent?: string;
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
  public static readonly viewType = "agentLink.approvalView";

  // Container references (only one is active at a time)
  private panel: vscode.WebviewPanel | undefined;
  private view: vscode.WebviewView | undefined;

  // Queue
  private queue: QueueEntry[] = [];
  private currentEntry: QueueEntry | undefined;

  // Recent single-use approvals cache (key → timestamp)
  // When a user approves a request once, repeat matching requests within the
  // TTL window are auto-approved. Path approvals use rule-aware matching so a
  // parallel batch of outside-workspace reads under the same approved directory
  // does not require one prompt per file.
  private recentApprovals = new Map<string, number>();
  private recentPathApprovals: Array<{
    path: string;
    mode: "glob" | "prefix" | "exact";
    timestamp: number;
  }> = [];

  // Alert
  private alertDisposable: vscode.Disposable | undefined;

  // Listener cleanup for panel mode
  private viewMessageDisposable: vscode.Disposable | undefined;

  // Track whether the Preact app has signalled it's ready
  private webviewReady = false;

  /** When set, route approvals to this callback instead of showing the approval webview. */
  public onForwardApproval?: (
    request: ApprovalRequest,
    respond: (msg: DecisionMessage) => void,
  ) => void;

  /** Called when the approval queue empties, if onForwardApproval is set. */
  public onForwardApprovalIdle?: () => void;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly statusBarManager: StatusBarManager,
  ) {}

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
      vscode.commands.executeCommand("agentLink.approvalView.focus");
    }
  }

  // ── Public API ──────────────────────────────────────────────────────────

  enqueueCommandApproval(
    command: string,
    fullCommand: string,
    options?: {
      subCommands?: SubCommandEntry[];
      inlineFiles?: InlineCommandFilePreview[];
      reason?: string;
      cwd?: string;
    },
  ): { promise: Promise<CommandApprovalResponse>; id: string } {
    const id = randomUUID();
    const promise = this.enqueue({
      kind: "command",
      id,
      command,
      fullCommand,
      subCommands: options?.subCommands,
      inlineFiles: options?.inlineFiles,
      reason: options?.reason,
      cwd: options?.cwd,
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
    options: {
      operation: "create" | "modify";
      outsideWorkspace: boolean;
      id?: string;
    },
  ): { promise: Promise<WriteApprovalResponse>; id: string } {
    const id = options.id ?? randomUUID();
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

  enqueueMemoryApproval(options: {
    tier: MemoryTier;
    scope: MemoryScope;
    operation: MemoryOperation;
    name?: string;
    title: string;
    rationale: string;
    targetPath: string;
    content?: string;
    id?: string;
  }): { promise: Promise<MemoryApprovalResponse>; id: string } {
    const id = options.id ?? randomUUID();
    const promise = this.enqueue({
      kind: "memory",
      id,
      memoryTier: options.tier,
      memoryScope: options.scope,
      memoryOperation: options.operation,
      memoryName: options.name,
      memoryTitle: options.title,
      memoryRationale: options.rationale,
      memoryTargetPath: options.targetPath,
      memoryContent: options.content,
    }) as Promise<MemoryApprovalResponse>;
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
    | RenameApprovalResponse
    | MemoryApprovalResponse {
    if (kind === "command") return { decision: "reject" };
    if (kind === "write") return { decision: "reject" };
    if (kind === "rename") return { decision: "reject" };
    if (kind === "memory") return { decision: "reject" };
    return { decision: "reject" };
  }

  // ── Queue management ────────────────────────────────────────────────────

  private enqueue(request: InternalRequest): Promise<unknown> {
    // Auto-resolve command repeats immediately if a matching approval was
    // granted recently. Path approvals are intentionally checked only while
    // draining the existing queue so "Allow Once" applies to the current
    // parallel batch, not future requests within the TTL window.
    if (request.kind !== "path" && this.isRecentlyApprovedRequest(request)) {
      return Promise.resolve(this.makeAutoApproveResponse(request.kind));
    }

    return new Promise((resolve) => {
      this.queue.push({ request, resolve });
      this.updatePendingCount();
      this.processQueue();
    });
  }

  private processQueue(options?: { allowRecentPathApprovals?: boolean }): void {
    if (this.currentEntry) return;

    // Auto-resolve any recently-approved items at the front of the queue.
    // Path approvals are only eligible immediately after a path approval
    // decision, so "Allow Once" covers an already-queued parallel batch but
    // not future requests that happen within the command TTL window.
    while (this.queue.length > 0) {
      const front = this.queue[0];
      if (
        this.isRecentlyApprovedRequest(front.request, {
          allowPathApprovals: options?.allowRecentPathApprovals ?? false,
        })
      ) {
        this.queue.shift();
        this.updatePendingCount();
        front.resolve(this.makeAutoApproveResponse(front.request.kind));
      } else {
        break;
      }
    }

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

    // If a forwarding hook is set, delegate rendering to the caller (e.g. chat webview)
    if (this.onForwardApproval) {
      const queuePosition = 1;
      const queueTotal = 1 + this.queue.length;
      const msg: ApprovalRequest = {
        kind: request.kind,
        id: request.id,
        command: request.command,
        subCommands: request.subCommands,
        inlineFiles: request.inlineFiles,
        reason: request.reason,
        cwd: request.cwd,
        filePath: request.filePath,
        writeOperation: request.writeOperation,
        outsideWorkspace: request.outsideWorkspace,
        oldName: request.oldName,
        newName: request.newName,
        affectedFiles: request.affectedFiles,
        totalChanges: request.totalChanges,
        memoryTier: request.memoryTier,
        memoryScope: request.memoryScope,
        memoryOperation: request.memoryOperation,
        memoryName: request.memoryName,
        memoryTitle: request.memoryTitle,
        memoryRationale: request.memoryRationale,
        memoryTargetPath: request.memoryTargetPath,
        memoryContent: request.memoryContent,
        queuePosition,
        queueTotal,
      };
      this.onForwardApproval(msg, (decision) => this.handleMessage(decision));
      return;
    }

    // Always show alert and focus window, even if webview isn't ready yet
    this.alertDisposable?.dispose();
    this.alertDisposable = this.showAlert(
      request.kind === "command"
        ? "Command approval required"
        : request.kind === "write"
          ? "Write approval required"
          : request.kind === "rename"
            ? "Rename approval required"
            : request.kind === "memory"
              ? "Memory approval required"
              : "Path access approval required",
    );
    vscode.commands.executeCommand("workbench.action.focusWindow");

    const position = this.getPosition();
    const webview = this.ensureWebview(position);
    if (!webview) {
      vscode.commands.executeCommand("agentLink.approvalView.focus");
      return;
    }

    // Send approval data to the Preact app via postMessage
    this.postApprovalToWebview(webview);

    // Reveal and focus
    if (position === "beside") {
      this.panel!.reveal(vscode.ViewColumn.Beside, false);
    } else if (this.view) {
      this.view.show(false);
      vscode.commands.executeCommand("agentLink.approvalView.focus");
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
      inlineFiles: request.inlineFiles,
      reason: request.reason,
      cwd: request.cwd,
      filePath: request.filePath,
      writeOperation: request.writeOperation,
      outsideWorkspace: request.outsideWorkspace,
      oldName: request.oldName,
      newName: request.newName,
      affectedFiles: request.affectedFiles,
      totalChanges: request.totalChanges,
      memoryTier: request.memoryTier,
      memoryScope: request.memoryScope,
      memoryOperation: request.memoryOperation,
      memoryName: request.memoryName,
      memoryTitle: request.memoryTitle,
      memoryRationale: request.memoryRationale,
      memoryTargetPath: request.memoryTargetPath,
      memoryContent: request.memoryContent,
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
    editedContent?: string;
    memoryTier?: MemoryTier;
    memoryScope?: MemoryScope;
    memoryName?: string;
    followUp?: string;
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

    const followUp = message.followUp || undefined;

    let response:
      | CommandApprovalResponse
      | PathApprovalResponse
      | WriteApprovalResponse
      | RenameApprovalResponse
      | MemoryApprovalResponse;

    if (entry.request.kind === "command") {
      response = {
        decision: message.decision as CommandApprovalResponse["decision"],
        editedCommand: message.editedCommand,
        rejectionReason: message.rejectionReason || undefined,
        rulePattern: message.rulePattern || undefined,
        ruleMode: message.ruleMode as
          | CommandApprovalResponse["ruleMode"]
          | undefined,
        rules: message.rules as CommandApprovalResponse["rules"],
        followUp,
      };
    } else if (entry.request.kind === "write") {
      response = {
        decision: message.decision as WriteApprovalResponse["decision"],
        rejectionReason: message.rejectionReason || undefined,
        trustScope: message.trustScope as WriteApprovalResponse["trustScope"],
        rulePattern: message.rulePattern || undefined,
        ruleMode: message.ruleMode as WriteApprovalResponse["ruleMode"],
        followUp,
      };
    } else if (entry.request.kind === "rename") {
      response = {
        decision: message.decision as RenameApprovalResponse["decision"],
        rejectionReason: message.rejectionReason || undefined,
        trustScope: message.trustScope as RenameApprovalResponse["trustScope"],
        rulePattern: message.rulePattern || undefined,
        ruleMode: message.ruleMode as RenameApprovalResponse["ruleMode"],
        followUp,
      };
    } else if (entry.request.kind === "memory") {
      response = {
        decision: message.decision as MemoryApprovalResponse["decision"],
        rejectionReason: message.rejectionReason || undefined,
        editedContent: message.editedContent ?? undefined,
        memoryTier: message.memoryTier,
        memoryScope: message.memoryScope,
        memoryName: message.memoryName || undefined,
        followUp,
      };
    } else {
      response = {
        decision: message.decision as PathApprovalResponse["decision"],
        rejectionReason: message.rejectionReason || undefined,
        rulePattern: message.rulePattern || undefined,
        ruleMode: message.ruleMode as
          | PathApprovalResponse["ruleMode"]
          | undefined,
        followUp,
      };
    }

    entry.resolve(response);

    // Record for repeat auto-approve within TTL window.
    // Skip rejections and edited commands (user wanted to review those).
    const isRejection = message.decision === "reject";
    const isEdited =
      entry.request.kind === "command" && !!message.editedCommand;
    if (!isRejection && !isEdited) {
      this.recordApproval(entry.request, response);
    }

    this.processQueue({
      allowRecentPathApprovals: entry.request.kind === "path",
    });
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
    this.statusBarManager.setPendingCount(0);

    if (this.onForwardApproval) {
      this.onForwardApprovalIdle?.();
      return;
    }

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
        .getConfiguration("agentlink")
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
          "agentLink.approval",
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
          "agentlink.svg",
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

  // ── Public: focus the current approval UI ───────────────────────────────

  focusApproval(): void {
    if (!this.currentEntry) return;
    const position = this.getPosition();
    if (position === "beside" && this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside, false);
    } else if (this.view) {
      this.view.show(false);
      vscode.commands.executeCommand("agentLink.approvalView.focus");
    }
  }

  // ── Alert ───────────────────────────────────────────────────────────────

  private showAlert(message: string): vscode.Disposable {
    return this.statusBarManager.showAlert(message);
  }

  private updatePendingCount(): void {
    this.statusBarManager.setPendingCount(this.queue.length);
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

  // ── Recent approval cache ───────────────────────────────────────────────

  /**
   * Check whether a request of the given kind/identifier was recently
   * approved (within the configured TTL). Tool implementations can call
   * this *before* enqueueing to skip expensive UI (diff views, approval
   * panels) entirely.
   */
  isRecentlyApproved(
    kind: InternalRequest["kind"],
    identifier: string,
  ): boolean {
    const ttl = this.getRecentApprovalTtl();
    if (ttl <= 0) return false;

    if (kind !== "command") return false;
    const key = this.buildKey(kind, identifier);
    if (!key) return false;
    return this.hasRecentApproval(key);
  }

  private getRecentApprovalTtl(): number {
    return (
      vscode.workspace
        .getConfiguration("agentlink")
        .get<number>("recentApprovalTtl", 60) * 1000
    );
  }

  private buildKey(
    kind: InternalRequest["kind"],
    identifier: string,
  ): string | undefined {
    switch (kind) {
      case "command":
        return `cmd:${identifier}`;
      case "write":
        return `write:${identifier}`;
      case "path":
        return `path:${identifier}`;
      case "rename":
        return `rename:${identifier}`;
      case "memory":
        return undefined;
      default:
        return undefined;
    }
  }

  private isProtectedWriteRequest(request: InternalRequest): boolean {
    if (request.kind !== "write" || !request.filePath) return false;
    const filePath = path.isAbsolute(request.filePath)
      ? request.filePath
      : path.resolve(
          tryGetFirstWorkspaceRoot() ?? process.cwd(),
          request.filePath,
        );
    return isMemoryProtectedPath(filePath);
  }

  private approvalKeyForRequest(request: InternalRequest): string | undefined {
    switch (request.kind) {
      case "command":
        return request.fullCommand ? `cmd:${request.fullCommand}` : undefined;
      case "write":
        return request.filePath ? `write:${request.filePath}` : undefined;
      case "path":
        return request.filePath ? `path:${request.filePath}` : undefined;
      case "rename":
        return request.oldName && request.newName
          ? `rename:${request.oldName}\u2192${request.newName}`
          : undefined;
      case "memory":
        return undefined;
      default:
        return undefined;
    }
  }

  private hasRecentApproval(key: string): boolean {
    const ttl = this.getRecentApprovalTtl();
    if (ttl <= 0) return false;
    const ts = this.recentApprovals.get(key);
    if (ts === undefined) return false;
    if (Date.now() - ts > ttl) {
      this.recentApprovals.delete(key);
      return false;
    }
    return true;
  }

  private hasRecentPathApproval(filePath: string): boolean {
    this.pruneRecentPathApprovals();
    return this.recentPathApprovals.some((approval) =>
      this.matchesPathApproval(filePath, approval),
    );
  }

  private recordApproval(
    request: InternalRequest,
    response?:
      | CommandApprovalResponse
      | PathApprovalResponse
      | WriteApprovalResponse
      | RenameApprovalResponse
      | MemoryApprovalResponse,
  ): void {
    if (this.isProtectedWriteRequest(request)) return;

    if (request.kind === "path") {
      this.recordPathApproval(request, response as PathApprovalResponse);
      return;
    }

    if (request.kind !== "command") return;
    const key = this.approvalKeyForRequest(request);
    if (!key) return;
    this.recentApprovals.set(key, Date.now());
    // Prune expired entries when the map grows large
    if (this.recentApprovals.size > 100) {
      const ttl = this.getRecentApprovalTtl();
      const now = Date.now();
      for (const [k, ts] of this.recentApprovals) {
        if (now - ts > ttl) this.recentApprovals.delete(k);
      }
    }
  }

  private recordPathApproval(
    request: InternalRequest,
    response?: PathApprovalResponse,
  ): void {
    if (!request.filePath) return;

    const rule =
      response?.rulePattern && response.ruleMode
        ? { path: response.rulePattern, mode: response.ruleMode }
        : {
            path: this.containingDirectoryPattern(request.filePath),
            mode: "prefix" as const,
          };

    this.recentPathApprovals.push({ ...rule, timestamp: Date.now() });
    this.pruneRecentPathApprovals();
  }

  private pruneRecentPathApprovals(): void {
    const ttl = this.getRecentApprovalTtl();
    const now = Date.now();
    this.recentPathApprovals = this.recentPathApprovals.filter(
      (approval) => now - approval.timestamp <= ttl,
    );

    if (this.recentPathApprovals.length > 100) {
      this.recentPathApprovals.splice(0, this.recentPathApprovals.length - 100);
    }
  }

  private containingDirectoryPattern(filePath: string): string {
    const normalized = this.normalizeRulePath(filePath);
    const dir = path.posix.dirname(normalized);
    if (dir === ".") return normalized;
    return dir === "/" ? "/" : `${dir}/`;
  }

  private matchesPathApproval(
    filePath: string,
    approval: { path: string; mode: "glob" | "prefix" | "exact" },
  ): boolean {
    try {
      const normalizedPath = this.normalizeRulePath(filePath);
      const normalizedPattern = this.normalizeRulePath(approval.path);

      switch (approval.mode) {
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

  private isRecentlyApprovedRequest(
    request: InternalRequest,
    options?: { allowPathApprovals?: boolean },
  ): boolean {
    if (this.isProtectedWriteRequest(request)) return false;
    if (request.kind === "command" && request.inlineFiles?.length) return false;
    const identifier =
      request.kind === "command"
        ? request.fullCommand
        : request.kind === "path"
          ? request.filePath
          : undefined;
    if (!identifier) return false;
    if (request.kind === "path") {
      return options?.allowPathApprovals
        ? this.hasRecentPathApproval(identifier)
        : false;
    }

    return this.isRecentlyApproved(request.kind, identifier);
  }

  private makeAutoApproveResponse(
    kind: InternalRequest["kind"],
  ):
    | CommandApprovalResponse
    | PathApprovalResponse
    | WriteApprovalResponse
    | RenameApprovalResponse
    | MemoryApprovalResponse {
    switch (kind) {
      case "command":
        return { decision: "run-once" };
      case "write":
        return { decision: "accept" };
      case "path":
        return { decision: "allow-once" };
      case "rename":
        return { decision: "accept" };
      case "memory":
        return { decision: "reject" };
    }
  }

  // ── Dispose ─────────────────────────────────────────────────────────────

  dispose(): void {
    this.rejectAll();
    this.panel?.dispose();
    this.panel = undefined;
    this.viewMessageDisposable?.dispose();
    this.alertDisposable?.dispose();
  }
}
