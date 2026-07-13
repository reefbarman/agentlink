import { describe, expect, it } from "vitest";

import {
  projectVisibleStructuralGraph,
  type StructuralFileEntry,
  type StructuralGraphCache,
} from "./structuralGraph.js";
import type { IndexCache } from "./types.js";

function entry(relPath: string): StructuralFileEntry {
  return {
    relPath,
    hash: `${relPath}-hash`,
    indexedAt: "2026-01-01T00:00:00.000Z",
    imports: [],
    exports: [],
    symbols: [],
  };
}

function graph(
  files: Record<string, StructuralFileEntry>,
): StructuralGraphCache {
  return {
    version: 1,
    workspaceRoot: "/workspace",
    generatedAt: "2026-01-01T00:00:00.000Z",
    files,
  };
}

function cache(): IndexCache {
  return { version: 1, files: {} };
}

describe("projectVisibleStructuralGraph", () => {
  it("preserves legacy structural entries without protocol metadata", () => {
    const legacy = entry("src/legacy.ts");

    expect(
      projectVisibleStructuralGraph(graph({ "src/legacy.ts": legacy }), cache())
        .files,
    ).toEqual({
      "src/legacy.ts": legacy,
    });
  });

  it("hides protocol entries until the matching vector generation is current", () => {
    const pending = {
      ...entry("src/changed.ts"),
      generation: "generation-2",
      status: "current" as const,
    };
    const vectorCache = cache();
    vectorCache.files["src/changed.ts"] = {
      hash: pending.hash,
      pointIds: ["point-2"],
      indexedAt: pending.indexedAt,
      generation: pending.generation,
      visibility: "pending",
    };

    expect(
      projectVisibleStructuralGraph(
        graph({ "src/changed.ts": pending }),
        vectorCache,
      ).files,
    ).toEqual({});

    vectorCache.files["src/changed.ts"].visibility = "current";
    expect(
      projectVisibleStructuralGraph(
        graph({ "src/changed.ts": pending }),
        vectorCache,
      ).files,
    ).toEqual({ "src/changed.ts": pending });
  });

  it("hides mismatched structural and vector generations", () => {
    const current = {
      ...entry("src/changed.ts"),
      generation: "generation-2",
      status: "current" as const,
    };
    const vectorCache = cache();
    vectorCache.files["src/changed.ts"] = {
      hash: current.hash,
      pointIds: ["point-1"],
      indexedAt: current.indexedAt,
      generation: "generation-1",
      visibility: "current",
    };

    expect(
      projectVisibleStructuralGraph(
        graph({ "src/changed.ts": current }),
        vectorCache,
      ).files,
    ).toEqual({});
  });
});
