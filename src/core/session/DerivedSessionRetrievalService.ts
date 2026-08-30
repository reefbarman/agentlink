import type {
  RetrievalActiveSource,
  RetrievalDeleteSourceOutcome,
  RetrievalPublicationBatchOutcome,
  RetrievalPublicationOutcome,
  RetrievalPublicationRequest,
  RetrievalQueryCandidate,
  RetrievalRepository,
  RetrievalSnapshot,
} from "../retrieval/contracts.js";
import { scanMemoryText } from "../memory/memoryPolicy.js";

const DERIVED_SESSION_DOMAIN = "derived-session";
const DERIVED_SESSION_SCHEMA_VERSION = 1;
const DEFAULT_RECALL_LIMIT = 5;
const MAX_RECALL_LIMIT = 50;
const MAX_SUMMARY_CHARS = 8_000;
const MAX_CHUNKS_PER_SESSION = 500;
let publicationSequence = 0;

export interface DerivedSessionScope {
  kind: "global" | "workspace";
  id: string;
}

export interface DerivedSessionSummary {
  sessionId: string;
  surface: string;
  scope: DerivedSessionScope;
  title: string;
  createdAt: number;
  lastActiveAt: number;
  messageCount: number;
  sourceRevision: string;
  summary: string;
  topics: string[];
  decisions: string[];
  openQuestions: string[];
  durableCandidateHints: string[];
  updatedAt: number;
}

export interface DerivedSessionChunk {
  id: string;
  sessionId: string;
  sourceMessageIds: string[];
  startMessageIndex: number;
  endMessageIndex: number;
  sourceRevision: string;
  summary: string;
  keywords: string[];
  entities: string[];
  createdAt: number;
  updatedAt: number;
}

export interface PublishDerivedSessionRequest {
  session: DerivedSessionSummary;
  chunks: DerivedSessionChunk[];
}

export interface DerivedSessionRecallRequest {
  query: string;
  scopes: DerivedSessionScope[];
  surfaces?: string[];
  activeSessionId?: string;
  visibleMessageIds?: readonly string[];
  limit?: number;
  minimumScore?: number;
}

export interface DerivedSessionRecallResult {
  kind: "session" | "chunk";
  sessionId: string;
  surface: string;
  scope: DerivedSessionScope;
  chunkId?: string;
  title?: string;
  summary: string;
  score: number;
  sourceRevision: string;
  sourceMessageIds: string[];
  startMessageIndex?: number;
  endMessageIndex?: number;
  updatedAt: number;
}

export interface DerivedSessionInspection {
  sessions: DerivedSessionSummary[];
  sessionCount: number;
  chunkCount: number;
}

export interface DerivedSessionImportCheckpoint {
  sourceKey: string;
  sourceRevision: string;
  importerSchemaVersion: number;
  status: "missing" | "complete" | "failed";
  updatedAt: string;
  snapshot?: RetrievalSnapshot;
  importedSessionIds?: string[];
  error?: { code: string; message: string };
}

export interface ImportDerivedSessionsRequest {
  sourceKey: string;
  sourceRevision: string;
  importerSchemaVersion: number;
  observedAt: string;
  sessions: PublishDerivedSessionRequest[];
}

export interface DerivedSessionRetrievalServiceOptions {
  createPublicationId?: () => string;
}

interface StoredDerivedSessionPayload {
  schemaVersion: typeof DERIVED_SESSION_SCHEMA_VERSION;
  session: DerivedSessionSummary;
  chunks: DerivedSessionChunk[];
}

export class DerivedSessionRetrievalService {
  private readonly createPublicationId: () => string;

  constructor(
    private readonly repository: RetrievalRepository,
    options: DerivedSessionRetrievalServiceOptions = {},
  ) {
    this.createPublicationId =
      options.createPublicationId ??
      (() =>
        `derived-session-publication-${Date.now()}-${++publicationSequence}`);
  }

