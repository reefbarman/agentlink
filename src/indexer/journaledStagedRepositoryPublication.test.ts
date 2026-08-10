import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RetrievalStagedPublicationInspection } from "../core/retrieval/contracts.js";
import {
  emptyFileIndexJournal,
  loadFileIndexJournal,
  writeFileIndexJournal,
} from "./fileIndexJournal.js";
import type {
  FileReplacementStore,
  PreparedRepositoryFilePublication,
} from "./journaledRepositoryPublication.js";
import {
  executeJournaledStagedRepositoryPublications,
  recoverJournaledStagedRepositoryPublications,
  type StagedRepositoryPublicationPort,
} from "./journaledStagedRepositoryPublication.js";
import type { StructuralFileEntry } from "./structuralGraph.js";
import type { CachedFileEntry } from "./types.js";

describe("journaled staged repository publication", () => {
  let directory: string;
  let journalPath: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "agentlink-staged-journal-"),
    );
    journalPath = path.join(directory, "index.journal.json");
  });

  afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

  it("stages bounded batches and flushes the committed prefix when activation fails", async () => {
    const first = prepared("one", 205);
    const second = prepared("two", 1);
    const { port, events } = createPort();
    port.activate = vi.fn(async (id) => {
      events.push(`activate:${id}`);
      if (id === "publication:two") throw new Error("stop");
    });
    const { store, vectors } = createStore();

    await expect(
      executeJournaledStagedRepositoryPublications({
        journalPath,
        publications: [first, second],
        store,
        port,
        fenceToken: "7",
        isCancelled: () => false,
      }),
    ).rejects.toThrow("stop");

    expect(
      events.filter((event) => event.startsWith("chunks:publication:one")),
    ).toEqual([
      "chunks:publication:one:0:100",
      "chunks:publication:one:1:100",
      "chunks:publication:one:2:5",
    ]);
    expect(vectors[first.file]?.visibility).toBe("current");
    expect(loadFileIndexJournal(journalPath)).toMatchObject({
      status: "valid",
      journal: { operations: [{ operationId: "publication:two" }] },
    });
    expect(events).toContain("begin:publication:one");
    expect(events).toContain("finalize-after-journal:publication:one");
  });

  it("checkpoints the cache and rewrites the journal once per batch", async () => {
    const first = prepared("one", 3);
    const second = prepared("two", 2);
    const { port, events } = createPort();
    const { store, vectors, structurals } = createStore();
    const batchWrites = { vectors: 0, structurals: 0 };
    store.checkpointVectors = (entries) => {
      batchWrites.vectors += 1;
      for (const [file, entry] of entries) {
        if (entry) vectors[file] = structuredClone(entry);
        else delete vectors[file];
      }
    };
    store.checkpointStructurals = (entries) => {
      batchWrites.structurals += 1;
      for (const [file, entry] of entries) {
        if (entry) structurals[file] = structuredClone(entry);
        else delete structurals[file];
      }
    };

    await expect(
      executeJournaledStagedRepositoryPublications({
        journalPath,
        publications: [first, second],
        store,
        port,
        fenceToken: "7",
        isCancelled: () => false,
      }),
    ).resolves.toMatchObject({
      committedFiles: 2,
      recordsUpserted: 5,
      pending: false,
      cancelled: false,
    });

    expect(batchWrites).toEqual({ vectors: 2, structurals: 1 });
    expect(vectors[first.file]?.visibility).toBe("current");
    expect(vectors[second.file]?.visibility).toBe("current");
    expect(loadFileIndexJournal(journalPath)).toMatchObject({
      journal: { operations: [] },
    });
    expect(events).toContain("finalize-after-journal:publication:one");
    expect(events).toContain("finalize-after-journal:publication:two");
  });

  it("recovers an activated receipt with matching pending cache", async () => {
    const item = prepared("one", 1);
    const { store, vectors, structurals } = createStore();
    vectors[item.file] = {
      ...item.cacheEntry,
      generation: item.publication.generation,
      visibility: "pending",
    };
    structurals[item.file] = {
      ...item.structuralEntry,
      generation: item.publication.generation,
      status: "current",
    };
    writeFileIndexJournal(journalPath, journal(item));
    const { port } = createPort({ "publication:one": "activated" });
    const progress: Array<[number, number]> = [];

    await expect(
      recoverJournaledStagedRepositoryPublications({
        journalPath,
        store,
        port,
        isCancelled: () => false,
        onProgress: (completed, total) => progress.push([completed, total]),
      }),
    ).resolves.toMatchObject({ committedFiles: 1, pending: false });
    expect(progress).toEqual([
      [0, 1],
      [1, 1],
    ]);
    expect(vectors[item.file]?.visibility).toBe("current");
    expect(loadFileIndexJournal(journalPath)).toMatchObject({
      journal: { operations: [] },
    });
  });

  it("keeps an activated receipt pending when cache evidence is missing", async () => {
    const item = prepared("one", 1);
    writeFileIndexJournal(journalPath, journal(item));
    const { port } = createPort({ "publication:one": "activated" });

    await expect(
      recoverJournaledStagedRepositoryPublications({
        journalPath,
        store: createStore().store,
        port,
        isCancelled: () => false,
      }),
    ).resolves.toMatchObject({ committedFiles: 0, pending: true });
    expect(loadFileIndexJournal(journalPath)).toMatchObject({
      journal: { operations: [{ operationId: "publication:one" }] },
    });
  });

  it("adopts a stale staged manifest before aborting mismatched ownership", async () => {
    const item = prepared("one", 1);
    writeFileIndexJournal(journalPath, journal(item));
    const { store, vectors, structurals } = createStore();
    vectors[item.file] = structuredClone(item.cacheEntry);
    structurals[item.file] = structuredClone(item.structuralEntry);
    const { port, events } = createPort({ "publication:one": "staged" });
    port.inspectStagedPublication = vi.fn(async () => ({
      ...inspection("publication:one", "staged"),
      fenceToken: "6",
    }));

    await expect(
      recoverJournaledStagedRepositoryPublications({
        journalPath,
        store,
        port,
        isCancelled: () => false,
      }),
    ).resolves.toMatchObject({ committedFiles: 0, pending: false });
    expect(events).toContain("adopt:publication:one");
    expect(vectors[item.file]).toEqual(item.cacheEntry);
    expect(structurals[item.file]).toEqual(item.structuralEntry);
    expect(loadFileIndexJournal(journalPath)).toMatchObject({
      journal: { operations: [] },
    });
  });

  it("preserves prior cache ownership when journal intent was never staged", async () => {
    const item = prepared("one", 1);
    const { store, vectors, structurals } = createStore();
    vectors[item.file] = structuredClone(item.cacheEntry);
    structurals[item.file] = structuredClone(item.structuralEntry);
    writeFileIndexJournal(journalPath, journal(item));
    const { port } = createPort();

    await expect(
      recoverJournaledStagedRepositoryPublications({
        journalPath,
        store,
        port,
        isCancelled: () => false,
      }),
    ).resolves.toMatchObject({ committedFiles: 0, pending: false });
    expect(vectors[item.file]).toEqual(item.cacheEntry);
    expect(structurals[item.file]).toEqual(item.structuralEntry);
    expect(loadFileIndexJournal(journalPath)).toMatchObject({
      journal: { operations: [] },
    });
  });

  function createPort(
    initialStates: Record<
      string,
      RetrievalStagedPublicationInspection["state"]
    > = {},
  ) {
    const events: string[] = [];
    const states = new Map(Object.entries(initialStates));
    const port: StagedRepositoryPublicationPort = {
      fenceToken: "7",
      async runFenced(operation) {
        return operation();
      },
      async inspectStagedPublication(id) {
        const state = states.get(id);
        return state ? inspection(id, state) : null;
      },
      async stagePublication(bundle) {
        states.set(bundle.manifest.publicationId, "staging");
        events.push(`begin:${bundle.manifest.publicationId}`);
        for (const batch of bundle.chunkBatches) {
          events.push(
            `chunks:${batch.publicationId}:${batch.batchIndex}:${batch.chunks.length}`,
          );
        }
        states.set(bundle.manifest.publicationId, "staged");
      },
      async adoptStagedPublication(id) {
        events.push(`adopt:${id}`);
      },
      async abortStagedPublication(id) {
        states.delete(id);
      },
      async optimizeStagedStore() {},
      async activate(id) {
        states.set(id, "activated");
        events.push(`activate:${id}`);
      },
      async cleanupSupersededGenerations(entries) {
        events.push(
          `cleanup-superseded:${entries.map((entry) => entry.sourceId).join(",")}`,
        );
      },
      async finalizeActivations(ids) {
        const journal = loadFileIndexJournal(journalPath);
        for (const id of ids) {
          const operationStillPresent =
            journal.status === "valid" &&
            journal.journal.operations.some(
              (operation) => operation.operationId === id,
            );
          events.push(
            operationStillPresent
              ? `finalize-before-journal:${id}`
              : `finalize-after-journal:${id}`,
          );
          states.delete(id);
        }
      },
    };
    return { port, events };
  }

  function createStore() {
    const vectors: Record<string, CachedFileEntry> = {};
    const structurals: Record<string, StructuralFileEntry> = {};
    const store: FileReplacementStore = {
      getVector: (file) => vectors[file],
      getStructural: (file) => structurals[file],
      checkpointVector(file, entry) {
        if (entry) vectors[file] = structuredClone(entry);
        else delete vectors[file];
      },
      checkpointStructural(file, entry) {
        if (entry) structurals[file] = structuredClone(entry);
        else delete structurals[file];
      },
    };
    return { store, vectors, structurals };
  }
});

