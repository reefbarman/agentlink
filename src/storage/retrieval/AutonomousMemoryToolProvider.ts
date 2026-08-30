import { AutonomousMemoryService } from "../../core/memory/AutonomousMemoryService.js";
import type {
  ImportMemoryRecordsRequest,
  ManageMemoryRequest,
  MemoryArchiveV1,
  MemoryHealthSnapshot,
  MemoryImportCheckpoint,
  MemoryProvenance,
  MemoryScope,
  RecordMemoryImportFailureRequest,
} from "@agentlink/protocol/autonomous-memory";
import type {
  MemoryInspectionProvider,
  MemoryToolProvider,
} from "../../core/capabilities/memory.js";
import type {
  ManageMemoryToolRequest,
  MemoryActivityRequest,
  MemoryInspectionDetailRequest,
  MemoryInspectionMutationContext,
  MemoryInspectionQueryRequest,
  MemoryToolScope,
  RecallMemoryToolRequest,
} from "@agentlink/protocol/autonomous-memory";
import { sameMemoryScope } from "../../core/memory/memoryPolicy.js";
import { LanceDbMemoryRepository } from "./LanceDbMemoryRepository.js";

export type AutonomousMemoryMode = "off" | "autonomous";

export interface AutonomousMemoryModeSnapshot {
  mode: AutonomousMemoryMode;
  reason?: "config_invalid" | "config_unreadable";
}

export interface AutonomousMemoryToolProviderOptions {
  root: string;
  getMode: () =>
    | AutonomousMemoryMode
    | AutonomousMemoryModeSnapshot
    | Promise<AutonomousMemoryMode | AutonomousMemoryModeSnapshot>;
  isInitializing?: () => boolean;
}

