import type {
  AgentConfig,
  AgentEvent,
  AgentMessage,
  AgentRuntimeError,
  SessionStatus,
} from "./types.js";
import type { InFlightAssistantBlock } from "../shared/types.js";
import type {
  RequestContextBreakdown,
  ToolResultContextAttribution,
} from "../shared/types.js";
import type {
  ContentBlock,
  ReasoningEffort,
  TextBlock,
} from "./providers/types.js";
import {
  enforceToolResultAdjacency,
  getEffectiveHistory,
  injectSyntheticToolResults,
} from "./condense.js";

import type { AgentMode } from "./modes.js";
import { BUILT_IN_MODES } from "./modes.js";
import type { FinalMessageMarker } from "../shared/finalStatus.js";
import {
  normalizePromptProfileOverrides,
  resolvePromptProfile,
  type PromptProfile,
  type PromptProfileResolution,
} from "../core/promptProfile.js";
import {
  composeSkillCapabilityPolicy,
  type SkillCapabilityPolicySnapshot,
  type SkillEntry,
} from "./skillLoader.js";
import type { SkillLoadActivation } from "../core/tools/types.js";
import type { ProjectActiveFileResolution } from "./configLoader.js";
import type { McpToolDisclosurePartition } from "./mcpToolDisclosure.js";
import type { SkillCatalogProjection } from "./skillCatalogProjection.js";
import type {
  PersistedActiveSkillState,
  PersistedFleetMetadata,
  PersistedSessionRunState,
} from "./persistenceContracts.js";
import type { PersistedSessionLineage } from "./sessionHandoff.js";
import {
  buildModeInstructionBlock,
  buildPromptArtifacts,
  type AdvertisedRuleEntry,
  type WorkspaceFolderInfo,
} from "./systemPrompt.js";
import { buildSessionTitleFromUserText } from "./sessionTitle.js";
import {
  ESTIMATED_TOKENS_PER_IMAGE,
  estimateDocumentTokens,
  estimateTokensFromChars,
} from "../util/tokenEstimation.js";
import { randomUUID } from "crypto";
import { pathToFileURL } from "url";
import {
  createSessionProjectScope,
  createWorkspaceProjectId,
  isProjectlessSessionScope,
  type SessionProjectScope,
} from "../core/workspaceProjects.js";

export type SessionProjectAvailabilityStatus =
  | "available"
  | "missing"
  | "unavailable"
  | "invalid";

const PROJECTLESS_ASK_SYSTEM_PROMPT = `You are AgentLink in Ask mode without an open workspace folder.

Answer the user's questions directly. No local project, files, shell, editor state, project instructions, skills, commands, MCP servers, checkpoints, or write capabilities are available in this session. Do not claim to inspect or modify local files. If the request requires a local project, explain that the user must open a folder first.`;

/**
 * A mode instruction block pinned to a fixed position in the effective
 * conversation. `userTurnOrdinal` counts string-content user messages before
 * the block; the engine injects `blockText` as a request-local user message at
 * that position so the provider prompt cache prefix stays stable across mode
 * switches. Never part of the persisted transcript messages.
 */
export interface ModeInstructionAnchor {
  userTurnOrdinal: number;
  mode: string;
  blockText: string;
}

function countStringUserMessages(messages: readonly AgentMessage[]): number {
  let count = 0;
  for (const message of messages) {
    if (message.role === "user" && typeof message.content === "string") {
      count++;
    }
  }
  return count;
}

export interface PendingInterjection {
  text: string;
  queueId: string;
  messageId?: string;
  displayText?: string;
  isSlashCommand?: boolean;
  slashCommandLabel?: string;
  attachments?: string[];
  images?: Array<{ name: string; mimeType: string; base64: string }>;
  documents?: Array<{ name: string; mimeType: string; base64: string }>;
}

export class AgentSession {
  id: string;
  readonly background: boolean;
  createdAt: number;
  readonly projectScope: Readonly<SessionProjectScope>;
  readonly projectAvailability: SessionProjectAvailabilityStatus;
  systemPrompt: string;
  contextBreakdown: RequestContextBreakdown;
  mcpToolDisclosure?: McpToolDisclosurePartition;

  mode: string;
  /** Full mode definition (for tool filtering). Falls back to built-in 'code'. */
  agentMode: AgentMode;
  model: string;
  private _modelSelectionRevision = 0;
  private pendingModelSelectionUpdate: Promise<void> = Promise.resolve();
  /** Frozen evidence describing the prompt profile rendered for this session. */
  promptProfile: Readonly<PromptProfileResolution>;
  private promptProfileOverrides: Readonly<Record<string, PromptProfile>>;
  maxTokens: number;
  thinkingBudget: number;
  reasoningEffort: ReasoningEffort;
  autoCondense: boolean;
  autoCondenseThreshold: number;
  codexStatefulResponses: boolean;
  codexStoreResponses: boolean;
  codexProMode: boolean;
  disabledSkillIds: string[];
  /** Frozen metadata budget keeps the session prompt catalog byte-stable. */
  skillCatalogBudgetChars?: number;
  private _status: SessionStatus = "idle";
  private _statusListeners = new Set<() => void>();
  title: string = "New Chat";
  lastActiveAt: number;
  /** Name of the most recently started tool call (updated by AgentEngine). */
  currentTool: string | undefined;
  /** Durable marker for a foreground run that may need recovery after reload. */
  runState: PersistedSessionRunState | undefined;
  fleetMetadata: PersistedFleetMetadata | undefined;
  /** Durable fresh-session relationship metadata; no runtime authority is inherited. */
  lineage: PersistedSessionLineage | undefined;

  /** Cumulative uncached input tokens across the session.
   * This is intentionally uncached-only for cost/usage accounting; use lastInputTokens
   * for most-recent total context-window usage including cache reads/writes. */
  totalInputTokens: number = 0;
  totalOutputTokens: number = 0;
  totalCacheReadTokens: number = 0;
  totalCacheCreationTokens: number = 0;

  /** Full conversation history including condensed messages */
  private messages: AgentMessage[] = [];
  /**
   * Monotonic counter bumped on every transcript mutation. Persistence
   * compares it against the last written value to detect unchanged
   * transcripts without serializing or hashing the full history.
   */
  private messagesRevision = 0;
  /** Files read during this session (for folded file context on condense) */
  readonly filesRead = new Set<string>();
  /** Complete canonical skill catalog for activation authorization, keyed by path. */
  private advertisedSkills = new Map<string, SkillEntry>();
  /** Bounded prompt projection paired with the complete canonical skill catalog. */
  private skillCatalogProjection: SkillCatalogProjection | undefined;
  /** Deferred rules advertised in the current system prompt, keyed by path for allowlist validation. */
  private advertisedRules = new Map<string, AdvertisedRuleEntry>();
  /** Skill names loaded during this session and kept alive across condense. */
  readonly loadedSkills = new Set<string>();
  /** Canonical skill identities restricting the current user turn. */
  private readonly activeSkillIds = new Set<string>();
  /** Total input tokens from the most recent API response: uncached + cache_read + cache_creation.
   *  This represents actual context window usage (used for condense threshold check & context bar). */
  lastInputTokens = 0;
  /** Output tokens from the most recent API response (used with lastInputTokens to estimate next-turn usage) */
  lastOutputTokens = 0;
  /** Cache-read tokens from the most recent API response (used for cache-aware condense threshold) */
  lastCacheReadTokens = 0;

