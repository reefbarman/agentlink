import {
  checkpointRemovedFileCaches,
  executeRemovedFileDeletes,
  planRemovedFileDeletes,
} from "./removedFileDeletion.js";
import { describe, expect, it, vi } from "vitest";

describe("removed-file deletion", () => {
  it("plans bounded point batches while retaining complete per-file ownership", () => {
    expect(
      planRemovedFileDeletes(
        [
          {
            relPath: "src/removed.ts",
            pointIds: ["point-1", "point-2", "point-3", "point-4", "point-5"],
          },
        ],
        2,
      ),
    ).toEqual([
      {
        relPath: "src/removed.ts",
        pointIds: ["point-1", "point-2", "point-3", "point-4", "point-5"],
        batches: [["point-1", "point-2"], ["point-3", "point-4"], ["point-5"]],
      },
    ]);
  });

  it("checkpoints structural absence before releasing vector ownership", () => {
    const events: string[] = [];
    checkpointRemovedFileCaches({
      writeStructuralCache: () => events.push("structural"),
      writeVectorCache: () => events.push("vector"),
    });
    expect(events).toEqual(["structural", "vector"]);
  });

  it("retains vector ownership when structural checkpointing fails", () => {
    const writeVectorCache = vi.fn();
    expect(() =>
      checkpointRemovedFileCaches({
        writeStructuralCache: () => {
          throw new Error("structural checkpoint failed");
        },
        writeVectorCache,
      }),
    ).toThrow("structural checkpoint failed");
    expect(writeVectorCache).not.toHaveBeenCalled();
  });

  it("deduplicates repeated removed-file plans", () => {
    expect(
      planRemovedFileDeletes([
        { relPath: "src/removed.ts", pointIds: ["point-1"] },
        { relPath: "src/removed.ts", pointIds: ["point-1"] },
      ]),
    ).toHaveLength(1);
  });

  it("rejects invalid batch bounds", () => {
    for (const batchSize of [0, -1, 1.5]) {
      expect(() => planRemovedFileDeletes([], batchSize)).toThrow(
        "Delete batch size must be a positive integer",
      );
    }
  });

  it("marks a file complete only after every bounded batch succeeds", async () => {
    const deleteBatch = vi.fn(async () => undefined);
    const result = await executeRemovedFileDeletes(
      planRemovedFileDeletes(
        [
          {
            relPath: "src/removed.ts",
            pointIds: ["point-1", "point-2", "point-3"],
          },
          { relPath: "src/empty.ts", pointIds: [] },
        ],
        2,
      ),
      { deleteBatch, isCancelled: () => false },
    );

    expect(deleteBatch.mock.calls).toEqual([
      [["point-1", "point-2"]],
      [["point-3"]],
    ]);
    expect(result).toEqual({
      completedRelPaths: ["src/removed.ts", "src/empty.ts"],
      errors: [],
      pointsDeleted: 3,
      cancelled: false,
    });
  });

  it("retains file ownership after a partial batch failure and continues to later files", async () => {
    const deleteBatch = vi.fn(async (pointIds: string[]) => {
      if (pointIds.includes("point-3")) throw new Error("injected failure");
    });
    const result = await executeRemovedFileDeletes(
      planRemovedFileDeletes(
        [
          {
            relPath: "src/failed.ts",
            pointIds: ["point-1", "point-2", "point-3", "point-4"],
          },
          { relPath: "src/complete.ts", pointIds: ["point-5"] },
        ],
        2,
      ),
      { deleteBatch, isCancelled: () => false },
    );

    expect(deleteBatch.mock.calls).toEqual([
      [["point-1", "point-2"]],
      [["point-3", "point-4"]],
      [["point-5"]],
    ]);
    expect(result).toEqual({
      completedRelPaths: ["src/complete.ts"],
      errors: [
        "Failed to delete points for src/failed.ts: Error: injected failure",
      ],
      pointsDeleted: 3,
      cancelled: false,
    });
  });

  it("stops before the next batch on cancellation without completing the file", async () => {
    let cancelled = false;
    const deleteBatch = vi.fn(async () => {
      cancelled = true;
    });
    const result = await executeRemovedFileDeletes(
      planRemovedFileDeletes(
        [
          {
            relPath: "src/removed.ts",
            pointIds: ["point-1", "point-2", "point-3"],
          },
        ],
        2,
      ),
      { deleteBatch, isCancelled: () => cancelled },
    );

    expect(deleteBatch).toHaveBeenCalledOnce();
    expect(result).toEqual({
      completedRelPaths: [],
      errors: [],
      pointsDeleted: 2,
      cancelled: true,
    });
  });
});