function prepared(
  name: string,
  count: number,
): PreparedRepositoryFilePublication {
  const file = `src/${name}.ts`;
  const generation = `generation:${name}`;
  const revision = `hash:${name}`;
  const chunks = Array.from({ length: count }, (_, index) => ({
    id: `chunk:${name}:${index}`,
    sourceId: `source:${name}`,
    revisionId: revision,
    generation,
    content: `const value${index} = ${index};`,
    embedding: [1, 0, 0],
    location: { path: file, startLine: index + 1, endLine: index + 1 },
    metadata: {},
  }));
  return {
    file,
    publication: {
      publicationId: `publication:${name}`,
      generation,
      source: {
        id: `source:${name}`,
        namespace: "code",
        kind: "file",
        revision: {
          id: revision,
          contentHash: revision,
          observedAt: "2026-07-28T00:00:00.000Z",
        },
        path: file,
        content: chunks.map((chunk) => chunk.content).join("\n"),
        metadata: {},
      },
      chunks,
      relations: [],
      expectedChunkIds: chunks.map((chunk) => chunk.id),
      expectedRelationIds: [],
    },
    oldRecordIds: [`old:${name}`],
    cacheEntry: {
      hash: revision,
      recordIds: chunks.map((chunk) => chunk.id),
      indexedAt: "2026-07-28T00:00:00.000Z",
    },
    structuralEntry: {
      relPath: file,
      sourceId: `source:${name}`,
      hash: revision,
      indexedAt: "2026-07-28T00:00:00.000Z",
      imports: [],
      exports: [],
      symbols: [],
    },
  };
}

function journal(item: PreparedRepositoryFilePublication) {
  return {
    ...emptyFileIndexJournal(),
    operations: [
      {
        operationId: item.publication.publicationId,
        file: item.file,
        kind: "replace" as const,
        generation: item.publication.generation,
        targetHash: item.publication.source.revision.id,
        oldRecordIds: item.oldRecordIds,
        intendedBatches: [
          { batch: 0, recordIds: item.publication.expectedChunkIds },
        ],
      },
    ],
  };
}

function inspection(
  id: string,
  state: RetrievalStagedPublicationInspection["state"],
): RetrievalStagedPublicationInspection {
  return {
    publicationId: id,
    sourceId: `source:${id.split(":")[1]}`,
    revisionId: `hash:${id.split(":")[1]}`,
    generation: `generation:${id.split(":")[1]}`,
    fenceToken: "7",
    state,
    expectedChunkCount: 1,
    expectedRelationCount: 0,
    expectedChunkDigest: "digest",
    expectedRelationDigest: "digest",
    sourcePayloadDigest: "digest",
  };
}
