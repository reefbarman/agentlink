import type {
  RetrievalAbortPublicationOutcome,
  RetrievalPublicationBatchOutcome,
  RetrievalPublicationOutcome,
  RetrievalPublicationPreparation,
  RetrievalPublicationRequest,
  RetrievalStagedChunkBatch,
  RetrievalStagedPublicationBundle,
  RetrievalStagedPublicationInspection,
  RetrievalStagedPublicationManifest,
  RetrievalStagedRelationBatch,
} from "./retrievalPublication.js";
import type {
  RetrievalChunkRecord,
  RetrievalRelationRecord,
  RetrievalSourceDocument,
} from "./retrievalRecords.js";
import { expect, expectTypeOf, it } from "vitest";

it("pins retrieval publication and staging contracts", () => {
  expectTypeOf<RetrievalPublicationRequest>().toEqualTypeOf<{
    publicationId: string;
    generation: string;
    source: RetrievalSourceDocument;
    chunks: RetrievalChunkRecord[];
    relations: RetrievalRelationRecord[];
    expectedChunkIds: string[];
    expectedRelationIds: string[];
  }>();
  expectTypeOf<RetrievalStagedPublicationManifest>().toEqualTypeOf<{
    publicationId: string;
    generation: string;
    fenceToken: string;
    source: RetrievalSourceDocument;
    expectedChunkCount: number;
    expectedRelationCount: number;
    expectedChunkDigest: string;
    expectedRelationDigest: string;
    sourcePayloadDigest: string;
  }>();
  expectTypeOf<RetrievalStagedChunkBatch>().toEqualTypeOf<{
    publicationId: string;
    batchIndex: number;
    expectedIdDigest: string;
    expectedContentDigest: string;
    chunks: RetrievalChunkRecord[];
  }>();
  expectTypeOf<RetrievalStagedRelationBatch>().toEqualTypeOf<{
    publicationId: string;
    batchIndex: number;
    expectedIdDigest: string;
    expectedContentDigest: string;
    relations: RetrievalRelationRecord[];
  }>();
  expectTypeOf<RetrievalStagedPublicationBundle>().toEqualTypeOf<{
    manifest: RetrievalStagedPublicationManifest;
    chunkBatches: RetrievalStagedChunkBatch[];
    relationBatches: RetrievalStagedRelationBatch[];
  }>();
  expectTypeOf<RetrievalStagedPublicationInspection>().toEqualTypeOf<{
    publicationId: string;
    sourceId: string;
    revisionId: string;
    generation: string;
    fenceToken: string;
    state: "staging" | "staged" | "activated";
    expectedChunkCount: number;
    expectedRelationCount: number;
    expectedChunkDigest: string;
    expectedRelationDigest: string;
    sourcePayloadDigest: string;
  }>();
  expectTypeOf<RetrievalPublicationPreparation>().toEqualTypeOf<{
    publicationId: string;
    sourceId: string;
    revisionId: string;
    generation: string;
    status: "prepared";
  }>();
  expectTypeOf<RetrievalPublicationOutcome>().toEqualTypeOf<{
    publicationId: string;
    sourceId?: string;
    revisionId?: string;
    generation?: string;
    status: "published" | "stale_source" | "incomplete" | "not_found";
    recordsAdded: number;
    recordsRemoved: number;
  }>();
  expectTypeOf<RetrievalPublicationBatchOutcome>().toEqualTypeOf<{
    status: "published" | "rejected";
    publications: RetrievalPublicationOutcome[];
    recordsAdded: number;
    recordsRemoved: number;
  }>();
  expectTypeOf<RetrievalAbortPublicationOutcome>().toEqualTypeOf<{
    publicationId: string;
    status: "aborted" | "not_found";
  }>();
});

it("keeps publication DTOs serializable across indexer and storage boundaries", () => {
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
    content: "export {};",
    metadata: {},
  };
  const request: RetrievalPublicationRequest = {
    publicationId: "publication-1",
    generation: "generation-1",
    source,
    chunks: [],
    relations: [],
    expectedChunkIds: [],
    expectedRelationIds: [],
  };
  const bundle: RetrievalStagedPublicationBundle = {
    manifest: {
      publicationId: request.publicationId,
      generation: request.generation,
      fenceToken: "fence-1",
      source,
      expectedChunkCount: 0,
      expectedRelationCount: 0,
      expectedChunkDigest: "chunks",
      expectedRelationDigest: "relations",
      sourcePayloadDigest: "source",
    },
    chunkBatches: [],
    relationBatches: [],
  };

  expect(JSON.parse(JSON.stringify({ request, bundle }))).toEqual({
    request,
    bundle,
  });
});
