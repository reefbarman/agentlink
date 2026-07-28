import type {
  RetrievalFingerprint,
  RetrievalPublicationRequest,
  RetrievalSourceDocument,
} from "./contracts.js";
import {
  canonicalizeRetrievalFingerprint,
  classifyRetrievalFingerprint,
} from "./fingerprint.js";
import { describe, expect, it } from "vitest";

import { InMemoryRetrievalRepository } from "./InMemoryRetrievalRepository.js";

const fingerprint: RetrievalFingerprint = {
  schemaVersion: 1,
  recordSchemaVersion: 1,
  relationSchemaVersion: 1,
  chunker: {
    id: "agentlink-source-chunker",
    version: 2,
    configurationHash: "chunk-config-v2",
  },
  embedding: {
    provider: "openai-compatible",
    model: "text-embedding-3-small",
    endpointContract: "openai-embeddings-v1",
    dimensions: 1536,
  },
};

function source(
  revisionId: string,
  observedAt: string,
  overrides: Partial<RetrievalSourceDocument> = {},
): RetrievalSourceDocument {
  return {
    id: "source:retrieval",
    namespace: "code",
    kind: "file",
    revision: {
      id: revisionId,
      contentHash: `hash:${revisionId}`,
      observedAt,
    },
    path: "src/core/retrieval/contracts.ts",
    title: "Retrieval contracts",
    content: "backend neutral retrieval publication contract",
    metadata: { language: "typescript" },
    ...overrides,
  };
}

function publication(
  publicationId: string,
  revisionId: string,
  observedAt: string,
  options: {
    sourceId?: string;
    chunks?: Array<{
      id: string;
      content: string;
      embedding?: number[] | null;
    }>;
    expectedChunkIds?: string[];
  } = {},
): RetrievalPublicationRequest {
  const document = source(
    revisionId,
    observedAt,
    options.sourceId ? { id: options.sourceId } : {},
  );
  const generation = `generation:${revisionId}`;
  const chunks = (
    options.chunks ?? [
      {
        id: `chunk:${revisionId}:1`,
        content: "backend neutral retrieval publication contract",
        embedding: [1, 0, 0],
      },
    ]
  ).map((chunk) => ({
    id: chunk.id,
    sourceId: document.id,
    revisionId,
    generation,
    content: chunk.content,
    embedding: chunk.embedding === undefined ? [1, 0, 0] : chunk.embedding,
    location: {
      path: document.path,
      startLine: 1,
      endLine: 10,
      scope: ["retrieval", "contracts"],
    },
    metadata: { language: "typescript" },
  }));
  const relationId = `relation:${revisionId}:1`;
  return {
    publicationId,
    generation,
    source: document,
    chunks,
    relations: [
      {
        id: relationId,
        sourceId: document.id,
        revisionId,
        generation,
        fromId: chunks[0]?.id ?? document.id,
        toId: "symbol:RetrievalRepository",
        kind: "declares",
        metadata: {},
      },
    ],
    expectedChunkIds:
      options.expectedChunkIds ?? chunks.map((chunk) => chunk.id),
    expectedRelationIds: [relationId],
  };
}

