import { describe, expect, it } from "vitest";

import {
  beginCollectionReset,
  beginFileOperation,
  clearCheckpointedOperation,
  commitCollectionReset,
  confirmCacheCheckpoint,
  confirmCollectionDeleted,
  confirmCollectionRecreated,
  confirmOldPointDeletion,
  confirmRecoveryCleanup,
  confirmRecoveryInvalidation,
  confirmStructuralCheckpoint,
  confirmUpsertBatch,
  getAvailableCollectionGeneration,
  getAvailableDurableGeneration,
  getJournalIntent,
  getVisibleCommittedFile,
  planFileRecovery,
  type FileIndexState,
} from "./fileIndexState.js";

function indexedState(): FileIndexState {
  return {
    file: "src/example.ts",
    committed: {
      generation: "generation-1",
      hash: "old-hash",
      pointIds: ["old-1", "old-2"],
    },
    operation: null,
    structuralGeneration: "generation-1",
    structuralStatus: "current",
  };
}

describe("per-file index state", () => {
  it("retains removed-file ownership until remote deletion is confirmed", () => {
    const prepared = beginFileOperation(indexedState(), {
      operationId: "remove-1",
      kind: "remove",
      generation: "generation-1",
    });

    expect(prepared.committed?.pointIds).toEqual(["old-1", "old-2"]);
    expect(getJournalIntent(prepared)).toEqual({
      operationId: "remove-1",
      file: "src/example.ts",
      kind: "remove",
      generation: "generation-1",
      targetHash: null,
      oldPointIds: ["old-1", "old-2"],
      intendedBatches: [],
    });
    expect(planFileRecovery(prepared)).toEqual({
      deletePointIds: ["old-1", "old-2"],
      finalizeRemoval: true,
      repairStructural: false,
      reindex: false,
    });

    const deleted = confirmOldPointDeletion(prepared);
    expect(deleted.committed?.pointIds).toEqual(["old-1", "old-2"]);
    expect(getVisibleCommittedFile(deleted)).toBeNull();
    expect(deleted.structuralStatus).toBe("unavailable");
    expect(planFileRecovery(deleted)).toEqual({
      deletePointIds: ["old-1", "old-2"],
      finalizeRemoval: true,
      repairStructural: false,
      reindex: false,
    });

    const checkpointed = confirmCacheCheckpoint(deleted);
    expect(checkpointed.committed).toBeNull();
    expect(planFileRecovery(checkpointed)).toEqual({
      deletePointIds: ["old-1", "old-2"],
      finalizeRemoval: true,
      repairStructural: false,
      reindex: false,
    });
    const cleared = clearCheckpointedOperation(checkpointed);
    expect(cleared.operation).toBeNull();
    expect(planFileRecovery(cleared)).toBeNull();
  });

  it("retains changed-file visibility until old deletion and hides partial replacement", () => {
    const prepared = beginFileOperation(indexedState(), {
      operationId: "replace-1",
      kind: "replace",
      generation: "generation-2",
      targetHash: "new-hash",
      intendedBatches: [
        { batch: 0, pointIds: ["new-1", "new-2"] },
        { batch: 1, pointIds: ["new-3"] },
      ],
    });

    expect(prepared.committed?.hash).toBe("old-hash");
    expect(getVisibleCommittedFile(prepared)).toBeNull();
    const deleted = confirmOldPointDeletion(prepared);
    expect(deleted.committed?.hash).toBe("old-hash");
    expect(getVisibleCommittedFile(deleted)).toBeNull();
    expect(deleted.structuralStatus).toBe("stale");

    const partial = confirmUpsertBatch(deleted, 0);
    expect(partial.committed?.hash).toBe("old-hash");
    expect(getVisibleCommittedFile(partial)).toBeNull();
    expect(() => confirmCacheCheckpoint(partial)).toThrow(
      "All intended point batches must be confirmed",
    );
    expect(planFileRecovery(partial)).toEqual({
      deletePointIds: ["old-1", "old-2", "new-1", "new-2", "new-3"],
      finalizeRemoval: false,
      repairStructural: false,
      reindex: true,
    });

    const complete = confirmUpsertBatch(partial, 1);
    const checkpointed = confirmCacheCheckpoint(complete);
    expect(checkpointed.committed).toEqual({
      generation: "generation-2",
      hash: "new-hash",
      pointIds: ["new-1", "new-2", "new-3"],
    });
    expect(checkpointed.structuralStatus).toBe("stale");
    expect(getVisibleCommittedFile(checkpointed)).toBeNull();
    expect(() => clearCheckpointedOperation(checkpointed)).toThrow(
      "Cannot clear an operation before cache checkpoint",
    );
    const structurallyCheckpointed = confirmStructuralCheckpoint(checkpointed);
    expect(
      getVisibleCommittedFile(
        clearCheckpointedOperation(structurallyCheckpointed),
      ),
    ).toEqual(checkpointed.committed);
  });

  it("uses every predeclared point ID for recovery at each replacement crash prefix", () => {
    const prepared = beginFileOperation(indexedState(), {
      operationId: "replace-crash",
      kind: "replace",
      generation: "generation-2",
      targetHash: "new-hash",
      intendedBatches: [
        { batch: 0, pointIds: ["new-1"] },
        { batch: 1, pointIds: ["new-2"] },
      ],
    });
    const afterOldDelete = confirmOldPointDeletion(prepared);
    const afterFirstUpsert = confirmUpsertBatch(afterOldDelete, 0);
    const afterAllUpserts = confirmUpsertBatch(afterFirstUpsert, 1);

    for (const state of [
      prepared,
      afterOldDelete,
      afterFirstUpsert,
      afterAllUpserts,
    ]) {
      expect(planFileRecovery(state)).toEqual({
        deletePointIds: ["old-1", "old-2", "new-1", "new-2"],
        finalizeRemoval: false,
        repairStructural: false,
        reindex: true,
      });
    }

    const checkpointed = confirmCacheCheckpoint(afterAllUpserts);
    expect(planFileRecovery(checkpointed)).toEqual({
      deletePointIds: [],
      finalizeRemoval: false,
      repairStructural: true,
      reindex: false,
    });
    const structurallyCheckpointed = confirmStructuralCheckpoint(checkpointed);
    expect(
      planFileRecovery(clearCheckpointedOperation(structurallyCheckpointed)),
    ).toBeNull();
  });

  it.each([
    ["stale", "stale", "generation-1"],
    ["unavailable", "unavailable", null],
    ["current from another generation", "current", "generation-1"],
  ] as const)(
    "repairs %s structural state before clearing an exact-cache journal after restart",
    (_, structuralStatus, structuralGeneration) => {
      const prepared = beginFileOperation(indexedState(), {
        operationId: "replace-cache-crash",
        kind: "replace",
        generation: "generation-2",
        targetHash: "new-hash",
        intendedBatches: [{ batch: 0, pointIds: ["new-1", "new-2"] }],
      });
      const recovered: FileIndexState = {
        ...prepared,
        committed: {
          generation: "generation-2",
          hash: "new-hash",
          pointIds: ["new-1", "new-2"],
        },
        structuralGeneration,
        structuralStatus,
      };

      expect(recovered.operation?.oldDeleteConfirmed).toBe(false);
      expect(recovered.operation?.intendedBatches[0].upsertConfirmed).toBe(
        false,
      );
      expect(planFileRecovery(recovered)).toEqual({
        deletePointIds: [],
        finalizeRemoval: false,
        repairStructural: true,
        reindex: false,
      });
      expect(() => clearCheckpointedOperation(recovered)).toThrow(
        "Cannot clear an operation before cache checkpoint",
      );
      const repaired = confirmStructuralCheckpoint(recovered);
      expect(repaired.structuralGeneration).toBe("generation-2");
      expect(planFileRecovery(repaired)).toEqual({
        deletePointIds: [],
        finalizeRemoval: false,
        repairStructural: false,
        reindex: false,
      });
      expect(clearCheckpointedOperation(repaired)).toEqual(
        expect.objectContaining({ operation: null }),
      );
    },
  );

  it("clears an exact-cache journal after restart when structural proof is already current", () => {
    const prepared = beginFileOperation(indexedState(), {
      operationId: "replace-cache-current",
      kind: "replace",
      generation: "generation-2",
      targetHash: "new-hash",
      intendedBatches: [{ batch: 0, pointIds: ["new-1"] }],
    });
    const recovered: FileIndexState = {
      ...prepared,
      committed: {
        generation: "generation-2",
        hash: "new-hash",
        pointIds: ["new-1"],
      },
      structuralGeneration: "generation-2",
      structuralStatus: "current",
    };

    expect(recovered.operation?.oldDeleteConfirmed).toBe(false);
    expect(recovered.operation?.intendedBatches[0].upsertConfirmed).toBe(false);
    expect(planFileRecovery(recovered)).toEqual({
      deletePointIds: [],
      finalizeRemoval: false,
      repairStructural: false,
      reindex: false,
    });
    expect(clearCheckpointedOperation(recovered).operation).toBeNull();
  });

  it("replays removal deletion after restart even when the cache is already absent", () => {
    const prepared = beginFileOperation(indexedState(), {
      operationId: "remove-restart",
      kind: "remove",
      generation: "generation-1",
    });
    const recovered: FileIndexState = {
      ...prepared,
      committed: null,
      structuralGeneration: null,
      structuralStatus: "unavailable",
    };

    expect(recovered.operation?.oldDeleteConfirmed).toBe(false);
    expect(planFileRecovery(recovered)).toEqual({
      deletePointIds: ["old-1", "old-2"],
      finalizeRemoval: true,
      repairStructural: false,
      reindex: false,
    });
    expect(() => clearCheckpointedOperation(recovered)).toThrow(
      "Cannot clear an operation before cache checkpoint",
    );
    const replayed = confirmOldPointDeletion(recovered);
    expect(clearCheckpointedOperation(replayed).operation).toBeNull();
  });

  it.each([
    ["generation", { generation: "generation-3" }],
    ["hash", { hash: "other-hash" }],
    ["point IDs", { pointIds: ["new-2", "new-1"] }],
  ])("cleans up when recovered cache %s do not prove commit", (_, patch) => {
    const prepared = beginFileOperation(indexedState(), {
      operationId: "replace-cache-mismatch",
      kind: "replace",
      generation: "generation-2",
      targetHash: "new-hash",
      intendedBatches: [{ batch: 0, pointIds: ["new-1", "new-2"] }],
    });
    const recovered = {
      ...prepared,
      committed: {
        generation: "generation-2",
        hash: "new-hash",
        pointIds: ["new-1", "new-2"],
        ...patch,
      },
    };

    expect(planFileRecovery(recovered)).toEqual({
      deletePointIds: ["old-1", "old-2", "new-1", "new-2"],
      finalizeRemoval: false,
      repairStructural: false,
      reindex: true,
    });
  });

  it("checkpoints conservative replacement invalidation before clearing its journal", () => {
    const prepared = beginFileOperation(indexedState(), {
      operationId: "replace-invalidate",
      kind: "replace",
      generation: "generation-2",
      targetHash: "new-hash",
      intendedBatches: [{ batch: 0, pointIds: ["new-1"] }],
    });
    expect(() => confirmRecoveryInvalidation(prepared)).toThrow(
      "Full recovery cleanup must be confirmed before invalidation",
    );

    const cleaned = confirmRecoveryCleanup(prepared);
    const invalidated = confirmRecoveryInvalidation(cleaned);
    expect(invalidated.committed).toBeNull();
    expect(invalidated.structuralGeneration).toBeNull();
    expect(invalidated.structuralStatus).toBe("unavailable");
    expect(clearCheckpointedOperation(invalidated).operation).toBeNull();
  });

  it("replays cleanup after a crash before invalidation journal cleanup", () => {
    const prepared = beginFileOperation(indexedState(), {
      operationId: "replace-invalidate-restart",
      kind: "replace",
      generation: "generation-2",
      targetHash: "new-hash",
      intendedBatches: [{ batch: 0, pointIds: ["new-1"] }],
    });
    const restarted: FileIndexState = {
      ...prepared,
      committed: null,
      structuralGeneration: null,
      structuralStatus: "unavailable",
    };

    expect(restarted.operation?.recoveryInvalidationConfirmed).toBe(false);
    expect(planFileRecovery(restarted)).toEqual({
      deletePointIds: ["old-1", "old-2", "new-1"],
      finalizeRemoval: false,
      repairStructural: false,
      reindex: true,
    });
    expect(() => clearCheckpointedOperation(restarted)).toThrow(
      "Cannot clear an operation before cache checkpoint",
    );
    const replayed = confirmRecoveryInvalidation(
      confirmRecoveryCleanup(restarted),
    );
    expect(clearCheckpointedOperation(replayed).operation).toBeNull();
  });

  it("requires full cleanup after upserts before recovery invalidation", () => {
    const prepared = beginFileOperation(indexedState(), {
      operationId: "replace-partial-cleanup",
      kind: "replace",
      generation: "generation-2",
      targetHash: "new-hash",
      intendedBatches: [
        { batch: 0, pointIds: ["new-1"] },
        { batch: 1, pointIds: ["new-2"] },
      ],
    });
    const oldDeleted = confirmOldPointDeletion(prepared);
    const partial = confirmUpsertBatch(oldDeleted, 0);

    expect(partial.operation?.oldDeleteConfirmed).toBe(true);
    expect(partial.operation?.recoveryCleanupConfirmed).toBe(false);
    expect(() => confirmRecoveryInvalidation(partial)).toThrow(
      "Full recovery cleanup must be confirmed before invalidation",
    );
    const invalidated = confirmRecoveryInvalidation(
      confirmRecoveryCleanup(partial),
    );
    expect(clearCheckpointedOperation(invalidated).operation).toBeNull();
  });

  it("invalidates all recovery confirmations when an upsert occurs", () => {
    const prepared = beginFileOperation(indexedState(), {
      operationId: "replace-cleanup-reset",
      kind: "replace",
      generation: "generation-2",
      targetHash: "new-hash",
      intendedBatches: [{ batch: 0, pointIds: ["new-1"] }],
    });
    const cleaned = confirmRecoveryCleanup(confirmOldPointDeletion(prepared));
    const invalidated = confirmRecoveryInvalidation(cleaned);
    expect(invalidated.operation?.recoveryCleanupConfirmed).toBe(true);
    expect(invalidated.operation?.recoveryInvalidationConfirmed).toBe(true);

    const upserted = confirmUpsertBatch(invalidated, 0);
    expect(upserted.operation?.recoveryCleanupConfirmed).toBe(false);
    expect(upserted.operation?.recoveryInvalidationConfirmed).toBe(false);
    expect(() => clearCheckpointedOperation(upserted)).toThrow(
      "Cannot clear an operation before cache checkpoint",
    );

    const recleaned = confirmRecoveryCleanup(upserted);
    const reinvalidated = confirmRecoveryInvalidation(recleaned);
    expect(clearCheckpointedOperation(reinvalidated).operation).toBeNull();
  });

  it("recovers from durable intent without runtime confirmation flags", () => {
    const prepared = beginFileOperation(indexedState(), {
      operationId: "replace-restart",
      kind: "replace",
      generation: "generation-2",
      targetHash: "new-hash",
      intendedBatches: [{ batch: 0, pointIds: ["new-1"] }],
    });
    const intent = getJournalIntent(prepared)!;
    expect(intent).not.toHaveProperty("oldDeleteConfirmed");
    expect(intent.intendedBatches[0]).not.toHaveProperty("upsertConfirmed");

    const restarted: FileIndexState = {
      ...indexedState(),
      operation: {
        intent,
        oldDeleteConfirmed: false,
        recoveryCleanupConfirmed: false,
        recoveryInvalidationConfirmed: false,
        intendedBatches: intent.intendedBatches.map((batch) => ({
          ...batch,
          upsertConfirmed: false,
        })),
      },
    };
    expect(planFileRecovery(restarted)).toEqual({
      deletePointIds: ["old-1", "old-2", "new-1"],
      finalizeRemoval: false,
      repairStructural: false,
      reindex: true,
    });
  });

  it("rejects transitions that could expose incomplete ownership", () => {
    const state = indexedState();
    expect(() =>
      beginFileOperation(state, {
        operationId: "replace-empty",
        kind: "replace",
        generation: "generation-2",
        targetHash: "new-hash",
      }),
    ).toThrow("Replacement requires predeclared point IDs");
    expect(() =>
      beginFileOperation(state, {
        operationId: "remove-with-points",
        kind: "remove",
        generation: "generation-1",
        intendedBatches: [{ batch: 0, pointIds: ["new-1"] }],
      }),
    ).toThrow("Removal cannot declare replacement point IDs");
    expect(() =>
      beginFileOperation(state, {
        operationId: "replace-duplicate-points",
        kind: "replace",
        generation: "generation-2",
        targetHash: "new-hash",
        intendedBatches: [
          { batch: 0, pointIds: ["new-1"] },
          { batch: 1, pointIds: ["new-1"] },
        ],
      }),
    ).toThrow("Intended point IDs must be unique");
    expect(() =>
      beginFileOperation(state, {
        operationId: "replace-reused-point",
        kind: "replace",
        generation: "generation-2",
        targetHash: "new-hash",
        intendedBatches: [{ batch: 0, pointIds: ["old-1"] }],
      }),
    ).toThrow("Replacement point IDs cannot reuse committed IDs");

    const prepared = beginFileOperation(state, {
      operationId: "replace-invalid",
      kind: "replace",
      generation: "generation-2",
      targetHash: "new-hash",
      intendedBatches: [{ batch: 0, pointIds: ["new-1"] }],
    });
    expect(() => confirmUpsertBatch(prepared, 0)).toThrow(
      "Old point deletion must be confirmed",
    );
    expect(() => clearCheckpointedOperation(prepared)).toThrow(
      "Cannot clear an operation before cache checkpoint",
    );
    expect(() =>
      beginFileOperation(prepared, {
        operationId: "overlap",
        kind: "remove",
        generation: "generation-1",
      }),
    ).toThrow("File operation already active");
  });
});

