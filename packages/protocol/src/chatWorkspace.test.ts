import { describe, expect, it } from "vitest";

import {
  createChatWorkspaceViewSnapshot,
  getChatTabViewStatus,
  isChatTabSessionBusy,
  parseChatTabActionAddress,
  selectedWorkspaceSessionId,
  type ChatTabWorkspaceSnapshot,
  type ChatWorkspaceSessionSummary,
} from "./chatWorkspace.js";

function session(
  overrides: Partial<ChatWorkspaceSessionSummary> &
    Pick<ChatWorkspaceSessionSummary, "id">,
): ChatWorkspaceSessionSummary {
  return {
    status: "idle",
    title: "Session title",
    messageCount: 0,
    ...overrides,
  };
}

const workspace: ChatTabWorkspaceSnapshot = {
  controllerEpoch: "epoch-1",
  focusedTabId: "tab-2",
  layout: {
    version: 1,
    nextDisplayNumber: 3,
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
        sessionId: null,
        placement: "docked",
        terminalGeneration: 1,
      },
    ],
  },
};

describe("chat workspace protocol", () => {
  it("parses exact action addresses and requires an explicit nullable session", () => {
    expect(
      parseChatTabActionAddress({
        controllerEpoch: "epoch-1",
        tabId: "tab-1",
        sessionId: "session-1",
      }),
    ).toEqual({
      controllerEpoch: "epoch-1",
      tabId: "tab-1",
      sessionId: "session-1",
    });
    expect(
      parseChatTabActionAddress({
        controllerEpoch: "epoch-1",
        tabId: "tab-2",
        sessionId: null,
      }),
    ).toEqual({
      controllerEpoch: "epoch-1",
      tabId: "tab-2",
      sessionId: null,
    });
    expect(
      parseChatTabActionAddress({
        controllerEpoch: "epoch-1",
        tabId: "tab-2",
      }),
    ).toBeNull();
    expect(parseChatTabActionAddress({ tabId: "tab-1" })).toBeNull();
    expect(
      parseChatTabActionAddress({
        controllerEpoch: "epoch-1",
        tabId: "tab-1",
        sessionId: 42,
      }),
    ).toBeNull();
  });

  it("projects stable tab labels, focus, session title, and status", () => {
    const snapshot = createChatWorkspaceViewSnapshot(workspace, [
      session({
        id: "session-1",
        status: "streaming",
        interactiveExecutionPhase: "queued_for_workspace_write",
      }),
    ]);

    expect(snapshot).toEqual({
      controllerEpoch: "epoch-1",
      focusedTabId: "tab-2",
      tabs: [
        {
          tabId: "tab-1",
          displayNumber: 1,
          label: "T1",
          sessionId: "session-1",
          placement: "docked",
          title: "Session title",
          status: "queued_for_workspace_write",
          busy: true,
        },
        {
          tabId: "tab-2",
          displayNumber: 2,
          label: "T2",
          sessionId: null,
          placement: "docked",
          title: undefined,
          status: "idle",
          busy: false,
        },
      ],
    });
    expect(selectedWorkspaceSessionId(snapshot)).toBeNull();
    expect(selectedWorkspaceSessionId(snapshot, "tab-1")).toBe("session-1");
    expect(selectedWorkspaceSessionId(snapshot, "missing")).toBeNull();
  });

  it.each([
    [
      session({
        id: "queued",
        interactiveExecutionPhase: "queued_for_provider",
      }),
      "queued_for_provider",
      true,
    ],
    [
      session({
        id: "writer",
        interactiveExecutionPhase: "queued_for_workspace_write",
      }),
      "queued_for_workspace_write",
      true,
    ],
    [
      session({ id: "question", interactiveExecutionPhase: "awaiting_input" }),
      "needs_input",
      true,
    ],
    [
      session({ id: "approval", status: "awaiting_approval" }),
      "needs_input",
      true,
    ],
    [session({ id: "failed", status: "error" }), "failed", false],
    [session({ id: "done", messageCount: 2 }), "completed", false],
    [session({ id: "empty" }), "idle", false],
  ] as const)("maps session %s to %s", (info, status, busy) => {
    expect(getChatTabViewStatus(info)).toBe(status);
    expect(isChatTabSessionBusy(info)).toBe(busy);
  });
});
