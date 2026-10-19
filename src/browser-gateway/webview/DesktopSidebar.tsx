import type {
  ChatSessionActivity,
  ChatSessionHistorySummary,
  ChatSessionKind,
} from "@agentlink/protocol/chat-session-history";
import { useEffect, useRef, useState } from "preact/hooks";

import type { ComponentChildren } from "preact";
import type { DesktopMode } from "../../shared/desktopBridge";

export const SIDEBAR_WIDTH_KEY = "agentlink.desktopSidebarWidth";
export const MIN_SIDEBAR_WIDTH = 200;
export const MAX_SIDEBAR_WIDTH = 480;
/** The chat keeps at least this much room beside the sidebar. */
const MIN_MAIN_WIDTH = 360;
const KEYBOARD_STEP = 16;

/**
 * A sidebar width the window has room for: between the minimum and
 * maximum, and never squeezing the chat below `MIN_MAIN_WIDTH`.
 */
export function clampSidebarWidth(width: number, viewport: number): number {
  const roomy = Math.min(MAX_SIDEBAR_WIDTH, viewport - MIN_MAIN_WIDTH);
  return Math.round(Math.max(MIN_SIDEBAR_WIDTH, Math.min(width, roomy)));
}

export function storedSidebarWidth(): number | undefined {
  try {
    const value = Number(window.localStorage.getItem(SIDEBAR_WIDTH_KEY));
    return Number.isFinite(value) && value > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function storeSidebarWidth(width: number | undefined): void {
  try {
    if (width === undefined) {
      window.localStorage.removeItem(SIDEBAR_WIDTH_KEY);
    } else {
      window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width));
    }
  } catch {
    // Private windows may refuse storage; the width lasts this page only.
  }
}

/**
 * Drag (or arrow keys) to resize the sidebar; double-click returns it to
 * the default. The chosen width is kept per browser and set as
 * `--desktop-sidebar-user-width` on the shell, which the stylesheet still
 * clamps to the window, so small windows stay usable.
 */
function SidebarResizeHandle() {
  const handleRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number | undefined>(storedSidebarWidth);

  useEffect(() => {
    const shell = handleRef.current?.closest<HTMLElement>(".browser-shell");
    if (!shell) return;
    if (width === undefined) {
      shell.style.removeProperty("--desktop-sidebar-user-width");
    } else {
      shell.style.setProperty("--desktop-sidebar-user-width", `${width}px`);
    }
  }, [width]);

  /** The width shown now (the stylesheet may have clamped the chosen one). */
  const current = () =>
    handleRef.current?.parentElement?.getBoundingClientRect().width ||
    width ||
    264;
  const commit = (next: number | undefined) => {
    setWidth(next);
    storeSidebarWidth(next);
  };

  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = current();
    let latest = startWidth;
    document.body.classList.add("desktop-sidebar-resizing");
    const move = (moveEvent: PointerEvent) => {
      latest = clampSidebarWidth(
        startWidth + moveEvent.clientX - startX,
        window.innerWidth,
      );
      setWidth(latest);
    };
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      document.body.classList.remove("desktop-sidebar-resizing");
      commit(latest);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const step =
      event.key === "ArrowLeft"
        ? -KEYBOARD_STEP
        : event.key === "ArrowRight"
          ? KEYBOARD_STEP
          : 0;
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      commit(
        clampSidebarWidth(
          event.key === "Home" ? MIN_SIDEBAR_WIDTH : MAX_SIDEBAR_WIDTH,
          window.innerWidth,
        ),
      );
      return;
    }
    if (!step) return;
    event.preventDefault();
    commit(clampSidebarWidth(current() + step, window.innerWidth));
  };

  return (
    <div
      ref={handleRef}
      class="desktop-sidebar-resize-handle"
      role="separator"
      aria-label="Resize sidebar"
      aria-orientation="vertical"
      aria-valuemin={MIN_SIDEBAR_WIDTH}
      aria-valuemax={MAX_SIDEBAR_WIDTH}
      aria-valuenow={width ?? undefined}
      tabIndex={0}
      title="Drag to resize the sidebar, double-click to reset"
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDblClick={() => commit(undefined)}
    />
  );
}

