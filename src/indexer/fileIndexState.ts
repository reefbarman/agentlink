export type FileIndexOperationKind = "remove" | "replace";
export type StructuralFileStatus = "current" | "stale" | "unavailable";
export type DurableRecordStatus = "valid" | "absent" | "corrupt";

export interface CommittedFileIndex {
  generation: string;
  hash: string;
  pointIds: string[];
}

export interface FilePointBatchIntent {
  batch: number;
  pointIds: string[];
}

export interface FileIndexJournalIntent {
  operationId: string;
  file: string;
  kind: FileIndexOperationKind;
  generation: string;
  targetHash: string | null;
  oldPointIds: string[];
  intendedBatches: FilePointBatchIntent[];
}

export interface FilePointBatchState extends FilePointBatchIntent {
  upsertConfirmed: boolean;
}

export interface FileIndexOperationState {
  intent: FileIndexJournalIntent;
  intendedBatches: FilePointBatchState[];
  oldDeleteConfirmed: boolean;
  recoveryCleanupConfirmed: boolean;
  recoveryInvalidationConfirmed: boolean;
}

export interface FileIndexState {
  file: string;
  committed: CommittedFileIndex | null;
  operation: FileIndexOperationState | null;
  structuralGeneration: string | null;
  structuralStatus: StructuralFileStatus;
}

export interface FileRecoveryPlan {
  deletePointIds: string[];
  finalizeRemoval: boolean;
  repairStructural: boolean;
  reindex: boolean;
}

export interface DurableCacheRecordState {
  generation: string | null;
  status: DurableRecordStatus;
}

export interface DurableGenerationState {
  generation: string;
  journal: DurableRecordStatus;
  vectorCache: DurableCacheRecordState;
  structuralCache: DurableCacheRecordState;
}

export interface CollectionResetState {
  activeGeneration: string | null;
  pendingGeneration: string | null;
  phase: "available" | "prepared" | "collection_deleted" | "recreated";
}

export function beginFileOperation(
  state: FileIndexState,
  input: {
    operationId: string;
    kind: FileIndexOperationKind;
    generation: string;
    targetHash?: string;
    intendedBatches?: Array<{ batch: number; pointIds: string[] }>;
  },
): FileIndexState {
  if (state.operation) {
    throw new Error(`File operation already active for ${state.file}`);
  }
  if (input.kind === "replace" && !input.intendedBatches?.length) {
    throw new Error("Replacement requires predeclared point IDs");
  }
  if (input.kind === "replace" && !input.targetHash) {
    throw new Error("Replacement requires a target hash");
  }
  if (input.kind === "remove" && input.targetHash) {
    throw new Error("Removal cannot declare a target hash");
  }
  if (input.kind === "remove" && input.intendedBatches?.length) {
    throw new Error("Removal cannot declare replacement point IDs");
  }
  const intendedBatches = input.intendedBatches ?? [];
  const batchNumbers = intendedBatches.map((batch) => batch.batch);
  if (new Set(batchNumbers).size !== batchNumbers.length) {
    throw new Error("Point batch numbers must be unique");
  }
  const intendedPointIds = intendedBatches.flatMap((batch) => batch.pointIds);
  if (intendedPointIds.some((pointId) => pointId.length === 0)) {
    throw new Error("Point IDs cannot be empty");
  }
  if (new Set(intendedPointIds).size !== intendedPointIds.length) {
    throw new Error("Intended point IDs must be unique");
  }
  const oldPointIds = state.committed?.pointIds ?? [];
  if (intendedPointIds.some((pointId) => oldPointIds.includes(pointId))) {
    throw new Error("Replacement point IDs cannot reuse committed IDs");
  }

  return {
    ...state,
    operation: {
      intent: {
        operationId: input.operationId,
        file: state.file,
        kind: input.kind,
        generation: input.generation,
        targetHash: input.targetHash ?? null,
        oldPointIds: [...oldPointIds],
        intendedBatches: intendedBatches.map((batch) => ({
          batch: batch.batch,
          pointIds: [...batch.pointIds],
        })),
      },
      intendedBatches: intendedBatches.map((batch) => ({
        batch: batch.batch,
        pointIds: [...batch.pointIds],
        upsertConfirmed: false,
      })),
      oldDeleteConfirmed: state.committed === null,
      recoveryCleanupConfirmed: false,
      recoveryInvalidationConfirmed: false,
    },
  };
}

