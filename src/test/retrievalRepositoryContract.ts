import type {
  RetrievalFingerprint,
  RetrievalPublicationRequest,
  RetrievalRepository,
  RetrievalSourceDocument,
  RetrievalSourceFreshness,
} from "../core/retrieval/contracts.js";
import { describe, expect, it } from "vitest";

export interface RetrievalRepositoryContractController {
  setSourceFreshness(
    sourceId: string,
    freshness: RetrievalSourceFreshness,
  ): void;
  setEmbeddingAvailable(available: boolean): void;
  setIndexAvailability(availability: {
    lexical?: boolean;
    scalar?: boolean;
    vector?: boolean;
    structural?: boolean;
  }): void;
}

export interface RetrievalRepositoryContractInstance {
  repository: RetrievalRepository;
  controller: RetrievalRepositoryContractController;
  cleanup?: () => Promise<void> | void;
}

export type RetrievalRepositoryContractFactory = () =>
  | RetrievalRepositoryContractInstance
  | Promise<RetrievalRepositoryContractInstance>;

const fingerprint: RetrievalFingerprint = {
  schemaVersion: 1,
  recordSchemaVersion: 1,
  relationSchemaVersion: 1,
  chunker: {
    id: "retrieval-repository-contract",
    version: 1,
    configurationHash: "retrieval-repository-contract-v1",
  },
  embedding: {
    provider: "contract",
    model: "contract-embedding",
    endpointContract: "contract-v1",
    dimensions: 3,
  },
};

const lexicalQuery = {
  text: "backend neutral retrieval",
  mode: "lexical" as const,
  limit: 10,
};

