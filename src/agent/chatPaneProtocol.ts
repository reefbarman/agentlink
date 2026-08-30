import {
  addressChatPaneMessage,
  createChatPaneAddress,
  parseChatPaneAddress,
  parseChatPaneMessageAddress,
  parseChatWebviewBootstrap,
  sameChatPaneAddress,
} from "@agentlink/protocol/chat-pane-transport";

export type {
  ChatPaneAddress,
  ChatPaneAddressedMessage,
  ChatWebviewBootstrap,
} from "@agentlink/protocol/chat-pane-transport";
export {
  addressChatPaneMessage,
  createChatPaneAddress,
  parseChatPaneAddress,
  parseChatPaneMessageAddress,
  parseChatWebviewBootstrap,
  sameChatPaneAddress,
};

export const CHAT_PANEL_VIEW_TYPE = "agentLink.chatPanel";
export const SERIALIZED_CHAT_PANEL_STATE_VERSION = 1;

export interface SerializedChatPanelState {
  version: typeof SERIALIZED_CHAT_PANEL_STATE_VERSION;
  tabId: string;
}

export function createSerializedChatPanelState(
  tabId: string,
): SerializedChatPanelState {
  return {
    version: SERIALIZED_CHAT_PANEL_STATE_VERSION,
    tabId,
  };
}

export function parseSerializedChatPanelState(
  value: unknown,
): SerializedChatPanelState | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (
    record.version !== SERIALIZED_CHAT_PANEL_STATE_VERSION ||
    typeof record.tabId !== "string" ||
    record.tabId.length === 0
  ) {
    return null;
  }
  return createSerializedChatPanelState(record.tabId);
}
