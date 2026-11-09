import { createHash } from "node:crypto";
import * as path from "node:path";
import * as fs from "fs/promises";
import * as vscode from "vscode";
import { parse as parseYaml } from "yaml";

import type {
  AutoSaveRecovery,
  EditReviewResult,
  EditSaveFailureRecovery,
} from "../core/capabilities/editReview.js";
import {
  classifyEditDurability,
  deriveExpectedDiskContent,
  getEditDurabilityPolicy,
  normalizeEditorText,
  type EditDiskObservation,
  type EditDurabilityPolicy,
} from "../core/editDurability.js";
import { canonicalizePath } from "../util/canonicalPath.js";
import { MAX_EDITOR_RECOVERY_BYTES } from "./editorRecoveryPolicy.js";
import { primaryEditorColumn } from "../util/editorPlacement.js";
import { workHistoryRegistry } from "../agent/WorkHistoryRegistry.js";

export interface CommitAndVerifyEditRequest {
  document: vscode.TextDocument;
  absolutePath: string;
  relativePath: string;
  baselineExists: boolean;
  baselineContent: string;
  approvedContent: string;
  reviewState: EditSaveFailureRecovery["review_state"];
  saveWithoutFormatting?: boolean;
  /**
   * The edit was auto-approved and is not on screen. Do not leave temporary
   * tabs open, and when a save of the agent's own unchanged buffer fails,
   * recover it (late-save check, one retry, then revert to disk) instead of
   * leaving a dirty buffer that needs human-reviewed save_editor recovery.
   */
  autoApproved?: boolean;
  /**
   * The clean document is known not to reflect disk yet, so an exact disk
   * write should not wait for it to reload before verifying.
   */
  editorKnownStale?: boolean;
}

export interface CommitAndVerifyEditResult extends EditReviewResult {
  status: "accepted" | "error";
  path: string;
}

/**
 * Bounded waits used by editor-free auto-approved commits. Mutable so tests
 * can shorten them; production code must not change these values.
 */
export const autoSaveRecoveryTiming = {
  /** How long a failed save may take to land before it is retried. */
  lateSaveGraceMs: 500,
  /** How long an exact disk write waits for VS Code to reload the document. */
  documentReloadTimeoutMs: 2_000,
  /**
   * How long an auto-approved edit waits for a clean document that is out of
   * date with disk to reload before writing to disk directly instead.
   */
  editorSyncTimeoutMs: 1_500,
};

let preservingSaveTail: Promise<void> = Promise.resolve();

let editCommitLogger: ((message: string) => void) | undefined;

/**
 * Route edit-commit diagnostics (commit path, stale editor copies, save
 * failures and their recovery) to a host log. Pass undefined to disable.
 */
export function setEditCommitLogger(
  logger: ((message: string) => void) | undefined,
): void {
  editCommitLogger = logger;
}

export function logEditCommit(message: string): void {
  try {
    editCommitLogger?.(`[edit-commit] ${message}`);
  } catch {
    // Diagnostics must never affect the edit itself.
  }
}

/**
 * Clean documents that already failed to catch up with disk, keyed by the
 * document object and the version that was stale. A later edit of the same
 * unchanged document skips the wait instead of paying it again.
 */
const staleDocumentVersions = new WeakMap<vscode.TextDocument, number>();

/**
 * Wait until a clean document reflects `diskContent`.
 *
 * VS Code reloads a clean document only when its file watcher reports the
 * change, which can lag behind writes by other processes or by AgentLink's
 * own direct writes. Editing and saving a document before it reloads makes
 * VS Code show a "file is newer" Compare/Overwrite dialog, so auto-approved
 * edits must not save through a document that is out of date with disk.
 *
 * Returns true when the document is clean and matches disk, false when it is
 * dirty or stays out of date for `editorSyncTimeoutMs`.
 */
export async function waitForDocumentToMatchDisk(
  document: vscode.TextDocument,
  absolutePath: string,
  diskContent: string,
): Promise<boolean> {
  const inSync = () =>
    documentMatchesTarget(document, absolutePath) &&
    !document.isDirty &&
    documentTextMatchesDisk(document.getText(), diskContent);
  if (inSync()) {
    staleDocumentVersions.delete(document);
    return true;
  }
  if (document.isDirty || !documentMatchesTarget(document, absolutePath)) {
    return false;
  }
  if (staleDocumentVersions.get(document) === document.version) return false;

  const startedAt = Date.now();
  const synced = await waitForDocumentState(
    document,
    inSync,
    autoSaveRecoveryTiming.editorSyncTimeoutMs,
  );
  if (synced) {
    staleDocumentVersions.delete(document);
    logEditCommit(
      `editor copy caught up with disk after ${Date.now() - startedAt}ms: ${absolutePath}`,
    );
  } else {
    staleDocumentVersions.set(document, document.version);
    logEditCommit(
      `editor copy still out of date with disk after ${Date.now() - startedAt}ms: ${absolutePath}`,
    );
  }
  return synced;
}

