import {
  DesktopRemoteView,
  clampDesktopRemoteBounds,
} from "./DesktopRemoteView.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BrowserWindow } from "electron";
import { EventEmitter } from "node:events";

const electron = vi.hoisted(() => ({
  views: [] as any[],
  ipc: null as any,
  remoteSession: null as any,
}));
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  electron.ipc = new EventEmitter();
  electron.remoteSession = Object.assign(new EventEmitter(), {
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    setDevicePermissionHandler: vi.fn(),
  });
  return {
    ipcMain: electron.ipc,
    session: { fromPartition: vi.fn(() => electron.remoteSession) },
    WebContentsView: class {
      webContents = Object.assign(new EventEmitter(), {
        loadURL: vi.fn(async () => undefined),
        stop: vi.fn(),
        close: vi.fn(),
        isDestroyed: () => false,
        setWindowOpenHandler: vi.fn(),
      });
      setVisible = vi.fn();
      setBounds = vi.fn();
      constructor(public options: unknown) {
        electron.views.push(this);
      }
    },
  };
});

const target = {
  url: "http://127.0.0.1:47137/?desktopWorkspace=1",
  generation: "one",
};
function fixture() {
  const contents = Object.assign(new EventEmitter(), {
    mainFrame: { url: "http://127.0.0.1:47138/?surface=desktop" },
    send: vi.fn(),
    isDestroyed: () => false,
    getZoomFactor: () => 1.5,
  });
  const window = Object.assign(new EventEmitter(), {
    webContents: contents,
    isDestroyed: (): boolean => false,
    getContentSize: () => [1200, 800],
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
  });
  const discover = vi.fn(async () => target as typeof target | null);
  const remote = new DesktopRemoteView(
    window as unknown as BrowserWindow,
    "http://127.0.0.1:47138",
    discover,
  );
  const sender = { sender: contents, senderFrame: contents.mainFrame };
  const layout = (mode: "ask" | "vscode") =>
    electron.ipc.emit("agentlink:remote:layout", sender, {
      mode,
      bounds: { x: 100, y: 40, width: 900, height: 700 },
    });
  return {
    window,
    contents,
    discover,
    remote,
    sender,
    layout,
    view: electron.views.at(-1),
  };
}
async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe("native desktop remote composition", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    electron.views.length = 0;
  });
  afterEach(() => {
    electron.ipc.removeAllListeners();
    vi.useRealTimers();
  });

  it("cleans up after the native window is already destroyed", () => {
    const f = fixture();
    f.window.isDestroyed = () => true;
    Object.defineProperty(f.window, "webContents", {
      get: () => {
        throw new Error("Object has been destroyed");
      },
    });
    expect(() => f.window.emit("closed")).not.toThrow();
    expect(f.view.webContents.close).toHaveBeenCalledOnce();
    expect(() => f.remote.dispose()).not.toThrow();
  });

  it("composes an unprivileged view, reuses it across switches, and reloads retry/new generation only", async () => {
    const f = fixture();
    expect(f.view.options.webPreferences).toMatchObject({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      session: electron.remoteSession,
    });
    expect(f.view.options.webPreferences).not.toHaveProperty("preload");
    f.layout("vscode");
    await flush();
    expect(f.view.webContents.loadURL).toHaveBeenCalledExactlyOnceWith(
      target.url,
    );
    expect(f.view.setBounds).toHaveBeenLastCalledWith({
      x: 150,
      y: 60,
      width: 1050,
      height: 740,
    });
    expect(f.view.setVisible).toHaveBeenLastCalledWith(true);
    f.layout("ask");
    expect(f.view.setVisible).toHaveBeenLastCalledWith(false);
    f.layout("vscode");
    await flush();
    await vi.advanceTimersByTimeAsync(3000);
    expect(f.view.webContents.loadURL).toHaveBeenCalledTimes(1);
    electron.ipc.emit("agentlink:remote:retry", f.sender);
    await flush();
    expect(f.view.webContents.loadURL).toHaveBeenCalledTimes(2);
    f.discover.mockResolvedValue({ ...target, generation: "two" });
    await vi.advanceTimersByTimeAsync(3000);
    expect(f.view.webContents.loadURL).toHaveBeenCalledTimes(3);
    f.window.emit("closed");
    expect(f.view.webContents.close).toHaveBeenCalledOnce();
    expect(electron.ipc.listenerCount("agentlink:remote:layout")).toBe(0);
  });

  it("rejects foreign contents, child frames, wrong origins and malformed layouts on every channel", async () => {
    const f = fixture();
    const valid = {
      mode: "vscode",
      bounds: { x: 0, y: 0, width: 100, height: 100 },
    };
    for (const sender of [
      { sender: {}, senderFrame: f.contents.mainFrame },
      { sender: f.contents, senderFrame: { url: f.contents.mainFrame.url } },
      { sender: f.contents, senderFrame: null },
    ]) {
      electron.ipc.emit("agentlink:remote:layout", sender, valid);
      electron.ipc.emit("agentlink:remote:retry", sender);
    }
    f.contents.mainFrame.url = "https://evil.test/";
    electron.ipc.emit("agentlink:remote:layout", f.sender, valid);
    electron.ipc.emit("agentlink:remote:retry", f.sender);
    f.contents.mainFrame.url = "http://127.0.0.1:47138/";
    electron.ipc.emit("agentlink:remote:layout", f.sender, {
      ...valid,
      bounds: { ...valid.bounds, x: NaN },
    });
    await flush();
    expect(f.discover).not.toHaveBeenCalled();
    f.remote.dispose();
  });

  it("denies permissions, popups, redirects and unsafe navigation", async () => {
    const f = fixture();
    f.layout("vscode");
    await flush();
    expect(
      f.view.webContents.setWindowOpenHandler.mock.calls[0][0]({
        url: "https://example.com",
      }),
    ).toEqual({ action: "deny" });
    const permission = vi.fn();
    electron.remoteSession.setPermissionRequestHandler.mock.calls.at(-1)[0](
      null,
      "media",
      permission,
    );
    expect(permission).toHaveBeenCalledWith(false);
    expect(
      electron.remoteSession.setPermissionCheckHandler.mock.calls.at(-1)[0](),
    ).toBe(false);
    for (const eventName of ["will-redirect", "will-attach-webview"]) {
      const event = { preventDefault: vi.fn() };
      f.view.webContents.emit(eventName, event, target.url);
      expect(event.preventDefault).toHaveBeenCalled();
    }
    for (const url of [
      "https://example.com",
      "file:///tmp/a",
      "http://127.0.0.1:47138/",
      "http://127.0.0.1:47137/health",
    ]) {
      const event = { preventDefault: vi.fn() };
      f.view.webContents.emit("will-navigate", event, url);
      expect(event.preventDefault).toHaveBeenCalled();
    }
    const event = { preventDefault: vi.fn() };
    f.view.webContents.emit("will-navigate", event, target.url);
    expect(event.preventDefault).not.toHaveBeenCalled();
    f.remote.dispose();
  });

  it("falls back when unavailable and reconnects without reloading a live generation", async () => {
    const f = fixture();
    f.layout("vscode");
    await flush();
    f.discover.mockResolvedValue(null);
    await vi.advanceTimersByTimeAsync(3000);
    expect(f.view.setVisible).toHaveBeenLastCalledWith(false);
    expect(f.contents.send).toHaveBeenLastCalledWith("agentlink:remote:state", {
      status: "unavailable",
    });
    f.discover.mockResolvedValue(target);
    await vi.advanceTimersByTimeAsync(3000);
    expect(f.view.setVisible).toHaveBeenLastCalledWith(true);
    expect(f.view.webContents.loadURL).toHaveBeenCalledTimes(1);
    f.layout("ask");
    const calls = f.discover.mock.calls.length;
    await vi.advanceTimersByTimeAsync(9000);
    expect(f.discover).toHaveBeenCalledTimes(calls);
    f.remote.dispose();
  });

  it("keeps failed loads hidden until explicit retry or a new generation", async () => {
    const f = fixture();
    f.view.webContents.loadURL.mockRejectedValueOnce(new Error("failed"));
    f.layout("vscode");
    await flush();
    expect(f.view.setVisible).toHaveBeenLastCalledWith(false);
    await vi.advanceTimersByTimeAsync(3000);
    expect(f.view.webContents.loadURL).toHaveBeenCalledTimes(1);
    electron.ipc.emit("agentlink:remote:retry", f.sender);
    await flush();
    expect(f.view.setVisible).toHaveBeenLastCalledWith(true);
    f.remote.dispose();
  });

  it("clamps zoom-scaled rectangles to content bounds", () => {
    expect(
      clampDesktopRemoteBounds(
        { x: -20, y: -30, width: 2000, height: 1500 },
        [800, 600],
        2,
      ),
    ).toEqual({ x: 0, y: 0, width: 800, height: 600 });
    expect(
      clampDesktopRemoteBounds(
        { x: 900, y: 700, width: 20, height: 20 },
        [800, 600],
        1,
      ),
    ).toEqual({ x: 800, y: 600, width: 0, height: 0 });
  });
});
