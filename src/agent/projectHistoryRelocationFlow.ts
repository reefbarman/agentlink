import * as path from "path";

import * as vscode from "vscode";

import {
  createSessionProjectScope,
  type WorkspaceProject,
} from "@agentlink/protocol/workspace-project";

import { normalizeWorkspaceProjectUri } from "../adapters/vscode/workspaceProjectCapabilities.js";
import {
  findProjectHistoryRelocationCandidates,
  planProjectHistoryRelocation,
  relocateProjectHistory,
  type ProjectHistoryRelocationCandidate,
  type ProjectHistoryRelocationRequest,
} from "./projectHistoryRelocation.js";
import { recordProjectLocation } from "./projectLocationMarker.js";

export const MIGRATE_SESSION_HISTORY_COMMAND =
  "agentlink.migrateSessionHistory";

export interface ProjectHistoryRelocationFlowOptions {
  context: vscode.ExtensionContext;
  /** History directory selected for this window at activation. */
  currentHistoryDirectory: string | undefined;
  listProjects: () => readonly WorkspaceProject[];
  flushForWorkspaceTransition: () => Promise<
    { ok: true } | { ok: false; activeSessionIds: string[] }
  >;
  /** Blocks session saves until reload so stale scopes are not re-written. */
  setPersistenceSuspended: (suspended: boolean) => void;
  log: (message: string) => void;
}

/**
 * Records each folder's location in `.agentlink/location.json`, registers the
 * "Migrate Session History from a Previous Folder" command, and offers that
 * migration once when history in this folder still belongs to a previous
 * location that no longer exists (a rename or move).
 */
