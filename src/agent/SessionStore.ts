import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

import type { AgentMessage, SessionInfo } from "./types.js";
import type {
  PersistedSessionLineage,
  SessionLineageSummary,
} from "./sessionHandoff.js";
import {
  normalizePersistedSessionLineage,
  projectSessionLineageSummary,
} from "./sessionHandoff.js";
import type {
  CheckpointState,
  PersistDurability,
  PersistResult,
  PersistedActiveSkillState,
  PersistedFleetMetadata,
  PersistedSessionMetadata,
  PersistedSessionRecord,
  PersistedSessionRunState,
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
import { hostFlightRecorder } from "../core/hostLiveness.js";
import {
  TRANSCRIPT_ATTACHMENTS_DIRNAME,
  externalizeTranscriptPayloads,
  rehydrateTranscriptPayloads,
  type ExternalizedTranscript,
} from "./transcriptPayloads.js";
import {
  SESSION_PROJECT_SCOPE_SCHEMA_VERSION,
  type SessionProjectScope,
} from "@agentlink/protocol/workspace-project";
import {
  findFirstUserMessage,
  getTailChunkByUserTurns,
  RESTORE_TAIL_TURNS,
} from "./transcriptChunks.js";
import { getLatestTodoState, type TodoItem } from "./todoTool.js";

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
  /** Derived history projection; persisted metadata remains authoritative. */
  projectScope?: SessionProjectScope;
  /** Lightweight handoff links for history rendering without transcript loads. */
  lineage?: SessionLineageSummary;
}

interface MessagesFile {
  schemaVersion: number;
  messages: AgentMessage[];
}

/**
 * Derived fast-restore snapshot persisted beside messages.json. Carries the
 * transcript tail plus everything a provisional restore hydration needs, so
 * reload can paint the recent conversation without parsing the (potentially
 * multi-MB) full transcript first. Message payloads stay externalized on disk
 * (attachment markers), mirroring messages.json.
 *
 * Deliberately transcript-derived data ONLY. Session state (runState, mode,
 * model, title, token counters) lives in metadata.json and is composed in at
 * read time: the tail file is refreshed only on transcript writes, so any
 * session state baked into it goes stale on metadata-only saves — e.g. the
 * end-of-turn save that clears runState after an in-flight persist already
 * wrote the final transcript would leave a phantom "interrupted" phase here.
 */
interface SessionTailSnapshotFile {
  schemaVersion: number;
  totalMessages: number;
  /** Absolute index of `messages[0]` in the full persisted transcript. */
  messageIndexOffset: number;
  /** Number of user turns before the first message in the tail. */
  userTurnOffset: number;
  hasMoreBefore: boolean;
  transcriptRevision?: number;
  todos: TodoItem[];
  /** First visible user turn (for originalPrompt), usually outside the tail. */
  firstUserMessage?: AgentMessage;
  messages: AgentMessage[];
}

function isValidTailSnapshotFile(
  value: unknown,
): value is SessionTailSnapshotFile {
  if (typeof value !== "object" || value === null) return false;
  const file = value as Partial<SessionTailSnapshotFile>;
  return (
    file.schemaVersion === SCHEMA_VERSION &&
    typeof file.totalMessages === "number" &&
    typeof file.messageIndexOffset === "number" &&
    typeof file.userTurnOffset === "number" &&
    typeof file.hasMoreBefore === "boolean" &&
    Array.isArray(file.todos) &&
    Array.isArray(file.messages)
  );
}

/** Rehydrated tail snapshot returned to restore callers. */
export interface SessionTailSnapshot {
  sessionId: string;
  totalMessages: number;
  messageIndexOffset: number;
  userTurnOffset: number;
  hasMoreBefore: boolean;
  transcriptRevision?: number;
  title: string;
  mode: string;
  model: string;
  lastInputTokens?: number;
  todos: TodoItem[];
  runStatePhase?: PersistedSessionRunState["phase"];
  firstUserMessage?: AgentMessage;
  messages: AgentMessage[];
}

type ClassifiedJsonRead<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "corrupt" | "io_error"; message: string };

interface MetadataFile {
  schemaVersion: number;
  revision?: PersistenceRevision;
  summary?: SessionSummary;
  projectScope?: SessionProjectScope;
  activeContextResourceUri?: string;
  mode: string;
  model: string;
  initialArchitectReviewPending?: boolean;
  promptProfile?: import("@agentlink/protocol/prompt-profile").PromptProfileResolution;
  contextLedger?: import("@agentlink/protocol/context-ledger").ContextLedgerSnapshot;
  commandApprovalPolicy?: import("@agentlink/protocol/terminal").TerminalCommandApprovalPolicySnapshot;
  approvalPolicy?: import("@agentlink/protocol/terminal").TerminalApprovalPolicy;
  approvalReviewer?: import("@agentlink/protocol/terminal").TerminalApprovalReviewer;
  executionPreset?: import("@agentlink/protocol/terminal").TerminalExecutionPreset;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens?: number;
  totalCacheCreationTokens?: number;
  lastInputTokens?: number;
  lastCacheReadTokens?: number;
  reasoningEffort?: import("./providers/types.js").ReasoningEffort;
  loadedSkills?: string[];
  activeSkillState?: PersistedActiveSkillState;
  checkpoints?: Checkpoint[];
  checkpointState?: CheckpointState;
  revertPending?: RevertRecoveryState;
  runState?: PersistedSessionRunState;
  fleet?: PersistedFleetMetadata;
  lineage?: PersistedSessionLineage;
}

