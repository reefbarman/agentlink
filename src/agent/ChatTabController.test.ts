import { describe, expect, it, vi } from "vitest";

import {
  CHAT_TAB_LAYOUT_WORKSPACE_KEY,
  CHAT_TAB_LAYOUT_VERSION,
  ChatTabController,
  type ChatTabLayout,
  type ChatTabWorkspaceState,
} from "./ChatTabController.js";

function createWorkspaceState(initial?: unknown): {
  state: ChatTabWorkspaceState;
  stored: Map<string, unknown>;
  update: ReturnType<typeof vi.fn>;
} {
  const stored = new Map<string, unknown>();
  if (initial !== undefined) stored.set(CHAT_TAB_LAYOUT_WORKSPACE_KEY, initial);
  const update = vi.fn(async (key: string, value: unknown) => {
    stored.set(key, structuredClone(value));
  });
  return {
    stored,
    update,
    state: {
      get: <T>(key: string) => stored.get(key) as T | undefined,
      update,
    },
  };
}

function createIds(...ids: string[]): () => string {
  const remaining = [...ids];
  return () => remaining.shift() ?? `tab-${Math.random()}`;
}

describe("ChatTabController", () => {
  it("creates and persists one docked T1 tab for an empty workspace", async () => {
    const workspace = createWorkspaceState();
    const controller = new ChatTabController(workspace.state, {
      createId: createIds("tab-1"),
    });

    expect(controller.getLayout()).toEqual({
      version: CHAT_TAB_LAYOUT_VERSION,
      tabs: [
        {
          id: "tab-1",
          displayNumber: 1,
          sessionId: null,
          placement: "docked",
          terminalGeneration: 1,
        },
      ],
      nextDisplayNumber: 2,
    });
    expect(controller.getFocusedTabId()).toBe("tab-1");

    await controller.initialize();

    expect(workspace.update).toHaveBeenCalledWith(
      CHAT_TAB_LAYOUT_WORKSPACE_KEY,
      controller.getLayout(),
    );
  });

  it("restores valid layout order and focuses the first docked tab", async () => {
    const initial: ChatTabLayout = {
      version: CHAT_TAB_LAYOUT_VERSION,
      tabs: [
        {
          id: "popped",
          displayNumber: 4,
          sessionId: "session-4",
          placement: "popped",
          terminalGeneration: 2,
        },
        {
          id: "docked",
          displayNumber: 7,
          sessionId: "session-7",
          placement: "docked",
          terminalGeneration: 1,
        },
      ],
      nextDisplayNumber: 8,
    };
    const workspace = createWorkspaceState(initial);
    const controller = new ChatTabController(workspace.state);

    expect(controller.getLayout()).toEqual(initial);
    expect(controller.getFocusedTabId()).toBe("docked");

    await controller.initialize();
    expect(workspace.update).not.toHaveBeenCalled();
  });

  it("repairs corrupt tabs, duplicate sessions, labels, and missing docked placement", async () => {
    const workspace = createWorkspaceState({
      version: CHAT_TAB_LAYOUT_VERSION,
      tabs: [
        {
          id: "tab-a",
          displayNumber: 2,
          sessionId: "session-a",
          placement: "popped",
          terminalGeneration: 0,
        },
        {
          id: "tab-b",
          displayNumber: 2,
          sessionId: "session-a",
          placement: "bad",
          terminalGeneration: 3,
        },
        { id: "tab-b", displayNumber: 9 },
        null,
      ],
      nextDisplayNumber: 1,
    });
    const controller = new ChatTabController(workspace.state);

    expect(controller.getLayout()).toEqual({
      version: CHAT_TAB_LAYOUT_VERSION,
      tabs: [
        {
          id: "tab-a",
          displayNumber: 2,
          sessionId: "session-a",
          placement: "popped",
          terminalGeneration: 1,
        },
        {
          id: "tab-b",
          displayNumber: 3,
          sessionId: null,
          placement: "docked",
          terminalGeneration: 3,
        },
      ],
      nextDisplayNumber: 4,
    });

    await controller.initialize();
    await controller.initialize();
    expect(workspace.update).toHaveBeenCalledOnce();
  });

  it("binds the current foreground session to the implicit tab", async () => {
    const workspace = createWorkspaceState();
    const controller = new ChatTabController(workspace.state, {
      createId: createIds("tab-1"),
    });

    const tab = await controller.bindFocusedSession("session-1");

    expect(tab).toMatchObject({ id: "tab-1", sessionId: "session-1" });
    expect(controller.getTabForSession("session-1")?.id).toBe("tab-1");
  });

  it("creates stable monotonically numbered tabs without duplicating an open session", async () => {
    const workspace = createWorkspaceState();
    const controller = new ChatTabController(workspace.state, {
      createId: createIds("tab-1", "tab-2", "unused"),
    });
    await controller.bindFocusedSession("session-1");

    const second = await controller.createTab("session-2");
    const existing = await controller.createTab("session-1");

    expect(second).toMatchObject({
      id: "tab-2",
      displayNumber: 2,
      sessionId: "session-2",
    });
    expect(existing.id).toBe("tab-1");
    expect(controller.getLayout().tabs).toHaveLength(2);
    expect(controller.getFocusedTabId()).toBe("tab-1");
  });

  it("replaces a tab session with conflict guards and increments terminal generation", async () => {
    const workspace = createWorkspaceState();
    const controller = new ChatTabController(workspace.state, {
      createId: createIds("tab-1", "tab-2"),
    });
    await controller.bindFocusedSession("session-1");
    const second = await controller.createTab("session-2");
    const retired = vi.fn();
    controller.onWillRetireTerminalGeneration(retired);

    await expect(
      controller.replaceSession("tab-1", "stale", "session-3"),
    ).resolves.toEqual({ ok: false, reason: "conflict" });
    await expect(
      controller.replaceSession("tab-1", "session-1", "session-2"),
    ).resolves.toEqual({ ok: false, reason: "already_open" });
    expect(retired).not.toHaveBeenCalled();

    const replaced = await controller.replaceSession(
      "tab-1",
      "session-1",
      "session-3",
    );

    expect(replaced).toEqual({
      ok: true,
      tab: {
        id: "tab-1",
        displayNumber: 1,
        sessionId: "session-3",
        placement: "docked",
        terminalGeneration: 2,
      },
    });
    expect(controller.getTab(second.id)?.sessionId).toBe("session-2");
    expect(retired).toHaveBeenCalledTimes(1);
    expect(retired).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "tab-1",
        sessionId: "session-1",
        terminalGeneration: 1,
      }),
    );
  });

  it("reorders tabs only when the exact tab set is supplied", async () => {
    const workspace = createWorkspaceState();
    const controller = new ChatTabController(workspace.state, {
      createId: createIds("tab-1", "tab-2", "tab-3"),
    });
    await controller.createTab();
    await controller.createTab();

    await expect(
      controller.reorderTabs(["tab-3", "tab-1", "tab-2"]),
    ).resolves.toBe(true);
    expect(controller.getLayout().tabs.map((tab) => tab.id)).toEqual([
      "tab-3",
      "tab-1",
      "tab-2",
    ]);
    await expect(controller.reorderTabs(["tab-1", "tab-2"])).resolves.toBe(
      false,
    );
  });

  it("requires one docked tab and moves focus when the focused tab is popped", async () => {
    const workspace = createWorkspaceState();
    const controller = new ChatTabController(workspace.state, {
      createId: createIds("tab-1", "tab-2"),
    });

    await expect(controller.setPlacement("tab-1", "popped")).resolves.toBe(
      false,
    );
    const second = await controller.createTab();
    await expect(controller.setPlacement(second.id, "popped")).resolves.toBe(
      true,
    );
    expect(controller.getFocusedTabId()).toBe("tab-1");
    expect(controller.getTab(second.id)?.placement).toBe("popped");
  });

  it("closes only when another docked tab remains", async () => {
    const workspace = createWorkspaceState();
    const controller = new ChatTabController(workspace.state, {
      createId: createIds("tab-1", "tab-2", "tab-3"),
    });

    await expect(controller.closeTab("tab-1")).resolves.toBe(false);
    const second = await controller.createTab();
    const third = await controller.createTab();
    await controller.setPlacement(second.id, "popped");
    const retired = vi.fn();
    controller.onWillRetireTerminalGeneration(retired);

    await expect(controller.closeTab(third.id)).resolves.toBe(true);
    expect(controller.getFocusedTabId()).toBe("tab-1");
    expect(retired).toHaveBeenCalledTimes(1);
    expect(retired).toHaveBeenCalledWith(
      expect.objectContaining({ id: third.id, terminalGeneration: 1 }),
    );
    await expect(controller.closeTab("tab-1")).resolves.toBe(false);
    expect(retired).toHaveBeenCalledTimes(1);
  });

  it("publishes cloned snapshots after serialized persistence", async () => {
    const workspace = createWorkspaceState();
    const controller = new ChatTabController(workspace.state, {
      createId: createIds("tab-1", "tab-2"),
    });
    const snapshots: ChatTabLayout[] = [];
    controller.onDidChange((layout) => snapshots.push(layout));

    await controller.createTab("session-2");
    snapshots[0]!.tabs[0]!.sessionId = "mutated-listener-copy";

    expect(controller.getLayout().tabs[0]?.sessionId).toBeNull();
    expect(workspace.update).toHaveBeenCalledOnce();
  });
});
