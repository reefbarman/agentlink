import { describe, expect, it, vi } from "vitest";

import type { AgentSession } from "./AgentSession.js";
import {
  ChatTabController,
  type ChatTabActionAddress,
  type ChatTabWorkspaceState,
} from "./ChatTabController.js";
import { ChatTabHostCoordinator } from "./ChatTabHostCoordinator.js";
import type { SessionInfo } from "./types.js";

function createWorkspaceState(): ChatTabWorkspaceState {
  const stored = new Map<string, unknown>();
  return {
    get: <T>(key: string) => stored.get(key) as T | undefined,
    update: async (key, value) => {
      stored.set(key, structuredClone(value));
    },
  };
}

function session(id: string, hasQueuedUiMessages = false): AgentSession {
  return {
    id,
    mode: "code",
    title: `Session ${id}`,
    hasQueuedUiMessages,
    setQueuedUiMessageCount: vi.fn(),
  } as unknown as AgentSession;
}

function info(id: string, overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id,
    status: "idle",
    mode: "code",
    model: "model",
    title: `Session ${id}`,
    messageCount: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    background: false,
    createdAt: 1,
    lastActiveAt: 1,
    projectScope: {
      schemaVersion: 1,
      kind: "project",
      projectId: "project",
      workspaceFolderUri: "file:///workspace",
      displayName: "Workspace",
    },
    projectAvailability: "available",
    ...overrides,
  };
}

function createHarness() {
  const tabs = new ChatTabController(createWorkspaceState(), {
    createId: (() => {
      let index = 0;
      return () => `tab-${++index}`;
    })(),
    createControllerEpoch: () => "epoch-1",
  });
  const sessions = new Map<string, AgentSession>();
  let infos: SessionInfo[] = [];
  const manager = {
    getSession: vi.fn((id: string) => sessions.get(id)),
    getSessionInfos: vi.fn(() => infos),
    createSession: vi.fn(async () => {
      const created = session(`session-${sessions.size + 1}`);
      sessions.set(created.id, created);
      return created;
    }),
    hydratePersistedSession: vi.fn(
      async (id: string) => sessions.get(id) ?? null,
    ),
    loadPersistedSession: vi.fn(async (id: string) => sessions.get(id) ?? null),
    stopSessionAndWait: vi.fn(async () => []),
    switchTo: vi.fn(),
  };
  const coordinator = new ChatTabHostCoordinator(tabs, manager);
  const address = (): ChatTabActionAddress => {
    const snapshot = tabs.getWorkspaceSnapshot();
    const tab = tabs.getFocusedTab();
    return {
      controllerEpoch: snapshot.controllerEpoch,
      tabId: tab.id,
      sessionId: tab.sessionId,
    };
  };
  return {
    tabs,
    sessions,
    manager,
    coordinator,
    address,
    setInfos(next: SessionInfo[]) {
      infos = next;
    },
  };
}

