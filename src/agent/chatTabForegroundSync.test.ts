import { describe, expect, it, vi } from "vitest";

import {
  ChatTabController,
  type ChatTabWorkspaceState,
} from "./ChatTabController.js";
import { createForegroundChatTabSync } from "./chatTabForegroundSync.js";

function createWorkspaceState(): ChatTabWorkspaceState {
  const stored = new Map<string, unknown>();
  return {
    get: <T>(key: string) => stored.get(key) as T | undefined,
    update: async (key, value) => {
      stored.set(key, structuredClone(value));
    },
  };
}

describe("createForegroundChatTabSync", () => {
  it("coalesces notifications that arrive while a bind is in flight", async () => {
    const resolvers: Array<() => void> = [];
    const bindFocusedSession = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const sync = createForegroundChatTabSync({
      getForegroundSessionId: () => "session-1",
      bindFocusedSession,
    });

    const first = sync();
    const second = sync();
    expect(second).toBe(first);
    expect(bindFocusedSession).toHaveBeenCalledTimes(1);

    // The notification that arrived mid-bind is absorbed by one re-check.
    resolvers[0]!();
    await vi.waitFor(() => expect(bindFocusedSession).toHaveBeenCalledTimes(2));
    resolvers[1]!();
    await first;

    const third = sync();
    expect(bindFocusedSession).toHaveBeenCalledTimes(3);
    resolvers[2]!();
    await third;
  });

  it("recovers after a bind failure", async () => {
    const bindFocusedSession = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue(undefined);
    const sync = createForegroundChatTabSync({
      getForegroundSessionId: () => "session-1",
      bindFocusedSession,
    });

    await expect(sync()).rejects.toThrow("boom");
    await expect(sync()).resolves.toBeUndefined();
    expect(bindFocusedSession).toHaveBeenCalledTimes(2);
  });

  it("skips binding while no foreground session exists", async () => {
    const bindFocusedSession = vi.fn();
    const sync = createForegroundChatTabSync({
      getForegroundSessionId: () => undefined,
      bindFocusedSession,
    });

    await sync();
    expect(bindFocusedSession).not.toHaveBeenCalled();
  });

  // Regression: v1.17.71 froze the extension host when a fresh foreground
  // session replaced a restored tab binding. Retiring the old binding stopped
  // its session, which fired sessions-changed and re-entered the sync while
  // the tab layout was still stale, recursing without bound. This replays the
  // production seam: controller retirement -> session stop -> sessions-changed
  // -> sync re-entry.
  it("survives restored-tab replacement when retirement stops sessions and re-fires sync", async () => {
    const controller = new ChatTabController(createWorkspaceState(), {
      createId: () => "tab-1",
    });
    await controller.bindFocusedSession("session-restored");

    let foregroundSessionId = "session-fresh";
    const sessionsChangedListeners: Array<() => void> = [];
    const notifySessionsChanged = () => {
      for (const listener of sessionsChangedListeners) listener();
    };
    const stopSessionAndWait = vi.fn(async (_sessionId: string) => {
      // stopSingleSession notifies synchronously before its first await.
      notifySessionsChanged();
    });
    controller.onWillRetireTerminalGeneration(async (tab) => {
      if (tab.sessionId) await stopSessionAndWait(tab.sessionId);
    });
    const sync = createForegroundChatTabSync({
      getForegroundSessionId: () => foregroundSessionId,
      bindFocusedSession: (sessionId) =>
        controller.bindFocusedSession(sessionId),
    });
    sessionsChangedListeners.push(() => void sync().catch(() => undefined));

    // The incident entry point: createSession set the new foreground and
    // notified, which ran the sync.
    notifySessionsChanged();
    await sync();

    expect(controller.getFocusedTab()).toMatchObject({
      sessionId: "session-fresh",
      terminalGeneration: 2,
    });
    expect(stopSessionAndWait).toHaveBeenCalledTimes(1);
    expect(stopSessionAndWait).toHaveBeenCalledWith("session-restored");

    // A later foreground change binds again without retiring the fresh
    // session twice.
    foregroundSessionId = "session-later";
    notifySessionsChanged();
    await sync();
    expect(controller.getFocusedTab().sessionId).toBe("session-later");
  });
});
