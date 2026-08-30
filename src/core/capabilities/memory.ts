import type {
  ClearMemoryScopeResult,
  ImportMemoryArchiveResult,
  ManageMemoryResult,
  ManageMemoryToolInput,
  ManageMemoryToolRequest,
  MemoryActivityRequest,
  MemoryArchiveV1,
  MemoryAuditEvent,
  MemoryHealthSnapshot,
  MemoryInspectionDetailRequest,
  MemoryInspectionDetailResult,
  MemoryInspectionMutationContext,
  MemoryInspectionQueryRequest,
  MemoryToolScope,
  QueryMemoryResult,
  RecallMemoryResult,
  RecallMemoryToolRequest,
} from "@agentlink/protocol/autonomous-memory";

export type {
  AutomaticMemoryContext,
  ManageMemoryToolInput,
  ManageMemoryToolRequest,
  MemoryActivityRequest,
  MemoryInspectionDetailRequest,
  MemoryInspectionDetailResult,
  MemoryInspectionMutationContext,
  MemoryInspectionQueryRequest,
  MemoryPanelSnapshot,
  MemoryToolExecutionContext,
  MemoryToolScope,
  RecallMemoryToolInput,
  RecallMemoryToolRequest,
} from "@agentlink/protocol/autonomous-memory";

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
