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

  it("rebinds the focused tab before retiring so re-entrant syncs observe the new binding", async () => {
    const workspace = createWorkspaceState();
    const controller = new ChatTabController(workspace.state, {
      createId: createIds("tab-1"),
    });
    await controller.bindFocusedSession("session-restored");
    const layoutsSeenDuringRetirement: Array<string | null> = [];
    const retired = vi.fn(async () => {
      layoutsSeenDuringRetirement.push(controller.getFocusedTab().sessionId);
      // Production wiring stops the outgoing session here, which fires
      // sessions-changed and re-enters bindFocusedSession on the same stack.
      await controller.bindFocusedSession("session-fresh");
    });
    controller.onWillRetireTerminalGeneration(retired);

    const tab = await controller.bindFocusedSession("session-fresh");

    expect(tab).toMatchObject({
      id: "tab-1",
      sessionId: "session-fresh",
      terminalGeneration: 2,
    });
    expect(retired).toHaveBeenCalledTimes(1);
    expect(retired).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-restored",
        terminalGeneration: 1,
      }),
    );
    expect(layoutsSeenDuringRetirement).toEqual(["session-fresh"]);
  });

  it("mutates layout before retirement for replaceSession and closeTab", async () => {
    const workspace = createWorkspaceState();
    const controller = new ChatTabController(workspace.state, {
      createId: createIds("tab-1", "tab-2"),
    });
    await controller.bindFocusedSession("session-1");
    const second = await controller.createTab("session-2");
    const observed: Array<{ event: string; layout: string[] }> = [];
    controller.onWillRetireTerminalGeneration((tab) => {
      observed.push({
        event: `retire:${tab.sessionId}`,
        layout: controller
          .getLayout()
          .tabs.map((candidate) => `${candidate.id}=${candidate.sessionId}`),
      });
    });

    await controller.replaceSession("tab-1", "session-1", "session-3");
    await controller.closeTab(second.id);

    expect(observed).toEqual([
      {
        event: "retire:session-1",
        layout: ["tab-1=session-3", "tab-2=session-2"],
      },
      { event: "retire:session-2", layout: ["tab-1=session-3"] },
    ]);
  });

  it("creates stable numbered tabs without duplicating an open session", async () => {
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

  it("reuses the lowest display number after a tab closes", async () => {
    const workspace = createWorkspaceState();
    const controller = new ChatTabController(workspace.state, {
      createId: createIds("tab-1", "tab-2", "tab-3"),
    });
    await controller.bindFocusedSession("session-1");
    const second = await controller.createTab("session-2");

    await expect(controller.closeTab(second.id)).resolves.toBe(true);
    const replacement = await controller.createTab("session-3");

    expect(replacement).toMatchObject({
      id: "tab-3",
      displayNumber: 2,
      sessionId: "session-3",
    });
    expect(controller.getLayout().nextDisplayNumber).toBe(3);
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

    expect(controller.canSetPlacement("tab-1", "docked", "popped")).toEqual({
      ok: false,
      reason: "last_docked",
    });
    await expect(
      controller.setPlacement("tab-1", "docked", "popped"),
    ).resolves.toEqual({ ok: false, reason: "last_docked" });
    const second = await controller.createTab();
    expect(controller.canSetPlacement(second.id, "docked", "popped")).toEqual({
      ok: true,
      tab: expect.objectContaining({ id: second.id, placement: "docked" }),
    });
    await expect(
      controller.setPlacement(second.id, "docked", "popped"),
    ).resolves.toEqual({
      ok: true,
      tab: expect.objectContaining({ id: second.id, placement: "popped" }),
    });
    expect(controller.getFocusedTabId()).toBe("tab-1");
    expect(controller.getTab(second.id)?.placement).toBe("popped");
  });

  it("rejects stale placement and rolls back when persistence fails", async () => {
    const workspace = createWorkspaceState();
    const controller = new ChatTabController(workspace.state, {
      createId: createIds("tab-1", "tab-2"),
    });
    const second = await controller.createTab();

    await expect(
      controller.setPlacement(second.id, "popped", "docked"),
    ).resolves.toEqual({ ok: false, reason: "conflict" });
    workspace.update.mockRejectedValueOnce(new Error("persist failed"));
    await expect(
      controller.setPlacement(second.id, "docked", "popped"),
    ).rejects.toThrow("persist failed");

    expect(controller.getTab(second.id)?.placement).toBe("docked");
    expect(controller.getFocusedTabId()).toBe(second.id);
  });

  it("does not roll back a newer layout after placement persistence fails", async () => {
    let rejectFirstWrite: ((error: Error) => void) | undefined;
    const workspace = createWorkspaceState();
    const controller = new ChatTabController(workspace.state, {
      createId: createIds("tab-1", "tab-2", "tab-3"),
    });
    const second = await controller.createTab();
    workspace.update.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectFirstWrite = reject;
        }),
    );
    const placement = controller.setPlacement(second.id, "docked", "popped");
    const thirdPromise = controller.createTab();
    await vi.waitFor(() => expect(rejectFirstWrite).toBeTypeOf("function"));
    rejectFirstWrite!(new Error("persist failed"));

    await expect(placement).rejects.toThrow("persist failed");
    const third = await thirdPromise;
    expect(controller.getTab(second.id)?.placement).toBe("popped");
    expect(controller.getTab(third.id)).toBeDefined();
  });

  it("closes only when another docked tab remains", async () => {
    const workspace = createWorkspaceState();
    const controller = new ChatTabController(workspace.state, {
      createId: createIds("tab-1", "tab-2", "tab-3"),
    });

    await expect(controller.closeTab("tab-1")).resolves.toBe(false);
    const second = await controller.createTab();
    const third = await controller.createTab();
    await controller.setPlacement(second.id, "docked", "popped");
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

  it("validates tab actions against controller epoch and exact session binding", async () => {
    const workspace = createWorkspaceState();
    const controller = new ChatTabController(workspace.state, {
      createId: createIds("tab-1"),
      createControllerEpoch: () => "epoch-1",
    });
    await controller.bindFocusedSession("session-1");

    expect(
      controller.validateAction({
        controllerEpoch: "epoch-1",
        tabId: "tab-1",
        sessionId: "session-1",
      }),
    ).toEqual({
      ok: true,
      tab: expect.objectContaining({ id: "tab-1", sessionId: "session-1" }),
    });
    expect(
      controller.validateAction({
        controllerEpoch: "stale",
        tabId: "tab-1",
        sessionId: "session-1",
      }),
    ).toEqual({ ok: false, reason: "stale_controller" });
    expect(
      controller.validateAction({
        controllerEpoch: "epoch-1",
        tabId: "missing",
        sessionId: "session-1",
      }),
    ).toEqual({ ok: false, reason: "not_found" });
    expect(
      controller.validateAction({
        controllerEpoch: "epoch-1",
        tabId: "tab-1",
        sessionId: "session-old",
      }),
    ).toEqual({ ok: false, reason: "stale_session" });
  });

  it("publishes focus-only workspace snapshots without persisting layout", async () => {
    const workspace = createWorkspaceState();
    const controller = new ChatTabController(workspace.state, {
      createId: createIds("tab-1", "tab-2"),
      createControllerEpoch: () => "epoch-1",
    });
    const second = await controller.createTab("session-2");
    workspace.update.mockClear();
    const snapshots: ReturnType<typeof controller.getWorkspaceSnapshot>[] = [];
    controller.onDidChangeWorkspace((snapshot) => snapshots.push(snapshot));

    await controller.focusTab("tab-1");
    snapshots[0]!.layout.tabs[0]!.sessionId = "mutated-listener-copy";

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({
      controllerEpoch: "epoch-1",
      focusedTabId: "tab-1",
    });
    expect(controller.getTab(second.id)?.sessionId).toBe("session-2");
    expect(controller.getTab("tab-1")?.sessionId).toBeNull();
    expect(workspace.update).not.toHaveBeenCalled();
  });
});
