import type { ChatWorkspaceViewSnapshot } from "../chatTabProtocol.js";

export function addressChatWebviewMessage(
  message: unknown,
  snapshot: ChatWorkspaceViewSnapshot | null,
): unknown {
  if (!snapshot || !message || typeof message !== "object") return message;
  const record = message as Record<string, unknown>;
  if (typeof record.command !== "string") return message;
  const selected = snapshot.tabs.find(
    (tab) => tab.tabId === snapshot.focusedTabId,
  );
  if (!selected) return message;
  return {
    ...record,
    controllerEpoch:
      typeof record.controllerEpoch === "string"
        ? record.controllerEpoch
        : snapshot.controllerEpoch,
    tabId: typeof record.tabId === "string" ? record.tabId : selected.tabId,
    sessionId:
      record.sessionId === null || typeof record.sessionId === "string"
        ? record.sessionId
        : selected.sessionId,
  };
}
