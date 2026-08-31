import type {
  RetrievalAggregateMetrics,
  RetrievalMigrationOutcome,
  RetrievalOptimizeOutcome,
  RetrievalRepairOutcome,
  RetrievalSnapshot,
  RetrievalSnapshotOutcome,
} from "./retrievalMaintenance.js";
import { expect, expectTypeOf, it } from "vitest";

it("pins retrieval maintenance contracts", () => {
  expectTypeOf<RetrievalSnapshot>().toEqualTypeOf<{
    id: string;
    createdAt: string;
    label?: string;
    sourceCount: number;
    chunkCount: number;
    relationCount: number;
  }>();
  expectTypeOf<RetrievalSnapshotOutcome>().toEqualTypeOf<{
    status: "created" | "restored" | "not_found";
    snapshot?: RetrievalSnapshot;
  }>();
  expectTypeOf<RetrievalRepairOutcome>().toEqualTypeOf<{
    status: "clean" | "repaired";
    abandonedPublications: number;
    orphanedChunksRemoved: number;
    orphanedRelationsRemoved: number;
  }>();
  expectTypeOf<RetrievalOptimizeOutcome>().toEqualTypeOf<{
    status: "optimized";
    recordsCompacted: number;
    bytesReclaimed?: number;
    staleRecordsRemoved?: number;
  }>();
  expectTypeOf<RetrievalMigrationOutcome>().toEqualTypeOf<{
    status: "up_to_date" | "migrated" | "rebuild_required";
    fromVersion: number | null;
    toVersion: number;
  }>();
  expectTypeOf<RetrievalAggregateMetrics>().toEqualTypeOf<{
    sourcesScanned: number;
    sourcesPublished: number;
    sourcesDeleted: number;
    recordsAdded: number;
    recordsRemoved: number;
    queries: number;
    lexicalQueries: number;
    vectorQueries: number;
    hybridQueries: number;
    recoveries: number;
    snapshotsCreated: number;
    snapshotsRestored: number;
    repairs: number;
    optimizations: number;
  }>();
});

it("keeps retrieval maintenance outcomes serializable across surfaces", () => {
  const value: {
    snapshot: RetrievalSnapshotOutcome;
    repair: RetrievalRepairOutcome;
    optimize: RetrievalOptimizeOutcome;
    migration: RetrievalMigrationOutcome;
    metrics: RetrievalAggregateMetrics;
  } = {
    snapshot: {
      status: "created",
      snapshot: {
        id: "snapshot-1",
        createdAt: "2026-08-30T00:00:00.000Z",
        label: "before-import",
        sourceCount: 1,
        chunkCount: 2,
        relationCount: 3,
      },
    },
    repair: {
      status: "repaired",
      abandonedPublications: 1,
      orphanedChunksRemoved: 2,
      orphanedRelationsRemoved: 3,
    },
    optimize: {
      status: "optimized",
      recordsCompacted: 4,
      bytesReclaimed: 5,
      staleRecordsRemoved: 6,
    },
    migration: { status: "migrated", fromVersion: 1, toVersion: 2 },
    metrics: {
      sourcesScanned: 1,
      sourcesPublished: 2,
      sourcesDeleted: 3,
      recordsAdded: 4,
      recordsRemoved: 5,
      queries: 6,
      lexicalQueries: 7,
      vectorQueries: 8,
      hybridQueries: 9,
      recoveries: 10,
      snapshotsCreated: 11,
      snapshotsRestored: 12,
      repairs: 13,
      optimizations: 14,
    },
  };

  expect(JSON.parse(JSON.stringify(value))).toEqual(value);
});
