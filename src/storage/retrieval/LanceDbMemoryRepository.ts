import * as fs from "node:fs/promises";

import type { Connection, Table } from "@lancedb/lancedb";
import { Index, connect, makeArrowTable } from "@lancedb/lancedb";
import type {
  MemoryAuditEvent,
  MemoryHealthSnapshot,
  MemoryImportCheckpoint,
  MemoryLexicalCandidate,
  MemoryLexicalSearchRequest,
  MemoryRecord,
  MemoryRevision,
  MemoryScope,
  MemoryStoreSnapshot,
} from "@agentlink/protocol/autonomous-memory";
import type {
  MemoryRepository,
  MemoryRepositoryTransaction,
} from "../../core/memory/contracts.js";
import { RETRIEVAL_TABLES, memoryEntrySchema } from "./lanceDbSchemas.js";
import {
  memoryLexicalScore,
  sameMemoryScope,
} from "../../core/memory/memoryPolicy.js";

import { withRetrievalStoreLock } from "./retrievalStoreLock.js";

const MEMORY_FTS_INDEX = "memory_search_text_fts";
const MEMORY_RECORD_INDEX = "memory_record_id_btree";
const MEMORY_SCOPE_INDEX = "memory_scope_id_btree";

interface MemoryEntryRow {
  row_id: string;
  row_kind: "head" | "revision" | "audit" | "import_checkpoint" | "snapshot";
  record_id: string | null;
  revision: number | null;
  scope_kind: string;
  scope_id: string;
  status: string;
  search_text: string;
  occurred_at: string;
  payload_json: string;
}

interface MemoryState {
  records: Map<string, MemoryRecord>;
  revisions: Map<string, MemoryRevision[]>;
  audits: MemoryAuditEvent[];
  importCheckpoints: Map<string, MemoryImportCheckpoint>;
  snapshots: Map<string, MemoryStoreSnapshot>;
}

export interface MemoryRepositoryStateExport {
  records: MemoryRecord[];
  revisions: MemoryRevision[];
  audits: MemoryAuditEvent[];
  importCheckpoints: MemoryImportCheckpoint[];
  snapshots: MemoryStoreSnapshot[];
}

export interface MemoryRepositoryMergeResult {
  recordsAdded: number;
  recordsUpdated: number;
  revisionsAdded: number;
  auditsAdded: number;
  importCheckpointsAdded: number;
  snapshotsAdded: number;
}

export interface LanceDbMemoryRepositoryOptions {
  root: string;
}

export class LanceDbMemoryRepository implements MemoryRepository {
  private readonly root: string;
  private connection: Connection | undefined;
  private table: Table | undefined;
  private closing = false;
  private closePromise: Promise<void> | undefined;
  private lexicalIndex: "unknown" | "ready" | "unavailable" = "unknown";
  private lexicalIndexDetail: string | undefined;

  constructor(options: LanceDbMemoryRepositoryOptions) {
    this.root = options.root;
  }

  async transaction<T>(
    operation: (transaction: MemoryRepositoryTransaction) => Promise<T>,
  ): Promise<T> {
    return await this.withTable(async (table) => {
      const state = await readState(table);
      const staged = cloneState(state);
      const result = await operation(transactionView(staged));
      if (!memoryStatesEqual(state, staged)) {
        await this.writeState(table, staged);
      }
      return result;
    });
  }

  async get(recordId: string): Promise<MemoryRecord | null> {
    return await this.read((state) =>
      clone(state.records.get(recordId) ?? null),
    );
  }

  async list(scope?: MemoryScope): Promise<MemoryRecord[]> {
    return await this.read((state) => listRecords(state, scope));
  }

  async searchLexical(
    request: MemoryLexicalSearchRequest,
  ): Promise<MemoryLexicalCandidate[]> {
    return await this.withTable(async (table) => {
      const state = await readState(table);
      const nativeIds = await this.nativeCandidateIds(table, request);
      return searchRecords(state, request, nativeIds);
    });
  }

