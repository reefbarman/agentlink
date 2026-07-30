import * as vscode from "vscode";

/**
 * Unified status bar manager for AgentLink approval attention and indexer errors.
 */
export class StatusBarManager implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;

  private alertGeneration = 0;
  private readonly alerts = new Map<
    number,
    { message: string; command: string | vscode.Command }
  >();
  private pendingCount = 0;
  private errorMessage: string | undefined;

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      "approvalAlert",
      vscode.StatusBarAlignment.Left,
      10000,
    );
    this.item.name = "AgentLink Status";
  }

  /** Set an error message. Shown as "Error" with error background. */
  setError(message: string): void {
    this.errorMessage = message;
    this.renderError();
  }

  /** Clear the error state and return the primary item to its idle state. */
  clearError(): void {
    if (!this.errorMessage) return;
    this.errorMessage = undefined;
    this.restoreBaseState();
  }

  /**
   * Show a persistent approval alert on the primary item.
   * Returns a Disposable that restores the previous base state.
   */
  showAlert(
    message: string,
    command?: string | vscode.Command,
  ): vscode.Disposable {
    const generation = ++this.alertGeneration;
    this.alerts.set(generation, {
      message,
      command: command ?? "agentLink.focusApproval",
    });
    this.renderAlert();

    return {
      dispose: () => {
        if (!this.alerts.delete(generation)) return;
        this.restoreBaseState();
      },
    };
  }

  /** Update the queued approval count on the unified status item. */
  setPendingCount(count: number): void {
    this.pendingCount = Math.max(0, count);
    if (this.errorMessage) return;
    if (this.alerts.size > 0) {
      this.renderAlert();
      return;
    }
    this.restoreBaseState();
  }

  private renderAlert(): void {
    const alert = Array.from(this.alerts.values()).at(-1);
    if (!alert) return;
    const otherAlerts = this.alerts.size - 1;
    const countSuffix = otherAlerts > 0 ? ` (+${otherAlerts} pending)` : "";
    const queuedTooltip =
      otherAlerts > 0
        ? `\n${otherAlerts} more AgentLink interaction${otherAlerts > 1 ? "s" : ""} pending`
        : "";
    this.item.text = `$(link) AgentLink — ${alert.message}${countSuffix}`;
    this.item.tooltip = `${alert.message}${queuedTooltip}`;
    this.item.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.warningBackground",
    );
    this.item.command = alert.command;
    this.item.show();
  }

  private renderPending(): void {
    this.item.text = `$(link) AgentLink — ${this.pendingCount} approval${this.pendingCount > 1 ? "s" : ""} pending`;
    this.item.tooltip = `${this.pendingCount} AgentLink approval${this.pendingCount > 1 ? "s" : ""} pending`;
    this.item.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.warningBackground",
    );
    this.item.command = "agentLink.focusApproval";
    this.item.show();
  }

  private renderError(): void {
    if (!this.errorMessage) return;
    this.item.text = "$(link) AgentLink — Error";
    this.item.tooltip = this.errorMessage;
    this.item.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.errorBackground",
    );
    this.item.command = "agentLink.statusView.focus";
    this.item.show();
  }

  private restoreBaseState(): void {
    if (this.errorMessage) {
      this.renderError();
      return;
    }
    if (this.alerts.size > 0) {
      this.renderAlert();
      return;
    }
    if (this.pendingCount > 0) {
      this.renderPending();
      return;
    }
    this.item.text = "";
    this.item.tooltip = undefined;
    this.item.backgroundColor = undefined;
    this.item.command = undefined;
    this.item.hide();
  }

  dispose(): void {
    this.alerts.clear();
    this.item.dispose();
  }
}
