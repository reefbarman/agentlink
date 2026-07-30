import type {
  RetrievalAbortPublicationOutcome,
  RetrievalActiveSource,
  RetrievalAggregateMetrics,
  RetrievalChunkRecord,
  RetrievalDeleteScopeOutcome,
  RetrievalDeleteScopeRequest,
  RetrievalDeleteSourceOutcome,
  RetrievalDeleteSourceRequest,
  RetrievalFingerprint,
  RetrievalFingerprintDisposition,
  RetrievalHealthReason,
  RetrievalHealthSnapshot,
  RetrievalLexicalReadiness,
  RetrievalMigrationOutcome,
  RetrievalOptimizeOutcome,
  RetrievalPublicationBatchOutcome,
  RetrievalPublicationOutcome,
  RetrievalPublicationPreparation,
  RetrievalPublicationRequest,
  RetrievalQuery,
  RetrievalQueryCandidate,
  RetrievalQueryFilter,
  RetrievalQueryFreshnessSummary,
  RetrievalQueryResult,
  RetrievalRelationRecord,
  RetrievalRepairOutcome,
  RetrievalRepository,
  RetrievalSnapshot,
  RetrievalSnapshotOutcome,
  RetrievalSourceDocument,
  RetrievalSourceFreshnessVerifier,
  RetrievalStaleSource,
  RetrievalStructuralSnapshot,
  RetrievalStructuralSnapshotRequest,
} from "./contracts.js";
import {
  compareRetrievalCandidates,
  diversifyRetrievalCandidates,
  hasRetrievalSignal,
  normalizeRetrievalPath,
  resolveRetrievalRankingWeights,
  scoreRetrievalCandidate,
} from "./ranking.js";
import {
  compareRetrievalSourceRevisions,
  validateRetrievalSourceRevision,
} from "./revisionOrder.js";

import { classifyRetrievalFingerprint } from "./fingerprint.js";

export interface InMemoryRetrievalRepositoryOptions {
  enabled?: boolean;
  workspaceAvailable?: boolean;
  storeAvailable?: boolean;
  lexicalAvailable?: boolean;
  scalarAvailable?: boolean;
  vectorIndexAvailable?: boolean;
  structuralAvailable?: boolean;
  embeddingConfigured?: boolean;
  embeddingAvailable?: boolean;
  repairRequired?: boolean;
  freshnessVerifier?: RetrievalSourceFreshnessVerifier;
  fingerprint?: RetrievalFingerprint | null;
  now?: () => string;
  createId?: () => string;
}

interface RepositoryState {
  fingerprint: RetrievalFingerprint | null;
  sources: Map<string, RetrievalSourceDocument>;
  sourceGenerations: Map<string, string>;
  chunks: Map<string, RetrievalChunkRecord>;
  relations: Map<string, RetrievalRelationRecord>;
  sourceRevisionTombstones: Map<string, RetrievalSourceDocument["revision"]>;
}

interface StoredSnapshot {
  descriptor: RetrievalSnapshot;
  state: RepositoryState;
}

export class InMemoryRetrievalRepository implements RetrievalRepository {
  private state: RepositoryState;
  private readonly pending = new Map<string, RetrievalPublicationRequest>();
  private readonly snapshots = new Map<string, StoredSnapshot>();
  private readonly now: () => string;
  private readonly createId: () => string;
  private readonly enabled: boolean;
  private readonly workspaceAvailable: boolean;
  private readonly storeAvailable: boolean;
  private lexicalAvailable: boolean;
  private scalarAvailable: boolean;
  private vectorIndexAvailable: boolean;
  private structuralAvailable: boolean;
  private readonly embeddingConfigured: boolean;
  private embeddingAvailable: boolean;
  private repairRequired: boolean;
  private initialized: boolean;
  private readonly freshnessVerifier?: RetrievalSourceFreshnessVerifier;
  private readonly staleSourceIds = new Set<string>();
  private fingerprintDisposition: RetrievalFingerprintDisposition;
  private snapshotSequence = 0;
  private readonly aggregate: RetrievalAggregateMetrics = {
    sourcesScanned: 0,
    sourcesPublished: 0,
    sourcesDeleted: 0,
    recordsAdded: 0,
    recordsRemoved: 0,
    queries: 0,
    lexicalQueries: 0,
    vectorQueries: 0,
    hybridQueries: 0,
    recoveries: 0,
    snapshotsCreated: 0,
    snapshotsRestored: 0,
    repairs: 0,
    optimizations: 0,
  };