// Narrow async seam for testing atomic JSON writes without mocking Node's ESM
// `fs` namespace. Non-atomic reads/deletes intentionally continue to call `fs`
// synchronously: they are small (metadata/index) or startup-only. Node's
// `fs.promises.FileHandle` satisfies `SessionStoreAtomicFile` structurally.
interface SessionStoreAtomicFile {
  writeFile(data: string, options: BufferEncoding): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

interface SessionStoreAtomicFileOps {
  open(
    path: fs.PathLike,
    flags: string | number,
  ): Promise<SessionStoreAtomicFile>;
  rename(oldPath: fs.PathLike, newPath: fs.PathLike): Promise<void>;
  rm(path: fs.PathLike, options: fs.RmOptions): Promise<void>;
}

const defaultAtomicFileOps: SessionStoreAtomicFileOps = {
  open: (filePath, flags) => fs.promises.open(filePath, flags),
  rename: (oldPath, newPath) => fs.promises.rename(oldPath, newPath),
  rm: (filePath, options) => fs.promises.rm(filePath, options),
};

export interface SessionStoreOptions {
  /**
   * Optional subdirectory under `.agentlink/history` used to isolate sessions
   * for a specific VS Code workspace identity (for example, a multi-root
   * workspace). Omit to preserve the legacy single-folder history layout.
   */
  historyNamespace?: string;
  /**
   * Exact resolved session-history directory. This is used by v2 workspace
   * lineages and must not be combined with historyNamespace.
   */
  historyDirectory?: string;
  /** Activation-time primary project used only to migrate pre-scope sessions. */
  legacyProjectScope?: SessionProjectScope;
  log?: (message: string) => void;
}

const SCHEMA_VERSION = 1;
const SESSIONS_FILE = "sessions.json";
const TAIL_SNAPSHOT_FILE = "messages.tail.json";
const AGENTLINK_GITIGNORE_ENTRIES = [
  "history/",
  "workspaces/",
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
  private readonly legacyProjectScope: SessionProjectScope | undefined;
  private readonly log: ((message: string) => void) | undefined;
  /** In-memory index — updated on every save/delete/rename */
  private index: Map<string, SessionSummary> = new Map();
  /**
   * SHA-256 of the last messages.json content written per session. Lets
   * metadata-only saves (token counters, run state) skip re-writing and
   * re-fsyncing the full transcript.
   */
  private lastMessagesDigest: Map<string, string> = new Map();
  /**
   * Transcript revision counter recorded at the last messages.json write per
   * session. When an incoming record carries `transcriptRevision`, comparing
   * counters replaces serializing + hashing the full history to detect an
   * unchanged transcript.
   */
  private lastTranscriptRevision: Map<string, number> = new Map();
  /**
   * Durability of the last messages.json write per session. A durable save
   * whose transcript skip lands on a checkpoint-tier write must fsync the
   * existing transcript before writing durable metadata that references it.
   */
  private messagesFileDurability: Map<string, PersistDurability> = new Map();
  /** Directories already created this process — skips redundant mkdirSync. */
  private ensuredDirs = new Set<string>();
  /**
   * Per-session write queue. Serializes the whole revision-aware mutation
   * (CAS read → messages → metadata) per session directory so overlapping
   * async saves/deletes can neither interleave their file writes nor race the
   * revision check, preserving messages-before-metadata and save ordering.
   */
  private sessionWriteQueues = new Map<string, Promise<void>>();
  /** Tail of the sessions.json write chain — at most one write in flight. */
  private indexWriteChain: Promise<void> = Promise.resolve();
  /**
   * Index flush that is queued behind the in-flight write but not yet
   * started. It serializes `this.index` when it runs, so any number of flush
   * requests arriving while a write is in flight collapse into this single
   * entry (last-write-wins; intermediate snapshots are never written).
   */
  private pendingIndexFlush: {
    durability: PersistDurability;
    promise: Promise<void>;
  } | null = null;
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
    atomicFileOps: SessionStoreAtomicFileOps = defaultAtomicFileOps,
    options: SessionStoreOptions = {},
  ) {
    this.identity = identity;
    this.atomicFileOps = atomicFileOps;
    if (options.historyDirectory && options.historyNamespace) {
      throw new Error(
        "SessionStore historyDirectory and historyNamespace cannot be combined",
      );
    }
    this.legacyProjectScope = options.legacyProjectScope;
    this.log = options.log;
    const historyRoot = path.join(workspaceDir, ".agentlink", "history");
    this.historyDir = options.historyDirectory
      ? path.resolve(options.historyDirectory)
      : options.historyNamespace
        ? path.join(historyRoot, options.historyNamespace)
        : historyRoot;
    this.sessionsFile = path.join(this.historyDir, SESSIONS_FILE);
    this.ensureGitignore(path.join(workspaceDir, ".agentlink"));
    this.loadIndex();
  }

  // ---------------------------------------------------------------------------
  // Index management
  // ---------------------------------------------------------------------------

  /** Wait until every already-queued session and index write has settled. */
  async flush(): Promise<void> {
    await Promise.all(this.sessionWriteQueues.values());
    await this.indexWriteChain;
    if (this.pendingIndexFlush) await this.pendingIndexFlush.promise;
  }

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

      let didNormalizeIndex = false;
      const normalized = parsed.map((summary) => {
        const migratedTitle = buildSessionTitleFromUserText(summary.title);
        const nextTitle = migratedTitle ?? DEFAULT_SESSION_TITLE;
        let normalizedSummary =
          nextTitle === summary.title
            ? summary
            : { ...summary, title: nextTitle };
        if (normalizedSummary !== summary) didNormalizeIndex = true;

        const metadataResult = this.readMetadataFile(summary.id);
        const metadataScope = metadataResult.ok
          ? metadataResult.value.projectScope
          : undefined;
        const projectScope = this.resolvePersistedProjectScope(
          summary.id,
          metadataScope,
          summary.projectScope,
        );
        if (
          !this.projectScopesEqual(normalizedSummary.projectScope, projectScope)
        ) {
          normalizedSummary = { ...normalizedSummary, projectScope };
          didNormalizeIndex = true;
        }
        return normalizedSummary;
      });
      this.index = new Map(normalized.map((s) => [s.id, s]));
      this.indexLoadState = { ok: true };
      if (didNormalizeIndex) this.flushIndexSync();
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