  async publish(
    request: PublishDerivedSessionRequest,
  ): Promise<RetrievalPublicationOutcome> {
    const publication = this.buildPublication(request);
    await this.repository.preparePublication(publication);
    try {
      return await this.repository.commitPublication(publication.publicationId);
    } catch (error) {
      await this.repository
        .abortPublication(publication.publicationId)
        .catch(() => undefined);
      throw error;
    }
  }

  async upsert(
    request: PublishDerivedSessionRequest,
  ): Promise<RetrievalPublicationOutcome> {
    const active = await this.repository.inspectSource(
      getDerivedSessionSourceId(request.session),
    );
    if (!active) return await this.publish(request);
    const current = parseStoredProjection(active);
    const chunks = new Map(
      current.chunks.map((chunk) => [chunk.id, chunk] as const),
    );
    for (const chunk of request.chunks) chunks.set(chunk.id, chunk);
    return await this.publish({
      session: request.session,
      chunks: [...chunks.values()].sort(
        (left, right) =>
          left.startMessageIndex - right.startMessageIndex ||
          left.id.localeCompare(right.id),
      ),
    });
  }

  async publishBatch(
    requests: PublishDerivedSessionRequest[],
  ): Promise<RetrievalPublicationBatchOutcome> {
    const publications = requests.map((request) =>
      this.buildPublication(request),
    );
    const preparedIds: string[] = [];
    try {
      for (const publication of publications) {
        await this.repository.preparePublication(publication);
        preparedIds.push(publication.publicationId);
      }
      return await this.repository.commitPublicationBatch(preparedIds);
    } catch (error) {
      await Promise.all(
        preparedIds.map((publicationId) =>
          this.repository
            .abortPublication(publicationId)
            .catch(() => undefined),
        ),
      );
      throw error;
    }
  }

  private buildPublication(
    request: PublishDerivedSessionRequest,
  ): RetrievalPublicationRequest {
    validatePublication(request);
    const sourceId = getDerivedSessionSourceId(request.session);
    const generation = `derived-session-generation:${encodeIdentity(request.session.sourceRevision)}`;
    const revisionId = request.session.sourceRevision;
    const sourceContent = renderSessionSearchText(request.session);
    const summaryChunkId = `${sourceId}:summary`;
    const chunks = [
      {
        id: summaryChunkId,
        sourceId,
        revisionId,
        generation,
        content: sourceContent,
        embedding: null,
        metadata: {
          domain: DERIVED_SESSION_DOMAIN,
          recordKind: "session-summary",
          sessionId: request.session.sessionId,
          surface: request.session.surface,
          scopeKind: request.session.scope.kind,
          scopeId: request.session.scope.id,
          sourceRevision: revisionId,
          updatedAt: request.session.updatedAt,
        },
      },
      ...request.chunks.map((chunk) => ({
        id: getDerivedSessionChunkRecordId(sourceId, chunk.id),
        sourceId,
        revisionId,
        generation,
        content: renderChunkSearchText(request.session, chunk),
        embedding: null,
        location: {
          startLine: chunk.startMessageIndex,
          endLine: chunk.endMessageIndex,
          scope: [request.session.surface, request.session.sessionId],
        },
        metadata: {
          domain: DERIVED_SESSION_DOMAIN,
          recordKind: "chunk-summary",
          sessionId: request.session.sessionId,
          surface: request.session.surface,
          scopeKind: request.session.scope.kind,
          scopeId: request.session.scope.id,
          chunkId: chunk.id,
          sourceRevision: chunk.sourceRevision,
          sourceMessageIdsJson: JSON.stringify(chunk.sourceMessageIds),
          summary: chunk.summary,
          createdAt: chunk.createdAt,
          updatedAt: chunk.updatedAt,
        },
      })),
    ];
    const publicationId = this.createPublicationId();
    return {
      publicationId,
      generation,
      source: {
        id: sourceId,
        namespace: "session",
        kind: "session",
        revision: {
          id: revisionId,
          contentHash: stableHash(
            JSON.stringify({
              session: request.session,
              chunks: request.chunks,
            }),
          ),
          observedAt: new Date(request.session.updatedAt).toISOString(),
        },
        path: `session://${encodeIdentity(request.session.surface)}/${encodeIdentity(request.session.sessionId)}`,
        title: request.session.title,
        content: sourceContent,
        metadata: {
          domain: DERIVED_SESSION_DOMAIN,
          schemaVersion: DERIVED_SESSION_SCHEMA_VERSION,
          sessionId: request.session.sessionId,
          surface: request.session.surface,
          scopeKind: request.session.scope.kind,
          scopeId: request.session.scope.id,
          sourceRevision: revisionId,
          updatedAt: request.session.updatedAt,
          chunkCount: request.chunks.length,
          payloadJson: JSON.stringify({
            schemaVersion: DERIVED_SESSION_SCHEMA_VERSION,
            session: request.session,
            chunks: request.chunks,
          } satisfies StoredDerivedSessionPayload),
        },
      },
      chunks,
      relations: [],
      expectedChunkIds: chunks.map((chunk) => chunk.id),
      expectedRelationIds: [],
    };
  }

