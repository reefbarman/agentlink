import type {
  AgentConfig,
  AgentMessage,
  AgentRuntimeError,
  SessionStatus,
} from "./types.js";
import type { RequestContextBreakdown } from "../shared/types.js";
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
import type { SkillEntry } from "./skillLoader.js";
import type { ProjectActiveFileResolution } from "./configLoader.js";
import type { McpToolDisclosurePartition } from "./mcpToolDisclosure.js";
import type {
  PersistedFleetMetadata,
  PersistedSessionRunState,
} from "./persistenceContracts.js";
import {
  buildPromptArtifacts,
  type AdvertisedRuleEntry,
  type WorkspaceFolderInfo,
} from "./systemPrompt.js";
import { buildSessionTitleFromUserText } from "./sessionTitle.js";
import { estimateTokensFromChars } from "../util/tokenEstimation.js";
import { randomUUID } from "crypto";
import { pathToFileURL } from "url";
import {
  createSessionProjectScope,
  createWorkspaceProjectId,
  type SessionProjectScope,
} from "../core/workspaceProjects.js";

export type SessionProjectAvailabilityStatus =
  | "available"
  | "missing"
  | "unavailable"
  | "invalid";

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
  maxTokens: number;
  thinkingBudget: number;
  reasoningEffort: ReasoningEffort;
  autoCondense: boolean;
  autoCondenseThreshold: number;
  codexStatefulResponses: boolean;
  codexStoreResponses: boolean;
  codexProMode: boolean;
  private _status: SessionStatus = "idle";
  private _statusListeners = new Set<() => void>();
  title: string = "New Chat";
  lastActiveAt: number;
  /** Name of the most recently started tool call (updated by AgentEngine). */
  currentTool: string | undefined;
  /** Durable marker for a foreground run that may need recovery after reload. */
  runState: PersistedSessionRunState | undefined;
  fleetMetadata: PersistedFleetMetadata | undefined;

  /** Cumulative uncached input tokens across the session.
   * This is intentionally uncached-only for cost/usage accounting; use lastInputTokens
   * for most-recent total context-window usage including cache reads/writes. */
  totalInputTokens: number = 0;
  totalOutputTokens: number = 0;
  totalCacheReadTokens: number = 0;
  totalCacheCreationTokens: number = 0;

  /** Full conversation history including condensed messages */
  private messages: AgentMessage[] = [];
  /** Files read during this session (for folded file context on condense) */
  readonly filesRead = new Set<string>();
  /** Skills advertised in the current system prompt, keyed by path for allowlist validation. */
  private advertisedSkills = new Map<string, SkillEntry>();
  /** Deferred rules advertised in the current system prompt, keyed by path for allowlist validation. */
  private advertisedRules = new Map<string, AdvertisedRuleEntry>();
  /** Skill names explicitly loaded during this session and kept alive across condense. */
  readonly loadedSkills = new Set<string>();
  /** Most recently loaded advertised skill, used for allowed-tools restriction. */
  private activeSkillName: string | undefined;
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

  /** Active file path at session creation — used for subfolder AGENTS.md and hot-reload. */
  activeFilePath: string | undefined;
  /** Durable resource identity corresponding to activeFilePath. */
  activeContextResourceUri: string | undefined;
  /** Containment decision used by the current prompt artifacts. */
  activeFileContext: ProjectActiveFileResolution | undefined;
  /** Workspace folders to surface in the system prompt (multi-root workspaces). */
  private workspaceFolders: WorkspaceFolderInfo[] | undefined;

  /** Provider ID (e.g. "anthropic", "codex") — used for provider-specific system prompt tuning. */
  providerId: string | undefined;
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
    background?: boolean;
    projectScope: SessionProjectScope;
    projectAvailability: SessionProjectAvailabilityStatus;
    activeFilePath?: string;
    activeContextResourceUri?: string;
    activeFileContext?: ProjectActiveFileResolution;
    providerId?: string;
    workspaceFolders?: WorkspaceFolderInfo[];
    mcpToolDisclosure?: McpToolDisclosurePartition;
  }) {
    this.id = randomUUID();
    this.mode = opts.mode;
    this.agentMode = opts.agentMode;
    this.projectScope = Object.freeze({ ...opts.projectScope });
    this.projectAvailability = opts.projectAvailability;
    this.model = opts.config.model;
    this.maxTokens = opts.config.maxTokens;
    this.thinkingBudget = opts.config.thinkingBudget;
    this.reasoningEffort = "high";
    this.autoCondense = opts.config.autoCondense ?? true;
    this.autoCondenseThreshold = opts.config.autoCondenseThreshold ?? 0.9;
    this.codexStatefulResponses = opts.config.codexStatefulResponses ?? true;
    this.codexStoreResponses = opts.config.codexStoreResponses ?? false;
    this.codexProMode = opts.config.codexProMode ?? false;
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
    const cwd = opts.projectScope.rootPath;
    if (cwd === undefined) {
      throw new Error(
        `Project '${opts.projectScope.displayName}' is unavailable for local execution.`,
      );
    }
    const artifacts = await buildPromptArtifacts(opts.mode, cwd, {
      devMode: opts.devMode,
      activeFilePath: opts.activeFilePath,
      providerId: opts.providerId,
      model: opts.config.model,
      isBackground: opts.isBackground,
      lightweight: opts.lightweight,
      workspaceFolders: opts.workspaceFolders,
      mcpToolCatalog: opts.mcpToolDisclosure?.catalog,
      agentMode: opts.agentMode,
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
      projectScope: opts.projectScope,
      projectAvailability: "available",
      background: opts.background,
      activeFilePath: opts.activeFilePath,
      activeContextResourceUri: opts.activeContextResourceUri,
      activeFileContext: artifacts.activeFileContext,
      providerId: opts.providerId,
      workspaceFolders: opts.workspaceFolders,
      mcpToolDisclosure: opts.mcpToolDisclosure,
    });
    session.setAdvertisedSkills(artifacts.skills);
    session.setAdvertisedRules(artifacts.advertisedRules);
    return session;
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
    return new AgentSession({
      mode: opts.mode,
      agentMode,
      config: opts.config,
      systemPrompt: "",
      promptBreakdown: { sections: [], totalChars: 0, estimatedTokens: 0 },
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

  /**
   * Rebuild the system prompt in-place (used for hot-reload when instruction files change).
   * Preserves the activeFilePath that was set at session creation.
   */
  async rebuildSystemPrompt(opts?: {
    devMode?: boolean;
    workspaceFolders?: WorkspaceFolderInfo[];
  }): Promise<void> {
    if (opts?.workspaceFolders) this.workspaceFolders = opts.workspaceFolders;
    const artifacts = await buildPromptArtifacts(
      this.mode,
      this.requireProjectRoot(),
      {
        devMode: opts?.devMode,
        activeFilePath: this.activeFilePath,
        providerId: this.providerId,
        model: this.model,
        isBackground: this.background,
        workspaceFolders: this.workspaceFolders,
        mcpToolCatalog: this.mcpToolDisclosure?.catalog,
        agentMode: this.agentMode,
      },
    );
    this.systemPrompt = artifacts.systemPrompt;
    this.contextBreakdown = { prompt: artifacts.promptBreakdown };
    this.activeFileContext = artifacts.activeFileContext;
    this.setAdvertisedSkills(artifacts.skills);
    this.setAdvertisedRules(artifacts.advertisedRules);
    this.resetProviderResponseState();
  }

  /**
   * Switch mode in-place while preserving message history and session identity.
   */
  async setMode(
    mode: string,
    opts?: { agentMode?: AgentMode; devMode?: boolean },
  ): Promise<void> {
    const artifacts = await buildPromptArtifacts(
      mode,
      this.requireProjectRoot(),
      {
        devMode: opts?.devMode,
        activeFilePath: this.activeFilePath,
        providerId: this.providerId,
        model: this.model,
        isBackground: this.background,
        workspaceFolders: this.workspaceFolders,
        mcpToolCatalog: this.mcpToolDisclosure?.catalog,
        agentMode: opts?.agentMode,
      },
    );
    const agentMode =
      opts?.agentMode ??
      BUILT_IN_MODES.find((m) => m.slug === mode) ??
      BUILT_IN_MODES[0];

    this.mode = mode;
    this.agentMode = agentMode;
    this.systemPrompt = artifacts.systemPrompt;
    this.contextBreakdown = { prompt: artifacts.promptBreakdown };
    this.activeFileContext = artifacts.activeFileContext;
    this.setAdvertisedSkills(artifacts.skills);
    this.setAdvertisedRules(artifacts.advertisedRules);
    this.resetProviderResponseState();
    this.lastActiveAt = Date.now();
  }

  /** Full history (for persistence, rewind, etc.) */
  getAllMessages(): AgentMessage[] {
    return this.messages;
  }

  /**
   * Effective history to send to the API.
   * Filters out messages tagged with condenseParent whose summary still exists,
   * plus persisted runtime-error notes that are for local context only.
   */
  getMessages(): AgentMessage[] {
    // enforceToolResultAdjacency is the last line of defense: after all
    // history transforms (condense slicing, resume-context insertion,
    // synthetic results), every tool_result must still pair 1:1 with a
    // tool_use in the immediately preceding assistant turn or providers
    // reject the request with a 400.
    return enforceToolResultAdjacency(
      injectSyntheticToolResults(
        getEffectiveHistory(this.messages).filter((m) => !m.runtimeError),
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
      images?: Array<{ name: string; mimeType: string; base64: string }>;
      documents?: Array<{ name: string; mimeType: string; base64: string }>;
    },
  ): void {
    this.activeSkillName = undefined;
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
        opts.origin)
        ? {
            uiHint: {
              userMessage: {
                ...(opts.displayText ? { displayText: opts.displayText } : {}),
                ...(opts.isSlashCommand ? { isSlashCommand: true } : {}),
                ...(opts.slashCommandLabel
                  ? { slashCommandLabel: opts.slashCommandLabel }
                  : {}),
                ...(opts.origin ? { origin: opts.origin } : {}),
              },
            },
          }
        : {}),
    } as AgentMessage);
    this.lastActiveAt = Date.now();
  }

  appendRuntimeError(error: AgentRuntimeError): void {
    const last = this.messages[this.messages.length - 1];
    if (last?.runtimeError?.message === error.message) {
      last.runtimeError.retryable = error.retryable;
      last.runtimeError.code = error.code;
      last.runtimeError.actions = error.actions;
      this.lastActiveAt = Date.now();
      return;
    }
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

  appendAssistantTurn(content: ContentBlock[]): void {
    this.appendAssistantMessage({ role: "assistant", content });
  }

  appendAssistantMessage(message: AgentMessage): void {
    if (message.role !== "assistant") {
      throw new Error("appendAssistantMessage requires an assistant message");
    }
    this.messages.push(message);
    this.lastActiveAt = Date.now();
  }

  applyFinalMarker(marker: FinalMessageMarker): boolean {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const msg = this.messages[i];
      if (msg.role !== "assistant") continue;
      msg.uiHint = {
        ...msg.uiHint,
        finalMarker: marker,
      };
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
    this.messages.push({ role: "user", content: results } as AgentMessage);
    this.lastActiveAt = Date.now();
  }

  /** Replace full message history after condensing */
  replaceMessages(messages: AgentMessage[]): void {
    this.messages = messages;
    this.resetProviderResponseState();
    this.lastActiveAt = Date.now();
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
    runState?: PersistedSessionRunState;
    fleetMetadata?: PersistedFleetMetadata;
    messages: AgentMessage[];
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
    this.messages = data.messages;
    this.resetProviderResponseState();
    this.loadedSkills.clear();
    for (const skill of data.loadedSkills ?? []) {
      if (skill.trim()) this.loadedSkills.add(skill.trim());
    }
  }

  /** Record that a file was read during this session */
  trackFileRead(filePath: string): void {
    this.filesRead.add(filePath);
  }

  setAdvertisedSkills(skills: SkillEntry[]): void {
    this.advertisedSkills = new Map(
      skills.map((skill) => [skill.skillPath, skill]),
    );
  }

  getAdvertisedSkills(): SkillEntry[] {
    return Array.from(this.advertisedSkills.values());
  }

  getActiveSkillAllowedTools(): string[] | undefined {
    if (!this.activeSkillName) return undefined;
    return Array.from(this.advertisedSkills.values()).find(
      (skill) => skill.name === this.activeSkillName,
    )?.allowedTools;
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

  trackLoadedSkill(skillName: string): void {
    const trimmed = skillName.trim();
    if (!trimmed) return;
    this.loadedSkills.add(trimmed);
    this.activeSkillName = trimmed;
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
  }

  /**
   * Add an estimated token count for content added since the last API response
   * (e.g. tool results, user messages). Uses the same 4-bytes-per-token
   * heuristic as Codex CLI.
   */
  addEstimatedTokens(chars: number): void {
    this.estimatedAccumulatedTokens += estimateTokensFromChars(chars);
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
    return true;
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
