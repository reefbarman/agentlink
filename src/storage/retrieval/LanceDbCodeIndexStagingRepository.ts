import { connect, makeArrowTable } from "@lancedb/lancedb";
import type { Table } from "@lancedb/lancedb";
import type { Schema } from "apache-arrow";

import type { StagedRetrievalPublicationRepository } from "../../core/retrieval/contracts.js";
import type {
  RetrievalPublicationPreparation,
  RetrievalStagedChunkBatch,
  RetrievalStagedPublicationBundle,
  RetrievalStagedPublicationInspection,
  RetrievalStagedPublicationManifest,
  RetrievalStagedRelationBatch,
} from "@agentlink/protocol/retrieval-publication";
import {
  createRetrievalRecordContentDigest,
  createRetrievalRecordIdDigest,
  createRetrievalSourcePayloadDigest,
} from "../../core/retrieval/publicationDigests.js";
import type { CodeIndexWriterLease } from "../../indexer/codeIndexWriterLease.js";
import { withCodeIndexWriterFence } from "../../indexer/codeIndexWriterLease.js";
import {
  closeCodeIndexStagedTables,
  ensureCodeIndexStagedTables,
  type CodeIndexStagedTables,
} from "./codeIndexStagedTables.js";
import {
  stagedRetrievalBatchSchema,
  stagedRetrievalChunkSchema,
  stagedRetrievalManifestSchema,
  stagedRetrievalRelationSchema,
} from "./lanceDbSchemas.js";
import { buildRetrievalChunkSearchText } from "./retrievalSearchText.js";

interface StagedManifestRow {
  publication_id: string;
  source_id: string;
  revision_id: string;
  generation: string;
  fence_token: string;
  state: "staging" | "staged" | "activated";
  expected_chunk_count: number;
  expected_relation_count: number;
  expected_chunk_digest: string;
  expected_relation_digest: string;
  source_payload_digest: string;
  source_payload_json: string;
}

interface StagedBatchRow {
  publication_id: string;
  row_kind: "chunk" | "relation";
  batch_index: number;
  expected_count: number;
  expected_id_digest: string;
  expected_content_digest: string;
}

interface MaterializedEmbedding extends ArrayLike<number> {
  get?(index: number): number | null;
}

interface StagedRecordRow {
  [column: string]: unknown;
  source_id: string;
  revision_id: string;
  generation: string;
  search_text?: string;
  embedding?: MaterializedEmbedding | null;
  payload_json: string;
}

interface StagedSourceVerification {
  id: string;
  revision: { id: string };
  generation: string;
  document?: RetrievalStagedPublicationManifest["source"];
}

const MAX_STAGED_BATCH_RECORDS = 256;
const STAGED_VERSION_RETENTION_MS = 60 * 60 * 1_000;
const MAX_STAGED_PUBLICATION_RECORDS = 50_000;
const COMPACT_MANIFEST_COLUMNS = [
  "publication_id",
  "source_id",
  "revision_id",
  "generation",
  "fence_token",
  "state",
  "expected_chunk_count",
  "expected_relation_count",
  "expected_chunk_digest",
  "expected_relation_digest",
  "source_payload_digest",
];

export class LanceDbCodeIndexStagingRepository implements StagedRetrievalPublicationRepository {
  constructor(
    private readonly lease: CodeIndexWriterLease,
    private readonly dimensions: number,
  ) {}

