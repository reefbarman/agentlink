import * as diffLib from "diff";
import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";

import type {
  ApprovalPanelProvider,
  WriteApprovalResponse,
} from "../approvals/ApprovalPanelProvider.js";

import {
  DEFAULT_DIAGNOSTIC_DELAY_MS,
  normalizeEditorText,
  type EditApplyFailureRecovery,
  type EditReviewResult,
  type EditSaveFailureRecovery,
} from "../core/capabilities/editReview.js";
import { classifyEditDurability } from "../core/editDurability.js";
import { commitAndVerifyEdit } from "./editDurability.js";
import { DIFF_VIEW_URI_SCHEME } from "./diffViewContentProvider.js";
import type { OnApprovalRequest } from "../shared/types.js";
import { diffSnapshotHub } from "../browser-gateway/DiffSnapshotHub.js";
import { randomUUID } from "crypto";
import { sleep } from "../util/sleep.js";
import { waitForDiagnosticsQuiescence } from "./diagnosticsQuiescence.js";
import { withPrimaryEditorColumn } from "../util/editorPlacement.js";

export { FileLockTimeoutError, withFileLock } from "../util/fileLock.js";

export type DiffDecision =
  | "accept"
  | "accept-session"
  | "accept-project"
  | "accept-always"
  | "reject";

interface PendingDiffDecision {
  requestId: string;
  filePath: string;
  resolve: (decision: DiffDecision) => void;
  reveal: () => Promise<void>;
}

// Map of diff request ID → pending decision metadata.
const pendingDecisionResolvers = new Map<string, PendingDiffDecision>();

// Map of absolute file path → active diff request ID.
// Used by editor title bar commands to resolve the diff for the active tab.
const pendingDiffRequestIdsByPath = new Map<string, string>();

/**
 * Resolve the diff for the currently active editor tab.
 * Falls back to resolving the single pending diff if only one exists.
 */
export async function revealPendingDiff(requestId: string): Promise<boolean> {
  const pending = pendingDecisionResolvers.get(requestId);
  if (!pending) return false;
  await pending.reveal();
  return true;
}

export function resolveCurrentDiff(decision: DiffDecision): boolean {
  if (pendingDecisionResolvers.size === 0) return false;

  // Determine which diff to resolve based on the active editor
  const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
  if (activeTab?.input instanceof vscode.TabInputTextDiff) {
    const filePath = activeTab.input.modified.fsPath;
    const requestId = pendingDiffRequestIdsByPath.get(filePath);
    const pending = requestId
      ? pendingDecisionResolvers.get(requestId)
      : undefined;
    if (requestId && pending) {
      pendingDecisionResolvers.delete(requestId);
      pendingDiffRequestIdsByPath.delete(filePath);
      pending.resolve(decision);
      return true;
    }
  }

  // Fallback: if only one diff is pending, resolve it
  if (pendingDecisionResolvers.size === 1) {
    const [requestId, pending] = pendingDecisionResolvers
      .entries()
      .next().value!;
    pendingDecisionResolvers.delete(requestId);
    pendingDiffRequestIdsByPath.delete(pending.filePath);
    pending.resolve(decision);
    return true;
  }

  return false;
}

/**
 * Show a QuickPick with session/always accept options.
 * Called from the "more options" toolbar button command.
 */
export async function showDiffMoreOptions(): Promise<void> {
  if (pendingDecisionResolvers.size === 0) return;

  const items: Array<vscode.QuickPickItem & { decision: DiffDecision }> = [
    {
      label: "$(bookmark) Accept for Session",
      description:
        "Accept this change and auto-accept future writes in this session",
      decision: "accept-session",
    },
    {
      label: "$(folder) Accept for Project",
      description:
        "Accept this change and auto-accept future writes for this project",
      decision: "accept-project",
    },
    {
      label: "$(globe) Always Accept",
      description: "Accept this change and auto-accept all future writes",
      decision: "accept-always",
    },
  ];

  const picked = await vscode.window.showQuickPick(items, {
    title: "Accept with options",
    placeHolder: "Choose scope for auto-acceptance",
    ignoreFocusOut: true,
  });

  if (picked) {
    resolveCurrentDiff(picked.decision);
  }
}

