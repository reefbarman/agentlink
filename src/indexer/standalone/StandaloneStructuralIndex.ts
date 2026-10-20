// Standalone structural index: a lightweight JSON store shared by every
// standalone surface (CLI, Desktop, Assistant runners) on one checkout.
// IMPORTANT: No `vscode` or LanceDB imports (see standaloneBoundary.test.ts).

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { canonicalizePath } from "../../util/canonicalPath.js";
import { writeAtomicJsonFile } from "../atomicJsonFile.js";
import {
  CODE_INDEX_WRITER_BUSY_ERROR,
  acquireCodeIndexWriterLease,
  releaseCodeIndexWriterLease,
  renewCodeIndexWriterLease,
  withCodeIndexWriterFence,
  type CodeIndexWriterLease,
} from "../codeIndexWriterLease.js";
import {
  STRUCTURAL_EXTRACTOR_VERSION,
  extractStructuralFile,
  refreshStructuralAliasLinks,
} from "../structuralExtractor.js";
import {
  STRUCTURAL_GRAPH_CACHE_VERSION,
  type StructuralFileEntry,
  type StructuralGraphCache,
} from "../structuralGraph.js";
import { createTsconfigPathResolver } from "../tsconfigPaths.js";
import {
  INDEXABLE_EXTENSIONS,
  MAX_FILE_SIZE,
  hashContent,
  isBinaryContent,
} from "../workerLib.js";

export const STANDALONE_STRUCTURAL_STORE_VERSION = 1;
const LEASE_PROTOCOL = "structural-v1";
const DEFAULT_MAX_FILES = 20_000;
const DEFAULT_WAIT_FOR_WRITER_MS = 10_000;
const RECONCILE_THROTTLE_MS = 1_000;
const RENEW_EVERY_MS = 4_000;
const GIT_TIMEOUT_MS = 20_000;
const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;
/** Directories the walk fallback never enters (git listings use .gitignore). */
const WALK_SKIP = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  "target",
  "vendor",
  ".next",
  ".turbo",
  ".cache",
  ".venv",
  "__pycache__",
]);

/** The published snapshot: the shared graph format plus store metadata. */
export interface StandaloneStructuralSnapshot extends StructuralGraphCache {
  readonly storeVersion: typeof STANDALONE_STRUCTURAL_STORE_VERSION;
  readonly extractorVersion: number;
  readonly generation: string;
  /** More candidate files than `maxFiles`; the map covers a subset. */
  readonly partial?: boolean;
  /** Candidates that could not be extracted (binary, unreadable). */
  readonly skipped?: Record<string, FileStamp>;
}

interface FileStamp {
  readonly size?: number;
  readonly mtimeMs?: number;
}

export type StandaloneStructuralState =
  /** The snapshot matches the files on disk. */
  | "fresh"
  /** Another writer is rebuilding; this is the last published snapshot. */
  | "stale";

export interface StandaloneStructuralReadResult {
  readonly graph: StructuralGraphCache;
  readonly state: StandaloneStructuralState;
  readonly generation: string;
  readonly partial: boolean;
  /** Snapshot directory (shared by every client of this checkout). */
  readonly storePath: string;
  readonly indexName: string;
}

export interface StandaloneStructuralIndexOptions {
  readonly projectRoot: string;
  /** Shared per-user (or per-task) root; the store lives under it. */
  readonly indexRoot: string;
  readonly maxFiles?: number;
  /** How long a client waits for another writer before serving stale. */
  readonly waitForWriterMs?: number;
  /** Test seams. */
  readonly listFiles?: (root: string) => Promise<string[] | undefined>;
  readonly now?: () => number;
}

interface Candidate {
  readonly relPath: string;
  readonly size: number;
  readonly mtimeMs: number;
}

/**
 * One checkout's structural index. Any number of processes may hold one for
 * the same checkout: they read the published snapshot freely, and the one
 * that wins the fenced writer lease rebuilds changed files and publishes a
 * new generation. A client that loses the race waits briefly, then serves
 * the last snapshot marked stale.
 */
export class StandaloneStructuralIndex {
  readonly workspaceRoot: string;
  readonly indexName: string;
  readonly storePath: string;
  private readonly snapshotPath: string;
  private readonly leaseRoot: string;
  private readonly ownerId = `${process.pid}-${randomUUID()}`;
  private readonly maxFiles: number;
  private readonly waitForWriterMs: number;
  private readonly listFiles: (root: string) => Promise<string[] | undefined>;
  private readonly now: () => number;
  private inFlight: Promise<StandaloneStructuralReadResult> | undefined;
  private lastFresh:
    | { at: number; result: StandaloneStructuralReadResult }
    | undefined;
  private disposed = false;

