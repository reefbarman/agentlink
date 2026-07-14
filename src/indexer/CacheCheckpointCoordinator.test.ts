import { describe, expect, it, vi } from "vitest";

import { CacheCheckpointCoordinator } from "./CacheCheckpointCoordinator.js";

function createScheduler(): {
  schedule: (run: () => void) => () => void;
  flush: () => void;
  pending: () => number;
} {
  let scheduled: (() => void) | null = null;
  return {
    schedule(run) {
      scheduled = run;
      return () => {
        if (scheduled === run) scheduled = null;
      };
    },
    flush() {
      const run = scheduled;
      scheduled = null;
      run?.();
    },
    pending: () => (scheduled ? 1 : 0),
  };
}

describe("CacheCheckpointCoordinator", () => {
  it("coalesces repeated dirty marks into one write per cache", () => {
    const writeVector = vi.fn();
    const writeStructural = vi.fn();
    const coordinator = new CacheCheckpointCoordinator({
      writeVector,
      writeStructural,
    });

    coordinator.markVectorDirty();
    coordinator.markVectorDirty();
    coordinator.markStructuralDirty();
    coordinator.markStructuralDirty();
    coordinator.flush();
    coordinator.flush();

    expect(writeVector).toHaveBeenCalledTimes(1);
    expect(writeStructural).toHaveBeenCalledTimes(1);
    expect(coordinator.pending).toEqual({ vector: false, structural: false });
  });

  it("flushes only the requested cache", () => {
    const writeVector = vi.fn();
    const writeStructural = vi.fn();
    const coordinator = new CacheCheckpointCoordinator({
      writeVector,
      writeStructural,
    });

    coordinator.markVectorDirty();
    coordinator.markStructuralDirty();

    expect(coordinator.flushVector()).toBe(true);
    expect(writeVector).toHaveBeenCalledTimes(1);
    expect(writeStructural).not.toHaveBeenCalled();
    expect(coordinator.pending).toEqual({ vector: false, structural: true });
  });

  it("preserves the requested pair checkpoint order", () => {
    const events: string[] = [];
    const coordinator = new CacheCheckpointCoordinator({
      writeVector: () => events.push("vector"),
      writeStructural: () => events.push("structural"),
    });

    coordinator.checkpointBoth(["structural", "vector"]);

    expect(events).toEqual(["structural", "vector"]);
  });

  it("retains dirty state when a writer fails so the checkpoint can retry", () => {
    const writeVector = vi
      .fn<() => void>()
      .mockImplementationOnce(() => {
        throw new Error("checkpoint failed");
      })
      .mockImplementation(() => undefined);
    const coordinator = new CacheCheckpointCoordinator({
      writeVector,
      writeStructural: vi.fn(),
    });
    coordinator.markVectorDirty();

    expect(() => coordinator.flushVector()).toThrow("checkpoint failed");
    expect(coordinator.pending.vector).toBe(true);

    expect(coordinator.flushVector()).toBe(true);
    expect(writeVector).toHaveBeenCalledTimes(2);
    expect(coordinator.pending.vector).toBe(false);
  });

  it("coalesces scheduled marks and flushes them in the default order", () => {
    const scheduler = createScheduler();
    const events: string[] = [];
    const coordinator = new CacheCheckpointCoordinator({
      writeVector: () => events.push("vector"),
      writeStructural: () => events.push("structural"),
      schedule: scheduler.schedule,
    });

    coordinator.scheduleVector();
    coordinator.scheduleVector();
    coordinator.scheduleStructural();

    expect(scheduler.pending()).toBe(1);
    expect(events).toEqual([]);

    scheduler.flush();

    expect(events).toEqual(["vector", "structural"]);
    expect(coordinator.pending).toEqual({ vector: false, structural: false });
  });

  it("supports a scheduler that invokes synchronously", () => {
    const writeVector = vi.fn();
    const coordinator = new CacheCheckpointCoordinator({
      writeVector,
      writeStructural: vi.fn(),
      schedule(run) {
        run();
        return vi.fn();
      },
    });

    coordinator.scheduleVector();
    coordinator.drain();

    expect(writeVector).toHaveBeenCalledTimes(1);
    expect(coordinator.pending.vector).toBe(false);
  });

  it("drains scheduled state immediately and cancels the delayed callback", () => {
    const scheduler = createScheduler();
    const writeVector = vi.fn();
    const coordinator = new CacheCheckpointCoordinator({
      writeVector,
      writeStructural: vi.fn(),
      schedule: scheduler.schedule,
    });

    coordinator.scheduleVector();
    coordinator.drain();
    scheduler.flush();

    expect(writeVector).toHaveBeenCalledTimes(1);
    expect(scheduler.pending()).toBe(0);
  });

  it("cancels scheduled execution without clearing dirty state", () => {
    const scheduler = createScheduler();
    const writeVector = vi.fn();
    const coordinator = new CacheCheckpointCoordinator({
      writeVector,
      writeStructural: vi.fn(),
      schedule: scheduler.schedule,
    });

    coordinator.scheduleVector();
    coordinator.cancelScheduled();
    scheduler.flush();

    expect(writeVector).not.toHaveBeenCalled();
    expect(coordinator.pending.vector).toBe(true);
  });

  it("cancels a redundant scheduled callback after an immediate checkpoint", () => {
    const scheduler = createScheduler();
    const writeStructural = vi.fn();
    const coordinator = new CacheCheckpointCoordinator({
      writeVector: vi.fn(),
      writeStructural,
      schedule: scheduler.schedule,
    });

    coordinator.scheduleStructural();
    coordinator.checkpointStructural();
    scheduler.flush();

    expect(writeStructural).toHaveBeenCalledTimes(1);
    expect(scheduler.pending()).toBe(0);
  });

  it("surfaces a scheduled writer failure once and permits an explicit retry", () => {
    const scheduler = createScheduler();
    const writeVector = vi
      .fn<() => void>()
      .mockImplementationOnce(() => {
        throw new Error("scheduled checkpoint failed");
      })
      .mockImplementation(() => undefined);
    const coordinator = new CacheCheckpointCoordinator({
      writeVector,
      writeStructural: vi.fn(),
      schedule: scheduler.schedule,
    });

    coordinator.scheduleVector();
    scheduler.flush();

    expect(coordinator.pending.vector).toBe(true);
    expect(() => coordinator.drain()).toThrow("scheduled checkpoint failed");
    expect(() => coordinator.drain()).not.toThrow();
    expect(writeVector).toHaveBeenCalledTimes(2);
    expect(coordinator.pending.vector).toBe(false);
  });

  it("preserves an immediate pair barrier after a scheduled writer failure", () => {
    const scheduler = createScheduler();
    const events: string[] = [];
    let failScheduledVector = true;
    const coordinator = new CacheCheckpointCoordinator({
      writeVector() {
        if (failScheduledVector) {
          failScheduledVector = false;
          throw new Error("scheduled checkpoint failed");
        }
        events.push("vector");
      },
      writeStructural: () => events.push("structural"),
      schedule: scheduler.schedule,
    });

    coordinator.scheduleVector();
    scheduler.flush();
    coordinator.checkpointBoth(["structural", "vector"]);

    expect(events).toEqual(["structural", "vector"]);
    expect(coordinator.pending).toEqual({ vector: false, structural: false });
    expect(() => coordinator.drain()).toThrow("scheduled checkpoint failed");
    expect(() => coordinator.drain()).not.toThrow();
  });

  it("does not clear later dirty state when an earlier ordered write fails", () => {
    const writeStructural = vi.fn(() => {
      throw new Error("structural failed");
    });
    const writeVector = vi.fn();
    const coordinator = new CacheCheckpointCoordinator({
      writeVector,
      writeStructural,
    });
    coordinator.markVectorDirty();
    coordinator.markStructuralDirty();

    expect(() => coordinator.flush(["structural", "vector"])).toThrow(
      "structural failed",
    );
    expect(writeVector).not.toHaveBeenCalled();
    expect(coordinator.pending).toEqual({ vector: true, structural: true });
  });
});