  async listRevisions(recordId: string): Promise<MemoryRevision[]> {
    return await this.read((state) =>
      clone(state.revisions.get(recordId) ?? []),
    );
  }

  async listAudit(recordId?: string): Promise<MemoryAuditEvent[]> {
    return await this.read((state) => listAudit(state, recordId));
  }

  async getAuditEvent(auditEventId: string): Promise<MemoryAuditEvent | null> {
    return await this.read((state) =>
      clone(state.audits.find((event) => event.id === auditEventId) ?? null),
    );
  }

  async getImportCheckpoint(
    checkpointId: string,
  ): Promise<MemoryImportCheckpoint | null> {
    return await this.read((state) =>
      clone(state.importCheckpoints.get(checkpointId) ?? null),
    );
  }

  async listImportCheckpoints(
    sourceKey?: string,
  ): Promise<MemoryImportCheckpoint[]> {
    return await this.read((state) => listImportCheckpoints(state, sourceKey));
  }

  async getSnapshot(snapshotId: string): Promise<MemoryStoreSnapshot | null> {
    return await this.read((state) =>
      clone(state.snapshots.get(snapshotId) ?? null),
    );
  }

  async listSnapshots(): Promise<MemoryStoreSnapshot[]> {
    return await this.read(listSnapshots);
  }

  async exportState(): Promise<MemoryRepositoryStateExport> {
    return await this.read((state) => exportMemoryState(state));
  }

  async mergeState(
    exported: MemoryRepositoryStateExport,
    options: { legacySourceKeyPrefix?: string } = {},
  ): Promise<MemoryRepositoryMergeResult> {
    return await this.transaction(async (transaction) => {
      const result: MemoryRepositoryMergeResult = {
        recordsAdded: 0,
        recordsUpdated: 0,
        revisionsAdded: 0,
        auditsAdded: 0,
        importCheckpointsAdded: 0,
        snapshotsAdded: 0,
      };
      for (const record of exported.records) {
        const current = await transaction.get(record.id);
        if (!current) {
          await transaction.put(record);
          result.recordsAdded += 1;
        } else if (compareMemoryRecords(record, current) > 0) {
          await transaction.put(record);
          result.recordsUpdated += 1;
        }
      }
      for (const revision of exported.revisions) {
        const current = await transaction.listRevisions(revision.recordId);
        if (!current.some((item) => item.revision === revision.revision)) {
          await transaction.appendRevision(revision);
          result.revisionsAdded += 1;
        }
      }
      const currentAuditIds = new Set(
        (await transaction.listAudit()).map((event) => event.id),
      );
      for (const audit of exported.audits) {
        if (currentAuditIds.has(audit.id)) continue;
        await transaction.appendAudit(audit);
        currentAuditIds.add(audit.id);
        result.auditsAdded += 1;
      }
      const snapshotIdPrefix = options.legacySourceKeyPrefix
        ? `${options.legacySourceKeyPrefix}:snapshot:`
        : "";
      const checkpointIdPrefix = options.legacySourceKeyPrefix
        ? `${options.legacySourceKeyPrefix}:checkpoint:`
        : "";
      const currentSnapshotIds = new Set(
        (await transaction.listSnapshots()).map((snapshot) => snapshot.id),
      );
      for (const snapshot of exported.snapshots) {
        const migrated = snapshotIdPrefix
          ? { ...snapshot, id: `${snapshotIdPrefix}${snapshot.id}` }
          : snapshot;
        if (currentSnapshotIds.has(migrated.id)) continue;
        await transaction.putSnapshot(migrated);
        currentSnapshotIds.add(migrated.id);
        result.snapshotsAdded += 1;
      }
      const currentCheckpointIds = new Set(
        (await transaction.listImportCheckpoints()).map(
          (checkpoint) => checkpoint.id,
        ),
      );
      for (const checkpoint of exported.importCheckpoints) {
        const migrated = options.legacySourceKeyPrefix
          ? {
              ...checkpoint,
              id: `${checkpointIdPrefix}${checkpoint.id}`,
              sourceKey: `${options.legacySourceKeyPrefix}:${checkpoint.sourceKey}`,
              ...(checkpoint.snapshotId
                ? { snapshotId: `${snapshotIdPrefix}${checkpoint.snapshotId}` }
                : {}),
            }
          : checkpoint;
        if (currentCheckpointIds.has(migrated.id)) continue;
        await transaction.putImportCheckpoint(migrated);
        currentCheckpointIds.add(migrated.id);
        result.importCheckpointsAdded += 1;
      }
      return result;
    });
  }

