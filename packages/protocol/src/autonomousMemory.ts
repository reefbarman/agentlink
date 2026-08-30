export type MemoryKind =
  | "preference"
  | "project_fact"
  | "gotcha"
  | "decision"
  | "workflow_hint"
  | "correction";

export type MemoryStatus =
  | "active"
  | "superseded"
  | "contested"
  | "forgotten"
  | "expired";

export interface MemoryScope {
  kind: "global" | "workspace" | "session";
  id: string;
}

export type MemoryProvenanceSource =
  | "current_user"
  | "repository"
  | "foreground_agent"
  | "background_agent"
  | "import";

export interface MemoryProvenance {
  source: MemoryProvenanceSource;
  observedAt: string;
  sessionId?: string;
  agentId?: string;
  evidence?: string;
}

export interface MemoryRecord {
  id: string;
  revision: number;
  scope: MemoryScope;
  kind: MemoryKind;
  statement: string;
  conflictKey?: string;
  confidence: number;
  status: MemoryStatus;
  provenance: MemoryProvenance[];
  createdAt: string;
  updatedAt: string;
  observedAt: string;
  expiresAt?: string;
  supersededBy?: string;
  forgottenAt?: string;
}

export interface MemoryRevision {
  recordId: string;
  revision: number;
  recordedAt: string;
  record: MemoryRecord;
}

export type MemoryImportStatus = "pending" | "complete" | "failed";

export interface MemoryImportCheckpoint {
  id: string;
  sourceKey: string;
  sourceRevision: string;
  importerSchemaVersion: number;
  status: MemoryImportStatus;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  failedAt?: string;
  snapshotId?: string;
  auditEventIds?: string[];
  importedRecordIds?: string[];
  error?: {
    code: string;
    message: string;
  };
}

export interface MemoryStoreSnapshot {
  id: string;
  tag: string;
  createdAt: string;
  records: MemoryRecord[];
  revisions: MemoryRevision[];
  audits: MemoryAuditEvent[];
  importCheckpoints: MemoryImportCheckpoint[];
}

export type MemoryManageOperation =
  | "remember"
  | "update"
  | "supersede"
  | "forget"
  | "restore"
  | "undo";

export type MemoryAuditOperation = MemoryManageOperation | "clear" | "import";

export type MemoryDisposition =
  | "created"
  | "updated"
  | "same-fact"
  | "superseded"
  | "contested"
  | "forgotten"
  | "restored"
  | "undone"
  | "cleared"
  | "imported"
  | "rejected-sensitive"
  | "rejected-quota"
  | "not-found"
  | "stale-revision";

export interface MemoryAuditChange {
  recordId: string;
  before: MemoryRecord | null;
  after: MemoryRecord | null;
}

export interface MemoryAuditEvent {
  id: string;
  operation: MemoryAuditOperation;
  disposition: MemoryDisposition;
  occurredAt: string;
  actor: MemoryProvenance;
  scope: MemoryScope;
  changes: MemoryAuditChange[];
  undoneAuditEventId?: string;
  rejection?: {
    reason: "sensitive" | "record-length" | "scope-quota";
    finding?: string;
    candidateLength: number;
  };
}

export interface ManageMemoryRequest {
  operation: MemoryManageOperation;
  scope: MemoryScope;
  provenance: MemoryProvenance;
  targetId?: string;
  statement?: string;
  kind?: MemoryKind;
  conflictKey?: string;
  confidence?: number;
  expiresAt?: string;
  expectedRevision?: number;
  undoAuditEventId?: string;
  /** Internal deterministic identity used by typed migration services. */
  recordId?: string;
  /** Internal one-time migration exemption from the runtime growth quota. */
  bypassScopeQuota?: boolean;
}

export interface ManageMemoryResult {
  disposition: MemoryDisposition;
  record?: MemoryRecord;
  relatedRecords: MemoryRecord[];
  auditEventId: string;
}

export interface ImportMemoryRecordCandidate {
  id: string;
  scope: MemoryScope;
  kind: MemoryKind;
  statement: string;
  provenance: MemoryProvenance;
  conflictKey?: string;
  confidence?: number;
  expiresAt?: string;
}

export interface ImportMemoryRecordsRequest {
  checkpointId: string;
  snapshotId: string;
  snapshotTag: string;
  sourceKey: string;
  sourceRevision: string;
  importerSchemaVersion: number;
  records: ImportMemoryRecordCandidate[];
}

export interface ImportMemoryRecordsResult {
  status: "imported" | "already-complete";
  checkpoint: MemoryImportCheckpoint;
  results: ManageMemoryResult[];
}

export interface RecordMemoryImportFailureRequest {
  checkpointId: string;
  sourceKey: string;
  sourceRevision: string;
  importerSchemaVersion: number;
  startedAt: string;
  error: {
    code: string;
    message: string;
  };
}

