import { afterEach, expect, it, vi } from "vitest";

import type { DesktopWorkspaceBridge } from "../../../src/shared/desktopBridge.js";

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

it("exposes only tab publication, hosting and actions to the workspace main frame", async () => {
  vi.stubGlobal("process", { ...process, isMainFrame: true });
  await import("./workspacePreload.js");
  expect(electron.expose).toHaveBeenCalledWith(
    "agentlinkDesktopWorkspace",
    expect.any(Object),
  );
  const bridge = electron.expose.mock.calls[0][1] as DesktopWorkspaceBridge;
  expect(Object.keys(bridge).sort()).toEqual([
    "onAction",
    "onHosted",
    "publishTabs",
  ]);
  bridge.publishTabs([]);
  expect(electron.send).toHaveBeenCalledWith("agentlink:remote:tabs", []);
  const hosted = vi.fn();
  const stopHosted = bridge.onHosted(hosted);
  const action = vi.fn();
  const stopAction = bridge.onAction(action);
  const handler = (channel: string) =>
    electron.on.mock.calls.find(([name]) => name === channel)![1];
  handler("agentlink:remote:tabs-hosted")({ secret: "not-forwarded" });
  expect(hosted).toHaveBeenCalledExactlyOnceWith();
  const selection = {
    action: "select",
    instanceId: "window-two",
    tabId: "tab-three",
  };
  handler("agentlink:remote:tab-action")(
    { secret: "not-forwarded" },
    selection,
  );
  handler("agentlink:remote:tab-action")({}, { action: "shell" });
  expect(action).toHaveBeenCalledExactlyOnceWith(selection);
  stopHosted();
  stopAction();
  expect(electron.removeListener).toHaveBeenCalledTimes(2);
});

it("does not expose a bridge to subframes", async () => {
  vi.stubGlobal("process", { ...process, isMainFrame: false });
  await import("./workspacePreload.js");
  expect(electron.expose).not.toHaveBeenCalled();
});
