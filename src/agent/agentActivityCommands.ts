import * as vscode from "vscode";

interface ApprovalFocusTarget {
  focusApproval(): void;
}

interface PendingInteractionFocusTarget {
  focusPendingInteraction(sessionId: string): Promise<boolean>;
}

interface ToolCallControlTarget {
  cancelCall(id: string): void;
  continueInBackground(id: string): void;
  completeCall(id: string): void;
}

interface ActiveApprovalSession {
  id: string;
}

interface SessionApprovalTarget {
  getActiveSessions(): ActiveApprovalSession[];
  clearSession(id: string): void;
  resetWriteApproval(): void;
  resetAgentWriteApproval(): void;
}

export interface AgentActivityCommandDependencies {
  addTrustedCommand(): void | Promise<void>;
  approvalPanel: ApprovalFocusTarget;
  pendingInteractionTarget: PendingInteractionFocusTarget;
  toolCallTracker: ToolCallControlTarget;
  approvalManager: SessionApprovalTarget;
}

export function registerAgentActivityCommands({
  addTrustedCommand,
  approvalPanel,
  pendingInteractionTarget,
  toolCallTracker,
  approvalManager,
}: AgentActivityCommandDependencies): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand(
      "agentlink.addTrustedCommand",
      addTrustedCommand,
    ),
    vscode.commands.registerCommand(
      "agentLink.focusApproval",
      async (target?: { sessionId?: string }) => {
        if (target?.sessionId) {
          try {
            if (
              await pendingInteractionTarget.focusPendingInteraction(
                target.sessionId,
              )
            ) {
              return;
            }
          } catch {
            // Fall back to the external approval panel below.
          }
        }
        approvalPanel.focusApproval();
      },
    ),
    vscode.commands.registerCommand("agentlink.cancelToolCall", (id: string) =>
      toolCallTracker.cancelCall(id),
    ),
    vscode.commands.registerCommand(
      "agentlink.continueToolCallInBackground",
      (id: string) => toolCallTracker.continueInBackground(id),
    ),
    vscode.commands.registerCommand(
      "agentlink.completeToolCall",
      (id: string) => toolCallTracker.completeCall(id),
    ),
    vscode.commands.registerCommand("agentlink.clearSessionApprovals", () => {
      for (const session of approvalManager.getActiveSessions()) {
        approvalManager.clearSession(session.id);
      }
      approvalManager.resetWriteApproval();
      approvalManager.resetAgentWriteApproval();
      vscode.window.showInformationMessage(
        "All built-in agent session approvals cleared.",
      );
    }),
  ];
}
