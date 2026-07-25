import { describe, expect, it } from "vitest";

import type { ChatWorkspaceViewSnapshot } from "../chatTabProtocol.js";
import { addressChatWebviewMessage } from "./chatTabActions.js";

const snapshot: ChatWorkspaceViewSnapshot = {
  controllerEpoch: "epoch-1",
  focusedTabId: "tab-2",
  tabs: [
    {
      tabId: "tab-2",
      displayNumber: 2,
      label: "T2",
      sessionId: "session-2",
      placement: "docked",
      status: "idle",
      busy: false,
    },
  ],
};

describe("addressChatWebviewMessage", () => {
  it("adds the focused composite identity to ordinary commands", () => {
    expect(
      addressChatWebviewMessage(
        { command: "agentSend", text: "hello" },
        snapshot,
      ),
    ).toEqual({
      command: "agentSend",
      text: "hello",
      controllerEpoch: "epoch-1",
      tabId: "tab-2",
      sessionId: "session-2",
    });
  });

  it("preserves explicit identity for background actions and confirmation replay", () => {
    expect(
      addressChatWebviewMessage(
        {
          command: "chatTabNewChat",
          controllerEpoch: "epoch-old",
          tabId: "tab-1",
          sessionId: "session-1",
          stopRunning: true,
        },
        snapshot,
      ),
    ).toEqual({
      command: "chatTabNewChat",
      controllerEpoch: "epoch-old",
      tabId: "tab-1",
      sessionId: "session-1",
      stopRunning: true,
    });
  });

  it("uses an explicit null session for a fresh tab and leaves non-commands unchanged", () => {
    expect(
      addressChatWebviewMessage(
        { command: "chatTabNew", sessionId: null },
        snapshot,
      ),
    ).toMatchObject({ sessionId: null });
    expect(addressChatWebviewMessage({ type: "local" }, snapshot)).toEqual({
      type: "local",
    });
    expect(addressChatWebviewMessage("text", snapshot)).toBe("text");
  });
});
