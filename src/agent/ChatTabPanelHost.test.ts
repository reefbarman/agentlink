import { beforeEach, describe, expect, it, vi } from "vitest";

const createWebviewPanel = vi.hoisted(() => vi.fn());

vi.mock("vscode", () => ({
  ViewColumn: { Beside: -2 },
  Uri: {
    joinPath: (
      base: { path?: string; fsPath?: string },
      ...segments: string[]
    ) => {
      const root = base.path ?? base.fsPath ?? "";
      const path = [root.replace(/\/$/, ""), ...segments].join("/");
      return { path, fsPath: path, toString: () => `webview:${path}` };
    },
  },
  window: { createWebviewPanel },
}));

import { ChatTabPanelHost } from "./ChatTabPanelHost.js";
import type { ChatPaneAddress } from "./chatPaneProtocol.js";
import {
  CHAT_TAB_LAYOUT_VERSION,
  CHAT_TAB_LAYOUT_WORKSPACE_KEY,
  ChatTabController,
  type ChatTabLayout,
  type ChatTabWorkspaceState,
} from "./ChatTabController.js";

class FakeWebview {
  options: unknown;
  html = "";
  readonly postMessage = vi.fn(async () => true);
  readonly cspSource = "webview-source";
  private readonly receiveListeners = new Set<(message: unknown) => void>();

  asWebviewUri(uri: unknown): unknown {
    return uri;
  }

  onDidReceiveMessage(listener: (message: unknown) => void): {
    dispose(): void;
  } {
    this.receiveListeners.add(listener);
    return { dispose: () => this.receiveListeners.delete(listener) };
  }

  receive(message: unknown): void {
    for (const listener of this.receiveListeners) listener(message);
  }
}

class FakePanel {
  readonly webview = new FakeWebview();
  title = "";
  iconPath: unknown;
  readonly reveal = vi.fn();
  private readonly disposeListeners = new Set<() => void>();
  disposed = false;

  onDidDispose(listener: () => void): { dispose(): void } {
    this.disposeListeners.add(listener);
    return { dispose: () => this.disposeListeners.delete(listener) };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.disposeListeners.forEach((listener) => listener());
  }
}

function createController(
  initial?: ChatTabLayout,
  shouldFailUpdate: () => boolean = () => false,
): ChatTabController {
  const stored = new Map<string, unknown>();
  if (initial) stored.set(CHAT_TAB_LAYOUT_WORKSPACE_KEY, initial);
  const state: ChatTabWorkspaceState = {
    get: <T>(key: string) => stored.get(key) as T | undefined,
    update: async (key, value) => {
      if (shouldFailUpdate()) throw new Error("workspace persistence failed");
      stored.set(key, structuredClone(value));
    },
  };
  let nextId = 1;
  return new ChatTabController(state, {
    createId: () => `tab-${nextId++}`,
    createControllerEpoch: () => "controller-1",
  });
}

function createHost(tabs: ChatTabController) {
  const hydrateEditor = vi.fn();
  const hydrateSidebar = vi.fn();
  const onEditorMessage = vi.fn();
  const onLayoutChanged = vi.fn();
  const log = vi.fn();
  const host = new ChatTabPanelHost({
    extensionUri: { path: "/extension", fsPath: "/extension" } as never,
    tabs,
    hydrateEditor,
    hydrateSidebar,
    onEditorMessage,
    onLayoutChanged,
    log,
  });
  return {
    host,
    hydrateEditor,
    hydrateSidebar,
    onEditorMessage,
    onLayoutChanged,
    log,
  };
}

function editorAddress(panel: FakePanel): ChatPaneAddress {
  const match = panel.webview.html.match(
    /<script id="agentlink-chat-bootstrap" type="application\/json">([^<]+)<\/script>/,
  );
  if (!match?.[1]) throw new Error("missing editor bootstrap");
  const parsed = JSON.parse(match[1]) as {
    surface: string;
    address: ChatPaneAddress;
  };
  return parsed.address;
}

function sendReady(panel: FakePanel): void {
  panel.webview.receive({
    command: "webviewReady",
    pane: editorAddress(panel),
  });
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  createWebviewPanel.mockReset();
});

