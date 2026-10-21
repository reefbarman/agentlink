/**
 * The latest turn failure per chat, so a job run and its Inbox entry can say
 * what went wrong. The description itself is shared with the CLI through
 * workspace-host; only the server's owner sees these (run records, the
 * Inbox, the server log).
 */

export {
  MAX_FAILURE_DETAIL_LENGTH,
  describeTurnFailure,
} from "@agentlink/workspace-host";

const MAX_REMEMBERED = 200;

export interface TurnFailureLog {
  record(projectId: string, sessionId: string, detail: string): void;
  /** The latest failure of a chat, removed once read. */
  take(projectId: string, sessionId: string): string | undefined;
}

/** The latest failure per chat, the most recent few hundred chats only. */
export function createTurnFailureLog(): TurnFailureLog {
  const failures = new Map<string, string>();
  const key = (projectId: string, sessionId: string) =>
    `${projectId}\u0000${sessionId}`;
  return {
    record(projectId, sessionId, detail) {
      const id = key(projectId, sessionId);
      failures.delete(id);
      failures.set(id, detail);
      while (failures.size > MAX_REMEMBERED) {
        const oldest = failures.keys().next().value;
        if (oldest === undefined) break;
        failures.delete(oldest);
      }
    },
    take(projectId, sessionId) {
      const id = key(projectId, sessionId);
      const detail = failures.get(id);
      failures.delete(id);
      return detail;
    },
  };
}
