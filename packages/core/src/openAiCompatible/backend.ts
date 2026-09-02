import type {
  CoreModelBackend,
  CoreModelCapabilities,
  CoreModelCompleteRequest,
  CoreModelCompleteResult,
  CoreModelCredentialResolver,
  CoreModelProviderAuthStatus,
  CoreModelRequestContext,
  CoreModelStreamEvent,
  CoreModelStreamRequest,
} from "../modelRuntime.js";
import {
  completeOpenAiCompatibleCompletion,
  streamOpenAiCompatibleCompletion,
} from "./completionFacade.js";

import type { AgentPrincipal } from "../modelIdentity.js";
import type { CoreModelCatalogEntry } from "@agentlink/protocol/model-catalog";
import type { NormalizedOpenAiCompatibleConnection } from "./config.js";
import type { OpenAiCompatibleFetch } from "./types.js";
import { OpenAiCompatibleRequestError } from "./errors.js";

export interface OpenAiCompatibleBackendOptions {
  connection: NormalizedOpenAiCompatibleConnection;
  credentialResolver?: CoreModelCredentialResolver;
  /** Required scope binding when a constructor resolver is supplied. */
  credentialPrincipal?: AgentPrincipal;
  fetch?: OpenAiCompatibleFetch;
}

export class OpenAiCompatibleBackend implements CoreModelBackend {
  readonly providerId: string;
  readonly displayName: string;
  readonly condenseModel: string;

  private readonly connection: NormalizedOpenAiCompatibleConnection;
  private readonly credentialResolver?: CoreModelCredentialResolver;
  private readonly credentialPrincipal?: AgentPrincipal;
  private readonly fetch?: OpenAiCompatibleFetch;
  private readonly modelsById: ReadonlyMap<
    string,
    NormalizedOpenAiCompatibleConnection["models"][number]
  >;

  constructor(options: OpenAiCompatibleBackendOptions) {
    this.connection = options.connection;
    if (options.credentialResolver && !options.credentialPrincipal) {
      throw new Error(
        "OpenAI-compatible constructor credentials require a bound principal",
      );
    }
    this.credentialResolver = options.credentialResolver;
    this.credentialPrincipal = options.credentialPrincipal;
    this.fetch = options.fetch;
    this.providerId = options.connection.providerId;
    this.displayName = options.connection.displayName;
    this.condenseModel =
      options.connection.auxiliaryModel ?? options.connection.models[0]!.id;
    this.modelsById = new Map(
      options.connection.models.map((model) => [model.id, model]),
    );
  }

  get runtimeProfile() {
    return this.connection.runtimeProfile;
  }

  get authKey(): string | undefined {
    return this.connection.authKey;
  }

  getAuxiliaryModel(activeModel: string): string {
    if (this.connection.auxiliaryModel) return this.connection.auxiliaryModel;
    return this.modelsById.has(activeModel) ? activeModel : this.condenseModel;
  }

  getModelFamily(modelId: string): "anthropic" | "openai" | undefined {
    return this.modelsById.get(modelId)?.modelFamily;
  }

  getCapabilities(modelId: string): CoreModelCapabilities {
    const configured = this.modelsById.get(modelId);
    if (!configured) {
      throw new Error(
        `Unknown model "${modelId}" for provider "${this.providerId}"`,
      );
    }
    return { ...configured.capabilities };
  }

  listModels(): CoreModelCatalogEntry[] {
    return this.catalogEntries(!this.runtimeProfile.authRequired);
  }

  async listAvailableModels(
    request: CoreModelRequestContext,
    authStatus?: CoreModelProviderAuthStatus,
  ): Promise<CoreModelCatalogEntry[]> {
    const status = authStatus ?? (await this.getAuthStatus(request));
    return this.catalogEntries(status.authenticated);
  }

