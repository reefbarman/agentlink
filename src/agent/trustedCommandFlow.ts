import * as vscode from "vscode";

import type { CommandRule } from "../approvals/ApprovalManager.js";
import { isBannedCommandRulePrefixSuggestion } from "../approvals/commandRulePolicy.js";

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
    title: "Built-In Agent Command Policy Pattern",
    prompt: "Enter a command pattern to allow without another approval card.",
    ignoreFocusOut: true,
    validateInput: (value) => (value.trim() ? null : "Pattern cannot be empty"),
  });
  if (!pattern) return;

  const trimmedPattern = pattern.trim();
  const modes: Array<vscode.QuickPickItem & { mode: CommandRule["mode"] }> = [
    {
      label: "Prefix Match",
      description: `Allow commands starting with "${trimmedPattern}"`,
      mode: "prefix",
    },
    {
      label: "Exact Match",
      description: `Allow only "${trimmedPattern}"`,
      mode: "exact",
    },
    {
      label: "Regex Match",
      description: `Allow commands matching /${trimmedPattern}/`,
      mode: "regex",
    },
  ];

  const picked = await vscode.window.showQuickPick(modes, {
    title: "Match Mode",
    placeHolder: "How should this pattern match commands?",
    ignoreFocusOut: true,
  });
  if (!picked) return;

  if (
    picked.mode === "prefix" &&
    isBannedCommandRulePrefixSuggestion(trimmedPattern)
  ) {
    const confirmed = await vscode.window.showWarningMessage(
      `Broad prefix: "${trimmedPattern}" allows any matching command without another approval card.`,
      { modal: true },
      "Add Broad Rule",
    );
    if (confirmed !== "Add Broad Rule") return;
  }

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
    { pattern: trimmedPattern, mode: picked.mode, decision: "allow" },
    scopePick.scope,
  );
  vscode.window.showInformationMessage(
    `Added command policy (${scopePick.scope}): allow ${picked.mode} "${trimmedPattern}"`,
  );
}