/**
 * True when VS Code's text for a clean document represents `diskContent`.
 * The comparison is exact apart from a UTF-8 BOM, so a line-ending-only
 * change on disk still counts as out of date. The one exception is a file
 * with mixed line endings, which VS Code normalizes to a single EOL when it
 * loads it, so its text can never match byte for byte.
 */
export function documentTextMatchesDisk(
  documentText: string,
  diskContent: string,
): boolean {
  const disk = diskContent.replace(/^\uFEFF/, "");
  if (documentText === disk) return true;
  const mixedLineEndings = disk.includes("\r\n") && /(^|[^\r])\n/.test(disk);
  return (
    mixedLineEndings &&
    normalizeEditorText(documentText) === normalizeEditorText(disk)
  );
}

/**
 * True when an edit can be written to disk as UTF-8 without changing how
 * VS Code decoded the file. Hosts without the `encoding` API fall back to
 * checking that the disk text decoded without replacement characters.
 */
export function canWriteDocumentDirectly(
  document: vscode.TextDocument,
  diskContent: string,
): boolean {
  const encoding = (document as { encoding?: string }).encoding;
  if (encoding !== undefined) {
    return encoding === "utf8" || encoding === "utf8bom";
  }
  return !diskContent.includes("\uFFFD");
}

/**
 * Save one approved editor state and verify its durable disk representation.
 * Callers must hold the per-file edit lock for the complete operation.
 *
 * Verified saves are recorded in the running tool call's work history, from
 * the disk baseline to the content actually saved.
 */
export async function commitAndVerifyEdit(
  request: CommitAndVerifyEditRequest,
): Promise<CommitAndVerifyEditResult> {
  return recordCommittedEdit(
    request,
    await commitAndVerifyEditUnrecorded(request),
  );
}

/**
 * Persist an exact (no save participant) edit straight to disk without
 * routing it through the editor buffer or an active editor, then verify it.
 * The document must be clean and match the disk baseline; VS Code reloads the
 * clean document from disk. Callers must hold the per-file edit lock.
 */
export async function commitExactEditToDisk(
  request: CommitAndVerifyEditRequest,
): Promise<CommitAndVerifyEditResult> {
  return recordCommittedEdit(
    request,
    await commitExactEditToDiskUnrecorded(request),
  );
}

function recordCommittedEdit(
  request: CommitAndVerifyEditRequest,
  result: CommitAndVerifyEditResult,
): CommitAndVerifyEditResult {
  if (result.status === "accepted" && result.finalContent !== undefined) {
    workHistoryRegistry.recordCommittedEdit({
      absolutePath: request.absolutePath,
      displayPath: request.relativePath,
      before: {
        exists: request.baselineExists,
        content: request.baselineContent,
      },
      after: { exists: true, content: result.finalContent },
      formatted: result.durability?.outcome === "transformed",
    });
  }
  return result;
}

