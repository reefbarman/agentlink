/**
 * AnthropicProvider — implements ModelProvider for the Anthropic Messages API.
 *
 * This is the only file (alongside clientFactory.ts) that imports @anthropic-ai/sdk.
 * Credential/client lifecycle stays here; provider-neutral request translation and
 * stream parsing live under src/core/model/providers/anthropic.
 */

import Anthropic from "@anthropic-ai/sdk";
import { withAgentLinkHttpActivity } from "../../../util/httpDispatcher.js";
import { buildAnthropicStreamRequest } from "../../../core/model/providers/anthropic/completionFacade.js";
import { parseAnthropicStreamEvents } from "../../../core/model/providers/anthropic/streamParser.js";
import { translateAnthropicMessages } from "../../../core/model/providers/anthropic/translation.js";
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
  MessageParam,
} from "../types.js";
import {
  AnthropicModelCatalog,
  type ModelCatalogPersistence,
} from "../../../core/model/providers/anthropic/anthropicModelCatalog.js";
import {
  ANTHROPIC_CONDENSE_MODEL,
  ANTHROPIC_HOSTED_WEB_CAPABILITIES,
  ANTHROPIC_MODEL_CAPABILITIES,
  ANTHROPIC_MODEL_DISPLAY_NAMES,
  ANTHROPIC_STATIC_MODEL_ORDER,
  DEFAULT_ANTHROPIC_MODEL_CAPABILITIES,
  buildAnthropicStaticModelEntries,
} from "../../../core/model/providers/anthropic/anthropicModels.js";

export { ANTHROPIC_CONDENSE_MODEL };

/** Options accepted by AnthropicProvider for dynamic model capabilities. */
export interface AnthropicProviderOptions {
  /** Persistence port for the dynamic model catalog snapshot (host-injected). */
  modelCatalogPersistence?: ModelCatalogPersistence;
  /** Feature flag (Q1 default true). When false, only static metadata is used. */
  dynamicCapabilitiesEnabled?: boolean;
  /** Optional host-injected client factory for resolved credentials outside VS Code. */
  createClient?: (apiKey: string | undefined) => {
    client: Anthropic;
    authSource: AuthSource;
  };
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
  private readonly createClient: (apiKey: string | undefined) => {
    client: Anthropic;
    authSource: AuthSource;
  };

  constructor(
    apiKey?: string,
    log?: (msg: string) => void,
    options?: AnthropicProviderOptions,
  ) {
    this.apiKey = apiKey;
    this.log = log;
    this.createClient =
      options?.createClient ?? ((key) => createAnthropicClient(key, this.log));
    this.dynamicCapabilitiesEnabled =
      options?.dynamicCapabilitiesEnabled ?? true;
    this.catalog = new AnthropicModelCatalog({
      providerId: this.id,
      staticModels: buildAnthropicStaticModelEntries(),
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
    const capabilities = this.dynamicCapabilitiesEnabled
      ? (this.catalog.getCapabilities(model) ??
        ANTHROPIC_MODEL_CAPABILITIES[model] ??
        DEFAULT_ANTHROPIC_MODEL_CAPABILITIES)
      : (ANTHROPIC_MODEL_CAPABILITIES[model] ??
        DEFAULT_ANTHROPIC_MODEL_CAPABILITIES);
    return copyModelCapabilities(capabilities);
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
                  data: import("../../../core/model/providers/anthropic/anthropicModelCatalog.js").SdkModelInfo[];
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
      hostedTools,
      maxTokens,
      thinking,
      reasoningEffort,
      signal,
    } = request;
    const requestParams = buildAnthropicStreamRequest({
      model,
      systemPrompt,
      messages,
      maxTokens,
      reasoningEffort,
      supportsAdaptiveThinking: this.supportsAdaptiveThinking(model),
      thinking,
      tools,
      hostedTools,
    }) as unknown as Anthropic.MessageCreateParams;

    const stream = withAgentLinkHttpActivity(request.onTransportActivity, () =>
      client.messages.stream(requestParams, {
        signal,
        maxRetries: 0,
      }),
    );
    const rawEvents = (async function* () {
      for await (const event of stream) {
        request.onTransportActivity?.({
          kind: "provider_event",
          at: Date.now(),
        });
        yield event as unknown as Record<string, unknown>;
      }
    })();
    yield* parseAnthropicStreamEvents(rawEvents);
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

    const requestParams = {
      model,
      max_tokens: maxTokens,
      ...(temperature !== undefined && !this.supportsAdaptiveThinking(model)
        ? { temperature }
        : {}),
      system: systemPrompt,
      messages: translateAnthropicMessages(messages, {
        cacheBreakpoints: false,
      }).messages,
    } as unknown as Anthropic.MessageCreateParamsNonStreaming;

    const requestedEffort = reasoningEffort ?? "high";
    if (requestedEffort !== "none" && this.supportsAdaptiveThinking(model)) {
      const params = requestParams as unknown as Record<string, unknown>;
      params.thinking = { type: "adaptive", display: "summarized" };
      params.output_config = { effort: requestedEffort };
    }

    const response = request.signal
      ? await client.messages.create(requestParams, { signal: request.signal })
      : await client.messages.create(requestParams);

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
      const result = this.createClient(this.apiKey);
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
    const result = this.createClient(this.apiKey);
    this.client = result.client;
    this.authSource = result.authSource;
    return result.client;
  }
}

// ── Helpers (moved from AgentEngine.ts) ──

function copyModelCapabilities(
  capabilities: ModelCapabilities,
): ModelCapabilities {
  return {
    ...capabilities,
    hostedWeb: ANTHROPIC_HOSTED_WEB_CAPABILITIES,
    ...(capabilities.reasoningEfforts
      ? { reasoningEfforts: [...capabilities.reasoningEfforts] }
      : {}),
  };
}

/** Static fallback used when dynamic model capabilities are disabled. */
function staticSupportsAdaptiveThinking(model: string): boolean {
  return Boolean(ANTHROPIC_MODEL_CAPABILITIES[model]?.supportsAdaptiveThinking);
}

export interface AnthropicReplaySanitizationResult {
  messages: MessageParam[];
  strippedThinking: boolean;
  strippedThinkingFromToolUse: boolean;
}

/** Compatibility wrapper retained for existing extension tests and callers. */
export function sanitizeMessagesForAnthropicReplay(
  messages: MessageParam[],
): AnthropicReplaySanitizationResult {
  const translated = translateAnthropicMessages(messages, {
    cacheBreakpoints: false,
  });
  return {
    messages: translated.messages as MessageParam[],
    strippedThinking: translated.strippedThinking,
    strippedThinkingFromToolUse: translated.strippedThinkingFromToolUse,
  };
}
