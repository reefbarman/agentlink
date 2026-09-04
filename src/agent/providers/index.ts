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
  getProviderAuxiliaryModel,
} from "./types.js";

export {
  CodexProvider,
  CODEX_CONDENSE_MODEL,
  CODEX_CONDENSE_MODEL_FALLBACKS,
  CodexOAuthManager,
  codexOAuthManager,
  OpenAiCodexAuthManager,
  openAiCodexAuthManager,
  queryCodexUsage,
  type CodexCredentials,
  type CodexOAuthAccountInfo,
  type SaveOAuthAccountOptions,
  type SaveOAuthAccountResult,
  type OpenAiCodexAuthMethod,
  type OpenAiCodexResolvedAuth,
  type OpenAiApiKeyCredential,
  type CodexUsageResult,
  type CodexCliUsageResult,
  type CodexSubscriptionUsage,
} from "./codex/index.js";

import type { ModelProvider, ModelInfo } from "./types.js";
import type {
  CoreModelCatalogEntry,
  CoreModelCatalogSnapshot,
} from "@agentlink/protocol/model-catalog";
import { ModelRequestScheduler } from "@agentlink/core/model-request-scheduler";

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
  private disabledProviders = new Set<string>();
  readonly requestScheduler: ModelRequestScheduler;

  constructor(requestScheduler = new ModelRequestScheduler()) {
    this.requestScheduler = requestScheduler;
  }

  register(provider: ModelProvider): void {
    if (this.providers.has(provider.id)) {
      throw new Error(`Duplicate model provider "${provider.id}"`);
    }
    this.reconcile([...this.providers.values(), provider]);
  }

  /**
   * Atomically replace the complete provider set. The current registry remains
   * intact when provider/model validation fails.
   */
  reconcile(providers: Iterable<ModelProvider>): void {
    const candidateProviders = new Map<string, ModelProvider>();
    for (const provider of providers) {
      if (candidateProviders.has(provider.id)) {
        throw new Error(`Duplicate model provider "${provider.id}"`);
      }
      candidateProviders.set(provider.id, provider);
    }
    const candidateIndex = this.buildIndex(candidateProviders);
    this.providers = candidateProviders;
    this.modelIndex = candidateIndex;
  }

  getProvider(providerId: string): ModelProvider | undefined {
    return this.providers.get(providerId);
  }

  listProviders(): ModelProvider[] {
    return [...this.providers.values()];
  }

  setDisabledProviders(providerIds: Iterable<string>): void {
    this.disabledProviders = new Set(
      [...providerIds].map((id) => id.trim()).filter(Boolean),
    );
    this.rebuildIndex();
  }

  isProviderEnabled(providerId: string): boolean {
    return !this.disabledProviders.has(providerId);
  }

  private buildIndex(
    providers: ReadonlyMap<string, ModelProvider>,
  ): Map<string, string> {
    const index = new Map<string, string>();
    for (const provider of providers.values()) {
      if (!this.isProviderEnabled(provider.id)) continue;
      const addModel = (modelId: string): void => {
        const existingProviderId = index.get(modelId);
        if (existingProviderId) {
          throw new Error(
            `Duplicate model "${modelId}" registered by providers "${existingProviderId}" and "${provider.id}"`,
          );
        }
        index.set(modelId, provider.id);
      };
      // Index picker-visible models...
      for (const model of provider.listModels()) addModel(model.id);
      // ...plus any routing-floor IDs the provider keeps resolvable but hidden
      // from the picker.
      for (const id of provider.listRoutableModelIds?.() ?? []) {
        if (!index.has(id)) addModel(id);
      }
    }
    return index;
  }

  private rebuildIndex(): void {
    this.modelIndex = this.buildIndex(this.providers);
  }

  /**
   * Rebuild the model→provider routing index from current `listModels()` output.
   *
   * Call after a provider's dynamic model set changes so newly added/removed
   * model IDs route correctly.
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
        if (!this.isProviderEnabled(provider.id)) continue;
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
      if (!this.isProviderEnabled(provider.id)) continue;
      models.push(...provider.listModels());
    }
    return models;
  }

  /** Build one settled picker snapshot; auth is evaluated once per provider. */
  async getModelCatalogSnapshot(request: {
    publishedByOwnerId: string;
    publishedAt?: number;
    condenseThreshold?: (modelId: string) => number | undefined;
  }): Promise<CoreModelCatalogSnapshot> {
    const models = (
      await Promise.all(
        [...this.providers.entries()].map(async ([providerId, provider]) => {
          if (!this.isProviderEnabled(providerId)) return [];
          const authenticated = await provider.isAuthenticated();
          const authAction = authenticated
            ? undefined
            : provider.getCatalogAuthAction?.();
          const readiness = authenticated
            ? ({ status: "ready" } as const)
            : authAction
              ? ({
                  status: "credentials_required",
                  action: authAction,
                } as const)
              : ({ status: "credentials_required" } as const);
          return provider.listModels().map(
            (model): CoreModelCatalogEntry => ({
              id: model.id,
              displayName: model.displayName,
              providerId: model.provider,
              providerDisplayName: model.providerDisplayName,
              supportsToolUse:
                model.supportsToolUse ?? model.capabilities.supportsToolUse,
              supportsImages:
                model.supportsImages ?? model.capabilities.supportsImages,
              contextWindow: model.capabilities.contextWindow,
              maxInputTokens: model.capabilities.maxInputTokens,
              maxOutputTokens: model.capabilities.maxOutputTokens,
              reasoningEfforts: model.capabilities.reasoningEfforts,
              defaultReasoningEffort: model.capabilities.defaultReasoningEffort,
              authenticated,
              readiness,
              condenseThreshold: request.condenseThreshold?.(model.id),
            }),
          );
        }),
      )
    ).flat();
    return {
      models,
      publishedByOwnerId: request.publishedByOwnerId,
      publishedAt: request.publishedAt ?? Date.now(),
    };
  }

  /**
   * Async — calls provider.isAuthenticated() for each registered provider.
   */
  async getAuthStatus(): Promise<Record<string, boolean>> {
    const entries = await Promise.all(
      Array.from(this.providers.entries()).map(async ([id, p]) => {
        if (!this.isProviderEnabled(id)) return [id, false] as const;
        const authed = await p.isAuthenticated();
        return [id, authed] as const;
      }),
    );
    return Object.fromEntries(entries);
  }
}

/** Singleton registry used by the agent runtime. */
export const providerRegistry = new ProviderRegistry();
