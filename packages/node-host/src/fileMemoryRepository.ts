import {
  memoryLexicalScore,
  sameMemoryScope,
  type MemoryRepository,
  type MemoryRepositoryTransaction,
} from "@agentlink/core/memory";
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
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const STATE_FILENAME = "memory.json";
const TEMP_PREFIX = ".memory.json.";

/** A record whose text was purged: only its ID and when. */
export interface ForgottenMemory {
  readonly id: string;
  readonly forgottenAt: string;
}

interface FileMemoryState {
  schemaVersion: 1;
  records: MemoryRecord[];
  revisions: MemoryRevision[];
  audits: MemoryAuditEvent[];
  importCheckpoints: MemoryImportCheckpoint[];
  snapshots: MemoryStoreSnapshot[];
  forgotten: ForgottenMemory[];
}

/**
 * Autonomous memory in one JSON file (`memory.json`, mode 0600) under a
 * directory. The whole store is held in memory, each transaction works on
 * a copy and is written atomically (temporary file, fsync, rename) before
 * it is visible, so a failed write or a failed operation changes nothing.
 * One process owns the directory.
 *
 * Forgetting through the service only marks a record forgotten;
 * `purgeForgotten` then removes its text from the records, revisions,
 * audit changes and snapshots, keeping `{ id, forgottenAt }`.
 */
export class FileMemoryRepository implements MemoryRepository {
  private pending: Promise<void> = Promise.resolve();

  private constructor(
    private readonly file: string,
    private state: FileMemoryState,
  ) {}

