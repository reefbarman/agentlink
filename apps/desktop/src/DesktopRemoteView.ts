import { randomUUID } from "node:crypto";
import * as path from "node:path";
import {
  isWorkspaceTabAction,
  isWorkspaceTabGroups,
  type WorkspaceTabGroup,
} from "../../../src/browser-gateway/webview/workspaceTabsBridge.js";
import {
  ipcMain,
  session,
  WebContentsView,
  type BrowserWindow,
  type IpcMainEvent,
} from "electron";
import type {
  DesktopRemoteLayout,
  DesktopRemoteState,
} from "../../../src/shared/desktopBridge.js";
import { openExternalLink } from "./desktopExternalLinks.js";
import { discoverDesktopRemote } from "./desktopRemoteDiscovery.js";

const POLL_MS = 3_000;
const LOAD_TIMEOUT_MS = 15_000;

export function isDesktopRemoteLayout(
  value: unknown,
): value is DesktopRemoteLayout {
  if (!value || typeof value !== "object") return false;
  const layout = value as DesktopRemoteLayout;
  return (
    (layout.mode === "ask" ||
      layout.mode === "vscode" ||
      layout.mode === "assistant") &&
    !!layout.bounds &&
    [
      layout.bounds.x,
      layout.bounds.y,
      layout.bounds.width,
      layout.bounds.height,
    ].every((part) => typeof part === "number" && Number.isFinite(part)) &&
    layout.bounds.width >= 0 &&
    layout.bounds.height >= 0
  );
}

export function isTrustedDesktopSender(
  event: IpcMainEvent,
  window: BrowserWindow,
  origin: string,
): boolean {
  try {
    return (
      !window.isDestroyed() &&
      event.sender === window.webContents &&
      event.senderFrame === window.webContents.mainFrame &&
      new URL(event.senderFrame.url).origin === origin
    );
  } catch {
    return false;
  }
}

export function clampDesktopRemoteBounds(
  bounds: DesktopRemoteLayout["bounds"],
  size: number[],
  zoom: number,
): DesktopRemoteLayout["bounds"] {
  const [width, height] = size;
  const factor = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const x = Math.min(width, Math.max(0, Math.ceil(bounds.x * factor)));
  const y = Math.min(height, Math.max(0, Math.ceil(bounds.y * factor)));
  const right = Math.min(
    width,
    Math.max(x, Math.floor((bounds.x + bounds.width) * factor)),
  );
  const bottom = Math.min(
    height,
    Math.max(y, Math.floor((bounds.y + bounds.height) * factor)),
  );
  return { x, y, width: right - x, height: bottom - y };
}