  async health(): Promise<MemoryHealthSnapshot> {
    return await this.withTable(async (table) => {
      const state = await readState(table);
      if (this.lexicalIndex === "unknown") await this.refreshIndexes(table);
      const records = [...state.records.values()];
      const lexicalReady = this.lexicalIndex === "ready";
      return {
        status: lexicalReady ? "ready" : "degraded",
        retrieval: lexicalReady ? "lexical-only" : "unavailable",
        crud: true,
        dedupe: true,
        conflict: true,
        auditUndo: true,
        recordCount: records.length,
        activeRecordCount: records.filter(
          (record) => record.status === "active",
        ).length,
        auditEventCount: state.audits.length,
        ...(!lexicalReady
          ? {
              reason:
                this.lexicalIndexDetail ?? "memory_lexical_index_unavailable",
            }
          : {}),
      };
    });
  }

  async close(): Promise<void> {
    if (this.closePromise) return await this.closePromise;
    this.closing = true;
    if (!this.connection && !this.table) {
      this.closePromise = Promise.resolve();
      return await this.closePromise;
    }
    this.closePromise = withRetrievalStoreLock(this.root, async () => {
      this.table?.close();
      this.table = undefined;
      this.connection?.close();
      this.connection = undefined;
    });
    return await this.closePromise;
  }

  private async read<T>(operation: (state: MemoryState) => T): Promise<T> {
    return await this.withTable(async (table) =>
      operation(await readState(table)),
    );
  }

  private async withTable<T>(
    operation: (table: Table) => Promise<T>,
  ): Promise<T> {
    if (this.closing) throw new Error("memory_store_closed");
    return await withRetrievalStoreLock(this.root, async () => {
      if (this.closing) throw new Error("memory_store_closed");
      return await operation(await this.ensureTable());
    });
  }

  private async ensureTable(): Promise<Table> {
    if (this.table) return this.table;
    await fs.mkdir(this.root, { recursive: true });
    this.connection = await connect(this.root, { readConsistencyInterval: 0 });
    const names = new Set(await this.connection.tableNames());
    if (!names.has(RETRIEVAL_TABLES.memoryEntries)) {
      await this.connection.createEmptyTable(
        RETRIEVAL_TABLES.memoryEntries,
        memoryEntrySchema(),
        { mode: "create", existOk: true },
      );
    }
    this.table = await this.connection.openTable(
      RETRIEVAL_TABLES.memoryEntries,
    );
    if (this.lexicalIndex === "unknown") await this.refreshIndexes(this.table);
    return this.table;
  }

  private async writeState(table: Table, state: MemoryState): Promise<void> {
    const rows = stateRows(state);
    if (rows.length === 0) {
      if ((await table.countRows()) > 0) await table.delete("true");
    } else {
      await table.add(
        makeArrowTable(rows as unknown as Record<string, unknown>[], {
          schema: memoryEntrySchema(),
        }),
        { mode: "overwrite" },
      );
    }
    await this.refreshIndexes(table);
  }