  /** Estimated tokens accumulated since the last API response (tool results, user messages, etc.).
   *  Reset to 0 when addUsage() receives fresh API data. */
  estimatedAccumulatedTokens = 0;

  /** Per-source split of estimatedAccumulatedTokens (e.g. "tool:read_file"),
   *  used to attribute large context-usage jumps in telemetry. Reset alongside it. */
  estimatedAccumulationBySource: Record<string, number> = {};
  /** Bounded per-result detail behind aggregate tool source attribution. */
  toolResultContextAttributions: ToolResultContextAttribution[] = [];
  omittedToolResultContextAttributions = 0;

  /** Active file path at session creation — used for subfolder AGENTS.md and hot-reload. */
  activeFilePath: string | undefined;
  /** Durable resource identity corresponding to activeFilePath. */
  activeContextResourceUri: string | undefined;
  /** Containment decision used by the current prompt artifacts. */
  activeFileContext: ProjectActiveFileResolution | undefined;
  /** Workspace folders to surface in the system prompt (multi-root workspaces). */
  private workspaceFolders: WorkspaceFolderInfo[] | undefined;

  /**
   * Where mode-specific instructions live. "conversation" keeps the system
   * prompt byte-identical across modes (mode content injected via
   * modeInstructionAnchors); "system" is the legacy inline placement, kept for
   * background/lightweight sessions that never switch modes mid-run.
   */
  modeInstructionPlacement: "system" | "conversation" = "system";
  /** Mode instruction blocks pinned to conversation positions (see type doc). */
  modeInstructionAnchors: ModeInstructionAnchor[] = [];
  /** Cached block text for the current mode, used to re-seed anchors after replaceMessages. */
  private currentModeBlockText: string | undefined;

  /** Provider ID (e.g. "anthropic", "codex") — used for provider-specific system prompt tuning. */
  providerId: string | undefined;
  /** Approve for Me is active for this session — switches the system prompt's
   *  mode-switch guidance from user consent to automatic allowance.
   *  Owned by AgentSessionManager, which syncs it from the session's command
   *  approval policy and rebuilds the prompt when it changes. */
  approveForMe = false;
  /** Last OpenAI/Codex Responses API response ID used for optional stateful chaining. */
  providerResponseId: string | undefined;

  get status(): SessionStatus {
    return this._status;
  }

  set status(s: SessionStatus) {
    this._status = s;
    // Notify all waiters on every status change
    for (const listener of this._statusListeners) listener();
    this._statusListeners.clear();
  }

