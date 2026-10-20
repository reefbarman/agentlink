import {
  ASSISTANT_PARTITION,
  DesktopAssistantView,
} from "./DesktopAssistantView.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BrowserWindow } from "electron";
import { EventEmitter } from "node:events";

const electron = vi.hoisted(() => ({
  views: [] as any[],
  ipc: null as any,
  assistantSession: null as any,
  fromPartition: null as any,
  openExternal: vi.fn(),
  trusted: vi.fn(() => true),
}));
vi.mock("./desktopAssistantTrust.js", () => ({
  isTrustedAssistantCertificate: electron.trusted,
}));
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  electron.ipc = new EventEmitter();
  electron.assistantSession = Object.assign(new EventEmitter(), {
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    setDevicePermissionHandler: vi.fn(),
    setCertificateVerifyProc: vi.fn(),
    closeAllConnections: vi.fn(async () => undefined),
    cookies: { get: vi.fn(async (): Promise<unknown[]> => []) },
  });
  electron.fromPartition = vi.fn(() => electron.assistantSession);
  return {
    ipcMain: electron.ipc,
    shell: { openExternal: electron.openExternal },
    session: { fromPartition: electron.fromPartition },
    WebContentsView: class {
      webContents = Object.assign(new EventEmitter(), {
        loadURL: vi.fn(async () => undefined),
        stop: vi.fn(),
        close: vi.fn(),
        isDestroyed: () => false,
        setWindowOpenHandler: vi.fn(),
        send: vi.fn(),
        mainFrame: { url: "" },
        zoom: 1,
        getZoomFactor(): number {
          return this.zoom;
        },
        setZoomFactor: vi.fn(function (this: { zoom: number }, zoom: number) {
          this.zoom = zoom;
        }),
      });
      setVisible = vi.fn();
      setBounds = vi.fn();
      constructor(public options: unknown) {
        electron.views.push(this);
      }
    },
  };
});

const ORIGIN = "https://agentlink-assistant.local:8443";
const CA = { pem: "ca", fingerprint256: "AA:BB" };

function fixture(
  config: { origin: string; ca?: typeof CA } = { origin: ORIGIN },
  preload?: string,
) {
  const contents = Object.assign(new EventEmitter(), {
    mainFrame: { url: "http://127.0.0.1:47138/?surface=desktop" },
    send: vi.fn(),
    isDestroyed: () => false,
    zoom: 1,
    getZoomFactor(): number {
      return this.zoom;
    },
  });
  const window = Object.assign(new EventEmitter(), {
    webContents: contents,
    isDestroyed: (): boolean => false,
    getContentSize: () => [1200, 800],
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
  });
  const assistant = new DesktopAssistantView(
    window as unknown as BrowserWindow,
    "http://127.0.0.1:47138",
    config,
    () => 1_000,
    preload,
  );
  const sender = { sender: contents, senderFrame: contents.mainFrame };
  const layout = (mode: "ask" | "vscode" | "assistant") =>
    electron.ipc.emit("agentlink:remote:layout", sender, {
      mode,
      bounds: { x: 100, y: 40, width: 900, height: 700 },
    });
  const verify = (hostname: string) => {
    const proc =
      electron.assistantSession.setCertificateVerifyProc.mock.calls.at(-1)[0];
    const callback = vi.fn();
    proc({ hostname, certificate: { data: "leaf" } }, callback);
    return callback.mock.calls[0][0] as number;
  };
  const lastState = () =>
    contents.send.mock.calls
      .filter(([channel]) => channel === "agentlink:assistant:state")
      .at(-1)?.[1];
  return {
    window,
    contents,
    assistant,
    sender,
    layout,
    verify,
    lastState,
    view: electron.views.at(-1),
  };
}

