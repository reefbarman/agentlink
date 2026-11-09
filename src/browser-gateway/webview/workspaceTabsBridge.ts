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

/** Validate tab data crossing the browser frame or Desktop IPC boundary. */
export function isWorkspaceTabGroups(
  value: unknown,
): value is WorkspaceTabGroup[] {
  const status = (kind: unknown): boolean =>
    kind === "working" ||
    kind === "awaiting_approval" ||
    kind === "error" ||
    kind === "disconnected" ||
    kind === "idle";
  return (
    Array.isArray(value) &&
    value.every(
      (group: WorkspaceTabGroup) =>
        group &&
        typeof group.instanceId === "string" &&
        typeof group.workspaceName === "string" &&
        typeof group.color === "string" &&
        status(group.statusKind) &&
        typeof group.statusLabel === "string" &&
        typeof group.active === "boolean" &&
        typeof group.disconnected === "boolean" &&
        typeof group.manageable === "boolean" &&
        typeof group.pending === "boolean" &&
        Array.isArray(group.tabs) &&
        group.tabs.every(
          (tab: WorkspaceTabItem) =>
            tab &&
            typeof tab.tabId === "string" &&
            typeof tab.label === "string" &&
            typeof tab.title === "string" &&
            status(tab.statusKind) &&
            typeof tab.statusLabel === "string" &&
            typeof tab.active === "boolean" &&
            typeof tab.selectable === "boolean" &&
            typeof tab.popped === "boolean",
        ),
    )
  );
}

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