export interface QueryMemoryRequest {
  scopes: MemoryScope[];
  query?: string;
  kinds?: MemoryKind[];
  statuses?: MemoryStatus[];
  sources?: MemoryProvenanceSource[];
  limit?: number;
}

export interface QueryMemoryResult {
  records: MemoryRecord[];
  total: number;
}

export interface MemoryRecordDetail {
  record: MemoryRecord;
  revisions: MemoryRevision[];
  audit: MemoryAuditEvent[];
}

export interface ClearMemoryScopeRequest {
  scope: MemoryScope;
  provenance: MemoryProvenance;
}

export interface ClearMemoryScopeResult {
  clearedCount: number;
  auditEventId: string;
}

export interface MemoryArchiveV1 {
  schema: "agentlink-memory";
  version: 1;
  archiveId: string;
  exportedAt: string;
  scope: MemoryScope;
  records: MemoryRecord[];
  warning: string;
}

export interface ImportMemoryArchiveRequest {
  archive: MemoryArchiveV1;
  targetScope: MemoryScope;
  provenance: MemoryProvenance;
}

export interface ImportMemoryArchiveResult {
  importedCount: number;
  skippedCount: number;
  snapshotId: string;
  auditEventId: string;
}

export interface RecallMemoryRequest {
  query: string;
  scopes: MemoryScope[];
  limit?: number;
  minimumScore?: number;
  automatic?: boolean;
}

export interface RecalledMemory {
  record: MemoryRecord;
  score: number;
  rendering: string;
  authority: "low-authority-evidence";
  canAuthorizeTools: false;
}

export interface RecallMemoryResult {
  memories: RecalledMemory[];
  mode: "lexical-only" | "hybrid";
}

export interface MemoryLexicalSearchRequest {
  text: string;
  scopes: MemoryScope[];
  limit: number;
}

export interface MemoryLexicalCandidate {
  record: MemoryRecord;
  score: number;
}

export interface MemoryHealthSnapshot {
  status: "ready" | "degraded" | "unavailable";
  retrieval: "lexical-only" | "hybrid" | "unavailable";
  crud: boolean;
  dedupe: boolean;
  conflict: boolean;
  auditUndo: boolean;
  recordCount: number;
  activeRecordCount: number;
  auditEventCount: number;
  reason?: string;
}

export type MemoryToolScope = "global" | "project";

export interface ManageMemoryToolInput {
  operation: MemoryManageOperation;
  scope: MemoryToolScope;
  source_evidence: string;
  kind?: MemoryKind;
  statement?: string;
  target_id?: string;
  conflict_key?: string;
  confidence?: number;
  expires_at?: string;
  expected_revision?: number;
  undo_audit_event_id?: string;
}

export interface RecallMemoryToolInput {
  query: string;
  scope?: MemoryToolScope | "all";
  limit?: number;
  minimum_score?: number;
}

export interface MemoryToolExecutionContext {
  sessionId: string;
  projectId?: string;
  isBackground: boolean;
  observedAt: string;
}

export interface ManageMemoryToolRequest {
  input: ManageMemoryToolInput;
  context: MemoryToolExecutionContext;
}

export interface RecallMemoryToolRequest {
  input: RecallMemoryToolInput;
  context: MemoryToolExecutionContext;
}

/** Immutable low-authority evidence prepared once for one logical agent invocation. */
export interface AutomaticMemoryContext {
  readonly rendering: string;
  readonly estimatedTokens: number;
  readonly memoryCount: number;
  readonly query: string;
  readonly scopes: readonly MemoryToolScope[];
  readonly authority: "low-authority-evidence";
  readonly canAuthorizeTools: false;
}

export interface MemoryActivityRequest {
  scope: MemoryToolScope;
  projectId?: string;
  limit?: number;
}

export interface MemoryInspectionQueryRequest {
  scope: MemoryToolScope | "all";
  projectId?: string;
  query?: string;
  kinds?: MemoryKind[];
  statuses?: MemoryStatus[];
  sources?: MemoryProvenanceSource[];
  limit?: number;
}

export interface MemoryInspectionDetailRequest {
  recordId: string;
  scope: MemoryToolScope;
  projectId?: string;
}

export interface MemoryInspectionDetailResult {
  detail: MemoryRecordDetail | null;
  health: MemoryHealthSnapshot;
}

export interface MemoryInspectionMutationContext {
  scope: MemoryToolScope;
  projectId?: string;
  observedAt: string;
  evidence: string;
}

export interface MemoryPanelSnapshot {
  records: MemoryRecord[];
  total: number;
  events: MemoryAuditEvent[];
  selected?: MemoryRecordDetail | null;
  health: MemoryHealthSnapshot;
}
