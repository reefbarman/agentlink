import { Dialog, errorText, requestJson } from "./AssistantProjects";
import { useEffect, useState } from "preact/hooks";

/**
 * What the Assistant remembers about the owner: the Memory panel (search,
 * edit, forget, export, forget everything) and the "Remembered" lines
 * above a chat's composer, each with Undo. Memories are evidence the
 * Assistant reads, never instructions or permissions.
 */

export interface RememberedCard {
  id: string;
  statement: string;
  createdAt: string;
}

export interface MemoryEntry {
  id: string;
  revision: number;
  kind: string;
  statement: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  source?: {
    projectId?: string;
    sessionId?: string;
    observedAt: string;
    words?: string;
  };
}

const KIND_LABELS: Record<string, string> = {
  preference: "Preference",
  project_fact: "Fact",
  decision: "Decision",
  correction: "Correction",
};

export function memoryKindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind;
}

async function forgetMemory(id: string): Promise<void> {
  await requestJson(`/api/memory/${encodeURIComponent(id)}/forget`, {
    method: "POST",
    body: {},
  });
}

/** What was just remembered in the open chat, each with Undo. */
export function RememberedStrip({
  memories,
  onUndo = forgetMemory,
}: {
  memories: readonly RememberedCard[] | undefined;
  onUndo?: (id: string) => Promise<void>;
}) {
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  if (!memories || memories.length === 0) return null;
  const undo = (id: string) => {
    setProblem(null);
    setBusy(id);
    onUndo(id)
      .catch((caught: unknown) => setProblem(errorText(caught)))
      .finally(() => setBusy(null));
  };
  return (
    <ul class="assistant-chat-tasks" aria-label="Remembered in this chat">
      {memories.map((memory) => (
        <li class="assistant-chat-task" key={memory.id}>
          <i class="codicon codicon-lightbulb" aria-hidden="true" />
          <span class="assistant-chat-task-name">
            Remembered: {memory.statement}
          </span>
          <button
            type="button"
            class="assistant-task-pr"
            disabled={busy === memory.id}
            onClick={() => undo(memory.id)}
          >
            Undo
          </button>
        </li>
      ))}
      {problem && (
        <li class="assistant-project-error" role="alert">
          {problem}
        </li>
      )}
    </ul>
  );
}

export function MemoryPanel({
  onClose,
  openChat,
}: {
  onClose: () => void;
  openChat: (projectId: string, sessionId: string) => void | Promise<void>;
}) {
  const [memories, setMemories] = useState<MemoryEntry[] | null>(null);
  const [query, setQuery] = useState("");
  const [reloads, setReloads] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{
    entry: MemoryEntry;
    text: string;
  } | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      requestJson<{ memories: MemoryEntry[] }>(
        `/api/memory${query.trim() ? `?q=${encodeURIComponent(query.trim())}` : ""}`,
      ).then(
        (body) => {
          if (!cancelled) setMemories(body.memories);
        },
        (caught: unknown) => {
          if (!cancelled) setError(errorText(caught));
        },
      );
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, reloads]);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      setReloads((count) => count + 1);
      return true;
    } catch (caught) {
      setError(errorText(caught));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!editing) return;
    const ok = await run(() =>
      requestJson(`/api/memory/${encodeURIComponent(editing.entry.id)}`, {
        method: "PATCH",
        body: {
          statement: editing.text,
          expectedRevision: editing.entry.revision,
        },
      }),
    );
    if (ok) setEditing(null);
  };

  return (
    <Dialog title="Memory" onClose={onClose} busy={busy} wide>
      <p class="assistant-project-hint">
        What the Assistant remembers about you, from your own words in chats. It
        reads these as notes, never as instructions: a memory cannot approve
        anything or change a setting. Forgetting removes it from the Assistant's
        store; earlier chats and backups may still contain it, and anything
        already sent to a model provider cannot be recalled.
      </p>
      <div class="assistant-panel-actions">
        <input
          class="assistant-github-filter"
          type="search"
          placeholder="Search memories"
          value={query}
          onInput={(event) => setQuery(event.currentTarget.value)}
        />
        <a
          class="assistant-panel-action"
          href="/api/memory/export"
          download="agentlink-assistant-memory.json"
        >
          Export
        </a>
        {confirmAll ? (
          <>
            <button
              type="button"
              class="assistant-panel-action primary"
              disabled={busy}
              onClick={() =>
                void run(() =>
                  requestJson("/api/memory/forget-all", {
                    method: "POST",
                    body: {},
                  }),
                ).then(() => setConfirmAll(false))
              }
            >
              Forget everything
            </button>
            <button
              type="button"
              class="assistant-panel-action"
              onClick={() => setConfirmAll(false)}
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            type="button"
            class="assistant-panel-action"
            disabled={!memories || memories.length === 0}
            onClick={() => setConfirmAll(true)}
          >
            Forget everything…
          </button>
        )}
      </div>
      {error && (
        <div class="assistant-project-error" role="alert">
          <p>{error}</p>
        </div>
      )}
      {!memories && !error && <p class="assistant-panel-empty">Loading…</p>}
      {memories && memories.length === 0 && (
        <div class="assistant-panel-empty">
          <i class="codicon codicon-lightbulb" aria-hidden="true" />
          <p>
            {query.trim()
              ? "Nothing remembered matches."
              : "Nothing remembered yet. Tell the Assistant a preference in a chat and it will remember it."}
          </p>
        </div>
      )}
      {memories && memories.length > 0 && (
        <ul class="assistant-job-list">
          {memories.map((entry) => (
            <li class="assistant-job" key={entry.id}>
              <div class="assistant-job-main">
                {editing?.entry.id === entry.id ? (
                  <form
                    class="assistant-project-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void save();
                    }}
                  >
                    <label>
                      <span>Memory</span>
                      <textarea
                        rows={2}
                        maxLength={300}
                        value={editing.text}
                        onInput={(event) =>
                          setEditing({
                            entry,
                            text: event.currentTarget.value,
                          })
                        }
                      />
                    </label>
                    <footer>
                      <button type="button" onClick={() => setEditing(null)}>
                        Cancel
                      </button>
                      <button class="primary" type="submit" disabled={busy}>
                        Save
                      </button>
                    </footer>
                  </form>
                ) : (
                  <strong>{entry.statement}</strong>
                )}
                <span class="assistant-job-meta">
                  {memoryKindLabel(entry.kind)}
                  {entry.status === "contested" &&
                    " · conflicts with another memory"}
                  {" · "}
                  {new Date(entry.createdAt).toLocaleString()}
                  {entry.source?.words && (
                    <>
                      {" · you said “"}
                      {entry.source.words}
                      {"”"}
                    </>
                  )}
                </span>
              </div>
              <div class="assistant-job-actions">
                {entry.source?.projectId && entry.source.sessionId && (
                  <button
                    type="button"
                    title="Open the chat it came from"
                    onClick={() =>
                      void openChat(
                        entry.source!.projectId!,
                        entry.source!.sessionId!,
                      )
                    }
                  >
                    Chat
                  </button>
                )}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setEditing({ entry, text: entry.statement })}
                >
                  Edit
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void run(() => forgetMemory(entry.id))}
                >
                  Forget
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
