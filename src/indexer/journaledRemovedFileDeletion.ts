import {
  emptyFileIndexJournal,
  loadFileIndexJournal,
  writeFileIndexJournal,
  type FileIndexJournal,
} from "./fileIndexJournal.js";
import {
  executeRemovedFileDeletes,
  planRemovedFileDeletes,
  type RemovedFileDeleteInput,
} from "./removedFileDeletion.js";

export interface JournaledRemovedFileDeletionResult {
  completedRelPaths: string[];
  errors: string[];
  pointsDeleted: number;
  cancelled: boolean;
  pending: boolean;
}

export async function executeJournaledRemovedFileDeletes(args: {
  journalPath: string;
  requestedFiles: RemovedFileDeleteInput[];
  deleteBatch: (pointIds: string[]) => Promise<void>;
  checkpointCompleted: (relPaths: string[]) => void;
  isCancelled: () => boolean;
  createId: () => string;
}): Promise<JournaledRemovedFileDeletionResult> {
  const loaded = loadFileIndexJournal(args.journalPath);
  if (loaded.status === "corrupt") {
    throw new Error(`File index journal is corrupt: ${loaded.error}`);
  }
  assertRemovalOnly(loaded.journal);

  const recovered = await executeJournalOperations(loaded.journal, args);
  if (recovered.pending || recovered.cancelled) return recovered;

  const recoveredFiles = new Set(recovered.completedRelPaths);
  const requestedPlans = planRemovedFileDeletes(
    args.requestedFiles.filter((file) => !recoveredFiles.has(file.relPath)),
  );
  if (requestedPlans.length === 0) return recovered;

  const journal: FileIndexJournal = {
    ...emptyFileIndexJournal(),
    operations: requestedPlans.map((plan) => ({
      operationId: args.createId(),
      file: plan.relPath,
      kind: "remove",
      generation: args.createId(),
      targetHash: null,
      oldPointIds: plan.pointIds,
      intendedBatches: [],
    })),
  };
  writeFileIndexJournal(args.journalPath, journal);

  const removed = await executeJournalOperations(journal, args);
  return {
    completedRelPaths: [
      ...recovered.completedRelPaths,
      ...removed.completedRelPaths,
    ],
    errors: [...recovered.errors, ...removed.errors],
    pointsDeleted: recovered.pointsDeleted + removed.pointsDeleted,
    cancelled: removed.cancelled,
    pending: removed.pending,
  };
}

async function executeJournalOperations(
  journal: FileIndexJournal,
  args: {
    journalPath: string;
    deleteBatch: (pointIds: string[]) => Promise<void>;
    checkpointCompleted: (relPaths: string[]) => void;
    isCancelled: () => boolean;
  },
): Promise<JournaledRemovedFileDeletionResult> {
  if (journal.operations.length === 0) {
    return {
      completedRelPaths: [],
      errors: [],
      pointsDeleted: 0,
      cancelled: args.isCancelled(),
      pending: false,
    };
  }

  const result = await executeRemovedFileDeletes(
    planRemovedFileDeletes(
      journal.operations.map((operation) => ({
        relPath: operation.file,
        pointIds: operation.oldPointIds,
      })),
    ),
    {
      deleteBatch: args.deleteBatch,
      isCancelled: args.isCancelled,
    },
  );

  if (result.completedRelPaths.length > 0) {
    args.checkpointCompleted(result.completedRelPaths);
    const completed = new Set(result.completedRelPaths);
    writeFileIndexJournal(args.journalPath, {
      ...journal,
      operations: journal.operations.filter(
        (operation) => !completed.has(operation.file),
      ),
    });
  }

  const pending =
    result.errors.length > 0 ||
    result.completedRelPaths.length !== journal.operations.length;
  return {
    ...result,
    cancelled: result.cancelled || args.isCancelled(),
    pending,
  };
}

function assertRemovalOnly(journal: FileIndexJournal): void {
  const replacement = journal.operations.find(
    (operation) => operation.kind === "replace",
  );
  if (replacement) {
    throw new Error(
      `Replacement journal recovery is not implemented for ${replacement.file}`,
    );
  }
}
