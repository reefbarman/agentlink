import type {
  FileReplacementStore,
  JournaledRepositoryPublicationResult,
  PreparedRepositoryFilePublication,
} from "./journaledRepositoryPublication.js";
import type {
  RetrievalPublicationRequest,
  RetrievalStagedPublicationBundle,
  RetrievalStagedPublicationInspection,
} from "@agentlink/protocol/retrieval-publication";
import {
  createRetrievalRecordContentDigest,
  createRetrievalRecordIdDigest,
  createRetrievalSourcePayloadDigest,
} from "../core/retrieval/publicationDigests.js";
import {
  emptyFileIndexJournal,
  loadFileIndexJournal,
  writeFileIndexJournal,
} from "./fileIndexJournal.js";

import type { CachedFileEntry } from "./types.js";
import type { StructuralFileEntry } from "./structuralGraph.js";

export interface StagedRepositoryPublicationPort {
  readonly fenceToken: string;
  runFenced<T>(operation: () => Promise<T>): Promise<T>;
  /**
   * Stages a complete publication — manifest, batches, and verification — in
   * one fenced store session.
   */
  stagePublication(bundle: RetrievalStagedPublicationBundle): Promise<void>;
  adoptStagedPublication(publicationId: string): Promise<void>;
  inspectStagedPublication(
    publicationId: string,
  ): Promise<RetrievalStagedPublicationInspection | null>;
  abortStagedPublication(publicationId: string): Promise<void>;
  activate(
    publicationId: string,
    options?: {
      freshGeneration?: boolean;
      deferSupersededCleanup?: boolean;
    },
  ): Promise<unknown>;
  /**
   * Removes superseded-generation rows for activated sources with combined
   * predicates, one delete per table per batch instead of per file.
   */
  cleanupSupersededGenerations(
    entries: Array<{ sourceId: string; generation: string }>,
  ): Promise<void>;
  /** Finalizes a set of activated publications in one fenced store session. */
  finalizeActivations(publicationIds: string[]): Promise<void>;
  /** Compacts staged tables and prunes their old versions. */
  optimizeStagedStore(): Promise<void>;
}

const STAGED_BATCH_SIZE = 100;

/**
 * Publishes prepared files in three phases — stage all, activate each, then a
 * single batched checkpoint + journal rewrite + finalize — so cache/journal
 * rewrites and fenced store sessions are paid per batch instead of per file.
 * If activation fails or is cancelled part-way, the activated prefix is
 * flushed (checkpointed, journal-cleared, finalized) before returning, and the
 * remaining journal operations are recovered by the next job.
 */
export async function executeJournaledStagedRepositoryPublications(args: {
  journalPath: string;
  publications: PreparedRepositoryFilePublication[];
  store: FileReplacementStore;
  port: StagedRepositoryPublicationPort;
  fenceToken: string;
  isCancelled: () => boolean;
  onFileActivated?: (activatedCount: number) => void;
}): Promise<JournaledRepositoryPublicationResult> {
  const loaded = loadFileIndexJournal(args.journalPath);
  if (loaded.status === "corrupt") {
    throw new Error(`File index journal is corrupt: ${loaded.error}`);
  }
  if (loaded.journal.operations.length > 0) {
    throw new Error(
      "Cannot begin publication while journal operations are active",
    );
  }
  if (args.publications.length === 0) return emptyResult(args.isCancelled());

  const journal = {
    ...emptyFileIndexJournal(),
    operations: args.publications.map(
      ({ file, publication, oldRecordIds }) => ({
        operationId: publication.publicationId,
        file,
        kind: "replace" as const,
        generation: publication.generation,
        targetHash: publication.source.revision.id,
        oldRecordIds,
        intendedBatches: batchValues(publication.expectedChunkIds).map(
          (recordIds, batch) => ({ batch, recordIds }),
        ),
      }),
    ),
  };
  await args.port.runFenced(async () => {
    writeFileIndexJournal(args.journalPath, journal);
  });

  const staged: PreparedRepositoryFilePublication[] = [];
  for (const prepared of args.publications) {
    if (args.isCancelled()) break;
    await args.port.stagePublication(
      publicationBundle(prepared.publication, args.fenceToken),
    );
    staged.push(prepared);
  }
  if (staged.length > 0) {
    await args.port.runFenced(async () => {
      checkpointPending(args.store, staged);
    });
  }
  if (staged.length < args.publications.length) {
    return pendingResult(0, 0, 0, true);
  }

  const activated: PreparedRepositoryFilePublication[] = [];
  let flushedCount = 0;
  const flushActivated = async () => {
    const unflushed = activated.slice(flushedCount);
    if (unflushed.length === 0) return;
    await args.port.cleanupSupersededGenerations(
      unflushed.map((prepared) => ({
        sourceId: prepared.publication.source.id,
        generation: prepared.publication.generation,
      })),
    );
    await args.port.runFenced(async () => {
      checkpointCurrent(args.store, unflushed);
      removeJournalOperations(
        args.journalPath,
        journal,
        unflushed.map((prepared) => prepared.publication.publicationId),
      );
    });
    flushedCount = activated.length;
    await args.port.finalizeActivations(
      unflushed.map((prepared) => prepared.publication.publicationId),
    );
  };

  try {
    for (const prepared of staged) {
      if (args.isCancelled()) break;
      // Generations are minted fresh in prepareCodeFilePublication, so the
      // activator can skip its replay guards; superseded rows are removed in
      // one combined pass per flush instead of per file.
      await args.port.activate(prepared.publication.publicationId, {
        freshGeneration: true,
        deferSupersededCleanup: true,
      });
      activated.push(prepared);
      args.onFileActivated?.(activated.length);
    }
  } catch (error) {
    await flushActivated();
    throw error;
  }
  await flushActivated();

  const recordsUpserted = activated.reduce(
    (total, prepared) => total + prepared.publication.expectedChunkIds.length,
    0,
  );
  const recordsDeleted = activated.reduce(
    (total, prepared) => total + prepared.oldRecordIds.length,
    0,
  );
  if (activated.length < args.publications.length) {
    return pendingResult(
      activated.length,
      recordsUpserted,
      recordsDeleted,
      true,
    );
  }
  return {
    committedFiles: activated.length,
    recordsUpserted,
    recordsDeleted,
    cancelled: false,
    pending: false,
  };
}