  async stagePublication(
    bundle: RetrievalStagedPublicationBundle,
  ): Promise<void> {
    const manifest = bundle.manifest;
    validateManifest(manifest, this.lease);
    for (const batch of bundle.chunkBatches) {
      validateBatch(
        batch.publicationId,
        batch.batchIndex,
        batch.chunks,
        "chunk",
      );
    }
    for (const batch of bundle.relationBatches) {
      validateBatch(
        batch.publicationId,
        batch.batchIndex,
        batch.relations,
        "relation",
      );
    }
    await this.withTables(async (tables) => {
      const existingRows = await readProjectedRows<StagedManifestRow>(
        tables.manifests,
        sqlEquals("publication_id", manifest.publicationId),
        COMPACT_MANIFEST_COLUMNS,
      );
      const existing = existingRows[0];
      let fresh = false;
      let stagedManifest: StagedManifestRow;
      let source: RetrievalStagedPublicationManifest["source"];
      if (existing) {
        assertManifestFence(existing, this.lease);
        // A completed or activated manifest means this bundle already staged
        // fully on a previous attempt; replay is a no-op.
        if (existing.state !== "staging") return;
        stagedManifest = await requireManifest(tables, manifest.publicationId);
        source = parseSource(stagedManifest);
      } else {
        stagedManifest = manifestRow(manifest);
        await addRows(
          tables.manifests,
          [stagedManifest],
          stagedRetrievalManifestSchema(),
        );
        // validateManifest already proved manifest.source matches
        // sourcePayloadDigest, so the fresh path skips the read-back parse.
        source = manifest.source;
        fresh = true;
      }
      for (const batch of bundle.chunkBatches) {
        await this.appendChunkBatchToTables(
          tables,
          batch,
          stagedManifest,
          source,
          fresh,
        );
      }
      for (const batch of bundle.relationBatches) {
        await this.appendRelationBatchToTables(
          tables,
          batch,
          stagedManifest,
          fresh,
        );
      }
      await completeStagedPublicationInTables(
        tables,
        manifest.publicationId,
        this.lease,
      );
    });
  }

  async beginStagedPublication(
    manifest: RetrievalStagedPublicationManifest,
  ): Promise<RetrievalPublicationPreparation> {
    validateManifest(manifest, this.lease);
    return this.withTables(async (tables) => {
      if (
        (await tables.manifests.countRows(
          sqlEquals("publication_id", manifest.publicationId),
        )) > 0
      ) {
        throw new Error("Staged publication already exists");
      }
      await addRows(
        tables.manifests,
        [manifestRow(manifest)],
        stagedRetrievalManifestSchema(),
      );
      return {
        publicationId: manifest.publicationId,
        sourceId: manifest.source.id,
        revisionId: manifest.source.revision.id,
        generation: manifest.generation,
        status: "prepared",
      };
    });
  }

  async appendStagedChunkBatch(
    batch: RetrievalStagedChunkBatch,
  ): Promise<void> {
    validateBatch(batch.publicationId, batch.batchIndex, batch.chunks, "chunk");
    await this.withTables(async (tables) => {
      const manifest = await requireManifest(tables, batch.publicationId);
      assertManifestFence(manifest, this.lease);
      if (manifest.state !== "staging") {
        throw new Error("Cannot append to a completed staged publication");
      }
      const source = parseSource(manifest);
      await this.appendChunkBatchToTables(
        tables,
        batch,
        manifest,
        source,
        false,
      );
    });
  }

  /**
   * Appends one chunk batch inside an already-open store session. `fresh`
   * marks a publication whose manifest was created in this same session, so
   * replay-only work (committed-batch probes, cumulative-bound scans, and
   * delete-before-add sweeps that can never match) is skipped.
   */
  private async appendChunkBatchToTables(
    tables: CodeIndexStagedTables,
    batch: RetrievalStagedChunkBatch,
    manifest: StagedManifestRow,
    source: RetrievalStagedPublicationManifest["source"],
    fresh: boolean,
  ): Promise<void> {
    for (const chunk of batch.chunks) {
      if (
        chunk.sourceId !== manifest.source_id ||
        chunk.revisionId !== manifest.revision_id ||
        chunk.generation !== manifest.generation
      ) {
        throw new Error("Staged chunk ownership does not match its manifest");
      }
    }
    const idDigest = createRetrievalRecordIdDigest(
      batch.chunks.map((chunk) => chunk.id),
    );
    const contentDigest = createRetrievalRecordContentDigest(batch.chunks);
    if (
      idDigest !== batch.expectedIdDigest ||
      contentDigest !== batch.expectedContentDigest
    ) {
      throw new Error("Staged chunk batch digest mismatch");
    }
    const rows = batch.chunks.map((chunk) => ({
      publication_id: batch.publicationId,
      batch_index: batch.batchIndex,
      chunk_id: chunk.id,
      source_id: chunk.sourceId,
      revision_id: chunk.revisionId,
      generation: chunk.generation,
      search_text: buildRetrievalChunkSearchText({
        chunk,
        source,
        relations: [],
      }),
      embedding: chunk.embedding,
      payload_json: JSON.stringify(chunk),
    }));
    if (!fresh) {
      if (
        await isMatchingCommittedBatch(
          tables,
          batch.publicationId,
          "chunk",
          batch.batchIndex,
          batch.chunks.length,
          idDigest,
          contentDigest,
          tables.chunks,
          "chunk_id",
          {
            id: source.id,
            revision: source.revision,
            generation: manifest.generation,
            document: source,
          },
        )
      ) {
        return;
      }
      await assertCumulativeBatchCount(
        tables,
        batch.publicationId,
        "chunk",
        batch.batchIndex,
        batch.chunks.length,
        manifest.expected_chunk_count,
      );
      const predicate = batchPredicate(batch.publicationId, batch.batchIndex);
      await tables.chunks.delete(predicate);
      await tables.batches.delete(
        ledgerPredicate(batch.publicationId, "chunk", batch.batchIndex),
      );
    }
    await addRows(
      tables.chunks,
      rows,
      stagedRetrievalChunkSchema(this.dimensions),
    );
    await addRows(
      tables.batches,
      [
        batchLedger(
          batch.publicationId,
          "chunk",
          batch.batchIndex,
          batch.chunks.length,
          idDigest,
          contentDigest,
        ),
      ],
      stagedRetrievalBatchSchema(),
    );
  }

