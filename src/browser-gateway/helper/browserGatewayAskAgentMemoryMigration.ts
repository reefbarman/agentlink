import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type {
  DerivedSessionChunk,
  DerivedSessionImportCheckpoint,
  DerivedSessionRetrievalService,
  DerivedSessionSummary,
  PublishDerivedSessionRequest,
} from "../../core/session/DerivedSessionRetrievalService.js";

import { BROWSER_GATEWAY_ASK_AGENT_MEMORY_SCHEMA_VERSION } from "../browserGatewayAskAgentMemory.js";
import { createHash } from "node:crypto";

export const BROWSER_GATEWAY_ASK_AGENT_MEMORY_IMPORTER_SCHEMA_VERSION = 1;
export const BROWSER_GATEWAY_ASK_AGENT_MEMORY_IMPORT_SOURCE_KEY =
  "global:agentlink-user:browser-gateway-ask-agent-memory.json";

const DEFAULT_LEGACY_MEMORY_PATH = path.join(
  os.homedir(),
  ".agentlink",
  "browser-gateway-ask-agent-memory.json",
);
const MAX_LEGACY_MEMORY_BYTES = 16 * 1024 * 1024;
const STABLE_READ_ATTEMPTS = 3;
const BROWSER_SESSION_SURFACE = "browser-ask-agent";
const GLOBAL_SESSION_SCOPE = { kind: "global", id: "agentlink-user" } as const;

export interface BrowserGatewayAskAgentMemoryMigrationService {
  getImportCheckpoint(
    sourceKey: string,
  ): Promise<DerivedSessionImportCheckpoint | null>;
  importSessions(
    request: Parameters<DerivedSessionRetrievalService["importSessions"]>[0],
  ): ReturnType<DerivedSessionRetrievalService["importSessions"]>;
  recordImportState(
    checkpoint: DerivedSessionImportCheckpoint,
  ): Promise<DerivedSessionImportCheckpoint>;
}

export type BrowserGatewayAskAgentMemoryMigrationResult =
  | {
      status: "missing";
      checkpoint: DerivedSessionImportCheckpoint;
      filePath: string;
    }
  | {
      status: "imported" | "already-complete";
      checkpoint: DerivedSessionImportCheckpoint;
      filePath: string;
      sessionCount: number;
      chunkCount: number;
    };

interface StrictLegacyMemorySnapshot {
  schemaVersion: typeof BROWSER_GATEWAY_ASK_AGENT_MEMORY_SCHEMA_VERSION;
  updatedAt: number;
  sessions: StrictLegacySessionMemory[];
  chunks: StrictLegacyMemoryChunk[];
}

