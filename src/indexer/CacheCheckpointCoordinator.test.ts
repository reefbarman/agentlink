import { describe, expect, it, vi } from "vitest";

import { CacheCheckpointCoordinator } from "./CacheCheckpointCoordinator.js";

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
