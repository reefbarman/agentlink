import * as fs from "fs/promises";
import * as vscode from "vscode";

import {
  commitAndVerifyEdit,
  type CommitAndVerifyEditResult,
} from "../../integrations/editDurability.js";

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
  const applied = await vscode.workspace.applyEdit(params.edit);
  if (!applied) {
    return params.applyFailure;
  }

  const affectedPaths = new Set(params.affectedPaths);
  for (const document of vscode.workspace.textDocuments) {
    if (
      affectedPaths.has(document.uri.fsPath) &&
      document.isDirty &&
      !(await document.save())
    ) {
      return params.saveFailure ?? params.applyFailure;
    }
  }

  return params.buildSuccess();
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
