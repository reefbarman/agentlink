import { connect, makeArrowTable } from "@lancedb/lancedb";
import type { Connection, Table } from "@lancedb/lancedb";
import type { Schema } from "apache-arrow";

import type { RetrievalSourceDocument } from "@agentlink/protocol/retrieval-records";
import { createRetrievalSourcePayloadDigest } from "../../core/retrieval/publicationDigests.js";
import { compareRetrievalSourceRevisions } from "../../core/retrieval/revisionOrder.js";
import type { CodeIndexWriterLease } from "../../indexer/codeIndexWriterLease.js";
import { withCodeIndexWriterFence } from "../../indexer/codeIndexWriterLease.js";
import {
  closeCodeIndexStagedTables,
  ensureCodeIndexStagedTables,
  type CodeIndexStagedTables,
} from "./codeIndexStagedTables.js";
import { LanceDbCodeIndexStagingRepository } from "./LanceDbCodeIndexStagingRepository.js";
import {
  RETRIEVAL_TABLES,
  retrievalChunkSchema,
  retrievalMetadataSchema,
  retrievalRelationSchema,
  retrievalSourceSchema,
} from "./lanceDbSchemas.js";

interface ActiveTables {
  sources: Table;
  chunks: Table;
  relations: Table;
  metadata: Table;
}

interface ManifestRow {
  publication_id: string;
  source_id: string;
  revision_id: string;
  generation: string;
  fence_token: string;
  state: "staging" | "staged" | "activated";
  expected_chunk_count: number;
  expected_relation_count: number;
  source_payload_digest: string;
  source_payload_json: string;
}

interface SourceRow {
  source_id: string;
  revision_id: string;
  generation: string | null;
  deleted: boolean;
  payload_json: string;
}

interface BatchRow {
  publication_id: string;
  row_kind: "chunk" | "relation";
  batch_index: number;
}

export interface CodeIndexActivationOutcome {
  publicationId: string;
  sourceId: string;
  revisionId: string;
  generation: string;
  status: "activated" | "already_activated";
}

export interface CodeIndexActivationOptions {
  /**
   * The caller minted this publication's generation in the current process,
   * so no rows can exist for it in the active tables. Skips the replay-guard
   * delete and count verification, which otherwise cost full-table predicate
   * scans per activation on large stores.
   */
  freshGeneration?: boolean;
  /**
   * Skip the per-activation superseded-generation delete; the caller batches
   * it across activations via cleanupSupersededGenerations. Safe because
   * superseded rows are a space concern, not a correctness one (queries
   * filter by the active source generation), and the optimize() sweep removes
   * any rows left behind by a crash.
   */
  deferSupersededCleanup?: boolean;
}

const MANIFEST_COLUMNS = [
  "publication_id",
  "source_id",
  "revision_id",
  "generation",
  "fence_token",
  "state",
  "expected_chunk_count",
  "expected_relation_count",
  "source_payload_digest",
  "source_payload_json",
];
const NATIVE_INDEXES_DIRTY_KEY = "native_indexes_dirty";
const SUPERSEDED_CLEANUP_BATCH = 200;

export class LanceDbCodeIndexActivator {
  constructor(
    private readonly lease: CodeIndexWriterLease,
    private readonly dimensions: number,
  ) {}

  async activate(
    publicationId: string,
    options: CodeIndexActivationOptions = {},
  ): Promise<CodeIndexActivationOutcome> {
    if (!publicationId) throw new Error("Staged publication ID is required");
    // Fast path: a manifest that is already "staged" under the current fence
    // was verified at completion time and activates inside one fenced store
    // session. Only stale-fence or still-staging manifests need the staging
    // repository's adopt/complete round trips first.
    const attempt = await this.tryActivate(publicationId, options);
    if (attempt !== "needs_preparation") return attempt;

    const stagingRepository = new LanceDbCodeIndexStagingRepository(
      this.lease,
      this.dimensions,
    );
    const inspection =
      await stagingRepository.inspectStagedPublication(publicationId);
    if (!inspection) throw new Error("Staged publication not found");
    if (inspection.state !== "activated") {
      if (inspection.fenceToken !== this.lease.fenceToken) {
        await stagingRepository.adoptStagedPublication(publicationId);
      }
      await stagingRepository.completeStagedPublication(publicationId);
    }
    const retried = await this.tryActivate(publicationId, options);
    if (retried === "needs_preparation") {
      throw new Error("Staged publication is not complete");
    }
    return retried;
  }

