import type {
  RetrievalChunkLocation,
  RetrievalChunkRecord,
  RetrievalNamespace,
  RetrievalRelationRecord,
  RetrievalSourceDocument,
  RetrievalSourceKind,
  RetrievalSourceRevision,
} from "./retrievalRecords.js";
import { expect, expectTypeOf, it } from "vitest";

it("pins retrieval record contracts", () => {
  expectTypeOf<RetrievalNamespace>().toEqualTypeOf<
    "code" | "memory" | "session" | "catalog" | "custom"
  >();
  expectTypeOf<RetrievalSourceKind>().toEqualTypeOf<
    "file" | "memory" | "session" | "instruction" | "skill" | "tool" | "custom"
  >();
  expectTypeOf<RetrievalSourceRevision>().toEqualTypeOf<{
    id: string;
    contentHash: string;
    observedAt: string;
  }>();
  expectTypeOf<RetrievalChunkLocation>().toEqualTypeOf<{
    path?: string;
    startLine?: number;
    endLine?: number;
    scope?: string[];
  }>();
  expectTypeOf<RetrievalSourceDocument>().toEqualTypeOf<{
    id: string;
    namespace: RetrievalNamespace;
    kind: RetrievalSourceKind;
    revision: RetrievalSourceRevision;
    path?: string;
    title?: string;
    content: string;
    metadata: Record<string, string | number | boolean | null>;
  }>();
  expectTypeOf<RetrievalChunkRecord>().toEqualTypeOf<{
    id: string;
    sourceId: string;
    revisionId: string;
    generation: string;
    content: string;
    embedding: readonly number[] | null;
    location?: RetrievalChunkLocation;
    metadata: Record<string, string | number | boolean | null>;
  }>();
  expectTypeOf<RetrievalRelationRecord>().toEqualTypeOf<{
    id: string;
    sourceId: string;
    revisionId: string;
    generation: string;
    fromId: string;
    toId: string;
    kind: string;
    metadata: Record<string, string | number | boolean | null>;
  }>();
});

it("keeps retrieval records serializable across indexer and storage boundaries", () => {
  const source: RetrievalSourceDocument = {
    id: "code:workspace:src/index.ts",
    namespace: "code",
    kind: "file",
    revision: {
      id: "revision-1",
      contentHash: "sha256:content",
      observedAt: "2026-08-30T00:00:00.000Z",
    },
    path: "src/index.ts",
    title: "index.ts",
    content: "export {};",
    metadata: { language: "typescript", indexed: true, rank: 1, empty: null },
  };
  const chunk: RetrievalChunkRecord = {
    id: "chunk-1",
    sourceId: source.id,
    revisionId: source.revision.id,
    generation: "generation-1",
    content: source.content,
    embedding: [0.25, 0.75],
    location: {
      path: source.path,
      startLine: 1,
      endLine: 1,
      scope: ["module"],
    },
    metadata: {},
  };
  const relation: RetrievalRelationRecord = {
    id: "relation-1",
    sourceId: source.id,
    revisionId: source.revision.id,
    generation: chunk.generation,
    fromId: chunk.id,
    toId: "symbol:export",
    kind: "exports",
    metadata: {},
  };

  expect(JSON.parse(JSON.stringify({ source, chunk, relation }))).toEqual({
    source,
    chunk,
    relation,
  });
});
