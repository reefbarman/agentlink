import type { ChatSessionHistorySummary } from "@agentlink/protocol/chat-session-history";
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
}

export function DesktopSidebar({
  sessions,
  currentSessionId,
  onSelect,
  onNew,
  onManage,
  mode = "ask",
  onModeChange,
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
        </nav>
      )}
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
          {visibleSessions.map((session) => (
            <button
              key={session.id}
              class={`desktop-chat-link${session.id === currentSessionId ? " active" : ""}`}
              type="button"
              aria-current={
                session.id === currentSessionId ? "page" : undefined
              }
              title={session.title || "Untitled chat"}
              onClick={() => onSelect(session.id)}
            >
              {session.title || "Untitled chat"}
            </button>
          ))}
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
    </aside>
  );
}
