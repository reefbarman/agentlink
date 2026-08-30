export type ChatPaneSurface = "sidebar" | "editor";

/** Monotonic authority identity for one rendered chat pane. */
export interface ChatPaneLease {
  tabId: string;
  surface: ChatPaneSurface;
  epoch: number;
}

/** Address carried by messages exchanged with one authoritative chat pane. */
export interface ChatPaneAddress {
  controllerEpoch: string;
  tabId: string;
  sessionId: string | null;
  surface: ChatPaneSurface;
  paneEpoch: number;
}

export interface ChatPaneAddressedMessage {
  pane: ChatPaneAddress;
}

export type ChatWebviewBootstrap =
  | { surface: "sidebar" }
  | { surface: "editor"; address: ChatPaneAddress };

export function createChatPaneAddress(
  controllerEpoch: string,
  sessionId: string | null,
  lease: ChatPaneLease,
): ChatPaneAddress {
  return {
    controllerEpoch,
    tabId: lease.tabId,
    sessionId,
    surface: lease.surface,
    paneEpoch: lease.epoch,
  };
}

export function parseChatPaneAddress(value: unknown): ChatPaneAddress | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.controllerEpoch !== "string" ||
    typeof record.tabId !== "string" ||
    !(record.sessionId === null || typeof record.sessionId === "string") ||
    !(record.surface === "sidebar" || record.surface === "editor") ||
    typeof record.paneEpoch !== "number" ||
    !Number.isSafeInteger(record.paneEpoch) ||
    record.paneEpoch < 1
  ) {
    return null;
  }
  return {
    controllerEpoch: record.controllerEpoch,
    tabId: record.tabId,
    sessionId: record.sessionId as string | null,
    surface: record.surface,
    paneEpoch: record.paneEpoch,
  };
}

export function parseChatPaneMessageAddress(
  value: unknown,
): ChatPaneAddress | null {
  if (!value || typeof value !== "object") return null;
  return parseChatPaneAddress((value as Record<string, unknown>).pane);
}

export function parseChatWebviewBootstrap(
  value: unknown,
): ChatWebviewBootstrap | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.surface === "sidebar") return { surface: "sidebar" };
  if (record.surface !== "editor") return null;
  const address = parseChatPaneAddress(record.address);
  return address?.surface === "editor" ? { surface: "editor", address } : null;
}

export function sameChatPaneAddress(
  left: ChatPaneAddress,
  right: ChatPaneAddress,
): boolean {
  return (
    left.controllerEpoch === right.controllerEpoch &&
    left.tabId === right.tabId &&
    left.sessionId === right.sessionId &&
    left.surface === right.surface &&
    left.paneEpoch === right.paneEpoch
  );
}

export function addressChatPaneMessage(
  message: unknown,
  address: ChatPaneAddress,
): unknown {
  if (!message || typeof message !== "object") return message;
  return {
    ...(message as Record<string, unknown>),
    pane: { ...address },
  };
}