async function commitAndVerifyEditUnrecorded(
  request: CommitAndVerifyEditRequest,
): Promise<CommitAndVerifyEditResult> {
  const policy = request.saveWithoutFormatting
    ? "preserve_exact"
    : getEditDurabilityPolicy(request.relativePath);
  const expectedDiskContent = deriveExpectedDiskContent(
    request.baselineContent,
    request.approvedContent,
  );
  if (!documentMatchesTarget(request.document, request.absolutePath)) {
    const disk = await observeDisk(request.absolutePath);
    const classification = classifyEditDurability({
      relativePath: request.relativePath,
      baselineExists: request.baselineExists,
      baselineContent: request.baselineContent,
      approvedContent: request.approvedContent,
      editorContent: request.document.getText(),
      disk,
      policy,
    });
    return {
      status: "error",
      path: request.relativePath,
      error: "Edit document does not match the target file",
      reason: "document_target_mismatch",
      durability: {
        ...classification.durability,
        status: "failed",
        outcome: "unverifiable",
        requires_reread: true,
      },
      ...(disk.status === "readable" ? { finalContent: disk.content } : {}),
      next_steps: [
        "Inspect any retained buffer in VS Code before closing or saving it. get_editor_state can inspect only an open file-backed target editor; re-read the target and compose the edit again after reconciling the buffer.",
      ],
    };
  }

  let autoRecovery: AutoSaveRecovery | undefined;
  if (request.document.isDirty) {
    const saveAttemptContent = request.document.getText();
    let saved = false;
    let saveException: unknown;
    let saveOutcome: "returned_false" | "exception" = "returned_false";
    let saveReason: "save_failed" | "preserving_save_failed" = "save_failed";

    try {
      if (policy === "preserve_exact") {
        saveReason = "preserving_save_failed";
        saved = await withPreservingSaveCoordinator(() =>
          saveWithoutFormatting(
            request.document,
            request.absolutePath,
            undefined,
            { closeOpenedTab: request.autoApproved },
          ),
        );
      } else {
        saved = await request.document.save();
      }
    } catch (error) {
      saved = false;
      saveException = error;
      saveOutcome = "exception";
    }

    if (!saved) {
      logEditCommit(
        `${policy === "preserve_exact" ? "exact" : "ordinary"} editor save failed (${saveOutcome}${
          saveException
            ? `: ${boundedSaveErrorMessage(saveException) ?? "no detail"}`
            : ""
        }): ${request.absolutePath}`,
      );
    }
    if (!saved && request.autoApproved) {
      autoRecovery = await recoverFailedAutoSave({
        document: request.document,
        absolutePath: request.absolutePath,
        policy,
        saveAttemptContent,
        approvedContent: request.approvedContent,
        baselineContent: request.baselineContent,
        expectedDiskContent,
      });
      logEditCommit(
        `auto-save recovery: ${autoRecovery ?? "not possible"}: ${request.absolutePath}`,
      );
      saved =
        autoRecovery === "late_save_detected" ||
        autoRecovery === "save_retried";
    }

    if (!saved && autoRecovery === "buffer_reverted_to_disk") {
      const disk = await observeDisk(request.absolutePath);
      const classification = classifyEditDurability({
        relativePath: request.relativePath,
        baselineExists: request.baselineExists,
        baselineContent: request.baselineContent,
        approvedContent: request.approvedContent,
        editorContent: request.document.getText(),
        disk,
        policy,
        saveOutcome,
      });
      const diskChanged =
        disk.status !== "readable" || disk.content !== request.baselineContent;
      return {
        status: "error",
        path: request.relativePath,
        error:
          saveReason === "preserving_save_failed"
            ? "File could not be saved without formatting"
            : "File save failed",
        reason: saveReason,
        auto_recovery: autoRecovery,
        durability: classification.durability,
        next_steps: [
          "VS Code did not save the auto-approved edit, and one automatic retry also failed. The editor buffer only held this edit, so AgentLink reverted it to the file on disk: no unsaved changes remain and the edit was not applied.",
          diskChanged
            ? "The file changed on disk after the edit baseline was captured; re-read it before composing the edit again."
            : "The file still matches the pre-edit baseline. Retry the same edit once; if it fails again, check whether the file is read-only or a save participant is rejecting the save.",
        ],
      };
    }

    if (!saved) {
      const disk = await observeDisk(request.absolutePath);
      const classification = classifyEditDurability({
        relativePath: request.relativePath,
        baselineExists: request.baselineExists,
        baselineContent: request.baselineContent,
        approvedContent: request.approvedContent,
        editorContent: request.document.getText(),
        disk,
        policy,
        saveOutcome,
      });
      const recovery = await diagnoseEditSaveFailure({
        absolutePath: request.absolutePath,
        baselineContent: request.baselineContent,
        documentDirty: request.document.isDirty,
        saveAttemptContent,
        currentDocumentContent: request.document.getText(),
        reviewState: request.reviewState,
        saveException,
        saveOutcome,
      });
      return {
        status: "error",
        path: request.relativePath,
        error:
          saveReason === "preserving_save_failed"
            ? "File could not be saved without formatting"
            : "File save failed",
        reason: saveReason,
        durability: classification.durability,
        ...classification.formatOnSaveReport,
        ...recovery,
      };
    }
  } else if (
    request.document.getText() === request.approvedContent &&
    request.baselineContent !== expectedDiskContent
  ) {
    // A clean VS Code document can briefly retain stale text after an external
    // disk change. With no editor change to save, persist the approved storage
    // representation directly while the caller still owns the file lock.
    await fs.writeFile(request.absolutePath, expectedDiskContent, "utf-8");
  }

  const verified = await verifyCommittedEdit(
    request,
    policy,
    expectedDiskContent,
    request.document.getText(),
  );
  return autoRecovery ? { ...verified, auto_recovery: autoRecovery } : verified;
}

/**
 * Observe and classify the committed disk state. Pass `editorContent` as
 * undefined only when the editor buffer is known not to reflect the commit
 * yet (an exact disk write VS Code has not reloaded).
 */