  constructor(options: InMemoryRetrievalRepositoryOptions = {}) {
    this.state = {
      fingerprint: clone(options.fingerprint ?? null),
      sources: new Map(),
      sourceGenerations: new Map(),
      chunks: new Map(),
      relations: new Map(),
      sourceRevisionTombstones: new Map(),
    };
    this.now = options.now ?? (() => new Date().toISOString());
    this.createId =
      options.createId ?? (() => `snapshot-${++this.snapshotSequence}`);
    this.enabled = options.enabled ?? true;
    this.workspaceAvailable = options.workspaceAvailable ?? true;
    this.storeAvailable = options.storeAvailable ?? true;
    this.lexicalAvailable = options.lexicalAvailable ?? true;
    this.scalarAvailable = options.scalarAvailable ?? true;
    this.vectorIndexAvailable = options.vectorIndexAvailable ?? true;
    this.structuralAvailable = options.structuralAvailable ?? true;
    this.embeddingConfigured = options.embeddingConfigured ?? true;
    this.embeddingAvailable = options.embeddingAvailable ?? true;
    this.repairRequired = options.repairRequired ?? false;
    this.initialized = options.fingerprint !== undefined;
    this.freshnessVerifier = options.freshnessVerifier;
    this.fingerprintDisposition = this.state.fingerprint
      ? "compatible"
      : "initialize";
  }

  async inspectFingerprint(
    expected: RetrievalFingerprint,
  ): Promise<RetrievalFingerprintDisposition> {
    this.fingerprintDisposition = classifyRetrievalFingerprint(
      this.state.fingerprint,
      expected,
    );
    return this.fingerprintDisposition;
  }

  async migrate(
    expected: RetrievalFingerprint,
  ): Promise<RetrievalMigrationOutcome> {
    const disposition = await this.inspectFingerprint(expected);
    if (disposition === "compatible") {
      return {
        status: "up_to_date",
        fromVersion: this.state.fingerprint?.schemaVersion ?? null,
        toVersion: expected.schemaVersion,
      };
    }
    if (disposition === "rebuild_required") {
      return {
        status: "rebuild_required",
        fromVersion: this.state.fingerprint?.schemaVersion ?? null,
        toVersion: expected.schemaVersion,
      };
    }

    this.state.fingerprint = clone(expected);
    this.fingerprintDisposition = "compatible";
    this.initialized = true;
    return {
      status: "migrated",
      fromVersion: null,
      toVersion: expected.schemaVersion,
    };
  }

  async preparePublication(
    request: RetrievalPublicationRequest,
  ): Promise<RetrievalPublicationPreparation> {
    validateRetrievalPublicationRequest(request);
    validateRetrievalSourceRevision(request.source.revision);
    if (this.pending.has(request.publicationId)) {
      throw new Error(`Publication already exists: ${request.publicationId}`);
    }
    this.aggregate.sourcesScanned += 1;
    this.pending.set(request.publicationId, clone(request));
    return {
      publicationId: request.publicationId,
      sourceId: request.source.id,
      revisionId: request.source.revision.id,
      generation: request.generation,
      status: "prepared",
    };
  }

  async preparePublicationBatch(
    requests: RetrievalPublicationRequest[],
  ): Promise<RetrievalPublicationPreparation[]> {
    validateUniqueIds(
      requests.map((request) => request.publicationId),
      "publication",
    );
    validateUniqueIds(
      requests.map((request) => request.source.id),
      "publication source",
    );
    const originalPending = new Map(
      [...this.pending].map(([id, request]) => [id, clone(request)]),
    );
    const originalAggregate = clone(this.aggregate);
    const prepared: RetrievalPublicationPreparation[] = [];
    try {
      for (const request of requests) {
        prepared.push(await this.preparePublication(request));
      }
      return prepared;
    } catch (error) {
      this.pending.clear();
      for (const [id, request] of originalPending) {
        this.pending.set(id, request);
      }
      Object.assign(this.aggregate, originalAggregate);
      throw error;
    }
  }

  async commitPublication(
    publicationId: string,
  ): Promise<RetrievalPublicationOutcome> {
    const request = this.pending.get(publicationId);
    if (!request) return missingPublication(publicationId);
    this.pending.delete(publicationId);

    if (!publicationIsComplete(request)) {
      return publicationOutcome(request, "incomplete", 0, 0);
    }

    const current = this.state.sources.get(request.source.id);
    const tombstone = this.state.sourceRevisionTombstones.get(
      request.source.id,
    );
    if (
      (current &&
        compareRetrievalSourceRevisions(
          current.revision,
          request.source.revision,
        ) > 0) ||
      (tombstone &&
        compareRetrievalSourceRevisions(tombstone, request.source.revision) >=
          0)
    ) {
      return publicationOutcome(request, "stale_source", 0, 0);
    }

    const oldChunkIds = idsForSource(this.state.chunks, request.source.id);
    const oldRelationIds = idsForSource(
      this.state.relations,
      request.source.id,
    );
    for (const id of oldChunkIds) this.state.chunks.delete(id);
    for (const id of oldRelationIds) this.state.relations.delete(id);

    this.state.sources.set(request.source.id, clone(request.source));
    this.state.sourceGenerations.set(request.source.id, request.generation);
    this.state.sourceRevisionTombstones.delete(request.source.id);
    this.initialized = true;
    this.staleSourceIds.delete(request.source.id);
    for (const chunk of request.chunks) {
      this.state.chunks.set(chunk.id, clone(chunk));
    }
    for (const relation of request.relations) {
      this.state.relations.set(relation.id, clone(relation));
    }

    const recordsAdded = 1 + request.chunks.length + request.relations.length;
    const recordsRemoved =
      (current ? 1 : 0) + oldChunkIds.length + oldRelationIds.length;
    this.aggregate.sourcesPublished += 1;
    this.aggregate.recordsAdded += recordsAdded;
    this.aggregate.recordsRemoved += recordsRemoved;
    return publicationOutcome(
      request,
      "published",
      recordsAdded,
      recordsRemoved,
    );
  }

