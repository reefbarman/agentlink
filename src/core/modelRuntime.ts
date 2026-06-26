import type {
  CoreModelAuthMethod,
  CoreModelAuthProvider,
} from "./modelAuth.js";
import type {
  CoreModelCatalogEntry,
  CoreModelCatalogSnapshot,
  CoreReasoningEffort,
} from "./modelCatalog.js";

export type CoreModelContentBlock =
  | CoreModelTextBlock
  | CoreModelThinkingBlock
  | CoreModelToolUseBlock
  | CoreModelToolResultBlock
  | CoreModelImageBlock
  | CoreModelDocumentBlock;

export interface CoreModelTextBlock {
  type: "text";
  text: string;
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

export interface CoreModelRequestBase {
  model: string;
  systemPrompt: string;
  messages: CoreModelMessage[];
  maxTokens: number;
  reasoningEffort?: CoreReasoningEffort;
  cache?: CoreModelCacheOptions;
  state?: CoreModelStateOptions;
  providerHints?: CoreModelProviderHints;
  signal?: AbortSignal;
}

export interface CoreModelStreamRequest extends CoreModelRequestBase {
  tools?: CoreModelToolDefinition[];
  thinking?: { budgetTokens: number };
}

export interface CoreModelCompleteRequest extends CoreModelRequestBase {
  temperature?: number;
}

export interface CoreModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

export interface CoreModelCompleteResult {
  text: string;
  usage?: CoreModelUsage;
  providerResponseId?: string;
}

export type CoreModelStreamEvent =
  | { type: "thinking_start"; thinkingId: string }
  | { type: "thinking_delta"; thinkingId: string; text: string }
  | { type: "thinking_end"; thinkingId: string }
  | { type: "text_delta"; text: string }
  | { type: "tool_start"; toolCallId: string; toolName: string }
  | { type: "tool_input_delta"; toolCallId: string; partialJson: string }
  | {
      type: "tool_done";
      toolCallId: string;
      toolName: string;
      input: unknown;
    }
  | { type: "content_blocks"; blocks: CoreModelContentBlock[] }
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
  let providerResponseId: string | undefined;

  for await (const event of events) {
    if (event.type === "text_delta") {
      text += event.text;
    } else if (event.type === "usage") {
      inputTokens = event.inputTokens;
      outputTokens = event.outputTokens;
      cacheReadTokens = event.cacheReadTokens ?? 0;
      cacheCreationTokens = event.cacheCreationTokens ?? 0;
      providerResponseId = event.providerResponseId;
    }
  }

  return {
    text,
    usage: {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
    },
    providerResponseId,
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
  provider: CoreModelBackend;
  capabilities: CoreModelCapabilities;
}

export interface CoreModelBackend {
  readonly providerId: string;
  readonly displayName: string;
  /** Preferred cheap/fast model for core-owned condense flows in later phases. */
  readonly condenseModel: string;

  listModels(): CoreModelCatalogEntry[];
  /** Reserved for dynamic/account-specific catalog refresh in later phases. */
  listAvailableModels?(): Promise<CoreModelCatalogEntry[]>;
  listRoutableModelIds?(): string[];
  getCapabilities(modelId: string): CoreModelCapabilities;
  getAuthStatus?(
    context: CoreModelAuthContext,
  ): Promise<CoreModelProviderAuthStatus>;

  stream(request: CoreModelStreamRequest): AsyncGenerator<CoreModelStreamEvent>;
  complete(request: CoreModelCompleteRequest): Promise<CoreModelCompleteResult>;
}

export interface CoreModelCatalogRequest {
  ownerId?: string;
  now?: number;
}

export interface CoreModelRuntime {
  listCatalog(
    request?: CoreModelCatalogRequest,
  ): Promise<CoreModelCatalogSnapshot>;
  refreshCatalog?(): Promise<CoreModelCatalogSnapshot>;
  resolveModel(modelId: string): CoreResolvedModel;
  tryResolveModel(modelId: string): CoreResolvedModel | undefined;
  getCapabilities(modelId: string): CoreModelCapabilities | undefined;
  getAuthStatus(): Promise<Record<string, CoreModelProviderAuthStatus>>;
  stream(request: CoreModelStreamRequest): AsyncGenerator<CoreModelStreamEvent>;
  complete(request: CoreModelCompleteRequest): Promise<CoreModelCompleteResult>;
}

export interface CoreModelRuntimeOptions {
  ownerId: string;
  authContext?: CoreModelAuthContext;
  now?: () => number;
}

export class CoreModelBackendRegistry {
  private readonly providers = new Map<string, CoreModelBackend>();
  private readonly modelIndex = new Map<string, string>();

