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
import { writeAtomicJsonFile } from "./atomicJsonFile.js";
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
 * Build a Qdrant-compatible pathSegments map from a relative file path.
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

export function writeCache(cachePath: string, cache: IndexCache): void {
  writeAtomicJsonFile(cachePath, cache);
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
  const ownedPointIds = new Set<string>();
  for (const [file, entry] of Object.entries(value.files)) {
    if (
      file.length === 0 ||
      !isRecord(entry) ||
      typeof entry.hash !== "string" ||
      entry.hash.length === 0 ||
      !Array.isArray(entry.pointIds) ||
      entry.pointIds.some(
        (pointId) => typeof pointId !== "string" || pointId.length === 0,
      ) ||
      new Set(entry.pointIds).size !== entry.pointIds.length ||
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
    if (entry.pointIds.some((pointId) => ownedPointIds.has(pointId))) {
      throw new Error(`Vector cache point IDs have multiple owners at ${file}`);
    }
    for (const pointId of entry.pointIds) ownedPointIds.add(pointId);
    files[file] = {
      hash: entry.hash,
      pointIds: [...entry.pointIds],
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
  };
}

export function loadStructuralCache(
  cachePath: string,
  workspaceRoot = "",
): StructuralGraphCache {
  try {
    const raw = fs.readFileSync(cachePath, "utf-8");
    const parsed = JSON.parse(raw) as StructuralGraphCache;
    if (parsed.version === STRUCTURAL_GRAPH_CACHE_VERSION && parsed.files) {
      return parsed;
    }
  } catch {
    // Missing or corrupt — start fresh
  }
  return emptyStructuralCache(workspaceRoot);
}

export function writeStructuralCache(
  cachePath: string,
  cache: StructuralGraphCache,
): void {
  writeAtomicJsonFile(cachePath, cache);
}

export function emptyStructuralCache(
  workspaceRoot: string,
  collectionName?: string,
): StructuralGraphCache {
  return {
    version: STRUCTURAL_GRAPH_CACHE_VERSION,
    workspaceRoot,
    ...(collectionName ? { collectionName } : {}),
    generatedAt: new Date(0).toISOString(),
    files: {},
  };
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

// --- Incremental diff ---

export interface DiffResult {
  /** Files that are new or changed (need re-indexing) */
  toIndex: Array<{
    absPath: string;
    relPath: string;
    content: string;
    hash: string;
  }>;
  /** Non-fatal errors encountered during file reading */
  errors: string[];
}

const IO_CONCURRENCY = 10;

/**
 * Given a list of file paths and the current cache, determine which files
 * need indexing and which can be skipped.
 */
export function diffFiles(
  files: string[],
  workspaceRoot: string,
  cache: IndexCache,
  metrics?: IndexWorkerMetrics,
): DiffResult {
  const toIndex: DiffResult["toIndex"] = [];
  const errors: string[] = [];

  for (let fi = 0; fi < files.length; fi++) {
    const absPath = files[fi];
    // Skip paths outside the workspace (e.g. Windows paths on WSL)
    if (!absPath.startsWith(workspaceRoot)) continue;

    const relPath = path.relative(workspaceRoot, absPath);

    // Safety: skip if relative path escapes the workspace
    if (relPath.startsWith("..")) continue;

    // Skip files with non-indexable extensions
    const ext = path.extname(absPath).toLowerCase();
    if (ext && !INDEXABLE_EXTENSIONS.has(ext)) continue;

    let readActive = false;
    try {
      const stat = fs.statSync(absPath);
      if (!stat.isFile()) continue;
      if (stat.size > MAX_FILE_SIZE || stat.size === 0) continue;

      metrics?.readStarted();
      readActive = true;
      const content = fs.readFileSync(absPath, "utf-8");
      if (isBinaryContent(content)) continue;

      const hash = hashContent(content);

      // Skip if cached and unchanged
      const cached = cache.files[relPath];
      if (cached && cached.hash === hash) continue;

      metrics?.contentRetained(Buffer.byteLength(content, "utf8"));
      toIndex.push({ absPath, relPath, content, hash });
    } catch (err) {
      errors.push(`Failed to read ${relPath}: ${err}`);
    } finally {
      if (readActive) metrics?.readFinished();
    }
  }

  return { toIndex, errors };
}

// --- Memory-efficient scan (for large codebases) ---

export interface ScanResult {
  /** Files that need re-indexing (paths only — no content held) */
  toIndexPaths: Array<{ absPath: string; relPath: string }>;
  /** Relative paths absent from the workspace and safe for removed-file cleanup. */
  removedRelPaths: string[];
  /** Relative paths removed or changed and therefore stale in Qdrant. */
  staleRelPaths: string[];
  /** Non-fatal errors */
  errors: string[];
}

/**
 * Scan all files to determine which need indexing, without retaining content.
 *
 * Uses a two-tier skip strategy to minimize I/O on large codebases:
 * 1. **Stat-based fast skip**: if mtime and size match the cache, skip without reading.
 * 2. **Hash-based skip**: if stat changed, read + hash to check for actual content change.
 *
 * Uses async I/O with concurrency limiting (like Roo-Code's pLimit approach)
 * to avoid blocking the event loop and saturating CPU.
 */
export async function scanFiles(
  files: string[],
  workspaceRoot: string,
  cache: IndexCache,
  onProgress?: (scanned: number, total: number) => void,
  metrics?: IndexWorkerMetrics,
): Promise<ScanResult> {
  const toIndexPaths: ScanResult["toIndexPaths"] = [];
  const errors: string[] = [];
  const currentFiles = new Set<string>();

  // Phase 1: Quick synchronous filtering (no I/O) — build candidate list
  const candidates: Array<{ absPath: string; relPath: string }> = [];
  for (const absPath of files) {
    if (!absPath.startsWith(workspaceRoot)) continue;
    const relPath = path.relative(workspaceRoot, absPath);
    if (relPath.startsWith("..")) continue;
    currentFiles.add(relPath);

    const ext = path.extname(absPath).toLowerCase();
    if (ext && !INDEXABLE_EXTENSIONS.has(ext)) continue;
    candidates.push({ absPath, relPath });
  }

  // Phase 2: Async I/O with concurrency limiting
  const semaphore = new Semaphore(IO_CONCURRENCY);
  let scanned = 0;

  const scanPromises = candidates.map(async ({ absPath, relPath }) => {
    const release = await semaphore.acquire();
    try {
      metrics?.readStarted();
      const stat = await fsp.stat(absPath);
      if (!stat.isFile()) return;
      if (stat.size > MAX_FILE_SIZE || stat.size === 0) return;

      // Fast path: stat-based skip
      const cached = cache.files[relPath];
      if (
        cached &&
        cached.mtimeMs !== undefined &&
        cached.size !== undefined &&
        cached.mtimeMs === stat.mtimeMs &&
        cached.size === stat.size
      ) {
        return;
      }

      // Slow path: read + hash
      const content = await fsp.readFile(absPath, "utf-8");
      const contentBytes = Buffer.byteLength(content, "utf8");
      metrics?.contentRetained(contentBytes);
      try {
        if (isBinaryContent(content)) return;

        const hash = hashContent(content);

        if (cached && cached.hash === hash) {
          cached.mtimeMs = stat.mtimeMs;
          cached.size = stat.size;
          return;
        }

        toIndexPaths.push({ absPath, relPath });
      } finally {
        metrics?.contentReleased(contentBytes);
      }
    } catch (err) {
      errors.push(`Failed to scan ${relPath}: ${err}`);
    } finally {
      metrics?.readFinished();
      try {
        scanned++;
        if (scanned % 100 === 0) {
          onProgress?.(scanned, candidates.length);
        }
      } finally {
        release();
      }
    }
  });

  await Promise.all(scanPromises);
  onProgress?.(candidates.length, candidates.length);

  // Phase 3: Find stale files
  const removedRelPaths: string[] = [];
  const staleRelPaths: string[] = [];
  const toIndexRelPaths = new Set(toIndexPaths.map((f) => f.relPath));
  for (const relPath of Object.keys(cache.files)) {
    if (!currentFiles.has(relPath)) {
      removedRelPaths.push(relPath);
      staleRelPaths.push(relPath);
    } else if (toIndexRelPaths.has(relPath)) {
      staleRelPaths.push(relPath);
    }
  }

  return { toIndexPaths, removedRelPaths, staleRelPaths, errors };
}

export interface FileWithContent {
  absPath: string;
  relPath: string;
  content: string;
  hash: string;
  mtimeMs?: number;
  size?: number;
}

/**
 * Read content for a batch of file paths. Used after scanFiles() to
 * load only the files needed for the current processing batch.
 * Uses async I/O with concurrency limiting to avoid CPU saturation.
 */
export async function readFilesBatch(
  paths: Array<{ absPath: string; relPath: string }>,
  errors: string[],
  metrics?: IndexWorkerMetrics,
): Promise<FileWithContent[]> {
  const result: FileWithContent[] = [];
  const semaphore = new Semaphore(IO_CONCURRENCY);

  const promises = paths.map(async ({ absPath, relPath }) => {
    const release = await semaphore.acquire();
    try {
      metrics?.readStarted();
      const stat = await fsp.stat(absPath);
      const content = await fsp.readFile(absPath, "utf-8");
      const hash = hashContent(content);
      metrics?.contentRetained(Buffer.byteLength(content, "utf8"));
      result.push({
        absPath,
        relPath,
        content,
        hash,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
      });
    } catch (err) {
      errors.push(`Failed to read ${relPath}: ${err}`);
    } finally {
      metrics?.readFinished();
      release();
    }
  });

  await Promise.all(promises);
  return result;
}
