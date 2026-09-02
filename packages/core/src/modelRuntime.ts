import type { AgentModelReference, AgentPrincipal } from "./modelIdentity.js";
import type {
  CoreHostedToolDefinition,
  CoreHostedWebCapabilities,
} from "@agentlink/protocol/web-access-policy";
import type {
  CoreModelCatalogAuthAction,
  CoreModelCatalogEntry,
  CoreModelCatalogSnapshot,
  CoreReasoningEffort,
} from "@agentlink/protocol/model-catalog";
import type {
  CoreWebActivity,
  CoreWebCitation,
} from "@agentlink/protocol/web-activity";

import type { CoreModelAuthMethod } from "@agentlink/protocol/model-auth";
import type { CoreModelAuthProvider } from "./modelAuthProvider.js";
import type { CoreProviderReplayEnvelope } from "@agentlink/protocol/provider-replay";

export type CoreModelContentBlock =
  | CoreModelTextBlock
  | CoreModelThinkingBlock
  | CoreModelToolUseBlock
  | CoreModelToolResultBlock
  | CoreModelImageBlock
  | CoreModelDocumentBlock
  | CoreModelWebActivityBlock;

export interface CoreModelTextBlock {
  type: "text";
  text: string;
  citations?: CoreWebCitation[];
  cache_control?: { type: "ephemeral" };
}

export interface CoreModelThinkingBlock {
  type: "thinking";
  thinking: string;
  signature: string;
}

export interface CoreModelToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface CoreModelToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string | CoreModelContentBlock[];
  is_error?: boolean;
}

export interface CoreModelWebActivityBlock {
  type: "web_activity";
  activity: CoreWebActivity;
}

export type CoreModelImageMediaType =
  | "image/jpeg"
  | "image/png"
  | "image/gif"
  | "image/webp";

export type CoreModelDocumentMediaType =
  | "application/pdf"
  | "text/plain"
  | "text/markdown"
  | "text/csv"
  | "application/json";

