// @vitest-environment jsdom

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/preact";

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

function sessionLoaded(sessionId: string, message: string) {
  return {
    type: "agentSessionLoaded",
    sessionId,
    title: `Loaded ${sessionId}`,
    mode: "code",
    model: "claude-opus-5",
    messages: [{ role: "user", content: message }],
    todos: [],
    lastInputTokens: 0,
    lastOutputTokens: 0,
  };
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

  it("isolates context usage and queued messages across tab switches", () => {
    const vscodeApi = createVsCodeApi();
    const { container } = render(<App vscodeApi={vscodeApi} />);
    deliver({ type: "chatWorkspaceUpdate", snapshot: createSnapshot("tab-1") });
    deliver({
      type: "stateUpdate",
      state: {
        sessionId: "session-1",
        mode: "code",
        model: "claude-opus-5",
        streaming: true,
        thinkingEnabled: true,
        reasoningEffort: "high",
        contextBudget: {
          maxInputTokens: 1_000_000,
          usedInputTokens: 250_000,
          outputReservation: 0,
        },
      },
    });
    deliver({
      type: "agentTokenEstimate",
      sessionId: "session-1",
      estimatedTotalUsed: 250_000,
    });
    deliver({
      type: "agentQueuedMessage",
      sessionId: "session-1",
      queueId: "queue-1",
      text: "queued for the first tab",
      displayText: "queued for the first tab",
      isSlashCommand: false,
    });

    expect(
      container.querySelector(".context-bar-label")?.textContent,
    ).toContain("250.0k");
    expect(screen.getByText("queued for the first tab")).toBeTruthy();

    const unboundSecondTab = createSnapshot("tab-2");
    unboundSecondTab.tabs[1] = {
      ...unboundSecondTab.tabs[1]!,
      sessionId: null,
    };
    deliver({ type: "chatWorkspaceUpdate", snapshot: unboundSecondTab });
    deliver({
      type: "stateUpdate",
      state: {
        sessionId: "session-1",
        mode: "code",
        model: "claude-opus-5",
        streaming: true,
        contextBudget: {
          maxInputTokens: 1_000_000,
          usedInputTokens: 250_000,
          outputReservation: 0,
        },
      },
    });
    expect(container.querySelector(".context-bar-label")).toBeNull();
    expect(screen.queryByText("queued for the first tab")).toBeNull();

    deliver({ type: "chatWorkspaceUpdate", snapshot: createSnapshot("tab-2") });
    expect(container.querySelector(".context-bar-label")).toBeNull();

    deliver({
      type: "agentDone",
      sessionId: "session-1",
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
    });
    deliver({ type: "chatWorkspaceUpdate", snapshot: createSnapshot("tab-1") });
    deliver({
      type: "agentSessionLoaded",
      sessionId: "session-1",
      title: "First chat",
      mode: "code",
      model: "claude-opus-5",
      messages: [],
      todos: [],
      lastInputTokens: 0,
      lastOutputTokens: 0,
    });

    expect(
      container.querySelector(".context-bar-label")?.textContent,
    ).toContain("250.0k");
    expect(screen.getByText("queued for the first tab")).toBeTruthy();
  });

  it("rejects late session loads without consuming inactive events", async () => {
    const vscodeApi = createVsCodeApi();
    render(<App vscodeApi={vscodeApi} />);
    deliver({ type: "chatWorkspaceUpdate", snapshot: createSnapshot("tab-1") });
    deliver(sessionLoaded("session-1", "transcript for A"));

    deliver({ type: "chatWorkspaceUpdate", snapshot: createSnapshot("tab-2") });
    deliver(sessionLoaded("session-2", "transcript for B"));
    deliver({ type: "chatWorkspaceUpdate", snapshot: createSnapshot("tab-1") });
    expect(screen.getAllByText("transcript for A")).not.toHaveLength(0);

    deliver({
      type: "agentQueuedMessage",
      sessionId: "session-2",
      queueId: "queue-b",
      text: "buffered for B",
      displayText: "buffered for B",
      isSlashCommand: false,
    });
    deliver(sessionLoaded("session-2", "late overwrite from B"));
    deliver({
      type: "stateUpdate",
      state: {
        sessionId: "session-2",
        mode: "code",
        model: "claude-opus-5",
        streaming: false,
        contextBudget: {
          maxInputTokens: 1_000_000,
          usedInputTokens: 400_000,
          outputReservation: 0,
        },
      },
    });

    expect(screen.getAllByText("transcript for A")).not.toHaveLength(0);
    expect(screen.queryByText("late overwrite from B")).toBeNull();
    expect(screen.queryByText("buffered for B")).toBeNull();
    expect(document.querySelector(".context-bar-label")).toBeNull();

    deliver({ type: "chatWorkspaceUpdate", snapshot: createSnapshot("tab-2") });
    deliver(sessionLoaded("session-2", "transcript for B"));

    await waitFor(() => {
      expect(screen.getAllByText("transcript for B")).not.toHaveLength(0);
      expect(screen.getByText("buffered for B")).toBeTruthy();
    });
  });

  it("does not duplicate an inactive queued interjection after terminal replay", async () => {
    const vscodeApi = createVsCodeApi();
    render(<App vscodeApi={vscodeApi} />);
    deliver({ type: "chatWorkspaceUpdate", snapshot: createSnapshot("tab-2") });
    deliver(sessionLoaded("session-2", "transcript for B"));
    deliver({ type: "chatWorkspaceUpdate", snapshot: createSnapshot("tab-1") });
    deliver(sessionLoaded("session-1", "transcript for A"));

    deliver({
      type: "agentQueuedMessage",
      sessionId: "session-2",
      queueId: "queue-b",
      text: "interject once",
      displayText: "interject once",
      isSlashCommand: false,
    });
    deliver({
      type: "agentInterjection",
      sessionId: "session-2",
      queueId: "queue-b",
      text: "interject once",
      displayText: "interject once",
      isSlashCommand: false,
    });
    deliver({
      type: "agentDone",
      sessionId: "session-2",
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
    });

    deliver({ type: "chatWorkspaceUpdate", snapshot: createSnapshot("tab-2") });
    deliver(sessionLoaded("session-2", "transcript for B"));

    await waitFor(() => {
      expect(screen.getAllByText("interject once")).toHaveLength(1);
    });
    expect(screen.queryByText("Queued (1)")).toBeNull();
    expect(postedCommands(vscodeApi.postMessage, "agentSend")).toHaveLength(0);
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
    deliver({ type: "chatWorkspaceUpdate", snapshot: createSnapshot("tab-2") });
    deliver(sessionLoaded("session-2", "transcript for B"));
    deliver({ type: "chatWorkspaceUpdate", snapshot: createSnapshot("tab-1") });
    deliver(sessionLoaded("session-1", "transcript for A"));
    deliver({
      type: "agentQueuedMessage",
      sessionId: "session-1",
      queueId: "queue-a",
      text: "queued for A",
      displayText: "queued for A",
      isSlashCommand: false,
    });

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
    expect(screen.getAllByText("transcript for B")).not.toHaveLength(0);
    expect(screen.queryByText("transcript for A")).toBeNull();
    expect(screen.queryByText("queued for A")).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Dismiss tab message" }),
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
