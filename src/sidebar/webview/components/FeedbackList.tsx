import type { FeedbackEntry, PostCommand } from "../types.js";

import { CollapsibleSection } from "./common/CollapsibleSection.js";

interface Props {
  entries: FeedbackEntry[];
  postCommand: PostCommand;
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return iso;
  }
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString([], { month: "short", day: "numeric" });
  } catch {
    return "";
  }
}

export function FeedbackList({ entries, postCommand }: Props) {
  const badge =
    entries.length > 0 ? (
      <span class="badge badge-warn" style={{ marginLeft: "6px" }}>
        {entries.length}
      </span>
    ) : (
      <span class="badge" style={{ marginLeft: "6px" }}>
        0
      </span>
    );

  if (entries.length === 0) {
    return (
      <CollapsibleSection title="Feedback" titleExtra={badge}>
        <p class="help-text">No feedback recorded.</p>
        <button
          class="btn"
          title="Reload feedback entries from disk"
          onClick={() => postCommand("refreshFeedback")}
        >
          Refresh
        </button>
      </CollapsibleSection>
    );
  }

  return (
    <CollapsibleSection title="Feedback" titleExtra={badge}>
      <div class="feedback-actions">
        <button
          class="btn"
          title="Reload feedback entries from disk"
          onClick={() => postCommand("refreshFeedback")}
        >
          Refresh
        </button>
        <button
          class="btn btn-cancel"
          title="Hide every active feedback entry; raw records remain in the append-only file"
          onClick={() => postCommand("clearAllFeedback")}
        >
          Hide All
        </button>
        <button
          class="btn"
          title="Open the feedback data file in the editor"
          onClick={() => postCommand("openFeedbackFile")}
        >
          Open File
        </button>
      </div>
      {entries.map((entry) => (
        <div key={entry.id} class="feedback-row">
          <div class="feedback-header">
            <code class="tool-call-name">{entry.tool_name}</code>
            <span class="feedback-time" title={entry.timestamp}>
              {formatDate(entry.timestamp)} {formatTime(entry.timestamp)}
            </span>
          </div>
          <div class="feedback-text">{entry.feedback}</div>
          {entry.tool_params && (
            <details class="feedback-details">
              <summary>Params</summary>
              <pre>{entry.tool_params}</pre>
            </details>
          )}
          {entry.tool_result_summary && (
            <details class="feedback-details">
              <summary>Result</summary>
              <pre>{entry.tool_result_summary}</pre>
            </details>
          )}
          <div class="feedback-meta">
            <span title="Extension version">v{entry.extension_version}</span>
            {entry.session_id && (
              <span title="Session ID">{entry.session_id.slice(0, 8)}</span>
            )}
            <button
              class="btn-inline btn-cancel"
              title="Hide this feedback entry; the raw record remains on disk"
              onClick={() =>
                postCommand("deleteFeedbackEntry", { id: entry.id })
              }
            >
              Hide
            </button>
          </div>
        </div>
      ))}
    </CollapsibleSection>
  );
}
