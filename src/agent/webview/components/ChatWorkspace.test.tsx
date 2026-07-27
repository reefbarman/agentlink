/** @vitest-environment jsdom */

import { ChatSessionPane, ChatWorkspace } from "./ChatWorkspace";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/preact";

import type { ChatWorkspaceViewSnapshot } from "../../chatTabProtocol.js";

const snapshot: ChatWorkspaceViewSnapshot = {
  controllerEpoch: "epoch-1",
  focusedTabId: "tab-2",
  tabs: [
    {
      tabId: "tab-1",
      displayNumber: 1,
      label: "T1",
      sessionId: "session-1",
      placement: "docked",
      title: "First task",
      status: "queued_for_provider",
      busy: true,
    },
    {
      tabId: "tab-2",
      displayNumber: 2,
      label: "T2",
      sessionId: "session-2",
      placement: "docked",
      title: "Second task",
      status: "needs_input",
      busy: true,
    },
  ],
};

afterEach(cleanup);

describe("ChatWorkspace", () => {
  it("renders stable labels, titles, statuses, and selected tab", () => {
    render(
      <ChatWorkspace
        snapshot={snapshot}
        onFocus={vi.fn()}
        onNewTab={vi.fn()}
        onClose={vi.fn()}
        onReorder={vi.fn()}
      >
        <ChatSessionPane tabKey="tab-2:session-2">pane</ChatSessionPane>
      </ChatWorkspace>,
    );

    expect(screen.getByTitle("Waiting for provider")).toBeTruthy();
    expect(screen.getByTitle("Needs input")).toBeTruthy();
    expect(screen.getByText("First task")).toBeTruthy();
    expect(screen.getByText("Second task")).toBeTruthy();
    expect(screen.getByRole("tab", { selected: true }).textContent).toContain(
      "T2",
    );
    expect(
      screen.getByText("pane").closest<HTMLElement>(".chat-session-pane")
        ?.dataset.tabKey,
    ).toBe("tab-2:session-2");
  });

  it("routes focus, pop-out, close, New Tab, and drag reorder actions", () => {
    const onFocus = vi.fn();
    const onPopOut = vi.fn();
    const onClose = vi.fn();
    const onNewTab = vi.fn();
    const onReorder = vi.fn();
    const { container } = render(
      <ChatWorkspace
        snapshot={snapshot}
        onFocus={onFocus}
        onNewTab={onNewTab}
        onClose={onClose}
        onPopOut={onPopOut}
        onReorder={onReorder}
      >
        pane
      </ChatWorkspace>,
    );

    fireEvent.click(screen.getByTitle("T1: First task — Waiting for provider"));
    fireEvent.click(screen.getByLabelText("Pop out T1"));
    fireEvent.click(screen.getByLabelText("Close T1"));
    fireEvent.click(screen.getByLabelText("New Tab"));
    const tabs = container.querySelectorAll<HTMLElement>(".chat-tab");
    fireEvent.dragStart(tabs[0]!);
    fireEvent.dragOver(tabs[1]!);
    fireEvent.drop(tabs[1]!);

    expect(onFocus).toHaveBeenCalledWith("tab-1");
    expect(onPopOut).toHaveBeenCalledWith("tab-1");
    expect(onClose).toHaveBeenCalledWith("tab-1");
    expect(onNewTab).toHaveBeenCalledOnce();
    expect(onReorder).toHaveBeenCalledWith(["tab-2", "tab-1"]);
  });

  it("prevents closing or popping out the only docked tab", () => {
    render(
      <ChatWorkspace
        snapshot={{
          ...snapshot,
          focusedTabId: "tab-1",
          tabs: [snapshot.tabs[0]!],
        }}
        onFocus={vi.fn()}
        onNewTab={vi.fn()}
        onClose={vi.fn()}
        onPopOut={vi.fn()}
        onReorder={vi.fn()}
      >
        pane
      </ChatWorkspace>,
    );

    expect(
      (screen.getByLabelText("Close T1") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByLabelText("Pop out T1") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByLabelText("New Tab") as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});
