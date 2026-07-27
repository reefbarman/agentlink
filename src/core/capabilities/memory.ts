import type {
  ClearMemoryScopeResult,
  ImportMemoryArchiveResult,
  ManageMemoryResult,
  MemoryArchiveV1,
  MemoryAuditEvent,
  MemoryHealthSnapshot,
  MemoryKind,
  MemoryProvenanceSource,
  MemoryRecord,
  MemoryRecordDetail,
  MemoryStatus,
  QueryMemoryResult,
  RecallMemoryResult,
} from "../memory/contracts.js";

export type MemoryToolScope = "global" | "project";

export interface ManageMemoryToolInput {
  operation:
    | "remember"
    | "update"
    | "supersede"
    | "forget"
    | "restore"
    | "undo";
  scope: MemoryToolScope;
  source_evidence: string;
  kind?:
    | "preference"
    | "project_fact"
    | "gotcha"
    | "decision"
    | "workflow_hint"
    | "correction";
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

export interface MemoryToolProvider {
  manage(request: ManageMemoryToolRequest): Promise<{
    result: ManageMemoryResult;
    health: MemoryHealthSnapshot;
  }>;
  recall(request: RecallMemoryToolRequest): Promise<{
    result: RecallMemoryResult;
    health: MemoryHealthSnapshot;
  }>;
  /** Optional request-time recall path with the service's automatic-recall policy enabled. */
  recallAutomatically?(request: RecallMemoryToolRequest): Promise<{
    result: RecallMemoryResult;
    health: MemoryHealthSnapshot;
  }>;
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

export interface MemoryInspectionProvider {
  health(): Promise<MemoryHealthSnapshot>;
  activity(request: MemoryActivityRequest): Promise<{
    events: MemoryAuditEvent[];
    health: MemoryHealthSnapshot;
  }>;
  query(request: MemoryInspectionQueryRequest): Promise<{
    result: QueryMemoryResult;
    health: MemoryHealthSnapshot;
  }>;
  detail(
    request: MemoryInspectionDetailRequest,
  ): Promise<MemoryInspectionDetailResult>;
  manageAsUser(
    input: ManageMemoryToolInput,
    context: Omit<MemoryInspectionMutationContext, "scope">,
  ): Promise<{
    result: ManageMemoryResult;
    health: MemoryHealthSnapshot;
  }>;
  clearScope(request: MemoryInspectionMutationContext): Promise<{
    result: ClearMemoryScopeResult;
    health: MemoryHealthSnapshot;
  }>;
  exportArchive(request: {
    scope: MemoryToolScope;
    projectId?: string;
  }): Promise<{
    archive: MemoryArchiveV1;
    health: MemoryHealthSnapshot;
  }>;
  importArchive(
    archive: MemoryArchiveV1,
    context: MemoryInspectionMutationContext,
  ): Promise<{
    result: ImportMemoryArchiveResult;
    health: MemoryHealthSnapshot;
  }>;
}

export interface MemoryPanelSnapshot {
  records: MemoryRecord[];
  total: number;
  events: MemoryAuditEvent[];
  selected?: MemoryRecordDetail | null;
  health: MemoryHealthSnapshot;
}
