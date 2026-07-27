import type {
  AutonomousMemoryServiceOptions,
  ClearMemoryScopeRequest,
  ClearMemoryScopeResult,
  ImportMemoryArchiveRequest,
  ImportMemoryArchiveResult,
  ImportMemoryRecordsRequest,
  ImportMemoryRecordsResult,
  ManageMemoryRequest,
  ManageMemoryResult,
  MemoryArchiveV1,
  MemoryAuditChange,
  MemoryAuditEvent,
  MemoryDisposition,
  MemoryImportCheckpoint,
  MemoryRecord,
  MemoryRecordDetail,
  MemoryRepository,
  MemoryRepositoryTransaction,
  MemoryRevision,
  MemoryScope,
  MemoryStoreSnapshot,
  QueryMemoryRequest,
  QueryMemoryResult,
  RecallMemoryRequest,
  RecallMemoryResult,
  RecordMemoryImportFailureRequest,
} from "./contracts.js";
import {
  memoryAuthority,
  memoryIsExpired,
  memoryStatementsAgree,
  normalizeMemoryStatement,
  recordAuthority,
  renderMemoryEvidence,
  sameMemoryScope,
  scanMemoryText,
} from "./memoryPolicy.js";

const DEFAULT_MAX_STATEMENT_CHARS = 1_000;
const DEFAULT_MAX_RECORDS_PER_SCOPE = 500;
const MEMORY_KINDS = new Set([
  "preference",
  "project_fact",
  "gotcha",
  "decision",
  "workflow_hint",
  "correction",
]);
const MEMORY_STATUSES = new Set([
  "active",
  "superseded",
  "contested",
  "forgotten",
  "expired",
]);
const MEMORY_PROVENANCE_SOURCES = new Set([
  "current_user",
  "repository",
  "foreground_agent",
  "background_agent",
  "import",
]);
const MEMORY_SCOPE_KINDS = new Set(["global", "workspace", "session"]);
const MEMORY_ARCHIVE_WARNING =
  "This export may contain sensitive user or project context. Tombstones and storage compaction do not guarantee secure erasure from backups or storage fragments.";
let generatedId = 0;

export class AutonomousMemoryService {
  private readonly now: () => Date;
  private readonly createId: (kind: "record" | "audit") => string;
  private readonly maxStatementChars: number;
  private readonly maxRecordsPerScope: number;

  constructor(
    private readonly repository: MemoryRepository,
    options: AutonomousMemoryServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.createId =
      options.createId ??
      ((kind) => `memory-${kind}-${Date.now()}-${++generatedId}`);
    this.maxStatementChars =
      options.maxStatementChars ?? DEFAULT_MAX_STATEMENT_CHARS;
    this.maxRecordsPerScope =
      options.maxRecordsPerScope ?? DEFAULT_MAX_RECORDS_PER_SCOPE;
  }

  async manage(request: ManageMemoryRequest): Promise<ManageMemoryResult> {
    validateManageRequest(request);
    return await this.repository.transaction(async (transaction) => {
      const statement = request.statement
        ? normalizeMemoryStatement(request.statement)
        : undefined;
      const sensitiveText = [
        request.statement,
        request.provenance.evidence,
      ].filter((value): value is string => value !== undefined);
      for (const candidate of sensitiveText) {
        const normalized = normalizeMemoryStatement(candidate);
        const rawScan = scanMemoryText(candidate);
        const normalizedScan = scanMemoryText(normalized);
        const scan = rawScan.safe ? normalizedScan : rawScan;
        if (!scan.safe) {
          return await this.reject(
            transaction,
            request,
            "rejected-sensitive",
            "sensitive",
            candidate.length,
            scan.finding,
          );
        }
      }
      if (request.operation === "undo") {
        return await this.undo(transaction, request);
      }
      if (statement !== undefined) {
        if (statement.length > this.maxStatementChars) {
          return await this.reject(
            transaction,
            request,
            "rejected-quota",
            "record-length",
            statement.length,
          );
        }
      }

      switch (request.operation) {
        case "remember":
          return await this.remember(transaction, request, statement!);
        case "update":
          return await this.update(transaction, request, statement!);
        case "supersede":
          return await this.supersede(transaction, request, statement!);
        case "forget":
          return await this.changeStatus(transaction, request, "forgotten");
        case "restore":
          return await this.changeStatus(transaction, request, "active");
      }
    });
  }

