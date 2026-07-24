import * as vscode from "vscode";

import type {
  ApprovalKind,
  ApprovalProjectContext,
  ApprovalRequest,
  CommandReviewSummary,
  DecisionMessage,
  InlineCommandFilePreview,
  MemoryOperation,
  MemoryScope,
  MemoryTier,
  NetworkReviewSummary,
  RuleEntry,
  SubCommandEntry,
} from "./webview/types.js";
import type {
  ManagedNetworkRequest,
  TerminalExecutionSecuritySummary,
} from "../core/capabilities/terminal.js";

import type { StatusBarManager } from "../util/StatusBarManager.js";
import { isMemoryProtectedPath } from "./protectedPaths.js";
import path from "path";
import picomatch from "picomatch";
import { randomUUID } from "crypto";
import { renderWebviewShell } from "../adapters/vscode/webviewShell.js";

// ── Response types ──────────────────────────────────────────────────────────

export interface CommandApprovalResponse {
  decision: "run-once" | "edit" | "session" | "project" | "global" | "reject";
  /** True when the provider resolved this request from its attributed recent cache. */
  recentApproval?: boolean;
  editedCommand?: string;
  rejectionReason?: string;
  rulePattern?: string;
  ruleMode?: "prefix" | "exact" | "regex";
  /** Per-sub-command rules with individual decisions and scopes. */
  rules?: RuleEntry[];
  /** Optional follow-up message from the user */
  followUp?: string;
}

export interface NetworkApprovalResponse {
  decision:
    | "allow-once"
    | "allow-session"
    | "allow-project"
    | "allow-global"
    | "reject";
  rejectionReason?: string;
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
  kind: "command" | "network" | "path" | "write" | "rename" | "memory";
  deferApprovalRecording?: boolean;
  bypassRecentApproval?: boolean;
  id: string;
  sessionId?: string;
  sourceProject?: ApprovalProjectContext;
  targetProject?: ApprovalProjectContext;
  targetPath?: string;
  projectResourceUri?: string;
  command?: string;
  fullCommand?: string;
  filePath?: string;
  subCommands?: SubCommandEntry[];
  inlineFiles?: InlineCommandFilePreview[];
  /** Agent-provided reason for running a command */
  reason?: string;
  /** Working directory a command will run in */
  cwd?: string;
  /** Automatic review result shown when the command still needs a human. */
  commandReview?: CommandReviewSummary;
  /** Concise guardrail reason shown instead of reviewer output. */
  humanOnlyReason?: string;
  security?: TerminalExecutionSecuritySummary;
  managedNetwork?: ManagedNetworkRequest;
  networkReview?: NetworkReviewSummary;
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
  signal?: AbortSignal;
}

interface QueueEntry {
  request: InternalRequest;
  resolve: (value: unknown) => void;
}

// ── Provider ────────────────────────────────────────────────────────────────

