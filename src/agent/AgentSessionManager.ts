import type { AgentConfig, SessionInfo } from "./types.js";
import { AgentSession } from "./AgentSession.js";
import { AgentEngine } from "./AgentEngine.js";
import type { AgentEvent } from "./types.js";
import type { AgentMode } from "./modes.js";
import type { ToolDispatchContext, BgStatusResult } from "./toolAdapter.js";
import type { SessionStore, SessionSummary } from "./SessionStore.js";
import type { BgSessionInfo } from "../shared/types.js";
import {
  CheckpointManager,
  type Checkpoint,
  type RevertPreview,
} from "./CheckpointManager.js";

export class AgentSessionManager {
  private sessions = new Map<string, AgentSession>();
  private foregroundId: string | null = null;
  private engine: AgentEngine | null = null;
  private config: AgentConfig;
  private cwd: string;
  private apiKey?: string;
  private toolCtx?: ToolDispatchContext;
  private devMode: boolean;
  private store?: SessionStore;
  private log?: (msg: string) => void;

  /** CheckpointManager shared across sessions (one shadow repo per workspace) */
  private checkpointManager: CheckpointManager | null = null;
  /** Checkpoints per session: sessionId → Checkpoint[] */
  private checkpoints = new Map<string, Checkpoint[]>();
  /** Pending waiters for background session completion: sessionId → resolvers */
  private bgResultWaiters = new Map<string, Array<(result: string) => void>>();

  /** Callback invoked with each event from the running agent */
  onEvent?: (sessionId: string, event: AgentEvent) => void;

  /** Callback when session list changes */
  onSessionsChanged?: () => void;

  constructor(
    config: AgentConfig,
    cwd: string,
    apiKey?: string,
    devMode?: boolean,
    store?: SessionStore,
    log?: (msg: string) => void,
  ) {
    this.config = config;
    this.cwd = cwd;
    this.apiKey = apiKey;
    this.devMode = devMode ?? false;
    this.store = store;
    this.log = log;

    // Initialize checkpoint manager asynchronously — failures are non-fatal
    this.checkpointManager = new CheckpointManager({
      workspaceDir: cwd,
      taskId: "agent",
      log: (msg) => log?.(msg),
    });
    this.checkpointManager.initialize().catch((err) => {
      log?.(`[checkpoint] Init error: ${err}`);
    });
  }

  setToolContext(ctx: ToolDispatchContext): void {
    this.toolCtx = ctx;
    if (this.engine) {
      this.engine.setToolContext(ctx);
    }
  }

  private getEngine(): AgentEngine {
    if (!this.engine) {
      this.engine = new AgentEngine(this.apiKey, this.log);
      if (this.toolCtx) {
        this.engine.setToolContext(this.toolCtx);
      }
    }
    return this.engine;
  }

  updateConfig(config: Partial<AgentConfig>): void {
    Object.assign(this.config, config);
  }

  getConfig(): AgentConfig {
    return this.config;
  }

  async createSession(
    mode: string,
    opts?: { activeFilePath?: string },
  ): Promise<AgentSession> {
    const session = await AgentSession.create({
      mode,
      config: this.config,
      cwd: this.cwd,
      devMode: this.devMode,
      activeFilePath: opts?.activeFilePath,
    });
    this.sessions.set(session.id, session);
    this.foregroundId = session.id;
    this.onSessionsChanged?.();
    return session;
  }

  /**
   * Rebuild the system prompt for all active foreground sessions.
   * Called when instruction files (AGENTS.md, CLAUDE.md, etc.) change on disk.
   */
  async rebuildSystemPrompts(): Promise<void> {
    const fg = this.getForegroundSession();
    if (!fg) return;
    await fg.rebuildSystemPrompt({ devMode: this.devMode });
  }

  getSession(id: string): AgentSession | undefined {
    return this.sessions.get(id);
  }