describe("durable record availability", () => {
  it.each([
    ["journal", { journal: "corrupt" as const }],
    [
      "vector cache",
      {
        vectorCache: { generation: "generation-2", status: "corrupt" as const },
      },
    ],
    [
      "structural cache",
      {
        structuralCache: {
          generation: "generation-2",
          status: "corrupt" as const,
        },
      },
    ],
  ])("keeps a generation unavailable when the %s is corrupt", (_, patch) => {
    expect(
      getAvailableDurableGeneration({
        generation: "generation-2",
        journal: "absent",
        vectorCache: { generation: "generation-2", status: "valid" },
        structuralCache: { generation: "generation-2", status: "valid" },
        ...patch,
      }),
    ).toBeNull();
  });

  it.each(["vectorCache", "structuralCache"] as const)(
    "rejects a valid %s record from another generation",
    (record) => {
      expect(
        getAvailableDurableGeneration({
          generation: "generation-2",
          journal: "absent",
          vectorCache: { generation: "generation-2", status: "valid" },
          structuralCache: { generation: "generation-2", status: "valid" },
          [record]: { generation: "generation-1", status: "valid" },
        }),
      ).toBeNull();
    },
  );

  it("exposes only a fully validated generation without an active journal", () => {
    expect(
      getAvailableDurableGeneration({
        generation: "generation-2",
        journal: "absent",
        vectorCache: { generation: "generation-2", status: "valid" },
        structuralCache: { generation: "generation-2", status: "valid" },
      }),
    ).toBe("generation-2");
    expect(
      getAvailableDurableGeneration({
        generation: "generation-2",
        journal: "valid",
        vectorCache: { generation: "generation-2", status: "valid" },
        structuralCache: { generation: "generation-2", status: "valid" },
      }),
    ).toBeNull();
  });
});

describe("collection reset state", () => {
  it("keeps the collection unavailable from durable preparation through recreation", () => {
    const prepared = beginCollectionReset("generation-1", "generation-2");
    expect(getAvailableCollectionGeneration(prepared)).toBeNull();

    const deleted = confirmCollectionDeleted(prepared);
    expect(deleted.activeGeneration).toBeNull();
    expect(getAvailableCollectionGeneration(deleted)).toBeNull();

    const recreated = confirmCollectionRecreated(deleted);
    expect(getAvailableCollectionGeneration(recreated)).toBeNull();

    const committed = commitCollectionReset(recreated);
    expect(committed).toEqual({
      activeGeneration: "generation-2",
      pendingGeneration: null,
      phase: "available",
    });
    expect(getAvailableCollectionGeneration(committed)).toBe("generation-2");
  });

  it("cannot expose a failed or out-of-order recreation", () => {
    const prepared = beginCollectionReset("generation-1", "generation-2");
    expect(() => confirmCollectionRecreated(prepared)).toThrow(
      "Collection recreation requires confirmed deletion",
    );
    expect(() => commitCollectionReset(prepared)).toThrow(
      "Collection reset cannot commit before recreation",
    );
  });
});