export class AutonomousMemoryToolProvider
  implements MemoryToolProvider, MemoryInspectionProvider
{
  private readonly repository: LanceDbMemoryRepository;
  private readonly service: AutonomousMemoryService;

  constructor(private readonly options: AutonomousMemoryToolProviderOptions) {
    this.repository = new LanceDbMemoryRepository({ root: options.root });
    this.service = new AutonomousMemoryService(this.repository);
  }

  async importRecords(request: ImportMemoryRecordsRequest) {
    await this.assertModeEnabled();
    return await this.service.importRecords(request);
  }

  async recordImportFailure(request: RecordMemoryImportFailureRequest) {
    await this.assertModeEnabled();
    return await this.service.recordImportFailure(request);
  }

  async manage(request: ManageMemoryToolRequest) {
    await this.assertReady();
    const result = await this.service.manage({
      operation: request.input.operation,
      scope: resolveScope(request.input.scope, request.context.projectId),
      provenance: provenance(request),
      ...(request.input.kind ? { kind: request.input.kind } : {}),
      ...(request.input.statement
        ? { statement: request.input.statement }
        : {}),
      ...(request.input.target_id ? { targetId: request.input.target_id } : {}),
      ...(request.input.conflict_key
        ? { conflictKey: request.input.conflict_key }
        : {}),
      ...(request.input.confidence !== undefined
        ? { confidence: request.input.confidence }
        : {}),
      ...(request.input.expires_at
        ? { expiresAt: request.input.expires_at }
        : {}),
      ...(request.input.expected_revision !== undefined
        ? { expectedRevision: request.input.expected_revision }
        : {}),
      ...(request.input.undo_audit_event_id
        ? { undoAuditEventId: request.input.undo_audit_event_id }
        : {}),
    } satisfies ManageMemoryRequest);
    return { result, health: await this.service.health() };
  }

  async recall(request: RecallMemoryToolRequest) {
    return await this.recallWithPolicy(request, false);
  }

  async recallAutomatically(request: RecallMemoryToolRequest) {
    return await this.recallWithPolicy(
      {
        ...request,
        input: {
          ...request.input,
          limit: Math.min(request.input.limit ?? 8, 8),
        },
      },
      true,
    );
  }

  async health(): Promise<MemoryHealthSnapshot> {
    const mode = await this.getModeSnapshot();
    if (mode.mode !== "autonomous") {
      return unavailableHealth(mode.reason ?? "disabled");
    }
    if (this.options.isInitializing?.()) {
      return unavailableHealth(
        "Autonomous memory is unavailable while legacy memory migration is running.",
      );
    }
    try {
      await this.assertReady();
      const health = await this.service.health();
      const blocked = latestBlockedImport(
        await this.repository.listImportCheckpoints(),
      );
      return blocked
        ? { ...health, status: "degraded", reason: "migration_blocked" }
        : health;
    } catch (error) {
      const base = await this.service.health().catch(() => undefined);
      return unavailableHealth(
        error instanceof Error ? error.message : String(error),
        base,
      );
    }
  }

  async activity(request: MemoryActivityRequest) {
    await this.assertReady();
    const limit = request.limit ?? 50;
    if (!Number.isInteger(limit) || limit <= 0 || limit > 200) {
      throw new Error("Memory activity limit must be an integer from 1 to 200");
    }
    const scope = resolveScope(request.scope, request.projectId);
    const events = (await this.service.listAudit())
      .filter((event) => sameMemoryScope(event.scope, scope))
      .sort(
        (left, right) =>
          right.occurredAt.localeCompare(left.occurredAt) ||
          right.id.localeCompare(left.id),
      )
      .slice(0, limit);
    return { events, health: await this.service.health() };
  }

  async query(request: MemoryInspectionQueryRequest) {
    await this.assertReady();
    const result = await this.service.query({
      scopes: recallScopes(request.scope, request.projectId),
      ...(request.query ? { query: request.query } : {}),
      ...(request.kinds ? { kinds: request.kinds } : {}),
      ...(request.statuses ? { statuses: request.statuses } : {}),
      ...(request.sources ? { sources: request.sources } : {}),
      ...(request.limit !== undefined ? { limit: request.limit } : {}),
    });
    return { result, health: await this.service.health() };
  }

  async detail(request: MemoryInspectionDetailRequest) {
    await this.assertReady();
    const detail = await this.service.detail(request.recordId);
    const scope = resolveScope(request.scope, request.projectId);
    return {
      detail:
        detail && sameMemoryScope(detail.record.scope, scope) ? detail : null,
      health: await this.service.health(),
    };
  }

  async manageAsUser(
    input: ManageMemoryToolRequest["input"],
    context: Omit<MemoryInspectionMutationContext, "scope">,
  ) {
    await this.assertReady();
    const result = await this.service.manage({
      operation: input.operation,
      scope: resolveScope(input.scope, context.projectId),
      provenance: userProvenance(context),
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.statement ? { statement: input.statement } : {}),
      ...(input.target_id ? { targetId: input.target_id } : {}),
      ...(input.conflict_key ? { conflictKey: input.conflict_key } : {}),
      ...(input.confidence !== undefined
        ? { confidence: input.confidence }
        : {}),
      ...(input.expires_at ? { expiresAt: input.expires_at } : {}),
      ...(input.expected_revision !== undefined
        ? { expectedRevision: input.expected_revision }
        : {}),
      ...(input.undo_audit_event_id
        ? { undoAuditEventId: input.undo_audit_event_id }
        : {}),
    });
    return { result, health: await this.service.health() };
  }

  async clearScope(request: MemoryInspectionMutationContext) {
    await this.assertReady();
    const result = await this.service.clearScope({
      scope: resolveScope(request.scope, request.projectId),
      provenance: userProvenance(request),
    });
    return { result, health: await this.service.health() };
  }

  async exportArchive(request: { scope: MemoryToolScope; projectId?: string }) {
    await this.assertReady();
    const archive = await this.service.exportArchive(
      resolveScope(request.scope, request.projectId),
    );
    return { archive, health: await this.service.health() };
  }

  async importArchive(
    archive: MemoryArchiveV1,
    context: MemoryInspectionMutationContext,
  ) {
    await this.assertReady();
    const result = await this.service.importArchive({
      archive,
      targetScope: resolveScope(context.scope, context.projectId),
      provenance: userProvenance(context),
    });
    return { result, health: await this.service.health() };
  }

  async dispose(): Promise<void> {
    await this.repository.close();
  }

  private async recallWithPolicy(
    request: RecallMemoryToolRequest,
    automatic: boolean,
  ) {
    await this.assertReady();
    const scopes = recallScopes(
      request.input.scope ?? "all",
      request.context.projectId,
    );
    const result = await this.service.recall({
      query: request.input.query,
      scopes,
      ...(request.input.limit !== undefined
        ? { limit: request.input.limit }
        : {}),
      ...(request.input.minimum_score !== undefined
        ? { minimumScore: request.input.minimum_score }
        : {}),
      automatic,
    });
    return { result, health: await this.service.health() };
  }

  private async assertModeEnabled(): Promise<void> {
    const mode = await this.getModeSnapshot();
    if (mode.mode !== "autonomous") {
      throw new Error(
        mode.reason ??
          'Autonomous memory is disabled. Set agentlink.memory.mode to "autonomous".',
      );
    }
  }

  private async getModeSnapshot(): Promise<AutonomousMemoryModeSnapshot> {
    const mode = await this.options.getMode();
    return typeof mode === "string" ? { mode } : mode;
  }

  private async assertReady(): Promise<void> {
    await this.assertModeEnabled();
    if (this.options.isInitializing?.()) {
      throw new Error(
        "Autonomous memory is unavailable while legacy memory migration is running.",
      );
    }
  }
}

