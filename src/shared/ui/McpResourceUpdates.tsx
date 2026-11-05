import type {
  McpResourceUpdateProvenance,
  McpResourceWatchView,
} from "@agentlink/protocol/chat-transcript";

import { useState } from "preact/hooks";

export interface McpResourceWatchAction {
  server: string;
  uri: string;
  action: "pause" | "resume" | "unwatch" | "send-once";
}

/** Resource content is plain text: no markdown, URI navigation or remote images. */
export function McpResourceUpdateCard({
  text,
  update,
}: {
  text: string;
  update: McpResourceUpdateProvenance;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div class="tool-call-block mcp-resource-update">
      <button
        type="button"
        class="tool-call-header"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
      >
        <span class="tool-call-name">MCP resource update</span>
        <span class="tool-call-summary">
          {update.server} / {update.uri}
        </span>
      </button>
      {expanded && (
        <div class="tool-call-body">
          <p>
            Untrusted external content. This is not a user instruction or
            approval.
          </p>
          <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
            {text}
          </pre>
        </div>
      )}
    </div>
  );
}

const permissions: Record<McpResourceWatchView["mode"], string> = {
  notify: "Notify only",
  deliver: "Deliver automatically",
  wake: "Deliver and wake",
};

/** Shared Shelf control. All authority stays with the session's host. */
export function McpResourceWatchPanel({
  watches,
  onAction,
}: {
  watches: McpResourceWatchView[];
  onAction: (request: McpResourceWatchAction) => void | Promise<void>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!watches.length) return null;
  const submit = async (
    watch: McpResourceWatchView,
    action: McpResourceWatchAction["action"],
  ) => {
    setBusy(JSON.stringify([watch.server, watch.uri]));
    setError(null);
    try {
      await onAction({ server: watch.server, uri: watch.uri, action });
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not update resource watch.",
      );
    } finally {
      setBusy(null);
    }
  };
  return (
    <section class="mcp-resource-watches" aria-label="MCP resource watches">
      <strong>MCP resource watches</strong>
      {watches.map((watch) => (
        <div
          key={JSON.stringify([watch.server, watch.uri])}
          style={{ padding: "6px 0", overflowWrap: "anywhere" }}
        >
          <div>
            <strong>{watch.server}</strong> / {watch.uri}
          </div>
          <div>
            {permissions[watch.mode]} · {watch.paused ? "Paused" : "Watching"}
            {watch.pending ? " · 1 update pending" : ""}
          </div>
          {watch.reason && <div role="status">{watch.reason}</div>}
          <div class="queue-item-actions">
            <button
              type="button"
              disabled={busy !== null}
              onClick={() =>
                void submit(watch, watch.paused ? "resume" : "pause")
              }
            >
              {watch.paused ? "Resume" : "Pause"}
            </button>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void submit(watch, "unwatch")}
            >
              Stop watching
            </button>
            <button
              type="button"
              disabled={busy !== null}
              title="Request one read and delivery through normal approval, without a standing grant"
              onClick={() => void submit(watch, "send-once")}
            >
              Send once
            </button>
          </div>
        </div>
      ))}
      {error && <div role="alert">{error}</div>}
    </section>
  );
}