export function confirmOldPointDeletion(state: FileIndexState): FileIndexState {
  const operation = requireOperation(state);
  return {
    ...state,
    operation: { ...operation, oldDeleteConfirmed: true },
    structuralStatus:
      operation.intent.kind === "remove" ? "unavailable" : "stale",
  };
}

export function confirmUpsertBatch(
  state: FileIndexState,
  batch: number,
): FileIndexState {
  const operation = requireOperation(state);
  if (operation.intent.kind !== "replace") {
    throw new Error("Removal has no upsert batches");
  }
  if (!operation.oldDeleteConfirmed) {
    throw new Error("Old point deletion must be confirmed before upsert");
  }
  if (!operation.intendedBatches.some((entry) => entry.batch === batch)) {
    throw new Error(`Unknown point batch ${batch}`);
  }

  return {
    ...state,
    operation: {
      ...operation,
      recoveryCleanupConfirmed: false,
      recoveryInvalidationConfirmed: false,
      intendedBatches: operation.intendedBatches.map((entry) =>
        entry.batch === batch ? { ...entry, upsertConfirmed: true } : entry,
      ),
    },
  };
}

export function getVisibleCommittedFile(
  state: FileIndexState,
): CommittedFileIndex | null {
  return state.operation ? null : state.committed;
}

export function confirmCacheCheckpoint(state: FileIndexState): FileIndexState {
  const operation = requireOperation(state);
  if (!operation.oldDeleteConfirmed) {
    throw new Error("Old point deletion is not confirmed");
  }

  if (operation.intent.kind === "remove") {
    return {
      ...state,
      committed: null,
      operation,
      structuralStatus: "unavailable",
    };
  }
  if (!operation.intent.targetHash) {
    throw new Error("Replacement operation has no target hash");
  }
  if (operation.intendedBatches.some((batch) => !batch.upsertConfirmed)) {
    throw new Error("All intended point batches must be confirmed");
  }

  return {
    ...state,
    committed: {
      generation: operation.intent.generation,
      hash: operation.intent.targetHash,
      pointIds: operation.intendedBatches.flatMap((batch) => batch.pointIds),
    },
    operation,
    structuralStatus: "stale",
  };
}

export function confirmRecoveryCleanup(state: FileIndexState): FileIndexState {
  const operation = requireOperation(state);
  if (operation.intent.kind !== "replace") {
    throw new Error("Removal does not use replacement recovery cleanup");
  }
  return {
    ...state,
    operation: {
      ...operation,
      recoveryCleanupConfirmed: true,
      recoveryInvalidationConfirmed: false,
    },
  };
}

export function confirmRecoveryInvalidation(
  state: FileIndexState,
): FileIndexState {
  const operation = requireOperation(state);
  if (operation.intent.kind !== "replace") {
    throw new Error("Removal does not use replacement invalidation");
  }
  if (!operation.recoveryCleanupConfirmed) {
    throw new Error(
      "Full recovery cleanup must be confirmed before invalidation",
    );
  }
  return {
    ...state,
    committed: null,
    operation: { ...operation, recoveryInvalidationConfirmed: true },
    structuralGeneration: null,
    structuralStatus: "unavailable",
  };
}

export function confirmStructuralCheckpoint(
  state: FileIndexState,
): FileIndexState {
  const operation = requireOperation(state);
  if (!replacementCacheProvesCommit(state, operation)) {
    throw new Error("Structural checkpoint requires exact vector cache proof");
  }
  return {
    ...state,
    structuralGeneration: operation.intent.generation,
    structuralStatus: "current",
  };
}

