import type {
  WorkspaceTabAction,
  WorkspaceTabGroup,
  WorkspaceTabItem,
} from "./workspaceTabsBridge";

import type { CSSProperties } from "preact";
import { ChatActivityIndicator } from "./DesktopSidebar";

function TabStatus({ tab }: { tab: Pick<WorkspaceTabItem, "statusKind"> }) {
  switch (tab.statusKind) {
    case "working":
      return <ChatActivityIndicator activity="running" />;
    case "awaiting_approval":
      return <ChatActivityIndicator activity="needs-you" />;
    case "error":
      return (
        <i
          class="codicon codicon-error workspace-tab-error"
          aria-hidden="true"
        />
      );
    default:
      return null;
  }
}

/**
 * The VS Code windows and their chat tabs, listed in the shell sidebar. The
 * embedded workspace page owns the tabs; this only renders the list it posts
 * and sends the user's actions back to it.
 */
export function WorkspaceTabList({
  groups,
  onAction,
}: {
  groups: WorkspaceTabGroup[];
  onAction: (action: WorkspaceTabAction) => void;
}) {
  if (groups.length === 0) {
    return (
      <p class="desktop-sidebar-empty">
        Open a VS Code window with AgentLink to connect.
      </p>
    );
  }
  return (
    <nav class="workspace-tab-groups" aria-label="VS Code chat tabs">
      {groups.map((group) => (
        <section
          key={group.instanceId}
          class={`workspace-tab-group${group.disconnected ? " disconnected" : ""}`}
          style={
            {
              "--instance-group-color": group.color,
            } as unknown as CSSProperties
          }
        >
          <div class="workspace-tab-group-header">
            {group.manageable ? (
              <h2 class="desktop-sidebar-heading">{group.workspaceName}</h2>
            ) : (
              <button
                type="button"
                class={`desktop-chat-link workspace-tab-window${group.active ? " active" : ""}`}
                aria-current={group.active ? "page" : undefined}
                title={`${group.workspaceName} · ${group.statusLabel}`}
                onClick={() =>
                  onAction({ action: "select", instanceId: group.instanceId })
                }
              >
                <i class="codicon codicon-window" aria-hidden="true" />
                <span class="desktop-chat-title">{group.workspaceName}</span>
                <TabStatus tab={group} />
              </button>
            )}
            {group.manageable && (
              <button
                type="button"
                class="workspace-tab-icon-button"
                aria-label={`New tab in ${group.workspaceName}`}
                title={`New tab in ${group.workspaceName}`}
                disabled={group.disconnected || group.pending}
                onClick={() =>
                  onAction({ action: "new", instanceId: group.instanceId })
                }
              >
                <i
                  class={`codicon codicon-${group.pending ? "loading codicon-modifier-spin" : "add"}`}
                  aria-hidden="true"
                />
              </button>
            )}
          </div>
          {group.tabs.length > 0 && (
            <ul class="workspace-tab-list">
              {group.tabs.map((tab) => (
                <li
                  key={tab.tabId}
                  class={`workspace-tab-row${tab.active ? " active" : ""}`}
                >
                  <button
                    type="button"
                    class={`desktop-chat-link workspace-tab-select${tab.active ? " active" : ""}`}
                    aria-current={tab.active ? "page" : undefined}
                    disabled={!tab.selectable}
                    title={`${tab.label} · ${tab.title} · ${tab.statusLabel}`}
                    onClick={() =>
                      onAction({
                        action: "select",
                        instanceId: group.instanceId,
                        tabId: tab.tabId,
                      })
                    }
                  >
                    <span class="workspace-tab-label">{tab.label}</span>
                    <span class="desktop-chat-title">{tab.title}</span>
                    {tab.popped && (
                      <i
                        class="codicon codicon-opened-editors"
                        aria-label="Popped out"
                      />
                    )}
                    <TabStatus tab={tab} />
                  </button>
                  <button
                    type="button"
                    class="workspace-tab-icon-button workspace-tab-close"
                    aria-label={`Close ${tab.label} · ${tab.title}`}
                    title="Close tab"
                    disabled={group.disconnected || group.pending}
                    onClick={() =>
                      onAction({
                        action: "close",
                        instanceId: group.instanceId,
                        tabId: tab.tabId,
                      })
                    }
                  >
                    <i class="codicon codicon-close" aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
    </nav>
  );
}
