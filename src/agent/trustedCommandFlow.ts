import * as vscode from "vscode";

import type { CommandRule } from "../approvals/ApprovalManager.js";

interface TrustedCommandRuleTarget {
  addCommandRule(
    sessionId: string,
    rule: CommandRule,
    scope: "project" | "global",
  ): void;
}

export async function addTrustedCommandViaUi(
  approvalManager: TrustedCommandRuleTarget,
): Promise<void> {
  const pattern = await vscode.window.showInputBox({
    title: "Built-In Agent Trusted Command Pattern",
    prompt: "Enter a command pattern to trust for built-in agent sessions",
    ignoreFocusOut: true,
    validateInput: (value) => (value.trim() ? null : "Pattern cannot be empty"),
  });
  if (!pattern) return;

  const trimmedPattern = pattern.trim();
  const modes: Array<vscode.QuickPickItem & { mode: CommandRule["mode"] }> = [
    {
      label: "Prefix Match",
      description: `Trust commands starting with "${trimmedPattern}"`,
      mode: "prefix",
    },
    {
      label: "Exact Match",
      description: `Trust only "${trimmedPattern}"`,
      mode: "exact",
    },
    {
      label: "Regex Match",
      description: `Trust commands matching /${trimmedPattern}/`,
      mode: "regex",
    },
  ];

  const picked = await vscode.window.showQuickPick(modes, {
    title: "Match Mode",
    placeHolder: "How should this pattern match commands?",
    ignoreFocusOut: true,
  });
  if (!picked) return;

  const scopeItems: Array<
    vscode.QuickPickItem & { scope: "project" | "global" }
  > = [];
  if (vscode.workspace.workspaceFolders?.length) {
    scopeItems.push({
      label: "$(folder) This Project",
      description: ".agentlink/agentlink.json",
      scope: "project",
    });
  }
  scopeItems.push({
    label: "$(globe) Global",
    description: "~/.agentlink/agentlink.json",
    scope: "global",
  });

  const scopePick = await vscode.window.showQuickPick(scopeItems, {
    title: "Rule Scope",
    placeHolder: "Where should this rule be saved?",
    ignoreFocusOut: true,
  });
  if (!scopePick) return;

  approvalManager.addCommandRule(
    "_global",
    { pattern: trimmedPattern, mode: picked.mode },
    scopePick.scope,
  );
  vscode.window.showInformationMessage(
    `Added trusted command (${scopePick.scope}): ${picked.mode} "${trimmedPattern}"`,
  );
}
