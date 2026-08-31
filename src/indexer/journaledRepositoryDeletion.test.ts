import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  REMOVED_FILE_DELETE_BATCH_SIZE,
  executeJournaledRepositoryDeletions,
  recoverJournaledRepositoryDeletions,
} from "./journaledRepositoryDeletion.js";
import type {
  RetrievalDeleteSourceOutcome,
  RetrievalDeleteSourceRequest,
} from "@agentlink/protocol/retrieval-deletion";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  emptyFileIndexJournal,
  loadFileIndexJournal,
  writeFileIndexJournal,
} from "./fileIndexJournal.js";

async function runFenced<T>(operation: () => Promise<T>): Promise<T> {
  return operation();
}

function deletingRepository(deleted: string[][]) {
  return {
    async deleteSources(
      requests: RetrievalDeleteSourceRequest[],
    ): Promise<RetrievalDeleteSourceOutcome[]> {
      deleted.push(requests.map((request) => request.sourceId));
      return requests.map((request) => ({
        sourceId: request.sourceId,
        status: "deleted" as const,
        recordsRemoved: 3,
      }));
    },
  };
}

function operation(file: string, operationId = `operation:${file}`) {
  return {
    operationId,
    file,
    kind: "remove" as const,
    generation: `generation:${file}`,
    targetHash: null,
    oldRecordIds: [`chunk:${file}`],
    intendedBatches: [],
  };
}