  async importSessions(request: ImportDerivedSessionsRequest): Promise<{
    status: "imported" | "already-complete";
    checkpoint: DerivedSessionImportCheckpoint;
  }> {
    validateImportIdentity(request);
    const current = await this.getImportCheckpoint(request.sourceKey);
    if (
      current?.status === "complete" &&
      current.sourceRevision === request.sourceRevision
    ) {
      return { status: "already-complete", checkpoint: current };
    }

    // Canonical sessions may advance while an older profile remains open.
    // Skip legacy projections that are not newer instead of rejecting the
    // entire atomic import batch as stale.
    const importableSessions: PublishDerivedSessionRequest[] = [];
    for (const session of request.sessions) {
      const active = await this.repository.inspectSource(
        getDerivedSessionSourceId(session.session),
      );
      if (active) {
        const current = parseStoredProjection(active).session;
        if (
          current.updatedAt > session.session.updatedAt ||
          (current.updatedAt === session.session.updatedAt &&
            current.sourceRevision >= session.session.sourceRevision)
        ) {
          continue;
        }
      }
      importableSessions.push(session);
    }
    const sessionPublications = importableSessions.map((session) =>
      this.buildPublication(session),
    );
    const snapshotOutcome = await this.repository.createSnapshot(
      `pre-import:${request.sourceKey}:${request.sourceRevision}`,
    );
    if (snapshotOutcome.status !== "created" || !snapshotOutcome.snapshot) {
      throw new Error("Derived session pre-import snapshot was not created");
    }
    const checkpoint: DerivedSessionImportCheckpoint = {
      sourceKey: request.sourceKey,
      sourceRevision: request.sourceRevision,
      importerSchemaVersion: request.importerSchemaVersion,
      status: "complete",
      updatedAt: request.observedAt,
      snapshot: snapshotOutcome.snapshot,
      importedSessionIds: importableSessions
        .map(({ session }) => session.sessionId)
        .sort(),
    };
    const publications = [
      ...sessionPublications,
      this.buildImportCheckpointPublication(checkpoint),
    ];
    const preparedIds: string[] = [];
    try {
      for (const publication of publications) {
        await this.repository.preparePublication(publication);
        preparedIds.push(publication.publicationId);
      }
      const outcome = await this.repository.commitPublicationBatch(preparedIds);
      if (outcome.status !== "published") {
        await this.abortPublications(preparedIds);
        throw new Error("Derived session import batch was rejected");
      }
      return { status: "imported", checkpoint };
    } catch (error) {
      await this.abortPublications(preparedIds);
      throw error;
    }
  }

  async recordImportState(
    checkpoint: DerivedSessionImportCheckpoint,
  ): Promise<DerivedSessionImportCheckpoint> {
    validateImportCheckpoint(checkpoint);
    const outcome = await this.publishRaw(
      this.buildImportCheckpointPublication(checkpoint),
    );
    if (outcome.status !== "published") {
      throw new Error(
        `Derived session import checkpoint was not published: ${outcome.status}`,
      );
    }
    return checkpoint;
  }

