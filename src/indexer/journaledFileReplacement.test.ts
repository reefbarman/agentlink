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
  executeJournaledFileReplacements,
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

function replacementFor(
  file: string,
  suffix: string,
  oldPointIds: string[] = [`old-${suffix}`],
): PreparedFileReplacement {
  const hash = `hash-${suffix}`;
  return {
    file,
    generation: `generation-${suffix}`,
    targetHash: hash,
    oldPointIds,
    points: [
      {
        id: `new-${suffix}-1`,
        vector: [0.1],
        payload: { filePath: file, indexVisible: false },
      },
      {
        id: `new-${suffix}-2`,
        vector: [0.2],
        payload: { filePath: file, indexVisible: false },
      },
    ],
    structuralEntry: structural(file, hash),
    cacheEntry: {
      hash,
      pointIds: [`new-${suffix}-1`, `new-${suffix}-2`],
      indexedAt: "2026-01-01T00:00:00.000Z",
    },
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

  function coalescingStore(): FileReplacementStore {
    return {
      ...store,
      checkpointVectors(entries) {
        events.push(`vectors:${entries.length}`);
        for (const [file, entry] of entries) {
          if (entry) vectors.set(file, entry);
          else vectors.delete(file);
        }
      },
      checkpointStructurals(entries) {
        events.push(`structurals:${entries.length}`);
        for (const [file, entry] of entries) {
          if (entry) structures.set(file, entry);
          else structures.delete(file);
        }
      },
    };
  }

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

  it("commits multiple replacements with coalesced cache checkpoints", async () => {
    const replacements = [
      replacementFor("src/first.ts", "first"),
      replacementFor("src/second.ts", "second"),
    ];
    for (const replacement of replacements) {
      vectors.set(replacement.file, {
        hash: `old-${replacement.targetHash}`,
        pointIds: replacement.oldPointIds,
        indexedAt: "2025-01-01T00:00:00.000Z",
      });
      structures.set(
        replacement.file,
        structural(replacement.file, `old-${replacement.targetHash}`),
      );
    }
    remote.setVisibility.mockImplementation(async (_ids, visible) => {
      expect(loadFileIndexJournal(journalPath)).toMatchObject({
        status: "valid",
        journal: { operations: [{ kind: "replace" }, { kind: "replace" }] },
      });
      events.push(`visible:${visible}`);
    });

    const result = await executeJournaledFileReplacements({
      journalPath,
      replacements,
      store: coalescingStore(),
      remote,
      isCancelled: () => false,
      createId: (() => {
        let id = 0;
        return () => `operation-${++id}`;
      })(),
    });

    expect(result).toEqual({
      committedFiles: 2,
      cancelled: false,
      pointsDeleted: 2,
      pointsUpserted: 4,
    });
    expect(events).toEqual([
      "structurals:2",
      "visible:false",
      "delete",
      "upsert",
      "vectors:2",
      "structurals:2",
      "visible:true",
      "vectors:2",
    ]);
    expect(
      remote.setVisibility.mock.calls.map(([ids, visible]) => [
        ids.length,
        visible,
      ]),
    ).toEqual([
      [2, false],
      [4, true],
    ]);
    expect(loadFileIndexJournal(journalPath)).toEqual({
      status: "valid",
      journal: emptyFileIndexJournal(),
    });
    expect(
      [...vectors.values()].every((entry) => entry.visibility === "current"),
    ).toBe(true);
  });

  it("recovers mixed exact and invalid operations with one checkpoint per cache", async () => {
    const exact = replacementFor("src/exact.ts", "exact");
    const invalid = replacementFor("src/invalid.ts", "invalid");
    writeFileIndexJournal(journalPath, {
      ...emptyFileIndexJournal(),
      operations: [exact, invalid].map((entry, index) => ({
        operationId: `operation-${index}`,
        file: entry.file,
        kind: "replace",
        generation: entry.generation,
        targetHash: entry.targetHash,
        oldPointIds: entry.oldPointIds,
        intendedBatches: [
          {
            batch: 0,
            pointIds: entry.points.map((point) => point.id),
          },
        ],
      })),
    });
    vectors.set(exact.file, {
      ...exact.cacheEntry,
      generation: exact.generation,
      visibility: "pending",
    });
    structures.set(exact.file, {
      ...exact.structuralEntry,
      generation: exact.generation,
      status: "current",
    });
    vectors.set(invalid.file, {
      hash: "old-invalid",
      pointIds: invalid.oldPointIds,
      indexedAt: "2025-01-01T00:00:00.000Z",
    });

    const result = await recoverJournaledFileReplacements({
      journalPath,
      store: coalescingStore(),
      remote,
      isCancelled: () => false,
    });

    expect(result).toEqual({
      recoveredFiles: [exact.file, invalid.file],
      cancelled: false,
      pointsDeleted: 3,
    });
    expect(remote.setVisibility).toHaveBeenCalledWith(
      exact.points.map((point) => point.id),
      true,
    );
    expect(remote.deletePoints).toHaveBeenCalledWith([
      ...invalid.oldPointIds,
      ...invalid.points.map((point) => point.id),
    ]);
    expect(events).toEqual([
      "visible:true",
      "delete",
      "structurals:1",
      "vectors:2",
    ]);
    expect(vectors.get(exact.file)?.visibility).toBe("current");
    expect(vectors.has(invalid.file)).toBe(false);
    expect(loadFileIndexJournal(journalPath)).toEqual({
      status: "valid",
      journal: emptyFileIndexJournal(),
    });
  });

  it("retains the full journal when a coalesced cache checkpoint fails", async () => {
    const replacements = [
      replacementFor("src/first.ts", "first"),
      replacementFor("src/second.ts", "second"),
    ];
    const failingStore = coalescingStore();
    failingStore.checkpointVectors = () => {
      throw new Error("vector checkpoint failed");
    };

    await expect(
      executeJournaledFileReplacements({
        journalPath,
        replacements,
        store: failingStore,
        remote,
        isCancelled: () => false,
        createId: (() => {
          let id = 0;
          return () => `operation-${++id}`;
        })(),
      }),
    ).rejects.toThrow("vector checkpoint failed");

    expect(loadFileIndexJournal(journalPath)).toMatchObject({
      status: "valid",
      journal: {
        operations: [{ file: "src/first.ts" }, { file: "src/second.ts" }],
      },
    });
    expect(vectors.size).toBe(0);
  });

  it("leaves the full recovery journal and caches unchanged on remote failure", async () => {
    const exact = replacementFor("src/exact.ts", "exact");
    const invalid = replacementFor("src/invalid.ts", "invalid");
    const journal = {
      ...emptyFileIndexJournal(),
      operations: [exact, invalid].map((entry, index) => ({
        operationId: `operation-${index}`,
        file: entry.file,
        kind: "replace" as const,
        generation: entry.generation,
        targetHash: entry.targetHash,
        oldPointIds: entry.oldPointIds,
        intendedBatches: [
          {
            batch: 0,
            pointIds: entry.points.map((point) => point.id),
          },
        ],
      })),
    };
    writeFileIndexJournal(journalPath, journal);
    vectors.set(exact.file, {
      ...exact.cacheEntry,
      generation: exact.generation,
      visibility: "pending",
    });
    structures.set(exact.file, {
      ...exact.structuralEntry,
      generation: exact.generation,
      status: "current",
    });
    const originalVector = vectors.get(exact.file);
    remote.deletePoints.mockRejectedValueOnce(new Error("cleanup failed"));

    await expect(
      recoverJournaledFileReplacements({
        journalPath,
        store: coalescingStore(),
        remote,
        isCancelled: () => false,
      }),
    ).rejects.toThrow("cleanup failed");

    expect(vectors.get(exact.file)).toEqual(originalVector);
    expect(events).toEqual(["visible:true"]);
    expect(loadFileIndexJournal(journalPath)).toEqual({
      status: "valid",
      journal,
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

  it("bounds exact pending recovery visibility and retains ownership on cancellation", async () => {
    const intendedPointIds = Array.from(
      { length: 250 },
      (_, index) => `new-${index}`,
    );
    const journal = {
      ...emptyFileIndexJournal(),
      operations: [
        {
          operationId: "operation-1",
          file: "src/changed.ts",
          kind: "replace" as const,
          generation: "generation-2",
          targetHash: "hash-2",
          oldPointIds: ["old-1"],
          intendedBatches: [
            { batch: 0, pointIds: intendedPointIds.slice(0, 100) },
            { batch: 1, pointIds: intendedPointIds.slice(100, 200) },
            { batch: 2, pointIds: intendedPointIds.slice(200) },
          ],
        },
      ],
    };
    writeFileIndexJournal(journalPath, journal);
    vectors.set("src/changed.ts", {
      hash: "hash-2",
      pointIds: intendedPointIds,
      indexedAt: "2026-01-01T00:00:00.000Z",
      generation: "generation-2",
      visibility: "pending",
    });
    structures.set("src/changed.ts", {
      ...structural("src/changed.ts", "hash-2"),
      generation: "generation-2",
      status: "current",
    });
    remote.setVisibility.mockImplementationOnce(async () => {
      events.push("visible:true");
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
      pointsDeleted: 0,
    });
    expect(remote.setVisibility).toHaveBeenCalledTimes(1);
    expect(remote.setVisibility).toHaveBeenCalledWith(
      intendedPointIds.slice(0, 100),
      true,
    );
    expect(vectors.get("src/changed.ts")?.visibility).toBe("pending");
    expect(loadFileIndexJournal(journalPath)).toEqual({
      status: "valid",
      journal,
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

  it("coalesces journal-cleared pending recovery checkpoints", async () => {
    for (let index = 0; index < 3; index++) {
      const file = `src/current-${index}.ts`;
      vectors.set(file, {
        hash: `hash-${index}`,
        pointIds: [`point-${index}`],
        indexedAt: "2026-01-01T00:00:00.000Z",
        generation: `generation-${index}`,
        visibility: "pending",
      });
      structures.set(file, {
        ...structural(file, `hash-${index}`),
        generation: `generation-${index}`,
        status: "current",
      });
    }
    vectors.set("src/invalid.ts", {
      hash: "hash-invalid",
      pointIds: ["point-invalid"],
      indexedAt: "2026-01-01T00:00:00.000Z",
      generation: "generation-invalid",
      visibility: "pending",
    });

    await recoverJournaledFileReplacements({
      journalPath,
      store: coalescingStore(),
      remote,
      isCancelled: () => false,
    });

    expect(events).toEqual([
      "delete",
      "visible:true",
      "structurals:1",
      "vectors:4",
    ]);
    expect(remote.setVisibility).toHaveBeenCalledWith(
      ["point-0", "point-1", "point-2"],
      true,
    );
    expect(vectors.has("src/invalid.ts")).toBe(false);
    expect(
      [...vectors.values()].every((entry) => entry.visibility === "current"),
    ).toBe(true);
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
