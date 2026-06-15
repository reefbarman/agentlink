import * as crypto from "crypto";

import type { AgentConfig, AgentMessage, SessionInfo } from "./types.js";
import type {
  PersistResult,
  PersistedSessionRecord,
  PersistenceRevision,
  RevertRecoveryState,
} from "./persistenceContracts.js";
import { hasPendingTodos, todoTool, type TodoItem } from "./todoTool.js";
import { AgentSession } from "./AgentSession.js";
import type { WorkspaceFolderInfo } from "./systemPrompt.js";
import { AgentEngine } from "./AgentEngine.js";
import type { AgentEvent } from "./types.js";
import type { AgentMode } from "./modes.js";
import {
  getAgentTools,
  type ToolDispatchContext,
  type BgStatusResult,
} from "./toolAdapter.js";
import type { SessionStore, SessionSummary } from "./SessionStore.js";
import type { BgSessionInfo } from "../shared/types.js";
import type { Checkpoint, RevertPreview } from "./CheckpointManager.js";
import { resolveBackgroundRoute } from "./backgroundModelRouter.js";
import { parseMcpToolName } from "./mcpToolNames.js";
import {
  partitionMcpToolsForDisclosure,
  type McpToolDisclosurePartition,
} from "./mcpToolDisclosure.js";
import { CODEX_CONDENSE_MODEL_FALLBACKS } from "./providers/codex/models.js";
import { getEffectiveAutoCondenseThreshold } from "./modelCondenseThresholds.js";
import {
  callOpenAiCompatibleChat,
  getOpenAiCompatibleEndpoint,
} from "./openaiCompatibleClient.js";

import { summarizeTextForPreview } from "../shared/textSummary.js";
import {
  applyMemoryCandidateNudge,
  countMemoryNudges,
} from "../shared/memoryCandidates.js";
import type {
  SpawnBackgroundRequest,
  SpawnBackgroundResult,
} from "./backgroundTypes.js";
import {
  createDefaultAgentSessionManagerHost,
  mergeAgentSessionManagerHost,
  type ActivityTraceRecorderLike,
  type AgentSessionManagerHost,
  type AgentSessionManagerOptions,
  type CheckpointManagerLike,
} from "./AgentSessionManagerHost.js";

export interface BtwQuestionResult {
  answer: string;
  toolCalls: Array<{ toolName: string; durationMs?: number }>;
  warnings: string[];
  inputTokens: number;
  outputTokens: number;
}

export interface CheckpointRevertPreviewResult {
  checkpointId: string;
  sessionRevision: PersistenceRevision;
  persistenceRevision?: PersistenceRevision;
  workspaceRevision?: string;
  preview: RevertPreview;
}

export type CheckpointRevertResult =
  | { ok: true; restoredPrompt?: string; sessionRevision?: PersistenceRevision }
  | {
      ok: false;
      reason:
        | "not_found"
        | "session_conflict"
        | "checkpoint_stale"
        | "workspace_revert_failed"
        | "persistence_failed";
      currentRevision?: PersistenceRevision;
    };

export type PersistedSessionMutationOperation = "rename" | "delete";

export type PersistedSessionMutationResult =
  | { ok: true }
  | {
      ok: false;
      operation: PersistedSessionMutationOperation;
      reason: "conflict" | "not_owner" | "not_found" | "corrupt" | "io_error";
      currentRevision?: PersistenceRevision;
      message?: string;
    };

export class AgentSessionManager {
  private sessions = new Map<string, AgentSession>();
  private foregroundId: string | null = null;
  private engine: AgentEngine | null = null;
  private config: AgentConfig;
  private cwd: string;
  private apiKey?: string;
  private toolCtx?: ToolDispatchContext;
  private devMode: boolean;
  private persistence?: SessionStore;
  private sessionRevisions = new Map<string, PersistenceRevision>();
  private sessionRevertPending = new Map<string, RevertRecoveryState>();
  private sessionSaveQueues = new Map<string, Promise<void>>();
  private log?: (msg: string) => void;
  private readonly host: AgentSessionManagerHost;
  private activityTraceRecorder: ActivityTraceRecorderLike;

