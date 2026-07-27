export interface ForegroundChatTabSyncHost {
  getForegroundSessionId(): string | undefined;
  bindFocusedSession(sessionId: string): Promise<unknown>;
}

/**
 * Serializes foreground-tab binding against sessions-changed notifications.
 *
 * Binding the foreground session can stop the outgoing tab session, which
 * fires sessions-changed again while the bind is still in flight. Without
 * coalescing, each notification re-enters bindFocusedSession on the same
 * stack; combined with a stale tab layout this recursed without bound and
 * froze the extension host. Notifications arriving mid-bind now mark the
 * state dirty and are absorbed by one trailing re-check.
 */
export function createForegroundChatTabSync(
  host: ForegroundChatTabSyncHost,
): () => Promise<void> {
  let inFlight: Promise<void> | undefined;
  let dirty = false;
  let draining = false;
  let boundForegroundSessionId: string | undefined;

  const run = async (): Promise<void> => {
    draining = true;
    try {
      while (dirty) {
        dirty = false;
        const sessionId = host.getForegroundSessionId();
        if (sessionId === undefined) {
          boundForegroundSessionId = undefined;
          continue;
        }
        if (sessionId === boundForegroundSessionId) continue;
        await host.bindFocusedSession(sessionId);
        boundForegroundSessionId = sessionId;
      }
    } finally {
      draining = false;
      inFlight = undefined;
    }
  };

  return () => {
    dirty = true;
    if (draining) return inFlight ?? Promise.resolve();
    const pending = run();
    // A run that never awaited — activation fires one before any session
    // exists — has already cleared its own bookkeeping by the time it returns.
    // Latching `inFlight` onto that settled promise short-circuited every later
    // notification, so no session was bound to a chat tab for the rest of the
    // window and tab-owned terminals stayed permanently unavailable.
    if (draining) inFlight = pending;
    return pending;
  };
}
