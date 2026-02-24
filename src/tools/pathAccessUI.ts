import * as vscode from "vscode";
import * as path from "path";

import type { ApprovalManager, PathRule } from "../approvals/ApprovalManager.js";
import { promptRejectionReason } from "../util/rejectionReason.js";
import { showApprovalAlert } from "../util/approvalAlert.js";
import { enqueueApproval } from "../util/quickPickQueue.js";

type PathDecision = "allow-once" | "allow-session" | "allow-project" | "allow-always" | "reject";

/**
 * Gate for outside-workspace path access.
 * Uses a QuickPick instead of a modal dialog so that random keystrokes
 * (from typing in other windows/apps) go into the filter box harmlessly
 * rather than accidentally selecting a button.
 * On "For Session"/"Always", shows a pattern editor so the user can
 * widen the rule (e.g. to a directory prefix or glob).
 * On "Reject" or Escape, prompts for an optional reason.
 */
export async function approveOutsideWorkspaceAccess(
  filePath: string,
  approvalManager: ApprovalManager,
  sessionId: string,
): Promise<{ approved: boolean; reason?: string }> {
  // Wrap entire approval flow in the queue so concurrent path approvals
  // don't collide (QP + follow-up pattern editor + rejection reason).
  return enqueueApproval("Path access approval", async () => {
    const decision = await showPathApproval(filePath);

    if (decision === "reject") {
      const reason = await promptRejectionReason();
      return { approved: false, reason };
    }

    if (decision === "allow-session" || decision === "allow-project" || decision === "allow-always") {
      const scope =
        decision === "allow-session" ? "session" : decision === "allow-project" ? "project" : "global";
      const dirPath = path.dirname(filePath) + "/";
      const rule = await showPathPatternEditor(dirPath);
      if (rule) {
        approvalManager.addPathRule(sessionId, rule, scope);
      }
    }

    return { approved: true };
  });
}

function showPathApproval(filePath: string): Promise<PathDecision> {
  type Item = vscode.QuickPickItem & { decision: PathDecision };
  const items: Item[] = [
    { label: "$(unlock) Allow Once", description: "Allow this access, ask again next time", decision: "allow-once", alwaysShow: true },
    { label: "$(check) For Session", description: "Trust matching paths this session", decision: "allow-session", alwaysShow: true },
    { label: "$(folder) For Project", description: "Trust matching paths for this project", decision: "allow-project", alwaysShow: true },
    { label: "$(globe) Always", description: "Trust matching paths globally", decision: "allow-always", alwaysShow: true },
    { label: "$(close) Reject", description: "Deny access to this path", decision: "reject", alwaysShow: true },
  ];

  return new Promise<PathDecision>((resolve) => {
    const alert = showApprovalAlert("Path access approval required");
    const qp = vscode.window.createQuickPick<Item>();
    qp.title = "Outside workspace access";
    qp.placeholder = filePath;
    qp.items = items;
    qp.activeItems = [];
    qp.ignoreFocusOut = true;

    let resolved = false;
    qp.onDidAccept(() => {
      const selected = qp.selectedItems[0];
      if (selected) {
        resolved = true;
        alert.dispose();
        resolve(selected.decision);
        qp.dispose();
      }
    });
    qp.onDidHide(() => {
      alert.dispose();
      if (!resolved) resolve("reject");
      qp.dispose();
    });
    qp.show();
    qp.activeItems = [];
  });
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
