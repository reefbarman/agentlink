import * as vscode from "vscode";

/**
 * Unified status bar manager for AgentLink approval attention and indexer errors.
 */
export class StatusBarManager implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;

  private flashInterval: ReturnType<typeof setInterval> | undefined;
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
    this.stopFlash();
    this.errorMessage = message;
    this.renderError();
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
    const generation = ++this.alertGeneration;
    this.alert = {
      generation,
      message,
      command: command ?? "agentLink.focusApproval",
    };
    this.renderAlert(true);
    this.startFlash();

    return {
      dispose: () => {
        if (generation !== this.alert?.generation) return;
        this.stopFlash();
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
      this.renderAlert(true);
      return;
    }
    this.restoreBaseState();
  }

  private startFlash(): void {
    let visible = true;
    this.flashInterval = setInterval(() => {
      if (!this.alert || this.errorMessage) return;
      visible = !visible;
      this.renderAlert(visible);
    }, 800);
  }

  private renderAlert(showIcon: boolean): void {
    if (!this.alert) return;
    const countSuffix =
      this.pendingCount > 0 ? ` (+${this.pendingCount} pending)` : "";
    const queuedTooltip =
      this.pendingCount > 0
        ? `\n${this.pendingCount} more approval${this.pendingCount > 1 ? "s" : ""} pending`
        : "";
    this.item.text = `${showIcon ? "$(alert)" : "    "} ${this.alert.message}${countSuffix}`;
    this.item.tooltip = `${this.alert.message}${queuedTooltip}`;
    this.item.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.warningBackground",
    );
    this.item.command = this.alert.command;
    this.item.show();
  }

  private renderPending(): void {
    this.item.text = `$(alert) AgentLink — ${this.pendingCount} approval${this.pendingCount > 1 ? "s" : ""} pending`;
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
      this.renderAlert(true);
      this.startFlash();
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

  private stopFlash(): void {
    if (this.flashInterval) {
      clearInterval(this.flashInterval);
      this.flashInterval = undefined;
    }
  }

  dispose(): void {
    this.alertGeneration++;
    this.stopFlash();
    this.item.dispose();
  }
}