async function verifyCommittedEdit(
  request: CommitAndVerifyEditRequest,
  policy: EditDurabilityPolicy,
  expectedDiskContent: string,
  editorContent: string | undefined,
): Promise<CommitAndVerifyEditResult> {
  const disk = await observeDisk(request.absolutePath);
  let classification = classifyEditDurability({
    relativePath: request.relativePath,
    baselineExists: request.baselineExists,
    baselineContent: request.baselineContent,
    approvedContent: request.approvedContent,
    editorContent,
    disk,
    policy,
  });

  if (
    classification.durability.status === "durable" &&
    classification.durability.outcome === "transformed" &&
    disk.status === "readable" &&
    approvedStructuredContentBecameInvalid(
      request.relativePath,
      expectedDiskContent,
      disk.content,
    )
  ) {
    const transformedContent = disk.content;
    if (
      !request.document.isDirty &&
      request.document.getText() === transformedContent &&
      documentMatchesTarget(request.document, request.absolutePath)
    ) {
      const restored = await replaceDocumentContent(
        request.document,
        request.approvedContent,
      );
      const preserved =
        restored &&
        (await withPreservingSaveCoordinator(() =>
          saveWithoutFormatting(
            request.document,
            request.absolutePath,
            undefined,
            { closeOpenedTab: request.autoApproved },
          ),
        ));
      if (preserved) {
        const recoveredDisk = await observeDisk(request.absolutePath);
        classification = classifyEditDurability({
          relativePath: request.relativePath,
          baselineExists: request.baselineExists,
          baselineContent: request.baselineContent,
          approvedContent: request.approvedContent,
          editorContent: request.document.getText(),
          disk: recoveredDisk,
          policy: "preserve_exact",
        });
        if (classification.durability.status === "durable") {
          return {
            status: "accepted",
            path: request.relativePath,
            durability: classification.durability,
            ...(recoveredDisk.status === "readable"
              ? { finalContent: recoveredDisk.content }
              : {}),
          };
        }
      }
    }
    return {
      status: "error",
      path: request.relativePath,
      error: "Save transformation made structured content invalid",
      reason: "transformed_content_invalid",
      durability: {
        ...classification.durability,
        status: "failed",
        requires_reread: true,
      },
      finalContent: transformedContent,
      next_steps: [
        "Inspect the transformed editor content and save-participant configuration before retrying.",
      ],
    };
  }

  if (classification.durability.status !== "durable") {
    return {
      status: "error",
      path: request.relativePath,
      error:
        classification.error ?? "Edited file could not be verified after save",
      reason: classification.failureReason ?? "post_save_verification_failed",
      durability: classification.durability,
      ...classification.formatOnSaveReport,
      ...(classification.nextSteps
        ? { next_steps: classification.nextSteps }
        : {}),
      ...(disk.status === "readable" ? { finalContent: disk.content } : {}),
    };
  }

  return {
    status: "accepted",
    path: request.relativePath,
    durability: classification.durability,
    ...classification.formatOnSaveReport,
    ...(disk.status === "readable" ? { finalContent: disk.content } : {}),
  };
}

async function withPreservingSaveCoordinator<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const previous = preservingSaveTail;
  let release!: () => void;
  preservingSaveTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

export async function saveVerifiedEditorDocument(
  document: vscode.TextDocument,
  absolutePath: string,
  validate: () => Promise<boolean>,
): Promise<boolean> {
  return withPreservingSaveCoordinator(() =>
    saveWithoutFormatting(document, absolutePath, validate),
  );
}

interface ActiveDocumentOptions {
  /**
   * Close the target tab afterwards when no tab showed it beforehand, so an
   * auto-approved edit leaves no editor behind.
   */
  closeOpenedTab?: boolean;
}

async function saveWithoutFormatting(
  document: vscode.TextDocument,
  absolutePath: string,
  validate?: () => Promise<boolean>,
  options: ActiveDocumentOptions = {},
): Promise<boolean> {
  const ran = await withTemporarilyActiveDocument(
    document,
    absolutePath,
    options,
    async () => {
      if (validate && !(await validate())) return false;
      if (
        validate &&
        (vscode.window.activeTextEditor?.document !== document ||
          !documentMatchesTarget(document, absolutePath))
      )
        return false;
      await vscode.commands.executeCommand(
        "workbench.action.files.saveWithoutFormatting",
      );
      return true;
    },
  );
  // Saving can finish while editor restoration awaits. Read the completion
  // state after cleanup, not before it; callers still verify disk durability.
  return ran && !document.isDirty;
}

/**
 * Run an active-editor workbench command against `document` without taking
 * keyboard focus, then restore the previous editor and close temporary tabs.
 * Returns false without running `operation` when the document cannot be made
 * the active editor.
 */
