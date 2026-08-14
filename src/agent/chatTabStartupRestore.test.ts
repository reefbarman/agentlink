import { describe, expect, it, vi } from "vitest";

import {
  CHAT_TAB_LAYOUT_VERSION,
  type ChatTab,
  type ChatTabLayout,
} from "./ChatTabController.js";
import {
  restoreChatTabStartup,
  type ChatTabStartupRestoreHost,
} from "./chatTabStartupRestore.js";

interface FakeHostOptions {
  tabs: ChatTab[];
  focusedTabId: string;
  persistedSessionIds?: string[];
  initialForegroundId?: string;
  foregroundDuringHydration?: {
    sessionId: string;
    foregroundId: string;
  };
  legacyRestoredSessionId?: string;
}

function tab(
  id: string,
  sessionId: string | null,
  placement: ChatTab["placement"] = "docked",
): ChatTab {
  return {
    id,
    displayNumber: Number(id.replace(/\D/g, "")) || 1,
    sessionId,
    placement,
    terminalGeneration: 1,
  };
}

function createFakeHost(options: FakeHostOptions) {
  const layout: ChatTabLayout = {
    version: CHAT_TAB_LAYOUT_VERSION,
    tabs: structuredClone(options.tabs),
    nextDisplayNumber: options.tabs.length + 1,
  };
  const persistedSessionIds = new Set(options.persistedSessionIds ?? []);
  const sessions = new Map<string, { id: string }>();
  let focusedTabId = options.focusedTabId;
  let foreground = options.initialForegroundId
    ? { id: options.initialForegroundId }
    : undefined;

  const hydratePersistedSession = vi.fn(async (sessionId: string) => {
    if (options.foregroundDuringHydration?.sessionId === sessionId) {
      foreground = { id: options.foregroundDuringHydration.foregroundId };
    }
    if (!persistedSessionIds.has(sessionId)) return null;
    const session = { id: sessionId };
    sessions.set(sessionId, session);
    return session;
  });
  const restoreLastSession = vi.fn(async () => {
    if (!options.legacyRestoredSessionId) return null;
    const session = { id: options.legacyRestoredSessionId };
    sessions.set(session.id, session);
    foreground = session;
    return session;
  });
  const restorePersistedBackgroundSessions = vi.fn(
    async (_rootSessionIds: ReadonlySet<string>) => undefined,
  );
  const switchTo = vi.fn((sessionId: string) => {
    foreground = sessions.get(sessionId) ?? { id: sessionId };
  });
  const createTab = vi.fn(async (sessionId: string) => {
    const created = tab(`tab-${layout.tabs.length + 1}`, sessionId);
    layout.tabs.push(created);
    focusedTabId = created.id;
    return structuredClone(created);
  });
  const focusTab = vi.fn(async (tabId: string) => {
    const candidate = layout.tabs.find((item) => item.id === tabId);
    if (!candidate || candidate.placement !== "docked") return false;
    focusedTabId = tabId;
    return true;
  });
  const setPlacement = vi.fn(
    async (
      tabId: string,
      expectedPlacement: ChatTab["placement"],
      placement: ChatTab["placement"],
    ) => {
      const candidate = layout.tabs.find((item) => item.id === tabId);
      if (candidate?.placement === expectedPlacement) {
        candidate.placement = placement;
      }
    },
  );
  const replaceSession = vi.fn(
    async (
      tabId: string,
      expectedSessionId: string | null,
      sessionId: string | null,
    ) => {
      const candidate = layout.tabs.find((item) => item.id === tabId);
      if (candidate?.sessionId === expectedSessionId) {
        candidate.sessionId = sessionId;
      }
    },
  );

  const host: ChatTabStartupRestoreHost = {
    getLayout: () => structuredClone(layout),
    getFocusedTab: () => {
      const focused = layout.tabs.find(
        (candidate) => candidate.id === focusedTabId,
      );
      if (!focused) throw new Error(`Missing focused tab: ${focusedTabId}`);
      return structuredClone(focused);
    },
    getForegroundSession: () => foreground,
    getSession: (sessionId) => sessions.get(sessionId),
    getTabForSession: (sessionId) =>
      layout.tabs.find((candidate) => candidate.sessionId === sessionId),
    hydratePersistedSession,
    restoreLastSession,
    restorePersistedBackgroundSessions,
    switchTo,
    createTab,
    focusTab,
    setPlacement,
    replaceSession,
  };

  return {
    host,
    hydratePersistedSession,
    restoreLastSession,
    restorePersistedBackgroundSessions,
    switchTo,
    createTab,
    focusTab,
    setPlacement,
    replaceSession,
  };
}

