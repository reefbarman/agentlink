import { afterEach, expect, it, vi } from "vitest";

import {
  AGENTLINK_DESKTOP_OWNER_ARGUMENT_PREFIX,
  type DesktopBridge,
} from "../../../src/shared/desktopBridge.js";

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

it("exposes only the shell bridge and strips Electron events from state callbacks", async () => {
  vi.stubGlobal("process", {
    ...process,
    argv: [
      ...process.argv,
      `${AGENTLINK_DESKTOP_OWNER_ARGUMENT_PREFIX}agentlink-desktop~generation`,
    ],
    isMainFrame: true,
  });
  await import("./chatPreload.js");
  expect(electron.expose).toHaveBeenCalledWith(
    "agentlinkDesktopShell",
    expect.any(Object),
  );
  const bridge = electron.expose.mock.calls[0][1] as DesktopBridge;
  expect(Object.keys(bridge).sort()).toEqual([
    "askAgentOwnerId",
    "onAskAgentOwnerIdChanged",
    "onRemoteState",
    "retryRemote",
    "setRemoteLayout",
  ]);
  expect(bridge.askAgentOwnerId).toBe("agentlink-desktop~generation");
  const ownerListener = vi.fn();
  const unsubscribeOwner = bridge.onAskAgentOwnerIdChanged(ownerListener);
  const ownerHandler = electron.on.mock.calls.find(
    ([channel]) => channel === "agentlink:ask-agent-owner-id",
  )?.[1];
  ownerHandler?.({ sender: "privileged" }, " agentlink-desktop~updated ");
  ownerHandler?.({ sender: "privileged" }, { secret: "not-forwarded" });
  expect(ownerListener).toHaveBeenCalledExactlyOnceWith(
    "agentlink-desktop~updated",
  );
  unsubscribeOwner();
  expect(electron.removeListener).toHaveBeenCalledWith(
    "agentlink:ask-agent-owner-id",
    ownerHandler,
  );
  const layout = {
    mode: "ask" as const,
    bounds: { x: 1, y: 2, width: 3, height: 4 },
  };
  bridge.setRemoteLayout(layout);
  expect(electron.send).toHaveBeenCalledWith("agentlink:remote:layout", layout);
  bridge.retryRemote();
  expect(electron.send).toHaveBeenCalledWith("agentlink:remote:retry");
  const listener = vi.fn();
  const unsubscribe = bridge.onRemoteState(listener);
  const handler = electron.on.mock.calls.find(
    ([channel]) => channel === "agentlink:remote:state",
  )?.[1];
  handler(
    { sender: "privileged" },
    { status: "ready", secret: "not-forwarded" },
  );
  expect(listener).toHaveBeenCalledExactlyOnceWith({ status: "ready" });
  unsubscribe();
  expect(electron.removeListener).toHaveBeenCalledWith(
    "agentlink:remote:state",
    handler,
  );
});

it("does not expose the bridge to subframes", async () => {
  vi.stubGlobal("process", { ...process, isMainFrame: false });
  await import("./chatPreload.js");
  expect(electron.expose).not.toHaveBeenCalled();
});
