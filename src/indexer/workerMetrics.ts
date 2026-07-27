export type IndexWorkerOperation =
  | "retrieval.ensureIndex"
  | "retrieval.deleteIndex"
  | "retrieval.deleteRecords"
  | "retrieval.upsertRecords"
  | "retrieval.setRecordVisibility"
  | "cache.writeRetrieval"
  | "cache.writeStructural";

import type {
  IndexChunkingFallbackReason,
  IndexWorkerMetricsSnapshot,
} from "./types.js";

export type { IndexWorkerMetricsSnapshot } from "./types.js";

export interface IndexWorkerMetrics {
  recordOperation(operation: IndexWorkerOperation, bytes?: number): void;
  recordPhaseDuration(phase: string, durationMs: number): void;
  recordChunkingFallback(reason: IndexChunkingFallbackReason): void;
  readStarted(): void;
  readFinished(): void;
  contentRetained(bytes: number): void;
  contentReleased(bytes: number): void;
  sampleHeapUsed(bytes: number): void;
  snapshot(): IndexWorkerMetricsSnapshot;
}

const CHUNKING_FALLBACK_REASONS: IndexChunkingFallbackReason[] = [
  "tree_sitter_not_initialized",
  "tree_sitter_grammar_unavailable",
  "tree_sitter_parser_failure",
  "tree_sitter_extractor_unavailable",
  "tree_sitter_no_chunks",
];

const OPERATIONS: IndexWorkerOperation[] = [
  "retrieval.ensureIndex",
  "retrieval.deleteIndex",
  "retrieval.deleteRecords",
  "retrieval.upsertRecords",
  "retrieval.setRecordVisibility",
  "cache.writeRetrieval",
  "cache.writeStructural",
];

export function createIndexWorkerMetrics(): IndexWorkerMetrics {
  const operations = Object.fromEntries(
    OPERATIONS.map((operation) => [operation, 0]),
  ) as Record<IndexWorkerOperation, number>;
  const phaseDurationsMs: Record<string, number> = {};
  const chunkingFallbacks = Object.fromEntries(
    CHUNKING_FALLBACK_REASONS.map((reason) => [reason, 0]),
  ) as Record<IndexChunkingFallbackReason, number>;
  let cacheWriteBytes = 0;
  const cacheWriteBytesByKind = { retrieval: 0, structural: 0 };
  let activeReads = 0;
  let retainedContentBytes = 0;
  let maxActiveReads = 0;
  let maxRetainedContentBytes = 0;
  let maxHeapUsedBytes = 0;

  return {
    recordOperation(operation, bytes = 0) {
      operations[operation]++;
      if (operation === "cache.writeRetrieval") {
        cacheWriteBytes += bytes;
        cacheWriteBytesByKind.retrieval += bytes;
      } else if (operation === "cache.writeStructural") {
        cacheWriteBytes += bytes;
        cacheWriteBytesByKind.structural += bytes;
      }
    },
    recordPhaseDuration(phase, durationMs) {
      phaseDurationsMs[phase] = (phaseDurationsMs[phase] ?? 0) + durationMs;
    },
    recordChunkingFallback(reason) {
      chunkingFallbacks[reason]++;
    },
    readStarted() {
      activeReads++;
      maxActiveReads = Math.max(maxActiveReads, activeReads);
    },
    readFinished() {
      activeReads--;
    },
    contentRetained(bytes) {
      retainedContentBytes += bytes;
      maxRetainedContentBytes = Math.max(
        maxRetainedContentBytes,
        retainedContentBytes,
      );
    },
    contentReleased(bytes) {
      retainedContentBytes -= bytes;
    },
    sampleHeapUsed(bytes) {
      maxHeapUsedBytes = Math.max(maxHeapUsedBytes, bytes);
    },
    snapshot() {
      return {
        operations: { ...operations },
        cacheWriteBytes,
        cacheWriteBytesByKind: { ...cacheWriteBytesByKind },
        phaseDurationsMs: { ...phaseDurationsMs },
        chunkingFallbacks: { ...chunkingFallbacks },
        maxActiveReads,
        maxRetainedContentBytes,
        maxHeapUsedBytes,
      };
    },
  };
}

export function measureIndexWorkerPhaseSync<T>(
  metrics: IndexWorkerMetrics | undefined,
  phase: string,
  run: () => T,
  now: () => number = Date.now,
): T {
  const startedAt = now();
  try {
    return run();
  } finally {
    metrics?.recordPhaseDuration(phase, now() - startedAt);
  }
}

export async function measureIndexWorkerPhase<T>(
  metrics: IndexWorkerMetrics | undefined,
  phase: string,
  run: () => Promise<T>,
  now: () => number = Date.now,
): Promise<T> {
  const startedAt = now();
  try {
    return await run();
  } finally {
    metrics?.recordPhaseDuration(phase, now() - startedAt);
  }
}

export function serializedByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}
