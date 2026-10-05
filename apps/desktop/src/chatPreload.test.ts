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
  invoke: vi.fn(),
}));
vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: electron.expose },
  ipcRenderer: {
    send: electron.send,
    on: electron.on,
    removeListener: electron.removeListener,
    invoke: electron.invoke,
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
    "checkForReleaseUpdate",
    "dismissQuickAsk",
    "dismissReleaseUpdate",
    "getReleaseUpdateState",
    "onAskAgentOwnerIdChanged",
    "onMcpManagerOpen",
    "onQuickAskShown",
    "onQuickAskSubmission",
    "onReleaseUpdateState",
    "onRemoteState",
    "openMcpConfig",
    "openMcpManager",
    "openSettings",
    "retryRemote",
    "setMcpOperation",
    "setRemoteLayout",
    "submitQuickAsk",
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

it("routes native release-update controls through the narrow IPC bridge", async () => {
  vi.stubGlobal("process", { ...process, isMainFrame: true });
  await import("./chatPreload.js");
  const bridge = electron.expose.mock.calls[0][1] as DesktopBridge;
  const state = {
    identity: {
      product: "desktop" as const,
      version: "0.3.0",
      target: "darwin-arm64",
      development: true,
    },
    status: "available" as const,
    automaticChecks: false,
    lastAttemptAt: null,
    checkedAt: null,
    retryAt: null,
    candidate: null,
    dismissedVersion: null,
    stale: false,
  };
  electron.invoke.mockResolvedValue(state);
  await expect(bridge.getReleaseUpdateState!()).resolves.toEqual(state);
  await expect(bridge.checkForReleaseUpdate!()).resolves.toEqual(state);
  await expect(bridge.dismissReleaseUpdate!()).resolves.toEqual(state);
  expect(electron.invoke.mock.calls).toEqual([
    ["agentlink:release-update:get"],
    ["agentlink:release-update:check"],
    ["agentlink:release-update:dismiss"],
  ]);

  const listener = vi.fn();
  const unsubscribe = bridge.onReleaseUpdateState!(listener);
  const handler = electron.on.mock.calls.find(
    ([channel]) => channel === "agentlink:release-update:state",
  )?.[1];
  handler?.({ sender: "privileged" }, state);
  expect(listener).toHaveBeenCalledExactlyOnceWith(state);
  unsubscribe();
  expect(electron.removeListener).toHaveBeenCalledWith(
    "agentlink:release-update:state",
    handler,
  );
});

it("drains queued quick-ask submissions on subscribe and when more arrive", async () => {
  vi.stubGlobal("process", { ...process, isMainFrame: true });
  const first = { text: "queued before subscribe" };
  const second = { text: "arrived later" };
  electron.invoke
    .mockResolvedValueOnce([first])
    .mockResolvedValueOnce([second]);
  await import("./chatPreload.js");
  const bridge = electron.expose.mock.calls[0][1] as DesktopBridge;

  const listener = vi.fn();
  const unsubscribe = bridge.onQuickAskSubmission!(listener);
  await vi.waitFor(() => expect(listener).toHaveBeenCalledWith(first));
  const available = electron.on.mock.calls.find(
    ([channel]) => channel === "agentlink:quick-ask:available",
  )?.[1];
  available?.({ sender: "privileged" });
  await vi.waitFor(() => expect(listener).toHaveBeenCalledWith(second));
  expect(electron.invoke).toHaveBeenCalledWith("agentlink:quick-ask:take");

  unsubscribe();
  expect(electron.removeListener).toHaveBeenCalledWith(
    "agentlink:quick-ask:available",
    available,
  );
  bridge.submitQuickAsk!({ text: "hello" });
  expect(electron.send).toHaveBeenCalledWith("agentlink:quick-ask:submit", {
    text: "hello",
  });
  bridge.dismissQuickAsk!();
  expect(electron.send).toHaveBeenCalledWith("agentlink:quick-ask:dismiss");
  bridge.openSettings!();
  expect(electron.send).toHaveBeenCalledWith("agentlink:open-settings");
  await bridge.openMcpConfig!("ask-agent-global");
  expect(electron.invoke).toHaveBeenCalledWith(
    "agentlink:mcp-manager:open-config",
    "ask-agent-global",
  );
  bridge.openMcpManager!({ view: "config", action: "refresh" });
  expect(electron.send).toHaveBeenCalledWith("agentlink:mcp-manager:open", {
    view: "config",
    action: "refresh",
  });
  const managerListener = vi.fn();
  const unsubscribeManager = bridge.onMcpManagerOpen!(managerListener);
  const managerHandler = electron.on.mock.calls.find(
    ([channel]) => channel === "agentlink:mcp-manager:open",
  )?.[1];
  managerHandler?.(
    { sender: "privileged" },
    { view: "status", action: "open" },
  );
  managerHandler?.({ sender: "privileged" }, { view: "other", action: "open" });
  expect(managerListener).toHaveBeenCalledExactlyOnceWith({
    view: "status",
    action: "open",
  });
  unsubscribeManager();
  bridge.setMcpOperation!("123e4567-e89b-42d3-a456-426614174000");
  expect(electron.send).toHaveBeenCalledWith(
    "agentlink:mcp-manager:operation",
    "123e4567-e89b-42d3-a456-426614174000",
  );
});

it("does not expose the bridge to subframes", async () => {
  vi.stubGlobal("process", { ...process, isMainFrame: false });
  await import("./chatPreload.js");
  expect(electron.expose).not.toHaveBeenCalled();
});
