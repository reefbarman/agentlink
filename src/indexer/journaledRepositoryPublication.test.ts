import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  emptyFileIndexJournal,
  loadFileIndexJournal,
  writeFileIndexJournal,
} from "./fileIndexJournal.js";
import {
  executeJournaledRepositoryPublications,
  recoverJournaledRepositoryPublications,
} from "./journaledRepositoryPublication.js";

import type { CachedFileEntry } from "./types.js";
import type { FileReplacementStore } from "./journaledRepositoryPublication.js";
import { InMemoryRetrievalRepository } from "../core/retrieval/InMemoryRetrievalRepository.js";
import type { RetrievalPublicationRequest } from "../core/retrieval/contracts.js";
import type { StructuralFileEntry } from "./structuralGraph.js";

const sourceId = "code:workspace:test:src/index.ts";
const file = "src/index.ts";
const publicationId = "publication-1";
const generation = "generation-1";
const revisionId = "hash-1";
const chunkId = "chunk-1";

function publication(): RetrievalPublicationRequest {
  return {
    publicationId,
    generation,
    source: {
      id: sourceId,
      namespace: "code",
      kind: "file",
      revision: {
        id: revisionId,
        contentHash: revisionId,
        observedAt: "2026-07-25T00:00:00.000Z",
      },
      path: file,
      content: "export const value = 1;",
      metadata: { scopeType: "workspace", scopeId: "workspace:test" },
    },
    chunks: [
      {
        id: chunkId,
        sourceId,
        revisionId,
        generation,
        content: "export const value = 1;",
        embedding: [1, 0, 0],
        location: { path: file, startLine: 1, endLine: 1 },
        metadata: {},
      },
    ],
    relations: [],
    expectedChunkIds: [chunkId],
    expectedRelationIds: [],
  };
}

function structuralEntry(): StructuralFileEntry {
  return {
    relPath: file,
    sourceId,
    hash: revisionId,
    indexedAt: "2026-07-25T00:00:00.000Z",
    imports: [],
    exports: [],
    symbols: [],
  };
}

function createStore(): {
  store: FileReplacementStore;
  vectors: Record<string, CachedFileEntry>;
  structurals: Record<string, StructuralFileEntry>;
} {
  const vectors: Record<string, CachedFileEntry> = {};
  const structurals: Record<string, StructuralFileEntry> = {};
  const store: FileReplacementStore = {
    getVector: (target) => vectors[target],
    getStructural: (target) => structurals[target],
    checkpointVector(target, entry) {
      if (entry) vectors[target] = structuredClone(entry);
      else delete vectors[target];
    },
    checkpointStructural(target, entry) {
      if (entry) structurals[target] = structuredClone(entry);
      else delete structurals[target];
    },
    checkpointVectors(entries) {
      for (const [target, entry] of entries) {
        if (entry) vectors[target] = structuredClone(entry);
        else delete vectors[target];
      }
    },
    checkpointStructurals(entries) {
      for (const [target, entry] of entries) {
        if (entry) structurals[target] = structuredClone(entry);
        else delete structurals[target];
      }
    },
  };
  return { store, vectors, structurals };
}

function preparedFile() {
  return {
    file,
    publication: publication(),
    oldRecordIds: ["old-chunk"],
    cacheEntry: {
      hash: revisionId,
      recordIds: [chunkId],
      indexedAt: "2026-07-25T00:00:00.000Z",
    },
    structuralEntry: structuralEntry(),
  };
}

function journal() {
  return {
    ...emptyFileIndexJournal(),
    operations: [
      {
        operationId: publicationId,
        file,
        kind: "replace" as const,
        generation,
        targetHash: revisionId,
        oldRecordIds: ["old-chunk"],
        intendedBatches: [{ batch: 0, recordIds: [chunkId] }],
      },
    ],
  };
}

