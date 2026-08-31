import type {
  RetrievalFingerprint,
  RetrievalFingerprintDisposition,
} from "./retrievalFingerprint.js";
import type {
  RetrievalRelationRecord,
  RetrievalSourceDocument,
} from "./retrievalRecords.js";

import type { RetrievalQueryFilter } from "./retrievalQuery.js";

export interface RetrievalActiveSource {
  source: RetrievalSourceDocument;
  generation: string;
}

export interface RetrievalStructuralSnapshotRequest {
  expectedFingerprint: RetrievalFingerprint;
  filters?: RetrievalQueryFilter;
}

export interface RetrievalStructuralSnapshot {
  status: "ready" | "missing" | "rebuild_required" | "unavailable";
  fingerprintDisposition: RetrievalFingerprintDisposition;
  sources: RetrievalActiveSource[];
  relations: RetrievalRelationRecord[];
}
