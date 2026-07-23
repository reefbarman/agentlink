import { EventEmitter } from "events";
import { describe, expect, it, vi } from "vitest";

import {
  createRelaySseFrame,
  RelaySseClientQueue,
  type RelaySseWritable,
} from "./RelaySseClientQueue.js";

class WritableFixture extends EventEmitter implements RelaySseWritable {
  readonly chunks: string[] = [];
  destroyed = false;
  writableEnded = false;
  blockWrites = false;

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return !this.blockWrites;
  }

  end(): void {
    this.writableEnded = true;
    this.emit("close");
  }

  destroy(): void {
    this.destroyed = true;
    this.emit("close");
  }
}

describe("RelaySseClientQueue", () => {
  it("buffers ordered frames during backpressure and flushes on drain", () => {
    const writable = new WritableFixture();
    const queue = new RelaySseClientQueue({
      writable,
      requestCompaction: vi.fn(),
    });
    writable.blockWrites = true;
    queue.send(createRelaySseFrame({ event: "one", data: { n: 1 } }));
    queue.send(createRelaySseFrame({ event: "two", data: { n: 2 } }));
    queue.send(createRelaySseFrame({ event: "three", data: { n: 3 } }));

    expect(writable.chunks).toHaveLength(1);
    writable.blockWrites = false;
    writable.emit("drain");
    expect(writable.chunks.join("")).toContain("event: one");
    expect(writable.chunks.join("")).toContain("event: two");
    expect(writable.chunks.join("")).toContain("event: three");
  });

  it("requests checkpoint compaction and accepts only a dominating checkpoint", () => {
    const writable = new WritableFixture();
    writable.blockWrites = true;
    const requestCompaction = vi.fn();
    const queue = new RelaySseClientQueue({
      writable,
      maxQueuedBytes: 1,
      requestCompaction,
    });
    queue.send(createRelaySseFrame({ event: "first", data: {} }));
    queue.send(
      createRelaySseFrame({
        event: "event",
        data: { value: "large" },
        relaySequence: 5,
        ownerSequence: 7,
      }),
    );

    expect(queue.isAwaitingCompaction).toBe(true);
    expect(requestCompaction).toHaveBeenCalledWith({
      maximumRelaySequence: 5,
      maximumOwnerSequence: 7,
    });
    expect(queue.installCompaction(6, [])).toBe(false);
    expect(requestCompaction).toHaveBeenCalledTimes(2);

    expect(
      queue.installCompaction(7, [
        createRelaySseFrame({ event: "checkpoint", data: { sequence: 7 } }),
      ]),
    ).toBe(true);
    expect(queue.isAwaitingCompaction).toBe(false);
  });

  it("retains compaction-neutral operation frames behind the dominating checkpoint", () => {
    const writable = new WritableFixture();
    writable.blockWrites = true;
    const queue = new RelaySseClientQueue({
      writable,
      maxQueuedBytes: 120,
      requestCompaction: vi.fn(),
    });
    queue.send(createRelaySseFrame({ event: "blocked", data: {} }));
    queue.send(
      createRelaySseFrame({
        event: "owner.event",
        data: { value: "x".repeat(200) },
        relaySequence: 5,
        ownerSequence: 7,
      }),
    );
    expect(queue.isAwaitingCompaction).toBe(true);
    queue.send(
      createRelaySseFrame({
        event: "relay.operation",
        data: { operationId: "operation-1" },
        retainDuringCompaction: true,
      }),
    );

    expect(
      queue.installCompaction(7, [
        createRelaySseFrame({ event: "checkpoint", data: { sequence: 7 } }),
      ]),
    ).toBe(true);
    writable.blockWrites = false;
    writable.emit("drain");
    const text = writable.chunks.join("");
    expect(text.indexOf("event: checkpoint")).toBeLessThan(
      text.indexOf("event: relay.operation"),
    );
  });

  it("closes instead of silently dropping excessive compaction-neutral frames", () => {
    const writable = new WritableFixture();
    writable.blockWrites = true;
    const queue = new RelaySseClientQueue({
      writable,
      maxQueuedBytes: 1,
      requestCompaction: vi.fn(),
    });
    queue.send(createRelaySseFrame({ event: "blocked", data: {} }));
    queue.send(
      createRelaySseFrame({
        event: "owner.event",
        data: {},
        ownerSequence: 1,
      }),
    );
    expect(queue.isAwaitingCompaction).toBe(true);

    expect(
      queue.send(
        createRelaySseFrame({
          event: "relay.operation",
          data: { operationId: "operation-1" },
          retainDuringCompaction: true,
        }),
      ),
    ).toBe(false);
    expect(writable.destroyed).toBe(true);
  });

  it("clears pending compaction when a subscription replaces queued state", () => {
    const writable = new WritableFixture();
    writable.blockWrites = true;
    const queue = new RelaySseClientQueue({
      writable,
      maxQueuedBytes: 1,
      requestCompaction: vi.fn(),
    });
    queue.send(createRelaySseFrame({ event: "first", data: {} }));
    queue.send(
      createRelaySseFrame({
        event: "old-owner",
        data: { owner: "old" },
        ownerSequence: 9,
      }),
    );
    expect(queue.isAwaitingCompaction).toBe(true);

    queue.replacePending([
      createRelaySseFrame({ event: "new-owner", data: { owner: "new" } }),
    ]);
    expect(queue.isAwaitingCompaction).toBe(false);
  });

  it("destroys a client only after the stall deadline", () => {
    vi.useFakeTimers();
    try {
      const writable = new WritableFixture();
      writable.blockWrites = true;
      const onClose = vi.fn();
      const queue = new RelaySseClientQueue({
        writable,
        stallDeadlineMs: 100,
        requestCompaction: vi.fn(),
        onClose,
      });
      queue.send(createRelaySseFrame({ event: "blocked", data: {} }));
      expect(writable.destroyed).toBe(false);

      vi.advanceTimersByTime(99);
      expect(writable.destroyed).toBe(false);
      vi.advanceTimersByTime(1);
      expect(writable.destroyed).toBe(true);
      expect(onClose).toHaveBeenCalledWith("stall_deadline");
    } finally {
      vi.useRealTimers();
    }
  });
});
