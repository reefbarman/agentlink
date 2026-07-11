import * as vscode from "vscode";

import type { BrowserGatewayHelperDiscoveryRecord } from "./protocol.js";

export interface BrowserGatewayCommandDependencies {
  ensureRuntimeReady(): Promise<void>;
  forceRestart(): Promise<void>;
  pairBrowserDevice(): Promise<void>;
  managePairedDevices(): Promise<void>;
  getDiscovery(): BrowserGatewayHelperDiscoveryRecord | null;
  extensionVersion: string;
  formatError(error: unknown): string;
  log(message: string): void;
}

export function collectGatewayUrls(
  discovery: BrowserGatewayHelperDiscoveryRecord,
): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];
  const push = (url: string | undefined) => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    urls.push(url);
  };
  if (discovery.lanAccess) {
    push(discovery.mdnsUrl);
    for (const url of discovery.lanUrls ?? []) push(url);
  }
  push(discovery.url);
  return urls;
}

export function registerBrowserGatewayCommands({
  ensureRuntimeReady,
  forceRestart,
  pairBrowserDevice,
  managePairedDevices,
  getDiscovery,
  extensionVersion,
  formatError,
  log,
}: BrowserGatewayCommandDependencies): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand(
      "agentlink.restartBrowserGateway",
      async () => {
        try {
          await forceRestart();
        } catch (error) {
          vscode.window.showErrorMessage(formatError(error));
          return;
        }

        const discovery = getDiscovery();
        const message = discovery
          ? `AgentLink browser gateway restarted (helperVersion ${discovery.helperVersion}, extension ${extensionVersion}). Refresh the browser tab to load the latest assets. If you are testing local workspace changes, reload/reinstall the extension first so the helper serves the rebuilt dist assets.`
          : "AgentLink browser gateway restarted. Refresh the browser tab to load the latest assets. If you are testing local workspace changes, reload/reinstall the extension first so the helper serves the rebuilt dist assets.";
        const action = await vscode.window.showInformationMessage(
          message,
          "Open Browser Gateway",
        );
        if (action === "Open Browser Gateway" && discovery) {
          const [url] = collectGatewayUrls(discovery);
          await vscode.env.openExternal(vscode.Uri.parse(url));
        }
      },
    ),
    vscode.commands.registerCommand(
      "agentlink.openBrowserGateway",
      async () => {
        try {
          await ensureRuntimeReady();
        } catch (error) {
          vscode.window.showErrorMessage(formatError(error));
          return;
        }
        const discovery = getDiscovery();
        if (!discovery) {
          vscode.window.showErrorMessage(
            "AgentLink browser gateway helper is not ready yet.",
          );
          return;
        }

        const urls = collectGatewayUrls(discovery);
        if (!discovery.lanAccess || urls.length <= 1) {
          await vscode.env.openExternal(vscode.Uri.parse(urls[0]));
          return;
        }

        type GatewayUrlPick = vscode.QuickPickItem & { url: string };
        const items: GatewayUrlPick[] = urls.map((url, index) => ({
          label: url,
          description:
            index === 0
              ? url.includes(".local")
                ? "mDNS — works on the same network"
                : "LAN IP"
              : url.startsWith("http://127.0.0.1")
                ? "loopback (this machine only)"
                : "LAN IP fallback",
          url,
        }));
        const picked = await vscode.window.showQuickPick(items, {
          title: "Open Browser Gateway",
          placeHolder: "Pick the URL to open",
          ignoreFocusOut: true,
        });
        if (!picked) return;
        await vscode.env.openExternal(vscode.Uri.parse(picked.url));
      },
    ),
    vscode.commands.registerCommand(
      "agentlink.showBrowserGatewayStatus",
      async () => {
        try {
          await ensureRuntimeReady();
        } catch (error) {
          vscode.window.showErrorMessage(formatError(error));
          return;
        }
        const discovery = getDiscovery();
        if (!discovery) {
          vscode.window.showWarningMessage(
            "AgentLink browser gateway helper is not ready yet.",
          );
          return;
        }
        const lines = [
          `AgentLink browser gateway helper (pid ${discovery.pid}, helperVersion ${discovery.helperVersion})`,
          `Loopback: ${discovery.url}`,
          `LAN access: ${discovery.lanAccess ? "on" : "off"}`,
        ];
        if (discovery.mdnsUrl) {
          lines.push(`mDNS URL: ${discovery.mdnsUrl}`);
        } else if (discovery.lanAccess) {
          lines.push(
            "mDNS URL: (not advertised — check output log for mdns errors)",
          );
        }
        if (discovery.lanUrls && discovery.lanUrls.length > 0) {
          lines.push(`LAN IP URLs: ${discovery.lanUrls.join(", ")}`);
        }
        const message = lines.join("\n");
        log(`[browser-gateway-helper] status requested:\n${message}`);
        const pick = await vscode.window.showInformationMessage(
          message,
          { modal: true },
          "Copy mDNS URL",
          "Copy loopback URL",
        );
        if (pick === "Copy mDNS URL" && discovery.mdnsUrl) {
          await vscode.env.clipboard.writeText(discovery.mdnsUrl);
        } else if (pick === "Copy loopback URL") {
          await vscode.env.clipboard.writeText(discovery.url);
        }
      },
    ),
    vscode.commands.registerCommand("agentlink.pairBrowserDevice", async () => {
      try {
        await ensureRuntimeReady();
      } catch (error) {
        vscode.window.showErrorMessage(formatError(error));
        return;
      }
      await pairBrowserDevice();
    }),
    vscode.commands.registerCommand(
      "agentlink.managePairedDevices",
      async () => {
        try {
          await ensureRuntimeReady();
        } catch (error) {
          vscode.window.showErrorMessage(formatError(error));
          return;
        }
        await managePairedDevices();
      },
    ),
  ];
}