export class DesktopRemoteView {
  private readonly view: WebContentsView;
  private layout: DesktopRemoteLayout = {
    mode: "ask",
    bounds: { x: 0, y: 0, width: 0, height: 0 },
  };
  private status: DesktopRemoteState["status"] = "idle";
  private targetUrl: string | null = null;
  private attemptedKey: string | null = null;
  private loaded = false;
  private disposed = false;
  private checking = false;
  private tabGroups: WorkspaceTabGroup[] | null = null;
  private tabsSubscribed = false;
  private retryPending = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly window: BrowserWindow,
    private readonly shellOrigin: string,
    private readonly discover = discoverDesktopRemote,
  ) {
    const remoteSession = session.fromPartition(
      `agentlink-desktop-remote-${randomUUID()}`,
    );
    remoteSession.setPermissionRequestHandler(
      (_contents, _permission, callback) => callback(false),
    );
    remoteSession.setPermissionCheckHandler(() => false);
    remoteSession.setDevicePermissionHandler(() => false);
    remoteSession.on("will-download", (event) => event.preventDefault());
    this.view = new WebContentsView({
      webPreferences: {
        session: remoteSession,
        preload: path.join(__dirname, "workspace-preload.cjs"),
        sandbox: true,
        backgroundThrottling: false,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false,
        navigateOnDragDrop: false,
      },
    });
    this.view.setVisible(false);
    window.contentView.addChildView(this.view);
    const contents = this.view.webContents;
    contents.setWindowOpenHandler(({ url }) => {
      this.openExternal(url);
      return { action: "deny" };
    });
    contents.on("will-navigate", (event, url) => {
      if (this.isRemoteDocument(url)) return;
      event.preventDefault();
      this.openExternal(url);
    });
    contents.on("will-frame-navigate", (event) => {
      if (!event.isMainFrame || !this.isRemoteDocument(event.url))
        event.preventDefault();
    });
    contents.on("will-redirect", (event) => event.preventDefault());
    contents.on("will-attach-webview", (event) => event.preventDefault());
    contents.on("render-process-gone", () => this.loadFailed());
    contents.on(
      "did-fail-load",
      (_event, code, _description, _url, isMainFrame) => {
        if (isMainFrame && code !== -3) this.loadFailed();
      },
    );
    ipcMain.on("agentlink:remote:layout", this.onLayout);
    ipcMain.on("agentlink:remote:retry", this.onRetry);
    ipcMain.on("agentlink:remote:tabs", this.onTabs);
    ipcMain.on("agentlink:remote:tabs-subscribe", this.onTabsSubscribe);
    ipcMain.on("agentlink:remote:tab-action", this.onTabAction);
    // A cancelled navigation leaves the old document and its hosted tabs alive.
    contents.on("did-navigate", () => this.clearTabs());
    window.on("resize", this.onResize);
    window.on("closed", this.dispose);
    window.webContents.on("zoom-changed", this.onResize);
    window.webContents.on("did-start-navigation", this.onShellNavigation);
  }

  private openExternal(url: string): void {
    const internal = [this.shellOrigin];
    if (this.targetUrl) internal.push(new URL(this.targetUrl).origin);
    openExternalLink(url, internal);
  }

  private isRemoteDocument(url: string): boolean {
    if (!this.targetUrl) return false;
    try {
      const target = new URL(url);
      const allowed = new URL(this.targetUrl);
      return (
        target.origin === allowed.origin &&
        target.pathname === "/" &&
        !target.username &&
        !target.password &&
        target.search === allowed.search
      );
    } catch {
      return false;
    }
  }

  private readonly onLayout = (event: IpcMainEvent, value: unknown): void => {
    if (
      !isTrustedDesktopSender(event, this.window, this.shellOrigin) ||
      !isDesktopRemoteLayout(value)
    )
      return;
    const activate = this.layout.mode !== "vscode" && value.mode === "vscode";
    this.layout = value;
    this.updateBounds();
    this.publish();
    if (value.mode !== "vscode") this.clearTimer();
    else if (activate) void this.check();
  };

  private readonly onRetry = (event: IpcMainEvent): void => {
    if (
      !isTrustedDesktopSender(event, this.window, this.shellOrigin) ||
      this.layout.mode !== "vscode"
    )
      return;
    this.retryPending = true;
    void this.check();
  };

  private publishTabs(): void {
    if (this.tabsSubscribed && !this.window.webContents.isDestroyed()) {
      this.window.webContents.send("agentlink:remote:tabs", this.tabGroups);
      if (this.tabGroups)
        this.view.webContents.send("agentlink:remote:tabs-hosted");
    }
  }

  private clearTabs(): void {
    this.tabGroups = null;
    this.publishTabs();
  }

  private readonly onTabs = (event: IpcMainEvent, groups: unknown): void => {
    if (
      event.sender !== this.view.webContents ||
      event.senderFrame !== this.view.webContents.mainFrame ||
      !this.isRemoteDocument(event.senderFrame.url) ||
      !isWorkspaceTabGroups(groups)
    )
      return;
    this.tabGroups = groups;
    this.publishTabs();
  };

  private readonly onTabsSubscribe = (event: IpcMainEvent): void => {
    if (!isTrustedDesktopSender(event, this.window, this.shellOrigin)) return;
    this.tabsSubscribed = true;
    this.publishTabs();
  };

  private readonly onTabAction = (
    event: IpcMainEvent,
    action: unknown,
  ): void => {
    if (
      !isTrustedDesktopSender(event, this.window, this.shellOrigin) ||
      this.layout.mode !== "vscode" ||
      !this.tabGroups ||
      !isWorkspaceTabAction(action)
    )
      return;
    this.view.webContents.send("agentlink:remote:tab-action", action);
  };

  private readonly onResize = (): void => this.updateBounds();

  private readonly onShellNavigation = (
    _event: unknown,
    _url: string,
    isInPlace: boolean,
    isMainFrame: boolean,
  ): void => {
    if (isMainFrame && !isInPlace) {
      this.tabsSubscribed = false;
      this.layout.mode = "ask";
      this.clearTimer();
      this.updateBounds();
    }
  };

  private publish(): void {
    if (!this.disposed && !this.window.webContents.isDestroyed()) {
      this.window.webContents.send("agentlink:remote:state", {
        status: this.status,
      });
    }
  }

  private setStatus(status: DesktopRemoteState["status"]): void {
    this.status = status;
    this.updateBounds();
    this.publish();
  }

  private updateBounds(): void {
    if (this.disposed || this.window.isDestroyed()) return;
    const bounds = clampDesktopRemoteBounds(
      this.layout.bounds,
      this.window.getContentSize(),
      this.window.webContents.getZoomFactor(),
    );
    this.view.setBounds(bounds);
    this.view.setVisible(
      this.layout.mode === "vscode" &&
        this.status === "ready" &&
        bounds.width > 0 &&
        bounds.height > 0,
    );
  }

  private loadFailed(): void {
    if (this.disposed) return;
    this.loaded = false;
    this.clearTabs();
    this.setStatus("unavailable");
  }

  private clearTimer(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private async check(): Promise<void> {
    if (this.disposed || this.checking || this.layout.mode !== "vscode") return;
    this.clearTimer();
    this.checking = true;
    try {
      if (this.retryPending) {
        this.retryPending = false;
        this.attemptedKey = null;
      }
      if (this.status !== "ready") this.setStatus("connecting");
      const target = await this.discover();
      if (this.disposed || this.layout.mode !== "vscode") return;
      if (!target) {
        this.setStatus("unavailable");
        return;
      }
      const key = `${target.generation}:${target.url}`;
      if (key !== this.attemptedKey) {
        this.attemptedKey = key;
        this.clearTabs();
        this.targetUrl = target.url;
        this.loaded = false;
        this.setStatus("connecting");
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            this.view.webContents.loadURL(target.url),
            new Promise<never>((_resolve, reject) => {
              timeout = setTimeout(
                () => reject(new Error("remote_load_timeout")),
                LOAD_TIMEOUT_MS,
              );
            }),
          ]);
          this.loaded = true;
        } catch {
          if (!this.disposed) this.view.webContents.stop();
          this.loaded = false;
        } finally {
          clearTimeout(timeout);
        }
      }
      if (!this.disposed) this.setStatus(this.loaded ? "ready" : "unavailable");
    } catch {
      if (!this.disposed) this.setStatus("unavailable");
    } finally {
      this.checking = false;
      if (!this.disposed && this.layout.mode === "vscode") {
        this.timer = setTimeout(
          () => void this.check(),
          this.retryPending ? 0 : POLL_MS,
        );
        this.timer.unref();
      }
    }
  }

  readonly dispose = (): void => {
    if (this.disposed) return;
    this.disposed = true;
    this.clearTimer();
    ipcMain.removeListener("agentlink:remote:layout", this.onLayout);
    ipcMain.removeListener("agentlink:remote:retry", this.onRetry);
    ipcMain.removeListener("agentlink:remote:tabs", this.onTabs);
    ipcMain.removeListener(
      "agentlink:remote:tabs-subscribe",
      this.onTabsSubscribe,
    );
    ipcMain.removeListener("agentlink:remote:tab-action", this.onTabAction);
    this.window.removeListener("resize", this.onResize);
    this.window.removeListener("closed", this.dispose);
    if (!this.window.isDestroyed()) {
      this.window.webContents.removeListener("zoom-changed", this.onResize);
      this.window.webContents.removeListener(
        "did-start-navigation",
        this.onShellNavigation,
      );
      this.window.contentView.removeChildView(this.view);
    }
    if (!this.view.webContents.isDestroyed()) this.view.webContents.close();
  };
}