  /**
   * Returns a promise that resolves next time `status` is set.
   * Supports an optional AbortSignal for cleanup — when the signal fires,
   * the listener is removed to prevent accumulation during Promise.race loops.
   */
  waitForStatusChange(signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal?.aborted) {
        resolve();
        return;
      }
      const cb = () => {
        this._statusListeners.delete(cb);
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      const onAbort = () => {
        this._statusListeners.delete(cb);
        resolve();
      };
      this._statusListeners.add(cb);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private abortController: AbortController | null = null;
  private _abortSignal: AbortSignal | undefined;
  private _abortGeneration = 0;
  private _pendingInterjections: PendingInterjection[] = [];
  private readonly _pendingInterjectionQueuedListeners = new Set<() => void>();
  // Transient per-surface counts of messages sitting in UI send queues
  // (VS Code webview / browser remote). Not persisted; used to give queued
  // user messages priority over the todo auto-continue prompt.
  private _queuedUiMessageCounts = new Map<string, number>();
  private _pendingModeResume: {
    mode: string;
    reason?: string;
    followUp?: string;
  } | null = null;

  private constructor(opts: {
    mode: string;
    agentMode: AgentMode;
    config: AgentConfig;
    systemPrompt: string;
    promptBreakdown: RequestContextBreakdown["prompt"];
    promptProfile: Readonly<PromptProfileResolution>;
    background?: boolean;
    projectScope: SessionProjectScope;
    projectAvailability: SessionProjectAvailabilityStatus;
    activeFilePath?: string;
    activeContextResourceUri?: string;
    activeFileContext?: ProjectActiveFileResolution;
    providerId?: string;
    workspaceFolders?: WorkspaceFolderInfo[];
    mcpToolDisclosure?: McpToolDisclosurePartition;
    skillCatalogBudgetChars?: number;
  }) {
    this.id = randomUUID();
    this.mode = opts.mode;
    this.agentMode = opts.agentMode;
    this.projectScope = Object.freeze({ ...opts.projectScope });
    this.projectAvailability = opts.projectAvailability;
    this.model = opts.config.model;
    this.promptProfile = opts.promptProfile;
    this.promptProfileOverrides = normalizePromptProfileOverrides(
      opts.config.promptProfileOverrides,
    );
    this.maxTokens = opts.config.maxTokens;
    this.thinkingBudget = opts.config.thinkingBudget;
    this.reasoningEffort = "high";
    this.autoCondense = opts.config.autoCondense ?? true;
    this.autoCondenseThreshold = opts.config.autoCondenseThreshold ?? 0.9;
    this.codexStatefulResponses = opts.config.codexStatefulResponses ?? true;
    this.codexStoreResponses = opts.config.codexStoreResponses ?? false;
    this.codexProMode = opts.config.codexProMode ?? false;
    this.disabledSkillIds = [...(opts.config.disabledSkillIds ?? [])];
    this.skillCatalogBudgetChars = opts.skillCatalogBudgetChars;
    this.background = opts.background ?? false;
    this.createdAt = Date.now();
    this.lastActiveAt = this.createdAt;
    this.systemPrompt = opts.systemPrompt;
    this.contextBreakdown = { prompt: opts.promptBreakdown };
    this.activeFilePath = opts.activeFilePath;
    this.activeContextResourceUri = opts.activeContextResourceUri;
    this.activeFileContext = opts.activeFileContext;
    this.providerId = opts.providerId;
    this.workspaceFolders = opts.workspaceFolders;
    this.mcpToolDisclosure = opts.mcpToolDisclosure;
  }

  static async create(opts: {
    mode: string;
    agentMode?: AgentMode;
    config: AgentConfig;
    projectScope: SessionProjectScope;
    background?: boolean;
    isBackground?: boolean;
    /** Use lightweight prompt (background review agents). */
    lightweight?: boolean;
    devMode?: boolean;
    activeFilePath?: string;
    activeContextResourceUri?: string;
    providerId?: string;
    workspaceFolders?: WorkspaceFolderInfo[];
    mcpToolDisclosure?: McpToolDisclosurePartition;
  }): Promise<AgentSession> {
    if (isProjectlessSessionScope(opts.projectScope)) {
      if (opts.mode !== "ask" || opts.background || opts.isBackground) {
        throw new Error("Projectless sessions are available only in Ask mode.");
      }
      return AgentSession.createProjectlessAsk({
        config: opts.config,
        projectScope: opts.projectScope,
        agentMode: opts.agentMode,
        providerId: opts.providerId,
      });
    }
    const cwd = opts.projectScope.rootPath;
    if (cwd === undefined) {
      throw new Error(
        `Project '${opts.projectScope.displayName}' is unavailable for local execution.`,
      );
    }
    // Foreground sessions keep the system prompt byte-stable across modes so
    // switches preserve the provider prompt cache; background/lightweight
    // sessions never switch modes mid-run and keep the inline placement.
    const modeInstructionPlacement: "system" | "conversation" =
      opts.background || opts.isBackground || opts.lightweight
        ? "system"
        : "conversation";
    const artifacts = await buildPromptArtifacts(opts.mode, cwd, {
      devMode: opts.devMode,
      activeFilePath: opts.activeFilePath,
      providerId: opts.providerId,
      model: opts.config.model,
      promptProfileOverrides: opts.config.promptProfileOverrides,
      isBackground: opts.isBackground,
      lightweight: opts.lightweight,
      workspaceFolders: opts.workspaceFolders,
      mcpToolCatalog: opts.mcpToolDisclosure?.catalog,
      agentMode: opts.agentMode,
      disabledSkillIds: opts.config.disabledSkillIds,
      modeInstructionPlacement,
    });
    const agentMode =
      opts.agentMode ??
      BUILT_IN_MODES.find((m) => m.slug === opts.mode) ??
      BUILT_IN_MODES[0];
    const session = new AgentSession({
      mode: opts.mode,
      agentMode,
      config: opts.config,
      systemPrompt: artifacts.systemPrompt,
      promptBreakdown: artifacts.promptBreakdown,
      promptProfile: artifacts.promptProfile,
      projectScope: opts.projectScope,
      projectAvailability: "available",
      background: opts.background,
      activeFilePath: opts.activeFilePath,
      activeContextResourceUri: opts.activeContextResourceUri,
      activeFileContext: artifacts.activeFileContext,
      providerId: opts.providerId,
      workspaceFolders: opts.workspaceFolders,
      mcpToolDisclosure: opts.mcpToolDisclosure,
      skillCatalogBudgetChars: artifacts.skillCatalog?.budgetChars,
    });
    session.setAdvertisedSkills(artifacts.skills);
    session.setSkillCatalogProjection(artifacts.skillCatalog);
    session.setAdvertisedRules(artifacts.advertisedRules);
    session.modeInstructionPlacement = modeInstructionPlacement;
    await session.refreshModeInstructionAnchor();
    return session;
  }

  static createProjectlessAsk(opts: {
    config: AgentConfig;
    projectScope: SessionProjectScope;
    agentMode?: AgentMode;
    providerId?: string;
  }): AgentSession {
    if (!isProjectlessSessionScope(opts.projectScope)) {
      throw new Error(
        "Projectless Ask requires the reserved projectless scope.",
      );
    }
    const agentMode =
      opts.agentMode ?? BUILT_IN_MODES.find((mode) => mode.slug === "ask")!;
    if (agentMode.slug !== "ask") {
      throw new Error("Projectless sessions are available only in Ask mode.");
    }
    const promptProfile = resolvePromptProfile({
      providerId: opts.providerId,
      modelId: opts.config.model,
    });
    return new AgentSession({
      mode: "ask",
      agentMode,
      config: { ...opts.config, promptProfileOverrides: undefined },
      systemPrompt: PROJECTLESS_ASK_SYSTEM_PROMPT,
      promptProfile,
      promptBreakdown: {
        sections: [
          {
            label: "projectless-ask",
            chars: PROJECTLESS_ASK_SYSTEM_PROMPT.length,
            estimatedTokens: estimateTokensFromChars(
              PROJECTLESS_ASK_SYSTEM_PROMPT.length,
            ),
          },
        ],
        totalChars: PROJECTLESS_ASK_SYSTEM_PROMPT.length,
        estimatedTokens: estimateTokensFromChars(
          PROJECTLESS_ASK_SYSTEM_PROMPT.length,
        ),
        profile: promptProfile.profile,
        profileSource: promptProfile.source,
        profilePolicyRevision: promptProfile.policyRevision,
      },
      projectScope: opts.projectScope,
      projectAvailability: "unavailable",
      providerId: opts.providerId,
    });
  }

  /** Temporary named seam for tests and callers not yet wired to the project catalog. */
  static createForLegacyCwd(
    opts: Omit<Parameters<typeof AgentSession.create>[0], "projectScope"> & {
      cwd: string;
    },
  ): Promise<AgentSession> {
    const rootPath = opts.cwd;
    const workspaceFolderUri = pathToFileURL(rootPath).toString();
    const projectScope = createSessionProjectScope({
      id: createWorkspaceProjectId(workspaceFolderUri),
      name: rootPath,
      uri: workspaceFolderUri,
      rootPath,
      availability: { status: "available" },
    });
    const { cwd: _cwd, ...createOpts } = opts;
    return AgentSession.create({ ...createOpts, projectScope });
  }

  /** Restores persisted transcript state without loading project files or a prompt. */
  static createTranscriptOnly(opts: {
    mode: string;
    agentMode?: AgentMode;
    config: AgentConfig;
    projectScope: SessionProjectScope;
    projectAvailability: Exclude<SessionProjectAvailabilityStatus, "available">;
    background?: boolean;
    activeContextResourceUri?: string;
    providerId?: string;
    workspaceFolders?: WorkspaceFolderInfo[];
  }): AgentSession {
    const agentMode =
      opts.agentMode ??
      BUILT_IN_MODES.find((mode) => mode.slug === opts.mode) ??
      BUILT_IN_MODES[0];
    const promptProfile = resolvePromptProfile({
      providerId: opts.providerId,
      modelId: opts.config.model,
      overrides: normalizePromptProfileOverrides(
        opts.config.promptProfileOverrides,
      ),
    });
    return new AgentSession({
      mode: opts.mode,
      agentMode,
      config: opts.config,
      systemPrompt: "",
      promptProfile,
      promptBreakdown: {
        sections: [],
        totalChars: 0,
        estimatedTokens: 0,
        profile: promptProfile.profile,
        profileSource: promptProfile.source,
        profilePolicyRevision: promptProfile.policyRevision,
      },
      projectScope: opts.projectScope,
      projectAvailability: opts.projectAvailability,
      background: opts.background,
      activeContextResourceUri: opts.activeContextResourceUri,
      providerId: opts.providerId,
      workspaceFolders: opts.workspaceFolders,
    });
  }

  requireProjectRoot(): string {
    const rootPath = this.projectScope.rootPath;
    if (this.projectAvailability !== "available" || rootPath === undefined) {
      throw new Error(
        `Project '${this.projectScope.displayName}' is unavailable for local execution.`,
      );
    }
    return rootPath;
  }

  get modelSelectionRevision(): number {
    return this._modelSelectionRevision;
  }

  async waitForModelSelectionUpdate(): Promise<void> {
    while (true) {
      const revision = this._modelSelectionRevision;
      await this.pendingModelSelectionUpdate;
      if (revision === this._modelSelectionRevision) return;
    }
  }

  updateModelSelection(
    model: string,
    providerId: string | undefined,
    opts?: {
      devMode?: boolean;
      workspaceFolders?: WorkspaceFolderInfo[];
    },
  ): Promise<void> {
    this._modelSelectionRevision += 1;
    const previousUpdate = this.pendingModelSelectionUpdate;
    const update = previousUpdate.then(async () => {
      const providerChanged = providerId !== this.providerId;
      const modelChanged = model !== this.model;
      const workspaceFolders = opts?.workspaceFolders ?? this.workspaceFolders;
      const artifacts =
        (providerChanged || modelChanged) &&
        this.projectAvailability === "available"
          ? await buildPromptArtifacts(this.mode, this.requireProjectRoot(), {
              devMode: opts?.devMode,
              activeFilePath: this.activeFilePath,
              providerId,
              model,
              isBackground: this.background,
              workspaceFolders,
              mcpToolCatalog: this.mcpToolDisclosure?.catalog,
              agentMode: this.agentMode,
              approveForMe: this.approveForMe,
              modeInstructionPlacement: this.modeInstructionPlacement,
            })
          : undefined;

      this.model = model;
      this.providerId = providerId;
      this.workspaceFolders = workspaceFolders;
      if (artifacts) {
        this.systemPrompt = artifacts.systemPrompt;
        this.contextBreakdown = { prompt: artifacts.promptBreakdown };
        this.activeFileContext = artifacts.activeFileContext;
        this.setAdvertisedSkills(artifacts.skills);
        this.setAdvertisedRules(artifacts.advertisedRules);
      }
      this.resetProviderResponseState();
      this.lastActiveAt = Date.now();
    });
    this.pendingModelSelectionUpdate = update.catch(() => undefined);
    return update;
  }

  /**
   * Rebuild the system prompt in-place (used for hot-reload when instruction files change).
   * Preserves the activeFilePath that was set at session creation.
   */
  async rebuildSystemPrompt(opts?: {
    devMode?: boolean;
    workspaceFolders?: WorkspaceFolderInfo[];
    disabledSkillIds?: readonly string[];
    promptProfileOverrides?: Readonly<Record<string, PromptProfile>>;
  }): Promise<void> {
    const workspaceFolders = opts?.workspaceFolders ?? this.workspaceFolders;
    const disabledSkillIds = opts?.disabledSkillIds
      ? [...opts.disabledSkillIds]
      : this.disabledSkillIds;
    const promptProfileOverrides =
      opts?.promptProfileOverrides !== undefined
        ? normalizePromptProfileOverrides(opts.promptProfileOverrides)
        : this.promptProfileOverrides;
    const artifacts = await buildPromptArtifacts(
      this.mode,
      this.requireProjectRoot(),
      {
        devMode: opts?.devMode,
        activeFilePath: this.activeFilePath,
        providerId: this.providerId,
        model: this.model,
        promptProfileOverrides,
        isBackground: this.background,
        workspaceFolders,
        mcpToolCatalog: this.mcpToolDisclosure?.catalog,
        agentMode: this.agentMode,
        disabledSkillIds,
        skillCatalogBudgetChars: this.skillCatalogBudgetChars,
        approveForMe: this.approveForMe,
        modeInstructionPlacement: this.modeInstructionPlacement,
      },
    );
    const modeInstructionBlock =
      this.modeInstructionPlacement === "conversation"
        ? await buildModeInstructionBlock(
            this.mode,
            this.requireProjectRoot(),
            {
              agentMode: this.agentMode,
              approveForMe: this.approveForMe,
              promptProfile: artifacts.promptProfile.profile,
            },
          )
        : undefined;
    this.workspaceFolders = workspaceFolders;
    this.disabledSkillIds = disabledSkillIds;
    this.promptProfileOverrides = promptProfileOverrides;
    this.systemPrompt = artifacts.systemPrompt;
    this.promptProfile = artifacts.promptProfile;
    this.contextBreakdown = {
      ...this.contextBreakdown,
      prompt: artifacts.promptBreakdown,
    };
    this.activeFileContext = artifacts.activeFileContext;
    this.setAdvertisedSkills(artifacts.skills);
    this.setSkillCatalogProjection(artifacts.skillCatalog);
    this.setAdvertisedRules(artifacts.advertisedRules);
    if (modeInstructionBlock !== undefined) {
      this.applyModeInstructionAnchor(modeInstructionBlock);
    }
    this.resetProviderResponseState();
  }

  /**
   * Switch mode in-place while preserving message history and session identity.
   */
  async setMode(
    mode: string,
    opts?: {
      agentMode?: AgentMode;
      devMode?: boolean;
      promptProfileOverrides?: Readonly<Record<string, PromptProfile>>;
    },
  ): Promise<void> {
    if (opts?.promptProfileOverrides !== undefined) {
      this.promptProfileOverrides = normalizePromptProfileOverrides(
        opts.promptProfileOverrides,
      );
    }
    const artifacts = await buildPromptArtifacts(
      mode,
      this.requireProjectRoot(),
      {
        devMode: opts?.devMode,
        activeFilePath: this.activeFilePath,
        providerId: this.providerId,
        model: this.model,
        promptProfileOverrides: this.promptProfileOverrides,
        isBackground: this.background,
        workspaceFolders: this.workspaceFolders,
        mcpToolCatalog: this.mcpToolDisclosure?.catalog,
        agentMode: opts?.agentMode,
        disabledSkillIds: this.disabledSkillIds,
        skillCatalogBudgetChars: this.skillCatalogBudgetChars,
        approveForMe: this.approveForMe,
        modeInstructionPlacement: this.modeInstructionPlacement,
      },
    );
    const agentMode =
      opts?.agentMode ??
      BUILT_IN_MODES.find((m) => m.slug === mode) ??
      BUILT_IN_MODES[0];

    this.mode = mode;
    this.agentMode = agentMode;
    this.systemPrompt = artifacts.systemPrompt;
    this.promptProfile = artifacts.promptProfile;
    this.contextBreakdown = { prompt: artifacts.promptBreakdown };
    this.activeFileContext = artifacts.activeFileContext;
    this.setAdvertisedSkills(artifacts.skills);
    this.setSkillCatalogProjection(artifacts.skillCatalog);
    this.setAdvertisedRules(artifacts.advertisedRules);
    await this.refreshModeInstructionAnchor();
    this.resetProviderResponseState();
    this.lastActiveAt = Date.now();
  }

  /** Full history (for persistence, rewind, etc.) */
  getAllMessages(): AgentMessage[] {
    return this.messages;
  }

  /** Current transcript mutation counter — see `messagesRevision`. */
  get transcriptRevision(): number {
    return this.messagesRevision;
  }

  /**
   * Effective history to send to the API.
   * Filters out messages tagged with condenseParent whose summary still exists,
   * plus persisted runtime-error and diagnostic notes that are for local context only.
   */
  getMessages(): AgentMessage[] {
    // enforceToolResultAdjacency is the last line of defense: after all
    // history transforms (condense slicing, resume-context insertion,
    // synthetic results), every tool_result must still pair 1:1 with a
    // tool_use in the immediately preceding assistant turn or providers
    // reject the request with a 400.
    return enforceToolResultAdjacency(
      injectSyntheticToolResults(
        getEffectiveHistory(this.messages).filter(
          (message) => !message.runtimeError && !message.diagnosticOnly,
        ),
      ),
    );
  }

  get messageCount(): number {
    return this.messages.length;
  }

  /**
   * Remove the last message if it matches the given role.
   * Returns the removed message, or undefined if the last message didn't match.
   */
  popLastMessage(role: "user" | "assistant"): AgentMessage | undefined {
    const last = this.messages[this.messages.length - 1];
    if (last?.role === role) {
      this.messagesRevision++;
      return this.messages.pop();
    }
    return undefined;
  }

  addUserMessage(
    text: string,
    opts?: {
      displayText?: string;
      isSlashCommand?: boolean;
      slashCommandLabel?: string;
      origin?: "vscode" | "browser";
      handoff?: NonNullable<NonNullable<AgentMessage["uiHint"]>["handoff"]>;
      images?: Array<{ name: string; mimeType: string; base64: string }>;
      documents?: Array<{ name: string; mimeType: string; base64: string }>;
    },
  ): void {
    this.activeSkillIds.clear();
    this.messagesRevision++;
    this.messages.push({
      role: "user",
      content: text,
      ...(opts?.images?.length || opts?.documents?.length
        ? {
            media: {
              images: opts.images ?? [],
              documents: opts.documents ?? [],
            },
          }
        : {}),
      ...(opts &&
      (opts.displayText ||
        opts.isSlashCommand ||
        opts.slashCommandLabel ||
        opts.origin ||
        opts.handoff)
        ? {
            uiHint: {
              ...(opts.displayText ||
              opts.isSlashCommand ||
              opts.slashCommandLabel ||
              opts.origin
                ? {
                    userMessage: {
                      ...(opts.displayText
                        ? { displayText: opts.displayText }
                        : {}),
                      ...(opts.isSlashCommand ? { isSlashCommand: true } : {}),
                      ...(opts.slashCommandLabel
                        ? { slashCommandLabel: opts.slashCommandLabel }
                        : {}),
                      ...(opts.origin ? { origin: opts.origin } : {}),
                    },
                  }
                : {}),
              ...(opts.handoff ? { handoff: opts.handoff } : {}),
            },
          }
        : {}),
    } as AgentMessage);
    // Feed the running context estimate so jump telemetry can attribute user
    // content instead of reporting it as unattributed growth.
    this.addEstimatedTokens(text.length, "user_message");
    if (opts?.images?.length) {
      this.addKnownTokens(
        opts.images.length * ESTIMATED_TOKENS_PER_IMAGE,
        "attachment:image",
      );
    }
    for (const doc of opts?.documents ?? []) {
      this.addKnownTokens(
        estimateDocumentTokens(doc.base64),
        "attachment:document",
      );
    }
    this.lastActiveAt = Date.now();
  }

  appendRuntimeError(error: AgentRuntimeError): void {
    const last = this.messages[this.messages.length - 1];
    if (last?.runtimeError?.message === error.message) {
      last.runtimeError.retryable = error.retryable;
      last.runtimeError.code = error.code;
      last.runtimeError.actions = error.actions;
      this.messagesRevision++;
      this.lastActiveAt = Date.now();
      return;
    }
    this.messagesRevision++;
    this.messages.push({
      role: "assistant",
      content: [{ type: "text", text: error.message }],
      runtimeError: {
        message: error.message,
        retryable: error.retryable,
        code: error.code,
        actions: error.actions,
      },
    } as AgentMessage);
    this.lastActiveAt = Date.now();
  }

  appendUserMessage(message: AgentMessage): void {
    if (message.role !== "user") {
      throw new Error("appendUserMessage requires a user message");
    }
    this.messagesRevision++;
    this.messages.push(message);
    this.lastActiveAt = Date.now();
  }

  appendAssistantTurn(content: ContentBlock[]): void {
    this.appendAssistantMessage({ role: "assistant", content });
  }

  appendAssistantMessage(message: AgentMessage): void {
    if (message.role !== "assistant") {
      throw new Error("appendAssistantMessage requires an assistant message");
    }
    this.messagesRevision++;
    this.messages.push(message);
    this.lastActiveAt = Date.now();
    // The streamed response is now part of the transcript; the live tail
    // snapshot must not shadow it.
    this.inFlightBlocks = [];
  }

  /**
   * Live tail of the model response currently streaming. The transcript only
   * gains the assistant message once the whole response completes, so any
   * hydration built purely from `messages` would silently drop content the
   * user is watching stream. This snapshot closes that gap: it is maintained
   * from the same agent events the surfaces render, cleared the moment the
   * response is committed (appendAssistantMessage) or the run ends.
   */
  private inFlightBlocks: InFlightAssistantBlock[] = [];

  get inFlightAssistantBlocks(): InFlightAssistantBlock[] {
    return this.inFlightBlocks.map((block) => ({ ...block }));
  }

  clearInFlightAssistantBlocks(): void {
    this.inFlightBlocks = [];
  }

  recordInFlightAgentEvent(event: AgentEvent): void {
    switch (event.type) {
      case "thinking_start":
        if (
          !this.inFlightBlocks.some(
            (block) =>
              block.type === "thinking" && block.id === event.thinkingId,
          )
        ) {
          this.inFlightBlocks.push({
            type: "thinking",
            id: event.thinkingId,
            text: "",
            complete: false,
          });
        }
        break;
      case "thinking_delta":
        for (const block of this.inFlightBlocks) {
          if (block.type === "thinking" && block.id === event.thinkingId) {
            block.text += event.text;
          }
        }
        break;
      case "thinking_end":
        for (const block of this.inFlightBlocks) {
          if (block.type === "thinking" && block.id === event.thinkingId) {
            block.complete = true;
          }
        }
        break;
      case "text_delta": {
        const last = this.inFlightBlocks[this.inFlightBlocks.length - 1];
        if (last?.type === "text") {
          last.text += event.text;
        } else {
          this.inFlightBlocks.push({ type: "text", text: event.text });
        }
        break;
      }
      case "tool_start":
        // Child tool calls render inside the parent's compose trace, not as
        // top-level blocks; mirror the projection and skip them here.
        if (event.parentCallId) break;
        if (
          !this.inFlightBlocks.some(
            (block) =>
              block.type === "tool_call" && block.id === event.toolCallId,
          )
        ) {
          this.inFlightBlocks.push({
            type: "tool_call",
            id: event.toolCallId,
            name: event.toolName,
            inputJson:
              event.input === undefined ? "" : JSON.stringify(event.input),
            complete: false,
          });
        }
        break;
      case "tool_input_delta":
        for (const block of this.inFlightBlocks) {
          if (block.type === "tool_call" && block.id === event.toolCallId) {
            block.inputJson += event.partialJson;
          }
        }
        break;
      case "tool_result":
        for (const block of this.inFlightBlocks) {
          if (block.type === "tool_call" && block.id === event.toolCallId) {
            block.complete = true;
          }
        }
        break;
      case "done":
      case "error":
        this.inFlightBlocks = [];
        break;
      default:
        break;
    }
  }

  appendSurfaceChange(
    change: NonNullable<NonNullable<AgentMessage["uiHint"]>["surfaceChange"]>,
  ): void {
    this.appendAssistantMessage({
      role: "assistant",
      content: [],
      diagnosticOnly: true,
      uiHint: { surfaceChange: change },
    });
  }

  applyFinalMarker(marker: FinalMessageMarker): boolean {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const msg = this.messages[i];
      if (msg.role !== "assistant" || msg.diagnosticOnly) continue;
      msg.uiHint = {
        ...msg.uiHint,
        finalMarker: marker,
      };
      this.messagesRevision++;
      this.lastActiveAt = Date.now();
      return true;
    }
    return false;
  }

