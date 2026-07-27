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
  executeJournaledRepositoryDeletions,
  recoverJournaledRepositoryDeletions,
} from "./journaledRepositoryDeletion.js";

import type { RetrievalDeleteSourceOutcome } from "../core/retrieval/contracts.js";

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
    const deleted: string[] = [];
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
        repository: {
          async deleteSource(request): Promise<RetrievalDeleteSourceOutcome> {
            deleted.push(request.sourceId);
            return {
              sourceId: request.sourceId,
              status: "deleted",
              recordsRemoved: 3,
            };
          },
        },
        resolveSource: (file) => ({
          sourceId: `code:workspace:test:${file}`,
          expectedRevisionId: `revision:${file}`,
        }),
        checkpointCompleted: (files) => checkpointed.push(...files),
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
      "code:workspace:test:src/one.ts",
      "code:workspace:test:src/two.ts",
    ]);
    expect(checkpointed).toEqual(["src/one.ts", "src/two.ts"]);
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
    const deleteSource = vi.fn(async (request) => ({
      sourceId: request.sourceId,
      status: "not_found" as const,
      recordsRemoved: 0,
    }));

    await expect(
      recoverJournaledRepositoryDeletions({
        journalPath,
        repository: { deleteSource },
        resolveSource: (file) => ({
          sourceId: `code:workspace:test:${file}`,
          expectedRevisionId: "revision:recover",
        }),
        checkpointCompleted: () => undefined,
        isCancelled: () => false,
      }),
    ).resolves.toMatchObject({
      completedFiles: ["src/recover.ts"],
      pending: false,
    });
    expect(deleteSource).toHaveBeenCalledWith({
      sourceId: "code:workspace:test:src/recover.ts",
      expectedRevisionId: "revision:recover",
    });
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
          async deleteSource() {
            throw new Error("store unavailable");
          },
        },
        resolveSource: (file) => ({
          sourceId: `code:workspace:test:${file}`,
          expectedRevisionId: "revision:failure",
        }),
        checkpointCompleted,
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

  it("keeps the journal when revision ownership is stale", async () => {
    writeFileIndexJournal(journalPath, {
      ...emptyFileIndexJournal(),
      operations: [operation("src/stale.ts")],
    });
    const checkpointCompleted = vi.fn();

    await expect(
      recoverJournaledRepositoryDeletions({
        journalPath,
        repository: {
          async deleteSource(request) {
            return {
              sourceId: request.sourceId,
              status: "stale_source" as const,
              recordsRemoved: 0,
            };
          },
        },
        resolveSource: (file) => ({
          sourceId: `code:workspace:test:${file}`,
          expectedRevisionId: "revision:stale",
        }),
        checkpointCompleted,
        isCancelled: () => false,
      }),
    ).resolves.toMatchObject({
      completedFiles: [],
      recordsDeleted: 0,
      pending: true,
      failure: expect.stringContaining("retained stale ownership"),
    });
    expect(checkpointCompleted).not.toHaveBeenCalled();
    expect(loadFileIndexJournal(journalPath)).toMatchObject({
      status: "valid",
      journal: { operations: [{ file: "src/stale.ts" }] },
    });
  });
});