  async getImportCheckpoint(
    sourceKey: string,
  ): Promise<DerivedSessionImportCheckpoint | null> {
    validateIdentity("import source key", sourceKey);
    const source = await this.repository.inspectSource(
      getDerivedSessionImportSourceId(sourceKey),
    );
    if (!source) return null;
    return parseImportCheckpoint(source);
  }

  async recall(
    request: DerivedSessionRecallRequest,
  ): Promise<DerivedSessionRecallResult[]> {
    const query = request.query.trim();
    if (!query) return [];
    if (request.scopes.length === 0) {
      throw new Error("Derived session recall requires at least one scope");
    }
    const limit = request.limit ?? DEFAULT_RECALL_LIMIT;
    if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_RECALL_LIMIT) {
      throw new Error(
        `Derived session recall limit must be an integer from 1 to ${MAX_RECALL_LIMIT}`,
      );
    }
    if (
      request.minimumScore !== undefined &&
      (!Number.isFinite(request.minimumScore) || request.minimumScore < 0)
    ) {
      throw new Error(
        "Derived session recall minimumScore must be finite and non-negative",
      );
    }

    const surfaces = uniqueStrings(request.surfaces ?? []);
    const candidates = (
      await Promise.all(
        uniqueScopes(request.scopes).flatMap((scope) => {
          const effectiveSurfaces =
            surfaces.length > 0 ? surfaces : [undefined];
          return effectiveSurfaces.map((surface) =>
            this.repository.query({
              text: query,
              mode: "lexical",
              filters: {
                namespaces: ["session"],
                sourceKinds: ["session"],
                metadata: {
                  domain: DERIVED_SESSION_DOMAIN,
                  scopeKind: scope.kind,
                  scopeId: scope.id,
                  ...(surface ? { surface } : {}),
                },
              },
              limit: Math.max(limit * 4, 20),
              ...(request.minimumScore === undefined
                ? {}
                : { minimumScore: request.minimumScore }),
              diversity: { maxPerSource: 3, collapseOverlaps: true },
            }),
          );
        }),
      )
    ).flatMap((result) => result.candidates);