  async commitPublicationBatch(
    publicationIds: string[],
  ): Promise<RetrievalPublicationBatchOutcome> {
    validateUniqueIds(publicationIds, "publication");
    const pendingRequests = publicationIds.flatMap((publicationId) => {
      const request = this.pending.get(publicationId);
      return request ? [request] : [];
    });
    if (pendingRequests.length === publicationIds.length) {
      validateUniqueIds(
        pendingRequests.map((request) => request.source.id),
        "publication source",
      );
    }
    if (publicationIds.length === 0) {
      return {
        status: "published",
        publications: [],
        recordsAdded: 0,
        recordsRemoved: 0,
      };
    }
    const originalState = cloneState(this.state);
    const originalPending = new Map(
      [...this.pending].map(([id, request]) => [id, clone(request)]),
    );
    const originalAggregate = clone(this.aggregate);
    const originalInitialized = this.initialized;
    const originalStaleSourceIds = new Set(this.staleSourceIds);
    const publications: RetrievalPublicationOutcome[] = [];
    try {
      for (const publicationId of publicationIds) {
        const outcome = await this.commitPublication(publicationId);
        publications.push(outcome);
        if (outcome.status !== "published") {
          this.state = originalState;
          this.pending.clear();
          for (const [id, request] of originalPending) {
            this.pending.set(id, request);
          }
          Object.assign(this.aggregate, originalAggregate);
          this.initialized = originalInitialized;
          this.staleSourceIds.clear();
          for (const sourceId of originalStaleSourceIds) {
            this.staleSourceIds.add(sourceId);
          }
          return {
            status: "rejected",
            publications,
            recordsAdded: 0,
            recordsRemoved: 0,
          };
        }
      }
      return {
        status: "published",
        publications,
        recordsAdded: publications.reduce(
          (total, publication) => total + publication.recordsAdded,
          0,
        ),
        recordsRemoved: publications.reduce(
          (total, publication) => total + publication.recordsRemoved,
          0,
        ),
      };
    } catch (error) {
      this.state = originalState;
      this.pending.clear();
      for (const [id, request] of originalPending) {
        this.pending.set(id, request);
      }
      Object.assign(this.aggregate, originalAggregate);
      this.initialized = originalInitialized;
      this.staleSourceIds.clear();
      for (const sourceId of originalStaleSourceIds) {
        this.staleSourceIds.add(sourceId);
      }
      throw error;
    }
  }

  async abortPublication(
    publicationId: string,
  ): Promise<RetrievalAbortPublicationOutcome> {
    const status = this.pending.delete(publicationId) ? "aborted" : "not_found";
    return { publicationId, status };
  }

  async inspectSource(sourceId: string): Promise<RetrievalActiveSource | null> {
    const source = this.state.sources.get(sourceId);
    const generation = this.state.sourceGenerations.get(sourceId);
    return source && generation ? { source: clone(source), generation } : null;
  }

  async listSources(
    filters?: RetrievalQueryFilter,
  ): Promise<RetrievalActiveSource[]> {
    return [...this.state.sources.values()]
      .filter(
        (source) =>
          matchesSourceFilter(source, filters) &&
          matchesSourceMetadata(source, filters?.metadata),
      )
      .sort((left, right) => left.id.localeCompare(right.id))
      .flatMap((source) => {
        const generation = this.state.sourceGenerations.get(source.id);
        return generation ? [{ source: clone(source), generation }] : [];
      });
  }

