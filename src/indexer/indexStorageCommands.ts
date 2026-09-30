import * as path from "node:path";
import * as vscode from "vscode";

import {
  listIndexStorage,
  maintainIndexStorage,
  removeIndexStorage,
} from "./indexStorage.js";

import { getWorkspaceRoots } from "../util/paths.js";

export function registerIndexStorageCommand(
  globalStoragePath: string,
): vscode.Disposable {
  return vscode.commands.registerCommand(
    "agentlink.manageIndexStorage",
    async () => {
      try {
        const roots = getWorkspaceRoots();
        const entries = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Measuring AgentLink index storage",
          },
          () => listIndexStorage(globalStoragePath, roots),
        );
        if (entries.length === 0) {
          await vscode.window.showInformationMessage(
            "No AgentLink workspace index stores found.",
          );
          return;
        }
        const selected = await vscode.window.showQuickPick(
          entries.map((entry) => ({
            label: entry.workspaceRoot
              ? path.basename(entry.workspaceRoot)
              : "Unknown workspace",
            description: formatBytes(entry.bytes),
            detail: `${entry.workspaceRoot ?? entry.id}${entry.blockedReason ? ` (${storageReason(entry.blockedReason)})` : ""}`,
            entry,
          })),
          {
            title: "AgentLink Index Storage",
            placeHolder: "Select a workspace cache to maintain or remove",
            matchOnDetail: true,
          },
        );
        if (!selected) return;
        if (selected.entry.blockedReason) {
          await vscode.window.showWarningMessage(
            storageReason(selected.entry.blockedReason),
          );
          return;
        }
        const action = await vscode.window.showQuickPick(
          [
            {
              label: "Compact and prune",
              detail:
                "Run database-aware maintenance, retaining one hour of table history.",
            },
            {
              label: "Remove workspace index",
              detail:
                "Delete this cache and its index metadata. Source files are untouched.",
            },
          ],
          { title: selected.label },
        );
        if (!action) return;
        const remove = action.label === "Remove workspace index";
        const confirmLabel = remove
          ? "Other windows closed, remove index"
          : "Other windows closed, compact";
        const confirmed = await vscode.window.showWarningMessage(
          `${remove ? "Remove" : "Maintain"} ${selected.entry.workspaceRoot ?? selected.entry.id}? Close all other VS Code and AgentLink windows first. ${remove ? "Search for this workspace will be unavailable until it is indexed again. Enabled embeddings may incur regeneration cost." : "This does not delete source files or indexed content. Old orphan files may require a cache reset rather than compaction."}`,
          { modal: true },
          confirmLabel,
        );
        if (confirmed !== confirmLabel) return;
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: remove
              ? "Removing AgentLink index"
              : "Maintaining AgentLink index",
          },
          async () => {
            const protectedRoots = getWorkspaceRoots();
            if (remove) {
              await removeIndexStorage(
                globalStoragePath,
                selected.entry.id,
                protectedRoots,
              );
            } else {
              await maintainIndexStorage(
                globalStoragePath,
                selected.entry.id,
                protectedRoots,
              );
            }
          },
        );
        await vscode.window.showInformationMessage(
          remove
            ? "Workspace index cache removed. Source files were not changed."
            : "Index maintenance complete.",
        );
      } catch (error) {
        await vscode.window.showErrorMessage(
          `AgentLink index storage: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  );
}

function storageReason(reason: string): string {
  switch (reason) {
    case "index_storage_protected":
      return "Open this command from another workspace to manage this cache.";
    case "index_storage_writer_active":
      return "An indexer is still using this cache. Close its owning window first.";
    case "index_storage_invalid_lease":
    case "index_storage_unknown_identity":
      return "Cache metadata is invalid or mismatched. Automatic maintenance is blocked.";
    default:
      return reason;
  }
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(1)} GiB`
    : `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
}
