import * as vscode from "vscode";

export interface IndexCommandTarget {
  startIndexing(force?: boolean): void | Promise<void>;
  cancelIndexing(): void;
}

export function registerIndexCommands(
  getIndexerManager: () => IndexCommandTarget | null,
): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand("agentlink.rebuildIndex", () =>
      getIndexerManager()?.startIndexing(true),
    ),
    vscode.commands.registerCommand("agentlink.cancelIndex", () =>
      getIndexerManager()?.cancelIndexing(),
    ),
    vscode.commands.registerCommand("agentlink.resumeIndex", () =>
      getIndexerManager()?.startIndexing(false),
    ),
  ];
}
