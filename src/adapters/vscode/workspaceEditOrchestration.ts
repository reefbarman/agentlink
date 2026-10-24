import * as fs from "fs/promises";
import * as vscode from "vscode";

import {
  commitAndVerifyEdit,
  type CommitAndVerifyEditResult,
} from "../../integrations/editDurability.js";
import { canonicalizePath } from "../../util/canonicalPath.js";
import { getRelativePath } from "../../util/paths.js";
import { workHistoryRegistry } from "../../agent/WorkHistoryRegistry.js";

export interface WorkspaceEditOrchestration<TFailure, TSuccess> {
  edit: vscode.WorkspaceEdit;
  affectedPaths: readonly string[];
  applyFailure: TFailure;
  saveFailure?: TFailure;
  buildSuccess(): TSuccess;
}

export async function applyWorkspaceEditAndSave<TFailure, TSuccess>(
  params: WorkspaceEditOrchestration<TFailure, TSuccess>,
): Promise<TFailure | TSuccess> {
  const baselines = workHistoryRegistry.activeContext
    ? await readCaptureBaselines(params.affectedPaths)
    : undefined;
  const applied = await vscode.workspace.applyEdit(params.edit);
  if (!applied) {
    return params.applyFailure;
  }

  const saveFailure = params.saveFailure ?? params.applyFailure;
  const verified = new Set<string>();
  for (const document of await collectAffectedDocuments(params)) {
    if (!document.isDirty) continue;
    if (!(await document.save()) || !(await diskMatchesDocument(document))) {
      // Files saved before the failure are durable; keep them in the history.
      if (baselines) await recordSavedEdits(baselines, verified);
      return saveFailure;
    }
    verified.add(canonicalizePath(document.uri.fsPath));
  }

  if (baselines) await recordSavedEdits(baselines);
  return params.buildSuccess();
}

/** Disk baselines for work-history capture, keyed by canonical path. */
async function readCaptureBaselines(
  affectedPaths: readonly string[],
): Promise<
  Map<string, { absolutePath: string; exists: boolean; content: string }>
> {
  const baselines = new Map<
    string,
    { absolutePath: string; exists: boolean; content: string }
  >();
  for (const absolutePath of affectedPaths) {
    const key = canonicalizePath(absolutePath);
    if (baselines.has(key)) continue;
    try {
      baselines.set(key, {
        absolutePath,
        ...(await readDiskBaseline(absolutePath)),
      });
    } catch {
      // Unreadable baseline: leave this file out of the captured history.
    }
  }
  return baselines;
}

async function recordSavedEdits(
  baselines: Map<
    string,
    { absolutePath: string; exists: boolean; content: string }
  >,
  only?: ReadonlySet<string>,
): Promise<void> {
  for (const [key, baseline] of baselines) {
    if (only && !only.has(key)) continue;
    let after: { exists: boolean; content: string };
    try {
      after = await readDiskBaseline(baseline.absolutePath);
    } catch {
      continue;
    }
    workHistoryRegistry.recordCommittedEdit({
      absolutePath: baseline.absolutePath,
      displayPath: getRelativePath(baseline.absolutePath),
      before: { exists: baseline.exists, content: baseline.content },
      after,
    });
  }
}

/**
 * Resolve the documents the edit changed. VS Code may hold a document whose
 * URI differs from the requested path only in letter case or symlink form, so
 * match by the edit's own URIs and by canonical path rather than raw string
 * equality. A missed document would stay dirty in memory while the caller
 * reported success.
 */
