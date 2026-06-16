import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

import type { AgentMessage, SessionInfo } from "./types.js";
import type {
  CheckpointState,
  PersistResult,
  PersistedSessionMetadata,
  PersistedSessionRecord,
  PersistenceRevision,
  RevertRecoveryState,
  SessionPersistenceIdentity,
  SessionPersistenceProvider,
  SessionRead,
  SessionReadResult,
} from "./persistenceContracts.js";
import {
  DEFAULT_SESSION_TITLE,
  buildSessionTitleFromUserText,
} from "./sessionTitle.js";

import type { Checkpoint } from "./CheckpointManager.js";

/**
 * Persisted session index entry — lightweight metadata kept in sessions.json.
 * Full message history lives in {sessionId}/messages.json.
 */
export interface SessionSummary {
  schemaVersion: number;
  id: string;
  mode: string;
  model: string;
  title: string;
  messageCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  createdAt: number;
  lastActiveAt: number;
  /**
   * True for background-agent sessions. Hidden from end-user session history.
   * Optional for backward compatibility with old persisted entries.
   */
  background?: boolean;
}

interface MessagesFile {
  schemaVersion: number;
  messages: AgentMessage[];
}

interface MetadataFile {
  schemaVersion: number;
  revision?: PersistenceRevision;
  summary?: SessionSummary;
  mode: string;
  model: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens?: number;
  totalCacheCreationTokens?: number;
  lastInputTokens?: number;
  lastCacheReadTokens?: number;
  reasoningEffort?: import("./providers/types.js").ReasoningEffort;
  loadedSkills?: string[];
  checkpoints?: Checkpoint[];
  checkpointState?: CheckpointState;
  revertPending?: RevertRecoveryState;
}

// Narrow seam for testing atomic JSON writes without mocking Node's ESM `fs`
// namespace. Non-atomic reads/deletes intentionally continue to call `fs`.
interface SessionStoreAtomicFileOps {
  openSync(path: fs.PathLike, flags: string | number): number;
  writeFileSync(file: number, data: string, options: fs.WriteFileOptions): void;
  fsyncSync(fd: number): void;
  closeSync(fd: number): void;
  renameSync(oldPath: fs.PathLike, newPath: fs.PathLike): void;
  rmSync(path: fs.PathLike, options: fs.RmOptions): void;
}

const SCHEMA_VERSION = 1;
const SESSIONS_FILE = "sessions.json";
const AGENTLINK_GITIGNORE_ENTRIES = [
  "history/",
  "transcripts/",
  "debug/",
  "checkpoints/",
] as const;

/**
 * Persists agent sessions to .agentlink/history/{sessionId}/.
 *
 * Layout:
 *   .agentlink/history/sessions.json          — session index
 *   .agentlink/history/{id}/messages.json     — full message history
 *   .agentlink/history/{id}/metadata.json     — mode, model, token totals
 */
export class SessionStore implements SessionPersistenceProvider {
  readonly identity: SessionPersistenceIdentity;

  private readonly historyDir: string;
  private readonly sessionsFile: string;
  private readonly atomicFileOps: SessionStoreAtomicFileOps;
  /** In-memory index — updated on every save/delete/rename */
  private index: Map<string, SessionSummary> = new Map();
  private indexLoadState:
    | { ok: true }
    | { ok: false; reason: "corrupt" | "io_error"; message: string } = {
    ok: true,
  };

  constructor(
    workspaceDir: string,
    identity: SessionPersistenceIdentity = {
      ownerId: "vscode-extension",
      surface: "vscode",
      startedAt: Date.now(),
    },
    atomicFileOps: SessionStoreAtomicFileOps = fs,
  ) {
    this.identity = identity;
    this.atomicFileOps = atomicFileOps;
    this.historyDir = path.join(workspaceDir, ".agentlink", "history");
    this.sessionsFile = path.join(this.historyDir, SESSIONS_FILE);
    this.ensureGitignore(path.join(workspaceDir, ".agentlink"));
    this.loadIndex();
  }

