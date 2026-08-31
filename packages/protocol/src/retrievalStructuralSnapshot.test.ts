import type {
  RetrievalActiveSource,
  RetrievalStructuralSnapshot,
  RetrievalStructuralSnapshotRequest,
} from "./retrievalStructuralSnapshot.js";
import { expect, expectTypeOf, it } from "vitest";

it("pins retrieval structural snapshot contracts", () => {
  expectTypeOf<RetrievalActiveSource>().toEqualTypeOf<{
    source: import("./retrievalRecords.js").RetrievalSourceDocument;
    generation: string;
  }>();
  expectTypeOf<RetrievalStructuralSnapshotRequest>().toEqualTypeOf<{
    expectedFingerprint: import("./retrievalFingerprint.js").RetrievalFingerprint;
    filters?: import("./retrievalQuery.js").RetrievalQueryFilter;
  }>();
  expectTypeOf<RetrievalStructuralSnapshot>().toEqualTypeOf<{
    status: "ready" | "missing" | "rebuild_required" | "unavailable";
    fingerprintDisposition: import("./retrievalFingerprint.js").RetrievalFingerprintDisposition;
    sources: RetrievalActiveSource[];
    relations: import("./retrievalRecords.js").RetrievalRelationRecord[];
  }>();
});

it("keeps retrieval structural snapshots serializable across surfaces", () => {
  const request: RetrievalStructuralSnapshotRequest = {
    expectedFingerprint: {
      schemaVersion: 1,
      chunker: { id: "line", version: 2, configurationHash: "chunker-1" },
      embedding: null,
      recordSchemaVersion: 3,
      relationSchemaVersion: 4,
    },
    filters: { namespaces: ["code"], pathPrefix: "src/" },
  };
  const snapshot: RetrievalStructuralSnapshot = {
    status: "ready",
    fingerprintDisposition: "compatible",
    sources: [
      {
        generation: "generation-1",
        source: {
          id: "source-1",
          namespace: "code",
          kind: "file",
          revision: {
            id: "revision-1",
            contentHash: "content-1",
            observedAt: "2026-08-30T00:00:00.000Z",
          },
          path: "src/example.ts",
          content: "export const example = true;",
          metadata: { language: "typescript" },
        },
      },
    ],
    relations: [
      {
        id: "relation-1",
        sourceId: "source-1",
        revisionId: "revision-1",
        generation: "generation-1",
        fromId: "source-1",
        toId: "symbol-1",
        kind: "exports",
        metadata: {},
      },
    ],
  };

  expect(JSON.parse(JSON.stringify({ request, snapshot }))).toEqual({
    request,
    snapshot,
  });
});
