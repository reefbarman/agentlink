import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  MAX_FILE_SIZE,
  buildPathSegments,
  diffFiles,
  emptyStructuralCache,
  getStructuralCachePath,
  hashContent,
  isBinaryContent,
  loadCache,
  loadStructuralCache,
  readFilesBatch,
  scanFiles,
  writeCache,
  writeStructuralCache,
} from "./workerLib.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { IndexCache } from "./types.js";
import type { StructuralGraphCache } from "./structuralGraph.js";
import { createIndexWorkerMetrics } from "./workerMetrics.js";

const ioMocks = vi.hoisted(() => ({
  stat: vi.fn<typeof import("fs/promises").stat>(),
  readFile: vi.fn<typeof import("fs/promises").readFile>(),
  actualStat: undefined as typeof import("fs/promises").stat | undefined,
  actualReadFile: undefined as
    | typeof import("fs/promises").readFile
    | undefined,
}));

vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs/promises")>();
  ioMocks.actualStat = actual.stat;
  ioMocks.actualReadFile = actual.readFile;
  ioMocks.stat.mockImplementation(actual.stat);
  ioMocks.readFile.mockImplementation(actual.readFile);
  return {
    ...actual,
    default: { ...actual, stat: ioMocks.stat, readFile: ioMocks.readFile },
    stat: ioMocks.stat,
    readFile: ioMocks.readFile,
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

  it("round-trips a cache through write then load", () => {
    const cachePath = path.join(tmpDir, "cache.json");
    const cache: IndexCache = {
      version: 1,
      files: {
        "src/foo.ts": {
          hash: "abc123",
          pointIds: ["p1", "p2"],
          indexedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    };

    writeCache(cachePath, cache);
    const loaded = loadCache(cachePath);
    expect(loaded).toEqual(cache);
  });

  it("creates nested directories for cache path", () => {
    const cachePath = path.join(tmpDir, "a", "b", "c", "cache.json");
    writeCache(cachePath, { version: 1, files: {} });
    expect(fs.existsSync(cachePath)).toBe(true);
  });

  it("returns empty cache for corrupt JSON", () => {
    const cachePath = path.join(tmpDir, "corrupt.json");
    fs.writeFileSync(cachePath, "not json!!!", "utf-8");
    const cache = loadCache(cachePath);
    expect(cache).toEqual({ version: 1, files: {} });
  });

  it("returns empty cache for wrong version", () => {
    const cachePath = path.join(tmpDir, "wrong-version.json");
    fs.writeFileSync(
      cachePath,
      JSON.stringify({ version: 99, files: {} }),
      "utf-8",
    );
    const cache = loadCache(cachePath);
    expect(cache).toEqual({ version: 1, files: {} });
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

  it("round-trips a structural cache through write then load", () => {
    const cachePath = path.join(tmpDir, "cache.structural.json");
    const cache: StructuralGraphCache = {
      version: 1,
      workspaceRoot: tmpDir,
      collectionName: "al-test",
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
    const loaded = loadStructuralCache(cachePath, tmpDir);
    expect(loaded).toEqual(cache);
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

// --- diffFiles ---

describe("diffFiles", () => {
  let tmpDir: string;
  let workspaceRoot: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "workerlib-diff-"));
    workspaceRoot = tmpDir;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeFile(relPath: string, content: string): string {
    const absPath = path.join(workspaceRoot, relPath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, content, "utf-8");
    return absPath;
  }

  it("returns all files as toIndex when cache is empty", () => {
    const f1 = writeFile("a.ts", "const a = 1;");
    const f2 = writeFile("b.ts", "const b = 2;");
    const emptyCache: IndexCache = { version: 1, files: {} };

    const result = diffFiles([f1, f2], workspaceRoot, emptyCache);

    expect(result.toIndex).toHaveLength(2);
    expect(result.toIndex.map((f) => f.relPath).sort()).toEqual([
      "a.ts",
      "b.ts",
    ]);
    expect(result.errors).toHaveLength(0);
  });

  it("skips files that match cache hash", () => {
    const content = "const cached = true;";
    const f1 = writeFile("cached.ts", content);
    const hash = hashContent(content);

    const cache: IndexCache = {
      version: 1,
      files: {
        "cached.ts": {
          hash,
          pointIds: ["p1"],
          indexedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    };

    const result = diffFiles([f1], workspaceRoot, cache);
    expect(result.toIndex).toHaveLength(0);
  });

  it("detects changed files", () => {
    const f1 = writeFile("changed.ts", "const v2 = true;");

    const cache: IndexCache = {
      version: 1,
      files: {
        "changed.ts": {
          hash: "old-hash",
          pointIds: ["p1"],
          indexedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    };

    const result = diffFiles([f1], workspaceRoot, cache);
    expect(result.toIndex).toHaveLength(1);
    expect(result.toIndex[0].relPath).toBe("changed.ts");
  });

  it("skips files larger than MAX_FILE_SIZE", () => {
    // Create a file just over the limit
    const bigContent = "x".repeat(MAX_FILE_SIZE + 1);
    const f1 = writeFile("big.ts", bigContent);
    const emptyCache: IndexCache = { version: 1, files: {} };

    const result = diffFiles([f1], workspaceRoot, emptyCache);
    expect(result.toIndex).toHaveLength(0);
  });

  it("skips empty files", () => {
    const f1 = writeFile("empty.ts", "");
    const emptyCache: IndexCache = { version: 1, files: {} };

    const result = diffFiles([f1], workspaceRoot, emptyCache);
    expect(result.toIndex).toHaveLength(0);
  });

  it("skips binary files", () => {
    const f1 = writeFile("binary.ts", "header\0\0\0binary data");
    const emptyCache: IndexCache = { version: 1, files: {} };

    const result = diffFiles([f1], workspaceRoot, emptyCache);
    expect(result.toIndex).toHaveLength(0);
  });

  it("skips files with non-indexable extensions", () => {
    const f1 = writeFile("data.csv", "a,b,c\n1,2,3");
    const f2 = writeFile("package-lock.json", "{}"); // .json IS indexable
    const f3 = writeFile("image.png", "fake image data");
    const f4 = writeFile("styles.css", ".foo { color: red; }"); // .css IS indexable
    const f5 = writeFile("notes.log", "some log output");
    const emptyCache: IndexCache = { version: 1, files: {} };

    const result = diffFiles([f1, f2, f3, f4, f5], workspaceRoot, emptyCache);

    const indexed = result.toIndex.map((f) => f.relPath);
    expect(indexed).toContain("package-lock.json");
    expect(indexed).toContain("styles.css");
    expect(indexed).not.toContain("data.csv");
    expect(indexed).not.toContain("image.png");
    expect(indexed).not.toContain("notes.log");
  });

  it("indexes all common code extensions", () => {
    const extensions = [".ts", ".py", ".rs", ".go", ".java", ".rb", ".md"];
    const files = extensions.map((ext, i) =>
      writeFile(`file${i}${ext}`, `content for ${ext}`),
    );
    const emptyCache: IndexCache = { version: 1, files: {} };

    const result = diffFiles(files, workspaceRoot, emptyCache);
    expect(result.toIndex).toHaveLength(extensions.length);
  });

  it("records errors for unreadable files without crashing", () => {
    const emptyCache: IndexCache = { version: 1, files: {} };
    const fakePath = path.join(workspaceRoot, "nonexistent.ts");

    const result = diffFiles([fakePath], workspaceRoot, emptyCache);
    expect(result.toIndex).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("nonexistent.ts");
  });

  it("includes content and hash in toIndex entries", () => {
    const content = "export const foo = 42;";
    const f1 = writeFile("foo.ts", content);
    const emptyCache: IndexCache = { version: 1, files: {} };

    const result = diffFiles([f1], workspaceRoot, emptyCache);
    expect(result.toIndex[0].content).toBe(content);
    expect(result.toIndex[0].hash).toBe(hashContent(content));
    expect(result.toIndex[0].absPath).toBe(f1);
    expect(result.toIndex[0].relPath).toBe("foo.ts");
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
      (scanned, total) => progress.push([scanned, total]),
    );

    expect(result.toIndexPaths).toEqual([
      { absPath: validPath, relPath: "valid.ts" },
    ]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("missing.ts");
    expect(progress).toEqual([[2, 2]]);
  });

  it("admits at most ten reads and starts queued work in input order", async () => {
    const paths = Array.from({ length: 12 }, (_, index) => ({
      absPath: path.join(tmpDir, `file-${index}.ts`),
      relPath: `file-${index}.ts`,
    }));
    const pendingStats: Array<{
      path: string;
      resolve: (value: { mtimeMs: number; size: number }) => void;
    }> = [];
    ioMocks.stat.mockImplementation(
      (file) =>
        new Promise((resolve) => {
          pendingStats.push({
            path: String(file),
            resolve: resolve as (value: {
              mtimeMs: number;
              size: number;
            }) => void,
          });
        }) as ReturnType<typeof import("fs/promises").stat>,
    );
    ioMocks.readFile.mockResolvedValue("content");

    const metrics = createIndexWorkerMetrics();
    const resultPromise = readFilesBatch(paths, [], metrics);
    await vi.waitFor(() => expect(pendingStats).toHaveLength(10));
    expect(pendingStats.map(({ path: file }) => path.basename(file))).toEqual(
      paths.slice(0, 10).map(({ relPath }) => relPath),
    );

    pendingStats[0].resolve({ mtimeMs: 1, size: 7 });
    await vi.waitFor(() => expect(pendingStats).toHaveLength(11));
    expect(path.basename(pendingStats[10].path)).toBe("file-10.ts");

    pendingStats[1].resolve({ mtimeMs: 1, size: 7 });
    await vi.waitFor(() => expect(pendingStats).toHaveLength(12));
    expect(path.basename(pendingStats[11].path)).toBe("file-11.ts");

    for (const pending of pendingStats.slice(2)) {
      pending.resolve({ mtimeMs: 1, size: 7 });
    }

    await expect(resultPromise).resolves.toHaveLength(12);
    expect(metrics.snapshot()).toMatchObject({
      maxActiveReads: 10,
      maxRetainedContentBytes: 12 * Buffer.byteLength("content", "utf8"),
    });
  });

  it("preserves empty scan and batch results", async () => {
    const progress = vi.fn();

    await expect(
      scanFiles([], tmpDir, { version: 1, files: {} }, progress),
    ).resolves.toEqual({ toIndexPaths: [], staleRelPaths: [], errors: [] });
    expect(progress).toHaveBeenCalledOnce();
    expect(progress).toHaveBeenCalledWith(0, 0);
    await expect(readFilesBatch([], [])).resolves.toEqual([]);
  });

  it("propagates progress callback errors after releasing worker permits", async () => {
    const files = Array.from({ length: 100 }, (_, index) =>
      writeFile(`file-${index}.ts`, `export const value${index} = ${index};`),
    );

    await expect(
      scanFiles(files, tmpDir, { version: 1, files: {} }, () => {
        throw new Error("progress failed");
      }),
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
      undefined,
      metrics,
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
    );

    expect(result).toEqual([
      expect.objectContaining({
        absPath: validPath,
        relPath: "valid.ts",
        content: "export const valid = true;",
      }),
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("missing.ts");
  });
});
