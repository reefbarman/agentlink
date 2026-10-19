import { afterEach, expect, it, vi } from "vitest";

import type { DesktopEmbedBridge } from "../../../src/shared/desktopBridge.js";

const electron = vi.hoisted(() => ({
  expose: vi.fn(),
  send: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
}));
vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: electron.expose },
  ipcRenderer: {
    send: electron.send,
    on: electron.on,
    removeListener: electron.removeListener,
  },
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.resetModules();
});

it("gives the Assistant page only view navigation and the shell's sidebar", async () => {
  vi.stubGlobal("process", { ...process, isMainFrame: true });
  await import("./assistantPreload.js");
  expect(electron.expose).toHaveBeenCalledExactlyOnceWith(
    "agentlinkDesktopEmbed",
    expect.any(Object),
  );
  const bridge = electron.expose.mock.calls[0][1] as DesktopEmbedBridge;
  expect(Object.keys(bridge).sort()).toEqual(["onChrome", "ready", "showView"]);

  bridge.ready();
  expect(electron.send).toHaveBeenLastCalledWith(
    "agentlink:assistant-embed:ready",
  );
  bridge.showView("vscode");
  bridge.showView("settings" as never);
  expect(electron.send).toHaveBeenLastCalledWith(
    "agentlink:assistant-embed:show-view",
    "vscode",
  );
  expect(electron.send).toHaveBeenCalledTimes(2);

  const listener = vi.fn();
  const stop = bridge.onChrome(listener);
  const handler = electron.on.mock.calls.find(
    ([channel]) => channel === "agentlink:assistant-embed:chrome",
  )?.[1];
  handler({ sender: "privileged" }, { sidebarOpen: true, sidebarWidth: 300 });
  handler({}, { sidebarOpen: "yes", sidebarWidth: Number.NaN, extra: 1 });
  expect(listener.mock.calls).toEqual([
    [{ sidebarOpen: true, sidebarWidth: 300 }],
    [{ sidebarOpen: false }],
  ]);
  stop();
  expect(electron.removeListener).toHaveBeenCalledWith(
    "agentlink:assistant-embed:chrome",
    handler,
  );
});

it("exposes nothing to subframes", async () => {
  vi.stubGlobal("process", { ...process, isMainFrame: false });
  await import("./assistantPreload.js");
  expect(electron.expose).not.toHaveBeenCalled();
});
