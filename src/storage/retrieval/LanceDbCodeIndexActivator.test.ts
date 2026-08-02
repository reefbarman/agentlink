import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { connect, makeArrowTable } from "@lancedb/lancedb";
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
import { LanceDbCodeIndexActivator } from "./LanceDbCodeIndexActivator.js";
import { LanceDbCodeIndexStagingRepository } from "./LanceDbCodeIndexStagingRepository.js";
import {
  RETRIEVAL_TABLES,
  STAGED_RETRIEVAL_TABLES,
  retrievalChunkSchema,
  retrievalRelationSchema,
  retrievalSourceSchema,
} from "./lanceDbSchemas.js";

const dimensions = 3;
const source: RetrievalSourceDocument = {
  id: "source:1",
  namespace: "code",
  kind: "file",
  revision: {
    id: "revision:2",
    contentHash: "hash:2",
    observedAt: "2026-07-28T01:00:00.000Z",
  },
  path: "src/index.ts",
  title: "index",
  content: "export const current = true;",
  metadata: { language: "typescript" },
};
const chunks: RetrievalChunkRecord[] = [
  {
    id: "chunk:2",
    sourceId: source.id,
    revisionId: source.revision.id,
    generation: "generation:2",
    content: source.content,
    embedding: [1, 0, 0],
    location: { path: source.path!, startLine: 1, endLine: 1 },
    metadata: { language: "typescript" },
  },
];
const relations: RetrievalRelationRecord[] = [
  {
    id: "relation:2",
    sourceId: source.id,
    revisionId: source.revision.id,
    generation: "generation:2",
    fromId: chunks[0].id,
    toId: "symbol:current",
    kind: "defines",
    metadata: {},
  },
];

