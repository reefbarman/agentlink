import {
  ipcMain,
  session,
  WebContentsView,
  type BrowserWindow,
  type IpcMainEvent,
  type Session,
} from "electron";
import type {
  DesktopAssistantState,
  DesktopRemoteLayout,
} from "../../../src/shared/desktopBridge.js";
import type { DesktopAssistantConfig } from "./desktopAssistantSettings.js";
import { isTrustedAssistantCertificate } from "./desktopAssistantTrust.js";
import { openExternalLink } from "./desktopExternalLinks.js";
import {
  clampDesktopRemoteBounds,
  isDesktopRemoteLayout,
  isTrustedDesktopSender,
} from "./DesktopRemoteView.js";

/**
 * Persistent, so pairing the desktop with the Assistant survives restarts.
 * Only the Assistant ever loads in it.
 */
export const ASSISTANT_PARTITION = "persist:agentlink-assistant";
const LOAD_TIMEOUT_MS = 15_000;
/** Chromium's `net::ERR_ABORTED`: a superseded load, not a failure. */
const ERR_ABORTED = -3;

/** Chromium certificate errors are -200 to -299. */
function isCertificateError(code: number): boolean {
  return code <= -200 && code > -300;
}

/**
 * The desktop's Assistant tab: the AgentLink Assistant's own web app in a
 * sandboxed view with no preload, no permissions, and navigation locked to
 * the Assistant's origin. It is a separate page, not a frame inside the
 * shell, so the Assistant keeps its anti-framing and same-site protections.
 */
export class DesktopAssistantView {
  private readonly view: WebContentsView;
  private readonly assistantSession: Session;
  private layout: DesktopRemoteLayout = {
    mode: "ask",
    bounds: { x: 0, y: 0, width: 0, height: 0 },
  };
  private status: DesktopAssistantState["status"] = "idle";
  private error: DesktopAssistantState["error"];
  private loaded = false;
  private loading = false;
  private certificateRejected = false;
  private disposed = false;

