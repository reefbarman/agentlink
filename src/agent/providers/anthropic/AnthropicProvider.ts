/**
 * AnthropicProvider — implements ModelProvider for the Anthropic Messages API.
 *
 * This is the only file (alongside clientFactory.ts) that imports @anthropic-ai/sdk.
 * All Anthropic-specific SSE parsing, cache_control injection, and message
 * formatting lives here.
 */

import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "crypto";
import {
  createAnthropicClient,
  hasAnthropicApiKey,
  refreshClaudeCredentials,
  type AuthSource,
} from "../../clientFactory.js";
import type {
  ModelProvider,
  StreamRequest,
  CompleteRequest,
  CompleteResult,
  ProviderStreamEvent,
  ModelCapabilities,
  ModelInfo,
  ContentBlock,
  MessageParam,
  ToolDefinition,
  ReasoningEffort,
} from "../types.js";
import {
  AnthropicModelCatalog,
  type AnthropicModelCapabilities,
  type ModelCatalogPersistence,
  type StaticModelEntry,
} from "./anthropicModelCatalog.js";

const CLAUDE_REASONING_EFFORTS = [
  "none",
  "low",
  "medium",
  "high",
  "max",
] as const satisfies readonly ReasoningEffort[];

const ANTHROPIC_MODEL_CAPABILITIES: Record<string, AnthropicModelCapabilities> =
  {
    "claude-opus-4-8": {
      supportsThinking: true,
      supportsAdaptiveThinking: true,
      supportsCaching: true,
      supportsImages: true,
      supportsToolUse: true,
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      reasoningEfforts: [...CLAUDE_REASONING_EFFORTS],
      defaultReasoningEffort: "high",
    },
    "claude-sonnet-4-6": {
      supportsThinking: true,
      supportsAdaptiveThinking: true,
      supportsCaching: true,
      supportsImages: true,
      supportsToolUse: true,
      contextWindow: 1_000_000,
      maxOutputTokens: 64_000,
      reasoningEfforts: [...CLAUDE_REASONING_EFFORTS],
      defaultReasoningEffort: "high",
    },
    "claude-haiku-4-5-20251001": {
      supportsThinking: false,
      supportsAdaptiveThinking: false,
      supportsCaching: true,
      supportsImages: true,
      supportsToolUse: true,
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
    },
  };

/** Display names for the statically-known models (merge base + offline fallback). */
const ANTHROPIC_MODEL_DISPLAY_NAMES: Record<string, string> = {
  "claude-sonnet-4-6": "Claude Sonnet 4.6",
  "claude-opus-4-8": "Claude Opus 4.8",
  "claude-haiku-4-5-20251001": "Claude Haiku 4.5",
};

/** Static-listing order preserved from the original hard-coded `listModels()`. */
const ANTHROPIC_STATIC_MODEL_ORDER = [
  "claude-sonnet-4-6",
  "claude-opus-4-8",
  "claude-haiku-4-5-20251001",
] as const;

function buildStaticModelEntries(): StaticModelEntry[] {
  return ANTHROPIC_STATIC_MODEL_ORDER.map((id) => ({
    id,
    displayName: ANTHROPIC_MODEL_DISPLAY_NAMES[id] ?? id,
    capabilities: ANTHROPIC_MODEL_CAPABILITIES[id],
  }));
}

const DEFAULT_CAPABILITIES: AnthropicModelCapabilities = {
  supportsThinking: false,
  supportsCaching: true,
  supportsImages: true,
  supportsToolUse: true,
  contextWindow: 200_000,
  maxOutputTokens: 128_000,
};

/** The preferred cheap/fast model for condensing. */
export const ANTHROPIC_CONDENSE_MODEL = "claude-haiku-4-5-20251001";

/** Options accepted by AnthropicProvider for dynamic model capabilities. */
export interface AnthropicProviderOptions {
  /** Persistence port for the dynamic model catalog snapshot (host-injected). */
  modelCatalogPersistence?: ModelCatalogPersistence;
  /** Feature flag (Q1 default true). When false, only static metadata is used. */
  dynamicCapabilitiesEnabled?: boolean;
}

export class AnthropicProvider implements ModelProvider {
  readonly id = "anthropic";
  readonly displayName = "Anthropic";
  readonly condenseModel = ANTHROPIC_CONDENSE_MODEL;

  private client: Anthropic | null = null;
  private authSource: AuthSource = "none";
  private apiKey?: string;
  private log?: (msg: string) => void;
  private readonly catalog: AnthropicModelCatalog;
  private readonly dynamicCapabilitiesEnabled: boolean;

