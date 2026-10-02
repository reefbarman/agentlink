import { BrowserWindow, app } from "electron";

import type { BrowserGatewayHelperDiscoveryRecord } from "../../../src/browser-gateway/protocol.js";
import type { DesktopMcpManagerOpenRequest } from "../../../src/shared/desktopBridge.js";

const RANDOM_ID_PATTERN =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|id-[0-9a-f]+-[0-9a-f]{1,8})$/i;

export function isDesktopMcpManagerOpenRequest(
  value: unknown,
): value is DesktopMcpManagerOpenRequest {
  if (!value || typeof value !== "object") return false;
  const request = value as Record<string, unknown>;
  return (
    (request.view === "status" || request.view === "config") &&
    (request.action === "open" || request.action === "refresh")
  );
}

export function isDesktopMcpConfigScope(
  value: unknown,
): value is "global" | "ask-agent-global" {
  return value === "global" || value === "ask-agent-global";
}

export function isDesktopMcpOperationId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 64 &&
    RANDOM_ID_PATTERN.test(value)
  );
}

export interface DesktopMcpWindowOptions {
  getDiscovery(): BrowserGatewayHelperDiscoveryRecord | null;
  getPreloadPath(): string;
  onVisibilityChange(): void;
  log(message: string): void;
}

/** Owns the single lightweight MCP manager window, not its connections. */
export class DesktopMcpWindow {
  private window: BrowserWindow | null = null;
  private operationId: string | null = null;

  constructor(private readonly options: DesktopMcpWindowOptions) {}

  isDestroyed(): boolean {
    return !this.window || this.window.isDestroyed();
  }

  isVisible(): boolean {
    return Boolean(
      this.window && !this.window.isDestroyed() && this.window.isVisible(),
    );
  }

  get webContents(): Electron.WebContents | null {
    const contents = this.window?.webContents;
    return contents && !contents.isDestroyed() ? contents : null;
  }

  ownsSender(sender: Electron.WebContents): boolean {
    return Boolean(
      this.window &&
      !this.window.isDestroyed() &&
      sender.id === this.window.webContents.id,
    );
  }

  setOperation(operationId: unknown): void {
    this.operationId =
      operationId === null
        ? null
        : isDesktopMcpOperationId(operationId)
          ? operationId
          : null;
  }

  async open(request: DesktopMcpManagerOpenRequest): Promise<void> {
    const discovery = this.options.getDiscovery();
    if (!discovery) throw new Error("desktop_service_not_ready");
    const existing = this.window;
    if (existing && !existing.isDestroyed()) {
      const contents = existing.webContents;
      if (
        typeof contents.isLoadingMainFrame === "function" &&
        contents.isLoadingMainFrame()
      ) {
        contents.once("did-finish-load", () => {
          if (!contents.isDestroyed()) {
            contents.send("agentlink:mcp-manager:open", request);
          }
        });
      } else {
        contents.send("agentlink:mcp-manager:open", request);
      }
      await this.reveal(existing);
      return;
    }

    const window = new BrowserWindow({
      title: "MCP Servers",
      show: false,
      width: 800,
      height: 620,
      minWidth: 600,
      minHeight: 460,
      resizable: true,
      backgroundColor: "#111719",
      titleBarStyle: "hiddenInset",
      webPreferences: {
        preload: this.options.getPreloadPath(),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    this.window = window;
    const allowedOrigin = new URL(discovery.url).origin;
    window.webContents.on("will-navigate", (event, target) => {
      if (new URL(target).origin !== allowedOrigin) event.preventDefault();
    });
    window.webContents.on("will-redirect", (event, target) => {
      if (new URL(target).origin !== allowedOrigin) event.preventDefault();
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.on("show", this.options.onVisibilityChange);
    window.on("hide", this.options.onVisibilityChange);
    window.webContents.on("render-process-gone", () => {
      this.cancelOwnedOperation();
    });
    window.on("closed", () => {
      this.cancelOwnedOperation();
      if (this.window === window) this.window = null;
      this.options.onVisibilityChange();
    });

    const url = new URL(discovery.url);
    url.searchParams.set("surface", "desktop");
    url.searchParams.set("mcpManager", "1");
    url.searchParams.set("mcpView", request.view);
    url.searchParams.set("mcpAction", request.action);
    try {
      await window.loadURL(url.toString());
      await this.reveal(window);
    } catch (error) {
      if (!window.isDestroyed()) window.destroy();
      if (this.window === window) this.window = null;
      throw error;
    }
  }

  private async reveal(window: BrowserWindow): Promise<void> {
    await this.options.onVisibilityChange();
    appFocus();
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }

  private cancelOwnedOperation(): void {
    const operationId = this.operationId;
    this.operationId = null;
    if (!operationId) return;
    const discovery = this.options.getDiscovery();
    if (!discovery) return;
    void fetch(`${discovery.url}/internal/desktop/mcp-manager/cancel`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${discovery.clientSharedSecret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ operationId }),
    }).catch((error: unknown) =>
      this.options.log(
        `MCP operation close cancellation failed: ${String(error)}`,
      ),
    );
  }
}

function appFocus(): void {
  // Revealing any regular Desktop window also restores Dock visibility.
  void app.dock?.show();
  app.focus({ steal: true });
}
