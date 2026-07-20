import * as vscode from "vscode";

export const OPEN_AGENTLINK_TERMINAL_COMMAND = "agentlink.openTerminal";
export const DEFAULT_AGENT_VIEW_OPENED_KEY =
  "agentLink.defaultAgentViewOpened.v1";

export interface AgentWorkbenchLayoutOptions {
  terminalViewId: string;
  agentViewId: string;
  workspaceState: Pick<vscode.Memento, "get" | "update">;
  waitForTerminalReady(): PromiseLike<void>;
  isTerminalAvailable(): boolean;
  log?(message: string): void;
}

export function registerAgentWorkbenchLayout(
  options: AgentWorkbenchLayoutOptions,
): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand(
      OPEN_AGENTLINK_TERMINAL_COMMAND,
      async () => {
        try {
          await options.waitForTerminalReady();
        } catch (error) {
          options.log?.(
            `Unable to prepare AgentLink Terminal: ${String(error)}`,
          );
        }
        if (options.isTerminalAvailable()) {
          await vscode.commands.executeCommand(
            `${options.terminalViewId}.focus`,
          );
          return;
        }

        const action = await vscode.window.showInformationMessage(
          "AgentLink Terminal is disabled or unavailable on this host.",
          "Open Settings",
        );
        if (action === "Open Settings") {
          await vscode.commands.executeCommand(
            "workbench.action.openSettings",
            "agentlink.terminal.enabled",
          );
        }
      },
    ),
  ];
}

export async function openDefaultAgentViewOnce(
  options: AgentWorkbenchLayoutOptions,
): Promise<void> {
  if (options.workspaceState.get<boolean>(DEFAULT_AGENT_VIEW_OPENED_KEY))
    return;

  try {
    await vscode.commands.executeCommand(`${options.agentViewId}.focus`);
    await options.workspaceState.update(DEFAULT_AGENT_VIEW_OPENED_KEY, true);
  } catch (error) {
    options.log?.(`Unable to open the default Agent view: ${String(error)}`);
  }
}
