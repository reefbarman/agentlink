import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";

import { connect, Index, makeArrowTable } from "@lancedb/lancedb";
import type { Connection, Table } from "@lancedb/lancedb";
import type { Schema } from "apache-arrow";

import type { RetrievalRepository } from "../../core/retrieval/contracts.js";
import type {
  RetrievalDeleteScopeOutcome,
  RetrievalDeleteScopeRequest,
  RetrievalDeleteSourceOutcome,
  RetrievalDeleteSourceRequest,
} from "@agentlink/protocol/retrieval-deletion";
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
  RetrievalSnapshot,
  RetrievalSnapshotOutcome,
} from "@agentlink/protocol/retrieval-maintenance";
import type {
  RetrievalFingerprint,
  RetrievalFingerprintDisposition,
} from "@agentlink/protocol/retrieval-fingerprint";
import type {
  RetrievalAbortPublicationOutcome,
  RetrievalPublicationBatchOutcome,
  RetrievalPublicationOutcome,
  RetrievalPublicationPreparation,
  RetrievalPublicationRequest,
} from "@agentlink/protocol/retrieval-publication";
import type {
  RetrievalQuery,
  RetrievalQueryFilter,
  RetrievalQueryResult,
} from "@agentlink/protocol/retrieval-query";
import type {
  RetrievalChunkRecord,
  RetrievalRelationRecord,
  RetrievalSourceDocument,
  RetrievalSourceRevision,
} from "@agentlink/protocol/retrieval-records";
import type {
  RetrievalHealthSnapshot,
  RetrievalLexicalReadiness,
} from "@agentlink/protocol/retrieval-health";
import { classifyRetrievalFingerprint } from "../../core/retrieval/fingerprint.js";
import {
  diversifyRetrievalCandidates,
  normalizeRetrievalPath,
} from "../../core/retrieval/ranking.js";
import {
  compareRetrievalSourceRevisions,
  validateRetrievalSourceRevision,
} from "../../core/retrieval/revisionOrder.js";
import {
  InMemoryRetrievalRepository,
  validateRetrievalPublicationRequest,
  type InMemoryRetrievalRepositoryOptions,
} from "../../core/retrieval/InMemoryRetrievalRepository.js";
import {
  RETRIEVAL_TABLES,
  retrievalChunkSchema,
  retrievalMetadataSchema,
  retrievalPublicationSchema,
  retrievalRelationSchema,
  retrievalSnapshotSchema,
  retrievalSourceSchema,
} from "./lanceDbSchemas.js";
import type { CodeIndexWriterLease } from "../../indexer/codeIndexWriterLease.js";
import { assertCodeIndexWriterFenceCurrent } from "../../indexer/codeIndexWriterLease.js";
import { withRetrievalStoreLock } from "./retrievalStoreLock.js";
import { buildRetrievalChunkSearchText } from "./retrievalSearchText.js";

const FINGERPRINT_KEY = "fingerprint";
const METRICS_KEY = "aggregate_metrics";
const NATIVE_CAPABILITIES_KEY = "native_capabilities";
const NATIVE_INDEXES_DIRTY_KEY = "native_indexes_dirty";
export const RETRIEVAL_STORE_MARKER = ".agentlink-retrieval-store";
const DEFAULT_VECTOR_DIMENSIONS = 1;
const MINIMUM_NATIVE_CANDIDATES = 100;
const MAXIMUM_NATIVE_CANDIDATES = 1_000;
const LEXICAL_INDEX_NAME = "retrieval_search_text_fts";
const SOURCE_INDEX_NAME = "retrieval_source_id_btree";
const GENERATION_INDEX_NAME = "retrieval_generation_btree";
const WRITE_BATCH_SIZE = 256;
const DELETE_SCOPE_ID_BATCH_SIZE = 200;
// Queries on stores whose native search indexes are unavailable fall back to
// hydrating every chunk into memory for engine-side scanning. Beyond this row
// count that hydration can block the host process for minutes (chunk payloads
// embed full source content), so the query degrades instead.
const MAXIMUM_UNINDEXED_QUERY_CHUNKS = 2_048;
const RETRIEVAL_VERSION_RETENTION_MS = 60 * 60 * 1_000;
const REQUIRED_RETRIEVAL_TABLES = [
  RETRIEVAL_TABLES.sources,
  RETRIEVAL_TABLES.chunks,
  RETRIEVAL_TABLES.relations,
  RETRIEVAL_TABLES.publications,
  RETRIEVAL_TABLES.metadata,
  RETRIEVAL_TABLES.snapshots,
] as const;