  setProviderResponseId(responseId: string | undefined): void {
    this.providerResponseId = responseId?.trim() || undefined;
  }

  resetProviderResponseState(): void {
    this.providerResponseId = undefined;
  }

  appendToolResults(
    results: Array<{
      type: "tool_result";
      tool_use_id: string;
      content: string | ContentBlock[];
      mcpApprovalPromotion?: import("../shared/types.js").McpApprovalPromotionMeta;
      composeTrace?: import("../shared/composeTypes.js").ComposeTrace;
    }>,
  ): void {
    this.messagesRevision++;
    this.messages.push({ role: "user", content: results } as AgentMessage);
    this.lastActiveAt = Date.now();
  }

  /** Replace full message history after condensing */
  replaceMessages(messages: AgentMessage[]): void {
    this.messagesRevision++;
    this.messages = messages;
    // History positions are no longer valid; re-seed the current mode block at
    // the top of the rewritten history. The cache is rebuilt after a condense
    // or revert anyway, so position zero costs nothing extra.
    this.modeInstructionAnchors =
      this.modeInstructionPlacement === "conversation" &&
      this.currentModeBlockText
        ? [
            {
              userTurnOrdinal: 0,
              mode: this.mode,
              blockText: this.currentModeBlockText,
            },
          ]
        : [];
    this.resetProviderResponseState();
    this.lastActiveAt = Date.now();
  }