async function withTemporarilyActiveDocument(
  document: vscode.TextDocument,
  absolutePath: string,
  options: ActiveDocumentOptions,
  operation: () => Promise<boolean>,
): Promise<boolean> {
  if (!documentMatchesTarget(document, absolutePath)) return false;
  const previousEditor = vscode.window.activeTextEditor;
  const targetPath = canonicalizePath(absolutePath);
  const tabWasOpen =
    !options.closeOpenedTab ||
    (vscode.window.tabGroups?.all ?? []).some((group) =>
      findTextTab(group, targetPath),
    );
  // VS Code cannot activate another editor group without taking keyboard
  // focus, so this briefly opens the document in the active group. When
  // that group is not the primary one, close the temporary tab afterwards so
  // agent-edited files only stay open in the primary (left) column.
  const activeGroup = vscode.window.tabGroups?.activeTabGroup;
  const temporaryTabGroup =
    activeGroup &&
    activeGroup.viewColumn !== primaryEditorColumn() &&
    !findTextTab(activeGroup, targetPath)
      ? activeGroup
      : undefined;
  // Workbench file commands need an active editor, not keyboard focus. Keeping
  // focus in the sidebar lets the user continue typing meanwhile.
  const targetEditor = await vscode.window.showTextDocument(document, {
    preview: false,
    preserveFocus: true,
  });

  try {
    if (
      targetEditor?.document !== document ||
      vscode.window.activeTextEditor?.document !== document ||
      !documentMatchesTarget(document, absolutePath)
    ) {
      return false;
    }
    return await operation();
  } finally {
    const activePath = vscode.window.activeTextEditor?.document.uri.fsPath;
    if (
      previousEditor &&
      canonicalizePath(previousEditor.document.uri.fsPath) !== targetPath &&
      activePath &&
      canonicalizePath(activePath) === targetPath
    ) {
      await vscode.window.showTextDocument(previousEditor.document, {
        preview: false,
        preserveFocus: true,
        ...(previousEditor.viewColumn
          ? { viewColumn: previousEditor.viewColumn }
          : {}),
      });
    }
    if (temporaryTabGroup) {
      const group = vscode.window.tabGroups.all.find(
        (candidate) => candidate.viewColumn === temporaryTabGroup.viewColumn,
      );
      const tab = group && findTextTab(group, targetPath);
      // A dirty tab holds a failed save; leave it for the user to inspect.
      if (tab && !tab.isDirty) {
        await vscode.window.tabGroups.close(tab, true);
      }
    }
    if (!tabWasOpen) {
      for (const group of vscode.window.tabGroups?.all ?? []) {
        const tab = findTextTab(group, targetPath);
        if (tab && !tab.isDirty) {
          await vscode.window.tabGroups.close(tab, true);
        }
      }
    }
  }
}

/**
 * Recover a failed save of an auto-approved edit whose buffer still holds
 * exactly the approved content: wait briefly for a late save, retry once, and
 * finally revert the agent-only buffer to disk so no dirty buffer needs
 * human-reviewed save_editor recovery. Returns undefined, touching nothing,
 * when the buffer changed (for example the user typed into it).
 */
async function recoverFailedAutoSave(params: {
  document: vscode.TextDocument;
  absolutePath: string;
  policy: EditDurabilityPolicy;
  saveAttemptContent: string;
  approvedContent: string;
  baselineContent: string;
  expectedDiskContent: string;
}): Promise<AutoSaveRecovery | undefined> {
  const { document, absolutePath } = params;
  const ownsBuffer = () =>
    documentMatchesTarget(document, absolutePath) &&
    document.getText() === params.saveAttemptContent &&
    normalizeEditorText(params.saveAttemptContent) ===
      normalizeEditorText(params.approvedContent);
  if (!ownsBuffer()) return undefined;

  if (
    await waitForDocumentState(
      document,
      () => !document.isDirty,
      autoSaveRecoveryTiming.lateSaveGraceMs,
    )
  ) {
    return "late_save_detected";
  }
  if (!ownsBuffer()) return undefined;

  // When disk moved away from the baseline (another writer, or a document
  // VS Code had not reloaded), VS Code failed with a "file is newer"
  // conflict. Retrying would show that Compare/Overwrite dialog again, and
  // overwriting would discard the other change, so go straight to revert.
  const disk = await observeDisk(absolutePath);
  const diskConflict =
    disk.status === "readable" &&
    disk.content !== params.baselineContent &&
    disk.content !== params.expectedDiskContent;
  if (diskConflict) {
    logEditCommit(
      `failed save conflicts with a newer file on disk; skipping retry: ${absolutePath}`,
    );
  } else {
    try {
      const saved =
        params.policy === "preserve_exact"
          ? await withPreservingSaveCoordinator(() =>
              saveWithoutFormatting(document, absolutePath, undefined, {
                closeOpenedTab: true,
              }),
            )
          : await document.save();
      if (saved || !document.isDirty) return "save_retried";
    } catch {
      if (!document.isDirty) return "save_retried";
    }
    if (!document.isDirty) return "save_retried";
  }
  if (!ownsBuffer()) return undefined;
  // Revert is destructive and acts on the active editor. Only use it while no
  // tab shows the file, so nobody can be typing into the buffer meanwhile.
  const targetPath = canonicalizePath(absolutePath);
  if (
    (vscode.window.tabGroups?.all ?? []).some((group) =>
      findTextTab(group, targetPath),
    )
  ) {
    return undefined;
  }

  try {
    await withPreservingSaveCoordinator(() =>
      withTemporarilyActiveDocument(
        document,
        absolutePath,
        { closeOpenedTab: true },
        async () => {
          if (
            !ownsBuffer() ||
            vscode.window.activeTextEditor?.document !== document
          )
            return false;
          await vscode.commands.executeCommand("workbench.action.files.revert");
          return true;
        },
      ),
    );
  } catch {
    // Fall through: the dirty buffer stays for the ordinary recovery path.
  }
  return document.isDirty ? undefined : "buffer_reverted_to_disk";
}

