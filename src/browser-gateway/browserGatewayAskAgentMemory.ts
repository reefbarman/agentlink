import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { createHash, randomUUID } from "crypto";

import type { ChatMessage } from "../agent/webview/types.js";

export const BROWSER_GATEWAY_ASK_AGENT_MEMORY_SCHEMA_VERSION = 1;

const MEMORY_DIR = path.join(os.homedir(), ".agentlink");
const MEMORY_PATH = path.join(
  MEMORY_DIR,
  "browser-gateway-ask-agent-memory.json",
);
const LOCK_RETRY_DELAY_MS = 10;
const LOCK_RETRY_ATTEMPTS = 100;

const STOP_WORDS = new Set([
  "about",
  "after",
  "again",
  "agent",
  "also",
  "any",
  "because",
  "before",
  "being",
  "did",
  "browser",
  "could",
  "doing",
  "from",
  "have",
  "into",
  "just",
  "like",
  "more",
  "only",
  "please",
  "should",
  "still",
  "that",
  "the",
  "their",
  "there",
  "these",
  "this",
  "those",
  "want",
  "what",
  "when",
  "where",
  "with",
  "would",
  "your",
]);

const IDENTITY_CONTEXT_PATTERNS: RegExp[] = [
  /\bwhat(?:'s|\s+is)\s+my\s+(?:name|nickname|preferred\s+name)\b/i,
  /\bwho\s+am\s+i\b/i,
  /\bdo\s+you\s+(?:know|remember)\s+my\s+(?:name|nickname|preferred\s+name)\b/i,
  /\bhave\s+i\s+told\s+you\s+my\s+(?:name|nickname|preferred\s+name)\b/i,
  /\bwhat\s+(?:name|nickname)\s+(?:did\s+i\s+give\s+you|do\s+you\s+(?:have\s+for\s+me|know\s+me\s+by|remember\s+for\s+me))\b/i,
  /\bwhat\s+(?:should\s+you\s+call\s+me|do\s+you\s+(?:call|know|remember)\s+me(?:\s+as)?)\b/i,
];

const PAST_CONTEXT_PATTERNS: RegExp[] = [
  /\bprevious(?:ly)?\b/i,
  /\bearlier\b/i,
  /\blast time\b/i,
  /\bpast (?:chat|conversation|discussion)s?\b/i,
  /\bwhat did we (?:decide|discuss)\b/i,
  /\bdo you remember\b/i,
  /\bremind me\b/i,
  ...IDENTITY_CONTEXT_PATTERNS,
];

export interface BrowserGatewayAskAgentSessionMemory {
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

export interface BrowserGatewayAskAgentMemoryChunk {
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

export interface BrowserGatewayAskAgentMemorySnapshot {
  schemaVersion: typeof BROWSER_GATEWAY_ASK_AGENT_MEMORY_SCHEMA_VERSION;
  updatedAt: number;
  sessions: BrowserGatewayAskAgentSessionMemory[];
  chunks: BrowserGatewayAskAgentMemoryChunk[];
}

export interface BrowserGatewayAskAgentMemorySearchResult {
  kind: "session" | "chunk";
  sessionId: string;
  chunkId?: string;
  title?: string;
  summary: string;
  score: number;
  sourceMessageIds: string[];
  startMessageIndex?: number;
  endMessageIndex?: number;
  updatedAt: number;
}

export interface BrowserGatewayAskAgentMemorySearchOptions {
  activeSessionId?: string;
  recentMessageIds?: readonly string[];
  limit?: number;
  minScore?: number;
  explicitPastMinScore?: number;
  now?: number;
}

export interface BrowserGatewayAskAgentMemoryStoreOptions {
  filePath?: string;
  maxSessions?: number;
  maxChunks?: number;
}

export function getBrowserGatewayAskAgentMemoryPath(): string {
  return MEMORY_PATH;
}

export function getAskAgentMemorySourceRevision(
  messages: readonly Pick<ChatMessage, "id" | "role" | "content" | "error">[],
): string {
  const hash = createHash("sha256");
  for (const message of messages) {
    hash.update(message.id);
    hash.update("\0");
    hash.update(message.role);
    hash.update("\0");
    hash.update(message.content);
    hash.update("\0");
    hash.update(message.error?.code ?? "");
    hash.update("\0");
    hash.update(message.error?.message ?? "");
    hash.update("\0");
    hash.update(String(message.error?.retryable ?? ""));
    hash.update("\0\0");
  }
  return hash.digest("hex");
}

export function hasAskAgentMemoryPastIntent(query: string): boolean {
  return PAST_CONTEXT_PATTERNS.some((pattern) => pattern.test(query));
}

function hasAskAgentIdentityMemoryIntent(query: string): boolean {
  return IDENTITY_CONTEXT_PATTERNS.some((pattern) => pattern.test(query));
}

export function tokenizeAskAgentMemoryText(text: string): string[] {
  return [
    ...new Set(
      text
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, " ")
        .split(/\s+/)
        .map((token) => token.trim())
        .filter((token) => token.length > 2 && !STOP_WORDS.has(token)),
    ),
  ];
}

function sanitizeString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() : fallback;
}

function sanitizeNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .map((item) => (typeof item === "string" ? item.trim() : ""))
        .filter(Boolean),
    ),
  ];
}

