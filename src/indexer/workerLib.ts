/**
 * Pure/testable utility functions used by the indexer worker.
 * Extracted here so they can be unit-tested without triggering
 * the worker's IPC side effects.
 *
 * IMPORTANT: No `vscode` imports — must work in the child process.
 */

import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import { createHash } from "crypto";
import { Semaphore } from "../util/Semaphore.js";
import { parseRetrievalFingerprint } from "../core/retrieval/fingerprint.js";
import { writeAtomicJsonFile } from "./atomicJsonFile.js";
import { resolveContainedCodeIndexPath } from "./codeIndexPaths.js";
import type { IndexWorkerMetrics } from "./workerMetrics.js";
import type { IndexCache } from "./types.js";
import {
  STRUCTURAL_GRAPH_CACHE_VERSION,
  type StructuralGraphCache,
} from "./structuralGraph.js";

// --- Constants ---

export const MAX_FILE_SIZE = 1_000_000; // 1MB

/**
 * File extensions worth indexing. Files not matching these are skipped
 * to avoid noise from lock files, binaries-without-nulls, CSVs, etc.
 */
export const INDEXABLE_EXTENSIONS = new Set([
  // Tree-sitter supported
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".rs",
  ".go",
  ".java",
  ".c",
  ".h",
  ".cpp",
  ".hpp",
  ".cc",
  ".cxx",
  ".cs",
  ".rb",
  ".php",
  ".css",
  ".scss",
  ".sh",
  ".bash",
  ".ps1",
  // Markdown
  ".md",
  ".mdx",
  ".markdown",
  // Config/data
  ".json",
  ".yaml",
  ".yml",
  ".toml",
  ".xml",
  ".html",
  ".htm",
  // Other common code
  ".sql",
  ".graphql",
  ".gql",
  ".proto",
  ".tf",
  ".hcl",
  ".svelte",
  ".vue",
  ".astro",
  ".lua",
  ".kt",
  ".kts",
  ".ex",
  ".exs",
  ".elm",
  ".zig",
  ".scala",
  ".swift",
  ".vb",
]);

// --- Binary detection ---

/**
 * Returns true if the content appears to be binary (contains null bytes
 * in the first 512 characters).
 */
export function isBinaryContent(content: string): boolean {
  return content.slice(0, 512).includes("\0");
}

// --- Path segments ---

/**
 * Build an ordered path-segment map from a relative file path.
 * e.g. "src/services/Foo.ts" → { "0": "src", "1": "services", "2": "Foo.ts" }
 */
export function buildPathSegments(relPath: string): Record<string, string> {
  const segments = relPath.split("/").filter(Boolean);
  const result: Record<string, string> = {};
  segments.forEach((seg, idx) => {
    result[String(idx)] = seg;
  });
  return result;
}

// --- Cache I/O ---

export type IndexCacheLoadResult =
  | { status: "missing"; cache: IndexCache }
  | { status: "valid"; cache: IndexCache }
  | { status: "corrupt"; error: string };

export function loadIndexCache(cachePath: string): IndexCacheLoadResult {
  let raw: string;
  try {
    raw = fs.readFileSync(cachePath, "utf-8");
  } catch (error) {
    if (isMissingFile(error)) {
      const entryError = inspectMissingCacheEntry(cachePath);
      return entryError === null
        ? { status: "missing", cache: { version: 1, files: {} } }
        : { status: "corrupt", error: entryError };
    }
    return { status: "corrupt", error: describeError(error) };
  }

  try {
    return { status: "valid", cache: validateIndexCache(JSON.parse(raw)) };
  } catch (error) {
    return { status: "corrupt", error: describeError(error) };
  }
}

export function loadCache(cachePath: string): IndexCache {
  const loaded = loadIndexCache(cachePath);
  return loaded.status === "corrupt" ? { version: 1, files: {} } : loaded.cache;
}

export function writeCache(cachePath: string, cache: IndexCache): number {
  const persisted = {
    ...cache,
    files: Object.fromEntries(
      Object.entries(cache.files).map(([file, entry]) => [
        file,
        {
          ...entry,
          pointIds: [...entry.recordIds],
        },
      ]),
    ),
  };
  writeAtomicJsonFile(cachePath, persisted);
  return Buffer.byteLength(JSON.stringify(persisted), "utf8");
}

