import * as vscode from "vscode";
import * as path from "path";

import type { ApprovalManager, PathRule } from "../approvals/ApprovalManager.js";
import { promptRejectionReason } from "../util/rejectionReason.js";

/**
 * Gate for outside-workspace path access.
 * Shows a modal warning dialog that can't be accidentally dismissed.
 * On "For Session"/"Always", shows a pattern editor so the user can
 * widen the rule (e.g. to a directory prefix or glob).
 * On "Reject" or Escape, prompts for an optional reason.
 */
export async function approveOutsideWorkspaceAccess(
  filePath: string,
  approvalManager: ApprovalManager,
  sessionId: string,
): Promise<{ approved: boolean; reason?: string }> {
  const choice = await vscode.window.showWarningMessage(
    `Outside workspace access:\n${filePath}`,
    { modal: true, detail: "A tool is requesting access to a path outside your workspace. How would you like to handle this?" },
    "Allow Once",
    "Allow for Session",
    "Allow for Project",
    "Always Allow",
  );

  // Escape / X / no choice → reject
  if (!choice) {
    const reason = await promptRejectionReason();
    return { approved: false, reason };
  }

  if (choice === "Allow for Session" || choice === "Allow for Project" || choice === "Always Allow") {
    const scope =
      choice === "Allow for Session" ? "session" : choice === "Allow for Project" ? "project" : "global";
    // Show pattern editor pre-filled with the directory path + trailing slash
    const dirPath = path.dirname(filePath) + "/";
    const rule = await showPathPatternEditor(dirPath);
    if (rule) {
      approvalManager.addPathRule(sessionId, rule, scope);
    }
    // If dismissed: still allow this access, just don't save a rule
  }

  return { approved: true };
}

/**
 * Pattern editor for path rules. Pre-fills with a path (typically the
 * parent directory), lets the user edit it, then pick a match mode.
 */
function showPathPatternEditor(defaultPath: string): Promise<PathRule | null> {
  return new Promise((resolve) => {
    const qp = vscode.window.createQuickPick<vscode.QuickPickItem & { mode: PathRule["mode"] }>();
    qp.title = "Edit path pattern, then pick match mode";
    qp.placeholder = "Edit the path above → then select how to match it";
    qp.value = defaultPath;
    qp.items = [
      {
        label: "$(symbol-text) Prefix Match",
        description: "Trust paths starting with this text",
        mode: "prefix" as const,
        alwaysShow: true,
      },
      {
        label: "$(symbol-key) Exact Match",
        description: "Trust only this exact path",
        mode: "exact" as const,
        alwaysShow: true,
      },
      {
        label: "$(symbol-misc) Glob Match",
        description: "Trust paths matching this glob pattern",
        mode: "glob" as const,
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
