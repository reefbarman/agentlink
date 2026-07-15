import {
  createIndexWorkerMetrics,
  measureIndexWorkerPhase,
  measureIndexWorkerPhaseSync,
  serializedByteLength,
} from "./workerMetrics.js";
import { describe, expect, it } from "vitest";

describe("index worker metrics", () => {
  it("records operation counts, cache bytes, read concurrency, retained content, and heap samples", () => {
    const metrics = createIndexWorkerMetrics();

    metrics.recordOperation("qdrant.ensureCollection");
    metrics.recordOperation("qdrant.deletePoints");
    metrics.recordOperation("qdrant.deletePoints");
    metrics.recordOperation("cache.writeVector", 120);
    metrics.recordOperation("cache.writeStructural", 80);
    metrics.readStarted();
    metrics.readStarted();
    metrics.contentRetained(400);
    metrics.contentRetained(250);
    metrics.sampleHeapUsed(1_000);
    metrics.readFinished();
    metrics.contentReleased(400);
    metrics.sampleHeapUsed(900);
    metrics.readFinished();
    metrics.contentReleased(250);

    expect(metrics.snapshot()).toEqual({
      operations: {
        "qdrant.ensureCollection": 1,
        "qdrant.deleteCollection": 0,
        "qdrant.deletePoints": 2,
        "qdrant.upsertPoints": 0,
        "qdrant.setPointVisibility": 0,
        "cache.writeVector": 1,
        "cache.writeStructural": 1,
      },
      cacheWriteBytes: 200,
      cacheWriteBytesByKind: { vector: 120, structural: 80 },
      phaseDurationsMs: {},
      maxActiveReads: 2,
      maxRetainedContentBytes: 650,
      maxHeapUsedBytes: 1_000,
    });
  });

  it("accumulates phase durations when work succeeds or fails", async () => {
    const metrics = createIndexWorkerMetrics();
    const times = [10, 18, 25, 31];
    const now = () => times.shift()!;

    await expect(
      measureIndexWorkerPhase(metrics, "scan", async () => "ok", now),
    ).resolves.toBe("ok");
    await expect(
      measureIndexWorkerPhase(
        metrics,
        "scan",
        async () => {
          throw new Error("failed");
        },
        now,
      ),
    ).rejects.toThrow("failed");

    expect(metrics.snapshot().phaseDurationsMs).toEqual({ scan: 14 });
  });

  it("records synchronous phase failures", () => {
    const metrics = createIndexWorkerMetrics();
    const times = [10, 16];

    expect(() =>
      measureIndexWorkerPhaseSync(
        metrics,
        "diff",
        () => {
          throw new Error("failed");
        },
        () => times.shift()!,
      ),
    ).toThrow("failed");
    expect(metrics.snapshot().phaseDurationsMs).toEqual({ diff: 6 });
  });

  it("measures serialized cache bytes as UTF-8", () => {
    expect(serializedByteLength({ value: "é" })).toBe(
      Buffer.byteLength(JSON.stringify({ value: "é" }), "utf8"),
    );
  });
});