function validateIndexCache(value: unknown): IndexCache {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.files)) {
    throw new Error("Unsupported or malformed vector cache");
  }
  if (
    value.granularity !== undefined &&
    value.granularity !== "standard" &&
    value.granularity !== "fine"
  ) {
    throw new Error("Invalid vector cache granularity");
  }

  const files: IndexCache["files"] = {};
  const ownedRecordIds = new Set<string>();
  for (const [file, entry] of Object.entries(value.files)) {
    const recordIds = isRecord(entry)
      ? resolveStringArrayAlias(entry, "recordIds", "pointIds")
      : null;
    if (
      file.length === 0 ||
      !isRecord(entry) ||
      typeof entry.hash !== "string" ||
      entry.hash.length === 0 ||
      !recordIds ||
      recordIds.some((recordId) => recordId.length === 0) ||
      new Set(recordIds).size !== recordIds.length ||
      typeof entry.indexedAt !== "string" ||
      (entry.mtimeMs !== undefined && typeof entry.mtimeMs !== "number") ||
      (entry.size !== undefined && typeof entry.size !== "number") ||
      (entry.generation !== undefined &&
        typeof entry.generation !== "string") ||
      (entry.visibility !== undefined &&
        entry.visibility !== "pending" &&
        entry.visibility !== "current")
    ) {
      throw new Error(`Malformed vector cache entry for ${file || "<empty>"}`);
    }
    if (recordIds.some((recordId) => ownedRecordIds.has(recordId))) {
      throw new Error(
        `Vector cache record IDs have multiple owners at ${file}`,
      );
    }
    for (const recordId of recordIds) ownedRecordIds.add(recordId);
    files[file] = {
      hash: entry.hash,
      recordIds,
      indexedAt: entry.indexedAt,
      ...(entry.mtimeMs !== undefined ? { mtimeMs: entry.mtimeMs } : {}),
      ...(entry.size !== undefined ? { size: entry.size } : {}),
      ...(entry.generation !== undefined
        ? { generation: entry.generation }
        : {}),
      ...(entry.visibility !== undefined
        ? { visibility: entry.visibility }
        : {}),
    };
  }

  return {
    version: 1,
    files,
    ...(value.granularity !== undefined
      ? { granularity: value.granularity }
      : {}),
    ...(value.fingerprint !== undefined
      ? { fingerprint: parseRetrievalFingerprint(value.fingerprint) }
      : {}),
  };
}

