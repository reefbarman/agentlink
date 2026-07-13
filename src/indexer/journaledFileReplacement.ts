import {
  emptyFileIndexJournal,
  loadFileIndexJournal,
  writeFileIndexJournal,
} from "./fileIndexJournal.js";

import type { CachedFileEntry } from "./types.js";
import type { QdrantPoint } from "./qdrantClient.js";
import type { StructuralFileEntry } from "./structuralGraph.js";

const QDRANT_DELETE_BATCH_SIZE = 256;

export interface PreparedFileReplacement {
  file: string;
  generation: string;
  targetHash: string;
  oldPointIds: string[];
  points: QdrantPoint[];
  structuralEntry: StructuralFileEntry;
  cacheEntry: Omit<CachedFileEntry, "generation" | "visibility">;
}

export interface FileReplacementStore {
  getVector(file: string): CachedFileEntry | undefined;
  getStructural(file: string): StructuralFileEntry | undefined;
  getPendingVectors(): Array<[string, CachedFileEntry]>;
  checkpointVector(file: string, entry: CachedFileEntry | null): void;
  checkpointStructural(file: string, entry: StructuralFileEntry | null): void;
}

export interface FileReplacementRemote {
  deletePoints(pointIds: string[]): Promise<void>;
  upsertPoints(points: QdrantPoint[]): Promise<void>;
  setVisibility(pointIds: string[], visible: boolean): Promise<void>;
}

export interface FileReplacementResult {
  committed: boolean;
  cancelled: boolean;
  pointsDeleted: number;
  pointsUpserted: number;
}

export async function recoverJournaledFileReplacements(args: {
  journalPath: string;
  store: FileReplacementStore;
  remote: FileReplacementRemote;
  isCancelled: () => boolean;
}): Promise<{
  recoveredFiles: string[];
  cancelled: boolean;
  pointsDeleted: number;
}> {
  const loaded = loadFileIndexJournal(args.journalPath);
  if (loaded.status === "corrupt") {
    throw new Error(`File index journal is corrupt: ${loaded.error}`);
  }

  const replacements = loaded.journal.operations.filter(
    (operation) => operation.kind === "replace",
  );
  if (replacements.length === 0) {
    const reconciled = await reconcilePendingVisibility(
      args.store,
      args.remote,
      args.isCancelled,
    );
    return {
      recoveredFiles: [],
      cancelled: reconciled.cancelled,
      pointsDeleted: reconciled.pointsDeleted,
    };
  }
  if (loaded.journal.operations.length !== replacements.length) {
    throw new Error(
      "Mixed removal and replacement journal recovery is unsupported",
    );
  }

  const recoveredFiles: string[] = [];
  let pointsDeleted = 0;
  let journal = loaded.journal;
  for (const operation of replacements) {
    if (args.isCancelled()) {
      return { recoveredFiles, cancelled: true, pointsDeleted };
    }
    const intendedIds = operation.intendedBatches.flatMap(
      (batch) => batch.pointIds,
    );
    const vector = args.store.getVector(operation.file);
    const structural = args.store.getStructural(operation.file);
    const exactVector =
      vector?.generation === operation.generation &&
      vector.hash === operation.targetHash &&
      sameIds(vector.pointIds, intendedIds) &&
      (vector.visibility === "pending" || vector.visibility === "current");
    const exactStructural =
      structural?.generation === operation.generation &&
      structural.hash === operation.targetHash &&
      structural.status === "current";

    if (exactVector && exactStructural) {
      if (vector.visibility !== "current") {
        await args.remote.setVisibility(intendedIds, true);
        args.store.checkpointVector(operation.file, {
          ...vector,
          visibility: "current",
        });
      }
      journal = withoutOperation(journal, operation.operationId);
      writeFileIndexJournal(args.journalPath, journal);
      recoveredFiles.push(operation.file);
      continue;
    }

    const cleanup = await deleteOwnedPoints(
      unique([...operation.oldPointIds, ...intendedIds]),
      args.remote,
      args.isCancelled,
    );
    pointsDeleted += cleanup.pointsDeleted;
    if (cleanup.cancelled) {
      return { recoveredFiles, cancelled: true, pointsDeleted };
    }
    args.store.checkpointStructural(operation.file, null);
    args.store.checkpointVector(operation.file, null);
    journal = withoutOperation(journal, operation.operationId);
    writeFileIndexJournal(args.journalPath, journal);
    recoveredFiles.push(operation.file);
  }

  const reconciled = await reconcilePendingVisibility(
    args.store,
    args.remote,
    args.isCancelled,
  );
  pointsDeleted += reconciled.pointsDeleted;
  return { recoveredFiles, cancelled: reconciled.cancelled, pointsDeleted };
}

