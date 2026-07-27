import * as fs from "fs";
import * as path from "path";

import type { FileIndexJournalIntent } from "./fileIndexState.js";
import { requireCanonicalPortableCodeIndexPath } from "./codeIndexPaths.js";
import { writeAtomicJsonFile } from "./atomicJsonFile.js";

export const FILE_INDEX_JOURNAL_VERSION = 1;

export interface FileIndexJournal {
  version: typeof FILE_INDEX_JOURNAL_VERSION;
  operations: FileIndexJournalIntent[];
}

export type FileIndexJournalLoadResult =
  | { status: "missing"; journal: FileIndexJournal }
  | { status: "valid"; journal: FileIndexJournal }
  | { status: "corrupt"; error: string };

export function getFileIndexJournalPath(cachePath: string): string {
  const extension = path.extname(cachePath);
  if (!extension) return `${cachePath}.journal.json`;
  return path.join(
    path.dirname(cachePath),
    `${path.basename(cachePath, extension)}.journal${extension}`,
  );
}

export function emptyFileIndexJournal(): FileIndexJournal {
  return { version: FILE_INDEX_JOURNAL_VERSION, operations: [] };
}

export function loadFileIndexJournal(
  journalPath: string,
): FileIndexJournalLoadResult {
  let raw: string;
  try {
    raw = fs.readFileSync(journalPath, "utf8");
  } catch (error) {
    if (isMissingFile(error)) {
      const entryError = inspectMissingJournalEntry(journalPath);
      if (entryError === null) {
        return { status: "missing", journal: emptyFileIndexJournal() };
      }
      return { status: "corrupt", error: entryError };
    }
    return { status: "corrupt", error: describeError(error) };
  }

  try {
    const journal = validateFileIndexJournal(JSON.parse(raw));
    return { status: "valid", journal };
  } catch (error) {
    return { status: "corrupt", error: describeError(error) };
  }
}

export function writeFileIndexJournal(
  journalPath: string,
  journal: FileIndexJournal,
): void {
  const existing = loadFileIndexJournal(journalPath);
  if (existing.status === "corrupt") {
    throw new Error(
      `Refusing to replace corrupt file index journal: ${existing.error}`,
    );
  }
  writeAtomicJsonFile(
    journalPath,
    serializeFileIndexJournal(validateFileIndexJournal(journal)),
  );
}

/** Replace all prior ownership after the remote collection is confirmed absent. */
export function resetFileIndexJournal(journalPath: string): void {
  writeAtomicJsonFile(journalPath, emptyFileIndexJournal());
}

export function validateFileIndexJournal(value: unknown): FileIndexJournal {
  if (!isRecord(value) || value.version !== FILE_INDEX_JOURNAL_VERSION) {
    throw new Error("Unsupported file index journal version");
  }
  if (!Array.isArray(value.operations)) {
    throw new Error("File index journal operations must be an array");
  }

  const operations = value.operations.map(validateIntent);
  requireUnique(
    operations.map((operation) => operation.operationId),
    "Journal operation IDs must be unique",
  );
  requireUnique(
    operations.map((operation) => operation.file),
    "Journal files must be unique",
  );
  requireUnique(
    operations.flatMap((operation) => [
      ...operation.oldRecordIds,
      ...operation.intendedBatches.flatMap((batch) => batch.recordIds),
    ]),
    "Journal record IDs must have one owner",
  );

  return { version: FILE_INDEX_JOURNAL_VERSION, operations };
}

