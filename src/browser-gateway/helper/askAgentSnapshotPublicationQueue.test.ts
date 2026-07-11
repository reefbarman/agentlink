import { describe, expect, it, vi } from "vitest";

import { AskAgentSnapshotPublicationQueue } from "./askAgentSnapshotPublicationQueue.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

describe("AskAgentSnapshotPublicationQueue", () => {
  it("coalesces scheduled builds and resolves every caller with one publication", async () => {
    vi.useFakeTimers();
    try {
      const publish = vi.fn();
      const queue = new AskAgentSnapshotPublicationQueue<{ value: number }>({
        coalesceMs: 20,
        publish,
      });

      const first = queue.schedule(() => ({ value: 1 }));
      const second = queue.schedule(() => ({ value: 2 }));
      expect(publish).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(20);
      const [firstPublication, secondPublication] = await Promise.all([
        first,
        second,
      ]);

      expect(firstPublication).toBe(secondPublication);
      expect(firstPublication).toEqual({
        revision: 1,
        snapshot: { value: 2 },
        serialized: '{"value":2}',
        bytes: 11,
      });
      expect(publish).toHaveBeenCalledOnce();
      expect(publish).toHaveBeenCalledWith(firstPublication);
    } finally {
      vi.useRealTimers();
    }
  });

  it("discards an older scheduled async build when an immediate request arrives", async () => {
    const publish = vi.fn();
    const firstBuild = deferred<{ value: string }>();
    const buildStarted = deferred<void>();
    const queue = new AskAgentSnapshotPublicationQueue<{ value: string }>({
      coalesceMs: 20,
      publish,
    });

    const first = queue.schedule(async () => {
      buildStarted.resolve();
      return await firstBuild.promise;
    });
    const flushing = queue.flush();
    await buildStarted.promise;
    const second = queue.publishNow(() => ({ value: "new" }));
    firstBuild.resolve({ value: "old" });

    const [firstPublication, secondPublication] = await Promise.all([
      first,
      second,
      flushing,
    ]);
    expect(firstPublication).toBe(secondPublication);
    expect(firstPublication.snapshot).toEqual({ value: "new" });
    expect(firstPublication.revision).toBe(1);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("transfers stale scheduled waiters when the obsolete build rejects", async () => {
    const publish = vi.fn();
    const firstBuild = deferred<{ value: string }>();
    const buildStarted = deferred<void>();
    const queue = new AskAgentSnapshotPublicationQueue<{ value: string }>({
      coalesceMs: 20,
      publish,
    });

    const first = queue.schedule(async () => {
      buildStarted.resolve();
      return await firstBuild.promise;
    });
    const flushing = queue.flush();
    await buildStarted.promise;
    const second = queue.publishNow(() => ({ value: "new" }));
    firstBuild.reject(new Error("obsolete"));

    const [firstPublication, secondPublication] = await Promise.all([
      first,
      second,
      flushing,
    ]);
    expect(firstPublication).toBe(secondPublication);
    expect(firstPublication.snapshot).toEqual({ value: "new" });
    expect(publish).toHaveBeenCalledOnce();
  });

  it("commits every immediate publication with its own snapshot", async () => {
    const publish = vi.fn();
    const queue = new AskAgentSnapshotPublicationQueue<{ value: number }>({
      coalesceMs: 20,
      publish,
    });

    const first = queue.publishNow(() => ({ value: 1 }));
    const second = queue.publishNow(() => ({ value: 2 }));

    await expect(first).resolves.toMatchObject({
      revision: 1,
      snapshot: { value: 1 },
    });
    await expect(second).resolves.toMatchObject({
      revision: 2,
      snapshot: { value: 2 },
    });
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it("serializes overlapping immediate publications with monotonic revisions", async () => {
    const publishBlock = deferred<void>();
    const publications: Array<{
      revision: number;
      snapshot: { value: number };
    }> = [];
    const queue = new AskAgentSnapshotPublicationQueue<{ value: number }>({
      coalesceMs: 20,
      publish: async (publication) => {
        publications.push(publication);
        if (publication.revision === 1) await publishBlock.promise;
      },
    });

    const first = queue.publishNow(() => ({ value: 1 }));
    await vi.waitFor(() => expect(publications).toHaveLength(1));
    const second = queue.publishNow(() => ({ value: 2 }));
    expect(publications).toHaveLength(1);

    publishBlock.resolve();
    await Promise.all([first, second]);
    expect(publications).toMatchObject([
      { revision: 1, snapshot: { value: 1 } },
      { revision: 2, snapshot: { value: 2 } },
    ]);
  });

  it("flushes work queued while a publication is still active", async () => {
    const publishBlock = deferred<void>();
    const publications: number[] = [];
    const queue = new AskAgentSnapshotPublicationQueue<{ value: number }>({
      coalesceMs: 20,
      publish: async (publication) => {
        publications.push(publication.snapshot.value);
        if (publication.snapshot.value === 1) await publishBlock.promise;
      },
    });

    const first = queue.publishNow(() => ({ value: 1 }));
    await vi.waitFor(() => expect(publications).toEqual([1]));
    const second = queue.schedule(() => ({ value: 2 }));
    const flushed = queue.flush();
    publishBlock.resolve();

    await Promise.all([first, second, flushed]);
    expect(publications).toEqual([1, 2]);
    expect(await flushed).toMatchObject({
      revision: 2,
      snapshot: { value: 2 },
    });
  });

  it("flushes scheduled work and rejects new work after graceful disposal", async () => {
    vi.useFakeTimers();
    try {
      const publish = vi.fn();
      const queue = new AskAgentSnapshotPublicationQueue<{ value: number }>({
        coalesceMs: 20,
        publish,
      });
      const scheduled = queue.schedule(() => ({ value: 1 }));

      await queue.dispose();
      await expect(scheduled).resolves.toMatchObject({
        revision: 1,
        snapshot: { value: 1 },
      });
      expect(publish).toHaveBeenCalledOnce();
      await expect(queue.publishNow(() => ({ value: 2 }))).rejects.toThrow(
        "ask_agent_snapshot_queue_disposed",
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