  register(provider: CoreModelBackend): void {
    if (this.providers.has(provider.providerId)) {
      throw new Error(`Duplicate model provider "${provider.providerId}"`);
    }
    this.providers.set(provider.providerId, provider);
    this.rebuildIndex();
  }

  refreshIndex(): void {
    this.rebuildIndex();
  }

  resolveModel(modelId: string): CoreResolvedModel {
    const resolved = this.tryResolveModel(modelId);
    if (resolved) return resolved;
    const available = this.listModels()
      .map((model) => model.id)
      .join(", ");
    throw new Error(
      `Unknown model "${modelId}". Available models: ${available || "(none)"}`,
    );
  }

  tryResolveModel(modelId: string): CoreResolvedModel | undefined {
    const providerId = this.modelIndex.get(modelId);
    if (!providerId) return undefined;
    const provider = this.providers.get(providerId);
    if (!provider) return undefined;
    return {
      modelId,
      providerId,
      provider,
      capabilities: provider.getCapabilities(modelId),
    };
  }

  getCapabilities(modelId: string): CoreModelCapabilities | undefined {
    return this.tryResolveModel(modelId)?.capabilities;
  }

  listModels(): CoreModelCatalogEntry[] {
    const models: CoreModelCatalogEntry[] = [];
    for (const provider of this.providers.values()) {
      models.push(...provider.listModels());
    }
    return models;
  }

  async listCatalog(request: {
    ownerId: string;
    now: number;
  }): Promise<CoreModelCatalogSnapshot> {
    return {
      models: this.listModels(),
      publishedByOwnerId: request.ownerId,
      publishedAt: request.now,
    };
  }

  async getAuthStatus(
    context: CoreModelAuthContext = {},
  ): Promise<Record<string, CoreModelProviderAuthStatus>> {
    const entries = await Promise.all(
      Array.from(this.providers.values()).map(async (provider) => {
        const status = provider.getAuthStatus
          ? await provider.getAuthStatus(context)
          : inferAuthStatusFromModels(provider.listModels());
        return [provider.providerId, status] as const;
      }),
    );
    return Object.fromEntries(entries);
  }

  private rebuildIndex(): void {
    this.modelIndex.clear();
    for (const provider of this.providers.values()) {
      for (const model of provider.listModels()) {
        const existingProviderId = this.modelIndex.get(model.id);
        if (existingProviderId && existingProviderId !== provider.providerId) {
          throw new Error(
            `Duplicate model "${model.id}" registered by providers "${existingProviderId}" and "${provider.providerId}"`,
          );
        }
        this.modelIndex.set(model.id, provider.providerId);
      }
      for (const modelId of provider.listRoutableModelIds?.() ?? []) {
        if (!this.modelIndex.has(modelId)) {
          this.modelIndex.set(modelId, provider.providerId);
        }
      }
    }
  }
}

export class DefaultCoreModelRuntime implements CoreModelRuntime {
  constructor(
    private readonly registry: CoreModelBackendRegistry,
    private readonly options: CoreModelRuntimeOptions,
  ) {}

  async listCatalog(
    request: CoreModelCatalogRequest = {},
  ): Promise<CoreModelCatalogSnapshot> {
    return await this.registry.listCatalog({
      ownerId: request.ownerId ?? this.options.ownerId,
      now: request.now ?? this.options.now?.() ?? Date.now(),
    });
  }

  async refreshCatalog(): Promise<CoreModelCatalogSnapshot> {
    this.registry.refreshIndex();
    return await this.listCatalog();
  }

  resolveModel(modelId: string): CoreResolvedModel {
    return this.registry.resolveModel(modelId);
  }

  tryResolveModel(modelId: string): CoreResolvedModel | undefined {
    return this.registry.tryResolveModel(modelId);
  }

  getCapabilities(modelId: string): CoreModelCapabilities | undefined {
    return this.registry.getCapabilities(modelId);
  }

  async getAuthStatus(): Promise<Record<string, CoreModelProviderAuthStatus>> {
    return await this.registry.getAuthStatus(this.options.authContext);
  }

  stream(
    request: CoreModelStreamRequest,
  ): AsyncGenerator<CoreModelStreamEvent> {
    return this.registry.resolveModel(request.model).provider.stream(request);
  }

  async complete(
    request: CoreModelCompleteRequest,
  ): Promise<CoreModelCompleteResult> {
    return await this.registry
      .resolveModel(request.model)
      .provider.complete(request);
  }
}

function inferAuthStatusFromModels(
  models: CoreModelCatalogEntry[],
): CoreModelProviderAuthStatus {
  return models.some((model) => model.authenticated)
    ? { authenticated: true, authSource: "host" }
    : { authenticated: false, authSource: "unavailable" };
}
