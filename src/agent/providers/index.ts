/**
 * Provider registry — routes model IDs to their owning ModelProvider.
 *
 * Each provider declares its models via listModels(). The registry builds
 * a model→provider lookup. Unknown model IDs are rejected with a helpful error.
 */

export {
  type ModelProvider,
  type StreamRequest,
  type CompleteRequest,
  type CompleteResult,
  type ProviderStreamEvent,
  type ModelCapabilities,
  type ModelInfo,
  type ContentBlock,
  type TextBlock,
  type ThinkingBlock,
  type ToolUseBlock,
  type ToolResultBlock,
  type ImageBlock,
  type MessageParam,
  type ToolDefinition,
  type JsonSchema,
} from "./types.js";

export {
  AnthropicProvider,
  ANTHROPIC_CONDENSE_MODEL,
} from "./anthropic/index.js";

export {
  CodexProvider,
  CODEX_CONDENSE_MODEL,
  CODEX_CONDENSE_MODEL_FALLBACKS,
  CodexOAuthManager,
  codexOAuthManager,
  OpenAiCodexAuthManager,
  openAiCodexAuthManager,
  queryCodexCliUsage,
  type CodexCredentials,
  type CodexOAuthAccountInfo,
  type SaveOAuthAccountOptions,
  type SaveOAuthAccountResult,
  type OpenAiCodexAuthMethod,
  type OpenAiCodexResolvedAuth,
  type OpenAiApiKeyCredential,
  type CodexCliUsageResult,
  type CodexSubscriptionUsage,
} from "./codex/index.js";

import type { ModelProvider, ModelInfo } from "./types.js";
import { ModelRequestScheduler } from "../../core/modelRequestScheduler.js";

export {
  queryProviderUsage,
  createCodexUsageAdapter,
  type ProviderUsageAdapter,
  type ProviderUsageEntry,
  type ProviderUsageSnapshot,
} from "./ProviderUsageService.js";

export class ProviderRegistry {
  private providers = new Map<string, ModelProvider>();
  private modelIndex = new Map<string, string>(); // modelId → providerId
  readonly requestScheduler: ModelRequestScheduler;

  constructor(requestScheduler = new ModelRequestScheduler()) {
    this.requestScheduler = requestScheduler;
  }

  register(provider: ModelProvider): void {
    this.providers.set(provider.id, provider);
    this.rebuildIndex();
  }

  private rebuildIndex(): void {
    this.modelIndex.clear();
    for (const provider of this.providers.values()) {
      // Index picker-visible models...
      for (const model of provider.listModels()) {
        this.modelIndex.set(model.id, provider.id);
      }
      // ...plus any routing-floor IDs the provider keeps resolvable but hidden
      // from the picker (e.g. static Anthropic models omitted by models.list()).
      for (const id of provider.listRoutableModelIds?.() ?? []) {
        if (!this.modelIndex.has(id)) {
          this.modelIndex.set(id, provider.id);
        }
      }
    }
  }

  /**
   * Rebuild the model→provider routing index from current `listModels()` output.
   *
   * Call after a provider's dynamic model set changes (e.g. Anthropic dynamic
   * capability refresh) so newly added/removed model IDs route correctly.
   */
  refreshIndex(): void {
    this.rebuildIndex();
  }

  /**
   * Resolve provider for a model. Uses provider.listModels() as source of truth —
   * each provider owns its model list. No prefix-based guessing.
   */
  resolveProvider(model: string): ModelProvider {
    const providerId = this.modelIndex.get(model);
    if (providerId) {
      return this.providers.get(providerId)!;
    }

    // Unknown model — list available models for a helpful error
    const available = this.listAllModels()
      .map((m) => m.id)
      .join(", ");
    throw new Error(
      `Unknown model "${model}". Available models: ${available || "(none)"}`,
    );
  }

  /**
   * Try to resolve a provider, returning undefined if not found.
   * Useful when the caller wants to handle unknown models gracefully.
   */
  tryResolveProvider(model: string): ModelProvider | undefined {
    const providerId = this.modelIndex.get(model);
    if (providerId) {
      return this.providers.get(providerId);
    }
    return undefined;
  }

  /**
   * Resolve a picker-visible/routable model, following provider-owned legacy
   * migrations when a persisted model id has been retired. Migration targets
   * must resolve back to the same provider, and chains are cycle-safe.
   */
  resolveAvailableModel(model: string):
    | {
        model: string;
        provider: ModelProvider;
        migratedFrom?: string;
      }
    | undefined {
    const requested = model.trim();
    if (!requested) return undefined;

    let candidate = requested;
    const visited = new Set<string>();
    let migrationProviderId: string | undefined;
    while (!visited.has(candidate)) {
      visited.add(candidate);
      const providerId = this.modelIndex.get(candidate);
      if (providerId) {
        if (
          migrationProviderId !== undefined &&
          providerId !== migrationProviderId
        ) {
          return undefined;
        }
        const provider = this.providers.get(providerId)!;
        return {
          model: candidate,
          provider,
          ...(candidate !== requested ? { migratedFrom: requested } : {}),
        };
      }

      let migration: { model: string; provider: ModelProvider } | undefined;
      for (const provider of this.providers.values()) {
        const migrated = provider.getModelMigration?.(candidate)?.trim();
        if (!migrated) continue;
        if (
          migration !== undefined ||
          (migrationProviderId !== undefined &&
            provider.id !== migrationProviderId)
        ) {
          return undefined;
        }
        migration = { model: migrated, provider };
      }
      if (!migration) return undefined;
      migrationProviderId ??= migration.provider.id;

      const targetProviderId = this.modelIndex.get(migration.model);
      if (
        targetProviderId !== undefined &&
        targetProviderId !== migration.provider.id
      ) {
        return undefined;
      }
      candidate = migration.model;
    }

    return undefined;
  }

  /**
   * Aggregate models from all registered providers.
   */
  listAllModels(): ModelInfo[] {
    const models: ModelInfo[] = [];
    for (const provider of this.providers.values()) {
      models.push(...provider.listModels());
    }
    return models;
  }

  /**
   * Async — calls provider.isAuthenticated() for each registered provider.
   */
  async getAuthStatus(): Promise<Record<string, boolean>> {
    const entries = await Promise.all(
      Array.from(this.providers.entries()).map(async ([id, p]) => {
        const authed = await p.isAuthenticated();
        return [id, authed] as const;
      }),
    );
    return Object.fromEntries(entries);
  }
}

/** Singleton registry used by the agent runtime. */
export const providerRegistry = new ProviderRegistry();
