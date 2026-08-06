import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  buildModuleNeighborsPayload,
  handleGetModuleNeighbors,
} from "./getModuleNeighbors.js";
import { describe, expect, it } from "vitest";

import type { StructuralGraphCache } from "../indexer/structuralGraph.js";
import type { StructuralGraphProvider } from "../core/capabilities/readSearch.js";

function parseTextResult(
  result: Awaited<ReturnType<typeof handleGetModuleNeighbors>>,
) {
  const [content] = result.content;
  expect(content.type).toBe("text");
  if (content.type !== "text") throw new Error("expected text result");
  return JSON.parse(content.text) as Record<string, unknown>;
}

function makeProvider(
  graph: StructuralGraphCache = makeGraph(),
): StructuralGraphProvider {
  return {
    resolveWorkspaceRoot() {
      return "/workspace";
    },
    resolvePath(inputPath) {
      if (inputPath === "../outside.ts") {
        return { absolutePath: "/outside.ts", inWorkspace: false };
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
    getScopeStatus() {
      return "indexed";
    },
    getTargetFreshness() {
      return { status: "fresh", indexed_at: "2026-01-01T00:00:00.000Z" };
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
      "src/bar.ts": {
        relPath: "src/bar.ts",
        hash: "bar-hash",
        indexedAt: "2026-01-01T00:00:00.000Z",
        imports: [
          {
            specifier: "./baz",
            kind: "static",
            resolvedRelPath: "src/baz.ts",
            imported: ["baz"],
            line: 1,
          },
        ],
        exports: [{ name: "bar", kind: "named", line: 3 }],
        symbols: [{ name: "bar", kind: "function", exported: true, line: 3 }],
      },
      "src/foo.ts": {
        relPath: "src/foo.ts",
        hash: "foo-hash",
        indexedAt: "2026-01-01T00:00:00.000Z",
        imports: [
          {
            specifier: "./bar",
            kind: "static",
            resolvedRelPath: "src/bar.ts",
            imported: ["bar"],
            line: 1,
          },
        ],
        exports: [],
        symbols: [],
      },
      "src/nested/qux.ts": {
        relPath: "src/nested/qux.ts",
        hash: "qux-hash",
        indexedAt: "2026-01-01T00:00:00.000Z",
        imports: [
          {
            specifier: "../bar",
            kind: "reexport",
            resolvedRelPath: "src/bar.ts",
            line: 2,
          },
        ],
        exports: [{ name: "*", kind: "reexport", source: "../bar", line: 2 }],
        symbols: [],
      },
    },
  };
}

describe("handleGetModuleNeighbors", () => {
  it("returns the legacy unavailable error when structural graph provider is unavailable", async () => {
    const result = await handleGetModuleNeighbors(
      { path: "src/foo.ts" },
      undefined,
    );

    expect(parseTextResult(result)).toEqual({
      error:
        "get_module_neighbors is unavailable without global storage context.",
      path: "src/foo.ts",
    });
    expect(result).toMatchObject({
      data: {
        error:
          "get_module_neighbors is unavailable without global storage context.",
        path: "src/foo.ts",
      },
      isError: true,
      error: { kind: "tool_error" },
    });
  });

  it("returns an error result for non-positive max_results", async () => {
    const result = await handleGetModuleNeighbors(
      { path: "src/foo.ts", max_results: 0 },
      makeProvider(),
    );

    expect(parseTextResult(result)).toEqual({
      error: "Invalid max_results: 0. Must be a positive number.",
      path: "src/foo.ts",
    });
  });

  it("maps canonical targets through a symlinked workspace root", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "neighbors-root-"));
    try {
      const physicalRoot = path.join(directory, "physical");
      const workspaceRoot = path.join(directory, "workspace-link");
      const target = path.join(physicalRoot, "src", "bar.ts");
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, "export function bar() {}", "utf8");
      fs.symlinkSync(physicalRoot, workspaceRoot, "dir");
      const provider = makeProvider();
      provider.resolvePath = () => ({
        absolutePath: fs.realpathSync(target),
        inWorkspace: true,
      });
      provider.getWorkspaceRootForPath = () => workspaceRoot;

      const result = await handleGetModuleNeighbors(
        { path: path.join(workspaceRoot, "src", "bar.ts") },
        provider,
      );

      expect(parseTextResult(result)).toMatchObject({
        path: "src/bar.ts",
        imports: { total: 1 },
        dependents: { total: 2 },
      });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("builds module neighbors from an injected structural graph provider", async () => {
    const result = await handleGetModuleNeighbors(
      { path: "src/bar.ts" },
      makeProvider(),
    );

    expect(result.isError).toBe(false);
    expect(result.data).toEqual(parseTextResult(result));
    expect(parseTextResult(result)).toMatchObject({
      path: "src/bar.ts",
      workspace_root: "/workspace",
      cache: {
        index_name: "al-test",
        structural_store_path: "/cache/al-test.structural.json",
      },
      freshness: {
        target: { status: "fresh" },
        graph: { status: "available", file_count: 3 },
      },
      dependents: { total: 2 },
    });
  });
});

describe("buildModuleNeighborsPayload", () => {
  it("returns imports, exports, symbols, dependents, and freshness metadata", () => {
    const payload = buildModuleNeighborsPayload({
      graph: makeGraph(),
      targetRelPath: "src/bar.ts",
    });

    expect(payload).toMatchObject({
      path: "src/bar.ts",
      freshness: {
        target: { status: "unknown" },
        graph: {
          status: "available",
          generated_at: "2026-01-01T00:00:00.000Z",
          file_count: 3,
          cache_version: 1,
        },
      },
      imports: {
        total: 1,
        truncated: false,
        items: [
          {
            specifier: "./baz",
            kind: "static",
            resolvedRelPath: "src/baz.ts",
            imported: ["baz"],
            line: 1,
          },
        ],
      },
      exports: {
        total: 1,
        truncated: false,
        items: [{ name: "bar", kind: "named", line: 3 }],
      },
      symbols: {
        total: 1,
        truncated: false,
        items: [{ name: "bar", kind: "function", exported: true, line: 3 }],
      },
      dependents: {
        total: 2,
        truncated: false,
        items: [
          {
            path: "src/foo.ts",
            imports: [
              {
                specifier: "./bar",
                kind: "static",
                resolvedRelPath: "src/bar.ts",
                imported: ["bar"],
                line: 1,
              },
            ],
          },
          {
            path: "src/nested/qux.ts",
            imports: [
              {
                specifier: "../bar",
                kind: "reexport",
                resolvedRelPath: "src/bar.ts",
                line: 2,
              },
            ],
          },
        ],
      },
    });
  });

  it("normalizes target paths before matching", () => {
    const payload = buildModuleNeighborsPayload({
      graph: makeGraph(),
      targetRelPath: "src\\bar.ts",
    });

    expect(payload).toMatchObject({
      path: "src/bar.ts",
      dependents: { total: 2 },
    });
  });

  it("limits each list independently and marks truncation", () => {
    const graph = makeGraph();
    graph.files["src/bar.ts"].imports.push({
      specifier: "./extra",
      kind: "dynamic",
      resolvedRelPath: "src/extra.ts",
      line: 4,
    });
    graph.files["src/a.ts"] = {
      relPath: "src/a.ts",
      hash: "a-hash",
      indexedAt: "2026-01-01T00:00:00.000Z",
      imports: [
        {
          specifier: "./bar",
          kind: "static",
          resolvedRelPath: "src/bar.ts",
          line: 1,
        },
      ],
      exports: [],
      symbols: [],
    };

    const payload = buildModuleNeighborsPayload({
      graph,
      targetRelPath: "src/bar.ts",
      maxResults: 1,
    });

    expect(payload).toMatchObject({
      imports: { total: 2, truncated: true, items: [{ specifier: "./baz" }] },
      dependents: { total: 3, truncated: true, items: [{ path: "src/a.ts" }] },
    });
  });

  it("reports missing target and missing graph notes", () => {
    const payload = buildModuleNeighborsPayload({
      graph: makeGraph(),
      targetRelPath: "src/missing.ts",
      graphExists: false,
    });

    expect(payload).toMatchObject({
      path: "src/missing.ts",
      freshness: {
        target: { status: "missing_from_graph" },
        graph: { status: "missing" },
      },
      imports: { total: 0, truncated: false, items: [] },
      dependents: { total: 0, truncated: false, items: [] },
    });
    expect(payload.note).toContain("Structural index is unavailable");
  });
});