const APPROVAL_PATCH_LIMIT = 12_000;

function createApprovalPatch(
  relPath: string,
  originalContent: string,
  proposedContent: string,
): string {
  const patch = diffLib.createPatch(
    relPath,
    originalContent,
    proposedContent,
    "current",
    "proposed",
    { context: 3 },
  );
  if (patch.length <= APPROVAL_PATCH_LIMIT) return patch;
  return `${patch.slice(0, APPROVAL_PATCH_LIMIT)}\n[patch truncated at ${APPROVAL_PATCH_LIMIT} characters]`;
}

export type { FormatOnSaveReport } from "../core/editDurability.js";
export { createFormatOnSaveReport } from "../core/editDurability.js";
export { diagnoseEditSaveFailure } from "./editDurability.js";

export interface DiffResult {
  status: "accepted" | "rejected" | "rejected_by_user" | "error";
  path: string;
  operation?: "created" | "modified";
  user_edits?: string;
  format_on_save?: boolean;
  format_on_save_edits?: string;
  format_on_save_edits_omitted?: "size_cap";
  format_on_save_reverted_proposal?: true;
  eol_changed?: boolean;
  durability?: EditReviewResult["durability"];
  hint?: string;
  new_diagnostics?: string;
  finalContent?: string;
  reason?: string;
  error?: string;
  follow_up?: string;
  warnings?: string[];
  apply_failure?: EditApplyFailureRecovery;
  save_failure?: EditSaveFailureRecovery;
  next_steps?: string[];
}

export async function diagnoseEditApplyFailure(params: {
  absolutePath: string;
  baselineContent: string;
  document?: Pick<vscode.TextDocument, "getText" | "isDirty">;
}): Promise<{
  apply_failure: EditApplyFailureRecovery;
  next_steps: string[];
}> {
  let diskState: EditApplyFailureRecovery["disk_state"];
  try {
    const diskContent = await fs.readFile(params.absolutePath, "utf-8");
    diskState =
      diskContent === params.baselineContent ? "unchanged" : "changed";
  } catch (error) {
    const code =
      typeof error === "object" &&
      error !== null &&
      typeof (error as { code?: unknown }).code === "string"
        ? (error as { code: string }).code
        : undefined;
    diskState = code === "ENOENT" ? "missing" : "unreadable";
  }
  const concurrentChange =
    diskState === "changed"
      ? true
      : diskState === "unchanged"
        ? false
        : "unknown";
  const documentState = !params.document
    ? "unavailable"
    : normalizeEditorText(params.document.getText()) ===
        normalizeEditorText(params.baselineContent)
      ? "matches_baseline"
      : "differs_from_baseline";
  return {
    apply_failure: {
      document_dirty: params.document?.isDirty ?? "unavailable",
      document_state: documentState,
      disk_state: diskState,
      concurrent_change: concurrentChange,
      retryable: true,
    },
    next_steps: [
      concurrentChange === true
        ? "The file changed on disk after the proposal baseline was captured; re-read it before retrying."
        : documentState === "differs_from_baseline"
          ? "The editor content differs from the proposal baseline. Inspect and reconcile it before retrying."
          : "VS Code rejected the editor apply without exposing a detailed error. Inspect the file/editor state before retrying.",
    ],
  };
}

export function interactiveDiffEditorOptions(): vscode.TextDocumentShowOptions {
  return withPrimaryEditorColumn({ preview: true });
}

export function interactiveFallbackEditorOptions(): vscode.TextDocumentShowOptions {
  return withPrimaryEditorColumn();
}