  getForegroundSession(): AgentSession | undefined {
    return this.foregroundId ? this.sessions.get(this.foregroundId) : undefined;
  }

  getSessionInfos(): SessionInfo[] {
    return Array.from(this.sessions.values()).map((s) => ({
      id: s.id,
      status: s.status,
      mode: s.mode,
      model: s.model,
      title: s.title,
      messageCount: s.messageCount,
      totalInputTokens: s.totalInputTokens,
      totalOutputTokens: s.totalOutputTokens,
      background: s.background,
      createdAt: s.createdAt,
      lastActiveAt: s.lastActiveAt,
    }));
  }

  async sendMessage(
    sessionId: string | undefined,
    text: string,
    mode: string,
    opts?: { thinkingEnabled?: boolean; activeFilePath?: string },
  ): Promise<void> {
    let session: AgentSession;

    if (sessionId && this.sessions.has(sessionId)) {
      session = this.sessions.get(sessionId)!;
    } else {
      session = await this.createSession(mode, {
        activeFilePath: opts?.activeFilePath,
      });
    }

    // Update thinking budget based on toggle (0 = disabled)
    if (opts?.thinkingEnabled === false) {
      session.thinkingBudget = 0;
    } else if (session.thinkingBudget === 0) {
      // Re-enable with config default
      session.thinkingBudget = this.config.thinkingBudget;
    }

    // Create checkpoint before adding user message.
    // turnIndex is the 0-based index of this human user message in the sequence
    // of human user messages (not counting tool-result messages that also have
    // role "user"). The UI's SET_CHECKPOINT reducer counts messages the same way.
    const turnIndex = session
      .getAllMessages()
      .filter((m) => m.role === "user" && typeof m.content === "string").length;
    const checkpoint =
      (await this.checkpointManager?.createCheckpoint(turnIndex)) ?? null;
    if (checkpoint) {
      const existing = this.checkpoints.get(session.id) ?? [];
      existing.push(checkpoint);
      this.checkpoints.set(session.id, existing);
      this.onEvent?.(session.id, {
        type: "checkpoint_created",
        checkpointId: checkpoint.id,
        turnIndex,
      });
    }

    session.addUserMessage(text);
    session.status = "streaming";

    if (session.messageCount === 1) {
      session.autoTitle();
    }

    this.onSessionsChanged?.();

    try {
      for await (const event of this.getEngine().run(session)) {
        this.onEvent?.(session.id, event);
        if (event.type === "done") {
          this.store?.save(session);
        }
      }
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err);
      session.status = "error";
      this.onEvent?.(session.id, { type: "error", error, retryable: false });
      this.onEvent?.(session.id, {
        type: "done",
        totalInputTokens: session.totalInputTokens,
        totalOutputTokens: session.totalOutputTokens,
        totalCacheReadTokens: session.totalCacheReadTokens,
        totalCacheCreationTokens: session.totalCacheCreationTokens,
      });
      // Still persist on error — partial history is valuable
      this.store?.save(session);
    }

