import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  MAX_FILE_SIZE,
  buildPathSegments,
  emptyStructuralCache,
  getStructuralCachePath,
  hashContent,
  isBinaryContent,
  loadCache,
  loadIndexCache,
  loadStructuralCache,
  readFilesBatch,
  scanFiles,
  writeCache,
  writeStructuralCache,
} from "./workerLib.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { IndexCache } from "./types.js";
import type { StructuralGraphCache } from "./structuralGraph.js";
import { createCodeIndexFingerprint } from "./retrievalFingerprint.js";
import { createIndexWorkerMetrics } from "./workerMetrics.js";

const ioMocks = vi.hoisted(() => ({
  stat: vi.fn<typeof import("fs/promises").stat>(),
  readFile: vi.fn<typeof import("fs/promises").readFile>(),
  open: vi.fn<typeof import("fs/promises").open>(),
  actualStat: undefined as typeof import("fs/promises").stat | undefined,
  actualReadFile: undefined as
    | typeof import("fs/promises").readFile
    | undefined,
  actualOpen: undefined as typeof import("fs/promises").open | undefined,
}));

vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs/promises")>();
  ioMocks.actualStat = actual.stat;
  ioMocks.actualReadFile = actual.readFile;
  ioMocks.actualOpen = actual.open;
  ioMocks.stat.mockImplementation(actual.stat);
  ioMocks.readFile.mockImplementation(actual.readFile);
  ioMocks.open.mockImplementation(actual.open);
  return {
    ...actual,
    default: {
      ...actual,
      stat: ioMocks.stat,
      readFile: ioMocks.readFile,
      open: ioMocks.open,
    },
    stat: ioMocks.stat,
    readFile: ioMocks.readFile,
    open: ioMocks.open,
  };
});

// --- isBinaryContent ---

describe("isBinaryContent", () => {
  it("returns false for normal text", () => {
    expect(isBinaryContent("hello world\nfoo bar")).toBe(false);
  });

  it("returns true for content with null bytes in first 512 chars", () => {
    expect(isBinaryContent("hello\0world")).toBe(true);
  });

  it("returns false for null bytes after position 512", () => {
    const content = "x".repeat(513) + "\0rest";
    expect(isBinaryContent(content)).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isBinaryContent("")).toBe(false);
  });
});

// --- buildPathSegments ---

describe("buildPathSegments", () => {
  it("splits a simple path into indexed segments", () => {
    expect(buildPathSegments("src/services/Foo.ts")).toEqual({
      "0": "src",
      "1": "services",
      "2": "Foo.ts",
    });
  });

  it("handles a single filename (no directory)", () => {
    expect(buildPathSegments("README.md")).toEqual({
      "0": "README.md",
    });
  });

  it("handles deeply nested paths", () => {
    const result = buildPathSegments("a/b/c/d/e.ts");
    expect(Object.keys(result)).toHaveLength(5);
    expect(result["0"]).toBe("a");
    expect(result["4"]).toBe("e.ts");
  });

  it("filters out empty segments from leading slashes", () => {
    // filter(Boolean) removes empty strings from split
    const result = buildPathSegments("/src/file.ts");
    expect(result).toEqual({ "0": "src", "1": "file.ts" });
  });
});

// --- hashContent ---

describe("hashContent", () => {
  it("returns a hex SHA-256 hash", () => {
    const hash = hashContent("hello");
    // SHA-256 of "hello" is well-known
    expect(hash).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });

  it("returns different hashes for different content", () => {
    expect(hashContent("a")).not.toBe(hashContent("b"));
  });

  it("returns consistent hash for same content", () => {
    expect(hashContent("test")).toBe(hashContent("test"));
  });
});

// --- loadCache / writeCache ---

