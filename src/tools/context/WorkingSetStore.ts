import { readFile, stat } from "node:fs/promises";

import { createHash } from "node:crypto";
import path from "node:path";

export type WorkingSetStatus =
  | "new"
  | "unchanged"
  | "changed"
  | "omitted_unchanged";

export interface WorkingSetRange {
  startLine: number;
  endLine: number;
}

export interface WorkingSetCheckOptions {
  sessionId: string;
  path: string;
  range?: WorkingSetRange;
  deriveRange?: (contentBytes: Buffer) => WorkingSetRange;
  dedupeUnchangedContent?: boolean;
  refresh?: boolean;
  now?: number;
}

export interface WorkingSetCheckResult {
  path: string;
  status: WorkingSetStatus;
  contentHash: string;
  previousContentHash?: string;
  size: number;
  modifiedMs: number;
  lastReadAt: number;
  shouldIncludeContent: boolean;
  contentBytes: Buffer;
  range?: WorkingSetRange;
  note?: string;
}

export interface WorkingSetStoreOptions {
  maxSessions?: number;
  maxFilesPerSession?: number;
}

interface WorkingSetEntry {
  path: string;
  contentHash: string;
  size: number;
  modifiedMs: number;
  lastReadAt: number;
  returnedRangeKeys: Set<string>;
}

interface WorkingSetSession {
  files: Map<string, WorkingSetEntry>;
  lastAccessedAt: number;
}

const DEFAULT_MAX_SESSIONS = 32;
const DEFAULT_MAX_FILES_PER_SESSION = 200;
const FULL_FILE_RANGE_KEY = "full";

export class WorkingSetStore {
  private readonly maxSessions: number;
  private readonly maxFilesPerSession: number;
  private readonly sessions = new Map<string, WorkingSetSession>();

  constructor(options: WorkingSetStoreOptions = {}) {
    this.maxSessions = positiveIntegerOrDefault(
      options.maxSessions,
      DEFAULT_MAX_SESSIONS,
    );
    this.maxFilesPerSession = positiveIntegerOrDefault(
      options.maxFilesPerSession,
      DEFAULT_MAX_FILES_PER_SESSION,
    );
  }

  async check(options: WorkingSetCheckOptions): Promise<WorkingSetCheckResult> {
    const now = options.now ?? Date.now();
    const absolutePath = path.resolve(options.path);
    const [bytes, stats] = await Promise.all([
      readFile(absolutePath),
      stat(absolutePath),
    ]);
    const range = options.deriveRange?.(bytes) ?? options.range;
    const rangeKey = getRangeKey(range);
    const contentHash = hashBytes(bytes);

    const session = this.getOrCreateSession(options.sessionId, now);
    const previous = session.files.get(absolutePath);
    const isUnchanged = previous?.contentHash === contentHash;
    const previouslyReturnedRange =
      previous?.returnedRangeKeys.has(rangeKey) ?? false;

    let status: WorkingSetStatus;
    let shouldIncludeContent = true;
    let previousContentHash: string | undefined;
    let note: string | undefined;

    if (!previous) {
      status = "new";
    } else if (!isUnchanged) {
      status = "changed";
      previousContentHash = previous.contentHash;
    } else if (
      options.dedupeUnchangedContent === true &&
      options.refresh !== true &&
      previouslyReturnedRange
    ) {
      status = "omitted_unchanged";
      shouldIncludeContent = false;
      note =
        "Content omitted because this unchanged range was already returned in the session.";
    } else {
      status = "unchanged";
    }

    const returnedRangeKeys =
      previous && isUnchanged ? previous.returnedRangeKeys : new Set<string>();
    if (shouldIncludeContent) {
      returnedRangeKeys.add(rangeKey);
    }

    session.files.delete(absolutePath);
    session.files.set(absolutePath, {
      path: absolutePath,
      contentHash,
      size: stats.size,
      modifiedMs: stats.mtimeMs,
      lastReadAt: now,
      returnedRangeKeys,
    });
    session.lastAccessedAt = now;

    this.sessions.delete(options.sessionId);
    this.sessions.set(options.sessionId, session);
    this.evictFiles(session);
    this.evictSessions();

    return {
      path: absolutePath,
      status,
      contentHash,
      previousContentHash,
      size: stats.size,
      modifiedMs: stats.mtimeMs,
      lastReadAt: now,
      shouldIncludeContent,
      contentBytes: bytes,
      range,
      note,
    };
  }

  clearSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  clear(): void {
    this.sessions.clear();
  }

  getSessionCount(): number {
    return this.sessions.size;
  }

  getFileCount(sessionId: string): number {
    return this.sessions.get(sessionId)?.files.size ?? 0;
  }

  private getOrCreateSession(
    sessionId: string,
    now: number,
  ): WorkingSetSession {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      existing.lastAccessedAt = now;
      this.sessions.delete(sessionId);
      this.sessions.set(sessionId, existing);
      return existing;
    }

    const session: WorkingSetSession = {
      files: new Map(),
      lastAccessedAt: now,
    };
    this.sessions.set(sessionId, session);
    return session;
  }

  private evictFiles(session: WorkingSetSession): void {
    while (session.files.size > this.maxFilesPerSession) {
      const oldestFilePath = session.files.keys().next().value;
      if (oldestFilePath === undefined) {
        return;
      }
      session.files.delete(oldestFilePath);
    }
  }

  private evictSessions(): void {
    while (this.sessions.size > this.maxSessions) {
      const oldestSessionId = this.sessions.keys().next().value;
      if (oldestSessionId === undefined) {
        return;
      }
      this.sessions.delete(oldestSessionId);
    }
  }
}

// Dedupe is exact-range only: overlapping ranges and full-file reads are tracked
// independently so callers never lose content they did not explicitly receive.
function getRangeKey(range: WorkingSetRange | undefined): string {
  if (!range) {
    return FULL_FILE_RANGE_KEY;
  }
  return `${range.startLine}:${range.endLine}`;
}

function hashBytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function positiveIntegerOrDefault(
  value: number | undefined,
  fallback: number,
): number {
  if (value === undefined || !Number.isInteger(value) || value <= 0) {
    return fallback;
  }
  return value;
}