describe("restoreChatTabStartup", () => {
  it("hydrates persisted bindings and promotes the valid focused tab", async () => {
    const fake = createFakeHost({
      tabs: [
        tab("tab-1", "session-focused"),
        tab("tab-2", "session-popped", "popped"),
      ],
      focusedTabId: "tab-1",
      persistedSessionIds: ["session-focused", "session-popped"],
    });

    await expect(restoreChatTabStartup(fake.host)).resolves.toEqual({
      superseded: false,
      hadRestorableSession: true,
    });

    expect(fake.hydratePersistedSession).toHaveBeenCalledTimes(2);
    expect(fake.restorePersistedBackgroundSessions).toHaveBeenCalledWith(
      new Set(["session-focused", "session-popped"]),
    );
    expect(fake.switchTo).toHaveBeenCalledOnce();
    expect(fake.switchTo).toHaveBeenCalledWith("session-focused");
    expect(fake.restoreLastSession).not.toHaveBeenCalled();
  });

  it("hydrates a tab's current binding when it was rebound during an earlier hydration", async () => {
    const fake = createFakeHost({
      tabs: [tab("tab-1", "big-1"), tab("tab-2", "old-2")],
      focusedTabId: "tab-1",
      persistedSessionIds: ["big-1", "new-2"],
    });
    const original = fake.hydratePersistedSession.getMockImplementation()!;
    fake.hydratePersistedSession.mockImplementation(
      async (sessionId: string) => {
        if (sessionId === "big-1") {
          // While the first tab's (slow) transcript hydration runs, the user
          // starts a new chat in tab-2, replacing its session.
          await fake.host.replaceSession("tab-2", "old-2", "new-2");
        }
        return original(sessionId);
      },
    );

    const result = await restoreChatTabStartup(fake.host);

    expect(result.hadRestorableSession).toBe(true);
    // The superseded session is never resurrected; the tab's current binding
    // is hydrated instead.
    expect(
      fake.hydratePersistedSession.mock.calls.map(([sessionId]) => sessionId),
    ).toEqual(["big-1", "new-2"]);
  });

  it("repairs invalid bindings and promotes a valid docked fallback", async () => {
    const fake = createFakeHost({
      tabs: [
        tab("tab-1", "missing-focused"),
        tab("tab-2", "missing-popped", "popped"),
        tab("tab-3", "session-fallback"),
      ],
      focusedTabId: "tab-1",
      persistedSessionIds: ["session-fallback"],
    });

    await expect(restoreChatTabStartup(fake.host)).resolves.toEqual({
      superseded: false,
      hadRestorableSession: true,
    });

    expect(fake.replaceSession).toHaveBeenCalledWith(
      "tab-1",
      "missing-focused",
      null,
    );
    expect(fake.setPlacement).toHaveBeenCalledWith("tab-2", "popped", "docked");
    expect(fake.replaceSession).toHaveBeenCalledWith(
      "tab-2",
      "missing-popped",
      null,
    );
    expect(fake.focusTab).toHaveBeenCalledWith("tab-3");
    expect(fake.switchTo).toHaveBeenCalledWith("session-fallback");
    expect(fake.restorePersistedBackgroundSessions).toHaveBeenCalledWith(
      new Set(["session-fallback"]),
    );
  });

  it("binds a session restored by the legacy last-session fallback", async () => {
    const fake = createFakeHost({
      tabs: [tab("tab-1", null)],
      focusedTabId: "tab-1",
      legacyRestoredSessionId: "session-legacy",
    });

    await expect(restoreChatTabStartup(fake.host)).resolves.toEqual({
      superseded: false,
      hadRestorableSession: true,
    });

    expect(fake.restoreLastSession).toHaveBeenCalledOnce();
    expect(fake.createTab).toHaveBeenCalledOnce();
    expect(fake.createTab).toHaveBeenCalledWith("session-legacy");
    expect(fake.switchTo).not.toHaveBeenCalled();
  });

  it("preserves and binds a foreground session that appears during hydration", async () => {
    const fake = createFakeHost({
      tabs: [tab("tab-1", "session-persisted")],
      focusedTabId: "tab-1",
      persistedSessionIds: ["session-persisted"],
      foregroundDuringHydration: {
        sessionId: "session-persisted",
        foregroundId: "session-new-foreground",
      },
    });

    await expect(restoreChatTabStartup(fake.host)).resolves.toEqual({
      superseded: true,
      hadRestorableSession: true,
    });

    expect(fake.createTab).toHaveBeenCalledOnce();
    expect(fake.createTab).toHaveBeenCalledWith("session-new-foreground");
    expect(fake.switchTo).not.toHaveBeenCalled();
    expect(fake.focusTab).not.toHaveBeenCalled();
    expect(fake.restoreLastSession).not.toHaveBeenCalled();
  });

  it("reports no restorable session when tabs and legacy state are empty", async () => {
    const fake = createFakeHost({
      tabs: [tab("tab-1", null)],
      focusedTabId: "tab-1",
    });

    await expect(restoreChatTabStartup(fake.host)).resolves.toEqual({
      superseded: false,
      hadRestorableSession: false,
    });

    expect(fake.hydratePersistedSession).not.toHaveBeenCalled();
    expect(fake.restorePersistedBackgroundSessions).toHaveBeenCalledWith(
      new Set(),
    );
    expect(fake.restoreLastSession).toHaveBeenCalledOnce();
    expect(fake.createTab).not.toHaveBeenCalled();
    expect(fake.switchTo).not.toHaveBeenCalled();
  });
});