    const visibleMessageIds = new Set(request.visibleMessageIds ?? []);
    return deduplicateCandidates(candidates)
      .flatMap((candidate) => {
        const result = recallResult(candidate);
        if (!result) return [];
        if (
          result.kind === "chunk" &&
          result.sessionId === request.activeSessionId &&
          result.sourceMessageIds.length > 0 &&
          result.sourceMessageIds.every((id) => visibleMessageIds.has(id))
        ) {
          return [];
        }
        return [result];
      })
      .sort(
        (left, right) =>
          right.score - left.score ||
          right.updatedAt - left.updatedAt ||
          resultIdentity(left).localeCompare(resultIdentity(right)),
      )
      .slice(0, limit);
  }

  async deleteSession(request: {
    sessionId: string;
    surface: string;
    scope: DerivedSessionScope;
    expectedRevision?: string;
  }): Promise<RetrievalDeleteSourceOutcome["status"]> {
    validateIdentity("session ID", request.sessionId);
    validateIdentity("surface", request.surface);
    validateScope(request.scope);
    const outcome = await this.repository.deleteSource({
      sourceId: getDerivedSessionSourceId(request),
      ...(request.expectedRevision
        ? { expectedRevisionId: request.expectedRevision }
        : {}),
    });
    return outcome.status;
  }

  async clearScope(request: { scope: DerivedSessionScope; surface?: string }) {
    validateScope(request.scope);
    return await this.repository.deleteScope({
      namespaces: ["session"],
      metadata: {
        domain: DERIVED_SESSION_DOMAIN,
        scopeKind: request.scope.kind,
        scopeId: request.scope.id,
        ...(request.surface ? { surface: request.surface } : {}),
      },
    });
  }

  private buildImportCheckpointPublication(
    checkpoint: DerivedSessionImportCheckpoint,
  ): RetrievalPublicationRequest {
    validateImportCheckpoint(checkpoint);
    const sourceId = getDerivedSessionImportSourceId(checkpoint.sourceKey);
    const revisionId = `${checkpoint.status}:${checkpoint.sourceRevision}:${checkpoint.importerSchemaVersion}`;
    const publicationId = this.createPublicationId();
    return {
      publicationId,
      generation: `derived-session-import-generation:${encodeIdentity(revisionId)}`,
      source: {
        id: sourceId,
        namespace: "session",
        kind: "custom",
        revision: {
          id: revisionId,
          contentHash: stableHash(JSON.stringify(checkpoint)),
          observedAt: checkpoint.updatedAt,
        },
        title: "Derived session legacy import checkpoint",
        content: "Derived session legacy import checkpoint",
        metadata: {
          domain: "derived-session-import",
          sourceKey: checkpoint.sourceKey,
          sourceRevision: checkpoint.sourceRevision,
          importerSchemaVersion: checkpoint.importerSchemaVersion,
          status: checkpoint.status,
          payloadJson: JSON.stringify(checkpoint),
        },
      },
      chunks: [],
      relations: [],
      expectedChunkIds: [],
      expectedRelationIds: [],
    };
  }

  private async publishRaw(
    publication: RetrievalPublicationRequest,
  ): Promise<RetrievalPublicationOutcome> {
    await this.repository.preparePublication(publication);
    try {
      return await this.repository.commitPublication(publication.publicationId);
    } catch (error) {
      await this.repository
        .abortPublication(publication.publicationId)
        .catch(() => undefined);
      throw error;
    }
  }

  private async abortPublications(publicationIds: string[]): Promise<void> {
    await Promise.all(
      publicationIds.map((publicationId) =>
        this.repository.abortPublication(publicationId).catch(() => undefined),
      ),
    );
  }

  async exportSessions(): Promise<PublishDerivedSessionRequest[]> {
    const sources = await this.repository.listSources({
      namespaces: ["session"],
      sourceKinds: ["session"],
      metadata: { domain: DERIVED_SESSION_DOMAIN },
    });
    return deduplicateSources(sources)
      .map((source) => {
        const projection = parseStoredProjection(source);
        return { session: projection.session, chunks: projection.chunks };
      })
      .sort(
        (left, right) =>
          left.session.surface.localeCompare(right.session.surface) ||
          left.session.scope.kind.localeCompare(right.session.scope.kind) ||
          left.session.scope.id.localeCompare(right.session.scope.id) ||
          left.session.sessionId.localeCompare(right.session.sessionId),
      );
  }

  async inspect(
    request: {
      scopes?: DerivedSessionScope[];
      surfaces?: string[];
    } = {},
  ): Promise<DerivedSessionInspection> {
    const scopes = request.scopes?.length
      ? uniqueScopes(request.scopes)
      : [undefined];
    const surfaces = request.surfaces?.length
      ? uniqueStrings(request.surfaces)
      : [undefined];
    const sources = (
      await Promise.all(
        scopes.flatMap((scope) =>
          surfaces.map((surface) =>
            this.repository.listSources({
              namespaces: ["session"],
              sourceKinds: ["session"],
              metadata: {
                domain: DERIVED_SESSION_DOMAIN,
                ...(scope ? { scopeKind: scope.kind, scopeId: scope.id } : {}),
                ...(surface ? { surface } : {}),
              },
            }),
          ),
        ),
      )
    ).flat();
    const sessions = deduplicateSources(sources)
      .map((source) => parseStoredSession(source))
      .sort(
        (left, right) =>
          right.updatedAt - left.updatedAt ||
          left.sessionId.localeCompare(right.sessionId),
      );
    const chunkCount = sessions.reduce(
      (count, session) =>
        count +
        sourcesForSession(sources, getDerivedSessionSourceId(session)).reduce(
          (total, source) => total + sourceChunkCount(source),
          0,
        ),
      0,
    );
    return { sessions, sessionCount: sessions.length, chunkCount };
  }
}