describe("ChatTabPanelHost", () => {
  it("keeps sidebar authority until the editor is hydrated and ready", async () => {
    const tabs = createController();
    await tabs.bindFocusedSession("session-1");
    const second = await tabs.createTab("session-2");
    const panel = new FakePanel();
    createWebviewPanel.mockReturnValue(panel);
    const { host, hydrateEditor, onLayoutChanged } = createHost(tabs);

    await expect(host.popOut(second.id)).resolves.toBe(true);
    expect(tabs.getTab(second.id)?.placement).toBe("docked");
    expect(host.getSidebarAddress(second.id)?.surface).toBe("sidebar");
    expect(host.getEditorConnection(second.id)).toBeUndefined();

    sendReady(panel);
    await vi.waitFor(() =>
      expect(host.getEditorConnection(second.id)?.isFrozen()).toBe(false),
    );

    expect(hydrateEditor).toHaveBeenCalledWith(
      second.id,
      expect.objectContaining({ isReady: expect.any(Function) }),
    );
    expect(tabs.getTab(second.id)?.placement).toBe("popped");
    expect(host.getSidebarAddress(second.id)).toBeUndefined();
    expect(host.getEditorConnection(second.id)?.isFrozen()).toBe(false);
    expect(onLayoutChanged).toHaveBeenCalledOnce();
  });

  it("treats user panel close as docking but shutdown as intentional disposal", async () => {
    const tabs = createController();
    await tabs.bindFocusedSession("session-1");
    const second = await tabs.createTab("session-2");
    const firstPanel = new FakePanel();
    createWebviewPanel.mockReturnValue(firstPanel);
    const { host, hydrateSidebar } = createHost(tabs);
    await host.popOut(second.id);
    sendReady(firstPanel);
    await settle();

    firstPanel.dispose();
    await settle();

    expect(hydrateSidebar).toHaveBeenCalledWith(
      second.id,
      expect.objectContaining({ surface: "sidebar" }),
    );
    expect(tabs.getTab(second.id)?.placement).toBe("docked");

    const secondPanel = new FakePanel();
    createWebviewPanel.mockReturnValue(secondPanel);
    await host.popOut(second.id);
    sendReady(secondPanel);
    await settle();
    host.dispose();
    await settle();

    expect(secondPanel.disposed).toBe(true);
    expect(tabs.getTab(second.id)?.placement).toBe("popped");
  });

  it("restores editor authority when explicit docking cannot be persisted", async () => {
    let failUpdates = false;
    const tabs = createController(undefined, () => failUpdates);
    await tabs.bindFocusedSession("session-1");
    const second = await tabs.createTab("session-2");
    const panel = new FakePanel();
    createWebviewPanel.mockReturnValue(panel);
    const { host, log } = createHost(tabs);
    await host.popOut(second.id);
    sendReady(panel);
    await settle();
    const editor = host.getEditorConnection(second.id);
    expect(editor).toBeDefined();

    failUpdates = true;
    await expect(host.dock(second.id)).resolves.toBe(false);

    expect(tabs.getTab(second.id)?.placement).toBe("popped");
    expect(panel.disposed).toBe(false);
    expect(host.getEditorConnection(second.id)).toBe(editor);
    expect(host.getSidebarAddress(second.id)).toBeUndefined();
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("Failed to dock editor panel"),
    );
  });

  it("restores a popped editor when close-to-dock persistence fails", async () => {
    let failUpdates = false;
    const tabs = createController(undefined, () => failUpdates);
    await tabs.bindFocusedSession("session-1");
    const second = await tabs.createTab("session-2");
    const firstPanel = new FakePanel();
    const restoredPanel = new FakePanel();
    createWebviewPanel.mockReturnValue(firstPanel);
    const { host, log } = createHost(tabs);
    await host.popOut(second.id);
    sendReady(firstPanel);
    await settle();

    failUpdates = true;
    createWebviewPanel.mockReturnValue(restoredPanel);
    firstPanel.dispose();
    await vi.waitFor(() => {
      expect(tabs.getTab(second.id)?.placement).toBe("popped");
      expect(restoredPanel.webview.html).toContain('"surface":"editor"');
    });

    expect(host.getSidebarAddress(second.id)?.surface).toBe("sidebar");
    sendReady(restoredPanel);
    await settle();
    expect(host.getEditorConnection(second.id)).toBeDefined();
    expect(host.getSidebarAddress(second.id)).toBeUndefined();
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("Failed to dock closed panel"),
    );
  });

  it("waits for runtime readiness before attaching a serialized panel", async () => {
    const tabs = createController({
      version: CHAT_TAB_LAYOUT_VERSION,
      tabs: [
        {
          id: "tab-1",
          displayNumber: 1,
          sessionId: "session-1",
          placement: "docked",
          terminalGeneration: 1,
        },
        {
          id: "tab-2",
          displayNumber: 2,
          sessionId: "session-2",
          placement: "popped",
          terminalGeneration: 1,
        },
      ],
      nextDisplayNumber: 3,
    });
    const panel = new FakePanel();
    const { host } = createHost(tabs);
    let completed = false;

    const restore = host
      .deserializeWebviewPanel(panel as never, { version: 1, tabId: "tab-2" })
      .then(() => {
        completed = true;
      });
    await settle();

    expect(completed).toBe(false);
    expect(panel.webview.html).toBe("");

    host.markRuntimeReady();
    await restore;

    expect(panel.webview.html).toContain('"surface":"editor"');
    sendReady(panel);
    await settle();
    expect(tabs.getTab("tab-2")?.placement).toBe("popped");
    expect(host.getEditorConnection("tab-2")).toBeDefined();
  });

  it("deduplicates restored panels and rejects stale serialized state", async () => {
    const tabs = createController({
      version: CHAT_TAB_LAYOUT_VERSION,
      tabs: [
        {
          id: "tab-1",
          displayNumber: 1,
          sessionId: null,
          placement: "docked",
          terminalGeneration: 1,
        },
        {
          id: "tab-2",
          displayNumber: 2,
          sessionId: "session-2",
          placement: "popped",
          terminalGeneration: 1,
        },
      ],
      nextDisplayNumber: 3,
    });
    const first = new FakePanel();
    const duplicate = new FakePanel();
    const stale = new FakePanel();
    const { host } = createHost(tabs);
    host.markRuntimeReady();

    await host.deserializeWebviewPanel(first as never, {
      version: 1,
      tabId: "tab-2",
    });
    await host.deserializeWebviewPanel(duplicate as never, {
      version: 1,
      tabId: "tab-2",
    });
    await host.deserializeWebviewPanel(stale as never, {
      version: 1,
      tabId: "missing",
    });

    expect(first.reveal).toHaveBeenCalledOnce();
    expect(duplicate.disposed).toBe(true);
    expect(stale.disposed).toBe(true);
    expect(tabs.getTab("tab-2")?.placement).toBe("popped");
  });

  it("rejects popping the last docked tab without creating a panel", async () => {
    const tabs = createController();
    const { host } = createHost(tabs);

    await expect(host.popOut("tab-1")).resolves.toBe(false);
    expect(createWebviewPanel).not.toHaveBeenCalled();
  });
});