  // ---------------------------------------------------------------------------
  // Index management
  // ---------------------------------------------------------------------------

  private loadIndex(): void {
    try {
      const raw = fs.readFileSync(this.sessionsFile, "utf-8");
      const parsed = JSON.parse(raw) as SessionSummary[];
      if (!Array.isArray(parsed)) {
        this.indexLoadState = {
          ok: false,
          reason: "corrupt",
          message: "sessions.json must contain an array",
        };
        this.rebuildIndex();
        return;
      }

      let didMigrateTitles = false;
      const normalized = parsed.map((s) => {
        const migratedTitle = buildSessionTitleFromUserText(s.title);
        const nextTitle = migratedTitle ?? DEFAULT_SESSION_TITLE;
        if (nextTitle !== s.title) {
          didMigrateTitles = true;
          return { ...s, title: nextTitle };
        }
        return s;
      });
      this.index = new Map(normalized.map((s) => [s.id, s]));
      this.indexLoadState = { ok: true };
      if (didMigrateTitles) {
        this.flushIndex();
      }
    } catch (error) {
      if (this.isNotFoundError(error)) {
        this.indexLoadState = { ok: true };
        this.rebuildIndex();
        return;
      }
      this.indexLoadState = {
        ok: false,
        reason: error instanceof SyntaxError ? "corrupt" : "io_error",
        message: error instanceof Error ? error.message : String(error),
      };
      this.rebuildIndex();
    }
  }

  private flushIndex(): void {
    this.ensureDir(this.historyDir);
    const arr = Array.from(this.index.values()).sort(
      (a, b) => b.lastActiveAt - a.lastActiveAt,
    );
    this.writeJsonFileAtomic(this.sessionsFile, arr);
    this.indexLoadState = { ok: true };
  }

  private rebuildIndex(): void {
    const rebuilt = new Map<string, SessionSummary>();
    let sawUnrebuildableSession = false;
    try {
      const entries = fs.readdirSync(this.historyDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const metadataResult = this.readMetadataFile(entry.name);
        if (!metadataResult.ok) continue;

        const summary = metadataResult.value.summary;
        if (!summary || summary.id !== entry.name) {
          sawUnrebuildableSession = true;
          continue;
        }

        rebuilt.set(summary.id, summary);
      }
    } catch (error) {
      if (!this.isNotFoundError(error) && this.indexLoadState.ok) {
        this.indexLoadState = {
          ok: false,
          reason: "io_error",
          message: error instanceof Error ? error.message : String(error),
        };
      }
    }

    this.index = rebuilt;
    if (
      this.indexLoadState.ok ||
      (rebuilt.size > 0 && !sawUnrebuildableSession)
    ) {
      this.flushIndex();
    }
  }

  private indexRevision(): PersistenceRevision {
    return String(
      Array.from(this.index.values()).reduce(
        (max, summary) => Math.max(max, summary.lastActiveAt),
        0,
      ),
    );
  }

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  async listSessions(): Promise<SessionRead<SessionSummary[]>> {
    return { value: this.list(), revision: this.indexRevision() };
  }

  async readSession(
    sessionId: string,
  ): Promise<SessionReadResult<PersistedSessionRecord>> {
    const summary = this.index.get(sessionId);
    if (!summary) return { ok: false, reason: "not_found" };

    const messagesResult = this.readMessagesFile(sessionId);
    if (!messagesResult.ok) return messagesResult;

    const metadataResult = this.readMetadataFile(sessionId);
    if (!metadataResult.ok) return metadataResult;

    const metadata = this.metadataFileToRecord(metadataResult.value);
    return {
      ok: true,
      value: {
        summary,
        messages: messagesResult.value.messages,
        metadata,
      },
      revision: metadataResult.value.revision ?? "0",
    };
  }

