import * as vscode from "vscode";

export const DIFF_VIEW_URI_SCHEME = "agentlink-diff";

export function decodeDiffViewContent(uri: Pick<vscode.Uri, "query">): string {
  return Buffer.from(uri.query, "base64").toString("utf-8");
}

export function registerDiffViewContentProvider(): vscode.Disposable {
  return vscode.workspace.registerTextDocumentContentProvider(
    DIFF_VIEW_URI_SCHEME,
    {
      provideTextDocumentContent: decodeDiffViewContent,
    },
  );
}