  async importRecords(
    request: ImportMemoryRecordsRequest,
  ): Promise<ImportMemoryRecordsResult> {
    this.validateImportIdentity(request);
    const existing = await this.repository.getImportCheckpoint(
      request.checkpointId,
    );
    if (existing?.status === "complete") {
      return { status: "already-complete", checkpoint: existing, results: [] };
    }

    const startedAt = this.now().toISOString();
    const pending: MemoryImportCheckpoint = {
      id: request.checkpointId,
      sourceKey: request.sourceKey,
      sourceRevision: request.sourceRevision,
      importerSchemaVersion: request.importerSchemaVersion,
      status: "pending",
      startedAt: existing?.startedAt ?? startedAt,
      updatedAt: startedAt,
    };
    await this.repository.transaction(async (transaction) => {
      const current = await transaction.getImportCheckpoint(
        request.checkpointId,
      );
      if (current?.status === "complete") return;
      await transaction.putImportCheckpoint(pending);
    });

    try {
      this.validateImportCandidates(request);
      return await this.repository.transaction(async (transaction) => {
        const current = await transaction.getImportCheckpoint(
          request.checkpointId,
        );
        if (current?.status === "complete") {
          return {
            status: "already-complete" as const,
            checkpoint: current,
            results: [],
          };
        }
        const snapshot = await this.createImportSnapshot(transaction, request);
        await transaction.putSnapshot(snapshot);

        const results: ManageMemoryResult[] = [];
        const importedRecordIds: string[] = [];
        for (const candidate of request.records) {
          const result = await this.remember(
            transaction,
            {
              operation: "remember",
              scope: candidate.scope,
              provenance: candidate.provenance,
              recordId: candidate.id,
              bypassScopeQuota: true,
              statement: candidate.statement,
              kind: candidate.kind,
              ...(candidate.conflictKey
                ? { conflictKey: candidate.conflictKey }
                : {}),
              ...(candidate.confidence === undefined
                ? {}
                : { confidence: candidate.confidence }),
              ...(candidate.expiresAt
                ? { expiresAt: candidate.expiresAt }
                : {}),
            },
            normalizeMemoryStatement(candidate.statement),
          );
          if (
            result.disposition === "rejected-sensitive" ||
            result.disposition === "rejected-quota"
          ) {
            throw new MemoryImportError(
              result.disposition,
              `Legacy memory import was ${result.disposition}`,
            );
          }
          results.push(result);
          if (await transaction.get(candidate.id)) {
            importedRecordIds.push(candidate.id);
          }
        }

        const completedAt = this.now().toISOString();
        const checkpoint: MemoryImportCheckpoint = {
          ...pending,
          status: "complete",
          updatedAt: completedAt,
          completedAt,
          snapshotId: snapshot.id,
          auditEventIds: results.map((result) => result.auditEventId),
          importedRecordIds: [...new Set(importedRecordIds)].sort(),
        };
        await transaction.putImportCheckpoint(checkpoint);
        return { status: "imported" as const, checkpoint, results };
      });
    } catch (error) {
      const failedAt = this.now().toISOString();
      const failure = importFailure(error);
      const failed: MemoryImportCheckpoint = {
        ...pending,
        status: "failed",
        updatedAt: failedAt,
        failedAt,
        error: failure,
      };
      await this.repository.transaction(async (transaction) => {
        const current = await transaction.getImportCheckpoint(
          request.checkpointId,
        );
        if (current?.status !== "complete") {
          await transaction.putImportCheckpoint(failed);
        }
      });
      throw error;
    }
  }

  async recordImportFailure(
    request: RecordMemoryImportFailureRequest,
  ): Promise<MemoryImportCheckpoint> {
    if (
      !request.checkpointId.trim() ||
      !request.sourceKey.trim() ||
      !request.sourceRevision.trim() ||
      !request.error.code.trim() ||
      !request.error.message.trim()
    ) {
      throw new Error("Legacy memory import failure metadata is incomplete");
    }
    if (
      !Number.isInteger(request.importerSchemaVersion) ||
      request.importerSchemaVersion <= 0
    ) {
      throw new Error("Legacy memory importer schema version must be positive");
    }
    const failedAt = this.now().toISOString();
    return await this.repository.transaction(async (transaction) => {
      const current = await transaction.getImportCheckpoint(
        request.checkpointId,
      );
      if (current?.status === "complete") return current;
      const checkpoint: MemoryImportCheckpoint = {
        id: request.checkpointId,
        sourceKey: request.sourceKey,
        sourceRevision: request.sourceRevision,
        importerSchemaVersion: request.importerSchemaVersion,
        status: "failed",
        startedAt: current?.startedAt ?? request.startedAt,
        updatedAt: failedAt,
        failedAt,
        error: request.error,
      };
      await transaction.putImportCheckpoint(checkpoint);
      return checkpoint;
    });
  }