export function registerProjectHistoryRelocation(
  options: ProjectHistoryRelocationFlowOptions,
): void {
  const { context, log } = options;
  const fileFolders = () =>
    (vscode.workspace.workspaceFolders ?? []).filter(
      (folder) => folder.uri.scheme === "file",
    );
  const projectFor = (folder: vscode.WorkspaceFolder) => {
    const uri = normalizeWorkspaceProjectUri(folder.uri);
    return options
      .listProjects()
      .find(
        (project) =>
          project.uri === uri && project.availability.status === "available",
      );
  };

  for (const folder of fileFolders()) {
    const project = projectFor(folder);
    if (!project) continue;
    try {
      const result = recordProjectLocation(folder.uri.fsPath, {
        workspaceFolderUri: project.uri,
        rootPath: folder.uri.fsPath,
        displayName: folder.name,
      });
      if (result?.movedFrom) {
        log(
          `[history] ${folder.uri.fsPath} was previously at ${result.movedFrom.rootPath}`,
        );
      }
    } catch (error) {
      log(`[history] Could not record project location: ${String(error)}`);
    }
  }

  const buildRequest = (
    previousRootPath: string,
    folder: vscode.WorkspaceFolder,
    previousProjectUri?: string,
  ): ProjectHistoryRelocationRequest | undefined => {
    const project = projectFor(folder);
    if (!project) return undefined;
    const previousUri = vscode.Uri.file(previousRootPath);
    return {
      workspaceFolders: vscode.workspace.workspaceFolders ?? [],
      workspaceFile: vscode.workspace.workspaceFile,
      previous: {
        rootPath: previousRootPath,
        uri: previousUri,
        projectUri:
          previousProjectUri ?? normalizeWorkspaceProjectUri(previousUri),
      },
      current: {
        rootPath: folder.uri.fsPath,
        uri: folder.uri,
        scope: createSessionProjectScope(project),
      },
    };
  };

  const folderForCandidate = (candidate: ProjectHistoryRelocationCandidate) =>
    candidate.currentRootPath
      ? fileFolders().find(
          (folder) =>
            path.resolve(folder.uri.fsPath) ===
            path.resolve(candidate.currentRootPath!),
        )
      : undefined;

  const discover = () =>
    findProjectHistoryRelocationCandidates({
      folders: fileFolders().flatMap((folder) => {
        const project = projectFor(folder);
        return project
          ? [
              {
                rootPath: folder.uri.fsPath,
                uri: folder.uri,
                projectUri: project.uri,
              },
            ]
          : [];
      }),
      currentHistoryDirectory: options.currentHistoryDirectory,
    });

  const runMigration = async (
    request: ProjectHistoryRelocationRequest,
    confirmed: boolean,
  ): Promise<void> => {
    const planned = planProjectHistoryRelocation(request);
    if (!planned.ok) {
      void vscode.window.showWarningMessage(
        `AgentLink cannot migrate this session history: ${planned.message}`,
      );
      return;
    }
    if (!confirmed) {
      const choice = await vscode.window.showWarningMessage(
        `Migrate ${planned.plan.totalSessions} AgentLink sessions from "${request.previous.rootPath}" to "${request.current.rootPath}"?`,
        {
          modal: true,
          detail:
            "AgentLink backs up the history to .agentlink/backups first, updates the sessions so they can be resumed in this folder, then reloads the window.",
        },
        "Migrate history",
      );
      if (choice !== "Migrate history") return;
    }

    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "AgentLink: Migrating session history",
          cancellable: false,
        },
        async (progress) => {
          progress.report({ message: "Waiting for session history to flush…" });
          const drained = await options.flushForWorkspaceTransition();
          if (!drained.ok) {
            void vscode.window.showWarningMessage(
              "AgentLink cannot migrate session history while sessions are active. Finish or stop those sessions, then run AgentLink: Migrate Session History from a Previous Folder again.",
            );
            return;
          }
          // Re-plan after the flush so the plan reflects the final history.
          const fresh = planProjectHistoryRelocation(request);
          if (!fresh.ok) throw new Error(fresh.message);
          options.setPersistenceSuspended(true);
          let result: Awaited<ReturnType<typeof relocateProjectHistory>>;
          try {
            result = await relocateProjectHistory(fresh.plan, {
              onProgress: (message) => progress.report({ message }),
            });
          } catch (error) {
            options.setPersistenceSuspended(false);
            throw error;
          }
          log(
            `[history] Migrated ${result.sessionsRewritten}/${result.totalSessions} sessions from ${request.previous.rootPath} to ${request.current.rootPath}; history=${result.historyDirectory} backup=${result.backupDirectory}`,
          );
          progress.report({ message: "Reloading with migrated history…" });
          await vscode.commands.executeCommand("workbench.action.reloadWindow");
        },
      );
    } catch (error) {
      log(`[history] Session history migration failed: ${String(error)}`);
      void vscode.window.showErrorMessage(
        `AgentLink could not migrate session history. ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  const pickDestinationFolder = async (): Promise<
    vscode.WorkspaceFolder | undefined
  > => {
    const folders = fileFolders();
    if (folders.length <= 1) return folders[0];
    const picked = await vscode.window.showQuickPick(
      folders.map((folder) => ({
        label: folder.name,
        description: folder.uri.fsPath,
        folder,
      })),
      { placeHolder: "Which folder should receive the history?" },
    );
    return picked?.folder;
  };

  context.subscriptions.push(
    vscode.commands.registerCommand(
      MIGRATE_SESSION_HISTORY_COMMAND,
      async () => {
        if (fileFolders().length === 0) {
          void vscode.window.showWarningMessage(
            "Open the renamed project folder first, then run this command again.",
          );
          return;
        }
        const candidates = discover().filter((candidate) => {
          const folder = folderForCandidate(candidate);
          if (!folder) return true;
          const request = buildRequest(
            candidate.previousRootPath,
            folder,
            candidate.previousProjectUri,
          );
          return request ? planProjectHistoryRelocation(request).ok : false;
        });
        type Item = vscode.QuickPickItem & {
          candidate?: ProjectHistoryRelocationCandidate;
        };
        const items: Item[] = [
          ...candidates.map((candidate) => ({
            label: candidate.previousDisplayName,
            description: candidate.previousRootPath,
            detail: [
              candidate.currentRootPath
                ? `Migrate into ${path.basename(candidate.currentRootPath)}`
                : undefined,
              candidate.previousExists
                ? "The previous folder still exists"
                : "The previous folder no longer exists",
            ]
              .filter(Boolean)
              .join(" · "),
            candidate,
          })),
          {
            label: "$(folder) Enter a previous folder path…",
            alwaysShow: true,
          },
        ];
        const picked = await vscode.window.showQuickPick(items, {
          placeHolder:
            candidates.length > 0
              ? "Select the folder this project's history came from"
              : "No previous locations found. Enter the previous folder path.",
        });
        if (!picked) return;

        let previousRootPath = picked.candidate?.previousRootPath;
        if (!previousRootPath) {
          const firstFolder = fileFolders()[0];
          previousRootPath = (
            await vscode.window.showInputBox({
              prompt:
                "Absolute path of the folder before it was renamed or moved",
              value: firstFolder
                ? `${path.dirname(firstFolder.uri.fsPath)}${path.sep}`
                : undefined,
              validateInput: (value) =>
                path.isAbsolute(value.trim())
                  ? undefined
                  : "Enter an absolute folder path.",
            })
          )?.trim();
          if (!previousRootPath) return;
          previousRootPath = path.resolve(previousRootPath);
        }

        const folder =
          (picked.candidate && folderForCandidate(picked.candidate)) ??
          (await pickDestinationFolder());
        if (!folder) return;
        const request = buildRequest(
          previousRootPath,
          folder,
          picked.candidate?.previousProjectUri,
        );
        if (!request) {
          void vscode.window.showWarningMessage(
            `${folder.name} is not available as a local project folder.`,
          );
          return;
        }
        await runMigration(request, false);
      },
    ),
  );

  // Offer once per previous/current pair when a rename or move is evident:
  // the location marker or a v2 manifest names the previous path, or saved
  // sessions reference exactly one missing location.
  const startupCandidates = discover().filter(
    (candidate) => !candidate.previousExists,
  );
  const historyOnly = startupCandidates.filter((candidate) =>
    candidate.evidence.every((evidence) => evidence === "session_history"),
  );
  for (const candidate of startupCandidates) {
    if (historyOnly.includes(candidate) && historyOnly.length !== 1) continue;
    const folder = folderForCandidate(candidate);
    if (!folder) continue;
    const dismissKey = `projectHistoryRelocation.dismissed.${candidate.previousRootPath}->${folder.uri.fsPath}`;
    if (context.globalState.get<boolean>(dismissKey, false)) continue;
    const request = buildRequest(
      candidate.previousRootPath,
      folder,
      candidate.previousProjectUri,
    );
    const planned = request ? planProjectHistoryRelocation(request) : undefined;
    if (!request || !planned?.ok) continue;

    void vscode.window
      .showInformationMessage(
        `AgentLink found ${planned.plan.totalSessions} sessions from "${candidate.previousRootPath}", which looks like this folder's previous location. Migrate them so they can be resumed here? A backup is kept in .agentlink/backups.`,
        "Migrate history",
        "Not now",
        "Don't ask again",
      )
      .then(async (choice) => {
        if (choice === "Migrate history") {
          await runMigration(request, true);
        } else if (choice === "Don't ask again") {
          await context.globalState.update(dismissKey, true);
        }
      });
    break;
  }
}