  private async refreshIndexes(table: Table): Promise<void> {
    try {
      await table.createIndex("search_text", {
        config: Index.fts({ withPosition: true, lowercase: true }),
        name: MEMORY_FTS_INDEX,
        replace: true,
        waitTimeoutSeconds: 30,
      });
      await table.createIndex("record_id", {
        config: Index.btree(),
        name: MEMORY_RECORD_INDEX,
        replace: true,
        waitTimeoutSeconds: 30,
      });
      await table.createIndex("scope_id", {
        config: Index.btree(),
        name: MEMORY_SCOPE_INDEX,
        replace: true,
        waitTimeoutSeconds: 30,
      });
      this.lexicalIndex = "ready";
      this.lexicalIndexDetail = undefined;
    } catch (error) {
      this.lexicalIndex = "unavailable";
      this.lexicalIndexDetail =
        error instanceof Error ? error.message : String(error);
    }
  }

  private async nativeCandidateIds(
    table: Table,
    request: MemoryLexicalSearchRequest,
  ): Promise<Set<string> | undefined> {
    if (this.lexicalIndex !== "ready" || !request.text.trim()) return undefined;
    try {
      const rows = await table
        .query()
        .fullTextSearch(request.text, { columns: "search_text" })
        .select(["record_id", "_score"])
        .limit(Math.max(request.limit * 4, 20))
        .toArray();
      return new Set(
        rows.flatMap((row) =>
          typeof row.record_id === "string" ? [row.record_id] : [],
        ),
      );
    } catch (error) {
      this.lexicalIndex = "unavailable";
      this.lexicalIndexDetail =
        error instanceof Error ? error.message : String(error);
      return undefined;
    }
  }
}

function transactionView(state: MemoryState): MemoryRepositoryTransaction {
  return {
    get: async (recordId) => clone(state.records.get(recordId) ?? null),
    list: async (scope) => listRecords(state, scope),
    searchLexical: async (request) => searchRecords(state, request),
    listRevisions: async (recordId) =>
      clone(state.revisions.get(recordId) ?? []),
    listAudit: async (recordId) => listAudit(state, recordId),
    getAuditEvent: async (auditEventId) =>
      clone(state.audits.find((event) => event.id === auditEventId) ?? null),
    getImportCheckpoint: async (checkpointId) =>
      clone(state.importCheckpoints.get(checkpointId) ?? null),
    listImportCheckpoints: async (sourceKey) =>
      listImportCheckpoints(state, sourceKey),
    getSnapshot: async (snapshotId) =>
      clone(state.snapshots.get(snapshotId) ?? null),
    listSnapshots: async () => listSnapshots(state),
    put: async (record) => {
      state.records.set(record.id, clone(record));
    },
    delete: async (recordId) => {
      state.records.delete(recordId);
    },
    appendRevision: async (revision) => {
      const revisions = state.revisions.get(revision.recordId) ?? [];
      if (revisions.some((item) => item.revision === revision.revision)) {
        throw new Error(
          `Memory revision ${revision.recordId}@${revision.revision} already exists`,
        );
      }
      revisions.push(clone(revision));
      state.revisions.set(revision.recordId, revisions);
    },
    appendAudit: async (event) => {
      if (state.audits.some((item) => item.id === event.id)) {
        throw new Error(`Memory audit event ${event.id} already exists`);
      }
      state.audits.push(clone(event));
    },
    putImportCheckpoint: async (checkpoint) => {
      state.importCheckpoints.set(checkpoint.id, clone(checkpoint));
    },
    putSnapshot: async (snapshot) => {
      if (state.snapshots.has(snapshot.id)) {
        throw new Error(`Memory snapshot ${snapshot.id} already exists`);
      }
      state.snapshots.set(snapshot.id, clone(snapshot));
    },
  };
}

