import * as vscode from "vscode";

import type { PathRule } from "../approvals/ApprovalManager.js";

export type WriteApprovalScopeChoice = "this-file" | "pattern" | "all-files" | null;

/**
 * QuickPick asking the user what scope they want for write auto-approval.
 * Returns null if the user dismisses the dialog.
 */
export async function showWriteApprovalScopeChoice(relPath: string): Promise<WriteApprovalScopeChoice> {
  const items: Array<vscode.QuickPickItem & { choice: WriteApprovalScopeChoice }> = [
    {
      label: "$(file) This File Only",
      description: relPath,
      choice: "this-file",
    },
    {
      label: "$(file-submodule) File Pattern...",
      description: "Define a glob/prefix/exact pattern to match multiple files",
      choice: "pattern",
    },
    {
      label: "$(files) All Files",
      description: "Auto-approve all future writes (current behavior)",
      choice: "all-files",
    },
  ];

  const picked = await vscode.window.showQuickPick(items, {
    title: "Write auto-approval scope",
    placeHolder: "Which files should be auto-approved going forward?",
    ignoreFocusOut: true,
  });

  return picked?.choice ?? null;
}

/**
 * Pattern editor for write rules — the file path is pre-filled in the input field,
 * and the user picks a match mode. Mirrors showPatternEditor from executeCommand.ts.
 */
export function showWritePatternEditor(relPath: string): Promise<PathRule | null> {
  return new Promise((resolve) => {
    const qp = vscode.window.createQuickPick<vscode.QuickPickItem & { mode: PathRule["mode"] }>();
    qp.title = "Edit pattern, then pick match mode";
    qp.placeholder = "Edit the path above → then select how to match it";
    qp.value = relPath;
    qp.items = [
      {
        label: "$(symbol-misc) Glob Match",
        description: "Trust files matching this glob pattern",
        mode: "glob" as const,
        alwaysShow: true,
      },
      {
        label: "$(symbol-text) Prefix Match",
        description: "Trust files whose path starts with this text",
        mode: "prefix" as const,
        alwaysShow: true,
      },
      {
        label: "$(symbol-key) Exact Match",
        description: "Trust only this exact file path",
        mode: "exact" as const,
        alwaysShow: true,
      },
    ];
    qp.ignoreFocusOut = true;

    let resolved = false;

    qp.onDidAccept(() => {
      const selected = qp.selectedItems[0];
      if (selected && qp.value.trim()) {
        resolved = true;
        resolve({ pattern: qp.value.trim(), mode: selected.mode });
        qp.dispose();
      }
    });

    qp.onDidHide(() => {
      if (!resolved) resolve(null);
      qp.dispose();
    });

    qp.show();
  });
}
