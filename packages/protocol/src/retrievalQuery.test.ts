import type {
  RetrievalCandidateScores,
  RetrievalDiversityPolicy,
  RetrievalQuery,
  RetrievalQueryCandidate,
  RetrievalQueryFilter,
  RetrievalQueryFreshnessSummary,
  RetrievalQueryResult,
  RetrievalRankingInput,
  RetrievalSourceFreshness,
  RetrievalStaleSource,
} from "./retrievalQuery.js";
import type {
  RetrievalChunkRecord,
  RetrievalNamespace,
  RetrievalSourceDocument,
  RetrievalSourceKind,
  RetrievalSourceRevision,
} from "./retrievalRecords.js";
import { expect, expectTypeOf, it } from "vitest";

import type { RetrievalHealthReason } from "./retrievalHealth.js";

it("pins retrieval query and freshness contracts", () => {
  expectTypeOf<RetrievalQueryFilter>().toEqualTypeOf<{
    namespaces?: RetrievalNamespace[];
    sourceKinds?: RetrievalSourceKind[];
    sourceIds?: string[];
    pathPrefix?: string;
    metadata?: Record<string, string | number | boolean | null>;
  }>();
  expectTypeOf<RetrievalRankingInput>().toEqualTypeOf<{
    exact?: number;
    lexical?: number;
    vector?: number;
    path?: number;
    source?: number;
    recency?: number;
  }>();
  expectTypeOf<RetrievalDiversityPolicy>().toEqualTypeOf<{
    maxPerSource?: number;
    collapseOverlaps?: boolean;
  }>();
  expectTypeOf<RetrievalSourceFreshness>().toEqualTypeOf<
    | { status: "current" | "not_applicable" }
    | { status: "changed"; currentRevision: RetrievalSourceRevision }
    | { status: "deleted" }
    | { status: "unverified"; reason: string }
  >();
  expectTypeOf<RetrievalStaleSource>().toEqualTypeOf<{
    sourceId: string;
    path?: string;
    indexedRevision: RetrievalSourceRevision;
    status: "changed" | "unverified";
    currentRevision?: RetrievalSourceRevision;
    reason?: string;
  }>();
  expectTypeOf<RetrievalQueryFreshnessSummary>().toEqualTypeOf<{
    staleSources: RetrievalStaleSource[];
    deletedSourceIds: string[];
  }>();
  expectTypeOf<RetrievalQuery>().toEqualTypeOf<{
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
  }>();
  expectTypeOf<RetrievalCandidateScores>().toEqualTypeOf<{
    exact: number;
    lexical: number;
    vector: number;
    path: number;
    source: number;
    recency: number;
    final: number;
  }>();
  expectTypeOf<RetrievalQueryCandidate>().toEqualTypeOf<{
    chunk: RetrievalChunkRecord;
    source: RetrievalSourceDocument;
    scores: RetrievalCandidateScores;
  }>();
  expectTypeOf<RetrievalQueryResult>().toEqualTypeOf<{
    query: RetrievalQuery;
    candidates: RetrievalQueryCandidate[];
    mode: "lexical" | "vector" | "hybrid";
    degradedReason?: RetrievalHealthReason;
    freshness?: RetrievalQueryFreshnessSummary;
  }>();
});

it("keeps retrieval queries serializable across service and storage boundaries", () => {
  const query: RetrievalQuery = {
    text: "retrieval query DTO",
    embedding: [0.25, 0.75],
    mode: "hybrid",
    filters: {
      namespaces: ["code"],
      sourceKinds: ["file"],
      pathPrefix: "src/",
      metadata: { language: "typescript" },
    },
    limit: 10,
    minimumScore: 0.2,
    ranking: { lexical: 0.5, vector: 0.5 },
    diversity: { maxPerSource: 2, collapseOverlaps: true },
    freshness: "required",
    excludeSourceRevisionIds: ["revision-old"],
  };

  expect(JSON.parse(JSON.stringify(query))).toEqual(query);
});