export function getDerivedSessionImportSourceId(sourceKey: string): string {
  return `derived-session-import:${encodeIdentity(sourceKey)}`;
}

export function getDerivedSessionSourceId(request: {
  sessionId: string;
  surface: string;
  scope: DerivedSessionScope;
}): string {
  return [
    "derived-session",
    encodeIdentity(request.surface),
    request.scope.kind,
    encodeIdentity(request.scope.id),
    encodeIdentity(request.sessionId),
  ].join(":");
}

function getDerivedSessionChunkRecordId(
  sourceId: string,
  chunkId: string,
): string {
  return `${sourceId}:chunk:${encodeIdentity(chunkId)}`;
}

function validateImportIdentity(request: ImportDerivedSessionsRequest): void {
  validateIdentity("import source key", request.sourceKey);
  validateIdentity("import source revision", request.sourceRevision);
  if (
    !Number.isInteger(request.importerSchemaVersion) ||
    request.importerSchemaVersion <= 0
  ) {
    throw new Error("Derived session importer schema version must be positive");
  }
  if (!Number.isFinite(Date.parse(request.observedAt))) {
    throw new Error("Derived session import observedAt is invalid");
  }
}

function validateImportCheckpoint(
  checkpoint: DerivedSessionImportCheckpoint,
): void {
  validateImportIdentity({
    sourceKey: checkpoint.sourceKey,
    sourceRevision: checkpoint.sourceRevision,
    importerSchemaVersion: checkpoint.importerSchemaVersion,
    observedAt: checkpoint.updatedAt,
    sessions: [],
  });
  if (
    checkpoint.status !== "missing" &&
    checkpoint.status !== "complete" &&
    checkpoint.status !== "failed"
  ) {
    throw new Error("Derived session import checkpoint status is invalid");
  }
  if (checkpoint.status === "failed") {
    if (!checkpoint.error?.code.trim() || !checkpoint.error.message.trim()) {
      throw new Error("Derived session import failure details are required");
    }
  }
}

function validatePublication(request: PublishDerivedSessionRequest): void {
  const { session, chunks } = request;
  validateIdentity("session ID", session.sessionId);
  validateIdentity("surface", session.surface);
  validateIdentity("source revision", session.sourceRevision);
  validateScope(session.scope);
  validateTimestamp("createdAt", session.createdAt);
  validateTimestamp("lastActiveAt", session.lastActiveAt);
  validateTimestamp("updatedAt", session.updatedAt);
  if (!Number.isInteger(session.messageCount) || session.messageCount < 0) {
    throw new Error(
      "Derived session messageCount must be a non-negative integer",
    );
  }
  validateSummaryText("session summary", session.summary);
  validateSummaryText("session title", session.title);
  for (const text of [
    ...session.topics,
    ...session.decisions,
    ...session.openQuestions,
    ...session.durableCandidateHints,
  ]) {
    validateSummaryText("session metadata", text);
  }
  if (chunks.length > MAX_CHUNKS_PER_SESSION) {
    throw new Error(
      `Derived session publication exceeds ${MAX_CHUNKS_PER_SESSION} chunks`,
    );
  }
  const chunkIds = new Set<string>();
  for (const chunk of chunks) {
    validateIdentity("chunk ID", chunk.id);
    if (chunkIds.has(chunk.id)) {
      throw new Error(`Duplicate derived session chunk ID: ${chunk.id}`);
    }
    chunkIds.add(chunk.id);
    if (chunk.sessionId !== session.sessionId) {
      throw new Error(
        "Derived session chunks must share the source session ID",
      );
    }
    validateIdentity("chunk source revision", chunk.sourceRevision);

    if (
      !Number.isInteger(chunk.startMessageIndex) ||
      !Number.isInteger(chunk.endMessageIndex) ||
      chunk.startMessageIndex < 0 ||
      chunk.endMessageIndex < chunk.startMessageIndex
    ) {
      throw new Error("Derived session chunk message range is invalid");
    }
    validateTimestamp("chunk createdAt", chunk.createdAt);
    validateTimestamp("chunk updatedAt", chunk.updatedAt);
    validateSummaryText("chunk summary", chunk.summary);
    for (const text of [...chunk.keywords, ...chunk.entities]) {
      validateSummaryText("chunk metadata", text);
    }
    for (const messageId of chunk.sourceMessageIds) {
      validateIdentity("source message ID", messageId);
    }
  }
}

