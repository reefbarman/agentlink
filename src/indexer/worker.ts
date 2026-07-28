/**
 * Indexer worker — runs as a child process via child_process.fork().
 *
 * Handles file reading, hashing, chunking, embedding (OpenAI), and durable
 * retrieval publication. Communicates with the extension host via IPC.
 *
 * Memory-efficient: processes files in batches of FILE_BATCH_SIZE through
 * the full pipeline (read → chunk → embed → upsert → release), bounding
 * peak memory to O(batch_size) instead of O(total_files).
 *
 * IMPORTANT: This file MUST NOT import "vscode".
 */

import * as os from "os";
import * as path from "path";
import { randomUUID } from "crypto";

// Lower worker process priority so indexing doesn't starve the UI / other processes.
// 19 = lowest priority on Linux/macOS (POSIX nice), 19 = IDLE on Windows.
try {
  os.setPriority(19);
} catch {
  // Non-fatal — some environments don't allow priority changes
}
import {
  initTreeSitter,
  treeSitterChunkFileDetailed,
  isTreeSitterSupported,
  setChunkGranularity as setTreeSitterGranularity,
  type TreeSitterSymbolHint,
} from "./treeSitterChunker.js";
import {
  chunkFile,
  setChunkGranularity as setChunkerGranularity,
} from "./chunker.js";
import {
  isMarkdownFile,
  markdownChunkFile,
  setChunkGranularity as setMarkdownGranularity,
} from "./markdownChunker.js";
import {
  emptyStructuralCache,
  getStructuralCachePath,
  loadIndexCache,
  loadStructuralCache,
  writeCache as writeCacheFile,
  writeStructuralCache as writeStructuralCacheFile,
  scanFiles,
  readFilesBatch,
  type FileWithContent,
} from "./workerLib.js";
import { CacheCheckpointCoordinator } from "./CacheCheckpointCoordinator.js";
import { runBoundedReadAheadPipeline } from "./boundedReadAheadPipeline.js";
import {
  getFileIndexJournalPath,
  loadFileIndexJournal,
  resetFileIndexJournal,
  type FileIndexJournal,
} from "./fileIndexJournal.js";
import {
  executeJournaledRepositoryDeletions,
  type RepositorySourceDeletion,
} from "./journaledRepositoryDeletion.js";
import type { FileReplacementStore } from "./journaledRepositoryPublication.js";
import {
  executeJournaledStagedRepositoryPublications,
  recoverJournaledStagedRepositoryPublications,
  type StagedRepositoryPublicationPort,
} from "./journaledStagedRepositoryPublication.js";
import {
  extractStructuralFile,
  shouldUseTreeSitterSymbolHints,
  STRUCTURAL_EXTRACTOR_VERSION,
} from "./structuralExtractor.js";
import {
  beginIndexReset,
  completeIndexReset,
  getIndexResetStatePath,
  loadIndexResetState,
  type IndexResetTarget,
} from "./collectionResetState.js";
import type { StructuralGraphCache } from "./structuralGraph.js";
import type {
  ExtensionToWorkerMessage,
  StartIndexMessage,
  IncrementalUpdateMessage,
  IndexStats,
  IndexCache,
  Chunk,
  ChunkGranularity,
} from "./types.js";
import type { RetrievalRepository } from "../core/retrieval/contracts.js";
import { classifyRetrievalFingerprint } from "../core/retrieval/fingerprint.js";
import { LanceDbRetrievalRepository } from "../storage/retrieval/LanceDbRetrievalRepository.js";
import { LanceDbCodeIndexStagingRepository } from "../storage/retrieval/LanceDbCodeIndexStagingRepository.js";
import { LanceDbCodeIndexActivator } from "../storage/retrieval/LanceDbCodeIndexActivator.js";
import {
  acquireCodeIndexWriterLease,
  releaseCodeIndexWriterLease,
  renewCodeIndexWriterLease,
  type CodeIndexWriterLease,
  withCodeIndexWriterFence,
} from "./codeIndexWriterLease.js";
import { EMBEDDING_DIM } from "./embeddingConfig.js";
import { requestEmbeddings } from "./embeddingClient.js";
import {
  CODE_INDEX_REBUILD_REQUIRED_ERROR,
  createCodeIndexFingerprint,
  MAX_CODE_INDEX_EMBEDDING_CHARS,
} from "./retrievalFingerprint.js";
import { prepareCodeFilePublication } from "./retrievalPublicationTranslation.js";
import { resolveContainedCodeIndexPath } from "./codeIndexPaths.js";
import {
  getCodeSourceId,
  getCodeWorkspaceScopeId,
} from "./codeRetrievalIdentity.js";
import { sleep } from "../util/sleep.js";
import { estimateTokensFromChars } from "../util/tokenEstimation.js";
import {
  createIndexWorkerMetrics,
  measureIndexWorkerPhase,
  serializedByteLength,
} from "./workerMetrics.js";

// --- Constants ---

const EMBEDDING_BATCH_SIZE = 100;
const EMBEDDING_CONCURRENCY = 3;
const MAX_RETRIES = 3;
/**
 * Token limit per embedding batch. Estimated via chars/4.
 * text-embedding-3-small supports up to 8191 tokens per input, and the API
 * accepts large batches. Roo-Code uses 100K; we use 50K as a safe middle ground
 * that drastically reduces the number of API calls vs our old 7.5K limit.
 */
const MAX_BATCH_TOKENS = 50_000;

/**
 * Number of files to process through the full pipeline (chunk → embed → upsert)
 * per batch. Each file may be 1MB and publication temporarily holds source text,
 * chunks, embeddings, JSON, and Arrow buffers, so keep this deliberately small.
 */
const FILE_BATCH_SIZE = 5;
const TREE_SITTER_STARTUP_TIMEOUT_MS = 15_000;
const STARTUP_HEARTBEAT_INTERVAL_MS = 5_000;

// --- State ---

let aborted = false;
let metrics = createIndexWorkerMetrics();
const pendingEmbeddingAuthRefreshRequests = new Map<
  string,
  {
    resolve: (token: string) => void;
    reject: (error: Error) => void;
  }
>();

function writeCache(cachePath: string, cache: IndexCache): void {
  const persistedBytes = writeCacheFile(cachePath, cache);
  metrics.recordOperation("cache.writeRetrieval", persistedBytes);
}

function writeStructuralCache(
  cachePath: string,
  cache: StructuralGraphCache,
): void {
  writeStructuralCacheFile(cachePath, cache);
  metrics.recordOperation("cache.writeStructural", serializedByteLength(cache));
}

function createCacheCheckpointCoordinator(args: {
  cachePath: string;
  structuralCachePath: string;
  cache: IndexCache;
  structuralCache: StructuralGraphCache;
}): CacheCheckpointCoordinator {
  return new CacheCheckpointCoordinator({
    writeVector: () => writeCache(args.cachePath, args.cache),
    writeStructural: () =>
      writeStructuralCache(args.structuralCachePath, args.structuralCache),
    schedule: (run) => {
      const timeout = setTimeout(run, 25);
      timeout.unref();
      return () => clearTimeout(timeout);
    },
  });
}

function scheduleCacheMetadataCheckpoint(args: {
  cache: IndexCache;
  granularity: ChunkGranularity;
  checkpoints: CacheCheckpointCoordinator;
}): void {
  const fingerprint = createCodeIndexFingerprint(args.granularity);
  const fingerprintChanged =
    classifyRetrievalFingerprint(
      args.cache.fingerprint ?? null,
      fingerprint,
    ) !== "compatible";
  if (args.cache.granularity === args.granularity && !fingerprintChanged)
    return;
  args.cache.granularity = args.granularity;
  args.cache.fingerprint = fingerprint;
  args.checkpoints.scheduleVector();
}

function createRetrievalRepository(
  root: string,
  lease: CodeIndexWriterLease,
): LanceDbRetrievalRepository {
  return new LanceDbRetrievalRepository({
    root,
    embeddingDimensions: EMBEDDING_DIM,
    deferNativeIndexRefresh: true,
    codeIndexWriterLease: lease,
  });
}

