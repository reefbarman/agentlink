import type {
  RetrievalChunkRecord,
  RetrievalRelationRecord,
  RetrievalSourceDocument,
} from "./retrievalRecords.js";

export interface RetrievalPublicationRequest {
  publicationId: string;
  generation: string;
  source: RetrievalSourceDocument;
  chunks: RetrievalChunkRecord[];
  relations: RetrievalRelationRecord[];
  expectedChunkIds: string[];
  expectedRelationIds: string[];
}

export interface RetrievalStagedPublicationManifest {
  publicationId: string;
  generation: string;
  fenceToken: string;
  source: RetrievalSourceDocument;
  expectedChunkCount: number;
  expectedRelationCount: number;
  expectedChunkDigest: string;
  expectedRelationDigest: string;
  sourcePayloadDigest: string;
}

export interface RetrievalStagedChunkBatch {
  publicationId: string;
  batchIndex: number;
  expectedIdDigest: string;
  expectedContentDigest: string;
  chunks: RetrievalChunkRecord[];
}

export interface RetrievalStagedRelationBatch {
  publicationId: string;
  batchIndex: number;
  expectedIdDigest: string;
  expectedContentDigest: string;
  relations: RetrievalRelationRecord[];
}

export interface RetrievalStagedPublicationBundle {
  manifest: RetrievalStagedPublicationManifest;
  chunkBatches: RetrievalStagedChunkBatch[];
  relationBatches: RetrievalStagedRelationBatch[];
}

export interface RetrievalStagedPublicationInspection {
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
}

export interface RetrievalPublicationPreparation {
  publicationId: string;
  sourceId: string;
  revisionId: string;
  generation: string;
  status: "prepared";
}

export interface RetrievalPublicationOutcome {
  publicationId: string;
  sourceId?: string;
  revisionId?: string;
  generation?: string;
  status: "published" | "stale_source" | "incomplete" | "not_found";
  recordsAdded: number;
  recordsRemoved: number;
}

export interface RetrievalPublicationBatchOutcome {
  status: "published" | "rejected";
  publications: RetrievalPublicationOutcome[];
  recordsAdded: number;
  recordsRemoved: number;
}

export interface RetrievalAbortPublicationOutcome {
  publicationId: string;
  status: "aborted" | "not_found";
}
