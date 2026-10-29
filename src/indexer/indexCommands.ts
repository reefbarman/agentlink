import * as vscode from "vscode";

import type { IndexMaintenanceResult } from "./IndexerManager.js";

export interface IndexCommandTarget {
  startIndexing(force?: boolean): void | Promise<void>;
  cancelIndexing(): void;
  maintainIndex(): Promise<IndexMaintenanceResult>;
}

async function maintainIndex(target: IndexCommandTarget): Promise<void> {
  const result = await target.maintainIndex();
  if (result.cancelled) return;
  const reclaimed = formatBytes(result.bytesReclaimed);
  if (result.errors.length === 0) {
    void vscode.window.showInformationMessage(
      `Codebase index maintained. Reclaimed ${reclaimed}.`,
    );
    return;
  }
  const summary =
    result.maintainedRoots > 0
      ? `Codebase index maintenance partly failed (reclaimed ${reclaimed}): `
      : "Codebase index maintenance failed: ";
  void vscode.window.showWarningMessage(summary + result.errors.join("; "));
}

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
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
    vscode.commands.registerCommand("agentlink.maintainIndex", async () => {
      const target = getIndexerManager();
      if (target) await maintainIndex(target);
    }),
  ];
}
