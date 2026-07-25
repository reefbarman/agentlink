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

  const run = async (): Promise<void> => {
    try {
      while (dirty) {
        dirty = false;
        const sessionId = host.getForegroundSessionId();
        if (sessionId === undefined) continue;
        await host.bindFocusedSession(sessionId);
      }
    } finally {
      inFlight = undefined;
    }
  };

  return () => {
    dirty = true;
    inFlight ??= run();
    return inFlight;
  };
}
