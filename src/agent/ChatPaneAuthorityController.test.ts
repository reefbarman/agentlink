import { describe, expect, it } from "vitest";

import { ChatPaneAuthorityController } from "./ChatPaneAuthorityController.js";
import type { ChatPaneLease } from "@agentlink/protocol/chat-pane-transport";

function createAuthority(tabIds: string[] = ["tab-1", "tab-2"]) {
  const knownTabs = new Set(tabIds);
  return {
    authority: new ChatPaneAuthorityController({
      isKnownTab: (tabId) => knownTabs.has(tabId),
    }),
    knownTabs,
  };
}

function requireLease(
  result: { ok: true; lease: ChatPaneLease } | { ok: false; reason: string },
): ChatPaneLease {
  if (!result.ok) throw new Error(result.reason);
  return result.lease;
}

describe("ChatPaneAuthorityController", () => {
  it("transfers authority only after the destination pane activates", () => {
    const { authority } = createAuthority();
    const sidebar = requireLease(authority.adoptSidebar("tab-1"));
    const editor = requireLease(authority.prepare("tab-1", "editor"));

    expect(editor).toEqual({ tabId: "tab-1", surface: "editor", epoch: 2 });
    expect(authority.isAuthoritative(sidebar)).toBe(true);
    expect(authority.isAuthoritative(editor)).toBe(false);
    expect(authority.getAuthority("tab-1")).toEqual({
      active: sidebar,
      pending: editor,
    });

    expect(authority.activate(editor)).toEqual({
      ok: true,
      previous: sidebar,
    });
    expect(authority.isAuthoritative(sidebar)).toBe(false);
    expect(authority.isAuthoritative(editor)).toBe(true);
  });

  it("cancels a failed destination without disturbing source authority", () => {
    const { authority } = createAuthority();
    const sidebar = requireLease(authority.adoptSidebar("tab-1"));
    const editor = requireLease(authority.prepare("tab-1", "editor"));

    expect(authority.cancel(editor)).toBe(true);
    expect(authority.isAuthoritative(sidebar)).toBe(true);
    expect(authority.getAuthority("tab-1")).toEqual({
      active: sidebar,
      pending: null,
    });
    expect(authority.cancel(editor)).toBe(false);
  });

  it("rolls an activated destination back to the prior authority", () => {
    const { authority } = createAuthority();
    const sidebar = requireLease(authority.adoptSidebar("tab-1"));
    const editor = requireLease(authority.prepare("tab-1", "editor"));
    const activated = authority.activate(editor);

    expect(activated).toEqual({ ok: true, previous: sidebar });
    expect(authority.rollbackActivation(editor, activated.previous)).toBe(true);
    expect(authority.getAuthority("tab-1")).toEqual({
      active: sidebar,
      pending: null,
    });
    expect(authority.rollbackActivation(editor, activated.previous)).toBe(
      false,
    );
  });

  it("uses monotonic epochs and rejects stale pane activation", () => {
    const { authority } = createAuthority();
    const sidebar = requireLease(authority.adoptSidebar("tab-1"));
    const firstEditor = requireLease(authority.prepare("tab-1", "editor"));
    authority.activate(firstEditor);

    const nextSidebar = requireLease(authority.prepare("tab-1", "sidebar"));
    expect(nextSidebar.epoch).toBe(3);
    expect(authority.activate(sidebar)).toEqual({ ok: false, previous: null });
    expect(authority.activate(nextSidebar)).toEqual({
      ok: true,
      previous: firstEditor,
    });
    expect(authority.isAuthoritative(firstEditor)).toBe(false);

    const secondEditor = requireLease(authority.prepare("tab-1", "editor"));
    expect(secondEditor.epoch).toBe(4);
    expect(authority.activate(firstEditor)).toEqual({
      ok: false,
      previous: null,
    });
  });

  it("allows only one in-flight destination per tab", () => {
    const { authority } = createAuthority();
    authority.adoptSidebar("tab-1");
    const editor = authority.prepare("tab-1", "editor");

    expect(authority.prepare("tab-1", "editor")).toEqual(editor);
    expect(authority.prepare("tab-1", "sidebar")).toEqual({
      ok: false,
      reason: "handoff_in_progress",
    });
  });

  it("revokes pending and active leases without accepting them again", () => {
    const { authority } = createAuthority();
    const sidebar = requireLease(authority.adoptSidebar("tab-1"));
    const editor = requireLease(authority.prepare("tab-1", "editor"));

    expect(authority.revoke(editor)).toBe(true);
    expect(authority.activate(editor)).toEqual({ ok: false, previous: null });
    expect(authority.revoke(sidebar)).toBe(true);
    expect(authority.isAuthoritative(sidebar)).toBe(false);
    expect(authority.revoke(sidebar)).toBe(false);
  });

  it("keeps epochs monotonic if the same tab ID is released and adopted again", () => {
    const { authority } = createAuthority();
    const first = requireLease(authority.adoptSidebar("tab-1"));
    authority.releaseTab("tab-1");
    const second = requireLease(authority.adoptSidebar("tab-1"));

    expect(second.epoch).toBeGreaterThan(first.epoch);
    expect(authority.isAuthoritative(first)).toBe(false);
    expect(authority.isAuthoritative(second)).toBe(true);
  });

  it("rejects unknown tabs and releases all authority for closed tabs", () => {
    const { authority } = createAuthority();
    expect(authority.prepare("missing", "editor")).toEqual({
      ok: false,
      reason: "unknown_tab",
    });

    const sidebar = requireLease(authority.adoptSidebar("tab-1"));
    authority.releaseTab("tab-1");
    expect(authority.isAuthoritative(sidebar)).toBe(false);
    expect(authority.getAuthority("tab-1")).toEqual({
      active: null,
      pending: null,
    });
  });

  it("clears leases without reusing epochs on controller disposal", () => {
    const { authority } = createAuthority();
    const first = requireLease(authority.adoptSidebar("tab-1"));
    authority.dispose();
    const next = requireLease(authority.adoptSidebar("tab-1"));

    expect(authority.isAuthoritative(first)).toBe(false);
    expect(next.epoch).toBeGreaterThan(first.epoch);
  });
});
