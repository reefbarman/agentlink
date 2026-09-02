/**
 * Compatibility barrel for the legacy agent provider surface.
 *
 * Provider-neutral model DTOs are now owned by `src/core/modelRuntime.ts`.
 * Keep these legacy names while the agent/session/provider call sites migrate to
 * the core-owned model runtime boundary.
 */

import type {
  CoreModelCacheOptions,
  CoreModelCapabilities,
  CoreModelCompleteRequest,
  CoreModelCompleteResult,
  CoreModelContentBlock,
  CoreModelDocumentBlock,
  CoreModelImageBlock,
  CoreModelImageMediaType,
  CoreModelJsonSchema,
  CoreModelMessage,
  CoreModelStateOptions,
  CoreModelStreamEvent,
  CoreModelStreamRequest,
  CoreModelTextBlock,
  CoreModelThinkingBlock,
  CoreModelToolDefinition,
  CoreModelToolResultBlock,
  CoreModelToolUseBlock,
} from "@agentlink/core/model-runtime";
import type {
  CoreModelCatalogAuthAction,
  CoreReasoningEffort,
} from "@agentlink/protocol/model-catalog";

import type { CoreWebAccessSettings } from "@agentlink/protocol/web-access-policy";
import type { CoreWebToolKind } from "@agentlink/protocol/web-activity";
import { toCoreModelImageMediaType } from "@agentlink/core/model-runtime";

export type ContentBlock = CoreModelContentBlock;
export type TextBlock = CoreModelTextBlock;
export type ThinkingBlock = CoreModelThinkingBlock;
export type ToolUseBlock = CoreModelToolUseBlock;
export type ToolResultBlock = CoreModelToolResultBlock;
export type ImageBlock = CoreModelImageBlock;
export type DocumentBlock = CoreModelDocumentBlock;
export type MessageParam = CoreModelMessage;
export type ToolDefinition = CoreModelToolDefinition;
export type JsonSchema = CoreModelJsonSchema;
export type ProviderCacheOptions = CoreModelCacheOptions;
export type ProviderStateOptions = CoreModelStateOptions;
export type ReasoningEffort = CoreReasoningEffort;
export type StreamRequest = CoreModelStreamRequest;
export type CompleteRequest = CoreModelCompleteRequest;
export type CompleteResult = CoreModelCompleteResult;
export type ProviderStreamEvent = CoreModelStreamEvent;
export type ModelCapabilities = CoreModelCapabilities;

/** MIME types accepted by model providers for image content. */
export type ImageMediaType = CoreModelImageMediaType;

/** Legacy name for the core-owned image MIME normalizer. */
export const toSupportedImageMediaType = toCoreModelImageMediaType;

// ── Legacy provider interface ──

export interface ModelProvider {
  readonly id: string;
  readonly displayName: string;
  /** The preferred cheap/fast model to use for context condensing. */
  readonly condenseModel: string;
  /**
   * Resolve the helper model for an active model. Multi-model connection
   * providers use this to keep auxiliary requests on the same connection.
   */
  getAuxiliaryModel?(activeModel: string): string;

  /** Async — checks stored credentials, may trigger refresh. */
  isAuthenticated(): Promise<boolean>;

  /** Truthful host action that can supply this provider's missing credentials. */
  getCatalogAuthAction?(): CoreModelCatalogAuthAction | undefined;

  getCapabilities(model: string): ModelCapabilities;

  /**
   * Optional model-vendor behavior used for system prompt selection. This stays
   * separate from the provider ID, which owns routing, authentication, and transport.
   */
  getModelFamily?(model: string): "anthropic" | "openai" | undefined;

  /**
   * Resolve capabilities for the authenticated transport that will own the next
   * request. Providers whose capabilities do not vary by auth may omit this.
   */
  getRequestCapabilities?(model: string): Promise<ModelCapabilities>;

  /**
   * Models this provider owns. Used as source of truth for model→provider routing.
   * Returns a hardcoded superset — runtime failures (model not available for account)
   * are handled gracefully at request time, not filtered here.
   */
  listModels(): ModelInfo[];

  /**
   * Optional: check which models are actually available for the current account.
   * Called lazily after auth succeeds. Providers that don't vary by account can
   * skip this (defaults to listModels()). For Codex, this could query the API
   * to filter by entitlement — but we defer this until we hit real account-gating issues.
   */
  listAvailableModels?(): Promise<ModelInfo[]>;

  /**
   * Optional: model IDs that must remain routable even if not shown by
   * `listModels()` (e.g. a static routing floor so persisted-session models
   * resolve after a dynamic refresh). Defaults to `listModels()` ids.
   */
  listRoutableModelIds?(): string[];

  /**
   * Return the supported replacement for a retired model id previously owned
   * by this provider. Retired ids stay out of model pickers and routing indexes;
   * the registry follows these aliases only while migrating persisted state.
   */
  getModelMigration?(model: string): string | undefined;

  /** Streaming completion — the primary agentic loop interface. */
  stream(request: StreamRequest): AsyncGenerator<ProviderStreamEvent>;

  /**
   * Non-streaming completion — for MCP sampling, condensing, and any
   * one-shot inference call. Simpler contract than stream() for callers
   * that just need a final result.
   */
  complete(request: CompleteRequest): Promise<CompleteResult>;

  /**
   * Optional low-latency native web transport. Returning null asks the caller
   * to use the provider's delegated hosted-tool implementation instead.
   */
  executeNativeWebTool?(request: {
    model: string;
    kind: CoreWebToolKind;
    input: Record<string, unknown>;
    settings: CoreWebAccessSettings;
    signal?: AbortSignal;
  }): Promise<unknown | null>;
}

export interface ModelInfo {
  id: string;
  displayName: string;
  provider: string;
  providerDisplayName?: string;
  supportsToolUse?: boolean;
  supportsImages?: boolean;
  capabilities: ModelCapabilities;
}

/** Resolve a provider's helper model without breaking legacy providers. */
export function getProviderAuxiliaryModel(
  provider: ModelProvider,
  activeModel: string,
): string {
  return provider.getAuxiliaryModel?.(activeModel) ?? provider.condenseModel;
}