  constructor(
    apiKey?: string,
    log?: (msg: string) => void,
    options?: AnthropicProviderOptions,
  ) {
    this.apiKey = apiKey;
    this.log = log;
    this.dynamicCapabilitiesEnabled =
      options?.dynamicCapabilitiesEnabled ?? true;
    this.catalog = new AnthropicModelCatalog({
      providerId: this.id,
      staticModels: buildStaticModelEntries(),
      // Flag off ⇒ no persisted seed, no snapshot-driven getters (kill switch).
      persistence: this.dynamicCapabilitiesEnabled
        ? options?.modelCatalogPersistence
        : undefined,
      log,
    });
    this.tryInitializeClient();
  }

  async isAuthenticated(): Promise<boolean> {
    return hasAnthropicApiKey();
  }

  getCapabilities(model: string): ModelCapabilities {
    if (this.dynamicCapabilitiesEnabled) {
      const dynamic = this.catalog.getCapabilities(model);
      if (dynamic) return dynamic;
    }
    return ANTHROPIC_MODEL_CAPABILITIES[model] ?? DEFAULT_CAPABILITIES;
  }

  listModels(): ModelInfo[] {
    if (this.dynamicCapabilitiesEnabled && this.catalog.hasDynamicData()) {
      return this.catalog.listModels();
    }
    return ANTHROPIC_STATIC_MODEL_ORDER.map((id) =>
      this.makeModelInfo(id, ANTHROPIC_MODEL_DISPLAY_NAMES[id] ?? id),
    );
  }

  /**
   * Model IDs that must remain routable (picker-visible models plus the static
   * routing floor). Used by the registry index so persisted-session model IDs
   * resolve even when omitted from a successful `models.list()` (design §0.2).
   */
  listRoutableModelIds(): string[] {
    if (this.dynamicCapabilitiesEnabled && this.catalog.hasDynamicData()) {
      return this.catalog.listRoutableModelIds();
    }
    return [...ANTHROPIC_STATIC_MODEL_ORDER];
  }

