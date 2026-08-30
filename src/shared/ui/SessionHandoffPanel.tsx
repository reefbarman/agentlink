import { useEffect, useState } from "preact/hooks";

import type { SessionHandoffDraft } from "@agentlink/protocol/session-handoff-draft";

export function SessionHandoffPanel({
  draft,
  error,
  onConfirm,
  onCancel,
}: {
  draft: SessionHandoffDraft;
  error?: string | null;
  onConfirm: (markdown: string) => void;
  onCancel: () => void;
}) {
  const [markdown, setMarkdown] = useState(draft.markdown);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    setMarkdown(draft.markdown);
    setStarting(false);
  }, [draft.id, draft.markdown]);

  useEffect(() => {
    if (error) setStarting(false);
  }, [error]);

  return (
    <section
      class="session-handoff-panel"
      aria-label="Continue in a fresh session"
    >
      <div class="session-handoff-panel-header">
        <div>
          <strong>Continue in a fresh session</strong>
          <span>Review the continuity brief from {draft.sourceTitle}.</span>
        </div>
        <button
          type="button"
          class="icon-button"
          onClick={onCancel}
          disabled={starting}
          aria-label="Discard handoff draft"
          title="Discard handoff draft"
        >
          <i class="codicon codicon-close" />
        </button>
      </div>
      <p class="session-handoff-panel-note">
        This brief is historical context. The fresh session will inspect the
        current workspace before acting.
      </p>
      <textarea
        class="session-handoff-editor"
        value={markdown}
        onInput={(event) =>
          setMarkdown((event.target as HTMLTextAreaElement).value)
        }
        spellcheck={false}
        aria-label="Editable session handoff"
      />
      {error && <div class="session-handoff-error">{error}</div>}
      <div class="session-handoff-actions">
        <button type="button" onClick={onCancel} disabled={starting}>
          Cancel
        </button>
        <button
          type="button"
          class="primary"
          onClick={() => {
            setStarting(true);
            onConfirm(markdown);
          }}
          disabled={starting || !markdown.trim()}
        >
          {starting ? "Starting…" : "Start fresh and continue"}
        </button>
      </div>
    </section>
  );
}