  /**
   * Removes superseded-generation rows for a set of activated sources with a
   * single combined predicate per table, so a publication batch pays one
   * delete scan instead of one per file.
   */
  async cleanupSupersededGenerations(
    entries: Array<{ sourceId: string; generation: string }>,
  ): Promise<void> {
    if (entries.length === 0) return;
    await this.withTables(async (_staged, active) => {
      for (
        let offset = 0;
        offset < entries.length;
        offset += SUPERSEDED_CLEANUP_BATCH
      ) {
        const predicate = entries
          .slice(offset, offset + SUPERSEDED_CLEANUP_BATCH)
          .map((entry) =>
            sqlAnd(
              sqlEquals("source_id", entry.sourceId),
              sqlNotEquals("generation", entry.generation),
            ),
          )
          .map((condition) => `(${condition})`)
          .join(" OR ");
        await active.chunks.delete(predicate);
        await active.relations.delete(predicate);
      }
    });
  }

  private async tryActivate(
    publicationId: string,
    options: CodeIndexActivationOptions,
  ): Promise<CodeIndexActivationOutcome | "needs_preparation"> {
    return this.withTables(async (staged, active) => {
      const manifest = await requireManifest(staged.manifests, publicationId);
      if (manifest.state === "activated") {
        await adoptActivatedReceipt(staged, active, manifest, this.lease);
        await cleanupStagedPayload(staged, publicationId);
        return outcome(manifest, "already_activated");
      }
      if (
        manifest.state === "staging" ||
        manifest.fence_token !== this.lease.fenceToken
      ) {
        return "needs_preparation";
      }

      const source = parseSource(manifest);
      const current = await readCurrentSource(active.sources, source.id);
      if (current) {
        const currentSource = parseSourceRow(current);
        if (
          current.generation === manifest.generation &&
          !activeSourceMatchesManifest(current, currentSource, manifest)
        ) {
          throw new Error("Code index generation collision");
        }
        if (
          current.generation !== manifest.generation &&
          compareRetrievalSourceRevisions(
            source.revision,
            currentSource.revision,
          ) < 0
        ) {
          throw new Error("Staged publication source is stale");
        }
      }

      if (current?.generation !== manifest.generation) {
        await copyTargetGeneration(
          staged,
          active,
          manifest,
          this.dimensions,
          options.freshGeneration === true,
        );
        await markNativeIndexesDirty(active.metadata);
        await active.sources
          .mergeInsert(["source_id"])
          .whenMatchedUpdateAll()
          .whenNotMatchedInsertAll()
          .execute(
            makeArrowTable(
              [sourceRow(source, manifest.generation)] as unknown as Record<
                string,
                unknown
              >[],
              { schema: retrievalSourceSchema() },
            ),
          );
      }

      // Superseded generations must be removed only after the source pointer
      // flips, and also on replay: a crash between the flip and this delete
      // leaves stale rows that the generation-equality branch above skips.
      // Callers that activate in batches defer this to a combined
      // cleanupSupersededGenerations pass instead of paying a predicate scan
      // per file; the optimize() sweep covers rows a crash leaves behind.
      if (!options.deferSupersededCleanup) {
        await deleteSupersededGenerations(active, manifest);
      }

      await staged.manifests.update({
        where: sqlAnd(
          sqlEquals("publication_id", publicationId),
          sqlEquals("state", "staged"),
          sqlEquals("fence_token", this.lease.fenceToken),
        ),
        values: { state: "activated" },
      });
      const activated = await requireManifest(staged.manifests, publicationId);
      if (activated.state !== "activated") {
        throw new Error("Code index activation receipt transition failed");
      }
      await cleanupStagedPayload(staged, publicationId);
      return outcome(activated, "activated");
    });
  }