  async recall(request: RecallMemoryRequest): Promise<RecallMemoryResult> {
    const limit = request.limit ?? 10;
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error("Memory recall limit must be a positive integer");
    }
    if (request.scopes.length === 0) {
      throw new Error("Memory recall requires at least one scope");
    }
    const minimumScore = request.minimumScore ?? 0.2;
    const now = this.now();
    const candidates = await this.repository.searchLexical({
      text: normalizeMemoryStatement(request.query),
      scopes: request.scopes,
      limit: Math.max(limit * 4, 20),
    });
    const memories = candidates
      .filter(
        (candidate) =>
          candidate.score >= minimumScore &&
          candidate.record.status === "active" &&
          !memoryIsExpired(candidate.record, now),
      )
      .slice(0, limit)
      .map((candidate) => ({
        record: candidate.record,
        score: candidate.score,
        rendering: renderMemoryEvidence(candidate.record),
        authority: "low-authority-evidence" as const,
        canAuthorizeTools: false as const,
      }));
    const health = await this.repository.health();
    return {
      memories,
      mode: health.retrieval === "hybrid" ? "hybrid" : "lexical-only",
    };
  }

  async query(request: QueryMemoryRequest): Promise<QueryMemoryResult> {
    if (request.scopes.length === 0) {
      throw new Error("Memory query requires at least one scope");
    }
    const limit = request.limit ?? 50;
    if (!Number.isInteger(limit) || limit <= 0 || limit > 200) {
      throw new Error("Memory query limit must be an integer from 1 to 200");
    }

    const query = request.query?.trim();
    const candidates = query
      ? (
          await this.repository.searchLexical({
            text: normalizeMemoryStatement(query),
            scopes: request.scopes,
            limit: 200,
          })
        ).map((candidate) => candidate.record)
      : (
          await Promise.all(
            request.scopes.map((scope) => this.repository.list(scope)),
          )
        ).flat();
    const records = candidates
      .filter((record) =>
        request.kinds?.length ? request.kinds.includes(record.kind) : true,
      )
      .filter((record) =>
        request.statuses?.length
          ? request.statuses.includes(record.status)
          : true,
      )
      .filter((record) =>
        request.sources?.length
          ? record.provenance.some((item) =>
              request.sources!.includes(item.source),
            )
          : true,
      )
      .sort(
        (left, right) =>
          right.updatedAt.localeCompare(left.updatedAt) ||
          left.id.localeCompare(right.id),
      );
    return { records: records.slice(0, limit), total: records.length };
  }

  async detail(recordId: string): Promise<MemoryRecordDetail | null> {
    const record = await this.repository.get(recordId);
    if (!record) return null;
    const [revisions, audit] = await Promise.all([
      this.repository.listRevisions(recordId),
      this.repository.listAudit(recordId),
    ]);
    return { record, revisions, audit };
  }

  async inspect(recordId: string): Promise<MemoryRecord | null> {
    return await this.repository.get(recordId);
  }

  async listRevisions(recordId: string): Promise<MemoryRevision[]> {
    return await this.repository.listRevisions(recordId);
  }

  async listAudit(recordId?: string): Promise<MemoryAuditEvent[]> {
    return await this.repository.listAudit(recordId);
  }

  async clearScope(
    request: ClearMemoryScopeRequest,
  ): Promise<ClearMemoryScopeResult> {
    validateProvenance(request.scope, request.provenance);
    return await this.repository.transaction(async (transaction) => {
      const occurredAt = this.now().toISOString();
      const changes: MemoryAuditChange[] = (
        await transaction.list(request.scope)
      )
        .filter((record) => record.status !== "forgotten")
        .map((record) => ({
          recordId: record.id,
          before: record,
          after: {
            ...record,
            revision: record.revision + 1,
            status: "forgotten" as const,
            forgottenAt: occurredAt,
            updatedAt: occurredAt,
          },
        }));
      for (const change of changes) {
        await transaction.put(change.after!);
        await transaction.appendRevision({
          recordId: change.recordId,
          revision: change.after!.revision,
          recordedAt: occurredAt,
          record: change.after!,
        });
      }
      const auditEventId = this.createId("audit");
      await transaction.appendAudit({
        id: auditEventId,
        operation: "clear",
        disposition: "cleared",
        occurredAt,
        actor: request.provenance,
        scope: request.scope,
        changes,
      });
      return { clearedCount: changes.length, auditEventId };
    });
  }

  async exportArchive(scope: MemoryScope): Promise<MemoryArchiveV1> {
    if (!scope.id.trim()) throw new Error("Memory scope ID is required");
    return {
      schema: "agentlink-memory",
      version: 1,
      archiveId: `memory-archive-${Date.now()}-${++generatedId}`,
      exportedAt: this.now().toISOString(),
      scope: clone(scope),
      records: await this.repository.list(scope),
      warning: MEMORY_ARCHIVE_WARNING,
    };
  }

  async importArchive(
    request: ImportMemoryArchiveRequest,
  ): Promise<ImportMemoryArchiveResult> {
    validateProvenance(request.targetScope, request.provenance);
    validateArchive(
      request.archive,
      this.maxStatementChars,
      this.maxRecordsPerScope,
    );
    const checkpointId = `archive:${request.archive.archiveId}:${request.targetScope.kind}:${request.targetScope.id}`;
    const existing = await this.repository.getImportCheckpoint(checkpointId);
    if (existing?.status === "complete") {
      return {
        importedCount: 0,
        skippedCount: request.archive.records.length,
        snapshotId: existing.snapshotId!,
        auditEventId: existing.auditEventIds?.[0] ?? "",
      };
    }

    return await this.repository.transaction(async (transaction) => {
      const checkpoint = await transaction.getImportCheckpoint(checkpointId);
      if (checkpoint?.status === "complete") {
        return {
          importedCount: 0,
          skippedCount: request.archive.records.length,
          snapshotId: checkpoint.snapshotId!,
          auditEventId: checkpoint.auditEventIds?.[0] ?? "",
        };
      }

      const occurredAt = this.now().toISOString();
      const snapshotId = `memory-snapshot-${Date.now()}-${++generatedId}`;
      const existingRecords = await transaction.list();
      await transaction.putSnapshot({
        id: snapshotId,
        tag: `pre-user-import:${request.archive.archiveId}`,
        createdAt: occurredAt,
        records: existingRecords,
        revisions: (
          await Promise.all(
            existingRecords.map((record) =>
              transaction.listRevisions(record.id),
            ),
          )
        ).flat(),
        audits: await transaction.listAudit(),
        importCheckpoints: await transaction.listImportCheckpoints(),
      });

      const changes: MemoryAuditChange[] = [];
      let skippedCount = 0;
      for (const archived of request.archive.records) {
        const duplicate = existingRecords.find(
          (record) =>
            sameMemoryScope(record.scope, request.targetScope) &&
            normalizeMemoryStatement(record.statement) ===
              normalizeMemoryStatement(archived.statement) &&
            record.kind === archived.kind &&
            record.status === archived.status,
        );
        if (duplicate) {
          skippedCount += 1;
          continue;
        }
        const occupied = await transaction.get(archived.id);
        const record: MemoryRecord = {
          id: occupied ? this.createId("record") : archived.id,
          revision: 1,
          scope: clone(request.targetScope),
          kind: archived.kind,
          statement: archived.statement,
          ...(archived.conflictKey
            ? { conflictKey: archived.conflictKey }
            : {}),
          confidence: archived.confidence,
          status: archived.status,
          provenance: mergeProvenance(
            clone(archived.provenance),
            request.provenance,
          ),
          createdAt: archived.createdAt,
          updatedAt: occurredAt,
          observedAt: archived.observedAt,
          ...(archived.expiresAt ? { expiresAt: archived.expiresAt } : {}),
          ...(archived.supersededBy
            ? { supersededBy: archived.supersededBy }
            : {}),
          ...(archived.forgottenAt
            ? { forgottenAt: archived.forgottenAt }
            : {}),
        };
        await transaction.put(record);
        await transaction.appendRevision({
          recordId: record.id,
          revision: record.revision,
          recordedAt: occurredAt,
          record,
        });
        changes.push({ recordId: record.id, before: null, after: record });
      }

      const auditEventId = this.createId("audit");
      await transaction.appendAudit({
        id: auditEventId,
        operation: "import",
        disposition: "imported",
        occurredAt,
        actor: request.provenance,
        scope: request.targetScope,
        changes,
      });
      await transaction.putImportCheckpoint({
        id: checkpointId,
        sourceKey: `archive:${request.archive.archiveId}`,
        sourceRevision: `${request.archive.schema}@${request.archive.version}`,
        importerSchemaVersion: 1,
        status: "complete",
        startedAt: occurredAt,
        updatedAt: occurredAt,
        completedAt: occurredAt,
        snapshotId,
        auditEventIds: [auditEventId],
        importedRecordIds: changes.map((change) => change.recordId),
      });
      return {
        importedCount: changes.length,
        skippedCount,
        snapshotId,
        auditEventId,
      };
    });
  }

  async health() {
    return await this.repository.health();
  }

  private validateImportIdentity(request: ImportMemoryRecordsRequest): void {
    if (!request.checkpointId.trim()) {
      throw new Error("Legacy memory import checkpoint ID is required");
    }
    if (!request.snapshotId.trim() || !request.snapshotTag.trim()) {
      throw new Error("Legacy memory import snapshot identity is required");
    }
    if (!request.sourceKey.trim() || !request.sourceRevision.trim()) {
      throw new Error("Legacy memory import source identity is required");
    }
    if (
      !Number.isInteger(request.importerSchemaVersion) ||
      request.importerSchemaVersion <= 0
    ) {
      throw new Error("Legacy memory importer schema version must be positive");
    }
  }

  private validateImportCandidates(request: ImportMemoryRecordsRequest): void {
    const ids = new Set<string>();
    for (const candidate of request.records) {
      if (!candidate.id.trim() || ids.has(candidate.id)) {
        throw new MemoryImportError(
          "invalid-record-id",
          `Invalid or duplicate imported memory ID: ${candidate.id}`,
        );
      }
      ids.add(candidate.id);
      if (!candidate.scope.id.trim() || !candidate.statement.trim()) {
        throw new MemoryImportError(
          "incomplete-record",
          `Imported memory ${candidate.id} is incomplete`,
        );
      }
      if (candidate.statement.length > this.maxStatementChars) {
        throw new MemoryImportError(
          "record-length",
          `Imported memory ${candidate.id} exceeds the record limit`,
        );
      }
      for (const text of [candidate.statement, candidate.provenance.evidence]) {
        if (text === undefined) continue;
        const scan = scanMemoryText(text);
        if (!scan.safe) {
          throw new MemoryImportError(
            "sensitive-content",
            `Imported memory ${candidate.id} contains sensitive content: ${scan.finding}`,
          );
        }
      }
      normalizeConfidence(candidate.confidence, candidate.provenance.source);
    }
  }

  private async createImportSnapshot(
    transaction: MemoryRepositoryTransaction,
    request: ImportMemoryRecordsRequest,
  ): Promise<MemoryStoreSnapshot> {
    const records = await transaction.list();
    const revisions = (
      await Promise.all(
        records.map((record) => transaction.listRevisions(record.id)),
      )
    ).flat();
    return {
      id: request.snapshotId,
      tag: request.snapshotTag,
      createdAt: this.now().toISOString(),
      records,
      revisions,
      audits: await transaction.listAudit(),
      importCheckpoints: (await transaction.listImportCheckpoints()).filter(
        (checkpoint) => checkpoint.id !== request.checkpointId,
      ),
    };
  }

  private async remember(
    transaction: MemoryRepositoryTransaction,
    request: ManageMemoryRequest,
    statement: string,
  ): Promise<ManageMemoryResult> {
    const now = this.now().toISOString();
    const scopeRecords = await transaction.list(request.scope);
    const candidates = request.conflictKey
      ? scopeRecords.filter(
          (record) =>
            record.conflictKey === request.conflictKey &&
            record.status !== "forgotten" &&
            record.status !== "expired",
        )
      : (
          await transaction.searchLexical({
            text: statement,
            scopes: [request.scope],
            limit: 5,
          })
        )
          .filter((candidate) => candidate.score >= 0.72)
          .map((candidate) => candidate.record)
          .filter(
            (record) =>
              record.status !== "forgotten" && record.status !== "expired",
          );

    const sameFact = candidates.find((record) =>
      memoryStatementsAgree(record.statement, statement),
    );
    if (sameFact) {
      const before = clone(sameFact);
      const after: MemoryRecord = {
        ...sameFact,
        revision: sameFact.revision + 1,
        confidence: Math.max(
          sameFact.confidence,
          normalizeConfidence(request.confidence, request.provenance.source),
        ),
        provenance: mergeProvenance(sameFact.provenance, request.provenance),
        observedAt: request.provenance.observedAt,
        updatedAt: now,
      };
      return await this.commit(
        transaction,
        request,
        "same-fact",
        [{ recordId: after.id, before, after }],
        after,
        [],
      );
    }

    const incomingAuthority = memoryAuthority(request.provenance.source);
    const highestExistingAuthority = Math.max(
      0,
      ...candidates.map(recordAuthority),
    );
    const id = request.recordId ?? this.createId("record");
    const incoming = createRecord(id, request, statement, now);

    if (candidates.length === 0) {
      const recordCount = scopeRecords.filter(
        (record) => record.status !== "forgotten",
      ).length;
      if (!request.bypassScopeQuota && recordCount >= this.maxRecordsPerScope) {
        return await this.reject(
          transaction,
          request,
          "rejected-quota",
          "scope-quota",
          statement.length,
        );
      }
      return await this.commit(
        transaction,
        request,
        "created",
        [{ recordId: incoming.id, before: null, after: incoming }],
        incoming,
        [],
      );
    }

    if (incomingAuthority > highestExistingAuthority) {
      const changes: MemoryAuditChange[] = candidates.map((record) => ({
        recordId: record.id,
        before: clone(record),
        after: {
          ...record,
          revision: record.revision + 1,
          status: "superseded",
          supersededBy: incoming.id,
          updatedAt: now,
        },
      }));
      changes.push({ recordId: incoming.id, before: null, after: incoming });
      return await this.commit(
        transaction,
        request,
        "superseded",
        changes,
        incoming,
        changes.slice(0, -1).map((change) => change.after!),
      );
    }

    if (incomingAuthority < highestExistingAuthority) {
      const authoritative = candidates
        .filter(
          (record) => recordAuthority(record) === highestExistingAuthority,
        )
        .sort((left, right) => left.id.localeCompare(right.id))[0]!;
      const superseded: MemoryRecord = {
        ...incoming,
        status: "superseded",
        supersededBy: authoritative.id,
      };
      return await this.commit(
        transaction,
        request,
        "superseded",
        [{ recordId: superseded.id, before: null, after: superseded }],
        authoritative,
        [superseded],
      );
    }

    incoming.status = "contested";
    const changes: MemoryAuditChange[] = candidates.map((record) => ({
      recordId: record.id,
      before: clone(record),
      after: {
        ...record,
        revision: record.revision + 1,
        status: "contested",
        updatedAt: now,
      },
    }));
    changes.push({ recordId: incoming.id, before: null, after: incoming });
    return await this.commit(
      transaction,
      request,
      "contested",
      changes,
      incoming,
      changes.slice(0, -1).map((change) => change.after!),
    );
  }

  private async update(
    transaction: MemoryRepositoryTransaction,
    request: ManageMemoryRequest,
    statement: string,
  ): Promise<ManageMemoryResult> {
    const current = await transaction.get(request.targetId!);
    if (!current || !sameMemoryScope(current.scope, request.scope)) {
      return await this.notFound(transaction, request);
    }
    if (
      request.expectedRevision !== undefined &&
      request.expectedRevision !== current.revision
    ) {
      return await this.auditOnly(transaction, request, "stale-revision");
    }
    const now = this.now().toISOString();
    const after: MemoryRecord = {
      ...current,
      revision: current.revision + 1,
      statement,
      kind: request.kind ?? current.kind,
      conflictKey: request.conflictKey ?? current.conflictKey,
      confidence:
        request.confidence === undefined
          ? current.confidence
          : normalizeConfidence(request.confidence, request.provenance.source),
      provenance: mergeProvenance(current.provenance, request.provenance),
      observedAt: request.provenance.observedAt,
      updatedAt: now,
      ...(request.expiresAt ? { expiresAt: request.expiresAt } : {}),
    };
    return await this.commit(
      transaction,
      request,
      "updated",
      [{ recordId: current.id, before: current, after }],
      after,
      [],
    );
  }

  private async supersede(
    transaction: MemoryRepositoryTransaction,
    request: ManageMemoryRequest,
    statement: string,
  ): Promise<ManageMemoryResult> {
    const current = await transaction.get(request.targetId!);
    if (!current || !sameMemoryScope(current.scope, request.scope)) {
      return await this.notFound(transaction, request);
    }
    const now = this.now().toISOString();
    const replacement = createRecord(
      this.createId("record"),
      request,
      statement,
      now,
    );
    const prior: MemoryRecord = {
      ...current,
      revision: current.revision + 1,
      status: "superseded",
      supersededBy: replacement.id,
      updatedAt: now,
    };
    return await this.commit(
      transaction,
      request,
      "superseded",
      [
        { recordId: prior.id, before: current, after: prior },
        { recordId: replacement.id, before: null, after: replacement },
      ],
      replacement,
      [prior],
    );
  }

  private async changeStatus(
    transaction: MemoryRepositoryTransaction,
    request: ManageMemoryRequest,
    status: "forgotten" | "active",
  ): Promise<ManageMemoryResult> {
    const current = await transaction.get(request.targetId!);
    if (!current || !sameMemoryScope(current.scope, request.scope)) {
      return await this.notFound(transaction, request);
    }
    if (
      request.expectedRevision !== undefined &&
      request.expectedRevision !== current.revision
    ) {
      return await this.auditOnly(transaction, request, "stale-revision");
    }
    const now = this.now().toISOString();
    const after: MemoryRecord = {
      ...current,
      revision: current.revision + 1,
      status,
      updatedAt: now,
      ...(status === "forgotten"
        ? { forgottenAt: now }
        : { forgottenAt: undefined }),
    };
    return await this.commit(
      transaction,
      request,
      status === "forgotten" ? "forgotten" : "restored",
      [{ recordId: current.id, before: current, after }],
      after,
      [],
    );
  }

  private async undo(
    transaction: MemoryRepositoryTransaction,
    request: ManageMemoryRequest,
  ): Promise<ManageMemoryResult> {
    const target = await transaction.getAuditEvent(request.undoAuditEventId!);
    if (
      !target ||
      !sameMemoryScope(target.scope, request.scope) ||
      target.changes.length === 0
    ) {
      return await this.notFound(transaction, request);
    }
    const now = this.now().toISOString();
    const changes: MemoryAuditChange[] = [];
    for (const change of [...target.changes].reverse()) {
      const current = await transaction.get(change.recordId);
      if (change.before) {
        const restored: MemoryRecord = {
          ...change.before,
          revision: (current?.revision ?? change.before.revision) + 1,
          updatedAt: now,
        };
        changes.push({
          recordId: change.recordId,
          before: current,
          after: restored,
        });
      } else if (current) {
        const forgotten: MemoryRecord = {
          ...current,
          revision: current.revision + 1,
          status: "forgotten",
          forgottenAt: now,
          updatedAt: now,
        };
        changes.push({
          recordId: change.recordId,
          before: current,
          after: forgotten,
        });
      }
    }
    const primary = changes.find((change) => change.after)?.after ?? undefined;
    return await this.commit(
      transaction,
      request,
      "undone",
      changes,
      primary,
      changes
        .slice(1)
        .flatMap((change) => (change.after ? [change.after] : [])),
      target.id,
    );
  }

  private async commit(
    transaction: MemoryRepositoryTransaction,
    request: ManageMemoryRequest,
    disposition: MemoryDisposition,
    changes: MemoryAuditChange[],
    record: MemoryRecord | undefined,
    relatedRecords: MemoryRecord[],
    undoneAuditEventId?: string,
  ): Promise<ManageMemoryResult> {
    const occurredAt = this.now().toISOString();
    for (const change of changes) {
      if (!change.after) {
        await transaction.delete(change.recordId);
        continue;
      }
      await transaction.put(change.after);
      await transaction.appendRevision({
        recordId: change.after.id,
        revision: change.after.revision,
        recordedAt: occurredAt,
        record: change.after,
      });
    }
    const auditEventId = this.createId("audit");
    await transaction.appendAudit({
      id: auditEventId,
      operation: request.operation,
      disposition,
      occurredAt,
      actor: request.provenance,
      scope: request.scope,
      changes,
      ...(undoneAuditEventId ? { undoneAuditEventId } : {}),
    });
    return {
      disposition,
      ...(record ? { record } : {}),
      relatedRecords,
      auditEventId,
    };
  }

  private async reject(
    transaction: MemoryRepositoryTransaction,
    request: ManageMemoryRequest,
    disposition: "rejected-sensitive" | "rejected-quota",
    reason: "sensitive" | "record-length" | "scope-quota",
    candidateLength: number,
    finding?: string,
  ): Promise<ManageMemoryResult> {
    const auditEventId = this.createId("audit");
    const actor = { ...request.provenance };
    if (reason === "sensitive") delete actor.evidence;
    await transaction.appendAudit({
      id: auditEventId,
      operation: request.operation,
      disposition,
      occurredAt: this.now().toISOString(),
      actor,
      scope: request.scope,
      changes: [],
      rejection: {
        reason,
        ...(finding ? { finding } : {}),
        candidateLength,
      },
    });
    return { disposition, relatedRecords: [], auditEventId };
  }

  private async notFound(
    transaction: MemoryRepositoryTransaction,
    request: ManageMemoryRequest,
  ): Promise<ManageMemoryResult> {
    return await this.auditOnly(transaction, request, "not-found");
  }

  private async auditOnly(
    transaction: MemoryRepositoryTransaction,
    request: ManageMemoryRequest,
    disposition: "not-found" | "stale-revision",
  ): Promise<ManageMemoryResult> {
    const auditEventId = this.createId("audit");
    await transaction.appendAudit({
      id: auditEventId,
      operation: request.operation,
      disposition,
      occurredAt: this.now().toISOString(),
      actor: request.provenance,
      scope: request.scope,
      changes: [],
    });
    return { disposition, relatedRecords: [], auditEventId };
  }
}