export function createUserEditsPatch(
  relPath: string,
  proposedContent: string,
  editedContent: string,
): string | undefined {
  // User-edits patches compose before the format-on-save report, which owns
  // EOL-only change metadata.
  const eol = proposedContent.includes("\r\n") ? "\r\n" : "\n";
  const normalizedEdited = editedContent.replace(/\r\n|\n/g, eol);
  const normalizedProposed = proposedContent.replace(/\r\n|\n/g, eol);

  if (normalizedEdited === normalizedProposed) return undefined;

  return diffLib.createPatch(
    relPath,
    normalizedProposed,
    normalizedEdited,
    "proposed",
    "user-edited",
    { context: 1 },
  );
}

export class DiffViewProvider {
  private originalContent: string | undefined;
  private newContent: string | undefined;
  private relPath: string | undefined;
  private absolutePath: string | undefined;
  private activeDiffEditor: vscode.TextEditor | undefined;
  private preDiagnostics: [vscode.Uri, vscode.Diagnostic[]][] = [];
  private editType: "create" | "modify" | undefined;
  private createdDirs: string[] = [];
  private documentWasOpen = false;
  private diagnosticDelay: number;
  private outsideWorkspace = false;
  private readonly saveWithoutFormatting: boolean;

  /** Populated when the approval panel is used for write decisions */
  writeApprovalResponse?: WriteApprovalResponse;

  readonly requestId: string;

  constructor(
    diagnosticDelay?: number,
    requestId?: string,
    saveWithoutFormatting = false,
  ) {
    this.diagnosticDelay = diagnosticDelay ?? DEFAULT_DIAGNOSTIC_DELAY_MS;
    this.requestId = requestId ?? randomUUID();
    this.saveWithoutFormatting = saveWithoutFormatting;
  }

  async open(
    absolutePath: string,
    relPath: string,
    newContent: string,
    options?: { outsideWorkspace?: boolean },
  ): Promise<void> {
    this.outsideWorkspace = options?.outsideWorkspace ?? false;
    this.relPath = relPath;
    this.newContent = newContent;
    this.absolutePath = absolutePath;

    // Determine create vs modify
    let fileExists = false;
    try {
      await fs.access(this.absolutePath);
      fileExists = true;
    } catch {
      fileExists = false;
    }
    this.editType = fileExists ? "modify" : "create";

    // Read the disk baseline before touching an existing editor buffer. A dirty
    // buffer may be an orphaned AgentLink proposal; saving it here would run save
    // participants before the user has approved the review.
    this.originalContent = fileExists
      ? await fs.readFile(this.absolutePath, "utf-8")
      : "";
    if (fileExists) {
      const existingDoc = vscode.workspace.textDocuments.find(
        (doc) =>
          doc.uri.scheme === "file" && doc.uri.fsPath === this.absolutePath,
      );
      if (
        existingDoc?.isDirty &&
        existingDoc.getText() !== this.originalContent &&
        existingDoc.getText() !== newContent
      ) {
        throw new Error("File has divergent unsaved editor changes");
      }
    }

    // Capture pre-edit diagnostics
    this.preDiagnostics = vscode.languages.getDiagnostics();

    // Create directories for new files
    if (!fileExists) {
      this.createdDirs = await createDirectoriesForFile(this.absolutePath);
      await fs.writeFile(this.absolutePath, "");
    }

    // Close existing tabs showing this file
    this.documentWasOpen = false;
    const tabs = vscode.window.tabGroups.all
      .flatMap((tg) => tg.tabs)
      .filter(
        (tab) =>
          tab.input instanceof vscode.TabInputText &&
          tab.input.uri.scheme === "file" &&
          tab.input.uri.fsPath === this.absolutePath,
      );

    for (const tab of tabs) {
      this.documentWasOpen = true;
      if (!tab.isDirty) {
        await vscode.window.tabGroups.close(tab);
      }
    }

    try {
      await this.revealDiff();

      // Wait for the diff editor to open. Poll until it appears rather than
      // blocking on a fixed delay — the editor is usually visible within a few
      // tens of milliseconds, so a flat sleep wastes most of that budget on
      // every edit.
      this.activeDiffEditor = await waitForVisibleFileEditor(this.absolutePath);

      if (!this.activeDiffEditor) {
        // Fallback: open the file and try again
        const doc = await vscode.workspace.openTextDocument(this.absolutePath);
        this.activeDiffEditor = await vscode.window.showTextDocument(
          doc,
          interactiveFallbackEditorOptions(),
        );
      }

      diffSnapshotHub.upsert({
        requestId: this.requestId,
        filePath: this.relPath,
        operation: this.editType,
        originalContent: this.originalContent,
        proposedContent: this.newContent,
        outsideWorkspace: this.outsideWorkspace,
        createdAt: Date.now(),
      });
    } catch (err) {
      diffSnapshotHub.remove(this.requestId);
      throw err;
    }

    // Apply new content to the right side
    const document = this.activeDiffEditor.document;
    const edit = new vscode.WorkspaceEdit();
    const fullRange = new vscode.Range(0, 0, document.lineCount, 0);
    edit.replace(document.uri, fullRange, newContent);
    if (!(await vscode.workspace.applyEdit(edit))) {
      diffSnapshotHub.remove(this.requestId);
      if (this.editType === "create") {
        await this.cleanupCreatedFile();
      }
      throw new Error("Unable to apply proposed editor changes");
    }

    // Scroll to the first change
    const firstChangeLine = findFirstChangeLine(
      this.originalContent,
      newContent,
    );
    if (firstChangeLine >= 0) {
      const range = new vscode.Range(firstChangeLine, 0, firstChangeLine, 0);
      this.activeDiffEditor.revealRange(
        range,
        vscode.TextEditorRevealType.InCenterIfOutsideViewport,
      );
    }
  }