  /**
   * Rebuild the current mode's instruction block and pin it at the present
   * end-of-history position. Replaces the previous anchor when nothing was
   * appended since (e.g. consecutive switches), so stale blocks don't stack.
   */
  async refreshModeInstructionAnchor(): Promise<void> {
    if (this.modeInstructionPlacement !== "conversation") return;
    const blockText = await buildModeInstructionBlock(
      this.mode,
      this.requireProjectRoot(),
      {
        agentMode: this.agentMode,
        approveForMe: this.approveForMe,
        promptProfile: this.promptProfile.profile,
      },
    );
    this.applyModeInstructionAnchor(blockText);
  }

  private applyModeInstructionAnchor(blockText: string): void {
    this.currentModeBlockText = blockText;
    const ordinal = countStringUserMessages(this.getMessages());
    const last =
      this.modeInstructionAnchors[this.modeInstructionAnchors.length - 1];
    if (last && last.userTurnOrdinal >= ordinal) {
      last.userTurnOrdinal = ordinal;
      last.mode = this.mode;
      last.blockText = blockText;
    } else {
      this.modeInstructionAnchors.push({
        userTurnOrdinal: ordinal,
        mode: this.mode,
        blockText,
      });
      this.addEstimatedTokens(blockText.length, "mode_instructions");
    }
    this.messagesRevision++;
  }

