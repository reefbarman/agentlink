import { describe, expect, it, vi } from "vitest";

import { runBoundedReadAheadPipeline } from "./boundedReadAheadPipeline.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("runBoundedReadAheadPipeline", () => {
  it("reads one batch ahead while preserving serial input-order processing", async () => {
    const reads = Array.from({ length: 3 }, () => deferred<string>());
    const processed: string[] = [];
    const processFirst = deferred<boolean>();
    const readBatch = vi.fn(
      async (_inputs: readonly number[], _start: number, batchNumber: number) =>
        reads[batchNumber].promise,
    );

    const running = runBoundedReadAheadPipeline({
      inputs: [0, 1, 2],
      batchSize: 1,
      isCancelled: () => false,
      readBatch,
      async processBatch(batch, _start, batchNumber) {
        processed.push(batch);
        return batchNumber === 0 ? processFirst.promise : true;
      },
      releaseBatch: vi.fn(),
    });

    expect(readBatch).toHaveBeenCalledTimes(1);
    reads[0].resolve("batch-0");
    await vi.waitFor(() => expect(readBatch).toHaveBeenCalledTimes(2));
    reads[1].resolve("batch-1");
    await expect.poll(() => processed).toEqual(["batch-0"]);
    expect(readBatch).toHaveBeenCalledTimes(2);

    processFirst.resolve(true);
    await vi.waitFor(() => expect(processed).toEqual(["batch-0", "batch-1"]));
    await vi.waitFor(() => expect(readBatch).toHaveBeenCalledTimes(3));
    reads[2].resolve("batch-2");

    await running;
    expect(processed).toEqual(["batch-0", "batch-1", "batch-2"]);
  });

  it("retains at most the current and one prefetched batch", async () => {
    const processGates = Array.from({ length: 3 }, () => deferred<boolean>());
    let retained = 0;
    let maxRetained = 0;

    const running = runBoundedReadAheadPipeline({
      inputs: [0, 1, 2],
      batchSize: 1,
      isCancelled: () => false,
      async readBatch(inputs) {
        retained++;
        maxRetained = Math.max(maxRetained, retained);
        return inputs[0];
      },
      async processBatch(_batch, _start, batchNumber) {
        return processGates[batchNumber].promise;
      },
      releaseBatch() {
        retained--;
      },
    });

    await vi.waitFor(() => expect(maxRetained).toBe(2));
    expect(retained).toBe(2);
    processGates[0].resolve(true);
    await vi.waitFor(() => expect(retained).toBe(2));
    processGates[1].resolve(true);
    processGates[2].resolve(true);

    await running;
    expect(maxRetained).toBe(2);
    expect(retained).toBe(0);
  });

  it("drains and releases prefetched content when the consumer stops early", async () => {
    const releaseBatch = vi.fn();
    const secondRead = deferred<string>();
    const running = runBoundedReadAheadPipeline({
      inputs: [0, 1, 2],
      batchSize: 1,
      isCancelled: () => false,
      async readBatch(_inputs, _start, batchNumber) {
        return batchNumber === 1 ? secondRead.promise : `batch-${batchNumber}`;
      },
      async processBatch() {
        return false;
      },
      releaseBatch,
    });

    await vi.waitFor(() => expect(releaseBatch).not.toHaveBeenCalled());
    secondRead.resolve("batch-1");
    await running;

    expect(releaseBatch.mock.calls.map(([batch]) => batch).sort()).toEqual([
      "batch-0",
      "batch-1",
    ]);
  });

  it("stops admission after cancellation and releases every retained batch", async () => {
    let cancelled = false;
    const processFirst = deferred<boolean>();
    const readBatch = vi.fn(async (inputs: readonly number[]) => inputs[0]);
    const releaseBatch = vi.fn();
    const running = runBoundedReadAheadPipeline({
      inputs: [0, 1, 2],
      batchSize: 1,
      isCancelled: () => cancelled,
      readBatch,
      async processBatch() {
        return processFirst.promise;
      },
      releaseBatch,
    });

    await vi.waitFor(() => expect(readBatch).toHaveBeenCalledTimes(2));
    cancelled = true;
    processFirst.resolve(true);
    await running;

    expect(readBatch).toHaveBeenCalledTimes(2);
    expect(releaseBatch).toHaveBeenCalledTimes(2);
  });

  it("propagates prefetched read failures after releasing the current batch", async () => {
    const releaseBatch = vi.fn();
    const running = runBoundedReadAheadPipeline({
      inputs: [0, 1],
      batchSize: 1,
      isCancelled: () => false,
      async readBatch(_inputs, _start, batchNumber) {
        if (batchNumber === 1) throw new Error("read failed");
        return "batch-0";
      },
      async processBatch() {
        return true;
      },
      releaseBatch,
    });

    await expect(running).rejects.toThrow("read failed");
    expect(releaseBatch).toHaveBeenCalledOnce();
    expect(releaseBatch).toHaveBeenCalledWith("batch-0");
  });

  it("preserves consumer failures while draining prefetched content", async () => {
    const releaseBatch = vi.fn();
    const secondRead = deferred<string>();
    const running = runBoundedReadAheadPipeline({
      inputs: [0, 1],
      batchSize: 1,
      isCancelled: () => false,
      async readBatch(_inputs, _start, batchNumber) {
        return batchNumber === 1 ? secondRead.promise : "batch-0";
      },
      async processBatch() {
        throw new Error("consumer failed");
      },
      releaseBatch,
    });

    secondRead.resolve("batch-1");
    await expect(running).rejects.toThrow("consumer failed");
    expect(releaseBatch).toHaveBeenCalledTimes(2);
  });

  it("rejects invalid batch sizes", async () => {
    await expect(
      runBoundedReadAheadPipeline({
        inputs: [],
        batchSize: 0,
        isCancelled: () => false,
        async readBatch() {
          return "batch";
        },
        async processBatch() {
          return true;
        },
        releaseBatch() {},
      }),
    ).rejects.toThrow("positive integer");
  });
});