  constructor(options: StandaloneStructuralIndexOptions) {
    this.workspaceRoot = canonicalizePath(options.projectRoot);
    this.indexName = createHash("sha256")
      .update(this.workspaceRoot)
      .digest("hex")
      .slice(0, 24);
    this.storePath = path.join(
      options.indexRoot,
      `structural-v${STANDALONE_STRUCTURAL_STORE_VERSION}`,
      this.indexName,
    );
    this.snapshotPath = path.join(this.storePath, "snapshot.json");
    this.leaseRoot = path.join(this.storePath, "writer");
    this.maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
    this.waitForWriterMs =
      options.waitForWriterMs ?? DEFAULT_WAIT_FOR_WRITER_MS;
    this.listFiles = options.listFiles ?? listGitFiles;
    this.now = options.now ?? Date.now;
  }

  /** The current graph, refreshed from disk when files changed. */
  async read(signal?: AbortSignal): Promise<StandaloneStructuralReadResult> {
    if (this.disposed) throw new Error("structural_index_disposed");
    const recent = this.lastFresh;
    if (recent && this.now() - recent.at < RECONCILE_THROTTLE_MS) {
      return recent.result;
    }
    // Concurrent callers in this process share one reconciliation.
    this.inFlight ??= this.reconcile(signal).finally(() => {
      this.inFlight = undefined;
    });
    return await this.inFlight;
  }

  dispose(): void {
    this.disposed = true;
  }

