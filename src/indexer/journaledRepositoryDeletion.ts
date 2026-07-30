import type {
  RetrievalDeleteSourceOutcome,
  RetrievalRepository,
} from "../core/retrieval/contracts.js";
import {
  emptyFileIndexJournal,
  loadFileIndexJournal,
  writeFileIndexJournal,
} from "./fileIndexJournal.js";

/**
 * Files deleted per repository call and journal checkpoint. Removals are
 * batched so bulk deletes pay per-batch (not per-file) commit, journal
 * rewrite, and cache checkpoint costs.
 */
export const REMOVED_FILE_DELETE_BATCH_SIZE = 100;

export interface RepositoryFileDeletion {
  file: string;
  oldRecordIds: string[];
  generation: string;
}

export interface RepositorySourceDeletion {
  sourceId: string;
  expectedRevisionId?: string;
}

export interface JournaledRepositoryDeletionResult {
  completedFiles: string[];
  recordsDeleted: number;
  cancelled: boolean;
  pending: boolean;
  failure?: string;
}

export interface RepositoryDeletionProgress {
  (completedFiles: number, totalFiles: number): void;
}

export async function executeJournaledRepositoryDeletions(args: {
  journalPath: string;
  requestedFiles: RepositoryFileDeletion[];
  repository: Pick<RetrievalRepository, "deleteSources">;
  resolveSource: (file: string) => RepositorySourceDeletion;
  checkpointCompleted: (files: string[]) => void;
  runFenced<T>(operation: () => Promise<T>): Promise<T>;
  isCancelled: () => boolean;
  createId: () => string;
  onProgress?: RepositoryDeletionProgress;
}): Promise<JournaledRepositoryDeletionResult> {
  const loaded = loadFileIndexJournal(args.journalPath);
  if (loaded.status === "corrupt") {
    throw new Error(`File index journal is corrupt: ${loaded.error}`);
  }
  const replacements = loaded.journal.operations.find(
    (operation) => operation.kind === "replace",
  );
  if (replacements) {
    throw new Error(
      `Replacement journal recovery is not implemented for ${replacements.file}`,
    );
  }

  const intendedTotal =
    loaded.journal.operations.length + args.requestedFiles.length;
  const recovered = await recoverJournaledRepositoryDeletions({
    journalPath: args.journalPath,
    repository: args.repository,
    resolveSource: args.resolveSource,
    checkpointCompleted: args.checkpointCompleted,
    runFenced: args.runFenced,
    isCancelled: args.isCancelled,
    ...(args.onProgress
      ? {
          onProgress: (completed: number) =>
            args.onProgress?.(completed, intendedTotal),
        }
      : {}),
  });
  if (recovered.pending || recovered.cancelled) return recovered;
  const recoveredFiles = new Set(recovered.completedFiles);
  const requested = args.requestedFiles.filter(
    (file) => !recoveredFiles.has(file.file),
  );
  if (requested.length === 0) return recovered;

  await args.runFenced(async () => {
    writeFileIndexJournal(args.journalPath, {
      ...emptyFileIndexJournal(),
      operations: requested.map((file) => ({
        operationId: args.createId(),
        file: file.file,
        kind: "remove" as const,
        generation: file.generation,
        targetHash: null,
        oldRecordIds: file.oldRecordIds,
        intendedBatches: [],
      })),
    });
  });
  const removalTotal = recovered.completedFiles.length + requested.length;
  const removed = await recoverJournaledRepositoryDeletions({
    journalPath: args.journalPath,
    repository: args.repository,
    resolveSource: args.resolveSource,
    checkpointCompleted: args.checkpointCompleted,
    runFenced: args.runFenced,
    isCancelled: args.isCancelled,
    ...(args.onProgress
      ? {
          onProgress: (completed: number) =>
            args.onProgress?.(
              recovered.completedFiles.length + completed,
              removalTotal,
            ),
        }
      : {}),
  });
  return {
    completedFiles: [...recovered.completedFiles, ...removed.completedFiles],
    recordsDeleted: recovered.recordsDeleted + removed.recordsDeleted,
    cancelled: removed.cancelled,
    pending: removed.pending,
    ...(removed.failure ? { failure: removed.failure } : {}),
  };
}

export async function recoverJournaledRepositoryDeletions(args: {
  journalPath: string;
  repository: Pick<RetrievalRepository, "deleteSources">;
  resolveSource: (file: string) => RepositorySourceDeletion;
  checkpointCompleted: (files: string[]) => void;
  runFenced<T>(operation: () => Promise<T>): Promise<T>;
  isCancelled: () => boolean;
  onProgress?: RepositoryDeletionProgress;
}): Promise<JournaledRepositoryDeletionResult> {
  const loaded = loadFileIndexJournal(args.journalPath);
  if (loaded.status === "corrupt") {
    throw new Error(`File index journal is corrupt: ${loaded.error}`);
  }
  const operations = loaded.journal.operations;
  for (const operation of operations) {
    if (operation.kind !== "remove") {
      throw new Error(
        `Replacement journal recovery is not implemented for ${operation.file}`,
      );
    }
  }

  const completedFiles: string[] = [];
  const remaining = [...operations];
  let recordsDeleted = 0;
  args.onProgress?.(0, operations.length);

  const checkpointBatch = async (
    batchCompleted: Array<(typeof operations)[number]>,
  ): Promise<void> => {
    if (batchCompleted.length === 0) return;
    await args.runFenced(async () => {
      args.checkpointCompleted(batchCompleted.map((op) => op.file));
      const completedIds = new Set(batchCompleted.map((op) => op.operationId));
      for (let index = remaining.length - 1; index >= 0; index--) {
        if (completedIds.has(remaining[index].operationId)) {
          remaining.splice(index, 1);
        }
      }
      writeFileIndexJournal(args.journalPath, {
        ...loaded.journal,
        operations: remaining,
      });
    });
    for (const operation of batchCompleted) {
      completedFiles.push(operation.file);
    }
    args.onProgress?.(completedFiles.length, operations.length);
  };

  for (
    let offset = 0;
    offset < operations.length;
    offset += REMOVED_FILE_DELETE_BATCH_SIZE
  ) {
    if (args.isCancelled()) {
      return { completedFiles, recordsDeleted, cancelled: true, pending: true };
    }
    const batch = operations.slice(
      offset,
      offset + REMOVED_FILE_DELETE_BATCH_SIZE,
    );
    let outcomes: RetrievalDeleteSourceOutcome[];
    try {
      outcomes = await args.repository.deleteSources(
        batch.map((operation) => args.resolveSource(operation.file)),
      );
    } catch (error) {
      return {
        completedFiles,
        recordsDeleted,
        cancelled: false,
        pending: true,
        failure: `Repository source deletion failed for ${batch[0].file}: ${error}`,
      };
    }
    const batchCompleted: Array<(typeof operations)[number]> = [];
    let staleFile: string | undefined;
    for (let index = 0; index < batch.length; index++) {
      const outcome = outcomes[index];
      if (outcome.status === "stale_source") {
        staleFile = batch[index].file;
        break;
      }
      batchCompleted.push(batch[index]);
      recordsDeleted += outcome.recordsRemoved;
    }
    await checkpointBatch(batchCompleted);
    if (staleFile !== undefined) {
      return {
        completedFiles,
        recordsDeleted,
        cancelled: false,
        pending: true,
        failure: `Repository source deletion retained stale ownership for ${staleFile}`,
      };
    }
  }
  return {
    completedFiles,
    recordsDeleted,
    cancelled: args.isCancelled(),
    pending: false,
  };
}
