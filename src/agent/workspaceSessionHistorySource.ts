import type {
  WorkspaceSessionCatalogEntry,
  WorkspaceSessionHistorySource,
  WorkspaceSessionRecord,
} from "@agentlink/core/workspace-session-history";

import type { SessionPersistenceProvider } from "./persistenceContracts.js";
import type { SessionProjectScope } from "@agentlink/protocol/workspace-project";
import type { SessionSummary } from "./SessionStore.js";
import type { SessionTranscriptSourceMessage } from "@agentlink/core/session-transcript-recall";

/**
 * Persisted foreground sessions that belong to exactly one project. Background
 * and fleet sessions, sessions without a durable project identity, and sessions
 * owned by another project are never listed or readable.
 */
export function createPersistedWorkspaceSessionHistorySource(options: {
  persistence: Pick<SessionPersistenceProvider, "listSessions" | "readSession">;
  projectScope: SessionProjectScope;
}): WorkspaceSessionHistorySource {
  const { persistence, projectScope } = options;
  const inScope = (scope: SessionProjectScope | undefined) =>
    scope !== undefined &&
    scope.projectId === projectScope.projectId &&
    scope.workspaceFolderUri === projectScope.workspaceFolderUri;

  return {
    async listSessions() {
      const listed = await persistence.listSessions();
      return listed.value
        .filter(
          (summary) => !summary.background && inScope(summary.projectScope),
        )
        .map(catalogEntry);
    },
    async readSession(sessionId): Promise<WorkspaceSessionRecord | undefined> {
      const read = await persistence.readSession(sessionId);
      if (!read.ok) return undefined;
      const { summary, metadata, messages } = read.value;
      if (summary.id !== sessionId || summary.background || metadata.fleet) {
        return undefined;
      }
      if (!inScope(metadata.projectScope ?? summary.projectScope)) {
        return undefined;
      }
      return {
        ...catalogEntry(summary),
        messages: messages as readonly SessionTranscriptSourceMessage[],
      };
    },
  };
}

function catalogEntry(summary: SessionSummary): WorkspaceSessionCatalogEntry {
  return {
    sessionId: summary.id,
    title: summary.title,
    createdAt: summary.createdAt,
    lastActiveAt: summary.lastActiveAt,
    revision: `${summary.lastActiveAt}:${summary.messageCount}`,
  };
}