export async function executeJournaledFileReplacement(args: {
  journalPath: string;
  replacement: PreparedFileReplacement;
  store: FileReplacementStore;
  remote: FileReplacementRemote;
  isCancelled: () => boolean;
  createId: () => string;
}): Promise<FileReplacementResult> {
  const existing = loadFileIndexJournal(args.journalPath);
  if (existing.status === "corrupt") {
    throw new Error(`File index journal is corrupt: ${existing.error}`);
  }
  if (existing.journal.operations.length > 0) {
    throw new Error(
      "Cannot begin replacement while journal operations are active",
    );
  }

  const batches = groupPointIds(args.replacement.points, 100);
  if (batches.length === 0) {
    throw new Error("Replacement requires at least one prepared point");
  }
  const operationId = args.createId();
  writeFileIndexJournal(args.journalPath, {
    ...emptyFileIndexJournal(),
    operations: [
      {
        operationId,
        file: args.replacement.file,
        kind: "replace",
        generation: args.replacement.generation,
        targetHash: args.replacement.targetHash,
        oldPointIds: args.replacement.oldPointIds,
        intendedBatches: batches,
      },
    ],
  });

  args.store.checkpointStructural(args.replacement.file, null);
  await args.remote.setVisibility(args.replacement.oldPointIds, false);
  if (args.isCancelled()) {
    return {
      committed: false,
      cancelled: true,
      pointsDeleted: 0,
      pointsUpserted: 0,
    };
  }
  const oldCleanup = await deleteOwnedPoints(
    args.replacement.oldPointIds,
    args.remote,
    args.isCancelled,
  );
  if (oldCleanup.cancelled) {
    return {
      committed: false,
      cancelled: true,
      pointsDeleted: oldCleanup.pointsDeleted,
      pointsUpserted: 0,
    };
  }

  let pointsUpserted = 0;
  for (let index = 0; index < args.replacement.points.length; index += 100) {
    const batch = args.replacement.points.slice(index, index + 100);
    await args.remote.upsertPoints(batch);
    pointsUpserted += batch.length;
    if (args.isCancelled()) {
      return {
        committed: false,
        cancelled: true,
        pointsDeleted: oldCleanup.pointsDeleted,
        pointsUpserted,
      };
    }
  }

  const pending: CachedFileEntry = {
    ...args.replacement.cacheEntry,
    generation: args.replacement.generation,
    visibility: "pending",
  };
  args.store.checkpointVector(args.replacement.file, pending);
  args.store.checkpointStructural(args.replacement.file, {
    ...args.replacement.structuralEntry,
    generation: args.replacement.generation,
    status: "current",
  });
  await args.remote.setVisibility(
    args.replacement.points.map((point) => point.id),
    true,
  );
  args.store.checkpointVector(args.replacement.file, {
    ...pending,
    visibility: "current",
  });
  writeFileIndexJournal(args.journalPath, emptyFileIndexJournal());
  return {
    committed: true,
    cancelled: args.isCancelled(),
    pointsDeleted: oldCleanup.pointsDeleted,
    pointsUpserted,
  };
}

async function deleteOwnedPoints(
  pointIds: string[],
  remote: FileReplacementRemote,
  isCancelled: () => boolean,
): Promise<{ pointsDeleted: number; cancelled: boolean }> {
  let pointsDeleted = 0;
  for (
    let index = 0;
    index < pointIds.length;
    index += QDRANT_DELETE_BATCH_SIZE
  ) {
    if (isCancelled()) return { pointsDeleted, cancelled: true };
    const batch = pointIds.slice(index, index + QDRANT_DELETE_BATCH_SIZE);
    await remote.deletePoints(batch);
    pointsDeleted += batch.length;
    if (isCancelled()) return { pointsDeleted, cancelled: true };
  }
  return { pointsDeleted, cancelled: false };
}

async function reconcilePendingVisibility(
  store: FileReplacementStore,
  remote: FileReplacementRemote,
  isCancelled: () => boolean,
): Promise<{ pointsDeleted: number; cancelled: boolean }> {
  let pointsDeleted = 0;
  const entries = store.getPendingVectors();
  for (const [file, vector] of entries) {
    if (isCancelled()) return { pointsDeleted, cancelled: true };
    const structural = store.getStructural(file);
    if (
      !vector.generation ||
      structural?.generation !== vector.generation ||
      structural.hash !== vector.hash ||
      structural.status !== "current"
    ) {
      const cleanup = await deleteOwnedPoints(
        vector.pointIds,
        remote,
        isCancelled,
      );
      pointsDeleted += cleanup.pointsDeleted;
      if (cleanup.cancelled) return { pointsDeleted, cancelled: true };
      store.checkpointStructural(file, null);
      store.checkpointVector(file, null);
      continue;
    }
    await remote.setVisibility(vector.pointIds, true);
    store.checkpointVector(file, { ...vector, visibility: "current" });
  }
  return { pointsDeleted, cancelled: isCancelled() };
}

function groupPointIds(points: QdrantPoint[], size: number) {
  const batches: Array<{ batch: number; pointIds: string[] }> = [];
  for (let index = 0; index < points.length; index += size) {
    batches.push({
      batch: batches.length,
      pointIds: points.slice(index, index + size).map((point) => point.id),
    });
  }
  return batches;
}

function withoutOperation(
  journal: ReturnType<typeof emptyFileIndexJournal>,
  operationId: string,
) {
  return {
    ...journal,
    operations: journal.operations.filter(
      (operation) => operation.operationId !== operationId,
    ),
  };
}

function sameIds(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
