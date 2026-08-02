import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  CODE_INDEX_WRITER_FENCED_ERROR,
  acquireCodeIndexWriterLease,
} from "../../indexer/codeIndexWriterLease.js";
import type {
  RetrievalFingerprint,
  RetrievalPublicationRequest,
  RetrievalSourceFreshness,
} from "../../core/retrieval/contracts.js";
import { connect, makeArrowTable } from "@lancedb/lancedb";
import { describe, expect, it } from "vitest";
import {
  retrievalChunkSchema,
  retrievalRelationSchema,
} from "./lanceDbSchemas.js";

import { LanceDbRetrievalRepository } from "./LanceDbRetrievalRepository.js";
import { describeRetrievalRepositoryContract } from "../../test/retrievalRepositoryContract.js";
import { withRetrievalStoreLock } from "./retrievalStoreLock.js";

const fingerprint: RetrievalFingerprint = {
  schemaVersion: 1,
  recordSchemaVersion: 1,
  relationSchemaVersion: 1,
  chunker: {
    id: "lancedb-contract",
    version: 1,
    configurationHash: "lancedb-contract-v1",
  },
  embedding: {
    provider: "contract",
    model: "contract-embedding",
    endpointContract: "contract-v1",
    dimensions: 3,
  },
};

describeRetrievalRepositoryContract("LanceDbRetrievalRepository", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "agentlink-lancedb-retrieval-contract-"),
  );
  const freshness = new Map<string, RetrievalSourceFreshness>();
  const repository = new LanceDbRetrievalRepository({
    root,
    embeddingDimensions: 3,
    freshnessVerifier: {
      verify: async (source) =>
        freshness.get(source.id) ?? { status: "current" },
    },
  });
  return {
    repository,
    controller: {
      setSourceFreshness(sourceId, value) {
        freshness.set(sourceId, value);
      },
      setEmbeddingAvailable(available) {
        repository.setEmbeddingAvailable(available);
      },
      setIndexAvailability(availability) {
        repository.setIndexAvailability(availability);
      },
    },
    cleanup: async () => {
      await repository.close();
      await fs.rm(root, { recursive: true, force: true });
    },
  };
});