  static async open(directory: string): Promise<FileMemoryRepository> {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    for (const entry of await fs.readdir(directory)) {
      if (entry.startsWith(TEMP_PREFIX)) {
        await fs.rm(path.join(directory, entry), { force: true });
      }
    }
    const file = path.join(directory, STATE_FILENAME);
    let raw: string | undefined;
    try {
      raw = await fs.readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return new FileMemoryRepository(
      file,
      raw === undefined ? emptyState() : parseState(raw, file),
    );
  }

  async transaction<T>(
    operation: (transaction: MemoryRepositoryTransaction) => Promise<T>,
  ): Promise<T> {
    return await this.exclusive(async () => {
      const draft = clone(this.state);
      const result = await operation(transactionView(draft));
      await this.write(draft);
      this.state = draft;
      return result;
    });
  }

  /**
   * Remove the text of every forgotten record from disk. Returns the IDs
   * purged. Earlier chats and backups may still contain it.
   */
  async purgeForgotten(): Promise<string[]> {
    return await this.exclusive(async () => {
      const ids = new Set(
        this.state.records
          .filter((record) => record.status === "forgotten")
          .map((record) => record.id),
      );
      if (ids.size === 0) return [];
      const draft = clone(this.state);
      const now = new Date().toISOString();
      for (const record of draft.records) {
        if (ids.has(record.id)) {
          draft.forgotten.push({
            id: record.id,
            forgottenAt: record.forgottenAt ?? now,
          });
        }
      }
      purge(draft, ids);
      await this.write(draft);
      this.state = draft;
      return [...ids];
    });
  }

  /** The current records, synchronously, for status displays. */
  currentRecords(): MemoryRecord[] {
    return clone(this.state.records);
  }

  async listForgotten(): Promise<ForgottenMemory[]> {
    await this.pending;
    return clone(this.state.forgotten);
  }

  async get(recordId: string): Promise<MemoryRecord | null> {
    await this.pending;
    return transactionView(this.state).get(recordId);
  }

  async list(scope?: MemoryScope): Promise<MemoryRecord[]> {
    await this.pending;
    return transactionView(this.state).list(scope);
  }

  async searchLexical(
    request: MemoryLexicalSearchRequest,
  ): Promise<MemoryLexicalCandidate[]> {
    await this.pending;
    return transactionView(this.state).searchLexical(request);
  }

  async listRevisions(recordId: string): Promise<MemoryRevision[]> {
    await this.pending;
    return transactionView(this.state).listRevisions(recordId);
  }

  async listAudit(recordId?: string): Promise<MemoryAuditEvent[]> {
    await this.pending;
    return transactionView(this.state).listAudit(recordId);
  }

  async getAuditEvent(auditEventId: string): Promise<MemoryAuditEvent | null> {
    await this.pending;
    return transactionView(this.state).getAuditEvent(auditEventId);
  }

  async getImportCheckpoint(
    checkpointId: string,
  ): Promise<MemoryImportCheckpoint | null> {
    await this.pending;
    return transactionView(this.state).getImportCheckpoint(checkpointId);
  }

  async listImportCheckpoints(
    sourceKey?: string,
  ): Promise<MemoryImportCheckpoint[]> {
    await this.pending;
    return transactionView(this.state).listImportCheckpoints(sourceKey);
  }

  async getSnapshot(snapshotId: string): Promise<MemoryStoreSnapshot | null> {
    await this.pending;
    return transactionView(this.state).getSnapshot(snapshotId);
  }

  async listSnapshots(): Promise<MemoryStoreSnapshot[]> {
    await this.pending;
    return transactionView(this.state).listSnapshots();
  }

  async health(): Promise<MemoryHealthSnapshot> {
    await this.pending;
    return {
      status: "ready",
      retrieval: "lexical-only",
      crud: true,
      dedupe: true,
      conflict: true,
      auditUndo: true,
      recordCount: this.state.records.length,
      activeRecordCount: this.state.records.filter(
        (record) => record.status === "active",
      ).length,
      auditEventCount: this.state.audits.length,
    };
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.pending.then(operation);
    this.pending = run.then(
      () => undefined,
      () => undefined,
    );
    return await run;
  }

  private async write(state: FileMemoryState): Promise<void> {
    const temporary = path.join(
      path.dirname(this.file),
      `${TEMP_PREFIX}${randomUUID()}`,
    );
    const handle = await fs.open(temporary, "w", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(state)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fs.rename(temporary, this.file);
    } catch (error) {
      await fs.rm(temporary, { force: true });
      throw error;
    }
  }
}

function emptyState(): FileMemoryState {
  return {
    schemaVersion: 1,
    records: [],
    revisions: [],
    audits: [],
    importCheckpoints: [],
    snapshots: [],
    forgotten: [],
  };
}

function parseState(raw: string, file: string): FileMemoryState {
  const parsed = JSON.parse(raw) as Partial<FileMemoryState>;
  if (
    parsed.schemaVersion !== 1 ||
    !Array.isArray(parsed.records) ||
    !Array.isArray(parsed.revisions) ||
    !Array.isArray(parsed.audits)
  ) {
    throw new Error(`${file} is not a memory store this version reads`);
  }
  return {
    schemaVersion: 1,
    records: parsed.records,
    revisions: parsed.revisions,
    audits: parsed.audits,
    importCheckpoints: parsed.importCheckpoints ?? [],
    snapshots: parsed.snapshots ?? [],
    forgotten: parsed.forgotten ?? [],
  };
}

/** Drop every copy of the records' content; keep audit event shells. */
function purge(state: FileMemoryState, ids: ReadonlySet<string>): void {
  state.records = state.records.filter((record) => !ids.has(record.id));
  state.revisions = state.revisions.filter(
    (revision) => !ids.has(revision.recordId),
  );
  const scrubAudit = (event: MemoryAuditEvent): MemoryAuditEvent => {
    if (!event.changes.some((change) => ids.has(change.recordId))) {
      return event;
    }
    const actor = { ...event.actor };
    delete actor.evidence;
    return {
      ...event,
      actor,
      changes: event.changes.map((change) =>
        ids.has(change.recordId)
          ? { recordId: change.recordId, before: null, after: null }
          : change,
      ),
    };
  };
  state.audits = state.audits.map(scrubAudit);
  state.snapshots = state.snapshots.map((snapshot) => ({
    ...snapshot,
    records: snapshot.records.filter((record) => !ids.has(record.id)),
    revisions: snapshot.revisions.filter(
      (revision) => !ids.has(revision.recordId),
    ),
    audits: snapshot.audits.map(scrubAudit),
  }));
}

function transactionView(state: FileMemoryState): MemoryRepositoryTransaction {
  const sortedRecords = (scope?: MemoryScope) =>
    state.records
      .filter((record) => !scope || sameMemoryScope(record.scope, scope))
      .sort((left, right) => left.id.localeCompare(right.id));
  return {
    get: async (recordId) =>
      clone(state.records.find((record) => record.id === recordId) ?? null),
    list: async (scope) => clone(sortedRecords(scope)),
    searchLexical: async (request) =>
      clone(
        state.records
          .filter((record) =>
            request.scopes.some((scope) =>
              sameMemoryScope(record.scope, scope),
            ),
          )
          .map((record) => ({
            record,
            score: memoryLexicalScore(request.text, record.statement),
          }))
          .filter((candidate) => candidate.score > 0)
          .sort(
            (left, right) =>
              right.score - left.score ||
              left.record.id.localeCompare(right.record.id),
          )
          .slice(0, request.limit),
      ),
    listRevisions: async (recordId) =>
      clone(
        state.revisions
          .filter((revision) => revision.recordId === recordId)
          .sort((left, right) => left.revision - right.revision),
      ),
    listAudit: async (recordId) =>
      clone(
        recordId
          ? state.audits.filter((event) =>
              event.changes.some((change) => change.recordId === recordId),
            )
          : state.audits,
      ),
    getAuditEvent: async (auditEventId) =>
      clone(state.audits.find((event) => event.id === auditEventId) ?? null),
    getImportCheckpoint: async (checkpointId) =>
      clone(
        state.importCheckpoints.find(
          (checkpoint) => checkpoint.id === checkpointId,
        ) ?? null,
      ),
    listImportCheckpoints: async (sourceKey) =>
      clone(
        state.importCheckpoints
          .filter(
            (checkpoint) => !sourceKey || checkpoint.sourceKey === sourceKey,
          )
          .sort(
            (left, right) =>
              left.startedAt.localeCompare(right.startedAt) ||
              left.id.localeCompare(right.id),
          ),
      ),
    getSnapshot: async (snapshotId) =>
      clone(
        state.snapshots.find((snapshot) => snapshot.id === snapshotId) ?? null,
      ),
    listSnapshots: async () =>
      clone(
        [...state.snapshots].sort(
          (left, right) =>
            left.createdAt.localeCompare(right.createdAt) ||
            left.id.localeCompare(right.id),
        ),
      ),
    put: async (record) => {
      const index = state.records.findIndex((item) => item.id === record.id);
      if (index >= 0) state.records[index] = clone(record);
      else state.records.push(clone(record));
    },
    delete: async (recordId) => {
      state.records = state.records.filter((record) => record.id !== recordId);
    },
    appendRevision: async (revision) => {
      if (
        state.revisions.some(
          (item) =>
            item.recordId === revision.recordId &&
            item.revision === revision.revision,
        )
      ) {
        throw new Error(
          `Memory revision ${revision.recordId}@${revision.revision} already exists`,
        );
      }
      state.revisions.push(clone(revision));
    },
    appendAudit: async (event) => {
      if (state.audits.some((item) => item.id === event.id)) {
        throw new Error(`Memory audit event ${event.id} already exists`);
      }
      state.audits.push(clone(event));
    },
    putImportCheckpoint: async (checkpoint) => {
      const index = state.importCheckpoints.findIndex(
        (item) => item.id === checkpoint.id,
      );
      if (index >= 0) state.importCheckpoints[index] = clone(checkpoint);
      else state.importCheckpoints.push(clone(checkpoint));
    },
    putSnapshot: async (snapshot) => {
      if (state.snapshots.some((item) => item.id === snapshot.id)) {
        throw new Error(`Memory snapshot ${snapshot.id} already exists`);
      }
      state.snapshots.push(clone(snapshot));
    },
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
