// @vitest-environment jsdom

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/preact";

import { App } from "./App.js";
import type { ChatWorkspaceViewSnapshot } from "../chatTabProtocol.js";

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

afterEach(() => cleanup());

function createVsCodeApi() {
  return {
    postMessage: vi.fn(),
    getState: vi.fn(() => undefined),
    setState: vi.fn(),
  };
}

function deliver(message: unknown): void {
  fireEvent(window, new MessageEvent("message", { data: message }));
}

function postedCommands(
  postMessage: ReturnType<typeof vi.fn>,
  command: string,
) {
  return postMessage.mock.calls
    .map(([message]) => message as Record<string, unknown>)
    .filter((message) => message.command === command);
}

function createSnapshot(focusedTabId = "tab-1"): ChatWorkspaceViewSnapshot {
  return {
    controllerEpoch: "epoch-1",
    focusedTabId,
    tabs: [
      {
        tabId: "tab-1",
        displayNumber: 1,
        label: "T1",
        sessionId: "session-1",
        placement: "docked",
        title: "First chat",
        status: "streaming",
        busy: true,
      },
      {
        tabId: "tab-2",
        displayNumber: 2,
        label: "T2",
        sessionId: "session-2",
        placement: "docked",
        title: "Second chat",
        status: "idle",
        busy: false,
      },
    ],
  };
}

describe("App chat workspace integration", () => {
  it("renders a keyed workspace and addresses focus and New Tab commands", () => {
    const vscodeApi = createVsCodeApi();
    const { container } = render(<App vscodeApi={vscodeApi} />);
    deliver({ type: "chatWorkspaceUpdate", snapshot: createSnapshot() });

    expect(screen.getByRole("tablist", { name: "Agent chats" })).toBeTruthy();
    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(2);
    expect(
      container.querySelector<HTMLElement>(".chat-session-pane")?.dataset
        .tabKey,
    ).toBe("tab-1:session-1");

    const tabSelectors =
      container.querySelectorAll<HTMLButtonElement>(".chat-tab-select");
    fireEvent.click(tabSelectors[1]!);
    expect(postedCommands(vscodeApi.postMessage, "chatTabFocus")).toEqual([
      {
        command: "chatTabFocus",
        controllerEpoch: "epoch-1",
        tabId: "tab-2",
        sessionId: "session-2",
      },
    ]);

    fireEvent.click(screen.getByRole("button", { name: "New Tab" }));
    expect(postedCommands(vscodeApi.postMessage, "chatTabNew")).toEqual([
      {
        command: "chatTabNew",
        mode: "code",
        controllerEpoch: "epoch-1",
        tabId: "tab-1",
        sessionId: "session-1",
      },
    ]);
  });

  it("replays the exact confirmed address and allows cancellation", () => {
    const vscodeApi = createVsCodeApi();
    render(<App vscodeApi={vscodeApi} />);
    deliver({ type: "chatWorkspaceUpdate", snapshot: createSnapshot() });
    deliver({
      type: "chatTabActionConfirmationRequested",
      request: {
        command: "chatTabLoadSession",
        action: "load_session",
        address: {
          controllerEpoch: "confirmation-epoch",
          tabId: "tab-2",
          sessionId: "session-2",
        },
        mode: "ask",
        projectId: "project-2",
        targetSessionId: "saved-session",
      },
    });

    fireEvent.click(screen.getByRole("button", { name: "Keep current chat" }));
    expect(
      postedCommands(vscodeApi.postMessage, "chatTabLoadSession"),
    ).toHaveLength(0);

    deliver({
      type: "chatTabActionConfirmationRequested",
      request: {
        command: "chatTabLoadSession",
        action: "load_session",
        address: {
          controllerEpoch: "confirmation-epoch",
          tabId: "tab-2",
          sessionId: "session-2",
        },
        mode: "ask",
        projectId: "project-2",
        targetSessionId: "saved-session",
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Stop and load chat" }));

    expect(postedCommands(vscodeApi.postMessage, "chatTabLoadSession")).toEqual(
      [
        {
          command: "chatTabLoadSession",
          controllerEpoch: "confirmation-epoch",
          tabId: "tab-2",
          sessionId: "session-2",
          mode: "ask",
          projectId: "project-2",
          targetSessionId: "saved-session",
          stopRunning: true,
        },
      ],
    );
  });

  it("applies a stale-action snapshot and shows recoverable feedback", () => {
    const vscodeApi = createVsCodeApi();
    const { container } = render(<App vscodeApi={vscodeApi} />);
    deliver({ type: "chatWorkspaceUpdate", snapshot: createSnapshot() });
    deliver({
      type: "chatTabActionRejected",
      rejection: {
        command: "chatTabFocus",
        reason: "stale_session",
        snapshot: createSnapshot("tab-2"),
      },
    });

    expect(screen.getByRole("alert").textContent).toContain(
      "That chat tab changed. Please try the action again.",
    );
    expect(
      container.querySelector<HTMLElement>(".chat-session-pane")?.dataset
        .tabKey,
    ).toBe("tab-2:session-2");

    fireEvent.click(
      screen.getByRole("button", { name: "Dismiss tab message" }),
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
