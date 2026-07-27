import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type {
  RetrievalFingerprint,
  RetrievalPublicationRequest,
  RetrievalSourceFreshness,
} from "../../core/retrieval/contracts.js";
import { describe, expect, it } from "vitest";

import { LanceDbRetrievalRepository } from "./LanceDbRetrievalRepository.js";
import { describeRetrievalRepositoryContract } from "../../test/retrievalRepositoryContract.js";

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
  options: { observedAt?: string } = {},
): RetrievalPublicationRequest {
  const sourceId = "source:durable";
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