  private async revealDiff(): Promise<void> {
    const fileName = path.basename(this.absolutePath!);
    const leftUri = vscode.Uri.parse(
      `${DIFF_VIEW_URI_SCHEME}:${fileName}`,
    ).with({
      query: Buffer.from(this.originalContent ?? "").toString("base64"),
    });
    const outsidePrefix = this.outsideWorkspace
      ? "\u26a0 OUTSIDE WORKSPACE: "
      : "";
    await vscode.commands.executeCommand(
      "vscode.diff",
      leftUri,
      vscode.Uri.file(this.absolutePath!),
      `${outsidePrefix}${this.relPath}: ${this.editType === "modify" ? "Proposed Changes" : "New File"} (Editable)`,
      interactiveDiffEditorOptions(),
    );
  }

  async waitForUserDecision(
    approvalPanel: ApprovalPanelProvider,
    onApprovalRequest?: OnApprovalRequest,
    sessionId?: string,
    onApprovalPresented?: () => void,
  ): Promise<DiffDecision> {
    // Track UI elements for cleanup — when the decision comes from outside
    // the panel/QuickPick (title bar buttons, editor close), the UI
    // must still be disposed to avoid orphaned state.
    let disposeUI: (() => void) | undefined;

    // Show toolbar buttons via context key (true if any diff is pending)
    await vscode.commands.executeCommand(
      "setContext",
      "agentLink.diffPending",
      true,
    );

    try {
      return await new Promise<DiffDecision>((resolve) => {
        let resolved = false;

        const finish = (decision: DiffDecision) => {
          if (resolved) return;
          resolved = true;
          pendingDecisionResolvers.delete(this.requestId);
          if (this.absolutePath) {
            pendingDiffRequestIdsByPath.delete(this.absolutePath);
          }
          editorCloseDisposable.dispose();
          try {
            disposeUI?.();
          } catch {
            // Ensure resolve() always runs even if UI cleanup throws
          }
          resolve(decision);
        };

        // Allow editor title bar commands to resolve this decision
        const existingRequestId = pendingDiffRequestIdsByPath.get(
          this.absolutePath!,
        );
        if (existingRequestId && existingRequestId !== this.requestId) {
          throw new Error(
            `Pending diff decision already registered for ${this.absolutePath}`,
          );
        }
        pendingDecisionResolvers.set(this.requestId, {
          requestId: this.requestId,
          filePath: this.absolutePath!,
          resolve: finish,
          reveal: () => this.revealDiff(),
        });
        pendingDiffRequestIdsByPath.set(this.absolutePath!, this.requestId);

        // Listen for diff tab being closed (treat as rejection).
        const editorCloseDisposable = vscode.window.tabGroups.onDidChangeTabs(
          (e) => {
            if (resolved) return;
            if (e.closed.length === 0) return;
            const diffStillOpen = vscode.window.tabGroups.all
              .flatMap((tg) => tg.tabs)
              .some((tab) => {
                if (tab.input instanceof vscode.TabInputTextDiff) {
                  return tab.input.modified.fsPath === this.absolutePath;
                }
                return false;
              });
            if (!diffStillOpen) {
              finish("reject");
            }
          },
        );

        if (onApprovalRequest) {
          // Inline chat approval — show rich WriteCard in the webview
          const operation = this.editType === "create" ? "Create" : "Modify";
          const approvalPromise = onApprovalRequest(
            {
              kind: "write",
              id: this.requestId,
              title: `${operation} \`${this.relPath}\`?`,
              detail: createApprovalPatch(
                this.relPath!,
                this.originalContent ?? "",
                this.newContent ?? "",
              ),
              targetPath: this.absolutePath,
              fileWrite: {
                operation: this.editType === "create" ? "create" : "modify",
                outsideWorkspace: this.outsideWorkspace,
              },
              choices: [],
            },
            sessionId,
          );
          try {
            onApprovalPresented?.();
          } catch {
            // Diagnostic callbacks must never interfere with approval UI.
          }
          approvalPromise.then((raw) => {
            if (resolved) return;
            // Extract decision from the rich response
            const decision = typeof raw === "string" ? raw : raw.decision;
            const followUp = typeof raw === "string" ? undefined : raw.followUp;
            const rejectionReason =
              typeof raw === "string" ? undefined : raw.rejectionReason;
            // Store rich response for saveChanges() / revertChanges()
            this.writeApprovalResponse = {
              decision: decision as WriteApprovalResponse["decision"],
              followUp,
              rejectionReason,
              // Map trust scopes from the WriteCard decision
              ...(typeof raw !== "string" && {
                trustScope: (raw as Record<string, unknown>)
                  .trustScope as WriteApprovalResponse["trustScope"],
                rulePattern: (raw as Record<string, unknown>).rulePattern as
                  | string
                  | undefined,
                ruleMode: (raw as Record<string, unknown>)
                  .ruleMode as WriteApprovalResponse["ruleMode"],
              }),
            };
            finish((decision as DiffDecision) ?? "reject");
          });
          // disposeUI is a no-op since there's no panel entry to cancel
          disposeUI = () => undefined;
        } else {
          // Enqueue write approval in the panel
          const { promise: panelPromise, id: approvalId } =
            approvalPanel.enqueueWriteApproval(this.relPath!, {
              operation: this.editType!,
              outsideWorkspace: this.outsideWorkspace,
              id: this.requestId,
              sessionId,
              targetPath: this.absolutePath,
            });
          try {
            onApprovalPresented?.();
          } catch {
            // Diagnostic callbacks must never interfere with approval UI.
          }

          // If title bar or editor close resolves first, cancel the panel entry
          disposeUI = () => {
            approvalPanel.cancelApproval(approvalId);
          };

          // When panel resolves, store the rich response and map to DiffDecision
          panelPromise.then((response) => {
            if (resolved) return; // title bar or editor close already resolved
            this.writeApprovalResponse = response;
            const decisionMap: Record<string, DiffDecision> = {
              accept: "accept",
              reject: "reject",
              "accept-session": "accept-session",
              "accept-project": "accept-project",
              "accept-always": "accept-always",
            };
            finish(decisionMap[response.decision] ?? "reject");
          });
        }
      });
    } finally {
      disposeUI?.();
      // Only clear context key if no other diffs are still pending
      if (pendingDecisionResolvers.size === 0) {
        await vscode.commands.executeCommand(
          "setContext",
          "agentLink.diffPending",
          false,
        );
      }
    }
  }