async function publish(
  repository: InMemoryRetrievalRepository,
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

const lexicalQuery = {
  text: "backend neutral retrieval",
  mode: "lexical" as const,
  limit: 10,
};

describe("retrieval fingerprint", () => {
  it("canonically includes every rebuild-affecting field", () => {
    expect(JSON.parse(canonicalizeRetrievalFingerprint(fingerprint))).toEqual({
      schemaVersion: 1,
      recordSchemaVersion: 1,
      relationSchemaVersion: 1,
      chunker: {
        id: "agentlink-source-chunker",
        version: 2,
        configurationHash: "chunk-config-v2",
      },
      embedding: {
        provider: "openai-compatible",
        model: "text-embedding-3-small",
        endpointContract: "openai-embeddings-v1",
        dimensions: 1536,
      },
    });
  });

  it.each([
    [
      "provider",
      { embedding: { ...fingerprint.embedding!, provider: "other" } },
    ],
    ["model", { embedding: { ...fingerprint.embedding!, model: "other" } }],
    [
      "endpoint contract",
      {
        embedding: {
          ...fingerprint.embedding!,
          endpointContract: "other-contract",
        },
      },
    ],
    [
      "dimensions",
      { embedding: { ...fingerprint.embedding!, dimensions: 384 } },
    ],
    ["chunker version", { chunker: { ...fingerprint.chunker, version: 3 } }],
    ["schema version", { schemaVersion: 2 }],
  ])("requires rebuild when %s changes", (_, patch) => {
    const changed = { ...fingerprint, ...patch } as RetrievalFingerprint;
    expect(classifyRetrievalFingerprint(fingerprint, changed)).toBe(
      "rebuild_required",
    );
  });

  it("initializes once and then reports compatible migrations", async () => {
    const repository = new InMemoryRetrievalRepository({
      embeddingAvailable: false,
    });
    expect(await repository.inspectFingerprint(fingerprint)).toBe("initialize");
    expect(await repository.migrate(fingerprint)).toEqual({
      status: "migrated",
      fromVersion: null,
      toVersion: 1,
    });
    expect(await repository.migrate(fingerprint)).toEqual({
      status: "up_to_date",
      fromVersion: 1,
      toVersion: 1,
    });

    const changed = {
      ...fingerprint,
      embedding: { ...fingerprint.embedding!, dimensions: 384 },
    };
    expect(await repository.migrate(changed)).toEqual({
      status: "rebuild_required",
      fromVersion: 1,
      toVersion: 1,
    });
  });
});

describe("InMemoryRetrievalRepository publication contract", () => {
  it("keeps prepared generations hidden until complete publication", async () => {
    const repository = new InMemoryRetrievalRepository({
      fingerprint,
      embeddingAvailable: false,
    });
    const request = publication(
      "publication-1",
      "revision-1",
      "2026-07-25T00:00:00.000Z",
    );

    expect(await repository.preparePublication(request)).toEqual({
      publicationId: "publication-1",
      sourceId: request.source.id,
      revisionId: "revision-1",
      generation: "generation:revision-1",
      status: "prepared",
    });
    expect((await repository.query(lexicalQuery)).candidates).toEqual([]);
    expect(await repository.health()).toMatchObject({
      status: "degraded",
      reason: "missing_embeddings_auth",
      pendingPublications: 1,
      sourceCount: 0,
    });

    expect(await repository.commitPublication("publication-1")).toEqual({
      publicationId: "publication-1",
      sourceId: request.source.id,
      revisionId: "revision-1",
      generation: "generation:revision-1",
      status: "published",
      recordsAdded: 3,
      recordsRemoved: 0,
    });
    expect(
      (await repository.query(lexicalQuery)).candidates.map(
        (entry) => entry.chunk.id,
      ),
    ).toEqual(["chunk:revision-1:1"]);
  });

  it("rolls back every prepared member when batch validation fails", async () => {
    const repository = new InMemoryRetrievalRepository({ fingerprint });
    const valid = publication(
      "batch-valid",
      "revision-valid",
      "2026-07-25T00:00:00.000Z",
      { sourceId: "source:valid" },
    );
    const invalid = publication(
      "batch-invalid",
      "revision-invalid",
      "2026-07-25T00:01:00.000Z",
      { sourceId: "source:invalid" },
    );
    invalid.expectedChunkIds = ["duplicate", "duplicate"];

    await expect(
      repository.preparePublicationBatch([valid, invalid]),
    ).rejects.toThrow("expected chunk IDs must be unique");
    expect(await repository.health()).toMatchObject({
      pendingPublications: 0,
    });
    expect(repository.metrics().sourcesScanned).toBe(0);
    await expect(
      repository.commitPublication(valid.publicationId),
    ).resolves.toMatchObject({ status: "not_found" });
  });

  it("does not publish incomplete expected records and allows a complete retry", async () => {
    const repository = new InMemoryRetrievalRepository({ fingerprint });
    const request = publication(
      "incomplete",
      "revision-incomplete",
      "2026-07-25T00:00:00.000Z",
      { expectedChunkIds: ["chunk:missing"] },
    );
    await repository.preparePublication(request);
    expect(await repository.commitPublication("incomplete")).toMatchObject({
      status: "incomplete",
      recordsAdded: 0,
      recordsRemoved: 0,
    });
    expect((await repository.query(lexicalQuery)).candidates).toEqual([]);

    const retry = publication(
      "incomplete",
      "revision-incomplete",
      "2026-07-25T00:00:00.000Z",
    );
    await repository.preparePublication(retry);
    expect(await repository.commitPublication("incomplete")).toMatchObject({
      status: "published",
      recordsAdded: 3,
    });
    expect((await repository.query(lexicalQuery)).candidates).toHaveLength(1);
  });

  it("keeps readers on the old generation until a replacement commits", async () => {
    const repository = new InMemoryRetrievalRepository({ fingerprint });
    await publish(
      repository,
      publication("old", "revision-1", "2026-07-25T00:00:00.000Z", {
        chunks: [{ id: "chunk:old", content: "old visible generation" }],
      }),
    );
    const replacement = publication(
      "new",
      "revision-2",
      "2026-07-25T01:00:00.000Z",
      {
        chunks: [{ id: "chunk:new", content: "new visible generation" }],
      },
    );
    await repository.preparePublication(replacement);

    expect(
      (
        await repository.query({
          text: "visible generation",
          mode: "lexical",
          limit: 10,
        })
      ).candidates.map((entry) => entry.chunk.id),
    ).toEqual(["chunk:old"]);

    await repository.commitPublication("new");
    expect(
      (
        await repository.query({
          text: "visible generation",
          mode: "lexical",
          limit: 10,
        })
      ).candidates.map((entry) => entry.chunk.id),
    ).toEqual(["chunk:new"]);
  });

  it("rejects stale source publication without replacing the current revision", async () => {
    const repository = new InMemoryRetrievalRepository({ fingerprint });
    await publish(
      repository,
      publication("newer", "revision-2", "2026-07-25T02:00:00.000Z", {
        chunks: [
          {
            id: "chunk:newer",
            content: "current generation retrieval contract",
          },
        ],
      }),
    );
    const stale = publication(
      "older",
      "revision-1",
      "2026-07-25T01:00:00.000Z",
      {
        chunks: [{ id: "chunk:older", content: "stale generation retrieval" }],
      },
    );
    await repository.preparePublication(stale);
    expect(await repository.commitPublication("older")).toMatchObject({
      status: "stale_source",
      recordsAdded: 0,
      recordsRemoved: 0,
    });
    expect(
      (
        await repository.query({
          text: "current generation",
          mode: "lexical",
          limit: 10,
        })
      ).candidates.map((entry) => entry.chunk.id),
    ).toEqual(["chunk:newer"]);
  });

  it("uses the revision identity tie-break at the same observed instant", async () => {
    const repository = new InMemoryRetrievalRepository({ fingerprint });
    await publish(
      repository,
      publication("first", "revision-first", "2026-07-25T01:00:00.000Z", {
        chunks: [{ id: "chunk:first", content: "first generation" }],
      }),
    );
    await publish(
      repository,
      publication("second", "revision-second", "2026-07-25T01:00:00.000Z", {
        chunks: [{ id: "chunk:second", content: "second generation" }],
      }),
    );

    expect(
      (
        await repository.query({
          text: "generation",
          mode: "lexical",
          limit: 10,
        })
      ).candidates.map((entry) => entry.chunk.id),
    ).toEqual(["chunk:second"]);
  });

  it("orders revisions by timestamp instants rather than timestamp strings", async () => {
    const repository = new InMemoryRetrievalRepository({ fingerprint });
    await publish(
      repository,
      publication("current", "revision-current", "2026-07-25T01:00:00.000Z"),
    );
    const earlierInstant = publication(
      "offset-earlier",
      "revision-offset",
      "2026-07-25T01:30:00.000+01:00",
    );
    await repository.preparePublication(earlierInstant);

    expect(await repository.commitPublication("offset-earlier")).toMatchObject({
      status: "stale_source",
      recordsAdded: 0,
      recordsRemoved: 0,
    });
  });

  it("returns only known identity for an unknown publication", async () => {
    const repository = new InMemoryRetrievalRepository({ fingerprint });

    expect(await repository.commitPublication("missing")).toEqual({
      publicationId: "missing",
      status: "not_found",
      recordsAdded: 0,
      recordsRemoved: 0,
    });
  });

  it("recovers abandoned prepared generations without exposing them", async () => {
    const repository = new InMemoryRetrievalRepository({ fingerprint });
    await repository.preparePublication(
      publication(
        "abandoned",
        "revision-abandoned",
        "2026-07-25T00:00:00.000Z",
      ),
    );
    expect(await repository.recoverPublications()).toEqual({
      status: "repaired",
      abandonedPublications: 1,
      orphanedChunksRemoved: 0,
      orphanedRelationsRemoved: 0,
    });
    expect(await repository.commitPublication("abandoned")).toMatchObject({
      status: "not_found",
    });
    expect((await repository.query(lexicalQuery)).candidates).toEqual([]);
  });
});

describe("InMemoryRetrievalRepository query and health contract", () => {
  it("filters stale revisions, paths, metadata, and source kinds", async () => {
    const repository = new InMemoryRetrievalRepository({ fingerprint });
    await publish(
      repository,
      publication("code", "revision-code", "2026-07-25T00:00:00.000Z"),
    );
    await publish(
      repository,
      publication("memory", "revision-memory", "2026-07-25T00:00:00.000Z", {
        sourceId: "source:memory",
        chunks: [
          {
            id: "chunk:memory",
            content: "backend neutral retrieval memory",
            embedding: null,
          },
        ],
      }),
    );

    const filtered = await repository.query({
      ...lexicalQuery,
      filters: {
        sourceKinds: ["file"],
        pathPrefix: "src/core",
        metadata: { language: "typescript" },
      },
      excludeSourceRevisionIds: ["revision-memory"],
    });
    expect(filtered.candidates.map((entry) => entry.source.id)).toEqual([
      "source:retrieval",
    ]);
  });

  it("uses deterministic backend-neutral ranking inputs", async () => {
    const repository = new InMemoryRetrievalRepository({ fingerprint });
    await publish(
      repository,
      publication("rank", "revision-rank", "2026-07-25T00:00:00.000Z", {
        chunks: [
          {
            id: "chunk:path",
            content: "unrelated body",
            embedding: [0, 1, 0],
          },
          {
            id: "chunk:exact",
            content: "backend neutral retrieval exact phrase",
            embedding: [1, 0, 0],
          },
        ],
      }),
    );

    const result = await repository.query({
      text: "backend neutral retrieval",
      embedding: [1, 0, 0],
      mode: "hybrid",
      limit: 10,
      diversity: { collapseOverlaps: false },
    });
    expect(result.candidates.map((entry) => entry.chunk.id)).toEqual([
      "chunk:exact",
      "chunk:path",
    ]);
    expect(result.candidates[0]!.scores).toMatchObject({
      exact: 1,
      lexical: 1,
      vector: 1,
    });
  });

  it("excludes null vectors from vector-only queries but retains lexical hybrid candidates", async () => {
    const repository = new InMemoryRetrievalRepository({ fingerprint });
    await publish(
      repository,
      publication(
        "mixed-vectors",
        "revision-mixed",
        "2026-07-25T00:00:00.000Z",
        {
          chunks: [
            {
              id: "chunk:vector",
              content: "vector and lexical retrieval",
              embedding: [1, 0, 0],
            },
            {
              id: "chunk:lexical-only",
              content: "lexical retrieval without vector",
              embedding: null,
            },
          ],
        },
      ),
    );

    expect(
      (
        await repository.query({
          text: "lexical retrieval",
          embedding: [1, 0, 0],
          mode: "vector",
          limit: 10,
        })
      ).candidates.map((entry) => entry.chunk.id),
    ).toEqual(["chunk:vector"]);
    expect(
      (
        await repository.query({
          text: "lexical retrieval",
          embedding: [1, 0, 0],
          mode: "hybrid",
          limit: 10,
          diversity: { collapseOverlaps: false },
        })
      ).candidates.map((entry) => entry.chunk.id),
    ).toEqual(["chunk:vector", "chunk:lexical-only"]);
  });

  it("uses vector retrieval while the lexical index is unavailable", async () => {
    const repository = new InMemoryRetrievalRepository({
      fingerprint,
      lexicalAvailable: false,
    });
    await publish(
      repository,
      publication("vector-only", "revision-vector", "2026-07-25T00:00:00.000Z"),
    );

    const result = await repository.query({
      text: "ignored by vector ranking",
      embedding: [1, 0, 0],
      mode: "vector",
      limit: 10,
    });
    expect(result).toMatchObject({
      mode: "vector",
      degradedReason: "lexical_index_unavailable",
    });
    expect(result.candidates.map((entry) => entry.chunk.id)).toEqual([
      "chunk:revision-vector:1",
    ]);
  });

  it("uses default ranking weights for explicit undefined overrides", async () => {
    const repository = new InMemoryRetrievalRepository({ fingerprint });
    await publish(
      repository,
      publication(
        "undefined-ranking",
        "revision-ranking",
        "2026-07-25T00:00:00.000Z",
      ),
    );

    const result = await repository.query({
      ...lexicalQuery,
      ranking: { exact: undefined, lexical: undefined },
    });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.scores.final).toBeGreaterThan(0);
    expect(Number.isFinite(result.candidates[0]!.scores.final)).toBe(true);
  });

  it("rejects invalid score thresholds", async () => {
    const repository = new InMemoryRetrievalRepository({ fingerprint });
    for (const minimumScore of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(
        repository.query({
          ...lexicalQuery,
          minimumScore,
        }),
      ).rejects.toThrow("minimumScore must be finite and non-negative");
    }
  });

  it("does not return candidates with only source-prior score", async () => {
    const repository = new InMemoryRetrievalRepository({ fingerprint });
    await publish(
      repository,
      publication("zero-signal", "revision-zero", "2026-07-25T00:00:00.000Z"),
    );

    expect(
      (
        await repository.query({
          text: "terms absent everywhere",
          mode: "lexical",
          limit: 10,
        })
      ).candidates,
    ).toEqual([]);
  });

  it("exposes current relations for structural projection", async () => {
    const repository = new InMemoryRetrievalRepository({ fingerprint });
    await publish(
      repository,
      publication(
        "relations",
        "revision-relations",
        "2026-07-25T00:00:00.000Z",
      ),
    );
    expect(await repository.relations()).toMatchObject([
      {
        sourceId: "source:retrieval",
        revisionId: "revision-relations",
        kind: "declares",
      },
    ]);
    expect(await repository.relations(["missing"])).toEqual([]);
    expect(await repository.health()).toMatchObject({
      structural: "ready",
      relationCount: 1,
    });
  });

  it("reports vectors as not configured without requiring credentials", async () => {
    const repository = new InMemoryRetrievalRepository({
      fingerprint,
      embeddingConfigured: false,
      embeddingAvailable: false,
    });
    await publish(
      repository,
      publication(
        "lexical-only",
        "revision-lexical-only",
        "2026-07-25T00:00:00.000Z",
      ),
    );

    expect(await repository.health()).toMatchObject({
      status: "ready",
      vector: "not_configured",
      embeddingCredentials: "not_required",
      reasons: [],
    });
  });

  it("reports structural index failure independently", async () => {
    const repository = new InMemoryRetrievalRepository({
      fingerprint,
      structuralAvailable: false,
    });
    await publish(
      repository,
      publication(
        "structural-health",
        "revision-structural",
        "2026-07-25T00:00:00.000Z",
      ),
    );

    expect(await repository.health()).toMatchObject({
      status: "degraded",
      structural: "unavailable",
      reason: "structural_index_unavailable",
      reasons: ["structural_index_unavailable"],
    });
  });

  it("keeps lexical retrieval ready when embedding credentials are unavailable", async () => {
    const repository = new InMemoryRetrievalRepository({
      fingerprint,
      embeddingConfigured: true,
      embeddingAvailable: false,
    });
    await publish(
      repository,
      publication("lexical", "revision-lexical", "2026-07-25T00:00:00.000Z", {
        chunks: [
          {
            id: "chunk:lexical",
            content: "credential free lexical retrieval",
            embedding: null,
          },
        ],
      }),
    );

    expect(await repository.health()).toMatchObject({
      status: "degraded",
      lexical: "ready",
      vector: "unavailable",
      reason: "missing_embeddings_auth",
    });
    expect(
      (
        await repository.query({
          text: "credential free lexical",
          mode: "lexical",
          limit: 10,
        })
      ).candidates.map((entry) => entry.chunk.id),
    ).toEqual(["chunk:lexical"]);

    const hybrid = await repository.query({
      text: "credential free lexical",
      embedding: [1, 0, 0],
      mode: "hybrid",
      limit: 10,
    });
    expect(hybrid).toMatchObject({
      mode: "lexical",
      degradedReason: "missing_embeddings_auth",
    });
    expect(hybrid.candidates.map((entry) => entry.chunk.id)).toEqual([
      "chunk:lexical",
    ]);
  });
});

