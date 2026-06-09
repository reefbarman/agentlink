import { buildRepoMapPayload, handleGetRepoMap } from "./getRepoMap.js";
import { describe, expect, it } from "vitest";

import type { StructuralGraphCache } from "../indexer/structuralGraph.js";

function parseTextResult(result: Awaited<ReturnType<typeof handleGetRepoMap>>) {
  const [content] = result.content;
  expect(content.type).toBe("text");
  if (content.type !== "text") throw new Error("expected text result");
  return JSON.parse(content.text) as Record<string, unknown>;
}

function makeGraph(): StructuralGraphCache {
  return {
    version: 1,
    workspaceRoot: "/workspace",
    collectionName: "al-test",
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

describe("handleGetRepoMap", () => {
  it("returns an error result when global storage is unavailable", async () => {
    const result = await handleGetRepoMap({}, undefined);

    expect(parseTextResult(result)).toEqual({
      error: "get_repo_map is unavailable without global storage context.",
    });
  });

  it("returns an error result for too-small max_chars", async () => {
    const result = await handleGetRepoMap({ max_chars: 100 }, {
      fsPath: "/storage",
    } as never);

    expect(parseTextResult(result)).toEqual({
      error: "Invalid max_chars: 100. Must be at least 2000.",
    });
  });
});

describe("buildRepoMapPayload", () => {
  it("returns cache metadata, aggregate totals, directories, dependencies, and files", () => {
    const payload = buildRepoMapPayload({
      graph: makeGraph(),
      workspaceRoot: "/workspace",
      collectionName: "al-test",
      structuralCachePath: "/cache/al-test.structural.json",
      maxChars: 20_000,
    });

    expect(payload).toMatchObject({
      workspace_root: "/workspace",
      cache: {
        collection_name: "al-test",
        structural_cache_path: "/cache/al-test.structural.json",
      },
      freshness: {
        graph: {
          status: "available",
          generated_at: "2026-01-01T00:00:00.000Z",
          file_count: 4,
          cache_version: 1,
        },
      },
      scope: { path: ".", matched_files: 4 },
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

  it("reports missing graph and empty scope notes", () => {
    const payload = buildRepoMapPayload({
      graph: makeGraph(),
      graphExists: false,
      scopeRelPath: "src/missing",
      maxChars: 20_000,
    });

    expect(payload).toMatchObject({
      freshness: { graph: { status: "missing" } },
      scope: { path: "src/missing", matched_files: 0 },
      totals: { files: 0 },
    });
    expect(payload.note).toContain("Structural sidecar cache is missing");
  });
});
