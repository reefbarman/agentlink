import { randomUUID } from "crypto";
import type Anthropic from "@anthropic-ai/sdk";
import type { SessionStatus, AgentConfig, AgentMessage } from "./types.js";
import { buildSystemPrompt } from "./systemPrompt.js";
import type { AgentMode } from "./modes.js";
import { BUILT_IN_MODES } from "./modes.js";
import { getEffectiveHistory, injectSyntheticToolResults } from "./condense.js";

export class AgentSession {
  id: string;
  readonly background: boolean;
  createdAt: number;
  readonly cwd: string;
  systemPrompt: string;

  mode: string;
  /** Full mode definition (for tool filtering). Falls back to built-in 'code'. */
  agentMode: AgentMode;
  model: string;
  maxTokens: number;
  thinkingBudget: number;
  autoCondense: boolean;
  autoCondenseThreshold: number;
  status: SessionStatus = "idle";
  title: string = "New Chat";
  lastActiveAt: number;
  /** Name of the most recently started tool call (updated by AgentEngine). */
  currentTool: string | undefined;

  totalInputTokens: number = 0;
  totalOutputTokens: number = 0;
  totalCacheReadTokens: number = 0;
  totalCacheCreationTokens: number = 0;

  /** Full conversation history including condensed messages */
  private messages: AgentMessage[] = [];
  /** Files read during this session (for folded file context on condense) */
  readonly filesRead = new Set<string>();
  /** Total input tokens from the most recent API response: uncached + cache_read + cache_creation.
   *  This represents actual context window usage (used for condense threshold check & context bar). */
  lastInputTokens = 0;
  /** Cache-read tokens from the most recent API response (used for cache-aware condense threshold) */
  lastCacheReadTokens = 0;

  /** Active file path at session creation — used for subfolder AGENTS.md and hot-reload. */
  activeFilePath: string | undefined;

  private abortController: AbortController | null = null;
  private _abortSignal: AbortSignal | undefined;
  private _pendingInterjection: { text: string; queueId: string } | null = null;

  private constructor(opts: {
    mode: string;
    agentMode: AgentMode;
    config: AgentConfig;
    systemPrompt: string;
    background?: boolean;
    cwd: string;
    activeFilePath?: string;
  }) {
    this.id = randomUUID();
    this.mode = opts.mode;
    this.agentMode = opts.agentMode;
    this.cwd = opts.cwd;
    this.model = opts.config.model;
    this.maxTokens = opts.config.maxTokens;
    this.thinkingBudget = opts.config.thinkingBudget;
    this.autoCondense = opts.config.autoCondense ?? true;
    this.autoCondenseThreshold = opts.config.autoCondenseThreshold ?? 0.9;
    this.background = opts.background ?? false;
    this.createdAt = Date.now();
    this.lastActiveAt = this.createdAt;
    this.systemPrompt = opts.systemPrompt;
    this.activeFilePath = opts.activeFilePath;
  }

  static async create(opts: {
    mode: string;
    agentMode?: AgentMode;
    config: AgentConfig;
    cwd: string;
    background?: boolean;
    devMode?: boolean;
    activeFilePath?: string;
  }): Promise<AgentSession> {
    const systemPrompt = await buildSystemPrompt(opts.mode, opts.cwd, {
      devMode: opts.devMode,
      activeFilePath: opts.activeFilePath,
    });
    const agentMode =
      opts.agentMode ??
      BUILT_IN_MODES.find((m) => m.slug === opts.mode) ??
      BUILT_IN_MODES[0];
    return new AgentSession({
      mode: opts.mode,
      agentMode,
      config: opts.config,
      systemPrompt,
      cwd: opts.cwd,
      background: opts.background,
      activeFilePath: opts.activeFilePath,
    });
  }

  /**
   * Rebuild the system prompt in-place (used for hot-reload when instruction files change).
   * Preserves the activeFilePath that was set at session creation.
   */
  async rebuildSystemPrompt(opts?: { devMode?: boolean }): Promise<void> {
    this.systemPrompt = await buildSystemPrompt(this.mode, this.cwd, {
      devMode: opts?.devMode,
      activeFilePath: this.activeFilePath,
    });
  }

  /**
   * Switch mode in-place while preserving message history and session identity.
   */
  async setMode(
    mode: string,
    opts?: { agentMode?: AgentMode; devMode?: boolean },
  ): Promise<void> {
    const systemPrompt = await buildSystemPrompt(mode, this.cwd, {
      devMode: opts?.devMode,
    });
    const agentMode =
      opts?.agentMode ??
      BUILT_IN_MODES.find((m) => m.slug === mode) ??
      BUILT_IN_MODES[0];

    this.mode = mode;
    this.agentMode = agentMode;
    this.systemPrompt = systemPrompt;
    this.lastActiveAt = Date.now();
  }

  /** Full history (for persistence, rewind, etc.) */
  getAllMessages(): AgentMessage[] {
    return this.messages;
  }

  /**
   * Effective history to send to the API.
   * Filters out messages tagged with condenseParent whose summary still exists.
   */
  getMessages(): AgentMessage[] {
    return injectSyntheticToolResults(getEffectiveHistory(this.messages));
  }

  get messageCount(): number {
    return this.messages.length;
  }

  addUserMessage(text: string): void {
    this.messages.push({ role: "user", content: text } as AgentMessage);
    this.lastActiveAt = Date.now();
  }

  appendAssistantTurn(content: Anthropic.ContentBlock[]): void {
    this.messages.push({ role: "assistant", content } as AgentMessage);
    this.lastActiveAt = Date.now();
  }

  appendToolResults(
    results: Array<{
      type: "tool_result";
      tool_use_id: string;
      content: string | Anthropic.ToolResultBlockParam["content"];
    }>,
  ): void {
    this.messages.push({ role: "user", content: results } as AgentMessage);
    this.lastActiveAt = Date.now();
  }

  /** Replace full message history after condensing */
  replaceMessages(messages: AgentMessage[]): void {
    this.messages = messages;
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
    this.messages = data.messages;
  }

  /** Record that a file was read during this session */
  trackFileRead(filePath: string): void {
    this.filesRead.add(filePath);
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
    this.lastCacheReadTokens = cacheReadTokens;
  }

  /** Return the text content of the last assistant message, if any. */
  getLastAssistantText(): string | undefined {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const msg = this.messages[i];
      if (msg.role === "assistant") {
        if (Array.isArray(msg.content)) {
          return (
            msg.content
              .filter((b): b is Anthropic.TextBlock => b.type === "text")
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

  /** Auto-title from first user message */
  autoTitle(): void {
    const first = this.messages[0];
    if (first?.role === "user" && typeof first.content === "string") {
      this.title = first.content.slice(0, 80);
    }
  }

  setPendingInterjection(text: string, queueId: string): void {
    // Only register the first queued item; subsequent items wait until done
    if (this._pendingInterjection === null) {
      this._pendingInterjection = { text, queueId };
    }
  }

  consumePendingInterjection(): { text: string; queueId: string } | null {
    const interjection = this._pendingInterjection;
    this._pendingInterjection = null;
    return interjection;
  }

  createAbortController(): AbortController {
    this.abortController = new AbortController();
    this._abortSignal = this.abortController.signal;
    return this.abortController;
  }

  abort(): void {
    this.abortController?.abort();
    this.abortController = null;
  }

  get isAborted(): boolean {
    return this._abortSignal?.aborted ?? false;
  }

  get abortSignal(): AbortSignal | undefined {
    return this._abortSignal;
  }
}
