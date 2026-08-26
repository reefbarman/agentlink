import { createHash } from "node:crypto";
import * as path from "node:path";
import * as fs from "fs/promises";
import * as vscode from "vscode";
import { parse as parseYaml } from "yaml";

import type {
  EditReviewResult,
  EditSaveFailureRecovery,
} from "../core/capabilities/editReview.js";
import {
  classifyEditDurability,
  deriveExpectedDiskContent,
  getEditDurabilityPolicy,
  type EditDiskObservation,
} from "../core/editDurability.js";
import { canonicalizePath } from "../util/canonicalPath.js";

export interface CommitAndVerifyEditRequest {
  document: vscode.TextDocument;
  absolutePath: string;
  relativePath: string;
  baselineExists: boolean;
  baselineContent: string;
  approvedContent: string;
  reviewState: EditSaveFailureRecovery["review_state"];
  saveWithoutFormatting?: boolean;
}

export interface CommitAndVerifyEditResult extends EditReviewResult {
  status: "accepted" | "error";
  path: string;
}

let preservingSaveTail: Promise<void> = Promise.resolve();

/**
 * Save one approved editor state and verify its durable disk representation.
 * Callers must hold the per-file edit lock for the complete operation.
 */
export async function commitAndVerifyEdit(
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
        "Close the stale review buffer, re-read the target file, and compose the edit again.",
      ],
    };
  }

  if (request.document.isDirty) {
    const saveAttemptContent = request.document.getText();
    let saved = false;
    let saveReason: "save_failed" | "preserving_save_failed" = "save_failed";

    try {
      if (policy === "preserve_exact") {
        saveReason = "preserving_save_failed";
        saved = await withPreservingSaveCoordinator(() =>
          saveWithoutFormatting(request.document, request.absolutePath),
        );
      } else {
        saved = await request.document.save();
      }
    } catch {
      saved = false;
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
      });
      const recovery = await diagnoseEditSaveFailure({
        absolutePath: request.absolutePath,
        baselineContent: request.baselineContent,
        documentDirty: request.document.isDirty,
        saveAttemptContent,
        currentDocumentContent: request.document.getText(),
        reviewState: request.reviewState,
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

  const editorContent = request.document.getText();
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
          saveWithoutFormatting(request.document, request.absolutePath),
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

async function saveWithoutFormatting(
  document: vscode.TextDocument,
  absolutePath: string,
): Promise<boolean> {
  const previousEditor = vscode.window.activeTextEditor;
  const targetPath = canonicalizePath(absolutePath);
  const targetEditor = await vscode.window.showTextDocument(document, {
    preview: false,
    preserveFocus: false,
  });

  if (
    canonicalizePath(targetEditor.document.uri.fsPath) !== targetPath ||
    canonicalizePath(
      vscode.window.activeTextEditor?.document.uri.fsPath ?? "",
    ) !== targetPath
  ) {
    return false;
  }

  try {
    await vscode.commands.executeCommand(
      "workbench.action.files.saveWithoutFormatting",
    );
    return !document.isDirty;
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
        preserveFocus: false,
        ...(previousEditor.viewColumn
          ? { viewColumn: previousEditor.viewColumn }
          : {}),
      });
    }
  }
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

function documentMatchesTarget(
  document: vscode.TextDocument,
  absolutePath: string,
): boolean {
  if (document.uri.scheme && document.uri.scheme !== "file") return false;
  return (
    canonicalizePath(document.uri.fsPath) === canonicalizePath(absolutePath)
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

export async function diagnoseEditSaveFailure(params: {
  absolutePath: string;
  baselineContent: string;
  documentDirty: boolean;
  saveAttemptContent?: string;
  currentDocumentContent?: string;
  reviewState: EditSaveFailureRecovery["review_state"];
}): Promise<{
  save_failure: EditSaveFailureRecovery;
  next_steps: string[];
}> {
  let diskState: EditSaveFailureRecovery["disk_state"];
  let diskErrorCode: string | undefined;
  try {
    const diskContent = await fs.readFile(params.absolutePath, "utf-8");
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
  }

  const concurrentChange =
    diskState === "changed"
      ? true
      : diskState === "unchanged"
        ? false
        : "unknown";
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
      vscode_error_detail: "unavailable",
      retryable: true,
      retry_target: "editor_save",
      ...(diskErrorCode ? { disk_error_code: diskErrorCode } : {}),
    },
    next_steps: [
      dirtyDocumentState === "matches_save_attempt"
        ? "The dirty editor is preserved with the exact content submitted to the failed save. Do not submit another file-edit tool call; resolve the save issue and retry the editor save."
        : dirtyDocumentState === "changed_after_save_attempt"
          ? "The dirty editor changed during the failed save. Inspect and reconcile its current content before saving or composing another edit."
          : params.reviewState === "diff_snapshot_preserved"
            ? "The review snapshot and dirty editor are preserved. Inspect the file/editor state before retrying the editor save."
            : "The dirty editor is preserved. Inspect the file/editor state before retrying the editor save.",
      concurrentChange === true
        ? "The file changed on disk after the edit baseline was captured; re-read it before composing another diff."
        : concurrentChange === false
          ? "The file still matches the pre-edit disk baseline; VS Code returned false without exposing an underlying save exception."
          : "Disk state could not be compared with the pre-edit baseline; use read_file before retrying.",
    ],
  };
}
