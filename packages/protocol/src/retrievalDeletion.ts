import type { RetrievalNamespace } from "./retrievalRecords.js";

export interface RetrievalDeleteSourceRequest {
  sourceId: string;
  expectedRevisionId?: string;
}

export interface RetrievalDeleteSourceOutcome {
  sourceId: string;
  status: "deleted" | "stale_source" | "not_found";
  recordsRemoved: number;
}

export interface RetrievalDeleteScopeRequest {
  namespaces?: RetrievalNamespace[];
  metadata?: Record<string, string | number | boolean | null>;
  sourceIdPrefix?: string;
}

export interface RetrievalDeleteScopeOutcome {
  sourcesDeleted: number;
  recordsRemoved: number;
}