describe("journaled repository publication", () => {
  let directory: string;
  let journalPath: string;
  let repository: InMemoryRetrievalRepository;

  beforeEach(async () => {
    directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "journaled-repository-publication-"),
    );
    journalPath = path.join(directory, "index.journal.json");
    repository = new InMemoryRetrievalRepository({ fingerprint: null });
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("prepares, checkpoints, commits, and clears the journal", async () => {
    const { store, vectors, structurals } = createStore();

    await expect(
      executeJournaledRepositoryPublications({
        journalPath,
        publications: [preparedFile()],
        store,
        repository,
        isCancelled: () => false,
      }),
    ).resolves.toEqual({
      committedFiles: 1,
      recordsUpserted: 1,
      recordsDeleted: 1,
      cancelled: false,
      pending: false,
    });
    expect(vectors[file]).toMatchObject({
      hash: revisionId,
      generation,
      visibility: "current",
      recordIds: [chunkId],
    });
    expect(structurals[file]).toMatchObject({
      sourceId,
      generation,
      status: "current",
    });
    expect(loadFileIndexJournal(journalPath)).toMatchObject({
      status: "valid",
      journal: { operations: [] },
    });
    expect(await repository.inspectSource(sourceId)).toMatchObject({
      generation,
    });
  });

  it("prepares and commits multiple files through one repository batch", async () => {
    const { store, vectors, structurals } = createStore();
    const first = preparedFile();
    const second = structuredClone(first);
    second.file = "src/second.ts";
    second.publication.publicationId = "publication-2";
    second.publication.generation = "generation-2";
    second.publication.source.id = "code:workspace:test:src/second.ts";
    second.publication.source.path = second.file;
    second.publication.source.revision = {
      id: "hash-2",
      contentHash: "hash-2",
      observedAt: "2026-07-25T00:01:00.000Z",
    };
    second.publication.chunks[0]!.id = "chunk-2";
    second.publication.chunks[0]!.sourceId = second.publication.source.id;
    second.publication.chunks[0]!.revisionId = "hash-2";
    second.publication.chunks[0]!.generation = "generation-2";
    second.publication.chunks[0]!.location = {
      path: second.file,
      startLine: 1,
      endLine: 1,
    };
    second.publication.expectedChunkIds = ["chunk-2"];
    second.oldRecordIds = ["old-chunk-2"];
    second.cacheEntry.hash = "hash-2";
    second.cacheEntry.recordIds = ["chunk-2"];
    second.structuralEntry.relPath = second.file;
    second.structuralEntry.sourceId = second.publication.source.id;
    second.structuralEntry.hash = "hash-2";

    const prepareBatch = vi.spyOn(repository, "preparePublicationBatch");
    const commitBatch = vi.spyOn(repository, "commitPublicationBatch");

    await expect(
      executeJournaledRepositoryPublications({
        journalPath,
        publications: [first, second],
        store,
        repository,
        isCancelled: () => false,
      }),
    ).resolves.toEqual({
      committedFiles: 2,
      recordsUpserted: 2,
      recordsDeleted: 2,
      cancelled: false,
      pending: false,
    });

    expect(prepareBatch).toHaveBeenCalledOnce();
    expect(prepareBatch).toHaveBeenCalledWith([
      first.publication,
      second.publication,
    ]);
    expect(commitBatch).toHaveBeenCalledOnce();
    expect(commitBatch).toHaveBeenCalledWith([
      "publication-1",
      "publication-2",
    ]);
    expect(vectors).toMatchObject({
      "src/index.ts": { generation: "generation-1", visibility: "current" },
      "src/second.ts": { generation: "generation-2", visibility: "current" },
    });
    expect(structurals).toMatchObject({
      "src/index.ts": { generation: "generation-1", status: "current" },
      "src/second.ts": { generation: "generation-2", status: "current" },
    });
  });

  it("aborts a durable prepare that never reached the cache checkpoint", async () => {
    const { store } = createStore();
    writeFileIndexJournal(journalPath, journal());
    await repository.preparePublication(publication());

    await expect(
      recoverJournaledRepositoryPublications({
        journalPath,
        store,
        repository,
        isCancelled: () => false,
      }),
    ).resolves.toMatchObject({ committedFiles: 0, pending: false });
    expect(await repository.commitPublication(publicationId)).toMatchObject({
      status: "not_found",
    });
    expect(await repository.inspectSource(sourceId)).toBeNull();
  });

  it("commits a checkpointed pending generation during recovery", async () => {
    const { store, vectors, structurals } = createStore();
    writeFileIndexJournal(journalPath, journal());
    await repository.preparePublication(publication());
    vectors[file] = {
      ...preparedFile().cacheEntry,
      generation,
      visibility: "pending",
    };
    structurals[file] = {
      ...structuralEntry(),
      generation,
      status: "current",
    };

    await expect(
      recoverJournaledRepositoryPublications({
        journalPath,
        store,
        repository,
        isCancelled: () => false,
      }),
    ).resolves.toMatchObject({ committedFiles: 1, pending: false });
    expect(vectors[file]?.visibility).toBe("current");
    expect(await repository.inspectSource(sourceId)).toMatchObject({
      generation,
    });
  });

  it("finishes cache cleanup when the repository already committed", async () => {
    const { store, vectors, structurals } = createStore();
    writeFileIndexJournal(journalPath, journal());
    await repository.preparePublication(publication());
    await repository.commitPublication(publicationId);
    vectors[file] = {
      ...preparedFile().cacheEntry,
      generation,
      visibility: "pending",
    };
    structurals[file] = {
      ...structuralEntry(),
      generation,
      status: "current",
    };

    await expect(
      recoverJournaledRepositoryPublications({
        journalPath,
        store,
        repository,
        isCancelled: () => false,
      }),
    ).resolves.toMatchObject({ committedFiles: 1, pending: false });
    expect(vectors[file]?.visibility).toBe("current");
    expect(loadFileIndexJournal(journalPath)).toMatchObject({
      status: "valid",
      journal: { operations: [] },
    });
  });

  it("keeps ownership pending when a newer source makes the commit stale", async () => {
    const { store, vectors, structurals } = createStore();
    const newer = publication();
    newer.publicationId = "publication-newer";
    newer.generation = "generation-newer";
    newer.source.revision = {
      id: "hash-newer",
      contentHash: "hash-newer",
      observedAt: "2026-07-25T01:00:00.000Z",
    };
    newer.chunks[0]!.id = "chunk-newer";
    newer.chunks[0]!.revisionId = "hash-newer";
    newer.chunks[0]!.generation = "generation-newer";
    newer.expectedChunkIds = ["chunk-newer"];
    await repository.preparePublication(newer);
    await repository.commitPublication(newer.publicationId);

    writeFileIndexJournal(journalPath, journal());
    await repository.preparePublication(publication());
    vectors[file] = {
      ...preparedFile().cacheEntry,
      generation,
      visibility: "pending",
    };
    structurals[file] = {
      ...structuralEntry(),
      generation,
      status: "current",
    };

    await expect(
      recoverJournaledRepositoryPublications({
        journalPath,
        store,
        repository,
        isCancelled: () => false,
      }),
    ).resolves.toMatchObject({ committedFiles: 0, pending: true });
    expect(vectors[file]?.visibility).toBe("pending");
    expect(loadFileIndexJournal(journalPath)).toMatchObject({
      status: "valid",
      journal: { operations: [{ operationId: publicationId }] },
    });
    expect(await repository.inspectSource(sourceId)).toMatchObject({
      generation: "generation-newer",
      source: { revision: { id: "hash-newer" } },
    });
  });
});