describe("journaled repository deletion", () => {
  let directory: string;
  let journalPath: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "journaled-repository-deletion-"),
    );
    journalPath = path.join(directory, "index.journal.json");
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("journals and drains multiple source deletions without resurrecting completed operations", async () => {
    const deleted: string[][] = [];
    const checkpointed: string[] = [];
    let sequence = 0;

    await expect(
      executeJournaledRepositoryDeletions({
        journalPath,
        requestedFiles: [
          {
            file: "src/one.ts",
            oldRecordIds: ["chunk:one"],
            generation: "generation:one",
          },
          {
            file: "src/two.ts",
            oldRecordIds: ["chunk:two"],
            generation: "generation:two",
          },
        ],
        repository: deletingRepository(deleted),
        resolveSource: (file) => ({
          sourceId: `code:workspace:test:${file}`,
          expectedRevisionId: `revision:${file}`,
        }),
        checkpointCompleted: (files) => checkpointed.push(...files),
        runFenced,
        isCancelled: () => false,
        createId: () => `operation-${++sequence}`,
      }),
    ).resolves.toEqual({
      completedFiles: ["src/one.ts", "src/two.ts"],
      recordsDeleted: 6,
      cancelled: false,
      pending: false,
    });
    expect(deleted).toEqual([
      ["code:workspace:test:src/one.ts", "code:workspace:test:src/two.ts"],
    ]);
    expect(checkpointed).toEqual(["src/one.ts", "src/two.ts"]);
    expect(loadFileIndexJournal(journalPath)).toMatchObject({
      status: "valid",
      journal: { operations: [] },
    });
  });

  it("batches large removal sets and reports progress per checkpoint", async () => {
    const total = REMOVED_FILE_DELETE_BATCH_SIZE + 3;
    const deleted: string[][] = [];
    const checkpointBatches: string[][] = [];
    const progress: Array<[number, number]> = [];
    let sequence = 0;

    await expect(
      executeJournaledRepositoryDeletions({
        journalPath,
        requestedFiles: Array.from({ length: total }, (_, index) => ({
          file: `src/file-${index}.ts`,
          oldRecordIds: [`chunk:${index}`],
          generation: `generation:${index}`,
        })),
        repository: deletingRepository(deleted),
        resolveSource: (file) => ({ sourceId: `code:workspace:test:${file}` }),
        checkpointCompleted: (files) => checkpointBatches.push([...files]),
        runFenced,
        isCancelled: () => false,
        createId: () => `operation-${++sequence}`,
        onProgress: (completedFiles, totalFiles) =>
          progress.push([completedFiles, totalFiles]),
      }),
    ).resolves.toMatchObject({
      recordsDeleted: total * 3,
      cancelled: false,
      pending: false,
    });
    expect(deleted.map((batch) => batch.length)).toEqual([
      REMOVED_FILE_DELETE_BATCH_SIZE,
      3,
    ]);
    expect(checkpointBatches.map((batch) => batch.length)).toEqual([
      REMOVED_FILE_DELETE_BATCH_SIZE,
      3,
    ]);
    expect(progress).toContainEqual([REMOVED_FILE_DELETE_BATCH_SIZE, total]);
    expect(progress.at(-1)).toEqual([total, total]);
    expect(loadFileIndexJournal(journalPath)).toMatchObject({
      status: "valid",
      journal: { operations: [] },
    });
  });

  it("recovers a removal from the durable file path without transient request state", async () => {
    writeFileIndexJournal(journalPath, {
      ...emptyFileIndexJournal(),
      operations: [operation("src/recover.ts")],
    });
    const deleteSources = vi.fn(
      async (requests: RetrievalDeleteSourceRequest[]) =>
        requests.map((request) => ({
          sourceId: request.sourceId,
          status: "not_found" as const,
          recordsRemoved: 0,
        })),
    );

    await expect(
      recoverJournaledRepositoryDeletions({
        journalPath,
        repository: { deleteSources },
        resolveSource: (file) => ({
          sourceId: `code:workspace:test:${file}`,
          expectedRevisionId: "revision:recover",
        }),
        checkpointCompleted: () => undefined,
        runFenced,
        isCancelled: () => false,
      }),
    ).resolves.toMatchObject({
      completedFiles: ["src/recover.ts"],
      pending: false,
    });
    expect(deleteSources).toHaveBeenCalledWith([
      {
        sourceId: "code:workspace:test:src/recover.ts",
        expectedRevisionId: "revision:recover",
      },
    ]);
  });

  it("keeps the journal and reports repository deletion failures", async () => {
    writeFileIndexJournal(journalPath, {
      ...emptyFileIndexJournal(),
      operations: [operation("src/failure.ts")],
    });
    const checkpointCompleted = vi.fn();

    await expect(
      recoverJournaledRepositoryDeletions({
        journalPath,
        repository: {
          async deleteSources(): Promise<RetrievalDeleteSourceOutcome[]> {
            throw new Error("store unavailable");
          },
        },
        resolveSource: (file) => ({
          sourceId: `code:workspace:test:${file}`,
          expectedRevisionId: "revision:failure",
        }),
        checkpointCompleted,
        runFenced,
        isCancelled: () => false,
      }),
    ).resolves.toMatchObject({
      completedFiles: [],
      recordsDeleted: 0,
      pending: true,
      failure: expect.stringContaining("store unavailable"),
    });
    expect(checkpointCompleted).not.toHaveBeenCalled();
    expect(loadFileIndexJournal(journalPath)).toMatchObject({
      status: "valid",
      journal: { operations: [{ file: "src/failure.ts" }] },
    });
  });

  it("keeps stale-owned journal entries while checkpointing earlier batch members", async () => {
    writeFileIndexJournal(journalPath, {
      ...emptyFileIndexJournal(),
      operations: [operation("src/completed.ts"), operation("src/stale.ts")],
    });
    const checkpointCompleted = vi.fn();

    await expect(
      recoverJournaledRepositoryDeletions({
        journalPath,
        repository: {
          async deleteSources(requests: RetrievalDeleteSourceRequest[]) {
            return requests.map((request) => ({
              sourceId: request.sourceId,
              status: request.sourceId.includes("stale")
                ? ("stale_source" as const)
                : ("deleted" as const),
              recordsRemoved: request.sourceId.includes("stale") ? 0 : 2,
            }));
          },
        },
        resolveSource: (file) => ({
          sourceId: `code:workspace:test:${file}`,
          expectedRevisionId: `revision:${file}`,
        }),
        checkpointCompleted,
        runFenced,
        isCancelled: () => false,
      }),
    ).resolves.toMatchObject({
      completedFiles: ["src/completed.ts"],
      recordsDeleted: 2,
      pending: true,
      failure: expect.stringContaining("retained stale ownership"),
    });
    expect(checkpointCompleted).toHaveBeenCalledWith(["src/completed.ts"]);
    expect(loadFileIndexJournal(journalPath)).toMatchObject({
      status: "valid",
      journal: { operations: [{ file: "src/stale.ts" }] },
    });
  });
});