export async function recoverJournaledStagedRepositoryPublications(args: {
  journalPath: string;
  store: FileReplacementStore;
  port: StagedRepositoryPublicationPort;
  isCancelled: () => boolean;
  /**
   * Liveness signal per recovered operation. Recovery on a degraded store can
   * legitimately take minutes; without this the host's inactivity watchdog
   * kills the worker mid-recovery and the job restarts forever.
   */
  onProgress?: (completed: number, total: number) => void;
}): Promise<JournaledRepositoryPublicationResult> {
  const loaded = loadFileIndexJournal(args.journalPath);
  if (loaded.status === "corrupt") {
    throw new Error(`File index journal is corrupt: ${loaded.error}`);
  }
  const replacements = loaded.journal.operations.filter(
    (operation) => operation.kind === "replace",
  );
  if (replacements.length !== loaded.journal.operations.length) {
    throw new Error(
      "Mixed removal and replacement journal recovery is unsupported",
    );
  }

  let committedFiles = 0;
  let recordsUpserted = 0;
  let recordsDeleted = 0;
  let completedOperations = 0;
  for (const operation of replacements) {
    args.onProgress?.(completedOperations, replacements.length);
    if (args.isCancelled()) {
      return pendingResult(
        committedFiles,
        recordsUpserted,
        recordsDeleted,
        true,
      );
    }
    const inspection = await args.port.inspectStagedPublication(
      operation.operationId,
    );
    if (!inspection) {
      await removeUnstagedOperation(args, loaded.journal, operation);
      completedOperations += 1;
      continue;
    }
    const vector = args.store.getVector(operation.file);
    const structural = args.store.getStructural(operation.file);
    const cacheMatches =
      vector?.generation === operation.generation &&
      vector.hash === operation.targetHash &&
      structural?.generation === operation.generation &&
      structural.hash === operation.targetHash;
    if (!cacheMatches) {
      if (inspection.state === "activated") {
        return pendingResult(
          committedFiles,
          recordsUpserted,
          recordsDeleted,
          false,
        );
      }
      if (inspection.fenceToken !== args.port.fenceToken) {
        await args.port.adoptStagedPublication(operation.operationId);
      }
      await args.port.abortStagedPublication(operation.operationId);
      await clearUnrecoverableOperation(args, loaded.journal, operation);
      completedOperations += 1;
      continue;
    }

    await args.port.activate(operation.operationId);
    await args.port.runFenced(async () => {
      args.store.checkpointVector(operation.file, {
        ...vector,
        visibility: "current",
      });
      removeJournalOperations(args.journalPath, loaded.journal, [
        operation.operationId,
      ]);
    });
    await args.port.finalizeActivations([operation.operationId]);
    committedFiles += 1;
    recordsUpserted += operation.intendedBatches.reduce(
      (total, batch) => total + batch.recordIds.length,
      0,
    );
    recordsDeleted += operation.oldRecordIds.length;
    completedOperations += 1;
  }
  args.onProgress?.(completedOperations, replacements.length);
  return {
    committedFiles,
    recordsUpserted,
    recordsDeleted,
    cancelled: false,
    pending: false,
  };
}