function normalizeSessionMemory(
  value: unknown,
): BrowserGatewayAskAgentSessionMemory | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const sessionId = sanitizeString(candidate.sessionId);
  if (!sessionId) return null;
  const createdAt = sanitizeNumber(candidate.createdAt, 0);
  const lastActiveAt = sanitizeNumber(candidate.lastActiveAt, createdAt);
  const updatedAt = sanitizeNumber(candidate.updatedAt, lastActiveAt);
  return {
    sessionId,
    title: sanitizeString(candidate.title, "Ask Agent") || "Ask Agent",
    createdAt,
    lastActiveAt,
    messageCount: Math.max(
      0,
      Math.floor(sanitizeNumber(candidate.messageCount, 0)),
    ),
    sourceRevision: sanitizeString(candidate.sourceRevision),
    summary: sanitizeString(candidate.summary),
    topics: sanitizeStringArray(candidate.topics),
    decisions: sanitizeStringArray(candidate.decisions),
    openQuestions: sanitizeStringArray(candidate.openQuestions),
    durableCandidateHints: sanitizeStringArray(candidate.durableCandidateHints),
    updatedAt,
  };
}

function normalizeChunk(
  value: unknown,
): BrowserGatewayAskAgentMemoryChunk | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const sessionId = sanitizeString(candidate.sessionId);
  if (!sessionId) return null;
  const id = sanitizeString(candidate.id) || `memory-chunk-${randomUUID()}`;
  const startMessageIndex = Math.max(
    0,
    Math.floor(sanitizeNumber(candidate.startMessageIndex, 0)),
  );
  const endMessageIndex = Math.max(
    startMessageIndex,
    Math.floor(sanitizeNumber(candidate.endMessageIndex, startMessageIndex)),
  );
  const createdAt = sanitizeNumber(candidate.createdAt, 0);
  const updatedAt = sanitizeNumber(candidate.updatedAt, createdAt);
  return {
    id,
    sessionId,
    sourceMessageIds: sanitizeStringArray(candidate.sourceMessageIds),
    startMessageIndex,
    endMessageIndex,
    sourceRevision: sanitizeString(candidate.sourceRevision),
    summary: sanitizeString(candidate.summary),
    keywords: sanitizeStringArray(candidate.keywords),
    entities: sanitizeStringArray(candidate.entities),
    createdAt,
    updatedAt,
  };
}

