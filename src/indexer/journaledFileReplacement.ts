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
  checkpointVectors?(
    entries: Array<[file: string, entry: CachedFileEntry | null]>,
  ): void;
  checkpointStructurals?(
    entries: Array<[file: string, entry: StructuralFileEntry | null]>,
  ): void;
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

export interface FileReplacementBatchResult {
  committedFiles: number;
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

  let pointsDeleted = 0;
  const vectorMutations: Array<[string, CachedFileEntry | null]> = [];
  const structuralMutations: Array<[string, StructuralFileEntry | null]> = [];
  for (const operation of replacements) {
    if (args.isCancelled()) {
      return { recoveredFiles: [], cancelled: true, pointsDeleted };
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
        const published = await setOwnedPointVisibility(
          intendedIds,
          true,
          args.remote,
          args.isCancelled,
        );
        if (published.cancelled) {
          return { recoveredFiles: [], cancelled: true, pointsDeleted };
        }
        vectorMutations.push([
          operation.file,
          { ...vector, visibility: "current" },
        ]);
      }
      continue;
    }

    const cleanup = await deleteOwnedPoints(
      unique([...operation.oldPointIds, ...intendedIds]),
      args.remote,
      args.isCancelled,
    );
    pointsDeleted += cleanup.pointsDeleted;
    if (cleanup.cancelled) {
      return { recoveredFiles: [], cancelled: true, pointsDeleted };
    }
    structuralMutations.push([operation.file, null]);
    vectorMutations.push([operation.file, null]);
  }

  checkpointStructuralEntries(args.store, structuralMutations);
  checkpointVectorEntries(args.store, vectorMutations);
  writeFileIndexJournal(args.journalPath, emptyFileIndexJournal());

  const reconciled = await reconcilePendingVisibility(
    args.store,
    args.remote,
    args.isCancelled,
  );
  pointsDeleted += reconciled.pointsDeleted;
  return {
    recoveredFiles: replacements.map((operation) => operation.file),
    cancelled: reconciled.cancelled,
    pointsDeleted,
  };
}

export async function executeJournaledFileReplacement(args: {
  journalPath: string;
  replacement: PreparedFileReplacement;
  store: FileReplacementStore;
  remote: FileReplacementRemote;
  isCancelled: () => boolean;
  createId: () => string;
}): Promise<FileReplacementResult> {
  const result = await executeJournaledFileReplacements({
    ...args,
    replacements: [args.replacement],
  });
  return {
    committed: result.committedFiles === 1,
    cancelled: result.cancelled,
    pointsDeleted: result.pointsDeleted,
    pointsUpserted: result.pointsUpserted,
  };
}

export async function executeJournaledFileReplacements(args: {
  journalPath: string;
  replacements: PreparedFileReplacement[];
  store: FileReplacementStore;
  remote: FileReplacementRemote;
  isCancelled: () => boolean;
  createId: () => string;
}): Promise<FileReplacementBatchResult> {
  const existing = loadFileIndexJournal(args.journalPath);
  if (existing.status === "corrupt") {
    throw new Error(`File index journal is corrupt: ${existing.error}`);
  }
  if (existing.journal.operations.length > 0) {
    throw new Error(
      "Cannot begin replacement while journal operations are active",
    );
  }
  if (args.replacements.length === 0) {
    return {
      committedFiles: 0,
      cancelled: args.isCancelled(),
      pointsDeleted: 0,
      pointsUpserted: 0,
    };
  }

  const operations = args.replacements.map((replacement) => {
    const intendedBatches = groupPointIds(replacement.points, 100);
    if (intendedBatches.length === 0) {
      throw new Error(
        `Replacement requires prepared points for ${replacement.file}`,
      );
    }
    return {
      operationId: args.createId(),
      file: replacement.file,
      kind: "replace" as const,
      generation: replacement.generation,
      targetHash: replacement.targetHash,
      oldPointIds: replacement.oldPointIds,
      intendedBatches,
    };
  });
  writeFileIndexJournal(args.journalPath, {
    ...emptyFileIndexJournal(),
    operations,
  });

  checkpointStructuralEntries(
    args.store,
    args.replacements.map((replacement) => [replacement.file, null]),
  );
  const oldPointIds = unique(
    args.replacements.flatMap((replacement) => replacement.oldPointIds),
  );
  const hidden = await setOwnedPointVisibility(
    oldPointIds,
    false,
    args.remote,
    args.isCancelled,
  );
  if (hidden.cancelled) {
    return {
      committedFiles: 0,
      cancelled: true,
      pointsDeleted: 0,
      pointsUpserted: 0,
    };
  }

  const oldCleanup = await deleteOwnedPoints(
    oldPointIds,
    args.remote,
    args.isCancelled,
  );
  if (oldCleanup.cancelled) {
    return {
      committedFiles: 0,
      cancelled: true,
      pointsDeleted: oldCleanup.pointsDeleted,
      pointsUpserted: 0,
    };
  }

  const points = args.replacements.flatMap((replacement) => replacement.points);
  let pointsUpserted = 0;
  for (let index = 0; index < points.length; index += 100) {
    if (args.isCancelled()) {
      return {
        committedFiles: 0,
        cancelled: true,
        pointsDeleted: oldCleanup.pointsDeleted,
        pointsUpserted,
      };
    }
    const batch = points.slice(index, index + 100);
    await args.remote.upsertPoints(batch);
    pointsUpserted += batch.length;
  }
  if (args.isCancelled()) {
    return {
      committedFiles: 0,
      cancelled: true,
      pointsDeleted: oldCleanup.pointsDeleted,
      pointsUpserted,
    };
  }

  const pendingEntries = args.replacements.map(
    (replacement): [string, CachedFileEntry] => [
      replacement.file,
      {
        ...replacement.cacheEntry,
        generation: replacement.generation,
        visibility: "pending",
      },
    ],
  );
  checkpointVectorEntries(args.store, pendingEntries);
  checkpointStructuralEntries(
    args.store,
    args.replacements.map((replacement) => [
      replacement.file,
      {
        ...replacement.structuralEntry,
        generation: replacement.generation,
        status: "current",
      },
    ]),
  );

  const published = await setOwnedPointVisibility(
    points.map((point) => point.id),
    true,
    args.remote,
    args.isCancelled,
  );
  if (published.cancelled) {
    return {
      committedFiles: 0,
      cancelled: true,
      pointsDeleted: oldCleanup.pointsDeleted,
      pointsUpserted,
    };
  }

  checkpointVectorEntries(
    args.store,
    pendingEntries.map(([file, entry]) => [
      file,
      { ...entry, visibility: "current" },
    ]),
  );
  writeFileIndexJournal(args.journalPath, emptyFileIndexJournal());
  return {
    committedFiles: args.replacements.length,
    cancelled: args.isCancelled(),
    pointsDeleted: oldCleanup.pointsDeleted,
    pointsUpserted,
  };
}