  private async reconcile(
    signal?: AbortSignal,
  ): Promise<StandaloneStructuralReadResult> {
    const discovered = await this.discover();
    const published = this.loadSnapshot();
    if (published && !hasChanges(published, discovered.candidates)) {
      return this.remember(published, "fresh");
    }
    let lease: CodeIndexWriterLease;
    try {
      lease = await acquireCodeIndexWriterLease({
        storeRoot: this.leaseRoot,
        workspaceScopeId: this.indexName,
        ownerId: this.ownerId,
        protocolVersion: LEASE_PROTOCOL,
      });
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.message !== CODE_INDEX_WRITER_BUSY_ERROR
      ) {
        throw error;
      }
      return await this.waitForWriter(published, signal);
    }
    try {
      // Another writer may have published while this client waited.
      const base = this.loadSnapshot();
      const next = await this.build(base, discovered, lease, signal);
      await withCodeIndexWriterFence(lease, async () => {
        writeAtomicJsonFile(this.snapshotPath, next);
      });
      return this.remember(next, "fresh");
    } finally {
      await releaseCodeIndexWriterLease(lease).catch(() => undefined);
    }
  }

  private async waitForWriter(
    published: StandaloneStructuralSnapshot | undefined,
    signal?: AbortSignal,
  ): Promise<StandaloneStructuralReadResult> {
    const deadline = this.now() + this.waitForWriterMs;
    while (this.now() < deadline && !signal?.aborted) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      const current = this.loadSnapshot();
      if (current && current.generation !== published?.generation) {
        return this.remember(current, "fresh");
      }
    }
    if (published) return this.result(published, "stale");
    return this.result(this.emptySnapshot(), "stale");
  }

  private async build(
    base: StandaloneStructuralSnapshot | undefined,
    discovered: { candidates: Candidate[]; partial: boolean },
    lease: CodeIndexWriterLease,
    signal?: AbortSignal,
  ): Promise<StandaloneStructuralSnapshot> {
    const previous = base?.files ?? {};
    const previousSkipped = base?.skipped ?? {};
    const current = new Map(
      discovered.candidates.map((candidate) => [candidate.relPath, candidate]),
    );
    const removed = Object.keys(previous).filter((rel) => !current.has(rel));
    const added = discovered.candidates.filter(
      (c) => !previous[c.relPath] && !previousSkipped[c.relPath],
    );
    const toExtract = new Set(
      discovered.candidates
        .filter((candidate) => {
          const stamp =
            previous[candidate.relPath] ?? previousSkipped[candidate.relPath];
          return !sameStamp(stamp, candidate);
        })
        .map((candidate) => candidate.relPath),
    );
    // Relative imports resolve against which files exist, so importers of
    // added or removed files are resolved again.
    if (added.length > 0 || removed.length > 0) {
      const removedSet = new Set(removed);
      for (const [rel, entry] of Object.entries(previous)) {
        if (!current.has(rel) || toExtract.has(rel)) continue;
        if (needsReresolution(entry, removedSet)) toExtract.add(rel);
      }
    }
    const files: Record<string, StructuralFileEntry> = {};
    const skipped: Record<string, FileStamp> = {};
    for (const [rel, entry] of Object.entries(previous)) {
      if (current.has(rel) && !toExtract.has(rel)) files[rel] = entry;
    }
    for (const [rel, stamp] of Object.entries(previousSkipped)) {
      if (current.has(rel) && !toExtract.has(rel)) skipped[rel] = stamp;
    }
    const pathResolver = createTsconfigPathResolver(this.workspaceRoot);
    let renewedAt = this.now();
    for (const rel of toExtract) {
      if (signal?.aborted || this.disposed) {
        throw new Error("structural_index_cancelled");
      }
      if (this.now() - renewedAt > RENEW_EVERY_MS) {
        await renewCodeIndexWriterLease(lease);
        renewedAt = this.now();
      }
      const candidate = current.get(rel)!;
      const entry = await this.extract(candidate, pathResolver);
      if (entry) files[rel] = entry;
      else skipped[rel] = { size: candidate.size, mtimeMs: candidate.mtimeMs };
    }
    return {
      version: STRUCTURAL_GRAPH_CACHE_VERSION,
      storeVersion: STANDALONE_STRUCTURAL_STORE_VERSION,
      extractorVersion: STRUCTURAL_EXTRACTOR_VERSION,
      workspaceRoot: this.workspaceRoot,
      indexName: this.indexName,
      generation: randomUUID(),
      generatedAt: new Date(this.now()).toISOString(),
      files,
      ...(Object.keys(skipped).length > 0 ? { skipped } : {}),
      ...(discovered.partial ? { partial: true } : {}),
    };
  }

  private async extract(
    candidate: Candidate,
    pathResolver: ReturnType<typeof createTsconfigPathResolver>,
  ): Promise<StructuralFileEntry | undefined> {
    const absPath = path.join(this.workspaceRoot, candidate.relPath);
    let content: string;
    try {
      content = await fs.promises.readFile(absPath, "utf8");
    } catch {
      return undefined;
    }
    if (isBinaryContent(content)) return undefined;
    try {
      return extractStructuralFile({
        content,
        absPath,
        relPath: candidate.relPath,
        workspaceRoot: this.workspaceRoot,
        hash: hashContent(content),
        indexedAt: new Date(this.now()).toISOString(),
        size: candidate.size,
        mtimeMs: candidate.mtimeMs,
        pathResolver,
      });
    } catch {
      return undefined;
    }
  }

  /**
   * Candidate files: git's tracked and untracked-not-ignored files, or a
   * bounded walk outside git. Only regular files are kept, so symlinks
   * (and anything they point at) are never indexed.
   */
  private async discover(): Promise<{
    candidates: Candidate[];
    partial: boolean;
  }> {
    const listed =
      (await this.listFiles(this.workspaceRoot)) ??
      (await walkFiles(this.workspaceRoot, this.maxFiles * 4));
    const relPaths = [...new Set(listed.map(normalizeRelPath))]
      .filter(
        (rel) =>
          rel &&
          !rel.startsWith("../") &&
          INDEXABLE_EXTENSIONS.has(path.extname(rel).toLowerCase()),
      )
      .sort();
    const partial = relPaths.length > this.maxFiles;
    const candidates: Candidate[] = [];
    for (const rel of relPaths.slice(0, this.maxFiles)) {
      try {
        const stat = await fs.promises.lstat(
          path.join(this.workspaceRoot, rel),
        );
        if (!stat.isFile() || stat.size > MAX_FILE_SIZE) continue;
        candidates.push({
          relPath: rel,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        });
      } catch {
        // Listed but gone: treated as removed.
      }
    }
    return { candidates, partial };
  }

  private loadSnapshot(): StandaloneStructuralSnapshot | undefined {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(this.snapshotPath, "utf8"));
    } catch {
      return undefined;
    }
    if (!parsed || typeof parsed !== "object") return undefined;
    const snapshot = parsed as Partial<StandaloneStructuralSnapshot>;
    if (
      snapshot.storeVersion !== STANDALONE_STRUCTURAL_STORE_VERSION ||
      snapshot.version !== STRUCTURAL_GRAPH_CACHE_VERSION ||
      snapshot.extractorVersion !== STRUCTURAL_EXTRACTOR_VERSION ||
      snapshot.workspaceRoot !== this.workspaceRoot ||
      typeof snapshot.generation !== "string" ||
      !snapshot.files ||
      typeof snapshot.files !== "object"
    ) {
      // Incompatible or foreign: ignored and replaced by the next build.
      return undefined;
    }
    return snapshot as StandaloneStructuralSnapshot;
  }

  private emptySnapshot(): StandaloneStructuralSnapshot {
    return {
      version: STRUCTURAL_GRAPH_CACHE_VERSION,
      storeVersion: STANDALONE_STRUCTURAL_STORE_VERSION,
      extractorVersion: STRUCTURAL_EXTRACTOR_VERSION,
      workspaceRoot: this.workspaceRoot,
      indexName: this.indexName,
      generation: "none",
      generatedAt: new Date(0).toISOString(),
      files: {},
    };
  }

  private remember(
    snapshot: StandaloneStructuralSnapshot,
    state: StandaloneStructuralState,
  ): StandaloneStructuralReadResult {
    const result = this.result(snapshot, state);
    this.lastFresh = { at: this.now(), result };
    return result;
  }

  private result(
    snapshot: StandaloneStructuralSnapshot,
    state: StandaloneStructuralState,
  ): StandaloneStructuralReadResult {
    return {
      // Re-resolve tsconfig aliases so config-only edits show at once.
      graph: refreshStructuralAliasLinks({
        version: STRUCTURAL_GRAPH_CACHE_VERSION,
        workspaceRoot: snapshot.workspaceRoot,
        indexName: this.indexName,
        generatedAt: snapshot.generatedAt,
        files: snapshot.files,
      }),
      state,
      generation: snapshot.generation,
      partial: snapshot.partial === true,
      storePath: this.storePath,
      indexName: this.indexName,
    };
  }
}