function validateSummaryText(label: string, value: string): void {
  if (!value.trim()) throw new Error(`Derived ${label} is required`);
  if (value.length > MAX_SUMMARY_CHARS) {
    throw new Error(`Derived ${label} exceeds ${MAX_SUMMARY_CHARS} characters`);
  }
  const scan = scanMemoryText(value);
  if (!scan.safe) {
    throw new Error(
      `Derived ${label} contains sensitive content: ${scan.finding}`,
    );
  }
}

function validateIdentity(label: string, value: string): void {
  if (!value.trim()) throw new Error(`Derived session ${label} is required`);
}

function validateScope(scope: DerivedSessionScope): void {
  if (scope.kind !== "global" && scope.kind !== "workspace") {
    throw new Error("Derived session scope kind is invalid");
  }
  validateIdentity("scope ID", scope.id);
}

function validateTimestamp(label: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(
      `Derived session ${label} must be a non-negative timestamp`,
    );
  }
}

function renderSessionSearchText(session: DerivedSessionSummary): string {
  return [
    session.title,
    session.summary,
    ...session.topics,
    ...session.decisions,
    ...session.openQuestions,
    ...session.durableCandidateHints,
  ]
    .filter(Boolean)
    .join("\n");
}

function renderChunkSearchText(
  session: DerivedSessionSummary,
  chunk: DerivedSessionChunk,
): string {
  return [session.title, chunk.summary, ...chunk.keywords, ...chunk.entities]
    .filter(Boolean)
    .join("\n");
}

function recallResult(
  candidate: RetrievalQueryCandidate,
): DerivedSessionRecallResult | null {
  const source = parseStoredProjection({
    source: candidate.source,
    generation: candidate.chunk.generation,
  }).session;
  const recordKind = stringMetadata(candidate.chunk.metadata.recordKind);
  const updatedAt = numberMetadata(candidate.chunk.metadata.updatedAt);
  if (recordKind === "session-summary") {
    return {
      kind: "session",
      sessionId: source.sessionId,
      surface: source.surface,
      scope: source.scope,
      title: source.title,
      summary: source.summary,
      score: candidate.scores.final,
      sourceRevision: source.sourceRevision,
      sourceMessageIds: [],
      updatedAt,
    };
  }
  if (recordKind !== "chunk-summary") return null;
  const chunkId = stringMetadata(candidate.chunk.metadata.chunkId);
  const startMessageIndex = candidate.chunk.location?.startLine;
  const endMessageIndex = candidate.chunk.location?.endLine;
  if (
    !chunkId ||
    startMessageIndex === undefined ||
    endMessageIndex === undefined
  ) {
    throw new Error(
      `Invalid derived session chunk record: ${candidate.chunk.id}`,
    );
  }
  return {
    kind: "chunk",
    sessionId: source.sessionId,
    surface: source.surface,
    scope: source.scope,
    chunkId,
    title: source.title,
    summary: stringMetadata(candidate.chunk.metadata.summary),
    score: candidate.scores.final,
    sourceRevision: stringMetadata(candidate.chunk.metadata.sourceRevision),
    sourceMessageIds: stringArrayMetadata(
      candidate.chunk.metadata.sourceMessageIdsJson,
    ),
    startMessageIndex,
    endMessageIndex,
    updatedAt,
  };
}