  getEditedContent(): string | undefined {
    return this.activeDiffEditor?.document.getText();
  }

  async saveChanges(): Promise<DiffResult> {
    if (
      !this.relPath ||
      this.newContent === undefined ||
      !this.absolutePath ||
      !this.activeDiffEditor ||
      this.originalContent === undefined ||
      !this.editType
    ) {
      const classification = classifyEditDurability({
        relativePath: this.relPath ?? "",
        baselineExists: false,
        baselineContent: "",
        approvedContent: "",
        disk: { status: "unreadable", errorCode: "EDIT_REVIEW_STATE_MISSING" },
      });
      return {
        status: "error",
        path: this.relPath ?? "",
        error: "Edit review state is incomplete",
        reason: "edit_review_state_missing",
        durability: classification.durability,
        next_steps: [
          "Re-open the edit review and verify the target file before retrying.",
        ],
      };
    }

    const document = this.activeDiffEditor.document;
    const approvedContent = document.getText();
    const userEdits = createUserEditsPatch(
      this.relPath,
      this.newContent,
      approvedContent,
    );
    const commit = await commitAndVerifyEdit({
      document,
      absolutePath: this.absolutePath,
      relativePath: this.relPath,
      baselineExists: this.editType === "modify",
      baselineContent: this.originalContent,
      approvedContent,
      reviewState: "diff_snapshot_preserved",
      saveWithoutFormatting: this.saveWithoutFormatting,
    });

    const result: DiffResult = {
      ...commit,
      operation: this.editType === "create" ? "created" : "modified",
      ...(userEdits ? { user_edits: userEdits } : {}),
      ...(this.writeApprovalResponse?.followUp
        ? { follow_up: this.writeApprovalResponse.followUp }
        : {}),
    };

    // A failed save keeps the dirty editor and review snapshot intact so the
    // user can resolve the save problem without losing the approved content.
    if (commit.status === "error" && document.isDirty) {
      return result;
    }

    // Once save has completed, even a verification failure is a resolved
    // review. Remove the read-only browser snapshot and leave the file open for
    // inspection instead of presenting a stale pending approval.
    diffSnapshotHub.remove(this.requestId);
    await vscode.window.showTextDocument(
      vscode.Uri.file(this.absolutePath),
      withPrimaryEditorColumn({
        preview: false,
        preserveFocus: true,
      }),
    );
    await this.closeAllDiffViews();

    const newProblems = await this.waitForDiagnostics();
    if (newProblems) {
      result.new_diagnostics = newProblems;
    }
    return result;
  }

