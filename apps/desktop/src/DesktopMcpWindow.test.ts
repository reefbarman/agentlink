/** @vitest-environment node */

import {
  DesktopMcpWindow,
  isDesktopMcpConfigScope,
  isDesktopMcpManagerOpenRequest,
  isDesktopMcpOperationId,
} from "./DesktopMcpWindow.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => {
  class MockContents {
    id = 41;
    isDestroyed = vi.fn(() => false);
    on = vi.fn();
    send = vi.fn();
    setWindowOpenHandler = vi.fn();
  }
  class MockBrowserWindow {
    static instances: MockBrowserWindow[] = [];
    webContents = new MockContents();
    options: Record<string, unknown>;
    handlers = new Map<string, (...args: unknown[]) => void>();
    loadURL = vi.fn(async (_url: string) => undefined);
    isDestroyed = vi.fn(() => false);
    isVisible = vi.fn(() => false);
    isMinimized = vi.fn(() => false);
    restore = vi.fn();
    show = vi.fn();
    focus = vi.fn();
    destroy = vi.fn();
    on = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      this.handlers.set(event, handler);
    });
    constructor(options: Record<string, unknown>) {
      this.options = options;
      MockBrowserWindow.instances.push(this);
    }
  }
  return {
    BrowserWindow: MockBrowserWindow,
    app: { dock: { show: vi.fn() }, focus: vi.fn() },
  };
});
vi.mock("electron", () => electron);

const discovery = {
  url: "http://127.0.0.1:47138",
  clientSharedSecret: "helper-secret",
} as never;

beforeEach(() => {
  electron.BrowserWindow.instances = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("DesktopMcpWindow", () => {
  it("validates narrow open actions and bounded random IDs", () => {
    expect(
      isDesktopMcpManagerOpenRequest({ view: "config", action: "refresh" }),
    ).toBe(true);
    expect(
      isDesktopMcpManagerOpenRequest({
        view: "https://example.com",
        action: "open",
      }),
    ).toBe(false);
    expect(
      isDesktopMcpOperationId("123e4567-e89b-42d3-a456-426614174000"),
    ).toBe(true);
    expect(isDesktopMcpOperationId("x".repeat(500))).toBe(false);
    expect(isDesktopMcpConfigScope("global")).toBe(true);
    expect(isDesktopMcpConfigScope("ask-agent-global")).toBe(true);
    expect(isDesktopMcpConfigScope("project")).toBe(false);
    expect(isDesktopMcpConfigScope("/tmp/config.json")).toBe(false);
  });

  it("reuses and focuses one resizable, sandboxed window and relays later opens", async () => {
    const manager = new DesktopMcpWindow({
      getDiscovery: () => discovery,
      getPreloadPath: () => "/app/chat-preload.cjs",
      onVisibilityChange: vi.fn(),
      log: vi.fn(),
    });
    await manager.open({ view: "status", action: "open" });
    await manager.open({ view: "config", action: "refresh" });

    expect(electron.BrowserWindow.instances).toHaveLength(1);
    const window = electron.BrowserWindow.instances[0];
    expect(window.options).toMatchObject({
      width: 800,
      height: 620,
      minWidth: 600,
      minHeight: 460,
      resizable: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    expect(window.loadURL).toHaveBeenCalledWith(
      expect.stringContaining("mcpManager=1"),
    );
    expect(window.webContents.send).toHaveBeenCalledWith(
      "agentlink:mcp-manager:open",
      { view: "config", action: "refresh" },
    );
    expect(window.focus).toHaveBeenCalled();
  });

  it("trusts only the manager window webContents for native IPC", async () => {
    const manager = new DesktopMcpWindow({
      getDiscovery: () => discovery,
      getPreloadPath: () => "/app/chat-preload.cjs",
      onVisibilityChange: vi.fn(),
      log: vi.fn(),
    });
    await manager.open({ view: "status", action: "open" });
    const contents = electron.BrowserWindow.instances[0].webContents;

    expect(
      manager.ownsSender(contents as unknown as Electron.WebContents),
    ).toBe(true);
    expect(manager.ownsSender({ id: 42 } as Electron.WebContents)).toBe(false);
  });

  it("cancels its registered operation from native close and renderer crash", async () => {
    const manager = new DesktopMcpWindow({
      getDiscovery: () => discovery,
      getPreloadPath: () => "/app/chat-preload.cjs",
      onVisibilityChange: vi.fn(),
      log: vi.fn(),
    });
    await manager.open({ view: "status", action: "open" });
    const window = electron.BrowserWindow.instances[0];
    manager.setOperation("bad-id");
    window.handlers.get("closed")?.();
    expect(fetch).not.toHaveBeenCalled();

    await manager.open({ view: "status", action: "open" });
    const reopened = electron.BrowserWindow.instances[1];
    manager.setOperation("123e4567-e89b-42d3-a456-426614174000");
    const gone = reopened.webContents.on.mock.calls.find(
      ([event]) => event === "render-process-gone",
    )?.[1];
    gone?.();
    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:47138/internal/desktop/mcp-manager/cancel",
      expect.objectContaining({
        method: "POST",
        headers: {
          Authorization: "Bearer helper-secret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          operationId: "123e4567-e89b-42d3-a456-426614174000",
        }),
      }),
    );
  });
});