  /**
   * Resolve anchors against the effective history the engine is about to
   * send. Returns request-local user-message insertions, ordered ascending by
   * index. Insertion points are always genuine turn boundaries (immediately
   * before a string-content user message, or the end of history), so
   * tool_use/tool_result adjacency can never be broken.
   */
  buildModeInstructionInsertions(
    effectiveMessages: readonly AgentMessage[],
  ): Array<{ beforeIndex: number; blockText: string }> {
    if (
      this.modeInstructionPlacement !== "conversation" ||
      this.modeInstructionAnchors.length === 0
    ) {
      return [];
    }
    // Map user-turn ordinal -> effective index of that string user message.
    const ordinalIndex: number[] = [];
    effectiveMessages.forEach((msg, index) => {
      if (msg.role === "user" && typeof msg.content === "string") {
        ordinalIndex.push(index);
      }
    });
    const insertions = new Map<number, string>();
    for (const anchor of this.modeInstructionAnchors) {
      const beforeIndex =
        anchor.userTurnOrdinal < ordinalIndex.length
          ? ordinalIndex[anchor.userTurnOrdinal]!
          : effectiveMessages.length;
      // Later anchors at the same position win (most recent mode).
      insertions.set(beforeIndex, anchor.blockText);
    }
    return [...insertions.entries()]
      .sort(([a], [b]) => a - b)
      .map(([beforeIndex, blockText]) => ({ beforeIndex, blockText }));
  }

  /**
   * Restore session state from persisted store data.
   * Only called by AgentSessionManager.loadPersistedSession().
   */
  restoreFromStore(data: {
    id: string;
    title: string;
    createdAt: number;
    lastActiveAt: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCacheReadTokens?: number;
    totalCacheCreationTokens?: number;
    lastInputTokens?: number;
    lastCacheReadTokens?: number;
    reasoningEffort?: ReasoningEffort;
    loadedSkills?: string[];
    activeSkillState?: PersistedActiveSkillState;
    runState?: PersistedSessionRunState;
    fleetMetadata?: PersistedFleetMetadata;
    lineage?: PersistedSessionLineage;
    messages: AgentMessage[];
    modeInstructionAnchors?: ModeInstructionAnchor[];
  }): void {
    this.id = data.id;
    this.title = data.title;
    this.createdAt = data.createdAt;
    this.lastActiveAt = data.lastActiveAt;
    this.totalInputTokens = data.totalInputTokens;
    this.totalOutputTokens = data.totalOutputTokens;
    this.totalCacheReadTokens = data.totalCacheReadTokens ?? 0;
    this.totalCacheCreationTokens = data.totalCacheCreationTokens ?? 0;
    this.lastInputTokens = data.lastInputTokens ?? 0;
    this.lastCacheReadTokens = data.lastCacheReadTokens ?? 0;
    this.reasoningEffort = data.reasoningEffort ?? this.reasoningEffort;
    // Leave status at its constructed idle value. A restored runState marks the
    // session resumable without pretending the old in-memory run still exists.
    this.runState = data.runState;
    this.fleetMetadata = data.fleetMetadata;
    this.lineage = data.lineage;
    this.messagesRevision++;
    this.messages = data.messages;
    if (data.modeInstructionAnchors?.length) {
      this.modeInstructionAnchors = data.modeInstructionAnchors;
      this.currentModeBlockText =
        data.modeInstructionAnchors[
          data.modeInstructionAnchors.length - 1
        ]!.blockText;
    }
    this.resetProviderResponseState();
    this.loadedSkills.clear();
    for (const skill of data.loadedSkills ?? []) {
      if (skill.trim()) this.loadedSkills.add(skill.trim());
    }
    this.restoreActiveSkillState(data.activeSkillState);
  }

