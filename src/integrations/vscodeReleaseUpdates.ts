import * as vscode from "vscode";

import type { ChatViewProvider } from "../agent/ChatViewProvider.js";
import { ReleaseUpdateService } from "../updates/ReleaseUpdateService.js";
import path from "node:path";

export function registerVscodeReleaseUpdates(
  context: vscode.ExtensionContext,
  provider: ChatViewProvider,
): ReleaseUpdateService {
  const settings = () => vscode.workspace.getConfiguration("agentlink");
  const metadataTarget: unknown =
    context.extension.packageJSON.__metadata?.targetPlatform;
  const platform =
    process.platform === "linux" && !hasGlibc() ? "alpine" : process.platform;
  const service = new ReleaseUpdateService({
    identity: {
      product: "vscode",
      version: context.extension.packageJSON.version,
      target:
        typeof metadataTarget === "string" && metadataTarget !== "undefined"
          ? metadataTarget
          : `${platform}-${process.arch}`,
      vscodeVersion: vscode.version,
      hostLabel: vscode.env.remoteName
        ? `Remote extension host (${vscode.env.remoteName})`
        : "Local extension host",
      development: context.extensionMode !== vscode.ExtensionMode.Production,
    },
    storageDirectory: path.join(context.globalStorageUri.fsPath, "updates"),
    automaticChecks: settings().get<boolean>("updates.automaticChecks", true),
    saveAutomaticChecks: async (value) => {
      await settings().update(
        "updates.automaticChecks",
        value,
        vscode.ConfigurationTarget.Global,
      );
    },
  });
  provider.setReleaseUpdateService(service);
  const unsubscribe = service.subscribe(() =>
    provider.sendReleaseUpdateState(),
  );
  context.subscriptions.push(
    service,
    { dispose: unsubscribe },
    vscode.commands.registerCommand("agentlink.checkForUpdates", async () => {
      await vscode.commands.executeCommand("agentLink.chatView.focus");
      provider.sendReleaseUpdateState(true);
      await service.check();
      provider.sendReleaseUpdateState(true);
    }),
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) service.checkDue();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration("agentlink.updates.automaticChecks"))
        return;
      const value = settings().get<boolean>("updates.automaticChecks", true);
      if (value !== service.snapshot().automaticChecks)
        void service.setAutomaticChecks(value);
    }),
  );
  void service
    .start()
    .catch(() =>
      provider.log(
        "[updates] Update status could not be loaded; manual checking remains available.",
      ),
    );
  return service;
}

function hasGlibc(): boolean {
  const report = process.report?.getReport();
  return Boolean(
    report &&
    typeof report === "object" &&
    "header" in report &&
    report.header &&
    typeof report.header === "object" &&
    "glibcVersionRuntime" in report.header,
  );
}
