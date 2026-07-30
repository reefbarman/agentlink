import { describe, expect, it, vi } from "vitest";

import { TerminalDataCoalescer } from "./TerminalDataCoalescer.js";

function manualScheduler() {
  let nextHandle = 1;
  const scheduled = new Map<number, () => void>();
  const delays: number[] = [];
  return {
    schedule: (callback: () => void, delayMs: number) => {
      const handle = nextHandle++;
      scheduled.set(handle, callback);
      delays.push(delayMs);
      return handle;
    },
    cancel: (handle: unknown) => {
      scheduled.delete(handle as number);
    },
    runAll() {
      const batch = Array.from(scheduled);
      for (const [handle, callback] of batch) {
        scheduled.delete(handle);
        callback();
      }
    },
    get pendingCount() {
      return scheduled.size;
    },
    delays,
  };
}

function coalescerHarness(options?: {
  flushDelayMs?: number;
  maxBufferedBytes?: number;
}) {
  const scheduler = manualScheduler();
  const flushes: Array<[string, string]> = [];
  const coalescer = new TerminalDataCoalescer({
    onFlush: (terminalId, data) => flushes.push([terminalId, data]),
    flushDelayMs: options?.flushDelayMs ?? 5,
    maxBufferedBytes: options?.maxBufferedBytes ?? 1024,
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
  });
  return { coalescer, scheduler, flushes };
}

describe("TerminalDataCoalescer", () => {
  it("joins pushes within the flush window into one delivery", () => {
    const { coalescer, scheduler, flushes } = coalescerHarness();
    coalescer.push("terminal-1", "one ");
    coalescer.push("terminal-1", "two ");
    coalescer.push("terminal-1", "three");
    expect(flushes).toEqual([]);
    expect(scheduler.pendingCount).toBe(1);
    expect(scheduler.delays).toEqual([5]);

    scheduler.runAll();
    expect(flushes).toEqual([["terminal-1", "one two three"]]);
    scheduler.runAll();
    expect(flushes).toHaveLength(1);
  });

  it("keeps terminals independent", () => {
    const { coalescer, scheduler, flushes } = coalescerHarness();
    coalescer.push("terminal-1", "left");
    coalescer.push("terminal-2", "right");
    scheduler.runAll();
    expect(flushes).toEqual([
      ["terminal-1", "left"],
      ["terminal-2", "right"],
    ]);
  });

  it("flushes immediately once buffered bytes reach the cap", () => {
    const { coalescer, scheduler, flushes } = coalescerHarness({
      maxBufferedBytes: 8,
    });
    coalescer.push("terminal-1", "1234");
    expect(flushes).toEqual([]);
    coalescer.push("terminal-1", "5678");
    expect(flushes).toEqual([["terminal-1", "12345678"]]);
    // The pending timer was cancelled with the flush.
    scheduler.runAll();
    expect(flushes).toHaveLength(1);
  });

  it("measures the cap in UTF-8 bytes", () => {
    const { coalescer, flushes } = coalescerHarness({ maxBufferedBytes: 4 });
    coalescer.push("terminal-1", "\u{1F600}");
    expect(flushes).toEqual([["terminal-1", "\u{1F600}"]]);
  });

  it("delivers synchronously when flushDelayMs is zero", () => {
    const { coalescer, scheduler, flushes } = coalescerHarness({
      flushDelayMs: 0,
    });
    coalescer.push("terminal-1", "now");
    expect(flushes).toEqual([["terminal-1", "now"]]);
    expect(scheduler.pendingCount).toBe(0);
  });

  it("ignores empty pushes", () => {
    const { coalescer, scheduler, flushes } = coalescerHarness();
    coalescer.push("terminal-1", "");
    expect(scheduler.pendingCount).toBe(0);
    scheduler.runAll();
    expect(flushes).toEqual([]);
  });

  it("flush() delivers pending output synchronously", () => {
    const { coalescer, scheduler, flushes } = coalescerHarness();
    coalescer.push("terminal-1", "tail");
    coalescer.flush("terminal-1");
    expect(flushes).toEqual([["terminal-1", "tail"]]);
    scheduler.runAll();
    expect(flushes).toHaveLength(1);
  });

  it("flush() without pending output is a no-op", () => {
    const { coalescer, flushes } = coalescerHarness();
    coalescer.flush("terminal-1");
    expect(flushes).toEqual([]);
  });

  it("flushAll() delivers every pending terminal", () => {
    const { coalescer, flushes } = coalescerHarness();
    coalescer.push("terminal-1", "left");
    coalescer.push("terminal-2", "right");
    coalescer.flushAll();
    expect(flushes).toEqual([
      ["terminal-1", "left"],
      ["terminal-2", "right"],
    ]);
  });

  it("discard() drops pending output without delivering", () => {
    const { coalescer, scheduler, flushes } = coalescerHarness();
    coalescer.push("terminal-1", "gone");
    coalescer.discard("terminal-1");
    scheduler.runAll();
    expect(flushes).toEqual([]);
    expect(scheduler.pendingCount).toBe(0);
  });

  it("dispose() cancels timers and rejects further pushes", () => {
    const { coalescer, scheduler, flushes } = coalescerHarness();
    coalescer.push("terminal-1", "pending");
    coalescer.dispose();
    expect(scheduler.pendingCount).toBe(0);
    coalescer.push("terminal-1", "late");
    coalescer.flushAll();
    scheduler.runAll();
    expect(flushes).toEqual([]);
  });

  it("supports re-entrant pushes from onFlush", () => {
    const flushes: string[] = [];
    const scheduler = manualScheduler();
    const coalescer: TerminalDataCoalescer = new TerminalDataCoalescer({
      onFlush: (terminalId, data) => {
        flushes.push(data);
        if (data === "first") coalescer.push(terminalId, "second");
      },
      flushDelayMs: 5,
      schedule: scheduler.schedule,
      cancel: scheduler.cancel,
    });
    coalescer.push("terminal-1", "first");
    scheduler.runAll();
    expect(flushes).toEqual(["first"]);
    scheduler.runAll();
    expect(flushes).toEqual(["first", "second"]);
  });

  it("rejects invalid tuning", () => {
    expect(
      () => new TerminalDataCoalescer({ onFlush: () => {}, flushDelayMs: -1 }),
    ).toThrow(/flushDelayMs/);
    expect(
      () =>
        new TerminalDataCoalescer({ onFlush: () => {}, maxBufferedBytes: 0 }),
    ).toThrow(/maxBufferedBytes/);
  });

  it("uses real timers by default", async () => {
    vi.useFakeTimers();
    try {
      const flushes: string[] = [];
      const coalescer = new TerminalDataCoalescer({
        onFlush: (_terminalId, data) => flushes.push(data),
      });
      coalescer.push("terminal-1", "timed");
      expect(flushes).toEqual([]);
      vi.advanceTimersByTime(5);
      expect(flushes).toEqual(["timed"]);
      coalescer.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