function hasChanges(
  snapshot: StandaloneStructuralSnapshot,
  candidates: readonly Candidate[],
): boolean {
  const skipped = snapshot.skipped ?? {};
  const known =
    Object.keys(snapshot.files).length + Object.keys(skipped).length;
  // A count mismatch means a file was removed (additions fail the stamp).
  if (known !== candidates.length) return true;
  return candidates.some(
    (candidate) =>
      !sameStamp(
        snapshot.files[candidate.relPath] ?? skipped[candidate.relPath],
        candidate,
      ),
  );
}

function sameStamp(stamp: FileStamp | undefined, candidate: Candidate) {
  return (
    stamp !== undefined &&
    stamp.size === candidate.size &&
    stamp.mtimeMs === candidate.mtimeMs
  );
}

function needsReresolution(
  entry: StructuralFileEntry,
  removed: ReadonlySet<string>,
): boolean {
  const relative = (specifier: string | undefined) =>
    specifier !== undefined &&
    (specifier.startsWith("./") || specifier.startsWith("../"));
  return (
    entry.imports.some(
      (item) =>
        relative(item.specifier) &&
        (!item.resolvedRelPath || removed.has(item.resolvedRelPath)),
    ) ||
    entry.exports.some(
      (item) =>
        relative(item.source) &&
        (!item.resolvedRelPath || removed.has(item.resolvedRelPath)),
    )
  );
}

function normalizeRelPath(relPath: string): string {
  return path.posix
    .normalize(relPath.replaceAll("\\", "/"))
    .replace(/^\.\//u, "");
}

/** Tracked plus untracked-not-ignored files, or undefined outside git. */
export function listGitFiles(root: string): Promise<string[] | undefined> {
  return new Promise((resolve) => {
    // A minimal environment: no host credentials reach the git child.
    const child = spawn(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      {
        cwd: root,
        stdio: ["ignore", "pipe", "ignore"],
        env: {
          ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
          GIT_OPTIONAL_LOCKS: "0",
        },
        timeout: GIT_TIMEOUT_MS,
      },
    );
    const chunks: Buffer[] = [];
    let bytes = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_GIT_OUTPUT_BYTES) {
        child.kill();
        return;
      }
      chunks.push(chunk);
    });
    child.on("error", () => resolve(undefined));
    child.on("close", (code) => {
      if (code !== 0 || bytes > MAX_GIT_OUTPUT_BYTES) {
        resolve(undefined);
        return;
      }
      resolve(
        Buffer.concat(chunks).toString("utf8").split("\0").filter(Boolean),
      );
    });
  });
}

/** A bounded walk that never follows symlinks or enters WALK_SKIP. */
async function walkFiles(root: string, limit: number): Promise<string[]> {
  const files: string[] = [];
  const pending = [""];
  while (pending.length > 0 && files.length < limit) {
    const relDir = pending.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(path.join(root, relDir), {
        withFileTypes: true,
      });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!WALK_SKIP.has(entry.name)) pending.push(rel);
      } else if (entry.isFile()) {
        files.push(rel);
        if (files.length >= limit) break;
      }
    }
  }
  return files;
}