  /** Record that a file was read during this session */
  trackFileRead(filePath: string): void {
    this.filesRead.add(filePath);
  }

  setAdvertisedSkills(skills: SkillEntry[]): void {
    const previouslyAdvertisedById = new Map(
      Array.from(this.advertisedSkills.values()).map((skill) => [
        skill.id,
        skill,
      ]),
    );
    this.advertisedSkills = new Map(
      skills.map((skill) => [skill.skillPath, skill]),
    );
    const nextById = new Map(skills.map((skill) => [skill.id, skill]));
    for (const skillId of this.activeSkillIds) {
      const previous = previouslyAdvertisedById.get(skillId);
      const next = nextById.get(skillId);
      if (
        !previous ||
        !next?.enabled ||
        next.name !== previous.name ||
        next.revision !== previous.revision
      ) {
        this.activeSkillIds.delete(skillId);
      }
    }
  }

  getAdvertisedSkills(): SkillEntry[] {
    return Array.from(this.advertisedSkills.values());
  }

  setSkillCatalogProjection(
    projection: SkillCatalogProjection | undefined,
  ): void {
    this.skillCatalogProjection = projection;
  }

  getSkillCatalogProjection(): SkillCatalogProjection | undefined {
    return this.skillCatalogProjection;
  }

  getActiveSkillPolicy(): SkillCapabilityPolicySnapshot {
    const activeSkills = Array.from(this.advertisedSkills.values()).filter(
      (skill) => this.activeSkillIds.has(skill.id) && skill.enabled,
    );
    return composeSkillCapabilityPolicy(activeSkills);
  }

  getActiveSkillAllowedTools(): string[] | undefined {
    return this.getActiveSkillPolicy().allowedTools;
  }

  getActiveSkillState(): PersistedActiveSkillState | undefined {
    if (this.activeSkillIds.size === 0) return undefined;
    const projection = this.skillCatalogProjection;
    if (!projection) return undefined;
    const byId = new Map(
      Array.from(this.advertisedSkills.values()).map((skill) => [
        skill.id,
        skill,
      ]),
    );
    const activeSkills = [...this.activeSkillIds]
      .map((id) => byId.get(id))
      .filter((skill): skill is SkillEntry => Boolean(skill?.enabled))
      .sort((left, right) => left.id.localeCompare(right.id));
    if (activeSkills.length !== this.activeSkillIds.size) return undefined;
    return {
      schemaVersion: 1,
      catalogRevision: projection.revision,
      activations: activeSkills.map((skill) => ({
        id: skill.id,
        name: skill.name,
        revision: skill.revision,
      })),
      policy: composeSkillCapabilityPolicy(activeSkills),
    };
  }

  private restoreActiveSkillState(
    state: PersistedActiveSkillState | undefined,
  ): void {
    this.activeSkillIds.clear();
    if (state?.schemaVersion !== 1 || state.activations.length === 0) return;
    if (
      new Set(state.activations.map((activation) => activation.id)).size !==
      state.activations.length
    ) {
      return;
    }
    const byId = new Map(
      Array.from(this.advertisedSkills.values()).map((skill) => [
        skill.id,
        skill,
      ]),
    );
    const activeSkills = state.activations.flatMap((activation) => {
      const skill = byId.get(activation.id);
      return skill?.enabled &&
        skill.name === activation.name &&
        skill.revision === activation.revision
        ? [skill]
        : [];
    });
    if (activeSkills.length !== state.activations.length) return;
    const policy = composeSkillCapabilityPolicy(activeSkills);
    if (policy.revision !== state.policy.revision) return;
    for (const skill of activeSkills) {
      this.activeSkillIds.add(skill.id);
      this.loadedSkills.add(skill.name);
    }
  }

  setAdvertisedRules(rules: AdvertisedRuleEntry[] = []): void {
    this.advertisedRules = new Map(rules.map((rule) => [rule.filePath, rule]));
  }

  getAdvertisedRules(): AdvertisedRuleEntry[] {
    return Array.from(this.advertisedRules.values());
  }

  getLoadedSkills(): string[] {
    return [...this.loadedSkills];
  }

  trackLoadedSkill(activation: SkillLoadActivation): boolean {
    const advertised = this.advertisedSkills.get(activation.skillPath);
    if (
      !advertised ||
      !advertised.enabled ||
      advertised.id !== activation.id ||
      advertised.name !== activation.name ||
      advertised.revision !== activation.revision
    ) {
      return false;
    }
    this.loadedSkills.add(advertised.name);
    this.activeSkillIds.add(advertised.id);
    return true;
  }

  addUsage(
    inputTokens: number,
    outputTokens: number,
    cacheReadTokens = 0,
    cacheCreationTokens = 0,
  ): void {
    this.totalInputTokens += inputTokens;
    this.totalOutputTokens += outputTokens;
    this.totalCacheReadTokens += cacheReadTokens;
    this.totalCacheCreationTokens += cacheCreationTokens;
    // The API's input_tokens field only counts tokens AFTER the last cache breakpoint.
    // For context window usage we need the total: uncached + cache reads + cache writes.
    this.lastInputTokens = inputTokens + cacheReadTokens + cacheCreationTokens;
    this.lastOutputTokens = outputTokens;
    this.lastCacheReadTokens = cacheReadTokens;
    // Fresh API data replaces any local estimates.
    this.estimatedAccumulatedTokens = 0;
    this.estimatedAccumulationBySource = {};
    this.toolResultContextAttributions = [];
    this.omittedToolResultContextAttributions = 0;
  }

  /**
   * Add an estimated token count for content added since the last API response
   * (e.g. tool results, user messages). Uses the same 4-bytes-per-token
   * heuristic as Codex CLI. `source` labels the contribution for jump telemetry.
   */
  addEstimatedTokens(chars: number, source = "other"): void {
    this.addKnownTokens(estimateTokensFromChars(chars), source);
  }

  /** Add an already-token-denominated contribution to the running accumulator. */
  addKnownTokens(tokens: number, source = "other"): void {
    if (tokens <= 0) return;
    this.estimatedAccumulatedTokens += tokens;
    this.estimatedAccumulationBySource[source] =
      (this.estimatedAccumulationBySource[source] ?? 0) + tokens;
  }

  addToolResultContextAttribution(
    toolCallId: string,
    toolName: string,
    retainedContent: string,
    estimatedTokens = estimateTokensFromChars([...retainedContent].length),
  ): void {
    const chars = [...retainedContent].length;
    const bytes = Buffer.byteLength(retainedContent, "utf8");
    this.addKnownTokens(estimatedTokens, `tool:${toolName}`);
    if (this.toolResultContextAttributions.length >= 64) {
      this.omittedToolResultContextAttributions += 1;
      return;
    }
    this.toolResultContextAttributions.push({
      toolCallId,
      toolName,
      chars,
      bytes,
      estimatedTokens,
    });
  }

