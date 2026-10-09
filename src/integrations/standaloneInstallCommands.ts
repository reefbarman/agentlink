import * as vscode from "vscode";
import {
  buildCliInstallCommand,
  findStandaloneRelease,
  type StandaloneProduct,
} from "./standaloneReleaseInstall.js";

export function registerStandaloneInstallCommands(): vscode.Disposable[] {
  const pending = new Set<StandaloneProduct>();
  async function install(product: StandaloneProduct): Promise<void> {
    if (pending.has(product)) return;
    if (
      vscode.env.remoteName ||
      process.platform !== "darwin" ||
      process.arch !== "arm64"
    ) {
      await vscode.window.showInformationMessage(
        product === "desktop"
          ? "Desktop installation requires a local macOS Apple Silicon VS Code window. Intel Macs are no longer supported."
          : "CLI installation requires a local macOS Apple Silicon VS Code window.",
      );
      return;
    }
    pending.add(product);
    try {
      const release = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Finding the latest AgentLink ${product} release`,
        },
        () => findStandaloneRelease(product, process.arch),
      );
      const action =
        product === "desktop" ? "Download DMG" : "Install in Terminal";
      const approved = await vscode.window.showWarningMessage(
        `Install AgentLink ${product} (${release.tag})?`,
        {
          modal: true,
          detail:
            "Published previews are unsigned and not notarised. Only proceed if you trust this release. " +
            (product === "desktop"
              ? "Your browser will download the DMG for this Mac. Open it and drag AgentLink to Applications. Quit an existing Desktop app before replacing it. macOS may require right-click > Open on first launch."
              : "A visible terminal will download and checksum-verify the bundle, install under ~/.local/lib/agentlink, and link ~/.local/bin/agentlink. An existing launcher will not be replaced. Your shell profile, sessions, and credentials are not changed. macOS may block this unsigned preview."),
        },
        action,
      );
      if (approved !== action) return;
      if (product === "desktop") {
        if (
          !(await vscode.env.openExternal(
            vscode.Uri.parse(release.asset.browser_download_url),
          ))
        ) {
          throw new Error(
            "Could not open the desktop download in your browser.",
          );
        }
      } else {
        const terminal = vscode.window.createTerminal({
          name: "Install AgentLink CLI",
          shellPath: "/bin/bash",
          shellArgs: ["--noprofile", "--norc"],
        });
        terminal.show();
        terminal.sendText(buildCliInstallCommand(release));
      }
    } catch (error) {
      await vscode.window.showErrorMessage(
        `AgentLink ${product} installation could not start: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      pending.delete(product);
    }
  }
  return [
    vscode.commands.registerCommand("agentlink.installDesktopApp", () =>
      install("desktop"),
    ),
    vscode.commands.registerCommand("agentlink.installCli", () =>
      install("cli"),
    ),
  ];
}