  async structuralSnapshot(
    request: RetrievalStructuralSnapshotRequest,
  ): Promise<RetrievalStructuralSnapshot> {
    const fingerprintDisposition = classifyRetrievalFingerprint(
      this.state.fingerprint,
      request.expectedFingerprint,
    );
    if (fingerprintDisposition !== "compatible") {
      return {
        status:
          fingerprintDisposition === "rebuild_required"
            ? "rebuild_required"
            : "missing",
        fingerprintDisposition,
        sources: [],
        relations: [],
      };
    }

    const filters = request.filters;
    const sources = [...this.state.sources.values()]
      .filter(
        (source) =>
          matchesSourceFilter(source, filters) &&
          matchesSourceMetadata(source, filters?.metadata),
      )
      .sort((left, right) => left.id.localeCompare(right.id))
      .flatMap((source) => {
        const generation = this.state.sourceGenerations.get(source.id);
        return generation ? [{ source: clone(source), generation }] : [];
      });
    const active = new Map(
      sources.map(({ source, generation }) => [
        source.id,
        { revisionId: source.revision.id, generation },
      ]),
    );
    const relations = [...this.state.relations.values()]
      .filter((relation) => {
        const expected = active.get(relation.sourceId);
        return (
          expected?.revisionId === relation.revisionId &&
          expected.generation === relation.generation
        );
      })
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((relation) => clone(relation));
    return {
      status: this.structuralAvailable ? "ready" : "unavailable",
      fingerprintDisposition,
      sources: this.structuralAvailable ? sources : [],
      relations: this.structuralAvailable ? relations : [],
    };
  }

  async recoverPublications(): Promise<RetrievalRepairOutcome> {
    const abandonedPublications = this.pending.size;
    this.pending.clear();
    this.aggregate.recoveries += 1;
    return {
      status: abandonedPublications > 0 ? "repaired" : "clean",
      abandonedPublications,
      orphanedChunksRemoved: 0,
      orphanedRelationsRemoved: 0,
    };
  }

  async deleteSource(
    request: RetrievalDeleteSourceRequest,
  ): Promise<RetrievalDeleteSourceOutcome> {
    const source = this.state.sources.get(request.sourceId);
    if (!source) {
      return {
        sourceId: request.sourceId,
        status: "not_found",
        recordsRemoved: 0,
      };
    }
    if (
      request.expectedRevisionId &&
      source.revision.id !== request.expectedRevisionId
    ) {
      return {
        sourceId: request.sourceId,
        status: "stale_source",
        recordsRemoved: 0,
      };
    }

    const chunkIds = idsForSource(this.state.chunks, request.sourceId);
    const relationIds = idsForSource(this.state.relations, request.sourceId);
    this.state.sources.delete(request.sourceId);
    this.state.sourceGenerations.delete(request.sourceId);
    this.staleSourceIds.delete(request.sourceId);
    this.state.sourceRevisionTombstones.set(
      request.sourceId,
      clone(source.revision),
    );
    for (const id of chunkIds) this.state.chunks.delete(id);
    for (const id of relationIds) this.state.relations.delete(id);
    const recordsRemoved = 1 + chunkIds.length + relationIds.length;
    this.aggregate.sourcesDeleted += 1;
    this.aggregate.recordsRemoved += recordsRemoved;
    return {
      sourceId: request.sourceId,
      status: "deleted",
      recordsRemoved,
    };
  }

  async deleteSources(
    requests: RetrievalDeleteSourceRequest[],
  ): Promise<RetrievalDeleteSourceOutcome[]> {
    if (
      new Set(requests.map((request) => request.sourceId)).size !==
      requests.length
    ) {
      throw new Error("Batch source deletions require unique source IDs");
    }
    const outcomes: RetrievalDeleteSourceOutcome[] = [];
    for (const request of requests) {
      outcomes.push(await this.deleteSource(request));
    }
    return outcomes;
  }

  async deleteScope(
    request: RetrievalDeleteScopeRequest,
  ): Promise<RetrievalDeleteScopeOutcome> {
    const activeSourceIds = new Set(
      [...this.state.sources.values()]
        .filter((source) => matchesDeleteScope(source, request))
        .map((source) => source.id),
    );
    const scopedSourceIds = new Set(activeSourceIds);
    if (request.sourceIdPrefix) {
      for (const sourceId of this.state.sourceRevisionTombstones.keys()) {
        if (sourceId.startsWith(request.sourceIdPrefix))
          scopedSourceIds.add(sourceId);
      }
    }
    for (const publication of this.pending.values()) {
      if (matchesDeleteScope(publication.source, request)) {
        scopedSourceIds.add(publication.source.id);
      }
    }
    const chunkIds = idsForSources(this.state.chunks, scopedSourceIds);
    const relationIds = idsForSources(this.state.relations, scopedSourceIds);
    for (const sourceId of scopedSourceIds) {
      this.state.sources.delete(sourceId);
      this.state.sourceGenerations.delete(sourceId);
      this.state.sourceRevisionTombstones.delete(sourceId);
      this.staleSourceIds.delete(sourceId);
    }
    for (const chunkId of chunkIds) this.state.chunks.delete(chunkId);
    for (const relationId of relationIds)
      this.state.relations.delete(relationId);
    for (const [publicationId, publication] of this.pending) {
      if (scopedSourceIds.has(publication.source.id))
        this.pending.delete(publicationId);
    }
    const recordsRemoved =
      activeSourceIds.size + chunkIds.length + relationIds.length;
    this.aggregate.sourcesDeleted += activeSourceIds.size;
    this.aggregate.recordsRemoved += recordsRemoved;
    return { sourcesDeleted: activeSourceIds.size, recordsRemoved };
  }

