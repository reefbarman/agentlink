/**
 * Indexer worker — runs as a child process via child_process.fork().
 *
 * Handles file reading, hashing, chunking, embedding (OpenAI), and
 * Qdrant upsert/delete. Communicates with the extension host via IPC.
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
  treeSitterChunkFile,
  isTreeSitterSupported,
  setChunkGranularity as setTreeSitterGranularity,
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
  buildPathSegments,
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
import {
  emptyFileIndexJournal,
  getFileIndexJournalPath,
  loadFileIndexJournal,
  resetFileIndexJournal,
  writeFileIndexJournal,
  type FileIndexJournal,
} from "./fileIndexJournal.js";
import { executeJournaledRemovedFileDeletes } from "./journaledRemovedFileDeletion.js";
import {
  executeJournaledFileReplacement,
  recoverJournaledFileReplacements,
  type FileReplacementStore,
} from "./journaledFileReplacement.js";
import { extractStructuralFile } from "./structuralExtractor.js";
import {
  beginCollectionReset,
  completeCollectionReset,
  getCollectionResetStatePath,
  loadCollectionResetState,
  type CollectionResetTarget,
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
import { EMBEDDING_DIM } from "./embeddingConfig.js";
import { requestEmbeddings } from "./embeddingClient.js";
import {
  deleteQdrantCollection as deleteQdrantCollectionRequest,
  deleteQdrantPoints as deleteQdrantPointsRequest,
  ensureQdrantCollection as ensureQdrantCollectionRequest,
  normalizeQdrantUrl,
  setQdrantPointVisibility as setQdrantPointVisibilityRequest,
  upsertQdrantPoints as upsertQdrantPointsRequest,
  type QdrantPoint,
  type QdrantPayloadIndex,
} from "./qdrantClient.js";
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
const QDRANT_UPSERT_BATCH = 100;
const MAX_RETRIES = 3;
/**
 * Token limit per embedding batch. Estimated via chars/4.
 * text-embedding-3-small supports up to 8191 tokens per input, and the API
 * accepts large batches. Roo-Code uses 100K; we use 50K as a safe middle ground
 * that drastically reduces the number of API calls vs our old 7.5K limit.
 */
const MAX_BATCH_TOKENS = 50_000;
/**
 * Max characters per individual embedding text.
 * text-embedding-3-small has an 8192 token limit. Code averages ~2.5-3
 * chars/token, so 20k chars ≈ 6700-8000 tokens — safe with margin.
 */
const MAX_EMBEDDING_CHARS = 20_000;
/**
 * Number of files to process through the full pipeline (chunk → embed → upsert)
 * per batch. Bounds peak memory to ~7.5MB per batch instead of O(total_files).
 */
const FILE_BATCH_SIZE = 50;

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
  writeCacheFile(cachePath, cache);
  metrics.recordOperation("cache.writeVector", serializedByteLength(cache));
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
  if (args.cache.granularity === args.granularity) return;
  args.cache.granularity = args.granularity;
  args.checkpoints.scheduleVector();
}

async function deleteQdrantCollection(
  qdrantUrl: string,
  collectionName: string,
): Promise<void> {
  metrics.recordOperation("qdrant.deleteCollection");
  await deleteQdrantCollectionRequest(qdrantUrl, collectionName);
}

async function deleteQdrantPoints(
  qdrantUrl: string,
  collectionName: string,
  pointIds: string[],
): Promise<void> {
  metrics.recordOperation("qdrant.deletePoints");
  await deleteQdrantPointsRequest(qdrantUrl, collectionName, pointIds);
}

async function upsertQdrantPoints(
  qdrantUrl: string,
  collectionName: string,
  points: QdrantPoint[],
): Promise<void> {
  metrics.recordOperation("qdrant.upsertPoints");
  await upsertQdrantPointsRequest(qdrantUrl, collectionName, points);
}

