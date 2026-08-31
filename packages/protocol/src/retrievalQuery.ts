import type {
  RetrievalChunkRecord,
  RetrievalNamespace,
  RetrievalSourceDocument,
  RetrievalSourceKind,
  RetrievalSourceRevision,
} from "./retrievalRecords.js";

import type { RetrievalHealthReason } from "./retrievalHealth.js";

export interface RetrievalQueryFilter {
  namespaces?: RetrievalNamespace[];
  sourceKinds?: RetrievalSourceKind[];
  sourceIds?: string[];
  pathPrefix?: string;
  metadata?: Record<string, string | number | boolean | null>;
}

export interface RetrievalRankingInput {
  exact?: number;
  lexical?: number;
  vector?: number;
  path?: number;
  source?: number;
  recency?: number;
}

export interface RetrievalDiversityPolicy {
  maxPerSource?: number;
  collapseOverlaps?: boolean;
}

export type RetrievalSourceFreshness =
  | { status: "current" | "not_applicable" }
  | { status: "changed"; currentRevision: RetrievalSourceRevision }
  | { status: "deleted" }
  | { status: "unverified"; reason: string };

export interface RetrievalStaleSource {
  sourceId: string;
  path?: string;
  indexedRevision: RetrievalSourceRevision;
  status: "changed" | "unverified";
  currentRevision?: RetrievalSourceRevision;
  reason?: string;
}

export interface RetrievalQueryFreshnessSummary {
  staleSources: RetrievalStaleSource[];
  deletedSourceIds: string[];
}

export interface RetrievalQuery {
  text: string;
  embedding?: readonly number[];
  mode: "lexical" | "vector" | "hybrid";
  filters?: RetrievalQueryFilter;
  limit: number;
  minimumScore?: number;
  ranking?: RetrievalRankingInput;
  diversity?: RetrievalDiversityPolicy;
  freshness?: "required" | "index_only";
  excludeSourceRevisionIds?: string[];
}

export interface RetrievalCandidateScores {
  exact: number;
  lexical: number;
  vector: number;
  path: number;
  source: number;
  recency: number;
  final: number;
}

export interface RetrievalQueryCandidate {
  chunk: RetrievalChunkRecord;
  source: RetrievalSourceDocument;
  scores: RetrievalCandidateScores;
}

export interface RetrievalQueryResult {
  query: RetrievalQuery;
  candidates: RetrievalQueryCandidate[];
  mode: "lexical" | "vector" | "hybrid";
  degradedReason?: RetrievalHealthReason;
  freshness?: RetrievalQueryFreshnessSummary;
}
