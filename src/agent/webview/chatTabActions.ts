import type { ChatPaneAddress } from "../chatPaneProtocol.js";
import type { ChatWorkspaceViewSnapshot } from "../chatTabProtocol.js";

export function addressChatWebviewMessage(
  message: unknown,
  snapshot: ChatWorkspaceViewSnapshot | null,
  pinnedPane?: ChatPaneAddress,
): unknown {
  if (!message || typeof message !== "object") return message;
  const record = message as Record<string, unknown>;
  if (typeof record.command !== "string") return message;
  const selected = pinnedPane
    ? snapshot?.tabs.find((tab) => tab.tabId === pinnedPane.tabId)
    : snapshot?.tabs.find((tab) => tab.tabId === snapshot.focusedTabId);
  if (!selected && !pinnedPane) return message;
  return {
    ...record,
    controllerEpoch:
      typeof record.controllerEpoch === "string"
        ? record.controllerEpoch
        : (snapshot?.controllerEpoch ?? pinnedPane!.controllerEpoch),
    tabId:
      typeof record.tabId === "string"
        ? record.tabId
        : (selected?.tabId ?? pinnedPane!.tabId),
    sessionId:
      record.sessionId === null || typeof record.sessionId === "string"
        ? record.sessionId
        : (selected?.sessionId ?? pinnedPane!.sessionId),
  };
}
