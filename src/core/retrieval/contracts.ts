export type {
  RetrievalDeleteScopeOutcome,
  RetrievalDeleteScopeRequest,
  RetrievalDeleteSourceOutcome,
  RetrievalDeleteSourceRequest,
} from "@agentlink/protocol/retrieval-deletion";
export type {
  RetrievalEmbeddingFingerprint,
  RetrievalFingerprint,
  RetrievalFingerprintDisposition,
} from "@agentlink/protocol/retrieval-fingerprint";
export type {
  RetrievalHealthReason,
  RetrievalHealthSnapshot,
  RetrievalLexicalReadiness,
} from "@agentlink/protocol/retrieval-health";
export type {
  RetrievalAggregateMetrics,
  RetrievalMigrationOutcome,
  RetrievalOptimizeOutcome,
  RetrievalRepairOutcome,
  RetrievalSnapshot,
  RetrievalSnapshotOutcome,
} from "@agentlink/protocol/retrieval-maintenance";
export type {
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
} from "@agentlink/protocol/retrieval-publication";
export type {
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
} from "@agentlink/protocol/retrieval-query";
export type {
  RetrievalChunkLocation,
  RetrievalChunkRecord,
  RetrievalNamespace,
  RetrievalRelationRecord,
  RetrievalSourceDocument,
  RetrievalSourceKind,
  RetrievalSourceRevision,
} from "@agentlink/protocol/retrieval-records";
export type {
  RetrievalActiveSource,
  RetrievalStructuralSnapshot,
  RetrievalStructuralSnapshotRequest,
} from "@agentlink/protocol/retrieval-structural-snapshot";

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
} from "@agentlink/protocol/retrieval-publication";
import type {
  RetrievalActiveSource,
  RetrievalStructuralSnapshot,
  RetrievalStructuralSnapshotRequest,
} from "@agentlink/protocol/retrieval-structural-snapshot";
import type {
  RetrievalAggregateMetrics,
  RetrievalMigrationOutcome,
  RetrievalOptimizeOutcome,
  RetrievalRepairOutcome,
  RetrievalSnapshotOutcome,
} from "@agentlink/protocol/retrieval-maintenance";
import type {
  RetrievalDeleteScopeOutcome,
  RetrievalDeleteScopeRequest,
  RetrievalDeleteSourceOutcome,
  RetrievalDeleteSourceRequest,
} from "@agentlink/protocol/retrieval-deletion";
import type {
  RetrievalFingerprint,
  RetrievalFingerprintDisposition,
} from "@agentlink/protocol/retrieval-fingerprint";
import type {
  RetrievalHealthSnapshot,
  RetrievalLexicalReadiness,
} from "@agentlink/protocol/retrieval-health";
import type {
  RetrievalQuery,
  RetrievalQueryFilter,
  RetrievalQueryResult,
  RetrievalSourceFreshness,
} from "@agentlink/protocol/retrieval-query";
import type {
  RetrievalRelationRecord,
  RetrievalSourceDocument,
} from "@agentlink/protocol/retrieval-records";

export interface StagedRetrievalPublicationRepository {
  /**
   * Stages a complete publication — manifest, every batch, and completion
   * verification — inside a single fenced store session, so per-publication
   * costs (lock, lease heartbeat, connection, table opens) are paid once.
   */
  stagePublication(bundle: RetrievalStagedPublicationBundle): Promise<void>;
  beginStagedPublication(
    manifest: RetrievalStagedPublicationManifest,
  ): Promise<RetrievalPublicationPreparation>;
  appendStagedChunkBatch(batch: RetrievalStagedChunkBatch): Promise<void>;
  appendStagedRelationBatch(batch: RetrievalStagedRelationBatch): Promise<void>;
  completeStagedPublication(publicationId: string): Promise<void>;
  adoptStagedPublication(publicationId: string): Promise<void>;
  abortStagedPublication(publicationId: string): Promise<void>;
  inspectStagedPublication(
    publicationId: string,
  ): Promise<RetrievalStagedPublicationInspection | null>;
}

export interface RetrievalSourceFreshnessVerifier {
  verify(source: RetrievalSourceDocument): Promise<RetrievalSourceFreshness>;
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
  /**
   * Batch variant of deleteSource. Requests must have unique source IDs;
   * outcomes are returned in request order. Implementations should group
   * storage mutations so a large batch does not pay per-source commit costs.
   */
  deleteSources(
    requests: RetrievalDeleteSourceRequest[],
  ): Promise<RetrievalDeleteSourceOutcome[]>;
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
