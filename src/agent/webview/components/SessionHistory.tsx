import { useState, useCallback, useMemo } from "preact/hooks";
import type { SessionSummary } from "../types";

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}

const MODE_ICONS: Record<string, string> = {
  code: "codicon-code",
  architect: "codicon-organization",
  ask: "codicon-question",
  debug: "codicon-debug",
};

interface SessionHistoryProps {
  sessions: SessionSummary[];
  currentSessionId: string | null;
  onLoad: (sessionId: string) => void;
  onDelete: (sessionId: string) => void;
  onRename: (sessionId: string, title: string) => void;
  onCopyFirstPrompt: (sessionId: string) => void;
  onClose: () => void;
}

export function SessionHistory({
  sessions,
  currentSessionId,
  onLoad,
  onDelete,
  onRename,
  onCopyFirstPrompt,
  onClose,
}: SessionHistoryProps) {
  const [search, setSearch] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  const PAGE_SIZE = 10;

  const filtered = useMemo(() => {
    if (!search.trim()) return sessions;
    const q = search.toLowerCase();
    return sessions.filter((s) => s.title.toLowerCase().includes(q));
  }, [sessions, search]);

  const isSearching = search.trim().length > 0;
  const visible =
    isSearching || showAll ? filtered : filtered.slice(0, PAGE_SIZE);
  const hiddenCount = filtered.length - visible.length;

  const handleStartRename = useCallback((s: SessionSummary) => {
    setEditingId(s.id);
    setEditTitle(s.title);
  }, []);

  const handleConfirmRename = useCallback(() => {
    if (editingId && editTitle.trim()) {
      onRename(editingId, editTitle.trim());
    }
    setEditingId(null);
  }, [editingId, editTitle, onRename]);

  const handleDelete = useCallback(
    (id: string) => {
      if (confirmDeleteId === id) {
        onDelete(id);
        setConfirmDeleteId(null);
      } else {
        setConfirmDeleteId(id);
        // Auto-dismiss confirmation after 3 seconds
        setTimeout(() => setConfirmDeleteId(null), 3000);
      }
    },
    [confirmDeleteId, onDelete],
  );

  return (
    <div class="session-history">
      <div class="session-history-header">
        <i class="codicon codicon-history" />
        <span>Session History</span>
        <button class="icon-button" onClick={onClose} title="Close">
          <i class="codicon codicon-close" />
        </button>
      </div>

      {sessions.length > 3 && (
        <div class="session-history-search">
          <i class="codicon codicon-search" />
          <input
            type="text"
            placeholder="Search sessions..."
            value={search}
            onInput={(e) => setSearch((e.target as HTMLInputElement).value)}
          />
        </div>
      )}

      <div class="session-history-list">
        {filtered.length === 0 ? (
          <div class="session-history-empty">
            {sessions.length === 0
              ? "No saved sessions yet."
              : "No matching sessions."}
          </div>
        ) : (
          <>
            {visible.map((s) => (
              <div
                key={s.id}
                class={`session-history-item${s.id === currentSessionId ? " active" : ""}`}
              >
                {editingId === s.id ? (
                  <div class="session-history-edit">
                    <input
                      type="text"
                      value={editTitle}
                      onInput={(e) =>
                        setEditTitle((e.target as HTMLInputElement).value)
                      }
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleConfirmRename();
                        if (e.key === "Escape") setEditingId(null);
                      }}
                      // eslint-disable-next-line @typescript-eslint/no-explicit-any
                      ref={(el: any) => el?.focus()}
                    />
                    <button
                      class="icon-button"
                      onClick={handleConfirmRename}
                      title="Save"
                    >
                      <i class="codicon codicon-check" />
                    </button>
                    <button
                      class="icon-button"
                      onClick={() => setEditingId(null)}
                      title="Cancel"
                    >
                      <i class="codicon codicon-close" />
                    </button>
                  </div>
                ) : (
                  <>
                    <div
                      class="session-history-item-main"
                      onClick={() => onLoad(s.id)}
                      title={`${s.title}\n${s.messageCount} messages · ${s.mode} mode`}
                    >
                      <div class="session-history-item-title">
                        <i
                          class={`codicon ${MODE_ICONS[s.mode] ?? "codicon-code"}`}
                        />
                        <span class="session-history-title-text">
                          {s.title}
                        </span>
                      </div>
                      <div class="session-history-item-meta">
                        <span>{relativeTime(s.lastActiveAt)}</span>
                        <span class="session-history-sep">·</span>
                        <span>
                          {s.messageCount} msg{s.messageCount !== 1 ? "s" : ""}
                        </span>
                      </div>
                    </div>
                    <div class="session-history-item-actions">
                      <button
                        class="icon-button"
                        onClick={() => onCopyFirstPrompt(s.id)}
                        title="Copy first prompt to new session"
                      >
                        <i class="codicon codicon-copy" />
                      </button>
                      <button
                        class="icon-button"
                        onClick={() => handleStartRename(s)}
                        title="Rename"
                      >
                        <i class="codicon codicon-edit" />
                      </button>
                      <button
                        class={`icon-button${confirmDeleteId === s.id ? " session-history-delete-confirm" : ""}`}
                        onClick={() => handleDelete(s.id)}
                        title={
                          confirmDeleteId === s.id
                            ? "Click again to confirm"
                            : "Delete"
                        }
                      >
                        <i class="codicon codicon-trash" />
                      </button>
                    </div>
                  </>
                )}
              </div>
            ))}
            {hiddenCount > 0 && (
              <button
                class="session-history-more"
                onClick={() => setShowAll(true)}
              >
                + {hiddenCount} more
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
