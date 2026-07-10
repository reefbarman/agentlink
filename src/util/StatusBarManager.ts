import * as vscode from "vscode";

/**
 * Status bar manager for AgentLink approval alerts and indexer errors.
 *
 * The primary item stays hidden while idle and appears only for a temporary
 * approval alert or an active error. The secondary item shows queued approvals.
 */
export class StatusBarManager implements vscode.Disposable {
  private readonly primaryItem: vscode.StatusBarItem;
  private readonly pendingItem: vscode.StatusBarItem;

  private flashInterval: ReturnType<typeof setInterval> | undefined;
  private errorMessage: string | undefined;

  constructor() {
    this.primaryItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      10000,
    );

    this.pendingItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      9999,
    );
    this.pendingItem.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.warningBackground",
    );
    this.pendingItem.command = "agentLink.focusApproval";
  }

  /** Set an error message. Shown as "Error" with error background. */
  setError(message: string): void {
    this.stopFlash();
    this.errorMessage = message;
    this.primaryItem.text = "$(link) AgentLink — Error";
    this.primaryItem.tooltip = message;
    this.primaryItem.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.errorBackground",
    );
    this.primaryItem.command = "agentLink.statusView.focus";
    this.primaryItem.show();
  }

  /** Clear the error state and return the primary item to its idle state. */
  clearError(): void {
    this.errorMessage = undefined;
    this.restoreBaseState();
  }

  /**
   * Show a flashing approval alert on the primary item.
   * Returns a Disposable that restores the previous base state.
   */
  showAlert(message: string, command?: string): vscode.Disposable {
    this.stopFlash();

    this.primaryItem.text = `$(alert) ${message}`;
    this.primaryItem.tooltip = message;
    this.primaryItem.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.warningBackground",
    );
    this.primaryItem.command = command ?? "agentLink.focusApproval";
    this.primaryItem.show();

    let flash = true;
    this.flashInterval = setInterval(() => {
      flash = !flash;
      this.primaryItem.text = flash ? `$(alert) ${message}` : `     ${message}`;
    }, 800);

    return {
      dispose: () => {
        this.stopFlash();
        this.restoreBaseState();
      },
    };
  }

  /** Update the pending approvals count badge. Hidden when count is 0. */
  setPendingCount(count: number): void {
    if (count > 0) {
      this.pendingItem.text = `$(ellipsis) ${count} more approval${count > 1 ? "s" : ""} pending`;
      this.pendingItem.show();
    } else {
      this.pendingItem.hide();
    }
  }

  private restoreBaseState(): void {
    if (this.errorMessage) {
      this.setError(this.errorMessage);
      return;
    }
    this.primaryItem.text = "";
    this.primaryItem.tooltip = undefined;
    this.primaryItem.backgroundColor = undefined;
    this.primaryItem.command = undefined;
    this.primaryItem.hide();
  }

  private stopFlash(): void {
    if (this.flashInterval) {
      clearInterval(this.flashInterval);
      this.flashInterval = undefined;
    }
  }

  dispose(): void {
    this.stopFlash();
    this.primaryItem.dispose();
    this.pendingItem.dispose();
  }
}