interface DesktopSidebarProps {
  sessions: ChatSessionHistorySummary[];
  currentSessionId: string | null;
  onSelect: (sessionId: string) => void;
  onNew: () => void;
  onManage: () => void;
  mode?: DesktopMode;
  onModeChange?: (mode: DesktopMode) => void;
  /**
   * The view the navigation marks as current, when it differs from the
   * content shown (the embedded Assistant shows chats under "Assistant").
   */
  activeView?: DesktopMode;
  /** Offer the drag handle; off when another surface owns the width. */
  resizable?: boolean;
  /** Shown above the chats, for example a product's project switcher. */
  header?: ComponentChildren;
  /** Offer the Assistant as a view (the desktop's embedded Assistant tab). */
  assistantMode?: boolean;
  /** Or a link to it, shown with the views (the browser gateway). */
  assistantLink?: ComponentChildren;
}

/** What a chat is for; hosts that predate `kind` mark only scheduled runs. */
function kindOf(session: ChatSessionHistorySummary): ChatSessionKind {
  return session.kind ?? (session.scheduled ? "job_run" : "chat");
}

type ChatFilter = "all" | ChatSessionKind;

const CHAT_FILTERS: ReadonlyArray<{ id: ChatFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "chat", label: "Chats" },
  { id: "task", label: "Tasks" },
  { id: "job_run", label: "Scheduled" },
];

const KIND_NOTES: Record<ChatSessionKind, string | undefined> = {
  chat: undefined,
  task: "task",
  job_run: "scheduled run",
};

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
  activeView = mode,
  resizable = true,
  header,
  assistantMode = false,
  assistantLink,
}: DesktopSidebarProps) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<ChatFilter>("all");
  const query = search.trim().toLocaleLowerCase();
  // Filters appear once there is more than one kind of chat to tell apart.
  const kinds = new Set(sessions.map(kindOf));
  const filtering = kinds.size > 1;
  const activeFilter = filtering ? filter : "all";
  const visibleSessions = sessions.filter(
    (session) =>
      session.title.toLocaleLowerCase().includes(query) &&
      (activeFilter === "all" || kindOf(session) === activeFilter),
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
            aria-current={activeView === "ask" ? "page" : undefined}
            onClick={() => onModeChange("ask")}
          >
            <i class="codicon codicon-comment-discussion" aria-hidden="true" />{" "}
            Ask AgentLink
          </button>
          <button
            type="button"
            aria-current={activeView === "vscode" ? "page" : undefined}
            onClick={() => onModeChange("vscode")}
          >
            <i class="codicon codicon-vscode" aria-hidden="true" /> VS Code
          </button>
          {assistantMode && (
            <button
              type="button"
              aria-current={activeView === "assistant" ? "page" : undefined}
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
        {filtering && (
          <div
            class="desktop-chat-filters"
            role="group"
            aria-label="Show chats"
          >
            {CHAT_FILTERS.filter(
              (option) => option.id === "all" || kinds.has(option.id),
            ).map((option) => (
              <button
                key={option.id}
                type="button"
                class="desktop-chat-filter"
                aria-pressed={activeFilter === option.id}
                onClick={() => setFilter(option.id)}
              >
                {option.label}
              </button>
            ))}
          </div>
        )}
        <nav class="desktop-chat-list" aria-label="Saved chats">
          {visibleSessions.map((session) => {
            const title = session.title || "Untitled chat";
            const kind = kindOf(session);
            const notes = [
              KIND_NOTES[kind],
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
                {kind === "job_run" && (
                  <i
                    class="codicon codicon-history desktop-chat-scheduled"
                    aria-hidden="true"
                  />
                )}
                {kind === "task" && (
                  <i
                    class="codicon codicon-git-pull-request desktop-chat-task"
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
              {query || activeFilter !== "all"
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
      {resizable && <SidebarResizeHandle />}
    </aside>
  );
}
