import * as vscode from "vscode";

/**
 * Prompt the user for an optional rejection reason.
 * Returns the trimmed reason string, or undefined if skipped/empty.
 */
export async function promptRejectionReason(): Promise<string | undefined> {
  const reason = await vscode.window.showInputBox({
    title: "Rejection Reason (optional)",
    prompt: "Tell Claude why you rejected this (press Escape or leave empty to skip)",
    placeHolder: "e.g., Don't modify that function, use a different approach...",
    ignoreFocusOut: false,
  });
  return reason?.trim() || undefined;
}
