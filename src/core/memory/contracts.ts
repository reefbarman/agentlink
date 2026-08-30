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

export * from "@agentlink/protocol/autonomous-memory";

export interface MemoryRepositoryReader {
  get(recordId: string): Promise<MemoryRecord | null>;
  list(scope?: MemoryScope): Promise<MemoryRecord[]>;
  searchLexical(
    request: MemoryLexicalSearchRequest,
  ): Promise<MemoryLexicalCandidate[]>;
  listRevisions(recordId: string): Promise<MemoryRevision[]>;
  listAudit(recordId?: string): Promise<MemoryAuditEvent[]>;
  getAuditEvent(auditEventId: string): Promise<MemoryAuditEvent | null>;
  getImportCheckpoint(
    checkpointId: string,
  ): Promise<MemoryImportCheckpoint | null>;
  listImportCheckpoints(sourceKey?: string): Promise<MemoryImportCheckpoint[]>;
  getSnapshot(snapshotId: string): Promise<MemoryStoreSnapshot | null>;
  listSnapshots(): Promise<MemoryStoreSnapshot[]>;
}

export interface MemoryRepositoryTransaction extends MemoryRepositoryReader {
  put(record: MemoryRecord): Promise<void>;
  delete(recordId: string): Promise<void>;
  appendRevision(revision: MemoryRevision): Promise<void>;
  appendAudit(event: MemoryAuditEvent): Promise<void>;
  putImportCheckpoint(checkpoint: MemoryImportCheckpoint): Promise<void>;
  putSnapshot(snapshot: MemoryStoreSnapshot): Promise<void>;
}

export interface MemoryRepository extends MemoryRepositoryReader {
  transaction<T>(
    operation: (transaction: MemoryRepositoryTransaction) => Promise<T>,
  ): Promise<T>;
  health(): Promise<MemoryHealthSnapshot>;
}

export interface AutonomousMemoryServiceOptions {
  now?: () => Date;
  createId?: (kind: "record" | "audit") => string;
  maxStatementChars?: number;
  maxRecordsPerScope?: number;
}