  /** CheckpointManager shared across sessions (one shadow repo per workspace) */
  private checkpointManager: CheckpointManagerLike | null = null;
  /** Checkpoints per session: sessionId → Checkpoint[] */
  private checkpoints = new Map<string, Checkpoint[]>();
  /** Pending waiters for background session completion: sessionId → resolvers */
  private bgResultWaiters = new Map<string, Array<(result: string) => void>>();
  /** Stored final results for completed bg sessions (prevents race in waitForBackground). */
  private bgFinalResults = new Map<string, string>();
  /** Safety timers per bg session (cleared on normal completion). */
  private bgSafetyTimers = new Map<
    string,
    ReturnType<AgentSessionManagerHost["timers"]["setTimeout"]>[]
  >();
  /** Accumulated streaming text for background sessions (for UI preview). */
  private bgStreamingText = new Map<string, string>();
  /** Completion timestamps for background sessions (for auto-dismiss). */
  private bgCompletedAt = new Map<string, number>();
  /** Error messages for background sessions. */
  private bgErrors = new Map<string, string>();
  /** Human-friendly status detail (e.g. active file path) per background session. */
  private bgStatusDetail = new Map<string, string>();
  /** Set of bg session IDs that were explicitly cancelled by the user. */
  private bgCancelled = new Set<string>();
  /** Foreground session that launched each background session. */
  private bgParents = new Map<
    string,
    {
      sessionId: string;
      task: string;
    }
  >();
  /** Background sessions already used to auto-resume a foreground session. */
  private bgAutoResumed = new Set<string>();
  /** Routing metadata per background session. */
  private bgMeta = new Map<
    string,
    {
      resolvedMode: string;
      resolvedModel: string;
      resolvedProvider: string;
      taskClass: string;
      routingReason: string;
      fallbackUsed: boolean;
      toolCalls: number;
      tokenUsage: number;
    }
  >();
  /** Current heuristic phase bucket per background session. */
  private bgPhase = new Map<string, string>();
  /** True while a transient /btw side question is running. */
  private btwInFlight = false;
  /** Background summary state keyed by session id. */
  private bgSummary = new Map<
    string,
    {
      inFlight: boolean;
      generatedAt?: number;
      sourceModel?: string;
      fallbackUsed?: boolean;
      confidence?: number;
      shortStatus?: string;
      lastAttemptAt?: number;
      lastFailureAt?: number;
      lastFailureReason?: string;
      lastInputHash?: string;
      needsRefresh: boolean;
    }
  >();

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
    private readonly bgDefaults: {
      maxConcurrent: number;
    } = {
      maxConcurrent: 3,
    },
    opts?: AgentSessionManagerOptions,
  ) {
    this.config = config;
    this.cwd = cwd;
    this.apiKey = apiKey;
    this.devMode = devMode ?? false;
    this.log = log;
    const defaultHost = createDefaultAgentSessionManagerHost({
      cwd,
      log,
      store,
    });
    this.host = mergeAgentSessionManagerHost(defaultHost, opts?.host);
    this.persistence = this.host.persistence;
    this.activityTraceRecorder = this.host.createActivityTraceRecorder({
      workspaceDir: cwd,
    });

    // Initialize checkpoint manager asynchronously — failures are non-fatal
    this.checkpointManager = this.host.createCheckpointManager({
      workspaceDir: cwd,
      taskId: "agent",
      log: (msg: string) => log?.(msg),
    });
    this.checkpointManager.initialize().catch((err: unknown) => {
      log?.(`[checkpoint] Init error: ${err}`);
    });
  }

  /**
   * Snapshot the open workspace folders so the agent's system prompt can list
   * where each project lives (multi-root workspaces). Read fresh each time so
   * folder add/remove is reflected on the next session create or prompt rebuild.
   */
  private getWorkspaceFolders(): WorkspaceFolderInfo[] {
    return this.host.workspace.getWorkspaceFolders();
  }

  setToolContext(ctx: ToolDispatchContext): void {
    this.toolCtx = ctx;
    if (this.engine) {
      this.engine.setToolRuntime(this.host.createToolRuntime(ctx));
    }
  }

  private recordAndEmitEvent(sessionId: string, event: AgentEvent): void {
    const session = this.sessions.get(sessionId);
    this.activityTraceRecorder.appendAgentEvent(
      sessionId,
      event,
      session?.background ? "background_agent" : "foreground_agent",
    );
    this.onEvent?.(sessionId, event);
  }

  private async ensureCheckpointForTurn(
    session: AgentSession,
    turnIndex: number,
    opts?: { refreshExisting?: boolean },
  ): Promise<Checkpoint | null> {
    if (turnIndex <= 0 || !this.checkpointManager) return null;

    const existingBefore = this.checkpoints.get(session.id) ?? [];
    const existingMatch = existingBefore.find(
      (checkpoint) => checkpoint.turnIndex === turnIndex,
    );
    if (existingMatch && !opts?.refreshExisting) {
      return null;
    }

    const checkpoint = await this.checkpointManager.createCheckpoint(turnIndex);
    if (!checkpoint) return null;

    const existingAfter = this.checkpoints.get(session.id) ?? [];
    const existingIndex = existingAfter.findIndex(
      (candidate) => candidate.turnIndex === turnIndex,
    );

    if (existingIndex !== -1) {
      if (!opts?.refreshExisting) {
        return null;
      }
      const refreshed: Checkpoint = {
        ...existingAfter[existingIndex],
        commitHash: checkpoint.commitHash,
        createdAt: checkpoint.createdAt,
      };
      const next = [...existingAfter];
      next[existingIndex] = refreshed;
      this.checkpoints.set(session.id, next);
      return refreshed;
    }

    const next = [...existingAfter, checkpoint];
    this.checkpoints.set(session.id, next);
    this.recordAndEmitEvent(session.id, {
      type: "checkpoint_created",
      checkpointId: checkpoint.id,
      turnIndex,
    });
    return checkpoint;
  }

  private getEngine(): AgentEngine {
    if (!this.engine) {
      this.engine = this.host.createEngine(this.host.providers, this.log);
      if (this.toolCtx) {
        this.engine.setToolRuntime(this.host.createToolRuntime(this.toolCtx));
      }
    }
    return this.engine;
  }

  updateConfig(config: Partial<AgentConfig>): void {
    Object.assign(this.config, config);
  }

  private getCondenseThresholdForModel(model: string): number {
    try {
      return this.host.config.getCondenseThresholdForModel(model);
    } catch (err) {
      this.log?.(
        `[agent] Failed to resolve configured condense threshold for ${model}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return getEffectiveAutoCondenseThreshold(model);
    }
  }

  private buildConfigForModel(model: string): AgentConfig {
    return {
      ...this.config,
      model,
      autoCondenseThreshold: this.getCondenseThresholdForModel(model),
    };
  }

  private getModelForMode(mode: string): string {
    try {
      return this.host.config.resolveModelForMode(mode, this.config.model);
    } catch (err) {
      this.log?.(
        `[agent] Failed to resolve configured model for mode ${mode}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return this.config.model;
    }
  }

  private applyThresholdToSession(session: AgentSession): void {
    session.autoCondenseThreshold = this.getCondenseThresholdForModel(
      session.model,
    );
  }

  private buildMcpToolDisclosure(): McpToolDisclosurePartition | undefined {
    const mcpHub = this.toolCtx?.mcpHub;
    if (!mcpHub) return undefined;
    const tools = mcpHub.getToolDefs();
    if (tools.length === 0) return undefined;
    const serverNames = new Set(
      tools
        .map((tool) => parseMcpToolName(tool.name)?.serverName)
        .filter((name): name is string => name !== undefined),
    );
    const serverConfigs = [...serverNames].map((serverName) => ({
      serverName,
      mode: mcpHub.getServerConfig(serverName)?.toolDisclosure,
    }));
    return partitionMcpToolsForDisclosure(tools, { serverConfigs });
  }

  private refreshMcpToolDisclosure(session: AgentSession): void {
    session.mcpToolDisclosure = this.buildMcpToolDisclosure();
  }

  getConfig(): AgentConfig {
    return this.config;
  }

  async createSession(
    mode: string,
    opts?: { activeFilePath?: string },
  ): Promise<AgentSession> {
    const model = this.getModelForMode(mode);
    const config = this.buildConfigForModel(model);
    const providerId = this.host.providers.tryResolveProvider(config.model)?.id;
    this.updateConfig({
      model,
      autoCondenseThreshold: config.autoCondenseThreshold,
    });
    const session = await this.host.createSession({
      mode,
      config,
      cwd: this.cwd,
      workspaceFolders: this.getWorkspaceFolders(),
      devMode: this.devMode,
      activeFilePath: opts?.activeFilePath,
      providerId,
      mcpToolDisclosure: this.buildMcpToolDisclosure(),
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
    this.refreshMcpToolDisclosure(fg);
    await fg.rebuildSystemPrompt({
      devMode: this.devMode,
      workspaceFolders: this.getWorkspaceFolders(),
    });
  }

  /**
   * Update the model on the active foreground session.
   * If the model crosses a provider boundary (e.g. Anthropic → Codex),
   * updates the session's providerId and rebuilds the system prompt so
   * provider-specific behavioral tuning takes effect.
   */
  async setModel(model: string): Promise<void> {
    this.updateConfig({
      model,
      autoCondenseThreshold: this.getCondenseThresholdForModel(model),
    });
    const fg = this.getForegroundSession();
    if (!fg) return;

    fg.model = model;
    this.applyThresholdToSession(fg);
    const newProviderId = this.host.providers.tryResolveProvider(model)?.id;
    if (newProviderId !== fg.providerId) {
      fg.providerId = newProviderId;
      await fg.rebuildSystemPrompt({
        devMode: this.devMode,
        workspaceFolders: this.getWorkspaceFolders(),
      });
    }
    await this.maybeAutoCondenseForegroundSession();
  }

  getSession(id: string): AgentSession | undefined {
    return this.sessions.get(id);
  }

  saveAllSessions(): void {
    for (const id of this.sessions.keys()) {
      this.saveSession(id);
    }
  }

  saveSession(id: string): void {
    if (!this.persistence || !this.sessions.has(id)) return;

    if (typeof this.persistence.saveSession !== "function") {
      const session = this.sessions.get(id);
      if (session) this.saveSessionLegacy(session);
      return;
    }

    const run = () => this.saveSessionRevisionAware(id);
    const previous = this.sessionSaveQueues.get(id);
    const next = previous ? previous.then(run, run) : run();
    const tracked = next.finally(() => {
      if (this.sessionSaveQueues.get(id) === tracked) {
        this.sessionSaveQueues.delete(id);
      }
    });
    tracked.catch(() => undefined);
    this.sessionSaveQueues.set(id, tracked);
  }

  private saveSessionLegacy(session: AgentSession): void {
    this.persistence?.save({
      id: session.id,
      mode: session.mode,
      model: session.model,
      title: session.title,
      createdAt: session.createdAt,
      lastActiveAt: session.lastActiveAt,
      totalInputTokens: session.totalInputTokens,
      totalOutputTokens: session.totalOutputTokens,
      totalCacheReadTokens: session.totalCacheReadTokens,
      totalCacheCreationTokens: session.totalCacheCreationTokens,
      lastInputTokens: session.lastInputTokens,
      lastCacheReadTokens: session.lastCacheReadTokens,
      reasoningEffort: session.reasoningEffort,
      background: session.background,
      getLoadedSkills: () => session.getLoadedSkills?.() ?? [],
      getAllMessages: () => session.getAllMessages(),
      checkpoints: this.checkpoints.get(session.id) ?? [],
    });
  }

  private async saveSessionRevisionAware(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session || !this.persistence) return;

    const expectedRevision = this.sessionRevisions.get(id) ?? null;
    let result;
    try {
      result = await this.persistence.saveSession({
        session: this.buildPersistedSessionRecord(session),
        expectedRevision,
      });
    } catch (error) {
      this.log?.(
        `[session] persistence save failed for ${id}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }

    if (result.ok) {
      this.sessionRevisions.set(id, result.revision);
      return;
    }

    if (result.reason === "conflict") {
      this.sessionRevisions.set(id, result.currentRevision);
      this.log?.(
        `[session] persistence conflict for ${id}: expected=${expectedRevision ?? "<create>"} current=${result.currentRevision}`,
      );
      return;
    }

    this.log?.(
      `[session] persistence save failed for ${id}: ${result.reason}${"message" in result ? `: ${result.message}` : ""}`,
    );
  }

  private buildPersistedSessionRecord(
    session: AgentSession,
    opts?: {
      messages?: AgentMessage[];
      checkpoints?: Checkpoint[];
      revertPending?: RevertRecoveryState | null;
    },
  ): PersistedSessionRecord {
    const messages = opts?.messages ?? session.getAllMessages();
    return {
      summary: {
        schemaVersion: 1,
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
        checkpointState: {
          baseCommit: this.checkpointManager?.baseCommit ?? null,
          checkpoints:
            opts?.checkpoints ?? this.checkpoints.get(session.id) ?? [],
        },
        revertPending:
          opts?.revertPending === null
            ? undefined
            : (opts?.revertPending ??
              this.sessionRevertPending.get(session.id)),
      },
    };
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

  async runBtwQuestion(question: string): Promise<BtwQuestionResult> {
    const trimmed = question.trim();
    if (!trimmed) throw new Error("/btw requires a question");
    if (!this.toolCtx) throw new Error("No tool context — cannot run /btw");
    if (this.btwInFlight) {
      throw new Error("Another /btw question is already running");
    }

    const fg = this.getForegroundSession();

    const mode = fg?.mode ?? "code";
    const model = fg?.model ?? this.config.model;
    const providerId =
      fg?.providerId ?? this.host.providers.tryResolveProvider(model)?.id;
    const config: AgentConfig = fg
      ? {
          ...this.buildConfigForModel(model),
          maxTokens: fg.maxTokens,
          thinkingBudget: fg.thinkingBudget,
          autoCondense: fg.autoCondense,
          autoCondenseThreshold: fg.autoCondenseThreshold,
          codexStatefulResponses: fg.codexStatefulResponses,
          codexStoreResponses: fg.codexStoreResponses,
        }
      : this.buildConfigForModel(model);

    const session = await this.host.createSession({
      mode,
      agentMode: fg?.agentMode,
      config,
      cwd: this.cwd,
      workspaceFolders: this.getWorkspaceFolders(),
      devMode: this.devMode,
      activeFilePath: fg?.activeFilePath,
      providerId,
    });

    session.title = `/btw ${trimmed}`.slice(0, 80);
    session.reasoningEffort = fg?.reasoningEffort ?? session.reasoningEffort;
    if (fg) {
      session.systemPrompt = fg.systemPrompt;
      session.replaceMessages(
        structuredClone(fg.getMessages()) as AgentMessage[],
      );
    }
    session.addUserMessage(trimmed, {
      displayText: `/btw ${trimmed}`,
      isSlashCommand: true,
      slashCommandLabel: "/btw",
    });
    session.status = "streaming";

    const sideCtx: ToolDispatchContext = {
      ...this.toolCtx,
      sessionId: session.id,
      mode: session.agentMode.slug,
      onModeSwitch: undefined,
      onApprovalRequest: undefined,
      onQuestion: undefined,
      onSpawnBackground: undefined,
      onGetBackgroundStatus: undefined,
      onGetBackgroundResult: undefined,
      onKillBackground: undefined,
      onFinalStatus: undefined,
      onFileRead: (filePath) => {
        session.trackFileRead(filePath);
      },
      getAdvertisedSkills: () => session.getAdvertisedSkills(),
      getAdvertisedRules: () => session.getAdvertisedRules(),
      onSkillLoad: (skillName) => session.trackLoadedSkill(skillName),
    };

    const engine = this.host.createEngine(this.host.providers, this.log);
    engine.setToolRuntime(this.host.createToolRuntime(sideCtx));

    let answer = "";
    const toolCalls: BtwQuestionResult["toolCalls"] = [];
    const warnings: string[] = [];

    this.btwInFlight = true;
    try {
      for await (const event of engine.run(session, {
        toolProfile: "btw",
        maxApiTurns: 5,
        maxToolCalls: 10,
      })) {
        switch (event.type) {
          case "text_delta":
            answer += event.text;
            break;
          case "tool_result":
            toolCalls.push({
              toolName: event.toolName,
              durationMs: event.durationMs,
            });
            break;
          case "warning":
            warnings.push(event.message);
            break;
          case "error":
            throw new Error(event.error);
        }
      }
    } finally {
      this.btwInFlight = false;
    }

    return {
      answer: session.getLastAssistantText() ?? answer,
      toolCalls,
      warnings,
      inputTokens: session.totalInputTokens,
      outputTokens: session.totalOutputTokens,
    };
  }

  async sendMessage(
    sessionId: string | undefined,
    text: string,
    mode: string,
    opts?: {
      thinkingEnabled?: boolean;
      reasoningEffort?: import("./providers/types.js").ReasoningEffort;
      activeFilePath?: string;
      displayText?: string;
      isSlashCommand?: boolean;
      slashCommandLabel?: string;
      origin?: "vscode" | "browser";
      images?: Array<{ name: string; mimeType: string; base64: string }>;
      documents?: Array<{ name: string; mimeType: string; base64: string }>;
    },
  ): Promise<void> {
    let session: AgentSession;

    if (sessionId && this.sessions.has(sessionId)) {
      session = this.sessions.get(sessionId)!;
    } else {
      session = await this.createSession(mode, {
        activeFilePath: opts?.activeFilePath,
      });
    }

    // Update reasoning effort. Legacy callers can still send thinkingEnabled.
    if (opts?.reasoningEffort) {
      session.reasoningEffort = opts.reasoningEffort;
    } else if (opts?.thinkingEnabled === false) {
      session.reasoningEffort = "none";
    } else if (session.reasoningEffort === "none") {
      session.reasoningEffort = "high";
    }

    // Keep the legacy budget field in sync for budget-based providers.
    if (session.reasoningEffort === "none") {
      session.thinkingBudget = 0;
    } else if (session.thinkingBudget === 0) {
      session.thinkingBudget = this.config.thinkingBudget;
    }

    // Create checkpoint before adding the next user message, but only after the
    // first turn — the initial message has no prior state worth restoring to.
    // `turnIndex` here means "how many visible user turns already exist at this
    // snapshot". Example: immediately before the second user message, turnIndex=1.
    // In the UI that checkpoint is displayed on the first user message.
    const turnIndex = session
      .getAllMessages()
      .filter((m) => m.role === "user" && typeof m.content === "string").length;
    await this.ensureCheckpointForTurn(session, turnIndex, {
      refreshExisting: true,
    });

    // Clear any stale pending interjection from the previous run — if the
    // webview already drained the queue and sent this message via agentSend,
    // the old interjection would otherwise be re-emitted mid-turn as a duplicate.
    session.consumePendingInterjection();
    // Pasted images/PDFs are stored on the message itself so they're injected
    // into every API call (the API is stateless) and survive session restore.
    const priorUserTexts = session
      .getAllMessages()
      .filter(
        (message): message is AgentMessage & { content: string } =>
          message.role === "user" && typeof message.content === "string",
      )
      .map((message) => message.content);
    const memoryNudge =
      opts?.isSlashCommand === true || text.trim().length === 0
        ? { text, nudged: false }
        : applyMemoryCandidateNudge(
            text,
            priorUserTexts,
            countMemoryNudges(priorUserTexts),
          );
    session.addUserMessage(memoryNudge.text, {
      displayText: opts?.displayText ?? (memoryNudge.nudged ? text : undefined),
      isSlashCommand: opts?.isSlashCommand === true,
      slashCommandLabel: opts?.slashCommandLabel,
      origin: opts?.origin,
      images: opts?.images,
      documents: opts?.documents,
    });
    if (opts?.images?.length || opts?.documents?.length) {
      this.log?.(
        `[media] attached media to user message: images=${opts?.images?.length ?? 0} documents=${opts?.documents?.length ?? 0} totalRawMessages=${session.messageCount}`,
      );
    }

    session.status = "streaming";

    if (session.messageCount === 1) {
      session.autoTitle();
    }

    // Persist immediately so the session appears in history even if the
    // API call fails (e.g. network error, auth failure on the first message).
    this.saveSession(session.id);
    let lastPersistedActiveAt = session.lastActiveAt;

    const persistIfHistoryChanged = () => {
      if (session.lastActiveAt !== lastPersistedActiveAt) {
        this.saveSession(session.id);
        lastPersistedActiveAt = session.lastActiveAt;
      }
    };

    // Keep checkpointing in-flight turns so reloads don't drop recent transcript
    // progress. The guard above avoids writes unless message history changed.
    const inFlightPersistTimer = this.host.timers.setInterval(
      persistIfHistoryChanged,
      1000,
    );

    this.onSessionsChanged?.();

    const MAX_AUTO_CONTINUE = 5;
    let autoContinueCount = 0;
    let lastTodos: TodoItem[] = [];

    try {
      while (true) {
        let naturalDone = false;

        for await (const event of this.getEngine().run(session)) {
          if (event.type === "todo_update") {
            lastTodos = event.todos;
          }
          if (event.type === "done") {
            this.saveSession(session.id);
            naturalDone = true;
            // Don't forward yet — check for pending todos first
            continue;
          }
          this.recordAndEmitEvent(session.id, event);

          // After forwarding a user_interjection event, create a checkpoint so
          // the user can revert to the state immediately before that injected
          // turn. Because the message already exists in webview state at this
          // point, the checkpoint will render on the preceding user message.
          if (event.type === "user_interjection") {
            // The interjection is already present in the transcript here, so
            // length - 1 gives the index of that injected user turn.
            const interjectionTurnIndex =
              session
                .getAllMessages()
                .filter(
                  (m) => m.role === "user" && typeof m.content === "string",
                ).length - 1;
            await this.ensureCheckpointForTurn(session, interjectionTurnIndex);
          }
        }

        // Aborted — let ChatViewProvider handle the done notification
        if (session.isAborted) break;

        const pendingModeResume =
          naturalDone && autoContinueCount < MAX_AUTO_CONTINUE
            ? session.consumePendingModeResume()
            : null;
        if (pendingModeResume) {
          autoContinueCount++;
          const reason = pendingModeResume.reason?.trim();
          const followUp = pendingModeResume.followUp?.trim();
          const details = [
            `You just switched this session to ${pendingModeResume.mode} mode.`,
            "Continue immediately in the new mode and start the next concrete implementation step now.",
          ];
          if (reason) {
            details.push(`Switch reason: ${reason}`);
          }
          if (followUp) {
            details.push(`User follow-up: ${followUp}`);
          }
          this.log?.(
            `[agent] auto-continuing (${autoContinueCount}/${MAX_AUTO_CONTINUE}): resumed after switch to ${pendingModeResume.mode}`,
          );
          session.addUserMessage(details.join("\n"));
          session.status = "streaming";
          continue;
        }

        // Check if we should auto-continue due to pending todos
        if (
          naturalDone &&
          autoContinueCount < MAX_AUTO_CONTINUE &&
          hasPendingTodos(lastTodos)
        ) {
          autoContinueCount++;
          this.log?.(
            `[agent] auto-continuing (${autoContinueCount}/${MAX_AUTO_CONTINUE}): pending todos remain`,
          );
          session.addUserMessage(
            "You stopped but there are still pending tasks. Continue with the remaining items.",
          );
          session.status = "streaming";
          continue;
        }

        const completedTurnIndex = session
          .getAllMessages()
          .filter(
            (m) => m.role === "user" && typeof m.content === "string",
          ).length;
        await this.ensureCheckpointForTurn(session, completedTurnIndex);
        this.saveSession(session.id);

        // Emit the deferred done
        this.recordAndEmitEvent(session.id, {
          type: "done",
          totalInputTokens: session.totalInputTokens,
          totalOutputTokens: session.totalOutputTokens,
          totalCacheReadTokens: session.totalCacheReadTokens,
          totalCacheCreationTokens: session.totalCacheCreationTokens,
        });
        break;
      }
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err);
      session.status = "error";
      this.recordAndEmitEvent(session.id, {
        type: "error",
        error,
        retryable: false,
      });
      // Persist before emitting done so sendSessionList sees the saved session
      this.saveSession(session.id);
      this.recordAndEmitEvent(session.id, {
        type: "done",
        totalInputTokens: session.totalInputTokens,
        totalOutputTokens: session.totalOutputTokens,
        totalCacheReadTokens: session.totalCacheReadTokens,
        totalCacheCreationTokens: session.totalCacheCreationTokens,
      });
    } finally {
      this.host.timers.clearInterval(inFlightPersistTimer);
      persistIfHistoryChanged();
      this.onSessionsChanged?.();
    }
  }

  /**
   * Kill a running background agent and return its partial output.
   * Called by the foreground agent via the kill_background_agent tool.
   */
  killBackground(
    sessionId: string,
    reason?: string,
  ): { killed: boolean; partialOutput?: string } {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { killed: false, partialOutput: "Session not found" };
    }
    if (!session.background) {
      return { killed: false, partialOutput: "Not a background session" };
    }
    const isRunning =
      session.status === "streaming" ||
      session.status === "tool_executing" ||
      session.status === "awaiting_approval";
    if (!isRunning) {
      return {
        killed: false,
        partialOutput:
          session.getLastAssistantText() ??
          "(background agent already finished)",
      };
    }

    this.log?.(
      `[bg-kill] session=${sessionId} reason="${reason ?? "no reason"}"`,
    );

    // Capture partial output before stopping
    const partialOutput =
      session.getLastAssistantText() ??
      this.bgStreamingText.get(sessionId) ??
      "(no output captured)";

    // Stop the session (marks as cancelled, aborts, resolves waiters)
    this.stopSession(sessionId);

    return { killed: true, partialOutput };
  }

  stopSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.abort();
      session.status = "idle";
      this.saveSession(session.id);
      // Mark bg sessions as cancelled so the UI can distinguish stop vs complete
      if (session.background) {
        this.bgCancelled.add(sessionId);
        this.markBgCompleted(sessionId);
      }
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
    let lastPersistedActiveAt = session.lastActiveAt;

    const persistIfHistoryChanged = () => {
      if (session.lastActiveAt !== lastPersistedActiveAt) {
        this.saveSession(session.id);
        lastPersistedActiveAt = session.lastActiveAt;
      }
    };

    const inFlightPersistTimer = this.host.timers.setInterval(
      persistIfHistoryChanged,
      1000,
    );
    this.onSessionsChanged?.();

    try {
      for await (const event of this.getEngine().run(session)) {
        if (event.type === "done") {
          this.saveSession(session.id);
        }
        this.recordAndEmitEvent(session.id, event);
      }
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err);
      session.status = "error";
      this.recordAndEmitEvent(session.id, {
        type: "error",
        error,
        retryable: false,
      });
      this.saveSession(session.id);
      this.recordAndEmitEvent(session.id, {
        type: "done",
        totalInputTokens: session.totalInputTokens,
        totalOutputTokens: session.totalOutputTokens,
        totalCacheReadTokens: session.totalCacheReadTokens,
        totalCacheCreationTokens: session.totalCacheCreationTokens,
      });
    } finally {
      this.host.timers.clearInterval(inFlightPersistTimer);
      persistIfHistoryChanged();
      this.onSessionsChanged?.();
    }
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

    const model = this.getModelForMode(mode);
    const newProviderId = this.host.providers.tryResolveProvider(model)?.id;

    session.model = model;
    session.providerId = newProviderId;
    this.applyThresholdToSession(session);
    this.refreshMcpToolDisclosure(session);
    await session.setMode(mode, opts);

    this.updateConfig({
      model,
      autoCondenseThreshold: session.autoCondenseThreshold,
    });

    this.onSessionsChanged?.();
    this.saveSession(session.id);
    return session;
  }

  queueModeSwitchResume(
    sessionId: string,
    mode: string,
    opts?: { reason?: string; followUp?: string },
  ): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.background) return;
    session.queuePendingModeResume(mode, opts);
  }

  /**
   * Manually condense the foreground session's context.
   * Emits condense or condense_error events via onEvent.
   */
  private buildPreservedContext(session: AgentSession): {
    toolNames: string[];
    mcpServerNames: string[];
    activeSkills: string[];
  } {
    this.refreshMcpToolDisclosure(session);
    const connectedMcpToolDefs = this.toolCtx?.mcpHub?.getToolDefs() ?? [];
    const providerMcpToolDefs =
      session.mcpToolDisclosure?.inlineTools ?? connectedMcpToolDefs;
    const rawTools = this.toolCtx
      ? [
          ...getAgentTools(session.agentMode, providerMcpToolDefs, false),
          todoTool,
        ]
      : undefined;
    return {
      toolNames: rawTools?.map((t) => t.name) ?? [],
      mcpServerNames: [
        ...new Set(
          connectedMcpToolDefs
            .map((t) => parseMcpToolName(t.name)?.serverName ?? "")
            .filter((name) => name.length > 0),
        ),
      ],
      activeSkills: [...session.loadedSkills],
    };
  }

  private async condenseSession(
    session: AgentSession,
    isAutomatic: boolean,
  ): Promise<void> {
    const engine = this.getEngine();
    const preservedContext = this.buildPreservedContext(session);
    session.status = "streaming";
    this.onSessionsChanged?.();

    let condenseSucceeded = false;

    try {
      for await (const event of engine.condenseSession(
        session,
        isAutomatic,
        undefined,
        preservedContext,
      )) {
        if (event.type === "condense") {
          condenseSucceeded = true;
        }
        this.recordAndEmitEvent(session.id, event);
      }
      this.saveSession(session.id);

      if (!isAutomatic && condenseSucceeded) {
        try {
          for await (const event of engine.run(session)) {
            if (event.type === "done") {
              this.saveSession(session.id);
            }
            this.recordAndEmitEvent(session.id, event);
          }
        } catch (err: unknown) {
          const error = err instanceof Error ? err.message : String(err);
          session.status = "error";
          this.recordAndEmitEvent(session.id, {
            type: "error",
            error,
            retryable: false,
          });
          this.saveSession(session.id);
          this.recordAndEmitEvent(session.id, {
            type: "done",
            totalInputTokens: session.totalInputTokens,
            totalOutputTokens: session.totalOutputTokens,
            totalCacheReadTokens: session.totalCacheReadTokens,
            totalCacheCreationTokens: session.totalCacheCreationTokens,
          });
          return;
        }
      }
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err);
      this.recordAndEmitEvent(session.id, { type: "condense_error", error });
    } finally {
      session.status = "idle";
      this.onSessionsChanged?.();
    }
  }

  async condenseCurrentSession(): Promise<void> {
    const session = this.getForegroundSession();
    if (!session) return;
    await this.condenseSession(session, false);
  }

  async maybeAutoCondenseForegroundSession(): Promise<void> {
    const session = this.getForegroundSession();
    if (!session || session.background) return;
    if (session.status !== "idle") return;
    if (!this.getEngine().isOverCondenseThreshold(session)) return;
    await this.condenseSession(session, true);
  }

  // ---------------------------------------------------------------------------
  // Checkpoints
  // ---------------------------------------------------------------------------

  /** Return all checkpoints for a session, in creation order. */
  getCheckpoints(sessionId: string): Checkpoint[] {
    return this.checkpoints.get(sessionId) ?? [];
  }

  /**
   * Create a checkpoint for the current workspace/session state on demand.
   * Returns null when no foreground session exists or checkpoint creation fails.
   */
  async createManualCheckpoint(): Promise<Checkpoint | null> {
    const session = this.getForegroundSession();
    if (!session || !this.checkpointManager) return null;

    const turnIndex = session
      .getAllMessages()
      .filter((m) => m.role === "user" && typeof m.content === "string").length;
    if (turnIndex === 0) return null;

    return this.ensureCheckpointForTurn(session, turnIndex, {
      refreshExisting: true,
    });
  }

  /**
   * Preview the files that would be affected by reverting to a checkpoint.
   */
  async previewRevert(
    sessionId: string,
    checkpointId: string,
  ): Promise<CheckpointRevertPreviewResult | null> {
    const checkpoint = this.findCheckpoint(sessionId, checkpointId);
    if (!checkpoint || !this.checkpointManager) return null;
    const preview = await this.checkpointManager.previewRevert(checkpoint);
    if (!preview) return null;
    return {
      checkpointId,
      sessionRevision: this.currentSessionRevisionToken(sessionId),
      persistenceRevision: this.sessionRevisions.get(sessionId),
      workspaceRevision: checkpoint.commitHash,
      preview,
    };
  }

  /**
   * Revert workspace files to the state at `checkpointId`, then truncate the
   * session's message history to that turn.
   */
  async revertToCheckpoint(
    sessionId: string,
    checkpointId: string,
    expectedSessionRevision?: PersistenceRevision,
    expectedPersistenceRevision?: PersistenceRevision,
  ): Promise<CheckpointRevertResult> {
    const checkpoint = this.findCheckpoint(sessionId, checkpointId);
    if (!checkpoint || !this.checkpointManager) {
      return { ok: false, reason: "not_found" };
    }

    const pendingSave = this.sessionSaveQueues.get(sessionId);
    if (pendingSave) {
      await pendingSave.catch(() => undefined);
    }

    const session = this.sessions.get(sessionId);
    if (!session) {
      return { ok: false, reason: "not_found" };
    }

    if (
      expectedSessionRevision &&
      this.currentSessionRevisionToken(sessionId) !== expectedSessionRevision
    ) {
      return {
        ok: false,
        reason: "session_conflict",
        currentRevision: this.currentSessionRevisionToken(sessionId),
      };
    }

    if (
      expectedPersistenceRevision &&
      this.persistence &&
      typeof this.persistence.readSession === "function"
    ) {
      const readResult = await this.persistence.readSession(sessionId);
      if (
        readResult.ok &&
        readResult.revision !== expectedPersistenceRevision
      ) {
        return {
          ok: false,
          reason: "session_conflict",
          currentRevision: readResult.revision,
        };
      }
      if (!readResult.ok && readResult.reason !== "not_found") {
        return { ok: false, reason: "persistence_failed" };
      }
    }

    const truncateResult = this.buildCheckpointTruncation(session, checkpoint);
    if (!truncateResult) {
      return { ok: false, reason: "checkpoint_stale" };
    }

    const existingCheckpoints = this.checkpoints.get(sessionId) ?? [];
    const idx = existingCheckpoints.findIndex((c) => c.id === checkpointId);
    const nextCheckpoints =
      idx === -1 ? existingCheckpoints : existingCheckpoints.slice(0, idx + 1);

    if (
      expectedSessionRevision &&
      this.currentSessionRevisionToken(sessionId) !== expectedSessionRevision
    ) {
      return {
        ok: false,
        reason: "session_conflict",
        currentRevision: this.currentSessionRevisionToken(sessionId),
      };
    }

    const workspaceReverted =
      await this.checkpointManager.revertToCheckpoint(checkpoint);
    if (!workspaceReverted) {
      return { ok: false, reason: "workspace_revert_failed" };
    }

    const saveResult = await this.saveCheckpointRevertResult(
      session,
      truncateResult.messages,
      nextCheckpoints,
    );
    if (!saveResult.ok) {
      await this.persistRevertPending(session, checkpoint, saveResult);
      return saveResult.reason === "conflict"
        ? {
            ok: false,
            reason: "persistence_failed",
            currentRevision: saveResult.currentRevision,
          }
        : { ok: false, reason: "persistence_failed" };
    }
    this.sessionRevertPending.delete(sessionId);
    session.replaceMessages(truncateResult.messages);
    session.status = "idle";
    this.checkpoints.set(sessionId, nextCheckpoints);
    this.onSessionsChanged?.();
    return {
      ok: true,
      restoredPrompt: truncateResult.restoredPrompt,
      sessionRevision: saveResult.revision,
    };
  }

  private currentSessionRevisionToken(sessionId: string): PersistenceRevision {
    const session = this.sessions.get(sessionId);
    const messages = session?.getAllMessages() ?? [];
    const checkpoints = this.checkpoints.get(sessionId) ?? [];
    return crypto
      .createHash("sha256")
      .update(JSON.stringify({ checkpoints, messages }))
      .digest("hex");
  }

  private buildCheckpointTruncation(
    session: AgentSession,
    checkpoint: Checkpoint,
  ): { messages: AgentMessage[]; restoredPrompt?: string } | null {
    const allMessages = session.getAllMessages();
    let restoredPrompt: string | undefined;
    let userCount = 0;
    let keepUntil = allMessages.length;
    for (let i = 0; i < allMessages.length; i++) {
      const message = allMessages[i];
      if (message.role === "user" && typeof message.content === "string") {
        if (userCount === checkpoint.turnIndex) {
          restoredPrompt = message.content;
          keepUntil = i;
          break;
        }
        userCount++;
      }
    }
    if (
      keepUntil === allMessages.length &&
      userCount !== checkpoint.turnIndex
    ) {
      return null;
    }
    return { messages: allMessages.slice(0, keepUntil), restoredPrompt };
  }

  private async saveCheckpointRevertResult(
    session: AgentSession,
    messages: AgentMessage[],
    checkpoints: Checkpoint[],
  ): Promise<PersistResult> {
    if (
      !this.persistence ||
      typeof this.persistence.saveSession !== "function"
    ) {
      return {
        ok: true,
        revision: this.currentSessionRevisionToken(session.id),
      };
    }

    const pendingSave = this.sessionSaveQueues.get(session.id);
    if (pendingSave) {
      await pendingSave.catch(() => undefined);
    }

    const expectedRevision = this.sessionRevisions.get(session.id) ?? null;
    const result = await this.persistence.saveSession({
      session: this.buildPersistedSessionRecord(session, {
        checkpoints,
        messages,
        revertPending: null,
      }),
      expectedRevision,
    });
    if (result.ok) {
      this.sessionRevisions.set(session.id, result.revision);
    } else if (result.reason === "conflict") {
      this.sessionRevisions.set(session.id, result.currentRevision);
    }
    return result;
  }

  private async persistRevertPending(
    session: AgentSession,
    checkpoint: Checkpoint,
    failedSaveResult: PersistResult,
  ): Promise<void> {
    const pending: RevertRecoveryState = {
      checkpointId: checkpoint.id,
      sessionRevision:
        "currentRevision" in failedSaveResult
          ? failedSaveResult.currentRevision
          : (this.sessionRevisions.get(session.id) ?? "unknown"),
      workspaceRevision: checkpoint.commitHash,
      startedAt: Date.now(),
      reason: "workspace_reverted_session_save_failed",
    };
    this.sessionRevertPending.set(session.id, pending);

    if (
      !this.persistence ||
      typeof this.persistence.saveSession !== "function"
    ) {
      return;
    }

    try {
      const readResult = await this.persistence.readSession(session.id);
      if (!readResult.ok) return;
      const result = await this.persistence.saveSession({
        session: {
          ...readResult.value,
          metadata: {
            ...readResult.value.metadata,
            revertPending: pending,
          },
        },
        expectedRevision: readResult.revision,
      });
      if (result.ok) {
        this.sessionRevisions.set(session.id, result.revision);
      }
    } catch (error) {
      this.log?.(
        `[checkpoint] failed to persist revertPending for ${session.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Get the diff from the shadow repo at a given checkpoint.
   * @param scope "turn" = diff since the previous checkpoint (or base), "all" = diff since session start
   */
  async getCheckpointDiff(
    sessionId: string,
    checkpointId: string,
    scope: "turn" | "all",
  ): Promise<string> {
    const checkpoint = this.findCheckpoint(sessionId, checkpointId);
    if (!checkpoint || !this.checkpointManager) return "";

    const baseHash = this.checkpointManager.baseCommit;
    if (!baseHash) return "";

    if (scope === "all") {
      return this.checkpointManager.getDiffBetween(
        baseHash,
        checkpoint.commitHash,
      );
    }

    // "turn" scope: diff from the previous checkpoint to this one
    const all = this.checkpoints.get(sessionId) ?? [];
    const idx = all.findIndex((c) => c.id === checkpointId);
    const fromHash = idx > 0 ? all[idx - 1].commitHash : baseHash;
    return this.checkpointManager.getDiffBetween(
      fromHash,
      checkpoint.commitHash,
    );
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
    return this.persistence?.list() ?? [];
  }

  getPersistedSessionSummary(sessionId: string): SessionSummary | undefined {
    return this.persistence?.get(sessionId);
  }

  getPersistedSessionMessages(sessionId: string): AgentMessage[] | null {
    return this.persistence?.loadMessages(sessionId) ?? null;
  }

  getRevertRecoveryState(sessionId: string): RevertRecoveryState | null {
    return this.sessionRevertPending.get(sessionId) ?? null;
  }

  /**
   * Load a persisted session's message history into memory and make it the
   * foreground session. Returns the loaded session or null if not found.
   */
  async loadPersistedSession(sessionId: string): Promise<AgentSession | null> {
    if (!this.persistence) return null;

    const readResult = await this.persistence.readSession(sessionId);
    if (!readResult.ok) return null;
    const { summary, messages, metadata } = readResult.value;

    // Reuse in-memory session if already loaded
    if (this.sessions.has(sessionId)) {
      if (!this.sessionRevisions.has(sessionId)) {
        this.sessionRevisions.set(sessionId, readResult.revision);
      }
      this.foregroundId = sessionId;
      this.onSessionsChanged?.();
      return this.sessions.get(sessionId)!;
    }

    this.sessionRevisions.set(sessionId, readResult.revision);
    this.checkpoints.set(
      sessionId,
      metadata.checkpointState?.checkpoints ?? [],
    );
    if (metadata.revertPending) {
      this.sessionRevertPending.set(sessionId, metadata.revertPending);
    } else {
      this.sessionRevertPending.delete(sessionId);
    }

    // Reconstruct session from persisted data
    const providerId = this.host.providers.tryResolveProvider(
      summary.model,
    )?.id;
    const session = await this.host.createSession({
      mode: summary.mode,
      config: this.buildConfigForModel(summary.model),
      cwd: this.cwd,
      workspaceFolders: this.getWorkspaceFolders(),
      devMode: this.devMode,
      providerId,
    });

    // Restore persisted state
    session.restoreFromStore({
      id: sessionId,
      title: summary.title,
      createdAt: summary.createdAt,
      lastActiveAt: summary.lastActiveAt,
      totalInputTokens: summary.totalInputTokens,
      totalOutputTokens: summary.totalOutputTokens,
      totalCacheReadTokens: metadata.totalCacheReadTokens ?? 0,
      totalCacheCreationTokens: metadata.totalCacheCreationTokens ?? 0,
      lastInputTokens: metadata.lastInputTokens ?? 0,
      // Use 0 for resumed sessions so cache-aware threshold isn't biased by stale prior runs.
      lastCacheReadTokens: 0,
      reasoningEffort: metadata.reasoningEffort,
      loadedSkills: metadata.loadedSkills ?? [],
      messages,
    });
    await session.rebuildSystemPrompt({
      devMode: this.devMode,
      workspaceFolders: this.getWorkspaceFolders(),
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
    if (!this.persistence) return null;
    const sessions = this.persistence.list();
    if (sessions.length === 0) return null;
    // Abort restore if the user started a foreground session while startup restore
    // was still in flight. This keeps auto-restore from stealing focus back.
    if (this.foregroundId) return null;
    const targetSessionId = sessions[0].id;
    const session = await this.loadPersistedSession(targetSessionId);
    if (!session) return null;
    if (this.foregroundId !== targetSessionId) {
      return null;
    }
    return session;
  }

  async deletePersistedSession(sessionId: string): Promise<boolean> {
    return (await this.deletePersistedSessionWithResult(sessionId)).ok;
  }

  async deletePersistedSessionWithResult(
    sessionId: string,
  ): Promise<PersistedSessionMutationResult> {
    if (!this.persistence) {
      return { ok: false, operation: "delete", reason: "not_found" };
    }

    const pendingSave = this.sessionSaveQueues.get(sessionId);
    if (pendingSave) {
      await pendingSave.catch(() => undefined);
    }

    let deleted: boolean;
    if (typeof this.persistence.deleteSession === "function") {
      const expectedRevision = await this.getExpectedSessionRevision(sessionId);
      if (expectedRevision === null) {
        return { ok: false, operation: "delete", reason: "not_found" };
      }
      const result = await this.persistence.deleteSession({
        sessionId,
        expectedRevision,
      });
      if (result.ok) {
        deleted = true;
      } else {
        return this.handlePersistenceMutationFailure(
          sessionId,
          "delete",
          result,
        );
      }
    } else {
      deleted = this.persistence.delete(sessionId);
    }

    if (!deleted) {
      return { ok: false, operation: "delete", reason: "not_found" };
    }

    this.sessionRevisions.delete(sessionId);
    this.sessionSaveQueues.delete(sessionId);
    if (this.sessions.has(sessionId)) {
      this.sessions.delete(sessionId);
      if (this.foregroundId === sessionId) {
        this.foregroundId = null;
      }
    }
    this.onSessionsChanged?.();
    return { ok: true };
  }

  async renamePersistedSession(
    sessionId: string,
    title: string,
  ): Promise<boolean> {
    return (await this.renamePersistedSessionWithResult(sessionId, title)).ok;
  }

  async renamePersistedSessionWithResult(
    sessionId: string,
    title: string,
  ): Promise<PersistedSessionMutationResult> {
    if (!this.persistence) {
      return { ok: false, operation: "rename", reason: "not_found" };
    }

    let nextRevision: PersistenceRevision | null = null;
    let renamed: boolean;
    if (typeof this.persistence.renameSession === "function") {
      const expectedRevision = await this.getExpectedSessionRevision(sessionId);
      if (expectedRevision === null) {
        return { ok: false, operation: "rename", reason: "not_found" };
      }
      const result = await this.persistence.renameSession({
        sessionId,
        title,
        expectedRevision,
      });
      if (result.ok) {
        renamed = true;
        nextRevision = result.revision;
      } else {
        return this.handlePersistenceMutationFailure(
          sessionId,
          "rename",
          result,
        );
      }
    } else {
      renamed = this.persistence.rename(sessionId, title);
    }

    if (!renamed) {
      return { ok: false, operation: "rename", reason: "not_found" };
    }

    if (nextRevision) {
      this.sessionRevisions.set(sessionId, nextRevision);
    }
    const session = this.sessions.get(sessionId);
    if (session) {
      session.title = title;
    }
    this.onSessionsChanged?.();
    return { ok: true };
  }

  private async getExpectedSessionRevision(
    sessionId: string,
  ): Promise<PersistenceRevision | null> {
    const tracked = this.sessionRevisions.get(sessionId);
    if (tracked) return tracked;
    if (
      !this.persistence ||
      typeof this.persistence.readSession !== "function"
    ) {
      return null;
    }
    const readResult = await this.persistence.readSession(sessionId);
    if (!readResult.ok) {
      this.log?.(
        `[session] persistence revision lookup failed for ${sessionId}: ${readResult.reason}${"message" in readResult ? `: ${readResult.message}` : ""}`,
      );
      return null;
    }
    this.sessionRevisions.set(sessionId, readResult.revision);
    return readResult.revision;
  }

  private handlePersistenceMutationFailure(
    sessionId: string,
    operation: PersistedSessionMutationOperation,
    result: Exclude<PersistResult, { ok: true }>,
  ): PersistedSessionMutationResult {
    if (result.reason === "conflict") {
      this.sessionRevisions.set(sessionId, result.currentRevision);
      this.log?.(
        `[session] persistence ${operation} conflict for ${sessionId}: current=${result.currentRevision}`,
      );
      return {
        ok: false,
        operation,
        reason: "conflict",
        currentRevision: result.currentRevision,
      };
    }
    this.log?.(
      `[session] persistence ${operation} failed for ${sessionId}: ${result.reason}${"message" in result ? `: ${result.message}` : ""}`,
    );
    return {
      ok: false,
      operation,
      reason: result.reason,
      message: "message" in result ? result.message : undefined,
    };
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
    const messages = this.persistence?.loadMessages(sessionId);
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
   * Spawn a background agent session and return the resolved routing metadata.
   */
  async spawnBackground(
    request: SpawnBackgroundRequest,
  ): Promise<SpawnBackgroundResult> {
    if (!this.toolCtx) {
      throw new Error("No tool context — cannot spawn background agent");
    }

    const task = request.task?.trim();
    const message = request.message?.trim();
    if (!task || !message) {
      throw new Error(
        "spawn_background_agent requires non-empty task and message",
      );
    }

    const activeBackgroundCount = Array.from(this.sessions.values()).filter(
      (s) =>
        s.background &&
        (s.status === "streaming" ||
          s.status === "tool_executing" ||
          s.status === "awaiting_approval"),
    ).length;
    if (activeBackgroundCount >= this.bgDefaults.maxConcurrent) {
      const reason = `concurrency limit reached (${this.bgDefaults.maxConcurrent})`;
      this.log?.(`[bg-guard] reject spawn: ${reason}`);
      throw new Error(
        `Background spawn rejected: ${reason}. Wait for another background run to finish.`,
      );
    }

    const fg = this.getForegroundSession();
    const foregroundMode = fg?.mode ?? "code";
    const foregroundModel = fg?.model ?? this.config.model;
    const parentSessionId = fg?.id;

    const route = await resolveBackgroundRoute(this.host.providers, request, {
      mode: foregroundMode,
      model: foregroundModel,
    });

    this.log?.(
      `[bg-route] task=${task} class=${route.taskClass} requested={mode:${request.mode ?? "-"},model:${request.model ?? "-"},provider:${request.provider ?? "-"}} resolved={mode:${route.resolvedMode},model:${route.resolvedModel},provider:${route.resolvedProvider}} fallback=${route.fallbackUsed} reason="${route.routingReason}"`,
    );

    const bgConfig: AgentConfig = {
      ...this.buildConfigForModel(route.resolvedModel),
      // Apply per-task-class thinking budget override
      ...(route.thinkingBudget !== undefined
        ? { thinkingBudget: route.thinkingBudget }
        : {}),
    };

    const providerId =
      this.host.providers.tryResolveProvider(route.resolvedModel)?.id ??
      route.resolvedProvider;

    // Use lightweight prompt for review task classes to reduce system prompt bloat
    const isReviewTask = route.taskClass.startsWith("review_");

    const session = await this.host.createSession({
      mode: route.resolvedMode,
      config: bgConfig,
      cwd: this.cwd,
      workspaceFolders: this.getWorkspaceFolders(),
      devMode: this.devMode,
      background: true,
      isBackground: true,
      lightweight: isReviewTask,
      providerId,
    });

    if (route.thinkingBudget === 0) {
      session.reasoningEffort = "none";
    }

    session.title = task.slice(0, 80);
    // Set status to "streaming" BEFORE registering the session, so the first
    // bgSessionsUpdate the UI receives already shows the agent as running
    // (not briefly "idle"/done).
    session.status = "streaming";
    this.sessions.set(session.id, session);
    if (parentSessionId) {
      this.bgParents.set(session.id, {
        sessionId: parentSessionId,
        task,
      });
    }
    this.bgMeta.set(session.id, {
      resolvedMode: route.resolvedMode,
      resolvedModel: route.resolvedModel,
      resolvedProvider: route.resolvedProvider,
      taskClass: route.taskClass,
      routingReason: route.routingReason,
      fallbackUsed: route.fallbackUsed,
      toolCalls: 0,
      tokenUsage: 0,
    });
    this.onSessionsChanged?.();

    // Build a bg-specific tool context: inherit base but block nested spawning,
    // wrap onApprovalRequest / onQuestion to attribute the request to the
    // background task, and prevent background agents from switching the
    // foreground session's mode.
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
      onKillBackground: undefined,
      onQuestion: baseCtx.onQuestion
        ? (context, questions, bgSessionId) =>
            baseCtx.onQuestion!(context, questions, bgSessionId, task)
        : undefined,
    };

    const bgEngine = this.host.createEngine(this.host.providers, this.log);
    bgEngine.setToolRuntime(this.host.createToolRuntime(bgCtx));

    session.addUserMessage(message);

    // Fire-and-forget — runs concurrently alongside the foreground session.
    // Background agents run indefinitely (like foreground agents) using
    // auto-condensing to manage context. The foreground agent can kill
    // a background agent via the kill_background_agent tool if needed.
    void (async () => {
      let lastPersistedActiveAt = session.lastActiveAt;
      const persistIfHistoryChanged = () => {
        if (session.lastActiveAt !== lastPersistedActiveAt) {
          this.saveSession(session.id);
          lastPersistedActiveAt = session.lastActiveAt;
        }
      };
      const inFlightPersistTimer = this.host.timers.setInterval(
        persistIfHistoryChanged,
        1000,
      );

      try {
        for await (const event of bgEngine.run(session, {
          isBackground: true,
          toolProfile: route.toolProfile,
        })) {
          if (event.type === "text_delta") {
            this.appendBgStreamingText(session.id, event.text);
          }
          if (event.type === "tool_start") {
            // Clear stale detail from previous tool runs.
            this.bgStatusDetail.delete(session.id);
          }
          if (event.type === "tool_result") {
            const detail = this.extractToolStatusDetail(
              event.toolName,
              event.input,
            );
            if (detail) {
              this.bgStatusDetail.set(session.id, detail);
            }
          }

          // Track tool calls and token usage for observability
          const meta = this.bgMeta.get(session.id);
          if (meta) {
            if (event.type === "tool_start") {
              meta.toolCalls += 1;
            }
            if (event.type === "api_request") {
              meta.tokenUsage += event.uncachedInputTokens + event.outputTokens;
            }
          }

          const isCancelled = this.bgCancelled.has(session.id);
          const status =
            isCancelled && session.status === "idle"
              ? "cancelled"
              : (session.status as BgSessionInfo["status"]);
          this.maybeScheduleBgSummary({
            sessionId: session.id,
            event,
            status,
            currentTool: session.currentTool,
            streamingText: this.bgStreamingText.get(session.id),
            resultText:
              session.status === "idle" || session.status === "error"
                ? session.getLastAssistantText()
                : undefined,
            errorMessage: this.bgErrors.get(session.id),
            statusDetail: this.bgStatusDetail.get(session.id),
          });

          this.recordAndEmitEvent(session.id, event);
        }
      } catch (err: unknown) {
        const error = err instanceof Error ? err.message : String(err);
        session.status = "error";
        this.setBgError(session.id, error);
        this.recordAndEmitEvent(session.id, {
          type: "error",
          error,
          retryable: false,
        });
        this.recordAndEmitEvent(session.id, {
          type: "done",
          totalInputTokens: session.totalInputTokens,
          totalOutputTokens: session.totalOutputTokens,
          totalCacheReadTokens: session.totalCacheReadTokens,
          totalCacheCreationTokens: session.totalCacheCreationTokens,
        });
      } finally {
        this.host.timers.clearInterval(inFlightPersistTimer);
        persistIfHistoryChanged();
      }

      // Clear transient status detail once the run has finished.
      this.bgStatusDetail.delete(session.id);

      // Mark completion time for auto-dismiss
      this.markBgCompleted(session.id);

      // Resolve any callers waiting on get_background_result
      const fallbackMsg = this.bgErrors.get(session.id)
        ? `Background agent stopped: ${this.bgErrors.get(session.id)}`
        : "(background agent completed without output)";
      const resultText = session.getLastAssistantText() ?? fallbackMsg;

      // Store result BEFORE resolving waiters to close the race window
      this.bgFinalResults.set(session.id, resultText);

      // Clear all safety timers for this session
      for (const t of this.bgSafetyTimers.get(session.id) ?? [])
        this.host.timers.clearTimeout(t);
      this.bgSafetyTimers.delete(session.id);

      for (const resolve of this.bgResultWaiters.get(session.id) ?? []) {
        resolve(resultText);
      }
      this.bgResultWaiters.delete(session.id);
      this.onSessionsChanged?.();
      void this.resumeParentAfterBackgroundCompletion(session.id, resultText);

      // Cleanup stored result after 5 minutes to prevent unbounded memory growth
      this.host.timers.setTimeout(
        () => {
          this.bgFinalResults.delete(session.id);
          this.bgParents.delete(session.id);
          this.bgAutoResumed.delete(session.id);
        },
        5 * 60 * 1000,
      );
    })();

    return {
      sessionId: session.id,
      resolvedMode: route.resolvedMode,
      resolvedModel: route.resolvedModel,
      resolvedProvider: route.resolvedProvider,
      taskClass: route.taskClass,
      routingReason: route.routingReason,
      fallbackUsed: route.fallbackUsed,
    };
  }

  private normalizeBgStatusPhrase(status: string): string {
    const raw = status.trim();
    if (!raw) return "";

    const normalized = raw
      .toLowerCase()
      .replace(/[_-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    const directMap: Record<string, string> = {
      "streaming active": "Thinking…",
      streaming: "Thinking…",
      "streaming thinking": "Thinking…",
      "streaming file analysis": "Reviewing code",
      "streaming file list": "Scanning files",
      "file analysis": "Reviewing code",
      "file list": "Scanning files",
      analysis: "Reviewing code",
      reviewing: "Reviewing code",
      "tool call": "Running tool",
      "tool calls": "Running tools",
      "tool execution": "Running tool",
      executing: "Running tool",
      done: "Done",
      complete: "Done",
      completed: "Done",
      finished: "Done",
      cancel: "Cancelled",
      cancelled: "Cancelled",
      canceled: "Cancelled",
      error: "Error",
      failed: "Error",
      waiting: "Awaiting input",
      "awaiting approval": "Awaiting approval",
      approval: "Awaiting approval",
    };

    if (directMap[normalized]) return directMap[normalized];

    if (normalized.startsWith("streaming ")) {
      const rest = normalized.replace(/^streaming\s+/, "");
      if (rest.includes("file") && rest.includes("analysis")) {
        return "Reviewing code";
      }
      if (rest.includes("file") && rest.includes("list")) {
        return "Scanning files";
      }
      if (rest.includes("tool")) {
        return "Running tool";
      }
      if (
        rest.includes("search") ||
        rest.includes("inspect") ||
        rest.includes("analy")
      ) {
        return "Reviewing code";
      }
      return "Thinking…";
    }

    // Lightweight humanization fallback: Title Case with compact spacing.
    return normalized
      .split(" ")
      .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
      .join(" ");
  }

  private extractToolStatusDetail(toolName: string, input?: unknown): string {
    if (!input || typeof input !== "object") return "";

    const tool = toolName.toLowerCase();
    const obj = input as Record<string, unknown>;
    const pathVal = typeof obj.path === "string" ? obj.path.trim() : "";

    if (!pathVal) return "";

    const compactPath =
      pathVal.length > 60 ? `…${pathVal.slice(-57)}` : pathVal;

    if (tool.includes("read_file")) return `Reading ${compactPath}`;
    if (tool.includes("search_files")) return `Searching ${compactPath}`;
    if (tool.includes("write_file")) return `Writing ${compactPath}`;
    if (tool.includes("find_and_replace")) return `Editing ${compactPath}`;
    if (tool.includes("rename_symbol")) return `Renaming in ${compactPath}`;

    return "";
  }

  private inferBgDisplayStatus(args: {
    status: BgSessionInfo["status"];
    currentTool?: string;
    streamingText?: string;
    resultText?: string;
    errorMessage?: string;
    statusDetail?: string;
  }): string {
    const tool = (args.currentTool ?? "").toLowerCase();
    const textWindow = [args.streamingText, args.resultText]
      .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
      .join("\n")
      .toLowerCase()
      .slice(-700);

    if (args.status === "awaiting_approval") return "Awaiting approval";
    if (args.status === "idle") return "Done";
    if (args.status === "cancelled") return "Cancelled";
    if (args.status === "error") {
      if (args.errorMessage?.trim()) return "Error";
      return "Error";
    }

    if (args.statusDetail?.trim()) {
      return args.statusDetail;
    }

    const isTestCommand =
      tool.includes("execute_command") &&
      /(\bnpm\s+test\b|\bpnpm\s+test\b|\byarn\s+test\b|\bvitest\b|\bjest\b|\blint\b|\btsc\b|\bbuild\b)/i.test(
        textWindow,
      );

    if (
      tool.includes("read_file") ||
      tool.includes("search_files") ||
      tool.includes("codebase_search") ||
      tool.includes("list_files") ||
      tool.includes("get_symbols") ||
      tool.includes("get_references") ||
      tool.includes("go_to_definition") ||
      tool.includes("go_to_implementation") ||
      tool.includes("get_type_hierarchy") ||
      tool.includes("get_hover") ||
      tool.includes("get_completions")
    ) {
      if (
        /\bi found\b|\bfound the issue\b|\broot cause\b|\bproblem is\b/.test(
          textWindow,
        )
      ) {
        return "Issue found";
      }
      if (/\binspect\b|\binvestigat\w*\b|\banaly\w*\b/.test(textWindow)) {
        return "Inspecting code";
      }
      return "Reading code";
    }

    if (
      tool.includes("apply_diff") ||
      tool.includes("write_file") ||
      tool.includes("find_and_replace") ||
      tool.includes("rename_symbol") ||
      tool.includes("apply_code_action")
    ) {
      if (/\bapplied patch\b|\bupdated\b|\bpatched\b/.test(textWindow)) {
        return "Patch applied";
      }
      return "Editing code";
    }

    if (tool.includes("execute_command")) {
      if (
        /\bre-ran tests\b|\ball tests pass\b|\btests pass\b|\bverified\b/.test(
          textWindow,
        )
      ) {
        return "Verifying fix";
      }
      return isTestCommand ? "Running tests" : "Running command";
    }

    if (tool.includes("ask_user")) return "Waiting input";

    if (args.status === "tool_executing") {
      if (/\bre-ran tests\b|\brerun\b|\btest\b/.test(textWindow)) {
        return "Running tests";
      }
      if (/\bapplied patch\b|\bupdating\b|\bpatching\b/.test(textWindow)) {
        return "Updating code";
      }
      if (/\bi found\b|\bfound the issue\b|\broot cause\b/.test(textWindow)) {
        return "Issue found";
      }
      return "Running…";
    }

    if (
      /\bneed confirmation\b|\bwaiting for\b|\bblocked on\b/.test(textWindow)
    ) {
      return "Awaiting input";
    }
    if (/\bnext i('|’)ll\b|\bi('|’)m going to\b|\binspect\b/.test(textWindow)) {
      return "Inspecting code";
    }
    if (/\bi found\b|\bfound the issue\b|\broot cause\b/.test(textWindow)) {
      return "Issue found";
    }

    return "Thinking…";
  }

  private getOrInitBgSummary(sessionId: string): {
    inFlight: boolean;
    generatedAt?: number;
    sourceModel?: string;
    fallbackUsed?: boolean;
    confidence?: number;
    shortStatus?: string;
    lastAttemptAt?: number;
    lastFailureAt?: number;
    lastFailureReason?: string;
    lastInputHash?: string;
    needsRefresh: boolean;
  } {
    const existing = this.bgSummary.get(sessionId);
    if (existing) return existing;
    const init = {
      inFlight: false,
      needsRefresh: true,
    };
    this.bgSummary.set(sessionId, init);
    return init;
  }

  private async tryRefreshBgSummary(args: {
    sessionId: string;
    trigger: "phase_change" | "important_tool" | "error" | "done";
    status: BgSessionInfo["status"];
    currentTool?: string;
    streamingText?: string;
    resultText?: string;
    errorMessage?: string;
  }): Promise<void> {
    const mode = this.host.config.getBgSummaryMode();
    if (mode === "heuristic") return;

    const summary = this.getOrInitBgSummary(args.sessionId);
    const now = Date.now();
    const cooldownMs = 10_000;

    if (summary.inFlight) return;
    if (summary.lastAttemptAt && now - summary.lastAttemptAt < cooldownMs)
      return;

    const contextText = [
      `status=${args.status}`,
      args.currentTool ? `tool=${args.currentTool}` : null,
      args.errorMessage ? `error=${args.errorMessage}` : null,
      args.streamingText ? `stream=${args.streamingText.slice(-500)}` : null,
      args.resultText ? `result=${args.resultText.slice(0, 1000)}` : null,
    ]
      .filter((v): v is string => Boolean(v))
      .join("\n");

    const contextHash = `${args.status}|${args.currentTool ?? ""}|${contextText.slice(-400)}`;
    if (summary.lastInputHash === contextHash && !summary.needsRefresh) return;

    summary.inFlight = true;
    summary.lastAttemptAt = now;
    summary.lastInputHash = contextHash;
    this.onSessionsChanged?.();

    try {
      const session = this.sessions.get(args.sessionId);
      if (!session) return;

      const systemPrompt = [
        "Summarize the background agent's current state for a tiny UI status area.",
        "Return ONLY JSON with shape:",
        '{"status":"string","confidence":0.0}',
        "Rules:",
        "- status must be 1-3 words (hard max 5 words)",
        "- concise, phase-oriented wording",
        "- confidence between 0 and 1",
      ].join("\n");

      const userPayload = [
        `Trigger: ${args.trigger}`,
        `Context:\n${contextText}`,
      ].join("\n\n");

      let text = "";
      let selectedModel: string | undefined;
      let fallbackUsed = false;
      let lastError = "";

      if (mode === "openai") {
        const endpoint = getOpenAiCompatibleEndpoint();
        try {
          const result = await callOpenAiCompatibleChat({
            endpoint,
            systemPrompt,
            userContent: userPayload,
            maxTokens: 120,
            temperature: 0,
          });
          text = result.content;
          selectedModel = endpoint.model || "openai-compatible";
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
        }
      } else {
        const provider = this.host.providers.tryResolveProvider(session.model);
        if (!provider) {
          summary.lastFailureAt = Date.now();
          summary.lastFailureReason = `No provider for model ${session.model}`;
          summary.needsRefresh = false;
          return;
        }

        const modelCandidates =
          provider.id === "codex"
            ? ["gpt-5.4-mini", ...CODEX_CONDENSE_MODEL_FALLBACKS]
            : [provider.condenseModel];
        const uniqueModels = [...new Set(modelCandidates)];

        for (let i = 0; i < uniqueModels.length; i++) {
          const model = uniqueModels[i];
          try {
            const result = await provider.complete({
              model,
              systemPrompt,
              messages: [{ role: "user", content: userPayload }],
              maxTokens: 120,
              temperature: 0,
            });
            selectedModel = model;
            fallbackUsed = i > 0;
            text = result.text;
            break;
          } catch (err) {
            lastError = err instanceof Error ? err.message : String(err);
          }
        }
      }

      if (!selectedModel || !text.trim()) {
        summary.lastFailureAt = Date.now();
        summary.lastFailureReason =
          lastError || "No model candidate produced a summary";
        summary.needsRefresh = false;
        return;
      }

      let shortStatus = "";
      let confidence: number | undefined;
      try {
        const unfenced = text
          .trim()
          .replace(/^```(?:json)?\s*/i, "")
          .replace(/\s*```$/, "")
          .trim();
        const parsed = JSON.parse(unfenced) as {
          status?: unknown;
          confidence?: unknown;
        };
        shortStatus =
          typeof parsed.status === "string" ? parsed.status.trim() : "";
        confidence =
          typeof parsed.confidence === "number" ? parsed.confidence : undefined;
      } catch {
        shortStatus = "";
      }

      if (!shortStatus) {
        summary.lastFailureAt = Date.now();
        summary.lastFailureReason = "Summary response was not valid JSON";
        summary.needsRefresh = false;
        return;
      }

      const wordCount = shortStatus.split(/\s+/).filter(Boolean).length;
      if (wordCount < 1 || wordCount > 5) {
        summary.lastFailureAt = Date.now();
        summary.lastFailureReason = "Summary status violated 1-5 word rule";
        summary.needsRefresh = false;
        return;
      }

      summary.shortStatus = shortStatus;
      summary.confidence = confidence;
      summary.generatedAt = Date.now();
      summary.sourceModel = selectedModel;
      summary.fallbackUsed = fallbackUsed;
      summary.lastFailureReason = undefined;
      summary.needsRefresh = false;
    } finally {
      summary.inFlight = false;
      this.onSessionsChanged?.();
    }
  }

  private maybeScheduleBgSummary(args: {
    sessionId: string;
    event: AgentEvent;
    status: BgSessionInfo["status"];
    currentTool?: string;
    streamingText?: string;
    resultText?: string;
    errorMessage?: string;
    statusDetail?: string;
  }): void {
    const nextPhase = this.inferBgDisplayStatus({
      status: args.status,
      currentTool: args.currentTool,
      streamingText: args.streamingText,
      resultText: args.resultText,
      errorMessage: args.errorMessage,
      statusDetail: args.statusDetail,
    });

    const prevPhase = this.bgPhase.get(args.sessionId);
    if (prevPhase !== nextPhase) {
      this.bgPhase.set(args.sessionId, nextPhase);
      void this.tryRefreshBgSummary({
        sessionId: args.sessionId,
        trigger: "phase_change",
        status: args.status,
        currentTool: args.currentTool,
        streamingText: args.streamingText,
        resultText: args.resultText,
        errorMessage: args.errorMessage,
      });
      return;
    }

    if (args.event.type === "tool_result") {
      const name = args.event.toolName.toLowerCase();
      const important =
        name.includes("execute_command") ||
        name.includes("apply_diff") ||
        name.includes("write_file") ||
        name.includes("ask_user");
      if (important) {
        void this.tryRefreshBgSummary({
          sessionId: args.sessionId,
          trigger: "important_tool",
          status: args.status,
          currentTool: args.currentTool,
          streamingText: args.streamingText,
          resultText: args.resultText,
          errorMessage: args.errorMessage,
        });
      }
      return;
    }

    if (args.event.type === "error") {
      void this.tryRefreshBgSummary({
        sessionId: args.sessionId,
        trigger: "error",
        status: args.status,
        currentTool: args.currentTool,
        streamingText: args.streamingText,
        resultText: args.resultText,
        errorMessage: args.errorMessage,
      });
      return;
    }

    if (args.event.type === "done") {
      void this.tryRefreshBgSummary({
        sessionId: args.sessionId,
        trigger: "done",
        status: args.status,
        currentTool: args.currentTool,
        streamingText: args.streamingText,
        resultText: args.resultText,
        errorMessage: args.errorMessage,
      });
    }
  }

  private pickBgDisplayStatus(args: {
    status: BgSessionInfo["status"];
    heuristicStatus: string;
    summary: {
      shortStatus?: string;
      generatedAt?: number;
      inFlight: boolean;
    };
  }): {
    displayStatus: string;
    displayStatusSource: "terminal" | "model" | "heuristic";
  } {
    if (args.status === "idle") {
      return { displayStatus: "Done", displayStatusSource: "terminal" };
    }
    if (args.status === "error") {
      return { displayStatus: "Error", displayStatusSource: "terminal" };
    }
    if (args.status === "cancelled") {
      return { displayStatus: "Cancelled", displayStatusSource: "terminal" };
    }

    if (args.summary.shortStatus && args.summary.generatedAt) {
      const ageMs = Date.now() - args.summary.generatedAt;
      if (ageMs <= 60_000) {
        const normalizedModelStatus = this.normalizeBgStatusPhrase(
          args.summary.shortStatus,
        );
        const normalized = normalizedModelStatus.toLowerCase();

        // Prevent false terminal labels before the underlying session is terminal.
        const looksTerminal =
          normalized === "done" ||
          normalized === "cancelled" ||
          normalized === "error";

        const prefersHeuristicWhileToolActive =
          normalized === "thinking…" &&
          typeof args.heuristicStatus === "string" &&
          args.heuristicStatus !== "Thinking…";

        if (
          !looksTerminal &&
          normalizedModelStatus &&
          !prefersHeuristicWhileToolActive
        ) {
          return {
            displayStatus: normalizedModelStatus,
            displayStatusSource: "model",
          };
        }
      }
    }

    return {
      displayStatus: args.heuristicStatus,
      displayStatusSource: "heuristic",
    };
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
        displayStatus: "Error",
      };
    }
    const isCancelled = this.bgCancelled.has(sessionId);
    const done = session.status === "idle" || session.status === "error";
    const status = (
      isCancelled && session.status === "idle" ? "cancelled" : session.status
    ) as BgStatusResult["status"];
    const streamingText = this.bgStreamingText.get(sessionId);
    const heuristicStatus = this.inferBgDisplayStatus({
      status: status as BgSessionInfo["status"],
      currentTool: session.currentTool,
      streamingText,
      resultText: done ? session.getLastAssistantText() : undefined,
      errorMessage: this.bgErrors.get(sessionId),
      statusDetail: this.bgStatusDetail.get(sessionId),
    });
    const summary = this.getOrInitBgSummary(sessionId);
    const picked = this.pickBgDisplayStatus({
      status: status as BgSessionInfo["status"],
      heuristicStatus,
      summary,
    });

    const meta = this.bgMeta.get(sessionId);
    const progressSummary = summary.shortStatus?.trim() || picked.displayStatus;

    return {
      status,
      currentTool: session.currentTool,
      done,
      partialOutput: done ? session.getLastAssistantText() : undefined,
      displayStatus: picked.displayStatus,
      streamingPreview: streamingText,
      progressSummary,
      resolvedMode: meta?.resolvedMode,
      resolvedModel: meta?.resolvedModel,
      resolvedProvider: meta?.resolvedProvider,
      taskClass: meta?.taskClass,
      toolCalls: meta?.toolCalls,
      tokenUsage: meta?.tokenUsage,
    };
  }

  /**
   * Async — blocks until the background session finishes.
   * Returns the last assistant message text.
   * Uses a double-check pattern to prevent races between status check and waiter registration.
   */
  waitForBackground(sessionId: string): Promise<string> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return Promise.resolve(
        JSON.stringify({ error: `No background session: ${sessionId}` }),
      );
    }

    // Check stored result first (set in finally block of completion handler)
    const storedResult = this.bgFinalResults.get(sessionId);
    if (storedResult !== undefined) {
      return Promise.resolve(storedResult);
    }

    // Already done (belt + suspenders)
    if (session.status === "idle" || session.status === "error") {
      return Promise.resolve(session.getLastAssistantText() ?? "(no result)");
    }

    return new Promise((resolve) => {
      const waiters = this.bgResultWaiters.get(sessionId) ?? [];
      waiters.push(resolve);
      this.bgResultWaiters.set(sessionId, waiters);

      // Double-check after registration to close the race window
      const storedAfter = this.bgFinalResults.get(sessionId);
      if (storedAfter !== undefined) {
        resolve(storedAfter);
        return;
      }

      // Safety timeout: resolve after 30 minutes as a last resort to prevent
      // permanently hung waiters (e.g. if the session crashes without cleanup).
      const safetyMs = 30 * 60 * 1000;
      const timerId = this.host.timers.setTimeout(() => {
        this.log?.(
          `[background] Result waiter timed out for ${sessionId}; background agent is still allowed to continue running.`,
        );
        resolve(
          session.getLastAssistantText() ??
            "(background agent timed out waiting for result)",
        );
      }, safetyMs);
      const timers = this.bgSafetyTimers.get(sessionId) ?? [];
      timers.push(timerId);
      this.bgSafetyTimers.set(sessionId, timers);
    });
  }

  /**
   * Append streaming text from a background agent (for UI preview).
   * Only keeps the last ~500 characters to avoid unbounded growth.
   */
  appendBgStreamingText(sessionId: string, text: string): void {
    const existing = this.bgStreamingText.get(sessionId) ?? "";
    const updated = existing + text;
    // Keep last 500 chars
    this.bgStreamingText.set(
      sessionId,
      updated.length > 500 ? updated.slice(-500) : updated,
    );
  }

  /** Record a bg session error message. */
  setBgError(sessionId: string, error: string): void {
    this.bgErrors.set(sessionId, error);
  }

  /** Mark a bg session as completed with a timestamp. */
  markBgCompleted(sessionId: string): void {
    this.bgCompletedAt.set(sessionId, Date.now());
  }

  getBackgroundResultSummary(sessionId: string): string | undefined {
    const summary = this.bgSummary.get(sessionId)?.shortStatus?.trim();
    if (summary) return summary;

    const session = this.sessions.get(sessionId);
    if (!session) return undefined;

    const isCancelled = this.bgCancelled.has(sessionId);
    if (isCancelled) return "Cancelled";
    if (session.status === "error") return "Error";

    return summarizeTextForPreview(session.getLastAssistantText(), {
      maxLength: 220,
      minSentenceLength: 20,
    });
  }

  private async resumeParentAfterBackgroundCompletion(
    bgSessionId: string,
    resultText: string,
  ): Promise<void> {
    if (this.bgAutoResumed.has(bgSessionId)) return;
    const parent = this.bgParents.get(bgSessionId);
    if (!parent) return;

    const session = this.sessions.get(parent.sessionId);
    if (!session || session.background) return;
    if (session.status !== "idle") return;
    if (this.foregroundId !== session.id) return;

    this.bgAutoResumed.add(bgSessionId);
    try {
      await this.sendMessage(
        session.id,
        [
          `The background agent for "${parent.task}" has returned while you were stopped.`,
          "Resume now using the included <background_result> content (do not call get_background_result unless you explicitly need to wait on another session).",
          "",
          `<background_result task="${parent.task}" sessionId="${bgSessionId}">`,
          resultText,
          "</background_result>",
        ].join("\n"),
        session.mode,
      );
    } catch (err) {
      this.bgAutoResumed.delete(bgSessionId);
      this.log?.(
        `[bg-resume] failed to resume foreground for ${bgSessionId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Return status info for all background sessions (for the UI strip).
   */
  getBgSessionInfos(): BgSessionInfo[] {
    return Array.from(this.sessions.values())
      .filter((s) => s.background)
      .map((s) => {
        const isCancelled = this.bgCancelled.has(s.id);
        const isDone =
          s.status === "idle" || s.status === "error" || isCancelled;
        let status: BgSessionInfo["status"] =
          s.status as BgSessionInfo["status"];
        if (isCancelled && s.status === "idle") {
          status = "cancelled";
        }
        const meta = this.bgMeta.get(s.id);
        const streamingText = this.bgStreamingText.get(s.id);
        const resultText = isDone ? s.getLastAssistantText() : undefined;
        const errorMessage = this.bgErrors.get(s.id);
        const heuristicStatus = this.inferBgDisplayStatus({
          status,
          currentTool: s.currentTool,
          streamingText,
          resultText,
          errorMessage,
          statusDetail: this.bgStatusDetail.get(s.id),
        });
        const summary = this.getOrInitBgSummary(s.id);
        const picked = this.pickBgDisplayStatus({
          status,
          heuristicStatus,
          summary,
        });

        return {
          id: s.id,
          task: s.title,
          status,
          currentTool: s.currentTool,
          displayStatus: picked.displayStatus,
          displayStatusSource: picked.displayStatusSource,
          resolvedMode: meta?.resolvedMode,
          resolvedModel: meta?.resolvedModel,
          resolvedProvider: meta?.resolvedProvider,
          taskClass: meta?.taskClass,
          routingReason: meta?.routingReason,
          fallbackUsed: meta?.fallbackUsed,
          streamingText,
          resultText,
          errorMessage,
          completedAt: this.bgCompletedAt.get(s.id),
          fullTranscript: isDone ? s.getFullAssistantTranscript() : undefined,
          resultSummary: summary.shortStatus,
          summaryMeta: {
            inFlight: summary.inFlight,
            generatedAt: summary.generatedAt,
            sourceModel: summary.sourceModel,
            fallbackUsed: summary.fallbackUsed,
            confidence: summary.confidence,
            lastAttemptAt: summary.lastAttemptAt,
            lastFailureAt: summary.lastFailureAt,
            lastFailureReason: summary.lastFailureReason,
          },
        };
      });
  }

  /**
   * Return the most recent background routing summaries for debug surfaces.
   */
  getRecentBgRoutingSummaries(limit = 5): string[] {
    const infos = this.getBgSessionInfos()
      .slice()
      .sort((a, b) => {
        const at = a.completedAt ?? Number.MAX_SAFE_INTEGER;
        const bt = b.completedAt ?? Number.MAX_SAFE_INTEGER;
        return bt - at;
      })
      .slice(0, Math.max(1, limit));

    return infos.map((info) => {
      const route = [
        info.resolvedMode ? `mode=${info.resolvedMode}` : null,
        info.resolvedProvider ? `provider=${info.resolvedProvider}` : null,
        info.resolvedModel ? `model=${info.resolvedModel}` : null,
      ]
        .filter((v): v is string => Boolean(v))
        .join(", ");
      const reason = info.routingReason
        ? ` reason="${info.routingReason}"`
        : "";
      const flags = [info.fallbackUsed ? "fallback=true" : null]
        .filter((v): v is string => Boolean(v))
        .join(" ");

      return `${info.id} task="${info.task}"${route ? ` ${route}` : ""}${reason}${flags ? ` ${flags}` : ""}`;
    });
  }
}