export function loadStructuralCache(
  cachePath: string,
  workspaceRoot = "",
): StructuralGraphCache {
  try {
    const raw = fs.readFileSync(cachePath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (
      !isRecord(parsed) ||
      parsed.version !== STRUCTURAL_GRAPH_CACHE_VERSION ||
      typeof parsed.workspaceRoot !== "string" ||
      typeof parsed.generatedAt !== "string" ||
      !isRecord(parsed.files)
    ) {
      return emptyStructuralCache(workspaceRoot);
    }
    const indexName = resolveStringAlias(parsed, "indexName", "collectionName");
    if (indexName === undefined) return emptyStructuralCache(workspaceRoot);
    return {
      version: STRUCTURAL_GRAPH_CACHE_VERSION,
      workspaceRoot: parsed.workspaceRoot,
      ...(indexName ? { indexName } : {}),
      generatedAt: parsed.generatedAt,
      files: parsed.files as StructuralGraphCache["files"],
    };
  } catch {
    return emptyStructuralCache(workspaceRoot);
  }
}

export function writeStructuralCache(
  cachePath: string,
  cache: StructuralGraphCache,
): void {
  writeAtomicJsonFile(cachePath, cache);
}

export function emptyStructuralCache(
  workspaceRoot: string,
  indexName?: string,
): StructuralGraphCache {
  return {
    version: STRUCTURAL_GRAPH_CACHE_VERSION,
    workspaceRoot,
    ...(indexName ? { indexName } : {}),
    generatedAt: new Date(0).toISOString(),
    files: {},
  };
}

function resolveStringAlias(
  value: Record<string, unknown>,
  canonicalKey: string,
  legacyKey: string,
): string | null | undefined {
  const canonical = value[canonicalKey];
  const legacy = value[legacyKey];
  if (
    canonical !== undefined &&
    (typeof canonical !== "string" || canonical.length === 0)
  ) {
    return undefined;
  }
  if (
    legacy !== undefined &&
    (typeof legacy !== "string" || legacy.length === 0)
  ) {
    return undefined;
  }
  if (canonical !== undefined && legacy !== undefined && canonical !== legacy) {
    return undefined;
  }
  return canonical ?? legacy ?? null;
}

function resolveStringArrayAlias(
  value: Record<string, unknown>,
  canonicalKey: string,
  legacyKey: string,
): string[] | null {
  const canonical = value[canonicalKey];
  const legacy = value[legacyKey];
  const isStringArray = (candidate: unknown): candidate is string[] =>
    Array.isArray(candidate) &&
    candidate.every((entry) => typeof entry === "string");
  if (canonical !== undefined && !isStringArray(canonical)) return null;
  if (legacy !== undefined && !isStringArray(legacy)) return null;
  if (canonical === undefined && legacy === undefined) return null;
  if (
    canonical !== undefined &&
    legacy !== undefined &&
    (canonical.length !== legacy.length ||
      canonical.some((entry, index) => entry !== legacy[index]))
  ) {
    return null;
  }
  return [...(canonical ?? legacy ?? [])];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function inspectMissingCacheEntry(cachePath: string): string | null {
  try {
    fs.lstatSync(cachePath);
    return "Vector cache path exists but could not be read";
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

export function getStructuralCachePath(cachePath: string): string {
  const ext = path.extname(cachePath);
  if (!ext) return `${cachePath}.structural.json`;
  return path.join(
    path.dirname(cachePath),
    `${path.basename(cachePath, ext)}.structural${ext}`,
  );
}

// --- File hashing ---

export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

// --- Memory-efficient async scan and read ---

const IO_CONCURRENCY = 10;

type ScanMode = "full" | "incremental";

export interface ScanFilesOptions {
  /** Full scans infer removals and may use cached stat metadata. */
  mode?: ScanMode;
  onProgress?: (scanned: number, total: number) => void;
  metrics?: IndexWorkerMetrics;
  isCancelled?: () => boolean;
}

export interface ScanResult {
  /** Files that need re-indexing (paths only — no content held) */
  toIndexPaths: Array<{ absPath: string; relPath: string }>;
  /** Relative paths absent from a full workspace scan. Always empty incrementally. */
  removedRelPaths: string[];
  /** Relative paths removed or changed and therefore stale in the retrieval store. */
  staleRelPaths: string[];
  /** Whether hash-equal files refreshed cache stat metadata. */
  cacheMetadataChanged: boolean;
  /** Non-fatal errors */
  errors: string[];
}

interface ScanOutcome {
  toIndexPath?: { absPath: string; relPath: string };
  cacheMetadataChanged?: boolean;
  error?: string;
}

interface StableFileRead {
  content: string;
  contentBytes: number;
  stat: fs.Stats;
}

async function readStableFile(
  absPath: string,
  initialStat: fs.Stats,
  isCancelled?: () => boolean,
): Promise<StableFileRead | undefined> {
  let expectedStat = initialStat;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (isCancelled?.()) return undefined;
    if (
      !expectedStat.isFile() ||
      expectedStat.size === 0 ||
      expectedStat.size > MAX_FILE_SIZE
    ) {
      return undefined;
    }

    const handle = await fsp.open(absPath, "r");
    try {
      const preReadStat = await handle.stat();
      if (isCancelled?.()) return undefined;
      if (
        !preReadStat.isFile() ||
        preReadStat.size === 0 ||
        preReadStat.size > MAX_FILE_SIZE
      ) {
        return undefined;
      }

      const buffer = Buffer.allocUnsafe(MAX_FILE_SIZE + 1);
      let contentBytes = 0;
      while (contentBytes < buffer.length) {
        const { bytesRead } = await handle.read(
          buffer,
          contentBytes,
          buffer.length - contentBytes,
          contentBytes,
        );
        if (isCancelled?.()) return undefined;
        if (bytesRead === 0) break;
        contentBytes += bytesRead;
      }
      if (contentBytes === 0 || contentBytes > MAX_FILE_SIZE) return undefined;

      const postReadStat = await handle.stat();
      if (isCancelled?.()) return undefined;
      const pathStat = await fsp.stat(absPath);
      if (isCancelled?.()) return undefined;
      if (
        postReadStat.size === contentBytes &&
        postReadStat.dev === preReadStat.dev &&
        postReadStat.ino === preReadStat.ino &&
        postReadStat.size === preReadStat.size &&
        postReadStat.mtimeMs === preReadStat.mtimeMs &&
        postReadStat.ctimeMs === preReadStat.ctimeMs &&
        pathStat.isFile() &&
        pathStat.size > 0 &&
        pathStat.size <= MAX_FILE_SIZE &&
        pathStat.dev === postReadStat.dev &&
        pathStat.ino === postReadStat.ino &&
        pathStat.size === postReadStat.size &&
        pathStat.mtimeMs === postReadStat.mtimeMs &&
        pathStat.ctimeMs === postReadStat.ctimeMs
      ) {
        return {
          content: buffer.subarray(0, contentBytes).toString("utf8"),
          contentBytes,
          stat: postReadStat,
        };
      }
      expectedStat = pathStat;
    } finally {
      await handle.close();
    }
  }
  return undefined;
}

/**
 * Scan files without retaining their content. Full scans may use stat metadata
 * and infer removals from a complete workspace inventory. Incremental scans
 * always hash watcher candidates and never infer removals from their partial list.
 */
export async function scanFiles(
  files: string[],
  workspaceRoot: string,
  cache: IndexCache,
  options: ScanFilesOptions = {},
): Promise<ScanResult> {
  const mode = options.mode ?? "full";
  const currentFiles = new Set<string>();
  const candidates: Array<{ absPath: string; relPath: string }> = [];
  const candidateRelPaths = new Set<string>();

  for (const candidatePath of files) {
    const identity = resolveContainedCodeIndexPath(
      workspaceRoot,
      candidatePath,
    );
    if (!identity) continue;
    currentFiles.add(identity.relativePath);

    const ext = path.extname(identity.absolutePath).toLowerCase();
    if (ext && !INDEXABLE_EXTENSIONS.has(ext)) continue;
    if (candidateRelPaths.has(identity.relativePath)) continue;
    candidateRelPaths.add(identity.relativePath);
    candidates.push({
      absPath: identity.absolutePath,
      relPath: identity.relativePath,
    });
  }

  let scanned = 0;
  let cursor = 0;
  const outcomes: ScanOutcome[] = Array.from({ length: candidates.length });
  const scanNext = async (): Promise<void> => {
    while (!options.isCancelled?.()) {
      const candidateIndex = cursor++;
      const candidate = candidates[candidateIndex];
      if (!candidate) return;
      const { absPath, relPath } = candidate;
      let readActive = false;
      try {
        options.metrics?.readStarted();
        readActive = true;

        const stat = await fsp.stat(absPath);
        if (options.isCancelled?.()) {
          outcomes[candidateIndex] = {};
          continue;
        }
        if (!stat.isFile() || stat.size > MAX_FILE_SIZE || stat.size === 0) {
          outcomes[candidateIndex] = {};
          continue;
        }

        const cached = cache.files[relPath];
        if (
          mode === "full" &&
          cached?.mtimeMs !== undefined &&
          cached.size !== undefined &&
          cached.mtimeMs === stat.mtimeMs &&
          cached.size === stat.size
        ) {
          outcomes[candidateIndex] = {};
          continue;
        }

        const read = await readStableFile(absPath, stat, options.isCancelled);
        if (!read) {
          outcomes[candidateIndex] = {};
          continue;
        }
        options.metrics?.contentRetained(read.contentBytes);
        try {
          if (isBinaryContent(read.content)) {
            outcomes[candidateIndex] = {};
            continue;
          }

          const hash = hashContent(read.content);
          if (cached?.hash === hash) {
            const cacheMetadataChanged =
              cached.mtimeMs !== read.stat.mtimeMs ||
              cached.size !== read.stat.size;
            cached.mtimeMs = read.stat.mtimeMs;
            cached.size = read.stat.size;
            outcomes[candidateIndex] = { cacheMetadataChanged };
            continue;
          }

          outcomes[candidateIndex] = {
            toIndexPath: { absPath, relPath },
          };
        } finally {
          options.metrics?.contentReleased(read.contentBytes);
        }
      } catch (err) {
        outcomes[candidateIndex] = options.isCancelled?.()
          ? {}
          : { error: `Failed to scan ${relPath}: ${err}` };
      } finally {
        if (readActive) options.metrics?.readFinished();
        scanned++;
        if (scanned % 100 === 0) {
          options.onProgress?.(scanned, candidates.length);
        }
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(IO_CONCURRENCY, candidates.length) }, () =>
      scanNext(),
    ),
  );

  options.onProgress?.(candidates.length, candidates.length);

  const completedOutcomes = outcomes.filter(
    (outcome): outcome is ScanOutcome => outcome !== undefined,
  );
  const toIndexPaths = completedOutcomes.flatMap((outcome) =>
    outcome.toIndexPath ? [outcome.toIndexPath] : [],
  );
  const errors = completedOutcomes.flatMap((outcome) =>
    outcome.error ? [outcome.error] : [],
  );
  const cacheMetadataChanged = completedOutcomes.some(
    (outcome) => outcome.cacheMetadataChanged,
  );
  const removedRelPaths: string[] = [];
  const staleRelPaths: string[] = [];
  const toIndexRelPaths = new Set(toIndexPaths.map((file) => file.relPath));

  for (const relPath of Object.keys(cache.files)) {
    if (mode === "full" && !currentFiles.has(relPath)) {
      removedRelPaths.push(relPath);
      staleRelPaths.push(relPath);
    } else if (toIndexRelPaths.has(relPath)) {
      staleRelPaths.push(relPath);
    }
  }

  return {
    toIndexPaths,
    removedRelPaths,
    staleRelPaths,
    cacheMetadataChanged,
    errors,
  };
}

export interface FileWithContent {
  absPath: string;
  relPath: string;
  content: string;
  contentBytes: number;
  hash: string;
  mtimeMs?: number;
  size?: number;
}

export interface ReadFilesBatchOptions {
  workspaceRoot: string;
  cache?: IndexCache;
  metrics?: IndexWorkerMetrics;
  isCancelled?: () => boolean;
  onCacheMetadataChanged?: () => void;
}

interface ReadOutcome {
  file?: FileWithContent;
  error?: string;
}

/**
 * Read and revalidate one bounded file batch. Results retain content until the
 * caller finishes processing the batch and releases the corresponding metrics.
 */
export async function readFilesBatch(
  paths: Array<{ absPath: string; relPath: string }>,
  errors: string[],
  options: ReadFilesBatchOptions,
): Promise<FileWithContent[]> {
  const semaphore = new Semaphore(IO_CONCURRENCY);
  const outcomes = await Promise.all(
    paths.map(async ({ absPath, relPath }): Promise<ReadOutcome> => {
      const release = await semaphore.acquire();
      let readActive = false;
      try {
        if (options.isCancelled?.()) return {};
        options.metrics?.readStarted();
        readActive = true;

        const identity = resolveContainedCodeIndexPath(
          options.workspaceRoot,
          absPath,
        );
        if (!identity || identity.relativePath !== relPath) {
          throw new Error(
            "Path does not match its canonical workspace identity",
          );
        }

        const stat = await fsp.stat(identity.absolutePath);
        if (options.isCancelled?.()) return {};
        if (!stat.isFile()) return {};
        if (stat.size > MAX_FILE_SIZE || stat.size === 0) return {};

        const read = await readStableFile(
          identity.absolutePath,
          stat,
          options.isCancelled,
        );
        if (!read || isBinaryContent(read.content)) return {};
        const finalIdentity = resolveContainedCodeIndexPath(
          options.workspaceRoot,
          identity.absolutePath,
        );
        if (
          !finalIdentity ||
          finalIdentity.absolutePath !== identity.absolutePath ||
          finalIdentity.relativePath !== identity.relativePath
        ) {
          throw new Error("Path changed its canonical workspace identity");
        }

        const hash = hashContent(read.content);
        const cached = options.cache?.files[relPath];
        if (cached?.hash === hash) {
          const cacheMetadataChanged =
            cached.mtimeMs !== read.stat.mtimeMs ||
            cached.size !== read.stat.size;
          cached.mtimeMs = read.stat.mtimeMs;
          cached.size = read.stat.size;
          if (cacheMetadataChanged) options.onCacheMetadataChanged?.();
          return {};
        }

        options.metrics?.contentRetained(read.contentBytes);
        return {
          file: {
            absPath: identity.absolutePath,
            relPath: identity.relativePath,
            content: read.content,
            contentBytes: read.contentBytes,
            hash,
            mtimeMs: read.stat.mtimeMs,
            size: read.stat.size,
          },
        };
      } catch (err) {
        if (options.isCancelled?.()) return {};
        return { error: `Failed to read ${relPath}: ${err}` };
      } finally {
        if (readActive) options.metrics?.readFinished();
        release();
      }
    }),
  );

  errors.push(
    ...outcomes.flatMap((outcome) => (outcome.error ? [outcome.error] : [])),
  );
  return outcomes.flatMap((outcome) => (outcome.file ? [outcome.file] : []));
}
