import type {
  RetrievalActiveSource,
  RetrievalPublicationOutcome,
  RetrievalPublicationRequest,
} from "../core/retrieval/contracts.js";
import {
  emptyFileIndexJournal,
  loadFileIndexJournal,
  writeFileIndexJournal,
} from "./fileIndexJournal.js";

import type { CachedFileEntry } from "./types.js";
import type { StructuralFileEntry } from "./structuralGraph.js";

export interface FileReplacementStore {
  getVector(file: string): CachedFileEntry | undefined;
  getStructural(file: string): StructuralFileEntry | undefined;
  checkpointVector(file: string, entry: CachedFileEntry | null): void;
  checkpointStructural(file: string, entry: StructuralFileEntry | null): void;
  checkpointVectors?(
    entries: Array<[file: string, entry: CachedFileEntry | null]>,
  ): void;
  checkpointStructurals?(
    entries: Array<[file: string, entry: StructuralFileEntry | null]>,
  ): void;
}

export interface RepositoryPublicationPort {
  preparePublication(request: RetrievalPublicationRequest): Promise<unknown>;
  commitPublication(
    publicationId: string,
  ): Promise<RetrievalPublicationOutcome>;
  abortPublication(publicationId: string): Promise<unknown>;
  inspectSource(sourceId: string): Promise<RetrievalActiveSource | null>;
}

export interface PreparedRepositoryFilePublication {
  file: string;
  publication: RetrievalPublicationRequest;
  oldRecordIds: string[];
  cacheEntry: Omit<CachedFileEntry, "generation" | "visibility">;
  structuralEntry: StructuralFileEntry;
}

export interface JournaledRepositoryPublicationResult {
  committedFiles: number;
  recordsUpserted: number;
  recordsDeleted: number;
  cancelled: boolean;
  pending: boolean;
}

export async function executeJournaledRepositoryPublications(args: {
  journalPath: string;
  publications: PreparedRepositoryFilePublication[];
  store: FileReplacementStore;
  repository: RepositoryPublicationPort;
  isCancelled: () => boolean;
}): Promise<JournaledRepositoryPublicationResult> {
  const existing = loadFileIndexJournal(args.journalPath);
  if (existing.status === "corrupt") {
    throw new Error(`File index journal is corrupt: ${existing.error}`);
  }
  if (existing.journal.operations.length > 0) {
    throw new Error(
      "Cannot begin publication while journal operations are active",
    );
  }
  if (args.publications.length === 0) return emptyResult(args.isCancelled());

  writeFileIndexJournal(args.journalPath, {
    ...emptyFileIndexJournal(),
    operations: args.publications.map(
      ({ file, publication, oldRecordIds }) => ({
        operationId: publication.publicationId,
        file,
        kind: "replace" as const,
        generation: publication.generation,
        targetHash: publication.source.revision.id,
        oldRecordIds,
        intendedBatches: groupIds(publication.expectedChunkIds, 100),
      }),
    ),
  });

  for (const item of args.publications) {
    if (args.isCancelled()) return pendingResult();
    await args.repository.preparePublication(item.publication);
  }
  checkpointPending(args.store, args.publications);
  return recoverJournaledRepositoryPublications(args);
}