describe("LanceDbCodeIndexActivator", () => {
  let directory: string;
  let storeRoot: string;
  let lease: CodeIndexWriterLease;
  let staging: LanceDbCodeIndexStagingRepository;
  let activator: LanceDbCodeIndexActivator;

  beforeEach(async () => {
    directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "agentlink-code-index-activator-"),
    );
    storeRoot = path.join(directory, "store");
    lease = await acquireCodeIndexWriterLease({
      storeRoot,
      workspaceScopeId: "workspace:test",
      ownerId: "window:1:job:1",
      protocolVersion: "v4",
    });
    staging = new LanceDbCodeIndexStagingRepository(lease, dimensions);
    activator = new LanceDbCodeIndexActivator(lease, dimensions);
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  it("promotes the source pointer last and removes superseded generations", async () => {
    await seedOldGeneration();
    await stageCompletePublication();

    await expect(activator.activate("publication:2")).resolves.toEqual({
      publicationId: "publication:2",
      sourceId: source.id,
      revisionId: source.revision.id,
      generation: "generation:2",
      status: "activated",
    });

    const connection = await connect(storeRoot, { readConsistencyInterval: 0 });
    const sources = await connection.openTable(RETRIEVAL_TABLES.sources);
    const activeChunks = await connection.openTable(RETRIEVAL_TABLES.chunks);
    const activeRelations = await connection.openTable(
      RETRIEVAL_TABLES.relations,
    );
    const manifests = await connection.openTable(
      STAGED_RETRIEVAL_TABLES.manifests,
    );
    const stagedChunks = await connection.openTable(
      STAGED_RETRIEVAL_TABLES.chunks,
    );
    const stagedBatches = await connection.openTable(
      STAGED_RETRIEVAL_TABLES.batches,
    );

    expect(await jsonRows(sources)).toEqual([
      expect.objectContaining({
        source_id: source.id,
        revision_id: source.revision.id,
        generation: "generation:2",
        deleted: false,
      }),
    ]);
    expect(await jsonRows(activeChunks)).toEqual([
      expect.objectContaining({
        chunk_id: "chunk:2",
        generation: "generation:2",
      }),
    ]);
    expect(await jsonRows(activeRelations)).toEqual([
      expect.objectContaining({
        relation_id: "relation:2",
        generation: "generation:2",
      }),
    ]);
    expect(await jsonRows(manifests)).toEqual([
      expect.objectContaining({
        publication_id: "publication:2",
        state: "activated",
      }),
    ]);
    expect(await stagedChunks.countRows()).toBe(0);
    expect(await stagedBatches.countRows()).toBe(0);

    for (const table of [
      sources,
      activeChunks,
      activeRelations,
      manifests,
      stagedChunks,
      stagedBatches,
    ]) {
      table.close();
    }
    connection.close();
  });

  it("removes stale generations on replay after a crash between pointer flip and delete", async () => {
    await seedOldGeneration();
    await stageCompletePublication();
    // Simulate the crash window: the source pointer already references the
    // manifest generation, but generation:1 rows were never deleted and the
    // manifest is still "staged".
    const connection = await connect(storeRoot, { readConsistencyInterval: 0 });
    const sources = await connection.openTable(RETRIEVAL_TABLES.sources);
    await sources.update({
      where: `source_id = '${source.id}'`,
      values: {
        generation: "generation:2",
        revision_id: source.revision.id,
        payload_json: JSON.stringify(source),
      },
    });
    sources.close();
    connection.close();
    const seeded = await connect(storeRoot, { readConsistencyInterval: 0 });
    const seededChunks = await seeded.openTable(RETRIEVAL_TABLES.chunks);
    await seededChunks.add(
      makeArrowTable(
        chunks.map((chunk) => ({
          chunk_id: chunk.id,
          source_id: chunk.sourceId,
          revision_id: chunk.revisionId,
          generation: chunk.generation,
          search_text: chunk.content,
          embedding: chunk.embedding,
          payload_json: JSON.stringify(chunk),
        })),
        { schema: retrievalChunkSchema(dimensions) },
      ),
    );
    seededChunks.close();
    seeded.close();

    await expect(activator.activate("publication:2")).resolves.toMatchObject({
      status: "activated",
    });

    const verify = await connect(storeRoot, { readConsistencyInterval: 0 });
    const activeChunks = await verify.openTable(RETRIEVAL_TABLES.chunks);
    const activeRelations = await verify.openTable(RETRIEVAL_TABLES.relations);
    expect(await jsonRows(activeChunks)).toEqual([
      expect.objectContaining({
        chunk_id: "chunk:2",
        generation: "generation:2",
      }),
    ]);
    expect(
      (await jsonRows(activeRelations)).filter(
        (row) => (row as { generation: string }).generation === "generation:1",
      ),
    ).toEqual([]);
    activeChunks.close();
    activeRelations.close();
    verify.close();
  });

  it("replays an activation receipt and finalizes it after checkpoint", async () => {
    await stageCompletePublication();
    await activator.activate("publication:2");

    await expect(activator.activate("publication:2")).resolves.toMatchObject({
      status: "already_activated",
    });
    await activator.finalizeActivation("publication:2");
    await activator.finalizeActivation("publication:2");
    await expect(
      staging.inspectStagedPublication("publication:2"),
    ).resolves.toBeNull();
  });

  it("rejects incomplete staging and stale source revisions", async () => {
    const manifest = createManifest();
    await staging.beginStagedPublication(manifest);
    await expect(activator.activate(manifest.publicationId)).rejects.toThrow(
      "Staged publication chunk verification failed",
    );

    await staging.abortStagedPublication(manifest.publicationId);
    await seedActiveSource({
      ...source,
      revision: {
        id: "revision:3",
        contentHash: "hash:3",
        observedAt: "2026-07-28T02:00:00.000Z",
      },
    });
    await stageCompletePublication();
    await expect(activator.activate("publication:2")).rejects.toThrow(
      "Staged publication source is stale",
    );
  });

  it("revalidates staged content immediately before activation", async () => {
    await stageCompletePublication();
    const connection = await connect(storeRoot, { readConsistencyInterval: 0 });
    const stagedChunks = await connection.openTable(
      STAGED_RETRIEVAL_TABLES.chunks,
    );
    await stagedChunks.update({
      where: "publication_id = 'publication:2' AND chunk_id = 'chunk:2'",
      values: { search_text: "tampered after completion" },
    });
    stagedChunks.close();
    connection.close();

    await expect(activator.activate("publication:2")).rejects.toThrow(
      "Staged chunk materialization verification failed",
    );
  });

  it("adopts an activated receipt only when active state matches exactly", async () => {
    await stageCompletePublication();
    await activator.activate("publication:2");
    const successorLease = await acquireCodeIndexWriterLease({
      storeRoot,
      workspaceScopeId: "workspace:test",
      ownerId: "window:2:job:2",
      protocolVersion: "v4",
      options: { isOwnerAlive: () => false },
    });
    const successor = new LanceDbCodeIndexActivator(successorLease, dimensions);

    await expect(successor.activate("publication:2")).resolves.toMatchObject({
      status: "already_activated",
    });
    await successor.finalizeActivation("publication:2");
  });

  it("rejects equal-generation collisions with different active source data", async () => {
    await seedActiveSource({
      ...source,
      revision: {
        id: "revision:collision",
        contentHash: "hash:collision",
        observedAt: source.revision.observedAt,
      },
    });
    const connection = await connect(storeRoot, { readConsistencyInterval: 0 });
    const sources = await connection.openTable(RETRIEVAL_TABLES.sources);
    await sources.update({
      where: `source_id = '${source.id}'`,
      values: { generation: "generation:2" },
    });
    sources.close();
    connection.close();
    await stageCompletePublication();

    await expect(activator.activate("publication:2")).rejects.toThrow(
      "Code index generation collision",
    );
  });

  it("rejects a displaced writer before activation", async () => {
    await stageCompletePublication();
    await acquireCodeIndexWriterLease({
      storeRoot,
      workspaceScopeId: "workspace:test",
      ownerId: "window:2:job:2",
      protocolVersion: "v4",
      options: { isOwnerAlive: () => false },
    });

    await expect(activator.activate("publication:2")).rejects.toThrow(
      "code_index_writer_fenced",
    );
  });

  async function stageCompletePublication(): Promise<void> {
    const manifest = createManifest();
    await staging.beginStagedPublication(manifest);
    await staging.appendStagedChunkBatch({
      publicationId: manifest.publicationId,
      batchIndex: 0,
      expectedIdDigest: manifest.expectedChunkDigest,
      expectedContentDigest: createRetrievalRecordContentDigest(chunks),
      chunks,
    });
    await staging.appendStagedRelationBatch({
      publicationId: manifest.publicationId,
      batchIndex: 0,
      expectedIdDigest: manifest.expectedRelationDigest,
      expectedContentDigest: createRetrievalRecordContentDigest(relations),
      relations,
    });
    await staging.completeStagedPublication(manifest.publicationId);
  }

  async function seedOldGeneration(): Promise<void> {
    const oldSource: RetrievalSourceDocument = {
      ...source,
      revision: {
        id: "revision:1",
        contentHash: "hash:1",
        observedAt: "2026-07-28T00:00:00.000Z",
      },
      content: "export const old = true;",
    };
    await seedActiveSource(oldSource);
    const connection = await connect(storeRoot, { readConsistencyInterval: 0 });
    const activeChunks = await connection.openTable(RETRIEVAL_TABLES.chunks);
    const activeRelations = await connection.openTable(
      RETRIEVAL_TABLES.relations,
    );
    await activeChunks.add(
      makeArrowTable(
        [
          {
            chunk_id: "chunk:1",
            source_id: source.id,
            revision_id: oldSource.revision.id,
            generation: "generation:1",
            search_text: oldSource.content,
            embedding: [0, 1, 0],
            payload_json: JSON.stringify({
              ...chunks[0],
              id: "chunk:1",
              revisionId: oldSource.revision.id,
              generation: "generation:1",
              content: oldSource.content,
            }),
          },
        ],
        { schema: retrievalChunkSchema(dimensions) },
      ),
    );
    await activeRelations.add(
      makeArrowTable(
        [
          {
            relation_id: "relation:1",
            source_id: source.id,
            revision_id: oldSource.revision.id,
            generation: "generation:1",
            payload_json: JSON.stringify({
              ...relations[0],
              id: "relation:1",
              revisionId: oldSource.revision.id,
              generation: "generation:1",
            }),
          },
        ],
        { schema: retrievalRelationSchema() },
      ),
    );
    activeChunks.close();
    activeRelations.close();
    connection.close();
  }

  async function seedActiveSource(
    document: RetrievalSourceDocument,
  ): Promise<void> {
    const connection = await connect(storeRoot, { readConsistencyInterval: 0 });
    const names = new Set(await connection.tableNames());
    if (!names.has(RETRIEVAL_TABLES.sources)) {
      await connection.createEmptyTable(
        RETRIEVAL_TABLES.sources,
        retrievalSourceSchema(),
      );
      await connection.createEmptyTable(
        RETRIEVAL_TABLES.chunks,
        retrievalChunkSchema(dimensions),
      );
      await connection.createEmptyTable(
        RETRIEVAL_TABLES.relations,
        retrievalRelationSchema(),
      );
    }
    const sources = await connection.openTable(RETRIEVAL_TABLES.sources);
    await sources
      .mergeInsert(["source_id"])
      .whenMatchedUpdateAll()
      .whenNotMatchedInsertAll()
      .execute(
        makeArrowTable(
          [
            {
              source_id: document.id,
              revision_id: document.revision.id,
              generation:
                document.revision.id === "revision:1"
                  ? "generation:1"
                  : "generation:3",
              deleted: false,
              payload_json: JSON.stringify(document),
            },
          ],
          { schema: retrievalSourceSchema() },
        ),
      );
    sources.close();
    connection.close();
  }
});

function createManifest(): RetrievalStagedPublicationManifest {
  return {
    publicationId: "publication:2",
    generation: "generation:2",
    fenceToken: "1",
    source,
    expectedChunkCount: chunks.length,
    expectedRelationCount: relations.length,
    expectedChunkDigest: createRetrievalRecordIdDigest(
      chunks.map((chunk) => chunk.id),
    ),
    expectedRelationDigest: createRetrievalRecordIdDigest(
      relations.map((relation) => relation.id),
    ),
    sourcePayloadDigest: createRetrievalSourcePayloadDigest(source),
  };
}

async function jsonRows(table: {
  query(): { toArray(): Promise<Array<{ toJSON(): unknown }>> };
}): Promise<unknown[]> {
  return (await table.query().toArray()).map((row) => row.toJSON());
}
