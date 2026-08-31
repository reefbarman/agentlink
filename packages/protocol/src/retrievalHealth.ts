import type { RetrievalFingerprintDisposition } from "./retrievalFingerprint.js";

export type RetrievalHealthReason =
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
  | "generic_error";

export type RetrievalLexicalReadiness =
  | { status: "ready" }
  | {
      status: "unavailable";
      reason: RetrievalHealthReason;
      detail?: string;
    };

export interface RetrievalHealthSnapshot {
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
}