  async finalizeActivation(publicationId: string): Promise<void> {
    await this.finalizeActivations([publicationId]);
  }

  /**
   * Finalizes a set of activated publications in one fenced store session,
   * with combined predicates so the batch pays a constant number of table
   * commits instead of one commit set per publication.
   */
  async finalizeActivations(publicationIds: string[]): Promise<void> {
    if (publicationIds.length === 0) return;
    await this.withTables(async (staged) => {
      const present = await readProjectedRows<ManifestRow>(
        staged.manifests,
        sqlIn("publication_id", publicationIds),
        MANIFEST_COLUMNS,
      );
      if (present.length === 0) return;
      for (const manifest of present) {
        assertFence(manifest, this.lease);
        if (manifest.state !== "activated") {
          throw new Error("Cannot finalize an unactivated staged publication");
        }
      }
      const predicate = sqlIn(
        "publication_id",
        present.map((manifest) => manifest.publication_id),
      );
      await staged.chunks.delete(predicate);
      await staged.relations.delete(predicate);
      await staged.batches.delete(predicate);
      await staged.manifests.delete(predicate);
    });
  }

  private async withTables<T>(
    operation: (
      staged: CodeIndexStagedTables,
      active: ActiveTables,
    ) => Promise<T>,
  ): Promise<T> {
    return withCodeIndexWriterFence(this.lease, async () => {
      const connection = await connect(this.lease.storeRoot, {
        readConsistencyInterval: 0,
      });
      let staged: CodeIndexStagedTables | undefined;
      let active: ActiveTables | undefined;
      try {
        staged = await ensureCodeIndexStagedTables(connection, this.dimensions);
        active = await ensureActiveTables(connection, this.dimensions);
        return await operation(staged, active);
      } finally {
        if (staged) closeCodeIndexStagedTables(staged);
        if (active) closeActiveTables(active);
        connection.close();
      }
    });
  }
}

async function copyTargetGeneration(
  staged: CodeIndexStagedTables,
  active: ActiveTables,
  manifest: ManifestRow,
  dimensions: number,
  freshGeneration: boolean,
): Promise<void> {
  const target = sourceGenerationPredicate(
    manifest.source_id,
    manifest.generation,
  );
  // The replay guards only matter after a crash-and-replay mid-copy: they
  // remove half-copied rows and verify the copied counts. A freshly minted
  // generation cannot have rows in the active tables, so the guards — each a
  // full predicate scan of the active tables — are skipped on the hot path.
  if (!freshGeneration) {
    const [staleChunks, staleRelations] = await Promise.all([
      active.chunks.countRows(target),
      active.relations.countRows(target),
    ]);
    if (staleChunks > 0) await active.chunks.delete(target);
    if (staleRelations > 0) await active.relations.delete(target);
  }

  const ledgers = await readProjectedRows<BatchRow>(
    staged.batches,
    sqlEquals("publication_id", manifest.publication_id),
    ["publication_id", "row_kind", "batch_index"],
  );
  ledgers.sort(
    (left, right) =>
      left.row_kind.localeCompare(right.row_kind) ||
      left.batch_index - right.batch_index,
  );
  for (const ledger of ledgers) {
    const rows = await readProjectedRows<Record<string, unknown>>(
      ledger.row_kind === "chunk" ? staged.chunks : staged.relations,
      batchPredicate(manifest.publication_id, ledger.batch_index),
      ledger.row_kind === "chunk"
        ? [
            "chunk_id",
            "source_id",
            "revision_id",
            "generation",
            "search_text",
            "embedding",
            "payload_json",
          ]
        : [
            "relation_id",
            "source_id",
            "revision_id",
            "generation",
            "payload_json",
          ],
    );
    await addRows(
      ledger.row_kind === "chunk" ? active.chunks : active.relations,
      rows,
      ledger.row_kind === "chunk"
        ? retrievalChunkSchema(dimensions)
        : retrievalRelationSchema(),
    );
  }

  // Copied batches were count- and digest-verified at staging time and each
  // append commits atomically, so the fresh-generation path trusts the copy;
  // the count verification exists to catch replayed copies overlapping stale
  // rows, which the guard above already handled.
  if (freshGeneration) return;
  const [chunkCount, relationCount] = await Promise.all([
    active.chunks.countRows(target),
    active.relations.countRows(target),
  ]);
  if (
    chunkCount !== manifest.expected_chunk_count ||
    relationCount !== manifest.expected_relation_count
  ) {
    throw new Error("Staged publication activation copy is incomplete");
  }
}