function checkpointVectorEntries(
  store: FileReplacementStore,
  entries: Array<[file: string, entry: CachedFileEntry | null]>,
): void {
  if (entries.length === 0) return;
  if (store.checkpointVectors) {
    store.checkpointVectors(entries);
    return;
  }
  for (const [file, entry] of entries) store.checkpointVector(file, entry);
}

function checkpointStructuralEntries(
  store: FileReplacementStore,
  entries: Array<[file: string, entry: StructuralFileEntry | null]>,
): void {
  if (entries.length === 0) return;
  if (store.checkpointStructurals) {
    store.checkpointStructurals(entries);
    return;
  }
  for (const [file, entry] of entries) store.checkpointStructural(file, entry);
}

async function setOwnedPointVisibility(
  pointIds: string[],
  visible: boolean,
  remote: FileReplacementRemote,
  isCancelled: () => boolean,
): Promise<{ cancelled: boolean }> {
  for (let index = 0; index < pointIds.length; index += 100) {
    if (isCancelled()) return { cancelled: true };
    await remote.setVisibility(pointIds.slice(index, index + 100), visible);
    if (isCancelled()) return { cancelled: true };
  }
  return { cancelled: false };
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
  const vectorMutations: Array<[string, CachedFileEntry | null]> = [];
  const structuralMutations: Array<[string, StructuralFileEntry | null]> = [];
  const pointIdsToDelete: string[] = [];
  const pointIdsToPublish: string[] = [];
  for (const [file, vector] of store.getPendingVectors()) {
    if (isCancelled()) return { pointsDeleted: 0, cancelled: true };
    const structural = store.getStructural(file);
    if (
      !vector.generation ||
      structural?.generation !== vector.generation ||
      structural.hash !== vector.hash ||
      structural.status !== "current"
    ) {
      pointIdsToDelete.push(...vector.pointIds);
      structuralMutations.push([file, null]);
      vectorMutations.push([file, null]);
      continue;
    }
    pointIdsToPublish.push(...vector.pointIds);
    vectorMutations.push([file, { ...vector, visibility: "current" }]);
  }

  const cleanup = await deleteOwnedPoints(
    unique(pointIdsToDelete),
    remote,
    isCancelled,
  );
  if (cleanup.cancelled) return cleanup;

  const published = await setOwnedPointVisibility(
    unique(pointIdsToPublish),
    true,
    remote,
    isCancelled,
  );
  if (published.cancelled) {
    return { pointsDeleted: cleanup.pointsDeleted, cancelled: true };
  }

  checkpointStructuralEntries(store, structuralMutations);
  checkpointVectorEntries(store, vectorMutations);
  return {
    pointsDeleted: cleanup.pointsDeleted,
    cancelled: isCancelled(),
  };
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

function sameIds(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
