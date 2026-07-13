import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  emptyFileIndexJournal,
  loadFileIndexJournal,
  writeFileIndexJournal,
} from "./fileIndexJournal.js";
import {
  executeJournaledFileReplacement,
  recoverJournaledFileReplacements,
  type FileReplacementStore,
  type PreparedFileReplacement,
} from "./journaledFileReplacement.js";
import type { StructuralFileEntry } from "./structuralGraph.js";
import type { CachedFileEntry } from "./types.js";

function structural(file: string, hash: string): StructuralFileEntry {
  return {
    relPath: file,
    hash,
    indexedAt: "2026-01-01T00:00:00.000Z",
    imports: [],
    exports: [],
    symbols: [],
  };
}

function replacement(): PreparedFileReplacement {
  return {
    file: "src/changed.ts",
    generation: "generation-2",
    targetHash: "hash-2",
    oldPointIds: ["old-1"],
    points: [
      {
        id: "new-1",
        vector: [0.1],
        payload: { filePath: "src/changed.ts", indexVisible: false },
      },
      {
        id: "new-2",
        vector: [0.2],
        payload: { filePath: "src/changed.ts", indexVisible: false },
      },
    ],
    structuralEntry: structural("src/changed.ts", "hash-2"),
    cacheEntry: {
      hash: "hash-2",
      pointIds: ["new-1", "new-2"],
      indexedAt: "2026-01-01T00:00:00.000Z",
    },
  };
}

