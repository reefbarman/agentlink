import * as vscode from "vscode";

/**
 * Shows visual alerts to draw attention when an approval QuickPick is waiting.
 * Creates a flashing status bar item and a non-modal warning notification.
 * Call dispose() when the approval is resolved.
 */
export function showApprovalAlert(
  message: string,
  command?: string,
): vscode.Disposable {
  // Flashing status bar item (high priority = leftmost)
  const statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    10000,
  );
  statusBar.text = `$(alert) ${message}`;
  statusBar.backgroundColor = new vscode.ThemeColor(
    "statusBarItem.warningBackground",
  );
  if (command) {
    statusBar.command = command;
  }
  statusBar.show();

  let flash = true;
  const interval = setInterval(() => {
    flash = !flash;
    statusBar.text = flash ? `$(alert) ${message}` : `     ${message}`;
  }, 800);

  // Dismissible notification — resolving the progress promise closes it.
  // (showWarningMessage can't be programmatically dismissed, but withProgress can.)
  let dismissNotification: (() => void) | undefined;
  vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `⚠ ${message}` },
    () =>
      new Promise<void>((resolve) => {
        dismissNotification = resolve;
      }),
  );

  // Try to bring VS Code to front (will flash taskbar if window is behind others)
  vscode.commands.executeCommand("workbench.action.focusWindow");

  return {
    dispose() {
      clearInterval(interval);
      statusBar.dispose();
      dismissNotification?.();
    },
  };
}