  async appendStagedRelationBatch(
    batch: RetrievalStagedRelationBatch,
  ): Promise<void> {
    validateBatch(
      batch.publicationId,
      batch.batchIndex,
      batch.relations,
      "relation",
    );
    await this.withTables(async (tables) => {
      const manifest = await requireManifest(
        tables,
        batch.publicationId,
        false,
      );
      assertManifestFence(manifest, this.lease);
      if (manifest.state !== "staging") {
        throw new Error("Cannot append to a completed staged publication");
      }
      await this.appendRelationBatchToTables(tables, batch, manifest, false);
    });
  }

  private async appendRelationBatchToTables(
    tables: CodeIndexStagedTables,
    batch: RetrievalStagedRelationBatch,
    manifest: StagedManifestRow,
    fresh: boolean,
  ): Promise<void> {
    for (const relation of batch.relations) {
      if (
        relation.sourceId !== manifest.source_id ||
        relation.revisionId !== manifest.revision_id ||
        relation.generation !== manifest.generation
      ) {
        throw new Error(
          "Staged relation ownership does not match its manifest",
        );
      }
    }
    const idDigest = createRetrievalRecordIdDigest(
      batch.relations.map((relation) => relation.id),
    );
    const contentDigest = createRetrievalRecordContentDigest(batch.relations);
    if (
      idDigest !== batch.expectedIdDigest ||
      contentDigest !== batch.expectedContentDigest
    ) {
      throw new Error("Staged relation batch digest mismatch");
    }
    const rows = batch.relations.map((relation) => ({
      publication_id: batch.publicationId,
      batch_index: batch.batchIndex,
      relation_id: relation.id,
      source_id: relation.sourceId,
      revision_id: relation.revisionId,
      generation: relation.generation,
      payload_json: JSON.stringify(relation),
    }));
    if (!fresh) {
      if (
        await isMatchingCommittedBatch(
          tables,
          batch.publicationId,
          "relation",
          batch.batchIndex,
          batch.relations.length,
          idDigest,
          contentDigest,
          tables.relations,
          "relation_id",
          {
            id: manifest.source_id,
            revision: { id: manifest.revision_id },
            generation: manifest.generation,
          },
        )
      ) {
        return;
      }
      await assertCumulativeBatchCount(
        tables,
        batch.publicationId,
        "relation",
        batch.batchIndex,
        batch.relations.length,
        manifest.expected_relation_count,
      );
      const predicate = batchPredicate(batch.publicationId, batch.batchIndex);
      await tables.relations.delete(predicate);
      await tables.batches.delete(
        ledgerPredicate(batch.publicationId, "relation", batch.batchIndex),
      );
    }
    await addRows(tables.relations, rows, stagedRetrievalRelationSchema());
    await addRows(
      tables.batches,
      [
        batchLedger(
          batch.publicationId,
          "relation",
          batch.batchIndex,
          batch.relations.length,
          idDigest,
          contentDigest,
        ),
      ],
      stagedRetrievalBatchSchema(),
    );
  }

  async completeStagedPublication(publicationId: string): Promise<void> {
    await this.withTables(async (tables) => {
      await completeStagedPublicationInTables(
        tables,
        publicationId,
        this.lease,
      );
    });
  }