  async saveSession(args: {
    session: PersistedSessionRecord;
    expectedRevision: PersistenceRevision | null;
  }): Promise<PersistResult> {
    const currentRevisionResult = this.readCurrentRevision(
      args.session.summary.id,
    );
    if (
      !currentRevisionResult.ok &&
      currentRevisionResult.reason === "corrupt"
    ) {
      return currentRevisionResult;
    }
    if (
      !currentRevisionResult.ok &&
      currentRevisionResult.reason === "io_error"
    ) {
      return currentRevisionResult;
    }

    if (args.expectedRevision === null) {
      if (currentRevisionResult.ok) {
        return {
          ok: false,
          reason: "conflict",
          currentRevision: currentRevisionResult.revision,
        };
      }
    } else if (!currentRevisionResult.ok) {
      return { ok: false, reason: "not_found" };
    } else if (currentRevisionResult.revision !== args.expectedRevision) {
      return {
        ok: false,
        reason: "conflict",
        currentRevision: currentRevisionResult.revision,
      };
    }

    try {
      const nextRevision = this.nextRevision(currentRevisionResult);
      this.writeSessionRecord(args.session, nextRevision);
      return { ok: true, revision: nextRevision };
    } catch (error) {
      return {
        ok: false,
        reason: "io_error",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async renameSession(args: {
    sessionId: string;
    title: string;
    expectedRevision: PersistenceRevision;
  }): Promise<PersistResult> {
    const readResult = await this.readSession(args.sessionId);
    if (!readResult.ok) return readResult;
    if (readResult.revision !== args.expectedRevision) {
      return {
        ok: false,
        reason: "conflict",
        currentRevision: readResult.revision,
      };
    }

    return this.saveSession({
      session: {
        ...readResult.value,
        summary: { ...readResult.value.summary, title: args.title },
      },
      expectedRevision: args.expectedRevision,
    });
  }

  async deleteSession(args: {
    sessionId: string;
    expectedRevision: PersistenceRevision;
  }): Promise<PersistResult> {
    const currentRevisionResult = this.readCurrentRevision(args.sessionId);
    if (!currentRevisionResult.ok && currentRevisionResult.reason === "corrupt")
      return currentRevisionResult;
    if (
      !currentRevisionResult.ok &&
      currentRevisionResult.reason === "io_error"
    )
      return currentRevisionResult;
    if (!currentRevisionResult.ok) return { ok: false, reason: "not_found" };
    if (currentRevisionResult.revision !== args.expectedRevision) {
      return {
        ok: false,
        reason: "conflict",
        currentRevision: currentRevisionResult.revision,
      };
    }

    const deleted = this.delete(args.sessionId);
    return deleted
      ? { ok: true, revision: currentRevisionResult.revision }
      : { ok: false, reason: "not_found" };
  }

  /**
   * Save/update a session to disk.
   * Called after each API response (on `done` event) and after condensing.
   */
  save(session: {
    id: string;
    mode: string;
    model: string;
    title: string;
    createdAt: number;
    lastActiveAt: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCacheReadTokens: number;
    totalCacheCreationTokens: number;
    lastInputTokens: number;
    lastCacheReadTokens: number;
    reasoningEffort?: import("./providers/types.js").ReasoningEffort;
    background?: boolean;
    getLoadedSkills?(): string[];
    getAllMessages(): AgentMessage[];
    checkpoints?: Checkpoint[];
  }): void {
    const messages = session.getAllMessages();
    const currentRevisionResult = this.readCurrentRevision(session.id);
    const nextRevision = this.nextRevision(currentRevisionResult);
    this.writeSessionRecord(
      {
        summary: {
          schemaVersion: SCHEMA_VERSION,
          id: session.id,
          mode: session.mode,
          model: session.model,
          title: session.title,
          messageCount: messages.length,
          totalInputTokens: session.totalInputTokens,
          totalOutputTokens: session.totalOutputTokens,
          createdAt: session.createdAt,
          lastActiveAt: session.lastActiveAt,
          background: session.background,
        },
        messages,
        metadata: {
          mode: session.mode,
          model: session.model,
          totalInputTokens: session.totalInputTokens,
          totalOutputTokens: session.totalOutputTokens,
          totalCacheReadTokens: session.totalCacheReadTokens,
          totalCacheCreationTokens: session.totalCacheCreationTokens,
          lastInputTokens: session.lastInputTokens,
          lastCacheReadTokens: session.lastCacheReadTokens,
          reasoningEffort: session.reasoningEffort,
          loadedSkills: session.getLoadedSkills?.() ?? [],
          checkpointState: session.checkpoints
            ? { baseCommit: null, checkpoints: session.checkpoints }
            : undefined,
        },
      },
      nextRevision,
    );
  }

  // ---------------------------------------------------------------------------
  // Read
  // ---------------------------------------------------------------------------

  /**
   * List persisted foreground sessions, sorted by lastActiveAt descending.
   * Background-agent sessions are intentionally excluded from session history UI.
   */
  list(): SessionSummary[] {
    return Array.from(this.index.values())
      .filter((s) => !s.background)
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  }

  /**
   * Load full message history for a session.
   * Returns null if the session doesn't exist or files are corrupt.
   */
  loadMessages(sessionId: string): AgentMessage[] | null {
    const file = path.join(this.historyDir, sessionId, "messages.json");
    try {
      const raw = fs.readFileSync(file, "utf-8");
      const parsed = JSON.parse(raw) as MessagesFile;
      return parsed.messages ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Load metadata for a session.
   */
  loadMetadata(
    sessionId: string,
  ): (MetadataFile & { checkpoints?: Checkpoint[] }) | null {
    const result = this.readMetadataFile(sessionId);
    if (!result.ok) return null;
    return this.metadataFileWithLegacyCheckpoints(result.value);
  }

  get(sessionId: string): SessionSummary | undefined {
    return this.index.get(sessionId);
  }

  // ---------------------------------------------------------------------------
  // Internal read/write helpers
  // ---------------------------------------------------------------------------

  private readMessagesFile(
    sessionId: string,
  ):
    | { ok: true; value: MessagesFile }
    | { ok: false; reason: "not_found" }
    | { ok: false; reason: "corrupt" | "io_error"; message: string } {
    const file = path.join(this.historyDir, sessionId, "messages.json");
    try {
      const raw = fs.readFileSync(file, "utf-8");
      const parsed = JSON.parse(raw) as MessagesFile;
      if (!Array.isArray(parsed.messages)) {
        return {
          ok: false,
          reason: "corrupt",
          message: `Invalid messages file for session ${sessionId}`,
        };
      }
      return { ok: true, value: parsed };
    } catch (error) {
      if (this.isNotFoundError(error))
        return { ok: false, reason: "not_found" };
      if (error instanceof SyntaxError) {
        return {
          ok: false,
          reason: "corrupt",
          message: error.message,
        };
      }
      return {
        ok: false,
        reason: "io_error",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private readMetadataFile(
    sessionId: string,
  ):
    | { ok: true; value: MetadataFile }
    | { ok: false; reason: "not_found" }
    | { ok: false; reason: "corrupt" | "io_error"; message: string } {
    const file = path.join(this.historyDir, sessionId, "metadata.json");
    try {
      const raw = fs.readFileSync(file, "utf-8");
      const parsed = JSON.parse(raw) as MetadataFile;
      if (typeof parsed.mode !== "string" || typeof parsed.model !== "string") {
        return {
          ok: false,
          reason: "corrupt",
          message: `Invalid metadata file for session ${sessionId}`,
        };
      }
      return { ok: true, value: parsed };
    } catch (error) {
      if (this.isNotFoundError(error))
        return { ok: false, reason: "not_found" };
      if (error instanceof SyntaxError) {
        return {
          ok: false,
          reason: "corrupt",
          message: error.message,
        };
      }
      return {
        ok: false,
        reason: "io_error",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private readCurrentRevision(
    sessionId: string,
  ):
    | { ok: true; revision: PersistenceRevision }
    | { ok: false; reason: "not_found" }
    | { ok: false; reason: "corrupt" | "io_error"; message: string } {
    const metadataResult = this.readMetadataFile(sessionId);
    if (metadataResult.ok) {
      return { ok: true, revision: metadataResult.value.revision ?? "0" };
    }
    if (
      metadataResult.reason === "corrupt" ||
      metadataResult.reason === "io_error"
    ) {
      return metadataResult;
    }
    return { ok: false, reason: "not_found" };
  }

  private nextRevision(
    currentRevisionResult:
      | { ok: true; revision: PersistenceRevision }
      | { ok: false; reason: "not_found" }
      | { ok: false; reason: "corrupt" | "io_error"; message: string },
  ): PersistenceRevision {
    if (!currentRevisionResult.ok) return "1";
    const numericRevision = Number(currentRevisionResult.revision);
    if (Number.isSafeInteger(numericRevision) && numericRevision >= 0) {
      return String(numericRevision + 1);
    }
    return `${Date.now()}`;
  }

  private writeSessionRecord(
    record: PersistedSessionRecord,
    revision: PersistenceRevision,
  ): void {
    // Persist messages before metadata so a durable metadata revision never
    // references transcript bytes that have not already been flushed.
    // `sessions.json` is a derived index and can be rebuilt from metadata.
    const sessionDir = path.join(this.historyDir, record.summary.id);
    this.ensureDir(sessionDir);

    const messagesFile: MessagesFile = {
      schemaVersion: SCHEMA_VERSION,
      messages: record.messages,
    };
    this.writeJsonFileAtomic(
      path.join(sessionDir, "messages.json"),
      messagesFile,
    );

    const metadataFile = this.recordMetadataToFile(
      record.metadata,
      revision,
      record.summary,
    );
    this.writeJsonFileAtomic(
      path.join(sessionDir, "metadata.json"),
      metadataFile,
    );

    this.index.set(record.summary.id, record.summary);
    this.flushIndex();
  }

  private metadataFileToRecord(file: MetadataFile): PersistedSessionMetadata {
    return {
      mode: file.mode,
      model: file.model,
      totalInputTokens: file.totalInputTokens,
      totalOutputTokens: file.totalOutputTokens,
      totalCacheReadTokens: file.totalCacheReadTokens,
      totalCacheCreationTokens: file.totalCacheCreationTokens,
      lastInputTokens: file.lastInputTokens,
      lastCacheReadTokens: file.lastCacheReadTokens,
      reasoningEffort: file.reasoningEffort,
      loadedSkills: file.loadedSkills,
      checkpointState: file.checkpointState ?? {
        baseCommit: null,
        checkpoints: file.checkpoints ?? [],
      },
      revertPending: file.revertPending,
    };
  }

  private recordMetadataToFile(
    metadata: PersistedSessionMetadata,
    revision: PersistenceRevision,
    summary: SessionSummary,
  ): MetadataFile {
    // `checkpointState` is the source of truth for the revision-aware aggregate.
    // Keep writing legacy `checkpoints` during the compatibility window so older
    // sync readers continue to see checkpoint metadata.
    const checkpoints = metadata.checkpointState?.checkpoints;
    return {
      schemaVersion: SCHEMA_VERSION,
      revision,
      summary,
      mode: metadata.mode,
      model: metadata.model,
      totalInputTokens: metadata.totalInputTokens,
      totalOutputTokens: metadata.totalOutputTokens,
      totalCacheReadTokens: metadata.totalCacheReadTokens,
      totalCacheCreationTokens: metadata.totalCacheCreationTokens,
      lastInputTokens: metadata.lastInputTokens,
      lastCacheReadTokens: metadata.lastCacheReadTokens,
      reasoningEffort: metadata.reasoningEffort,
      loadedSkills: metadata.loadedSkills,
      checkpoints,
      checkpointState: metadata.checkpointState,
      revertPending: metadata.revertPending,
    };
  }

  private writeJsonFileAtomic(filePath: string, value: unknown): void {
    const dir = path.dirname(filePath);
    this.ensureDir(dir);
    const tempPath = path.join(
      dir,
      `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp`,
    );
    let shouldRemoveTemp = true;
    let fd: number | undefined;
    try {
      fd = this.atomicFileOps.openSync(tempPath, "w");
      this.atomicFileOps.writeFileSync(
        fd,
        `${JSON.stringify(value)}\n`,
        "utf-8",
      );
      this.atomicFileOps.fsyncSync(fd);
      this.atomicFileOps.closeSync(fd);
      fd = undefined;

      this.atomicFileOps.renameSync(tempPath, filePath);
      shouldRemoveTemp = false;
      this.fsyncDirectoryBestEffort(dir);
    } finally {
      if (fd !== undefined) {
        try {
          this.atomicFileOps.closeSync(fd);
        } catch {
          // Best-effort cleanup.
        }
      }
      if (shouldRemoveTemp) {
        try {
          this.atomicFileOps.rmSync(tempPath, { force: true });
        } catch {
          // Best-effort cleanup.
        }
      }
    }
  }

  private fsyncDirectoryBestEffort(dir: string): void {
    let dirFd: number | undefined;
    try {
      dirFd = this.atomicFileOps.openSync(dir, "r");
      this.atomicFileOps.fsyncSync(dirFd);
    } catch {
      // Some file systems/platforms do not allow fsync on directories.
    } finally {
      if (dirFd !== undefined) {
        try {
          this.atomicFileOps.closeSync(dirFd);
        } catch {
          // Best-effort cleanup.
        }
      }
    }
  }

  private metadataFileWithLegacyCheckpoints(
    file: MetadataFile,
  ): MetadataFile & { checkpoints?: Checkpoint[] } {
    return {
      ...file,
      checkpoints: file.checkpoints ?? file.checkpointState?.checkpoints,
    };
  }

  private isNotFoundError(error: unknown): boolean {
    return (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    );
  }

  // ---------------------------------------------------------------------------
  // Mutations
  // ---------------------------------------------------------------------------

  rename(sessionId: string, title: string): boolean {
    const entry = this.index.get(sessionId);
    if (!entry) return false;
    entry.title = title;
    this.index.set(sessionId, entry);
    this.flushIndex();
    return true;
  }

  delete(sessionId: string): boolean {
    if (!this.index.has(sessionId)) return false;
    this.index.delete(sessionId);
    this.flushIndex();

    // Remove session directory
    const sessionDir = path.join(this.historyDir, sessionId);
    try {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    } catch {
      // Best-effort
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private ensureDir(dir: string): void {
    fs.mkdirSync(dir, { recursive: true });
  }

  /**
   * Ensure .agentlink/.gitignore includes required runtime folders so generated
   * artifacts are never committed.
   */
  private ensureGitignore(agentlinkDir: string): void {
    const gitignorePath = path.join(agentlinkDir, ".gitignore");
    try {
      this.ensureDir(agentlinkDir);
      const content = this.readFileIfExists(gitignorePath);

      // Match full normalized lines to avoid false positives like "my-history/"
      const existingEntries = new Set(
        content
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line.length > 0),
      );

      const missingEntries = AGENTLINK_GITIGNORE_ENTRIES.filter(
        (entry) => !existingEntries.has(entry),
      );

      if (missingEntries.length === 0) return;

      // Append only what is missing to minimize writes and preserve file ordering.
      const prefix = content.length === 0 || content.endsWith("\n") ? "" : "\n";
      fs.appendFileSync(
        gitignorePath,
        `${prefix}${missingEntries.join("\n")}\n`,
        "utf-8",
      );
    } catch {
      // Best-effort — don't block startup
    }
  }

  private readFileIfExists(filePath: string): string {
    try {
      return fs.readFileSync(filePath, "utf-8");
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        return "";
      }
      throw error;
    }
  }

  /** Convert a SessionInfo (in-memory) to a SessionSummary (persisted) */
  static infoToSummary(info: SessionInfo): SessionSummary {
    return {
      schemaVersion: SCHEMA_VERSION,
      id: info.id,
      mode: info.mode,
      model: info.model,
      title: info.title,
      messageCount: info.messageCount,
      totalInputTokens: info.totalInputTokens,
      totalOutputTokens: info.totalOutputTokens,
      createdAt: info.createdAt,
      lastActiveAt: info.lastActiveAt,
      background: info.background,
    };
  }
}