  /**
   * Synchronous index flush for the constructor path (`loadIndex`/
   * `rebuildIndex`) and the legacy sync mutators (`rename`/`delete`). Startup
   * runs before any async writes exist and the index is small, so this is the
   * one deliberate exception to the async write pipeline. Uses raw `fs`, not
   * the async seam.
   */
  private flushIndexSync(): void {
    this.ensureDir(this.historyDir);
    this.writeSerializedFileAtomicSync(
      this.sessionsFile,
      `${JSON.stringify(this.sortedIndexSnapshot())}\n`,
    );
    this.indexLoadState = { ok: true };
  }

  /**
   * Request an async sessions.json flush. At most one write runs at a time;
   * requests made while a write is in flight coalesce into a single queued
   * flush that serializes the newest index state when it starts
   * (last-write-wins — intermediate snapshots are dropped). A durable request
   * upgrades a queued checkpoint flush, never the reverse.
   */
  private scheduleIndexFlush(durability: PersistDurability): Promise<void> {
    const pending = this.pendingIndexFlush;
    if (pending) {
      if (durability === "durable" && pending.durability === "checkpoint") {
        pending.durability = "durable";
      }
      return pending.promise;
    }
    const entry: { durability: PersistDurability; promise: Promise<void> } = {
      durability,
      promise: Promise.resolve(),
    };
    entry.promise = this.indexWriteChain.then(async () => {
      // From here this flush serializes current state; later requests must
      // queue a fresh flush to capture mutations made after this point.
      if (this.pendingIndexFlush === entry) this.pendingIndexFlush = null;
      this.ensureDir(this.historyDir);
      // sessions.json is a derived index rebuilt from metadata on load, so a
      // checkpoint-tier flush losing power is recoverable.
      await this.writeJsonFileAtomic(
        this.sessionsFile,
        this.sortedIndexSnapshot(),
        entry.durability,
      );
      this.indexLoadState = { ok: true };
    });
    this.pendingIndexFlush = entry;
    this.indexWriteChain = entry.promise.then(
      () => undefined,
      () => undefined,
    );
    return entry.promise;
  }

  private sortedIndexSnapshot(): SessionSummary[] {
    return Array.from(this.index.values()).sort(
      (a, b) => b.lastActiveAt - a.lastActiveAt,
    );
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

        const projectScope = this.resolvePersistedProjectScope(
          summary.id,
          metadataResult.value.projectScope,
          summary.projectScope,
        );
        rebuilt.set(summary.id, { ...summary, projectScope });
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
      this.flushIndexSync();
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

    const messagesResult = await this.readMessagesFileAsync(sessionId);
    if (!messagesResult.ok) return messagesResult;

    const metadataResult = this.readMetadataFile(sessionId);
    if (!metadataResult.ok) return metadataResult;

    const metadata = this.metadataFileToRecord(metadataResult.value, summary);
    const normalizedSummary = this.withSessionLineageSummary(
      this.withAuthoritativeProjectScope(summary, metadata.projectScope),
      metadata.lineage,
    );
    if (
      !this.projectScopesEqual(
        summary.projectScope,
        normalizedSummary.projectScope,
      )
    ) {
      this.index.set(sessionId, normalizedSummary);
      await this.scheduleIndexFlush("durable");
    }
    return {
      ok: true,
      value: {
        summary: normalizedSummary,
        messages: this.rehydrateMessages(
          sessionId,
          messagesResult.value.messages,
        ),
        metadata,
      },
      revision: metadataResult.value.revision ?? "0",
    };
  }

  async saveSession(args: {
    session: PersistedSessionRecord;
    expectedRevision: PersistenceRevision | null;
    durability?: PersistDurability;
  }): Promise<PersistResult> {
    return this.enqueueSessionWrite(args.session.summary.id, () =>
      this.saveSessionUnqueued(args),
    );
  }

