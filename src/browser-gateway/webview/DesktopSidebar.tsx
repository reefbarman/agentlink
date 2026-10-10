import type {
  ChatSessionActivity,
  ChatSessionHistorySummary,
} from "@agentlink/protocol/chat-session-history";

import type { ComponentChildren } from "preact";
import type { DesktopMode } from "../../shared/desktopBridge";
import { useState } from "preact/hooks";

interface DesktopSidebarProps {
  sessions: ChatSessionHistorySummary[];
  currentSessionId: string | null;
  onSelect: (sessionId: string) => void;
  onNew: () => void;
  onManage: () => void;
  mode?: DesktopMode;
  onModeChange?: (mode: DesktopMode) => void;
  /** Shown above the chats, for example a product's project switcher. */
  header?: ComponentChildren;
  /** Offer the Assistant as a view (the desktop's embedded Assistant tab). */
  assistantMode?: boolean;
  /** Or a link to it, shown with the views (the browser gateway). */
  assistantLink?: ComponentChildren;
}

const ACTIVITY_LABELS: Record<ChatSessionActivity, string> = {
  running: "Working",
  "needs-you": "Needs you",
  unread: "New reply",
};

/**
 * A chat's live status: a spinner, an amber "needs you" dot, or an unread
 * dot. Decorative: the control it sits in carries the status in its label.
 */
export function ChatActivityIndicator({
  activity,
  label = ACTIVITY_LABELS[activity],
}: {
  activity: ChatSessionActivity;
  /** Overrides the default description, for example with counts. */
  label?: string;
}) {
  return (
    <span
      class={`desktop-chat-activity desktop-chat-activity-${activity}`}
      aria-hidden="true"
      title={label}
    />
  );
}

export function DesktopSidebar({
  sessions,
  currentSessionId,
  onSelect,
  onNew,
  onManage,
  mode = "ask",
  onModeChange,
  header,
  assistantMode = false,
  assistantLink,
}: DesktopSidebarProps) {
  const [search, setSearch] = useState("");
  const query = search.trim().toLocaleLowerCase();
  const visibleSessions = sessions.filter((session) =>
    session.title.toLocaleLowerCase().includes(query),
  );

  return (
    <aside
      class="desktop-sidebar"
      id="desktop-sidebar"
      aria-label="Chat navigation"
    >
      {onModeChange && (
        <nav class="desktop-mode-navigation" aria-label="Desktop views">
          <button
            type="button"
            aria-current={mode === "ask" ? "page" : undefined}
            onClick={() => onModeChange("ask")}
          >
            <i class="codicon codicon-comment-discussion" aria-hidden="true" />{" "}
            Ask AgentLink
          </button>
          <button
            type="button"
            aria-current={mode === "vscode" ? "page" : undefined}
            onClick={() => onModeChange("vscode")}
          >
            <i class="codicon codicon-vscode" aria-hidden="true" /> VS Code
          </button>
          {assistantMode && (
            <button
              type="button"
              aria-current={mode === "assistant" ? "page" : undefined}
              onClick={() => onModeChange("assistant")}
            >
              <i class="codicon codicon-sparkle" aria-hidden="true" /> Assistant
            </button>
          )}
          {assistantLink}
        </nav>
      )}
      {header}
      <div class="desktop-sidebar-history" hidden={mode !== "ask"}>
        <button class="desktop-new-chat" type="button" onClick={onNew}>
          <i class="codicon codicon-new-file" aria-hidden="true" />
          New chat
        </button>
        <label class="desktop-search">
          <i class="codicon codicon-search" aria-hidden="true" />
          <input
            aria-label="Search chats"
            placeholder="Search chats"
            value={search}
            onInput={(event) => setSearch(event.currentTarget.value)}
            type="search"
          />
        </label>
        <h2 class="desktop-sidebar-heading">Your chats</h2>
        <nav class="desktop-chat-list" aria-label="Saved chats">
          {visibleSessions.map((session) => {
            const title = session.title || "Untitled chat";
            const notes = [
              session.scheduled ? "scheduled run" : undefined,
              session.activity ? ACTIVITY_LABELS[session.activity] : undefined,
            ].filter(Boolean);
            const label = notes.length
              ? `${title} (${notes.join(", ")})`
              : undefined;
            return (
              <button
                key={session.id}
                class={`desktop-chat-link${session.id === currentSessionId ? " active" : ""}`}
                type="button"
                aria-current={
                  session.id === currentSessionId ? "page" : undefined
                }
                title={label ?? title}
                aria-label={label}
                onClick={() => onSelect(session.id)}
              >
                {session.scheduled && (
                  <i
                    class="codicon codicon-history desktop-chat-scheduled"
                    aria-hidden="true"
                  />
                )}
                <span class="desktop-chat-title">{title}</span>
                {session.activity && (
                  <ChatActivityIndicator activity={session.activity} />
                )}
              </button>
            );
          })}
          {visibleSessions.length === 0 && (
            <p class="desktop-sidebar-empty">
              {query
                ? "No matching chats."
                : "Your conversations will appear here."}
            </p>
          )}
        </nav>
        <button class="desktop-manage-chats" type="button" onClick={onManage}>
          <i class="codicon codicon-history" aria-hidden="true" />
          Manage chats
        </button>
      </div>
      {mode === "vscode" && (
        <p class="desktop-sidebar-empty">
          Your open VS Code windows and chats, connected through AgentLink.
        </p>
      )}
      {mode === "assistant" && (
        <p class="desktop-sidebar-empty">
          Your self-hosted AgentLink Assistant. Its chats and projects live on
          the Assistant's server.
        </p>
      )}
    </aside>
  );
}
