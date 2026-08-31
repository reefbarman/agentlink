import {
  MAX_RETRIEVAL_CHUNK_METADATA_SEARCH_CHARS,
  buildRetrievalChunkSearchText,
} from "./retrievalSearchText.js";
import type {
  RetrievalChunkRecord,
  RetrievalRelationRecord,
  RetrievalSourceDocument,
} from "@agentlink/protocol/retrieval-records";
import { describe, expect, it } from "vitest";

const chunk: RetrievalChunkRecord = {
  id: "chunk:1",
  sourceId: "source:1",
  revisionId: "revision:1",
  generation: "generation:1",
  content: "export const localWinner = true;",
  embedding: null,
  location: {
    path: "src/index.ts",
    startLine: 1,
    endLine: 1,
    scope: ["localWinner"],
  },
  metadata: { language: "typescript", symbolName: "localWinner" },
};

const source: RetrievalSourceDocument = {
  id: chunk.sourceId,
  namespace: "code",
  kind: "file",
  revision: {
    id: chunk.revisionId,
    contentHash: "hash:1",
    observedAt: "2026-07-28T00:00:00.000Z",
  },
  path: "src/index.ts",
  title: "index",
  content: `${chunk.content}\nconst sourceOnlyNeedle = true;`,
  metadata: { language: "typescript" },
};

const relation: RetrievalRelationRecord = {
  id: "relation:1",
  sourceId: chunk.sourceId,
  revisionId: chunk.revisionId,
  generation: chunk.generation,
  fromId: chunk.id,
  toId: "symbol:target",
  kind: "defines",
  metadata: {},
};

describe("retrieval chunk search text", () => {
  it("contains chunk-local content and bounded lexical metadata", () => {
    const text = buildRetrievalChunkSearchText({
      chunk,
      source,
      relations: [relation],
    });

    expect(text).toContain(chunk.content);
    expect(text).toContain("src/index.ts");
    expect(text).toContain("localWinner");
    expect(text).toContain("defines");
    expect(text.length).toBeLessThanOrEqual(
      chunk.content.length + MAX_RETRIEVAL_CHUNK_METADATA_SEARCH_CHARS + 1,
    );
  });

  it("does not copy source-only content into every chunk", () => {
    const text = buildRetrievalChunkSearchText({
      chunk,
      source,
      relations: [],
    });

    expect(text).not.toContain("sourceOnlyNeedle");
    expect(text).not.toContain(source.content);
  });

  it("truncates oversized metadata without truncating chunk content", () => {
    const text = buildRetrievalChunkSearchText({
      chunk,
      source: {
        ...source,
        metadata: { oversized: "x".repeat(100_000) },
      },
      relations: [],
    });

    expect(text.endsWith(chunk.content)).toBe(true);
    expect(text.length).toBe(
      MAX_RETRIEVAL_CHUNK_METADATA_SEARCH_CHARS + 1 + chunk.content.length,
    );
  });
});