function parseImportCheckpoint(
  source: RetrievalActiveSource,
): DerivedSessionImportCheckpoint {
  const raw = stringMetadata(source.source.metadata.payloadJson);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `Invalid derived session import checkpoint: ${source.source.id}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `Invalid derived session import checkpoint: ${source.source.id}`,
    );
  }
  const checkpoint = parsed as DerivedSessionImportCheckpoint;
  validateImportCheckpoint(checkpoint);
  return structuredClone(checkpoint);
}

function parseStoredProjection(
  source: RetrievalActiveSource,
): StoredDerivedSessionPayload {
  const raw = stringMetadata(source.source.metadata.payloadJson);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid derived session payload: ${source.source.id}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid derived session payload: ${source.source.id}`);
  }
  const payload = parsed as Partial<StoredDerivedSessionPayload>;
  if (
    payload.schemaVersion !== DERIVED_SESSION_SCHEMA_VERSION ||
    !payload.session ||
    !Array.isArray(payload.chunks)
  ) {
    throw new Error(`Unknown derived session schema: ${source.source.id}`);
  }
  validatePublication({ session: payload.session, chunks: payload.chunks });
  return structuredClone(payload as StoredDerivedSessionPayload);
}

function parseStoredSession(
  source: RetrievalActiveSource,
): DerivedSessionSummary {
  return parseStoredProjection(source).session;
}

function stringMetadata(value: unknown): string {
  if (typeof value !== "string" || !value) {
    throw new Error("Invalid derived session string metadata");
  }
  return value;
}

function numberMetadata(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("Invalid derived session numeric metadata");
  }
  return value;
}

function stringArrayMetadata(value: unknown): string[] {
  const raw = stringMetadata(value);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Invalid derived session message ID metadata");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.some((item) => typeof item !== "string")
  ) {
    throw new Error("Invalid derived session message ID metadata");
  }
  return [...parsed];
}

function uniqueScopes(scopes: DerivedSessionScope[]): DerivedSessionScope[] {
  const byIdentity = new Map<string, DerivedSessionScope>();
  for (const scope of scopes) {
    validateScope(scope);
    byIdentity.set(`${scope.kind}:${scope.id}`, scope);
  }
  return [...byIdentity.values()];
}

function uniqueStrings(values: readonly string[]): string[] {
  const result = [
    ...new Set(values.map((value) => value.trim()).filter(Boolean)),
  ];
  for (const value of result) validateIdentity("surface", value);
  return result;
}

function deduplicateCandidates(
  candidates: RetrievalQueryCandidate[],
): RetrievalQueryCandidate[] {
  const byId = new Map<string, RetrievalQueryCandidate>();
  for (const candidate of candidates) {
    const current = byId.get(candidate.chunk.id);
    if (!current || candidate.scores.final > current.scores.final) {
      byId.set(candidate.chunk.id, candidate);
    }
  }
  return [...byId.values()];
}

function deduplicateSources(
  sources: RetrievalActiveSource[],
): RetrievalActiveSource[] {
  return [
    ...new Map(sources.map((source) => [source.source.id, source])).values(),
  ];
}

function sourcesForSession(
  sources: RetrievalActiveSource[],
  sourceId: string,
): RetrievalActiveSource[] {
  return sources.filter((source) => source.source.id === sourceId);
}

function sourceChunkCount(source: RetrievalActiveSource): number {
  const value = source.source.metadata.chunkCount;
  if (!Number.isInteger(value) || Number(value) < 0) {
    throw new Error(`Invalid derived session chunk count: ${source.source.id}`);
  }
  return Number(value);
}

function resultIdentity(result: DerivedSessionRecallResult): string {
  return `${result.sessionId}:${result.chunkId ?? "summary"}`;
}

function encodeIdentity(value: string): string {
  return encodeURIComponent(value);
}

function stableHash(value: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193) >>> 0;
    second = Math.imul(second ^ code, 0x85ebca6b) >>> 0;
  }
  return `${first.toString(16).padStart(8, "0")}${second.toString(16).padStart(8, "0")}`;
}