const CORE_MODEL_SUPPORTED_IMAGE_TYPES = new Set<CoreModelImageMediaType>([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

const CORE_MODEL_MIME_ALIASES: Record<string, CoreModelImageMediaType> = {
  "image/jpg": "image/jpeg",
  "image/x-png": "image/png",
};

const CORE_MODEL_SUPPORTED_DOCUMENT_TYPES = new Set<CoreModelDocumentMediaType>(
  [
    "application/pdf",
    "text/plain",
    "text/markdown",
    "text/csv",
    "application/json",
  ],
);

export function toCoreModelImageMediaType(
  mimeType: string,
): CoreModelImageMediaType | null {
  if (
    CORE_MODEL_SUPPORTED_IMAGE_TYPES.has(mimeType as CoreModelImageMediaType)
  ) {
    return mimeType as CoreModelImageMediaType;
  }
  return CORE_MODEL_MIME_ALIASES[mimeType] ?? null;
}

export function toCoreModelDocumentMediaType(
  mimeType: string,
): CoreModelDocumentMediaType | null {
  if (
    CORE_MODEL_SUPPORTED_DOCUMENT_TYPES.has(
      mimeType as CoreModelDocumentMediaType,
    )
  ) {
    return mimeType as CoreModelDocumentMediaType;
  }
  return null;
}

export interface CoreModelImageBlock {
  type: "image";
  source: {
    type: "base64";
    media_type: CoreModelImageMediaType;
    data: string;
  };
}

export interface CoreModelDocumentBlock {
  type: "document";
  source: {
    type: "base64";
    media_type: CoreModelDocumentMediaType;
    data: string;
  };
  title?: string;
}

export interface CoreModelMessage {
  role: "user" | "assistant";
  content: string | CoreModelContentBlock[];
  /** Provider-private data decoded only by the provider that created it. */
  providerReplay?: CoreProviderReplayEnvelope;
}

export type CoreModelJsonSchema = {
  type: string;
  properties?: Record<string, unknown>;
  required?: string[];
  description?: string;
  [key: string]: unknown;
};

export interface CoreModelToolDefinition {
  name: string;
  description: string;
  input_schema: CoreModelJsonSchema;
  cache_control?: { type: "ephemeral" };
}

export interface CoreModelCapabilities {
  supportsThinking: boolean;
  supportsCaching: boolean;
  supportsImages: boolean;
  supportsToolUse: boolean;
  hostedWeb?: CoreHostedWebCapabilities;
  contextWindow: number;
  maxInputTokens?: number;
  maxOutputTokens: number;
  reasoningEfforts?: CoreReasoningEffort[];
  defaultReasoningEffort?: CoreReasoningEffort;
}

export interface CoreModelCacheOptions {
  key?: string;
  retention?: "in_memory" | "24h";
}

export interface CoreModelStateOptions {
  previousResponseId?: string;
  store?: boolean;
}

export interface CoreModelProviderHints {
  codex?: {
    sessionId?: string;
  };
}

export interface CoreModelTransportActivity {
  kind: "headers" | "body" | "provider_event";
  at: number;
  bytes?: number;
}

/** A physical provider transport request, emitted immediately before dispatch. */
export interface CoreModelProviderRequestAttempt {
  /** Effective wire model for this attempt, after provider-local fallback. */
  model: string;
}

export interface CoreModelRequestBase {
  model: string;
  systemPrompt: string;
  messages: CoreModelMessage[];
  maxTokens: number;
  reasoningEffort?: CoreReasoningEffort;
  reasoningMode?: "standard" | "pro";
  cache?: CoreModelCacheOptions;
  state?: CoreModelStateOptions;
  providerHints?: CoreModelProviderHints;
  signal?: AbortSignal;
  /**
   * Physical request-attempt hook. Providers invoke this immediately before
   * every outbound model request, including retries and terminal failures.
   */
  onProviderRequestAttempt?: (attempt: CoreModelProviderRequestAttempt) => void;
  /**
   * Provider/transport liveness hook. This is deliberately below the semantic
   * stream-event layer so metadata, heartbeats, and body chunks keep long
   * model requests alive even when no user-visible output is produced.
   */
  onTransportActivity?: (activity: CoreModelTransportActivity) => void;
}

export interface CoreModelStreamRequest extends CoreModelRequestBase {
  /** Client-dispatched function tools. */
  tools?: CoreModelToolDefinition[];
  /** Provider-executed tools; never dispatched by the local tool runtime. */
  hostedTools?: CoreHostedToolDefinition[];
  thinking?: { budgetTokens: number };
}

export interface CoreModelCompleteRequest extends CoreModelRequestBase {
  temperature?: number;
}

export interface CoreModelServerToolUsage {
  webSearchRequests?: number;
  webFetchRequests?: number;
}

export interface CoreModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  /** True only when the provider reported enough detail to partition fresh and cached input. */
  inputTokenBreakdownReported?: boolean;
  serverToolUsage?: CoreModelServerToolUsage;
  /** True when usage was estimated locally because the provider omitted it. */
  estimated?: boolean;
}

export interface CoreModelCompleteResult {
  text: string;
  usage?: CoreModelUsage;
  providerResponseId?: string;
  assistantMessage?: CoreModelMessage;
  stopReason?: CoreModelStopReason;
}

export type CoreModelStopReason =
  | "end_turn"
  | "tool_use"
  | "pause_turn"
  | "max_tokens"
  | "refusal";

export type CoreModelStreamEvent =
  | {
      type: "model_fallback";
      requestedModel: string;
      effectiveModel: string;
    }
  | { type: "thinking_start"; thinkingId: string }
  | { type: "thinking_delta"; thinkingId: string; text: string }
  | { type: "thinking_end"; thinkingId: string }
  | { type: "text_delta"; text: string }
  | { type: "web_activity"; activity: CoreWebActivity }
  | { type: "tool_start"; toolCallId: string; toolName: string }
  | { type: "tool_input_delta"; toolCallId: string; partialJson: string }
  | {
      type: "tool_done";
      toolCallId: string;
      toolName: string;
      input: unknown;
    }
  | { type: "content_blocks"; blocks: CoreModelContentBlock[] }
  | {
      type: "model_stop";
      reason: CoreModelStopReason;
      assistantMessage: CoreModelMessage;
    }
  | ({ type: "usage" } & CoreModelUsage & { providerResponseId?: string })
  | { type: "done" };

export async function collectCoreModelCompleteResult(
  events: AsyncIterable<CoreModelStreamEvent>,
): Promise<CoreModelCompleteResult> {
  let text = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let inputTokenBreakdownReported: boolean | undefined;
  let serverToolUsage: CoreModelServerToolUsage | undefined;
  let estimated: boolean | undefined;
  let providerResponseId: string | undefined;
  let assistantMessage: CoreModelMessage | undefined;
  let stopReason: CoreModelStopReason | undefined;

  for await (const event of events) {
    if (event.type === "text_delta") {
      text += event.text;
    } else if (event.type === "usage") {
      inputTokens = event.inputTokens;
      outputTokens = event.outputTokens;
      cacheReadTokens = event.cacheReadTokens ?? 0;
      cacheCreationTokens = event.cacheCreationTokens ?? 0;
      inputTokenBreakdownReported = event.inputTokenBreakdownReported;
      serverToolUsage = event.serverToolUsage;
      estimated = event.estimated;
      providerResponseId = event.providerResponseId;
    } else if (event.type === "model_stop") {
      assistantMessage = event.assistantMessage;
      stopReason = event.reason;
    }
  }

  return {
    text,
    usage: {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      ...(inputTokenBreakdownReported !== undefined
        ? { inputTokenBreakdownReported }
        : {}),
      ...(serverToolUsage ? { serverToolUsage } : {}),
      ...(estimated !== undefined ? { estimated } : {}),
    },
    providerResponseId,
    ...(assistantMessage ? { assistantMessage } : {}),
    ...(stopReason ? { stopReason } : {}),
  };
}

export type CoreModelProviderAuthStatus =
  | {
      authenticated: true;
      authSource: "host" | "lease" | "cachedCredential";
    }
  | {
      authenticated: false;
      authSource: "unavailable";
      unavailableReason?: string;
      authAction?: CoreModelCatalogAuthAction;
    };

/** Host-owned credential material resolved server-side for provider backends. */
export interface CoreResolvedModelCredential {
  providerId: string;
  method: CoreModelAuthMethod;
  secret: string;
  accountId?: string;
  auditId?: string;
  expiresAt?: number;
  canRefresh?: boolean;
}

export interface CoreModelCredentialResolver {
  resolveCredential(request: {
    principal: AgentPrincipal;
    providerId: string;
    modelId: string;
    purpose: "stream" | "complete" | "catalog" | "authStatus";
  }): Promise<CoreResolvedModelCredential | null>;
}

export interface CoreModelAuthContext {
  authProvider?: CoreModelAuthProvider;
  /** Provider backends use this in later phases to resolve host-owned secrets. */
  credentialResolver?: CoreModelCredentialResolver;
}

export interface CoreResolvedModel {
  modelId: string;
  providerId: string;
  reference: AgentModelReference;
  provider: CoreModelBackend;
  capabilities: CoreModelCapabilities;
}

export interface CoreModelRequestContext {
  principal: AgentPrincipal;
  authContext: CoreModelAuthContext | undefined;
}

export interface CoreModelBackend {
  readonly providerId: string;
  readonly displayName: string;
  /** Preferred cheap/fast model for core-owned condense flows in later phases. */
  readonly condenseModel: string;

  listModels(): CoreModelCatalogEntry[];
  listAvailableModels?(
    request: CoreModelRequestContext,
    authStatus?: CoreModelProviderAuthStatus,
  ): Promise<CoreModelCatalogEntry[]>;
  listRoutableModelIds?(): string[];
  getCapabilities(modelId: string): CoreModelCapabilities;
  getAuthStatus?(
    request: CoreModelRequestContext,
  ): Promise<CoreModelProviderAuthStatus>;

  stream(
    request: CoreModelStreamRequest,
    context: CoreModelRequestContext,
  ): AsyncGenerator<CoreModelStreamEvent>;
  complete(
    request: CoreModelCompleteRequest,
    context: CoreModelRequestContext,
  ): Promise<CoreModelCompleteResult>;
}

export interface CoreQualifiedModelCatalogEntry extends CoreModelCatalogEntry {
  ref: AgentModelReference;
}

export interface CoreQualifiedModelCatalogSnapshot extends Omit<
  CoreModelCatalogSnapshot,
  "models"
> {
  models: CoreQualifiedModelCatalogEntry[];
}

export interface CoreModelCatalogRequest extends CoreModelRequestContext {
  ownerId?: string;
  now?: number;
}

export interface CoreModelLookupRequest extends CoreModelRequestContext {
  model: AgentModelReference | string;
}

export type CoreModelAuthStatusRequest = CoreModelRequestContext;

export interface CoreModelStreamOperationRequest extends CoreModelRequestContext {
  model: AgentModelReference | string;
  request: Omit<CoreModelStreamRequest, "model">;
}

export interface CoreModelCompleteOperationRequest extends CoreModelRequestContext {
  model: AgentModelReference | string;
  request: Omit<CoreModelCompleteRequest, "model">;
}

export interface CoreModelRuntime {
  listCatalog(
    request: CoreModelCatalogRequest,
  ): Promise<CoreQualifiedModelCatalogSnapshot>;
  refreshCatalog(
    request: CoreModelCatalogRequest,
  ): Promise<CoreQualifiedModelCatalogSnapshot>;
  resolveModel(request: CoreModelLookupRequest): CoreResolvedModel;
  tryResolveModel(
    request: CoreModelLookupRequest,
  ): CoreResolvedModel | undefined;
  getCapabilities(
    request: CoreModelLookupRequest,
  ): CoreModelCapabilities | undefined;
  getAuthStatus(
    request: CoreModelAuthStatusRequest,
  ): Promise<Record<string, CoreModelProviderAuthStatus>>;
  stream(
    request: CoreModelStreamOperationRequest,
  ): AsyncGenerator<CoreModelStreamEvent>;
  complete(
    request: CoreModelCompleteOperationRequest,
  ): Promise<CoreModelCompleteResult>;
}

export interface CoreModelRuntimeOptions {
  ownerId: string;
  now?: () => number;
}

interface CoreModelRoutingIndex {
  qualified: Map<string, AgentModelReference>;
  legacy: Map<string, AgentModelReference | null>;
}

export class CoreModelBackendRegistry {
  private readonly providers = new Map<string, CoreModelBackend>();
  private staticRoutingIndex: CoreModelRoutingIndex = {
    qualified: new Map(),
    legacy: new Map(),
  };
  private readonly principalRoutingIndexes = new Map<
    string,
    CoreModelRoutingIndex
  >();

  register(provider: CoreModelBackend): void {
    if (this.providers.has(provider.providerId)) {
      throw new Error(`Duplicate model provider "${provider.providerId}"`);
    }
    validateProviderCatalogEntries(provider, provider.listModels());
    this.providers.set(provider.providerId, provider);
    this.rebuildIndex();
  }

  refreshIndex(): void {
    this.rebuildIndex();
  }

  resolveModel(
    model: AgentModelReference | string,
    principal?: AgentPrincipal,
  ): CoreResolvedModel {
    const index = this.routingIndexFor(principal);
    const resolved = this.tryResolveModel(model, principal);
    if (resolved) return resolved;
    if (typeof model === "string" && index.legacy.get(model) === null) {
      throw new Error(
        `Ambiguous legacy model "${model}". Use a provider-qualified model reference.`,
      );
    }
    const displayModel = formatModelReference(model);
    const available = this.listModels()
      .map((entry) => formatModelReference(toModelReference(entry)))
      .join(", ");
    throw new Error(
      `Unknown model "${displayModel}". Available models: ${available || "(none)"}`,
    );
  }

  tryResolveModel(
    model: AgentModelReference | string,
    principal?: AgentPrincipal,
  ): CoreResolvedModel | undefined {
    const index = this.routingIndexFor(principal);
    const reference =
      typeof model === "string"
        ? index.legacy.get(model)
        : index.qualified.get(modelReferenceKey(model));
    if (!reference) return undefined;
    const provider = this.providers.get(reference.providerId);
    if (!provider) return undefined;
    try {
      return {
        modelId: reference.modelId,
        providerId: reference.providerId,
        reference,
        provider,
        capabilities: provider.getCapabilities(reference.modelId),
      };
    } catch {
      return undefined;
    }
  }

  getCapabilities(
    model: AgentModelReference | string,
    principal?: AgentPrincipal,
  ): CoreModelCapabilities | undefined {
    return this.tryResolveModel(model, principal)?.capabilities;
  }

  listModels(): CoreModelCatalogEntry[] {
    const models: CoreModelCatalogEntry[] = [];
    for (const provider of this.providers.values()) {
      models.push(
        ...validateProviderCatalogEntries(provider, provider.listModels()),
      );
    }
    return models;
  }

  async listCatalog(
    request: CoreModelCatalogRequest & { ownerId: string; now: number },
  ): Promise<CoreQualifiedModelCatalogSnapshot> {
    const models = await this.loadAvailableModels(request);
    return {
      models: qualifyCatalogEntries(models),
      publishedByOwnerId: request.ownerId,
      publishedAt: request.now,
    };
  }

  async refreshCatalog(
    request: CoreModelCatalogRequest & { ownerId: string; now: number },
  ): Promise<CoreQualifiedModelCatalogSnapshot> {
    const models = await this.loadAvailableModels(request);
    this.principalRoutingIndexes.set(
      principalScopeKey(request.principal),
      this.buildRoutingIndex(models),
    );
    return {
      models: qualifyCatalogEntries(models),
      publishedByOwnerId: request.ownerId,
      publishedAt: request.now,
    };
  }

  async getAuthStatus(
    request: CoreModelAuthStatusRequest,
  ): Promise<Record<string, CoreModelProviderAuthStatus>> {
    const entries = await Promise.all(
      Array.from(this.providers.values()).map(async (provider) => {
        const status = provider.getAuthStatus
          ? await provider.getAuthStatus(request)
          : inferAuthStatusFromModels(provider.listModels());
        return [provider.providerId, status] as const;
      }),
    );
    return Object.fromEntries(entries);
  }

  private async loadAvailableModels(
    request: CoreModelRequestContext,
  ): Promise<CoreModelCatalogEntry[]> {
    const context: CoreModelRequestContext = {
      principal: request.principal,
      authContext: request.authContext,
    };
    return (
      await Promise.all(
        [...this.providers.values()].map(async (provider) => {
          const authStatus = provider.getAuthStatus
            ? await provider.getAuthStatus(context)
            : inferAuthStatusFromModels(provider.listModels());
          const models = validateProviderCatalogEntries(
            provider,
            provider.listAvailableModels
              ? await provider.listAvailableModels(context, authStatus)
              : provider.listModels(),
          );
          return models.map((model) =>
            applyProviderAuthStatus(model, authStatus),
          );
        }),
      )
    ).flat();
  }

  private rebuildIndex(): void {
    this.staticRoutingIndex = this.buildRoutingIndex(this.listModels());
    this.principalRoutingIndexes.clear();
  }

  private buildRoutingIndex(
    models: CoreModelCatalogEntry[],
  ): CoreModelRoutingIndex {
    const qualified = new Map<string, AgentModelReference>();
    const legacy = new Map<string, AgentModelReference | null>();
    const registerReference = (reference: AgentModelReference): void => {
      qualified.set(modelReferenceKey(reference), reference);
      const hasExisting = legacy.has(reference.modelId);
      const existing = legacy.get(reference.modelId);
      legacy.set(
        reference.modelId,
        hasExisting &&
          (existing === null ||
            existing === undefined ||
            existing.providerId !== reference.providerId)
          ? null
          : reference,
      );
    };

    for (const model of models) registerReference(toModelReference(model));
    for (const provider of this.providers.values()) {
      const routableModelIds =
        provider.listRoutableModelIds?.() ??
        provider.listModels().map((model) => model.id);
      for (const modelId of routableModelIds) {
        registerReference({ providerId: provider.providerId, modelId });
      }
    }
    return { qualified, legacy };
  }

  private routingIndexFor(principal?: AgentPrincipal): CoreModelRoutingIndex {
    return principal
      ? (this.principalRoutingIndexes.get(principalScopeKey(principal)) ??
          this.staticRoutingIndex)
      : this.staticRoutingIndex;
  }
}

export class DefaultCoreModelRuntime implements CoreModelRuntime {
  constructor(
    private readonly registry: CoreModelBackendRegistry,
    private readonly options: CoreModelRuntimeOptions,
  ) {}

  async listCatalog(
    request: CoreModelCatalogRequest,
  ): Promise<CoreQualifiedModelCatalogSnapshot> {
    return await this.registry.listCatalog({
      ...request,
      ownerId: request.ownerId ?? this.options.ownerId,
      now: request.now ?? this.options.now?.() ?? Date.now(),
    });
  }

  async refreshCatalog(
    request: CoreModelCatalogRequest,
  ): Promise<CoreQualifiedModelCatalogSnapshot> {
    return await this.registry.refreshCatalog({
      ...request,
      ownerId: request.ownerId ?? this.options.ownerId,
      now: request.now ?? this.options.now?.() ?? Date.now(),
    });
  }

  resolveModel(request: CoreModelLookupRequest): CoreResolvedModel {
    return this.registry.resolveModel(request.model, request.principal);
  }

  tryResolveModel(
    request: CoreModelLookupRequest,
  ): CoreResolvedModel | undefined {
    return this.registry.tryResolveModel(request.model, request.principal);
  }

  getCapabilities(
    request: CoreModelLookupRequest,
  ): CoreModelCapabilities | undefined {
    return this.registry.getCapabilities(request.model, request.principal);
  }

  async getAuthStatus(
    request: CoreModelAuthStatusRequest,
  ): Promise<Record<string, CoreModelProviderAuthStatus>> {
    return await this.registry.getAuthStatus(request);
  }

  async *stream(
    operation: CoreModelStreamOperationRequest,
  ): AsyncGenerator<CoreModelStreamEvent> {
    const resolved = this.registry.resolveModel(
      operation.model,
      operation.principal,
    );
    const context: CoreModelRequestContext = {
      principal: operation.principal,
      authContext: operation.authContext,
    };
    yield* resolved.provider.stream(
      { ...operation.request, model: resolved.modelId },
      context,
    );
  }

  async complete(
    operation: CoreModelCompleteOperationRequest,
  ): Promise<CoreModelCompleteResult> {
    const resolved = this.registry.resolveModel(
      operation.model,
      operation.principal,
    );
    const context: CoreModelRequestContext = {
      principal: operation.principal,
      authContext: operation.authContext,
    };
    return await resolved.provider.complete(
      { ...operation.request, model: resolved.modelId },
      context,
    );
  }
}

function principalScopeKey(principal: AgentPrincipal): string {
  return JSON.stringify([principal.tenantId, principal.subjectId]);
}

function validateProviderCatalogEntries(
  provider: CoreModelBackend,
  entries: CoreModelCatalogEntry[],
): CoreModelCatalogEntry[] {
  for (const entry of entries) {
    if (entry.providerId !== provider.providerId) {
      throw new Error(
        `Model "${entry.id}" declared provider "${entry.providerId}" but was returned by "${provider.providerId}"`,
      );
    }
  }
  return entries;
}

function qualifyCatalogEntries(
  entries: CoreModelCatalogEntry[],
): CoreQualifiedModelCatalogEntry[] {
  return entries.map((entry) => ({ ...entry, ref: toModelReference(entry) }));
}

function modelReferenceKey(reference: AgentModelReference): string {
  return JSON.stringify([reference.providerId, reference.modelId]);
}

function toModelReference(entry: CoreModelCatalogEntry): AgentModelReference {
  return { providerId: entry.providerId, modelId: entry.id };
}

function formatModelReference(reference: AgentModelReference | string): string {
  return typeof reference === "string"
    ? reference
    : `${reference.providerId}/${reference.modelId}`;
}

function applyProviderAuthStatus(
  model: CoreModelCatalogEntry,
  status: CoreModelProviderAuthStatus,
): CoreModelCatalogEntry {
  if (model.readiness) {
    return {
      ...model,
      authenticated: model.readiness.status === "ready",
    };
  }
  if (status.authenticated) {
    return { ...model, authenticated: true, readiness: { status: "ready" } };
  }
  return status.authAction
    ? {
        ...model,
        authenticated: false,
        readiness: {
          status: "credentials_required",
          action: status.authAction,
          reason: status.unavailableReason,
        },
      }
    : {
        ...model,
        authenticated: false,
        readiness: {
          status: "unavailable",
          reason: status.unavailableReason,
        },
      };
}

function inferAuthStatusFromModels(
  models: CoreModelCatalogEntry[],
): CoreModelProviderAuthStatus {
  return {
    authenticated: false,
    authSource: "unavailable",
    unavailableReason: models.length
      ? "Provider does not expose request-scoped auth status"
      : "Provider has no registered models",
  };
}
