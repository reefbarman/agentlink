import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { connect } from "@lancedb/lancedb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  RetrievalChunkRecord,
  RetrievalRelationRecord,
  RetrievalSourceDocument,
  RetrievalStagedPublicationManifest,
} from "../../core/retrieval/contracts.js";
import {
  createRetrievalRecordContentDigest,
  createRetrievalRecordIdDigest,
  createRetrievalSourcePayloadDigest,
} from "../../core/retrieval/publicationDigests.js";
import {
  acquireCodeIndexWriterLease,
  type CodeIndexWriterLease,
} from "../../indexer/codeIndexWriterLease.js";
import { LanceDbCodeIndexStagingRepository } from "./LanceDbCodeIndexStagingRepository.js";
import { STAGED_RETRIEVAL_TABLES } from "./lanceDbSchemas.js";

const dimensions = 3;

const source: RetrievalSourceDocument = {
  id: "source:1",
  namespace: "code",
  kind: "file",
  revision: {
    id: "revision:1",
    contentHash: "hash:1",
    observedAt: "2026-07-28T00:00:00.000Z",
  },
  path: "src/index.ts",
  title: "index",
  content: "export const first = true;\nexport const second = true;",
  metadata: { language: "typescript" },
};

const chunks: RetrievalChunkRecord[] = [
  {
    id: "chunk:1",
    sourceId: source.id,
    revisionId: source.revision.id,
    generation: "generation:1",
    content: "export const first = true;",
    embedding: [1, 0, 0],
    location: { path: "src/index.ts", startLine: 1, endLine: 1 },
    metadata: { language: "typescript" },
  },
  {
    id: "chunk:2",
    sourceId: source.id,
    revisionId: source.revision.id,
    generation: "generation:1",
    content: "export const second = true;",
    embedding: [0, 1, 0],
    location: { path: "src/index.ts", startLine: 2, endLine: 2 },
    metadata: { language: "typescript" },
  },
];

const relations: RetrievalRelationRecord[] = [
  {
    id: "relation:1",
    sourceId: source.id,
    revisionId: source.revision.id,
    generation: "generation:1",
    fromId: chunks[0].id,
    toId: chunks[1].id,
    kind: "references",
    metadata: {},
  },
];