/**
 * Resolve true as soon as `predicate` holds after a change or save of
 * `document`, or false once `timeoutMs` passes without it holding.
 */
async function waitForDocumentState(
  document: vscode.TextDocument,
  predicate: () => boolean,
  timeoutMs: number,
  start?: () => Promise<void>,
): Promise<boolean> {
  let settle!: (value: boolean) => void;
  const settled = new Promise<boolean>((resolve) => {
    settle = resolve;
  });
  const onEvent = (changed: vscode.TextDocument) => {
    if (changed === document && predicate()) settle(true);
  };
  // Some hosts (and test doubles) omit these events; the timeout still bounds
  // the wait and the final predicate check reports the outcome.
  const subscriptions = [
    vscode.workspace.onDidChangeTextDocument?.((event) =>
      onEvent(event.document),
    ),
    vscode.workspace.onDidSaveTextDocument?.(onEvent),
  ];
  const timer = setTimeout(() => settle(predicate()), timeoutMs);
  try {
    await start?.();
    if (predicate()) return true;
    return await settled;
  } finally {
    clearTimeout(timer);
    for (const subscription of subscriptions) subscription?.dispose();
  }
}

async function commitExactEditToDiskUnrecorded(
  request: CommitAndVerifyEditRequest,
): Promise<CommitAndVerifyEditResult> {
  const expectedDiskContent = deriveExpectedDiskContent(
    request.baselineContent,
    request.approvedContent,
  );
  const document = request.document;
  // The per-file lock only excludes AgentLink. Never overwrite a file that
  // another process changed since the baseline was captured.
  const current = await observeDisk(request.absolutePath);
  if (
    current.status !== "readable" ||
    current.content !== request.baselineContent
  ) {
    return {
      status: "error",
      path: request.relativePath,
      error: "File changed on disk before the exact save",
      reason: "apply_edit_failed",
      next_steps: [
        "The file changed on disk after the edit baseline was captured and was not overwritten. Re-read it before composing the edit again.",
      ],
    };
  }
  // Writing beneath unsaved editor changes would leave them to conflict with
  // disk when the user saves, so re-check right before the write.
  if (
    document.isDirty ||
    !documentMatchesTarget(document, request.absolutePath)
  ) {
    return {
      status: "error",
      path: request.relativePath,
      error: "File has unsaved editor changes",
      reason: "dirty_document_conflict",
      document_dirty: document.isDirty,
      next_steps: [
        "The file gained unsaved editor changes before the write, so disk was not changed. Reconcile the editor buffer in VS Code, re-read the file, and compose the edit again.",
      ],
    };
  }
  const normalizedApproved = normalizeEditorText(request.approvedContent);
  const editorReloaded = () =>
    documentMatchesTarget(document, request.absolutePath) &&
    !document.isDirty &&
    normalizeEditorText(document.getText()) === normalizedApproved;
  let writeError: unknown;
  // Subscribe before writing so a fast reload cannot be missed.
  const reloaded = await waitForDocumentState(
    document,
    editorReloaded,
    request.editorKnownStale
      ? 0
      : autoSaveRecoveryTiming.documentReloadTimeoutMs,
    async () => {
      try {
        await fs.writeFile(request.absolutePath, expectedDiskContent, "utf-8");
      } catch (error) {
        writeError = error;
        throw error;
      }
    },
  ).catch(() => false);

  if (writeError !== undefined) {
    const disk = await observeDisk(request.absolutePath);
    const classification = classifyEditDurability({
      relativePath: request.relativePath,
      baselineExists: request.baselineExists,
      baselineContent: request.baselineContent,
      approvedContent: request.approvedContent,
      editorContent: document.getText(),
      disk,
      policy: "preserve_exact",
      saveOutcome: "exception",
    });
    const message = boundedSaveErrorMessage(writeError);
    return {
      status: "error",
      path: request.relativePath,
      error: "File could not be saved without formatting",
      reason: "preserving_save_failed",
      durability: classification.durability,
      next_steps: [
        `Writing the file failed${message ? ` (${message})` : ""}. The editor buffer was not changed. Re-read the file and check its permissions before retrying.`,
      ],
    };
  }

  // A clean document that VS Code has not reloaded yet still shows an older
  // disk version (the baseline, or something earlier when it was already out
  // of date); verify disk alone rather than report a false divergence. A
  // clean document holds no unsaved work. A buffer that became dirty
  // meanwhile will not reload, so it is verified against disk and reported
  // if it diverges.
  const editorStale =
    !reloaded &&
    documentMatchesTarget(document, request.absolutePath) &&
    !document.isDirty &&
    normalizeEditorText(document.getText()) !== normalizedApproved;
  const verified = await verifyCommittedEdit(
    request,
    "preserve_exact",
    expectedDiskContent,
    editorStale ? undefined : document.getText(),
  );
  if (!editorStale || verified.status !== "accepted") return verified;
  return {
    ...verified,
    warnings: [
      ...(verified.warnings ?? []),
      "The file was verified on disk, but VS Code had not reloaded its open copy yet. It reloads unchanged buffers automatically.",
    ],
  };
}