  async query(request: RetrievalQuery): Promise<RetrievalQueryResult> {
    validateQuery(request);
    this.aggregate.queries += 1;
    this.aggregate[`${request.mode}Queries`] += 1;

    const capability = this.resolveQueryCapability(request);
    if (!capability.mode) {
      return {
        query: clone(request),
        candidates: [],
        mode: request.mode,
        ...(capability.degradedReason
          ? { degradedReason: capability.degradedReason }
          : {}),
      };
    }

    const effectiveMode = capability.mode;
    const weights = resolveRetrievalRankingWeights(
      effectiveMode,
      request.ranking,
    );
    const minimumScore = request.minimumScore ?? Number.EPSILON;
    let candidates = [...this.state.chunks.values()]
      .flatMap((chunk): RetrievalQueryCandidate[] => {
        const source = this.state.sources.get(chunk.sourceId);
        if (!source || source.revision.id !== chunk.revisionId) return [];
        if (request.excludeSourceRevisionIds?.includes(chunk.revisionId)) {
          return [];
        }
        if (!matchesFilter(source, chunk, request)) return [];
        if (
          effectiveMode === "vector" &&
          (!request.embedding?.length || !chunk.embedding)
        ) {
          return [];
        }
        const scores = scoreRetrievalCandidate(
          request,
          effectiveMode,
          source,
          chunk,
          weights,
        );
        if (
          !hasRetrievalSignal(scores, effectiveMode) ||
          !Number.isFinite(scores.final) ||
          scores.final < minimumScore
        ) {
          return [];
        }
        return [{ source: clone(source), chunk: clone(chunk), scores }];
      })
      .sort(compareRetrievalCandidates);

    const freshness =
      request.freshness === "required"
        ? await this.verifyCandidateFreshness(candidates)
        : undefined;
    if (freshness) {
      const excludedSourceIds = new Set([
        ...freshness.staleSources.map((source) => source.sourceId),
        ...freshness.deletedSourceIds,
      ]);
      candidates = candidates.filter(
        (candidate) => !excludedSourceIds.has(candidate.source.id),
      );
    }
    candidates = diversifyRetrievalCandidates(candidates, request);

    return {
      query: clone(request),
      candidates,
      mode: effectiveMode,
      ...(capability.degradedReason
        ? { degradedReason: capability.degradedReason }
        : {}),
      ...(freshness ? { freshness } : {}),
    };
  }

  async relations(sourceIds?: string[]): Promise<RetrievalRelationRecord[]> {
    const allowed = sourceIds ? new Set(sourceIds) : undefined;
    return [...this.state.relations.values()]
      .filter((relation) => !allowed || allowed.has(relation.sourceId))
      .filter((relation) => {
        const source = this.state.sources.get(relation.sourceId);
        return source?.revision.id === relation.revisionId;
      })
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((relation) => clone(relation));
  }

  async lexicalReadiness(): Promise<RetrievalLexicalReadiness> {
    const blockingReason = this.blockingHealthReason();
    if (blockingReason) {
      return { status: "unavailable", reason: blockingReason };
    }
    if (!this.lexicalAvailable) {
      return { status: "unavailable", reason: "lexical_index_unavailable" };
    }
    return { status: "ready" };
  }

  async health(): Promise<RetrievalHealthSnapshot> {
    const reasons = this.healthReasons();
    const reason = reasons[0];
    const blocking = reason !== undefined && isBlockingHealthReason(reason);
    const vectorUsable =
      this.embeddingConfigured &&
      this.vectorIndexAvailable &&
      this.embeddingAvailable;
    const noRetrievalMode = !this.lexicalAvailable && !vectorUsable;
    const status = !this.enabled
      ? "disabled"
      : blocking || noRetrievalMode
        ? "unavailable"
        : reasons.length > 0
          ? "degraded"
          : "ready";
    return {
      status,
      lexical: this.lexicalAvailable ? "ready" : "unavailable",
      scalar: this.scalarAvailable ? "ready" : "unavailable",
      vector: !this.embeddingConfigured
        ? "not_configured"
        : vectorUsable
          ? "ready"
          : "unavailable",
      structural: this.structuralAvailable ? "ready" : "unavailable",
      embeddingCredentials: !this.embeddingConfigured
        ? "not_required"
        : this.embeddingAvailable
          ? "available"
          : "missing",
      ...(reason ? { reason } : {}),
      reasons,
      fingerprintDisposition: this.fingerprintDisposition,
      pendingPublications: this.pending.size,
      sourceCount: this.state.sources.size,
      chunkCount: this.state.chunks.size,
      relationCount: this.state.relations.size,
      staleSourceCount: this.staleSourceIds.size,
    };
  }