function createStagedPublicationPort(
  lease: CodeIndexWriterLease,
): StagedRepositoryPublicationPort {
  const staging = new LanceDbCodeIndexStagingRepository(lease, EMBEDDING_DIM);
  const activator = new LanceDbCodeIndexActivator(lease, EMBEDDING_DIM);
  return {
    fenceToken: lease.fenceToken,
    runFenced: (operation) => withCodeIndexWriterFence(lease, operation),
    beginStagedPublication: (manifest) =>
      staging.beginStagedPublication(manifest),
    appendStagedChunkBatch: (batch) => staging.appendStagedChunkBatch(batch),
    appendStagedRelationBatch: (batch) =>
      staging.appendStagedRelationBatch(batch),
    completeStagedPublication: (publicationId) =>
      staging.completeStagedPublication(publicationId),
    adoptStagedPublication: (publicationId) =>
      staging.adoptStagedPublication(publicationId),
    inspectStagedPublication: (publicationId) =>
      staging.inspectStagedPublication(publicationId),
    abortStagedPublication: (publicationId) =>
      staging.abortStagedPublication(publicationId),
    activate: (publicationId) => activator.activate(publicationId),
    finalizeActivation: (publicationId) =>
      activator.finalizeActivation(publicationId),
  };
}

async function acquireWorkerWriterLease(args: {
  storeRoot: string;
  workspaceScopeId: string;
}): Promise<{
  lease: CodeIndexWriterLease;
  port: StagedRepositoryPublicationPort;
  stopHeartbeat(): void;
}> {
  const lease = await acquireCodeIndexWriterLease({
    storeRoot: args.storeRoot,
    workspaceScopeId: args.workspaceScopeId,
    ownerId: `worker:${process.pid}:${randomUUID()}`,
    protocolVersion: "v4",
  });
  const heartbeat = setInterval(() => {
    void renewCodeIndexWriterLease(lease).catch((error) => {
      console.error(`Code index writer lease renewal failed: ${error}`);
    });
  }, 5_000);
  heartbeat.unref();
  return {
    lease,
    port: createStagedPublicationPort(lease),
    stopHeartbeat: () => clearInterval(heartbeat),
  };
}

async function releaseWorkerWriterLease(
  writer: Awaited<ReturnType<typeof acquireWorkerWriterLease>> | undefined,
): Promise<void> {
  if (!writer) return;
  writer.stopHeartbeat();
  try {
    await releaseCodeIndexWriterLease(writer.lease);
  } catch (error) {
    console.error(`Failed to release code index writer lease: ${error}`);
  }
}

// --- IPC helpers ---

function send(msg: unknown): void {
  if (process.send) process.send(msg);
}

function sendProgress(
  phase: string,
  current: number,
  total: number,
  detail?: string,
): void {
  send({ type: "progress", phase, current, total, detail });
}

function sampleHeapUsed(): void {
  metrics.sampleHeapUsed(process.memoryUsage().heapUsed);
}

function sendStartupProgress(total: number, detail: string): void {
  const { heapUsed, rss } = process.memoryUsage();
  const mib = 1024 * 1024;
  sendProgress(
    "reading",
    0,
    total,
    `${detail} (heap=${Math.round(heapUsed / mib)}MiB rss=${Math.round(rss / mib)}MiB)`,
  );
}

function completeMessage(stats: IndexStats, jobMetrics = metrics): unknown {
  jobMetrics.sampleHeapUsed(process.memoryUsage().heapUsed);
  return {
    type: "complete",
    stats: { ...stats, metrics: jobMetrics.snapshot() },
  };
}

function sendComplete(stats: IndexStats, jobMetrics = metrics): void {
  send(completeMessage(stats, jobMetrics));
}

function deferComplete(
  stats: IndexStats,
  jobMetrics: ReturnType<typeof createIndexWorkerMetrics>,
): () => void {
  const message = completeMessage(stats, jobMetrics);
  return () => send(message);
}

function errorMessage(message: string, fatal: boolean): unknown {
  return { type: "error", message, fatal };
}

function sendError(message: string, fatal: boolean): void {
  send(errorMessage(message, fatal));
}

async function refreshRetrievalIndexes(
  repository: LanceDbRetrievalRepository,
  current: number,
  total: number,
): Promise<void> {
  const report = () =>
    sendProgress("cleanup", current, total, "refreshing retrieval indexes");
  report();
  const heartbeat = setInterval(report, 30_000);
  heartbeat.unref();
  try {
    await repository.refreshNativeIndexes();
  } finally {
    clearInterval(heartbeat);
  }
}

async function closeRetrievalRepository(
  repository: LanceDbRetrievalRepository | undefined,
): Promise<void> {
  try {
    await repository?.close();
  } catch (error) {
    console.error(`Failed to close retrieval repository: ${error}`);
  }
}

async function requestEmbeddingAuthRefresh(): Promise<string> {
  const requestId = randomUUID();
  return new Promise<string>((resolve, reject) => {
    pendingEmbeddingAuthRefreshRequests.set(requestId, { resolve, reject });
    send({ type: "embeddingAuthRefreshRequest", requestId });
    const timeout = setTimeout(() => {
      pendingEmbeddingAuthRefreshRequests.delete(requestId);
      reject(new Error("Timed out waiting for refreshed embedding auth token"));
    }, 30_000);
    const originalResolve = resolve;
    const originalReject = reject;
    pendingEmbeddingAuthRefreshRequests.set(requestId, {
      resolve: (token: string) => {
        clearTimeout(timeout);
        originalResolve(token);
      },
      reject: (error: Error) => {
        clearTimeout(timeout);
        originalReject(error);
      },
    });
  });
}

/** Count total chunks (points) across all cached files */
function countCachedChunks(cache: IndexCache): number {
  let total = 0;
  for (const entry of Object.values(cache.files)) {
    total += entry.recordIds.length;
  }
  return total;
}

function loadWorkerOwnership(
  cachePath: string,
  allowCorruptReset: boolean,
): {
  cache: IndexCache;
  interruptedResetTarget: IndexResetTarget | null;
} {
  const loadedCache = loadIndexCache(cachePath);
  const loadedJournal = loadFileIndexJournal(
    getFileIndexJournalPath(cachePath),
  );
  const loadedReset = loadIndexResetState(getIndexResetStatePath(cachePath));
  if (loadedReset.status === "corrupt") {
    throw new Error(`Index reset state is corrupt: ${loadedReset.error}`);
  }
  if (
    loadedReset.status === "valid" &&
    loadedReset.state.status === "in-progress"
  ) {
    if (allowCorruptReset) {
      return {
        cache: { version: 1, files: {} },
        interruptedResetTarget: loadedReset.state.target,
      };
    }
    throw new Error(
      "Index reset state requires a forced re-index: An index reset did not complete",
    );
  }
  if (loadedCache.status === "corrupt") {
    if (allowCorruptReset) {
      return {
        cache: { version: 1, files: {} },
        interruptedResetTarget: null,
      };
    }
    throw new Error(
      `Vector cache is corrupt; run a forced re-index to rebuild ownership: ${loadedCache.error}`,
    );
  }
  if (loadedJournal.status === "corrupt") {
    if (allowCorruptReset) {
      return {
        cache: { version: 1, files: {} },
        interruptedResetTarget: null,
      };
    }
    throw new Error(
      `File index journal is corrupt; run a forced re-index to rebuild ownership: ${loadedJournal.error}`,
    );
  }
  try {
    validateJournalCacheOwnership(loadedCache.cache, loadedJournal.journal);
  } catch (error) {
    if (allowCorruptReset) {
      return {
        cache: { version: 1, files: {} },
        interruptedResetTarget: null,
      };
    }
    throw error;
  }
  return { cache: loadedCache.cache, interruptedResetTarget: null };
}

function validateJournalCacheOwnership(
  cache: IndexCache,
  journal: FileIndexJournal,
): void {
  const owners = new Map<string, string>();
  for (const [file, entry] of Object.entries(cache.files)) {
    for (const recordId of entry.recordIds)
      owners.set(recordId, toJournalPath(file));
  }
  for (const operation of journal.operations) {
    const intendedRecordIds = operation.intendedBatches.flatMap(
      (batch) => batch.recordIds,
    );
    const recordIds = [...operation.oldRecordIds, ...intendedRecordIds];
    const conflictingRecordId = recordIds.find((recordId) => {
      const owner = owners.get(recordId);
      return owner !== undefined && owner !== operation.file;
    });
    if (conflictingRecordId) {
      throw new Error(
        `File index journal record ${conflictingRecordId} conflicts with vector cache ownership`,
      );
    }

    const entry = cache.files[fromJournalPath(operation.file)];
    if (!entry) continue;
    const exactOldOwnership = sameRecordIds(
      entry.recordIds,
      operation.oldRecordIds,
    );
    const exactIntendedOwnership =
      operation.kind === "replace" &&
      entry.generation === operation.generation &&
      entry.hash === operation.targetHash &&
      sameRecordIds(entry.recordIds, intendedRecordIds) &&
      (entry.visibility === "pending" || entry.visibility === "current");
    if (!exactOldOwnership && !exactIntendedOwnership) {
      throw new Error(
        `File index journal ownership for ${operation.file} does not match a recoverable vector cache state`,
      );
    }
  }
}

