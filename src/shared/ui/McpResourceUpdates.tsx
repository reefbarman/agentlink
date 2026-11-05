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
        title={`${update.server}: ${update.uri}`}
        onClick={() => setExpanded(!expanded)}
      >
        <i
          class={`codicon codicon-chevron-${expanded ? "down" : "right"} tool-call-chevron`}
          aria-hidden="true"
        />
        <i
          class="codicon codicon-mail tool-call-status-icon"
          aria-hidden="true"
        />
        <span class="tool-call-name">MCP resource update</span>
        <span class="tool-call-summary">{update.server}</span>
      </button>
      {expanded && (
        <div class="tool-call-details">
          <div class="tool-call-section">
            <div class="tool-call-section-label">Source</div>
            <pre class="tool-call-code">{update.uri}</pre>
          </div>
          <div class="mcp-resource-update-notice">
            Untrusted external content. This is not a user instruction or
            approval.
          </div>
          <div class="tool-call-section">
            <div class="tool-call-section-label">Content</div>
            <pre class="tool-call-code">{text}</pre>
          </div>
        </div>
      )}
    </div>
  );
}

/** Metadata-only affordance: opening controls never reads or delivers content. */
export function McpResourcePendingIndicator({
  watches,
  disabled,
  onOpen,
}: {
  watches: readonly McpResourceWatchView[];
  disabled?: boolean;
  onOpen: () => void;
}) {
  const count = watches.filter((watch) => watch.pending).length;
  if (!count) return null;
  return (
    <div role="status" aria-live="polite" aria-atomic="true">
      <button
        type="button"
        class="mcp-resource-pending-indicator"
        disabled={disabled}
        title={
          disabled
            ? "Resolve the pending request before opening resource watches"
            : "Open resource watches. This does not read content or start the agent."
        }
        onClick={disabled ? undefined : onOpen}
      >
        <i class="codicon codicon-mail" aria-hidden="true" />
        {count} MCP {count === 1 ? "update" : "updates"} available
      </button>
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
  revealVersion = 0,
}: {
  watches: McpResourceWatchView[];
  /** Changes only for explicit open clicks, never for incoming notifications. */
  revealVersion?: number;
  onAction: (request: McpResourceWatchAction) => void | Promise<void>;
  open?: boolean;
  onClose?: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (open && revealVersion)
      panelRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [open, revealVersion]);
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
      ref={panelRef}
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
