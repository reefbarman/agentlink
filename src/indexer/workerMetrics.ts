export type IndexWorkerOperation =
  | "qdrant.ensureCollection"
  | "qdrant.deleteCollection"
  | "qdrant.deletePoints"
  | "qdrant.upsertPoints"
  | "cache.writeVector"
  | "cache.writeStructural";

import type { IndexWorkerMetricsSnapshot } from "./types.js";

export type { IndexWorkerMetricsSnapshot } from "./types.js";

export interface IndexWorkerMetrics {
  recordOperation(operation: IndexWorkerOperation, bytes?: number): void;
  recordPhaseDuration(phase: string, durationMs: number): void;
  readStarted(): void;
  readFinished(): void;
  contentRetained(bytes: number): void;
  contentReleased(bytes: number): void;
  sampleHeapUsed(bytes: number): void;
  snapshot(): IndexWorkerMetricsSnapshot;
}

const OPERATIONS: IndexWorkerOperation[] = [
  "qdrant.ensureCollection",
  "qdrant.deleteCollection",
  "qdrant.deletePoints",
  "qdrant.upsertPoints",
  "cache.writeVector",
  "cache.writeStructural",
];

export function createIndexWorkerMetrics(): IndexWorkerMetrics {
  const operations = Object.fromEntries(
    OPERATIONS.map((operation) => [operation, 0]),
  ) as Record<IndexWorkerOperation, number>;
  const phaseDurationsMs: Record<string, number> = {};
  let cacheWriteBytes = 0;
  let activeReads = 0;
  let retainedContentBytes = 0;
  let maxActiveReads = 0;
  let maxRetainedContentBytes = 0;
  let maxHeapUsedBytes = 0;

  return {
    recordOperation(operation, bytes = 0) {
      operations[operation]++;
      if (
        operation === "cache.writeVector" ||
        operation === "cache.writeStructural"
      ) {
        cacheWriteBytes += bytes;
      }
    },
    recordPhaseDuration(phase, durationMs) {
      phaseDurationsMs[phase] = (phaseDurationsMs[phase] ?? 0) + durationMs;
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
        phaseDurationsMs: { ...phaseDurationsMs },
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