  async revertChanges(reason?: string): Promise<DiffResult> {
    if (!this.absolutePath || !this.relPath) {
      return {
        status: "rejected",
        path: this.relPath ?? "",
        ...(reason && { reason }),
      };
    }

    // Revert the in-memory document to match disk state before closing,
    // so VS Code doesn't prompt "Do you want to save?"
    const doc = vscode.workspace.textDocuments.find(
      (d) => d.uri.scheme === "file" && d.uri.fsPath === this.absolutePath,
    );
    if (doc?.isDirty) {
      const diskContent =
        this.editType === "modify" ? (this.originalContent ?? "") : "";
      const edit = new vscode.WorkspaceEdit();
      const fullRange = new vscode.Range(0, 0, doc.lineCount, 0);
      edit.replace(doc.uri, fullRange, diskContent);
      if (!(await vscode.workspace.applyEdit(edit))) {
        return {
          status: "rejected",
          path: this.relPath,
          reason: "revert_apply_failed",
          next_steps: [
            "The proposed editor changes were preserved because rollback could not be applied. Inspect the dirty editor before retrying or saving.",
          ],
        };
      }
      if (!(await doc.save())) {
        return {
          status: "rejected",
          path: this.relPath,
          reason: "revert_save_failed",
          next_steps: [
            "The rollback is present in the dirty editor but could not be saved. Inspect the editor and resolve the save issue before retrying.",
          ],
        };
      }
    }

    // Close diff views — document is clean now, no save prompt
    await this.closeAllDiffViews();

    if (this.editType === "modify") {
      // File on disk already has original content (saved back above)
      if (this.documentWasOpen) {
        const openDoc = await vscode.workspace.openTextDocument(
          this.absolutePath,
        );
        await vscode.window.showTextDocument(
          openDoc,
          withPrimaryEditorColumn({ preserveFocus: true }),
        );
      }
    } else if (this.editType === "create") {
      await this.cleanupCreatedFile();
    }

    diffSnapshotHub.remove(this.requestId);

    return {
      status: "rejected_by_user",
      path: this.relPath,
      ...(reason && { reason }),
    };
  }

