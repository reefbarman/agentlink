import * as path from "node:path";

import { DerivedSessionRetrievalService } from "../../core/session/DerivedSessionRetrievalService.js";
import { LanceDbMemoryRepository } from "./LanceDbMemoryRepository.js";
import { LanceDbRetrievalRepository } from "./LanceDbRetrievalRepository.js";
import type { MemoryRepositoryMergeResult } from "./LanceDbMemoryRepository.js";
import { createHash } from "node:crypto";

export const SHARED_MEMORY_STORE_IMPORTER_SCHEMA_VERSION = 1;

export interface SharedMemoryStoreMigrationResult {
  sourceKey: string;
  sourceRevision: string;
  autonomousMemory: MemoryRepositoryMergeResult;
  derivedSessions: {
    status: "imported" | "already-complete";
    sessionCount: number;
  };
}

export async function migrateSharedMemoryStore(options: {
  legacyRoot: string;
  canonicalRoot: string;
  observedAt?: string;
}): Promise<SharedMemoryStoreMigrationResult> {
  const legacyRoot = path.resolve(options.legacyRoot);
  const canonicalRoot = path.resolve(options.canonicalRoot);
  const sourceKey = legacyStoreSourceKey(legacyRoot);
  if (legacyRoot === canonicalRoot) {
    return {
      sourceKey,
      sourceRevision: digest([]),
      autonomousMemory: emptyMergeResult(),
      derivedSessions: { status: "already-complete", sessionCount: 0 },
    };
  }

  const legacyMemory = new LanceDbMemoryRepository({ root: legacyRoot });
  const canonicalMemory = new LanceDbMemoryRepository({ root: canonicalRoot });
  const legacyRetrieval = new LanceDbRetrievalRepository({ root: legacyRoot });
  const canonicalRetrieval = new LanceDbRetrievalRepository({
    root: canonicalRoot,
  });
  try {
    const [memoryState, sessions] = await Promise.all([
      legacyMemory.exportState(),
      new DerivedSessionRetrievalService(legacyRetrieval).exportSessions(),
    ]);
    const sourceRevision = digest({ memoryState, sessions });
    const autonomousMemory = await canonicalMemory.mergeState(memoryState, {
      legacySourceKeyPrefix: sourceKey,
    });
    const derived = await new DerivedSessionRetrievalService(
      canonicalRetrieval,
    ).importSessions({
      sourceKey,
      sourceRevision,
      importerSchemaVersion: SHARED_MEMORY_STORE_IMPORTER_SCHEMA_VERSION,
      observedAt: options.observedAt ?? new Date().toISOString(),
      sessions,
    });
    return {
      sourceKey,
      sourceRevision,
      autonomousMemory,
      derivedSessions: {
        status: derived.status,
        sessionCount: sessions.length,
      },
    };
  } finally {
    await Promise.allSettled([
      legacyMemory.close(),
      canonicalMemory.close(),
      legacyRetrieval.close(),
      canonicalRetrieval.close(),
    ]);
  }
}

function legacyStoreSourceKey(legacyRoot: string): string {
  return `legacy-retrieval-store:${digest(legacyRoot).slice(0, 24)}`;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function emptyMergeResult(): MemoryRepositoryMergeResult {
  return {
    recordsAdded: 0,
    recordsUpdated: 0,
    revisionsAdded: 0,
    auditsAdded: 0,
    importCheckpointsAdded: 0,
    snapshotsAdded: 0,
  };
}
