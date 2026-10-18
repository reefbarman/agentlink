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
) {
  const contents = Object.assign(new EventEmitter(), {
    mainFrame: { url: "http://127.0.0.1:47138/?surface=desktop" },
    send: vi.fn(),
    isDestroyed: () => false,
    getZoomFactor: () => 1,
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
  const lastState = () => contents.send.mock.calls.at(-1)?.[1];
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
    const permission = vi.fn();
    electron.assistantSession.setPermissionRequestHandler.mock.calls.at(-1)[0](
      null,
      "notifications",
      permission,
    );
    expect(permission).toHaveBeenCalledWith(false);

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
