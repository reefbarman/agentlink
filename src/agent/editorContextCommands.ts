import * as vscode from "vscode";

import { AgentCodeActionProvider } from "./AgentCodeActionProvider.js";

export interface EditorContextCommandTarget {
  injectPrompt(
    prompt: string,
    attachments?: string[],
    autoSubmit?: boolean,
  ): void;
  injectAttachment(path: string): void;
  injectContext(context: string): void;
}

export function registerEditorContextCommands(
  target: EditorContextCommandTarget,
): vscode.Disposable[] {
  return [
    vscode.languages.registerCodeActionsProvider(
      { scheme: "file" },
      new AgentCodeActionProvider(),
      {
        providedCodeActionKinds:
          AgentCodeActionProvider.providedCodeActionKinds,
      },
    ),
    vscode.commands.registerCommand(
      "agentlink.fixWithAgent",
      (
        uri?: vscode.Uri,
        range?: vscode.Range,
        diagnostics?: vscode.Diagnostic[],
      ) => {
        const editor = vscode.window.activeTextEditor;
        const targetUri = uri ?? editor?.document.uri;
        if (!targetUri) return;
        const targetRange = range ?? editor?.selection;
        const targetDiagnostics =
          diagnostics ??
          vscode.languages.getDiagnostics(targetUri).filter((diagnostic) => {
            if (!targetRange) return true;
            if (!targetRange.isEmpty)
              return diagnostic.range.intersection(targetRange);
            return (
              diagnostic.range.start.line <= targetRange.start.line &&
              diagnostic.range.end.line >= targetRange.start.line
            );
          });
        if (targetDiagnostics.length === 0) {
          void vscode.window.showInformationMessage(
            "No diagnostics found at the current position.",
          );
          return;
        }
        const relPath = vscode.workspace.asRelativePath(targetUri);
        const diagText = targetDiagnostics
          .map(
            (diagnostic) =>
              `[${diagnostic.source ?? ""}] ${diagnostic.message} (line ${diagnostic.range.start.line + 1})`,
          )
          .join("\n");
        const prompt = `Fix the following issue(s) in \`${relPath}\`:\n\n${diagText}`;
        target.injectPrompt(prompt, [relPath]);
      },
    ),
    vscode.commands.registerCommand(
      "agentlink.explainWithAgent",
      (uri?: vscode.Uri, range?: vscode.Range) => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;
        const targetUri = uri ?? editor.document.uri;
        const targetRange = range ?? editor.selection;
        if (targetRange.isEmpty) return;
        const selection = editor.document.getText(targetRange);
        const relPath = vscode.workspace.asRelativePath(targetUri);
        const startLine = targetRange.start.line + 1;
        const endLine = targetRange.end.line + 1;
        const prompt = `Explain this code from \`${relPath}\` (lines ${startLine}-${endLine}):\n\n\`\`\`\n${selection}\n\`\`\``;
        target.injectPrompt(prompt, [], true);
      },
    ),
    vscode.commands.registerCommand(
      "agentlink.addFileToChat",
      (uri?: vscode.Uri) => {
        const targetUri = uri ?? vscode.window.activeTextEditor?.document.uri;
        if (!targetUri) return;
        const relPath = vscode.workspace.asRelativePath(targetUri);
        target.injectAttachment(relPath);
      },
    ),
    vscode.commands.registerCommand("agentlink.addSelectionToChat", () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) return;
      const selection = editor.document.getText(editor.selection);
      const relPath = vscode.workspace.asRelativePath(editor.document.uri);
      const startLine = editor.selection.start.line + 1;
      const endLine = editor.selection.end.line + 1;
      const context = `From \`${relPath}\` (lines ${startLine}-${endLine}):\n\`\`\`\n${selection}\n\`\`\``;
      target.injectContext(context);
    }),
  ];
}
