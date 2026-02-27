import type { FeedbackEntry, PostCommand } from "../types.js";

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
  if (entries.length === 0) {
    return (
      <div class="section">
        <h3>
          Feedback <span class="badge">{entries.length}</span>
        </h3>
        <p class="help-text">No feedback recorded.</p>
        <button class="btn" onClick={() => postCommand("refreshFeedback")}>
          Refresh
        </button>
      </div>
    );
  }

  return (
    <div class="section">
      <h3>
        Feedback <span class="badge badge-warn">{entries.length}</span>
      </h3>
      <div class="feedback-actions">
        <button class="btn" onClick={() => postCommand("refreshFeedback")}>
          Refresh
        </button>
        <button
          class="btn btn-cancel"
          onClick={() => postCommand("clearAllFeedback")}
        >
          Clear All
        </button>
        <button class="btn" onClick={() => postCommand("openFeedbackFile")}>
          Open File
        </button>
      </div>
      {entries.map((entry, i) => (
        <div key={`${entry.timestamp}-${i}`} class="feedback-row">
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
              <span title="Session ID">
                {entry.session_id.slice(0, 8)}
              </span>
            )}
            <button
              class="btn-inline btn-cancel"
              onClick={() =>
                postCommand("deleteFeedbackEntry", { index: String(i) })
              }
            >
              Delete
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
