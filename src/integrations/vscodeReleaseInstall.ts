import * as vscode from "vscode";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ReleaseUpdateService } from "../updates/ReleaseUpdateService.js";
import {
  acquireInstallLock,
  downloadReleaseUpdate,
  type ReleaseInstallState,
} from "../updates/releaseInstall.js";
import {
  compareReleaseVersions,
  parseReleaseVersion,
} from "../updates/releaseSelection.js";

export function registerVscodeReleaseInstall(
  context: vscode.ExtensionContext,
  service: ReleaseUpdateService,
  publish: (state: ReleaseInstallState) => void,
): vscode.Disposable[] {
  let pending = false;
  let installedVersion: string | undefined;
  const directory = path.join(context.globalStorageUri.fsPath, "updates");
  const recordFile = path.join(directory, "installed.json");
  const readInstalled = async () => {
    const record: unknown = await readFile(recordFile, "utf8")
      .then((value) => JSON.parse(value))
      .catch(() => null);
    const identity = service.snapshot().identity;
    if (
      record &&
      typeof record === "object" &&
      "version" in record &&
      "target" in record &&
      typeof record.version === "string" &&
      parseReleaseVersion(record.version) &&
      record.target === identity.target &&
      compareReleaseVersions(record.version, identity.version) > 0
    ) {
      installedVersion = record.version;
      publish({
        phase: "ready_to_restart",
        version: installedVersion,
        message: `AgentLink ${installedVersion} is installed. Reload to use it.`,
      });
      return true;
    }
    return false;
  };
  const restart = async () => {
    if (!installedVersion && !(await readInstalled())) return;
    const approved = await vscode.window.showWarningMessage(
      `Reload to use AgentLink ${installedVersion}?`,
      {
        modal: true,
        detail:
          "Reloading this window interrupts its running agent sessions, including background agents. Other VS Code windows need their own reload.",
      },
      "Reload Window",
    );
    if (approved === "Reload Window")
      await vscode.commands.executeCommand("workbench.action.reloadWindow");
  };
  const install = async () => {
    if (pending) return;
    pending = true;
    let unlock: (() => Promise<void>) | undefined;
    let artifact: string | undefined;
    try {
      const snapshot = service.snapshot();
      if (snapshot.identity.development || vscode.env.remoteName) {
        const message = snapshot.identity.development
          ? "Source builds must be updated from source."
          : "Self-update is not available for remote hosts yet. Use the host's manual VSIX installation instructions.";
        publish({ phase: "blocked", message });
        await vscode.window.showInformationMessage(message);
        return;
      }
      if (await readInstalled()) {
        await restart();
        return;
      }
      const state = await service.check();
      if (!state.candidate) {
        await vscode.window.showInformationMessage(
          state.status === "current"
            ? "No newer compatible AgentLink release is available."
            : "No verified update is available. Open Check for Updates for the check status and manual installation links.",
        );
        return;
      }
      const approved = await vscode.window.showWarningMessage(
        `Install AgentLink ${state.candidate.version} on ${state.identity.hostLabel ?? "this extension host"}?`,
        {
          modal: true,
          detail:
            "The release will be downloaded from GitHub and checksum-verified. Installation does not reload the window. You will be asked before reloading.",
        },
        "Install",
      );
      if (approved !== "Install") return;
      unlock = await acquireInstallLock(directory);
      if (await readInstalled()) {
        await restart();
        return;
      }
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Updating AgentLink",
          cancellable: true,
        },
        async (progress, token) => {
          const controller = new AbortController();
          const subscription = token.onCancellationRequested(() =>
            controller.abort(),
          );
          try {
            artifact = await downloadReleaseUpdate(
              state.identity,
              state.candidate!,
              {
                directory: path.join(directory, "downloads"),
                signal: controller.signal,
                onState: (next) => {
                  publish(next);
                  progress.report({ message: next.phase });
                },
              },
            );
            controller.signal.throwIfAborted();
            publish({ phase: "installing", version: state.candidate!.version });
            await vscode.commands.executeCommand(
              "workbench.extensions.installExtension",
              vscode.Uri.file(artifact),
            );
            installedVersion = state.candidate!.version;
            publish({
              phase: "ready_to_restart",
              version: installedVersion,
              message: `AgentLink ${installedVersion} is installed. Reload to use it.`,
            });
            await mkdir(directory, { recursive: true });
            const temporary = `${recordFile}.${process.pid}.tmp`;
            await writeFile(
              temporary,
              JSON.stringify({
                version: installedVersion,
                target: state.identity.target,
                at: Date.now(),
              }),
              { mode: 0o600 },
            );
            await rename(temporary, recordFile);
          } finally {
            subscription.dispose();
          }
        },
      );
      await restart();
    } catch (error) {
      publish({
        phase: installedVersion ? "ready_to_restart" : "failed",
        version: installedVersion,
        message: installedVersion
          ? `AgentLink ${installedVersion} was installed, but recording update status failed. Reload to use it.`
          : error instanceof Error
            ? error.message
            : String(error),
      });
      await vscode.window.showErrorMessage(
        `AgentLink update: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      if (artifact) await rm(artifact, { force: true }).catch(() => undefined);
      try {
        await unlock?.();
      } finally {
        pending = false;
      }
    }
  };
  void readInstalled();
  return [
    vscode.commands.registerCommand("agentlink.installUpdate", install),
    vscode.commands.registerCommand("agentlink.restartForUpdate", restart),
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused && !pending) void readInstalled();
    }),
  ];
}
