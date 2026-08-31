import type {
  RetrievalHealthReason,
  RetrievalHealthSnapshot,
  RetrievalLexicalReadiness,
} from "./retrievalHealth.js";
import { expect, expectTypeOf, it } from "vitest";

import type { RetrievalFingerprintDisposition } from "./retrievalFingerprint.js";

it("pins retrieval health contracts", () => {
  expectTypeOf<RetrievalHealthReason>().toEqualTypeOf<
    | "disabled"
    | "no_workspace"
    | "missing_index"
    | "store_unavailable"
    | "rebuild_required"
    | "lexical_index_unavailable"
    | "scalar_index_unavailable"
    | "vector_index_unavailable"
    | "structural_index_unavailable"
    | "missing_embeddings_auth"
    | "repair_required"
    | "generic_error"
  >();
  expectTypeOf<RetrievalLexicalReadiness>().toEqualTypeOf<
    | { status: "ready" }
    | {
        status: "unavailable";
        reason: RetrievalHealthReason;
        detail?: string;
      }
  >();
  expectTypeOf<RetrievalHealthSnapshot>().toEqualTypeOf<{
    status: "ready" | "degraded" | "unavailable" | "disabled";
    lexical: "ready" | "unavailable";
    scalar: "ready" | "unavailable";
    vector: "ready" | "unavailable" | "not_configured";
    structural: "ready" | "unavailable";
    embeddingCredentials: "available" | "missing" | "not_required";
    reason?: RetrievalHealthReason;
    reasons: RetrievalHealthReason[];
    details?: Partial<Record<RetrievalHealthReason, string>>;
    fingerprintDisposition: RetrievalFingerprintDisposition;
    pendingPublications: number;
    sourceCount: number;
    chunkCount: number;
    relationCount: number;
    staleSourceCount: number;
  }>();
});

it("keeps retrieval health snapshots serializable across surfaces", () => {
  const snapshot: RetrievalHealthSnapshot = {
    status: "degraded",
    lexical: "ready",
    scalar: "unavailable",
    vector: "not_configured",
    structural: "ready",
    embeddingCredentials: "not_required",
    reason: "scalar_index_unavailable",
    reasons: ["scalar_index_unavailable"],
    details: { scalar_index_unavailable: "index rebuilding" },
    fingerprintDisposition: "compatible",
    pendingPublications: 1,
    sourceCount: 2,
    chunkCount: 3,
    relationCount: 4,
    staleSourceCount: 5,
  };

  expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
});
