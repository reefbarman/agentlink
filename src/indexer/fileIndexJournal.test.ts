import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  FILE_INDEX_JOURNAL_VERSION,
  emptyFileIndexJournal,
  getFileIndexJournalPath,
  loadFileIndexJournal,
  validateFileIndexJournal,
  writeFileIndexJournal,
  type FileIndexJournal,
} from "./fileIndexJournal.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { FileIndexJournalIntent } from "./fileIndexState.js";

function replacement(
  overrides: Partial<FileIndexJournalIntent> = {},
): FileIndexJournalIntent {
  return {
    operationId: "operation-1",
    file: "src/example.ts",
    kind: "replace",
    generation: "generation-2",
    targetHash: "target-hash",
    oldPointIds: ["old-1"],
    intendedBatches: [
      { batch: 0, pointIds: ["new-1", "new-2"] },
      { batch: 1, pointIds: ["new-3"] },
    ],
    ...overrides,
  };
}

describe("fileIndexJournal", () => {
  let directory: string;
  let journalPath: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-journal-"));
    journalPath = path.join(directory, "index.journal.json");
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("derives the journal path beside the vector cache", () => {
    expect(getFileIndexJournalPath("/cache/workspace.json")).toBe(
      path.join("/cache", "workspace.journal.json"),
    );
    expect(getFileIndexJournalPath("/cache/workspace")).toBe(
      "/cache/workspace.journal.json",
    );
  });

  it("returns an empty missing journal without creating a file", () => {
    expect(loadFileIndexJournal(journalPath)).toEqual({
      status: "missing",
      journal: emptyFileIndexJournal(),
    });
    expect(fs.existsSync(journalPath)).toBe(false);
  });

  it("atomically round-trips validated removal and replacement intents", () => {
    const journal: FileIndexJournal = {
      version: FILE_INDEX_JOURNAL_VERSION,
      operations: [
        replacement(),
        {
          operationId: "operation-2",
          file: "src/removed.ts",
          kind: "remove" as const,
          generation: "generation-2",
          targetHash: null,
          oldPointIds: ["removed-1", "removed-2"],
          intendedBatches: [],
        },
      ],
    };

    writeFileIndexJournal(journalPath, journal);

    expect(loadFileIndexJournal(journalPath)).toEqual({
      status: "valid",
      journal,
    });
    expect(
      fs.readdirSync(directory).filter((file) => file.includes(".tmp-")),
    ).toEqual([]);
  });

  it("preserves corrupt bytes for operator-assisted recovery", () => {
    const corrupt = '{"version":1,"operations":[';
    fs.writeFileSync(journalPath, corrupt);

    const result = loadFileIndexJournal(journalPath);

    expect(result.status).toBe("corrupt");
    expect(() =>
      writeFileIndexJournal(journalPath, emptyFileIndexJournal()),
    ).toThrow("Refusing to replace corrupt file index journal");
    expect(fs.readFileSync(journalPath, "utf8")).toBe(corrupt);
  });

  it("preserves a dangling journal symlink as an unreadable artifact", () => {
    fs.symlinkSync(path.join(directory, "missing-target.json"), journalPath);

    const result = loadFileIndexJournal(journalPath);

    expect(result).toEqual({
      status: "corrupt",
      error: "Journal path exists but could not be read",
    });
    expect(() =>
      writeFileIndexJournal(journalPath, emptyFileIndexJournal()),
    ).toThrow("Refusing to replace corrupt file index journal");
    expect(fs.lstatSync(journalPath).isSymbolicLink()).toBe(true);
  });

  it("classifies unsupported versions and invalid operations as corrupt", () => {
    fs.writeFileSync(
      journalPath,
      JSON.stringify({ version: 2, operations: [] }),
    );
    expect(loadFileIndexJournal(journalPath).status).toBe("corrupt");

    fs.writeFileSync(
      journalPath,
      JSON.stringify({
        version: FILE_INDEX_JOURNAL_VERSION,
        operations: [replacement({ targetHash: null })],
      }),
    );
    expect(loadFileIndexJournal(journalPath).status).toBe("corrupt");
  });

  it("validates before replacing an existing durable journal", () => {
    const original = JSON.stringify(emptyFileIndexJournal());
    fs.writeFileSync(journalPath, original);

    expect(() =>
      writeFileIndexJournal(journalPath, {
        version: FILE_INDEX_JOURNAL_VERSION,
        operations: [
          replacement(),
          replacement({ operationId: "operation-2" }),
        ],
      }),
    ).toThrow("Journal files must be unique");

    expect(fs.readFileSync(journalPath, "utf8")).toBe(original);
  });

  it("rejects duplicate operation IDs and point ownership", () => {
    expect(() =>
      validateFileIndexJournal({
        version: FILE_INDEX_JOURNAL_VERSION,
        operations: [replacement(), replacement({ file: "src/other.ts" })],
      }),
    ).toThrow("Journal operation IDs must be unique");

    expect(() =>
      validateFileIndexJournal({
        version: FILE_INDEX_JOURNAL_VERSION,
        operations: [replacement({ oldPointIds: ["old-1", "old-1"] })],
      }),
    ).toThrow("Journal old point IDs must be unique");

    expect(() =>
      validateFileIndexJournal({
        version: FILE_INDEX_JOURNAL_VERSION,
        operations: [
          replacement({
            intendedBatches: [
              { batch: 0, pointIds: ["new-1"] },
              { batch: 1, pointIds: ["new-1"] },
            ],
          }),
        ],
      }),
    ).toThrow("Journal intended point IDs must be unique");

    expect(() =>
      validateFileIndexJournal({
        version: FILE_INDEX_JOURNAL_VERSION,
        operations: [
          replacement({
            oldPointIds: ["shared"],
            intendedBatches: [{ batch: 0, pointIds: ["shared"] }],
          }),
        ],
      }),
    ).toThrow("Journal intended point IDs cannot reuse old point IDs");

    expect(() =>
      validateFileIndexJournal({
        version: FILE_INDEX_JOURNAL_VERSION,
        operations: [
          replacement(),
          replacement({
            operationId: "operation-2",
            file: "src/other.ts",
            oldPointIds: ["new-3"],
            intendedBatches: [{ batch: 0, pointIds: ["other-new"] }],
          }),
        ],
      }),
    ).toThrow("Journal point IDs must have one owner");
  });

  it.each([
    "./src/example.ts",
    "src/../src/example.ts",
    "src/example.ts/",
    "src\\example.ts",
    "/src/example.ts",
    "C:\\src\\example.ts",
    "C:src/example.ts",
    "../src/example.ts",
    ".",
  ])("rejects non-canonical journal file path %s", (file) => {
    expect(() =>
      validateFileIndexJournal({
        version: FILE_INDEX_JOURNAL_VERSION,
        operations: [replacement({ file })],
      }),
    ).toThrow("Journal file must be a canonical workspace-relative path");
  });

  it("rejects trailing-separator aliases before file ownership comparison", () => {
    expect(() =>
      validateFileIndexJournal({
        version: FILE_INDEX_JOURNAL_VERSION,
        operations: [
          replacement(),
          replacement({
            operationId: "operation-2",
            file: "src/example.ts/",
            oldPointIds: ["other-old"],
            intendedBatches: [{ batch: 0, pointIds: ["other-new"] }],
          }),
        ],
      }),
    ).toThrow("Journal file must be a canonical workspace-relative path");
  });

  it("rejects invalid remove and replace payloads", () => {
    expect(() =>
      validateFileIndexJournal({
        version: FILE_INDEX_JOURNAL_VERSION,
        operations: [
          {
            operationId: "remove-1",
            file: "src/removed.ts",
            kind: "remove",
            generation: "generation-2",
            targetHash: "unexpected",
            oldPointIds: [],
            intendedBatches: [],
          },
        ],
      }),
    ).toThrow("Removal journal operations cannot declare replacement data");

    expect(() =>
      validateFileIndexJournal({
        version: FILE_INDEX_JOURNAL_VERSION,
        operations: [replacement({ intendedBatches: [] })],
      }),
    ).toThrow("Replacement journal operations require intended point IDs");
  });
});
