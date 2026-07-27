import {
  addressChatPaneMessage,
  createChatPaneAddress,
  createSerializedChatPanelState,
  parseChatPaneAddress,
  parseChatPaneMessageAddress,
  parseChatWebviewBootstrap,
  parseSerializedChatPanelState,
  sameChatPaneAddress,
} from "./chatPaneProtocol.js";
import { describe, expect, it } from "vitest";

const address = createChatPaneAddress("controller-1", "session-1", {
  tabId: "tab-1",
  surface: "editor",
  epoch: 3,
});

describe("chat pane protocol", () => {
  it("round-trips the minimal serialized panel state", () => {
    const state = createSerializedChatPanelState("tab-1");

    expect(state).toEqual({ version: 1, tabId: "tab-1" });
    expect(parseSerializedChatPanelState(state)).toEqual(state);
    expect(
      parseSerializedChatPanelState({ version: 2, tabId: "tab-1" }),
    ).toBeNull();
    expect(parseSerializedChatPanelState({ version: 1, tabId: "" })).toBeNull();
  });

  it("creates and strictly parses an immutable pane address", () => {
    expect(address).toEqual({
      controllerEpoch: "controller-1",
      tabId: "tab-1",
      sessionId: "session-1",
      surface: "editor",
      paneEpoch: 3,
    });
    expect(parseChatPaneAddress(address)).toEqual(address);
    expect(parseChatPaneAddress({ ...address, paneEpoch: 0 })).toBeNull();
    expect(parseChatPaneAddress({ ...address, surface: "browser" })).toBeNull();
  });

  it("addresses messages without mutating the input", () => {
    const message = { command: "agentSend", text: "hello" };
    const addressed = addressChatPaneMessage(message, address);

    expect(addressed).toEqual({ ...message, pane: address });
    expect(message).toEqual({ command: "agentSend", text: "hello" });
    expect(parseChatPaneMessageAddress(addressed)).toEqual(address);
    expect(parseChatPaneMessageAddress(message)).toBeNull();
  });

  it("parses sidebar and editor bootstrap identities", () => {
    expect(parseChatWebviewBootstrap({ surface: "sidebar" })).toEqual({
      surface: "sidebar",
    });
    expect(parseChatWebviewBootstrap({ surface: "editor", address })).toEqual({
      surface: "editor",
      address,
    });
    expect(
      parseChatWebviewBootstrap({
        surface: "editor",
        address: { ...address, surface: "sidebar" },
      }),
    ).toBeNull();
  });

  it("compares every authority-bearing field", () => {
    expect(sameChatPaneAddress(address, { ...address })).toBe(true);
    expect(
      sameChatPaneAddress(address, {
        ...address,
        controllerEpoch: "controller-2",
      }),
    ).toBe(false);
    expect(sameChatPaneAddress(address, { ...address, sessionId: null })).toBe(
      false,
    );
    expect(sameChatPaneAddress(address, { ...address, paneEpoch: 4 })).toBe(
      false,
    );
  });
});
