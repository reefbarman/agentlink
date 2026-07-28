export type RetrievalNamespace =
  | "code"
  | "memory"
  | "session"
  | "catalog"
  | "custom";

export type RetrievalSourceKind =
  | "file"
  | "memory"
  | "session"
  | "instruction"
  | "skill"
  | "tool"
  | "custom";

export interface RetrievalSourceRevision {
  id: string;
  contentHash: string;
  observedAt: string;
}

export interface RetrievalSourceDocument {
  id: string;
  namespace: RetrievalNamespace;
  kind: RetrievalSourceKind;
  revision: RetrievalSourceRevision;
  path?: string;
  title?: string;
  content: string;
  metadata: Record<string, string | number | boolean | null>;
}

export interface RetrievalChunkLocation {
  path?: string;
  startLine?: number;
  endLine?: number;
  scope?: string[];
}

export interface RetrievalChunkRecord {
  id: string;
  sourceId: string;
  revisionId: string;
  generation: string;
  content: string;
  embedding: readonly number[] | null;
  location?: RetrievalChunkLocation;
  metadata: Record<string, string | number | boolean | null>;
}

export interface RetrievalRelationRecord {
  id: string;
  sourceId: string;
  revisionId: string;
  generation: string;
  fromId: string;
  toId: string;
  kind: string;
  metadata: Record<string, string | number | boolean | null>;
}

export interface RetrievalEmbeddingFingerprint {
  provider: string;
  model: string;
  endpointContract: string;
  dimensions: number;
}

export interface RetrievalFingerprint {
  schemaVersion: number;
  chunker: {
    id: string;
    version: number;
    configurationHash: string;
  };
  embedding: RetrievalEmbeddingFingerprint | null;
  recordSchemaVersion: number;
  relationSchemaVersion: number;
}

export type RetrievalFingerprintDisposition =
  | "compatible"
  | "initialize"
  | "rebuild_required";

export interface RetrievalPublicationRequest {
  publicationId: string;
  generation: string;
  source: RetrievalSourceDocument;
  chunks: RetrievalChunkRecord[];
  relations: RetrievalRelationRecord[];
  expectedChunkIds: string[];
  expectedRelationIds: string[];
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

export interface RetrievalSourceFreshnessVerifier {
  verify(source: RetrievalSourceDocument): Promise<RetrievalSourceFreshness>;
}

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

export interface RetrievalSnapshot {
  id: string;
  createdAt: string;
  label?: string;
  sourceCount: number;
  chunkCount: number;
  relationCount: number;
}

export interface RetrievalSnapshotOutcome {
  status: "created" | "restored" | "not_found";
  snapshot?: RetrievalSnapshot;
}

export interface RetrievalRepairOutcome {
  status: "clean" | "repaired";
  abandonedPublications: number;
  orphanedChunksRemoved: number;
  orphanedRelationsRemoved: number;
}

export interface RetrievalOptimizeOutcome {
  status: "optimized";
  recordsCompacted: number;
  /** Optional best-effort physical storage metric when the backend can measure it. */
  bytesReclaimed?: number;
}

export interface RetrievalMigrationOutcome {
  status: "up_to_date" | "migrated" | "rebuild_required";
  fromVersion: number | null;
  toVersion: number;
}

export interface RetrievalAggregateMetrics {
  sourcesScanned: number;
  sourcesPublished: number;
  sourcesDeleted: number;
  recordsAdded: number;
  recordsRemoved: number;
  queries: number;
  lexicalQueries: number;
  vectorQueries: number;
  hybridQueries: number;
  recoveries: number;
  snapshotsCreated: number;
  snapshotsRestored: number;
  repairs: number;
  optimizations: number;
}

export interface RetrievalRepository {
  inspectFingerprint(
    expected: RetrievalFingerprint,
  ): Promise<RetrievalFingerprintDisposition>;
  migrate(expected: RetrievalFingerprint): Promise<RetrievalMigrationOutcome>;
  preparePublication(
    request: RetrievalPublicationRequest,
  ): Promise<RetrievalPublicationPreparation>;
  /** Batch requests must have unique publication IDs and source IDs. */
  preparePublicationBatch(
    requests: RetrievalPublicationRequest[],
  ): Promise<RetrievalPublicationPreparation[]>;
  commitPublication(
    publicationId: string,
  ): Promise<RetrievalPublicationOutcome>;
  /** Pending batch members must resolve to unique source IDs. */
  commitPublicationBatch(
    publicationIds: string[],
  ): Promise<RetrievalPublicationBatchOutcome>;
  abortPublication(
    publicationId: string,
  ): Promise<RetrievalAbortPublicationOutcome>;
  inspectSource(sourceId: string): Promise<RetrievalActiveSource | null>;
  listSources(filters?: RetrievalQueryFilter): Promise<RetrievalActiveSource[]>;
  structuralSnapshot(
    request: RetrievalStructuralSnapshotRequest,
  ): Promise<RetrievalStructuralSnapshot>;
  recoverPublications(): Promise<RetrievalRepairOutcome>;
  deleteSource(
    request: RetrievalDeleteSourceRequest,
  ): Promise<RetrievalDeleteSourceOutcome>;
  deleteScope(
    request: RetrievalDeleteScopeRequest,
  ): Promise<RetrievalDeleteScopeOutcome>;
  query(request: RetrievalQuery): Promise<RetrievalQueryResult>;
  relations(sourceIds?: string[]): Promise<RetrievalRelationRecord[]>;
  lexicalReadiness(): Promise<RetrievalLexicalReadiness>;
  health(): Promise<RetrievalHealthSnapshot>;
  createSnapshot(label?: string): Promise<RetrievalSnapshotOutcome>;
  restoreSnapshot(snapshotId: string): Promise<RetrievalSnapshotOutcome>;
  repair(): Promise<RetrievalRepairOutcome>;
  optimize(): Promise<RetrievalOptimizeOutcome>;
  metrics(): RetrievalAggregateMetrics;
}
