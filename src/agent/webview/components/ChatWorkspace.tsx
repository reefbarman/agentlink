import type {
  ChatTabViewStatus,
  ChatWorkspaceViewSnapshot,
} from "../../chatTabProtocol.js";
import type { ComponentChildren, JSX } from "preact";

import { useState } from "preact/hooks";

const STATUS_LABELS: Record<ChatTabViewStatus, string> = {
  idle: "Idle",
  streaming: "Running",
  queued_for_provider: "Waiting for provider",
  queued_for_workspace_write: "Waiting for workspace writer",
  needs_input: "Needs input",
  failed: "Failed",
  completed: "Completed",
};

export function ChatWorkspace({
  snapshot,
  showTabStrip = true,
  onFocus,
  onNewTab,
  onClose,
  onPopOut,
  onReorder,
  children,
}: {
  snapshot: ChatWorkspaceViewSnapshot | null;
  showTabStrip?: boolean;
  onFocus(tabId: string): void;
  onNewTab(): void;
  onClose(tabId: string): void;
  onPopOut?(tabId: string): void;
  onReorder(tabIds: string[]): void;
  children: ComponentChildren;
}) {
  const [draggedTabId, setDraggedTabId] = useState<string | null>(null);
  const dockedTabs =
    snapshot?.tabs.filter((tab) => tab.placement === "docked") ?? [];

  const handleDrop = (
    event: JSX.TargetedDragEvent<HTMLDivElement>,
    targetTabId: string,
  ) => {
    event.preventDefault();
    if (!draggedTabId || draggedTabId === targetTabId || !snapshot) return;
    const ordered = snapshot.tabs.map((tab) => tab.tabId);
    const from = ordered.indexOf(draggedTabId);
    const to = ordered.indexOf(targetTabId);
    if (from < 0 || to < 0) return;
    ordered.splice(from, 1);
    ordered.splice(to, 0, draggedTabId);
    setDraggedTabId(null);
    onReorder(ordered);
  };

  return (
    <div class="chat-workspace">
      {showTabStrip && (
        <div class="chat-tab-strip" role="tablist" aria-label="Agent chats">
          <div class="chat-tab-strip-scroll">
            {dockedTabs.map((tab) => {
              const selected = tab.tabId === snapshot?.focusedTabId;
              const statusLabel = STATUS_LABELS[tab.status];
              return (
                <div
                  key={tab.tabId}
                  class={`chat-tab${selected ? " selected" : ""}`}
                  role="tab"
                  aria-selected={selected}
                  draggable
                  onDragStart={() => setDraggedTabId(tab.tabId)}
                  onDragEnd={() => setDraggedTabId(null)}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => handleDrop(event, tab.tabId)}
                >
                  <button
                    type="button"
                    class="chat-tab-select"
                    onClick={() => onFocus(tab.tabId)}
                    title={`${tab.label}: ${tab.title ?? "New Chat"} — ${statusLabel}`}
                  >
                    <span
                      class={`chat-tab-status status-${tab.status}`}
                      title={statusLabel}
                      aria-label={statusLabel}
                    />
                    <span class="chat-tab-label">{tab.label}</span>
                    <span class="chat-tab-title">
                      {tab.title ?? "New Chat"}
                    </span>
                  </button>
                  {onPopOut && (
                    <button
                      type="button"
                      class="chat-tab-pop-out"
                      onClick={() => onPopOut(tab.tabId)}
                      disabled={dockedTabs.length === 1}
                      title={
                        dockedTabs.length === 1
                          ? "At least one chat tab must remain docked"
                          : `Pop out ${tab.label}`
                      }
                      aria-label={`Pop out ${tab.label}`}
                    >
                      <i class="codicon codicon-open-preview" />
                    </button>
                  )}
                  <button
                    type="button"
                    class="chat-tab-close"
                    onClick={() => onClose(tab.tabId)}
                    disabled={dockedTabs.length === 1}
                    title={
                      dockedTabs.length === 1
                        ? "At least one chat tab must remain open"
                        : `Close ${tab.label}`
                    }
                    aria-label={`Close ${tab.label}`}
                  >
                    <i class="codicon codicon-close" />
                  </button>
                </div>
              );
            })}
          </div>
          <button
            type="button"
            class="chat-tab-new"
            onClick={onNewTab}
            title="New Tab"
            aria-label="New Tab"
            disabled={!snapshot}
          >
            <i class="codicon codicon-add" />
          </button>
        </div>
      )}
      {children}
    </div>
  );
}

export function ChatSessionPane({
  tabKey,
  children,
}: {
  tabKey: string;
  children: ComponentChildren;
}) {
  return (
    <div class="chat-session-pane" data-tab-key={tabKey}>
      {children}
    </div>
  );
}