async function readState(table: Table): Promise<MemoryState> {
  const rows = await readRows(table);
  const records = new Map<string, MemoryRecord>();
  const revisions = new Map<string, MemoryRevision[]>();
  const audits: MemoryAuditEvent[] = [];
  const importCheckpoints = new Map<string, MemoryImportCheckpoint>();
  const snapshots = new Map<string, MemoryStoreSnapshot>();
  for (const row of rows) {
    if (row.row_kind === "head") {
      const record = parseJson<MemoryRecord>(row.payload_json);
      records.set(record.id, record);
      continue;
    }
    if (row.row_kind === "revision") {
      const revision = parseJson<MemoryRevision>(row.payload_json);
      const existing = revisions.get(revision.recordId) ?? [];
      existing.push(revision);
      revisions.set(revision.recordId, existing);
      continue;
    }
    if (row.row_kind === "audit") {
      audits.push(parseJson<MemoryAuditEvent>(row.payload_json));
      continue;
    }
    if (row.row_kind === "import_checkpoint") {
      const checkpoint = parseJson<MemoryImportCheckpoint>(row.payload_json);
      importCheckpoints.set(checkpoint.id, checkpoint);
      continue;
    }
    const snapshot = parseJson<MemoryStoreSnapshot>(row.payload_json);
    snapshots.set(snapshot.id, snapshot);
  }
  for (const recordRevisions of revisions.values()) {
    recordRevisions.sort((left, right) => left.revision - right.revision);
  }
  audits.sort(
    (left, right) =>
      left.occurredAt.localeCompare(right.occurredAt) ||
      left.id.localeCompare(right.id),
  );
  return { records, revisions, audits, importCheckpoints, snapshots };
}

async function readRows(table: Table): Promise<MemoryEntryRow[]> {
  return (await table.query().toArray()).map((row) => {
    const value =
      row !== null &&
      typeof row === "object" &&
      "toJSON" in row &&
      typeof row.toJSON === "function"
        ? row.toJSON()
        : row;
    return JSON.parse(JSON.stringify(value)) as MemoryEntryRow;
  });
}

function stateRows(state: MemoryState): MemoryEntryRow[] {
  const rows: MemoryEntryRow[] = [];
  for (const record of [...state.records.values()].sort((left, right) =>
    left.id.localeCompare(right.id),
  )) {
    rows.push({
      row_id: `head:${record.id}`,
      row_kind: "head",
      record_id: record.id,
      revision: record.revision,
      scope_kind: record.scope.kind,
      scope_id: record.scope.id,
      status: record.status,
      search_text: record.status === "active" ? record.statement : "",
      occurred_at: record.updatedAt,
      payload_json: JSON.stringify(record),
    });
  }
  for (const [recordId, revisions] of [...state.revisions.entries()].sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    for (const revision of revisions) {
      rows.push({
        row_id: `revision:${recordId}:${revision.revision}`,
        row_kind: "revision",
        record_id: recordId,
        revision: revision.revision,
        scope_kind: revision.record.scope.kind,
        scope_id: revision.record.scope.id,
        status: revision.record.status,
        search_text: "",
        occurred_at: revision.recordedAt,
        payload_json: JSON.stringify(revision),
      });
    }
  }
  for (const audit of state.audits) {
    rows.push({
      row_id: `audit:${audit.id}`,
      row_kind: "audit",
      record_id: audit.changes[0]?.recordId ?? null,
      revision: null,
      scope_kind: audit.scope.kind,
      scope_id: audit.scope.id,
      status: audit.disposition,
      search_text: "",
      occurred_at: audit.occurredAt,
      payload_json: JSON.stringify(audit),
    });
  }
  for (const checkpoint of listImportCheckpoints(state)) {
    rows.push({
      row_id: `import-checkpoint:${checkpoint.id}`,
      row_kind: "import_checkpoint",
      record_id: null,
      revision: checkpoint.importerSchemaVersion,
      scope_kind: "migration",
      scope_id: checkpoint.sourceKey,
      status: checkpoint.status,
      search_text: "",
      occurred_at: checkpoint.updatedAt,
      payload_json: JSON.stringify(checkpoint),
    });
  }
  for (const snapshot of listSnapshots(state)) {
    rows.push({
      row_id: `snapshot:${snapshot.id}`,
      row_kind: "snapshot",
      record_id: null,
      revision: null,
      scope_kind: "snapshot",
      scope_id: snapshot.tag,
      status: "complete",
      search_text: "",
      occurred_at: snapshot.createdAt,
      payload_json: JSON.stringify(snapshot),
    });
  }
  return rows;
}