function sameRecordIds(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((recordId) => right.includes(recordId))
  );
}

function loadWorkerStructuralCache(args: {
  cachePath: string;
  workspaceRoot: string;
  indexName: string;
}): { path: string; cache: StructuralGraphCache } {
  const structuralCachePath = getStructuralCachePath(args.cachePath);
  const cache = loadStructuralCache(structuralCachePath, args.workspaceRoot);
  cache.workspaceRoot = args.workspaceRoot;
  cache.indexName = args.indexName;
  return { path: structuralCachePath, cache };
}

function resetStructuralCache(
  structuralCache: StructuralGraphCache,
  workspaceRoot: string,
  indexName: string,
): void {
  const fresh = emptyStructuralCache(workspaceRoot, indexName);
  structuralCache.version = fresh.version;
  structuralCache.workspaceRoot = fresh.workspaceRoot;
  structuralCache.indexName = fresh.indexName;
  structuralCache.generatedAt = fresh.generatedAt;
  structuralCache.files = fresh.files;
}

async function resetIndexOwnership(args: {
  cachePath: string;
  cache: IndexCache;
  structuralCache: StructuralGraphCache;
  workspaceRoot: string;
  indexName: string;
  retrievalStoreRoot: string;
  workspaceScopeId: string;
  repository: Pick<LanceDbRetrievalRepository, "deleteSourceIdPrefix">;
  granularity: ChunkGranularity;
  fingerprint: IndexCache["fingerprint"];
  interruptedTarget: IndexResetTarget | null;
  checkpoints: CacheCheckpointCoordinator;
  runFenced<T>(operation: () => Promise<T>): Promise<T>;
}): Promise<void> {
  const resetStatePath = getIndexResetStatePath(args.cachePath);
  const currentTarget: IndexResetTarget = {
    storeRoot: path.resolve(args.retrievalStoreRoot),
    workspaceScopeId: args.workspaceScopeId,
  };
  if (
    args.interruptedTarget &&
    (path.resolve(args.interruptedTarget.storeRoot) !==
      currentTarget.storeRoot ||
      args.interruptedTarget.workspaceScopeId !==
        currentTarget.workspaceScopeId)
  ) {
    throw new Error(
      "Index reset state targets a different retrieval store or workspace scope",
    );
  }
  await args.runFenced(async () => {
    beginIndexReset(resetStatePath, currentTarget);
  });
  metrics.recordOperation("retrieval.deleteIndex");
  await args.repository.deleteSourceIdPrefix(`code:${args.workspaceScopeId}:`);
  await args.runFenced(async () => {
    resetFileIndexJournal(getFileIndexJournalPath(args.cachePath));
    args.cache.version = 1;
    args.cache.files = {};
    args.cache.granularity = args.granularity;
    args.cache.fingerprint = args.fingerprint;
    resetStructuralCache(
      args.structuralCache,
      args.workspaceRoot,
      args.indexName,
    );
    args.checkpoints.checkpointBoth(["vector", "structural"]);
    completeIndexReset(resetStatePath, currentTarget);
  });
}

async function updateStructuralCacheForFiles(
  structuralCache: StructuralGraphCache,
  files: FileWithContent[],
  workspaceRoot: string,
  useTreeSitter: boolean,
): Promise<number> {
  const indexedAt = new Date().toISOString();
  let updated = 0;
  for (const file of files) {
    if (aborted) break;
    const existing = structuralCache.files[file.relPath];
    if (
      existing?.hash === file.hash &&
      existing.extractorVersion === STRUCTURAL_EXTRACTOR_VERSION
    ) {
      continue;
    }
    const symbolHints =
      useTreeSitter &&
      isTreeSitterSupported(file.absPath) &&
      shouldUseTreeSitterSymbolHints(file.absPath)
        ? (
            await treeSitterChunkFileDetailed(
              file.content,
              file.absPath,
              file.relPath,
            )
          ).symbols
        : [];
    structuralCache.files[file.relPath] = {
      ...extractStructuralFile({
        content: file.content,
        absPath: file.absPath,
        relPath: file.relPath,
        workspaceRoot,
        hash: file.hash,
        indexedAt,
        mtimeMs: file.mtimeMs,
        size: file.size,
        symbolHints,
      }),
      ...(existing?.hash === file.hash && existing.generation
        ? { generation: existing.generation }
        : {}),
      ...(existing?.hash === file.hash && existing.status
        ? { status: existing.status }
        : {}),
    };
    updated++;
  }
  if (updated > 0) {
    structuralCache.generatedAt = new Date().toISOString();
  }
  return updated;
}

async function removeFilesFromIndex(args: {
  relPaths: string[];
  cachePath: string;
  cache: IndexCache;
  structuralCache: StructuralGraphCache;
  workspaceScopeId: string;
  repository: Pick<RetrievalRepository, "deleteSource">;
  checkpoints: CacheCheckpointCoordinator;
  runFenced<T>(operation: () => Promise<T>): Promise<T>;
}): Promise<{
  completed: number;
  errors: string[];
  recordsDeleted: number;
  cancelled: boolean;
  pending: boolean;
}> {
  const resolveSource = (file: string): RepositorySourceDeletion => {
    const relPath = fromJournalPath(file);
    const cached = args.cache.files[relPath];
    return {
      sourceId: getCodeSourceId(args.workspaceScopeId, file),
      ...(cached?.hash ? { expectedRevisionId: cached.hash } : {}),
    };
  };
  const result = await executeJournaledRepositoryDeletions({
    journalPath: getFileIndexJournalPath(args.cachePath),
    requestedFiles: args.relPaths.map((relPath) => {
      const cached = args.cache.files[relPath];
      return {
        file: toJournalPath(relPath),
        oldRecordIds: cached?.recordIds ?? [],
        generation: cached?.generation ?? randomUUID(),
      };
    }),
    repository: args.repository,
    resolveSource,
    checkpointCompleted: (journalPaths) => {
      for (const journalPath of journalPaths) {
        const relPath = fromJournalPath(journalPath);
        delete args.cache.files[relPath];
        delete args.structuralCache.files[relPath];
      }
      args.structuralCache.generatedAt = new Date().toISOString();
      args.checkpoints.checkpointBoth(["structural", "vector"]);
    },
    runFenced: args.runFenced,
    isCancelled: () => aborted,
    createId: randomUUID,
  });

  return {
    completed: result.completedFiles.length,
    errors: result.failure ? [result.failure] : [],
    recordsDeleted: result.recordsDeleted,
    cancelled: result.cancelled,
    pending: result.pending,
  };
}

function toJournalPath(relPath: string): string {
  return relPath.split(path.sep).join(path.posix.sep);
}

function fromJournalPath(journalPath: string): string {
  return journalPath.split(path.posix.sep).join(path.sep);
}

function createFileReplacementStore(args: {
  cache: IndexCache;
  structuralCache: StructuralGraphCache;
  checkpoints: CacheCheckpointCoordinator;
}): FileReplacementStore {
  return {
    getVector(file) {
      return args.cache.files[fromJournalPath(file)];
    },
    getStructural(file) {
      return args.structuralCache.files[fromJournalPath(file)];
    },
    checkpointVector(file, entry) {
      const relPath = fromJournalPath(file);
      if (entry) args.cache.files[relPath] = entry;
      else delete args.cache.files[relPath];
      args.checkpoints.checkpointVector();
    },
    checkpointStructural(file, entry) {
      const relPath = fromJournalPath(file);
      if (entry) args.structuralCache.files[relPath] = entry;
      else delete args.structuralCache.files[relPath];
      args.structuralCache.generatedAt = new Date().toISOString();
      args.checkpoints.checkpointStructural();
    },
    checkpointVectors(entries) {
      for (const [file, entry] of entries) {
        const relPath = fromJournalPath(file);
        if (entry) args.cache.files[relPath] = entry;
        else delete args.cache.files[relPath];
      }
      args.checkpoints.checkpointVector();
    },
    checkpointStructurals(entries) {
      for (const [file, entry] of entries) {
        const relPath = fromJournalPath(file);
        if (entry) args.structuralCache.files[relPath] = entry;
        else delete args.structuralCache.files[relPath];
      }
      args.structuralCache.generatedAt = new Date().toISOString();
      args.checkpoints.checkpointStructural();
    },
  };
}