  async adoptStagedPublication(publicationId: string): Promise<void> {
    await this.withTables(async (tables) => {
      const manifest = await requireManifest(tables, publicationId, false);
      if (manifest.state === "activated") {
        throw new Error(
          "Activated publication receipts require active-state adoption",
        );
      }
      await tables.manifests.update({
        where: sqlAnd(
          sqlEquals("publication_id", publicationId),
          sqlEquals("state", manifest.state),
          sqlEquals("fence_token", manifest.fence_token),
        ),
        values: { fence_token: this.lease.fenceToken },
      });
      const adopted = await requireManifest(tables, publicationId, false);
      assertManifestFence(adopted, this.lease);
    });
  }

  async abortStagedPublication(publicationId: string): Promise<void> {
    await this.withTables(async (tables) => {
      const rows = await readProjectedRows<StagedManifestRow>(
        tables.manifests,
        sqlEquals("publication_id", publicationId),
        COMPACT_MANIFEST_COLUMNS,
      );
      const manifest = rows[0];
      if (!manifest) return;
      assertManifestFence(manifest, this.lease);
      await tables.chunks.delete(sqlEquals("publication_id", publicationId));
      await tables.relations.delete(sqlEquals("publication_id", publicationId));
      await tables.batches.delete(sqlEquals("publication_id", publicationId));
      await tables.manifests.delete(sqlEquals("publication_id", publicationId));
    });
  }

  async inspectStagedPublication(
    publicationId: string,
  ): Promise<RetrievalStagedPublicationInspection | null> {
    return this.withTables(async (tables) => {
      const rows = await readProjectedRows<StagedManifestRow>(
        tables.manifests,
        sqlEquals("publication_id", publicationId),
        COMPACT_MANIFEST_COLUMNS,
      );
      const manifest = rows[0];
      if (!manifest) return null;
      return inspection(manifest);
    });
  }

  /**
   * Compacts staged-table fragments and prunes old table versions. Staged
   * tables churn on every publication batch, so without periodic pruning
   * their version history grows without bound and slows every operation.
   */
  async optimizeStagedTables(): Promise<void> {
    await this.withTables(async (tables) => {
      const options = {
        cleanupOlderThan: new Date(Date.now() - STAGED_VERSION_RETENTION_MS),
        deleteUnverified: false,
      };
      for (const table of Object.values(tables)) {
        await table.optimize(options);
      }
    });
  }

  private async withTables<T>(
    operation: (tables: CodeIndexStagedTables) => Promise<T>,
  ): Promise<T> {
    return withCodeIndexWriterFence(this.lease, async () => {
      const connection = await connect(this.lease.storeRoot, {
        readConsistencyInterval: 0,
      });
      let tables: CodeIndexStagedTables | undefined;
      try {
        tables = await ensureCodeIndexStagedTables(connection, this.dimensions);
        return await operation(tables);
      } finally {
        if (tables) closeCodeIndexStagedTables(tables);
        connection.close();
      }
    });
  }
}

function validateManifest(
  manifest: RetrievalStagedPublicationManifest,
  lease: CodeIndexWriterLease,
): void {
  if (!manifest.publicationId || !manifest.generation) {
    throw new Error("Staged publication identity is required");
  }
  if (manifest.fenceToken !== lease.fenceToken) {
    throw new Error("Staged publication fence does not match its writer lease");
  }
  if (
    !Number.isSafeInteger(manifest.expectedChunkCount) ||
    manifest.expectedChunkCount < 0 ||
    manifest.expectedChunkCount > MAX_STAGED_PUBLICATION_RECORDS ||
    !Number.isSafeInteger(manifest.expectedRelationCount) ||
    manifest.expectedRelationCount < 0 ||
    manifest.expectedRelationCount > MAX_STAGED_PUBLICATION_RECORDS
  ) {
    throw new Error(
      `Staged publication expected counts must be integers between 0 and ${MAX_STAGED_PUBLICATION_RECORDS}`,
    );
  }
  if (
    createRetrievalSourcePayloadDigest(manifest.source) !==
    manifest.sourcePayloadDigest
  ) {
    throw new Error("Staged publication source payload digest mismatch");
  }
}

