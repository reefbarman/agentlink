import type {
  DerivedSessionRetrievalService,
  DerivedSessionScope,
  PublishDerivedSessionRequest,
} from "./DerivedSessionRetrievalService.js";
import type {
  WorkspaceSessionHistoryIndex,
  WorkspaceSessionIndexCandidate,
  WorkspaceSessionIndexDocument,
} from "@agentlink/core/workspace-session-history";

import { scanMemoryText } from "@agentlink/core/memory";

/** Derived-session surface for workspace session history; separate from Ask Agent recall. */
export const WORKSPACE_SESSION_HISTORY_SURFACE = "workspace-session-history";

const MAX_TITLE_CHARS = 200;
const UNTITLED = "Untitled session";

/** Index only text the derived-session store accepts (no credential-like content). */
export function isWorkspaceHistoryIndexableText(text: string): boolean {
  return (
    Boolean(text.trim()) && text.length <= 8_000 && scanMemoryText(text).safe
  );
}

/**
 * Adapt the existing derived-session retrieval service to the portable
 * workspace-history index port. One instance covers exactly one scope; the
 * scope is fixed by the host, never by tool input.
 */
export function createDerivedSessionWorkspaceHistoryIndex(options: {
  service: Pick<
    DerivedSessionRetrievalService,
    "publish" | "publishBatch" | "deleteSession" | "inspect" | "recall"
  >;
  scope: DerivedSessionScope;
  surface?: string;
  now?: () => number;
}): WorkspaceSessionHistoryIndex {
  const surface = options.surface ?? WORKSPACE_SESSION_HISTORY_SURFACE;
  const scope = options.scope;
  const now = options.now ?? Date.now;
  return {
    async listIndexed() {
      const inspection = await options.service.inspect({
        scopes: [scope],
        surfaces: [surface],
      });
      return new Map(
        inspection.sessions.map((session) => [
          session.sessionId,
          session.sourceRevision,
        ]),
      );
    },
    async publish(document: WorkspaceSessionIndexDocument) {
      const outcome = await options.service.publish(
        toPublishRequest(document, surface, scope, now()),
      );
      if (outcome.status !== "published") {
        throw new Error(
          `Workspace session index publication was not committed: ${outcome.status}`,
        );
      }
    },
    // One commit (and one native index refresh) for the whole batch.
    async publishBatch(documents: WorkspaceSessionIndexDocument[]) {
      const updatedAt = now();
      const outcome = await options.service.publishBatch(
        documents.map((document) =>
          toPublishRequest(document, surface, scope, updatedAt),
        ),
      );
      if (outcome.status !== "published") {
        throw new Error(
          `Workspace session index batch was not committed: ${outcome.status}`,
        );
      }
    },
    async remove(sessionId: string) {
      await options.service.deleteSession({ sessionId, surface, scope });
    },
    async query(request) {
      const results = await options.service.recall({
        query: request.text,
        scopes: [scope],
        surfaces: [surface],
        limit: request.limit,
      });
      return results.map((result): WorkspaceSessionIndexCandidate => ({
        sessionId: result.sessionId,
        score: result.score,
        ...(result.startMessageIndex === undefined
          ? {}
          : { startMessageIndex: result.startMessageIndex }),
        ...(result.endMessageIndex === undefined
          ? {}
          : { endMessageIndex: result.endMessageIndex }),
      }));
    },
  };
}

function toPublishRequest(
  document: WorkspaceSessionIndexDocument,
  surface: string,
  scope: DerivedSessionScope,
  updatedAt: number,
): PublishDerivedSessionRequest {
  const title = indexableTitle(document.title);
  return {
    session: {
      sessionId: document.sessionId,
      surface,
      scope,
      title,
      createdAt: nonNegative(document.createdAt),
      lastActiveAt: nonNegative(document.lastActiveAt),
      messageCount: document.messageCount,
      sourceRevision: document.revision,
      summary: title,
      topics: [],
      decisions: [],
      openQuestions: [],
      durableCandidateHints: [],
      updatedAt,
    },
    chunks: document.chunks.map((chunk) => ({
      id: chunk.id,
      sessionId: document.sessionId,
      sourceMessageIds: [],
      startMessageIndex: chunk.startMessageIndex,
      endMessageIndex: chunk.endMessageIndex,
      sourceRevision: document.revision,
      summary: chunk.text,
      keywords: [],
      entities: [],
      createdAt: updatedAt,
      updatedAt,
    })),
  };
}

function indexableTitle(title: string): string {
  const bounded = title.trim().slice(0, MAX_TITLE_CHARS);
  return bounded && isWorkspaceHistoryIndexableText(bounded)
    ? bounded
    : UNTITLED;
}

function nonNegative(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}
