import type {
  McpResourceUpdateProvenance,
  McpResourceWatchView,
} from "@agentlink/protocol/chat-transcript";
import { useLayoutEffect, useRef, useState } from "preact/hooks";

import { PaneHeader } from "./Panes";

export interface McpResourceWatchAction {
  server: string;
  uri: string;
  action: "pause" | "resume" | "unwatch" | "send-once";
}

/** Reveal additions, not notifications or status changes, independently for each chat. */
export function useMcpResourceWatchReveal(
  sessionId: string,
  watches: readonly McpResourceWatchView[],
  onReveal: () => void,
): string {
  const previous = useRef(new Map<string, Set<string>>());
  const identities = watches.map(({ server, uri }) =>
    JSON.stringify([server, uri]),
  );
  const key = JSON.stringify(identities.sort());
  useLayoutEffect(() => {
    const before = previous.current.get(sessionId);
    const current = new Set<string>(JSON.parse(key));
    previous.current.set(sessionId, current);
    if (before && [...current].some((identity) => !before.has(identity)))
      onReveal();
  }, [sessionId, key, onReveal]);
  return key;
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
  open = watches.length > 0,
  onClose,
}: {
  watches: McpResourceWatchView[];
  onAction: (request: McpResourceWatchAction) => void | Promise<void>;
  open?: boolean;
  onClose?: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!open) return null;
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
    <section
      class="pane-card mcp-resource-watches"
      aria-label="MCP resource watches"
    >
      <PaneHeader
        title={`Resource watches (${watches.length})`}
        right={
          onClose && (
            <button
              type="button"
              class="icon-button"
              aria-label="Hide resource watches"
              title="Hide panel. Watches stay active. Reopen with /mcp-watches."
              onClick={onClose}
            >
              <i class="codicon codicon-close" aria-hidden="true" />
            </button>
          )
        }
      />
      {!watches.length && (
        <div class="mcp-resource-watches-empty">
          No resource watches in this chat.
        </div>
      )}
      {watches.map((watch) => (
        <div
          key={JSON.stringify([watch.server, watch.uri])}
          class="mcp-resource-watch"
        >
          <div class="mcp-resource-watch-heading">
            <strong>{watch.server}</strong>
            {watch.pending && (
              <span class="mcp-resource-watch-pending">Update pending</span>
            )}
          </div>
          <code class="mcp-resource-watch-uri" title={watch.uri}>
            {watch.uri}
          </code>
          <div class="mcp-resource-watch-status">
            {permissions[watch.mode]} · {watch.paused ? "Paused" : "Watching"}
          </div>
          {watch.reason && <div role="status">{watch.reason}</div>}
          <div class="mcp-resource-watch-actions">
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
      <div class="mcp-resource-watches-hint">
        Hide this panel without stopping watches. Reopen with{" "}
        <code>/mcp-watches</code>.
      </div>
      {error && <div role="alert">{error}</div>}
    </section>
  );
}