function publicationBundle(
  publication: RetrievalPublicationRequest,
  fenceToken: string,
): RetrievalStagedPublicationBundle {
  return {
    manifest: {
      publicationId: publication.publicationId,
      generation: publication.generation,
      fenceToken,
      source: publication.source,
      expectedChunkCount: publication.chunks.length,
      expectedRelationCount: publication.relations.length,
      expectedChunkDigest: createRetrievalRecordIdDigest(
        publication.expectedChunkIds,
      ),
      expectedRelationDigest: createRetrievalRecordIdDigest(
        publication.expectedRelationIds,
      ),
      sourcePayloadDigest: createRetrievalSourcePayloadDigest(
        publication.source,
      ),
    },
    chunkBatches: batchValues(publication.chunks).map((chunks, batchIndex) => ({
      publicationId: publication.publicationId,
      batchIndex,
      expectedIdDigest: createRetrievalRecordIdDigest(
        chunks.map((chunk) => chunk.id),
      ),
      expectedContentDigest: createRetrievalRecordContentDigest(chunks),
      chunks,
    })),
    relationBatches: batchValues(publication.relations).map(
      (relations, batchIndex) => ({
        publicationId: publication.publicationId,
        batchIndex,
        expectedIdDigest: createRetrievalRecordIdDigest(
          relations.map((relation) => relation.id),
        ),
        expectedContentDigest: createRetrievalRecordContentDigest(relations),
        relations,
      }),
    ),
  };
}

function checkpointPending(
  store: FileReplacementStore,
  publications: PreparedRepositoryFilePublication[],
): void {
  const vectors = publications.map(
    ({ file, publication, cacheEntry }): [string, CachedFileEntry] => [
      file,
      {
        ...cacheEntry,
        generation: publication.generation,
        visibility: "pending",
      },
    ],
  );
  const structurals = publications.map(
    ({ file, publication, structuralEntry }): [string, StructuralFileEntry] => [
      file,
      {
        ...structuralEntry,
        generation: publication.generation,
        status: "current",
      },
    ],
  );
  if (store.checkpointVectors) store.checkpointVectors(vectors);
  else for (const [file, entry] of vectors) store.checkpointVector(file, entry);
  if (store.checkpointStructurals) store.checkpointStructurals(structurals);
  else {
    for (const [file, entry] of structurals) {
      store.checkpointStructural(file, entry);
    }
  }
}

function checkpointCurrent(
  store: FileReplacementStore,
  publications: PreparedRepositoryFilePublication[],
): void {
  const vectors = publications.map(
    ({ file, publication, cacheEntry }): [string, CachedFileEntry] => [
      file,
      {
        ...cacheEntry,
        generation: publication.generation,
        visibility: "current",
      },
    ],
  );
  if (store.checkpointVectors) store.checkpointVectors(vectors);
  else for (const [file, entry] of vectors) store.checkpointVector(file, entry);
}

async function removeUnstagedOperation(
  args: {
    journalPath: string;
    port: StagedRepositoryPublicationPort;
  },
  journal: ReturnType<typeof emptyFileIndexJournal>,
  operation: ReturnType<typeof emptyFileIndexJournal>["operations"][number],
): Promise<void> {
  await args.port.runFenced(async () => {
    removeJournalOperations(args.journalPath, journal, [operation.operationId]);
  });
}

async function clearUnrecoverableOperation(
  args: {
    journalPath: string;
    store: FileReplacementStore;
    port: StagedRepositoryPublicationPort;
  },
  journal: ReturnType<typeof emptyFileIndexJournal>,
  operation: ReturnType<typeof emptyFileIndexJournal>["operations"][number],
): Promise<void> {
  await args.port.runFenced(async () => {
    if (
      args.store.getVector(operation.file)?.generation === operation.generation
    ) {
      args.store.checkpointVector(operation.file, null);
    }
    if (
      args.store.getStructural(operation.file)?.generation ===
      operation.generation
    ) {
      args.store.checkpointStructural(operation.file, null);
    }
    removeJournalOperations(args.journalPath, journal, [operation.operationId]);
  });
}

function removeJournalOperations(
  journalPath: string,
  journal: ReturnType<typeof emptyFileIndexJournal>,
  operationIds: string[],
): void {
  const removed = new Set(operationIds);
  journal.operations = journal.operations.filter(
    (operation) => !removed.has(operation.operationId),
  );
  writeFileIndexJournal(journalPath, journal);
}

function batchValues<T>(values: T[]): T[][] {
  const batches: T[][] = [];
  for (let offset = 0; offset < values.length; offset += STAGED_BATCH_SIZE) {
    batches.push(values.slice(offset, offset + STAGED_BATCH_SIZE));
  }
  return batches;
}

function emptyResult(cancelled: boolean): JournaledRepositoryPublicationResult {
  return {
    committedFiles: 0,
    recordsUpserted: 0,
    recordsDeleted: 0,
    cancelled,
    pending: false,
  };
}

function pendingResult(
  committedFiles: number,
  recordsUpserted: number,
  recordsDeleted: number,
  cancelled: boolean,
): JournaledRepositoryPublicationResult {
  return {
    committedFiles,
    recordsUpserted,
    recordsDeleted,
    cancelled,
    pending: true,
  };
}