function unavailableHealth(
  reason: string,
  base?: MemoryHealthSnapshot,
): MemoryHealthSnapshot {
  return {
    status: "unavailable",
    retrieval: "unavailable",
    crud: false,
    dedupe: false,
    conflict: false,
    auditUndo: false,
    recordCount: base?.recordCount ?? 0,
    activeRecordCount: base?.activeRecordCount ?? 0,
    auditEventCount: base?.auditEventCount ?? 0,
    reason,
  };
}

function latestBlockedImport(
  checkpoints: MemoryImportCheckpoint[],
): MemoryImportCheckpoint | undefined {
  const latestBySource = new Map<string, MemoryImportCheckpoint>();
  for (const checkpoint of checkpoints) {
    const current = latestBySource.get(checkpoint.sourceKey);
    if (
      !current ||
      checkpoint.updatedAt > current.updatedAt ||
      (checkpoint.updatedAt === current.updatedAt && checkpoint.id > current.id)
    ) {
      latestBySource.set(checkpoint.sourceKey, checkpoint);
    }
  }
  return [...latestBySource.values()].find(
    (checkpoint) => checkpoint.status !== "complete",
  );
}

function provenance(request: ManageMemoryToolRequest): MemoryProvenance {
  return {
    source: request.context.isBackground
      ? "background_agent"
      : "foreground_agent",
    observedAt: request.context.observedAt,
    sessionId: request.context.sessionId,
    agentId: request.context.isBackground
      ? `background:${request.context.sessionId}`
      : `foreground:${request.context.sessionId}`,
    evidence: request.input.source_evidence,
  };
}

function userProvenance(
  context: Omit<MemoryInspectionMutationContext, "scope">,
): MemoryProvenance {
  return {
    source: "current_user",
    observedAt: context.observedAt,
    evidence: context.evidence,
  };
}

function resolveScope(scope: MemoryToolScope, projectId?: string): MemoryScope {
  if (scope === "global") return { kind: "global", id: "agentlink-user" };
  if (!projectId) {
    throw new Error("Project-scoped memory requires an active project");
  }
  return { kind: "workspace", id: projectId };
}

function recallScopes(
  scope: MemoryToolScope | "all",
  projectId?: string,
): MemoryScope[] {
  if (scope === "global") return [resolveScope("global", projectId)];
  if (scope === "project") return [resolveScope("project", projectId)];
  return projectId
    ? [resolveScope("project", projectId), resolveScope("global", projectId)]
    : [resolveScope("global", projectId)];
}
