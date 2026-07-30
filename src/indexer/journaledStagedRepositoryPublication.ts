import type {
  FileReplacementStore,
  JournaledRepositoryPublicationResult,
  PreparedRepositoryFilePublication,
} from "./journaledRepositoryPublication.js";
import type {
  RetrievalPublicationRequest,
  RetrievalStagedPublicationInspection,
  RetrievalStagedPublicationManifest,
} from "../core/retrieval/contracts.js";
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

export interface StagedRepositoryPublicationPort {
  readonly fenceToken: string;
  runFenced<T>(operation: () => Promise<T>): Promise<T>;
  beginStagedPublication(
    manifest: RetrievalStagedPublicationManifest,
  ): Promise<unknown>;
  appendStagedChunkBatch(batch: {
    publicationId: string;
    batchIndex: number;
    expectedIdDigest: string;
    expectedContentDigest: string;
    chunks: RetrievalPublicationRequest["chunks"];
  }): Promise<void>;
  appendStagedRelationBatch(batch: {
    publicationId: string;
    batchIndex: number;
    expectedIdDigest: string;
    expectedContentDigest: string;
    relations: RetrievalPublicationRequest["relations"];
  }): Promise<void>;
  completeStagedPublication(publicationId: string): Promise<void>;
  adoptStagedPublication(publicationId: string): Promise<void>;
  inspectStagedPublication(
    publicationId: string,
  ): Promise<RetrievalStagedPublicationInspection | null>;
  abortStagedPublication(publicationId: string): Promise<void>;
  activate(publicationId: string): Promise<unknown>;
  finalizeActivation(publicationId: string): Promise<void>;
  /** Compacts staged tables and prunes their old versions. */
  optimizeStagedStore(): Promise<void>;
}

const STAGED_BATCH_SIZE = 100;

export async function executeJournaledStagedRepositoryPublications(args: {
  journalPath: string;
  publications: PreparedRepositoryFilePublication[];
  store: FileReplacementStore;
  port: StagedRepositoryPublicationPort;
  fenceToken: string;
  isCancelled: () => boolean;
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

  let committedFiles = 0;
  let recordsUpserted = 0;
  let recordsDeleted = 0;
  for (const prepared of args.publications) {
    if (args.isCancelled()) {
      return pendingResult(
        committedFiles,
        recordsUpserted,
        recordsDeleted,
        true,
      );
    }
    await stagePublication(prepared.publication, args.port, args.fenceToken);
    await args.port.runFenced(async () => {
      checkpointPending(args.store, prepared);
    });
    if (args.isCancelled()) {
      return pendingResult(
        committedFiles,
        recordsUpserted,
        recordsDeleted,
        true,
      );
    }
    await args.port.activate(prepared.publication.publicationId);
    await args.port.runFenced(async () => {
      checkpointCurrent(args.store, prepared);
      removeJournalOperation(
        args.journalPath,
        journal,
        prepared.publication.publicationId,
      );
    });
    await args.port.finalizeActivation(prepared.publication.publicationId);
    committedFiles += 1;
    recordsUpserted += prepared.publication.expectedChunkIds.length;
    recordsDeleted += prepared.oldRecordIds.length;
  }
  return {
    committedFiles,
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
  for (const operation of replacements) {
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
      continue;
    }

    await args.port.activate(operation.operationId);
    await args.port.runFenced(async () => {
      args.store.checkpointVector(operation.file, {
        ...vector,
        visibility: "current",
      });
      removeJournalOperation(
        args.journalPath,
        loaded.journal,
        operation.operationId,
      );
    });
    await args.port.finalizeActivation(operation.operationId);
    committedFiles += 1;
    recordsUpserted += operation.intendedBatches.reduce(
      (total, batch) => total + batch.recordIds.length,
      0,
    );
    recordsDeleted += operation.oldRecordIds.length;
  }
  return {
    committedFiles,
    recordsUpserted,
    recordsDeleted,
    cancelled: false,
    pending: false,
  };
}

async function stagePublication(
  publication: RetrievalPublicationRequest,
  port: StagedRepositoryPublicationPort,
  fenceToken: string,
): Promise<void> {
  const existing = await port.inspectStagedPublication(
    publication.publicationId,
  );
  if (!existing) {
    await port.beginStagedPublication({
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
    });
  }
  for (const [batchIndex, chunks] of batchValues(
    publication.chunks,
  ).entries()) {
    await port.appendStagedChunkBatch({
      publicationId: publication.publicationId,
      batchIndex,
      expectedIdDigest: createRetrievalRecordIdDigest(
        chunks.map((chunk) => chunk.id),
      ),
      expectedContentDigest: createRetrievalRecordContentDigest(chunks),
      chunks,
    });
  }
  for (const [batchIndex, relations] of batchValues(
    publication.relations,
  ).entries()) {
    await port.appendStagedRelationBatch({
      publicationId: publication.publicationId,
      batchIndex,
      expectedIdDigest: createRetrievalRecordIdDigest(
        relations.map((relation) => relation.id),
      ),
      expectedContentDigest: createRetrievalRecordContentDigest(relations),
      relations,
    });
  }
  await port.completeStagedPublication(publication.publicationId);
}

function checkpointPending(
  store: FileReplacementStore,
  prepared: PreparedRepositoryFilePublication,
): void {
  store.checkpointVector(prepared.file, {
    ...prepared.cacheEntry,
    generation: prepared.publication.generation,
    visibility: "pending",
  });
  store.checkpointStructural(prepared.file, {
    ...prepared.structuralEntry,
    generation: prepared.publication.generation,
    status: "current",
  });
}

function checkpointCurrent(
  store: FileReplacementStore,
  prepared: PreparedRepositoryFilePublication,
): void {
  store.checkpointVector(prepared.file, {
    ...prepared.cacheEntry,
    generation: prepared.publication.generation,
    visibility: "current",
  });
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
    removeJournalOperation(args.journalPath, journal, operation.operationId);
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
    removeJournalOperation(args.journalPath, journal, operation.operationId);
  });
}

function removeJournalOperation(
  journalPath: string,
  journal: ReturnType<typeof emptyFileIndexJournal>,
  operationId: string,
): void {
  journal.operations = journal.operations.filter(
    (operation) => operation.operationId !== operationId,
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