export class ApprovalPanelProvider implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;

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
    sessionId?: string;
    projectId?: string;
    projectResourceUri?: string;
  }> = [];

  // Alert
  private alertDisposable: vscode.Disposable | undefined;

  // Track whether the Preact app has signalled it's ready
  private webviewReady = false;

  /** When set, route approvals to this callback instead of showing the approval webview. */
  public onForwardApproval?: (
    request: ApprovalRequest,
    respond: (msg: DecisionMessage) => boolean,
  ) => void;

  /** Called when the approval queue empties, if onForwardApproval is set. */
  public onForwardApprovalIdle?: () => void;

  /** Called when a forwarded approval is cancelled without a UI decision. */
  public onForwardApprovalCancelled?: (id: string) => void;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly statusBarManager: StatusBarManager,
    private readonly resolveProjectContext?: (input: {
      sessionId?: string;
      targetPath?: string;
    }) => {
      sourceProject?: ApprovalProjectContext;
      targetProject?: ApprovalProjectContext;
      targetPath?: string;
      projectResourceUri?: string;
    },
  ) {}

  // ── Public API ──────────────────────────────────────────────────────────

  enqueueCommandApproval(
    command: string,
    fullCommand: string,
    options?: {
      subCommands?: SubCommandEntry[];
      inlineFiles?: InlineCommandFilePreview[];
      reason?: string;
      cwd?: string;
      commandReview?: CommandReviewSummary;
      humanOnlyReason?: string;
      security?: TerminalExecutionSecuritySummary;
      sessionId?: string;
      signal?: AbortSignal;
      /** Delay recent-approval persistence until the host revalidates policy. */
      deferApprovalRecording?: boolean;
      /** Require a new decision instead of consuming the recent-approval cache. */
      bypassRecentApproval?: boolean;
    },
  ): {
    promise: Promise<CommandApprovalResponse>;
    id: string;
    commitApprovalRecording: () => void;
  } {
    const id = randomUUID();
    let pendingRecording:
      | { request: InternalRequest; response: CommandApprovalResponse }
      | undefined;
    let recordingCommitted = false;
    const promise = this.enqueue(
      {
        kind: "command",
        id,
        command,
        fullCommand,
        subCommands: options?.subCommands,
        inlineFiles: options?.inlineFiles,
        reason: options?.reason,
        cwd: options?.cwd,
        commandReview: options?.commandReview,
        humanOnlyReason: options?.humanOnlyReason,
        security: options?.security,
        sessionId: options?.sessionId,
        signal: options?.signal,
        deferApprovalRecording: options?.deferApprovalRecording,
        bypassRecentApproval: options?.bypassRecentApproval,
      },
      (request, response) => {
        pendingRecording = {
          request,
          response: response as CommandApprovalResponse,
        };
      },
    ) as Promise<CommandApprovalResponse>;
    return {
      promise,
      id,
      commitApprovalRecording: () => {
        if (recordingCommitted || !pendingRecording) return;
        recordingCommitted = true;
        if (!pendingRecording.response.editedCommand) {
          this.recordApproval(
            pendingRecording.request,
            pendingRecording.response,
          );
        }
        pendingRecording = undefined;
      },
    };
  }

  enqueueNetworkApproval(options: {
    request: ManagedNetworkRequest;
    review?: NetworkReviewSummary;
    signal?: AbortSignal;
  }): { promise: Promise<NetworkApprovalResponse>; id: string } {
    const id = randomUUID();
    const promise = this.enqueue({
      kind: "network",
      id,
      sessionId: options.request.sessionId,
      managedNetwork: {
        ...options.request,
        dnsAnswers: options.request.dnsAnswers.map((answer) => ({ ...answer })),
      },
      networkReview: options.review,
      reason: options.request.reason,
      cwd: options.request.cwd,
      command: options.request.command,
      signal: options.signal,
      bypassRecentApproval: true,
    }) as Promise<NetworkApprovalResponse>;
    return { promise, id };
  }

  enqueuePathApproval(
    filePath: string,
    sessionId?: string,
    signal?: AbortSignal,
  ): {
    promise: Promise<PathApprovalResponse>;
    id: string;
  } {
    const id = randomUUID();
    const promise = this.enqueue({
      kind: "path",
      id,
      filePath,
      sessionId,
      targetPath: filePath,
      signal,
    }) as Promise<PathApprovalResponse>;
    return { promise, id };
  }

  enqueueWriteApproval(
    relPath: string,
    options: {
      operation: "create" | "modify";
      outsideWorkspace: boolean;
      id?: string;
      sessionId?: string;
      targetPath?: string;
    },
  ): { promise: Promise<WriteApprovalResponse>; id: string } {
    const id = options.id ?? randomUUID();
    const promise = this.enqueue({
      kind: "write",
      id,
      filePath: relPath,
      writeOperation: options.operation,
      outsideWorkspace: options.outsideWorkspace,
      sessionId: options.sessionId,
      targetPath: options.targetPath ?? relPath,
    }) as Promise<WriteApprovalResponse>;
    return { promise, id };
  }

  enqueueRenameApproval(
    oldName: string,
    newName: string,
    affectedFiles: Array<{ path: string; changes: number }>,
    totalChanges: number,
    options?: { sessionId?: string; targetPath?: string },
  ): { promise: Promise<RenameApprovalResponse>; id: string } {
    const id = randomUUID();
    const promise = this.enqueue({
      kind: "rename",
      id,
      oldName,
      newName,
      affectedFiles,
      totalChanges,
      sessionId: options?.sessionId,
      targetPath: options?.targetPath ?? affectedFiles[0]?.path,
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
    sessionId?: string;
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
      sessionId: options.sessionId,
      targetPath: options.targetPath,
    }) as Promise<MemoryApprovalResponse>;
    return { promise, id };
  }

  cancelApproval(id: string): void {
    if (this.currentEntry?.request.id === id) {
      this.alertDisposable?.dispose();
      this.alertDisposable = undefined;
      const entry = this.currentEntry;
      this.currentEntry = undefined;
      this.onForwardApprovalCancelled?.(id);
      entry.resolve(this.makeRejectResponse(entry.request.kind));
      this.processQueue();
      return;
    }
    const idx = this.queue.findIndex((e) => e.request.id === id);
    if (idx !== -1) {
      const entry = this.queue.splice(idx, 1)[0];
      this.onForwardApprovalCancelled?.(id);
      entry.resolve(this.makeRejectResponse(entry.request.kind));
      this.updatePendingCount();
    }
  }

  /**
   * Re-resolve pending command approvals for a session whose command approval
   * policy just changed (e.g. Approve for Me was enabled while a card was
   * open). Each affected request resolves as a rejection with an explanatory
   * reason; the command flow detects the policy drift, returns
   * `retry_required` to the agent, and the retried command is approved under
   * the new policy — under Approve for Me that means the guardian reviews it
   * automatically instead of leaving the stale card waiting on the user.
   */
  requeueCommandApprovalsForPolicyChange(
    sessionId: string,
    rejectionReason: string,
  ): number {
    const matches = (entry: QueueEntry) =>
      entry.request.kind === "command" && entry.request.sessionId === sessionId;
    const makeResponse = (): CommandApprovalResponse => ({
      decision: "reject",
      rejectionReason,
    });
    let resolved = 0;

    const queued = this.queue.filter(matches);
    if (queued.length > 0) {
      this.queue = this.queue.filter((entry) => !matches(entry));
      for (const entry of queued) {
        this.onForwardApprovalCancelled?.(entry.request.id);
        entry.resolve(makeResponse());
        resolved += 1;
      }
      this.updatePendingCount();
    }

    if (this.currentEntry && matches(this.currentEntry)) {
      const entry = this.currentEntry;
      this.alertDisposable?.dispose();
      this.alertDisposable = undefined;
      this.currentEntry = undefined;
      this.onForwardApprovalCancelled?.(entry.request.id);
      entry.resolve(makeResponse());
      resolved += 1;
      this.processQueue();
    }

    return resolved;
  }

  private makeRejectResponse(
    kind: InternalRequest["kind"],
  ):
    | CommandApprovalResponse
    | NetworkApprovalResponse
    | PathApprovalResponse
    | WriteApprovalResponse
    | RenameApprovalResponse
    | MemoryApprovalResponse {
    if (kind === "command") {
      return { decision: "reject" };
    }
    if (kind === "write") return { decision: "reject" };
    if (kind === "rename") return { decision: "reject" };
    if (kind === "memory") return { decision: "reject" };
    return { decision: "reject" };
  }

  // ── Queue management ────────────────────────────────────────────────────

  private enqueue(
    request: InternalRequest,
    deferRecording?: (request: InternalRequest, response: unknown) => void,
  ): Promise<unknown> {
    const projectContext = this.resolveProjectContext?.({
      sessionId: request.sessionId,
      targetPath: request.targetPath,
    });
    const attributedRequest: InternalRequest = {
      ...request,
      ...projectContext,
    };
    if (attributedRequest.signal?.aborted) {
      return Promise.resolve(this.makeRejectResponse(attributedRequest.kind));
    }

    // Auto-resolve command repeats immediately if a matching approval was
    // granted recently. Path approvals are intentionally checked only while
    // draining the existing queue so "Allow Once" applies to the current
    // parallel batch, not future requests within the TTL window.
    if (
      !attributedRequest.bypassRecentApproval &&
      attributedRequest.kind !== "network" &&
      attributedRequest.kind !== "path" &&
      this.isRecentlyApprovedRequest(attributedRequest)
    ) {
      return Promise.resolve(
        this.makeAutoApproveResponse(attributedRequest.kind),
      );
    }

    return new Promise((resolve) => {
      const handleAbort = () => this.cancelApproval(attributedRequest.id);
      const finish = (response: unknown) => {
        attributedRequest.signal?.removeEventListener("abort", handleAbort);
        if (attributedRequest.deferApprovalRecording) {
          deferRecording?.(attributedRequest, response);
        }
        resolve(response);
      };
      this.queue.push({ request: attributedRequest, resolve: finish });
      attributedRequest.signal?.addEventListener("abort", handleAbort, {
        once: true,
      });
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
        !front.request.bypassRecentApproval &&
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

    // Approval attention is presentation-independent. Built-in approvals are
    // rendered in chat while external approvals use a separate webview, but
    // both must remain visible in the status bar until they are resolved.
    this.alertDisposable?.dispose();
    this.alertDisposable = this.showAlert(
      request.kind === "command"
        ? "Command approval required"
        : request.kind === "network"
          ? "Network approval required"
          : request.kind === "write"
            ? "Write approval required"
            : request.kind === "rename"
              ? "Rename approval required"
              : request.kind === "memory"
                ? "Memory approval required"
                : "Path access approval required",
    );

    // If a forwarding hook is set, delegate rendering to the caller (e.g. chat webview)
    if (this.onForwardApproval) {
      const queuePosition = 1;
      const queueTotal = 1 + this.queue.length;
      const msg: ApprovalRequest = {
        kind: request.kind,
        id: request.id,
        sourceProject: request.sourceProject,
        targetProject: request.targetProject,
        targetPath: request.targetPath,
        command: request.command,
        subCommands: request.subCommands,
        inlineFiles: request.inlineFiles,
        reason: request.reason,
        cwd: request.cwd,
        commandReview: request.commandReview,
        humanOnlyReason: request.humanOnlyReason,
        security: request.security,
        managedNetwork: request.managedNetwork,
        networkReview: request.networkReview,
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

    // Focus the window even if the dedicated webview isn't ready yet.
    vscode.commands.executeCommand("workbench.action.focusWindow");

    const webview = this.ensureWebview();
    this.postApprovalToWebview(webview);
    this.panel!.reveal(vscode.ViewColumn.Beside, false);
  }

  private postApprovalToWebview(webview: vscode.Webview): void {
    if (!this.currentEntry) return;

    const { request } = this.currentEntry;
    const queuePosition = 1;
    const queueTotal = 1 + this.queue.length;

    const msg: ApprovalRequest = {
      kind: request.kind,
      id: request.id,
      sourceProject: request.sourceProject,
      targetProject: request.targetProject,
      targetPath: request.targetPath,
      command: request.command,
      subCommands: request.subCommands,
      inlineFiles: request.inlineFiles,
      reason: request.reason,
      cwd: request.cwd,
      commandReview: request.commandReview,
      humanOnlyReason: request.humanOnlyReason,
      security: request.security,
      managedNetwork: request.managedNetwork,
      networkReview: request.networkReview,
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
    approvalKind?: ApprovalKind;
    decision?: string;
    editedCommand?: string;
    rejectionReason?: string;
    rulePattern?: string;
    ruleMode?: string;
    rules?: Array<{
      pattern: string;
      mode: string;
      decision?: string;
      scope: string;
    }>;
    trustScope?: string;
    editedContent?: string;
    memoryTier?: MemoryTier;
    memoryScope?: MemoryScope;
    memoryName?: string;
    followUp?: string;
  }): boolean {
    // Handle webviewReady handshake
    if (message.type === "webviewReady") {
      this.webviewReady = true;
      // If there's a pending approval, send it now
      const webview = this.panel?.webview;
      if (webview && this.currentEntry) {
        this.postApprovalToWebview(webview);
      }
      return false;
    }

    if (message.type !== "decision") return false;
    if (!this.currentEntry || message.id !== this.currentEntry.request.id) {
      return false;
    }
    if (!this.isValidDecision(this.currentEntry.request, message)) {
      return false;
    }

    this.alertDisposable?.dispose();
    this.alertDisposable = undefined;

    const entry = this.currentEntry;
    this.currentEntry = undefined;

    const followUp = message.followUp || undefined;

    let response:
      | CommandApprovalResponse
      | NetworkApprovalResponse
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
    } else if (entry.request.kind === "network") {
      response = {
        decision: message.decision as NetworkApprovalResponse["decision"],
        rejectionReason: message.rejectionReason || undefined,
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
    if (
      entry.request.kind !== "network" &&
      !isRejection &&
      !isEdited &&
      !entry.request.deferApprovalRecording
    ) {
      this.recordApproval(entry.request, response);
    }

    this.processQueue({
      allowRecentPathApprovals: entry.request.kind === "path",
    });
    return true;
  }

  private isValidDecision(
    request: InternalRequest,
    message: {
      approvalKind?: ApprovalKind;
      decision?: string;
      editedCommand?: string;
      rulePattern?: string;
      ruleMode?: string;
      rules?: Array<{
        pattern?: unknown;
        mode?: unknown;
        decision?: unknown;
        scope?: unknown;
      }>;
      trustScope?: string;
      editedContent?: string;
      memoryTier?: MemoryTier;
      memoryScope?: MemoryScope;
      memoryName?: string;
    },
  ): boolean {
    if (message.approvalKind !== request.kind) return false;

    const allowedDecisions: Record<InternalRequest["kind"], readonly string[]> =
      {
        command: ["run-once", "edit", "session", "project", "global", "reject"],
        network: [
          "allow-once",
          "allow-session",
          "allow-project",
          "allow-global",
          "reject",
        ],
        path: [
          "allow-once",
          "allow-session",
          "allow-project",
          "allow-always",
          "reject",
        ],
        write: [
          "accept",
          "reject",
          "accept-session",
          "accept-project",
          "accept-always",
        ],
        rename: [
          "accept",
          "reject",
          "accept-session",
          "accept-project",
          "accept-always",
        ],
        memory: ["accept", "reject"],
      };
    if (
      !message.decision ||
      !allowedDecisions[request.kind].includes(message.decision)
    ) {
      return false;
    }

    if (request.kind === "command" && message.rules !== undefined) {
      const validModes = ["prefix", "exact", "regex", "skip"];
      const validDecisions = ["allow", "prompt", "forbidden"];
      const validScopes = ["session", "project", "global", "skip"];
      if (
        !message.rules.every(
          (rule) =>
            typeof rule === "object" &&
            rule !== null &&
            typeof rule.pattern === "string" &&
            validModes.includes(String(rule.mode)) &&
            (rule.decision === undefined ||
              (typeof rule.decision === "string" &&
                validDecisions.includes(rule.decision))) &&
            validScopes.includes(String(rule.scope)),
        )
      ) {
        return false;
      }
    }

    return true;
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

    this.panel?.dispose();
    this.panel = undefined;
    this.webviewReady = false;
  }

  // ── Webview lifecycle ───────────────────────────────────────────────────

  private ensureWebview(): vscode.Webview {
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
      this.panel.webview.onDidReceiveMessage((msg) => this.handleMessage(msg));
      this.panel.webview.html = this.getShellHtml(this.panel.webview);
    }
    return this.panel.webview;
  }

  // ── Public: focus the current approval UI ───────────────────────────────

  focusApproval(): void {
    if (this.currentEntry && this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside, false);
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
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "approval.js"),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "approval.css"),
    );
    const codiconsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "codicon.css"),
    );

    return renderWebviewShell({
      title: "Approval",
      cspSource: webview.cspSource,
      scriptUri: scriptUri.toString(),
      styleUris: [codiconsUri.toString(), styleUri.toString()],
    });
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
    projectId = "unscoped",
    requiredAuthority = "unspecified",
    permissionIntent = "unspecified",
    sessionId?: string,
  ): boolean {
    if (kind !== "command") return false;
    return this.hasRecentApproval(
      this.commandApprovalKey(
        sessionId,
        projectId,
        requiredAuthority,
        permissionIntent,
        identifier,
      ),
    );
  }

  private getRecentApprovalTtl(request?: InternalRequest): number {
    const resource = request?.projectResourceUri
      ? vscode.Uri.parse(request.projectResourceUri)
      : undefined;
    return (
      vscode.workspace
        .getConfiguration("agentlink", resource)
        .get<number>("recentApprovalTtl", 60) * 1000
    );
  }

  private isProtectedWriteRequest(request: InternalRequest): boolean {
    if (request.kind !== "write") return false;
    const targetPath = request.targetPath ?? request.filePath;
    if (!targetPath) return false;
    const filePath = path.isAbsolute(targetPath)
      ? targetPath
      : request.projectResourceUri
        ? path.resolve(
            vscode.Uri.parse(request.projectResourceUri).fsPath,
            targetPath,
          )
        : undefined;
    return filePath ? isMemoryProtectedPath(filePath) : true;
  }

  private commandApprovalKey(
    sessionId: string | undefined,
    projectId: string,
    requiredAuthority: string,
    permissionIntent: string,
    command: string,
  ): string {
    return `${projectId}:session:${sessionId ?? "unscoped"}:cmd:${requiredAuthority}:${permissionIntent}:${command}`;
  }

  private approvalKeyForRequest(request: InternalRequest): string | undefined {
    const projectPrefix = request.sourceProject?.projectId ?? "unscoped";
    switch (request.kind) {
      case "command":
        return request.fullCommand
          ? this.commandApprovalKey(
              request.sessionId,
              projectPrefix,
              request.security?.requiredAuthority ?? "unspecified",
              request.security?.permissionIntent ?? "unspecified",
              request.fullCommand,
            )
          : undefined;
      case "network":
        return undefined;
      case "write":
        return request.filePath
          ? `${projectPrefix}:write:${request.filePath}`
          : undefined;
      case "path":
        return request.filePath
          ? `${projectPrefix}:path:${request.filePath}`
          : undefined;
      case "rename":
        return request.oldName && request.newName
          ? `${projectPrefix}:rename:${request.oldName}\u2192${request.newName}`
          : undefined;
      case "memory":
        return undefined;
      default:
        return undefined;
    }
  }

  private hasRecentApproval(key: string, request?: InternalRequest): boolean {
    const ttl = this.getRecentApprovalTtl(request);
    if (ttl <= 0) return false;
    const ts = this.recentApprovals.get(key);
    if (ts === undefined) return false;
    if (Date.now() - ts > ttl) {
      this.recentApprovals.delete(key);
      return false;
    }
    return true;
  }

  private hasRecentPathApproval(request: InternalRequest): boolean {
    if (!request.filePath) return false;
    this.pruneRecentPathApprovals(request);
    return this.recentPathApprovals.some(
      (approval) =>
        approval.sessionId === request.sessionId &&
        approval.projectId === request.sourceProject?.projectId &&
        this.matchesPathApproval(request.filePath!, approval),
    );
  }

  private recordApproval(
    request: InternalRequest,
    response?:
      | CommandApprovalResponse
      | NetworkApprovalResponse
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
      const ttl = this.getRecentApprovalTtl(request);
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

    this.recentPathApprovals.push({
      ...rule,
      timestamp: Date.now(),
      sessionId: request.sessionId,
      projectId: request.sourceProject?.projectId,
      projectResourceUri: request.projectResourceUri,
    });
    this.pruneRecentPathApprovals(request);
  }

  private pruneRecentPathApprovals(request?: InternalRequest): void {
    const now = Date.now();
    this.recentPathApprovals = this.recentPathApprovals.filter((approval) => {
      const ttl = this.getRecentApprovalTtl({
        kind: "path",
        id: "recent-path",
        projectResourceUri:
          approval.projectResourceUri ?? request?.projectResourceUri,
      });
      return now - approval.timestamp <= ttl;
    });

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
    if (request.kind === "path") {
      return options?.allowPathApprovals
        ? this.hasRecentPathApproval(request)
        : false;
    }
    if (request.kind === "command") {
      const key = this.approvalKeyForRequest(request);
      return key ? this.hasRecentApproval(key, request) : false;
    }
    return false;
  }

  private makeAutoApproveResponse(
    kind: InternalRequest["kind"],
  ):
    | CommandApprovalResponse
    | NetworkApprovalResponse
    | PathApprovalResponse
    | WriteApprovalResponse
    | RenameApprovalResponse
    | MemoryApprovalResponse {
    switch (kind) {
      case "network":
        throw new Error(
          "Network approvals cannot be auto-approved by recent cache",
        );
      case "command":
        return { decision: "run-once", recentApproval: true };
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
    this.alertDisposable?.dispose();
  }
}