function exportMemoryState(state: MemoryState): MemoryRepositoryStateExport {
  return {
    records: listRecords(state),
    revisions: [...state.revisions.values()]
      .flat()
      .sort(
        (left, right) =>
          left.recordId.localeCompare(right.recordId) ||
          left.revision - right.revision,
      )
      .map(clone),
    audits: listAudit(state),
    importCheckpoints: listImportCheckpoints(state),
    snapshots: listSnapshots(state),
  };
}

function compareMemoryRecords(left: MemoryRecord, right: MemoryRecord): number {
  return (
    left.revision - right.revision ||
    left.updatedAt.localeCompare(right.updatedAt)
  );
}

function memoryStatesEqual(left: MemoryState, right: MemoryState): boolean {
  return JSON.stringify(stateRows(left)) === JSON.stringify(stateRows(right));
}

function listRecords(state: MemoryState, scope?: MemoryScope): MemoryRecord[] {
  return [...state.records.values()]
    .filter((record) => !scope || sameMemoryScope(record.scope, scope))
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(clone);
}

function searchRecords(
  state: MemoryState,
  request: MemoryLexicalSearchRequest,
  nativeIds?: Set<string>,
): MemoryLexicalCandidate[] {
  const candidates = [...state.records.values()].filter(
    (record) =>
      request.scopes.some((scope) => sameMemoryScope(record.scope, scope)) &&
      (!nativeIds || nativeIds.has(record.id)),
  );
  const ranked = candidates
    .map((record) => ({
      record: clone(record),
      score: memoryLexicalScore(request.text, record.statement),
    }))
    .filter((candidate) => candidate.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.record.id.localeCompare(right.record.id),
    )
    .slice(0, request.limit);
  if (ranked.length > 0 || !nativeIds) return ranked;
  return searchRecords(state, request);
}

function listAudit(state: MemoryState, recordId?: string): MemoryAuditEvent[] {
  return clone(
    recordId
      ? state.audits.filter((event) =>
          event.changes.some((change) => change.recordId === recordId),
        )
      : state.audits,
  );
}

function listImportCheckpoints(
  state: MemoryState,
  sourceKey?: string,
): MemoryImportCheckpoint[] {
  return [...state.importCheckpoints.values()]
    .filter((checkpoint) => !sourceKey || checkpoint.sourceKey === sourceKey)
    .sort(
      (left, right) =>
        left.startedAt.localeCompare(right.startedAt) ||
        left.id.localeCompare(right.id),
    )
    .map(clone);
}

function listSnapshots(state: MemoryState): MemoryStoreSnapshot[] {
  return [...state.snapshots.values()]
    .sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) ||
        left.id.localeCompare(right.id),
    )
    .map(clone);
}

function cloneState(state: MemoryState): MemoryState {
  return {
    records: new Map(
      [...state.records.entries()].map(([key, value]) => [key, clone(value)]),
    ),
    revisions: new Map(
      [...state.revisions.entries()].map(([key, value]) => [key, clone(value)]),
    ),
    audits: clone(state.audits),
    importCheckpoints: new Map(
      [...state.importCheckpoints.entries()].map(([key, value]) => [
        key,
        clone(value),
      ]),
    ),
    snapshots: new Map(
      [...state.snapshots.entries()].map(([key, value]) => [key, clone(value)]),
    ),
  };
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