export function normalizeAskAgentMemorySnapshot(
  value: unknown,
  options: { maxSessions?: number; maxChunks?: number } = {},
): BrowserGatewayAskAgentMemorySnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      schemaVersion: BROWSER_GATEWAY_ASK_AGENT_MEMORY_SCHEMA_VERSION,
      updatedAt: 0,
      sessions: [],
      chunks: [],
    };
  }
  const candidate = value as Record<string, unknown>;
  const sessionById = new Map<string, BrowserGatewayAskAgentSessionMemory>();
  for (const item of Array.isArray(candidate.sessions)
    ? candidate.sessions
    : []) {
    const session = normalizeSessionMemory(item);
    if (!session) continue;
    const existing = sessionById.get(session.sessionId);
    if (!existing || existing.updatedAt <= session.updatedAt) {
      sessionById.set(session.sessionId, session);
    }
  }
  let sessions = [...sessionById.values()].sort(
    (a, b) => b.lastActiveAt - a.lastActiveAt,
  );
  if (options.maxSessions && options.maxSessions > 0) {
    sessions = sessions.slice(0, options.maxSessions);
  }
  const allowedSessionIds = new Set(
    sessions.map((session) => session.sessionId),
  );
  const chunkById = new Map<string, BrowserGatewayAskAgentMemoryChunk>();
  for (const item of Array.isArray(candidate.chunks) ? candidate.chunks : []) {
    const chunk = normalizeChunk(item);
    if (!chunk || !allowedSessionIds.has(chunk.sessionId)) continue;
    const existing = chunkById.get(chunk.id);
    if (!existing || existing.updatedAt <= chunk.updatedAt) {
      chunkById.set(chunk.id, chunk);
    }
  }
  let chunks = [...chunkById.values()].sort(
    (a, b) => b.updatedAt - a.updatedAt,
  );
  if (options.maxChunks && options.maxChunks > 0) {
    const retainedById = new Map<string, BrowserGatewayAskAgentMemoryChunk>();
    for (const session of sessions) {
      const newestForSession = chunks.find(
        (chunk) => chunk.sessionId === session.sessionId,
      );
      if (newestForSession)
        retainedById.set(newestForSession.id, newestForSession);
    }
    for (const chunk of chunks) {
      if (retainedById.size >= options.maxChunks) break;
      retainedById.set(chunk.id, chunk);
    }
    chunks = [...retainedById.values()].sort(
      (a, b) => b.updatedAt - a.updatedAt,
    );
  }
  const childUpdatedAt = Math.max(
    0,
    ...sessions.map((session) => session.updatedAt),
    ...chunks.map((chunk) => chunk.updatedAt),
  );
  return {
    schemaVersion: BROWSER_GATEWAY_ASK_AGENT_MEMORY_SCHEMA_VERSION,
    updatedAt: Math.max(sanitizeNumber(candidate.updatedAt, 0), childUpdatedAt),
    sessions,
    chunks,
  };
}

async function readMemoryFile(
  filePath: string,
  options: { maxSessions?: number; maxChunks?: number },
): Promise<BrowserGatewayAskAgentMemorySnapshot> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return normalizeAskAgentMemorySnapshot(JSON.parse(raw) as unknown, options);
  } catch {
    return normalizeAskAgentMemorySnapshot(null, options);
  }
}

async function writeMemoryFile(
  filePath: string,
  snapshot: BrowserGatewayAskAgentMemorySnapshot,
  options: { maxSessions?: number; maxChunks?: number },
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const normalized = normalizeAskAgentMemorySnapshot(snapshot, options);
  const tmpPath = `${filePath}.tmp.${process.pid}.${randomUUID()}`;
  await fs.writeFile(tmpPath, JSON.stringify(normalized, null, 2) + "\n", {
    encoding: "utf-8",
    mode: 0o600,
  });
  await fs.rename(tmpPath, filePath);
}

async function withMemoryFileLock<T>(
  filePath: string,
  task: () => Promise<T>,
): Promise<T> {
  const lockPath = `${filePath}.lock`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  let handle: fs.FileHandle | null = null;
  for (let attempt = 0; attempt < LOCK_RETRY_ATTEMPTS; attempt += 1) {
    try {
      handle = await fs.open(lockPath, "wx", 0o600);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      await sleep(LOCK_RETRY_DELAY_MS);
    }
  }
  if (!handle) {
    throw new Error("browser_gateway_ask_agent_memory_lock_timeout");
  }
  try {
    await handle.writeFile(`${process.pid}\n`, "utf-8");
    return await task();
  } finally {
    await handle.close().catch(() => undefined);
    await fs.rm(lockPath, { force: true }).catch(() => undefined);
  }
}

function overlapRatio(
  queryTokens: readonly string[],
  targetTokens: readonly string[],
): number {
  if (queryTokens.length === 0 || targetTokens.length === 0) return 0;
  const target = new Set(targetTokens);
  let overlap = 0;
  for (const token of queryTokens) {
    if (target.has(token)) overlap += 1;
  }
  return overlap / Math.min(queryTokens.length, target.size);
}

function recencyBoost(updatedAt: number, now: number): number {
  if (!updatedAt || !now || updatedAt > now) return 0;
  const ageDays = (now - updatedAt) / 86_400_000;
  if (ageDays <= 1) return 1;
  if (ageDays >= 30) return 0;
  return 1 - ageDays / 30;
}

function metadataMatchRatio(
  queryTokens: readonly string[],
  metadata: readonly string[],
): number {
  return overlapRatio(
    queryTokens,
    tokenizeAskAgentMemoryText(metadata.join(" ")),
  );
}

