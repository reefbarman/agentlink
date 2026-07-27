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

    metrics.recordOperation("retrieval.ensureIndex");
    metrics.recordOperation("retrieval.deleteRecords");
    metrics.recordOperation("retrieval.deleteRecords");
    metrics.recordOperation("cache.writeRetrieval", 120);
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
        "retrieval.ensureIndex": 1,
        "retrieval.deleteIndex": 0,
        "retrieval.deleteRecords": 2,
        "retrieval.upsertRecords": 0,
        "retrieval.setRecordVisibility": 0,
        "cache.writeRetrieval": 1,
        "cache.writeStructural": 1,
      },
      cacheWriteBytes: 200,
      cacheWriteBytesByKind: { retrieval: 120, structural: 80 },
      phaseDurationsMs: {},
      chunkingFallbacks: {
        tree_sitter_not_initialized: 0,
        tree_sitter_grammar_unavailable: 0,
        tree_sitter_parser_failure: 0,
        tree_sitter_extractor_unavailable: 0,
        tree_sitter_no_chunks: 0,
      },
      maxActiveReads: 2,
      maxRetainedContentBytes: 650,
      maxHeapUsedBytes: 1_000,
    });
  });

  it("records typed chunking fallback reasons", () => {
    const metrics = createIndexWorkerMetrics();

    metrics.recordChunkingFallback("tree_sitter_extractor_unavailable");
    metrics.recordChunkingFallback("tree_sitter_extractor_unavailable");
    metrics.recordChunkingFallback("tree_sitter_parser_failure");

    expect(metrics.snapshot().chunkingFallbacks).toMatchObject({
      tree_sitter_extractor_unavailable: 2,
      tree_sitter_parser_failure: 1,
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
