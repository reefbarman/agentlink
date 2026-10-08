import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { buildRepoMapPayload, handleGetRepoMap } from "./getRepoMap.js";
import { describe, expect, it } from "vitest";

import type { StructuralGraphCache } from "../indexer/structuralGraph.js";
import type { StructuralGraphProvider } from "../core/capabilities/readSearch.js";

function parseTextResult(result: Awaited<ReturnType<typeof handleGetRepoMap>>) {
  const [content] = result.content;
  expect(content.type).toBe("text");
  if (content.type !== "text") throw new Error("expected text result");
  return JSON.parse(content.text) as Record<string, unknown>;
}

function makeProvider(
  graph: StructuralGraphCache = makeGraph(),
): StructuralGraphProvider {
  return {
    resolveWorkspaceRoot(inputPath) {
      return inputPath === "../outside" ? undefined : "/workspace";
    },
    resolvePath(inputPath) {
      if (inputPath === "../outside") {
        return { absolutePath: "/outside", inWorkspace: false };
      }
      return { absolutePath: `/workspace/${inputPath}`, inWorkspace: true };
    },
    getWorkspaceRootForPath() {
      return "/workspace";
    },
    async loadGraph(workspaceRoot) {
      return {
        graph,
        workspaceRoot,
        indexName: "al-test",
        structuralStorePath: "/cache/al-test.structural.json",
        graphExists: true,
      };
    },
    getScopeStatus(_absolutePath, matchedFiles) {
      return matchedFiles > 0 ? "indexed" : "unindexed";
    },
    getTargetFreshness() {
      return { status: "unknown" };
    },
  };
}

function makeGraph(): StructuralGraphCache {
  return {
    version: 1,
    workspaceRoot: "/workspace",
    indexName: "al-test",
    generatedAt: "2026-01-01T00:00:00.000Z",
    files: {
      "src/api/server.ts": {
        relPath: "src/api/server.ts",
        hash: "server-hash",
        indexedAt: "2026-01-01T00:00:00.000Z",
        language: "typescript",
        imports: [
          {
            specifier: "../core/router",
            kind: "static",
            resolvedRelPath: "src/core/router.ts",
            imported: ["createRouter"],
            line: 1,
          },
          {
            specifier: "vscode",
            kind: "static",
            external: true,
            line: 2,
          },
        ],
        exports: [{ name: "activate", kind: "named", line: 4 }],
        symbols: [
          { name: "activate", kind: "function", exported: true, line: 4 },
        ],
      },
      "src/core/router.ts": {
        relPath: "src/core/router.ts",
        hash: "router-hash",
        indexedAt: "2026-01-01T00:00:00.000Z",
        language: "typescript",
        imports: [
          {
            specifier: "./types",
            kind: "static",
            resolvedRelPath: "src/core/types.ts",
            imported: ["Route"],
            line: 1,
          },
        ],
        exports: [{ name: "createRouter", kind: "named", line: 3 }],
        symbols: [
          {
            name: "createRouter",
            kind: "function",
            exported: true,
            line: 3,
          },
        ],
      },
      "src/core/types.ts": {
        relPath: "src/core/types.ts",
        hash: "types-hash",
        indexedAt: "2026-01-01T00:00:00.000Z",
        language: "typescript",
        imports: [],
        exports: [{ name: "Route", kind: "named", line: 1 }],
        symbols: [
          { name: "Route", kind: "interface", exported: true, line: 1 },
        ],
      },
      "test/router.test.ts": {
        relPath: "test/router.test.ts",
        hash: "test-hash",
        indexedAt: "2026-01-01T00:00:00.000Z",
        language: "typescript",
        imports: [
          {
            specifier: "../src/core/router",
            kind: "static",
            resolvedRelPath: "src/core/router.ts",
            imported: ["createRouter"],
            line: 1,
          },
          {
            specifier: "vitest",
            kind: "static",
            external: true,
            line: 2,
          },
        ],
        exports: [],
        symbols: [],
      },
    },
  };
}

function makeEntry(
  relPath: string,
  exportName?: string,
): StructuralGraphCache["files"][string] {
  return {
    relPath,
    hash: `${relPath}-hash`,
    indexedAt: "2026-01-01T00:00:00.000Z",
    language: relPath.endsWith(".json") ? "json" : "typescript",
    imports: [],
    exports: exportName ? [{ name: exportName, kind: "named", line: 1 }] : [],
    symbols: exportName
      ? [{ name: exportName, kind: "function", exported: true, line: 1 }]
      : [],
  };
}

/**
 * Mirrors the reported project: 11 TypeScript sources beside an npm cache
 * spread across hundreds of content-addressed directories.
 */