async function recoverChangedFileReplacements(args: {
  cachePath: string;
  cache: IndexCache;
  structuralCache: StructuralGraphCache;
  stagedPublicationPort: StagedRepositoryPublicationPort;
  checkpoints: CacheCheckpointCoordinator;
}): Promise<{
  cancelled: boolean;
  pending: boolean;
  recordsDeleted: number;
  refreshRequired: boolean;
}> {
  const journalPath = getFileIndexJournalPath(args.cachePath);
  const loaded = loadFileIndexJournal(journalPath);
  if (loaded.status === "corrupt") {
    throw new Error(`File index journal is corrupt: ${loaded.error}`);
  }
  if (
    !loaded.journal.operations.some((operation) => operation.kind === "replace")
  ) {
    return {
      cancelled: false,
      pending: false,
      recordsDeleted: 0,
      refreshRequired: false,
    };
  }
  const recovered = await recoverJournaledStagedRepositoryPublications({
    journalPath,
    store: createFileReplacementStore(args),
    port: args.stagedPublicationPort,
    isCancelled: () => aborted,
  });
  return {
    cancelled: recovered.cancelled,
    pending: recovered.pending,
    recordsDeleted: recovered.recordsDeleted,
    refreshRequired:
      recovered.committedFiles > 0 || recovered.recordsDeleted > 0,
  };
}

async function backfillStructuralCacheForCachedFiles(args: {
  files: string[];
  workspaceRoot: string;
  cache: IndexCache;
  structuralCache: StructuralGraphCache;
  errors: string[];
  useTreeSitter: boolean;
}): Promise<number> {
  const missingStructuralPaths: Array<{ absPath: string; relPath: string }> =
    [];

  for (const candidatePath of args.files) {
    const identity = resolveContainedCodeIndexPath(
      args.workspaceRoot,
      candidatePath,
    );
    if (!identity) continue;
    const { absolutePath: absPath, relativePath: relPath } = identity;

    const cached = args.cache.files[relPath];
    if (!cached) continue;

    const structuralEntry = args.structuralCache.files[relPath];
    if (
      structuralEntry?.hash === cached.hash &&
      structuralEntry.extractorVersion === STRUCTURAL_EXTRACTOR_VERSION
    ) {
      continue;
    }

    missingStructuralPaths.push({ absPath, relPath });
  }

  let updated = 0;
  for (let i = 0; i < missingStructuralPaths.length; i += FILE_BATCH_SIZE) {
    const readErrors: string[] = [];
    const files = await readFilesBatch(
      missingStructuralPaths.slice(i, i + FILE_BATCH_SIZE),
      readErrors,
      {
        workspaceRoot: args.workspaceRoot,
        metrics,
        isCancelled: () => aborted,
      },
    );
    args.errors.push(...readErrors);

    const retainedBytes = files.reduce(
      (total, file) => total + file.contentBytes,
      0,
    );
    try {
      if (aborted) return updated;
      updated += await updateStructuralCacheForFiles(
        args.structuralCache,
        files.filter(
          (file) => args.cache.files[file.relPath]?.hash === file.hash,
        ),
        args.workspaceRoot,
        args.useTreeSitter,
      );
    } finally {
      metrics.contentReleased(retainedBytes);
    }
  }

  return updated;
}

// --- Entry point ---

process.on("message", (msg: ExtensionToWorkerMessage) => {
  switch (msg.type) {
    case "start":
      aborted = false;
      metrics = createIndexWorkerMetrics();
      sampleHeapUsed();
      handleStart(msg).catch((err) => {
        sendError(String(err), false);
      });
      break;
    case "cancel":
      aborted = true;
      break;
    case "embeddingAuthRefreshResponse": {
      const pending = pendingEmbeddingAuthRefreshRequests.get(msg.requestId);
      if (!pending) break;
      pendingEmbeddingAuthRefreshRequests.delete(msg.requestId);
      if (msg.bearerToken) {
        pending.resolve(msg.bearerToken);
      } else {
        pending.reject(
          new Error("Extension returned no refreshed embedding auth token"),
        );
      }
      break;
    }
    case "incrementalUpdate":
      aborted = false;
      metrics = createIndexWorkerMetrics();
      sampleHeapUsed();
      handleIncrementalUpdate(msg).catch((err) => {
        sendError(String(err), false);
      });
      break;
  }
});

send({ type: "ready" });

// Initialize tree-sitter WASM on the first job so the startup phase is visible
// before invoking WASM, but do not let optional syntax-aware chunking block the
// lexical indexing fallback indefinitely.
const wasmDir = path.join(__dirname, "wasm");
let treeSitterReady: Promise<void> | undefined;
let treeSitterInitializationSettled = false;
let treeSitterInitializationSucceeded = false;
let treeSitterStartupAbandoned = false;
let treeSitterRecoveryRequiresRebuild = false;

function startTreeSitterInitialization(): Promise<void> {
  treeSitterReady ??= initTreeSitter(wasmDir)
    .then(() => {
      treeSitterInitializationSucceeded = true;
    })
    .catch((error) => {
      sendError(
        `Tree-sitter init failed; using lexical chunking: ${error}`,
        false,
      );
    })
    .finally(() => {
      treeSitterInitializationSettled = true;
      if (treeSitterStartupAbandoned && treeSitterInitializationSucceeded) {
        treeSitterRecoveryRequiresRebuild = true;
      }
      treeSitterStartupAbandoned = false;
    });
  return treeSitterReady;
}

