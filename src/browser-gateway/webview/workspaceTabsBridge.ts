/**
 * Messages between the browser shell and its embedded VS Code workspace page
 * (`/?browserWorkspace=1`). The workspace page owns the tabs; it posts them up
 * so the shell can list them in its sidebar instead of a strip above the chat,
 * and the shell posts the user's tab actions back down. Both pages are
 * same-origin, and each side only accepts messages from the other's window.
 */

/** Workspace page → shell: the current tab list. */
export const WORKSPACE_TABS_MESSAGE = "agentlink-workspace-tabs";
/** Shell → workspace page: the shell is listing the tabs, so hide the strip. */
export const WORKSPACE_TABS_HOST_MESSAGE = "agentlink-workspace-tabs-host";
/** Shell → workspace page: select, create, or close a tab. */
export const WORKSPACE_TAB_ACTION_MESSAGE = "agentlink-workspace-tab-action";

export type WorkspaceTabStatusKind =
  | "working"
  | "awaiting_approval"
  | "error"
  | "disconnected"
  | "idle";

export interface WorkspaceTabItem {
  tabId: string;
  label: string;
  title: string;
  statusKind: WorkspaceTabStatusKind;
  statusLabel: string;
  active: boolean;
  selectable: boolean;
  popped: boolean;
}

export interface WorkspaceTabGroup {
  instanceId: string;
  workspaceName: string;
  color: string;
  statusKind: WorkspaceTabStatusKind;
  statusLabel: string;
  /** This window is selected (for windows that report no tabs). */
  active: boolean;
  disconnected: boolean;
  /** New and close are available (the window reports a tab workspace). */
  manageable: boolean;
  pending: boolean;
  tabs: WorkspaceTabItem[];
}

export type WorkspaceTabAction =
  | { action: "select"; instanceId: string; tabId?: string }
  | { action: "new"; instanceId: string }
  | { action: "close"; instanceId: string; tabId: string };

export function isWorkspaceTabAction(
  value: unknown,
): value is WorkspaceTabAction {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.instanceId !== "string") return false;
  switch (candidate.action) {
    case "select":
      return (
        candidate.tabId === undefined || typeof candidate.tabId === "string"
      );
    case "new":
      return true;
    case "close":
      return typeof candidate.tabId === "string";
    default:
      return false;
  }
}