async function setQdrantPointVisibility(
  qdrantUrl: string,
  collectionName: string,
  pointIds: string[],
  visible: boolean,
): Promise<void> {
  for (let index = 0; index < pointIds.length; index += QDRANT_UPSERT_BATCH) {
    metrics.recordOperation("qdrant.setPointVisibility");
    await setQdrantPointVisibilityRequest(
      qdrantUrl,
      collectionName,
      pointIds.slice(index, index + QDRANT_UPSERT_BATCH),
      visible,
    );
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

function sendComplete(stats: IndexStats): void {
  sampleHeapUsed();
  send({ type: "complete", stats: { ...stats, metrics: metrics.snapshot() } });
}

function sendError(message: string, fatal: boolean): void {
  send({ type: "error", message, fatal });
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
    total += entry.pointIds.length;
  }
  return total;
}

function loadWorkerOwnership(
  cachePath: string,
  allowCorruptReset: boolean,
): {
  cache: IndexCache;
  resetTarget: CollectionResetTarget | null;
} {
  const loadedCache = loadIndexCache(cachePath);
  const loadedJournal = loadFileIndexJournal(
    getFileIndexJournalPath(cachePath),
  );
  const loadedReset = loadCollectionResetState(
    getCollectionResetStatePath(cachePath),
  );
  if (loadedReset.status === "corrupt") {
    throw new Error(`Collection reset state is corrupt: ${loadedReset.error}`);
  }
  if (
    loadedReset.status === "valid" &&
    loadedReset.state.status === "in-progress"
  ) {
    if (allowCorruptReset) {
      return {
        cache: { version: 1, files: {} },
        resetTarget: {
          qdrantUrl: loadedReset.state.qdrantUrl,
          collectionName: loadedReset.state.collectionName,
        },
      };
    }
    throw new Error(
      "Collection reset state requires a forced re-index: A collection reset did not complete",
    );
  }
  if (loadedCache.status === "corrupt") {
    if (allowCorruptReset) {
      return { cache: { version: 1, files: {} }, resetTarget: null };
    }
    throw new Error(
      `Vector cache is corrupt; run a forced re-index to rebuild ownership: ${loadedCache.error}`,
    );
  }
  if (loadedJournal.status === "corrupt") {
    if (allowCorruptReset) {
      return { cache: { version: 1, files: {} }, resetTarget: null };
    }
    throw new Error(
      `File index journal is corrupt; run a forced re-index to rebuild ownership: ${loadedJournal.error}`,
    );
  }
  try {
    validateJournalCacheOwnership(loadedCache.cache, loadedJournal.journal);
  } catch (error) {
    if (allowCorruptReset) {
      return { cache: { version: 1, files: {} }, resetTarget: null };
    }
    throw error;
  }
  return { cache: loadedCache.cache, resetTarget: null };
}

function validateJournalCacheOwnership(
  cache: IndexCache,
  journal: FileIndexJournal,
): void {
  const owners = new Map<string, string>();
  for (const [file, entry] of Object.entries(cache.files)) {
    for (const pointId of entry.pointIds)
      owners.set(pointId, toJournalPath(file));
  }
  for (const operation of journal.operations) {
    const intendedPointIds = operation.intendedBatches.flatMap(
      (batch) => batch.pointIds,
    );
    const pointIds = [...operation.oldPointIds, ...intendedPointIds];
    const conflictingPointId = pointIds.find((pointId) => {
      const owner = owners.get(pointId);
      return owner !== undefined && owner !== operation.file;
    });
    if (conflictingPointId) {
      throw new Error(
        `File index journal point ${conflictingPointId} conflicts with vector cache ownership`,
      );
    }

    const entry = cache.files[fromJournalPath(operation.file)];
    if (!entry) continue;
    const exactOldOwnership = samePointIds(
      entry.pointIds,
      operation.oldPointIds,
    );
    const exactIntendedOwnership =
      operation.kind === "replace" &&
      entry.generation === operation.generation &&
      entry.hash === operation.targetHash &&
      samePointIds(entry.pointIds, intendedPointIds) &&
      (entry.visibility === "pending" || entry.visibility === "current");
    if (!exactOldOwnership && !exactIntendedOwnership) {
      throw new Error(
        `File index journal ownership for ${operation.file} does not match a recoverable vector cache state`,
      );
    }
  }
}

function samePointIds(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((pointId) => right.includes(pointId))
  );
}

function groupPointIds(
  pointIds: string[],
  batchSize: number,
): Array<{ batch: number; pointIds: string[] }> {
  const batches: Array<{ batch: number; pointIds: string[] }> = [];
  for (let index = 0; index < pointIds.length; index += batchSize) {
    batches.push({
      batch: batches.length,
      pointIds: pointIds.slice(index, index + batchSize),
    });
  }
  return batches;
}

function loadWorkerStructuralCache(args: {
  cachePath: string;
  workspaceRoot: string;
  collectionName: string;
}): { path: string; cache: StructuralGraphCache } {
  const structuralCachePath = getStructuralCachePath(args.cachePath);
  const cache = loadStructuralCache(structuralCachePath, args.workspaceRoot);
  cache.workspaceRoot = args.workspaceRoot;
  cache.collectionName = args.collectionName;
  return { path: structuralCachePath, cache };
}

function resetStructuralCache(
  structuralCache: StructuralGraphCache,
  workspaceRoot: string,
  collectionName: string,
): void {
  const fresh = emptyStructuralCache(workspaceRoot, collectionName);
  structuralCache.version = fresh.version;
  structuralCache.workspaceRoot = fresh.workspaceRoot;
  structuralCache.collectionName = fresh.collectionName;
  structuralCache.generatedAt = fresh.generatedAt;
  structuralCache.files = fresh.files;
}

async function resetCollectionOwnership(args: {
  cachePath: string;
  cache: IndexCache;
  structuralCache: StructuralGraphCache;
  workspaceRoot: string;
  qdrantUrl: string;
  collectionName: string;
  granularity: ChunkGranularity;
  interruptedTarget: CollectionResetTarget | null;
  checkpoints: CacheCheckpointCoordinator;
}): Promise<void> {
  const resetStatePath = getCollectionResetStatePath(args.cachePath);
  const currentTarget = {
    qdrantUrl: normalizeQdrantUrl(args.qdrantUrl),
    collectionName: args.collectionName,
  };
  if (
    args.interruptedTarget &&
    (normalizeQdrantUrl(args.interruptedTarget.qdrantUrl) !==
      currentTarget.qdrantUrl ||
      args.interruptedTarget.collectionName !== currentTarget.collectionName)
  ) {
    await deleteQdrantCollection(
      args.interruptedTarget.qdrantUrl,
      args.interruptedTarget.collectionName,
    );
  }
  beginCollectionReset(resetStatePath, currentTarget);
  await deleteQdrantCollection(
    currentTarget.qdrantUrl,
    currentTarget.collectionName,
  );
  resetFileIndexJournal(getFileIndexJournalPath(args.cachePath));
  args.cache.version = 1;
  args.cache.files = {};
  args.cache.granularity = args.granularity;
  resetStructuralCache(
    args.structuralCache,
    args.workspaceRoot,
    args.collectionName,
  );
  args.checkpoints.checkpointBoth(["vector", "structural"]);
  completeCollectionReset(resetStatePath, currentTarget);
}