function validateManageRequest(request: ManageMemoryRequest): void {
  validateProvenance(request.scope, request.provenance);
  if (
    (request.operation === "remember" ||
      request.operation === "update" ||
      request.operation === "supersede") &&
    !request.statement?.trim()
  ) {
    throw new Error(`${request.operation} requires a memory statement`);
  }
  if (request.operation === "remember" && !request.kind) {
    throw new Error("remember requires a memory kind");
  }
  if (
    (request.operation === "update" ||
      request.operation === "supersede" ||
      request.operation === "forget" ||
      request.operation === "restore") &&
    !request.targetId
  ) {
    throw new Error(`${request.operation} requires targetId`);
  }
  if (request.operation === "undo" && !request.undoAuditEventId) {
    throw new Error("undo requires undoAuditEventId");
  }
}

function validateProvenance(
  scope: ManageMemoryRequest["scope"],
  provenance: ManageMemoryRequest["provenance"],
): void {
  if (!scope.id.trim()) throw new Error("Memory scope ID is required");
  if (!provenance.observedAt) {
    throw new Error("Memory provenance observedAt is required");
  }
}

function validateArchive(
  archive: MemoryArchiveV1,
  maxStatementChars: number,
  maxRecordsPerScope: number,
): void {
  if (
    !isObject(archive) ||
    archive.schema !== "agentlink-memory" ||
    archive.version !== 1 ||
    !isBoundedString(archive.archiveId, 200) ||
    !isBoundedString(archive.exportedAt, 100) ||
    !isMemoryScope(archive.scope) ||
    !Array.isArray(archive.records) ||
    !isBoundedString(archive.warning, 2_000)
  ) {
    throw new Error("Unsupported or invalid memory archive");
  }
  if (archive.records.length > maxRecordsPerScope) {
    throw new Error("Memory archive exceeds the per-scope record limit");
  }
  const ids = new Set<string>();
  for (const value of archive.records) {
    if (!isMemoryRecord(value, maxStatementChars)) {
      throw new Error("Memory archive contains an invalid record");
    }
    if (ids.has(value.id)) {
      throw new Error("Memory archive contains a duplicate record ID");
    }
    ids.add(value.id);
    for (const text of [
      value.statement,
      ...value.provenance.flatMap((item) =>
        item.evidence === undefined ? [] : [item.evidence],
      ),
    ]) {
      const scan = scanMemoryText(text);
      if (!scan.safe) {
        throw new Error(
          `Memory archive contains sensitive content: ${scan.finding}`,
        );
      }
    }
  }
}