describe("LanceDbCodeIndexStagingRepository", () => {
  let directory: string;
  let storeRoot: string;
  let lease: CodeIndexWriterLease;
  let repository: LanceDbCodeIndexStagingRepository;

  beforeEach(async () => {
    directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "agentlink-staging-repository-"),
    );
    storeRoot = path.join(directory, "store");
    lease = await acquireCodeIndexWriterLease({
      storeRoot,
      workspaceScopeId: "workspace:test",
      ownerId: "window:1:job:1",
      protocolVersion: "v4",
    });
    repository = new LanceDbCodeIndexStagingRepository(lease, dimensions);
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  it("stages a complete publication atomically and replays idempotently", async () => {
    const manifest = createManifest();
    const bundle = {
      manifest,
      chunkBatches: [
        {
          publicationId: manifest.publicationId,
          batchIndex: 0,
          expectedIdDigest: manifest.expectedChunkDigest,
          expectedContentDigest: createRetrievalRecordContentDigest(chunks),
          chunks,
        },
      ],
      relationBatches: [
        {
          publicationId: manifest.publicationId,
          batchIndex: 0,
          expectedIdDigest: manifest.expectedRelationDigest,
          expectedContentDigest: createRetrievalRecordContentDigest(relations),
          relations,
        },
      ],
    };

    await repository.stagePublication(bundle);
    await expect(
      repository.inspectStagedPublication(manifest.publicationId),
    ).resolves.toMatchObject({ state: "staged" });

    // Replaying the same bundle after completion is a no-op, not an error.
    await repository.stagePublication(bundle);
    await expect(
      repository.inspectStagedPublication(manifest.publicationId),
    ).resolves.toMatchObject({ state: "staged" });

    const connection = await connect(storeRoot, { readConsistencyInterval: 0 });
    const chunkTable = await connection.openTable(
      STAGED_RETRIEVAL_TABLES.chunks,
    );
    const relationTable = await connection.openTable(
      STAGED_RETRIEVAL_TABLES.relations,
    );
    const batchTable = await connection.openTable(
      STAGED_RETRIEVAL_TABLES.batches,
    );
    expect(await chunkTable.countRows()).toBe(chunks.length);
    expect(await relationTable.countRows()).toBe(relations.length);
    expect(await batchTable.countRows()).toBe(2);
    chunkTable.close();
    relationTable.close();
    batchTable.close();
    connection.close();
  });

  it("rejects an atomic publication with tampered batch digests", async () => {
    const manifest = createManifest({ expectedRelationCount: 0 });
    await expect(
      repository.stagePublication({
        manifest,
        chunkBatches: [
          {
            publicationId: manifest.publicationId,
            batchIndex: 0,
            expectedIdDigest: manifest.expectedChunkDigest,
            expectedContentDigest: "tampered",
            chunks,
          },
        ],
        relationBatches: [],
      }),
    ).rejects.toThrow("Staged chunk batch digest mismatch");
  });

  it("begins a compact inspectable publication and rejects duplicates", async () => {
    const manifest = createManifest();

    await expect(repository.beginStagedPublication(manifest)).resolves.toEqual({
      publicationId: manifest.publicationId,
      sourceId: source.id,
      revisionId: source.revision.id,
      generation: manifest.generation,
      status: "prepared",
    });
    await expect(
      repository.inspectStagedPublication(manifest.publicationId),
    ).resolves.toEqual({
      publicationId: manifest.publicationId,
      sourceId: source.id,
      revisionId: source.revision.id,
      generation: manifest.generation,
      fenceToken: lease.fenceToken,
      state: "staging",
      expectedChunkCount: chunks.length,
      expectedRelationCount: relations.length,
      expectedChunkDigest: createRetrievalRecordIdDigest(
        chunks.map((chunk) => chunk.id),
      ),
      expectedRelationDigest: createRetrievalRecordIdDigest(
        relations.map((relation) => relation.id),
      ),
      sourcePayloadDigest: createRetrievalSourcePayloadDigest(source),
    });
    await expect(repository.beginStagedPublication(manifest)).rejects.toThrow(
      "Staged publication already exists",
    );
  });

  it("replaces the same batch idempotently and completes after exact verification", async () => {
    const manifest = createManifest();
    await repository.beginStagedPublication(manifest);

    const chunkBatch = {
      publicationId: manifest.publicationId,
      batchIndex: 0,
      expectedIdDigest: manifest.expectedChunkDigest,
      expectedContentDigest: createRetrievalRecordContentDigest(chunks),
      chunks,
    };
    await repository.appendStagedChunkBatch(chunkBatch);
    await repository.appendStagedChunkBatch(chunkBatch);
    await repository.appendStagedRelationBatch({
      publicationId: manifest.publicationId,
      batchIndex: 0,
      expectedIdDigest: manifest.expectedRelationDigest,
      expectedContentDigest: createRetrievalRecordContentDigest(relations),
      relations,
    });

    await repository.completeStagedPublication(manifest.publicationId);
    await expect(
      repository.inspectStagedPublication(manifest.publicationId),
    ).resolves.toMatchObject({ state: "staged" });

    const connection = await connect(storeRoot, { readConsistencyInterval: 0 });
    const chunkTable = await connection.openTable(
      STAGED_RETRIEVAL_TABLES.chunks,
    );
    const batchTable = await connection.openTable(
      STAGED_RETRIEVAL_TABLES.batches,
    );
    expect(await chunkTable.countRows()).toBe(chunks.length);
    expect(await batchTable.countRows()).toBe(2);
    chunkTable.close();
    batchTable.close();
    connection.close();
  });

  it("rejects mismatched ownership and batch digests before writing rows", async () => {
    const manifest = createManifest();
    await repository.beginStagedPublication(manifest);

    await expect(
      repository.appendStagedChunkBatch({
        publicationId: manifest.publicationId,
        batchIndex: 0,
        expectedIdDigest: manifest.expectedChunkDigest,
        expectedContentDigest: createRetrievalRecordContentDigest(chunks),
        chunks: [{ ...chunks[0], sourceId: "source:other" }],
      }),
    ).rejects.toThrow("Staged chunk ownership does not match its manifest");
    await expect(
      repository.appendStagedRelationBatch({
        publicationId: manifest.publicationId,
        batchIndex: 0,
        expectedIdDigest: "wrong",
        expectedContentDigest: createRetrievalRecordContentDigest(relations),
        relations,
      }),
    ).rejects.toThrow("Staged relation batch digest mismatch");

    const connection = await connect(storeRoot, { readConsistencyInterval: 0 });
    const chunkTable = await connection.openTable(
      STAGED_RETRIEVAL_TABLES.chunks,
    );
    const relationTable = await connection.openTable(
      STAGED_RETRIEVAL_TABLES.relations,
    );
    expect(await chunkTable.countRows()).toBe(0);
    expect(await relationTable.countRows()).toBe(0);
    chunkTable.close();
    relationTable.close();
    connection.close();
  });

  it("fails completion when a batch ledger is missing and remains recoverable", async () => {
    const manifest = createManifest({ expectedRelationCount: 0 });
    await repository.beginStagedPublication(manifest);
    await repository.appendStagedChunkBatch({
      publicationId: manifest.publicationId,
      batchIndex: 0,
      expectedIdDigest: manifest.expectedChunkDigest,
      expectedContentDigest: createRetrievalRecordContentDigest(chunks),
      chunks,
    });

    const connection = await connect(storeRoot, { readConsistencyInterval: 0 });
    const batchTable = await connection.openTable(
      STAGED_RETRIEVAL_TABLES.batches,
    );
    await batchTable.delete(`publication_id = '${manifest.publicationId}'`);
    batchTable.close();
    connection.close();

    await expect(
      repository.completeStagedPublication(manifest.publicationId),
    ).rejects.toThrow("Staged publication chunk verification failed");
    await expect(
      repository.inspectStagedPublication(manifest.publicationId),
    ).resolves.toMatchObject({ state: "staging" });
  });

  it("fails completion when a persisted batch digest is tampered", async () => {
    const manifest = createManifest({ expectedRelationCount: 0 });
    await repository.beginStagedPublication(manifest);
    await repository.appendStagedChunkBatch({
      publicationId: manifest.publicationId,
      batchIndex: 0,
      expectedIdDigest: manifest.expectedChunkDigest,
      expectedContentDigest: createRetrievalRecordContentDigest(chunks),
      chunks,
    });

    const connection = await connect(storeRoot, { readConsistencyInterval: 0 });
    const batchTable = await connection.openTable(
      STAGED_RETRIEVAL_TABLES.batches,
    );
    await batchTable.update({
      where: `publication_id = '${manifest.publicationId}' AND row_kind = 'chunk'`,
      values: { expected_id_digest: "tampered" },
    });
    batchTable.close();
    connection.close();

    await expect(
      repository.completeStagedPublication(manifest.publicationId),
    ).rejects.toThrow("Staged chunk batch verification failed");
  });

  it("fails completion when staged record IDs are duplicated", async () => {
    const manifest = createManifest({ expectedRelationCount: 0 });
    await repository.beginStagedPublication(manifest);
    await repository.appendStagedChunkBatch({
      publicationId: manifest.publicationId,
      batchIndex: 0,
      expectedIdDigest: manifest.expectedChunkDigest,
      expectedContentDigest: createRetrievalRecordContentDigest(chunks),
      chunks,
    });

    const connection = await connect(storeRoot, { readConsistencyInterval: 0 });
    const chunkTable = await connection.openTable(
      STAGED_RETRIEVAL_TABLES.chunks,
    );
    await chunkTable.update({
      where: `publication_id = '${manifest.publicationId}' AND chunk_id = 'chunk:2'`,
      values: { chunk_id: "chunk:1" },
    });
    chunkTable.close();
    connection.close();

    await expect(
      repository.completeStagedPublication(manifest.publicationId),
    ).rejects.toThrow("Staged chunk ownership verification failed");
  });

  it("rejects conflicting batch-index reuse without replacing valid rows", async () => {
    const manifest = createManifest({ expectedRelationCount: 0 });
    await repository.beginStagedPublication(manifest);
    await repository.appendStagedChunkBatch({
      publicationId: manifest.publicationId,
      batchIndex: 0,
      expectedIdDigest: manifest.expectedChunkDigest,
      expectedContentDigest: createRetrievalRecordContentDigest(chunks),
      chunks,
    });
    const changed = [{ ...chunks[0], content: "changed" }, chunks[1]];

    await expect(
      repository.appendStagedChunkBatch({
        publicationId: manifest.publicationId,
        batchIndex: 0,
        expectedIdDigest: manifest.expectedChunkDigest,
        expectedContentDigest: createRetrievalRecordContentDigest(changed),
        chunks: changed,
      }),
    ).rejects.toThrow("Staged publication batch index conflict");
    await expect(
      repository.completeStagedPublication(manifest.publicationId),
    ).resolves.toBeUndefined();
  });

  it("rejects an idempotent retry when persisted batch rows are partial", async () => {
    const manifest = createManifest({ expectedRelationCount: 0 });
    const batch = {
      publicationId: manifest.publicationId,
      batchIndex: 0,
      expectedIdDigest: manifest.expectedChunkDigest,
      expectedContentDigest: createRetrievalRecordContentDigest(chunks),
      chunks,
    };
    await repository.beginStagedPublication(manifest);
    await repository.appendStagedChunkBatch(batch);

    const connection = await connect(storeRoot, { readConsistencyInterval: 0 });
    const chunkTable = await connection.openTable(
      STAGED_RETRIEVAL_TABLES.chunks,
    );
    await chunkTable.delete(
      `publication_id = '${manifest.publicationId}' AND chunk_id = 'chunk:2'`,
    );
    chunkTable.close();
    connection.close();

    await expect(repository.appendStagedChunkBatch(batch)).rejects.toThrow(
      "Staged chunk batch verification failed",
    );
    await expect(
      repository.inspectStagedPublication(manifest.publicationId),
    ).resolves.toMatchObject({ state: "staging" });
  });

  it("completes idempotently without deleting the manifest", async () => {
    const manifest = createManifest({ expectedRelationCount: 0 });
    await repository.beginStagedPublication(manifest);
    await repository.appendStagedChunkBatch({
      publicationId: manifest.publicationId,
      batchIndex: 0,
      expectedIdDigest: manifest.expectedChunkDigest,
      expectedContentDigest: createRetrievalRecordContentDigest(chunks),
      chunks,
    });

    await repository.completeStagedPublication(manifest.publicationId);
    await repository.completeStagedPublication(manifest.publicationId);
    await expect(
      repository.inspectStagedPublication(manifest.publicationId),
    ).resolves.toMatchObject({ state: "staged" });
  });

  it("verifies decimal embeddings after Float32 materialization", async () => {
    const decimalChunks = chunks.map((chunk, index) => ({
      ...chunk,
      embedding:
        index === 0
          ? [0.123456789, -0.987654321, 0.333333333]
          : [-0.222222222, 0.444444444, 0.777777777],
    }));
    const manifest = createManifest({ expectedRelationCount: 0 });
    await repository.beginStagedPublication(manifest);
    await repository.appendStagedChunkBatch({
      publicationId: manifest.publicationId,
      batchIndex: 0,
      expectedIdDigest: manifest.expectedChunkDigest,
      expectedContentDigest: createRetrievalRecordContentDigest(decimalChunks),
      chunks: decimalChunks,
    });

    await expect(
      repository.completeStagedPublication(manifest.publicationId),
    ).resolves.toBeUndefined();
  });

  it("fails completion after source or materialized chunk tampering", async () => {
    const manifest = createManifest({ expectedRelationCount: 0 });
    await repository.beginStagedPublication(manifest);
    await repository.appendStagedChunkBatch({
      publicationId: manifest.publicationId,
      batchIndex: 0,
      expectedIdDigest: manifest.expectedChunkDigest,
      expectedContentDigest: createRetrievalRecordContentDigest(chunks),
      chunks,
    });

    let connection = await connect(storeRoot, { readConsistencyInterval: 0 });
    let chunkTable = await connection.openTable(STAGED_RETRIEVAL_TABLES.chunks);
    await chunkTable.update({
      where: `publication_id = '${manifest.publicationId}' AND chunk_id = 'chunk:1'`,
      values: { search_text: "tampered" },
    });
    chunkTable.close();
    connection.close();
    await expect(
      repository.completeStagedPublication(manifest.publicationId),
    ).rejects.toThrow("Staged chunk materialization verification failed");

    connection = await connect(storeRoot, { readConsistencyInterval: 0 });
    chunkTable = await connection.openTable(STAGED_RETRIEVAL_TABLES.chunks);
    await chunkTable.update({
      where: `publication_id = '${manifest.publicationId}' AND chunk_id = 'chunk:1'`,
      values: {
        search_text: chunks[0].content,
        embedding: [0, 0, 1],
      },
    });
    chunkTable.close();
    connection.close();
    await expect(
      repository.completeStagedPublication(manifest.publicationId),
    ).rejects.toThrow("Staged chunk materialization verification failed");

    connection = await connect(storeRoot, { readConsistencyInterval: 0 });
    chunkTable = await connection.openTable(STAGED_RETRIEVAL_TABLES.chunks);
    await chunkTable.update({
      where: `publication_id = '${manifest.publicationId}' AND chunk_id = 'chunk:1'`,
      values: {
        search_text: chunks[0].content,
      },
    });
    const manifestTable = await connection.openTable(
      STAGED_RETRIEVAL_TABLES.manifests,
    );
    await manifestTable.update({
      where: `publication_id = '${manifest.publicationId}'`,
      values: {
        source_payload_json: JSON.stringify({ ...source, title: "tampered" }),
      },
    });
    chunkTable.close();
    manifestTable.close();
    connection.close();
    await expect(
      repository.completeStagedPublication(manifest.publicationId),
    ).rejects.toThrow("Staged publication source payload digest mismatch");
  });

  it("adopts and aborts stale-fence staging state after writer takeover", async () => {
    const manifest = createManifest();
    await repository.beginStagedPublication(manifest);
    const successorLease = await acquireCodeIndexWriterLease({
      storeRoot,
      workspaceScopeId: "workspace:test",
      ownerId: "window:2:job:2",
      protocolVersion: "v4",
      options: { isOwnerAlive: () => false },
    });
    const successor = new LanceDbCodeIndexStagingRepository(
      successorLease,
      dimensions,
    );

    await successor.adoptStagedPublication(manifest.publicationId);
    await expect(
      repository.abortStagedPublication(manifest.publicationId),
    ).rejects.toThrow("code_index_writer_fenced");
    await successor.abortStagedPublication(manifest.publicationId);
    await expect(
      successor.inspectStagedPublication(manifest.publicationId),
    ).resolves.toBeNull();
  });

  it("rejects cumulative batches that exceed manifest expectations", async () => {
    const manifest = createManifest({
      expectedChunkCount: 1,
      expectedChunkDigest: createRetrievalRecordIdDigest([chunks[0].id]),
      expectedRelationCount: 0,
    });
    await repository.beginStagedPublication(manifest);
    await repository.appendStagedChunkBatch({
      publicationId: manifest.publicationId,
      batchIndex: 0,
      expectedIdDigest: createRetrievalRecordIdDigest([chunks[0].id]),
      expectedContentDigest: createRetrievalRecordContentDigest([chunks[0]]),
      chunks: [chunks[0]],
    });

    await expect(
      repository.appendStagedChunkBatch({
        publicationId: manifest.publicationId,
        batchIndex: 1,
        expectedIdDigest: createRetrievalRecordIdDigest([chunks[1].id]),
        expectedContentDigest: createRetrievalRecordContentDigest([chunks[1]]),
        chunks: [chunks[1]],
      }),
    ).rejects.toThrow("Staged chunk batches exceed manifest expected count");
  });

  it("rejects oversized batches before touching the store", async () => {
    const oversized = Array.from({ length: 257 }, (_, index) => ({
      ...chunks[0],
      id: `chunk:${index}`,
    }));

    await expect(
      repository.appendStagedChunkBatch({
        publicationId: "publication:missing",
        batchIndex: 0,
        expectedIdDigest: createRetrievalRecordIdDigest(
          oversized.map((chunk) => chunk.id),
        ),
        expectedContentDigest: createRetrievalRecordContentDigest(oversized),
        chunks: oversized,
      }),
    ).rejects.toThrow("Staged chunk batch must contain 1-256 records");
    await expect(
      repository.inspectStagedPublication("publication:missing"),
    ).resolves.toBeNull();
  });

  it("rejects a displaced writer before mutating staged rows", async () => {
    const manifest = createManifest();
    await repository.beginStagedPublication(manifest);
    await acquireCodeIndexWriterLease({
      storeRoot,
      workspaceScopeId: "workspace:test",
      ownerId: "window:2:job:2",
      protocolVersion: "v4",
      options: { isOwnerAlive: () => false },
    });

    await expect(
      repository.appendStagedChunkBatch({
        publicationId: manifest.publicationId,
        batchIndex: 0,
        expectedIdDigest: manifest.expectedChunkDigest,
        expectedContentDigest: createRetrievalRecordContentDigest(chunks),
        chunks,
      }),
    ).rejects.toThrow("code_index_writer_fenced");
  });

  it("rejects a corrupt source descriptor before staging chunks", async () => {
    const manifest = createManifest();
    await repository.beginStagedPublication(manifest);

    const connection = await connect(storeRoot, { readConsistencyInterval: 0 });
    const manifestTable = await connection.openTable(
      STAGED_RETRIEVAL_TABLES.manifests,
    );
    await manifestTable.update({
      where: `publication_id = '${manifest.publicationId}'`,
      values: {
        source_payload_json: JSON.stringify({ ...source, title: "changed" }),
      },
    });
    manifestTable.close();
    connection.close();

    await expect(
      repository.appendStagedChunkBatch({
        publicationId: manifest.publicationId,
        batchIndex: 0,
        expectedIdDigest: manifest.expectedChunkDigest,
        expectedContentDigest: createRetrievalRecordContentDigest(chunks),
        chunks,
      }),
    ).rejects.toThrow("Staged publication source payload digest mismatch");
  });
});

function createManifest(
  overrides: Partial<RetrievalStagedPublicationManifest> = {},
): RetrievalStagedPublicationManifest {
  const expectedRelationCount =
    overrides.expectedRelationCount ?? relations.length;
  return {
    publicationId: "publication:1",
    generation: "generation:1",
    fenceToken: leaseToken(overrides),
    source,
    expectedChunkCount: chunks.length,
    expectedRelationCount,
    expectedChunkDigest: createRetrievalRecordIdDigest(
      chunks.map((chunk) => chunk.id),
    ),
    expectedRelationDigest: createRetrievalRecordIdDigest(
      expectedRelationCount === 0
        ? []
        : relations.map((relation) => relation.id),
    ),
    sourcePayloadDigest: createRetrievalSourcePayloadDigest(source),
    ...overrides,
  };
}

function leaseToken(
  overrides: Partial<RetrievalStagedPublicationManifest>,
): string {
  return overrides.fenceToken ?? "1";
}