export function describeRetrievalRepositoryContract(
  name: string,
  factory: RetrievalRepositoryContractFactory,
): void {
  describe(`${name} retrieval repository contract`, () => {
    it("keeps prepared generations hidden until an atomic commit", async () => {
      await withRepository(factory, async (repository) => {
        const request = publication(
          "publication-1",
          "revision-1",
          "2026-07-25T00:00:00.000Z",
        );

        expect(await repository.preparePublication(request)).toEqual({
          publicationId: request.publicationId,
          sourceId: request.source.id,
          revisionId: request.source.revision.id,
          generation: request.generation,
          status: "prepared",
        });
        expect((await repository.query(lexicalQuery)).candidates).toEqual([]);
        expect(await repository.health()).toMatchObject({
          pendingPublications: 1,
          sourceCount: 0,
          chunkCount: 0,
          relationCount: 0,
        });
        expect(await repository.inspectSource(request.source.id)).toBeNull();

        expect(
          await repository.commitPublication(request.publicationId),
        ).toEqual({
          publicationId: request.publicationId,
          sourceId: request.source.id,
          revisionId: request.source.revision.id,
          generation: request.generation,
          status: "published",
          recordsAdded: 3,
          recordsRemoved: 0,
        });
        expect(
          (await repository.query(lexicalQuery)).candidates.map(
            (candidate) => candidate.chunk.id,
          ),
        ).toEqual(["chunk:revision-1"]);
        expect(await repository.health()).toMatchObject({
          pendingPublications: 0,
          sourceCount: 1,
          chunkCount: 1,
          relationCount: 1,
        });
        expect(await repository.inspectSource(request.source.id)).toEqual({
          source: request.source,
          generation: request.generation,
        });
      });
    });

    it("lists active sources through neutral filters", async () => {
      await withRepository(factory, async (repository) => {
        const session = publication(
          "list-session",
          "revision-session",
          "2026-07-25T00:00:00.000Z",
          {
            sourceId: "session:browser:one",
            namespace: "session",
            kind: "session",
            path: "session://browser/one",
            metadata: {
              domain: "derived-session",
              surface: "browser",
              scopeId: "agentlink-user",
            },
          },
        );
        const code = publication(
          "list-code",
          "revision-code",
          "2026-07-25T00:01:00.000Z",
          { sourceId: "source:code" },
        );
        await publish(repository, session);
        await publish(repository, code);

        expect(
          await repository.listSources({
            namespaces: ["session"],
            sourceKinds: ["session"],
            metadata: {
              domain: "derived-session",
              surface: "browser",
            },
          }),
        ).toEqual([
          {
            source: session.source,
            generation: session.generation,
          },
        ]);
        expect(
          await repository.listSources({ sourceIds: [code.source.id] }),
        ).toEqual([{ source: code.source, generation: code.generation }]);
      });
    });

    it("commits multiple prepared sources through one atomic visibility boundary", async () => {
      await withRepository(factory, async (repository) => {
        const first = publication(
          "batch-first",
          "revision-batch-first",
          "2026-07-25T00:00:00.000Z",
          { sourceId: "source:batch:first" },
        );
        const second = publication(
          "batch-second",
          "revision-batch-second",
          "2026-07-25T00:01:00.000Z",
          { sourceId: "source:batch:second" },
        );
        await repository.preparePublication(first);
        await repository.preparePublication(second);

        expect(
          await repository.commitPublicationBatch([
            first.publicationId,
            second.publicationId,
          ]),
        ).toMatchObject({
          status: "published",
          recordsAdded: 6,
          recordsRemoved: 0,
          publications: [
            { publicationId: first.publicationId, status: "published" },
            { publicationId: second.publicationId, status: "published" },
          ],
        });
        expect(
          (
            await repository.listSources({
              sourceIds: [first.source.id, second.source.id],
            })
          ).map(({ source }) => source.id),
        ).toEqual([first.source.id, second.source.id]);
        expect(await repository.health()).toMatchObject({
          pendingPublications: 0,
          sourceCount: 2,
        });
      });
    });

    it("rejects an invalid publication batch without exposing any member", async () => {
      await withRepository(factory, async (repository) => {
        const complete = publication(
          "batch-complete",
          "revision-batch-complete",
          "2026-07-25T00:00:00.000Z",
          { sourceId: "source:batch:complete" },
        );
        const incomplete = publication(
          "batch-incomplete",
          "revision-batch-incomplete",
          "2026-07-25T00:01:00.000Z",
          { sourceId: "source:batch:incomplete" },
        );
        incomplete.expectedChunkIds = ["chunk:missing"];
        await repository.preparePublication(complete);
        await repository.preparePublication(incomplete);

        expect(
          await repository.commitPublicationBatch([
            complete.publicationId,
            incomplete.publicationId,
          ]),
        ).toMatchObject({
          status: "rejected",
          recordsAdded: 0,
          recordsRemoved: 0,
          publications: [
            { publicationId: complete.publicationId, status: "published" },
            { publicationId: incomplete.publicationId, status: "incomplete" },
          ],
        });
        expect(await repository.listSources()).toEqual([]);
        expect(await repository.health()).toMatchObject({
          pendingPublications: 2,
          sourceCount: 0,
          chunkCount: 0,
        });
        expect(
          await repository.commitPublication(complete.publicationId),
        ).toMatchObject({ status: "published" });
        expect(
          await repository.abortPublication(incomplete.publicationId),
        ).toEqual({
          publicationId: incomplete.publicationId,
          status: "aborted",
        });
      });
    });

    it("aborts only the selected pending publication", async () => {
      await withRepository(factory, async (repository) => {
        const first = publication(
          "abort-first",
          "revision-abort-first",
          "2026-07-25T00:00:00.000Z",
        );
        const second = publication(
          "abort-second",
          "revision-abort-second",
          "2026-07-25T00:01:00.000Z",
          { sourceId: "source:second" },
        );
        await repository.preparePublication(first);
        await repository.preparePublication(second);

        expect(await repository.abortPublication(first.publicationId)).toEqual({
          publicationId: first.publicationId,
          status: "aborted",
        });
        expect(await repository.abortPublication(first.publicationId)).toEqual({
          publicationId: first.publicationId,
          status: "not_found",
        });
        expect(
          await repository.commitPublication(first.publicationId),
        ).toMatchObject({ status: "not_found" });
        expect(
          await repository.commitPublication(second.publicationId),
        ).toMatchObject({ status: "published" });
        expect(await repository.inspectSource(second.source.id)).toEqual({
          source: second.source,
          generation: second.generation,
        });
      });
    });

    it("rejects incomplete publication without changing visible records", async () => {
      await withRepository(factory, async (repository) => {
        const incomplete = publication(
          "incomplete",
          "revision-incomplete",
          "2026-07-25T00:00:00.000Z",
        );
        incomplete.expectedChunkIds = ["chunk:missing"];
        await repository.preparePublication(incomplete);

        expect(
          await repository.commitPublication(incomplete.publicationId),
        ).toMatchObject({
          status: "incomplete",
          recordsAdded: 0,
          recordsRemoved: 0,
        });
        expect((await repository.query(lexicalQuery)).candidates).toEqual([]);

        const complete = publication(
          incomplete.publicationId,
          incomplete.source.revision.id,
          incomplete.source.revision.observedAt,
        );
        await publish(repository, complete);
        expect((await repository.query(lexicalQuery)).candidates).toHaveLength(
          1,
        );
      });
    });

    it("keeps the old generation visible until replacement commit and rejects stale revisions", async () => {
      await withRepository(factory, async (repository) => {
        await publish(
          repository,
          publication("old", "revision-1", "2026-07-25T00:00:00.000Z", {
            chunkId: "chunk:old",
            content: "old visible generation",
          }),
        );
        const replacement = publication(
          "new",
          "revision-2",
          "2026-07-25T02:00:00.000Z",
          { chunkId: "chunk:new", content: "new visible generation" },
        );
        await repository.preparePublication(replacement);
        expect(
          (
            await repository.query({
              text: "visible generation",
              mode: "lexical",
              limit: 10,
            })
          ).candidates.map((candidate) => candidate.chunk.id),
        ).toEqual(["chunk:old"]);
        expect(
          await repository.commitPublication(replacement.publicationId),
        ).toMatchObject({
          status: "published",
          recordsRemoved: 3,
        });

        const stale = publication(
          "stale",
          "revision-stale",
          "2026-07-25T01:00:00.000Z",
        );
        await repository.preparePublication(stale);
        expect(
          await repository.commitPublication(stale.publicationId),
        ).toMatchObject({
          status: "stale_source",
          recordsAdded: 0,
          recordsRemoved: 0,
        });
        expect(
          (
            await repository.query({
              text: "visible generation",
              mode: "lexical",
              limit: 10,
            })
          ).candidates.map((candidate) => candidate.chunk.id),
        ).toEqual(["chunk:new"]);
      });
    });

    it("recovers abandoned prepared publications without exposing them", async () => {
      await withRepository(factory, async (repository) => {
        const abandoned = publication(
          "abandoned",
          "revision-abandoned",
          "2026-07-25T00:00:00.000Z",
        );
        await repository.preparePublication(abandoned);

        expect(await repository.recoverPublications()).toMatchObject({
          status: "repaired",
          abandonedPublications: 1,
        });
        expect(
          await repository.commitPublication(abandoned.publicationId),
        ).toMatchObject({
          status: "not_found",
        });
        expect((await repository.query(lexicalQuery)).candidates).toEqual([]);
      });
    });

    it("guards deletion and prevents stale revision resurrection", async () => {
      await withRepository(factory, async (repository) => {
        const current = publication(
          "current",
          "revision-2",
          "2026-07-25T02:00:00.000Z",
        );
        await publish(repository, current);

        expect(
          await repository.deleteSource({
            sourceId: current.source.id,
            expectedRevisionId: "wrong-revision",
          }),
        ).toMatchObject({ status: "stale_source", recordsRemoved: 0 });
        expect(
          await repository.deleteSource({
            sourceId: current.source.id,
            expectedRevisionId: current.source.revision.id,
          }),
        ).toMatchObject({ status: "deleted", recordsRemoved: 3 });

        for (const stale of [
          publication(
            "same",
            current.source.revision.id,
            current.source.revision.observedAt,
          ),
          publication("older", "revision-1", "2026-07-25T01:00:00.000Z"),
        ]) {
          await repository.preparePublication(stale);
          expect(
            await repository.commitPublication(stale.publicationId),
          ).toMatchObject({
            status: "stale_source",
            recordsAdded: 0,
          });
        }

        await publish(
          repository,
          publication("newer", "revision-3", "2026-07-25T03:00:00.000Z"),
        );
        expect((await repository.query(lexicalQuery)).candidates).toHaveLength(
          1,
        );
      });
    });

    it("resets one workspace code scope without touching other workspaces or namespaces", async () => {
      await withRepository(factory, async (repository) => {
        const tombstoned = publication(
          "workspace-one-old",
          "revision-workspace-one-old",
          "2026-07-25T00:00:00.000Z",
          {
            sourceId: "code:workspace-one:src/old.ts",
            path: "src/old.ts",
            chunkId: "chunk:workspace-one-old",
            metadata: { scopeType: "workspace", scopeId: "workspace-one" },
          },
        );
        const active = publication(
          "workspace-one-active",
          "revision-workspace-one-active",
          "2026-07-25T01:00:00.000Z",
          {
            sourceId: "code:workspace-one:src/active.ts",
            path: "src/active.ts",
            chunkId: "chunk:workspace-one-active",
            metadata: { scopeType: "workspace", scopeId: "workspace-one" },
          },
        );
        const otherWorkspace = publication(
          "workspace-two-active",
          "revision-workspace-two-active",
          "2026-07-25T01:00:00.000Z",
          {
            sourceId: "code:workspace-two:src/active.ts",
            path: "src/active.ts",
            chunkId: "chunk:workspace-two-active",
            metadata: { scopeType: "workspace", scopeId: "workspace-two" },
          },
        );
        const memory = publication(
          "workspace-one-memory",
          "revision-workspace-one-memory",
          "2026-07-25T01:00:00.000Z",
          {
            sourceId: "memory:workspace-one:preference",
            namespace: "memory",
            kind: "memory",
            path: "memory/preference",
            chunkId: "chunk:workspace-one-memory",
            metadata: { scopeType: "workspace", scopeId: "workspace-one" },
          },
        );
        await publish(repository, tombstoned);
        await repository.deleteSource({ sourceId: tombstoned.source.id });
        await publish(repository, active);
        await publish(repository, otherWorkspace);
        await publish(repository, memory);
        const pending = publication(
          "workspace-one-pending",
          "revision-workspace-one-pending",
          "2026-07-25T02:00:00.000Z",
          {
            sourceId: "code:workspace-one:src/pending.ts",
            path: "src/pending.ts",
            chunkId: "chunk:workspace-one-pending",
            metadata: { scopeType: "workspace", scopeId: "workspace-one" },
          },
        );
        await repository.preparePublication(pending);

        expect(
          await repository.deleteScope({
            namespaces: ["code"],
            metadata: { scopeId: "workspace-one" },
            sourceIdPrefix: "code:workspace-one:",
          }),
        ).toEqual({ sourcesDeleted: 1, recordsRemoved: 3 });
        expect(await repository.inspectSource(active.source.id)).toBeNull();
        expect(
          await repository.inspectSource(otherWorkspace.source.id),
        ).not.toBeNull();
        expect(await repository.inspectSource(memory.source.id)).not.toBeNull();
        expect(
          await repository.commitPublication(pending.publicationId),
        ).toMatchObject({ status: "not_found" });

        await publish(repository, tombstoned);
        expect(await repository.inspectSource(tombstoned.source.id)).toEqual({
          source: tombstoned.source,
          generation: tombstoned.generation,
        });
      });
    });

    it("filters current records and relations by neutral source identity", async () => {
      await withRepository(factory, async (repository) => {
        await publish(
          repository,
          publication("code", "revision-code", "2026-07-25T00:00:00.000Z"),
        );
        await publish(
          repository,
          publication("memory", "revision-memory", "2026-07-25T00:00:00.000Z", {
            sourceId: "source:memory",
            namespace: "memory",
            kind: "memory",
            path: "memory/project.md",
            chunkId: "chunk:memory",
          }),
        );

        const result = await repository.query({
          ...lexicalQuery,
          filters: {
            namespaces: ["code"],
            sourceKinds: ["file"],
            sourceIds: ["source:retrieval"],
            pathPrefix: "src/core",
            metadata: { language: "typescript" },
          },
          excludeSourceRevisionIds: ["revision-memory"],
        });
        expect(
          result.candidates.map((candidate) => candidate.source.id),
        ).toEqual(["source:retrieval"]);
        const structural = await repository.structuralSnapshot({
          expectedFingerprint: fingerprint,
        });
        expect(structural).toMatchObject({
          status: "ready",
          fingerprintDisposition: "compatible",
        });
        expect(
          structural.sources.map(({ source }) => source.id).sort(),
        ).toEqual(["source:memory", "source:retrieval"]);
        await expect(
          repository.structuralSnapshot({
            expectedFingerprint: {
              ...fingerprint,
              relationSchemaVersion: fingerprint.relationSchemaVersion + 1,
            },
          }),
        ).resolves.toEqual({
          status: "rebuild_required",
          fingerprintDisposition: "rebuild_required",
          sources: [],
          relations: [],
        });
        expect(
          await repository.structuralSnapshot({
            expectedFingerprint: fingerprint,
            filters: {
              namespaces: ["code"],
              sourceKinds: ["file"],
              pathPrefix: "src/core",
              metadata: { language: "typescript" },
            },
          }),
        ).toEqual({
          status: "ready",
          fingerprintDisposition: "compatible",
          sources: [
            expect.objectContaining({
              source: expect.objectContaining({ id: "source:retrieval" }),
              generation: "generation:code",
            }),
          ],
          relations: [
            expect.objectContaining({ sourceId: "source:retrieval" }),
          ],
        });
        expect(
          await repository.structuralSnapshot({
            expectedFingerprint: fingerprint,
            filters: {
              namespaces: ["code"],
              metadata: { language: "python" },
            },
          }),
        ).toEqual({
          status: "ready",
          fingerprintDisposition: "compatible",
          sources: [],
          relations: [],
        });
        expect(
          (await repository.relations())
            .map((relation) => relation.sourceId)
            .sort(),
        ).toEqual(["source:memory", "source:retrieval"]);
        expect(
          (await repository.relations(["source:retrieval"])).map(
            (relation) => relation.sourceId,
          ),
        ).toEqual(["source:retrieval"]);
      });
    });

    it("converges on one revision for equal-time commits in either order", async () => {
      const first = await factory();
      const second = await factory();
      try {
        await first.repository.migrate(fingerprint);
        await second.repository.migrate(fingerprint);
        const revisionA = publication(
          "publication-a",
          "revision-a",
          "2026-07-25T01:00:00.000Z",
          { content: "equal time winner" },
        );
        const revisionB = publication(
          "publication-b",
          "revision-b",
          "2026-07-25T02:00:00.000+01:00",
          { content: "equal time winner" },
        );

        await publish(first.repository, revisionA);
        await publish(first.repository, revisionB);
        await publish(second.repository, revisionB);
        await second.repository.preparePublication(revisionA);
        expect(
          await second.repository.commitPublication(revisionA.publicationId),
        ).toMatchObject({ status: "stale_source" });

        for (const repository of [first.repository, second.repository]) {
          expect(
            (
              await repository.query({
                text: "equal time winner",
                mode: "lexical",
                limit: 10,
              })
            ).candidates.map((candidate) => candidate.source.revision.id),
          ).toEqual(["revision-b"]);
        }
      } finally {
        await first.cleanup?.();
        await second.cleanup?.();
      }
    });

    it("suppresses changed, deleted, and unverified live sources", async () => {
      await withRepository(factory, async (repository, controller) => {
        const changed = publication(
          "changed",
          "revision-changed",
          "2026-07-25T00:00:00.000Z",
          { sourceId: "source:changed" },
        );
        const deleted = publication(
          "deleted",
          "revision-deleted",
          "2026-07-25T00:00:00.000Z",
          { sourceId: "source:deleted" },
        );
        const unverified = publication(
          "unverified",
          "revision-unverified",
          "2026-07-25T00:00:00.000Z",
          { sourceId: "source:unverified" },
        );
        await publish(repository, changed);
        await publish(repository, deleted);
        await publish(repository, unverified);
        controller.setSourceFreshness(changed.source.id, {
          status: "changed",
          currentRevision: {
            id: "revision-changed-current",
            contentHash: "hash:revision-changed-current",
            observedAt: "2026-07-25T01:00:00.000Z",
          },
        });
        controller.setSourceFreshness(deleted.source.id, { status: "deleted" });
        controller.setSourceFreshness(unverified.source.id, {
          status: "unverified",
          reason: "live source unavailable",
        });

        const result = await repository.query({
          ...lexicalQuery,
          freshness: "required",
        });
        expect(result.candidates).toEqual([]);
        expect(result.freshness).toEqual({
          staleSources: [
            {
              sourceId: "source:changed",
              path: "src/core/retrieval/contracts.ts",
              indexedRevision: changed.source.revision,
              status: "changed",
              currentRevision: {
                id: "revision-changed-current",
                contentHash: "hash:revision-changed-current",
                observedAt: "2026-07-25T01:00:00.000Z",
              },
            },
            {
              sourceId: "source:unverified",
              path: "src/core/retrieval/contracts.ts",
              indexedRevision: unverified.source.revision,
              status: "unverified",
              reason: "live source unavailable",
            },
          ],
          deletedSourceIds: ["source:deleted"],
        });
        expect(await repository.health()).toMatchObject({
          staleSourceCount: 2,
        });

        controller.setSourceFreshness(changed.source.id, { status: "current" });
        controller.setSourceFreshness(unverified.source.id, {
          status: "current",
        });
        const refreshed = await repository.query({
          ...lexicalQuery,
          freshness: "required",
        });
        expect(
          refreshed.candidates.map((candidate) => candidate.source.id).sort(),
        ).toEqual(["source:changed", "source:unverified"]);
        expect(await repository.health()).toMatchObject({
          staleSourceCount: 0,
        });
      });
    });

    it("clears stale observations after republish, delete, and restore", async () => {
      await withRepository(factory, async (repository, controller) => {
        const original = publication(
          "stale-lifecycle",
          "revision-1",
          "2026-07-25T00:00:00.000Z",
        );
        await publish(repository, original);
        const snapshot = await repository.createSnapshot("before-stale-reset");
        const snapshotId = snapshot.snapshot?.id;
        if (!snapshotId)
          throw new Error("Repository did not return a snapshot ID");
        controller.setSourceFreshness(original.source.id, {
          status: "changed",
          currentRevision: {
            id: "revision-live",
            contentHash: "hash:revision-live",
            observedAt: "2026-07-25T01:00:00.000Z",
          },
        });
        await repository.query({ ...lexicalQuery, freshness: "required" });
        expect(await repository.health()).toMatchObject({
          staleSourceCount: 1,
        });

        await publish(
          repository,
          publication(
            "stale-lifecycle-republish",
            "revision-2",
            "2026-07-25T02:00:00.000Z",
          ),
        );
        expect(await repository.health()).toMatchObject({
          staleSourceCount: 0,
        });

        await repository.query({ ...lexicalQuery, freshness: "required" });
        expect(await repository.health()).toMatchObject({
          staleSourceCount: 1,
        });
        await repository.deleteSource({ sourceId: original.source.id });
        expect(await repository.health()).toMatchObject({
          staleSourceCount: 0,
        });

        await repository.restoreSnapshot(snapshotId);
        await repository.query({ ...lexicalQuery, freshness: "required" });
        expect(await repository.health()).toMatchObject({
          staleSourceCount: 1,
        });
        await repository.restoreSnapshot(snapshotId);
        expect(await repository.health()).toMatchObject({
          staleSourceCount: 0,
        });
      });
    });

    it("reranks by source evidence and diversifies with backfill", async () => {
      await withRepository(factory, async (repository) => {
        const sourceA = publication(
          "source-a",
          "revision-a",
          "2026-07-25T00:00:00.000Z",
          {
            sourceId: "source:a",
            path: "src/other.ts",
            content: "shared retrieval evidence",
          },
        );
        sourceA.chunks = [
          {
            ...sourceA.chunks[0]!,
            id: "a-1",
            location: { path: "src/other.ts", startLine: 1, endLine: 10 },
          },
          {
            ...sourceA.chunks[0]!,
            id: "a-overlap",
            location: { path: "src/other.ts", startLine: 5, endLine: 15 },
          },
          {
            ...sourceA.chunks[0]!,
            id: "a-2",
            location: { path: "src/other.ts", startLine: 20, endLine: 25 },
          },
          {
            ...sourceA.chunks[0]!,
            id: "a-over-cap",
            location: { path: "src/other.ts", startLine: 30, endLine: 35 },
          },
        ];
        sourceA.expectedChunkIds = sourceA.chunks.map((chunk) => chunk.id);
        sourceA.relations[0]!.fromId = "a-1";
        const sourceB = publication(
          "source-b",
          "revision-b",
          "2026-07-25T00:00:00.000Z",
          {
            sourceId: "source:b",
            path: "src/SearchService.ts",
            chunkId: "b-backfill",
            content: "shared retrieval evidence",
          },
        );
        await publish(repository, sourceA);
        await publish(repository, sourceB);

        const sourceAware = await repository.query({
          text: "SearchService.ts",
          mode: "lexical",
          limit: 10,
        });
        expect(sourceAware.candidates[0]!.source.id).toBe("source:b");

        const diversified = await repository.query({
          text: "shared retrieval evidence",
          mode: "lexical",
          limit: 3,
        });
        expect(
          diversified.candidates.map((candidate) => candidate.chunk.id),
        ).toEqual(["a-1", "a-2", "b-backfill"]);
      });
    });

    it("transitions credential and index health without rebuilding", async () => {
      await withRepository(factory, async (repository, controller) => {
        await publish(
          repository,
          publication("health", "revision-health", "2026-07-25T00:00:00.000Z"),
        );
        const baseline = await repository.health();
        expect(baseline).toMatchObject({
          status: "ready",
          vector: "ready",
          embeddingCredentials: "available",
          reasons: [],
        });
        expect(await repository.lexicalReadiness()).toEqual({
          status: "ready",
        });

        controller.setEmbeddingAvailable(false);
        expect(await repository.lexicalReadiness()).toEqual({
          status: "ready",
        });
        expect(await repository.health()).toMatchObject({
          status: "degraded",
          vector: "unavailable",
          embeddingCredentials: "missing",
          reason: "missing_embeddings_auth",
          reasons: ["missing_embeddings_auth"],
          fingerprintDisposition: baseline.fingerprintDisposition,
          sourceCount: baseline.sourceCount,
        });
        controller.setEmbeddingAvailable(true);
        expect(await repository.health()).toMatchObject({
          status: "ready",
          vector: "ready",
          reasons: [],
        });

        controller.setIndexAvailability({ vector: false });
        expect(await repository.health()).toMatchObject({
          status: "degraded",
          reason: "vector_index_unavailable",
          reasons: ["vector_index_unavailable"],
        });
        controller.setIndexAvailability({
          lexical: false,
          scalar: false,
          vector: false,
        });
        const unavailableHealth = await repository.health();
        expect(unavailableHealth).toMatchObject({
          status: "unavailable",
          lexical: "unavailable",
          scalar: "unavailable",
          vector: "unavailable",
          reason: "lexical_index_unavailable",
          reasons: [
            "lexical_index_unavailable",
            "scalar_index_unavailable",
            "vector_index_unavailable",
          ],
        });
        expect(await repository.lexicalReadiness()).toEqual({
          status: "unavailable",
          reason: "lexical_index_unavailable",
        });
        expect(
          await repository.query({
            text: "backend neutral retrieval",
            embedding: [1, 0, 0],
            mode: "hybrid",
            limit: 10,
          }),
        ).toMatchObject({
          candidates: [],
          degradedReason: unavailableHealth.reason,
        });
      });
    });

    it("round-trips an isolated snapshot", async () => {
      await withRepository(factory, async (repository) => {
        const request = publication(
          "snapshot-source",
          "revision-snapshot",
          "2026-07-25T00:00:00.000Z",
        );
        await publish(repository, request);
        const created = await repository.createSnapshot("contract-snapshot");
        expect(created).toMatchObject({
          status: "created",
          snapshot: {
            label: "contract-snapshot",
            sourceCount: 1,
            chunkCount: 1,
            relationCount: 1,
          },
        });
        const snapshotId = created.snapshot?.id;
        if (!snapshotId)
          throw new Error("Repository did not return a snapshot ID");

        await repository.deleteSource({ sourceId: request.source.id });
        expect((await repository.query(lexicalQuery)).candidates).toEqual([]);
        expect(await repository.restoreSnapshot(snapshotId)).toMatchObject({
          status: "restored",
          snapshot: { id: snapshotId },
        });
        expect((await repository.query(lexicalQuery)).candidates).toHaveLength(
          1,
        );
        expect(await repository.inspectSource(request.source.id)).toEqual({
          source: request.source,
          generation: request.generation,
        });
      });
    });
  });
}