  constructor(
    private readonly window: BrowserWindow,
    private readonly shellOrigin: string,
    private config: DesktopAssistantConfig,
    private readonly now: () => number = Date.now,
  ) {
    this.assistantSession = session.fromPartition(ASSISTANT_PARTITION);
    // Notifications and every other permission stay off for now.
    this.assistantSession.setPermissionRequestHandler(
      (_contents, _permission, callback) => callback(false),
    );
    this.assistantSession.setPermissionCheckHandler(() => false);
    this.assistantSession.setDevicePermissionHandler(() => false);
    this.assistantSession.setCertificateVerifyProc(this.verifyCertificate);
    this.view = new WebContentsView({
      webPreferences: {
        session: this.assistantSession,
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
      if (this.isAssistantUrl(url)) void contents.loadURL(url);
      else this.openExternal(url);
      return { action: "deny" };
    });
    contents.on("will-navigate", (event, url) => {
      if (this.isAssistantUrl(url)) return;
      event.preventDefault();
      this.openExternal(url);
    });
    contents.on("will-frame-navigate", (event) => {
      if (!event.isMainFrame || !this.isAssistantUrl(event.url)) {
        event.preventDefault();
      }
    });
    contents.on("will-redirect", (event, url) => {
      if (!this.isAssistantUrl(url)) event.preventDefault();
    });
    contents.on("will-attach-webview", (event) => event.preventDefault());
    contents.on("render-process-gone", () => this.loadFailed("load"));
    contents.on(
      "did-fail-load",
      (_event, code, _description, _url, isMainFrame) => {
        if (!isMainFrame || code === ERR_ABORTED) return;
        this.loadFailed(
          this.certificateRejected || isCertificateError(code)
            ? "certificate"
            : "load",
        );
      },
    );
    ipcMain.on("agentlink:remote:layout", this.onLayout);
    ipcMain.on("agentlink:assistant:retry", this.onRetry);
    window.on("resize", this.onResize);
    window.on("closed", this.dispose);
    window.webContents.on("zoom-changed", this.onResize);
    window.webContents.on("did-start-navigation", this.onShellNavigation);
  }

  /** Apply new Settings: reload if the address or pinned CA changed. */
  configure(config: DesktopAssistantConfig): void {
    const changed =
      config.origin !== this.config.origin ||
      config.ca?.fingerprint256 !== this.config.ca?.fingerprint256;
    this.config = config;
    if (!changed || this.disposed) {
      this.publish();
      return;
    }
    // Connections verified under the old trust must not be reused.
    void this.assistantSession.closeAllConnections().catch(() => undefined);
    this.loaded = false;
    this.error = undefined;
    this.setStatus("idle");
    if (this.layout.mode === "assistant") void this.load();
  }

  private readonly verifyCertificate = (
    request: Electron.Request,
    callback: (verificationResult: number) => void,
  ): void => {
    const { hostname, ca } = {
      hostname: new URL(this.config.origin).hostname,
      ca: this.config.ca,
    };
    const requested = request.hostname.replace(/^\[(.*)\]$/u, "$1");
    // Without a pinned CA, or for any other host, Chromium decides.
    if (!ca || requested !== hostname.replace(/^\[(.*)\]$/u, "$1")) {
      callback(-3);
      return;
    }
    const trusted = isTrustedAssistantCertificate({
      leafPem: request.certificate.data,
      ca,
      hostname: requested,
      now: this.now(),
    });
    if (!trusted) this.certificateRejected = true;
    callback(trusted ? 0 : -2);
  };

  private isAssistantUrl(url: string): boolean {
    try {
      const target = new URL(url);
      return (
        target.origin === this.config.origin &&
        !target.username &&
        !target.password
      );
    } catch {
      return false;
    }
  }

  private openExternal(url: string): void {
    openExternalLink(url, [this.shellOrigin, this.config.origin]);
  }

  private readonly onLayout = (event: IpcMainEvent, value: unknown): void => {
    if (
      !isTrustedDesktopSender(event, this.window, this.shellOrigin) ||
      !isDesktopRemoteLayout(value)
    )
      return;
    this.layout = value;
    this.updateBounds();
    this.publish();
    if (
      value.mode === "assistant" &&
      !this.loaded &&
      this.error === undefined
    ) {
      void this.load();
    }
  };

  private readonly onRetry = (event: IpcMainEvent): void => {
    if (
      !isTrustedDesktopSender(event, this.window, this.shellOrigin) ||
      this.layout.mode !== "assistant"
    )
      return;
    this.loaded = false;
    void this.load();
  };

  private readonly onResize = (): void => this.updateBounds();

  private readonly onShellNavigation = (
    _event: unknown,
    _url: string,
    isInPlace: boolean,
    isMainFrame: boolean,
  ): void => {
    if (isMainFrame && !isInPlace) {
      this.layout.mode = "ask";
      this.updateBounds();
    }
  };

  private async load(): Promise<void> {
    if (this.disposed || this.loading) return;
    this.loading = true;
    this.certificateRejected = false;
    this.error = undefined;
    this.setStatus("connecting");
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.view.webContents.loadURL(`${this.config.origin}/`),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error("assistant_load_timeout")),
            LOAD_TIMEOUT_MS,
          );
        }),
      ]);
      if (this.disposed) return;
      this.loaded = true;
      this.setStatus("ready");
    } catch {
      if (this.disposed) return;
      this.view.webContents.stop();
      this.loadFailed(this.certificateRejected ? "certificate" : "load");
    } finally {
      clearTimeout(timeout);
      this.loading = false;
    }
  }

  private loadFailed(error: NonNullable<DesktopAssistantState["error"]>): void {
    if (this.disposed) return;
    this.loaded = false;
    this.error = error;
    this.setStatus("unavailable");
  }

  private publish(): void {
    if (this.disposed || this.window.isDestroyed()) return;
    const state: DesktopAssistantState = {
      status: this.status,
      origin: this.config.origin,
      pinned: this.config.ca !== undefined,
      ...(this.error ? { error: this.error } : {}),
    };
    this.window.webContents.send("agentlink:assistant:state", state);
  }

  private setStatus(status: DesktopAssistantState["status"]): void {
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
      this.layout.mode === "assistant" &&
        this.status === "ready" &&
        bounds.width > 0 &&
        bounds.height > 0,
    );
  }

  readonly dispose = (): void => {
    if (this.disposed) return;
    this.disposed = true;
    ipcMain.removeListener("agentlink:remote:layout", this.onLayout);
    ipcMain.removeListener("agentlink:assistant:retry", this.onRetry);
    this.window.removeListener("resize", this.onResize);
    this.window.removeListener("closed", this.dispose);
    this.assistantSession.setCertificateVerifyProc(null);
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
