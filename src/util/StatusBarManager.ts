import * as vscode from "vscode";

export interface SessionInfo {
  trusted: boolean;
}

/**
 * Unified status bar manager for AgentLink.
 *
 * Owns a single primary status bar item that transitions between states:
 *   stopped   → server not running:      "$(link) AgentLink"  (warning bg)
 *   waiting   → server up, no sessions:  "$(link) AgentLink — Waiting"
 *   connected → session(s) connected:    "$(link) AgentLink — Connected"
 *   trusted   → session(s) trusted:      "$(link) AgentLink — Trusted"
 *   alert     → approval needed:         "$(alert) message"   (flashing)
 *
 * Also owns a secondary "pending count" item shown when queued approvals > 0.
 */
export class StatusBarManager implements vscode.Disposable {
  private readonly primaryItem: vscode.StatusBarItem;
  private readonly pendingItem: vscode.StatusBarItem;

  private port: number | null = null;
  private sessions: SessionInfo[] = [];
  private flashInterval: ReturnType<typeof setInterval> | undefined;
  private errorMessage: string | undefined;

  constructor() {
    this.primaryItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      10000,
    );
    this.primaryItem.show();

    this.pendingItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      9999,
    );
    this.pendingItem.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.warningBackground",
    );
    this.pendingItem.command = "agentLink.focusApproval";

    // Start in stopped state
    this.setStopped();
  }

  /** Server stopped. */
  setStopped(): void {
    this.stopFlash();
    this.port = null;
    this.sessions = [];
    this.primaryItem.text = "$(link) AgentLink";
    this.primaryItem.tooltip = "AgentLink MCP server stopped";
    this.primaryItem.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.warningBackground",
    );
    this.primaryItem.command = "agentlink.showStatus";
  }

  /** Server running — derive status label from session state. */
  setRunning(port: number, sessions: SessionInfo[] = []): void {
    this.stopFlash();
    this.port = port;
    this.sessions = sessions;

    const total = sessions.length;
    const trusted = sessions.filter((s) => s.trusted).length;

    let label: string;
    let tooltip: string;

    // Error takes priority over session state
    if (this.errorMessage) {
      label = "$(link) AgentLink — Error";
      tooltip = this.errorMessage;
    } else if (total === 0) {
      label = "$(link) AgentLink — Waiting";
      tooltip = "Waiting for an agent to connect";
    } else if (trusted > 0) {
      label = "$(link) AgentLink — Trusted";
      tooltip =
        trusted === total
          ? `${trusted} trusted session${trusted > 1 ? "s" : ""}`
          : `${trusted} trusted, ${total - trusted} pending`;
    } else {
      label = "$(link) AgentLink — Connected";
      tooltip = `${total} session${total > 1 ? "s" : ""} connected (awaiting handshake)`;
    }

    this.primaryItem.text = label;
    this.primaryItem.tooltip = tooltip;
    this.primaryItem.backgroundColor = this.errorMessage
      ? new vscode.ThemeColor("statusBarItem.errorBackground")
      : undefined;
    this.primaryItem.command = "agentlink.showStatus";
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
    this.primaryItem.command = "agentlink.showStatus";
  }

  /** Clear the error state and restore to running/stopped. */
  clearError(): void {
    this.errorMessage = undefined;
    if (this.port !== null) {
      this.setRunning(this.port, this.sessions);
    } else {
      this.setStopped();
    }
  }

  /**
   * Show a flashing approval alert on the primary item.
   * Returns a Disposable that restores the previous base state.
   */
  showAlert(
    message: string,
    command?: string,
  ): vscode.Disposable {
    this.stopFlash();

    this.primaryItem.text = `$(alert) ${message}`;
    this.primaryItem.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.warningBackground",
    );
    this.primaryItem.command = command ?? "agentLink.focusApproval";

    let flash = true;
    this.flashInterval = setInterval(() => {
      flash = !flash;
      this.primaryItem.text = flash
        ? `$(alert) ${message}`
        : `     ${message}`;
    }, 800);

    return {
      dispose: () => {
        this.stopFlash();
        if (this.port !== null) {
          this.setRunning(this.port, this.sessions);
        } else {
          this.setStopped();
        }
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