interface StrictLegacySessionMemory {
  sessionId: string;
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

interface StrictLegacyMemoryChunk {
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

export async function migrateBrowserGatewayAskAgentMemory(options: {
  service: BrowserGatewayAskAgentMemoryMigrationService;
  filePath?: string;
  now?: () => Date;
}): Promise<BrowserGatewayAskAgentMemoryMigrationResult> {
  const filePath = options.filePath ?? DEFAULT_LEGACY_MEMORY_PATH;
  const current = await options.service.getImportCheckpoint(
    BROWSER_GATEWAY_ASK_AGENT_MEMORY_IMPORT_SOURCE_KEY,
  );
  if (current?.status === "complete") {
    return {
      status: "already-complete",
      checkpoint: current,
      filePath,
      sessionCount: current.importedSessionIds?.length ?? 0,
      chunkCount: 0,
    };
  }

  const now = options.now ?? (() => new Date());
  const updatedAt = now().toISOString();
  let read: StableLegacyMemoryRead | null;
  try {
    read = await readStableLegacyMemoryFile(filePath);
  } catch (error) {
    const failure = migrationFailure(error, "read-failed");
    await options.service.recordImportState({
      sourceKey: BROWSER_GATEWAY_ASK_AGENT_MEMORY_IMPORT_SOURCE_KEY,
      sourceRevision: `unreadable:${failure.code}`,
      importerSchemaVersion:
        BROWSER_GATEWAY_ASK_AGENT_MEMORY_IMPORTER_SCHEMA_VERSION,
      status: "failed",
      updatedAt,
      error: failure,
    });
    throw new BrowserGatewayAskAgentMemoryMigrationError(
      failure.code,
      failure.message,
      { cause: error },
    );
  }

  if (!read) {
    const checkpoint = await options.service.recordImportState({
      sourceKey: BROWSER_GATEWAY_ASK_AGENT_MEMORY_IMPORT_SOURCE_KEY,
      sourceRevision: "missing",
      importerSchemaVersion:
        BROWSER_GATEWAY_ASK_AGENT_MEMORY_IMPORTER_SCHEMA_VERSION,
      status: "missing",
      updatedAt,
    });
    return { status: "missing", checkpoint, filePath };
  }

  const sourceRevision = sha256(read.content);
  let snapshot: StrictLegacyMemorySnapshot;
  try {
    snapshot = parseStrictLegacyMemorySnapshot(read.content);
  } catch (error) {
    const failure = migrationFailure(error, "parse-failed");
    await options.service.recordImportState({
      sourceKey: BROWSER_GATEWAY_ASK_AGENT_MEMORY_IMPORT_SOURCE_KEY,
      sourceRevision,
      importerSchemaVersion:
        BROWSER_GATEWAY_ASK_AGENT_MEMORY_IMPORTER_SCHEMA_VERSION,
      status: "failed",
      updatedAt,
      error: failure,
    });
    throw error;
  }

  const sessions = buildImportRequests(snapshot);
  try {
    const result = await options.service.importSessions({
      sourceKey: BROWSER_GATEWAY_ASK_AGENT_MEMORY_IMPORT_SOURCE_KEY,
      sourceRevision,
      importerSchemaVersion:
        BROWSER_GATEWAY_ASK_AGENT_MEMORY_IMPORTER_SCHEMA_VERSION,
      observedAt: read.observedAt,
      sessions,
    });
    return {
      status: result.status,
      checkpoint: result.checkpoint,
      filePath,
      sessionCount: snapshot.sessions.length,
      chunkCount: snapshot.chunks.length,
    };
  } catch (error) {
    const failure = migrationFailure(error, "import-failed");
    await options.service.recordImportState({
      sourceKey: BROWSER_GATEWAY_ASK_AGENT_MEMORY_IMPORT_SOURCE_KEY,
      sourceRevision,
      importerSchemaVersion:
        BROWSER_GATEWAY_ASK_AGENT_MEMORY_IMPORTER_SCHEMA_VERSION,
      status: "failed",
      updatedAt,
      error: failure,
    });
    throw error;
  }
}

interface StableLegacyMemoryRead {
  content: Buffer;
  observedAt: string;
}

async function readStableLegacyMemoryFile(
  filePath: string,
): Promise<StableLegacyMemoryRead | null> {
  for (let attempt = 1; attempt <= STABLE_READ_ATTEMPTS; attempt += 1) {
    try {
      return await readLegacyMemoryFileOnce(filePath);
    } catch (error) {
      if (
        !(error instanceof BrowserGatewayAskAgentMemoryMigrationError) ||
        error.code !== "source-changed-during-read" ||
        attempt === STABLE_READ_ATTEMPTS
      ) {
        throw error;
      }
    }
  }
  throw new Error("unreachable");
}

async function readLegacyMemoryFileOnce(
  filePath: string,
): Promise<StableLegacyMemoryRead | null> {
  let before: Awaited<ReturnType<typeof fs.stat>>;
  try {
    before = await fs.stat(filePath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
  if (!before.isFile()) {
    throw new BrowserGatewayAskAgentMemoryMigrationError(
      "not-a-file",
      `Legacy Browser Ask Agent memory source is not a regular file: ${filePath}`,
    );
  }
  if (before.size > MAX_LEGACY_MEMORY_BYTES) {
    throw new BrowserGatewayAskAgentMemoryMigrationError(
      "source-too-large",
      `Legacy Browser Ask Agent memory exceeds ${MAX_LEGACY_MEMORY_BYTES} bytes`,
    );
  }
  const content = await fs.readFile(filePath);
  const after = await fs.stat(filePath);
  if (
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    content.byteLength !== before.size
  ) {
    throw new BrowserGatewayAskAgentMemoryMigrationError(
      "source-changed-during-read",
      `Legacy Browser Ask Agent memory changed while it was being read: ${filePath}`,
    );
  }
  if (content.includes(0)) {
    throw new BrowserGatewayAskAgentMemoryMigrationError(
      "invalid-content",
      "Legacy Browser Ask Agent memory contains NUL bytes",
    );
  }
  return { content, observedAt: before.mtime.toISOString() };
}

function parseStrictLegacyMemorySnapshot(
  content: Buffer,
): StrictLegacyMemorySnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.toString("utf8"));
  } catch (error) {
    throw new BrowserGatewayAskAgentMemoryMigrationError(
      "corrupt-json",
      `Legacy Browser Ask Agent memory JSON is malformed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const root = record(parsed, "root");
  const schemaVersion = integer(root.schemaVersion, "schemaVersion");
  if (schemaVersion !== BROWSER_GATEWAY_ASK_AGENT_MEMORY_SCHEMA_VERSION) {
    throw new BrowserGatewayAskAgentMemoryMigrationError(
      "unknown-schema",
      `Unsupported Browser Ask Agent memory schema version: ${schemaVersion}`,
    );
  }
  const sessions = array(root.sessions, "sessions").map((value, index) =>
    parseSession(value, `sessions[${index}]`),
  );
  const chunks = array(root.chunks, "chunks").map((value, index) =>
    parseChunk(value, `chunks[${index}]`),
  );
  assertUnique(
    sessions.map(({ sessionId }) => sessionId),
    "session ID",
  );
  assertUnique(
    chunks.map(({ id }) => id),
    "chunk ID",
  );
  const sessionsById = new Map(
    sessions.map((session) => [session.sessionId, session]),
  );
  for (const chunk of chunks) {
    const session = sessionsById.get(chunk.sessionId);
    if (!session) {
      throw invalidShape(
        `Chunk ${chunk.id} references missing session ${chunk.sessionId}`,
      );
    }
  }
  return {
    schemaVersion: BROWSER_GATEWAY_ASK_AGENT_MEMORY_SCHEMA_VERSION,
    updatedAt: finiteNumber(root.updatedAt, "updatedAt"),
    sessions,
    chunks,
  };
}

function parseSession(
  value: unknown,
  label: string,
): StrictLegacySessionMemory {
  const source = record(value, label);
  return {
    sessionId: nonEmptyString(source.sessionId, `${label}.sessionId`),
    title: nonEmptyString(source.title, `${label}.title`),
    createdAt: finiteNumber(source.createdAt, `${label}.createdAt`),
    lastActiveAt: finiteNumber(source.lastActiveAt, `${label}.lastActiveAt`),
    messageCount: nonNegativeInteger(
      source.messageCount,
      `${label}.messageCount`,
    ),
    sourceRevision: nonEmptyString(
      source.sourceRevision,
      `${label}.sourceRevision`,
    ),
    summary: nonEmptyString(source.summary, `${label}.summary`),
    topics: stringArray(source.topics, `${label}.topics`),
    decisions: stringArray(source.decisions, `${label}.decisions`),
    openQuestions: stringArray(source.openQuestions, `${label}.openQuestions`),
    durableCandidateHints: stringArray(
      source.durableCandidateHints,
      `${label}.durableCandidateHints`,
    ),
    updatedAt: finiteNumber(source.updatedAt, `${label}.updatedAt`),
  };
}

function parseChunk(value: unknown, label: string): StrictLegacyMemoryChunk {
  const source = record(value, label);
  const startMessageIndex = nonNegativeInteger(
    source.startMessageIndex,
    `${label}.startMessageIndex`,
  );
  const endMessageIndex = nonNegativeInteger(
    source.endMessageIndex,
    `${label}.endMessageIndex`,
  );
  if (endMessageIndex < startMessageIndex) {
    throw invalidShape(`${label} has an invalid message range`);
  }
  return {
    id: nonEmptyString(source.id, `${label}.id`),
    sessionId: nonEmptyString(source.sessionId, `${label}.sessionId`),
    sourceMessageIds: stringArray(
      source.sourceMessageIds,
      `${label}.sourceMessageIds`,
    ),
    startMessageIndex,
    endMessageIndex,
    sourceRevision: nonEmptyString(
      source.sourceRevision,
      `${label}.sourceRevision`,
    ),
    summary: nonEmptyString(source.summary, `${label}.summary`),
    keywords: stringArray(source.keywords, `${label}.keywords`),
    entities: stringArray(source.entities, `${label}.entities`),
    createdAt: finiteNumber(source.createdAt, `${label}.createdAt`),
    updatedAt: finiteNumber(source.updatedAt, `${label}.updatedAt`),
  };
}

function buildImportRequests(
  snapshot: StrictLegacyMemorySnapshot,
): PublishDerivedSessionRequest[] {
  const chunksBySession = new Map<string, DerivedSessionChunk[]>();
  for (const chunk of snapshot.chunks) {
    const sessionChunks = chunksBySession.get(chunk.sessionId) ?? [];
    sessionChunks.push({ ...chunk });
    chunksBySession.set(chunk.sessionId, sessionChunks);
  }
  return snapshot.sessions.map((legacy): PublishDerivedSessionRequest => {
    const session: DerivedSessionSummary = {
      ...legacy,
      surface: BROWSER_SESSION_SURFACE,
      scope: GLOBAL_SESSION_SCOPE,
    };
    return {
      session,
      chunks: (chunksBySession.get(legacy.sessionId) ?? []).sort(
        (left, right) =>
          left.startMessageIndex - right.startMessageIndex ||
          left.id.localeCompare(right.id),
      ),
    };
  });
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidShape(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw invalidShape(`${label} must be an array`);
  return value;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw invalidShape(`${label} must be a non-empty string`);
  }
  return value;
}

function stringArray(value: unknown, label: string): string[] {
  const values = array(value, label);
  if (values.some((item) => typeof item !== "string" || !item.trim())) {
    throw invalidShape(`${label} must contain non-empty strings`);
  }
  return values as string[];
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw invalidShape(`${label} must be a non-negative finite number`);
  }
  return value;
}

function integer(value: unknown, label: string): number {
  if (!Number.isInteger(value))
    throw invalidShape(`${label} must be an integer`);
  return Number(value);
}

function nonNegativeInteger(value: unknown, label: string): number {
  const parsed = integer(value, label);
  if (parsed < 0) throw invalidShape(`${label} must be non-negative`);
  return parsed;
}

function assertUnique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw invalidShape(
      `Legacy Browser Ask Agent memory has duplicate ${label}s`,
    );
  }
}

function invalidShape(
  message: string,
): BrowserGatewayAskAgentMemoryMigrationError {
  return new BrowserGatewayAskAgentMemoryMigrationError(
    "invalid-shape",
    message,
  );
}

function migrationFailure(
  error: unknown,
  fallbackCode: string,
): NonNullable<DerivedSessionImportCheckpoint["error"]> {
  return {
    code:
      error instanceof BrowserGatewayAskAgentMemoryMigrationError
        ? error.code
        : (errorCode(error) ?? fallbackCode),
    message: error instanceof Error ? error.message : String(error),
  };
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

export class BrowserGatewayAskAgentMemoryMigrationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "BrowserGatewayAskAgentMemoryMigrationError";
  }
}
