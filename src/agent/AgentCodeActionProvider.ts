import * as vscode from "vscode";

/**
 * Provides "Fix with AgentLink" and "Explain with AgentLink" code actions
 * in the editor's lightbulb / quick fix menu.
 */
export class AgentCodeActionProvider implements vscode.CodeActionProvider {
  static readonly providedCodeActionKinds = [
    vscode.CodeActionKind.QuickFix,
    vscode.CodeActionKind.RefactorRewrite,
  ];

  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext,
  ): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];

    // "Fix with AgentLink" — shown when there are diagnostics
    if (context.diagnostics.length > 0) {
      const fix = new vscode.CodeAction(
        "Fix with AgentLink",
        vscode.CodeActionKind.QuickFix,
      );
      fix.command = {
        command: "agentlink.fixWithAgent",
        title: "Fix with AgentLink",
        arguments: [document.uri, range, context.diagnostics],
      };
      fix.isPreferred = false;
      actions.push(fix);
    }

    // "Explain with AgentLink" — shown when there's a selection
    if (!range.isEmpty) {
      const explain = new vscode.CodeAction(
        "Explain with AgentLink",
        vscode.CodeActionKind.RefactorRewrite,
      );
      explain.command = {
        command: "agentlink.explainWithAgent",
        title: "Explain with AgentLink",
        arguments: [document.uri, range],
      };
      actions.push(explain);
    }

    return actions;
  }
}