const EMPTY_METRICS: RetrievalAggregateMetrics = {
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

interface SourceRow {
  source_id: string;
  revision_id: string;
  generation: string | null;
  deleted: boolean;
  payload_json: string;
}

interface ChunkRow {
  chunk_id: string;
  source_id: string;
  revision_id: string;
  generation: string;
  search_text: string;
  embedding: readonly number[] | null;
  payload_json: string;
}

interface RelationRow {
  relation_id: string;
  source_id: string;
  revision_id: string;
  generation: string;
  payload_json: string;
}

interface PublicationRow {
  publication_id: string;
  source_id: string;
  revision_id: string;
  generation: string;
  payload_json: string;
}

interface MetadataRow {
  key: string;
  value_json: string;
}

interface SnapshotRow {
  snapshot_id: string;
  created_at: string;
  label: string | null;
  source_count: number;
  chunk_count: number;
  relation_count: number;
  payload_json: string;
}

interface DurableSnapshotState {
  fingerprint: RetrievalFingerprint | null;
  sources: SourceRow[];
  chunks: ChunkRow[];
  relations: RelationRow[];
}

interface NativeCapabilityStatus {
  status: "ready" | "unavailable";
  detail?: string;
}

interface NativeCapabilities {
  lexical: NativeCapabilityStatus;
  scalar: NativeCapabilityStatus;
  vector: NativeCapabilityStatus;
}

interface DurableState extends DurableSnapshotState {
  publications: PublicationRow[];
  metadata: MetadataRow[];
  snapshots: SnapshotRow[];
  metrics: RetrievalAggregateMetrics;
  nativeCapabilities: NativeCapabilities;
  nativeIndexesDirty: boolean;
}

interface NativeIndexState {
  fingerprint: RetrievalFingerprint | null | undefined;
  nativeCapabilities: NativeCapabilities;
  nativeIndexesDirty: boolean;
}

interface RetrievalTables {
  sources: Table;
  chunks: Table;
  relations: Table;
  publications: Table;
  metadata: Table;
  snapshots: Table;
}

export interface LanceDbRetrievalIndexOperations {
  createLexical(table: Table): Promise<void>;
  createScalar(table: Table): Promise<void>;
  validateVector(table: Table, dimensions: number): Promise<void>;
}

export interface LanceDbRetrievalRepositoryOptions extends Omit<
  InMemoryRetrievalRepositoryOptions,
  "fingerprint"
> {
  root: string;
  embeddingDimensions?: number;
  indexOperations?: LanceDbRetrievalIndexOperations;
  deferNativeIndexRefresh?: boolean;
  codeIndexWriterLease?: CodeIndexWriterLease;
  /** Test seam; production callers use {@link MAXIMUM_UNINDEXED_QUERY_CHUNKS}. */
  maxUnindexedQueryChunks?: number;
}

export class LanceDbRetrievalRepository implements RetrievalRepository {
  private readonly root: string;
  private readonly options: LanceDbRetrievalRepositoryOptions;
  private connection: Connection | undefined;
  private tables: RetrievalTables | undefined;
  private dimensions: number | undefined;
  private aggregate: RetrievalAggregateMetrics = clone(EMPTY_METRICS);
  private inspectedFingerprint: RetrievalFingerprint | undefined;
  private readonly staleSourceIds = new Set<string>();
  private readonly activeReads = new Set<Promise<unknown>>();
  private readonly pendingQueryMetrics = {
    lexical: 0,
    vector: 0,
    hybrid: 0,
  };
  private closePromise: Promise<void> | undefined;
  private closing = false;

  constructor(options: LanceDbRetrievalRepositoryOptions) {
    this.root = options.root;
    this.options = options;
    this.dimensions = options.embeddingDimensions;
  }

  async inspectFingerprint(
    expected: RetrievalFingerprint,
  ): Promise<RetrievalFingerprintDisposition> {
    this.inspectedFingerprint = clone(expected);
    return this.withReadableTables(
      expected.embedding?.dimensions,
      async (tables) => {
        const metadata = await readRows<MetadataRow>(tables.metadata);
        return classifyRetrievalFingerprint(
          metadataValue<RetrievalFingerprint>(metadata, FINGERPRINT_KEY),
          expected,
        );
      },
    );
  }

  async migrate(
    expected: RetrievalFingerprint,
  ): Promise<RetrievalMigrationOutcome> {
    this.inspectedFingerprint = clone(expected);
    return this.withTables(expected.embedding?.dimensions, async (tables) => {
      const metadata = await readRows<MetadataRow>(tables.metadata);
      const fingerprint = metadataValue<RetrievalFingerprint>(
        metadata,
        FINGERPRINT_KEY,
      );
      const nativeCapabilities =
        metadataValue<NativeCapabilities>(metadata, NATIVE_CAPABILITIES_KEY) ??
        defaultNativeCapabilities();
      const nativeIndexesDirty =
        metadataValue<boolean>(metadata, NATIVE_INDEXES_DIRTY_KEY) ??
        fingerprint !== undefined;
      const disposition = classifyRetrievalFingerprint(fingerprint, expected);
      if (disposition === "rebuild_required") {
        return {
          status: "rebuild_required",
          fromVersion: fingerprint?.schemaVersion ?? null,
          toVersion: expected.schemaVersion,
        };
      }

      if (disposition === "initialize") {
        await upsertMetadataValue(tables.metadata, FINGERPRINT_KEY, expected);
        await upsertMetadataValue(tables.metadata, METRICS_KEY, EMPTY_METRICS);
      }
      if (
        disposition === "initialize" ||
        nativeIndexesDirty ||
        hasUnavailableNativeCapability(nativeCapabilities)
      ) {
        if (this.options.deferNativeIndexRefresh) {
          await upsertMetadataValue(
            tables.metadata,
            NATIVE_INDEXES_DIRTY_KEY,
            true,
          );
        } else {
          await this.refreshNativeIndexesFromTables(tables);
        }
      }
      await this.writeStoreMarker();
      return {
        status: disposition === "initialize" ? "migrated" : "up_to_date",
        fromVersion: fingerprint?.schemaVersion ?? null,
        toVersion: expected.schemaVersion,
      };
    });
  }

  async preparePublication(
    request: RetrievalPublicationRequest,
  ): Promise<RetrievalPublicationPreparation> {
    const [preparation] = await this.preparePublicationBatch([request]);
    return preparation!;
  }

  async preparePublicationBatch(
    requests: RetrievalPublicationRequest[],
  ): Promise<RetrievalPublicationPreparation[]> {
    if (
      new Set(requests.map((request) => request.publicationId)).size !==
      requests.length
    ) {
      throw new Error("Publication IDs must be unique");
    }
    if (
      new Set(requests.map((request) => request.source.id)).size !==
      requests.length
    ) {
      throw new Error("Publication source IDs must be unique within a batch");
    }
    if (requests.length === 0) return [];
    const preparations = requests.map((request) => {
      validateRetrievalPublicationRequest(request);
      validateRetrievalSourceRevision(request.source.revision);
      return {
        publicationId: request.publicationId,
        sourceId: request.source.id,
        revisionId: request.source.revision.id,
        generation: request.generation,
        status: "prepared" as const,
      };
    });
    return this.withTables(undefined, async (tables) => {
      const publicationIds = requests.map((request) => request.publicationId);
      if (
        (await tables.publications.countRows(
          sqlIn("publication_id", publicationIds),
        )) > 0
      ) {
        throw new Error("Publication already exists");
      }
      await appendRows(
        tables.publications,
        requests.map(publicationRow),
        retrievalPublicationSchema(),
      );
      await this.updateMetrics(tables, (metrics) => {
        metrics.sourcesScanned += requests.length;
      });
      return preparations;
    });
  }

  async commitPublication(
    publicationId: string,
  ): Promise<RetrievalPublicationOutcome> {
    const outcome = await this.commitPublicationBatch([publicationId]);
    const publication =
      outcome.publications[0] ?? missingPublication(publicationId);
    if (outcome.status === "rejected" && publication.status !== "not_found") {
      await this.abortPublication(publicationId);
    }
    return publication;
  }

  async commitPublicationBatch(
    publicationIds: string[],
  ): Promise<RetrievalPublicationBatchOutcome> {
    if (new Set(publicationIds).size !== publicationIds.length) {
      throw new Error("Publication IDs must be unique");
    }
    if (publicationIds.some((publicationId) => !publicationId)) {
      throw new Error("Publication IDs cannot be empty");
    }
    if (publicationIds.length === 0) {
      return {
        status: "published",
        publications: [],
        recordsAdded: 0,
        recordsRemoved: 0,
      };
    }

    return this.withTables(undefined, async (tables) => {
      const publicationRows = await readFilteredRows<PublicationRow>(
        tables.publications,
        sqlIn("publication_id", publicationIds),
      );
      const publicationsById = new Map(
        publicationRows.map((row) => [row.publication_id, row]),
      );
      const requests: RetrievalPublicationRequest[] = [];
      for (const publicationId of publicationIds) {
        const row = publicationsById.get(publicationId);
        if (!row) {
          return rejectedPublicationBatch([
            ...requests.map((request) =>
              publicationOutcome(request, "published"),
            ),
            missingPublication(publicationId),
          ]);
        }
        requests.push(parseJson<RetrievalPublicationRequest>(row.payload_json));
      }
      if (
        new Set(requests.map((request) => request.source.id)).size !==
        requests.length
      ) {
        throw new Error("Publication source IDs must be unique within a batch");
      }

      const sourceIds = requests.map((request) => request.source.id);
      const currentSourceRows = await readFilteredRows<SourceRow>(
        tables.sources,
        sqlIn("source_id", sourceIds),
      );
      const currentSources = new Map(
        currentSourceRows.map((row) => [row.source_id, row]),
      );
      const publications: RetrievalPublicationOutcome[] = [];
      for (const request of requests) {
        const currentRow = currentSources.get(request.source.id);
        if (!publicationIsComplete(request)) {
          publications.push(publicationOutcome(request, "incomplete"));
          return rejectedPublicationBatch(publications);
        }
        if (currentRow && publicationIsStale(request, currentRow)) {
          publications.push(publicationOutcome(request, "stale_source"));
          return rejectedPublicationBatch(publications);
        }
        const recordsRemoved = currentRow
          ? 1 +
            (await tables.chunks.countRows(
              sqlEquals("source_id", request.source.id),
            )) +
            (await tables.relations.countRows(
              sqlEquals("source_id", request.source.id),
            ))
          : 0;
        publications.push(
          publicationOutcome(
            request,
            "published",
            1 + request.chunks.length + request.relations.length,
            recordsRemoved,
          ),
        );
      }

      await upsertMetadataValue(
        tables.metadata,
        NATIVE_INDEXES_DIRTY_KEY,
        true,
      );

      const stagedGenerations = sqlOr(
        requests.map((request) =>
          sqlAnd(
            sqlEquals("source_id", request.source.id),
            sqlEquals("generation", request.generation),
          ),
        ),
      );
      await tables.chunks.delete(stagedGenerations);
      await tables.relations.delete(stagedGenerations);
      await appendRows(
        tables.chunks,
        requests.flatMap((request) =>
          request.chunks.map((chunk) =>
            chunkRow(chunk, request.source, request.relations),
          ),
        ),
        retrievalChunkSchema(this.requireDimensions()),
      );
      await appendRows(
        tables.relations,
        requests.flatMap((request) => request.relations.map(relationRow)),
        retrievalRelationSchema(),
      );

      await tables.sources
        .mergeInsert(["source_id"])
        .whenMatchedUpdateAll()
        .whenNotMatchedInsertAll()
        .execute(
          makeArrowTable(
            requests.map((request) =>
              sourceRow(request.source, request.generation),
            ) as unknown as Record<string, unknown>[],
            { schema: retrievalSourceSchema() },
          ),
        );

      const obsoleteGenerations = sqlOr(
        requests.map((request) =>
          sqlAnd(
            sqlEquals("source_id", request.source.id),
            sqlNotEquals("generation", request.generation),
          ),
        ),
      );
      await tables.chunks.delete(obsoleteGenerations);
      await tables.relations.delete(obsoleteGenerations);
      for (const request of requests) {
        this.staleSourceIds.delete(request.source.id);
      }
      await tables.publications.delete(sqlIn("publication_id", publicationIds));

      const recordsAdded = publications.reduce(
        (total, publication) => total + publication.recordsAdded,
        0,
      );
      const recordsRemoved = publications.reduce(
        (total, publication) => total + publication.recordsRemoved,
        0,
      );
      await this.updateMetrics(tables, (metrics) => {
        metrics.sourcesPublished += publications.length;
        metrics.recordsAdded += recordsAdded;
        metrics.recordsRemoved += recordsRemoved;
      });
      if (!this.options.deferNativeIndexRefresh) {
        await this.refreshNativeIndexesFromTables(tables);
      }
      return {
        status: "published",
        publications,
        recordsAdded,
        recordsRemoved,
      };
    });
  }

  async abortPublication(
    publicationId: string,
  ): Promise<RetrievalAbortPublicationOutcome> {
    return this.withTables(undefined, async (tables) => {
      const [pendingPublication] = await readFilteredRows<PublicationRow>(
        tables.publications,
        sqlEquals("publication_id", publicationId),
      );
      if (!pendingPublication) return { publicationId, status: "not_found" };

      const request = parseJson<RetrievalPublicationRequest>(
        pendingPublication.payload_json,
      );
      const [activeSource] = await readFilteredRows<SourceRow>(
        tables.sources,
        sqlEquals("source_id", request.source.id),
      );
      const generationPredicate =
        activeSource?.generation === request.generation
          ? sqlAnd(
              sqlEquals("source_id", request.source.id),
              sqlNotEquals("generation", request.generation),
            )
          : sqlAnd(
              sqlEquals("source_id", request.source.id),
              sqlEquals("generation", request.generation),
            );
      const [chunksToRemove, relationsToRemove] = await Promise.all([
        tables.chunks.countRows(generationPredicate),
        tables.relations.countRows(generationPredicate),
      ]);
      if (chunksToRemove + relationsToRemove > 0) {
        await upsertMetadataValue(
          tables.metadata,
          NATIVE_INDEXES_DIRTY_KEY,
          true,
        );
        if (chunksToRemove > 0) await tables.chunks.delete(generationPredicate);
        if (relationsToRemove > 0) {
          await tables.relations.delete(generationPredicate);
        }
        if (!this.options.deferNativeIndexRefresh) {
          await this.refreshNativeIndexesFromTables(tables);
        }
      }
      await tables.publications.delete(
        sqlEquals("publication_id", publicationId),
      );
      return { publicationId, status: "aborted" };
    });
  }

  async inspectSource(sourceId: string): Promise<RetrievalActiveSource | null> {
    return this.withReadableTables(undefined, async (tables) => {
      const rows = await readFilteredRows<SourceRow>(
        tables.sources,
        sqlEquals("source_id", sourceId),
      );
      const row = activeSourceRows(rows)[0];
      return row?.generation
        ? {
            source: parseJson<RetrievalSourceDocument>(row.payload_json),
            generation: row.generation,
          }
        : null;
    });
  }

  async listSources(
    filters?: RetrievalQueryFilter,
  ): Promise<RetrievalActiveSource[]> {
    return this.withReadableState(undefined, async (state) =>
      activeSourceRows(state.sources)
        .flatMap((row) => {
          if (!row.generation) return [];
          const source = parseJson<RetrievalSourceDocument>(row.payload_json);
          return matchesSourceFilter(source, filters)
            ? [{ source, generation: row.generation }]
            : [];
        })
        .sort((left, right) => left.source.id.localeCompare(right.source.id)),
    );
  }

  async structuralSnapshot(
    request: RetrievalStructuralSnapshotRequest,
  ): Promise<RetrievalStructuralSnapshot> {
    if (this.closing) throw new Error("retrieval_store_closed");
    if (!(await this.hasStoreMarker())) return missingStructuralSnapshot();

    return this.withReadConnection(async (connection) => {
      if (!(await this.hasStoreMarker())) return missingStructuralSnapshot();

      let sourcesTable: Table | undefined;
      let relationsTable: Table | undefined;
      let metadataTable: Table | undefined;
      try {
        const names = new Set(await connection.tableNames());
        if (
          !names.has(RETRIEVAL_TABLES.sources) ||
          !names.has(RETRIEVAL_TABLES.relations) ||
          !names.has(RETRIEVAL_TABLES.metadata)
        ) {
          return missingStructuralSnapshot();
        }

        const openedTables = await Promise.all([
          connection.openTable(RETRIEVAL_TABLES.sources),
          connection.openTable(RETRIEVAL_TABLES.relations),
          connection.openTable(RETRIEVAL_TABLES.metadata),
        ]);
        [sourcesTable, relationsTable, metadataTable] = openedTables;
        const [sourceRows, relationRows, metadata] = await Promise.all([
          readRows<SourceRow>(openedTables[0]),
          readRows<RelationRow>(openedTables[1]),
          readRows<MetadataRow>(openedTables[2]),
        ]);
        const fingerprint = metadataValue<RetrievalFingerprint>(
          metadata,
          FINGERPRINT_KEY,
        );
        const fingerprintDisposition = classifyRetrievalFingerprint(
          fingerprint,
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
        if (this.options.structuralAvailable === false) {
          return {
            status: "unavailable",
            fingerprintDisposition,
            sources: [],
            relations: [],
          };
        }

        const sources = activeSourceRows(sourceRows)
          .flatMap((row) => {
            if (!row.generation) return [];
            const source = parseJson<RetrievalSourceDocument>(row.payload_json);
            return matchesSourceFilter(source, request.filters)
              ? [{ source, generation: row.generation }]
              : [];
          })
          .sort((left, right) => left.source.id.localeCompare(right.source.id));
        const active = new Map(
          sources.map(({ source, generation }) => [
            source.id,
            { revisionId: source.revision.id, generation },
          ]),
        );
        const relations = relationRows
          .map((row) => parseJson<RetrievalRelationRecord>(row.payload_json))
          .filter((relation) => {
            const expected = active.get(relation.sourceId);
            return (
              expected?.revisionId === relation.revisionId &&
              expected.generation === relation.generation
            );
          })
          .sort((left, right) => left.id.localeCompare(right.id));
        return {
          status: "ready",
          fingerprintDisposition,
          sources,
          relations,
        };
      } finally {
        sourcesTable?.close();
        relationsTable?.close();
        metadataTable?.close();
      }
    });
  }

  async recoverPublications(): Promise<RetrievalRepairOutcome> {
    return this.withState(undefined, async (state, tables) => {
      const outcome = await this.repairState(state, tables, false);
      state.metrics.recoveries += 1;
      await this.persistMetadata(state, tables);
      return outcome;
    });
  }

  async deleteSource(
    request: RetrievalDeleteSourceRequest,
  ): Promise<RetrievalDeleteSourceOutcome> {
    const [outcome] = await this.deleteSources([request]);
    return outcome;
  }

  async deleteSources(
    requests: RetrievalDeleteSourceRequest[],
  ): Promise<RetrievalDeleteSourceOutcome[]> {
    if (requests.length === 0) return [];
    const uniqueIds = new Set(requests.map((request) => request.sourceId));
    if (uniqueIds.size !== requests.length) {
      throw new Error("Batch source deletions require unique source IDs");
    }
    return this.withTables(undefined, async (tables) => {
      const currentBySourceId = new Map<string, SourceRow>();
      for (const sourceIds of batchValues(
        [...uniqueIds],
        DELETE_SCOPE_ID_BATCH_SIZE,
      )) {
        const rows = await readFilteredRows<SourceRow>(
          tables.sources,
          sqlIn("source_id", sourceIds),
        );
        for (const row of activeSourceRows(rows)) {
          currentBySourceId.set(row.source_id, row);
        }
      }

      const deletable: SourceRow[] = [];
      const outcomes = requests.map((request): RetrievalDeleteSourceOutcome => {
        const current = currentBySourceId.get(request.sourceId);
        if (!current) {
          return {
            sourceId: request.sourceId,
            status: "not_found",
            recordsRemoved: 0,
          };
        }
        if (
          request.expectedRevisionId &&
          current.revision_id !== request.expectedRevisionId
        ) {
          return {
            sourceId: request.sourceId,
            status: "stale_source",
            recordsRemoved: 0,
          };
        }
        deletable.push(current);
        return {
          sourceId: request.sourceId,
          status: "deleted",
          recordsRemoved: 1,
        };
      });
      if (deletable.length === 0) return outcomes;

      const outcomeBySourceId = new Map(
        outcomes.map((outcome) => [outcome.sourceId, outcome]),
      );
      const deletableBatches = batchValues(
        deletable.map((row) => row.source_id),
        DELETE_SCOPE_ID_BATCH_SIZE,
      );
      for (const sourceIds of deletableBatches) {
        const predicate = sqlIn("source_id", sourceIds);
        const countRemoved = async (table: Table) => {
          const rows = await table
            .query()
            .where(predicate)
            .select(["source_id"])
            .toArray();
          for (const row of normalizeRows<{ source_id: string }>(rows)) {
            const outcome = outcomeBySourceId.get(row.source_id);
            if (outcome) outcome.recordsRemoved += 1;
          }
        };
        await Promise.all([
          countRemoved(tables.chunks),
          countRemoved(tables.relations),
        ]);
      }

      await upsertMetadataValue(
        tables.metadata,
        NATIVE_INDEXES_DIRTY_KEY,
        true,
      );
      await tables.sources
        .mergeInsert(["source_id"])
        .whenMatchedUpdateAll()
        .whenNotMatchedInsertAll()
        .execute(
          makeArrowTable(
            deletable.map((row) =>
              tombstoneRow(
                row.source_id,
                parseJson<RetrievalSourceDocument>(row.payload_json).revision,
              ),
            ) as unknown as Record<string, unknown>[],
            { schema: retrievalSourceSchema() },
          ),
        );
      for (const sourceIds of deletableBatches) {
        const predicate = sqlIn("source_id", sourceIds);
        await Promise.all([
          tables.chunks.delete(predicate),
          tables.relations.delete(predicate),
        ]);
      }
      if (!this.options.deferNativeIndexRefresh) {
        await this.refreshNativeIndexesFromTables(tables);
      }
      let recordsRemoved = 0;
      for (const row of deletable) {
        this.staleSourceIds.delete(row.source_id);
        recordsRemoved +=
          outcomeBySourceId.get(row.source_id)?.recordsRemoved ?? 0;
      }
      await this.updateMetrics(tables, (metrics) => {
        metrics.sourcesDeleted += deletable.length;
        metrics.recordsRemoved += recordsRemoved;
      });
      return outcomes;
    });
  }

  async deleteScope(
    request: RetrievalDeleteScopeRequest,
  ): Promise<RetrievalDeleteScopeOutcome> {
    return this.withTables(undefined, async (tables) => {
      const candidatePredicate = request.sourceIdPrefix
        ? sqlStartsWith("source_id", request.sourceIdPrefix)
        : undefined;
      const [sourceRows, publicationRows] = await Promise.all([
        candidatePredicate
          ? readFilteredRows<SourceRow>(tables.sources, candidatePredicate)
          : readRows<SourceRow>(tables.sources),
        candidatePredicate
          ? readFilteredRows<PublicationRow>(
              tables.publications,
              candidatePredicate,
            )
          : readRows<PublicationRow>(tables.publications),
      ]);
      const activeSourceIds = new Set(
        sourceRows
          .filter((row) => !row.deleted && row.generation !== null)
          .filter((row) =>
            matchesDeleteScope(
              parseJson<RetrievalSourceDocument>(row.payload_json),
              request,
            ),
          )
          .map((row) => row.source_id),
      );
      const scopedSourceIds = new Set(activeSourceIds);
      if (request.sourceIdPrefix) {
        for (const row of sourceRows) {
          if (row.deleted && row.source_id.startsWith(request.sourceIdPrefix)) {
            scopedSourceIds.add(row.source_id);
          }
        }
      }
      for (const row of publicationRows) {
        const publication = parseJson<RetrievalPublicationRequest>(
          row.payload_json,
        );
        if (matchesDeleteScope(publication.source, request)) {
          scopedSourceIds.add(publication.source.id);
        }
      }
      if (scopedSourceIds.size === 0) {
        return { sourcesDeleted: 0, recordsRemoved: 0 };
      }

      const sourceIdBatches = batchValues(
        [...scopedSourceIds],
        DELETE_SCOPE_ID_BATCH_SIZE,
      );
      let chunksRemoved = 0;
      let relationsRemoved = 0;
      for (const sourceIds of sourceIdBatches) {
        const predicate = sqlIn("source_id", sourceIds);
        const [chunks, relations] = await Promise.all([
          tables.chunks.countRows(predicate),
          tables.relations.countRows(predicate),
        ]);
        chunksRemoved += chunks;
        relationsRemoved += relations;
      }

      await upsertMetadataValue(
        tables.metadata,
        NATIVE_INDEXES_DIRTY_KEY,
        true,
      );
      for (const sourceIds of sourceIdBatches) {
        const predicate = sqlIn("source_id", sourceIds);
        await Promise.all([
          tables.sources.delete(predicate),
          tables.chunks.delete(predicate),
          tables.relations.delete(predicate),
          tables.publications.delete(predicate),
        ]);
      }
      if (!this.options.deferNativeIndexRefresh) {
        await this.refreshNativeIndexesFromTables(tables);
      }
      for (const sourceId of scopedSourceIds) {
        this.staleSourceIds.delete(sourceId);
      }
      const recordsRemoved =
        activeSourceIds.size + chunksRemoved + relationsRemoved;
      await this.updateMetrics(tables, (metrics) => {
        metrics.sourcesDeleted += activeSourceIds.size;
        metrics.recordsRemoved += recordsRemoved;
      });
      return {
        sourcesDeleted: activeSourceIds.size,
        recordsRemoved,
      };
    });
  }

  async deleteSourceIdPrefix(
    sourceIdPrefix: string,
  ): Promise<RetrievalDeleteScopeOutcome> {
    return this.withTables(undefined, async (tables) => {
      const predicate = sqlStartsWith("source_id", sourceIdPrefix);
      const [sources, activeSources, chunks, relations, publications] =
        await Promise.all([
          tables.sources.countRows(predicate),
          tables.sources.countRows(
            sqlAnd(predicate, "deleted = false", "generation IS NOT NULL"),
          ),
          tables.chunks.countRows(predicate),
          tables.relations.countRows(predicate),
          tables.publications.countRows(predicate),
        ]);
      if (sources + chunks + relations + publications === 0) {
        return { sourcesDeleted: 0, recordsRemoved: 0 };
      }

      await upsertMetadataValue(
        tables.metadata,
        NATIVE_INDEXES_DIRTY_KEY,
        true,
      );
      await Promise.all([
        sources > 0 ? tables.sources.delete(predicate) : undefined,
        chunks > 0 ? tables.chunks.delete(predicate) : undefined,
        relations > 0 ? tables.relations.delete(predicate) : undefined,
        publications > 0 ? tables.publications.delete(predicate) : undefined,
      ]);
      if (!this.options.deferNativeIndexRefresh) {
        await this.refreshNativeIndexesFromTables(tables);
      }
      for (const sourceId of this.staleSourceIds) {
        if (sourceId.startsWith(sourceIdPrefix)) {
          this.staleSourceIds.delete(sourceId);
        }
      }
      const recordsRemoved = activeSources + chunks + relations;
      await this.updateMetrics(tables, (metrics) => {
        metrics.sourcesDeleted += activeSources;
        metrics.recordsRemoved += recordsRemoved;
      });
      return { sourcesDeleted: activeSources, recordsRemoved };
    });
  }

  async query(request: RetrievalQuery): Promise<RetrievalQueryResult> {
    return this.trackRead(() => this.runQuery(request));
  }

  private async runQuery(
    request: RetrievalQuery,
  ): Promise<RetrievalQueryResult> {
    const result = await this.withReadableTables<RetrievalQueryResult>(
      undefined,
      async (tables) => {
        const nativeState = await readNativeIndexState(tables);
        const candidateLimit = Math.min(
          MAXIMUM_NATIVE_CANDIDATES,
          Math.max(MINIMUM_NATIVE_CANDIDATES, request.limit * 8),
        );
        const nativeIds = await this.nativeCandidateIds(
          request,
          candidateLimit,
          nativeState,
          tables,
        );
        let engine: InMemoryRetrievalRepository;
        if (nativeIds) {
          engine = await this.buildScopedEngine(nativeState, tables, nativeIds);
        } else {
          const chunkRowCount = await tables.chunks.countRows();
          const maxUnindexedChunks =
            this.options.maxUnindexedQueryChunks ??
            MAXIMUM_UNINDEXED_QUERY_CHUNKS;
          if (chunkRowCount > maxUnindexedChunks) {
            return {
              query: clone(request),
              candidates: [],
              mode: request.mode,
              degradedReason: "lexical_index_unavailable",
            };
          }
          engine = await this.buildEngine(await readState(tables));
        }
        const expandedRequest: RetrievalQuery = {
          ...request,
          limit: candidateLimit,
          diversity: {
            maxPerSource: candidateLimit,
            collapseOverlaps: false,
          },
        };
        const expanded = await engine.query(expandedRequest);
        const result: RetrievalQueryResult = {
          ...expanded,
          query: clone(request),
          candidates: diversifyRetrievalCandidates(
            nativeIds
              ? expanded.candidates.filter((candidate) =>
                  nativeIds.has(candidate.chunk.id),
                )
              : expanded.candidates,
            request,
          ),
        };
        if (request.freshness === "required") {
          const observed = new Set(
            result.freshness?.staleSources.map((source) => source.sourceId) ??
              [],
          );
          for (const candidate of result.candidates) {
            if (!observed.has(candidate.source.id)) {
              this.staleSourceIds.delete(candidate.source.id);
            }
          }
          for (const sourceId of observed) this.staleSourceIds.add(sourceId);
          for (const sourceId of result.freshness?.deletedSourceIds ?? []) {
            this.staleSourceIds.delete(sourceId);
          }
        }
        return result;
      },
    );
    await this.updateQueryMetrics(request.mode);
    return result;
  }

  async relations(sourceIds?: string[]): Promise<RetrievalRelationRecord[]> {
    return this.withReadableState(undefined, async (state) => {
      const engine = await this.buildEngine(state);
      return engine.relations(sourceIds);
    });
  }

  async lexicalReadiness(): Promise<RetrievalLexicalReadiness> {
    if (this.closing) throw new Error("retrieval_store_closed");
    const configuredBlocker = this.configuredLexicalBlocker();
    if (configuredBlocker) return configuredBlocker;
    if (!(await this.hasStoreMarker())) {
      return { status: "unavailable", reason: "missing_index" };
    }

    return this.withReadConnection<RetrievalLexicalReadiness>(
      async (connection) => {
        if (!(await this.hasStoreMarker())) {
          return { status: "unavailable", reason: "missing_index" };
        }

        let metadataTable: Table | undefined;
        try {
          const names = new Set(await connection.tableNames());
          if (
            REQUIRED_RETRIEVAL_TABLES.some((tableName) => !names.has(tableName))
          ) {
            return { status: "unavailable", reason: "missing_index" };
          }
          const openedMetadataTable = await connection.openTable(
            RETRIEVAL_TABLES.metadata,
          );
          metadataTable = openedMetadataTable;
          const metadata = await readRows<MetadataRow>(openedMetadataTable);
          const fingerprint = metadataValue<RetrievalFingerprint>(
            metadata,
            FINGERPRINT_KEY,
          );
          if (!fingerprint) {
            return { status: "unavailable", reason: "missing_index" };
          }
          if (
            this.inspectedFingerprint &&
            classifyRetrievalFingerprint(
              fingerprint,
              this.inspectedFingerprint,
            ) === "rebuild_required"
          ) {
            return { status: "unavailable", reason: "rebuild_required" };
          }
          const capabilities = metadataValue<NativeCapabilities>(
            metadata,
            NATIVE_CAPABILITIES_KEY,
          );
          const nativeIndexesDirty =
            metadataValue<boolean>(metadata, NATIVE_INDEXES_DIRTY_KEY) ?? true;
          if (
            nativeIndexesDirty ||
            !capabilities ||
            capabilities.lexical.status !== "ready"
          ) {
            return {
              status: "unavailable",
              reason: "lexical_index_unavailable",
              ...(nativeIndexesDirty
                ? { detail: "Native indexes require refresh" }
                : capabilities?.lexical.detail
                  ? { detail: capabilities.lexical.detail }
                  : {}),
            };
          }
          return { status: "ready" };
        } catch (error) {
          return {
            status: "unavailable",
            reason: "store_unavailable",
            detail: error instanceof Error ? error.message : String(error),
          };
        } finally {
          metadataTable?.close();
        }
      },
    ).catch(
      (error): RetrievalLexicalReadiness => ({
        status: "unavailable",
        reason: "store_unavailable",
        detail: error instanceof Error ? error.message : String(error),
      }),
    );
  }

  async health(): Promise<RetrievalHealthSnapshot> {
    return this.withReadableTables(undefined, async (tables) => {
      const metadata = await readRows<MetadataRow>(tables.metadata);
      const fingerprint = metadataValue<RetrievalFingerprint>(
        metadata,
        FINGERPRINT_KEY,
      );
      const nativeCapabilities =
        metadataValue<NativeCapabilities>(metadata, NATIVE_CAPABILITIES_KEY) ??
        defaultNativeCapabilities();
      const nativeIndexesDirty =
        metadataValue<boolean>(metadata, NATIVE_INDEXES_DIRTY_KEY) ??
        fingerprint !== undefined;
      const effectiveNativeCapabilities = nativeIndexesDirty
        ? dirtyNativeCapabilities()
        : nativeCapabilities;
      const engine = new InMemoryRetrievalRepository({
        ...this.options,
        lexicalAvailable:
          (this.options.lexicalAvailable ?? true) &&
          effectiveNativeCapabilities.lexical.status === "ready",
        scalarAvailable:
          (this.options.scalarAvailable ?? true) &&
          effectiveNativeCapabilities.scalar.status === "ready",
        vectorIndexAvailable:
          (this.options.vectorIndexAvailable ?? true) &&
          effectiveNativeCapabilities.vector.status === "ready",
        embeddingConfigured:
          this.options.embeddingConfigured ?? Boolean(fingerprint?.embedding),
        ...(fingerprint ? { fingerprint } : {}),
      });
      if (this.inspectedFingerprint) {
        await engine.inspectFingerprint(this.inspectedFingerprint);
      }
      const health = await engine.health();
      const details = nativeHealthDetails(effectiveNativeCapabilities);
      const [pendingPublications, sourceCount, chunkCount, relationCount] =
        await Promise.all([
          tables.publications.countRows(),
          tables.sources.countRows(
            "deleted = false AND generation IS NOT NULL",
          ),
          tables.chunks.countRows(),
          tables.relations.countRows(),
        ]);
      return {
        ...health,
        ...(Object.keys(details).length > 0 ? { details } : {}),
        pendingPublications,
        sourceCount,
        chunkCount,
        relationCount,
        staleSourceCount: this.staleSourceIds.size,
      };
    });
  }

  async createSnapshot(label?: string): Promise<RetrievalSnapshotOutcome> {
    return this.withState(undefined, async (state, tables) => {
      const descriptor: RetrievalSnapshot = {
        id: this.options.createId?.() ?? `snapshot-${randomUUID()}`,
        createdAt: this.options.now?.() ?? new Date().toISOString(),
        ...(label ? { label } : {}),
        sourceCount: activeSourceRows(state.sources).length,
        chunkCount: state.chunks.filter((row) =>
          isActiveGeneration(row, state.sources),
        ).length,
        relationCount: state.relations.filter((row) =>
          isActiveGeneration(row, state.sources),
        ).length,
      };
      const snapshotState: DurableSnapshotState = {
        fingerprint: clone(state.fingerprint),
        sources: clone(state.sources),
        chunks: clone(state.chunks),
        relations: clone(state.relations),
      };
      state.snapshots.push(snapshotRow(descriptor, snapshotState));
      state.metrics.snapshotsCreated += 1;
      await writeRows(
        tables.snapshots,
        state.snapshots,
        retrievalSnapshotSchema(),
      );
      await this.persistMetadata(state, tables);
      return { status: "created", snapshot: descriptor };
    });
  }

  async restoreSnapshot(snapshotId: string): Promise<RetrievalSnapshotOutcome> {
    return this.withState(undefined, async (state, tables) => {
      const row = state.snapshots.find(
        (snapshot) => snapshot.snapshot_id === snapshotId,
      );
      if (!row) return { status: "not_found" };
      const snapshot = parseJson<DurableSnapshotState>(row.payload_json);

      const stagedChunks = deduplicateChunks([
        ...state.chunks,
        ...snapshot.chunks,
      ]);
      await this.markNativeIndexesDirty(state, tables);
      const stagedRelations = deduplicateRelations([
        ...state.relations,
        ...snapshot.relations,
      ]);
      await writeRows(
        tables.chunks,
        stagedChunks,
        retrievalChunkSchema(this.requireDimensions()),
      );
      await writeRows(
        tables.relations,
        stagedRelations,
        retrievalRelationSchema(),
      );
      state.sources = clone(snapshot.sources);
      await writeRows(tables.sources, state.sources, retrievalSourceSchema());

      state.chunks = stagedChunks.filter((chunk) =>
        isActiveGeneration(chunk, state.sources),
      );
      state.relations = stagedRelations.filter((relation) =>
        isActiveGeneration(relation, state.sources),
      );
      state.publications = [];
      state.fingerprint = clone(snapshot.fingerprint);
      await writeRows(
        tables.chunks,
        state.chunks,
        retrievalChunkSchema(this.requireDimensions()),
      );
      await writeRows(
        tables.relations,
        state.relations,
        retrievalRelationSchema(),
      );
      await writeRows(
        tables.publications,
        state.publications,
        retrievalPublicationSchema(),
      );
      await this.refreshNativeIndexesInState(state, tables);
      this.staleSourceIds.clear();
      state.metrics.snapshotsRestored += 1;
      await this.persistMetadata(state, tables);
      return {
        status: "restored",
        snapshot: snapshotDescriptor(row),
      };
    });
  }

  async repair(): Promise<RetrievalRepairOutcome> {
    return this.withState(undefined, async (state, tables) => {
      const outcome = await this.repairState(state, tables, true);
      state.metrics.repairs += 1;
      state.metrics.recordsRemoved +=
        outcome.orphanedChunksRemoved + outcome.orphanedRelationsRemoved;
      await this.persistMetadata(state, tables);
      return outcome;
    });
  }

  async refreshNativeIndexes(): Promise<void> {
    await this.withTables(undefined, (tables) =>
      this.refreshNativeIndexesFromTables(tables),
    );
  }

  async optimize(): Promise<RetrievalOptimizeOutcome> {
    return this.withTables(undefined, async (tables) => {
      const recordCount =
        (await tables.sources.countRows()) +
        (await tables.chunks.countRows()) +
        (await tables.relations.countRows());
      let fragmentsRemoved = 0;
      let bytesReclaimed = 0;
      await this.refreshNativeIndexesFromTables(tables);
      const options = {
        cleanupOlderThan: new Date(Date.now() - RETRIEVAL_VERSION_RETENTION_MS),
        deleteUnverified: false,
      };
      for (const table of Object.values(tables)) {
        const stats = await table.optimize(options);
        fragmentsRemoved += stats.compaction.fragmentsRemoved;
        bytesReclaimed += stats.prune.bytesRemoved;
      }
      await this.updateMetrics(tables, (metrics) => {
        metrics.optimizations += 1;
      });
      return {
        status: "optimized",
        recordsCompacted: fragmentsRemoved > 0 ? recordCount : 0,
        ...(bytesReclaimed > 0 ? { bytesReclaimed } : {}),
      };
    });
  }

  metrics(): RetrievalAggregateMetrics {
    return clone(this.aggregate);
  }

  setEmbeddingAvailable(available: boolean): void {
    this.options.embeddingAvailable = available;
  }

  setIndexAvailability(availability: {
    lexical?: boolean;
    scalar?: boolean;
    vector?: boolean;
    structural?: boolean;
  }): void {
    if (availability.lexical !== undefined) {
      this.options.lexicalAvailable = availability.lexical;
    }
    if (availability.scalar !== undefined) {
      this.options.scalarAvailable = availability.scalar;
    }
    if (availability.vector !== undefined) {
      this.options.vectorIndexAvailable = availability.vector;
    }
    if (availability.structural !== undefined) {
      this.options.structuralAvailable = availability.structural;
    }
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = this.finishClose();
    return this.closePromise;
  }

  private async finishClose(): Promise<void> {
    await Promise.allSettled(this.activeReads);
    if (!this.tables && !this.connection) {
      this.staleSourceIds.clear();
      return;
    }
    await withRetrievalStoreLock(this.root, async () => {
      this.closeNativeHandles();
      this.staleSourceIds.clear();
    });
  }

  private async withState<T>(
    dimensions: number | undefined,
    operation: (state: DurableState, tables: RetrievalTables) => Promise<T>,
  ): Promise<T> {
    return this.withTables(dimensions, async (tables) => {
      const state = await readState(tables);
      this.aggregate = this.metricsWithPendingQueries(state.metrics);
      const result = await operation(state, tables);
      this.aggregate = this.metricsWithPendingQueries(state.metrics);
      return result;
    });
  }

  private async withReadableState<T>(
    dimensions: number | undefined,
    operation: (state: DurableState, tables: RetrievalTables) => Promise<T>,
  ): Promise<T> {
    return this.withReadableTables(dimensions, async (tables) => {
      const state = await readState(tables);
      this.aggregate = this.metricsWithPendingQueries(state.metrics);
      return operation(state, tables);
    });
  }

  private async withReadableTables<T>(
    dimensions: number | undefined,
    operation: (tables: RetrievalTables) => Promise<T>,
  ): Promise<T> {
    if (!(await this.hasStoreMarker())) {
      return this.withTables(dimensions, operation);
    }
    if (dimensions !== undefined) this.validateDimensions(dimensions);
    return this.withReadConnection(async (connection) => {
      const names = new Set(await connection.tableNames());
      if (REQUIRED_RETRIEVAL_TABLES.some((name) => !names.has(name))) {
        throw new Error("retrieval_store_incomplete");
      }
      const opened: Table[] = [];
      try {
        for (const name of REQUIRED_RETRIEVAL_TABLES) {
          opened.push(await connection.openTable(name));
        }
      } catch (error) {
        for (const table of opened) table.close();
        throw error;
      }
      const tables: RetrievalTables = {
        sources: opened[0],
        chunks: opened[1],
        relations: opened[2],
        publications: opened[3],
        metadata: opened[4],
        snapshots: opened[5],
      };
      try {
        return await operation(tables);
      } finally {
        for (const table of opened) table.close();
      }
    });
  }

  private async withReadConnection<T>(
    operation: (connection: Connection) => Promise<T>,
  ): Promise<T> {
    return this.trackRead(() => this.runReadConnection(operation));
  }

  private async trackRead<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing) throw new Error("retrieval_store_closed");
    const read = Promise.resolve().then(operation);
    this.activeReads.add(read);
    try {
      return await read;
    } finally {
      this.activeReads.delete(read);
    }
  }

  private async runReadConnection<T>(
    operation: (connection: Connection) => Promise<T>,
  ): Promise<T> {
    const connection = await connect(this.root, { readConsistencyInterval: 0 });
    try {
      return await operation(connection);
    } finally {
      connection.close();
    }
  }

  private async updateQueryMetrics(
    mode: RetrievalQuery["mode"],
  ): Promise<void> {
    this.pendingQueryMetrics[mode] += 1;
    this.aggregate.queries += 1;
    this.aggregate[`${mode}Queries`] += 1;
    try {
      await withRetrievalStoreLock(
        this.root,
        async () => {
          if (this.options.codeIndexWriterLease) {
            assertCodeIndexWriterFenceCurrent(
              this.options.codeIndexWriterLease,
            );
          }
          const pending = { ...this.pendingQueryMetrics };
          try {
            const tables = await this.ensureTables(undefined);
            const metadata = await readRows<MetadataRow>(tables.metadata);
            const metrics =
              metadataValue<RetrievalAggregateMetrics>(metadata, METRICS_KEY) ??
              clone(EMPTY_METRICS);
            metrics.queries +=
              pending.lexical + pending.vector + pending.hybrid;
            metrics.lexicalQueries += pending.lexical;
            metrics.vectorQueries += pending.vector;
            metrics.hybridQueries += pending.hybrid;
            await upsertMetadataValue(tables.metadata, METRICS_KEY, metrics);
            this.pendingQueryMetrics.lexical -= pending.lexical;
            this.pendingQueryMetrics.vector -= pending.vector;
            this.pendingQueryMetrics.hybrid -= pending.hybrid;
            this.aggregate = this.metricsWithPendingQueries(metrics);
          } finally {
            this.closeNativeHandles();
          }
        },
        { timeoutMs: 1, maxWaitMs: 1 },
      );
    } catch {
      // Query telemetry is best-effort; pending counters flush on a later query.
    }
  }

  private metricsWithPendingQueries(
    metrics: RetrievalAggregateMetrics,
  ): RetrievalAggregateMetrics {
    const pending = this.pendingQueryMetrics;
    return {
      ...clone(metrics),
      queries:
        metrics.queries + pending.lexical + pending.vector + pending.hybrid,
      lexicalQueries: metrics.lexicalQueries + pending.lexical,
      vectorQueries: metrics.vectorQueries + pending.vector,
      hybridQueries: metrics.hybridQueries + pending.hybrid,
    };
  }

  private async withTables<T>(
    dimensions: number | undefined,
    operation: (tables: RetrievalTables) => Promise<T>,
  ): Promise<T> {
    if (this.closing) throw new Error("retrieval_store_closed");
    return withRetrievalStoreLock(this.root, async () => {
      if (this.closing) throw new Error("retrieval_store_closed");
      if (this.options.codeIndexWriterLease) {
        assertCodeIndexWriterFenceCurrent(this.options.codeIndexWriterLease);
      }
      try {
        return await operation(await this.ensureTables(dimensions));
      } finally {
        this.closeNativeHandles();
      }
    });
  }

  private async updateMetrics(
    tables: RetrievalTables,
    update: (metrics: RetrievalAggregateMetrics) => void,
  ): Promise<void> {
    const metadata = await readRows<MetadataRow>(tables.metadata);
    const metrics =
      metadataValue<RetrievalAggregateMetrics>(metadata, METRICS_KEY) ??
      clone(EMPTY_METRICS);
    update(metrics);
    this.aggregate = this.metricsWithPendingQueries(metrics);
    await upsertMetadataValue(tables.metadata, METRICS_KEY, metrics);
  }

  private async markNativeIndexesDirty(
    state: DurableState,
    tables: RetrievalTables,
  ): Promise<void> {
    state.nativeIndexesDirty = true;
    await upsertMetadataValue(tables.metadata, NATIVE_INDEXES_DIRTY_KEY, true);
  }

  private async refreshNativeIndexesFromTables(
    tables: RetrievalTables,
  ): Promise<void> {
    const operations = this.options.indexOperations ?? defaultIndexOperations;
    const nativeCapabilities: NativeCapabilities = {
      lexical: await runIndexOperation(() =>
        operations.createLexical(tables.chunks),
      ),
      scalar: await runIndexOperation(() =>
        operations.createScalar(tables.chunks),
      ),
      vector: await runIndexOperation(() =>
        operations.validateVector(tables.chunks, this.requireDimensions()),
      ),
    };
    await upsertMetadataValue(
      tables.metadata,
      NATIVE_CAPABILITIES_KEY,
      nativeCapabilities,
    );
    await upsertMetadataValue(tables.metadata, NATIVE_INDEXES_DIRTY_KEY, false);
  }

  private closeNativeHandles(): void {
    for (const table of Object.values(this.tables ?? {})) table.close();
    this.tables = undefined;
    this.connection?.close();
    this.connection = undefined;
  }

  private async ensureTables(
    requestedDimensions: number | undefined,
  ): Promise<RetrievalTables> {
    if (requestedDimensions !== undefined) {
      this.validateDimensions(requestedDimensions);
      this.dimensions = requestedDimensions;
    }
    if (this.tables) return this.tables;

    await fs.mkdir(this.root, { recursive: true });
    this.connection = await connect(this.root, { readConsistencyInterval: 0 });
    const names = new Set(await this.connection.tableNames());
    if (this.dimensions === undefined && names.has(RETRIEVAL_TABLES.chunks)) {
      const chunks = await this.connection.openTable(RETRIEVAL_TABLES.chunks);
      try {
        this.dimensions = vectorDimensions(await chunks.schema());
      } finally {
        chunks.close();
      }
    }
    const dimensions = this.dimensions ?? DEFAULT_VECTOR_DIMENSIONS;
    this.dimensions = dimensions;
    const definitions = [
      [RETRIEVAL_TABLES.sources, retrievalSourceSchema()],
      [RETRIEVAL_TABLES.chunks, retrievalChunkSchema(dimensions)],
      [RETRIEVAL_TABLES.relations, retrievalRelationSchema()],
      [RETRIEVAL_TABLES.publications, retrievalPublicationSchema()],
      [RETRIEVAL_TABLES.metadata, retrievalMetadataSchema()],
      [RETRIEVAL_TABLES.snapshots, retrievalSnapshotSchema()],
    ] as const;
    for (const [name, schema] of definitions) {
      if (!names.has(name)) {
        await this.connection.createEmptyTable(name, schema, {
          mode: "create",
          existOk: true,
        });
      }
    }
    this.tables = {
      sources: await this.connection.openTable(RETRIEVAL_TABLES.sources),
      chunks: await this.connection.openTable(RETRIEVAL_TABLES.chunks),
      relations: await this.connection.openTable(RETRIEVAL_TABLES.relations),
      publications: await this.connection.openTable(
        RETRIEVAL_TABLES.publications,
      ),
      metadata: await this.connection.openTable(RETRIEVAL_TABLES.metadata),
      snapshots: await this.connection.openTable(RETRIEVAL_TABLES.snapshots),
    };
    return this.tables;
  }

  private validateDimensions(requestedDimensions: number): void {
    if (
      this.dimensions !== undefined &&
      this.dimensions !== requestedDimensions
    ) {
      throw new Error(
        `Retrieval vector dimensions changed from ${this.dimensions} to ${requestedDimensions}`,
      );
    }
  }

  private requireDimensions(): number {
    if (this.dimensions === undefined) {
      throw new Error("Retrieval store has not been initialized");
    }
    return this.dimensions;
  }

  private engineOptions(
    state: NativeIndexState,
  ): ConstructorParameters<typeof InMemoryRetrievalRepository>[0] {
    return {
      ...this.options,
      lexicalAvailable:
        (this.options.lexicalAvailable ?? true) &&
        !state.nativeIndexesDirty &&
        state.nativeCapabilities.lexical.status === "ready",
      scalarAvailable:
        (this.options.scalarAvailable ?? true) &&
        !state.nativeIndexesDirty &&
        state.nativeCapabilities.scalar.status === "ready",
      vectorIndexAvailable:
        (this.options.vectorIndexAvailable ?? true) &&
        !state.nativeIndexesDirty &&
        state.nativeCapabilities.vector.status === "ready",
      embeddingConfigured:
        this.options.embeddingConfigured ??
        Boolean(state.fingerprint?.embedding),
      ...(state.fingerprint ? { fingerprint: clone(state.fingerprint) } : {}),
    };
  }

  /**
   * Hydrates only the given candidate chunks (and their sources) into a
   * scoring engine. Row reads stay proportional to the native candidate
   * limit, never to store size.
   */
  private async buildScopedEngine(
    state: NativeIndexState,
    tables: RetrievalTables,
    chunkIds: ReadonlySet<string>,
  ): Promise<InMemoryRetrievalRepository> {
    const engine = new InMemoryRetrievalRepository(this.engineOptions(state));
    const chunkRows: ChunkRow[] = [];
    for (const ids of batchValues([...chunkIds], DELETE_SCOPE_ID_BATCH_SIZE)) {
      chunkRows.push(
        ...(await readFilteredRows<ChunkRow>(
          tables.chunks,
          sqlIn("chunk_id", ids),
        )),
      );
    }
    const sourceIds = [...new Set(chunkRows.map((row) => row.source_id))];
    const sourceRows: SourceRow[] = [];
    for (const ids of batchValues(sourceIds, DELETE_SCOPE_ID_BATCH_SIZE)) {
      sourceRows.push(
        ...(await readFilteredRows<SourceRow>(
          tables.sources,
          sqlIn("source_id", ids),
        )),
      );
    }
    for (const row of activeSourceRows(sourceRows)) {
      const chunks = deduplicateChunks(
        chunkRows.filter((chunk) => isRowForSource(chunk, row)),
      ).map((chunk) => parseJson<RetrievalChunkRecord>(chunk.payload_json));
      if (chunks.length === 0) continue;
      const source = parseJson<RetrievalSourceDocument>(row.payload_json);
      const request: RetrievalPublicationRequest = {
        publicationId: `hydrate:${source.id}:${source.revision.id}`,
        generation: row.generation!,
        source,
        chunks,
        relations: [],
        expectedChunkIds: chunks.map((chunk) => chunk.id),
        expectedRelationIds: [],
      };
      await engine.preparePublication(request);
      await engine.commitPublication(request.publicationId);
    }
    if (this.inspectedFingerprint) {
      await engine.inspectFingerprint(this.inspectedFingerprint);
    }
    return engine;
  }

  private async buildEngine(
    state: DurableState,
  ): Promise<InMemoryRetrievalRepository> {
    const engine = new InMemoryRetrievalRepository(this.engineOptions(state));
    for (const row of activeSourceRows(state.sources)) {
      const source = parseJson<RetrievalSourceDocument>(row.payload_json);
      const chunks = state.chunks
        .filter((chunk) => isRowForSource(chunk, row))
        .map((chunk) => parseJson<RetrievalChunkRecord>(chunk.payload_json));
      const relations = state.relations
        .filter((relation) => isRowForSource(relation, row))
        .map((relation) =>
          parseJson<RetrievalRelationRecord>(relation.payload_json),
        );
      const request: RetrievalPublicationRequest = {
        publicationId: `hydrate:${source.id}:${source.revision.id}`,
        generation: row.generation!,
        source,
        chunks,
        relations,
        expectedChunkIds: chunks.map((chunk) => chunk.id),
        expectedRelationIds: relations.map((relation) => relation.id),
      };
      await engine.preparePublication(request);
      await engine.commitPublication(request.publicationId);
    }
    for (const row of state.sources.filter((source) => source.deleted)) {
      const revision = parseJson<RetrievalSourceRevision>(row.payload_json);
      const source: RetrievalSourceDocument = {
        id: row.source_id,
        namespace: "custom",
        kind: "custom",
        revision,
        content: "",
        metadata: {},
      };
      const request: RetrievalPublicationRequest = {
        publicationId: `hydrate:tombstone:${row.source_id}:${revision.id}`,
        generation: `hydrate:tombstone:${revision.id}`,
        source,
        chunks: [],
        relations: [],
        expectedChunkIds: [],
        expectedRelationIds: [],
      };
      await engine.preparePublication(request);
      await engine.commitPublication(request.publicationId);
      await engine.deleteSource({
        sourceId: source.id,
        expectedRevisionId: revision.id,
      });
    }
    for (const row of state.publications) {
      await engine.preparePublication(
        parseJson<RetrievalPublicationRequest>(row.payload_json),
      );
    }
    if (this.inspectedFingerprint) {
      await engine.inspectFingerprint(this.inspectedFingerprint);
    }
    return engine;
  }

  private async refreshNativeIndexesInState(
    state: DurableState,
    tables: RetrievalTables,
  ): Promise<void> {
    const operations = this.options.indexOperations ?? defaultIndexOperations;
    state.nativeCapabilities.lexical = await runIndexOperation(() =>
      operations.createLexical(tables.chunks),
    );
    state.nativeCapabilities.scalar = await runIndexOperation(() =>
      operations.createScalar(tables.chunks),
    );
    state.nativeCapabilities.vector = await runIndexOperation(() =>
      operations.validateVector(tables.chunks, this.requireDimensions()),
    );
    state.nativeIndexesDirty = false;
  }

  private async nativeCandidateIds(
    request: RetrievalQuery,
    limit: number,
    state: NativeIndexState,
    tables: RetrievalTables,
  ): Promise<Set<string> | undefined> {
    const candidateIds = new Set<string>();
    let usedNativeSearch = false;
    if (
      (request.mode === "lexical" || request.mode === "hybrid") &&
      !state.nativeIndexesDirty &&
      state.nativeCapabilities.lexical.status === "ready" &&
      request.text.trim()
    ) {
      try {
        const rows = await tables.chunks
          .query()
          .fullTextSearch(request.text, { columns: "search_text" })
          .select(["chunk_id", "_score"])
          .limit(limit)
          .toArray();
        for (const row of rows) candidateIds.add(String(row.chunk_id));
        usedNativeSearch = true;
      } catch {
        // Preserve candidates from another successful hybrid search leg.
      }
    }
    if (
      (request.mode === "vector" || request.mode === "hybrid") &&
      !state.nativeIndexesDirty &&
      state.nativeCapabilities.vector.status === "ready" &&
      request.embedding?.length
    ) {
      try {
        const rows = await tables.chunks
          .vectorSearch([...request.embedding])
          .column("embedding")
          .bypassVectorIndex()
          .select(["chunk_id", "_distance"])
          .limit(limit)
          .toArray();
        for (const row of rows) candidateIds.add(String(row.chunk_id));
        usedNativeSearch = true;
      } catch {
        // Preserve candidates from another successful hybrid search leg.
      }
    }
    return usedNativeSearch ? candidateIds : undefined;
  }

  private async repairState(
    state: DurableState,
    tables: RetrievalTables,
    _explicitRepair: boolean,
  ): Promise<RetrievalRepairOutcome> {
    const abandonedPublications = state.publications.length;
    const activeChunks = state.chunks.filter((row) =>
      isActiveGeneration(row, state.sources),
    );
    const activeRelations = state.relations.filter((row) =>
      isActiveGeneration(row, state.sources),
    );
    const orphanedChunksRemoved = state.chunks.length - activeChunks.length;
    const orphanedRelationsRemoved =
      state.relations.length - activeRelations.length;
    state.publications = [];
    state.chunks = activeChunks;
    state.relations = activeRelations;
    await this.markNativeIndexesDirty(state, tables);
    await writeRows(
      tables.publications,
      state.publications,
      retrievalPublicationSchema(),
    );
    await writeRows(
      tables.chunks,
      state.chunks,
      retrievalChunkSchema(this.requireDimensions()),
    );
    await writeRows(
      tables.relations,
      state.relations,
      retrievalRelationSchema(),
    );
    await this.refreshNativeIndexesInState(state, tables);
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

  private configuredLexicalBlocker(): RetrievalLexicalReadiness | undefined {
    if (this.options.enabled === false) {
      return { status: "unavailable", reason: "disabled" };
    }
    if (this.options.workspaceAvailable === false) {
      return { status: "unavailable", reason: "no_workspace" };
    }
    if (this.options.storeAvailable === false) {
      return { status: "unavailable", reason: "store_unavailable" };
    }
    if (this.options.repairRequired === true) {
      return { status: "unavailable", reason: "repair_required" };
    }
    if (this.options.lexicalAvailable === false) {
      return { status: "unavailable", reason: "lexical_index_unavailable" };
    }
    return undefined;
  }

  private async hasStoreMarker(): Promise<boolean> {
    try {
      await fs.access(`${this.root}/${RETRIEVAL_STORE_MARKER}`);
      return true;
    } catch {
      return false;
    }
  }

  private async writeStoreMarker(): Promise<void> {
    await fs.writeFile(`${this.root}/${RETRIEVAL_STORE_MARKER}`, "1\n", {
      mode: 0o600,
    });
  }

  private async persistMetadata(
    state: DurableState,
    tables: RetrievalTables,
  ): Promise<void> {
    state.metadata = [
      ...(state.fingerprint
        ? [metadataRow(FINGERPRINT_KEY, state.fingerprint)]
        : []),
      metadataRow(METRICS_KEY, state.metrics),
      metadataRow(NATIVE_CAPABILITIES_KEY, state.nativeCapabilities),
      metadataRow(NATIVE_INDEXES_DIRTY_KEY, state.nativeIndexesDirty),
    ];
    await writeRows(tables.metadata, state.metadata, retrievalMetadataSchema());
  }
}

function missingStructuralSnapshot(): RetrievalStructuralSnapshot {
  return {
    status: "missing",
    fingerprintDisposition: "initialize",
    sources: [],
    relations: [],
  };
}

async function readNativeIndexState(
  tables: RetrievalTables,
): Promise<NativeIndexState> {
  const metadata = await readRows<MetadataRow>(tables.metadata);
  const fingerprint = metadataValue<RetrievalFingerprint>(
    metadata,
    FINGERPRINT_KEY,
  );
  return {
    fingerprint,
    nativeCapabilities:
      metadataValue<NativeCapabilities>(metadata, NATIVE_CAPABILITIES_KEY) ??
      defaultNativeCapabilities(),
    nativeIndexesDirty:
      metadataValue<boolean>(metadata, NATIVE_INDEXES_DIRTY_KEY) ??
      fingerprint !== undefined,
  };
}

async function readState(tables: RetrievalTables): Promise<DurableState> {
  const [sources, chunks, relations, publications, metadata, snapshots] =
    await Promise.all([
      readRows<SourceRow>(tables.sources),
      readRows<ChunkRow>(tables.chunks),
      readRows<RelationRow>(tables.relations),
      readRows<PublicationRow>(tables.publications),
      readRows<MetadataRow>(tables.metadata),
      readRows<SnapshotRow>(tables.snapshots),
    ]);
  const fingerprint = metadataValue<RetrievalFingerprint>(
    metadata,
    FINGERPRINT_KEY,
  );
  const metrics =
    metadataValue<RetrievalAggregateMetrics>(metadata, METRICS_KEY) ??
    clone(EMPTY_METRICS);
  const nativeCapabilities =
    metadataValue<NativeCapabilities>(metadata, NATIVE_CAPABILITIES_KEY) ??
    defaultNativeCapabilities();
  const nativeIndexesDirty =
    metadataValue<boolean>(metadata, NATIVE_INDEXES_DIRTY_KEY) ??
    fingerprint !== undefined;
  return {
    fingerprint,
    sources,
    chunks,
    relations,
    publications,
    metadata,
    snapshots,
    metrics,
    nativeCapabilities,
    nativeIndexesDirty,
  };
}

async function readRows<T>(table: Table): Promise<T[]> {
  return normalizeRows<T>(await table.query().toArray());
}

async function readFilteredRows<T>(
  table: Table,
  predicate: string,
): Promise<T[]> {
  return normalizeRows<T>(await table.query().where(predicate).toArray());
}

function normalizeRows<T>(rows: unknown[]): T[] {
  return rows.map((row) => {
    const value =
      row !== null &&
      typeof row === "object" &&
      "toJSON" in row &&
      typeof row.toJSON === "function"
        ? row.toJSON()
        : row;
    return JSON.parse(JSON.stringify(value)) as T;
  });
}

async function appendRows<T extends object>(
  table: Table,
  rows: T[],
  schema: Schema,
): Promise<void> {
  for (let offset = 0; offset < rows.length; offset += WRITE_BATCH_SIZE) {
    const batch = rows.slice(offset, offset + WRITE_BATCH_SIZE);
    await table.add(
      makeArrowTable(batch as unknown as Record<string, unknown>[], { schema }),
      { mode: "append" },
    );
  }
}

async function upsertMetadataValue(
  table: Table,
  key: string,
  value: unknown,
): Promise<void> {
  await table.delete(sqlEquals("key", key));
  await appendRows(table, [metadataRow(key, value)], retrievalMetadataSchema());
}

async function writeRows<T extends object>(
  table: Table,
  rows: T[],
  schema: Schema,
): Promise<void> {
  if (rows.length === 0) {
    if ((await table.countRows()) > 0) await table.delete("true");
    return;
  }
  for (let offset = 0; offset < rows.length; offset += WRITE_BATCH_SIZE) {
    const batch = rows.slice(offset, offset + WRITE_BATCH_SIZE);
    await table.add(
      makeArrowTable(batch as unknown as Record<string, unknown>[], { schema }),
      { mode: offset === 0 ? "overwrite" : "append" },
    );
  }
}

function matchesSourceFilter(
  source: RetrievalSourceDocument,
  filter: RetrievalQueryFilter | undefined,
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
    const sourcePath = normalizeRetrievalPath(source.path ?? "");
    const prefix = normalizeRetrievalPath(filter.pathPrefix);
    if (sourcePath !== prefix && !sourcePath.startsWith(`${prefix}/`)) {
      return false;
    }
  }
  if (filter.metadata) {
    for (const [key, value] of Object.entries(filter.metadata)) {
      if (source.metadata[key] !== value) return false;
    }
  }
  return true;
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

function activeSourceRows(rows: SourceRow[]): SourceRow[] {
  return rows.filter((row) => !row.deleted && row.generation !== null);
}

function sourceRow(
  source: RetrievalSourceDocument,
  generation: string,
): SourceRow {
  return {
    source_id: source.id,
    revision_id: source.revision.id,
    generation,
    deleted: false,
    payload_json: JSON.stringify(source),
  };
}

function tombstoneRow(
  sourceId: string,
  revision: RetrievalSourceRevision,
): SourceRow {
  return {
    source_id: sourceId,
    revision_id: revision.id,
    generation: null,
    deleted: true,
    payload_json: JSON.stringify(revision),
  };
}

function chunkRow(
  chunk: RetrievalChunkRecord,
  source: RetrievalSourceDocument,
  relations: RetrievalRelationRecord[],
): ChunkRow {
  return {
    chunk_id: chunk.id,
    source_id: chunk.sourceId,
    revision_id: chunk.revisionId,
    generation: chunk.generation,
    search_text: buildRetrievalChunkSearchText({ chunk, source, relations }),
    embedding: chunk.embedding,
    payload_json: JSON.stringify(chunk),
  };
}

function relationRow(relation: RetrievalRelationRecord): RelationRow {
  return {
    relation_id: relation.id,
    source_id: relation.sourceId,
    revision_id: relation.revisionId,
    generation: relation.generation,
    payload_json: JSON.stringify(relation),
  };
}

function publicationRow(request: RetrievalPublicationRequest): PublicationRow {
  return {
    publication_id: request.publicationId,
    source_id: request.source.id,
    revision_id: request.source.revision.id,
    generation: request.generation,
    payload_json: JSON.stringify(request),
  };
}

const defaultIndexOperations: LanceDbRetrievalIndexOperations = {
  async createLexical(table) {
    await table.createIndex("search_text", {
      config: Index.fts({ withPosition: true, lowercase: true }),
      name: LEXICAL_INDEX_NAME,
      replace: true,
      waitTimeoutSeconds: 30,
    });
  },
  async createScalar(table) {
    await table.createIndex("source_id", {
      config: Index.btree(),
      name: SOURCE_INDEX_NAME,
      replace: true,
      waitTimeoutSeconds: 30,
    });
    await table.createIndex("generation", {
      config: Index.btree(),
      name: GENERATION_INDEX_NAME,
      replace: true,
      waitTimeoutSeconds: 30,
    });
  },
  async validateVector(table, dimensions) {
    const schema = await table.schema();
    const field = schema.fields.find(
      (candidate) => candidate.name === "embedding",
    );
    if (
      !field ||
      vectorListSize(field.type) !== dimensions ||
      !field.nullable
    ) {
      throw new Error(
        `retrieval vector schema must be a nullable fixed-size list with ${dimensions} dimensions`,
      );
    }
  },
};

async function runIndexOperation(
  operation: () => Promise<void>,
): Promise<NativeCapabilityStatus> {
  try {
    await operation();
    return { status: "ready" };
  } catch (error) {
    return unavailableCapability(error);
  }
}

function unavailableCapability(error: unknown): NativeCapabilityStatus {
  return {
    status: "unavailable",
    detail: error instanceof Error ? error.message : String(error),
  };
}

function vectorDimensions(schema: Schema): number {
  const field = schema.fields.find(
    (candidate) => candidate.name === "embedding",
  );
  const dimensions = field ? vectorListSize(field.type) : undefined;
  if (dimensions === undefined) {
    throw new Error("retrieval chunk table has no fixed-size embedding field");
  }
  return dimensions;
}

function vectorListSize(type: unknown): number | undefined {
  if (
    type === null ||
    typeof type !== "object" ||
    !("listSize" in type) ||
    !Number.isInteger(type.listSize) ||
    Number(type.listSize) <= 0
  ) {
    return undefined;
  }
  return Number(type.listSize);
}

function hasUnavailableNativeCapability(
  capabilities: NativeCapabilities,
): boolean {
  return Object.values(capabilities).some(
    (capability) => capability.status === "unavailable",
  );
}

function dirtyNativeCapabilities(): NativeCapabilities {
  return {
    lexical: unavailableCapability("Native indexes require refresh"),
    scalar: unavailableCapability("Native indexes require refresh"),
    vector: unavailableCapability("Native indexes require refresh"),
  };
}

function defaultNativeCapabilities(): NativeCapabilities {
  return {
    lexical: {
      status: "unavailable",
      detail: "retrieval lexical index has not been initialized",
    },
    scalar: {
      status: "unavailable",
      detail: "retrieval scalar indexes have not been initialized",
    },
    vector: { status: "ready" },
  };
}

function nativeHealthDetails(
  capabilities: NativeCapabilities,
): NonNullable<RetrievalHealthSnapshot["details"]> {
  const details: NonNullable<RetrievalHealthSnapshot["details"]> = {};
  if (capabilities.lexical.detail) {
    details.lexical_index_unavailable = capabilities.lexical.detail;
  }
  if (capabilities.scalar.detail) {
    details.scalar_index_unavailable = capabilities.scalar.detail;
  }
  if (capabilities.vector.detail) {
    details.vector_index_unavailable = capabilities.vector.detail;
  }
  return details;
}

function metadataRow(key: string, value: unknown): MetadataRow {
  return { key, value_json: JSON.stringify(value) };
}

function snapshotRow(
  descriptor: RetrievalSnapshot,
  state: DurableSnapshotState,
): SnapshotRow {
  return {
    snapshot_id: descriptor.id,
    created_at: descriptor.createdAt,
    label: descriptor.label ?? null,
    source_count: descriptor.sourceCount,
    chunk_count: descriptor.chunkCount,
    relation_count: descriptor.relationCount,
    payload_json: JSON.stringify(state),
  };
}

function snapshotDescriptor(row: SnapshotRow): RetrievalSnapshot {
  return {
    id: row.snapshot_id,
    createdAt: row.created_at,
    ...(row.label ? { label: row.label } : {}),
    sourceCount: row.source_count,
    chunkCount: row.chunk_count,
    relationCount: row.relation_count,
  };
}

function metadataValue<T>(rows: MetadataRow[], key: string): T | null {
  const row = rows.find((candidate) => candidate.key === key);
  return row ? parseJson<T>(row.value_json) : null;
}

function isActiveGeneration(
  row: { source_id: string; revision_id: string; generation: string },
  sources: SourceRow[],
): boolean {
  const source = sources.find(
    (candidate) => !candidate.deleted && candidate.source_id === row.source_id,
  );
  return source ? isRowForSource(row, source) : false;
}

function isRowForSource(
  row: { source_id: string; revision_id: string; generation: string },
  source: SourceRow,
): boolean {
  return (
    row.source_id === source.source_id &&
    row.revision_id === source.revision_id &&
    row.generation === source.generation
  );
}

function deduplicateChunks(rows: ChunkRow[]): ChunkRow[] {
  return deduplicateRows(
    rows,
    (row) => `${row.source_id}\u0000${row.generation}\u0000${row.chunk_id}`,
  );
}

function deduplicateRelations(rows: RelationRow[]): RelationRow[] {
  return deduplicateRows(
    rows,
    (row) => `${row.source_id}\u0000${row.generation}\u0000${row.relation_id}`,
  );
}

function deduplicateRows<T>(rows: T[], key: (row: T) => string): T[] {
  const unique = new Map<string, T>();
  for (const row of rows) unique.set(key(row), row);
  return [...unique.values()];
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

function publicationIsStale(
  request: RetrievalPublicationRequest,
  current: SourceRow,
): boolean {
  const currentRevision = current.deleted
    ? parseJson<RetrievalSourceRevision>(current.payload_json)
    : parseJson<RetrievalSourceDocument>(current.payload_json).revision;
  const comparison = compareRetrievalSourceRevisions(
    currentRevision,
    request.source.revision,
  );
  return current.deleted ? comparison >= 0 : comparison > 0;
}

function publicationOutcome(
  request: RetrievalPublicationRequest,
  status: RetrievalPublicationOutcome["status"],
  recordsAdded = 0,
  recordsRemoved = 0,
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

function rejectedPublicationBatch(
  publications: RetrievalPublicationOutcome[],
): RetrievalPublicationBatchOutcome {
  return {
    status: "rejected",
    publications,
    recordsAdded: 0,
    recordsRemoved: 0,
  };
}

function sqlEquals(column: string, value: string): string {
  return `${column} = ${sqlString(value)}`;
}

function sqlNotEquals(column: string, value: string): string {
  return `${column} != ${sqlString(value)}`;
}

function sqlIn(column: string, values: readonly string[]): string {
  if (values.length === 0) return "false";
  return `${column} IN (${values.map(sqlString).join(", ")})`;
}

function sqlAnd(...predicates: string[]): string {
  return predicates.map((predicate) => `(${predicate})`).join(" AND ");
}

function sqlStartsWith(column: string, prefix: string): string {
  const escapedPrefix = prefix
    .replaceAll("\\", "\\\\")
    .replaceAll("%", "\\%")
    .replaceAll("_", "\\_");
  return `${column} LIKE ${sqlString(`${escapedPrefix}%`)} ESCAPE '\\'`;
}

function sqlOr(predicates: string[]): string {
  if (predicates.length === 0) return "false";
  return predicates.map((predicate) => `(${predicate})`).join(" OR ");
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function batchValues<T>(values: T[], batchSize: number): T[][] {
  const batches: T[][] = [];
  for (let offset = 0; offset < values.length; offset += batchSize) {
    batches.push(values.slice(offset, offset + batchSize));
  }
  return batches;
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