function updateStructuralCacheForFiles(
  structuralCache: StructuralGraphCache,
  files: FileWithContent[],
  workspaceRoot: string,
): number {
  const indexedAt = new Date().toISOString();
  let updated = 0;
  for (const file of files) {
    const existing = structuralCache.files[file.relPath];
    if (existing?.hash === file.hash) continue;
    structuralCache.files[file.relPath] = extractStructuralFile({
      content: file.content,
      absPath: file.absPath,
      relPath: file.relPath,
      workspaceRoot,
      hash: file.hash,
      indexedAt,
      mtimeMs: file.mtimeMs,
      size: file.size,
    });
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
  qdrantUrl: string;
  collectionName: string;
  checkpoints: CacheCheckpointCoordinator;
}): Promise<{
  completed: number;
  errors: string[];
  pointsDeleted: number;
  cancelled: boolean;
  pending: boolean;
}> {
  const result = await executeJournaledRemovedFileDeletes({
    journalPath: getFileIndexJournalPath(args.cachePath),
    requestedFiles: args.relPaths.map((relPath) => ({
      relPath: toJournalPath(relPath),
      pointIds: args.cache.files[relPath]?.pointIds ?? [],
    })),
    deleteBatch: (pointIds) =>
      deleteQdrantPoints(args.qdrantUrl, args.collectionName, pointIds),
    checkpointCompleted: (journalPaths) => {
      for (const journalPath of journalPaths) {
        const relPath = fromJournalPath(journalPath);
        delete args.cache.files[relPath];
        delete args.structuralCache.files[relPath];
      }
      args.structuralCache.generatedAt = new Date().toISOString();
      args.checkpoints.checkpointBoth(["structural", "vector"]);
    },
    isCancelled: () => aborted,
    createId: randomUUID,
  });

  return {
    completed: result.completedRelPaths.length,
    errors: result.errors,
    pointsDeleted: result.pointsDeleted,
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

function hasDurableIndexOperations(
  cachePath: string,
  cache: IndexCache,
): boolean {
  const loaded = loadFileIndexJournal(getFileIndexJournalPath(cachePath));
  return (
    (loaded.status === "valid" && loaded.journal.operations.length > 0) ||
    Object.values(cache.files).some((entry) => entry.visibility === "pending")
  );
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
    getPendingVectors() {
      return Object.entries(args.cache.files)
        .filter(([, entry]) => entry.visibility === "pending")
        .map(([file, entry]) => [toJournalPath(file), entry]);
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
  };
}

async function recoverChangedFileReplacements(args: {
  cachePath: string;
  cache: IndexCache;
  structuralCache: StructuralGraphCache;
  qdrantUrl: string;
  collectionName: string;
  checkpoints: CacheCheckpointCoordinator;
}): Promise<{ cancelled: boolean; pointsDeleted: number }> {
  const recovered = await recoverJournaledFileReplacements({
    journalPath: getFileIndexJournalPath(args.cachePath),
    store: createFileReplacementStore(args),
    remote: {
      deletePoints: (pointIds) =>
        deleteQdrantPoints(args.qdrantUrl, args.collectionName, pointIds),
      upsertPoints: (points) =>
        upsertQdrantPoints(args.qdrantUrl, args.collectionName, points),
      setVisibility: (pointIds, visible) =>
        setQdrantPointVisibility(
          args.qdrantUrl,
          args.collectionName,
          pointIds,
          visible,
        ),
    },
    isCancelled: () => aborted,
  });
  return {
    cancelled: recovered.cancelled,
    pointsDeleted: recovered.pointsDeleted,
  };
}

async function backfillStructuralCacheForCachedFiles(args: {
  files: string[];
  workspaceRoot: string;
  cache: IndexCache;
  structuralCache: StructuralGraphCache;
  errors: string[];
}): Promise<number> {
  const missingStructuralPaths: Array<{ absPath: string; relPath: string }> =
    [];

  for (const absPath of args.files) {
    if (!absPath.startsWith(args.workspaceRoot)) continue;
    const relPath = path.relative(args.workspaceRoot, absPath);
    if (relPath.startsWith("..")) continue;

    const cached = args.cache.files[relPath];
    if (!cached) continue;

    const structuralEntry = args.structuralCache.files[relPath];
    if (structuralEntry?.hash === cached.hash) continue;

    missingStructuralPaths.push({ absPath, relPath });
  }

  let updated = 0;
  for (let i = 0; i < missingStructuralPaths.length; i += FILE_BATCH_SIZE) {
    const readErrors: string[] = [];
    const files = await readFilesBatch(
      missingStructuralPaths.slice(i, i + FILE_BATCH_SIZE),
      readErrors,
      { metrics, isCancelled: () => aborted },
    );
    args.errors.push(...readErrors);

    const retainedBytes = files.reduce(
      (total, file) => total + file.contentBytes,
      0,
    );
    try {
      if (aborted) return updated;
      updated += updateStructuralCacheForFiles(
        args.structuralCache,
        files.filter(
          (file) => args.cache.files[file.relPath]?.hash === file.hash,
        ),
        args.workspaceRoot,
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

// Initialize tree-sitter WASM (one-time, before any indexing)
const wasmDir = path.join(__dirname, "wasm");
const treeSitterReady = initTreeSitter(wasmDir).catch((err) => {
  sendError(`Tree-sitter init failed: ${err}`, true);
});

// --- File batch pipeline ---

interface BatchConfig {
  qdrantUrl: string;
  collectionName: string;
  embeddingBearerToken: string;
  cachePath: string;
  workspaceRoot: string;
  granularity: ChunkGranularity;
  checkpoints: CacheCheckpointCoordinator;
}

interface BatchResult {
  filesIndexed: number;
  chunksCreated: number;
  pointsUpserted: number;
  pointsDeleted: number;
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
  let pointsUpserted = 0;
  let pointsDeleted = 0;
  const priorEntries = files.map((file) => cache.files[file.relPath]);

  // 1. Chunk all files in this batch (yield every ~15ms to avoid CPU saturation)
  const allChunks: Array<{ chunk: Chunk; fileIdx: number }> = [];
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
    } else if (isTreeSitterSupported(file.absPath)) {
      chunks = await treeSitterChunkFile(
        file.content,
        file.absPath,
        file.relPath,
      );
      if (chunks.length === 0) {
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
      pointsUpserted,
      pointsDeleted,
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
      pointsUpserted,
      pointsDeleted,
      errors,
      pendingOwnership: false,
    };
  }

  // 3. Build points (filter out failed embeddings)
  const filePointIds = new Map<number, string[]>();
  const filePoints = new Map<number, QdrantPoint[]>();

  for (let i = 0; i < allChunks.length; i++) {
    const embedding = embeddings[i];
    if (!embedding) continue;

    const { chunk, fileIdx } = allChunks[i];
    const pointId = randomUUID();

    if (!filePointIds.has(fileIdx)) filePointIds.set(fileIdx, []);
    filePointIds.get(fileIdx)!.push(pointId);

    const point: QdrantPoint = {
      id: pointId,
      vector: embedding,
      payload: {
        filePath: chunk.relPath,
        codeChunk: chunk.content,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        pathSegments: buildPathSegments(chunk.relPath),
        indexVisible: false,
      },
    };
    const ownedPoints = filePoints.get(fileIdx) ?? [];
    ownedPoints.push(point);
    filePoints.set(fileIdx, ownedPoints);
  }

  // 4. Journal new-file ownership before any upsert, then publish the whole
  // addition set with coalesced cache checkpoints.
  const additions = files.flatMap((file, fileIndex) => {
    if (priorEntries[fileIndex]) return [];
    const points = filePoints.get(fileIndex) ?? [];
    if (points.length === 0) return [];
    const indexedAt = new Date().toISOString();
    return [
      {
        file,
        points,
        generation: randomUUID(),
        cacheEntry: {
          hash: file.hash,
          pointIds: points.map((point) => point.id),
          indexedAt,
          mtimeMs: file.mtimeMs,
          size: file.size,
        },
        structuralEntry: extractStructuralFile({
          content: file.content,
          absPath: file.absPath,
          relPath: file.relPath,
          workspaceRoot: config.workspaceRoot,
          hash: file.hash,
          indexedAt,
          mtimeMs: file.mtimeMs,
          size: file.size,
        }),
      },
    ];
  });
  if (additions.length > 0) {
    const journalPath = getFileIndexJournalPath(config.cachePath);
    writeFileIndexJournal(journalPath, {
      ...emptyFileIndexJournal(),
      operations: additions.map((addition) => ({
        operationId: randomUUID(),
        file: toJournalPath(addition.file.relPath),
        kind: "replace",
        generation: addition.generation,
        targetHash: addition.file.hash,
        oldPointIds: [],
        intendedBatches: groupPointIds(
          addition.points.map((point) => point.id),
          QDRANT_UPSERT_BATCH,
        ),
      })),
    });
    try {
      const additionPoints = additions.flatMap((addition) => addition.points);
      for (let i = 0; i < additionPoints.length; i += QDRANT_UPSERT_BATCH) {
        if (aborted) break;
        const batch = additionPoints.slice(i, i + QDRANT_UPSERT_BATCH);
        await upsertQdrantPoints(
          config.qdrantUrl,
          config.collectionName,
          batch,
        );
        pointsUpserted += batch.length;
      }
      if (aborted) {
        return {
          filesIndexed,
          chunksCreated,
          pointsUpserted,
          pointsDeleted,
          errors,
          pendingOwnership: true,
        };
      }
      for (const addition of additions) {
        cache.files[addition.file.relPath] = {
          ...addition.cacheEntry,
          generation: addition.generation,
          visibility: "pending",
        };
        structuralCache.files[addition.file.relPath] = {
          ...addition.structuralEntry,
          generation: addition.generation,
          status: "current",
        };
      }
      structuralCache.generatedAt = new Date().toISOString();
      config.checkpoints.scheduleStructural();
      config.checkpoints.checkpointBoth(["vector", "structural"]);
      const additionPointIds = additions.flatMap((addition) =>
        addition.points.map((point) => point.id),
      );
      for (let i = 0; i < additionPointIds.length; i += QDRANT_UPSERT_BATCH) {
        if (aborted) {
          return {
            filesIndexed,
            chunksCreated,
            pointsUpserted,
            pointsDeleted,
            errors,
            pendingOwnership: true,
          };
        }
        await setQdrantPointVisibility(
          config.qdrantUrl,
          config.collectionName,
          additionPointIds.slice(i, i + QDRANT_UPSERT_BATCH),
          true,
        );
        if (aborted) {
          return {
            filesIndexed,
            chunksCreated,
            pointsUpserted,
            pointsDeleted,
            errors,
            pendingOwnership: true,
          };
        }
      }
      for (const addition of additions) {
        cache.files[addition.file.relPath] = {
          ...cache.files[addition.file.relPath],
          visibility: "current",
        };
      }
      config.checkpoints.checkpointVector();
      writeFileIndexJournal(journalPath, emptyFileIndexJournal());
      filesIndexed += additions.length;
    } catch (error) {
      errors.push(`Qdrant upsert failed: ${error}`);
      config.checkpoints.checkpointBoth(["vector", "structural"]);
      return {
        filesIndexed,
        chunksCreated,
        pointsUpserted,
        pointsDeleted,
        errors,
        pendingOwnership: true,
      };
    }
  }

  // 5. Durably replace changed files one at a time.
  for (let i = 0; i < files.length; i++) {
    if (aborted) break;
    const file = files[i];
    const ids = filePointIds.get(i) ?? [];
    const ownedPoints = filePoints.get(i) ?? [];
    const indexedAt = new Date().toISOString();
    const structuralEntry = extractStructuralFile({
      content: file.content,
      absPath: file.absPath,
      relPath: file.relPath,
      workspaceRoot: config.workspaceRoot,
      hash: file.hash,
      indexedAt,
      mtimeMs: file.mtimeMs,
      size: file.size,
    });
    if (ids.length === 0) continue;

    const cacheEntry = {
      hash: file.hash,
      pointIds: ids,
      indexedAt,
      mtimeMs: file.mtimeMs,
      size: file.size,
    };
    const prior = priorEntries[i];
    if (!prior) continue;
    let completedDeletes = 0;
    let completedUpserts = 0;
    try {
      const replacement = await executeJournaledFileReplacement({
        journalPath: getFileIndexJournalPath(config.cachePath),
        replacement: {
          file: toJournalPath(file.relPath),
          generation: randomUUID(),
          targetHash: file.hash,
          oldPointIds: prior.pointIds,
          points: ownedPoints,
          structuralEntry,
          cacheEntry,
        },
        store: createFileReplacementStore({
          cache,
          structuralCache,
          checkpoints: config.checkpoints,
        }),
        remote: {
          async deletePoints(pointIds) {
            await deleteQdrantPoints(
              config.qdrantUrl,
              config.collectionName,
              pointIds,
            );
            completedDeletes += pointIds.length;
          },
          async upsertPoints(replacementPoints) {
            await upsertQdrantPoints(
              config.qdrantUrl,
              config.collectionName,
              replacementPoints,
            );
            completedUpserts += replacementPoints.length;
          },
          setVisibility: (pointIds, visible) =>
            setQdrantPointVisibility(
              config.qdrantUrl,
              config.collectionName,
              pointIds,
              visible,
            ),
        },
        isCancelled: () => aborted,
        createId: randomUUID,
      });
      pointsDeleted += completedDeletes;
      pointsUpserted += completedUpserts;
      if (replacement.committed) filesIndexed++;
    } catch (error) {
      pointsDeleted += completedDeletes;
      pointsUpserted += completedUpserts;
      errors.push(`Qdrant upsert failed: ${error}`);
      return {
        filesIndexed,
        chunksCreated,
        pointsUpserted,
        pointsDeleted,
        errors,
        pendingOwnership: true,
      };
    }
  }
  return {
    filesIndexed,
    chunksCreated,
    pointsUpserted,
    pointsDeleted,
    errors,
    pendingOwnership: false,
  };
}

// --- Main indexing pipeline ---

async function handleStart(msg: StartIndexMessage): Promise<void> {
  await treeSitterReady;
  const startTime = Date.now();
  const errors: string[] = [];
  let filesIndexed = 0;
  let chunksCreated = 0;
  let pointsUpserted = 0;
  let pointsDeleted = 0;
  let checkpoints: CacheCheckpointCoordinator | undefined;

  // Distribute granularity to all chunkers
  setTreeSitterGranularity(msg.granularity);
  setChunkerGranularity(msg.granularity);
  setMarkdownGranularity(msg.granularity);

  try {
    const { path: structuralCachePath, cache: structuralCache } =
      loadWorkerStructuralCache({
        cachePath: msg.cachePath,
        workspaceRoot: msg.workspaceRoot,
        collectionName: msg.collectionName,
      });

    const { cache, resetTarget } = loadWorkerOwnership(
      msg.cachePath,
      msg.force,
    );
    const checkpointCoordinator = createCacheCheckpointCoordinator({
      cachePath: msg.cachePath,
      structuralCachePath,
      cache,
      structuralCache,
    });
    checkpoints = checkpointCoordinator;
    const rebuildRequested =
      msg.force || (cache.granularity ?? "standard") !== msg.granularity;

    // Recovery mutations are idempotent but still require the collection to exist.
    // Rebuilds discard all prior ownership after deleting the collection.
    if (!rebuildRequested && hasDurableIndexOperations(msg.cachePath, cache)) {
      await ensureQdrantCollectionForIndex(msg.qdrantUrl, msg.collectionName);
    }
    const replacementRecovery = rebuildRequested
      ? { cancelled: false, pointsDeleted: 0 }
      : await recoverChangedFileReplacements({
          cachePath: msg.cachePath,
          cache,
          structuralCache,
          qdrantUrl: msg.qdrantUrl,
          collectionName: msg.collectionName,
          checkpoints,
        });
    pointsDeleted += replacementRecovery.pointsDeleted;
    if (replacementRecovery.cancelled) {
      sendComplete({
        filesIndexed,
        totalFilesInIndex: Object.keys(cache.files).length,
        chunksCreated,
        totalChunksInIndex: countCachedChunks(cache),
        pointsUpserted,
        pointsDeleted,
        durationMs: Date.now() - startTime,
        errors,
        cancelled: true,
      });
      return;
    }
    const recovery = rebuildRequested
      ? {
          completed: 0,
          errors: [],
          pointsDeleted: 0,
          cancelled: false,
          pending: false,
        }
      : await removeFilesFromIndex({
          relPaths: [],
          cachePath: msg.cachePath,
          cache,
          structuralCache,
          qdrantUrl: msg.qdrantUrl,
          collectionName: msg.collectionName,
          checkpoints,
        });
    pointsDeleted += recovery.pointsDeleted;
    errors.push(...recovery.errors);
    if (recovery.pending || recovery.cancelled) {
      sendComplete({
        filesIndexed,
        totalFilesInIndex: Object.keys(cache.files).length,
        chunksCreated,
        totalChunksInIndex: countCachedChunks(cache),
        pointsUpserted,
        pointsDeleted,
        durationMs: Date.now() - startTime,
        errors,
        cancelled: recovery.cancelled || undefined,
      });
      return;
    }

    // Force and granularity rebuilds share one durable collection/cache reset.
    if (rebuildRequested) {
      await resetCollectionOwnership({
        cachePath: msg.cachePath,
        cache,
        structuralCache,
        workspaceRoot: msg.workspaceRoot,
        qdrantUrl: msg.qdrantUrl,
        collectionName: msg.collectionName,
        granularity: msg.granularity,
        interruptedTarget: resetTarget,
        checkpoints,
      });
    }

    // Ensure Qdrant collection exists after any reset.
    await ensureQdrantCollectionForIndex(msg.qdrantUrl, msg.collectionName);

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
      sendComplete({
        filesIndexed,
        totalFilesInIndex: Object.keys(cache.files).length,
        chunksCreated,
        totalChunksInIndex: countCachedChunks(cache),
        pointsUpserted,
        pointsDeleted,
        durationMs: Date.now() - startTime,
        errors,
        cancelled: true,
      });
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
        qdrantUrl: msg.qdrantUrl,
        collectionName: msg.collectionName,
        checkpoints,
      });
      pointsDeleted += removal.pointsDeleted;
      errors.push(...removal.errors);
      sendProgress("cleanup", removal.completed, removedRelPaths.length);
      if (removal.pending || removal.cancelled) {
        sendComplete({
          filesIndexed,
          totalFilesInIndex: Object.keys(cache.files).length,
          chunksCreated,
          totalChunksInIndex: countCachedChunks(cache),
          pointsUpserted,
          pointsDeleted,
          durationMs: Date.now() - startTime,
          errors,
          cancelled: removal.cancelled || undefined,
        });
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
      sendComplete({
        filesIndexed: 0,
        totalFilesInIndex: Object.keys(cache.files).length,
        chunksCreated: 0,
        totalChunksInIndex: countCachedChunks(cache),
        pointsUpserted,
        pointsDeleted,
        durationMs: Date.now() - startTime,
        errors,
        cancelled: aborted || undefined,
      });
      return;
    }

    // Phase 2: Process files in batches through the full pipeline
    const totalFiles = toIndexPaths.length;
    const totalBatches = Math.ceil(totalFiles / FILE_BATCH_SIZE);
    const batchConfig: BatchConfig = {
      qdrantUrl: msg.qdrantUrl,
      collectionName: msg.collectionName,
      embeddingBearerToken: msg.embeddingBearerToken,
      cachePath: msg.cachePath,
      workspaceRoot: msg.workspaceRoot,
      granularity: msg.granularity,
      checkpoints,
    };

    for (let batchNum = 0; batchNum < totalBatches; batchNum++) {
      if (aborted) break;

      const batchStart = batchNum * FILE_BATCH_SIZE;
      const batchPaths = toIndexPaths.slice(
        batchStart,
        batchStart + FILE_BATCH_SIZE,
      );

      // Read content for this batch only
      const batchErrors: string[] = [];
      const batchFiles = await measureIndexWorkerPhase(metrics, "read", () =>
        readFilesBatch(batchPaths, batchErrors, {
          cache,
          metrics,
          isCancelled: () => aborted,
          onCacheMetadataChanged: () => checkpointCoordinator.scheduleVector(),
        }),
      );
      errors.push(...batchErrors);

      const retainedBytes = batchFiles.reduce(
        (total, file) => total + file.contentBytes,
        0,
      );
      try {
        if (aborted || batchFiles.length === 0) continue;

        // Process batch through chunk → embed → journaled replacement pipeline
        sendProgress(
          "indexing",
          batchStart,
          totalFiles,
          `batch ${batchNum + 1}/${totalBatches}`,
        );

        const result = await measureIndexWorkerPhase(metrics, "process", () =>
          processFileBatch(batchFiles, batchConfig, cache, structuralCache),
        );
        filesIndexed += result.filesIndexed;
        chunksCreated += result.chunksCreated;
        pointsUpserted += result.pointsUpserted;
        pointsDeleted += result.pointsDeleted;
        errors.push(...result.errors);
        if (result.pendingOwnership) break;
      } finally {
        metrics.contentReleased(retainedBytes);
        sampleHeapUsed();
      }

      // batchFiles, result, and all intermediate arrays are now out of scope
    }

    scheduleCacheMetadataCheckpoint({
      cache,
      granularity: msg.granularity,
      checkpoints,
    });
    checkpoints.drain();

    sendComplete({
      filesIndexed,
      totalFilesInIndex: Object.keys(cache.files).length,
      chunksCreated,
      totalChunksInIndex: countCachedChunks(cache),
      pointsUpserted,
      pointsDeleted,
      durationMs: Date.now() - startTime,
      errors,
      cancelled: aborted || undefined,
    });
  } catch (err) {
    try {
      checkpoints?.drain();
    } catch (checkpointError) {
      sendError(
        `Indexing failed: ${err}; cache checkpoint failed: ${checkpointError}`,
        true,
      );
      return;
    }
    sendError(`Indexing failed: ${err}`, true);
  } finally {
    checkpoints?.cancelScheduled();
  }
}

// --- Incremental update ---

async function handleIncrementalUpdate(
  msg: IncrementalUpdateMessage,
): Promise<void> {
  await treeSitterReady;
  const startTime = Date.now();
  const errors: string[] = [];
  let filesIndexed = 0;
  let chunksCreated = 0;
  let pointsUpserted = 0;
  let pointsDeleted = 0;
  let checkpoints: CacheCheckpointCoordinator | undefined;

  // Distribute granularity to all chunkers
  setTreeSitterGranularity(msg.granularity);
  setChunkerGranularity(msg.granularity);
  setMarkdownGranularity(msg.granularity);

  try {
    const { cache } = loadWorkerOwnership(msg.cachePath, false);
    const { path: structuralCachePath, cache: structuralCache } =
      loadWorkerStructuralCache({
        cachePath: msg.cachePath,
        workspaceRoot: msg.workspaceRoot,
        collectionName: msg.collectionName,
      });
    const checkpointCoordinator = createCacheCheckpointCoordinator({
      cachePath: msg.cachePath,
      structuralCachePath,
      cache,
      structuralCache,
    });
    checkpoints = checkpointCoordinator;
    if (hasDurableIndexOperations(msg.cachePath, cache)) {
      await ensureQdrantCollectionForIndex(msg.qdrantUrl, msg.collectionName);
    }
    const replacementRecovery = await recoverChangedFileReplacements({
      cachePath: msg.cachePath,
      cache,
      structuralCache,
      qdrantUrl: msg.qdrantUrl,
      collectionName: msg.collectionName,
      checkpoints,
    });
    pointsDeleted += replacementRecovery.pointsDeleted;
    if (replacementRecovery.cancelled) {
      sendComplete({
        filesIndexed,
        totalFilesInIndex: Object.keys(cache.files).length,
        chunksCreated,
        totalChunksInIndex: countCachedChunks(cache),
        pointsUpserted,
        pointsDeleted,
        durationMs: Date.now() - startTime,
        errors,
        cancelled: true,
      });
      return;
    }
    const recovery = await removeFilesFromIndex({
      relPaths: [],
      cachePath: msg.cachePath,
      cache,
      structuralCache,
      qdrantUrl: msg.qdrantUrl,
      collectionName: msg.collectionName,
      checkpoints,
    });
    pointsDeleted += recovery.pointsDeleted;
    errors.push(...recovery.errors);
    if (recovery.pending || recovery.cancelled) {
      sendComplete({
        filesIndexed,
        totalFilesInIndex: Object.keys(cache.files).length,
        chunksCreated,
        totalChunksInIndex: countCachedChunks(cache),
        pointsUpserted,
        pointsDeleted,
        durationMs: Date.now() - startTime,
        errors,
        cancelled: recovery.cancelled || undefined,
      });
      return;
    }

    // Handle removed files. Cache ownership is released only after every
    // bounded Qdrant delete batch for that file succeeds.
    const removal = await removeFilesFromIndex({
      relPaths: msg.removed
        .map((absPath) => path.relative(msg.workspaceRoot, absPath))
        .filter(
          (relPath) =>
            relPath !== "" &&
            relPath !== ".." &&
            !relPath.startsWith(`..${path.sep}`) &&
            !path.isAbsolute(relPath),
        ),
      cachePath: msg.cachePath,
      cache,
      structuralCache,
      qdrantUrl: msg.qdrantUrl,
      collectionName: msg.collectionName,
      checkpoints,
    });
    pointsDeleted += removal.pointsDeleted;
    errors.push(...removal.errors);
    if (removal.pending || removal.cancelled) {
      sendComplete({
        filesIndexed,
        totalFilesInIndex: Object.keys(cache.files).length,
        chunksCreated,
        totalChunksInIndex: countCachedChunks(cache),
        pointsUpserted,
        pointsDeleted,
        durationMs: Date.now() - startTime,
        errors,
        cancelled: removal.cancelled || undefined,
      });
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

    // Read and process one bounded batch at a time. Existing ownership remains
    // intact until each replacement intent is durable.
    if (toIndexPaths.length > 0 && !aborted) {
      const batchConfig: BatchConfig = {
        qdrantUrl: msg.qdrantUrl,
        collectionName: msg.collectionName,
        embeddingBearerToken: msg.embeddingBearerToken,
        cachePath: msg.cachePath,
        workspaceRoot: msg.workspaceRoot,
        granularity: msg.granularity,
        checkpoints,
      };

      for (let i = 0; i < toIndexPaths.length; i += FILE_BATCH_SIZE) {
        if (aborted) break;
        const batchErrors: string[] = [];
        const batch = await measureIndexWorkerPhase(metrics, "read", () =>
          readFilesBatch(
            toIndexPaths.slice(i, i + FILE_BATCH_SIZE),
            batchErrors,
            {
              cache,
              metrics,
              isCancelled: () => aborted,
              onCacheMetadataChanged: () =>
                checkpointCoordinator.scheduleVector(),
            },
          ),
        );
        errors.push(...batchErrors);

        const retainedBytes = batch.reduce(
          (total, file) => total + file.contentBytes,
          0,
        );
        try {
          if (aborted || batch.length === 0) continue;
          const result = await measureIndexWorkerPhase(metrics, "process", () =>
            processFileBatch(batch, batchConfig, cache, structuralCache),
          );
          filesIndexed += result.filesIndexed;
          chunksCreated += result.chunksCreated;
          pointsUpserted += result.pointsUpserted;
          pointsDeleted += result.pointsDeleted;
          errors.push(...result.errors);
          if (result.pendingOwnership) break;
        } finally {
          metrics.contentReleased(retainedBytes);
          sampleHeapUsed();
        }
      }
    }

    scheduleCacheMetadataCheckpoint({
      cache,
      granularity: msg.granularity,
      checkpoints,
    });
    checkpoints.drain();

    sendComplete({
      filesIndexed,
      totalFilesInIndex: Object.keys(cache.files).length,
      chunksCreated,
      totalChunksInIndex: countCachedChunks(cache),
      pointsUpserted,
      pointsDeleted,
      durationMs: Date.now() - startTime,
      errors,
      cancelled: aborted || undefined,
    });
  } catch (err) {
    try {
      checkpoints?.drain();
    } catch (checkpointError) {
      sendError(
        `Incremental update failed: ${err}; cache checkpoint failed: ${checkpointError}`,
        true,
      );
      return;
    }
    sendError(`Incremental update failed: ${err}`, true);
  } finally {
    checkpoints?.cancelScheduled();
  }
}

// ============================================================
// OpenAI Embedding API
// ============================================================

/**
 * Split texts into token-aware batches that respect both the count limit
 * (EMBEDDING_BATCH_SIZE) and the token limit (MAX_BATCH_TOKENS).
 */
function buildTokenAwareBatches(
  texts: string[],
  startIdx: number,
): Array<{ startIdx: number; batch: string[] }> {
  const batches: Array<{ startIdx: number; batch: string[] }> = [];
  let i = startIdx;
  while (i < texts.length && batches.length < EMBEDDING_CONCURRENCY) {
    const batch: string[] = [];
    let batchTokens = 0;
    const batchStart = i;
    while (i < texts.length && batch.length < EMBEDDING_BATCH_SIZE) {
      const tokens = estimateTokensFromChars(texts[i].length);
      if (batch.length > 0 && batchTokens + tokens > MAX_BATCH_TOKENS) break;
      batch.push(texts[i]);
      batchTokens += tokens;
      i++;
    }
    if (batch.length > 0) {
      batches.push({ startIdx: batchStart, batch });
    }
  }
  return batches;
}

async function batchEmbed(
  texts: string[],
  bearerToken: string,
  errors: string[],
  onProgress?: (done: number, total: number) => void,
): Promise<(number[] | null)[]> {
  // Truncate oversized texts to fit within the embedding model's context window
  const safeTexts = texts.map((t) =>
    t.length > MAX_EMBEDDING_CHARS ? t.slice(0, MAX_EMBEDDING_CHARS) : t,
  );
  const results: (number[] | null)[] = Array.from<number[] | null>({
    length: safeTexts.length,
  }).fill(null);
  let done = 0;
  let cursor = 0;

  while (cursor < safeTexts.length) {
    if (aborted) break;

    const concurrentBatches = buildTokenAwareBatches(safeTexts, cursor);
    if (concurrentBatches.length === 0) break;

    // Advance cursor past all batches we're about to process
    const lastBatch = concurrentBatches[concurrentBatches.length - 1];
    cursor = lastBatch.startIdx + lastBatch.batch.length;

    const promises = concurrentBatches.map(({ startIdx, batch }) =>
      embedBatchWithRetry(batch, bearerToken)
        .then((vectors) => {
          for (let k = 0; k < vectors.length; k++) {
            results[startIdx + k] = vectors[k];
          }
          done += batch.length;
          onProgress?.(done, safeTexts.length);
        })
        .catch((err) => {
          errors.push(
            `Embedding batch failed (${batch.length} chunks at offset ${startIdx}): ${err}`,
          );
          done += batch.length;
          onProgress?.(done, safeTexts.length);
        }),
    );

    await Promise.all(promises);
  }

  return results;
}

async function embedBatchWithRetry(
  texts: string[],
  bearerToken: string,
  retries = MAX_RETRIES,
): Promise<number[][]> {
  return requestEmbeddings(texts, bearerToken, {
    maxRetries: retries,
    shouldRetryStatus: (status) => status === 429,
    retryDelayMs: (attempt, random) =>
      Math.min(1000 * 2 ** attempt + random * 500, 30000),
    refreshBearerToken: requestEmbeddingAuthRefresh,
    bisectOnBadRequest: true,
    sortByIndex: true,
  });
}

// ============================================================
// Qdrant REST API
// ============================================================

const QDRANT_PAYLOAD_INDEXES: QdrantPayloadIndex[] = [
  { field_name: "filePath", field_schema: "keyword" },
  { field_name: "type", field_schema: "keyword" },
  { field_name: "pathSegments.0", field_schema: "keyword" },
  { field_name: "pathSegments.1", field_schema: "keyword" },
  { field_name: "pathSegments.2", field_schema: "keyword" },
  { field_name: "pathSegments.3", field_schema: "keyword" },
  { field_name: "pathSegments.4", field_schema: "keyword" },
  {
    field_name: "codeChunk",
    field_schema: {
      type: "text",
      tokenizer: "word",
      min_token_len: 2,
      max_token_len: 40,
    },
  },
];

async function ensureQdrantCollectionForIndex(
  qdrantUrl: string,
  collectionName: string,
): Promise<void> {
  metrics.recordOperation("qdrant.ensureCollection");
  await ensureQdrantCollectionRequest({
    qdrantUrl,
    collectionName,
    vectorSize: EMBEDDING_DIM,
    payloadIndexes: QDRANT_PAYLOAD_INDEXES,
  });
}