async function collectAffectedDocuments(params: {
  edit: vscode.WorkspaceEdit;
  affectedPaths: readonly string[];
}): Promise<vscode.TextDocument[]> {
  const documents = new Set<vscode.TextDocument>();
  const editEntries =
    typeof params.edit.entries === "function" ? params.edit.entries() : [];
  for (const [uri] of editEntries) {
    try {
      documents.add(await vscode.workspace.openTextDocument(uri));
    } catch {
      // Not a text document; nothing to save.
    }
  }

  const affected = new Set(params.affectedPaths);
  const canonicalAffected = new Set(params.affectedPaths.map(canonicalizePath));
  for (const document of vscode.workspace.textDocuments) {
    const fsPath = document.uri.fsPath;
    if (
      affected.has(fsPath) ||
      (document.uri.scheme === "file" &&
        canonicalAffected.has(canonicalizePath(fsPath)))
    ) {
      documents.add(document);
    }
  }
  return [...documents];
}

/**
 * Confirm a saved file document reached disk. Non-file schemes and documents
 * in a non-UTF-8 encoding cannot be compared byte-for-byte here and are
 * trusted to VS Code's save result.
 */
async function diskMatchesDocument(
  document: vscode.TextDocument,
): Promise<boolean> {
  if (document.uri.scheme !== "file") return true;
  const encoding = (document as { encoding?: string }).encoding;
  if (encoding && encoding !== "utf8" && encoding !== "utf8bom") return true;
  try {
    const disk = await fs.readFile(document.uri.fsPath, "utf-8");
    return disk.replace(/^\uFEFF/, "") === document.getText();
  } catch {
    return false;
  }
}

export interface ExactSaveTarget {
  absolutePath: string;
  relativePath: string;
}

export interface WorkspaceEditExactSaveOrchestration<TFailure, TResult> {
  edit: vscode.WorkspaceEdit;
  /** Files changed by the edit; each is saved and verified independently. */
  targets: readonly ExactSaveTarget[];
  applyFailure: TFailure;
  /** Receives one commit result per target, in target order. */
  buildResult(commits: readonly CommitAndVerifyEditResult[]): TResult;
}

/**
 * Apply a workspace edit, then save every target without format-on-save or
 * other ordinary save participants and verify exact disk preservation through
 * the shared single-file commit path. Every target is attempted even when an
 * earlier one fails, so callers can report precise per-file outcomes.
 *
 * Callers must hold the per-file edit locks for every target.
 */
export async function applyWorkspaceEditAndSaveWithoutFormatting<
  TFailure,
  TResult,
>(
  params: WorkspaceEditExactSaveOrchestration<TFailure, TResult>,
): Promise<TFailure | TResult> {
  const baselines: Array<{ exists: boolean; content: string }> = [];
  for (const target of params.targets) {
    baselines.push(await readDiskBaseline(target.absolutePath));
  }

  const applied = await vscode.workspace.applyEdit(params.edit);
  if (!applied) {
    return params.applyFailure;
  }

  const commits: CommitAndVerifyEditResult[] = [];
  for (let index = 0; index < params.targets.length; index++) {
    const target = params.targets[index]!;
    const baseline = baselines[index]!;
    try {
      const document = await vscode.workspace.openTextDocument(
        vscode.Uri.file(target.absolutePath),
      );
      commits.push(
        await commitAndVerifyEdit({
          document,
          absolutePath: target.absolutePath,
          relativePath: target.relativePath,
          baselineExists: baseline.exists,
          baselineContent: baseline.content,
          approvedContent: document.getText(),
          reviewState: "dirty_document_preserved",
          saveWithoutFormatting: true,
        }),
      );
    } catch {
      // Keep raw editor/save exception text out of the result; the per-file
      // recovery guidance asks for inspection instead.
      commits.push({
        status: "error",
        path: target.relativePath,
        error: "File could not be saved without formatting",
        reason: "preserving_save_failed",
        next_steps: [
          "Inspect the editor buffer and re-read the file before retrying.",
        ],
      });
    }
  }

  return params.buildResult(commits);
}

async function readDiskBaseline(
  absolutePath: string,
): Promise<{ exists: boolean; content: string }> {
  try {
    return { exists: true, content: await fs.readFile(absolutePath, "utf-8") };
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      (error as { code?: unknown }).code === "ENOENT"
    ) {
      return { exists: false, content: "" };
    }
    throw error;
  }
}