function makeCacheHeavyGraph(): StructuralGraphCache {
  const files: StructuralGraphCache["files"] = {};
  for (const relPath of [
    "src/service.ts",
    "src/storage.ts",
    "src/mcp.ts",
    "src/providers/openai.ts",
    "src/providers/anthropic.ts",
    ...Array.from({ length: 6 }, (_, i) => `src/util/helper${i}.ts`),
  ]) {
    files[relPath] = makeEntry(relPath, path.basename(relPath, ".ts"));
  }
  for (let i = 0; i < 456; i++) {
    const relPath = `.npm-cache/_cacache/content-v2/sha512/${i
      .toString(16)
      .padStart(2, "0")}/entry.json`;
    files[relPath] = makeEntry(relPath);
  }
  return { ...makeGraph(), files };
}

describe("handleGetRepoMap", () => {
  it("returns the legacy unavailable error when structural graph provider is unavailable", async () => {
    const result = await handleGetRepoMap({}, undefined);

    expect(parseTextResult(result)).toEqual({
      error: "get_repo_map is unavailable without global storage context.",
    });
    expect(result).toMatchObject({
      data: {
        error: "get_repo_map is unavailable without global storage context.",
      },
      isError: true,
      error: { kind: "tool_error" },
    });
  });

  it("returns an error result for too-small max_chars", async () => {
    const result = await handleGetRepoMap({ max_chars: 100 }, makeProvider());

    expect(parseTextResult(result)).toEqual({
      error: "Invalid max_chars: 100. Must be at least 2000.",
    });
  });

  it("maps canonical scopes through a symlinked workspace root", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "repo-map-root-"));
    try {
      const physicalRoot = path.join(directory, "physical");
      const workspaceRoot = path.join(directory, "workspace-link");
      const scope = path.join(physicalRoot, "src", "core");
      fs.mkdirSync(scope, { recursive: true });
      fs.symlinkSync(physicalRoot, workspaceRoot, "dir");
      const provider = makeProvider();
      provider.resolveWorkspaceRoot = () => workspaceRoot;
      provider.resolvePath = () => ({
        absolutePath: fs.realpathSync(scope),
        inWorkspace: true,
      });

      const result = await handleGetRepoMap(
        { path: path.join(workspaceRoot, "src", "core") },
        provider,
      );

      expect(parseTextResult(result)).toMatchObject({
        scope: { path: "src/core", matched_files: 2 },
        totals: { files: 2 },
      });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("labels an existing scope with no graph entries as unindexed", async () => {
    const result = await handleGetRepoMap(
      { path: "src/unindexed", max_chars: 20_000 },
      makeProvider(),
    );

    expect(parseTextResult(result)).toMatchObject({
      scope: {
        path: "src/unindexed",
        status: "unindexed",
        matched_files: 0,
      },
      note: expect.stringContaining("No indexed files"),
    });
  });

  it("builds a repo map from an injected structural graph provider", async () => {
    const result = await handleGetRepoMap(
      { path: "src/core", max_chars: 20_000 },
      makeProvider(),
    );

    const payload = parseTextResult(result);
    expect(result.isError).toBe(false);
    expect(result.data).toStrictEqual(payload);
    expect(Object.hasOwn(result.data as object, "note")).toBe(false);
    expect(payload).toMatchObject({
      workspace_root: "/workspace",
      cache: {
        index_name: "al-test",
        structural_store_path: "/cache/al-test.structural.json",
      },
      scope: { path: "src/core", status: "indexed", matched_files: 2 },
      totals: { files: 2, imports: 1, internal_imports: 1 },
    });
  });
});