describe("LanceDbRetrievalRepository persistence", () => {
  it("rejects mutations after its code-index writer lease is displaced", async () => {
    await withStore(async (root) => {
      const firstLease = await acquireCodeIndexWriterLease({
        storeRoot: root,
        workspaceScopeId: "workspace:test",
        ownerId: "worker:first",
        protocolVersion: "v4",
      });
      const repository = new LanceDbRetrievalRepository({
        root,
        embeddingDimensions: 3,
        deferNativeIndexRefresh: true,
        codeIndexWriterLease: firstLease,
      });
      try {
        await repository.migrate(fingerprint);
        await acquireCodeIndexWriterLease({
          storeRoot: root,
          workspaceScopeId: "workspace:test",
          ownerId: "worker:successor",
          protocolVersion: "v4",
          options: { isOwnerAlive: () => false },
        });

        await expect(
          repository.deleteSourceIdPrefix("code:workspace:test:"),
        ).rejects.toThrow(CODE_INDEX_WRITER_FENCED_ERROR);
      } finally {
        await repository.close();
      }
    });
  });

  it("reports a never-migrated store as missing", async () => {
    await withStore(async (root) => {
      const repository = new LanceDbRetrievalRepository({
        root,
        embeddingDimensions: 3,
      });
      try {
        expect(await repository.health()).toMatchObject({
          status: "unavailable",
          reason: "missing_index",
          fingerprintDisposition: "initialize",
        });
      } finally {
        await repository.close();
      }
    });
  });

  it("probes lexical readiness without creating a missing store or lock", async () => {
    const parent = await fs.mkdtemp(
      path.join(os.tmpdir(), "agentlink-lancedb-readiness-"),
    );
    const root = path.join(parent, "missing-store");
    const repository = new LanceDbRetrievalRepository({ root });
    try {
      expect(await repository.lexicalReadiness()).toEqual({
        status: "unavailable",
        reason: "missing_index",
      });
      expect(repository.metrics()).toEqual({
        sourcesScanned: 0,
        sourcesPublished: 0,
        sourcesDeleted: 0,
        recordsAdded: 0,
        recordsRemoved: 0,
        queries: 0,
        lexicalQueries: 0,
        vectorQueries: 0,
        hybridQueries: 0,
        recoveries: 0,
        snapshotsCreated: 0,
        snapshotsRestored: 0,
        repairs: 0,
        optimizations: 0,
      });
      await expect(fs.stat(root)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.stat(`${root}.lock`)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await repository.close();
      await fs.rm(parent, { recursive: true, force: true });
    }
  });

  it("rehydrates active records, metrics, and snapshots after reopening", async () => {
    await withStore(async (root) => {
      const first = repository(root);
      await first.migrate(fingerprint);
      const request = publication("persisted", "revision-1");
      await first.preparePublication(request);
      await first.commitPublication(request.publicationId);
      const snapshot = await first.createSnapshot("persisted-snapshot");
      const snapshotId = snapshot.snapshot?.id;
      if (!snapshotId) throw new Error("Snapshot ID was not returned");
      expect(first.metrics()).toMatchObject({
        sourcesScanned: 1,
        sourcesPublished: 1,
        snapshotsCreated: 1,
      });
      await first.close();

      const reopened = repository(root);
      try {
        expect(await reopened.inspectFingerprint(fingerprint)).toBe(
          "compatible",
        );
        expect(
          (
            await reopened.query({
              text: "durable retrieval",
              mode: "lexical",
              limit: 10,
            })
          ).candidates.map((candidate) => candidate.chunk.id),
        ).toEqual(["chunk:revision-1"]);
        expect(reopened.metrics()).toMatchObject({
          sourcesScanned: 1,
          sourcesPublished: 1,
          snapshotsCreated: 1,
          queries: 1,
        });
        await reopened.deleteSource({ sourceId: request.source.id });
        expect(await reopened.restoreSnapshot(snapshotId)).toMatchObject({
          status: "restored",
          snapshot: { id: snapshotId, label: "persisted-snapshot" },
        });
        expect(
          (
            await reopened.query({
              text: "durable retrieval",
              mode: "lexical",
              limit: 10,
            })
          ).candidates,
        ).toHaveLength(1);
      } finally {
        await reopened.close();
      }
    });
  });

  it("recovers a prepared publication after reopening without exposing it", async () => {
    await withStore(async (root) => {
      const first = repository(root);
      await first.migrate(fingerprint);
      const request = publication("pending", "revision-pending");
      await first.preparePublication(request);
      await first.close();

      const reopened = repository(root);
      try {
        expect(await reopened.health()).toMatchObject({
          pendingPublications: 1,
          sourceCount: 0,
          chunkCount: 0,
        });
        expect(await reopened.recoverPublications()).toMatchObject({
          status: "repaired",
          abandonedPublications: 1,
        });
        expect(
          await reopened.commitPublication(request.publicationId),
        ).toMatchObject({ status: "not_found" });
      } finally {
        await reopened.close();
      }
    });
  });

  it("persists deletion tombstones across reopening", async () => {
    await withStore(async (root) => {
      const first = repository(root);
      await first.migrate(fingerprint);
      const current = publication("current", "revision-2", {
        observedAt: "2026-07-25T02:00:00.000Z",
      });
      await first.preparePublication(current);
      await first.commitPublication(current.publicationId);
      await first.deleteSource({ sourceId: current.source.id });
      await first.close();

      const reopened = repository(root);
      try {
        const stale = publication("stale", "revision-1", {
          observedAt: "2026-07-25T01:00:00.000Z",
        });
        await reopened.preparePublication(stale);
        expect(
          await reopened.commitPublication(stale.publicationId),
        ).toMatchObject({
          status: "stale_source",
          recordsAdded: 0,
        });
      } finally {
        await reopened.close();
      }
    });
  });

  it("keeps credential-free lexical retrieval healthy with nullable vectors", async () => {
    await withStore(async (root) => {
      const repository = new LanceDbRetrievalRepository({ root });
      const lexicalFingerprint: RetrievalFingerprint = {
        ...fingerprint,
        embedding: null,
      };
      const request = publication("lexical-only", "revision-lexical");
      request.chunks[0]!.embedding = null;
      try {
        await repository.migrate(lexicalFingerprint);
        await repository.preparePublication(request);
        await repository.commitPublication(request.publicationId);
        expect(await repository.health()).toMatchObject({
          status: "ready",
          lexical: "ready",
          vector: "not_configured",
          embeddingCredentials: "not_required",
        });
        expect(
          (
            await repository.query({
              text: "durable retrieval",
              mode: "lexical",
              limit: 10,
            })
          ).candidates.map((candidate) => candidate.chunk.id),
        ).toEqual(["chunk:revision-lexical"]);
      } finally {
        await repository.close();
      }
    });
  });

  it("keeps the lexical winner when hybrid retrieval includes null vectors", async () => {
    await withStore(async (root) => {
      const repository = new LanceDbRetrievalRepository({
        root,
        embeddingDimensions: 3,
      });
      const request = publication("mixed", "revision-mixed");
      request.chunks = [
        {
          ...request.chunks[0]!,
          id: "chunk:lexical-winner",
          content: "durable retrieval exact lexical winner",
          embedding: null,
        },
        {
          ...request.chunks[0]!,
          id: "chunk:vector-only",
          content: "unrelated vector candidate",
          embedding: [1, 0, 0],
        },
      ];
      request.expectedChunkIds = request.chunks.map((chunk) => chunk.id);
      request.relations = [];
      request.expectedRelationIds = [];
      try {
        await repository.migrate(fingerprint);
        await repository.preparePublication(request);
        await repository.commitPublication(request.publicationId);
        const lexical = await repository.query({
          text: "durable retrieval exact lexical winner",
          mode: "lexical",
          limit: 2,
        });
        const hybrid = await repository.query({
          text: "durable retrieval exact lexical winner",
          embedding: [1, 0, 0],
          mode: "hybrid",
          limit: 2,
        });
        expect(lexical.candidates[0]?.chunk.id).toBe("chunk:lexical-winner");
        expect(hybrid.candidates[0]?.chunk.id).toBe("chunk:lexical-winner");
      } finally {
        await repository.close();
      }
    });
  });

  it("degrades unindexed queries on oversized stores instead of hydrating them", async () => {
    await withStore(async (root) => {
      const repository = new LanceDbRetrievalRepository({
        root,
        embeddingDimensions: 3,
        deferNativeIndexRefresh: true,
        maxUnindexedQueryChunks: 2,
      });
      const request = publication("oversized", "revision-oversized");
      request.chunks = [0, 1, 2].map((index) => ({
        ...request.chunks[0]!,
        id: `chunk:oversized-${index}`,
        content: `durable retrieval state ${index}`,
      }));
      request.expectedChunkIds = request.chunks.map((chunk) => chunk.id);
      request.relations = [];
      request.expectedRelationIds = [];
      try {
        await repository.migrate(fingerprint);
        await repository.preparePublication(request);
        await repository.commitPublication(request.publicationId);
        const result = await repository.query({
          text: "durable retrieval",
          mode: "lexical",
          limit: 10,
        });
        expect(result.candidates).toEqual([]);
        expect(result.degradedReason).toBe("lexical_index_unavailable");
        expect(repository.metrics().queries).toBe(1);
      } finally {
        await repository.close();
      }
    });
  });

  it("serves oversized indexed stores through bounded native candidates", async () => {
    await withStore(async (root) => {
      const repository = new LanceDbRetrievalRepository({
        root,
        embeddingDimensions: 3,
        maxUnindexedQueryChunks: 2,
      });
      const request = publication("indexed-large", "revision-indexed-large");
      request.chunks = [0, 1, 2].map((index) => ({
        ...request.chunks[0]!,
        id: `chunk:indexed-large-${index}`,
        content: `durable retrieval state ${index}`,
        location: {
          path: "src/storage/retrieval/example.ts",
          startLine: index * 10 + 1,
          endLine: index * 10 + 5,
        },
      }));
      request.expectedChunkIds = request.chunks.map((chunk) => chunk.id);
      request.relations = [];
      request.expectedRelationIds = [];
      try {
        await repository.migrate(fingerprint);
        await repository.preparePublication(request);
        await repository.commitPublication(request.publicationId);
        const result = await repository.query({
          text: "durable retrieval",
          mode: "lexical",
          limit: 10,
          diversity: { maxPerSource: 3, collapseOverlaps: false },
        });
        expect(result.degradedReason).toBeUndefined();
        expect(
          result.candidates.map((candidate) => candidate.chunk.id).sort(),
        ).toEqual([
          "chunk:indexed-large-0",
          "chunk:indexed-large-1",
          "chunk:indexed-large-2",
        ]);
      } finally {
        await repository.close();
      }
    });
  });

  it("surfaces actionable native index creation failures", async () => {
    await withStore(async (root) => {
      const repository = new LanceDbRetrievalRepository({
        root,
        embeddingDimensions: 3,
        indexOperations: {
          async createLexical() {
            throw new Error("fixture FTS build failed");
          },
          async createScalar() {},
          async validateVector() {},
        },
      });
      try {
        await repository.migrate(fingerprint);
        expect(await repository.health()).toMatchObject({
          status: "degraded",
          lexical: "unavailable",
          reason: "lexical_index_unavailable",
          details: {
            lexical_index_unavailable: "fixture FTS build failed",
          },
        });
      } finally {
        await repository.close();
      }
    });
  });

  it("refreshes deferred native indexes without compacting the store", async () => {
    await withStore(async (root) => {
      let lexicalRefreshes = 0;
      const repository = new LanceDbRetrievalRepository({
        root,
        embeddingDimensions: 3,
        deferNativeIndexRefresh: true,
        indexOperations: {
          async createLexical() {
            lexicalRefreshes += 1;
          },
          async createScalar() {},
          async validateVector() {},
        },
      });
      const request = publication("deferred", "revision-deferred");
      try {
        await repository.migrate(fingerprint);
        await repository.preparePublication(request);
        await repository.commitPublication(request.publicationId);

        expect(await repository.lexicalReadiness()).toMatchObject({
          status: "unavailable",
          reason: "lexical_index_unavailable",
          detail: "Native indexes require refresh",
        });
        expect(await repository.health()).toMatchObject({
          status: "unavailable",
          lexical: "unavailable",
        });

        await repository.refreshNativeIndexes();

        expect(lexicalRefreshes).toBe(1);
        expect(await repository.lexicalReadiness()).toEqual({
          status: "ready",
        });
        expect(repository.metrics().optimizations).toBe(0);
      } finally {
        await repository.close();
      }
    });
  });

  it("deletes an owned source prefix without hydrating filtered source payloads", async () => {
    await withStore(async (root) => {
      const repository = new LanceDbRetrievalRepository({
        root,
        embeddingDimensions: 3,
        deferNativeIndexRefresh: true,
      });
      const owned = publication("owned-prefix", "revision-owned-prefix", {
        sourceId: "code:workspace_%:owned.ts",
      });
      const neighbor = publication(
        "neighbor-prefix",
        "revision-neighbor-prefix",
        {
          sourceId: "code:workspace-A:neighbor.ts",
        },
      );
      try {
        await repository.migrate(fingerprint);
        await repository.preparePublicationBatch([owned, neighbor]);
        await repository.commitPublicationBatch([
          owned.publicationId,
          neighbor.publicationId,
        ]);
        await repository.refreshNativeIndexes();

        await expect(
          repository.deleteSourceIdPrefix("code:workspace_%:"),
        ).resolves.toEqual({ sourcesDeleted: 1, recordsRemoved: 3 });
        expect(await repository.inspectSource(owned.source.id)).toBeNull();
        expect(
          await repository.inspectSource(neighbor.source.id),
        ).not.toBeNull();
        expect(await repository.lexicalReadiness()).toMatchObject({
          status: "unavailable",
          detail: "Native indexes require refresh",
        });
      } finally {
        await repository.close();
      }
    });
  });

  it("defers native index refresh across source deletion", async () => {
    await withStore(async (root) => {
      let lexicalRefreshes = 0;
      const repository = new LanceDbRetrievalRepository({
        root,
        embeddingDimensions: 3,
        deferNativeIndexRefresh: true,
        indexOperations: {
          async createLexical() {
            lexicalRefreshes += 1;
          },
          async createScalar() {},
          async validateVector() {},
        },
      });
      const request = publication(
        "delete-deferred",
        "revision-delete-deferred",
      );
      try {
        await repository.migrate(fingerprint);
        await repository.preparePublication(request);
        await repository.commitPublication(request.publicationId);
        await repository.refreshNativeIndexes();
        expect(lexicalRefreshes).toBe(1);

        await expect(
          repository.deleteSource({
            sourceId: request.source.id,
            expectedRevisionId: request.source.revision.id,
          }),
        ).resolves.toMatchObject({ status: "deleted" });
        expect(lexicalRefreshes).toBe(1);
        expect(await repository.lexicalReadiness()).toMatchObject({
          status: "unavailable",
          detail: "Native indexes require refresh",
        });

        await repository.refreshNativeIndexes();
        expect(lexicalRefreshes).toBe(2);
        expect(await repository.lexicalReadiness()).toEqual({
          status: "ready",
        });
      } finally {
        await repository.close();
      }
    });
  });

  it("preserves deferred native indexes during compatible reopen migration", async () => {
    await withStore(async (root) => {
      const first = new LanceDbRetrievalRepository({
        root,
        embeddingDimensions: 3,
        deferNativeIndexRefresh: true,
      });
      const request = publication("interrupted", "revision-interrupted");
      await first.migrate(fingerprint);
      await first.preparePublication(request);
      await first.commitPublication(request.publicationId);
      await first.close();

      let lexicalRefreshes = 0;
      const reopened = new LanceDbRetrievalRepository({
        root,
        embeddingDimensions: 3,
        deferNativeIndexRefresh: true,
        indexOperations: {
          async createLexical() {
            lexicalRefreshes += 1;
          },
          async createScalar() {},
          async validateVector() {},
        },
      });
      try {
        expect(await reopened.lexicalReadiness()).toMatchObject({
          status: "unavailable",
          reason: "lexical_index_unavailable",
        });
        expect(await reopened.migrate(fingerprint)).toMatchObject({
          status: "up_to_date",
        });
        expect(lexicalRefreshes).toBe(0);
        expect(await reopened.lexicalReadiness()).toMatchObject({
          status: "unavailable",
          detail: "Native indexes require refresh",
        });
        await reopened.refreshNativeIndexes();
        expect(lexicalRefreshes).toBe(1);
        expect(await reopened.lexicalReadiness()).toEqual({ status: "ready" });
      } finally {
        await reopened.close();
      }
    });
  });

  it("serves committed reads while index maintenance holds the writer lock", async () => {
    await withStore(async (root) => {
      const writer = repository(root);
      const request = publication(
        "concurrent-read",
        "revision-concurrent-read",
      );
      await writer.migrate(fingerprint);
      await writer.preparePublication(request);
      await writer.commitPublication(request.publicationId);
      await writer.close();

      let releaseMaintenance!: () => void;
      const maintenanceReleased = new Promise<void>((resolve) => {
        releaseMaintenance = resolve;
      });
      let maintenanceStarted!: () => void;
      const maintenanceWasStarted = new Promise<void>((resolve) => {
        maintenanceStarted = resolve;
      });
      const maintenance = withRetrievalStoreLock(root, async () => {
        maintenanceStarted();
        await maintenanceReleased;
      });
      await maintenanceWasStarted;

      const reader = repository(root);
      try {
        const reads = Promise.all([
          reader.inspectFingerprint(fingerprint),
          reader.structuralSnapshot({ expectedFingerprint: fingerprint }),
          reader.lexicalReadiness(),
          reader.health(),
          reader.query({
            text: "durable retrieval",
            mode: "lexical",
            limit: 10,
          }),
        ]);
        const [disposition, structural, readiness, health, query] =
          await Promise.race([
            reads,
            new Promise<never>((_, reject) => {
              const timeout = setTimeout(
                () =>
                  reject(new Error("concurrent reads blocked on writer lock")),
                1_000,
              );
              timeout.unref();
            }),
          ]);

        expect(disposition).toBe("compatible");
        expect(structural).toMatchObject({
          status: "ready",
          sources: [{ source: { id: request.source.id } }],
        });
        expect(readiness).toEqual({ status: "ready" });
        expect(health).toMatchObject({
          status: "ready",
          sourceCount: 1,
          chunkCount: 1,
        });
        expect(query.candidates.map((candidate) => candidate.chunk.id)).toEqual(
          [request.chunks[0]!.id],
        );
        expect(reader.metrics()).toMatchObject({
          queries: 1,
          lexicalQueries: 1,
        });

        releaseMaintenance();
        await maintenance;
        await reader.query({
          text: "durable retrieval",
          mode: "lexical",
          limit: 10,
        });
        expect(reader.metrics()).toMatchObject({
          queries: 2,
          lexicalQueries: 2,
        });
        await reader.close();

        const reopened = repository(root);
        try {
          await reopened.listSources();
          expect(reopened.metrics()).toMatchObject({
            queries: 2,
            lexicalQueries: 2,
          });
        } finally {
          await reopened.close();
        }
      } finally {
        releaseMaintenance();
        await maintenance;
        await reader.close();
      }
    });
  });

  it("serializes close behind in-flight work and rejects later operations", async () => {
    await withStore(async (root) => {
      let releaseIndex!: () => void;
      const indexReleased = new Promise<void>((resolve) => {
        releaseIndex = resolve;
      });
      let indexStarted!: () => void;
      const indexWasStarted = new Promise<void>((resolve) => {
        indexStarted = resolve;
      });
      const repository = new LanceDbRetrievalRepository({
        root,
        embeddingDimensions: 3,
        indexOperations: {
          async createLexical() {
            indexStarted();
            await indexReleased;
          },
          async createScalar() {},
          async validateVector() {},
        },
      });
      const migration = repository.migrate(fingerprint);
      await indexWasStarted;
      let closed = false;
      const closing = repository.close().then(() => {
        closed = true;
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      expect(closed).toBe(false);
      releaseIndex();
      await migration;
      await closing;
      await expect(repository.health()).rejects.toThrow(
        "retrieval_store_closed",
      );
    });
  });

  it("does not sweep generations while an activation may still be in flight", async () => {
    await withStore(async (root) => {
      const seeded = repository(root);
      const request = publication("sweep", "revision-sweep");
      await seeded.migrate(fingerprint);
      await seeded.preparePublication(request);
      await seeded.commitPublication(request.publicationId);
      await seeded.close();

      // These rows can be newly copied by an activation that has not yet
      // advanced its source pointer, so optimize must leave them untouched.
      const connection = await connect(root, { readConsistencyInterval: 0 });
      const chunks = await connection.openTable("retrieval_chunks");
      const staleChunk = {
        ...request.chunks[0]!,
        id: "chunk:stale",
        generation: "generation:stale",
      };
      await chunks.add(
        makeArrowTable(
          [
            {
              chunk_id: staleChunk.id,
              source_id: request.source.id,
              revision_id: request.source.revision.id,
              generation: "generation:stale",
              search_text: staleChunk.content,
              embedding: [0, 1, 0],
              payload_json: JSON.stringify(staleChunk),
            },
            {
              chunk_id: "chunk:ghost",
              source_id: "source:ghost",
              revision_id: "revision-ghost",
              generation: "generation:ghost",
              search_text: "ghost",
              embedding: [0, 0, 1],
              payload_json: JSON.stringify({
                ...staleChunk,
                id: "chunk:ghost",
                sourceId: "source:ghost",
              }),
            },
          ],
          { schema: retrievalChunkSchema(3) },
        ),
      );
      const relations = await connection.openTable("retrieval_relations");
      await relations.add(
        makeArrowTable(
          [
            {
              relation_id: "relation:stale",
              source_id: request.source.id,
              revision_id: request.source.revision.id,
              generation: "generation:stale",
              payload_json: JSON.stringify({
                ...request.relations[0]!,
                id: "relation:stale",
                generation: "generation:stale",
              }),
            },
          ],
          { schema: retrievalRelationSchema() },
        ),
      );
      chunks.close();
      relations.close();
      connection.close();

      const swept = repository(root);
      try {
        await swept.migrate(fingerprint);
        const optimized = await swept.optimize();
        expect(optimized.staleRecordsRemoved).toBeUndefined();

        const verify = await connect(root, { readConsistencyInterval: 0 });
        const verifyChunks = await verify.openTable("retrieval_chunks");
        const verifyRelations = await verify.openTable("retrieval_relations");
        const chunkRows = (await verifyChunks.query().toArray()).map(
          (row: { toJSON(): unknown }) => row.toJSON(),
        ) as Array<{ chunk_id: string }>;
        const relationRows = (await verifyRelations.query().toArray()).map(
          (row: { toJSON(): unknown }) => row.toJSON(),
        ) as Array<{ relation_id: string }>;
        expect(chunkRows.map((row) => row.chunk_id)).toEqual(
          expect.arrayContaining([
            "chunk:revision-sweep",
            "chunk:stale",
            "chunk:ghost",
          ]),
        );
        expect(relationRows.map((row) => row.relation_id)).toEqual(
          expect.arrayContaining(["relation:revision-sweep", "relation:stale"]),
        );
        verifyChunks.close();
        verifyRelations.close();
        verify.close();
      } finally {
        await swept.close();
      }
    });
  });

  it("compacts fragmented chunk writes", async () => {
    await withStore(async (root) => {
      const repository = new LanceDbRetrievalRepository({
        root,
        embeddingDimensions: 3,
      });
      const request = publication("fragmented", "revision-fragmented");
      request.chunks = Array.from({ length: 700 }, (_, index) => ({
        ...request.chunks[0]!,
        id: `chunk:fragmented:${index}`,
        content: `fragmented durable retrieval ${index}`,
        embedding: index % 5 === 0 ? null : [1, 0, 0],
      }));
      request.expectedChunkIds = request.chunks.map((chunk) => chunk.id);
      request.relations = [];
      request.expectedRelationIds = [];
      try {
        await repository.migrate(fingerprint);
        await repository.preparePublication(request);
        await repository.commitPublication(request.publicationId);
        const optimized = await repository.optimize();
        expect(optimized).toMatchObject({ status: "optimized" });
        expect(optimized.recordsCompacted).toBeGreaterThan(0);
      } finally {
        await repository.close();
      }
    });
  });
});

function repository(root: string): LanceDbRetrievalRepository {
  return new LanceDbRetrievalRepository({
    root,
    embeddingDimensions: 3,
  });
}

async function withStore(run: (root: string) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "agentlink-lancedb-retrieval-persistence-"),
  );
  try {
    await run(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

function publication(
  publicationId: string,
  revisionId: string,
  options: { observedAt?: string; sourceId?: string } = {},
): RetrievalPublicationRequest {
  const sourceId = options.sourceId ?? "source:durable";
  const generation = `generation:${publicationId}`;
  const content = "durable retrieval state";
  const chunkId = `chunk:${revisionId}`;
  return {
    publicationId,
    generation,
    source: {
      id: sourceId,
      namespace: "code",
      kind: "file",
      revision: {
        id: revisionId,
        contentHash: `hash:${revisionId}`,
        observedAt: options.observedAt ?? "2026-07-25T00:00:00.000Z",
      },
      path: "src/storage/retrieval/example.ts",
      content,
      metadata: { language: "typescript" },
    },
    chunks: [
      {
        id: chunkId,
        sourceId,
        revisionId,
        generation,
        content,
        embedding: [1, 0, 0],
        location: {
          path: "src/storage/retrieval/example.ts",
          startLine: 1,
          endLine: 1,
        },
        metadata: { language: "typescript" },
      },
    ],
    relations: [
      {
        id: `relation:${revisionId}`,
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
    expectedRelationIds: [`relation:${revisionId}`],
  };
}