describe("journaled file replacement", () => {
  let directory: string;
  let journalPath: string;
  let vectors: Map<string, CachedFileEntry>;
  let structures: Map<string, StructuralFileEntry>;
  let events: string[];
  let cancelled: boolean;
  let store: FileReplacementStore;
  let remote: {
    deletePoints: ReturnType<typeof vi.fn<(ids: string[]) => Promise<void>>>;
    upsertPoints: ReturnType<
      typeof vi.fn<(points: unknown[]) => Promise<void>>
    >;
    setVisibility: ReturnType<
      typeof vi.fn<(ids: string[], visible: boolean) => Promise<void>>
    >;
  };

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "journaled-replace-"));
    journalPath = path.join(directory, "index.journal.json");
    vectors = new Map();
    structures = new Map();
    events = [];
    cancelled = false;
    store = {
      getVector: (file) => vectors.get(file),
      getStructural: (file) => structures.get(file),
      getPendingVectors: () =>
        [...vectors].filter(([, entry]) => entry.visibility === "pending"),
      checkpointVector(file, entry) {
        events.push(`vector:${entry?.visibility ?? "absent"}`);
        if (entry) vectors.set(file, entry);
        else vectors.delete(file);
      },
      checkpointStructural(file, entry) {
        events.push(`structural:${entry?.status ?? "absent"}`);
        if (entry) structures.set(file, entry);
        else structures.delete(file);
      },
    };
    remote = {
      deletePoints: vi.fn(async () => {
        events.push("delete");
      }),
      upsertPoints: vi.fn(async () => {
        events.push("upsert");
      }),
      setVisibility: vi.fn(async (_ids, visible) => {
        events.push(`visible:${visible}`);
      }),
    };
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("journals all IDs before hiding or mutating Qdrant", async () => {
    vectors.set("src/changed.ts", {
      hash: "hash-1",
      pointIds: ["old-1"],
      indexedAt: "2025-01-01T00:00:00.000Z",
    });
    remote.setVisibility.mockImplementation(async (_ids, visible) => {
      expect(loadFileIndexJournal(journalPath)).toMatchObject({
        status: "valid",
        journal: {
          operations: [
            {
              file: "src/changed.ts",
              oldPointIds: ["old-1"],
              intendedBatches: [{ batch: 0, pointIds: ["new-1", "new-2"] }],
            },
          ],
        },
      });
      events.push(`visible:${visible}`);
    });

    const result = await executeJournaledFileReplacement({
      journalPath,
      replacement: replacement(),
      store,
      remote,
      isCancelled: () => cancelled,
      createId: () => "operation-1",
    });

    expect(result).toEqual({
      committed: true,
      cancelled: false,
      pointsDeleted: 1,
      pointsUpserted: 2,
    });
    expect(events).toEqual([
      "structural:absent",
      "visible:false",
      "delete",
      "upsert",
      "vector:pending",
      "structural:current",
      "visible:true",
      "vector:current",
    ]);
    expect(loadFileIndexJournal(journalPath)).toEqual({
      status: "valid",
      journal: emptyFileIndexJournal(),
    });
  });

  it("recovers partial mutation by deleting the full old and intended union", async () => {
    writeFileIndexJournal(journalPath, {
      ...emptyFileIndexJournal(),
      operations: [
        {
          operationId: "operation-1",
          file: "src/changed.ts",
          kind: "replace",
          generation: "generation-2",
          targetHash: "hash-2",
          oldPointIds: ["old-1"],
          intendedBatches: [{ batch: 0, pointIds: ["new-1", "new-2"] }],
        },
      ],
    });
    vectors.set("src/changed.ts", {
      hash: "hash-1",
      pointIds: ["old-1"],
      indexedAt: "2025-01-01T00:00:00.000Z",
    });

    const result = await recoverJournaledFileReplacements({
      journalPath,
      store,
      remote,
      isCancelled: () => false,
    });

    expect(result).toEqual({
      recoveredFiles: ["src/changed.ts"],
      cancelled: false,
      pointsDeleted: 3,
    });
    expect(remote.deletePoints).toHaveBeenCalledWith([
      "old-1",
      "new-1",
      "new-2",
    ]);
    expect(events).toEqual(["delete", "structural:absent", "vector:absent"]);
    expect(loadFileIndexJournal(journalPath)).toEqual({
      status: "valid",
      journal: emptyFileIndexJournal(),
    });
  });

  it("bounds recovery cleanup and retains ownership when cancellation interrupts it", async () => {
    const intendedPointIds = Array.from(
      { length: 300 },
      (_, index) => `new-${index}`,
    );
    const oldPointIds = Array.from(
      { length: 300 },
      (_, index) => `old-${index}`,
    );
    writeFileIndexJournal(journalPath, {
      ...emptyFileIndexJournal(),
      operations: [
        {
          operationId: "operation-1",
          file: "src/changed.ts",
          kind: "replace",
          generation: "generation-2",
          targetHash: "hash-2",
          oldPointIds,
          intendedBatches: [
            { batch: 0, pointIds: intendedPointIds.slice(0, 100) },
            { batch: 1, pointIds: intendedPointIds.slice(100, 200) },
            { batch: 2, pointIds: intendedPointIds.slice(200) },
          ],
        },
      ],
    });
    remote.deletePoints.mockImplementationOnce(async () => {
      events.push("delete");
      cancelled = true;
    });

    const result = await recoverJournaledFileReplacements({
      journalPath,
      store,
      remote,
      isCancelled: () => cancelled,
    });

    expect(result).toEqual({
      recoveredFiles: [],
      cancelled: true,
      pointsDeleted: 256,
    });
    expect(remote.deletePoints).toHaveBeenCalledTimes(1);
    expect(remote.deletePoints).toHaveBeenCalledWith(oldPointIds.slice(0, 256));
    expect(loadFileIndexJournal(journalPath)).toMatchObject({
      status: "valid",
      journal: { operations: [{ operationId: "operation-1" }] },
    });
  });

  it("retains journal and cache ownership when a later recovery batch fails", async () => {
    const intendedPointIds = Array.from(
      { length: 300 },
      (_, index) => `new-${index}`,
    );
    const oldPointIds = Array.from(
      { length: 300 },
      (_, index) => `old-${index}`,
    );
    writeFileIndexJournal(journalPath, {
      ...emptyFileIndexJournal(),
      operations: [
        {
          operationId: "operation-1",
          file: "src/changed.ts",
          kind: "replace",
          generation: "generation-2",
          targetHash: "hash-2",
          oldPointIds,
          intendedBatches: [
            { batch: 0, pointIds: intendedPointIds.slice(0, 100) },
            { batch: 1, pointIds: intendedPointIds.slice(100, 200) },
            { batch: 2, pointIds: intendedPointIds.slice(200) },
          ],
        },
      ],
    });
    vectors.set("src/changed.ts", {
      hash: "hash-1",
      pointIds: oldPointIds,
      indexedAt: "2025-01-01T00:00:00.000Z",
    });
    remote.deletePoints
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("second delete failed"));

    await expect(
      recoverJournaledFileReplacements({
        journalPath,
        store,
        remote,
        isCancelled: () => false,
      }),
    ).rejects.toThrow("second delete failed");

    expect(remote.deletePoints).toHaveBeenCalledTimes(2);
    expect(vectors.get("src/changed.ts")?.pointIds).toEqual(oldPointIds);
    expect(loadFileIndexJournal(journalPath)).toMatchObject({
      status: "valid",
      journal: { operations: [{ operationId: "operation-1" }] },
    });
  });

  it("accepts exact vector and structural proof then publishes pending points", async () => {
    writeFileIndexJournal(journalPath, {
      ...emptyFileIndexJournal(),
      operations: [
        {
          operationId: "operation-1",
          file: "src/changed.ts",
          kind: "replace",
          generation: "generation-2",
          targetHash: "hash-2",
          oldPointIds: ["old-1"],
          intendedBatches: [{ batch: 0, pointIds: ["new-1", "new-2"] }],
        },
      ],
    });
    vectors.set("src/changed.ts", {
      hash: "hash-2",
      pointIds: ["new-1", "new-2"],
      indexedAt: "2026-01-01T00:00:00.000Z",
      generation: "generation-2",
      visibility: "pending",
    });
    structures.set("src/changed.ts", {
      ...structural("src/changed.ts", "hash-2"),
      generation: "generation-2",
      status: "current",
    });

    await recoverJournaledFileReplacements({
      journalPath,
      store,
      remote,
      isCancelled: () => false,
    });

    expect(remote.deletePoints).not.toHaveBeenCalled();
    expect(remote.setVisibility).toHaveBeenCalledWith(["new-1", "new-2"], true);
    expect(vectors.get("src/changed.ts")?.visibility).toBe("current");
    expect(loadFileIndexJournal(journalPath)).toEqual({
      status: "valid",
      journal: emptyFileIndexJournal(),
    });
  });

  it("reconciles journal-cleared pending visibility idempotently", async () => {
    vectors.set("src/changed.ts", {
      hash: "hash-2",
      pointIds: ["new-1", "new-2"],
      indexedAt: "2026-01-01T00:00:00.000Z",
      generation: "generation-2",
      visibility: "pending",
    });
    structures.set("src/changed.ts", {
      ...structural("src/changed.ts", "hash-2"),
      generation: "generation-2",
      status: "current",
    });

    await recoverJournaledFileReplacements({
      journalPath,
      store,
      remote,
      isCancelled: () => false,
    });

    expect(remote.setVisibility).toHaveBeenCalledWith(["new-1", "new-2"], true);
    expect(vectors.get("src/changed.ts")?.visibility).toBe("current");
  });

  it("counts bounded invalid pending-cache cleanup", async () => {
    const pointIds = Array.from({ length: 300 }, (_, index) => `new-${index}`);
    vectors.set("src/changed.ts", {
      hash: "hash-2",
      pointIds,
      indexedAt: "2026-01-01T00:00:00.000Z",
      generation: "generation-2",
      visibility: "pending",
    });

    const result = await recoverJournaledFileReplacements({
      journalPath,
      store,
      remote,
      isCancelled: () => false,
    });

    expect(result).toEqual({
      recoveredFiles: [],
      cancelled: false,
      pointsDeleted: 300,
    });
    expect(remote.deletePoints.mock.calls.map(([ids]) => ids.length)).toEqual([
      256, 44,
    ]);
    expect(vectors.has("src/changed.ts")).toBe(false);
  });

  it("counts partial pending-cache cleanup and retains ownership on cancellation", async () => {
    const pointIds = Array.from({ length: 300 }, (_, index) => `new-${index}`);
    vectors.set("src/changed.ts", {
      hash: "hash-2",
      pointIds,
      indexedAt: "2026-01-01T00:00:00.000Z",
      generation: "generation-2",
      visibility: "pending",
    });
    remote.deletePoints.mockImplementationOnce(async () => {
      events.push("delete");
      cancelled = true;
    });

    const result = await recoverJournaledFileReplacements({
      journalPath,
      store,
      remote,
      isCancelled: () => cancelled,
    });

    expect(result).toEqual({
      recoveredFiles: [],
      cancelled: true,
      pointsDeleted: 256,
    });
    expect(remote.deletePoints).toHaveBeenCalledTimes(1);
    expect(vectors.get("src/changed.ts")?.visibility).toBe("pending");
  });

  it("retains pending-cache ownership when a later cleanup batch fails", async () => {
    const pointIds = Array.from({ length: 300 }, (_, index) => `new-${index}`);
    vectors.set("src/changed.ts", {
      hash: "hash-2",
      pointIds,
      indexedAt: "2026-01-01T00:00:00.000Z",
      generation: "generation-2",
      visibility: "pending",
    });
    remote.deletePoints
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("second delete failed"));

    await expect(
      recoverJournaledFileReplacements({
        journalPath,
        store,
        remote,
        isCancelled: () => false,
      }),
    ).rejects.toThrow("second delete failed");

    expect(remote.deletePoints).toHaveBeenCalledTimes(2);
    expect(vectors.get("src/changed.ts")?.visibility).toBe("pending");
  });

  it("does not clear ownership when cancellation follows old-point hiding", async () => {
    remote.setVisibility.mockImplementationOnce(async () => {
      cancelled = true;
    });

    const result = await executeJournaledFileReplacement({
      journalPath,
      replacement: replacement(),
      store,
      remote,
      isCancelled: () => cancelled,
      createId: () => "operation-1",
    });

    expect(result).toEqual({
      committed: false,
      cancelled: true,
      pointsDeleted: 0,
      pointsUpserted: 0,
    });
    expect(remote.deletePoints).not.toHaveBeenCalled();
    expect(loadFileIndexJournal(journalPath)).toMatchObject({
      status: "valid",
      journal: { operations: [{ file: "src/changed.ts" }] },
    });
  });
});