function validateBatch<T extends { id: string }>(
  publicationId: string,
  batchIndex: number,
  records: readonly T[],
  rowKind: string,
): void {
  if (!publicationId || !Number.isSafeInteger(batchIndex) || batchIndex < 0) {
    throw new Error(`Invalid staged ${rowKind} batch identity`);
  }
  if (records.length === 0 || records.length > MAX_STAGED_BATCH_RECORDS) {
    throw new Error(
      `Staged ${rowKind} batch must contain 1-${MAX_STAGED_BATCH_RECORDS} records`,
    );
  }
  createRetrievalRecordIdDigest(records.map((record) => record.id));
}

function manifestRow(
  manifest: RetrievalStagedPublicationManifest,
): StagedManifestRow {
  return {
    publication_id: manifest.publicationId,
    source_id: manifest.source.id,
    revision_id: manifest.source.revision.id,
    generation: manifest.generation,
    fence_token: manifest.fenceToken,
    state: "staging",
    expected_chunk_count: manifest.expectedChunkCount,
    expected_relation_count: manifest.expectedRelationCount,
    expected_chunk_digest: manifest.expectedChunkDigest,
    expected_relation_digest: manifest.expectedRelationDigest,
    source_payload_digest: manifest.sourcePayloadDigest,
    source_payload_json: JSON.stringify(manifest.source),
  };
}

function inspection(
  manifest: StagedManifestRow,
): RetrievalStagedPublicationInspection {
  return {
    publicationId: manifest.publication_id,
    sourceId: manifest.source_id,
    revisionId: manifest.revision_id,
    generation: manifest.generation,
    fenceToken: manifest.fence_token,
    state: manifest.state,
    expectedChunkCount: manifest.expected_chunk_count,
    expectedRelationCount: manifest.expected_relation_count,
    expectedChunkDigest: manifest.expected_chunk_digest,
    expectedRelationDigest: manifest.expected_relation_digest,
    sourcePayloadDigest: manifest.source_payload_digest,
  };
}

function parseSource(manifest: StagedManifestRow) {
  const source = JSON.parse(
    manifest.source_payload_json,
  ) as RetrievalStagedPublicationManifest["source"];
  if (
    createRetrievalSourcePayloadDigest(source) !==
    manifest.source_payload_digest
  ) {
    throw new Error("Staged publication source payload digest mismatch");
  }
  return source;
}

function assertManifestFence(
  manifest: StagedManifestRow,
  lease: CodeIndexWriterLease,
): void {
  if (manifest.fence_token !== lease.fenceToken) {
    throw new Error("code_index_writer_fenced");
  }
}

function batchLedger(
  publicationId: string,
  rowKind: StagedBatchRow["row_kind"],
  batchIndex: number,
  expectedCount: number,
  expectedIdDigest: string,
  expectedContentDigest: string,
): StagedBatchRow {
  return {
    publication_id: publicationId,
    row_kind: rowKind,
    batch_index: batchIndex,
    expected_count: expectedCount,
    expected_id_digest: expectedIdDigest,
    expected_content_digest: expectedContentDigest,
  };
}

/**
 * Verifies every staged batch and transitions the manifest to "staged". A
 * manifest that already reads "staged" (or "activated") was verified when it
 * completed the first time and is immutable under the writer fence, so replays
 * return without re-reading the staged rows.
 */
async function completeStagedPublicationInTables(
  tables: CodeIndexStagedTables,
  publicationId: string,
  lease: CodeIndexWriterLease,
): Promise<void> {
  const manifest = await requireManifest(tables, publicationId);
  assertManifestFence(manifest, lease);
  if (manifest.state !== "staging") return;
  const ledgers = await readRows<StagedBatchRow>(
    tables.batches,
    sqlEquals("publication_id", publicationId),
  );
  assertUniqueLedgers(ledgers);
  const source = parseSource(manifest);
  const sourceVerification: StagedSourceVerification = {
    id: source.id,
    revision: source.revision,
    generation: manifest.generation,
    document: source,
  };
  await verifyStagedRows({
    table: tables.chunks,
    publicationId,
    rowKind: "chunk",
    idColumn: "chunk_id",
    ledgers,
    expectedCount: manifest.expected_chunk_count,
    expectedDigest: manifest.expected_chunk_digest,
    source: sourceVerification,
  });
  await verifyStagedRows({
    table: tables.relations,
    publicationId,
    rowKind: "relation",
    idColumn: "relation_id",
    ledgers,
    expectedCount: manifest.expected_relation_count,
    expectedDigest: manifest.expected_relation_digest,
    source: sourceVerification,
  });
  await tables.manifests.update({
    where: sqlAnd(
      sqlEquals("publication_id", publicationId),
      sqlEquals("state", "staging"),
      sqlEquals("fence_token", lease.fenceToken),
    ),
    values: { state: "staged" },
  });
  const completed = await requireManifest(tables, publicationId, false);
  if (completed.state !== "staged") {
    throw new Error("Staged publication completion transition failed");
  }
}