describe("InMemoryRetrievalRepository maintenance contract", () => {
  it("prevents deleted revisions from being resurrected by stale publication", async () => {
    const repository = new InMemoryRetrievalRepository({ fingerprint });
    const original = publication(
      "original",
      "revision-2",
      "2026-07-25T02:00:00.000Z",
    );
    await publish(repository, original);
    await repository.deleteSource({
      sourceId: original.source.id,
      expectedRevisionId: "revision-2",
    });

    for (const [publicationId, revisionId, observedAt] of [
      ["same", "revision-2", "2026-07-25T02:00:00.000Z"],
      ["older", "revision-1", "2026-07-25T01:00:00.000Z"],
    ] as const) {
      const stale = publication(publicationId, revisionId, observedAt);
      await repository.preparePublication(stale);
      expect(await repository.commitPublication(publicationId)).toMatchObject({
        status: "stale_source",
        recordsAdded: 0,
      });
    }

    const newer = publication(
      "newer",
      "revision-3",
      "2026-07-25T03:00:00.000Z",
    );
    await publish(repository, newer);
    expect((await repository.query(lexicalQuery)).candidates).toHaveLength(1);
  });

  it("supports guarded delete, snapshot, restore, repair, and optimize", async () => {
    const repository = new InMemoryRetrievalRepository({
      fingerprint,
      now: () => "2026-07-25T03:00:00.000Z",
      createId: () => "snapshot-1",
    });
    const request = publication(
      "initial",
      "revision-1",
      "2026-07-25T00:00:00.000Z",
    );
    await publish(repository, request);
    const snapshot = await repository.createSnapshot("before-delete");
    expect(snapshot).toEqual({
      status: "created",
      snapshot: {
        id: "snapshot-1",
        createdAt: "2026-07-25T03:00:00.000Z",
        label: "before-delete",
        sourceCount: 1,
        chunkCount: 1,
        relationCount: 1,
      },
    });

    expect(
      await repository.deleteSource({
        sourceId: request.source.id,
        expectedRevisionId: "wrong-revision",
      }),
    ).toMatchObject({ status: "stale_source", recordsRemoved: 0 });
    expect(
      await repository.deleteSource({
        sourceId: request.source.id,
        expectedRevisionId: "revision-1",
      }),
    ).toMatchObject({ status: "deleted", recordsRemoved: 3 });
    expect((await repository.query(lexicalQuery)).candidates).toEqual([]);

    expect(await repository.restoreSnapshot("snapshot-1")).toEqual({
      status: "restored",
      snapshot: snapshot.snapshot,
    });
    expect((await repository.query(lexicalQuery)).candidates).toHaveLength(1);
    expect(await repository.restoreSnapshot("missing")).toEqual({
      status: "not_found",
    });
    expect(await repository.repair()).toEqual({
      status: "clean",
      abandonedPublications: 0,
      orphanedChunksRemoved: 0,
      orphanedRelationsRemoved: 0,
    });
    expect(await repository.optimize()).toEqual({
      status: "optimized",
      recordsCompacted: 3,
    });

    expect(repository.metrics()).toMatchObject({
      sourcesScanned: 1,
      sourcesPublished: 1,
      sourcesDeleted: 1,
      recordsAdded: 3,
      recordsRemoved: 3,
      snapshotsCreated: 1,
      snapshotsRestored: 1,
      repairs: 1,
      optimizations: 1,
    });
    expect(
      Object.keys(repository.metrics()).some((key) =>
        /qdrant|lance|point/i.test(key),
      ),
    ).toBe(false);
  });
});