export async function recoverJournaledRepositoryPublications(args: {
  journalPath: string;
  store: FileReplacementStore;
  repository: RepositoryPublicationPort;
  isCancelled: () => boolean;
}): Promise<JournaledRepositoryPublicationResult> {
  const loaded = loadFileIndexJournal(args.journalPath);
  if (loaded.status === "corrupt") {
    throw new Error(`File index journal is corrupt: ${loaded.error}`);
  }
  const replacements = loaded.journal.operations.filter(
    (operation) => operation.kind === "replace",
  );
  if (replacements.length !== loaded.journal.operations.length) {
    throw new Error(
      "Mixed removal and replacement journal recovery is unsupported",
    );
  }

  let committedFiles = 0;
  let recordsUpserted = 0;
  let recordsDeleted = 0;
  const completed = new Set<string>();
  const currentVectors: Array<[string, CachedFileEntry]> = [];
  for (const operation of replacements) {
    const revisionId = operation.targetHash;
    if (!revisionId) {
      throw new Error("Replacement journal operation requires a target hash");
    }
    if (args.isCancelled()) {
      checkpointCompleted(
        args.journalPath,
        args.store,
        loaded.journal,
        completed,
        currentVectors,
      );
      return {
        committedFiles,
        recordsUpserted,
        recordsDeleted,
        cancelled: true,
        pending: true,
      };
    }
    const intendedIds = operation.intendedBatches.flatMap(
      (batch) => batch.recordIds,
    );
    const vector = args.store.getVector(operation.file);
    const structural = args.store.getStructural(operation.file);
    const checkpointed =
      vector?.generation === operation.generation &&
      vector.hash === revisionId &&
      sameIds(vector.recordIds, intendedIds) &&
      (vector.visibility === "pending" || vector.visibility === "current") &&
      structural?.generation === operation.generation &&
      structural.hash === revisionId &&
      structural.status === "current";
    const sourceId = checkpointed
      ? sourceIdFromStructural(structural)
      : undefined;
    let active = sourceId
      ? await args.repository.inspectSource(sourceId)
      : null;

    if (!checkpointed) {
      await args.repository.abortPublication(operation.operationId);
      if (structural?.generation === operation.generation) {
        args.store.checkpointStructural(operation.file, null);
      }
      completed.add(operation.operationId);
      continue;
    }

    let outcome: RetrievalPublicationOutcome | undefined;
    if (!matchesActive(active, operation.generation, revisionId)) {
      outcome = await args.repository.commitPublication(operation.operationId);
      if (outcome.status === "published") {
        active = sourceId
          ? await args.repository.inspectSource(sourceId)
          : null;
      }
    }
    if (
      outcome?.status === "published" ||
      matchesActive(active, operation.generation, revisionId)
    ) {
      currentVectors.push([
        operation.file,
        {
          ...vector,
          visibility: "current",
        },
      ]);
      committedFiles += 1;
      recordsUpserted += intendedIds.length;
      recordsDeleted += operation.oldRecordIds.length;
    } else {
      await args.repository.abortPublication(operation.operationId);
      checkpointCompleted(
        args.journalPath,
        args.store,
        loaded.journal,
        completed,
        currentVectors,
      );
      return {
        committedFiles,
        recordsUpserted,
        recordsDeleted,
        cancelled: false,
        pending: true,
      };
    }
    completed.add(operation.operationId);
  }

  checkpointCompleted(
    args.journalPath,
    args.store,
    loaded.journal,
    completed,
    currentVectors,
  );
  return {
    committedFiles,
    recordsUpserted,
    recordsDeleted,
    cancelled: args.isCancelled(),
    pending: false,
  };
}

function checkpointCompleted(
  journalPath: string,
  store: FileReplacementStore,
  journal: ReturnType<typeof emptyFileIndexJournal>,
  completed: Set<string>,
  currentVectors: Array<[string, CachedFileEntry]>,
): void {
  if (currentVectors.length > 0) {
    if (store.checkpointVectors) store.checkpointVectors(currentVectors);
    else {
      for (const [file, entry] of currentVectors) {
        store.checkpointVector(file, entry);
      }
    }
  }
  if (completed.size > 0) {
    writeFileIndexJournal(journalPath, {
      ...journal,
      operations: journal.operations.filter(
        (operation) => !completed.has(operation.operationId),
      ),
    });
  }
}

function checkpointPending(
  store: FileReplacementStore,
  publications: PreparedRepositoryFilePublication[],
): void {
  const vectors = publications.map(
    ({ file, publication, cacheEntry }): [string, CachedFileEntry] => [
      file,
      {
        ...cacheEntry,
        generation: publication.generation,
        visibility: "pending",
      },
    ],
  );
  const structurals = publications.map(
    ({ file, publication, structuralEntry }): [string, StructuralFileEntry] => [
      file,
      {
        ...structuralEntry,
        generation: publication.generation,
        status: "current",
      },
    ],
  );
  if (store.checkpointVectors) store.checkpointVectors(vectors);
  else for (const [file, entry] of vectors) store.checkpointVector(file, entry);
  if (store.checkpointStructurals) store.checkpointStructurals(structurals);
  else {
    for (const [file, entry] of structurals) {
      store.checkpointStructural(file, entry);
    }
  }
}

function sourceIdFromStructural(
  entry: StructuralFileEntry,
): string | undefined {
  return typeof entry.sourceId === "string" && entry.sourceId.length > 0
    ? entry.sourceId
    : undefined;
}

function matchesActive(
  active: RetrievalActiveSource | null,
  generation: string,
  revisionId: string,
): boolean {
  return (
    active?.generation === generation &&
    active.source.revision.id === revisionId
  );
}

function groupIds(values: string[], size: number) {
  const batches: Array<{ batch: number; recordIds: string[] }> = [];
  for (let index = 0; index < values.length; index += size) {
    batches.push({
      batch: batches.length,
      recordIds: values.slice(index, index + size),
    });
  }
  return batches;
}

function sameIds(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function emptyResult(cancelled: boolean): JournaledRepositoryPublicationResult {
  return {
    committedFiles: 0,
    recordsUpserted: 0,
    recordsDeleted: 0,
    cancelled,
    pending: false,
  };
}

function pendingResult(): JournaledRepositoryPublicationResult {
  return {
    committedFiles: 0,
    recordsUpserted: 0,
    recordsDeleted: 0,
    cancelled: true,
    pending: true,
  };
}