async function isMatchingCommittedBatch(
  tables: CodeIndexStagedTables,
  publicationId: string,
  rowKind: StagedBatchRow["row_kind"],
  batchIndex: number,
  expectedCount: number,
  expectedIdDigest: string,
  expectedContentDigest: string,
  table: Table,
  idColumn: string,
  source: StagedSourceVerification,
): Promise<boolean> {
  const ledgers = await readRows<StagedBatchRow>(
    tables.batches,
    ledgerPredicate(publicationId, rowKind, batchIndex),
  );
  if (ledgers.length === 0) return false;
  if (ledgers.length !== 1) {
    throw new Error("Staged publication batch ledger is duplicated");
  }
  const ledger = ledgers[0];
  if (
    ledger.expected_count !== expectedCount ||
    ledger.expected_id_digest !== expectedIdDigest ||
    ledger.expected_content_digest !== expectedContentDigest
  ) {
    throw new Error("Staged publication batch index conflict");
  }
  await readAndVerifyStagedBatch({
    table,
    publicationId,
    rowKind,
    idColumn,
    ledger,
    source,
  });
  return true;
}

async function assertCumulativeBatchCount(
  tables: CodeIndexStagedTables,
  publicationId: string,
  rowKind: StagedBatchRow["row_kind"],
  batchIndex: number,
  nextCount: number,
  expectedTotal: number,
): Promise<void> {
  const ledgers = await readProjectedRows<StagedBatchRow>(
    tables.batches,
    sqlAnd(
      sqlEquals("publication_id", publicationId),
      sqlEquals("row_kind", rowKind),
    ),
    ["batch_index", "expected_count"],
  );
  if (ledgers.length > expectedTotal) {
    throw new Error(`Staged ${rowKind} batch ledger exceeds manifest bounds`);
  }
  const total = ledgers
    .filter((ledger) => ledger.batch_index !== batchIndex)
    .reduce((sum, ledger) => sum + ledger.expected_count, nextCount);
  if (total > expectedTotal) {
    throw new Error(`Staged ${rowKind} batches exceed manifest expected count`);
  }
}

function assertUniqueLedgers(ledgers: StagedBatchRow[]): void {
  const keys = ledgers.map(
    (ledger) => `${ledger.row_kind}:${ledger.batch_index}`,
  );
  if (new Set(keys).size !== keys.length) {
    throw new Error("Staged publication batch ledger is duplicated");
  }
}

async function verifyStagedRows(options: {
  table: Table;
  publicationId: string;
  rowKind: StagedBatchRow["row_kind"];
  idColumn: string;
  ledgers: StagedBatchRow[];
  expectedCount: number;
  expectedDigest: string;
  source: StagedSourceVerification;
}): Promise<string[]> {
  const ids: string[] = [];
  for (const ledger of options.ledgers.filter(
    (entry) => entry.row_kind === options.rowKind,
  )) {
    const records = await readAndVerifyStagedBatch({
      table: options.table,
      publicationId: options.publicationId,
      rowKind: options.rowKind,
      idColumn: options.idColumn,
      ledger,
      source: options.source,
    });
    const batchIds = records.map((record) => record.id);
    ids.push(...batchIds);
  }

  const physicalCount = await options.table.countRows(
    sqlEquals("publication_id", options.publicationId),
  );
  if (
    physicalCount !== ids.length ||
    ids.length !== options.expectedCount ||
    createRetrievalRecordIdDigest(ids) !== options.expectedDigest
  ) {
    throw new Error(
      `Staged publication ${options.rowKind} verification failed`,
    );
  }
  return ids;
}

async function requireManifest(
  tables: CodeIndexStagedTables,
  publicationId: string,
  includeSource = true,
): Promise<StagedManifestRow> {
  const rows = await readProjectedRows<StagedManifestRow>(
    tables.manifests,
    sqlEquals("publication_id", publicationId),
    includeSource
      ? [...COMPACT_MANIFEST_COLUMNS, "source_payload_json"]
      : COMPACT_MANIFEST_COLUMNS,
  );
  const manifest = rows[0];
  if (!manifest) throw new Error("Staged publication not found");
  return manifest;
}