  private async saveSessionUnqueued(args: {
    session: PersistedSessionRecord;
    expectedRevision: PersistenceRevision | null;
    durability?: PersistDurability;
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
      await this.writeSessionRecord(
        args.session,
        nextRevision,
        args.durability ?? "durable",
      );
      return { ok: true, revision: nextRevision };
    } catch (error) {
      return {
        ok: false,
        reason: "io_error",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Chain a mutation onto the session's write queue. The task runs after all
   * previously enqueued mutations for the same session have settled, so its
   * revision read observes the prior write's committed state.
   */
  private enqueueSessionWrite<T>(
    sessionId: string,
    task: () => Promise<T>,
  ): Promise<T> {
    const previous =
      this.sessionWriteQueues.get(sessionId) ?? Promise.resolve();
    const run = previous.then(task, task);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.sessionWriteQueues.set(sessionId, tail);
    void tail.then(() => {
      if (this.sessionWriteQueues.get(sessionId) === tail) {
        this.sessionWriteQueues.delete(sessionId);
      }
    });
    return run;
  }

  async renameSession(args: {
    sessionId: string;
    title: string;
    expectedRevision: PersistenceRevision;
  }): Promise<PersistResult> {
    return this.enqueueSessionWrite(args.sessionId, async () => {
      const readResult = await this.readSession(args.sessionId);
      if (!readResult.ok) return readResult;
      if (readResult.revision !== args.expectedRevision) {
        return {
          ok: false,
          reason: "conflict",
          currentRevision: readResult.revision,
        };
      }

      return this.saveSessionUnqueued({
        session: {
          ...readResult.value,
          summary: { ...readResult.value.summary, title: args.title },
        },
        expectedRevision: args.expectedRevision,
      });
    });
  }

  async deleteSession(args: {
    sessionId: string;
    expectedRevision: PersistenceRevision;
  }): Promise<PersistResult> {
    return this.enqueueSessionWrite(args.sessionId, async () => {
      const currentRevisionResult = this.readCurrentRevision(args.sessionId);
      if (
        !currentRevisionResult.ok &&
        currentRevisionResult.reason === "corrupt"
      )
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

      const deleted = await this.deleteUnqueued(args.sessionId);
      return deleted
        ? { ok: true, revision: currentRevisionResult.revision }
        : { ok: false, reason: "not_found" };
    });
  }

  /**
   * Async delete used by the queued revision-aware path: removes the session
   * from the in-memory index, flushes the derived index through the async
   * write pipeline, and removes the session directory.
   */
  private async deleteUnqueued(sessionId: string): Promise<boolean> {
    if (!this.index.has(sessionId)) return false;
    this.index.delete(sessionId);
    this.clearSessionWriteState(sessionId);
    const indexFlush = this.scheduleIndexFlush("durable");

    const sessionDir = path.join(this.historyDir, sessionId);
    this.forgetEnsuredDirs(sessionDir);
    try {
      await fs.promises.rm(sessionDir, { recursive: true, force: true });
    } catch {
      // Best-effort
    }
    await indexFlush;
    return true;
  }

  /**
   * Save/update a session to disk.
   * Called after each API response (on `done` event) and after condensing.
   */
  save(session: {
    id: string;
    mode: string;
    model: string;
    promptProfile?: import("@agentlink/protocol/prompt-profile").PromptProfileResolution;
    contextLedger?: import("@agentlink/protocol/context-ledger").ContextLedgerSnapshot;
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
    commandApprovalPolicy?: import("@agentlink/protocol/terminal").TerminalCommandApprovalPolicySnapshot;
    approvalPolicy?: import("@agentlink/protocol/terminal").TerminalApprovalPolicy;
    approvalReviewer?: import("@agentlink/protocol/terminal").TerminalApprovalReviewer;
    executionPreset?: import("@agentlink/protocol/terminal").TerminalExecutionPreset;
    background?: boolean;
    projectScope?: SessionProjectScope;
    activeContextResourceUri?: string;
    getLoadedSkills?(): string[];
    getActiveSkillState?(): PersistedActiveSkillState | undefined;
    getAllMessages(): AgentMessage[];
    checkpoints?: Checkpoint[];
    lineage?: PersistedSessionLineage;
  }): void {
    const messages = session.getAllMessages();
    const record: PersistedSessionRecord = {
      summary: this.withSessionLineageSummary(
        {
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
          projectScope: session.projectScope,
        },
        normalizePersistedSessionLineage(session.lineage),
      ),
      messages,
      metadata: {
        projectScope: session.projectScope,
        activeContextResourceUri: session.activeContextResourceUri,
        mode: session.mode,
        model: session.model,
        promptProfile: session.promptProfile,
        contextLedger: session.contextLedger,
        commandApprovalPolicy: session.commandApprovalPolicy,
        approvalPolicy: session.approvalPolicy,
        approvalReviewer: session.approvalReviewer,
        executionPreset: session.executionPreset,
        totalInputTokens: session.totalInputTokens,
        totalOutputTokens: session.totalOutputTokens,
        totalCacheReadTokens: session.totalCacheReadTokens,
        totalCacheCreationTokens: session.totalCacheCreationTokens,
        lastInputTokens: session.lastInputTokens,
        lastCacheReadTokens: session.lastCacheReadTokens,
        reasoningEffort: session.reasoningEffort,
        loadedSkills: session.getLoadedSkills?.() ?? [],
        activeSkillState: session.getActiveSkillState?.(),
        checkpointState: session.checkpoints
          ? { baseCommit: null, checkpoints: session.checkpoints }
          : undefined,
        lineage: normalizePersistedSessionLineage(session.lineage),
      },
    };
    void this.enqueueSessionWrite(session.id, async () => {
      // Read the revision inside the queue so it observes prior queued writes.
      const currentRevisionResult = this.readCurrentRevision(session.id);
      const nextRevision = this.nextRevision(currentRevisionResult);
      await this.writeSessionRecord(record, nextRevision);
    }).catch((error) => {
      this.log?.(
        `[history] legacy save failed for session ${session.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
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

  /** List every persisted placement for fleet/history projections. */
  listAll(): SessionSummary[] {
    return Array.from(this.index.values()).sort(
      (a, b) => b.lastActiveAt - a.lastActiveAt,
    );
  }

  /**
   * Load full message history for a session.
   * Returns null if the session doesn't exist or files are corrupt.
   */
  loadMessages(sessionId: string): AgentMessage[] | null {
    const file = path.join(this.historyDir, sessionId, "messages.json");
    try {
      const startedAt = Date.now();
      const raw = fs.readFileSync(file, "utf-8");
      const parsed = JSON.parse(raw) as MessagesFile;
      hostFlightRecorder.noteSync(
        "transcript-load",
        `${sessionId} ${raw.length}B`,
        startedAt,
      );
      if (!parsed.messages) return null;
      return this.rehydrateMessages(sessionId, parsed.messages);
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
    const projectScope = this.resolvePersistedProjectScope(
      sessionId,
      result.value.projectScope,
      result.value.summary?.projectScope,
    );
    return this.metadataFileWithLegacyCheckpoints({
      ...result.value,
      projectScope,
      summary:
        result.value.summary === undefined
          ? undefined
          : this.withAuthoritativeProjectScope(
              result.value.summary,
              projectScope,
            ),
    });
  }

  get(sessionId: string): SessionSummary | undefined {
    return this.index.get(sessionId);
  }

  // ---------------------------------------------------------------------------
  // Internal read/write helpers
  // ---------------------------------------------------------------------------

  private readJsonFile<T>(
    file: string,
    isValid: (value: unknown) => value is T,
    invalidMessage: string,
  ): ClassifiedJsonRead<T> {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf-8"));
      if (!isValid(parsed)) {
        return { ok: false, reason: "corrupt", message: invalidMessage };
      }
      return { ok: true, value: parsed };
    } catch (error) {
      if (this.isNotFoundError(error)) {
        return { ok: false, reason: "not_found" };
      }
      if (error instanceof SyntaxError) {
        return { ok: false, reason: "corrupt", message: error.message };
      }
      return {
        ok: false,
        reason: "io_error",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Async transcript read for the restore path: the file I/O yields the
   * extension-host event loop, so only the (unavoidable) JSON.parse of the
   * transcript runs synchronously — and that parse is flight-recorded.
   */
  private async readMessagesFileAsync(
    sessionId: string,
  ): Promise<ClassifiedJsonRead<MessagesFile>> {
    const file = path.join(this.historyDir, sessionId, "messages.json");
    let raw: string;
    try {
      raw = await fs.promises.readFile(file, "utf-8");
    } catch (error) {
      if (this.isNotFoundError(error)) {
        return { ok: false, reason: "not_found" };
      }
      return {
        ok: false,
        reason: "io_error",
        message: error instanceof Error ? error.message : String(error),
      };
    }
    try {
      const startedAt = Date.now();
      const parsed: unknown = JSON.parse(raw);
      hostFlightRecorder.noteSync(
        "transcript-parse",
        `${sessionId} ${raw.length}B`,
        startedAt,
      );
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        !Array.isArray((parsed as MessagesFile).messages)
      ) {
        return {
          ok: false,
          reason: "corrupt",
          message: `Invalid messages file for session ${sessionId}`,
        };
      }
      return { ok: true, value: parsed as MessagesFile };
    } catch (error) {
      return {
        ok: false,
        reason: "corrupt",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private readMetadataFile(
    sessionId: string,
  ): ClassifiedJsonRead<MetadataFile> {
    return this.readJsonFile(
      path.join(this.historyDir, sessionId, "metadata.json"),
      (value): value is MetadataFile =>
        typeof value === "object" &&
        value !== null &&
        typeof (value as MetadataFile).mode === "string" &&
        typeof (value as MetadataFile).model === "string",
      `Invalid metadata file for session ${sessionId}`,
    );
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

  private async writeSessionRecord(
    record: PersistedSessionRecord,
    revision: PersistenceRevision,
    durability: PersistDurability = "durable",
  ): Promise<void> {
    const projectScope = this.resolvePersistedProjectScope(
      record.summary.id,
      record.metadata.projectScope,
      record.summary.projectScope,
    );
    const metadata = { ...record.metadata, projectScope };
    const summary = this.withSessionLineageSummary(
      this.withAuthoritativeProjectScope(record.summary, projectScope),
      metadata.lineage,
    );

    // Persist messages before metadata so a durable metadata revision never
    // references transcript bytes that have not already been flushed.
    // `sessions.json` is a derived index and can be rebuilt from metadata.
    const sessionDir = path.join(this.historyDir, summary.id);
    this.ensureDir(sessionDir);

    const messagesPath = path.join(sessionDir, "messages.json");
    const transcriptRevision = record.transcriptRevision;
    // Oversized payloads (base64 media) are persisted as content-addressed
    // attachment files instead of transcript bytes, so `messages.json` stays
    // small enough to re-stringify every checkpoint tick. Lazy: the
    // revision-skip path never pays for the transform.
    let externalized: ExternalizedTranscript | undefined;
    const getExternalized = () =>
      (externalized ??= externalizeTranscriptPayloads(record.messages));
    let messagesJson: string | undefined;
    let messagesDigest: string | undefined;
    let transcriptUnchanged: boolean;
    if (transcriptRevision !== undefined) {
      transcriptUnchanged =
        this.lastTranscriptRevision.get(summary.id) === transcriptRevision &&
        fs.existsSync(messagesPath);
    } else {
      // Legacy records without a transcript revision fall back to hashing the
      // serialized history to detect unchanged transcripts.
      messagesJson = this.serializeMessages(
        getExternalized().messages,
        summary.id,
      );
      messagesDigest = crypto
        .createHash("sha256")
        .update(messagesJson)
        .digest("base64");
      transcriptUnchanged =
        this.lastMessagesDigest.get(summary.id) === messagesDigest &&
        fs.existsSync(messagesPath);
    }

    if (!transcriptUnchanged) {
      // Attachments before messages, mirroring the messages-before-metadata
      // invariant: the transcript on disk never references a payload file
      // that has not already been written.
      await this.ensureTranscriptPayloadFiles(
        sessionDir,
        summary.id,
        getExternalized().payloads,
      );
      await this.writeSerializedFileAtomic(
        messagesPath,
        messagesJson ??
          this.serializeMessages(getExternalized().messages, summary.id),
        durability,
      );
      // Refresh the derived fast-restore tail after messages.json so a valid
      // snapshot is never newer than the transcript it summarizes; a crash
      // between the two writes leaves an older tail that the mtime staleness
      // check rejects on read.
      await this.writeSessionTailSnapshot(
        sessionDir,
        summary,
        record,
        getExternalized().messages,
      );
      // Record whichever change tracker the record supports and drop the
      // other, so alternating counter/digest saves can never stale-skip.
      if (transcriptRevision !== undefined) {
        this.lastTranscriptRevision.set(summary.id, transcriptRevision);
        this.lastMessagesDigest.delete(summary.id);
      } else {
        this.lastMessagesDigest.set(summary.id, messagesDigest as string);
        this.lastTranscriptRevision.delete(summary.id);
      }
      this.messagesFileDurability.set(summary.id, durability);
    } else if (
      durability === "durable" &&
      this.messagesFileDurability.get(summary.id) === "checkpoint"
    ) {
      // The transcript bytes on disk came from a checkpoint-tier write that
      // skipped fsync. Flush them now so the durable metadata revision below
      // never references transcript bytes that are not durable themselves.
      await this.fsyncExistingFile(messagesPath, sessionDir);
      this.messagesFileDurability.set(summary.id, "durable");
    }

    const metadataFile = this.recordMetadataToFile(metadata, revision, summary);
    await this.writeJsonFileAtomic(
      path.join(sessionDir, "metadata.json"),
      metadataFile,
      durability,
    );

    this.index.set(summary.id, summary);
    await this.scheduleIndexFlush(durability);
  }

  /**
   * Content hashes whose attachment files are known to exist on disk, per
   * session. Avoids an `existsSync` per payload per save; content-addressed
   * files are immutable so "seen once" is proof enough for this process.
   */
  private readonly ensuredPayloadHashes = new Map<string, Set<string>>();

  private async ensureTranscriptPayloadFiles(
    sessionDir: string,
    sessionId: string,
    payloads: Map<string, string>,
  ): Promise<void> {
    if (payloads.size === 0) return;
    let known = this.ensuredPayloadHashes.get(sessionId);
    if (!known) {
      known = new Set();
      this.ensuredPayloadHashes.set(sessionId, known);
    }
    const attachmentsDir = path.join(
      sessionDir,
      TRANSCRIPT_ATTACHMENTS_DIRNAME,
    );
    for (const [hash, value] of payloads) {
      if (known.has(hash)) continue;
      const payloadPath = path.join(attachmentsDir, `${hash}.payload`);
      if (!fs.existsSync(payloadPath)) {
        // Always durable: a payload is written once per unique blob, and the
        // checkpoint→durable upgrade tracking only covers messages.json, so
        // paying one fsync here keeps the durability invariant simple.
        await this.writeSerializedFileAtomic(payloadPath, value, "durable");
      }
      known.add(hash);
    }
  }

  /**
   * Best-effort write of the derived fast-restore tail. Failures are logged
   * and swallowed: the snapshot is a cache, and a save must not fail because
   * its accelerator could not be written. A stale leftover from an earlier
   * save is rejected on read by the mtime staleness check.
   */
  private async writeSessionTailSnapshot(
    sessionDir: string,
    summary: SessionSummary,
    record: PersistedSessionRecord,
    externalizedMessages: AgentMessage[],
  ): Promise<void> {
    try {
      const tail = getTailChunkByUserTurns(
        externalizedMessages,
        RESTORE_TAIL_TURNS,
      );
      const tailFile: SessionTailSnapshotFile = {
        schemaVersion: SCHEMA_VERSION,
        totalMessages: externalizedMessages.length,
        messageIndexOffset: externalizedMessages.length - tail.chunk.length,
        userTurnOffset: tail.userTurnOffset,
        hasMoreBefore: tail.hasMoreBefore,
        transcriptRevision: record.transcriptRevision,
        todos: getLatestTodoState(record.messages),
        firstUserMessage: findFirstUserMessage(externalizedMessages),
        messages: tail.chunk,
      };
      // Checkpoint durability: readers validate against messages.json and
      // fall back to the full transcript read, so the tail never needs to
      // survive power loss on its own.
      await this.writeSerializedFileAtomic(
        path.join(sessionDir, TAIL_SNAPSHOT_FILE),
        `${JSON.stringify(tailFile)}\n`,
        "checkpoint",
      );
    } catch (error) {
      this.log?.(
        `Failed to write tail snapshot for ${summary.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Fast-restore read of the persisted transcript tail. Returns null when no
   * usable snapshot exists (missing, corrupt, schema mismatch, or older than
   * messages.json) — callers fall back to the full `readSession`.
   */
  async readSessionTailSnapshot(
    sessionId: string,
  ): Promise<SessionTailSnapshot | null> {
    const summary = this.index.get(sessionId);
    if (!summary) return null;
    const sessionDir = path.join(this.historyDir, sessionId);
    const tailPath = path.join(sessionDir, TAIL_SNAPSHOT_FILE);
    const messagesPath = path.join(sessionDir, "messages.json");
    try {
      const [tailStat, messagesStat] = await Promise.all([
        fs.promises.stat(tailPath),
        fs.promises.stat(messagesPath),
      ]);
      // The tail is written after messages.json within the same queued save,
      // so an older tail means a newer transcript landed without one (crash
      // mid-save, snapshot write failure, or a writer without tail support).
      if (tailStat.mtimeMs < messagesStat.mtimeMs) return null;
      const raw = await fs.promises.readFile(tailPath, "utf-8");
      const parsed: unknown = JSON.parse(raw);
      if (!isValidTailSnapshotFile(parsed)) return null;
      // Session state comes from metadata.json, which every save refreshes —
      // the tail file only tracks transcript writes, so state baked into it
      // (runState especially) would go stale on metadata-only saves.
      const metadataResult = this.readMetadataFile(sessionId);
      if (!metadataResult.ok) return null;
      const metadata = metadataResult.value;
      return {
        sessionId,
        totalMessages: parsed.totalMessages,
        messageIndexOffset: parsed.messageIndexOffset,
        userTurnOffset: parsed.userTurnOffset,
        hasMoreBefore: parsed.hasMoreBefore,
        transcriptRevision: parsed.transcriptRevision,
        title: metadata.summary?.title ?? summary.title,
        mode: metadata.mode,
        model: metadata.model,
        lastInputTokens: metadata.lastInputTokens,
        todos: parsed.todos,
        runStatePhase: metadata.runState?.phase,
        firstUserMessage: parsed.firstUserMessage
          ? this.rehydrateMessages(sessionId, [parsed.firstUserMessage])[0]
          : undefined,
        messages: this.rehydrateMessages(sessionId, parsed.messages),
      };
    } catch {
      return null;
    }
  }

  private rehydrateMessages(
    sessionId: string,
    messages: AgentMessage[],
  ): AgentMessage[] {
    return rehydrateTranscriptPayloads(messages, (hash) => {
      try {
        return fs.readFileSync(
          path.join(
            this.historyDir,
            sessionId,
            TRANSCRIPT_ATTACHMENTS_DIRNAME,
            `${hash}.payload`,
          ),
          "utf-8",
        );
      } catch {
        return null;
      }
    });
  }

  private serializeMessages(
    messages: AgentMessage[],
    diagnosticsId: string,
  ): string {
    const messagesFile: MessagesFile = {
      schemaVersion: SCHEMA_VERSION,
      messages,
    };
    const startedAt = Date.now();
    const serialized = `${JSON.stringify(messagesFile)}\n`;
    hostFlightRecorder.noteSync(
      "transcript-stringify",
      `${diagnosticsId} ${serialized.length}B`,
      startedAt,
    );
    return serialized;
  }

  private withSessionLineageSummary(
    summary: SessionSummary,
    lineage: PersistedSessionLineage | undefined,
  ): SessionSummary {
    const projected = projectSessionLineageSummary(lineage);
    const { lineage: _previousLineage, ...withoutPreviousLineage } = summary;
    return {
      ...withoutPreviousLineage,
      ...(projected ? { lineage: projected } : {}),
    };
  }

  private metadataFileToRecord(
    file: MetadataFile,
    summary?: SessionSummary,
  ): PersistedSessionMetadata {
    const projectScope = this.resolvePersistedProjectScope(
      summary?.id ?? file.summary?.id ?? "<unknown>",
      file.projectScope,
      summary?.projectScope ?? file.summary?.projectScope,
    );
    return {
      projectScope,
      activeContextResourceUri: file.activeContextResourceUri,
      mode: file.mode,
      model: file.model,
      initialArchitectReviewPending: file.initialArchitectReviewPending,
      promptProfile: file.promptProfile,
      contextLedger: file.contextLedger,
      commandApprovalPolicy: file.commandApprovalPolicy,
      approvalPolicy: file.approvalPolicy,
      approvalReviewer: file.approvalReviewer,
      executionPreset: file.executionPreset,
      totalInputTokens: file.totalInputTokens,
      totalOutputTokens: file.totalOutputTokens,
      totalCacheReadTokens: file.totalCacheReadTokens,
      totalCacheCreationTokens: file.totalCacheCreationTokens,
      lastInputTokens: file.lastInputTokens,
      lastCacheReadTokens: file.lastCacheReadTokens,
      reasoningEffort: file.reasoningEffort,
      loadedSkills: file.loadedSkills,
      activeSkillState: file.activeSkillState,
      checkpointState: file.checkpointState ?? {
        baseCommit: null,
        checkpoints: file.checkpoints ?? [],
      },
      revertPending: file.revertPending,
      runState: file.runState,
      fleet: file.fleet,
      lineage: normalizePersistedSessionLineage(file.lineage),
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
    const lineage = normalizePersistedSessionLineage(metadata.lineage);
    return {
      schemaVersion: SCHEMA_VERSION,
      revision,
      summary: this.withAuthoritativeProjectScope(
        summary,
        metadata.projectScope,
      ),
      projectScope: metadata.projectScope,
      activeContextResourceUri: metadata.activeContextResourceUri,
      mode: metadata.mode,
      model: metadata.model,
      initialArchitectReviewPending: metadata.initialArchitectReviewPending,
      promptProfile: metadata.promptProfile,
      contextLedger: metadata.contextLedger,
      commandApprovalPolicy: metadata.commandApprovalPolicy,
      approvalPolicy: metadata.approvalPolicy,
      approvalReviewer: metadata.approvalReviewer,
      executionPreset: metadata.executionPreset,
      totalInputTokens: metadata.totalInputTokens,
      totalOutputTokens: metadata.totalOutputTokens,
      totalCacheReadTokens: metadata.totalCacheReadTokens,
      totalCacheCreationTokens: metadata.totalCacheCreationTokens,
      lastInputTokens: metadata.lastInputTokens,
      lastCacheReadTokens: metadata.lastCacheReadTokens,
      reasoningEffort: metadata.reasoningEffort,
      loadedSkills: metadata.loadedSkills,
      activeSkillState: metadata.activeSkillState,
      checkpoints,
      checkpointState: metadata.checkpointState,
      revertPending: metadata.revertPending,
      runState: metadata.runState,
      fleet: metadata.fleet,
      lineage,
    };
  }

  private async writeJsonFileAtomic(
    filePath: string,
    value: unknown,
    durability: PersistDurability = "durable",
  ): Promise<void> {
    await this.writeSerializedFileAtomic(
      filePath,
      `${JSON.stringify(value)}\n`,
      durability,
    );
  }

  private async writeSerializedFileAtomic(
    filePath: string,
    content: string,
    durability: PersistDurability = "durable",
  ): Promise<void> {
    const dir = path.dirname(filePath);
    this.ensureDir(dir);
    try {
      await this.writeSerializedFileAtomicInDir(
        filePath,
        dir,
        content,
        durability,
      );
    } catch (error) {
      if (!this.isNotFoundError(error)) throw error;
      // The directory was removed out from under the ensuredDirs cache (e.g.
      // another window deleted the session) — recreate it and retry once.
      this.ensuredDirs.delete(dir);
      this.ensureDir(dir);
      await this.writeSerializedFileAtomicInDir(
        filePath,
        dir,
        content,
        durability,
      );
    }
  }

  private async writeSerializedFileAtomicInDir(
    filePath: string,
    dir: string,
    content: string,
    durability: PersistDurability,
  ): Promise<void> {
    const tempPath = path.join(
      dir,
      `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp`,
    );
    let shouldRemoveTemp = true;
    let file: SessionStoreAtomicFile | undefined;
    try {
      file = await this.atomicFileOps.open(tempPath, "w");
      await file.writeFile(content, "utf-8");
      // Checkpoint-tier writes rely on the atomic rename alone: a crash never
      // leaves a torn file, but the bytes may not survive power loss until a
      // later durable save fsyncs them.
      if (durability === "durable") await file.sync();
      await file.close();
      file = undefined;

      await this.atomicFileOps.rename(tempPath, filePath);
      shouldRemoveTemp = false;
      if (durability === "durable") await this.fsyncDirectoryBestEffort(dir);
    } finally {
      if (file !== undefined) {
        try {
          await file.close();
        } catch {
          // Best-effort cleanup.
        }
      }
      if (shouldRemoveTemp) {
        try {
          await this.atomicFileOps.rm(tempPath, { force: true });
        } catch {
          // Best-effort cleanup.
        }
      }
    }
  }

  /**
   * Sync atomic write used only by `flushIndexSync` (constructor path and
   * legacy sync mutators). Deliberately bypasses the async seam; always
   * durable.
   */
  private writeSerializedFileAtomicSync(
    filePath: string,
    content: string,
  ): void {
    const dir = path.dirname(filePath);
    this.ensureDir(dir);
    const tempPath = path.join(
      dir,
      `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp`,
    );
    let shouldRemoveTemp = true;
    let fd: number | undefined;
    try {
      fd = fs.openSync(tempPath, "w");
      fs.writeFileSync(fd, content, "utf-8");
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;

      fs.renameSync(tempPath, filePath);
      shouldRemoveTemp = false;
      let dirFd: number | undefined;
      try {
        dirFd = fs.openSync(dir, "r");
        fs.fsyncSync(dirFd);
      } catch {
        // Some file systems/platforms do not allow fsync on directories.
      } finally {
        if (dirFd !== undefined) {
          try {
            fs.closeSync(dirFd);
          } catch {
            // Best-effort cleanup.
          }
        }
      }
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          // Best-effort cleanup.
        }
      }
      if (shouldRemoveTemp) {
        try {
          fs.rmSync(tempPath, { force: true });
        } catch {
          // Best-effort cleanup.
        }
      }
    }
  }

  /**
   * Fsync an already-written file (and best-effort its directory) to upgrade a
   * prior checkpoint-tier write to durable without rewriting its content.
   * Throws on fsync failure so the caller's save reports an io_error instead
   * of persisting a durable metadata revision over non-durable transcript
   * bytes.
   */
  private async fsyncExistingFile(
    filePath: string,
    dir: string,
  ): Promise<void> {
    let file: SessionStoreAtomicFile | undefined;
    try {
      file = await this.atomicFileOps.open(filePath, "r");
      await file.sync();
    } finally {
      if (file !== undefined) {
        try {
          await file.close();
        } catch {
          // Best-effort cleanup.
        }
      }
    }
    await this.fsyncDirectoryBestEffort(dir);
  }

  private async fsyncDirectoryBestEffort(dir: string): Promise<void> {
    let file: SessionStoreAtomicFile | undefined;
    try {
      file = await this.atomicFileOps.open(dir, "r");
      await file.sync();
    } catch {
      // Some file systems/platforms do not allow fsync on directories.
    } finally {
      if (file !== undefined) {
        try {
          await file.close();
        } catch {
          // Best-effort cleanup.
        }
      }
    }
  }

  private resolvePersistedProjectScope(
    sessionId: string,
    metadataScope: SessionProjectScope | undefined,
    summaryScope: SessionProjectScope | undefined,
  ): SessionProjectScope | undefined {
    if (this.isSessionProjectScope(metadataScope)) {
      if (
        summaryScope !== undefined &&
        !this.projectScopesEqual(metadataScope, summaryScope)
      ) {
        this.log?.(
          `[history] Normalized conflicting project summary for session ${sessionId}; persisted metadata is authoritative.`,
        );
      }
      return metadataScope;
    }
    if (this.isSessionProjectScope(summaryScope)) return summaryScope;
    if (this.legacyProjectScope !== undefined) {
      this.log?.(
        `[history] Session ${sessionId} has no project scope; using the activation-time legacy primary project until its next successful save.`,
      );
      return this.legacyProjectScope;
    }
    return undefined;
  }

  private withAuthoritativeProjectScope(
    summary: SessionSummary,
    projectScope: SessionProjectScope | undefined,
  ): SessionSummary {
    if (this.projectScopesEqual(summary.projectScope, projectScope))
      return summary;
    return { ...summary, projectScope };
  }

  private projectScopesEqual(
    left: SessionProjectScope | undefined,
    right: SessionProjectScope | undefined,
  ): boolean {
    if (left === undefined || right === undefined) return left === right;
    return (
      left.schemaVersion === right.schemaVersion &&
      left.kind === right.kind &&
      left.projectId === right.projectId &&
      left.workspaceFolderUri === right.workspaceFolderUri &&
      left.displayName === right.displayName &&
      left.rootPath === right.rootPath
    );
  }

  private isSessionProjectScope(
    value: SessionProjectScope | undefined,
  ): value is SessionProjectScope {
    return (
      value?.schemaVersion === SESSION_PROJECT_SCOPE_SCHEMA_VERSION &&
      value.kind === "project" &&
      typeof value.projectId === "string" &&
      value.projectId.length > 0 &&
      typeof value.workspaceFolderUri === "string" &&
      value.workspaceFolderUri.length > 0 &&
      typeof value.displayName === "string" &&
      (value.rootPath === undefined || typeof value.rootPath === "string")
    );
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

  /** Legacy sync rename kept for callers without revision tracking. */
  rename(sessionId: string, title: string): boolean {
    const entry = this.index.get(sessionId);
    if (!entry) return false;
    entry.title = title;
    this.index.set(sessionId, entry);
    this.flushIndexSync();
    return true;
  }

  /** Legacy sync delete kept for callers without revision tracking. */
  delete(sessionId: string): boolean {
    if (!this.index.has(sessionId)) return false;
    this.index.delete(sessionId);
    this.clearSessionWriteState(sessionId);
    this.flushIndexSync();

    // Remove session directory
    const sessionDir = path.join(this.historyDir, sessionId);
    this.forgetEnsuredDirs(sessionDir);
    try {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    } catch {
      // Best-effort
    }
    return true;
  }

  /** Drop per-session transcript-skip and durability tracking. */
  private clearSessionWriteState(sessionId: string): void {
    this.lastMessagesDigest.delete(sessionId);
    this.lastTranscriptRevision.delete(sessionId);
    this.messagesFileDurability.delete(sessionId);
    this.ensuredPayloadHashes.delete(sessionId);
  }

  private forgetEnsuredDirs(sessionDir: string): void {
    for (const dir of this.ensuredDirs) {
      if (dir === sessionDir || dir.startsWith(sessionDir + path.sep)) {
        this.ensuredDirs.delete(dir);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private ensureDir(dir: string): void {
    if (this.ensuredDirs.has(dir)) return;
    fs.mkdirSync(dir, { recursive: true });
    this.ensuredDirs.add(dir);
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