async function ensureActiveTables(
  connection: Connection,
  dimensions: number,
): Promise<ActiveTables> {
  const names = new Set(await connection.tableNames());
  const definitions = [
    [RETRIEVAL_TABLES.sources, retrievalSourceSchema()],
    [RETRIEVAL_TABLES.chunks, retrievalChunkSchema(dimensions)],
    [RETRIEVAL_TABLES.relations, retrievalRelationSchema()],
    [RETRIEVAL_TABLES.metadata, retrievalMetadataSchema()],
  ] as const;
  for (const [name, schema] of definitions) {
    if (names.has(name)) continue;
    await connection.createEmptyTable(name, schema, {
      mode: "create",
      existOk: true,
    });
  }
  return {
    sources: await connection.openTable(RETRIEVAL_TABLES.sources),
    chunks: await connection.openTable(RETRIEVAL_TABLES.chunks),
    relations: await connection.openTable(RETRIEVAL_TABLES.relations),
    metadata: await connection.openTable(RETRIEVAL_TABLES.metadata),
  };
}

function closeActiveTables(tables: ActiveTables): void {
  tables.sources.close();
  tables.chunks.close();
  tables.relations.close();
  tables.metadata.close();
}

async function readCurrentSource(
  table: Table,
  sourceId: string,
): Promise<SourceRow | null> {
  const rows = await readProjectedRows<SourceRow>(
    table,
    sqlEquals("source_id", sourceId),
    ["source_id", "revision_id", "generation", "deleted", "payload_json"],
  );
  return rows.find((row) => !row.deleted && row.generation !== null) ?? null;
}

async function adoptActivatedReceipt(
  staged: CodeIndexStagedTables,
  active: ActiveTables,
  manifest: ManifestRow,
  lease: CodeIndexWriterLease,
): Promise<void> {
  const current = await readCurrentSource(active.sources, manifest.source_id);
  if (
    !current ||
    !activeSourceMatchesManifest(current, parseSourceRow(current), manifest)
  ) {
    throw new Error(
      "Activated publication receipt does not match active source",
    );
  }
  if (manifest.fence_token === lease.fenceToken) return;
  await staged.manifests.update({
    where: sqlAnd(
      sqlEquals("publication_id", manifest.publication_id),
      sqlEquals("state", "activated"),
      sqlEquals("fence_token", manifest.fence_token),
    ),
    values: { fence_token: lease.fenceToken },
  });
  const adopted = await requireManifest(
    staged.manifests,
    manifest.publication_id,
  );
  assertFence(adopted, lease);
}

function activeSourceMatchesManifest(
  row: SourceRow,
  source: RetrievalSourceDocument,
  manifest: ManifestRow,
): boolean {
  return (
    row.generation === manifest.generation &&
    row.revision_id === manifest.revision_id &&
    source.id === manifest.source_id &&
    source.revision.id === manifest.revision_id &&
    createRetrievalSourcePayloadDigest(source) ===
      manifest.source_payload_digest
  );
}

async function deleteSupersededGenerations(
  active: ActiveTables,
  manifest: ManifestRow,
): Promise<void> {
  // Deleted unconditionally: for a re-indexed file the superseded rows almost
  // always exist, so a count-first probe would just add a second table scan.
  const superseded = sqlAnd(
    sqlEquals("source_id", manifest.source_id),
    sqlNotEquals("generation", manifest.generation),
  );
  await active.chunks.delete(superseded);
  await active.relations.delete(superseded);
}

