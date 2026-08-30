export const CHAT_TAB_LAYOUT_VERSION = 1 as const;

export type ChatTabPlacement = "docked" | "popped";

export interface ChatTab {
  id: string;
  displayNumber: number;
  sessionId: string | null;
  placement: ChatTabPlacement;
  terminalGeneration: number;
}

export interface ChatTabLayout {
  version: typeof CHAT_TAB_LAYOUT_VERSION;
  tabs: ChatTab[];
  nextDisplayNumber: number;
}

export interface ChatTabActionAddress {
  controllerEpoch: string;
  tabId: string;
  sessionId: string | null;
}

export interface ChatTabWorkspaceSnapshot {
  controllerEpoch: string;
  focusedTabId: string;
  layout: ChatTabLayout;
}

export type ChatTabDestructiveAction = "close" | "new_chat" | "load_session";

export type ChatTabViewStatus =
  | "idle"
  | "streaming"
  | "queued_for_provider"
  | "queued_for_workspace_write"
  | "needs_input"
  | "failed"
  | "completed";

export interface ChatTabViewSummary {
  tabId: string;
  displayNumber: number;
  label: string;
  sessionId: string | null;
  placement: ChatTabPlacement;
  title?: string;
  status: ChatTabViewStatus;
  busy: boolean;
}

export interface ChatWorkspaceViewSnapshot {
  controllerEpoch: string;
  focusedTabId: string;
  tabs: ChatTabViewSummary[];
}

export type ChatTabActionRejectionReason =
  | "invalid_address"
  | "stale_controller"
  | "not_found"
  | "stale_session";

export interface ChatTabActionRejection {
  command: string;
  reason: ChatTabActionRejectionReason;
  snapshot: ChatWorkspaceViewSnapshot;
}

export interface ChatTabActionConfirmationRequest {
  command: string;
  action: ChatTabDestructiveAction;
  address: ChatTabActionAddress;
  mode?: string;
  projectId?: string;
  targetSessionId?: string;
}

export interface ChatTabActionFailure {
  command: string;
  reason:
    | "close_blocked"
    | "session_not_found"
    | "binding_conflict"
    | "invalid_order"
    | "placement_failed";
  snapshot: ChatWorkspaceViewSnapshot;
}

export type ChatWorkspaceSessionStatus =
  | "queued"
  | "idle"
  | "streaming"
  | "tool_executing"
  | "awaiting_approval"
  | "error";

export type ChatWorkspaceInteractiveExecutionPhase =
  | "queued_for_workspace_write"
  | "queued_for_provider"
  | "running"
  | "awaiting_input"
  | "stopping";

/** Minimal structural session projection required to derive tab presentation. */
export interface ChatWorkspaceSessionSummary {
  id: string;
  status: ChatWorkspaceSessionStatus;
  interactiveExecutionPhase?: ChatWorkspaceInteractiveExecutionPhase;
  title: string;
  messageCount: number;
}

export function selectedWorkspaceSessionId(
  snapshot: ChatWorkspaceViewSnapshot | null,
  pinnedTabId?: string,
): string | null {
  const selectedTabId = pinnedTabId ?? snapshot?.focusedTabId;
  return (
    snapshot?.tabs.find((tab) => tab.tabId === selectedTabId)?.sessionId ?? null
  );
}

export function parseChatTabActionAddress(
  value: Record<string, unknown>,
): ChatTabActionAddress | null {
  if (
    typeof value.controllerEpoch !== "string" ||
    typeof value.tabId !== "string" ||
    !(value.sessionId === null || typeof value.sessionId === "string")
  ) {
    return null;
  }
  return {
    controllerEpoch: value.controllerEpoch,
    tabId: value.tabId,
    sessionId: typeof value.sessionId === "string" ? value.sessionId : null,
  };
}

export function createChatWorkspaceViewSnapshot(
  workspace: ChatTabWorkspaceSnapshot,
  sessions: readonly ChatWorkspaceSessionSummary[],
): ChatWorkspaceViewSnapshot {
  const sessionsById = new Map(
    sessions.map((session) => [session.id, session]),
  );
  return {
    controllerEpoch: workspace.controllerEpoch,
    focusedTabId: workspace.focusedTabId,
    tabs: workspace.layout.tabs.map((tab) => {
      const session = tab.sessionId
        ? sessionsById.get(tab.sessionId)
        : undefined;
      return {
        tabId: tab.id,
        displayNumber: tab.displayNumber,
        label: `T${tab.displayNumber}`,
        sessionId: tab.sessionId,
        placement: tab.placement,
        title: session?.title,
        status: getChatTabViewStatus(session),
        busy: isChatTabSessionBusy(session),
      };
    }),
  };
}

export function getChatTabViewStatus(
  session: ChatWorkspaceSessionSummary | undefined,
): ChatTabViewStatus {
  if (!session) return "idle";
  switch (session.interactiveExecutionPhase) {
    case "queued_for_provider":
      return "queued_for_provider";
    case "queued_for_workspace_write":
      return "queued_for_workspace_write";
    case "awaiting_input":
      return "needs_input";
    case "running":
    case "stopping":
      return "streaming";
  }
  switch (session.status) {
    case "queued":
      return "queued_for_provider";
    case "streaming":
    case "tool_executing":
      return "streaming";
    case "awaiting_approval":
      return "needs_input";
    case "error":
      return "failed";
    case "idle":
      return session.messageCount > 0 ? "completed" : "idle";
  }
}

export function isChatTabSessionBusy(
  session: ChatWorkspaceSessionSummary | undefined,
): boolean {
  if (!session) return false;
  return (
    session.interactiveExecutionPhase !== undefined ||
    session.status === "queued" ||
    session.status === "streaming" ||
    session.status === "tool_executing" ||
    session.status === "awaiting_approval"
  );
}
