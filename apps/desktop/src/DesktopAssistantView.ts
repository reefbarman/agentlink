import {
  ipcMain,
  session,
  WebContentsView,
  type BrowserWindow,
  type IpcMainEvent,
  type Session,
} from "electron";
import type {
  DesktopAssistantChrome,
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

export function isDesktopAssistantChrome(
  value: unknown,
): value is DesktopAssistantChrome {
  if (!value || typeof value !== "object") return false;
  const chrome = value as DesktopAssistantChrome;
  return (
    typeof chrome.sidebarOpen === "boolean" &&
    (chrome.sidebarWidth === undefined ||
      (typeof chrome.sidebarWidth === "number" &&
        Number.isFinite(chrome.sidebarWidth) &&
        chrome.sidebarWidth > 0))
  );
}

/**
 * The desktop's Assistant tab: the AgentLink Assistant's own web app in a
 * sandboxed view with no permissions and navigation locked to the
 * Assistant's origin. It is a separate page, not a frame inside the shell,
 * so the Assistant keeps its anti-framing and same-site protections.
 *
 * Its only preload is the embed bridge: the page may draw the desktop's
 * sidebar (following the shell's open state and width) and ask for another
 * view. Once it says it does, the shell hands it the sidebar's space so the
 * Assistant reads as part of the app rather than a window inside it.
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
  /** The page draws the desktop chrome (it called the bridge's `ready`). */
  private embedded = false;
  /** Whether the current document has said so; reset per navigation. */
  private readyThisLoad = false;
  private chrome: DesktopAssistantChrome = { sidebarOpen: true };
  /** The page's last reported unread inbox count, for the tab badge. */
  private unread = 0;
  /** Sub-pixel padding the page adds so its sidebar meets the title bar. */
  private offsetTop = 0;
  /** The last failure happened while another view showed; opening retries. */
  private failedInBackground = false;

  constructor(
    private readonly window: BrowserWindow,
    private readonly shellOrigin: string,
    private config: DesktopAssistantConfig,
    private readonly now: () => number = Date.now,
    preload?: string,
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
        ...(preload ? { preload } : {}),
      },
    });
    this.view.setVisible(false);
    window.contentView.addChildView(this.view);
    const contents = this.view.webContents;
    contents.on(
      "did-start-navigation",
      (
        _event: unknown,
        _url: string,
        isInPlace: boolean,
        isMainFrame: boolean,
      ) => {
        if (isMainFrame && !isInPlace) this.readyThisLoad = false;
      },
    );
    // A page that loaded without the bridge (sign-in, an older Assistant)
    // gets the shell's sidebar back. Checked after load, not at navigation
    // start, so reloads of the app itself do not flash the shell sidebar.
    contents.on("did-finish-load", () => {
      this.matchShellZoom();
      if (!this.readyThisLoad) {
        this.unread = 0;
        this.setEmbedded(false);
      }
    });
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
    ipcMain.on("agentlink:assistant:chrome", this.onChrome);
    ipcMain.on("agentlink:assistant-embed:ready", this.onEmbedReady);
    ipcMain.on("agentlink:assistant-embed:show-view", this.onShowView);
    ipcMain.on("agentlink:assistant-embed:unread", this.onUnread);
    window.on("resize", this.onResize);
    window.on("closed", this.dispose);
    window.webContents.on("zoom-changed", this.onResize);
    window.webContents.on("did-start-navigation", this.onShellNavigation);
    void this.preloadIfPaired();
  }

  /**
   * Load the Assistant hidden, so its tab can show the unread inbox badge
   * and opens instantly. Only once this desktop has signed in to it before
   * (its session holds cookies for the address): people who never use an
   * Assistant make no connection at launch.
   */
  private async preloadIfPaired(): Promise<void> {
    const origin = this.config.origin;
    let paired = false;
    try {
      const cookies = await this.assistantSession.cookies.get({
        url: `${origin}/`,
      });
      paired = cookies.length > 0;
    } catch {
      paired = false;
    }
    if (
      !paired ||
      this.disposed ||
      this.loaded ||
      this.loading ||
      this.config.origin !== origin
    )
      return;
    void this.load();
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
    this.embedded = false;
    this.unread = 0;
    this.error = undefined;
    this.setStatus("idle");
    if (this.layout.mode === "assistant") void this.load();
    else void this.preloadIfPaired();
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

  /** A message from the Assistant page itself, not a frame or other page. */
  private isAssistantSender(event: IpcMainEvent): boolean {
    const contents = this.view.webContents;
    try {
      return (
        !this.disposed &&
        event.sender === contents &&
        event.senderFrame === contents.mainFrame &&
        this.isAssistantUrl(event.senderFrame.url)
      );
    } catch {
      return false;
    }
  }

  private readonly onEmbedReady = (event: IpcMainEvent): void => {
    if (!this.isAssistantSender(event)) return;
    this.readyThisLoad = true;
    this.sendChrome();
    this.setEmbedded(true);
  };

  private readonly onShowView = (event: IpcMainEvent, mode: unknown): void => {
    if (!this.isAssistantSender(event) || this.window.isDestroyed()) return;
    if (mode !== "ask" && mode !== "vscode") return;
    this.window.webContents.send("agentlink:assistant:show-view", mode);
  };

  private readonly onUnread = (event: IpcMainEvent, count: unknown): void => {
    if (!this.isAssistantSender(event)) return;
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0)
      return;
    if (this.unread === count) return;
    this.unread = count;
    this.publish();
  };

  private readonly onChrome = (event: IpcMainEvent, value: unknown): void => {
    if (
      !isTrustedDesktopSender(event, this.window, this.shellOrigin) ||
      !isDesktopAssistantChrome(value)
    )
      return;
    this.chrome = {
      sidebarOpen: value.sidebarOpen,
      ...(value.sidebarWidth !== undefined
        ? { sidebarWidth: value.sidebarWidth }
        : {}),
    };
    this.sendChrome();
  };

  private sendChrome(): void {
    const contents = this.view.webContents;
    if (this.disposed || contents.isDestroyed()) return;
    contents.send("agentlink:assistant-embed:chrome", {
      ...this.chrome,
      ...(this.offsetTop > 0 ? { offsetTop: this.offsetTop } : {}),
    });
  }

  private setEmbedded(embedded: boolean): void {
    if (this.embedded === embedded) return;
    this.embedded = embedded;
    this.publish();
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
      (this.error === undefined || this.failedInBackground)
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
    this.failedInBackground = false;
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
    this.embedded = false;
    this.unread = 0;
    this.failedInBackground = this.layout.mode !== "assistant";
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
      ...(this.embedded ? { embedded: true } : {}),
      ...(this.unread > 0 ? { unread: this.unread } : {}),
    };
    this.window.webContents.send("agentlink:assistant:state", state);
  }

  private setStatus(status: DesktopAssistantState["status"]): void {
    this.status = status;
    this.updateBounds();
    this.publish();
  }

  /**
   * Draw the Assistant at the shell's zoom, so the sidebar it draws matches
   * the shell's own (same font and button sizes, same sidebar width) when
   * switching views. Zooming the shell resizes its page, which reports a new
   * layout and lands here through `updateBounds`.
   */
  private matchShellZoom(): void {
    const contents = this.view.webContents;
    if (this.disposed || this.window.isDestroyed() || contents.isDestroyed())
      return;
    const zoom = this.window.webContents.getZoomFactor();
    if (contents.getZoomFactor() !== zoom) contents.setZoomFactor(zoom);
  }

  private updateBounds(): void {
    if (this.disposed || this.window.isDestroyed()) return;
    const zoom = this.window.webContents.getZoomFactor();
    const bounds = clampDesktopRemoteBounds(
      this.layout.bounds,
      this.window.getContentSize(),
      zoom,
    );
    // Zoomed, the shell's title bar can end part-way through a pixel (64px
    // at 110% is 70.4), but a view sits on whole pixels. Start the view on
    // the pixel above and have the page pad the rest, so its sidebar lines
    // up exactly with the shell's instead of shifting on every switch.
    let offsetTop = 0;
    const exactTop = this.layout.bounds.y * (zoom > 0 ? zoom : 1);
    if (bounds.height > 0 && Number.isFinite(exactTop) && exactTop > 0) {
      const top = Math.min(bounds.y, Math.floor(exactTop));
      bounds.height += bounds.y - top;
      bounds.y = top;
      offsetTop =
        Math.round(((exactTop - top) / (zoom > 0 ? zoom : 1)) * 1000) / 1000;
    }
    this.matchShellZoom();
    this.view.setBounds(bounds);
    if (offsetTop !== this.offsetTop) {
      this.offsetTop = offsetTop;
      this.sendChrome();
    }
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
    ipcMain.removeListener("agentlink:assistant:chrome", this.onChrome);
    ipcMain.removeListener(
      "agentlink:assistant-embed:ready",
      this.onEmbedReady,
    );
    ipcMain.removeListener(
      "agentlink:assistant-embed:show-view",
      this.onShowView,
    );
    ipcMain.removeListener("agentlink:assistant-embed:unread", this.onUnread);
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