async function cleanupStagedPayload(
  staged: CodeIndexStagedTables,
  publicationId: string,
): Promise<void> {
  const predicate = sqlEquals("publication_id", publicationId);
  await staged.chunks.delete(predicate);
  await staged.relations.delete(predicate);
  await staged.batches.delete(predicate);
}

async function markNativeIndexesDirty(table: Table): Promise<void> {
  const current = await readProjectedRows<{ value_json: string }>(
    table,
    sqlEquals("key", NATIVE_INDEXES_DIRTY_KEY),
    ["value_json"],
  );
  if (current[0]?.value_json === JSON.stringify(true)) return;
  await table
    .mergeInsert(["key"])
    .whenMatchedUpdateAll()
    .whenNotMatchedInsertAll()
    .execute(
      makeArrowTable(
        [
          {
            key: NATIVE_INDEXES_DIRTY_KEY,
            value_json: JSON.stringify(true),
          },
        ],
        { schema: retrievalMetadataSchema() },
      ),
    );
}

async function requireManifest(
  table: Table,
  publicationId: string,
): Promise<ManifestRow> {
  const rows = await readProjectedRows<ManifestRow>(
    table,
    sqlEquals("publication_id", publicationId),
    MANIFEST_COLUMNS,
  );
  const manifest = rows[0];
  if (!manifest) throw new Error("Staged publication not found");
  return manifest;
}

function parseSource(manifest: ManifestRow): RetrievalSourceDocument {
  const source = JSON.parse(
    manifest.source_payload_json,
  ) as RetrievalSourceDocument;
  if (
    source.id !== manifest.source_id ||
    source.revision.id !== manifest.revision_id ||
    createRetrievalSourcePayloadDigest(source) !==
      manifest.source_payload_digest
  ) {
    throw new Error("Staged publication source payload digest mismatch");
  }
  return source;
}

function parseSourceRow(row: SourceRow): RetrievalSourceDocument {
  return JSON.parse(row.payload_json) as RetrievalSourceDocument;
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

function outcome(
  manifest: ManifestRow,
  status: CodeIndexActivationOutcome["status"],
): CodeIndexActivationOutcome {
  return {
    publicationId: manifest.publication_id,
    sourceId: manifest.source_id,
    revisionId: manifest.revision_id,
    generation: manifest.generation,
    status,
  };
}

function assertFence(manifest: ManifestRow, lease: CodeIndexWriterLease): void {
  if (manifest.fence_token !== lease.fenceToken) {
    throw new Error("code_index_writer_fenced");
  }
}

async function readProjectedRows<T>(
  table: Table,
  predicate: string,
  columns: string[],
): Promise<T[]> {
  const rows = await table.query().where(predicate).select(columns).toArray();
  return rows.map((row) => {
    const value = row.toJSON() as Record<string, unknown>;
    if (value.embedding !== null && value.embedding !== undefined) {
      value.embedding = Array.from(value.embedding as Iterable<number>);
    }
    return value as T;
  });
}

async function addRows<T extends object>(
  table: Table,
  rows: T[],
  schema: Schema,
): Promise<void> {
  if (rows.length === 0) return;
  await table.add(
    makeArrowTable(rows as unknown as Record<string, unknown>[], { schema }),
  );
}

function sourceGenerationPredicate(
  sourceId: string,
  generation: string,
): string {
  return sqlAnd(
    sqlEquals("source_id", sourceId),
    sqlEquals("generation", generation),
  );
}

function batchPredicate(publicationId: string, batchIndex: number): string {
  return sqlAnd(
    sqlEquals("publication_id", publicationId),
    `batch_index = ${batchIndex}`,
  );
}

function sqlEquals(field: string, value: string): string {
  return `${field} = ${sqlString(value)}`;
}

function sqlNotEquals(field: string, value: string): string {
  return `${field} != ${sqlString(value)}`;
}

function sqlIn(field: string, values: string[]): string {
  return `${field} IN (${values.map(sqlString).join(", ")})`;
}

function sqlAnd(...conditions: string[]): string {
  return conditions.map((condition) => `(${condition})`).join(" AND ");
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
