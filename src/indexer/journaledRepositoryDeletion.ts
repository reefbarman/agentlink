import type {
  RetrievalDeleteSourceOutcome,
  RetrievalRepository,
} from "../core/retrieval/contracts.js";
import {
  emptyFileIndexJournal,
  loadFileIndexJournal,
  writeFileIndexJournal,
} from "./fileIndexJournal.js";

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

export async function executeJournaledRepositoryDeletions(args: {
  journalPath: string;
  requestedFiles: RepositoryFileDeletion[];
  repository: Pick<RetrievalRepository, "deleteSource">;
  resolveSource: (file: string) => RepositorySourceDeletion;
  checkpointCompleted: (files: string[]) => void;
  runFenced<T>(operation: () => Promise<T>): Promise<T>;
  isCancelled: () => boolean;
  createId: () => string;
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

  const recovered = await recoverJournaledRepositoryDeletions({
    journalPath: args.journalPath,
    repository: args.repository,
    resolveSource: args.resolveSource,
    checkpointCompleted: args.checkpointCompleted,
    runFenced: args.runFenced,
    isCancelled: args.isCancelled,
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
  const removed = await recoverJournaledRepositoryDeletions({
    journalPath: args.journalPath,
    repository: args.repository,
    resolveSource: args.resolveSource,
    checkpointCompleted: args.checkpointCompleted,
    runFenced: args.runFenced,
    isCancelled: args.isCancelled,
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
  repository: Pick<RetrievalRepository, "deleteSource">;
  resolveSource: (file: string) => RepositorySourceDeletion;
  checkpointCompleted: (files: string[]) => void;
  runFenced<T>(operation: () => Promise<T>): Promise<T>;
  isCancelled: () => boolean;
}): Promise<JournaledRepositoryDeletionResult> {
  const loaded = loadFileIndexJournal(args.journalPath);
  if (loaded.status === "corrupt") {
    throw new Error(`File index journal is corrupt: ${loaded.error}`);
  }
  const completedFiles: string[] = [];
  const remaining = [...loaded.journal.operations];
  let recordsDeleted = 0;
  for (const operation of loaded.journal.operations) {
    if (operation.kind !== "remove") {
      throw new Error(
        `Replacement journal recovery is not implemented for ${operation.file}`,
      );
    }
    if (args.isCancelled()) {
      return { completedFiles, recordsDeleted, cancelled: true, pending: true };
    }
    const request = args.resolveSource(operation.file);
    let outcome: RetrievalDeleteSourceOutcome;
    try {
      outcome = await args.repository.deleteSource({
        sourceId: request.sourceId,
        ...(request.expectedRevisionId
          ? { expectedRevisionId: request.expectedRevisionId }
          : {}),
      });
    } catch (error) {
      return {
        completedFiles,
        recordsDeleted,
        cancelled: false,
        pending: true,
        failure: `Repository source deletion failed for ${operation.file}: ${error}`,
      };
    }
    if (outcome.status === "stale_source") {
      return {
        completedFiles,
        recordsDeleted,
        cancelled: false,
        pending: true,
        failure: `Repository source deletion retained stale ownership for ${operation.file}`,
      };
    }
    await args.runFenced(async () => {
      args.checkpointCompleted([operation.file]);
      const completedIndex = remaining.findIndex(
        (candidate) => candidate.operationId === operation.operationId,
      );
      if (completedIndex >= 0) remaining.splice(completedIndex, 1);
      writeFileIndexJournal(args.journalPath, {
        ...loaded.journal,
        operations: remaining,
      });
    });
    completedFiles.push(operation.file);
    recordsDeleted += outcome.recordsRemoved;
  }
  return {
    completedFiles,
    recordsDeleted,
    cancelled: args.isCancelled(),
    pending: false,
  };
}
