import { describe, expect, it } from "vitest";

import { InMemoryRetrievalRepository } from "../retrieval/InMemoryRetrievalRepository.js";
import {
  DerivedSessionRetrievalService,
  getDerivedSessionSourceId,
  type DerivedSessionChunk,
  type DerivedSessionSummary,
  type PublishDerivedSessionRequest,
} from "./DerivedSessionRetrievalService.js";

const globalScope = { kind: "global", id: "agentlink-user" } as const;

function session(
  overrides: Partial<DerivedSessionSummary> = {},
): DerivedSessionSummary {
  return {
    sessionId: "session-one",
    surface: "browser-ask-agent",
    scope: globalScope,
    title: "Retrieval design",
    createdAt: 1_000,
    lastActiveAt: 2_000,
    messageCount: 4,
    sourceRevision: "revision-one",
    summary: "We discussed shared lexical retrieval and source freshness.",
    topics: ["retrieval", "freshness"],
    decisions: ["Use one derived session source."],
    openQuestions: ["How should explicit transcript drill-in be budgeted?"],
    durableCandidateHints: [],
    updatedAt: 2_000,
    ...overrides,
  };
}

function chunk(
  overrides: Partial<DerivedSessionChunk> = {},
): DerivedSessionChunk {
  return {
    id: "session-one:2-3",
    sessionId: "session-one",
    sourceMessageIds: ["message-user", "message-assistant"],
    startMessageIndex: 2,
    endMessageIndex: 3,
    sourceRevision: "revision-one",
    summary:
      "The retrieval service should preserve canonical transcript ranges.",
    keywords: ["retrieval", "transcript"],
    entities: ["DerivedSessionRetrievalService"],
    createdAt: 1_500,
    updatedAt: 2_000,
    ...overrides,
  };
}

function publication(
  sessionOverrides: Partial<DerivedSessionSummary> = {},
  chunks: DerivedSessionChunk[] = [chunk()],
): PublishDerivedSessionRequest {
  const summary = session(sessionOverrides);
  return {
    session: summary,
    chunks: chunks.map((candidate) => ({
      ...candidate,
      sessionId: summary.sessionId,
      sourceRevision: summary.sourceRevision,
    })),
  };
}

function service() {
  const repository = new InMemoryRetrievalRepository({
    embeddingConfigured: false,
  });
  let publicationId = 0;
  return {
    repository,
    service: new DerivedSessionRetrievalService(repository, {
      createPublicationId: () => `publication-${++publicationId}`,
    }),
  };
}

