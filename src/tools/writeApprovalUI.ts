import * as vscode from "vscode";
import * as path from "path";

import type { ApprovalManager, PathRule } from "../approvals/ApprovalManager.js";
import type { WriteApprovalResponse } from "../approvals/ApprovalPanelProvider.js";
import type { DiffDecision } from "../integrations/DiffViewProvider.js";
import { enqueueApproval } from "../util/quickPickQueue.js";

export type WriteApprovalScopeChoice = "this-file" | "pattern" | "all-files" | null;
export type RuleScope = "session" | "project" | "global";

/**
 * Map a DiffDecision to a rule scope. Returns null for non-scoped decisions (accept/reject).
 */
export function decisionToScope(decision: DiffDecision): RuleScope | null {
  switch (decision) {
    case "accept-session": return "session";
    case "accept-project": return "project";
    case "accept-always": return "global";
    default: return null;
  }
}

/**
 * Save write trust rules from an approval response.
 * When panelResponse has inline trustScope, applies it directly.
 * Otherwise falls back to QuickPick dialogs (for diff view decisions).
 */
export async function saveWriteTrustRules(opts: {
  panelResponse: WriteApprovalResponse | undefined;
  approvalManager: ApprovalManager;
  sessionId: string;
  scope: RuleScope;
  relPath: string;
  filePath: string;
  inWorkspace: boolean;
}): Promise<void> {
  const { panelResponse, approvalManager, sessionId, scope, relPath, filePath, inWorkspace } = opts;

  if (panelResponse?.trustScope) {
    applyInlineTrustScope(panelResponse, approvalManager, sessionId, scope, relPath, inWorkspace);
  } else {
    // QuickPick fallback — use follow-up dialogs
    await enqueueApproval("Write scope selection", async () => {
      if (!inWorkspace) {
        const dirPath = path.dirname(filePath) + "/";
        const rule = await showWritePatternEditor(dirPath);
        if (rule) {
          approvalManager.addWriteRule(sessionId, rule, scope);
          approvalManager.addPathRule(sessionId, rule, scope);
        }
      } else {
        const choice = await showWriteApprovalScopeChoice(relPath);
        if (choice === "all-files") {
          approvalManager.setWriteApproval(sessionId, scope);
        } else if (choice === "this-file") {
          approvalManager.addWriteRule(sessionId, { pattern: relPath, mode: "exact" }, scope);
        } else if (choice === "pattern") {
          const rule = await showWritePatternEditor(relPath);
          if (rule) {
            approvalManager.addWriteRule(sessionId, rule, scope);
          }
        }
      }
    });
  }
}

/**
 * Apply inline trust scope from a panel response (no follow-up dialogs).
 * Used by both diff view writes and rename symbol.
 */
export function applyInlineTrustScope(
  panelResponse: WriteApprovalResponse,
  approvalManager: ApprovalManager,
  sessionId: string,
  scope: RuleScope,
  relPath: string,
  inWorkspace = true,
): void {
  if (panelResponse.trustScope === "all-files") {
    approvalManager.setWriteApproval(sessionId, scope);
  } else if (panelResponse.trustScope === "this-file") {
    approvalManager.addWriteRule(sessionId, { pattern: relPath, mode: "exact" }, scope);
  } else if (
    panelResponse.trustScope === "pattern" &&
    panelResponse.rulePattern &&
    panelResponse.ruleMode
  ) {
    const rule = { pattern: panelResponse.rulePattern, mode: panelResponse.ruleMode };
    approvalManager.addWriteRule(sessionId, rule, scope);
    if (!inWorkspace) {
      approvalManager.addPathRule(sessionId, rule, scope);
    }
  }
}

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