function calculateMemoryScore(params: {
  queryTokens: readonly string[];
  summary: string;
  metadata: readonly string[];
  updatedAt: number;
  explicitPastIntent: boolean;
  now: number;
}): number {
  const summaryTokens = tokenizeAskAgentMemoryText(params.summary);
  const keywordScore = overlapRatio(params.queryTokens, [
    ...summaryTokens,
    ...tokenizeAskAgentMemoryText(params.metadata.join(" ")),
  ]);
  const metadataScore = metadataMatchRatio(params.queryTokens, params.metadata);
  const explicitPastIntentBoost = params.explicitPastIntent ? 1 : 0;
  return (
    0.55 * keywordScore +
    0.25 * metadataScore +
    0.15 * explicitPastIntentBoost +
    0.05 * recencyBoost(params.updatedAt, params.now)
  );
}

function hasSpecificQueryOverlap(
  queryTokens: readonly string[],
  targetText: string,
  metadata: readonly string[],
): boolean {
  if (queryTokens.length <= 3) return true;
  return (
    overlapRatio(queryTokens, [
      ...tokenizeAskAgentMemoryText(targetText),
      ...tokenizeAskAgentMemoryText(metadata.join(" ")),
    ]) > 0
  );
}

function chunkSpecificityBoost(
  queryTokens: readonly string[],
  chunk: BrowserGatewayAskAgentMemoryChunk,
): number {
  const keywordOverlap = overlapRatio(
    queryTokens,
    tokenizeAskAgentMemoryText(chunk.keywords.join(" ")),
  );
  return keywordOverlap > 0 ? Math.min(0.08, keywordOverlap * 0.08) : 0;
}

export function searchAskAgentMemory(
  snapshot: BrowserGatewayAskAgentMemorySnapshot,
  query: string,
  options: BrowserGatewayAskAgentMemorySearchOptions = {},
): BrowserGatewayAskAgentMemorySearchResult[] {
  const normalized = normalizeAskAgentMemorySnapshot(snapshot);
  const baseQueryTokens = tokenizeAskAgentMemoryText(query);
  const queryTokens = hasAskAgentIdentityMemoryIntent(query)
    ? [...new Set([...baseQueryTokens, "name", "nickname", "identity"])]
    : baseQueryTokens;
  if (queryTokens.length === 0) return [];
  const explicitPastIntent = hasAskAgentMemoryPastIntent(query);
  const minScore = explicitPastIntent
    ? (options.explicitPastMinScore ?? 0.14)
    : (options.minScore ?? 0.22);
  const now = options.now ?? Date.now();
  const recentMessageIds = new Set(options.recentMessageIds ?? []);
  const results: BrowserGatewayAskAgentMemorySearchResult[] = [];

  for (const session of normalized.sessions) {
    const metadata = [
      session.title,
      ...session.topics,
      ...session.decisions,
      ...session.openQuestions,
      ...session.durableCandidateHints,
    ];
    if (
      explicitPastIntent &&
      !hasSpecificQueryOverlap(queryTokens, session.summary, metadata)
    ) {
      continue;
    }
    const score = calculateMemoryScore({
      queryTokens,
      summary: session.summary,
      metadata,
      updatedAt: session.updatedAt,
      explicitPastIntent,
      now,
    });
    if (score < minScore) continue;
    results.push({
      kind: "session",
      sessionId: session.sessionId,
      title: session.title,
      summary: session.summary,
      score,
      sourceMessageIds: [],
      updatedAt: session.updatedAt,
    });
  }

  for (const chunk of normalized.chunks) {
    if (
      chunk.sessionId === options.activeSessionId &&
      chunk.sourceMessageIds.length > 0 &&
      chunk.sourceMessageIds.every((messageId) =>
        recentMessageIds.has(messageId),
      )
    ) {
      continue;
    }
    const session = normalized.sessions.find(
      (candidate) => candidate.sessionId === chunk.sessionId,
    );
    const metadata = [
      session?.title ?? "",
      ...chunk.keywords,
      ...chunk.entities,
    ];
    if (
      explicitPastIntent &&
      !hasSpecificQueryOverlap(queryTokens, chunk.summary, metadata)
    ) {
      continue;
    }
    const score =
      calculateMemoryScore({
        queryTokens,
        summary: chunk.summary,
        metadata,
        updatedAt: chunk.updatedAt,
        explicitPastIntent,
        now,
      }) + chunkSpecificityBoost(queryTokens, chunk);
    if (score < minScore) continue;
    results.push({
      kind: "chunk",
      sessionId: chunk.sessionId,
      chunkId: chunk.id,
      title: session?.title,
      summary: chunk.summary,
      score,
      sourceMessageIds: chunk.sourceMessageIds,
      startMessageIndex: chunk.startMessageIndex,
      endMessageIndex: chunk.endMessageIndex,
      updatedAt: chunk.updatedAt,
    });
  }

  return results
    .sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt)
    .slice(0, options.limit ?? 5);
}