  private async cleanupCreatedFile(): Promise<void> {
    if (!this.absolutePath) return;
    try {
      await fs.unlink(this.absolutePath);
    } catch {
      // ignore
    }
    for (const dir of this.createdDirs.reverse()) {
      try {
        await fs.rmdir(dir);
      } catch {
        break;
      }
    }
  }

  private async waitForDiagnostics(): Promise<string | undefined> {
    return waitForDiagnosticsQuiescence({
      delayMs: this.diagnosticDelay,
      subscribe: (onEvent) =>
        vscode.languages.onDidChangeDiagnostics((event) => {
          if (event.uris.some((uri) => uri.fsPath === this.absolutePath)) {
            onEvent();
          }
        }),
      collect: () => collectNewDiagnosticErrors(this.preDiagnostics),
    });
  }

  private async closeAllDiffViews(): Promise<void> {
    if (!this.absolutePath) return;
    await closeDiffTabsForFile(this.absolutePath);
  }
}

export function isIgnorableTabCloseError(err: unknown): boolean {
  // VS Code can race between tab enumeration and close(), returning
  // "Invalid tab not found". Match this known transient case only.
  const message = err instanceof Error ? err.message : String(err);
  return /invalid tab not found/i.test(message);
}

export async function closeDiffTabsForFile(
  absolutePath: string,
): Promise<void> {
  const tabs = vscode.window.tabGroups.all
    .flatMap((tg) => tg.tabs)
    .filter((tab) => {
      if (tab.input instanceof vscode.TabInputTextDiff) {
        return tab.input.modified.fsPath === absolutePath;
      }
      return false;
    });

  for (const tab of tabs) {
    try {
      await vscode.window.tabGroups.close(tab);
    } catch (err) {
      if (!isIgnorableTabCloseError(err)) {
        throw err;
      }
    }
  }
}

/**
 * Find the first line that differs between original and modified content.
 * Returns -1 if the contents are identical.
 */
function findFirstChangeLine(original: string, modified: string): number {
  // Normalize \r\n to \n to prevent false positives on Windows
  const origLines = original.replace(/\r\n/g, "\n").split("\n");
  const modLines = modified.replace(/\r\n/g, "\n").split("\n");
  const maxLines = Math.max(origLines.length, modLines.length);
  for (let i = 0; i < maxLines; i++) {
    if (origLines[i] !== modLines[i]) {
      return i;
    }
  }
  return -1;
}

/**
 * Create directories for a file path and return list of created dirs.
 */
async function createDirectoriesForFile(filePath: string): Promise<string[]> {
  const dir = path.dirname(filePath);
  const created: string[] = [];

  // Walk up to find first existing directory
  const parts: string[] = [];
  let current = dir;
  while (current !== path.dirname(current)) {
    try {
      await fs.access(current);
      break;
    } catch {
      parts.unshift(current);
      current = path.dirname(current);
    }
  }

  // Create directories
  for (const dirPath of parts) {
    try {
      await fs.mkdir(dirPath);
      created.push(dirPath);
    } catch {
      // Already exists (race condition)
    }
  }

  return created;
}

/**
 * Compare two sets of diagnostics and return only new ones.
 * Adapted from Roo Code's diagnostics integration.
 */