async function awaitTreeSitterStartup(total: number): Promise<boolean> {
  const report = () =>
    sendProgress("reading", 0, total, "initializing syntax parser");
  report();
  if (treeSitterStartupAbandoned) return false;
  const initialization = startTreeSitterInitialization();
  if (treeSitterInitializationSettled) {
    await initialization;
    return treeSitterInitializationSucceeded;
  }

  const heartbeat = setInterval(report, STARTUP_HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();
  let timeout: NodeJS.Timeout | undefined;
  try {
    const initialized = await Promise.race([
      initialization.then(() => true),
      new Promise<false>((resolve) => {
        timeout = setTimeout(
          () => resolve(false),
          TREE_SITTER_STARTUP_TIMEOUT_MS,
        );
        timeout.unref();
      }),
    ]);
    if (!initialized) {
      if (!treeSitterInitializationSettled) treeSitterStartupAbandoned = true;
      sendError(
        `Tree-sitter initialization exceeded ${TREE_SITTER_STARTUP_TIMEOUT_MS}ms; using lexical chunking`,
        false,
      );
    }
    return initialized && treeSitterInitializationSucceeded;
  } finally {
    clearInterval(heartbeat);
    if (timeout) clearTimeout(timeout);
  }
}

// --- File batch pipeline ---

interface BatchConfig {
  repository: RetrievalRepository;
  stagedPublicationPort: StagedRepositoryPublicationPort;
  writerFenceToken: string;
  embeddingBearerToken: string | undefined;
  cachePath: string;
  workspaceRoot: string;
  granularity: ChunkGranularity;
  checkpoints: CacheCheckpointCoordinator;
  useTreeSitter: boolean;
}

interface BatchResult {
  filesIndexed: number;
  chunksCreated: number;
  recordsUpserted: number;
  recordsDeleted: number;
  errors: string[];
  pendingOwnership: boolean;
}

/**
 * Process a batch of files through the full pipeline: chunk → embed → upsert.
 * All intermediate data (chunks, embeddings, points) is scoped to this function
 * and released when it returns, bounding peak memory to O(batch_size).
 */
async function processFileBatch(
  files: FileWithContent[],
  config: BatchConfig,
  cache: IndexCache,
  structuralCache: StructuralGraphCache,
): Promise<BatchResult> {
  const errors: string[] = [];
  let filesIndexed = 0;
  let chunksCreated = 0;
  let recordsUpserted = 0;
  let recordsDeleted = 0;
  const priorEntries = files.map((file) => cache.files[file.relPath]);

  // 1. Chunk all files in this batch (yield every ~15ms to avoid CPU saturation)
  const allChunks: Array<{ chunk: Chunk; fileIdx: number }> = [];
  const structuralSymbolHints = new Map<number, TreeSitterSymbolHint[]>();
  let lastYield = Date.now();
  for (let i = 0; i < files.length; i++) {
    if (aborted) break;
    const now = Date.now();
    if (now - lastYield >= 15) {
      await sleep(1);
      lastYield = Date.now();
    }
    const file = files[i];

    let chunks: Chunk[];
    if (isMarkdownFile(file.absPath)) {
      chunks = markdownChunkFile(file.content, file.absPath, file.relPath);
    } else if (config.useTreeSitter && isTreeSitterSupported(file.absPath)) {
      const treeSitterResult = await treeSitterChunkFileDetailed(
        file.content,
        file.absPath,
        file.relPath,
      );
      chunks = treeSitterResult.chunks;
      structuralSymbolHints.set(i, treeSitterResult.symbols);
      if (chunks.length === 0) {
        if (treeSitterResult.fallbackReason) {
          metrics.recordChunkingFallback(treeSitterResult.fallbackReason);
        }
        chunks = chunkFile(file.content, file.absPath, file.relPath);
      }
    } else {
      chunks = chunkFile(file.content, file.absPath, file.relPath);
    }

    for (const chunk of chunks) {
      if (!chunk.embeddingContent) {
        chunk.embeddingContent = chunk.content;
      }
    }
    for (const chunk of chunks) {
      allChunks.push({ chunk, fileIdx: i });
    }
  }
  chunksCreated = allChunks.length;

  if (aborted || allChunks.length === 0) {
    return {
      filesIndexed,
      chunksCreated: 0,
      recordsUpserted,
      recordsDeleted,
      errors,
      pendingOwnership: false,
    };
  }

  // 2. Embed all chunks from this batch
  const embeddings = await batchEmbed(
    allChunks.map((c) => c.chunk.embeddingContent ?? c.chunk.content),
    config.embeddingBearerToken,
    errors,
  );

  if (aborted) {
    return {
      filesIndexed,
      chunksCreated,
      recordsUpserted,
      recordsDeleted,
      errors,
      pendingOwnership: false,
    };
  }

  // 3. Keep every chunk in the revision. Missing embeddings degrade those chunks
  // to lexical-only retrieval instead of suppressing the source publication.
  const publicationChunks = new Map<
    number,
    Array<{ chunk: Chunk; embedding: number[] | null }>
  >();
  for (let i = 0; i < allChunks.length; i++) {
    const { chunk, fileIdx } = allChunks[i];
    const ownedChunks = publicationChunks.get(fileIdx) ?? [];
    ownedChunks.push({ chunk, embedding: embeddings[i] ?? null });
    publicationChunks.set(fileIdx, ownedChunks);
  }

  const publications = [];
  for (const [fileIndex, chunks] of publicationChunks) {
    const file = files[fileIndex];
    try {
      const structuralEntry = extractStructuralFile({
        content: file.content,
        absPath: file.absPath,
        relPath: file.relPath,
        workspaceRoot: config.workspaceRoot,
        hash: file.hash,
        indexedAt: new Date().toISOString(),
        mtimeMs: file.mtimeMs,
        size: file.size,
        symbolHints: structuralSymbolHints.get(fileIndex),
      });
      const publication = prepareCodeFilePublication({
        publicationId: randomUUID(),
        generation: randomUUID(),
        workspaceRoot: config.workspaceRoot,
        sourcePath: file.relPath,
        contentHash: file.hash,
        observedAt: structuralEntry.indexedAt,
        sourceContent: file.content,
        chunks,
        structuralEntry,
      });
      publications.push({
        file: toJournalPath(file.relPath),
        publication,
        oldRecordIds: priorEntries[fileIndex]?.recordIds ?? [],
        cacheEntry: {
          hash: file.hash,
          recordIds: publication.expectedChunkIds,
          indexedAt: publication.source.revision.observedAt,
          mtimeMs: file.mtimeMs,
          size: file.size,
        },
        structuralEntry: {
          ...structuralEntry,
          sourceId: publication.source.id,
        },
      });
    } catch (error) {
      errors.push(
        `Publication preparation failed for ${file.relPath}: ${String(error)}`,
      );
    }
  }

  if (publications.length > 0) {
    try {
      metrics.recordOperation("retrieval.upsertRecords");
      const publicationResult =
        await executeJournaledStagedRepositoryPublications({
          journalPath: getFileIndexJournalPath(config.cachePath),
          publications,
          store: createFileReplacementStore({
            cache,
            structuralCache,
            checkpoints: config.checkpoints,
          }),
          port: config.stagedPublicationPort,
          fenceToken: config.writerFenceToken,
          isCancelled: () => aborted,
        });
      filesIndexed += publicationResult.committedFiles;
      recordsUpserted += publicationResult.recordsUpserted;
      recordsDeleted += publicationResult.recordsDeleted;
      if (publicationResult.cancelled || publicationResult.pending) {
        return {
          filesIndexed,
          chunksCreated,
          recordsUpserted,
          recordsDeleted,
          errors,
          pendingOwnership: true,
        };
      }
    } catch (error) {
      errors.push(`Retrieval publication failed: ${error}`);
      return {
        filesIndexed,
        chunksCreated,
        recordsUpserted,
        recordsDeleted,
        errors,
        pendingOwnership: true,
      };
    }
  }
  return {
    filesIndexed,
    chunksCreated,
    recordsUpserted,
    recordsDeleted,
    errors,
    pendingOwnership: false,
  };
}

async function processFilePaths(
  paths: Array<{ absPath: string; relPath: string }>,
  config: BatchConfig,
  cache: IndexCache,
  structuralCache: StructuralGraphCache,
  onBatch?: (
    batchStart: number,
    batchNumber: number,
    totalBatches: number,
  ) => void,
): Promise<BatchResult> {
  const result: BatchResult = {
    filesIndexed: 0,
    chunksCreated: 0,
    recordsUpserted: 0,
    recordsDeleted: 0,
    errors: [],
    pendingOwnership: false,
  };

  await runBoundedReadAheadPipeline({
    inputs: paths,
    batchSize: FILE_BATCH_SIZE,
    isCancelled: () => aborted,
    async readBatch(batchPaths) {
      const errors: string[] = [];
      const files = await measureIndexWorkerPhase(metrics, "read", () =>
        readFilesBatch([...batchPaths], errors, {
          workspaceRoot: config.workspaceRoot,
          cache,
          metrics,
          isCancelled: () => aborted,
          onCacheMetadataChanged: () => config.checkpoints.scheduleVector(),
        }),
      );
      return {
        files,
        errors,
        errorsReported: false,
        retainedBytes: files.reduce(
          (total, file) => total + file.contentBytes,
          0,
        ),
      };
    },
    async processBatch(batch, batchStart, batchNumber, totalBatches) {
      if (!batch.errorsReported) {
        result.errors.push(...batch.errors);
        batch.errorsReported = true;
      }
      if (batch.files.length === 0) return true;
      onBatch?.(batchStart, batchNumber, totalBatches);

      const batchResult = await measureIndexWorkerPhase(
        metrics,
        "process",
        () => processFileBatch(batch.files, config, cache, structuralCache),
      );
      result.filesIndexed += batchResult.filesIndexed;
      result.chunksCreated += batchResult.chunksCreated;
      result.recordsUpserted += batchResult.recordsUpserted;
      result.recordsDeleted += batchResult.recordsDeleted;
      result.errors.push(...batchResult.errors);
      result.pendingOwnership ||= batchResult.pendingOwnership;
      return !batchResult.pendingOwnership;
    },
    releaseBatch(batch) {
      if (!batch.errorsReported) {
        result.errors.push(...batch.errors);
        batch.errorsReported = true;
      }
      metrics.contentReleased(batch.retainedBytes);
      sampleHeapUsed();
    },
  });

  return result;
}

// --- Main indexing pipeline ---

async function handleStart(msg: StartIndexMessage): Promise<void> {
  const useTreeSitter = await awaitTreeSitterStartup(msg.files.length);
  const syntaxRecoveryRebuild = treeSitterRecoveryRequiresRebuild;
  const startTime = Date.now();
  const errors: string[] = [];
  let filesIndexed = 0;
  let chunksCreated = 0;
  let recordsUpserted = 0;
  let recordsDeleted = 0;
  let checkpoints: CacheCheckpointCoordinator | undefined;
  let repository: LanceDbRetrievalRepository | undefined;
  let writer: Awaited<ReturnType<typeof acquireWorkerWriterLease>> | undefined;
  let terminalMessage: (() => void) | undefined;
  const jobMetrics = metrics;

  if (aborted) {
    sendComplete({
      filesIndexed,
      totalFilesInIndex: 0,
      chunksCreated,
      totalChunksInIndex: 0,
      recordsUpserted,
      recordsDeleted,
      durationMs: Date.now() - startTime,
      errors,
      cancelled: true,
    });
    return;
  }

  // Distribute granularity to all chunkers
  setTreeSitterGranularity(msg.granularity);
  setChunkerGranularity(msg.granularity);
  setMarkdownGranularity(msg.granularity);

  try {
    sendProgress("reading", 0, msg.files.length, "loading index metadata");
    const expectedScopeId = getCodeWorkspaceScopeId(msg.workspaceRoot);
    if (msg.workspaceScopeId !== expectedScopeId) {
      throw new Error("Workspace scope identity does not match workspace root");
    }
    const { cache, interruptedResetTarget } = loadWorkerOwnership(
      msg.cachePath,
      msg.force,
    );
    const { path: structuralCachePath, cache: structuralCache } =
      loadWorkerStructuralCache({
        cachePath: msg.cachePath,
        workspaceRoot: msg.workspaceRoot,
        indexName: msg.indexName,
      });
    sendProgress("reading", 0, msg.files.length, "opening retrieval store");
    writer = await acquireWorkerWriterLease({
      storeRoot: msg.retrievalStoreRoot,
      workspaceScopeId: msg.workspaceScopeId,
    });
    repository = createRetrievalRepository(
      msg.retrievalStoreRoot,
      writer.lease,
    );
    const expectedFingerprint = createCodeIndexFingerprint(msg.granularity);
    sendStartupProgress(msg.files.length, "migrating retrieval store");
    const migration = await repository.migrate(expectedFingerprint);
    if (migration.status === "rebuild_required") {
      throw new Error(CODE_INDEX_REBUILD_REQUIRED_ERROR);
    }
    const retrievalIndexesRequireRefresh =
      (await repository.lexicalReadiness()).status !== "ready";
    const checkpointCoordinator = createCacheCheckpointCoordinator({
      cachePath: msg.cachePath,
      structuralCachePath,
      cache,
      structuralCache,
    });
    checkpoints = checkpointCoordinator;
    const fingerprintDisposition = classifyRetrievalFingerprint(
      cache.fingerprint ?? null,
      expectedFingerprint,
    );
    const rebuildRequested =
      msg.force ||
      syntaxRecoveryRebuild ||
      fingerprintDisposition !== "compatible" ||
      (cache.granularity ?? "standard") !== msg.granularity;

    if (!rebuildRequested) {
      sendStartupProgress(
        msg.files.length,
        "recovering interrupted file publications",
      );
    }
    const replacementRecovery = rebuildRequested
      ? {
          cancelled: false,
          pending: false,
          recordsDeleted: 0,
          refreshRequired: false,
        }
      : await recoverChangedFileReplacements({
          cachePath: msg.cachePath,
          cache,
          structuralCache,
          stagedPublicationPort: writer.port,
          checkpoints,
        });
    recordsDeleted += replacementRecovery.recordsDeleted;
    if (replacementRecovery.pending || replacementRecovery.cancelled) {
      if (replacementRecovery.refreshRequired) {
        await refreshRetrievalIndexes(
          repository,
          filesIndexed,
          Object.keys(cache.files).length,
        );
      }
      terminalMessage = deferComplete(
        {
          filesIndexed,
          totalFilesInIndex: Object.keys(cache.files).length,
          chunksCreated,
          totalChunksInIndex: countCachedChunks(cache),
          recordsUpserted,
          recordsDeleted,
          durationMs: Date.now() - startTime,
          errors,
          cancelled: true,
        },
        jobMetrics,
      );
      return;
    }
    if (!rebuildRequested) {
      sendStartupProgress(msg.files.length, "recovering interrupted deletions");
    }
    const recovery = rebuildRequested
      ? {
          completed: 0,
          errors: [],
          recordsDeleted: 0,
          cancelled: false,
          pending: false,
        }
      : await removeFilesFromIndex({
          relPaths: [],
          cachePath: msg.cachePath,
          cache,
          structuralCache,
          workspaceScopeId: msg.workspaceScopeId,
          repository,
          checkpoints,
          runFenced: writer.port.runFenced,
        });
    recordsDeleted += recovery.recordsDeleted;
    errors.push(...recovery.errors);
    if (recovery.pending || recovery.cancelled) {
      if (recordsDeleted > 0) {
        await refreshRetrievalIndexes(
          repository,
          filesIndexed,
          Object.keys(cache.files).length,
        );
      }
      terminalMessage = deferComplete(
        {
          filesIndexed,
          totalFilesInIndex: Object.keys(cache.files).length,
          chunksCreated,
          totalChunksInIndex: countCachedChunks(cache),
          recordsUpserted,
          recordsDeleted,
          durationMs: Date.now() - startTime,
          errors,
          cancelled: recovery.cancelled || undefined,
        },
        jobMetrics,
      );
      return;
    }

    // Force and granularity rebuilds share one durable retrieval index/cache reset.
    if (rebuildRequested) {
      sendStartupProgress(
        msg.files.length,
        "resetting workspace retrieval scope",
      );
      await resetIndexOwnership({
        cachePath: msg.cachePath,
        cache,
        structuralCache,
        workspaceRoot: msg.workspaceRoot,
        indexName: msg.indexName,
        retrievalStoreRoot: msg.retrievalStoreRoot,
        workspaceScopeId: msg.workspaceScopeId,
        repository,
        granularity: msg.granularity,
        fingerprint: expectedFingerprint,
        interruptedTarget: interruptedResetTarget,
        checkpoints,
        runFenced: writer.port.runFenced,
      });
      if (syntaxRecoveryRebuild) treeSitterRecoveryRequiresRebuild = false;
    }

    // Phase 1: Scan files to determine what changed (paths only, no content held)
    sendProgress("reading", 0, msg.files.length);
    const {
      toIndexPaths,
      removedRelPaths,
      cacheMetadataChanged,
      errors: scanErrors,
    } = await measureIndexWorkerPhase(metrics, "scan", () =>
      scanFiles(msg.files, msg.workspaceRoot, cache, {
        onProgress: (scanned, total) => sendProgress("reading", scanned, total),
        metrics,
        isCancelled: () => aborted,
      }),
    );
    errors.push(...scanErrors);
    if (cacheMetadataChanged) checkpoints.scheduleVector();
    sendProgress("reading", msg.files.length, msg.files.length);

    if (aborted) {
      checkpoints.drain();
      terminalMessage = deferComplete(
        {
          filesIndexed,
          totalFilesInIndex: Object.keys(cache.files).length,
          chunksCreated,
          totalChunksInIndex: countCachedChunks(cache),
          recordsUpserted,
          recordsDeleted,
          durationMs: Date.now() - startTime,
          errors,
          cancelled: true,
        },
        jobMetrics,
      );
      return;
    }

    // Phase 1b: Delete files that are absent from the workspace. Changed-file
    // ownership remains intact until the existing reindex path handles it.
    if (removedRelPaths.length > 0) {
      sendProgress("cleanup", 0, removedRelPaths.length);
      const removal = await removeFilesFromIndex({
        relPaths: removedRelPaths,
        cachePath: msg.cachePath,
        cache,
        structuralCache,
        workspaceScopeId: msg.workspaceScopeId,
        repository,
        checkpoints,
        runFenced: writer.port.runFenced,
      });
      recordsDeleted += removal.recordsDeleted;
      errors.push(...removal.errors);
      sendProgress("cleanup", removal.completed, removedRelPaths.length);
      if (removal.pending || removal.cancelled) {
        if (recordsDeleted > 0) {
          await refreshRetrievalIndexes(
            repository,
            filesIndexed,
            Object.keys(cache.files).length,
          );
        }
        terminalMessage = deferComplete(
          {
            filesIndexed,
            totalFilesInIndex: Object.keys(cache.files).length,
            chunksCreated,
            totalChunksInIndex: countCachedChunks(cache),
            recordsUpserted,
            recordsDeleted,
            durationMs: Date.now() - startTime,
            errors,
            cancelled: removal.cancelled || undefined,
          },
          jobMetrics,
        );
        return;
      }
    }

    if (!aborted) {
      const structuralBackfillCount = await measureIndexWorkerPhase(
        metrics,
        "backfill",
        () =>
          backfillStructuralCacheForCachedFiles({
            files: msg.files,
            workspaceRoot: msg.workspaceRoot,
            cache,
            structuralCache,
            errors,
            useTreeSitter,
          }),
      );
      sampleHeapUsed();
      if (structuralBackfillCount > 0) {
        checkpoints.scheduleStructural();
      }
    }

    if (aborted || toIndexPaths.length === 0) {
      scheduleCacheMetadataCheckpoint({
        cache,
        granularity: msg.granularity,
        checkpoints,
      });
      checkpoints.drain();
      if (
        !aborted &&
        (retrievalIndexesRequireRefresh ||
          rebuildRequested ||
          replacementRecovery.refreshRequired ||
          recordsDeleted > 0)
      ) {
        await refreshRetrievalIndexes(
          repository,
          filesIndexed,
          Object.keys(cache.files).length,
        );
      }
      terminalMessage = deferComplete(
        {
          filesIndexed: 0,
          totalFilesInIndex: Object.keys(cache.files).length,
          chunksCreated: 0,
          totalChunksInIndex: countCachedChunks(cache),
          recordsUpserted,
          recordsDeleted,
          durationMs: Date.now() - startTime,
          errors,
          cancelled: aborted || undefined,
        },
        jobMetrics,
      );
      return;
    }

    // Phase 2: Read one batch ahead while serially processing the current batch.
    const totalFiles = toIndexPaths.length;
    const result = await processFilePaths(
      toIndexPaths,
      {
        repository,
        stagedPublicationPort: writer.port,
        writerFenceToken: writer.lease.fenceToken,
        embeddingBearerToken: msg.embeddingBearerToken,
        cachePath: msg.cachePath,
        workspaceRoot: msg.workspaceRoot,
        granularity: msg.granularity,
        checkpoints,
        useTreeSitter,
      },
      cache,
      structuralCache,
      (batchStart, batchNumber, totalBatches) =>
        sendProgress(
          "indexing",
          batchStart,
          totalFiles,
          `batch ${batchNumber + 1}/${totalBatches}`,
        ),
    );
    filesIndexed += result.filesIndexed;
    chunksCreated += result.chunksCreated;
    recordsUpserted += result.recordsUpserted;
    recordsDeleted += result.recordsDeleted;
    errors.push(...result.errors);

    scheduleCacheMetadataCheckpoint({
      cache,
      granularity: msg.granularity,
      checkpoints,
    });
    checkpoints.drain();
    if (
      !aborted &&
      (retrievalIndexesRequireRefresh ||
        rebuildRequested ||
        replacementRecovery.refreshRequired ||
        recordsUpserted > 0 ||
        recordsDeleted > 0)
    ) {
      await refreshRetrievalIndexes(
        repository,
        filesIndexed,
        Object.keys(cache.files).length,
      );
    }

    terminalMessage = deferComplete(
      {
        filesIndexed,
        totalFilesInIndex: Object.keys(cache.files).length,
        chunksCreated,
        totalChunksInIndex: countCachedChunks(cache),
        recordsUpserted,
        recordsDeleted,
        durationMs: Date.now() - startTime,
        errors,
        cancelled: aborted || undefined,
      },
      jobMetrics,
    );
  } catch (err) {
    try {
      checkpoints?.drain();
    } catch (checkpointError) {
      terminalMessage = () =>
        sendError(
          `Indexing failed: ${err}; cache checkpoint failed: ${checkpointError}`,
          true,
        );
      return;
    }
    terminalMessage = () => sendError(`Indexing failed: ${err}`, true);
  } finally {
    checkpoints?.cancelScheduled();
    await releaseWorkerWriterLease(writer);
    await closeRetrievalRepository(repository);
    terminalMessage?.();
  }
}

// --- Incremental update ---

async function handleIncrementalUpdate(
  msg: IncrementalUpdateMessage,
): Promise<void> {
  const useTreeSitter = await awaitTreeSitterStartup(
    msg.added.length + msg.removed.length,
  );
  const startTime = Date.now();
  const errors: string[] = [];
  let filesIndexed = 0;
  let chunksCreated = 0;
  let recordsUpserted = 0;
  let recordsDeleted = 0;
  let checkpoints: CacheCheckpointCoordinator | undefined;
  let repository: LanceDbRetrievalRepository | undefined;
  let writer: Awaited<ReturnType<typeof acquireWorkerWriterLease>> | undefined;
  let terminalMessage: (() => void) | undefined;
  const jobMetrics = metrics;

  if (aborted) {
    sendComplete({
      filesIndexed,
      totalFilesInIndex: 0,
      chunksCreated,
      totalChunksInIndex: 0,
      recordsUpserted,
      recordsDeleted,
      durationMs: Date.now() - startTime,
      errors,
      cancelled: true,
    });
    return;
  }

  // Distribute granularity to all chunkers
  setTreeSitterGranularity(msg.granularity);
  setChunkerGranularity(msg.granularity);
  setMarkdownGranularity(msg.granularity);

  try {
    if (treeSitterRecoveryRequiresRebuild) {
      throw new Error(CODE_INDEX_REBUILD_REQUIRED_ERROR);
    }
    const totalChanges = msg.added.length + msg.removed.length;
    sendProgress("reading", 0, totalChanges, "loading index metadata");
    const expectedScopeId = getCodeWorkspaceScopeId(msg.workspaceRoot);
    if (msg.workspaceScopeId !== expectedScopeId) {
      throw new Error("Workspace scope identity does not match workspace root");
    }
    const { cache } = loadWorkerOwnership(msg.cachePath, false);
    const expectedFingerprint = createCodeIndexFingerprint(msg.granularity);
    if (
      classifyRetrievalFingerprint(
        cache.fingerprint ?? null,
        expectedFingerprint,
      ) !== "compatible" ||
      (cache.granularity ?? "standard") !== msg.granularity
    ) {
      throw new Error(CODE_INDEX_REBUILD_REQUIRED_ERROR);
    }
    const { path: structuralCachePath, cache: structuralCache } =
      loadWorkerStructuralCache({
        cachePath: msg.cachePath,
        workspaceRoot: msg.workspaceRoot,
        indexName: msg.indexName,
      });
    sendProgress("reading", 0, totalChanges, "opening retrieval store");
    writer = await acquireWorkerWriterLease({
      storeRoot: msg.retrievalStoreRoot,
      workspaceScopeId: msg.workspaceScopeId,
    });
    repository = createRetrievalRepository(
      msg.retrievalStoreRoot,
      writer.lease,
    );
    sendStartupProgress(totalChanges, "migrating retrieval store");
    const migration = await repository.migrate(expectedFingerprint);
    if (migration.status === "rebuild_required") {
      throw new Error(CODE_INDEX_REBUILD_REQUIRED_ERROR);
    }
    const retrievalIndexesRequireRefresh =
      (await repository.lexicalReadiness()).status !== "ready";
    const checkpointCoordinator = createCacheCheckpointCoordinator({
      cachePath: msg.cachePath,
      structuralCachePath,
      cache,
      structuralCache,
    });
    checkpoints = checkpointCoordinator;
    const replacementRecovery = await recoverChangedFileReplacements({
      cachePath: msg.cachePath,
      cache,
      structuralCache,
      stagedPublicationPort: writer.port,
      checkpoints,
    });
    recordsDeleted += replacementRecovery.recordsDeleted;
    if (replacementRecovery.pending || replacementRecovery.cancelled) {
      if (replacementRecovery.refreshRequired) {
        await refreshRetrievalIndexes(
          repository,
          filesIndexed,
          Object.keys(cache.files).length,
        );
      }
      terminalMessage = deferComplete(
        {
          filesIndexed,
          totalFilesInIndex: Object.keys(cache.files).length,
          chunksCreated,
          totalChunksInIndex: countCachedChunks(cache),
          recordsUpserted,
          recordsDeleted,
          durationMs: Date.now() - startTime,
          errors,
          cancelled: true,
        },
        jobMetrics,
      );
      return;
    }
    const recovery = await removeFilesFromIndex({
      relPaths: [],
      cachePath: msg.cachePath,
      cache,
      structuralCache,
      workspaceScopeId: msg.workspaceScopeId,
      repository,
      checkpoints,
      runFenced: writer.port.runFenced,
    });
    recordsDeleted += recovery.recordsDeleted;
    errors.push(...recovery.errors);
    if (recovery.pending || recovery.cancelled) {
      if (recordsDeleted > 0) {
        await refreshRetrievalIndexes(
          repository,
          filesIndexed,
          Object.keys(cache.files).length,
        );
      }
      terminalMessage = deferComplete(
        {
          filesIndexed,
          totalFilesInIndex: Object.keys(cache.files).length,
          chunksCreated,
          totalChunksInIndex: countCachedChunks(cache),
          recordsUpserted,
          recordsDeleted,
          durationMs: Date.now() - startTime,
          errors,
          cancelled: recovery.cancelled || undefined,
        },
        jobMetrics,
      );
      return;
    }

    // Handle removed files. Cache ownership is released only after the
    // repository confirms source deletion or idempotent absence.
    const removal = await removeFilesFromIndex({
      relPaths: msg.removed.flatMap((candidatePath) => {
        const identity = resolveContainedCodeIndexPath(
          msg.workspaceRoot,
          candidatePath,
        );
        return identity ? [identity.relativePath] : [];
      }),
      cachePath: msg.cachePath,
      cache,
      structuralCache,
      workspaceScopeId: msg.workspaceScopeId,
      repository,
      checkpoints,
      runFenced: writer.port.runFenced,
    });
    recordsDeleted += removal.recordsDeleted;
    errors.push(...removal.errors);
    if (removal.pending || removal.cancelled) {
      if (recordsDeleted > 0) {
        await refreshRetrievalIndexes(
          repository,
          filesIndexed,
          Object.keys(cache.files).length,
        );
      }
      terminalMessage = deferComplete(
        {
          filesIndexed,
          totalFilesInIndex: Object.keys(cache.files).length,
          chunksCreated,
          totalChunksInIndex: countCachedChunks(cache),
          recordsUpserted,
          recordsDeleted,
          durationMs: Date.now() - startTime,
          errors,
          cancelled: removal.cancelled || undefined,
        },
        jobMetrics,
      );
      return;
    }

    // Scan only the watcher candidates. Incremental mode always hashes them and
    // never infers removals from this partial path list.
    const {
      toIndexPaths,
      cacheMetadataChanged,
      errors: scanErrors,
    } = await measureIndexWorkerPhase(metrics, "scan", () =>
      scanFiles(msg.added, msg.workspaceRoot, cache, {
        mode: "incremental",
        metrics,
        isCancelled: () => aborted,
      }),
    );
    sampleHeapUsed();
    errors.push(...scanErrors);
    if (cacheMetadataChanged) checkpoints.scheduleVector();

    // Existing ownership remains intact until each serial replacement intent is
    // durable; file I/O for the next batch may overlap the current consumer.
    if (toIndexPaths.length > 0 && !aborted) {
      const result = await processFilePaths(
        toIndexPaths,
        {
          repository,
          stagedPublicationPort: writer.port,
          writerFenceToken: writer.lease.fenceToken,
          embeddingBearerToken: msg.embeddingBearerToken,
          cachePath: msg.cachePath,
          workspaceRoot: msg.workspaceRoot,
          granularity: msg.granularity,
          checkpoints,
          useTreeSitter,
        },
        cache,
        structuralCache,
      );
      filesIndexed += result.filesIndexed;
      chunksCreated += result.chunksCreated;
      recordsUpserted += result.recordsUpserted;
      recordsDeleted += result.recordsDeleted;
      errors.push(...result.errors);
    }

    scheduleCacheMetadataCheckpoint({
      cache,
      granularity: msg.granularity,
      checkpoints,
    });
    checkpoints.drain();
    if (
      !aborted &&
      (retrievalIndexesRequireRefresh ||
        replacementRecovery.refreshRequired ||
        recordsUpserted > 0 ||
        recordsDeleted > 0)
    ) {
      await refreshRetrievalIndexes(
        repository,
        filesIndexed,
        Object.keys(cache.files).length,
      );
    }

    terminalMessage = deferComplete(
      {
        filesIndexed,
        totalFilesInIndex: Object.keys(cache.files).length,
        chunksCreated,
        totalChunksInIndex: countCachedChunks(cache),
        recordsUpserted,
        recordsDeleted,
        durationMs: Date.now() - startTime,
        errors,
        cancelled: aborted || undefined,
      },
      jobMetrics,
    );
  } catch (err) {
    try {
      checkpoints?.drain();
    } catch (checkpointError) {
      terminalMessage = () =>
        sendError(
          `Incremental update failed: ${err}; cache checkpoint failed: ${checkpointError}`,
          true,
        );
      return;
    }
    terminalMessage = () =>
      sendError(`Incremental update failed: ${err}`, true);
  } finally {
    checkpoints?.cancelScheduled();
    await releaseWorkerWriterLease(writer);
    await closeRetrievalRepository(repository);
    terminalMessage?.();
  }
}

// ============================================================
// OpenAI Embedding API
// ============================================================

/**
 * Split texts into token-aware batches that respect both the count limit
 * (EMBEDDING_BATCH_SIZE) and the token limit (MAX_BATCH_TOKENS).
 */
function takeTokenAwareBatch(
  texts: string[],
  startIdx: number,
): { startIdx: number; batch: string[] } | null {
  if (startIdx >= texts.length) return null;

  const batch: string[] = [];
  let batchTokens = 0;
  let cursor = startIdx;
  while (cursor < texts.length && batch.length < EMBEDDING_BATCH_SIZE) {
    const tokens = estimateTokensFromChars(texts[cursor].length);
    if (batch.length > 0 && batchTokens + tokens > MAX_BATCH_TOKENS) break;
    batch.push(texts[cursor]);
    batchTokens += tokens;
    cursor++;
  }
  return batch.length > 0 ? { startIdx, batch } : null;
}

function createEmbeddingFetchLimiter(
  fetchImpl: typeof fetch,
  concurrency: number,
): typeof fetch {
  let activeRequests = 0;
  const waiters: Array<() => void> = [];

  const acquire = async (): Promise<void> => {
    if (activeRequests < concurrency) {
      activeRequests++;
      return;
    }
    await new Promise<void>((resolve) => waiters.push(resolve));
  };
  const release = (): void => {
    const next = waiters.shift();
    if (next) {
      next();
    } else {
      activeRequests--;
    }
  };

  return async (input, init) => {
    await acquire();
    try {
      return await fetchImpl(input, init);
    } finally {
      release();
    }
  };
}

async function batchEmbed(
  texts: string[],
  bearerToken: string | undefined,
  errors: string[],
  onProgress?: (done: number, total: number) => void,
): Promise<(number[] | null)[]> {
  if (!bearerToken) {
    onProgress?.(texts.length, texts.length);
    return Array.from({ length: texts.length }, () => null);
  }

  // Truncate oversized texts to fit within the embedding model's context window
  const safeTexts = texts.map((t) =>
    t.length > MAX_CODE_INDEX_EMBEDDING_CHARS
      ? t.slice(0, MAX_CODE_INDEX_EMBEDDING_CHARS)
      : t,
  );
  const results: (number[] | null)[] = Array.from<number[] | null>({
    length: safeTexts.length,
  }).fill(null);
  let done = 0;
  let cursor = 0;
  const embeddingFetch = createEmbeddingFetchLimiter(
    fetch,
    EMBEDDING_CONCURRENCY,
  );

  const processNextBatch = async (): Promise<void> => {
    while (!aborted) {
      const next = takeTokenAwareBatch(safeTexts, cursor);
      if (!next) return;
      const { startIdx, batch } = next;
      cursor = startIdx + batch.length;

      try {
        const vectors = await embedBatchWithRetry(
          batch,
          bearerToken,
          embeddingFetch,
        );
        for (let index = 0; index < vectors.length; index++) {
          results[startIdx + index] = vectors[index];
        }
      } catch (err) {
        errors.push(
          `Embedding batch failed (${batch.length} chunks at offset ${startIdx}): ${err}`,
        );
      }
      done += batch.length;
      onProgress?.(done, safeTexts.length);
    }
  };

  await Promise.all(
    Array.from(
      { length: Math.min(EMBEDDING_CONCURRENCY, safeTexts.length) },
      () => processNextBatch(),
    ),
  );

  return results;
}

async function embedBatchWithRetry(
  texts: string[],
  bearerToken: string,
  fetchImpl: typeof fetch,
  retries = MAX_RETRIES,
): Promise<number[][]> {
  return requestEmbeddings(texts, bearerToken, {
    maxRetries: retries,
    retryFetchErrors: true,
    shouldRetryStatus: (status) =>
      status === 408 || status === 429 || (status >= 500 && status < 600),
    retryDelayMs: (attempt, random, retryAfterMs) =>
      Math.min(retryAfterMs ?? 1000 * 2 ** attempt + random * 500, 30_000),
    refreshBearerToken: requestEmbeddingAuthRefresh,
    bisectOnBadRequest: true,
    sortByIndex: true,
    fetch: fetchImpl,
  });
}