describe("buildRepoMapPayload", () => {
  it("returns cache metadata, aggregate totals, directories, dependencies, and files", () => {
    const payload = buildRepoMapPayload({
      graph: makeGraph(),
      workspaceRoot: "/workspace",
      indexName: "al-test",
      structuralStorePath: "/cache/al-test.structural.json",
      maxChars: 20_000,
    });

    expect(Object.hasOwn(payload, "note")).toBe(false);
    expect(payload).toMatchObject({
      workspace_root: "/workspace",
      cache: {
        index_name: "al-test",
        structural_store_path: "/cache/al-test.structural.json",
      },
      freshness: {
        graph: {
          status: "available",
          generated_at: "2026-01-01T00:00:00.000Z",
          file_count: 4,
          cache_version: 1,
        },
      },
      scope: { path: ".", status: "indexed", matched_files: 4 },
      totals: {
        files: 4,
        imports: 5,
        internal_imports: 3,
        external_imports: 2,
        exports: 3,
        symbols: 3,
      },
    });

    const files = payload.files as {
      items: Array<Record<string, unknown>>;
      total: number;
      truncated: boolean;
    };
    expect(files.total).toBe(4);
    expect(files.truncated).toBe(false);
    expect(files.items).toContainEqual({
      path: "src/core/router.ts",
      language: "typescript",
      imports: ["src/core/types.ts"],
      exports: ["createRouter"],
      symbols: ["export function createRouter"],
      imported_by: 2,
    });

    const external = payload.external_dependencies as {
      items: Array<Record<string, unknown>>;
    };
    expect(external.items).toEqual([
      { specifier: "vitest", importer_count: 1 },
      { specifier: "vscode", importer_count: 1 },
    ]);
  });

  it("scopes to a directory", () => {
    const payload = buildRepoMapPayload({
      graph: makeGraph(),
      scopeRelPath: "src/core",
      maxChars: 20_000,
    });

    expect(payload).toMatchObject({
      scope: { path: "src/core", matched_files: 2 },
      totals: { files: 2, imports: 1, internal_imports: 1 },
    });
    const files = payload.files as { items: Array<{ path: string }> };
    expect(files.items.map((item) => item.path)).toEqual([
      "src/core/router.ts",
      "src/core/types.ts",
    ]);
  });

  it("honors max_files and reports truncation", () => {
    const payload = buildRepoMapPayload({
      graph: makeGraph(),
      maxChars: 20_000,
      maxFiles: 2,
    });

    expect(payload).toMatchObject({
      files: { total: 4, truncated: true, omitted: 2, max_files: 2 },
      budget: { truncated: true, omitted_files: 2 },
    });
  });

  it("keeps the JSON payload within the requested character budget", () => {
    const payload = buildRepoMapPayload({
      graph: makeGraph(),
      maxChars: 2_000,
    });

    const serialized = JSON.stringify(payload, null, 2);
    expect(serialized.length).toBeLessThanOrEqual(2_000);
    expect(payload).toMatchObject({
      budget: { max_chars: 2_000, actual_chars: serialized.length },
    });
  });

  it("keeps project files ahead of a cache-heavy tree within the same budget", () => {
    const graph = makeCacheHeavyGraph();
    const payload = buildRepoMapPayload({
      graph,
      maxChars: 19_000,
      maxFiles: 75,
    });

    expect(JSON.stringify(payload, null, 2).length).toBeLessThanOrEqual(19_000);
    const files = payload.files as {
      items: Array<{ path: string }>;
      total: number;
      omitted: number;
    };
    const paths = files.items.map((item) => item.path);
    expect(files.total).toBe(467);
    expect(files.omitted).toBe(467 - paths.length);
    expect(paths.slice(0, 11)).toEqual(
      [
        "src/mcp.ts",
        "src/providers/anthropic.ts",
        "src/providers/openai.ts",
        "src/service.ts",
        "src/storage.ts",
        ...Array.from({ length: 6 }, (_, i) => `src/util/helper${i}.ts`),
      ].sort((a, b) => a.localeCompare(b)),
    );
    expect(
      paths.slice(11).every((item) => item.startsWith(".npm-cache/")),
    ).toBe(true);

    const directories = payload.directories as {
      items: Array<{ path: string }>;
      total: number;
      omitted: number;
    };
    expect(directories.items.slice(0, 3).map((item) => item.path)).toEqual([
      "src/util",
      "src",
      "src/providers",
    ]);
    expect(directories.total).toBe(459);
    expect(directories.omitted).toBe(459 - directories.items.length);
  });

  it("reserves file space when project directories alone exceed the budget", () => {
    const files: StructuralGraphCache["files"] = {};
    for (let i = 0; i < 300; i++) {
      const relPath = `packages/pkg${String(i).padStart(3, "0")}/index.ts`;
      files[relPath] = makeEntry(relPath, `export${i}`);
    }
    const payload = buildRepoMapPayload({
      graph: { ...makeGraph(), files },
      maxChars: 20_000,
    });

    const fileItems = (payload.files as { items: unknown[] }).items;
    const directoryItems = (payload.directories as { items: unknown[] }).items;
    expect(fileItems.length).toBeGreaterThan(0);
    expect(directoryItems.length).toBeGreaterThan(0);
    expect(JSON.stringify(payload, null, 2).length).toBeLessThanOrEqual(20_000);
  });

  it("backfills directory summaries when file skeletons leave space", () => {
    const payload = buildRepoMapPayload({
      graph: makeGraph(),
      maxChars: 20_000,
    });

    expect(payload).toMatchObject({
      directories: { total: 3, truncated: false, omitted: 0 },
      files: { total: 4, truncated: false },
    });
  });

  it("keeps ordinary ordering when the scope is itself a cache tree", () => {
    const payload = buildRepoMapPayload({
      graph: makeCacheHeavyGraph(),
      scopeRelPath: ".npm-cache",
      maxChars: 6_000,
    });

    const paths = (
      payload.files as { items: Array<{ path: string }> }
    ).items.map((item) => item.path);
    expect(paths.length).toBeGreaterThan(0);
    expect(paths[0]).toBe(
      ".npm-cache/_cacache/content-v2/sha512/00/entry.json",
    );
    expect(payload).toMatchObject({ scope: { matched_files: 456 } });
  });

  it("reports missing graph and empty scope notes", () => {
    const payload = buildRepoMapPayload({
      graph: makeGraph(),
      graphExists: false,
      scopeRelPath: "src/missing",
      maxChars: 20_000,
    });

    expect(payload).toMatchObject({
      freshness: { graph: { status: "missing" } },
      scope: { path: "src/missing", status: "unavailable", matched_files: 0 },
      totals: { files: 0 },
    });
    expect(payload.note).toContain("Structural index is unavailable");
  });
});