describe("loadCache / writeCache", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "workerlib-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty cache when file does not exist", () => {
    const cache = loadCache(path.join(tmpDir, "nonexistent.json"));
    expect(cache).toEqual({ version: 1, files: {} });
  });

  it("round-trips a cache while dual-writing legacy ownership aliases", () => {
    const cachePath = path.join(tmpDir, "cache.json");
    const cache: IndexCache = {
      version: 1,
      files: {
        "src/foo.ts": {
          hash: "abc123",
          recordIds: ["p1", "p2"],
          indexedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    };

    const persistedBytes = writeCache(cachePath, cache);
    const persistedRaw = fs.readFileSync(cachePath, "utf8");
    const persisted = JSON.parse(persistedRaw) as {
      files: Record<string, { recordIds: string[]; pointIds: string[] }>;
    };
    expect(persistedBytes).toBe(Buffer.byteLength(persistedRaw, "utf8"));
    expect(persisted.files["src/foo.ts"]).toMatchObject({
      recordIds: ["p1", "p2"],
      pointIds: ["p1", "p2"],
    });
    expect(loadCache(cachePath)).toEqual(cache);
  });

  it.each([
    ["legacy", { pointIds: ["record-1"] }],
    ["canonical", { recordIds: ["record-1"] }],
    ["matching aliases", { recordIds: ["record-1"], pointIds: ["record-1"] }],
  ])("normalizes %s cache ownership", (_name, ownership) => {
    const cachePath = path.join(tmpDir, "ownership.json");
    fs.writeFileSync(
      cachePath,
      JSON.stringify({
        version: 1,
        files: {
          "src/foo.ts": {
            hash: "hash",
            indexedAt: "2026-01-01T00:00:00.000Z",
            ...ownership,
          },
        },
      }),
      "utf8",
    );

    expect(loadIndexCache(cachePath)).toEqual({
      status: "valid",
      cache: {
        version: 1,
        files: {
          "src/foo.ts": {
            hash: "hash",
            recordIds: ["record-1"],
            indexedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      },
    });
  });

  it("rejects conflicting cache ownership aliases", () => {
    const cachePath = path.join(tmpDir, "conflicting-ownership.json");
    fs.writeFileSync(
      cachePath,
      JSON.stringify({
        version: 1,
        files: {
          "src/foo.ts": {
            hash: "hash",
            recordIds: ["record-1"],
            pointIds: ["record-2"],
            indexedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      }),
      "utf8",
    );

    expect(loadIndexCache(cachePath)).toMatchObject({ status: "corrupt" });
  });

  it("round-trips a complete retrieval fingerprint without changing ownership", () => {
    const cachePath = path.join(tmpDir, "fingerprinted.json");
    const cache: IndexCache = {
      version: 1,
      granularity: "fine",
      fingerprint: createCodeIndexFingerprint("fine"),
      files: {
        "src/foo.ts": {
          hash: "abc123",
          recordIds: ["point-1"],
          indexedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    };

    writeCache(cachePath, cache);

    expect(loadIndexCache(cachePath)).toEqual({ status: "valid", cache });
  });

  it("keeps a legacy cache without a fingerprint syntactically valid", () => {
    const cachePath = path.join(tmpDir, "legacy.json");
    const cache: IndexCache = {
      version: 1,
      granularity: "standard",
      files: {},
    };

    writeCache(cachePath, cache);

    expect(loadIndexCache(cachePath)).toEqual({ status: "valid", cache });
  });

  it("creates nested directories for cache path", () => {
    const cachePath = path.join(tmpDir, "a", "b", "c", "cache.json");
    writeCache(cachePath, { version: 1, files: {} });
    expect(fs.existsSync(cachePath)).toBe(true);
  });

  it("distinguishes missing, valid, and corrupt cache records", () => {
    const missingPath = path.join(tmpDir, "missing.json");
    expect(loadIndexCache(missingPath)).toEqual({
      status: "missing",
      cache: { version: 1, files: {} },
    });

    const validPath = path.join(tmpDir, "valid.json");
    writeCache(validPath, { version: 1, files: {} });
    expect(loadIndexCache(validPath)).toEqual({
      status: "valid",
      cache: { version: 1, files: {} },
    });

    const corruptPath = path.join(tmpDir, "corrupt.json");
    fs.writeFileSync(corruptPath, "not json!!!", "utf-8");
    expect(loadIndexCache(corruptPath)).toMatchObject({
      status: "corrupt",
    });
    expect(loadCache(corruptPath)).toEqual({ version: 1, files: {} });
  });

  it("returns empty cache for wrong version", () => {
    const cachePath = path.join(tmpDir, "wrong-version.json");
    fs.writeFileSync(
      cachePath,
      JSON.stringify({ version: 99, files: {} }),
      "utf-8",
    );
    expect(loadIndexCache(cachePath)).toEqual({
      status: "corrupt",
      error: "Unsupported or malformed vector cache",
    });
    expect(loadCache(cachePath)).toEqual({ version: 1, files: {} });
  });

  it.each([
    [
      "malformed entry",
      {
        version: 1,
        files: { "src/foo.ts": { hash: "hash", pointIds: "point-1" } },
      },
    ],
    [
      "duplicate record ownership",
      {
        version: 1,
        files: {
          "src/foo.ts": {
            hash: "hash",
            pointIds: ["point-1", "point-1"],
            indexedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      },
    ],
    [
      "cross-file record ownership",
      {
        version: 1,
        files: {
          "src/foo.ts": {
            hash: "hash-1",
            pointIds: ["point-1"],
            indexedAt: "2026-01-01T00:00:00.000Z",
          },
          "src/bar.ts": {
            hash: "hash-2",
            pointIds: ["point-1"],
            indexedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      },
    ],
    [
      "invalid visibility",
      {
        version: 1,
        files: {
          "src/foo.ts": {
            hash: "hash",
            pointIds: ["point-1"],
            indexedAt: "2026-01-01T00:00:00.000Z",
            visibility: "published",
          },
        },
      },
    ],
    [
      "malformed fingerprint",
      {
        version: 1,
        files: {},
        fingerprint: {
          ...createCodeIndexFingerprint("standard"),
          embedding: {
            ...createCodeIndexFingerprint("standard").embedding,
            dimensions: 0,
          },
        },
      },
    ],
  ])("rejects %s", (_, value) => {
    const cachePath = path.join(tmpDir, "invalid.json");
    fs.writeFileSync(cachePath, JSON.stringify(value), "utf-8");

    expect(loadIndexCache(cachePath)).toMatchObject({ status: "corrupt" });
  });
});

// --- structural cache I/O ---

describe("loadStructuralCache / writeStructuralCache", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "structural-cache-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns an empty structural cache when file does not exist", () => {
    const cache = loadStructuralCache(
      path.join(tmpDir, "missing.structural.json"),
      tmpDir,
    );

    expect(cache).toEqual({
      version: 1,
      workspaceRoot: tmpDir,
      generatedAt: "1970-01-01T00:00:00.000Z",
      files: {},
    });
  });

  it("round-trips canonical state without writing the legacy v1 alias", () => {
    const cachePath = path.join(tmpDir, "cache.structural.json");
    const cache: StructuralGraphCache = {
      version: 1,
      workspaceRoot: tmpDir,
      indexName: "al-test",
      generatedAt: "2026-01-01T00:00:00.000Z",
      files: {
        "src/foo.ts": {
          relPath: "src/foo.ts",
          hash: "abc123",
          indexedAt: "2026-01-01T00:00:00.000Z",
          imports: [
            {
              specifier: "./bar",
              kind: "static",
              resolvedRelPath: "src/bar.ts",
              line: 1,
            },
          ],
          exports: [{ name: "foo", kind: "named", line: 3 }],
          symbols: [{ name: "foo", kind: "function", exported: true, line: 3 }],
        },
      },
    };

    writeStructuralCache(cachePath, cache);
    expect(JSON.parse(fs.readFileSync(cachePath, "utf8"))).toEqual(cache);
    expect(JSON.parse(fs.readFileSync(cachePath, "utf8"))).not.toHaveProperty(
      "collectionName",
    );
    expect(loadStructuralCache(cachePath, tmpDir)).toEqual(cache);
  });

  it.each([
    ["canonical", { indexName: "al-test" }],
    ["legacy", { collectionName: "al-test" }],
    ["matching aliases", { indexName: "al-test", collectionName: "al-test" }],
  ])("normalizes a %s structural cache identity", (_, identity) => {
    const cachePath = path.join(tmpDir, "identity.structural.json");
    fs.writeFileSync(
      cachePath,
      JSON.stringify({
        version: 1,
        workspaceRoot: tmpDir,
        generatedAt: "2026-01-01T00:00:00.000Z",
        files: {},
        ...identity,
      }),
      "utf8",
    );

    expect(loadStructuralCache(cachePath, tmpDir)).toEqual({
      version: 1,
      workspaceRoot: tmpDir,
      indexName: "al-test",
      generatedAt: "2026-01-01T00:00:00.000Z",
      files: {},
    });
  });

  it("rejects conflicting structural cache identity aliases", () => {
    const cachePath = path.join(tmpDir, "conflict.structural.json");
    fs.writeFileSync(
      cachePath,
      JSON.stringify({
        version: 1,
        workspaceRoot: tmpDir,
        indexName: "canonical",
        collectionName: "legacy",
        generatedAt: "2026-01-01T00:00:00.000Z",
        files: {},
      }),
      "utf8",
    );

    expect(loadStructuralCache(cachePath, tmpDir)).toEqual(
      emptyStructuralCache(tmpDir),
    );
  });

  it("creates nested directories for structural cache path", () => {
    const cachePath = path.join(tmpDir, "a", "b", "cache.structural.json");
    writeStructuralCache(cachePath, emptyStructuralCache(tmpDir));
    expect(fs.existsSync(cachePath)).toBe(true);
  });

  it("returns an empty structural cache for corrupt JSON", () => {
    const cachePath = path.join(tmpDir, "corrupt.structural.json");
    fs.writeFileSync(cachePath, "not json!!!", "utf-8");

    expect(loadStructuralCache(cachePath, tmpDir)).toEqual(
      emptyStructuralCache(tmpDir),
    );
  });

  it("returns an empty structural cache for wrong version", () => {
    const cachePath = path.join(tmpDir, "wrong-version.structural.json");
    fs.writeFileSync(
      cachePath,
      JSON.stringify({ version: 99, workspaceRoot: tmpDir, files: {} }),
      "utf-8",
    );

    expect(loadStructuralCache(cachePath, tmpDir)).toEqual(
      emptyStructuralCache(tmpDir),
    );
  });

  it("derives the structural sidecar path from the vector cache path", () => {
    expect(getStructuralCachePath(path.join(tmpDir, "al-123.json"))).toBe(
      path.join(tmpDir, "al-123.structural.json"),
    );
    expect(getStructuralCachePath(path.join(tmpDir, "al-123"))).toBe(
      path.join(tmpDir, "al-123.structural.json"),
    );
  });
});

// --- async file scanning and reading ---

describe("scanFiles / readFilesBatch", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "workerlib-async-"));
    ioMocks.stat.mockReset();
    ioMocks.stat.mockImplementation(ioMocks.actualStat!);
    ioMocks.readFile.mockReset();
    ioMocks.readFile.mockImplementation(ioMocks.actualReadFile!);
    ioMocks.open.mockReset();
    ioMocks.open.mockImplementation(ioMocks.actualOpen!);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeFile(relPath: string, content: string): string {
    const absPath = path.join(tmpDir, relPath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, content, "utf-8");
    return absPath;
  }

  it("continues scanning after file errors and reports final progress", async () => {
    const validPath = writeFile("valid.ts", "export const valid = true;");
    const missingPath = path.join(tmpDir, "missing.ts");
    const progress: Array<[number, number]> = [];

    const result = await scanFiles(
      [missingPath, validPath],
      tmpDir,
      { version: 1, files: {} },
      { onProgress: (scanned, total) => progress.push([scanned, total]) },
    );

    expect(result.toIndexPaths).toEqual([
      { absPath: fs.realpathSync(validPath), relPath: "valid.ts" },
    ]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("missing.ts");
    expect(progress).toEqual([[2, 2]]);
  });

  it("deduplicates aliases that resolve to one canonical file identity", async () => {
    const target = writeFile(
      path.join("src", "target.ts"),
      "export const target = true;",
    );
    const alias = path.join(tmpDir, "src", "alias.ts");
    fs.symlinkSync(target, alias, "file");

    const result = await scanFiles([alias, target, alias], tmpDir, {
      version: 1,
      files: {},
    });

    expect(result.toIndexPaths).toEqual([
      {
        absPath: fs.realpathSync(target),
        relPath: path.join("src", "target.ts"),
      },
    ]);
    expect(ioMocks.open).toHaveBeenCalledTimes(1);
  });

  it("rejects symlink escapes during scan before content is read", async () => {
    const outsideDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "workerlib-outside-"),
    );
    try {
      const outside = path.join(outsideDirectory, "outside.ts");
      fs.writeFileSync(outside, "export const outside = true;", "utf8");
      const alias = path.join(tmpDir, "src", "outside.ts");
      fs.mkdirSync(path.dirname(alias), { recursive: true });
      fs.symlinkSync(outside, alias, "file");

      await expect(
        scanFiles([alias], tmpDir, { version: 1, files: {} }),
      ).resolves.toEqual({
        toIndexPaths: [],
        removedRelPaths: [],
        staleRelPaths: [],
        cacheMetadataChanged: false,
        errors: [],
      });
      expect(ioMocks.stat).not.toHaveBeenCalled();
      expect(ioMocks.open).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(outsideDirectory, { recursive: true, force: true });
    }
  });

  it("rejects a batch path paired with a different workspace key", async () => {
    const file = writeFile(path.join("src", "actual.ts"), "content");
    const errors: string[] = [];

    await expect(
      readFilesBatch(
        [{ absPath: file, relPath: path.join("src", "other.ts") }],
        errors,
        { workspaceRoot: tmpDir },
      ),
    ).resolves.toEqual([]);
    expect(errors).toEqual([
      expect.stringContaining("canonical workspace identity"),
    ]);
    expect(ioMocks.stat).not.toHaveBeenCalled();
    expect(ioMocks.open).not.toHaveBeenCalled();
  });

  it("admits at most ten reads and starts queued work in input order", async () => {
    const paths = Array.from({ length: 12 }, (_, index) => ({
      absPath: writeFile(`file-${index}.ts`, "content"),
      relPath: `file-${index}.ts`,
    }));
    const pendingStats: Array<{
      path: string;
      resolve: (
        value: Awaited<ReturnType<typeof import("fs/promises").stat>>,
      ) => void;
    }> = [];
    const admittedPaths = new Set<string>();
    ioMocks.stat.mockImplementation((file) => {
      const filePath = String(file);
      if (admittedPaths.has(filePath)) {
        return ioMocks.actualStat!(file);
      }
      admittedPaths.add(filePath);
      return new Promise((resolve) => {
        pendingStats.push({
          path: filePath,
          resolve: resolve as (
            value: Awaited<ReturnType<typeof import("fs/promises").stat>>,
          ) => void,
        });
      }) as ReturnType<typeof import("fs/promises").stat>;
    });
    ioMocks.readFile.mockResolvedValue("content");

    const metrics = createIndexWorkerMetrics();
    const resultPromise = readFilesBatch(paths, [], {
      workspaceRoot: tmpDir,
      metrics,
    });
    await vi.waitFor(() => expect(pendingStats).toHaveLength(10));
    expect(pendingStats.map(({ path: file }) => path.basename(file))).toEqual(
      paths.slice(0, 10).map(({ relPath }) => relPath),
    );

    pendingStats[0].resolve(await ioMocks.actualStat!(pendingStats[0].path));
    await vi.waitFor(() => expect(pendingStats).toHaveLength(11));
    expect(path.basename(pendingStats[10].path)).toBe("file-10.ts");

    pendingStats[1].resolve(await ioMocks.actualStat!(pendingStats[1].path));
    await vi.waitFor(() => expect(pendingStats).toHaveLength(12));
    expect(path.basename(pendingStats[11].path)).toBe("file-11.ts");

    for (const pending of pendingStats.slice(2)) {
      pending.resolve(await ioMocks.actualStat!(pending.path));
    }

    await expect(resultPromise).resolves.toHaveLength(12);
    expect(metrics.snapshot()).toMatchObject({
      maxActiveReads: 10,
      maxRetainedContentBytes: 12 * Buffer.byteLength("content", "utf8"),
    });
  });

  it("distinguishes removed cached files from changed stale files", async () => {
    const changed = writeFile("changed.ts", "export const value = 2;");
    const cache: IndexCache = {
      version: 1,
      files: {
        "changed.ts": {
          hash: hashContent("export const value = 1;"),
          recordIds: ["changed-point"],
          indexedAt: "2026-01-01T00:00:00.000Z",
        },
        "removed.ts": {
          hash: "removed-hash",
          recordIds: ["removed-point"],
          indexedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    };

    await expect(scanFiles([changed], tmpDir, cache)).resolves.toEqual({
      toIndexPaths: [
        { absPath: fs.realpathSync(changed), relPath: "changed.ts" },
      ],
      removedRelPaths: ["removed.ts"],
      staleRelPaths: ["changed.ts", "removed.ts"],
      cacheMetadataChanged: false,
      errors: [],
    });
  });

  it("preserves empty scan and batch results", async () => {
    const progress = vi.fn();

    await expect(
      scanFiles(
        [],
        tmpDir,
        { version: 1, files: {} },
        { onProgress: progress },
      ),
    ).resolves.toEqual({
      toIndexPaths: [],
      removedRelPaths: [],
      staleRelPaths: [],
      cacheMetadataChanged: false,
      errors: [],
    });
    expect(progress).toHaveBeenCalledOnce();
    expect(progress).toHaveBeenCalledWith(0, 0);
    await expect(
      readFilesBatch([], [], { workspaceRoot: tmpDir }),
    ).resolves.toEqual([]);
  });

  it("propagates progress callback errors after releasing worker permits", async () => {
    const files = Array.from({ length: 100 }, (_, index) =>
      writeFile(`file-${index}.ts`, `export const value${index} = ${index};`),
    );

    await expect(
      scanFiles(
        files,
        tmpDir,
        { version: 1, files: {} },
        {
          onProgress: () => {
            throw new Error("progress failed");
          },
        },
      ),
    ).rejects.toThrow("progress failed");
  });

  it("releases scan content after each file is hashed", async () => {
    const first = writeFile("first.ts", "first");
    const second = writeFile("second.ts", "second-value");
    const metrics = createIndexWorkerMetrics();

    await scanFiles(
      [first, second],
      tmpDir,
      { version: 1, files: {} },
      {
        metrics,
      },
    );

    expect(metrics.snapshot()).toMatchObject({
      maxActiveReads: 2,
      maxRetainedContentBytes: Buffer.byteLength("second-value", "utf8"),
    });
  });

  it("continues reading a batch after file errors", async () => {
    const validPath = writeFile("valid.ts", "export const valid = true;");
    const errors: string[] = [];

    const result = await readFilesBatch(
      [
        { absPath: path.join(tmpDir, "missing.ts"), relPath: "missing.ts" },
        { absPath: validPath, relPath: "valid.ts" },
      ],
      errors,
      { workspaceRoot: tmpDir },
    );

    expect(result).toEqual([
      expect.objectContaining({
        absPath: fs.realpathSync(validPath),
        relPath: "valid.ts",
        content: "export const valid = true;",
      }),
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("missing.ts");
  });

  it("matches incremental classification while preserving candidate order", async () => {
    const changed = writeFile("changed.ts", "export const changed = 2;");
    const unchangedContent = "export const unchanged = true;";
    const unchanged = writeFile("unchanged.ts", unchangedContent);
    const empty = writeFile("empty.ts", "");
    const binary = writeFile("binary.ts", "header\0payload");
    const ignored = writeFile("ignored.png", "not source");
    const extensionless = writeFile("Dockerfile", "FROM node:22");
    const missing = path.join(tmpDir, "missing.ts");
    const cache: IndexCache = {
      version: 1,
      files: {
        "changed.ts": {
          hash: "old-hash",
          recordIds: ["changed"],
          indexedAt: "2026-01-01T00:00:00.000Z",
        },
        "unchanged.ts": {
          hash: hashContent(unchangedContent),
          recordIds: ["unchanged"],
          indexedAt: "2026-01-01T00:00:00.000Z",
        },
        "unrelated.ts": {
          hash: "unrelated-hash",
          recordIds: ["unrelated"],
          indexedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    };

    const scan = await scanFiles(
      [changed, unchanged, empty, binary, ignored, extensionless, missing],
      tmpDir,
      cache,
      { mode: "incremental" },
    );
    const readErrors: string[] = [];
    const files = await readFilesBatch(scan.toIndexPaths, readErrors, {
      workspaceRoot: tmpDir,
      cache,
    });

    expect(scan.toIndexPaths.map((file) => file.relPath)).toEqual([
      "changed.ts",
      "Dockerfile",
    ]);
    expect(files.map((file) => file.relPath)).toEqual([
      "changed.ts",
      "Dockerfile",
    ]);
    expect(files.map((file) => file.content)).toEqual([
      "export const changed = 2;",
      "FROM node:22",
    ]);
    expect(scan.removedRelPaths).toEqual([]);
    expect(scan.staleRelPaths).toEqual(["changed.ts"]);
    expect(scan.errors).toHaveLength(1);
    expect(scan.errors[0]).toContain("missing.ts");
    expect(readErrors).toEqual([]);
  });

  it("hashes incremental candidates despite matching cached stat metadata", async () => {
    const changed = writeFile("changed.ts", "export const current = true;");
    const stat = fs.statSync(changed);
    const cache: IndexCache = {
      version: 1,
      files: {
        "changed.ts": {
          hash: "stale-hash",
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          recordIds: ["old-point"],
          indexedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    };

    const full = await scanFiles([changed], tmpDir, cache);
    const incremental = await scanFiles([changed], tmpDir, cache, {
      mode: "incremental",
    });

    expect(full.toIndexPaths).toEqual([]);
    expect(incremental.toIndexPaths).toEqual([
      { absPath: fs.realpathSync(changed), relPath: "changed.ts" },
    ]);
  });

  it("signals durable metadata updates for hash-equal files", async () => {
    const content = "export const stable = true;";
    const stable = writeFile("stable.ts", content);
    const stat = fs.statSync(stable);
    const cache: IndexCache = {
      version: 1,
      files: {
        "stable.ts": {
          hash: hashContent(content),
          recordIds: ["stable"],
          indexedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    };

    const result = await scanFiles([stable], tmpDir, cache, {
      mode: "incremental",
    });

    expect(result.toIndexPaths).toEqual([]);
    expect(result.cacheMetadataChanged).toBe(true);
    expect(cache.files["stable.ts"]).toMatchObject({
      mtimeMs: stat.mtimeMs,
      size: stat.size,
    });
  });

  it("stops queued scan work after cancellation", async () => {
    const files = Array.from({ length: 12 }, (_, index) =>
      path.join(tmpDir, `file-${index}.ts`),
    );
    const pendingStats: Array<{
      path: string;
      resolve: (value: {
        isFile(): boolean;
        mtimeMs: number;
        size: number;
      }) => void;
    }> = [];
    let cancelled = false;
    ioMocks.stat.mockImplementation(
      (file) =>
        new Promise((resolve) => {
          pendingStats.push({
            path: String(file),
            resolve: resolve as (value: {
              isFile(): boolean;
              mtimeMs: number;
              size: number;
            }) => void,
          });
        }) as ReturnType<typeof import("fs/promises").stat>,
    );

    const resultPromise = scanFiles(
      files,
      tmpDir,
      { version: 1, files: {} },
      { mode: "incremental", isCancelled: () => cancelled },
    );
    await vi.waitFor(() => expect(pendingStats).toHaveLength(10));
    cancelled = true;
    for (const pending of pendingStats) {
      pending.resolve({ isFile: () => true, mtimeMs: 1, size: 7 });
    }

    const result = await resultPromise;
    expect(pendingStats).toHaveLength(10);
    expect(result.toIndexPaths).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(ioMocks.readFile).not.toHaveBeenCalled();
  });

  it("stops queued batch reads after cancellation", async () => {
    const paths = Array.from({ length: 12 }, (_, index) => ({
      absPath: path.join(tmpDir, `file-${index}.ts`),
      relPath: `file-${index}.ts`,
    }));
    const pendingStats: Array<{
      resolve: (value: {
        isFile(): boolean;
        mtimeMs: number;
        size: number;
      }) => void;
    }> = [];
    let cancelled = false;
    ioMocks.stat.mockImplementation(
      () =>
        new Promise((resolve) => {
          pendingStats.push({
            resolve: resolve as (value: {
              isFile(): boolean;
              mtimeMs: number;
              size: number;
            }) => void,
          });
        }) as ReturnType<typeof import("fs/promises").stat>,
    );

    const errors: string[] = [];
    const resultPromise = readFilesBatch(paths, errors, {
      workspaceRoot: tmpDir,
      isCancelled: () => cancelled,
    });
    await vi.waitFor(() => expect(pendingStats).toHaveLength(10));
    cancelled = true;
    for (const pending of pendingStats) {
      pending.resolve({ isFile: () => true, mtimeMs: 1, size: 7 });
    }

    await expect(resultPromise).resolves.toEqual([]);
    expect(pendingStats).toHaveLength(10);
    expect(errors).toEqual([]);
    expect(ioMocks.readFile).not.toHaveBeenCalled();
  });

  it("retries a file that changes during the batch read", async () => {
    const file = writeFile("racing.ts", "first version");
    const replacement = "second stable version";
    let openCount = 0;
    ioMocks.open.mockImplementation(async (...args) => {
      const handle = await ioMocks.actualOpen!(...args);
      openCount++;
      if (openCount === 1) {
        const read = handle.read.bind(handle) as (
          buffer: Buffer,
          offset: number,
          length: number,
          position: number,
        ) => Promise<{ bytesRead: number; buffer: Buffer }>;
        handle.read = (async (buffer, offset, length, position) => {
          const result = await read(
            buffer as Buffer,
            offset ?? 0,
            length ?? buffer.byteLength,
            typeof position === "number" ? position : 0,
          );
          if (position === 0) fs.writeFileSync(file, replacement, "utf8");
          return result;
        }) as typeof handle.read;
      }
      return handle;
    });

    const errors: string[] = [];
    const result = await readFilesBatch(
      [{ absPath: file, relPath: "racing.ts" }],
      errors,
      { workspaceRoot: tmpDir },
    );

    expect(result).toEqual([
      expect.objectContaining({
        content: replacement,
        hash: hashContent(replacement),
        size: Buffer.byteLength(replacement, "utf8"),
      }),
    ]);
    expect(openCount).toBe(2);
    expect(errors).toEqual([]);
  });

  it("retries an in-place mutation before final path validation", async () => {
    const file = writeFile("path-racing.ts", "first version");
    const replacement = "second stable version";
    let statCount = 0;
    ioMocks.stat.mockImplementation(async (...args) => {
      statCount++;
      if (statCount === 2) fs.writeFileSync(file, replacement, "utf8");
      return ioMocks.actualStat!(...args);
    });

    const errors: string[] = [];
    const result = await readFilesBatch(
      [{ absPath: file, relPath: "path-racing.ts" }],
      errors,
      { workspaceRoot: tmpDir },
    );

    expect(result).toEqual([
      expect.objectContaining({
        content: replacement,
        hash: hashContent(replacement),
        size: Buffer.byteLength(replacement, "utf8"),
      }),
    ]);
    expect(statCount).toBe(3);
    expect(ioMocks.open).toHaveBeenCalledTimes(2);
    expect(errors).toEqual([]);
  });

  it("rejects a file that grows beyond the limit during the batch read", async () => {
    const file = writeFile("growing.ts", "small");
    const oversized = "x".repeat(MAX_FILE_SIZE + 1);
    ioMocks.open.mockImplementation(async (...args) => {
      const handle = await ioMocks.actualOpen!(...args);
      const read = handle.read.bind(handle) as (
        buffer: Buffer,
        offset: number,
        length: number,
        position: number,
      ) => Promise<{ bytesRead: number; buffer: Buffer }>;
      handle.read = (async (buffer, offset, length, position) => {
        fs.writeFileSync(file, oversized, "utf8");
        return read(
          buffer as Buffer,
          offset ?? 0,
          length ?? buffer.byteLength,
          typeof position === "number" ? position : 0,
        );
      }) as typeof handle.read;
      return handle;
    });
    const metrics = createIndexWorkerMetrics();

    const errors: string[] = [];
    const result = await readFilesBatch(
      [{ absPath: file, relPath: "growing.ts" }],
      errors,
      { workspaceRoot: tmpDir, metrics },
    );

    expect(result).toEqual([]);
    expect(errors).toEqual([]);
    expect(metrics.snapshot().maxRetainedContentBytes).toBe(0);
  });

  it("revalidates content before returning a scanned batch", async () => {
    const binary = writeFile("binary.ts", "text during scan");
    const empty = writeFile("empty.ts", "text during scan");
    const revertedContent = "export const reverted = true;";
    const reverted = writeFile("reverted.ts", "changed during scan");
    const cache: IndexCache = {
      version: 1,
      files: {
        "reverted.ts": {
          hash: hashContent(revertedContent),
          recordIds: ["reverted"],
          indexedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    };
    const scan = await scanFiles([binary, empty, reverted], tmpDir, cache, {
      mode: "incremental",
    });
    fs.writeFileSync(binary, "header\0payload");
    fs.writeFileSync(empty, "");
    fs.writeFileSync(reverted, revertedContent);

    const errors: string[] = [];
    const onCacheMetadataChanged = vi.fn();
    await expect(
      readFilesBatch(scan.toIndexPaths, errors, {
        workspaceRoot: tmpDir,
        cache,
        onCacheMetadataChanged,
      }),
    ).resolves.toEqual([]);
    const revertedStat = fs.statSync(reverted);
    expect(cache.files["reverted.ts"]).toMatchObject({
      mtimeMs: revertedStat.mtimeMs,
      size: revertedStat.size,
    });
    expect(onCacheMetadataChanged).toHaveBeenCalledOnce();
    expect(errors).toEqual([]);
  });

  it("balances retained bytes for malformed UTF-8 when processing throws", async () => {
    const malformedBytes = Buffer.from([0x66, 0x80, 0x67]);
    const file = path.join(tmpDir, "malformed.ts");
    fs.writeFileSync(file, malformedBytes);
    let retainedBytes = 0;
    const baseMetrics = createIndexWorkerMetrics();
    const metrics = {
      ...baseMetrics,
      contentRetained(bytes: number) {
        retainedBytes += bytes;
        baseMetrics.contentRetained(bytes);
      },
      contentReleased(bytes: number) {
        retainedBytes -= bytes;
        baseMetrics.contentReleased(bytes);
      },
    };
    const files = await readFilesBatch(
      [{ absPath: file, relPath: "malformed.ts" }],
      [],
      { workspaceRoot: tmpDir, metrics },
    );

    expect(files).toEqual([
      expect.objectContaining({
        contentBytes: malformedBytes.byteLength,
      }),
    ]);
    expect(Buffer.byteLength(files[0].content, "utf8")).toBeGreaterThan(
      files[0].contentBytes,
    );
    expect(retainedBytes).toBe(malformedBytes.byteLength);

    await expect(
      (async () => {
        try {
          throw new Error("processing failed");
        } finally {
          metrics.contentReleased(
            files.reduce((total, entry) => total + entry.contentBytes, 0),
          );
        }
      })(),
    ).rejects.toThrow("processing failed");
    expect(retainedBytes).toBe(0);
  });
});