async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe("desktop Assistant view", () => {
  beforeEach(() => {
    electron.views.length = 0;
    electron.trusted.mockReset().mockReturnValue(true);
    electron.openExternal.mockClear();
    electron.assistantSession.setCertificateVerifyProc.mockClear();
    electron.assistantSession.closeAllConnections.mockClear();
    electron.assistantSession.cookies.get.mockReset().mockResolvedValue([]);
  });
  afterEach(() => {
    electron.ipc.removeAllListeners();
  });

  it("uses a persistent, unprivileged session and loads only when its tab is shown", async () => {
    const f = fixture();
    expect(electron.fromPartition).toHaveBeenCalledWith(ASSISTANT_PARTITION);
    expect(ASSISTANT_PARTITION.startsWith("persist:")).toBe(true);
    expect(f.view.options.webPreferences).toMatchObject({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      session: electron.assistantSession,
    });
    expect(f.view.options.webPreferences).not.toHaveProperty("preload");

    f.layout("vscode");
    await flush();
    expect(f.view.webContents.loadURL).not.toHaveBeenCalled();
    f.layout("assistant");
    await flush();
    expect(f.view.webContents.loadURL).toHaveBeenCalledExactlyOnceWith(
      `${ORIGIN}/`,
    );
    expect(f.view.setVisible).toHaveBeenLastCalledWith(true);
    expect(f.lastState()).toEqual({
      status: "ready",
      origin: ORIGIN,
      pinned: false,
    });
    f.layout("ask");
    expect(f.view.setVisible).toHaveBeenLastCalledWith(false);
    // Switching back keeps the signed-in page instead of reloading it.
    f.layout("assistant");
    await flush();
    expect(f.view.webContents.loadURL).toHaveBeenCalledTimes(1);
    f.window.emit("closed");
    expect(f.view.webContents.close).toHaveBeenCalledOnce();
    expect(
      electron.assistantSession.setCertificateVerifyProc,
    ).toHaveBeenLastCalledWith(null);
    expect(electron.ipc.listenerCount("agentlink:assistant:retry")).toBe(0);
  });

  it("allows notifications only for the paired Assistant page", () => {
    const f = fixture();
    const contents = f.view.webContents;
    const request = (
      webContents: unknown,
      permission: string,
      requestingUrl: string,
      isMainFrame = true,
    ) => {
      const callback = vi.fn();
      electron.assistantSession.setPermissionRequestHandler.mock.calls.at(
        -1,
      )[0](webContents, permission, callback, { requestingUrl, isMainFrame });
      return callback.mock.calls[0][0] as boolean;
    };
    const check = (
      webContents: unknown,
      permission: string,
      origin: string,
      isMainFrame = true,
    ) =>
      electron.assistantSession.setPermissionCheckHandler.mock.calls.at(-1)[0](
        webContents,
        permission,
        origin,
        { requestingUrl: `${origin}/`, isMainFrame },
      ) as boolean;

    expect(request(contents, "notifications", `${ORIGIN}/inbox`)).toBe(true);
    expect(check(contents, "notifications", ORIGIN)).toBe(true);
    // Every other permission stays off, even for the Assistant.
    for (const permission of ["media", "geolocation", "clipboard-read"]) {
      expect(request(contents, permission, `${ORIGIN}/`)).toBe(false);
      expect(check(contents, permission, ORIGIN)).toBe(false);
    }
    // Other origins, credentials, subframes and other pages are refused.
    expect(request(contents, "notifications", "https://example.com/")).toBe(
      false,
    );
    expect(check(contents, "notifications", "https://example.com")).toBe(false);
    expect(
      request(
        contents,
        "notifications",
        "https://user:pw@agentlink-assistant.local:8443/",
      ),
    ).toBe(false);
    expect(request(contents, "notifications", `${ORIGIN}/`, false)).toBe(false);
    expect(check(contents, "notifications", ORIGIN, false)).toBe(false);
    expect(request({}, "notifications", `${ORIGIN}/`)).toBe(false);
    expect(check(null, "notifications", ORIGIN)).toBe(false);

    f.assistant.dispose();
    expect(request(contents, "notifications", `${ORIGIN}/`)).toBe(false);
    expect(check(contents, "notifications", ORIGIN)).toBe(false);
  });

  it("pins the configured CA for the Assistant's host only", () => {
    const unpinned = fixture();
    expect(unpinned.verify("agentlink-assistant.local")).toBe(-3);
    unpinned.assistant.dispose();

    const f = fixture({ origin: ORIGIN, ca: CA });
    expect(f.verify("agentlink-assistant.local")).toBe(0);
    expect(electron.trusted).toHaveBeenCalledWith({
      leafPem: "leaf",
      ca: CA,
      hostname: "agentlink-assistant.local",
      now: 1_000,
    });
    // Other hosts (not the Assistant) are left to Chromium.
    expect(f.verify("example.com")).toBe(-3);
    electron.trusted.mockReturnValue(false);
    expect(f.verify("agentlink-assistant.local")).toBe(-2);
    f.assistant.dispose();
  });

  it("reports an untrusted certificate and reloads only on Reconnect", async () => {
    const f = fixture({ origin: ORIGIN, ca: CA });
    electron.trusted.mockReturnValue(false);
    f.view.webContents.loadURL.mockImplementationOnce(async () => {
      f.verify("agentlink-assistant.local");
      f.view.webContents.emit("did-fail-load", {}, -202, "", ORIGIN, true);
      throw new Error("ERR_CERT_AUTHORITY_INVALID");
    });
    f.layout("assistant");
    await flush();
    expect(f.lastState()).toEqual({
      status: "unavailable",
      origin: ORIGIN,
      pinned: true,
      error: "certificate",
    });
    expect(f.view.setVisible).toHaveBeenLastCalledWith(false);
    f.layout("ask");
    f.layout("assistant");
    await flush();
    expect(f.view.webContents.loadURL).toHaveBeenCalledTimes(1);

    electron.trusted.mockReturnValue(true);
    electron.ipc.emit("agentlink:assistant:retry", f.sender);
    await flush();
    expect(f.view.webContents.loadURL).toHaveBeenCalledTimes(2);
    expect(f.lastState()).toMatchObject({ status: "ready" });
    f.assistant.dispose();
  });

  it("keeps navigation on the Assistant and opens everything else outside", async () => {
    const f = fixture();
    f.layout("assistant");
    await flush();
    for (const url of [`${ORIGIN}/devices`, `${ORIGIN}/pair?code=123456`]) {
      const event = { preventDefault: vi.fn() };
      f.view.webContents.emit("will-navigate", event, url);
      expect(event.preventDefault).not.toHaveBeenCalled();
    }
    for (const url of [
      "https://example.com/",
      "https://agentlink-assistant.local:9443/",
      "http://agentlink-assistant.local:8443/",
      "http://127.0.0.1:47138/",
      "file:///etc/passwd",
    ]) {
      const event = { preventDefault: vi.fn() };
      f.view.webContents.emit("will-navigate", event, url);
      expect(event.preventDefault).toHaveBeenCalled();
    }
    expect(electron.openExternal).toHaveBeenCalledWith("https://example.com/");
    expect(electron.openExternal).not.toHaveBeenCalledWith(
      "http://127.0.0.1:47138/",
    );
    const redirect = { preventDefault: vi.fn() };
    f.view.webContents.emit("will-redirect", redirect, "https://evil.test/");
    expect(redirect.preventDefault).toHaveBeenCalled();
    const frame = { preventDefault: vi.fn(), isMainFrame: false, url: ORIGIN };
    f.view.webContents.emit("will-frame-navigate", frame);
    expect(frame.preventDefault).toHaveBeenCalled();
    const open = f.view.webContents.setWindowOpenHandler.mock.calls[0][0];
    expect(open({ url: "https://docs.example/" })).toEqual({ action: "deny" });
    expect(electron.openExternal).toHaveBeenCalledWith("https://docs.example/");
    f.assistant.dispose();
  });

  it("ignores layout and retry from anything but the shell's main frame", async () => {
    const f = fixture();
    const valid = {
      mode: "assistant",
      bounds: { x: 0, y: 0, width: 100, height: 100 },
    };
    electron.ipc.emit(
      "agentlink:remote:layout",
      { sender: {}, senderFrame: f.contents.mainFrame },
      valid,
    );
    f.contents.mainFrame.url = "https://evil.test/";
    electron.ipc.emit("agentlink:remote:layout", f.sender, valid);
    electron.ipc.emit("agentlink:assistant:retry", f.sender);
    await flush();
    expect(f.view.webContents.loadURL).not.toHaveBeenCalled();
    f.assistant.dispose();
  });

  it("hands the sidebar to an Assistant page that draws it, and relays its view requests", async () => {
    const f = fixture({ origin: ORIGIN }, "/app/assistant-preload.cjs");
    expect(f.view.options.webPreferences).toMatchObject({
      preload: "/app/assistant-preload.cjs",
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    });
    f.layout("assistant");
    await flush();
    electron.ipc.emit("agentlink:assistant:chrome", f.sender, {
      sidebarOpen: false,
      sidebarWidth: 300,
    });
    const page = f.view.webContents;
    page.mainFrame.url = `${ORIGIN}/`;
    const pageSender = { sender: page, senderFrame: page.mainFrame };

    // Only the Assistant's own main frame can claim the sidebar.
    electron.ipc.emit("agentlink:assistant-embed:ready", f.sender);
    electron.ipc.emit("agentlink:assistant-embed:ready", {
      sender: page,
      senderFrame: { url: `${ORIGIN}/` },
    });
    expect(f.lastState()).not.toHaveProperty("embedded");

    electron.ipc.emit("agentlink:assistant-embed:ready", pageSender);
    expect(f.lastState()).toEqual({
      status: "ready",
      origin: ORIGIN,
      pinned: false,
      embedded: true,
    });
    expect(page.send).toHaveBeenLastCalledWith(
      "agentlink:assistant-embed:chrome",
      { sidebarOpen: false, sidebarWidth: 300 },
    );
    const sent = page.send.mock.calls.length;
    electron.ipc.emit("agentlink:assistant:chrome", f.sender, {
      sidebarOpen: true,
      sidebarWidth: "wide",
    });
    electron.ipc.emit("agentlink:assistant:chrome", pageSender, {
      sidebarOpen: true,
    });
    expect(page.send).toHaveBeenCalledTimes(sent);
    electron.ipc.emit("agentlink:assistant:chrome", f.sender, {
      sidebarOpen: true,
    });
    expect(page.send).toHaveBeenLastCalledWith(
      "agentlink:assistant-embed:chrome",
      { sidebarOpen: true },
    );

    electron.ipc.emit("agentlink:assistant-embed:show-view", pageSender, "ask");
    electron.ipc.emit(
      "agentlink:assistant-embed:show-view",
      pageSender,
      "settings",
    );
    electron.ipc.emit(
      "agentlink:assistant-embed:show-view",
      f.sender,
      "vscode",
    );
    const views = f.contents.send.mock.calls.filter(
      ([channel]) => channel === "agentlink:assistant:show-view",
    );
    expect(views).toEqual([["agentlink:assistant:show-view", "ask"]]);

    // The page's unread inbox count badges the shell's Assistant tab.
    electron.ipc.emit("agentlink:assistant-embed:unread", f.sender, 9);
    electron.ipc.emit("agentlink:assistant-embed:unread", pageSender, -1);
    electron.ipc.emit("agentlink:assistant-embed:unread", pageSender, "3");
    expect(f.lastState()).not.toHaveProperty("unread");
    electron.ipc.emit("agentlink:assistant-embed:unread", pageSender, 3);
    expect(f.lastState()).toMatchObject({ embedded: true, unread: 3 });
    electron.ipc.emit("agentlink:assistant-embed:unread", pageSender, 0);
    expect(f.lastState()).not.toHaveProperty("unread");
    electron.ipc.emit("agentlink:assistant-embed:unread", pageSender, 2);

    // A reload that keeps the bridge stays embedded; a page without it
    // (sign-in, an older Assistant) gives the sidebar back.
    page.emit("did-start-navigation", {}, `${ORIGIN}/`, false, true);
    electron.ipc.emit("agentlink:assistant-embed:ready", pageSender);
    page.emit("did-finish-load");
    expect(f.lastState()).toMatchObject({ embedded: true });
    expect(f.lastState()).toMatchObject({ unread: 2 });
    page.emit("did-start-navigation", {}, `${ORIGIN}/pair`, false, true);
    page.emit("did-finish-load");
    expect(f.lastState()).not.toHaveProperty("embedded");
    expect(f.lastState()).not.toHaveProperty("unread");
    f.assistant.dispose();
    expect(electron.ipc.listenerCount("agentlink:assistant-embed:ready")).toBe(
      0,
    );
    expect(electron.ipc.listenerCount("agentlink:assistant-embed:unread")).toBe(
      0,
    );
  });

  it("loads a paired Assistant hidden at launch so its tab can show unread", async () => {
    const unpaired = fixture();
    await flush();
    expect(unpaired.view.webContents.loadURL).not.toHaveBeenCalled();
    unpaired.assistant.dispose();

    electron.assistantSession.cookies.get.mockResolvedValue([
      { name: "session" },
    ]);
    const f = fixture();
    await flush();
    expect(electron.assistantSession.cookies.get).toHaveBeenLastCalledWith({
      url: `${ORIGIN}/`,
    });
    expect(f.view.webContents.loadURL).toHaveBeenCalledExactlyOnceWith(
      `${ORIGIN}/`,
    );
    expect(f.lastState()).toMatchObject({ status: "ready" });
    // Hidden until the Assistant view is chosen.
    expect(f.view.setVisible).toHaveBeenLastCalledWith(false);
    f.layout("assistant");
    await flush();
    expect(f.view.webContents.loadURL).toHaveBeenCalledOnce();
    expect(f.view.setVisible).toHaveBeenLastCalledWith(true);
    f.assistant.dispose();
  });

  it("draws the Assistant at the shell's zoom so the sidebars match", async () => {
    const f = fixture();
    f.layout("assistant");
    await flush();
    expect(f.view.webContents.setZoomFactor).not.toHaveBeenCalled();
    // Zooming the shell resizes its page, which reports a new layout.
    f.contents.zoom = 1.25;
    f.layout("assistant");
    expect(f.view.webContents.setZoomFactor).toHaveBeenLastCalledWith(1.25);
    // A new page in the view keeps the shell's zoom.
    f.view.webContents.zoom = 1;
    f.view.webContents.emit("did-finish-load");
    expect(f.view.webContents.getZoomFactor()).toBe(1.25);
    f.assistant.dispose();
  });

  it("lines the page up with the shell's title bar at fractional zoom", async () => {
    const f = fixture();
    f.contents.zoom = 1.1;
    const page = f.view.webContents;
    page.mainFrame.url = `${ORIGIN}/`;
    electron.ipc.emit("agentlink:remote:layout", f.sender, {
      mode: "assistant",
      bounds: { x: 0, y: 64, width: 900, height: 700 },
    });
    await flush();
    // 64px at 110% is 70.4: the view starts on 70, the page pads the rest.
    expect(f.view.setBounds).toHaveBeenLastCalledWith(
      expect.objectContaining({ y: 70, height: 730 }),
    );
    const chrome = page.send.mock.calls
      .filter(
        ([channel]: unknown[]) =>
          channel === "agentlink:assistant-embed:chrome",
      )
      .at(-1)?.[1];
    expect(chrome).toEqual({ sidebarOpen: true, offsetTop: 0.364 });

    // A whole-pixel edge needs no padding.
    f.contents.zoom = 1;
    f.layout("assistant");
    expect(page.send).toHaveBeenLastCalledWith(
      "agentlink:assistant-embed:chrome",
      { sidebarOpen: true },
    );
    f.assistant.dispose();
  });

  it("retries a background failure when the Assistant view opens", async () => {
    electron.assistantSession.cookies.get.mockResolvedValue([
      { name: "session" },
    ]);
    const f = fixture();
    f.view.webContents.loadURL.mockRejectedValueOnce(new Error("offline"));
    await flush();
    expect(f.lastState()).toMatchObject({
      status: "unavailable",
      error: "load",
    });
    f.layout("assistant");
    await flush();
    expect(f.view.webContents.loadURL).toHaveBeenCalledTimes(2);
    expect(f.lastState()).toMatchObject({ status: "ready" });
    f.assistant.dispose();
  });

  it("reloads with fresh connections when Settings change the address or CA", async () => {
    const f = fixture();
    f.layout("assistant");
    await flush();
    f.assistant.configure({ origin: ORIGIN });
    expect(
      electron.assistantSession.closeAllConnections,
    ).not.toHaveBeenCalled();
    f.assistant.configure({ origin: ORIGIN, ca: CA });
    await flush();
    expect(
      electron.assistantSession.closeAllConnections,
    ).toHaveBeenCalledOnce();
    f.assistant.configure({ origin: "https://framework16.local:8443", ca: CA });
    await flush();
    expect(f.view.webContents.loadURL).toHaveBeenLastCalledWith(
      "https://framework16.local:8443/",
    );
    expect(f.lastState()).toEqual({
      status: "ready",
      origin: "https://framework16.local:8443",
      pinned: true,
    });
    f.assistant.dispose();
  });
});
