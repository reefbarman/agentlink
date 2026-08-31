export interface RetrievalSnapshot {
  id: string;
  createdAt: string;
  label?: string;
  sourceCount: number;
  chunkCount: number;
  relationCount: number;
}

export interface RetrievalSnapshotOutcome {
  status: "created" | "restored" | "not_found";
  snapshot?: RetrievalSnapshot;
}

export interface RetrievalRepairOutcome {
  status: "clean" | "repaired";
  abandonedPublications: number;
  orphanedChunksRemoved: number;
  orphanedRelationsRemoved: number;
}

export interface RetrievalOptimizeOutcome {
  status: "optimized";
  recordsCompacted: number;
  /** Optional best-effort physical storage metric when the backend can measure it. */
  bytesReclaimed?: number;
  /** Rows from superseded source generations removed by the deferred-GC sweep. */
  staleRecordsRemoved?: number;
}

export interface RetrievalMigrationOutcome {
  status: "up_to_date" | "migrated" | "rebuild_required";
  fromVersion: number | null;
  toVersion: number;
}

export interface RetrievalAggregateMetrics {
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
}