export class BrowserGatewayAskAgentMemoryStore {
  private readonly filePath: string;
  private readonly maxSessions: number;
  private readonly maxChunks: number;
  private pending: Promise<void> = Promise.resolve();

  constructor(options: BrowserGatewayAskAgentMemoryStoreOptions = {}) {
    this.filePath = options.filePath ?? MEMORY_PATH;
    this.maxSessions = options.maxSessions ?? 200;
    this.maxChunks = options.maxChunks ?? 2_000;
  }

  getPath(): string {
    return this.filePath;
  }

  async read(): Promise<BrowserGatewayAskAgentMemorySnapshot> {
    await this.pending.catch(() => undefined);
    return await readMemoryFile(this.filePath, {
      maxSessions: this.maxSessions,
      maxChunks: this.maxChunks,
    });
  }

  async write(snapshot: BrowserGatewayAskAgentMemorySnapshot): Promise<void> {
    await this.enqueue(async () => {
      await withMemoryFileLock(this.filePath, async () => {
        await writeMemoryFile(this.filePath, snapshot, {
          maxSessions: this.maxSessions,
          maxChunks: this.maxChunks,
        });
      });
    });
  }

  async update(
    mutate: (
      snapshot: BrowserGatewayAskAgentMemorySnapshot,
    ) => BrowserGatewayAskAgentMemorySnapshot | void,
  ): Promise<BrowserGatewayAskAgentMemorySnapshot> {
    let result = normalizeAskAgentMemorySnapshot(null, {
      maxSessions: this.maxSessions,
      maxChunks: this.maxChunks,
    });
    await this.enqueue(async () => {
      await withMemoryFileLock(this.filePath, async () => {
        const current = await readMemoryFile(this.filePath, {
          maxSessions: this.maxSessions,
          maxChunks: this.maxChunks,
        });
        const mutated = mutate(current) ?? current;
        result = normalizeAskAgentMemorySnapshot(mutated, {
          maxSessions: this.maxSessions,
          maxChunks: this.maxChunks,
        });
        await writeMemoryFile(this.filePath, result, {
          maxSessions: this.maxSessions,
          maxChunks: this.maxChunks,
        });
      });
    });
    return result;
  }

  async upsertSessionMemory(
    session: BrowserGatewayAskAgentSessionMemory,
  ): Promise<BrowserGatewayAskAgentMemorySnapshot> {
    return await this.update((snapshot) => {
      const sessions = snapshot.sessions.filter(
        (candidate) => candidate.sessionId !== session.sessionId,
      );
      sessions.push(session);
      return {
        ...snapshot,
        updatedAt: Math.max(snapshot.updatedAt, session.updatedAt),
        sessions,
      };
    });
  }

  async upsertChunk(
    chunk: BrowserGatewayAskAgentMemoryChunk,
  ): Promise<BrowserGatewayAskAgentMemorySnapshot> {
    return await this.update((snapshot) => {
      const chunks = snapshot.chunks.filter(
        (candidate) => candidate.id !== chunk.id,
      );
      chunks.push(chunk);
      return {
        ...snapshot,
        updatedAt: Math.max(snapshot.updatedAt, chunk.updatedAt),
        chunks,
      };
    });
  }

  async deleteSessionMemory(
    sessionId: string,
  ): Promise<BrowserGatewayAskAgentMemorySnapshot> {
    return await this.update((snapshot) => ({
      ...snapshot,
      updatedAt: Date.now(),
      sessions: snapshot.sessions.filter(
        (session) => session.sessionId !== sessionId,
      ),
      chunks: snapshot.chunks.filter((chunk) => chunk.sessionId !== sessionId),
    }));
  }

  async clear(): Promise<BrowserGatewayAskAgentMemorySnapshot> {
    return await this.update((snapshot) => ({
      ...snapshot,
      updatedAt: Date.now(),
      sessions: [],
      chunks: [],
    }));
  }

  async search(
    query: string,
    options: BrowserGatewayAskAgentMemorySearchOptions = {},
  ): Promise<BrowserGatewayAskAgentMemorySearchResult[]> {
    return searchAskAgentMemory(await this.read(), query, options);
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.pending.then(task, task);
    this.pending = next.catch(() => undefined);
    return next;
  }
}