async function withRepository(
  factory: RetrievalRepositoryContractFactory,
  run: (
    repository: RetrievalRepository,
    controller: RetrievalRepositoryContractController,
  ) => Promise<void>,
): Promise<void> {
  const instance = await factory();
  try {
    const migration = await instance.repository.migrate(fingerprint);
    expect(["migrated", "up_to_date"]).toContain(migration.status);
    await run(instance.repository, instance.controller);
  } finally {
    await instance.cleanup?.();
  }
}

async function publish(
  repository: RetrievalRepository,
  request: RetrievalPublicationRequest,
): Promise<void> {
  await repository.preparePublication(request);
  expect(
    await repository.commitPublication(request.publicationId),
  ).toMatchObject({
    status: "published",
    sourceId: request.source.id,
    revisionId: request.source.revision.id,
  });
}

function publication(
  publicationId: string,
  revisionId: string,
  observedAt: string,
  overrides: {
    sourceId?: string;
    namespace?: RetrievalSourceDocument["namespace"];
    kind?: RetrievalSourceDocument["kind"];
    path?: string;
    chunkId?: string;
    content?: string;
    metadata?: RetrievalSourceDocument["metadata"];
  } = {},
): RetrievalPublicationRequest {
  const sourceId = overrides.sourceId ?? "source:retrieval";
  const generation = `generation:${publicationId}`;
  const path = overrides.path ?? "src/core/retrieval/contracts.ts";
  const content = overrides.content ?? "backend neutral retrieval contract";
  const chunkId = overrides.chunkId ?? `chunk:${revisionId}`;
  const source: RetrievalSourceDocument = {
    id: sourceId,
    namespace: overrides.namespace ?? "code",
    kind: overrides.kind ?? "file",
    revision: {
      id: revisionId,
      contentHash: `hash:${revisionId}`,
      observedAt,
    },
    path,
    content,
    metadata: overrides.metadata ?? { language: "typescript" },
  };
  const relationId = `relation:${publicationId}`;
  return {
    publicationId,
    generation,
    source,
    chunks: [
      {
        id: chunkId,
        sourceId,
        revisionId,
        generation,
        content,
        embedding: [1, 0, 0],
        location: { path, startLine: 1, endLine: 1 },
        metadata: { language: "typescript" },
      },
    ],
    relations: [
      {
        id: relationId,
        sourceId,
        revisionId,
        generation,
        fromId: chunkId,
        toId: `symbol:${sourceId}`,
        kind: "declares",
        metadata: {},
      },
    ],
    expectedChunkIds: [chunkId],
    expectedRelationIds: [relationId],
  };
}