  /**
   * Running estimate of next request input usage:
   * last API input + estimated new content since then.
   */
  get estimatedInputUsed(): number {
    return this.lastInputTokens + this.estimatedAccumulatedTokens;
  }

  /**
   * Running estimate of total context window usage:
   * last API total + estimated new content since then.
   */
  get estimatedTotalUsed(): number {
    return this.estimatedInputUsed + this.lastOutputTokens;
  }

  /** Return the text content of the last assistant message, if any. */
  getLastAssistantText(): string | undefined {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const msg = this.messages[i];
      if (msg.role === "assistant") {
        if (Array.isArray(msg.content)) {
          return (
            msg.content
              .filter((b): b is TextBlock => b.type === "text")
              .map((b) => b.text)
              .join("")
              .trim() || undefined
          );
        }
        if (typeof msg.content === "string")
          return msg.content.trim() || undefined;
      }
    }
    return undefined;
  }

  /** Return the most recent final marker, including structured background results. */
  getLastFinalMarker(): FinalMessageMarker | undefined {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const marker = this.messages[i].uiHint?.finalMarker;
      if (marker) return marker;
    }
    return undefined;
  }

  /**
   * Concatenate all assistant text blocks across the full conversation.
   * Used for the "full transcript" view on background agent result blocks.
   */
  getFullAssistantTranscript(): string | undefined {
    const parts: string[] = [];
    for (const msg of this.messages) {
      if (msg.role !== "assistant") continue;
      if (Array.isArray(msg.content)) {
        for (const b of msg.content) {
          if (b.type === "text") parts.push(b.text);
        }
      } else if (typeof msg.content === "string") {
        parts.push(msg.content);
      }
    }
    const text = parts.join("\n\n").trim();
    return text || undefined;
  }

  /** Auto-title from first user message */
  autoTitle(): void {
    const first = this.messages[0];
    if (first?.role === "user" && typeof first.content === "string") {
      const title = buildSessionTitleFromUserText(first.content);
      if (title) {
        this.title = title;
      }
    }
  }

  /**
   * Queue an interjection for injection between tool batches. Multiple
   * interjections may be pending at once; they are consumed FIFO at the next
   * break. Registering a queueId that is already pending replaces that entry
   * in place. Always returns true (the interjection is accepted).
   */
  setPendingInterjection(
    text: string,
    queueId: string,
    messageId?: string,
    displayText?: string,
    isSlashCommand?: boolean,
    slashCommandLabel?: string,
    attachments?: string[],
    images?: Array<{ name: string; mimeType: string; base64: string }>,
    documents?: Array<{ name: string; mimeType: string; base64: string }>,
  ): boolean {
    const entry: PendingInterjection = {
      text,
      queueId,
      messageId,
      displayText,
      isSlashCommand,
      slashCommandLabel,
      attachments,
      images,
      documents,
    };
    const index = this._pendingInterjections.findIndex(
      (item) => item.queueId === queueId,
    );
    if (index >= 0) this._pendingInterjections[index] = entry;
    else this._pendingInterjections.push(entry);
    for (const listener of this._pendingInterjectionQueuedListeners) {
      listener();
    }
    return true;
  }

  /**
   * Subscribe to interjection queueing so blocking waits (e.g. a parent stuck
   * in get_background_result) can return early and let the engine drain the
   * pending message at the next tool boundary. Returns an unsubscribe function.
   */
  onPendingInterjectionQueued(listener: () => void): () => void {
    this._pendingInterjectionQueuedListeners.add(listener);
    return () => this._pendingInterjectionQueuedListeners.delete(listener);
  }

  /** Wait briefly for a queued user message without consuming it. */
  waitForPendingInterjection(timeoutMs: number): Promise<boolean> {
    if (this.hasPendingInterjections) return Promise.resolve(true);

    return new Promise((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let unsubscribe = () => {};
      const settle = (pending: boolean) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        unsubscribe();
        resolve(pending);
      };
      unsubscribe = this.onPendingInterjectionQueued(() => settle(true));
      timer = setTimeout(() => settle(false), timeoutMs);

      // Close the race between the initial check and listener registration.
      if (this.hasPendingInterjections) settle(true);
    });
  }

  updatePendingInterjection(
    queueId: string,
    updates: {
      text: string;
      messageId?: string;
      displayText?: string;
      isSlashCommand?: boolean;
      slashCommandLabel?: string;
      attachments?: string[];
      images?: Array<{ name: string; mimeType: string; base64: string }>;
      documents?: Array<{ name: string; mimeType: string; base64: string }>;
    },
  ): boolean {
    const index = this._pendingInterjections.findIndex(
      (item) => item.queueId === queueId,
    );
    if (index < 0) return false;
    this._pendingInterjections[index] = { queueId, ...updates };
    return true;
  }

  /**
   * Consume the oldest pending interjection (FIFO), or null when none remain.
   * Callers drain by looping until null.
   */
  consumePendingInterjection(): PendingInterjection | null {
    return this._pendingInterjections.shift() ?? null;
  }

  get hasPendingInterjections(): boolean {
    return this._pendingInterjections.length > 0;
  }

  /**
   * Record how many messages a UI surface currently holds in its send queue.
   * Queued messages take priority over the todo auto-continue prompt: when any
   * surface reports a non-zero count at turn end, the manager emits `done`
   * instead of auto-continuing so the queue can flush.
   */
  setQueuedUiMessageCount(surface: "vscode" | "browser", count: number): void {
    if (count <= 0) this._queuedUiMessageCounts.delete(surface);
    else this._queuedUiMessageCounts.set(surface, count);
  }

  get hasQueuedUiMessages(): boolean {
    return this._queuedUiMessageCounts.size > 0;
  }

  /**
   * Remove a pending interjection by queueId if it hasn't been consumed yet.
   * Returns the removed interjection, or null if it was already consumed.
   */
  clearPendingInterjectionIf(queueId: string): PendingInterjection | null {
    const index = this._pendingInterjections.findIndex(
      (item) => item.queueId === queueId,
    );
    if (index < 0) return null;
    return this._pendingInterjections.splice(index, 1)[0];
  }

  queuePendingModeResume(
    mode: string,
    opts?: { reason?: string; followUp?: string },
  ): void {
    this._pendingModeResume = {
      mode,
      reason: opts?.reason,
      followUp: opts?.followUp,
    };
  }

  consumePendingModeResume(): {
    mode: string;
    reason?: string;
    followUp?: string;
  } | null {
    const pending = this._pendingModeResume;
    this._pendingModeResume = null;
    return pending;
  }

  createAbortController(): AbortController {
    this.abortController = new AbortController();
    this._abortSignal = this.abortController.signal;
    return this.abortController;
  }

  abort(): void {
    this._abortGeneration++;
    this.abortController?.abort();
    this.abortController = null;
    this.inFlightBlocks = [];
    this._pendingModeResume = null;
  }

  get abortGeneration(): number {
    return this._abortGeneration;
  }

  get isAborted(): boolean {
    return this._abortSignal?.aborted ?? false;
  }

  get abortSignal(): AbortSignal | undefined {
    return this._abortSignal;
  }
}
