import * as vscode from "vscode";

export function primaryEditorColumn(): vscode.ViewColumn {
  return vscode.ViewColumn.One;
}

export function withPrimaryEditorColumn(): vscode.TextDocumentShowOptions;
export function withPrimaryEditorColumn<T extends object>(
  options: T,
): T & vscode.TextDocumentShowOptions;
export function withPrimaryEditorColumn<T extends object>(
  options?: T,
): T & vscode.TextDocumentShowOptions {
  return {
    ...(options ?? ({} as T)),
    viewColumn: primaryEditorColumn(),
  };
}
