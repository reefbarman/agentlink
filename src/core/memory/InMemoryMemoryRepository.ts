import type {
  MemoryAuditEvent,
  MemoryHealthSnapshot,
  MemoryImportCheckpoint,
  MemoryLexicalCandidate,
  MemoryLexicalSearchRequest,
  MemoryRecord,
  MemoryRepository,
  MemoryRepositoryTransaction,
  MemoryRevision,
  MemoryScope,
  MemoryStoreSnapshot,
} from "./contracts.js";
import { memoryLexicalScore, sameMemoryScope } from "./memoryPolicy.js";

interface MemoryRepositoryState {
  records: Map<string, MemoryRecord>;
  revisions: Map<string, MemoryRevision[]>;
  audits: MemoryAuditEvent[];
  importCheckpoints: Map<string, MemoryImportCheckpoint>;
  snapshots: Map<string, MemoryStoreSnapshot>;
}

export class InMemoryMemoryRepository implements MemoryRepository {
  private state: MemoryRepositoryState = {
    records: new Map(),
    revisions: new Map(),
    audits: [],
    importCheckpoints: new Map(),
    snapshots: new Map(),
  };
  private pending: Promise<void> = Promise.resolve();

  async transaction<T>(
    operation: (transaction: MemoryRepositoryTransaction) => Promise<T>,
  ): Promise<T> {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const result = new Promise<T>((resolveResult, rejectResult) => {
      resolve = resolveResult;
      reject = rejectResult;
    });
    const run = this.pending.then(async () => {
      const before = cloneState(this.state);
      try {
        resolve(await operation(this.transactionView()));
      } catch (error) {
        this.state = before;
        reject(error);
      }
    });
    this.pending = run.catch(() => undefined);
    return await result;
  }

  async get(recordId: string): Promise<MemoryRecord | null> {
    await this.pending;
    return clone(this.state.records.get(recordId) ?? null);
  }

  async list(scope?: MemoryScope): Promise<MemoryRecord[]> {
    await this.pending;
    return this.listCurrent(scope);
  }

  async searchLexical(
    request: MemoryLexicalSearchRequest,
  ): Promise<MemoryLexicalCandidate[]> {
    await this.pending;
    return this.searchCurrent(request);
  }

  async listRevisions(recordId: string): Promise<MemoryRevision[]> {
    await this.pending;
    return clone(this.state.revisions.get(recordId) ?? []);
  }

  async listAudit(recordId?: string): Promise<MemoryAuditEvent[]> {
    await this.pending;
    return clone(
      recordId
        ? this.state.audits.filter((event) =>
            event.changes.some((change) => change.recordId === recordId),
          )
        : this.state.audits,
    );
  }

  async getAuditEvent(auditEventId: string): Promise<MemoryAuditEvent | null> {
    await this.pending;
    return clone(
      this.state.audits.find((event) => event.id === auditEventId) ?? null,
    );
  }

  async getImportCheckpoint(
    checkpointId: string,
  ): Promise<MemoryImportCheckpoint | null> {
    await this.pending;
    return clone(this.state.importCheckpoints.get(checkpointId) ?? null);
  }

  async listImportCheckpoints(
    sourceKey?: string,
  ): Promise<MemoryImportCheckpoint[]> {
    await this.pending;
    return listImportCheckpoints(this.state, sourceKey);
  }

  async getSnapshot(snapshotId: string): Promise<MemoryStoreSnapshot | null> {
    await this.pending;
    return clone(this.state.snapshots.get(snapshotId) ?? null);
  }

  async listSnapshots(): Promise<MemoryStoreSnapshot[]> {
    await this.pending;
    return listSnapshots(this.state);
  }

  async health(): Promise<MemoryHealthSnapshot> {
    await this.pending;
    const records = [...this.state.records.values()];
    return {
      status: "ready",
      retrieval: "lexical-only",
      crud: true,
      dedupe: true,
      conflict: true,
      auditUndo: true,
      recordCount: records.length,
      activeRecordCount: records.filter((record) => record.status === "active")
        .length,
      auditEventCount: this.state.audits.length,
    };
  }

  private transactionView(): MemoryRepositoryTransaction {
    return {
      get: async (recordId) => clone(this.state.records.get(recordId) ?? null),
      list: async (scope) => this.listCurrent(scope),
      searchLexical: async (request) => this.searchCurrent(request),
      listRevisions: async (recordId) =>
        clone(this.state.revisions.get(recordId) ?? []),
      listAudit: async (recordId) =>
        clone(
          recordId
            ? this.state.audits.filter((event) =>
                event.changes.some((change) => change.recordId === recordId),
              )
            : this.state.audits,
        ),
      getAuditEvent: async (auditEventId) =>
        clone(
          this.state.audits.find((event) => event.id === auditEventId) ?? null,
        ),
      getImportCheckpoint: async (checkpointId) =>
        clone(this.state.importCheckpoints.get(checkpointId) ?? null),
      listImportCheckpoints: async (sourceKey) =>
        listImportCheckpoints(this.state, sourceKey),
      getSnapshot: async (snapshotId) =>
        clone(this.state.snapshots.get(snapshotId) ?? null),
      listSnapshots: async () => listSnapshots(this.state),
      put: async (record) => {
        this.state.records.set(record.id, clone(record));
      },
      delete: async (recordId) => {
        this.state.records.delete(recordId);
      },
      appendRevision: async (revision) => {
        const revisions = this.state.revisions.get(revision.recordId) ?? [];
        if (revisions.some((item) => item.revision === revision.revision)) {
          throw new Error(
            `Memory revision ${revision.recordId}@${revision.revision} already exists`,
          );
        }
        revisions.push(clone(revision));
        this.state.revisions.set(revision.recordId, revisions);
      },
      appendAudit: async (event) => {
        if (this.state.audits.some((item) => item.id === event.id)) {
          throw new Error(`Memory audit event ${event.id} already exists`);
        }
        this.state.audits.push(clone(event));
      },
      putImportCheckpoint: async (checkpoint) => {
        this.state.importCheckpoints.set(checkpoint.id, clone(checkpoint));
      },
      putSnapshot: async (snapshot) => {
        if (this.state.snapshots.has(snapshot.id)) {
          throw new Error(`Memory snapshot ${snapshot.id} already exists`);
        }
        this.state.snapshots.set(snapshot.id, clone(snapshot));
      },
    };
  }

  private listCurrent(scope?: MemoryScope): MemoryRecord[] {
    return [...this.state.records.values()]
      .filter((record) => !scope || sameMemoryScope(record.scope, scope))
      .sort((left, right) => left.id.localeCompare(right.id))
      .map(clone);
  }

  private searchCurrent(
    request: MemoryLexicalSearchRequest,
  ): MemoryLexicalCandidate[] {
    return [...this.state.records.values()]
      .filter((record) =>
        request.scopes.some((scope) => sameMemoryScope(record.scope, scope)),
      )
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
  }
}

function listImportCheckpoints(
  state: MemoryRepositoryState,
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

function listSnapshots(state: MemoryRepositoryState): MemoryStoreSnapshot[] {
  return [...state.snapshots.values()]
    .sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) ||
        left.id.localeCompare(right.id),
    )
    .map(clone);
}

function cloneState(state: MemoryRepositoryState): MemoryRepositoryState {
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

function clone<T>(value: T): T {
  return structuredClone(value);
}