async function readAndVerifyStagedBatch(options: {
  table: Table;
  publicationId: string;
  rowKind: StagedBatchRow["row_kind"];
  idColumn: string;
  ledger: StagedBatchRow;
  source: StagedSourceVerification;
}): Promise<
  Array<{
    id: string;
    sourceId: string;
    revisionId: string;
    generation: string;
  }>
> {
  const columns = [
    options.idColumn,
    "source_id",
    "revision_id",
    "generation",
    "payload_json",
    ...(options.rowKind === "chunk" ? ["search_text", "embedding"] : []),
  ];
  const rows = await readProjectedRows<StagedRecordRow>(
    options.table,
    batchPredicate(options.publicationId, options.ledger.batch_index),
    columns,
  );
  const records = rows.map((row) =>
    parseAndValidateStagedRecord(row, options, options.idColumn),
  );
  const ids = records.map((record) => record.id);
  if (
    ids.length !== options.ledger.expected_count ||
    createRetrievalRecordIdDigest(ids) !== options.ledger.expected_id_digest ||
    createRetrievalRecordContentDigest(records) !==
      options.ledger.expected_content_digest
  ) {
    throw new Error(`Staged ${options.rowKind} batch verification failed`);
  }
  return records;
}

function parseAndValidateStagedRecord(
  row: StagedRecordRow,
  options: {
    rowKind: StagedBatchRow["row_kind"];
    source: StagedSourceVerification;
  },
  idColumn: string,
): { id: string; sourceId: string; revisionId: string; generation: string } {
  const record = JSON.parse(row.payload_json) as {
    id: string;
    sourceId: string;
    revisionId: string;
    generation: string;
  };
  if (
    record.id !== String(row[idColumn]) ||
    record.sourceId !== row.source_id ||
    record.revisionId !== row.revision_id ||
    record.generation !== row.generation ||
    record.sourceId !== options.source.id ||
    record.revisionId !== options.source.revision.id ||
    record.generation !== options.source.generation
  ) {
    throw new Error(`Staged ${options.rowKind} ownership verification failed`);
  }
  if (options.rowKind === "chunk") {
    const chunk = record as RetrievalStagedChunkBatch["chunks"][number];
    if (!options.source.document) {
      throw new Error("Staged chunk source document is unavailable");
    }
    const expectedSearchText = buildRetrievalChunkSearchText({
      chunk,
      source: options.source.document,
      relations: [],
    });
    if (
      row.search_text !== expectedSearchText ||
      !matchesMaterializedEmbedding(row.embedding, chunk.embedding)
    ) {
      throw new Error("Staged chunk materialization verification failed");
    }
  }
  return record;
}

function matchesMaterializedEmbedding(
  actual: MaterializedEmbedding | null | undefined,
  expected: readonly number[] | null,
): boolean {
  if (actual == null || expected == null)
    return actual == null && expected == null;
  if (actual.length !== expected.length) return false;
  for (let index = 0; index < expected.length; index += 1) {
    const value = actual.get ? actual.get(index) : actual[index];
    if (value !== Math.fround(expected[index])) return false;
  }
  return true;
}

async function readProjectedRows<T>(
  table: Table,
  predicate: string,
  columns: string[],
): Promise<T[]> {
  const rows = await table.query().where(predicate).select(columns).toArray();
  return rows.map((row) => row.toJSON() as T);
}

async function readRows<T>(table: Table, predicate: string): Promise<T[]> {
  const rows = await table.query().where(predicate).toArray();
  return rows.map((row) => row.toJSON() as T);
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

function batchPredicate(publicationId: string, batchIndex: number): string {
  return sqlAnd(
    sqlEquals("publication_id", publicationId),
    `batch_index = ${batchIndex}`,
  );
}

function ledgerPredicate(
  publicationId: string,
  rowKind: StagedBatchRow["row_kind"],
  batchIndex: number,
): string {
  return sqlAnd(
    sqlEquals("publication_id", publicationId),
    sqlEquals("row_kind", rowKind),
    `batch_index = ${batchIndex}`,
  );
}

function sqlEquals(field: string, value: string): string {
  return `${field} = ${sqlString(value)}`;
}

function sqlAnd(...conditions: string[]): string {
  return conditions.map((condition) => `(${condition})`).join(" AND ");
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