function getNewDiagnostics(
  oldDiags: [vscode.Uri, vscode.Diagnostic[]][],
  newDiags: [vscode.Uri, vscode.Diagnostic[]][],
): [vscode.Uri, vscode.Diagnostic[]][] {
  const oldMap = new Map<string, vscode.Diagnostic[]>();
  for (const [uri, diags] of oldDiags) {
    oldMap.set(uri.toString(), diags);
  }

  const result: [vscode.Uri, vscode.Diagnostic[]][] = [];

  for (const [uri, diags] of newDiags) {
    const oldFileDiags = oldMap.get(uri.toString()) ?? [];
    const newFileDiags = diags.filter(
      (newDiag) =>
        !oldFileDiags.some(
          (oldDiag) =>
            oldDiag.message === newDiag.message &&
            oldDiag.range.start.line === newDiag.range.start.line &&
            oldDiag.severity === newDiag.severity,
        ),
    );
    if (newFileDiags.length > 0) {
      result.push([uri, newFileDiags]);
    }
  }

  return result;
}

function collectNewDiagnosticErrors(
  preDiagnostics: [vscode.Uri, vscode.Diagnostic[]][],
): string | undefined {
  const newProblems = getNewDiagnostics(
    preDiagnostics,
    vscode.languages.getDiagnostics(),
  );
  const lines: string[] = [];
  for (const [, diagnostics] of newProblems) {
    for (const diagnostic of diagnostics) {
      if (diagnostic.severity !== vscode.DiagnosticSeverity.Error) continue;
      lines.push(
        `Line ${diagnostic.range.start.line + 1}: ${diagnostic.message}`,
      );
    }
  }
  return lines.length > 0 ? lines.join("\n") : undefined;
}

/**
 * Poll for the visible file editor backing a diff view instead of blocking on a
 * fixed delay. VS Code typically reports the editor within a few tens of
 * milliseconds of `vscode.diff` resolving; returning as soon as it appears
 * shaves most of the previous flat 300ms wait off every interactive edit.
 * Returns undefined if the editor never becomes visible before the timeout, so
 * callers can fall back to opening the document directly.
 */
async function waitForVisibleFileEditor(
  absolutePath: string,
  timeoutMs = 500,
  intervalMs = 20,
): Promise<vscode.TextEditor | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const editor = vscode.window.visibleTextEditors.find(
      (e) =>
        e.document.uri.scheme === "file" &&
        e.document.uri.fsPath === absolutePath,
    );
    if (editor) return editor;
    if (Date.now() >= deadline) return undefined;
    await sleep(intervalMs);
  }
}

/**
 * Standalone diagnostic collection for auto-approved writes.
 * Snapshots diagnostics before a write and eagerly registers the
 * onDidChangeDiagnostics listener so no events are missed during
 * the write/open/sync sequence. Call collectNewErrors() after the
 * write to wait for results.
 *
 * Usage:
 *   const snap = snapshotDiagnostics(filePath);
 *   // ... perform the write, open document, etc. ...
 *   const diagnostics = await snap.collectNewErrors(delay);
 */
export function snapshotDiagnostics(filePath: string): {
  collectNewErrors: (delayMs: number) => Promise<string | undefined>;
  dispose(): void;
} {
  const preDiagnostics = vscode.languages.getDiagnostics();

  // Track diagnostic events eagerly — before the write happens —
  // so we never miss events that fire during write/open/sync.
  let gotEvent = false;
  const disposable = vscode.languages.onDidChangeDiagnostics((e) => {
    if (e.uris.some((u) => u.fsPath === filePath)) {
      gotEvent = true;
    }
  });

  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    disposable.dispose();
  };

  return {
    collectNewErrors(delayMs: number): Promise<string | undefined> {
      return waitForDiagnosticsQuiescence({
        delayMs,
        hadEvent: gotEvent,
        subscribe: (onEvent) =>
          vscode.languages.onDidChangeDiagnostics((event) => {
            if (event.uris.some((uri) => uri.fsPath === filePath)) {
              onEvent();
            }
          }),
        collect: () => collectNewDiagnosticErrors(preDiagnostics),
        eagerDisposables: [{ dispose }],
      });
    },
    dispose,
  };
}
