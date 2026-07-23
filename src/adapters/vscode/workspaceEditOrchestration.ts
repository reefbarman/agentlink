import * as vscode from "vscode";

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