function findTextTab(
  group: vscode.TabGroup,
  targetPath: string,
): vscode.Tab | undefined {
  return group.tabs.find(
    (tab) =>
      tab.input instanceof vscode.TabInputText &&
      tab.input.uri.scheme === "file" &&
      canonicalizePath(tab.input.uri.fsPath) === targetPath,
  );
}

async function replaceDocumentContent(
  document: vscode.TextDocument,
  content: string,
): Promise<boolean> {
  const edit = new vscode.WorkspaceEdit();
  edit.replace(
    document.uri,
    new vscode.Range(
      document.positionAt(0),
      document.positionAt(document.getText().length),
    ),
    content,
  );
  return vscode.workspace.applyEdit(edit);
}

function approvedStructuredContentBecameInvalid(
  relativePath: string,
  approvedContent: string,
  finalContent: string,
): boolean {
  const extension = path.extname(relativePath).toLowerCase();
  if (extension === ".json") {
    try {
      JSON.parse(approvedContent);
    } catch {
      return false;
    }
    try {
      JSON.parse(finalContent);
      return false;
    } catch {
      return true;
    }
  }
  if (extension === ".yaml" || extension === ".yml") {
    try {
      parseYaml(approvedContent, { strict: true });
    } catch {
      return false;
    }
    try {
      parseYaml(finalContent, { strict: true });
      return false;
    } catch {
      return true;
    }
  }
  return false;
}

export function documentMatchesTarget(
  document: vscode.TextDocument,
  absolutePath: string,
): boolean {
  return (
    document.uri.scheme === "file" &&
    !document.isClosed &&
    canonicalizePath(document.uri.fsPath) === canonicalizePath(absolutePath)
  );
}

export interface DocumentStateSnapshot {
  version: number;
  text: string;
  isDirty: boolean;
}

export function captureDocumentState(
  document: vscode.TextDocument,
): DocumentStateSnapshot {
  return {
    version: document.version,
    text: document.getText(),
    isDirty: document.isDirty,
  };
}

/**
 * True when the target document was closed, retargeted, or its content or
 * dirty state changed since the snapshot. A bare version bump with identical
 * text (for example a reload of unchanged content from a network mount or a
 * freshly written placeholder) is not treated as a change.
 */
export function documentChangedSince(
  document: vscode.TextDocument,
  absolutePath: string,
  snapshot: DocumentStateSnapshot,
): boolean {
  if (!documentMatchesTarget(document, absolutePath)) return true;
  if (document.version === snapshot.version) return false;
  return (
    document.isDirty !== snapshot.isDirty ||
    document.getText() !== snapshot.text
  );
}

async function observeDisk(absolutePath: string): Promise<EditDiskObservation> {
  try {
    const bytes = await fs.readFile(absolutePath);
    return {
      status: "readable",
      content: bytes.toString("utf-8"),
      contentHash: createHash("sha256").update(bytes).digest("hex"),
    };
  } catch (error) {
    const errorCode =
      typeof error === "object" &&
      error !== null &&
      typeof (error as { code?: unknown }).code === "string"
        ? (error as { code: string }).code
        : undefined;
    return errorCode === "ENOENT"
      ? { status: "missing", ...(errorCode ? { errorCode } : {}) }
      : { status: "unreadable", ...(errorCode ? { errorCode } : {}) };
  }
}

