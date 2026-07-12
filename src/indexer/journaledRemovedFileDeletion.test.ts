import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  emptyFileIndexJournal,
  loadFileIndexJournal,
  writeFileIndexJournal,
} from "./fileIndexJournal.js";

import { executeJournaledRemovedFileDeletes } from "./journaledRemovedFileDeletion.js";

function removal(file: string, pointIds: string[]) {
  return {
    operationId: `operation-${file}`,
    file,
    kind: "remove" as const,
    generation: `generation-${file}`,
    targetHash: null,
    oldPointIds: pointIds,
    intendedBatches: [],
  };
}

describe("journaled removed-file deletion", () => {
  let directory: string;
  let journalPath: string;
  let id: number;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "journaled-removal-"));
    journalPath = path.join(directory, "index.journal.json");
    id = 0;
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  function execute(options: {
    requestedFiles?: Array<{ relPath: string; pointIds: string[] }>;
    deleteBatch?: (pointIds: string[]) => Promise<void>;
    checkpointCompleted?: (relPaths: string[]) => void;
    isCancelled?: () => boolean;
  }) {
    return executeJournaledRemovedFileDeletes({
      journalPath,
      requestedFiles: options.requestedFiles ?? [],
      deleteBatch: options.deleteBatch ?? (async () => undefined),
      checkpointCompleted: options.checkpointCompleted ?? (() => undefined),
      isCancelled: options.isCancelled ?? (() => false),
      createId: () => `id-${++id}`,
    });
  }

  it("persists ownership before deleting and clears it after cache checkpoint", async () => {
    const events: string[] = [];

    const result = await execute({
      requestedFiles: [{ relPath: "src/removed.ts", pointIds: ["point-1"] }],
      deleteBatch: async () => {
        expect(loadFileIndexJournal(journalPath)).toMatchObject({
          status: "valid",
          journal: {
            operations: [
              {
                file: "src/removed.ts",
                kind: "remove",
                oldPointIds: ["point-1"],
              },
            ],
          },
        });
        events.push("delete");
      },
      checkpointCompleted: (relPaths) => {
        expect(relPaths).toEqual(["src/removed.ts"]);
        expect(loadFileIndexJournal(journalPath)).toMatchObject({
          status: "valid",
          journal: { operations: [{ file: "src/removed.ts" }] },
        });
        events.push("checkpoint");
      },
    });

    expect(events).toEqual(["delete", "checkpoint"]);
    expect(result).toEqual({
      completedRelPaths: ["src/removed.ts"],
      errors: [],
      pointsDeleted: 1,
      cancelled: false,
      pending: false,
    });
    expect(loadFileIndexJournal(journalPath)).toEqual({
      status: "valid",
      journal: emptyFileIndexJournal(),
    });
  });

  it("replays durable removal ownership before planning new removals", async () => {
    writeFileIndexJournal(journalPath, {
      ...emptyFileIndexJournal(),
      operations: [removal("src/recover.ts", ["recover-point"])],
    });
    const deleted: string[][] = [];

    const result = await execute({
      requestedFiles: [
        { relPath: "src/recover.ts", pointIds: ["stale-cache-point"] },
        { relPath: "src/new.ts", pointIds: ["new-point"] },
      ],
      deleteBatch: async (pointIds) => {
        deleted.push(pointIds);
      },
    });

    expect(deleted).toEqual([["recover-point"], ["new-point"]]);
    expect(result.completedRelPaths).toEqual(["src/recover.ts", "src/new.ts"]);
    expect(loadFileIndexJournal(journalPath)).toEqual({
      status: "valid",
      journal: emptyFileIndexJournal(),
    });
  });

  it("retains unresolved ownership after delete failure", async () => {
    const result = await execute({
      requestedFiles: [{ relPath: "src/removed.ts", pointIds: ["point-1"] }],
      deleteBatch: async () => {
        throw new Error("delete failed");
      },
    });

    expect(result.pending).toBe(true);
    expect(result.completedRelPaths).toEqual([]);
    expect(loadFileIndexJournal(journalPath)).toMatchObject({
      status: "valid",
      journal: { operations: [{ file: "src/removed.ts" }] },
    });
  });

  it("reports cancellation received during the final delete after committing removal", async () => {
    let cancelled = false;

    const result = await execute({
      requestedFiles: [{ relPath: "src/removed.ts", pointIds: ["point-1"] }],
      deleteBatch: async () => {
        cancelled = true;
      },
      isCancelled: () => cancelled,
    });

    expect(result).toEqual({
      completedRelPaths: ["src/removed.ts"],
      errors: [],
      pointsDeleted: 1,
      cancelled: true,
      pending: false,
    });
    expect(loadFileIndexJournal(journalPath)).toEqual({
      status: "valid",
      journal: emptyFileIndexJournal(),
    });
  });

  it("retains ownership when cache checkpointing fails", async () => {
    await expect(
      execute({
        requestedFiles: [{ relPath: "src/removed.ts", pointIds: ["point-1"] }],
        checkpointCompleted: () => {
          throw new Error("checkpoint failed");
        },
      }),
    ).rejects.toThrow("checkpoint failed");

    expect(loadFileIndexJournal(journalPath)).toMatchObject({
      status: "valid",
      journal: { operations: [{ file: "src/removed.ts" }] },
    });
  });

  it("retains ownership when journal cleanup fails", async () => {
    writeFileIndexJournal(journalPath, {
      ...emptyFileIndexJournal(),
      operations: [removal("src/removed.ts", ["point-1"])],
    });
    const checkpointCompleted = vi.fn();

    if (process.platform === "win32") return;
    fs.chmodSync(directory, 0o500);
    try {
      await expect(execute({ checkpointCompleted })).rejects.toThrow();
      expect(checkpointCompleted).toHaveBeenCalledWith(["src/removed.ts"]);
    } finally {
      fs.chmodSync(directory, 0o700);
    }
  });

  it("stops after unresolved recovery without starting new ownership", async () => {
    writeFileIndexJournal(journalPath, {
      ...emptyFileIndexJournal(),
      operations: [removal("src/recover.ts", ["recover-point"])],
    });
    const deleted: string[][] = [];

    const result = await execute({
      requestedFiles: [{ relPath: "src/new.ts", pointIds: ["new-point"] }],
      deleteBatch: async (pointIds) => {
        deleted.push(pointIds);
        throw new Error("recovery failed");
      },
    });

    expect(result.pending).toBe(true);
    expect(deleted).toEqual([["recover-point"]]);
    expect(loadFileIndexJournal(journalPath)).toMatchObject({
      status: "valid",
      journal: { operations: [{ file: "src/recover.ts" }] },
    });
  });

  it("fails closed for corrupt or replacement journals", async () => {
    fs.writeFileSync(journalPath, "not-json");
    await expect(execute({})).rejects.toThrow("File index journal is corrupt");

    fs.rmSync(journalPath);
    writeFileIndexJournal(journalPath, {
      ...emptyFileIndexJournal(),
      operations: [
        {
          operationId: "replace-1",
          file: "src/changed.ts",
          kind: "replace",
          generation: "generation-2",
          targetHash: "hash-2",
          oldPointIds: ["old-point"],
          intendedBatches: [{ batch: 0, pointIds: ["new-point"] }],
        },
      ],
    });
    await expect(execute({})).rejects.toThrow(
      "Replacement journal recovery is not implemented for src/changed.ts",
    );
  });
});