  async createSnapshot(label?: string): Promise<RetrievalSnapshotOutcome> {
    const id = this.createId();
    const descriptor: RetrievalSnapshot = {
      id,
      createdAt: this.now(),
      ...(label ? { label } : {}),
      sourceCount: this.state.sources.size,
      chunkCount: this.state.chunks.size,
      relationCount: this.state.relations.size,
    };
    this.snapshots.set(id, {
      descriptor: clone(descriptor),
      state: cloneState(this.state),
    });
    this.aggregate.snapshotsCreated += 1;
    return { status: "created", snapshot: descriptor };
  }

  async restoreSnapshot(snapshotId: string): Promise<RetrievalSnapshotOutcome> {
    const snapshot = this.snapshots.get(snapshotId);
    if (!snapshot) return { status: "not_found" };
    this.state = cloneState(snapshot.state);
    this.pending.clear();
    this.staleSourceIds.clear();
    this.fingerprintDisposition = this.state.fingerprint
      ? "compatible"
      : "initialize";
    this.aggregate.snapshotsRestored += 1;
    return { status: "restored", snapshot: clone(snapshot.descriptor) };
  }

  async repair(): Promise<RetrievalRepairOutcome> {
    const abandonedPublications = this.pending.size;
    this.pending.clear();
    let orphanedChunksRemoved = 0;
    let orphanedRelationsRemoved = 0;
    for (const [id, chunk] of this.state.chunks) {
      const source = this.state.sources.get(chunk.sourceId);
      if (!source || source.revision.id !== chunk.revisionId) {
        this.state.chunks.delete(id);
        orphanedChunksRemoved += 1;
      }
    }
    for (const [id, relation] of this.state.relations) {
      const source = this.state.sources.get(relation.sourceId);
      if (!source || source.revision.id !== relation.revisionId) {
        this.state.relations.delete(id);
        orphanedRelationsRemoved += 1;
      }
    }
    this.repairRequired = false;
    this.aggregate.repairs += 1;
    this.aggregate.recordsRemoved +=
      orphanedChunksRemoved + orphanedRelationsRemoved;
    const repaired =
      abandonedPublications + orphanedChunksRemoved + orphanedRelationsRemoved >
      0;
    return {
      status: repaired ? "repaired" : "clean",
      abandonedPublications,
      orphanedChunksRemoved,
      orphanedRelationsRemoved,
    };
  }

  async optimize(): Promise<RetrievalOptimizeOutcome> {
    this.aggregate.optimizations += 1;
    return {
      status: "optimized",
      recordsCompacted:
        this.state.sources.size +
        this.state.chunks.size +
        this.state.relations.size,
    };
  }

  metrics(): RetrievalAggregateMetrics {
    return clone(this.aggregate);
  }

  setEmbeddingAvailable(available: boolean): void {
    this.embeddingAvailable = available;
  }

  setIndexAvailability(availability: {
    lexical?: boolean;
    scalar?: boolean;
    vector?: boolean;
    structural?: boolean;
  }): void {
    if (availability.lexical !== undefined) {
      this.lexicalAvailable = availability.lexical;
    }
    if (availability.scalar !== undefined) {
      this.scalarAvailable = availability.scalar;
    }
    if (availability.vector !== undefined) {
      this.vectorIndexAvailable = availability.vector;
    }
    if (availability.structural !== undefined) {
      this.structuralAvailable = availability.structural;
    }
  }