function isMemoryRecord(
  value: unknown,
  maxStatementChars: number,
): value is MemoryRecord {
  if (!isObject(value)) return false;
  return (
    isBoundedString(value.id, 200) &&
    Number.isInteger(value.revision) &&
    (value.revision as number) >= 1 &&
    isMemoryScope(value.scope) &&
    typeof value.kind === "string" &&
    MEMORY_KINDS.has(value.kind) &&
    isBoundedString(value.statement, maxStatementChars) &&
    optionalBoundedString(value.conflictKey, 1_000) &&
    typeof value.confidence === "number" &&
    Number.isFinite(value.confidence) &&
    value.confidence >= 0 &&
    value.confidence <= 1 &&
    typeof value.status === "string" &&
    MEMORY_STATUSES.has(value.status) &&
    Array.isArray(value.provenance) &&
    value.provenance.length > 0 &&
    value.provenance.every(isMemoryProvenance) &&
    isBoundedString(value.createdAt, 100) &&
    isBoundedString(value.updatedAt, 100) &&
    isBoundedString(value.observedAt, 100) &&
    optionalBoundedString(value.expiresAt, 100) &&
    optionalBoundedString(value.supersededBy, 200) &&
    optionalBoundedString(value.forgottenAt, 100)
  );
}

function isMemoryScope(value: unknown): value is MemoryScope {
  return (
    isObject(value) &&
    typeof value.kind === "string" &&
    MEMORY_SCOPE_KINDS.has(value.kind) &&
    isBoundedString(value.id, 500)
  );
}

