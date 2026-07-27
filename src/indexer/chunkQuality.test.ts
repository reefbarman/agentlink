import {
  MAX_CODE_INDEX_CHUNK_CHARS,
  MAX_CODE_INDEX_EMBEDDING_CHARS,
  finalizeCodeChunks,
} from "./chunkQuality.js";
import { describe, expect, it } from "vitest";

import type { Chunk } from "./types.js";

function chunk(overrides: Partial<Chunk> = {}): Chunk {
  return {
    content: "export function search() { return true; }",
    filePath: "/workspace/src/services/search.ts",
    relPath: "src\\services\\search.ts",
    startLine: 10,
    endLine: 10,
    scope: ["class SearchService", "method search"],
    symbolName: "search",
    symbolKind: "method",
    exported: false,
    ...overrides,
  };
}

describe("finalizeCodeChunks", () => {
  it("adds normalized path, full scope, language, and preserves metadata", () => {
    const [result] = finalizeCodeChunks([chunk()]);

    expect(result).toMatchObject({
      language: "typescript",
      scope: ["class SearchService", "method search"],
      symbolName: "search",
      symbolKind: "method",
      exported: false,
    });
    expect(result.embeddingContent).toBe(
      [
        "// src/services/search.ts",
        "// class SearchService > method search",
        "export function search() { return true; }",
      ].join("\n"),
    );
    expect(result.embeddingContent).not.toContain("/workspace/");
  });

  it("hard-splits only giant lines while preserving adjacent lines and metadata", () => {
    const giantLine = "x".repeat(MAX_CODE_INDEX_CHUNK_CHARS * 2 + 1);
    const results = finalizeCodeChunks([
      chunk({
        content: ["before", giantLine, "after"].join("\n"),
        startLine: 20,
        endLine: 22,
      }),
    ]);

    expect(results[0]).toMatchObject({
      content: "before",
      startLine: 20,
      endLine: 20,
    });
    expect(results.at(-1)).toMatchObject({
      content: "after",
      startLine: 22,
      endLine: 22,
    });
    const giantParts = results.filter(
      (result) => result.startLine === 21 && result.endLine === 21,
    );
    expect(giantParts.map((result) => result.content).join("")).toBe(giantLine);
    expect(
      giantParts.every(
        (result) => result.content.length <= MAX_CODE_INDEX_CHUNK_CHARS,
      ),
    ).toBe(true);
    expect(results.every((result) => result.symbolName === "search")).toBe(
      true,
    );
  });

  it("bounds retrieval text", () => {
    const [result] = finalizeCodeChunks([
      chunk({
        content: Array.from({ length: 30 }, () => "x".repeat(900)).join("\n"),
        relPath: `${"directory/".repeat(100)}file.ts`,
        scope: Array.from({ length: 100 }, (_, index) => `scope-${index}`),
      }),
    ]);

    expect(result.embeddingContent!.length).toBeLessThanOrEqual(
      MAX_CODE_INDEX_EMBEDDING_CHARS,
    );
  });
});