  private async verifyCandidateFreshness(
    candidates: RetrievalQueryCandidate[],
  ): Promise<RetrievalQueryFreshnessSummary> {
    const sources = new Map(
      candidates.map((candidate) => [candidate.source.id, candidate.source]),
    );
    const staleSources: RetrievalStaleSource[] = [];
    const deletedSourceIds: string[] = [];
    for (const source of [...sources.values()].sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
    )) {
      let freshness;
      try {
        freshness = this.freshnessVerifier
          ? await this.freshnessVerifier.verify(clone(source))
          : {
              status: "unverified" as const,
              reason: "source_freshness_verifier_unavailable",
            };
      } catch (error) {
        freshness = {
          status: "unverified" as const,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
      if (
        freshness.status === "current" ||
        freshness.status === "not_applicable"
      ) {
        this.staleSourceIds.delete(source.id);
        continue;
      }
      if (freshness.status === "deleted") {
        this.staleSourceIds.delete(source.id);
        deletedSourceIds.push(source.id);
        continue;
      }
      this.staleSourceIds.add(source.id);
      if (freshness.status === "changed") {
        staleSources.push({
          sourceId: source.id,
          ...(source.path ? { path: source.path } : {}),
          indexedRevision: clone(source.revision),
          status: "changed",
          currentRevision: clone(freshness.currentRevision),
        });
      } else if (freshness.status === "unverified") {
        staleSources.push({
          sourceId: source.id,
          ...(source.path ? { path: source.path } : {}),
          indexedRevision: clone(source.revision),
          status: "unverified",
          reason: freshness.reason,
        });
      }
    }
    return { staleSources, deletedSourceIds };
  }

  private resolveQueryCapability(request: RetrievalQuery): {
    mode?: RetrievalQueryResult["mode"];
    degradedReason?: RetrievalHealthReason;
  } {
    const blockingReason = this.blockingHealthReason();
    if (blockingReason) return { degradedReason: blockingReason };

    const vectorAvailable =
      this.embeddingConfigured &&
      this.vectorIndexAvailable &&
      this.embeddingAvailable;
    if (request.mode === "lexical") {
      return this.lexicalAvailable
        ? { mode: "lexical" }
        : { degradedReason: "lexical_index_unavailable" };
    }
    if (request.mode === "vector") {
      if (vectorAvailable) {
        return {
          mode: "vector",
          ...(!this.lexicalAvailable
            ? { degradedReason: "lexical_index_unavailable" as const }
            : {}),
        };
      }
      const degradedReason = this.vectorDegradedReason();
      return this.lexicalAvailable
        ? { mode: "lexical", degradedReason }
        : { degradedReason: this.primaryUnavailableRetrievalReason() };
    }
    if (vectorAvailable && this.lexicalAvailable) return { mode: "hybrid" };
    if (vectorAvailable) {
      return { mode: "vector", degradedReason: "lexical_index_unavailable" };
    }
    const degradedReason = this.vectorDegradedReason();
    return this.lexicalAvailable
      ? { mode: "lexical", degradedReason }
      : { degradedReason: this.primaryUnavailableRetrievalReason() };
  }

  private primaryUnavailableRetrievalReason(): RetrievalHealthReason {
    return this.healthReasons()[0] ?? "vector_index_unavailable";
  }

  private vectorDegradedReason(): RetrievalHealthReason {
    if (!this.embeddingConfigured || !this.vectorIndexAvailable) {
      return "vector_index_unavailable";
    }
    return "missing_embeddings_auth";
  }

  private healthReasons(): RetrievalHealthReason[] {
    const blockingReason = this.blockingHealthReason();
    if (blockingReason) return [blockingReason];
    const reasons: RetrievalHealthReason[] = [];
    if (!this.lexicalAvailable) reasons.push("lexical_index_unavailable");
    if (!this.scalarAvailable) reasons.push("scalar_index_unavailable");
    if (this.embeddingConfigured && !this.vectorIndexAvailable) {
      reasons.push("vector_index_unavailable");
    }
    if (this.embeddingConfigured && !this.embeddingAvailable) {
      reasons.push("missing_embeddings_auth");
    }
    if (!this.structuralAvailable) {
      reasons.push("structural_index_unavailable");
    }
    return reasons;
  }

  private blockingHealthReason(): RetrievalHealthReason | undefined {
    if (!this.enabled) return "disabled";
    if (!this.workspaceAvailable) return "no_workspace";
    if (!this.storeAvailable) return "store_unavailable";
    if (this.fingerprintDisposition === "rebuild_required") {
      return "rebuild_required";
    }
    if (this.repairRequired) return "repair_required";
    if (!this.initialized) return "missing_index";
    return undefined;
  }
}

export function validateRetrievalPublicationRequest(
  request: RetrievalPublicationRequest,
): void {
  if (!request.publicationId || !request.generation || !request.source.id) {
    throw new Error("Publication identity is required");
  }
  validateUniqueIds(request.expectedChunkIds, "expected chunk");
  validateUniqueIds(request.expectedRelationIds, "expected relation");
  validateUniqueIds(
    request.chunks.map((chunk) => chunk.id),
    "chunk",
  );
  validateUniqueIds(
    request.relations.map((relation) => relation.id),
    "relation",
  );
  for (const record of [...request.chunks, ...request.relations]) {
    if (
      record.sourceId !== request.source.id ||
      record.revisionId !== request.source.revision.id ||
      record.generation !== request.generation
    ) {
      throw new Error(
        "Publication records must share source, revision, and generation",
      );
    }
  }
}

function validateUniqueIds(ids: readonly string[], label: string): void {
  if (ids.some((id) => !id)) throw new Error(`${label} IDs cannot be empty`);
  if (new Set(ids).size !== ids.length) {
    throw new Error(`${label} IDs must be unique`);
  }
}

function publicationIsComplete(request: RetrievalPublicationRequest): boolean {
  return (
    sameIds(
      request.expectedChunkIds,
      request.chunks.map((chunk) => chunk.id),
    ) &&
    sameIds(
      request.expectedRelationIds,
      request.relations.map((relation) => relation.id),
    )
  );
}

function sameIds(
  expected: readonly string[],
  actual: readonly string[],
): boolean {
  if (expected.length !== actual.length) return false;
  const actualIds = new Set(actual);
  return expected.every((id) => actualIds.has(id));
}

function publicationOutcome(
  request: RetrievalPublicationRequest,
  status: RetrievalPublicationOutcome["status"],
  recordsAdded: number,
  recordsRemoved: number,
): RetrievalPublicationOutcome {
  return {
    publicationId: request.publicationId,
    sourceId: request.source.id,
    revisionId: request.source.revision.id,
    generation: request.generation,
    status,
    recordsAdded,
    recordsRemoved,
  };
}

function missingPublication(
  publicationId: string,
): RetrievalPublicationOutcome {
  return {
    publicationId,
    status: "not_found",
    recordsAdded: 0,
    recordsRemoved: 0,
  };
}

function idsForSource<T extends { sourceId: string }>(
  records: Map<string, T>,
  sourceId: string,
): string[] {
  return [...records.entries()]
    .filter(([, record]) => record.sourceId === sourceId)
    .map(([id]) => id);
}

function validateQuery(query: RetrievalQuery): void {
  if (!Number.isInteger(query.limit) || query.limit <= 0) {
    throw new Error("Retrieval query limit must be a positive integer");
  }
  if (query.mode !== "lexical" && !query.embedding?.length) {
    throw new Error(`${query.mode} retrieval requires a query embedding`);
  }
  if (
    query.minimumScore !== undefined &&
    (!Number.isFinite(query.minimumScore) || query.minimumScore < 0)
  ) {
    throw new Error("Retrieval minimumScore must be finite and non-negative");
  }
}

function matchesFilter(
  source: RetrievalSourceDocument,
  chunk: RetrievalChunkRecord,
  query: RetrievalQuery,
): boolean {
  const filter = query.filters;
  if (!matchesSourceFilter(source, filter, chunk.location?.path)) return false;
  if (filter?.metadata) {
    for (const [key, value] of Object.entries(filter.metadata)) {
      if (chunk.metadata[key] !== value && source.metadata[key] !== value) {
        return false;
      }
    }
  }
  return true;
}

function matchesSourceFilter(
  source: RetrievalSourceDocument,
  filter: RetrievalQueryFilter | undefined,
  candidatePath?: string,
): boolean {
  if (!filter) return true;
  if (filter.namespaces && !filter.namespaces.includes(source.namespace)) {
    return false;
  }
  if (filter.sourceKinds && !filter.sourceKinds.includes(source.kind)) {
    return false;
  }
  if (filter.sourceIds && !filter.sourceIds.includes(source.id)) return false;
  if (filter.pathPrefix) {
    const sourcePath = normalizePath(candidatePath ?? source.path ?? "");
    const prefix = normalizePath(filter.pathPrefix);
    if (sourcePath !== prefix && !sourcePath.startsWith(`${prefix}/`)) {
      return false;
    }
  }
  return true;
}

function matchesSourceMetadata(
  source: RetrievalSourceDocument,
  metadata: RetrievalQueryFilter["metadata"],
): boolean {
  if (!metadata) return true;
  return Object.entries(metadata).every(
    ([key, value]) => source.metadata[key] === value,
  );
}

function normalizePath(value: string): string {
  return normalizeRetrievalPath(value);
}

function isBlockingHealthReason(reason: RetrievalHealthReason): boolean {
  return (
    reason === "disabled" ||
    reason === "no_workspace" ||
    reason === "missing_index" ||
    reason === "store_unavailable" ||
    reason === "rebuild_required" ||
    reason === "repair_required"
  );
}

function idsForSources<T extends { sourceId: string }>(
  records: Map<string, T>,
  sourceIds: Set<string>,
): string[] {
  return [...records]
    .filter(([, record]) => sourceIds.has(record.sourceId))
    .map(([id]) => id);
}

function matchesDeleteScope(
  source: RetrievalSourceDocument,
  request: RetrievalDeleteScopeRequest,
): boolean {
  if (request.namespaces && !request.namespaces.includes(source.namespace)) {
    return false;
  }
  if (request.sourceIdPrefix && !source.id.startsWith(request.sourceIdPrefix)) {
    return false;
  }
  return Object.entries(request.metadata ?? {}).every(
    ([key, value]) => source.metadata[key] === value,
  );
}

function cloneState(state: RepositoryState): RepositoryState {
  return {
    fingerprint: clone(state.fingerprint),
    sources: new Map(
      [...state.sources].map(([id, source]) => [id, clone(source)]),
    ),
    sourceGenerations: new Map(state.sourceGenerations),
    chunks: new Map([...state.chunks].map(([id, chunk]) => [id, clone(chunk)])),
    relations: new Map(
      [...state.relations].map(([id, relation]) => [id, clone(relation)]),
    ),
    sourceRevisionTombstones: new Map(
      [...state.sourceRevisionTombstones].map(([id, revision]) => [
        id,
        clone(revision),
      ]),
    ),
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