    this.onSessionsChanged?.();
  }

  stopSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.abort();
      session.status = "idle";
      this.onSessionsChanged?.();
    }
  }

  /**
   * Retry the last turn of a session after an error (e.g. auth failure).
   * Re-creates the engine (which re-reads credentials) and re-runs the agent loop.
   */
  async retrySession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Force re-creation of the engine so it picks up refreshed credentials
    this.engine = null;

    session.status = "streaming";
    this.onSessionsChanged?.();

    try {
      for await (const event of this.getEngine().run(session)) {
        this.onEvent?.(session.id, event);
        if (event.type === "done") {
          this.store?.save(session);
        }
      }
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err);
      session.status = "error";
      this.onEvent?.(session.id, { type: "error", error, retryable: false });
      this.onEvent?.(session.id, {
        type: "done",
        totalInputTokens: session.totalInputTokens,
        totalOutputTokens: session.totalOutputTokens,
        totalCacheReadTokens: session.totalCacheReadTokens,
        totalCacheCreationTokens: session.totalCacheCreationTokens,
      });
      this.store?.save(session);
    }

    this.onSessionsChanged?.();
  }

  switchTo(sessionId: string): void {
    if (this.sessions.has(sessionId)) {
      this.foregroundId = sessionId;
      this.onSessionsChanged?.();
    }
  }

  /**
   * Switch the current foreground session to a different mode in-place,
   * preserving its message history and session ID.
   */
  async switchForegroundMode(
    mode: string,
    opts?: { agentMode?: AgentMode; devMode?: boolean },
  ): Promise<AgentSession | null> {
    const session = this.getForegroundSession();
    if (!session) return null;

    await session.setMode(mode, opts);
    this.onSessionsChanged?.();
    this.store?.save(session);
    return session;
  }

  /**
   * Manually condense the foreground session's context.
   * Emits condense or condense_error events via onEvent.
   */
  async condenseCurrentSession(): Promise<void> {
    const session = this.getForegroundSession();
    if (!session) return;

    const engine = this.getEngine();

    try {
      for await (const event of engine.condenseSession(session, false)) {
        this.onEvent?.(session.id, event);
      }
      // Persist after condensing — message history has changed
      this.store?.save(session);
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err);
      this.onEvent?.(session.id, { type: "condense_error", error });
    }
  }

  // ---------------------------------------------------------------------------
  // Checkpoints
  // ---------------------------------------------------------------------------

  /** Return all checkpoints for a session, in creation order. */
  getCheckpoints(sessionId: string): Checkpoint[] {
    return this.checkpoints.get(sessionId) ?? [];
  }

  /**
   * Preview the files that would be affected by reverting to a checkpoint.
   */
  async previewRevert(
    sessionId: string,
    checkpointId: string,
  ): Promise<RevertPreview | null> {
    const checkpoint = this.findCheckpoint(sessionId, checkpointId);
    if (!checkpoint || !this.checkpointManager) return null;
    return this.checkpointManager.previewRevert(checkpoint);
  }

  /**
   * Revert workspace files to the state at `checkpointId`, then truncate the
   * session's message history to that turn.
   *
   * Returns true on success.
   */
  async revertToCheckpoint(
    sessionId: string,
    checkpointId: string,
  ): Promise<boolean> {
    const checkpoint = this.findCheckpoint(sessionId, checkpointId);
    if (!checkpoint || !this.checkpointManager) return false;

    const session = this.sessions.get(sessionId);

    const ok = await this.checkpointManager.revertToCheckpoint(checkpoint);
    if (!ok) return false;

    // Truncate conversation history to the turn that was checkpointed
    if (session) {
      const allMessages = session.getAllMessages();
      // Keep messages up to (but not including) the user message at turnIndex
      const truncated = allMessages.slice(0, checkpoint.turnIndex);
      session.replaceMessages(truncated);
      session.status = "idle";
    }

    // Remove checkpoints created after this one
    const existingCheckpoints = this.checkpoints.get(sessionId) ?? [];
    const idx = existingCheckpoints.findIndex((c) => c.id === checkpointId);
    if (idx !== -1) {
      this.checkpoints.set(sessionId, existingCheckpoints.slice(0, idx + 1));
    }

    this.onSessionsChanged?.();
    return true;
  }

  private findCheckpoint(
    sessionId: string,
    checkpointId: string,
  ): Checkpoint | undefined {
    return this.checkpoints.get(sessionId)?.find((c) => c.id === checkpointId);
  }

  // ---------------------------------------------------------------------------
  // Session history (delegates to SessionStore)
  // ---------------------------------------------------------------------------

  /** List all persisted sessions, most-recent first. */
  listPersistedSessions(): SessionSummary[] {
    return this.store?.list() ?? [];
  }

  /**
   * Load a persisted session's message history into memory and make it the
   * foreground session. Returns the loaded session or null if not found.
   */
  async loadPersistedSession(sessionId: string): Promise<AgentSession | null> {
    if (!this.store) return null;

    const summary = this.store.get(sessionId);
    if (!summary) return null;

    const messages = this.store.loadMessages(sessionId);
    if (!messages) return null;
    const metadata = this.store.loadMetadata(sessionId);

    // Reuse in-memory session if already loaded
    if (this.sessions.has(sessionId)) {
      this.foregroundId = sessionId;
      this.onSessionsChanged?.();
      return this.sessions.get(sessionId)!;
    }

    // Reconstruct session from persisted data
    const session = await AgentSession.create({
      mode: summary.mode,
      config: {
        ...this.config,
        model: summary.model,
      },
      cwd: this.cwd,
      devMode: this.devMode,
    });

    // Restore persisted state
    session.restoreFromStore({
      id: sessionId,
      title: summary.title,
      createdAt: summary.createdAt,
      lastActiveAt: summary.lastActiveAt,
      totalInputTokens: summary.totalInputTokens,
      totalOutputTokens: summary.totalOutputTokens,
      totalCacheReadTokens: metadata?.totalCacheReadTokens ?? 0,
      totalCacheCreationTokens: metadata?.totalCacheCreationTokens ?? 0,
      lastInputTokens: metadata?.lastInputTokens ?? 0,
      // Use 0 for resumed sessions so cache-aware threshold isn't biased by stale prior runs.
      lastCacheReadTokens: 0,
      messages,
    });

    this.sessions.set(sessionId, session);
    this.foregroundId = sessionId;
    this.onSessionsChanged?.();
    return session;
  }

  /**
   * Restore the most recently active persisted session as the foreground session.
   * Called on startup so the last chat is visible after a reload or panel move.
   * Returns the loaded session or null if there are no persisted sessions.
   */
  async restoreLastSession(): Promise<AgentSession | null> {
    if (!this.store) return null;
    const sessions = this.store.list();
    if (sessions.length === 0) return null;
    // list() is already sorted by lastActiveAt descending
    return this.loadPersistedSession(sessions[0].id);
  }

  deletePersistedSession(sessionId: string): boolean {
    const deleted = this.store?.delete(sessionId) ?? false;
    // Also remove from in-memory map if loaded
    if (deleted && this.sessions.has(sessionId)) {
      this.sessions.delete(sessionId);
      if (this.foregroundId === sessionId) {
        this.foregroundId = null;
      }
      this.onSessionsChanged?.();
    }
    return deleted;
  }

  renamePersistedSession(sessionId: string, title: string): boolean {
    const renamed = this.store?.rename(sessionId, title) ?? false;
    // Also update in-memory session if loaded
    if (renamed) {
      const session = this.sessions.get(sessionId);
      if (session) {
        session.title = title;
      }
      this.onSessionsChanged?.();
    }
    return renamed;
  }

  /**
   * Return the text of the first user message for a persisted session.
   * Used by "Copy First Prompt" to prefill a new session.
   */
  loadFirstPrompt(sessionId: string): string | null {
    // Try in-memory first
    const live = this.sessions.get(sessionId);
    if (live) {
      const first = live.getAllMessages()[0];
      if (first?.role === "user" && typeof first.content === "string") {
        return first.content;
      }
    }

    // Fall back to disk
    const messages = this.store?.loadMessages(sessionId);
    if (!messages) return null;
    const first = messages[0];
    if (first?.role === "user" && typeof first.content === "string") {
      return first.content;
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Background agents
  // ---------------------------------------------------------------------------

  /**
   * Spawn a background agent session. Returns the new session's ID immediately.
   * The background session runs concurrently with the current foreground session.
   * Use waitForBackground() to block until it completes.
   */
  async spawnBackground(task: string, message: string): Promise<string> {
    if (!this.toolCtx) {
      throw new Error("No tool context — cannot spawn background agent");
    }

    const mode = this.getForegroundSession()?.mode ?? "code";
    const session = await AgentSession.create({
      mode,
      config: this.config,
      cwd: this.cwd,
      devMode: this.devMode,
      background: true,
    });
    session.title = task.slice(0, 80);
    this.sessions.set(session.id, session);
    this.onSessionsChanged?.();

    // Build a bg-specific tool context: inherit base but block nested spawning,
    // wrap onApprovalRequest to include background task attribution, and prevent
    // background agents from switching the foreground session's mode.
    const baseCtx = this.toolCtx;
    const bgCtx: ToolDispatchContext = {
      ...baseCtx,
      sessionId: session.id,
      onModeSwitch: undefined,
      onApprovalRequest: baseCtx.onApprovalRequest
        ? (req) => baseCtx.onApprovalRequest!({ ...req, backgroundTask: task })
        : undefined,
      onSpawnBackground: undefined,
      onGetBackgroundStatus: undefined,
      onGetBackgroundResult: undefined,
    };

    const bgEngine = new AgentEngine(this.apiKey, this.log);
    bgEngine.setToolContext(bgCtx);

    session.addUserMessage(message);
    session.status = "streaming";

    // Fire-and-forget — runs concurrently alongside the foreground session.
    void (async () => {
      try {
        for await (const event of bgEngine.run(session, {
          isBackground: true,
        })) {
          this.onEvent?.(session.id, event);
        }
      } catch (err: unknown) {
        const error = err instanceof Error ? err.message : String(err);
        session.status = "error";
        this.onEvent?.(session.id, { type: "error", error, retryable: false });
        this.onEvent?.(session.id, {
          type: "done",
          totalInputTokens: session.totalInputTokens,
          totalOutputTokens: session.totalOutputTokens,
          totalCacheReadTokens: session.totalCacheReadTokens,
          totalCacheCreationTokens: session.totalCacheCreationTokens,
        });
      }

      // Resolve any callers waiting on get_background_result
      const lastMsg =
        session.getLastAssistantText() ??
        "(background agent completed without output)";
      for (const resolve of this.bgResultWaiters.get(session.id) ?? []) {
        resolve(lastMsg);
      }
      this.bgResultWaiters.delete(session.id);
      this.onSessionsChanged?.();
    })();

    return session.id;
  }

  /**
   * Non-blocking status check for a background session.
   */
  getBackgroundStatus(sessionId: string): BgStatusResult {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return {
        status: "error",
        done: true,
        partialOutput: "Session not found",
      };
    }
    const done = session.status === "idle" || session.status === "error";
    return {
      status: session.status as BgStatusResult["status"],
      currentTool: session.currentTool,
      done,
      partialOutput: done ? session.getLastAssistantText() : undefined,
    };
  }

  /**
   * Async — blocks until the background session finishes.
   * Returns the last assistant message text.
   */
  waitForBackground(sessionId: string): Promise<string> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return Promise.resolve(
        JSON.stringify({ error: `No background session: ${sessionId}` }),
      );
    }
    // Already done
    if (session.status === "idle" || session.status === "error") {
      return Promise.resolve(session.getLastAssistantText() ?? "(no result)");
    }
    return new Promise((resolve) => {
      const waiters = this.bgResultWaiters.get(sessionId) ?? [];
      waiters.push(resolve);
      this.bgResultWaiters.set(sessionId, waiters);
    });
  }

  /**
   * Return status info for all background sessions (for the UI strip).
   */
  getBgSessionInfos(): BgSessionInfo[] {
    return Array.from(this.sessions.values())
      .filter((s) => s.background)
      .map((s) => ({
        id: s.id,
        task: s.title,
        status: s.status as BgSessionInfo["status"],
        currentTool: s.currentTool,
      }));
  }
}