function boundedSaveErrorMessage(error: unknown): string | undefined {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : undefined;
  if (!message?.trim()) return undefined;
  return message
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*/g, "[REDACTED]")
    .replace(/\b(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[REDACTED]@")
    .replace(
      /\b(authorization\s*[:=]\s*)(?:"[^"]*"|'[^']*'|(?:bearer\s+|basic\s+)?[^\s,;]+)/gi,
      "$1[REDACTED]",
    )
    .replace(/\b(bearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/\b((?:set-cookie|cookie)\s*:\s*)[^\r\n]*/gi, "$1[REDACTED]")
    .replace(
      /(\b[\w-]*(?:api[_-]?key|private[_-]?key|token|secret|password|passwd|credential)[\w-]*\s*["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      "$1[REDACTED]",
    )
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]+|ghp_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+|xox[abposr]-[A-Za-z0-9-]+|AKIA[0-9A-Z]{16})\b/g,
      "[REDACTED]",
    )
    .replace(/\p{Cc}/gu, " ")
    .slice(0, 500);
}

export async function diagnoseEditSaveFailure(params: {
  absolutePath: string;
  baselineContent: string;
  documentDirty: boolean;
  saveAttemptContent?: string;
  currentDocumentContent?: string;
  reviewState: EditSaveFailureRecovery["review_state"];
  saveException?: unknown;
  saveOutcome?: EditSaveFailureRecovery["save_outcome"];
}): Promise<{
  save_failure: EditSaveFailureRecovery;
  next_steps: string[];
}> {
  let diskState: EditSaveFailureRecovery["disk_state"];
  let diskErrorCode: string | undefined;
  let diskRecoverable = false;
  try {
    const diskContent = await fs.readFile(params.absolutePath, "utf-8");
    diskRecoverable =
      Buffer.byteLength(diskContent, "utf8") <= MAX_EDITOR_RECOVERY_BYTES;
    diskState =
      diskContent === params.baselineContent ? "unchanged" : "changed";
  } catch (error) {
    diskErrorCode =
      typeof error === "object" &&
      error !== null &&
      typeof (error as { code?: unknown }).code === "string"
        ? (error as { code: string }).code
        : undefined;
    diskState = diskErrorCode === "ENOENT" ? "missing" : "unreadable";
    diskRecoverable = diskState === "missing";
  }

  const recoveryDocument = vscode.workspace.textDocuments.find((document) =>
    documentMatchesTarget(document, params.absolutePath),
  );
  const editorRecoverable = Boolean(
    diskRecoverable &&
    recoveryDocument &&
    Buffer.byteLength(recoveryDocument.getText(), "utf8") <=
      MAX_EDITOR_RECOVERY_BYTES &&
    recoveryDocument.getText() === params.currentDocumentContent,
  );
  const concurrentChange =
    diskState === "changed"
      ? true
      : diskState === "unchanged"
        ? false
        : "unknown";
  const saveErrorMessage = boundedSaveErrorMessage(params.saveException);
  const dirtyDocumentState =
    params.saveAttemptContent === undefined ||
    params.currentDocumentContent === undefined
      ? "unavailable"
      : params.saveAttemptContent === params.currentDocumentContent
        ? "matches_save_attempt"
        : "changed_after_save_attempt";
  return {
    save_failure: {
      document_dirty: params.documentDirty,
      disk_state: diskState,
      concurrent_change: concurrentChange,
      review_state: params.reviewState,
      dirty_document_state: dirtyDocumentState,
      vscode_error_detail: saveErrorMessage ? "available" : "unavailable",
      ...(saveErrorMessage ? { vscode_error_message: saveErrorMessage } : {}),
      ...(params.saveOutcome ? { save_outcome: params.saveOutcome } : {}),
      retryable: true,
      retry_target: "editor_save",
      ...(diskErrorCode ? { disk_error_code: diskErrorCode } : {}),
    },
    next_steps: [
      !editorRecoverable
        ? `${params.reviewState === "diff_snapshot_preserved" ? "The review snapshot and retained buffer are preserved. " : "The retained buffer is preserved. "}${dirtyDocumentState === "changed_after_save_attempt" ? "The dirty editor changed during the failed save. " : ""}Automated editor recovery cannot inspect this exact state. Inspect and reconcile it in VS Code before saving or closing it. Do not repeat the edit before reconciling the buffer and disk.`
        : dirtyDocumentState === "matches_save_attempt"
          ? "The dirty editor is preserved with the exact content submitted to the failed save. Use get_editor_state to inspect it, then save_editor with the returned hashes/version for a human-reviewed exact save. This recovery skips formatting and ordinary save participants; check any required formatting separately afterwards. Do not overwrite the buffer to retry."
          : dirtyDocumentState === "changed_after_save_attempt"
            ? "The dirty editor changed during the failed save. Use get_editor_state to compare the buffer with disk. Use save_editor only if the current buffer is what should be saved; otherwise reconcile it in VS Code. The reviewed recovery skips formatting and ordinary save participants; check any required formatting separately afterwards."
            : params.reviewState === "diff_snapshot_preserved"
              ? "The review snapshot and dirty editor are preserved. Inspect the file/editor state before retrying the editor save."
              : "The dirty editor is preserved. Inspect the file/editor state before retrying the editor save.",
      concurrentChange === true
        ? "The file changed on disk after the edit baseline was captured; re-read it before composing another diff."
        : concurrentChange === false
          ? params.saveOutcome === "exception"
            ? "The file still matches the pre-edit disk baseline; the save threw an exception. Inspect any reported save error detail before retrying."
            : "The file still matches the pre-edit disk baseline; VS Code returned false without exposing an underlying save exception."
          : "Disk state could not be compared with the pre-edit baseline; use read_file before retrying.",
    ],
  };
}