export function clearCheckpointedOperation(
  state: FileIndexState,
): FileIndexState {
  const operation = requireOperation(state);
  const checkpointed =
    operation.intent.kind === "remove"
      ? operation.oldDeleteConfirmed && state.committed === null
      : (replacementCacheProvesCommit(state, operation) &&
          structuralCacheProvesCommit(state, operation)) ||
        operation.recoveryInvalidationConfirmed;
  if (!checkpointed) {
    throw new Error("Cannot clear an operation before cache checkpoint");
  }
  return { ...state, operation: null };
}

export function planFileRecovery(
  state: FileIndexState,
): FileRecoveryPlan | null {
  const operation = state.operation;
  if (!operation) return null;
  if (replacementCacheProvesCommit(state, operation)) {
    return {
      deletePointIds: [],
      finalizeRemoval: false,
      repairStructural: !structuralCacheProvesCommit(state, operation),
      reindex: false,
    };
  }

  return {
    deletePointIds: unique([
      ...operation.intent.oldPointIds,
      ...operation.intent.intendedBatches.flatMap((batch) => batch.pointIds),
    ]),
    finalizeRemoval: operation.intent.kind === "remove",
    repairStructural: false,
    reindex: operation.intent.kind === "replace",
  };
}

export function getAvailableDurableGeneration(
  state: DurableGenerationState,
): string | null {
  if (
    state.journal !== "absent" ||
    state.vectorCache.status !== "valid" ||
    state.vectorCache.generation !== state.generation ||
    state.structuralCache.status !== "valid" ||
    state.structuralCache.generation !== state.generation
  ) {
    return null;
  }
  return state.generation;
}

export function beginCollectionReset(
  activeGeneration: string | null,
  pendingGeneration: string,
): CollectionResetState {
  if (activeGeneration === pendingGeneration) {
    throw new Error("Reset requires a new generation");
  }
  return {
    activeGeneration,
    pendingGeneration,
    phase: "prepared",
  };
}

export function confirmCollectionDeleted(
  state: CollectionResetState,
): CollectionResetState {
  if (state.phase !== "prepared") {
    throw new Error("Collection deletion requires a prepared reset");
  }
  return { ...state, activeGeneration: null, phase: "collection_deleted" };
}

export function confirmCollectionRecreated(
  state: CollectionResetState,
): CollectionResetState {
  if (state.phase !== "collection_deleted") {
    throw new Error("Collection recreation requires confirmed deletion");
  }
  return { ...state, phase: "recreated" };
}

export function getAvailableCollectionGeneration(
  state: CollectionResetState,
): string | null {
  return state.phase === "available" ? state.activeGeneration : null;
}

export function commitCollectionReset(
  state: CollectionResetState,
): CollectionResetState {
  if (state.phase !== "recreated" || !state.pendingGeneration) {
    throw new Error("Collection reset cannot commit before recreation");
  }
  return {
    activeGeneration: state.pendingGeneration,
    pendingGeneration: null,
    phase: "available",
  };
}

function structuralCacheProvesCommit(
  state: FileIndexState,
  operation: FileIndexOperationState,
): boolean {
  return (
    state.structuralStatus === "current" &&
    state.structuralGeneration === operation.intent.generation
  );
}

function replacementCacheProvesCommit(
  state: FileIndexState,
  operation: FileIndexOperationState,
): boolean {
  if (operation.intent.kind !== "replace" || !state.committed) return false;
  const intendedPointIds = operation.intent.intendedBatches.flatMap(
    (batch) => batch.pointIds,
  );
  return (
    state.committed.generation === operation.intent.generation &&
    state.committed.hash === operation.intent.targetHash &&
    state.committed.pointIds.length === intendedPointIds.length &&
    state.committed.pointIds.every(
      (pointId, index) => pointId === intendedPointIds[index],
    )
  );
}

export function getJournalIntent(
  state: FileIndexState,
): FileIndexJournalIntent | null {
  return state.operation?.intent ?? null;
}

function requireOperation(state: FileIndexState): FileIndexOperationState {
  if (!state.operation)
    throw new Error(`No active operation for ${state.file}`);
  return state.operation;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