describe("ChatTabHostCoordinator", () => {
  it("creates and focuses the new tab before creating its session", async () => {
    const harness = createHarness();
    const first = session("session-1");
    harness.sessions.set(first.id, first);
    await harness.tabs.bindFocusedSession(first.id);
    const initialAddress = harness.address();
    harness.manager.createSession.mockImplementationOnce(async () => {
      expect(harness.tabs.getLayout().tabs).toHaveLength(2);
      expect(harness.tabs.getFocusedTab()).toMatchObject({
        id: "tab-2",
        sessionId: null,
      });
      const created = session("session-2");
      harness.sessions.set(created.id, created);
      await harness.tabs.bindFocusedSession(created.id);
      return created;
    });

    const result = await harness.coordinator.newTab(initialAddress, "code");

    expect(result).toMatchObject({
      ok: true,
      tab: { id: "tab-2", displayNumber: 2, sessionId: "session-2" },
      session: { id: "session-2" },
    });
    expect(harness.tabs.getTab("tab-1")?.sessionId).toBe("session-1");
  });

  it("requires confirmation for a busy New Chat and preserves the stable tab", async () => {
    const harness = createHarness();
    const current = session("session-1");
    harness.sessions.set(current.id, current);
    harness.setInfos([
      info(current.id, {
        status: "streaming",
        interactiveExecutionPhase: "running",
      }),
    ]);
    await harness.tabs.bindFocusedSession(current.id);
    const currentAddress = harness.address();

    await expect(
      harness.coordinator.newChat(currentAddress, "code"),
    ).resolves.toMatchObject({
      ok: false,
      reason: "confirmation_required",
      action: "new_chat",
      tab: { id: "tab-1", displayNumber: 1, sessionId: "session-1" },
    });
    expect(harness.manager.stopSessionAndWait).not.toHaveBeenCalled();
    expect(harness.manager.createSession).not.toHaveBeenCalled();

    const result = await harness.coordinator.newChat(currentAddress, "code", {
      stopRunning: true,
    });

    expect(result).toMatchObject({
      ok: true,
      tab: {
        id: "tab-1",
        displayNumber: 1,
        sessionId: "session-2",
        terminalGeneration: 2,
      },
    });
    expect(harness.manager.stopSessionAndWait).toHaveBeenCalledWith(
      "session-1",
    );
  });

  it("replaces a browser-selected tab without changing VS Code focus", async () => {
    const harness = createHarness();
    const current = session("session-1");
    harness.sessions.set(current.id, current);
    await harness.tabs.bindFocusedSession(current.id);
    const focusTab = vi.spyOn(harness.tabs, "focusTab");

    const result = await harness.coordinator.newChat(
      harness.address(),
      "code",
      { focus: false },
    );

    expect(result).toMatchObject({
      ok: true,
      tab: { id: "tab-1", sessionId: "session-2" },
      session: { id: "session-2" },
    });
    expect(focusTab).not.toHaveBeenCalled();
    expect(harness.manager.createSession).toHaveBeenCalledWith("code", {
      projectId: undefined,
      foreground: false,
    });
    expect(harness.manager.switchTo).not.toHaveBeenCalled();
  });

  it("switches to a surviving session before retiring a focused tab", async () => {
    const harness = createHarness();
    const first = session("session-1");
    const second = session("session-2");
    harness.sessions.set(first.id, first);
    harness.sessions.set(second.id, second);
    await harness.tabs.bindFocusedSession(first.id);
    await harness.tabs.createTab(second.id);
    await harness.tabs.focusTab("tab-1");
    const order: string[] = [];
    harness.manager.switchTo.mockImplementation((id: string) => {
      order.push(`switch:${id}`);
    });
    harness.tabs.onWillRetireTerminalGeneration((tab) => {
      order.push(`retire:${tab.sessionId}`);
    });

    const result = await harness.coordinator.close(harness.address());

    expect(result).toMatchObject({ ok: true, tab: { id: "tab-1" } });
    expect(order).toEqual(["switch:session-2", "retire:session-1"]);
    expect(harness.tabs.getFocusedTab()).toMatchObject({
      id: "tab-2",
      sessionId: "session-2",
    });
  });

  it("focuses an already-open history session instead of duplicating it", async () => {
    const harness = createHarness();
    const first = session("session-1");
    const second = session("session-2");
    harness.sessions.set(first.id, first);
    harness.sessions.set(second.id, second);
    await harness.tabs.bindFocusedSession(first.id);
    await harness.tabs.createTab(second.id);
    await harness.tabs.focusTab("tab-1");

    const result = await harness.coordinator.loadSession(
      harness.address(),
      second.id,
    );

    expect(result).toMatchObject({
      ok: true,
      tab: { id: "tab-2", sessionId: "session-2" },
    });
    expect(harness.tabs.getLayout().tabs).toHaveLength(2);
    expect(harness.manager.loadPersistedSession).not.toHaveBeenCalled();
    expect(harness.manager.switchTo).toHaveBeenCalledWith("session-2");
  });

  it("hydrates browser-selected history without changing VS Code focus", async () => {
    const harness = createHarness();
    const current = session("session-1");
    const target = session("session-2");
    harness.sessions.set(current.id, current);
    await harness.tabs.bindFocusedSession(current.id);
    harness.manager.hydratePersistedSession.mockImplementationOnce(async () => {
      harness.sessions.set(target.id, target);
      return target;
    });
    const focusTab = vi.spyOn(harness.tabs, "focusTab");

    const result = await harness.coordinator.loadSession(
      harness.address(),
      target.id,
      { focus: false },
    );

    expect(result).toMatchObject({
      ok: true,
      tab: { id: "tab-1", sessionId: target.id },
      session: { id: target.id },
    });
    expect(harness.manager.hydratePersistedSession).toHaveBeenCalledWith(
      target.id,
    );
    expect(harness.manager.loadPersistedSession).not.toHaveBeenCalled();
    expect(focusTab).not.toHaveBeenCalled();
    expect(harness.manager.switchTo).not.toHaveBeenCalled();
  });

  it("treats queued webview messages as busy before replacing history", async () => {
    const harness = createHarness();
    const current = session("session-1", true);
    const target = session("session-2");
    harness.sessions.set(current.id, current);
    harness.sessions.set(target.id, target);
    await harness.tabs.bindFocusedSession(current.id);

    await expect(
      harness.coordinator.loadSession(harness.address(), target.id),
    ).resolves.toMatchObject({
      ok: false,
      reason: "confirmation_required",
      action: "load_session",
      targetSessionId: "session-2",
    });
  });

  it("rejects stale addresses and invalid reorder sets without mutation", async () => {
    const harness = createHarness();
    const stale = { ...harness.address(), controllerEpoch: "stale" };

    await expect(harness.coordinator.focus(stale)).resolves.toEqual({
      ok: false,
      reason: "stale_controller",
    });
    await expect(
      harness.coordinator.reorder(harness.address(), []),
    ).resolves.toEqual({ ok: false, reason: "invalid_order" });
    expect(harness.tabs.getLayout().tabs.map((tab) => tab.id)).toEqual([
      "tab-1",
    ]);
  });
});
