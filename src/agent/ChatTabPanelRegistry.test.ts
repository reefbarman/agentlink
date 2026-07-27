import { describe, expect, it, vi } from "vitest";

import { ChatPaneAuthorityController } from "./ChatPaneAuthorityController.js";
import {
  ChatTabPanelRegistry,
  type ChatTabPanelHandle,
} from "./ChatTabPanelRegistry.js";

class FakePanel implements ChatTabPanelHandle {
  readonly reveal = vi.fn();
  readonly dispose = vi.fn(() => this.fireDispose());
  private readonly disposeListeners = new Set<() => void>();

  onDidDispose(listener: () => void): { dispose(): void } {
    this.disposeListeners.add(listener);
    return { dispose: () => this.disposeListeners.delete(listener) };
  }

  fireDispose(): void {
    for (const listener of this.disposeListeners) listener();
  }
}

function createRegistry(tabIds: string[] = ["tab-1", "tab-2"]) {
  const knownTabs = new Set(tabIds);
  const authority = new ChatPaneAuthorityController({
    isKnownTab: (tabId) => knownTabs.has(tabId),
  });
  const onPanelUserClose = vi.fn();
  const log = vi.fn();
  const registry = new ChatTabPanelRegistry({
    authority,
    onPanelUserClose,
    log,
  });
  return { registry, authority, knownTabs, onPanelUserClose, log };
}

describe("ChatTabPanelRegistry", () => {
  it("binds one panel to a prepared editor lease and activates it when ready", () => {
    const { registry, authority } = createRegistry();
    const sidebar = authority.adoptSidebar("tab-1");
    if (!sidebar.ok) throw new Error(sidebar.reason);
    const panel = new FakePanel();
    const registered = registry.registerPanel("tab-1", panel);

    expect(registered.status).toBe("attached");
    if (registered.status !== "attached") return;
    expect(authority.isAuthoritative(sidebar.lease)).toBe(true);
    expect(authority.isAuthoritative(registered.lease)).toBe(false);
    expect(registry.activatePanel("tab-1", registered.lease)).toEqual({
      ok: true,
      previous: sidebar.lease,
    });
    expect(authority.isAuthoritative(registered.lease)).toBe(true);
  });

  it("rejects activation with a stale or mismatched panel lease", () => {
    const { registry } = createRegistry();
    const panel = new FakePanel();
    const registered = registry.registerPanel("tab-1", panel);
    if (registered.status !== "attached") throw new Error(registered.status);

    expect(
      registry.activatePanel("tab-1", {
        ...registered.lease,
        epoch: registered.lease.epoch + 1,
      }),
    ).toEqual({ ok: false, previous: null });
    expect(registry.activatePanel("tab-2", registered.lease)).toEqual({
      ok: false,
      previous: null,
    });
  });

  it("cancels failed panel hydration without disturbing source authority", () => {
    const { registry, authority } = createRegistry();
    const sidebar = authority.adoptSidebar("tab-1");
    if (!sidebar.ok) throw new Error(sidebar.reason);
    const panel = new FakePanel();
    const registered = registry.registerPanel("tab-1", panel);
    if (registered.status !== "attached") throw new Error(registered.status);

    expect(registry.cancelPanelHandoff("tab-1", registered.lease)).toBe(true);
    expect(panel.dispose).toHaveBeenCalledOnce();
    expect(authority.isAuthoritative(sidebar.lease)).toBe(true);
    expect(registry.getPanel("tab-1")).toBeUndefined();
  });

  it("deduplicates serializer callbacks and reveals the existing panel", () => {
    const { registry, onPanelUserClose } = createRegistry();
    const firstPanel = new FakePanel();
    const first = registry.registerPanel("tab-1", firstPanel);
    if (first.status !== "attached") throw new Error(first.status);
    const duplicatePanel = new FakePanel();

    expect(registry.registerPanel("tab-1", duplicatePanel)).toEqual({
      status: "duplicate",
      lease: first.lease,
    });
    expect(firstPanel.reveal).toHaveBeenCalledOnce();
    expect(duplicatePanel.dispose).toHaveBeenCalledOnce();
    expect(registry.getPanel("tab-1")).toBe(firstPanel);
    expect(onPanelUserClose).not.toHaveBeenCalled();
  });

  it("rejects stale restored tab IDs without retaining their panels", () => {
    const { registry, onPanelUserClose } = createRegistry();
    const panel = new FakePanel();

    expect(registry.registerPanel("missing", panel)).toEqual({
      status: "rejected",
      reason: "unknown_tab",
    });
    expect(panel.dispose).toHaveBeenCalledOnce();
    expect(registry.getPanel("missing")).toBeUndefined();
    expect(onPanelUserClose).not.toHaveBeenCalled();
  });

  it("treats a user close during hydration as a dock request", () => {
    const { registry, authority, onPanelUserClose } = createRegistry();
    const panel = new FakePanel();
    const registered = registry.registerPanel("tab-1", panel);
    if (registered.status !== "attached") throw new Error(registered.status);

    panel.fireDispose();

    expect(onPanelUserClose).toHaveBeenCalledWith("tab-1", registered.lease);
    expect(registry.getPanel("tab-1")).toBeUndefined();
    expect(authority.getAuthority("tab-1")).toEqual({
      active: null,
      pending: null,
    });
  });

  it("does not dock for intentional panel disposal or tab release", () => {
    const { registry, authority, onPanelUserClose } = createRegistry();
    const firstPanel = new FakePanel();
    const first = registry.registerPanel("tab-1", firstPanel);
    if (first.status !== "attached") throw new Error(first.status);
    registry.activatePanel("tab-1", first.lease);
    const secondPanel = new FakePanel();
    registry.registerPanel("tab-2", secondPanel);

    expect(registry.disposePanel("tab-1")).toBe(true);
    registry.releaseTab("tab-2");

    expect(firstPanel.dispose).toHaveBeenCalledOnce();
    expect(secondPanel.dispose).toHaveBeenCalledOnce();
    expect(onPanelUserClose).not.toHaveBeenCalled();
    expect(authority.isAuthoritative(first.lease)).toBe(false);
  });

  it("tears down all panels without converting popped placement to docked", () => {
    const { registry, authority, onPanelUserClose } = createRegistry();
    const firstPanel = new FakePanel();
    const secondPanel = new FakePanel();
    const first = registry.registerPanel("tab-1", firstPanel);
    const second = registry.registerPanel("tab-2", secondPanel);
    if (first.status !== "attached" || second.status !== "attached") {
      throw new Error("panel registration failed");
    }
    registry.activatePanel("tab-1", first.lease);
    registry.activatePanel("tab-2", second.lease);

    registry.dispose();
    registry.dispose();

    expect(firstPanel.dispose).toHaveBeenCalledOnce();
    expect(secondPanel.dispose).toHaveBeenCalledOnce();
    expect(onPanelUserClose).not.toHaveBeenCalled();
    expect(authority.isAuthoritative(first.lease)).toBe(false);
    expect(authority.isAuthoritative(second.lease)).toBe(false);
  });
});