function validateIntent(value: unknown): FileIndexJournalIntent {
  if (!isRecord(value)) throw new Error("Invalid file index journal operation");

  const operationId = requireNonEmptyString(value.operationId, "operation ID");
  const file = requireCanonicalRelativePath(value.file);
  const generation = requireNonEmptyString(value.generation, "generation");
  const kind = value.kind;
  if (kind !== "remove" && kind !== "replace") {
    throw new Error("Invalid file index journal operation kind");
  }
  const oldRecordIds = resolveStringArrayAlias(
    value,
    "oldRecordIds",
    "oldPointIds",
    "old record IDs",
  );
  if (!Array.isArray(value.intendedBatches)) {
    throw new Error("Journal intended batches must be an array");
  }
  requireUnique(oldRecordIds, "Journal old record IDs must be unique");

  const intendedBatches = value.intendedBatches.map((batch) => {
    if (!isRecord(batch) || !Number.isSafeInteger(batch.batch)) {
      throw new Error("Invalid journal record batch");
    }
    return {
      batch: batch.batch as number,
      recordIds: resolveStringArrayAlias(
        batch,
        "recordIds",
        "pointIds",
        "batch record IDs",
      ),
    };
  });
  requireUnique(
    intendedBatches.map((batch) => batch.batch),
    "Journal batch numbers must be unique",
  );

  const intendedRecordIds = intendedBatches.flatMap((batch) => batch.recordIds);
  requireUnique(
    intendedRecordIds,
    "Journal intended record IDs must be unique",
  );
  if (intendedRecordIds.some((recordId) => oldRecordIds.includes(recordId))) {
    throw new Error("Journal intended record IDs cannot reuse old record IDs");
  }

  if (kind === "remove") {
    if (value.targetHash !== null || intendedBatches.length > 0) {
      throw new Error(
        "Removal journal operations cannot declare replacement data",
      );
    }
  } else {
    requireNonEmptyString(value.targetHash, "target hash");
    if (intendedBatches.length === 0 || intendedRecordIds.length === 0) {
      throw new Error(
        "Replacement journal operations require intended record IDs",
      );
    }
  }

  return {
    operationId,
    file,
    kind,
    generation,
    targetHash: kind === "replace" ? (value.targetHash as string) : null,
    oldRecordIds,
    intendedBatches,
  };
}

function serializeFileIndexJournal(journal: FileIndexJournal): unknown {
  return {
    version: journal.version,
    operations: journal.operations.map((operation) => ({
      ...operation,
      oldPointIds: [...operation.oldRecordIds],
      intendedBatches: operation.intendedBatches.map((batch) => ({
        ...batch,
        pointIds: [...batch.recordIds],
      })),
    })),
  };
}

function resolveStringArrayAlias(
  value: Record<string, unknown>,
  canonicalKey: string,
  legacyKey: string,
  label: string,
): string[] {
  const canonical = value[canonicalKey];
  const legacy = value[legacyKey];
  const normalize = (candidate: unknown): string[] | null =>
    Array.isArray(candidate)
      ? candidate.map((entry) => requireNonEmptyString(entry, label))
      : null;
  const canonicalValues =
    canonical === undefined ? undefined : normalize(canonical);
  const legacyValues = legacy === undefined ? undefined : normalize(legacy);
  if (
    (canonical !== undefined && !canonicalValues) ||
    (legacy !== undefined && !legacyValues) ||
    (canonicalValues === undefined && legacyValues === undefined)
  ) {
    throw new Error(`Journal ${label} must be an array`);
  }
  if (
    canonicalValues &&
    legacyValues &&
    (canonicalValues.length !== legacyValues.length ||
      canonicalValues.some((entry, index) => entry !== legacyValues[index]))
  ) {
    throw new Error(`Journal ${label} aliases conflict`);
  }
  return [...(canonicalValues ?? legacyValues ?? [])];
}

function requireCanonicalRelativePath(value: unknown): string {
  const file = requireNonEmptyString(value, "file");
  try {
    return requireCanonicalPortableCodeIndexPath(file);
  } catch {
    throw new Error("Journal file must be a canonical workspace-relative path");
  }
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Journal ${label} must be a non-empty string`);
  }
  return value;
}

function requireUnique(values: Array<string | number>, message: string): void {
  if (new Set(values).size !== values.length) throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function inspectMissingJournalEntry(journalPath: string): string | null {
  try {
    fs.lstatSync(journalPath);
    return "Journal path exists but could not be read";
  } catch (error) {
    return isMissingFile(error) ? null : describeError(error);
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