  /**
   * Lazy, coalesced refresh of dynamic model capabilities from the Anthropic
   * Models API. Never called on construct/activation. Returns the merged list.
   * Flag-off ⇒ returns the static list without any network call.
   */
  async listAvailableModels(options?: {
    force?: boolean;
  }): Promise<ModelInfo[]> {
    if (!this.dynamicCapabilitiesEnabled) {
      return this.listModels();
    }
    // Respect the TTL (Q2): skip the network when cached data is still fresh,
    // unless the caller forces a refresh (e.g. explicit refresh / auth change).
    if (!options?.force && this.catalog.hasFreshData()) {
      return this.listModels();
    }
    try {
      const client = this.getClient();
      return await this.catalog.refresh({
        list: () =>
          (
            client as unknown as {
              models: {
                list: () => Promise<{
                  data: import("./anthropicModelCatalog.js").SdkModelInfo[];
                }>;
              };
            }
          ).models.list(),
      });
    } catch (err) {
      this.log?.(
        `[anthropic] listAvailableModels unavailable: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return this.listModels();
    }
  }

  /** Whether dynamic model capabilities are enabled (kill switch state). */
  get dynamicModelCapabilitiesEnabled(): boolean {
    return this.dynamicCapabilitiesEnabled;
  }

  /**
   * Attempt to refresh CLI credentials (runs `claude -p` to force the SDK
   * to refresh the OAuth token), then re-create the Anthropic client.
   * Returns true if the client was successfully refreshed.
   * Pass an AbortSignal to cancel if the user stops the session.
   */
  async refreshClient(signal?: AbortSignal): Promise<boolean> {
    if (this.authSource !== "cli-credentials") return false;
    const refreshed = await refreshClaudeCredentials(this.log, signal);
    if (!refreshed) return false;
    try {
      const result = createAnthropicClient(this.apiKey, this.log);
      this.client = result.client;
      this.authSource = result.authSource;
      return true;
    } catch {
      return false;
    }
  }

  get currentAuthSource(): AuthSource {
    return this.authSource;
  }

  async *stream(request: StreamRequest): AsyncGenerator<ProviderStreamEvent> {
    const client = this.getClient();
    const {
      model,
      systemPrompt,
      messages,
      tools,
      maxTokens,
      thinking,
      reasoningEffort,
      signal,
    } = request;

    // Build Anthropic-native request params. Historical extended-thinking
    // signatures are provider-private replay artifacts; keep them in the local
    // transcript/UI, but do not send them back to Anthropic.
    const transformedReplay = getTransformedAnthropicMessages(messages);
    const { anthropicMessages } = transformedReplay;

    const anthropicTools = tools ? translateAnthropicTools(tools) : undefined;

    const requestParams: Anthropic.MessageCreateParams = {
      model,
      system: [
        {
          type: "text",
          text: systemPrompt,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: anthropicMessages,
      max_tokens: maxTokens,
      stream: true,
      ...(anthropicTools && anthropicTools.length > 0
        ? { tools: anthropicTools }
        : {}),
    };

    const requestedEffort = reasoningEffort ?? "high";
    if (
      requestedEffort !== "none" &&
      !transformedReplay.strippedThinkingFromToolUse
    ) {
      const params = requestParams as unknown as Record<string, unknown>;
      if (this.supportsAdaptiveThinking(model)) {
        params.thinking = { type: "adaptive", display: "summarized" };
        params.output_config = { effort: requestedEffort };
      } else if (thinking) {
        params.thinking = {
          type: "enabled",
          budget_tokens: thinking.budgetTokens,
          display: "summarized",
        };
      }
    }

    const contentBlocks: ContentBlock[] = [];
    const blockBuffers = new Map<
      number,
      {
        type: string;
        id?: string;
        text: string;
        name?: string;
        signature?: string;
        thinkingStarted?: boolean;
      }
    >();

    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheCreationTokens = 0;

    const stream = client.messages.stream(requestParams, {
      signal,
      maxRetries: 0,
    });

    for await (const event of stream) {
      switch (event.type) {
        case "content_block_start": {
          const block = event.content_block;
          const idx = event.index;

          if (block.type === "thinking") {
            blockBuffers.set(idx, {
              type: "thinking",
              id: randomUUID(),
              text: "",
              thinkingStarted: false,
            });
          } else if (block.type === "text") {
            blockBuffers.set(idx, { type: "text", text: "" });
          } else if (block.type === "tool_use") {
            blockBuffers.set(idx, {
              type: "tool_use",
              id: block.id,
              name: block.name,
              text: "",
            });
            yield {
              type: "tool_start",
              toolCallId: block.id,
              toolName: block.name,
            };
          }
          break;
        }

        case "content_block_delta": {
          const idx = event.index;
          const buf = blockBuffers.get(idx);

          if (
            event.delta.type === "thinking_delta" &&
            buf?.type === "thinking"
          ) {
            const delta = event.delta.thinking;
            if (!delta) break;
            buf.text += delta;
            if (!buf.thinkingStarted) {
              buf.thinkingStarted = true;
              yield { type: "thinking_start", thinkingId: buf.id! };
            }
            yield {
              type: "thinking_delta",
              thinkingId: buf.id!,
              text: delta,
            };
          } else if (
            event.delta.type === "text_delta" &&
            buf?.type === "text"
          ) {
            buf.text += event.delta.text;
            yield { type: "text_delta", text: event.delta.text };
          } else if (
            event.delta.type === "signature_delta" &&
            buf?.type === "thinking"
          ) {
            buf.signature =
              (buf.signature ?? "") +
              (event.delta as unknown as { signature: string }).signature;
          } else if (
            event.delta.type === "input_json_delta" &&
            buf?.type === "tool_use"
          ) {
            buf.text += event.delta.partial_json;
            yield {
              type: "tool_input_delta",
              toolCallId: buf.id!,
              partialJson: event.delta.partial_json,
            };
          }
          break;
        }

        case "content_block_stop": {
          const idx = event.index;
          const buf = blockBuffers.get(idx);

          if (buf?.type === "thinking") {
            if (buf.thinkingStarted) {
              yield { type: "thinking_end", thinkingId: buf.id! };
            }
            if (buf.text.trim()) {
              contentBlocks.push({
                type: "thinking",
                thinking: buf.text,
                signature: buf.signature ?? "",
              } satisfies ContentBlock);
            }
          } else if (buf?.type === "text") {
            contentBlocks.push({
              type: "text",
              text: buf.text,
            } satisfies ContentBlock);
          } else if (buf?.type === "tool_use") {
            const parsed = buf.text ? JSON.parse(buf.text) : {};
            contentBlocks.push({
              type: "tool_use",
              id: buf.id!,
              name: buf.name!,
              input: parsed,
            } satisfies ContentBlock);
            yield {
              type: "tool_done",
              toolCallId: buf.id!,
              toolName: buf.name!,
              input: parsed,
            };
          }

          blockBuffers.delete(idx);
          break;
        }

        case "message_delta": {
          if (event.usage) {
            outputTokens = event.usage.output_tokens;
          }
          break;
        }

        case "message_start": {
          if (event.message.usage) {
            inputTokens = event.message.usage.input_tokens;
            const u = event.message.usage as typeof event.message.usage & {
              cache_read_input_tokens?: number;
              cache_creation_input_tokens?: number;
            };
            cacheReadTokens = u.cache_read_input_tokens ?? 0;
            cacheCreationTokens = u.cache_creation_input_tokens ?? 0;
          }
          break;
        }
      }
    }

    yield {
      type: "usage",
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
    };
    yield { type: "content_blocks", blocks: contentBlocks };
    yield { type: "done" };
  }

  async complete(request: CompleteRequest): Promise<CompleteResult> {
    const client = this.getClient();
    const {
      model,
      systemPrompt,
      messages,
      maxTokens,
      temperature,
      reasoningEffort,
    } = request;

    const requestParams: Anthropic.MessageCreateParams = {
      model,
      max_tokens: maxTokens,
      ...(temperature !== undefined && !this.supportsAdaptiveThinking(model)
        ? { temperature }
        : {}),
      system: systemPrompt,
      messages: mergeConsecutiveUserMessages(
        sanitizeMessagesForAnthropicReplay(messages).messages,
      ).map(({ role, content }) => ({
        role,
        content,
      })) as Anthropic.MessageParam[],
    };

    const requestedEffort = reasoningEffort ?? "high";
    if (requestedEffort !== "none" && this.supportsAdaptiveThinking(model)) {
      const params = requestParams as unknown as Record<string, unknown>;
      params.thinking = { type: "adaptive", display: "summarized" };
      params.output_config = { effort: requestedEffort };
    }

    const response = await client.messages.create(requestParams);

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");

    return {
      text,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    };
  }

  private makeModelInfo(id: string, displayName: string): ModelInfo {
    return {
      id,
      displayName,
      provider: this.id,
      capabilities: this.getCapabilities(id),
    };
  }

  /**
   * Whether the model supports the "adaptive" thinking request shape. Sourced
   * from dynamic catalog data when present, falling back to the static set so
   * request assembly stays correct for newly discovered models (design §3.4a).
   */
  private supportsAdaptiveThinking(model: string): boolean {
    if (this.dynamicCapabilitiesEnabled) {
      return this.catalog.supportsAdaptiveThinking(model);
    }
    return staticSupportsAdaptiveThinking(model);
  }

  private tryInitializeClient(): void {
    try {
      const result = createAnthropicClient(this.apiKey, this.log);
      this.client = result.client;
      this.authSource = result.authSource;
    } catch (err) {
      this.client = null;
      this.authSource = "none";
      this.log?.(
        `[auth] Anthropic client unavailable at startup: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private getClient(): Anthropic {
    if (this.client) return this.client;
    const result = createAnthropicClient(this.apiKey, this.log);
    this.client = result.client;
    this.authSource = result.authSource;
    return result.client;
  }
}

// ── Helpers (moved from AgentEngine.ts) ──

/** Static fallback used when dynamic model capabilities are disabled. */
function staticSupportsAdaptiveThinking(model: string): boolean {
  return Boolean(ANTHROPIC_MODEL_CAPABILITIES[model]?.supportsAdaptiveThinking);
}

interface AnthropicMessageTransformResult extends AnthropicReplaySanitizationResult {
  anthropicMessages: Anthropic.MessageParam[];
}

export interface AnthropicReplaySanitizationResult {
  messages: MessageParam[];
  strippedThinking: boolean;
  strippedThinkingFromToolUse: boolean;
}

let nextMessageContentFingerprintId = 1;
const messageContentFingerprintIds = new WeakMap<object, number>();
// Message arrays/content blocks are treated as immutable replay snapshots once
// passed to the provider. The cache key intentionally uses exact string content
// and object identity for block arrays to avoid re-walking large media/tool
// transcripts on every stream attempt.
const messageTransformCache = new Map<
  string,
  AnthropicMessageTransformResult
>();
const MAX_MESSAGE_TRANSFORM_CACHE_ENTRIES = 8;

function getMessageContentFingerprintId(value: object): number {
  let id = messageContentFingerprintIds.get(value);
  if (id === undefined) {
    id = nextMessageContentFingerprintId++;
    messageContentFingerprintIds.set(value, id);
  }
  return id;
}

function buildMessageTransformFingerprint(messages: MessageParam[]): string {
  return messages
    .map((message, index) => {
      const content = message.content;
      const contentFingerprint =
        typeof content === "string"
          ? `s:${content}`
          : Array.isArray(content)
            ? `a:${getMessageContentFingerprintId(content)}:${content.length}`
            : `o:${String(content)}`;
      return `${index}:${message.role}:${contentFingerprint}`;
    })
    .join("|");
}

function getTransformedAnthropicMessages(
  messages: MessageParam[],
): AnthropicMessageTransformResult {
  const fingerprint = buildMessageTransformFingerprint(messages);
  const cached = messageTransformCache.get(fingerprint);
  if (cached) return cached;

  const sanitizedReplay = sanitizeMessagesForAnthropicReplay(messages);
  const anthropicMessages = addMessageCacheBreakpoints(
    mergeConsecutiveUserMessages(sanitizedReplay.messages),
  ) as Anthropic.MessageParam[];
  const result = { ...sanitizedReplay, anthropicMessages };
  messageTransformCache.set(fingerprint, result);
  if (messageTransformCache.size > MAX_MESSAGE_TRANSFORM_CACHE_ENTRIES) {
    const oldestKey = messageTransformCache.keys().next().value;
    if (oldestKey) messageTransformCache.delete(oldestKey);
  }
  return result;
}

export function sanitizeMessagesForAnthropicReplay(
  messages: MessageParam[],
): AnthropicReplaySanitizationResult {
  const sanitized: MessageParam[] = [];
  let strippedThinking = false;
  let strippedThinkingFromToolUse = false;

  for (const msg of messages) {
    if (!Array.isArray(msg.content)) {
      sanitized.push({ role: msg.role, content: msg.content });
      continue;
    }

    const hadThinking = msg.content.some((block) => block.type === "thinking");
    const hasToolUse = msg.content.some((block) => block.type === "tool_use");
    const content = msg.content.filter((block) => block.type !== "thinking");
    if (hadThinking) {
      strippedThinking = true;
      strippedThinkingFromToolUse ||= msg.role === "assistant" && hasToolUse;
    }
    if (content.length === 0) continue;
    sanitized.push({ role: msg.role, content });
  }

  return { messages: sanitized, strippedThinking, strippedThinkingFromToolUse };
}

const anthropicToolCache = new WeakMap<ToolDefinition[], Anthropic.Tool[]>();

function toAnthropicTool(tool: ToolDefinition): Anthropic.Tool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.input_schema as Anthropic.Tool["input_schema"],
  };
}

function translateAnthropicTools(tools: ToolDefinition[]): Anthropic.Tool[] {
  const cached = anthropicToolCache.get(tools);
  if (cached) return cached;
  const translated = tools.map((t, i) =>
    i === tools.length - 1
      ? {
          ...toAnthropicTool(t),
          cache_control: { type: "ephemeral" as const },
        }
      : toAnthropicTool(t),
  );
  anthropicToolCache.set(tools, translated);
  return translated;
}

/**
 * Merge consecutive user messages before sending to the API.
 * Consecutive user messages can occur after condense (summary message followed
 * by a pending user message) or when the user interjects between tool batches.
 */
function mergeConsecutiveUserMessages(
  messages: MessageParam[],
): MessageParam[] {
  const result: MessageParam[] = [];
  for (const msg of messages) {
    const last = result[result.length - 1];
    if (last?.role === "user" && msg.role === "user") {
      const toBlocks = (c: MessageParam["content"]): ContentBlock[] =>
        Array.isArray(c) ? c : [{ type: "text", text: c as string }];
      last.content = [...toBlocks(last.content), ...toBlocks(msg.content)];
    } else {
      result.push({ role: msg.role, content: msg.content });
    }
  }
  return result;
}

/**
 * Add cache_control breakpoints to the last 2 user messages.
 * Multi-point caching: the second-to-last breakpoint hits the cache on the next
 * turn (the prefix before it is stable), while the last creates a new cache entry
 * so the turn after that also benefits.
 */
function addMessageCacheBreakpoints(messages: MessageParam[]): MessageParam[] {
  const userIndices: number[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      userIndices.push(i);
      if (userIndices.length === 2) break;
    }
  }
  if (userIndices.length === 0) return messages;

  return messages.map((msg, idx) => {
    if (!userIndices.includes(idx)) return msg;
    const blocks = Array.isArray(msg.content)
      ? (msg.content as unknown as Array<Record<string, unknown>>)
      : [{ type: "text", text: msg.content as string }];
    if (blocks.length === 0) return msg;
    // Strip any pre-existing cache_control from non-last blocks
    const patched = [
      ...blocks.slice(0, -1).map(({ cache_control: _cc, ...rest }) => rest),
      { ...blocks[blocks.length - 1], cache_control: { type: "ephemeral" } },
    ];
    return {
      role: msg.role,
      content: patched as unknown as ContentBlock[],
    };
  });
}