describe("DerivedSessionRetrievalService", () => {
  it("publishes a session and its chunks atomically with exact provenance", async () => {
    const { repository, service: derivedSessions } = service();
    const request = publication();

    await expect(derivedSessions.publish(request)).resolves.toMatchObject({
      status: "published",
      recordsAdded: 3,
    });

    const sourceId = getDerivedSessionSourceId(request.session);
    const active = await repository.inspectSource(sourceId);
    expect(active).toMatchObject({
      source: {
        id: sourceId,
        namespace: "session",
        kind: "session",
        revision: { id: "revision-one" },
        metadata: {
          domain: "derived-session",
          sessionId: "session-one",
          surface: "browser-ask-agent",
          scopeKind: "global",
          scopeId: "agentlink-user",
          sourceRevision: "revision-one",
          chunkCount: 1,
        },
      },
    });

    const recalled = await derivedSessions.recall({
      query: "canonical transcript ranges",
      scopes: [globalScope],
      surfaces: ["browser-ask-agent"],
      minimumScore: 0,
      limit: 5,
    });
    expect(recalled).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "chunk",
          sessionId: "session-one",
          chunkId: "session-one:2-3",
          summary:
            "The retrieval service should preserve canonical transcript ranges.",
          sourceRevision: "revision-one",
          sourceMessageIds: ["message-user", "message-assistant"],
          startMessageIndex: 2,
          endMessageIndex: 3,
        }),
      ]),
    );
  });

  it("replaces one session generation without affecting other sessions", async () => {
    const { service: derivedSessions } = service();
    await derivedSessions.publish(publication());
    await derivedSessions.publish(
      publication(
        {
          sessionId: "session-two",
          sourceRevision: "revision-two",
          title: "Other session",
          summary: "A separate browser session discussed provider parity.",
          topics: ["providers"],
          updatedAt: 3_000,
        },
        [
          chunk({
            id: "session-two:0-1",
            summary: "Provider parity applies to retry and restore.",
            keywords: ["providers", "retry", "restore"],
            updatedAt: 3_000,
          }),
        ],
      ),
    );

    await derivedSessions.publish(
      publication(
        {
          sourceRevision: "revision-three",
          summary: "The updated session now focuses on cascade deletion.",
          topics: ["deletion"],
          updatedAt: 4_000,
        },
        [
          chunk({
            id: "session-one:4-5",
            summary: "Deletion must remove all derived chunks.",
            keywords: ["deletion", "cascade"],
            sourceRevision: "revision-three",
            updatedAt: 4_000,
          }),
        ],
      ),
    );

    const inspection = await derivedSessions.inspect({
      scopes: [globalScope],
      surfaces: ["browser-ask-agent"],
    });
    expect(inspection).toMatchObject({ sessionCount: 2, chunkCount: 2 });
    expect(
      inspection.sessions.map((entry) => [
        entry.sessionId,
        entry.sourceRevision,
        entry.summary,
      ]),
    ).toEqual([
      [
        "session-one",
        "revision-three",
        "The updated session now focuses on cascade deletion.",
      ],
      [
        "session-two",
        "revision-two",
        "A separate browser session discussed provider parity.",
      ],
    ]);

    const replacedSessionResults = (
      await derivedSessions.recall({
        query: "deletion cascade",
        scopes: [globalScope],
        minimumScore: 0,
        limit: 10,
      })
    ).filter((result) => result.sessionId === "session-one");
    expect(replacedSessionResults).not.toHaveLength(0);
    expect(
      replacedSessionResults.every(
        (result) =>
          result.sourceRevision === "revision-three" &&
          !result.summary.includes("source freshness") &&
          !result.summary.includes("canonical transcript ranges"),
      ),
    ).toBe(true);
    expect(
      (
        await derivedSessions.recall({
          query: "provider parity",
          scopes: [globalScope],
          minimumScore: 0,
          limit: 10,
        })
      ).some((result) => result.sessionId === "session-two"),
    ).toBe(true);
  });

  it("isolates scopes and surfaces and deduplicates overlapping filters", async () => {
    const { service: derivedSessions } = service();
    await derivedSessions.publish(publication());
    await derivedSessions.publish(
      publication({
        sessionId: "workspace-session",
        surface: "vscode",
        scope: { kind: "workspace", id: "project-one" },
        sourceRevision: "revision-workspace",
        title: "Workspace decisions",
        summary: "The workspace uses a source-neutral retrieval contract.",
        updatedAt: 3_000,
      }),
    );

    expect(
      await derivedSessions.recall({
        query: "source neutral retrieval",
        scopes: [globalScope, globalScope],
        surfaces: ["browser-ask-agent", "browser-ask-agent"],
        minimumScore: 0,
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId: "session-one",
          surface: "browser-ask-agent",
          scope: globalScope,
        }),
      ]),
    );
    expect(
      (
        await derivedSessions.recall({
          query: "source neutral retrieval",
          scopes: [globalScope],
          surfaces: ["browser-ask-agent"],
          minimumScore: 0,
        })
      ).some((result) => result.sessionId === "workspace-session"),
    ).toBe(false);

    await expect(
      derivedSessions.inspect({
        scopes: [globalScope, globalScope],
        surfaces: ["browser-ask-agent", "browser-ask-agent"],
      }),
    ).resolves.toMatchObject({ sessionCount: 1, chunkCount: 1 });
  });

  it("suppresses an active chunk when every source message is already visible", async () => {
    const { service: derivedSessions } = service();
    await derivedSessions.publish(publication());

    const visible = await derivedSessions.recall({
      query: "canonical transcript ranges",
      scopes: [globalScope],
      activeSessionId: "session-one",
      visibleMessageIds: ["message-user", "message-assistant"],
      minimumScore: 0,
      limit: 10,
    });
    expect(visible.some((result) => result.kind === "chunk")).toBe(false);
    expect(visible.some((result) => result.kind === "session")).toBe(true);

    const partial = await derivedSessions.recall({
      query: "canonical transcript ranges",
      scopes: [globalScope],
      activeSessionId: "session-one",
      visibleMessageIds: ["message-user"],
      minimumScore: 0,
      limit: 10,
    });
    expect(partial.some((result) => result.kind === "chunk")).toBe(true);
  });

  it("cascade-deletes one session and supports scoped clearing", async () => {
    const { repository, service: derivedSessions } = service();
    const first = publication();
    const second = publication({
      sessionId: "session-two",
      sourceRevision: "revision-two",
      summary: "A second session remains after the first is deleted.",
      updatedAt: 3_000,
    });
    await derivedSessions.publish(first);
    await derivedSessions.publish(second);

    await expect(
      derivedSessions.deleteSession({
        sessionId: first.session.sessionId,
        surface: first.session.surface,
        scope: first.session.scope,
        expectedRevision: first.session.sourceRevision,
      }),
    ).resolves.toBe("deleted");
    await expect(
      repository.inspectSource(getDerivedSessionSourceId(first.session)),
    ).resolves.toBeNull();
    await expect(derivedSessions.inspect()).resolves.toMatchObject({
      sessionCount: 1,
      chunkCount: 1,
    });

    await expect(
      derivedSessions.clearScope({
        scope: globalScope,
        surface: "browser-ask-agent",
      }),
    ).resolves.toMatchObject({ sourcesDeleted: 1, recordsRemoved: 3 });
    await expect(derivedSessions.inspect()).resolves.toEqual({
      sessions: [],
      sessionCount: 0,
      chunkCount: 0,
    });
  });

  it("rejects stale revisions without replacing the current projection", async () => {
    const { service: derivedSessions } = service();
    await derivedSessions.publish(
      publication({ sourceRevision: "revision-new", updatedAt: 4_000 }),
    );

    await expect(
      derivedSessions.publish(
        publication({
          sourceRevision: "revision-old",
          summary: "This stale summary must not replace current history.",
          updatedAt: 3_000,
        }),
      ),
    ).resolves.toMatchObject({ status: "stale_source" });
    await expect(derivedSessions.inspect()).resolves.toMatchObject({
      sessions: [
        expect.objectContaining({
          sourceRevision: "revision-new",
          summary:
            "We discussed shared lexical retrieval and source freshness.",
        }),
      ],
    });
  });

  it("imports multiple sessions atomically with a durable checkpoint and pre-import snapshot", async () => {
    const { service: derivedSessions } = service();
    const request = {
      sourceKey: "global:agentlink-user:browser-ask-agent-memory.json",
      sourceRevision: "legacy-json-revision",
      importerSchemaVersion: 1,
      observedAt: "2026-07-26T00:00:00.000Z",
      sessions: [
        publication(),
        publication({
          sessionId: "session-two",
          sourceRevision: "revision-two",
          title: "Second import",
          summary: "The second imported session discusses Browser parity.",
          updatedAt: 3_000,
        }),
      ],
    };

    const imported = await derivedSessions.importSessions(request);
    expect(imported).toMatchObject({
      status: "imported",
      checkpoint: {
        sourceKey: request.sourceKey,
        sourceRevision: request.sourceRevision,
        importerSchemaVersion: 1,
        status: "complete",
        importedSessionIds: ["session-one", "session-two"],
        snapshot: {
          label: `pre-import:${request.sourceKey}:${request.sourceRevision}`,
          sourceCount: 0,
          chunkCount: 0,
        },
      },
    });
    await expect(
      derivedSessions.getImportCheckpoint(request.sourceKey),
    ).resolves.toEqual(imported.checkpoint);
    await expect(derivedSessions.inspect()).resolves.toMatchObject({
      sessionCount: 2,
      chunkCount: 2,
    });

    await expect(derivedSessions.importSessions(request)).resolves.toEqual({
      status: "already-complete",
      checkpoint: imported.checkpoint,
    });
    await expect(derivedSessions.inspect()).resolves.toMatchObject({
      sessionCount: 2,
      chunkCount: 2,
    });
  });

  it("does not expose any imported session when an atomic import member is stale", async () => {
    const { service: derivedSessions } = service();
    await derivedSessions.publish(
      publication({
        sessionId: "session-current",
        sourceRevision: "current",
        updatedAt: 5_000,
      }),
    );

    await expect(
      derivedSessions.importSessions({
        sourceKey: "legacy-browser-json",
        sourceRevision: "legacy-source",
        importerSchemaVersion: 1,
        observedAt: "2026-07-26T00:00:00.000Z",
        sessions: [
          publication({
            sessionId: "session-new",
            sourceRevision: "new",
            updatedAt: 4_000,
          }),
          publication({
            sessionId: "session-current",
            sourceRevision: "stale",
            updatedAt: 3_000,
          }),
        ],
      }),
    ).rejects.toThrow("import batch was rejected");

    const inspection = await derivedSessions.inspect();
    expect(inspection.sessions.map((entry) => entry.sessionId)).toEqual([
      "session-current",
    ]);
    await expect(
      derivedSessions.getImportCheckpoint("legacy-browser-json"),
    ).resolves.toBeNull();
  });

  it("persists and replaces explicit missing and failed import states", async () => {
    const { service: derivedSessions } = service();
    const missing = {
      sourceKey: "legacy-browser-json",
      sourceRevision: "missing",
      importerSchemaVersion: 1,
      status: "missing" as const,
      updatedAt: "2026-07-26T00:00:00.000Z",
    };
    await expect(derivedSessions.recordImportState(missing)).resolves.toEqual(
      missing,
    );
    await expect(
      derivedSessions.getImportCheckpoint(missing.sourceKey),
    ).resolves.toEqual(missing);

    const failed = {
      ...missing,
      sourceRevision: "corrupt:abc123",
      status: "failed" as const,
      updatedAt: "2026-07-26T00:01:00.000Z",
      error: { code: "corrupt-json", message: "Legacy JSON is malformed" },
    };
    await expect(derivedSessions.recordImportState(failed)).resolves.toEqual(
      failed,
    );
    await expect(
      derivedSessions.getImportCheckpoint(failed.sourceKey),
    ).resolves.toEqual(failed);
  });

  it("fails closed on malformed, mismatched, and sensitive projections", async () => {
    const { service: derivedSessions } = service();

    await expect(
      derivedSessions.publish({
        session: session({ sessionId: "mismatch" }),
        chunks: [chunk({ sessionId: "other-session" })],
      }),
    ).rejects.toThrow("must share the source session ID");
    await expect(
      derivedSessions.publish(
        publication({
          sessionId: "secret-session",
          sourceRevision: "revision-secret",
          summary: "Use token ghp_abcdefghijklmnopqrstuvwxyz1234567890.",
          updatedAt: 5_000,
        }),
      ),
    ).rejects.toThrow("contains sensitive content");
    await expect(
      derivedSessions.recall({ query: "anything", scopes: [], limit: 1 }),
    ).rejects.toThrow("requires at least one scope");
    await expect(
      derivedSessions.recall({
        query: "anything",
        scopes: [globalScope],
        limit: 51,
      }),
    ).rejects.toThrow("integer from 1 to 50");
  });
});