  private catalogEntries(authenticated: boolean): CoreModelCatalogEntry[] {
    return this.connection.models.map((model) => ({
      id: model.id,
      displayName: model.displayName,
      providerId: this.providerId,
      providerDisplayName: this.displayName,
      supportsToolUse: model.capabilities.supportsToolUse,
      supportsImages: model.capabilities.supportsImages,
      contextWindow: model.capabilities.contextWindow,
      ...(model.capabilities.maxInputTokens !== undefined
        ? { maxInputTokens: model.capabilities.maxInputTokens }
        : {}),
      ...(model.capabilities.maxOutputTokens !== undefined
        ? { maxOutputTokens: model.capabilities.maxOutputTokens }
        : {}),
      ...(model.capabilities.reasoningEfforts
        ? { reasoningEfforts: [...model.capabilities.reasoningEfforts] }
        : {}),
      ...(model.capabilities.defaultReasoningEffort
        ? {
            defaultReasoningEffort: model.capabilities.defaultReasoningEffort,
          }
        : {}),
      authenticated,
    }));
  }

  async getAuthStatus(
    request: CoreModelRequestContext,
  ): Promise<CoreModelProviderAuthStatus> {
    if (!this.runtimeProfile.authRequired) {
      return { authenticated: true, authSource: "host" };
    }
    const resolver = this.resolveCredentialResolver(request);
    if (!resolver) {
      return {
        authenticated: false,
        authSource: "unavailable",
        unavailableReason:
          "OpenAI-compatible credential resolver is unavailable",
      };
    }
    const credential = await resolver.resolveCredential({
      principal: request.principal,
      providerId: this.providerId,
      modelId: this.condenseModel,
      purpose: "authStatus",
    });
    return credential
      ? { authenticated: true, authSource: "host" }
      : {
          authenticated: false,
          authSource: "unavailable",
          unavailableReason: "OpenAI-compatible API key is unavailable",
          authAction: { kind: "api_key", providerId: this.providerId },
        };
  }

  async *stream(
    request: CoreModelStreamRequest,
    context: CoreModelRequestContext,
  ): AsyncGenerator<CoreModelStreamEvent> {
    this.getCapabilities(request.model);
    const apiKey = await this.resolveApiKey(request.model, "stream", context);
    yield* streamOpenAiCompatibleCompletion({
      profile: this.runtimeProfile,
      apiKey,
      request,
      fetch: this.fetch,
    });
  }

  async complete(
    request: CoreModelCompleteRequest,
    context: CoreModelRequestContext,
  ): Promise<CoreModelCompleteResult> {
    this.getCapabilities(request.model);
    const apiKey = await this.resolveApiKey(request.model, "complete", context);
    return await completeOpenAiCompatibleCompletion({
      profile: this.runtimeProfile,
      apiKey,
      request,
      fetch: this.fetch,
    });
  }

  private resolveCredentialResolver(
    context: CoreModelRequestContext,
  ): CoreModelCredentialResolver | undefined {
    if (context.authContext?.credentialResolver) {
      return context.authContext.credentialResolver;
    }
    return samePrincipal(context.principal, this.credentialPrincipal)
      ? this.credentialResolver
      : undefined;
  }

  private async resolveApiKey(
    modelId: string,
    purpose: "stream" | "complete",
    context: CoreModelRequestContext,
  ): Promise<string | undefined> {
    if (!this.runtimeProfile.authRequired) return undefined;
    const resolver = this.resolveCredentialResolver(context);
    const credential = await resolver?.resolveCredential({
      principal: context.principal,
      providerId: this.providerId,
      modelId,
      purpose,
    });
    const secret = credential?.secret.trim();
    if (!secret) {
      throw new OpenAiCompatibleRequestError({
        message: "OpenAI-compatible API key is required for this connection",
        providerCode: "auth_required",
        retryable: false,
        authentication: true,
      });
    }
    return secret;
  }
}

function samePrincipal(
  left: AgentPrincipal,
  right: AgentPrincipal | undefined,
): boolean {
  return Boolean(
    right &&
    left.tenantId === right.tenantId &&
    left.subjectId === right.subjectId,
  );
}
