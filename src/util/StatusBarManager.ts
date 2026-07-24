import * as vscode from "vscode";

/**
 * Unified status bar manager for AgentLink approval attention and indexer errors.
 */
export class StatusBarManager implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;

  private alertGeneration = 0;
  private alert:
    | { generation: number; message: string; command: string }
    | undefined;
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
  showAlert(message: string, command?: string): vscode.Disposable {
    const generation = ++this.alertGeneration;
    this.alert = {
      generation,
      message,
      command: command ?? "agentLink.focusApproval",
    };
    this.renderAlert();

    return {
      dispose: () => {
        if (generation !== this.alert?.generation) return;
        this.alert = undefined;
        this.restoreBaseState();
      },
    };
  }

  /** Update the queued approval count on the unified status item. */
  setPendingCount(count: number): void {
    this.pendingCount = Math.max(0, count);
    if (this.errorMessage) return;
    if (this.alert) {
      this.renderAlert();
      return;
    }
    this.restoreBaseState();
  }

  private renderAlert(): void {
    if (!this.alert) return;
    const countSuffix =
      this.pendingCount > 0 ? ` (+${this.pendingCount} pending)` : "";
    const queuedTooltip =
      this.pendingCount > 0
        ? `\n${this.pendingCount} more approval${this.pendingCount > 1 ? "s" : ""} pending`
        : "";
    this.item.text = `$(link) AgentLink — ${this.alert.message}${countSuffix}`;
    this.item.tooltip = `${this.alert.message}${queuedTooltip}`;
    this.item.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.warningBackground",
    );
    this.item.command = this.alert.command;
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
    if (this.alert) {
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
    this.alertGeneration++;
    this.item.dispose();
  }
}