function isMemoryProvenance(value: unknown): boolean {
  return (
    isObject(value) &&
    typeof value.source === "string" &&
    MEMORY_PROVENANCE_SOURCES.has(value.source) &&
    isBoundedString(value.observedAt, 100) &&
    optionalBoundedString(value.sessionId, 200) &&
    optionalBoundedString(value.agentId, 200) &&
    optionalBoundedString(value.evidence, 4_000)
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maxLength
  );
}

function optionalBoundedString(value: unknown, maxLength: number): boolean {
  return value === undefined || isBoundedString(value, maxLength);
}

function createRecord(
  id: string,
  request: ManageMemoryRequest,
  statement: string,
  now: string,
): MemoryRecord {
  return {
    id,
    revision: 1,
    scope: request.scope,
    kind: request.kind!,
    statement,
    ...(request.conflictKey ? { conflictKey: request.conflictKey } : {}),
    confidence: normalizeConfidence(
      request.confidence,
      request.provenance.source,
    ),
    status: "active",
    provenance: [request.provenance],
    createdAt: now,
    updatedAt: now,
    observedAt: request.provenance.observedAt,
    ...(request.expiresAt ? { expiresAt: request.expiresAt } : {}),
  };
}

function normalizeConfidence(
  value: number | undefined,
  source: ManageMemoryRequest["provenance"]["source"],
): number {
  const fallback = source === "background_agent" ? 0.45 : 0.7;
  const confidence = value ?? fallback;
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error("Memory confidence must be between 0 and 1");
  }
  return confidence;
}

function mergeProvenance(
  existing: MemoryRecord["provenance"],
  incoming: MemoryRecord["provenance"][number],
): MemoryRecord["provenance"] {
  const duplicate = existing.some(
    (item) =>
      item.source === incoming.source &&
      item.observedAt === incoming.observedAt &&
      item.sessionId === incoming.sessionId &&
      item.agentId === incoming.agentId &&
      item.evidence === incoming.evidence,
  );
  return duplicate ? existing : [...existing, incoming];
}

class MemoryImportError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "MemoryImportError";
  }
}

function importFailure(error: unknown): { code: string; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  return {
    code: error instanceof MemoryImportError ? error.code : "import-failed",
    message,
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
