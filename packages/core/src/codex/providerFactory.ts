import { createHash, randomUUID } from "node:crypto";

import type { CoreModelCatalogEntry } from "@agentlink/protocol/model-catalog";

import type { AgentPrincipal } from "../modelIdentity.js";
import {
  collectCoreModelCompleteResult,
  CoreModelAttemptLimitError,
  type CoreModelAuthContext,
  type CoreModelBackend,
  type CoreModelCapabilities,
  type CoreModelCompleteRequest,
  type CoreModelCompleteResult,
  type CoreModelCredentialResolver,
  type CoreModelProviderAuthStatus,
  type CoreModelRequestContext,
  type CoreModelStreamEvent,
  type CoreModelStreamRequest,
  type CoreResolvedModelCredential,
} from "../modelRuntime.js";
import {
  CodexCredentialSession,
  type CodexCredentialProvider,
  type CodexResolvedAuth,
} from "./credentialResolution.js";
import {
  buildCodexContextWindowExceededError,
  createCodexRequestError,
  getCodexErrorHandlingAction,
  toCodexRequestError,
} from "./errors.js";
import {
  CODEX_CONDENSE_MODEL,
  CODEX_MODEL_MAP,
  getCodexModelCapabilities,
  getEndpointCaps,
  isCodexModelServedOnChatgptBackend,
  listCodexModels,
  type CodexAuthMethod,
} from "./models.js";
import {
  createOpenAiResponsesClient,
  getCodexEndpointConfig,
  type CodexFetch,
} from "./openaiClient.js";
import { executeCodexResponsesStream } from "./responsesStream.js";
import {
  buildCodexResolvedRequestBody,
  translateCodexMessages,
  translateCodexTools,
} from "./translation.js";

const REQUEST_CONTROLS = {
  maxRetries: true,
  beforeModelDispatch: true,
  maxOutputBytes: true,
} as const;

export type OpenAIResponsesApiKey =
  | string
  | (() => string | undefined | Promise<string | undefined>)
  | ((request: {
      principal: AgentPrincipal;
      providerId: string;
      modelId: string;
    }) => string | undefined | Promise<string | undefined>);

export interface CreateOpenAIProviderOptions {
  apiKey: OpenAIResponsesApiKey;
  id?: string;
  displayName?: string;
  modelIds?: readonly string[];
  fetch?: CodexFetch;
}

export interface CodexProviderCredentialContext<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> {
  principal: TPrincipal;
  authContext: CoreModelAuthContext | undefined;
}

export interface CreateCodexProviderOptions<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> {
  credentialProvider: CodexCredentialProvider<
    CodexProviderCredentialContext<TPrincipal>
  >;
  id?: string;
  displayName?: string;
  modelIds?: readonly string[];
  maxOAuthRefreshAttempts?: number;
  fetch?: CodexFetch;
}

interface ResponsesProviderOptions<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> {
  providerId: string;
  displayName: string;
  authMethod: CodexAuthMethod;
  modelIds: readonly string[];
  credentialProvider: CodexCredentialProvider<
    CodexProviderCredentialContext<TPrincipal>
  >;
  maxOAuthRefreshAttempts?: number;
  fetch?: CodexFetch;
}

/** Creates a standalone OpenAI Responses API backend using API-key credentials. */
export function createOpenAIProvider(
  options: CreateOpenAIProviderOptions,
): CoreModelBackend {
  const providerId = options.id?.trim() || "openai";
  return new ResponsesModelBackend({
    providerId,
    displayName: options.displayName?.trim() || "OpenAI API",
    authMethod: "apiKey",
    modelIds: resolveModelIds(options.modelIds, "apiKey"),
    credentialProvider: apiKeyCredentialProvider(providerId, options.apiKey),
    fetch: options.fetch,
  });
}

/** Creates a standalone ChatGPT/Codex Responses backend using host-owned OAuth credentials. */
export function createCodexProvider<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
>(options: CreateCodexProviderOptions<TPrincipal>): CoreModelBackend {
  return new ResponsesModelBackend({
    providerId: options.id?.trim() || "codex",
    displayName: options.displayName?.trim() || "OpenAI Codex",
    authMethod: "oauth",
    modelIds: resolveModelIds(options.modelIds, "oauth"),
    credentialProvider: options.credentialProvider,
    maxOAuthRefreshAttempts: options.maxOAuthRefreshAttempts,
    fetch: options.fetch,
  });
}

export const createCodexOAuthProvider = createCodexProvider;

class ResponsesModelBackend<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> implements CoreModelBackend {
  readonly providerId: string;
  readonly displayName: string;
  readonly condenseModel: string;

  private readonly authMethod: CodexAuthMethod;
  private readonly modelIds: readonly string[];
  private readonly credentialProvider: CodexCredentialProvider<
    CodexProviderCredentialContext<TPrincipal>
  >;
  private readonly maxOAuthRefreshAttempts?: number;
  private readonly fetch?: CodexFetch;

  constructor(options: ResponsesProviderOptions<TPrincipal>) {
    this.providerId = options.providerId;
    this.displayName = options.displayName;
    this.authMethod = options.authMethod;
    this.modelIds = options.modelIds;
    this.credentialProvider = options.credentialProvider;
    this.maxOAuthRefreshAttempts = options.maxOAuthRefreshAttempts;
    this.fetch = options.fetch;
    this.condenseModel = this.modelIds.includes(CODEX_CONDENSE_MODEL)
      ? CODEX_CONDENSE_MODEL
      : this.modelIds[0]!;
  }

  listModels(): CoreModelCatalogEntry[] {
    return this.catalogEntries(false);
  }

  async listAvailableModels(
    request: CoreModelRequestContext,
    authStatus?: CoreModelProviderAuthStatus,
  ): Promise<CoreModelCatalogEntry[]> {
    const status = authStatus ?? (await this.getAuthStatus(request));
    return this.catalogEntries(status.authenticated);
  }

  listRoutableModelIds(): string[] {
    return [...this.modelIds];
  }

  getCapabilities(modelId: string): CoreModelCapabilities {
    this.assertKnownModel(modelId);
    const base = getCodexModelCapabilities(modelId, this.authMethod);
    const endpoint = getEndpointCaps({ method: this.authMethod });
    return {
      ...base,
      ...(endpoint.supportsStructuredOutput
        ? { structuredOutput: "json_schema" as const }
        : {}),
      ...(endpoint.supportsMaxOutputTokens
        ? { supportsMaxOutputTokens: true as const }
        : {}),
      requestControls: REQUEST_CONTROLS,
      completionEvidence: "authoritative",
    };
  }

  async getAuthStatus(
    request: CoreModelRequestContext,
  ): Promise<CoreModelProviderAuthStatus> {
    const provider = this.resolveCredentialProvider(request);
    const auth = await provider.resolveAuth({
      context: request as CodexProviderCredentialContext<TPrincipal>,
      modelId: this.condenseModel,
      purpose: "authStatus",
    });
    if (!auth || auth.method !== this.authMethod) {
      return {
        authenticated: false,
        authSource: "unavailable",
        unavailableReason:
          this.authMethod === "oauth"
            ? "Codex OAuth credentials are unavailable"
            : "OpenAI API key credentials are unavailable",
        authAction: {
          kind: this.authMethod === "oauth" ? "oauth" : "api_key",
          providerId: this.providerId,
        },
      };
    }
    return { authenticated: true, authSource: "host" };
  }

  async *stream(
    request: CoreModelStreamRequest,
    context: CoreModelRequestContext,
  ): AsyncGenerator<CoreModelStreamEvent> {
    yield* this.execute(request, context, "stream");
  }

  async complete(
    request: CoreModelCompleteRequest,
    context: CoreModelRequestContext,
  ): Promise<CoreModelCompleteResult> {
    return await collectCoreModelCompleteResult(
      this.execute(
        {
          ...request,
          tools: undefined,
          hostedTools: undefined,
          providerHints: undefined,
        },
        context,
        "complete",
      ),
    );
  }

  private async *execute(
    request: CoreModelStreamRequest,
    context: CoreModelRequestContext,
    purpose: "stream" | "complete",
  ): AsyncGenerator<CoreModelStreamEvent> {
    this.validateRequest(request);
    const credentialSession = await this.createCredentialSession(
      request.model,
      purpose,
      context,
    );
    let auth = credentialSession.auth;
    let outputStarted = false;
    let dispatches = 0;
    const maxAttempts = (request.executionControls?.maxRetries ?? 0) + 1;

    for (;;) {
      this.assertAuthMethod(auth);
      try {
        const endpoint = getCodexEndpointConfig(
          auth,
          request.providerHints?.codex?.sessionId ?? randomUUID(),
        );
        const resolved = buildCodexResolvedRequestBody({
          authMethod: auth.method,
          model: request.model,
          instructions: request.systemPrompt,
          input: translateCodexMessages(request.messages, {
            useProviderReplay: !request.state?.previousResponseId,
          }),
          maxTokens: request.maxTokens,
          state: request.state,
          cache: request.cache,
          reasoningEffort: request.reasoningEffort,
          reasoningMode: request.reasoningMode,
          outputFormat: request.outputFormat,
          tools: request.tools ? translateCodexTools(request.tools) : undefined,
          hostedTools: request.hostedTools,
        });
        const routingHint = request.providerHints?.codex;
        yield* executeCodexResponsesStream({
          client: createOpenAiResponsesClient(auth, endpoint, {
            fetch: this.fetch,
          }),
          body: resolved.body,
          authMethod: auth.method,
          routing:
            auth.method === "oauth" &&
            routingHint?.sessionId &&
            routingHint.turnState
              ? {
                  sessionId: routingHint.sessionId,
                  authIdentity: JSON.stringify([
                    auth.method,
                    auth.accountId,
                    auth.oauthAccountPoolId,
                    credentialFingerprint(auth.bearerToken),
                  ]),
                  turnState: routingHint.turnState,
                }
              : undefined,
          signal: request.signal,
          beforeModelDispatch: (attempt) => {
            dispatches += 1;
            if (dispatches > maxAttempts) {
              throw new CoreModelAttemptLimitError(maxAttempts);
            }
            request.executionControls?.beforeModelDispatch(attempt);
          },
          onProviderRequestAttempt: request.onProviderRequestAttempt,
          onTransportActivity: request.onTransportActivity,
          parserState: {
            get outputStarted() {
              return outputStarted;
            },
            set outputStarted(value: boolean) {
              outputStarted = value;
            },
          },
          parserOptions: {
            maxOutputBytes: request.executionControls?.maxOutputBytes,
            includeTerminationEvidence: Boolean(request.executionControls),
            replayProviderId:
              this.authMethod === "apiKey"
                ? "openai-responses"
                : "openai-codex",
          },
          maxRetries: Math.max(0, maxAttempts - dispatches - 1),
        });
        return;
      } catch (error) {
        if (request.signal?.aborted) throw abortError();
        if (
          error instanceof CoreModelAttemptLimitError ||
          isAgentClientError(error)
        ) {
          throw error;
        }
        const normalized = toCodexRequestError(error);
        const action = getCodexErrorHandlingAction({ auth, error: normalized });
        if (
          !outputStarted &&
          action === "refresh_oauth_auth" &&
          dispatches >= maxAttempts
        ) {
          throw new CoreModelAttemptLimitError(maxAttempts);
        }
        if (
          !outputStarted &&
          action === "refresh_oauth_auth" &&
          (await credentialSession.refreshOAuth())
        ) {
          auth = credentialSession.auth;
          continue;
        }
        if (
          !outputStarted &&
          action === "handle_oauth_usage_limit" &&
          auth.oauthAccountPoolId &&
          dispatches >= maxAttempts
        ) {
          throw new CoreModelAttemptLimitError(maxAttempts);
        }
        if (
          !outputStarted &&
          action === "handle_oauth_usage_limit" &&
          auth.oauthAccountPoolId
        ) {
          const rotation = await credentialSession.handleOAuthUsageLimit({
            allowRotation: true,
          });
          if (rotation.rotated) {
            auth = credentialSession.auth;
            continue;
          }
          throw credentialSession.buildUsageLimitExhaustedError(normalized);
        }
        if (action === "throw_context_window_exceeded") {
          throw createCodexRequestError(
            buildCodexContextWindowExceededError(normalized),
          );
        }
        throw normalized;
      }
    }
  }

  private validateRequest(
    request: CoreModelStreamRequest | CoreModelCompleteRequest,
  ): void {
    const capabilities = this.getCapabilities(request.model);
    if (request.temperature !== undefined) {
      throw createCodexRequestError({
        message:
          "Responses backend does not support temperature for this model",
        code: "unsupported_capability",
        retryable: false,
      });
    }
    if (request.outputFormat && !capabilities.structuredOutput) {
      throw createCodexRequestError({
        message:
          "The selected Responses endpoint does not support native structured output",
        code: "unsupported_capability",
        retryable: false,
      });
    }
    if (request.executionControls && !capabilities.requestControls) {
      throw createCodexRequestError({
        message: "The selected Responses endpoint lacks request controls",
        code: "unsupported_capability",
        retryable: false,
      });
    }
  }

  private async createCredentialSession(
    modelId: string,
    purpose: "stream" | "complete",
    context: CoreModelRequestContext,
  ): Promise<
    CodexCredentialSession<CodexProviderCredentialContext<TPrincipal>>
  > {
    return await CodexCredentialSession.create({
      provider: this.resolveCredentialProvider(context),
      request: {
        context: context as CodexProviderCredentialContext<TPrincipal>,
        modelId,
        purpose,
      },
      maxOAuthRefreshAttempts: this.maxOAuthRefreshAttempts,
    });
  }

  private resolveCredentialProvider(
    context: CoreModelRequestContext,
  ): CodexCredentialProvider<CodexProviderCredentialContext<TPrincipal>> {
    if (context.authContext?.credentialResolver) {
      return coreCredentialProvider(
        context.authContext.credentialResolver,
        this.providerId,
      );
    }
    if (context.authContext?.authProvider) {
      throw createCodexRequestError({
        message:
          "Responses providers do not accept model-auth leases; use a request-scoped credentialResolver",
        code: "unsupported_capability",
        retryable: false,
      });
    }
    return this.credentialProvider;
  }

  private catalogEntries(authenticated: boolean): CoreModelCatalogEntry[] {
    const entries = new Map(
      listCodexModels(this.providerId, this.authMethod).map((entry) => [
        entry.id,
        entry,
      ]),
    );
    return this.modelIds.map((modelId) => {
      const entry = entries.get(modelId)!;
      const capabilities = this.getCapabilities(modelId);
      return {
        id: modelId,
        displayName: entry.displayName,
        providerId: this.providerId,
        providerDisplayName: this.displayName,
        supportsToolUse: capabilities.supportsToolUse,
        supportsImages: capabilities.supportsImages,
        contextWindow: capabilities.contextWindow,
        maxInputTokens: capabilities.maxInputTokens,
        maxOutputTokens: capabilities.maxOutputTokens,
        reasoningEfforts: capabilities.reasoningEfforts,
        defaultReasoningEffort: capabilities.defaultReasoningEffort,
        authenticated,
      };
    });
  }

  private assertKnownModel(modelId: string): void {
    if (!this.modelIds.includes(modelId)) {
      throw new Error(
        `Unknown model "${modelId}" for provider "${this.providerId}"`,
      );
    }
  }

  private assertAuthMethod(auth: CodexResolvedAuth): void {
    if (auth.method !== this.authMethod) {
      throw createCodexRequestError({
        message:
          this.authMethod === "oauth"
            ? "Codex backend requires OAuth credentials"
            : "OpenAI API backend requires API-key credentials",
        code: "auth_method_mismatch",
        retryable: false,
      });
    }
  }
}

function resolveModelIds(
  requested: readonly string[] | undefined,
  authMethod: CodexAuthMethod,
): string[] {
  const defaults = listCodexModels("responses", authMethod).map(
    (model) => model.id,
  );
  const modelIds = requested ? [...requested] : defaults;
  if (modelIds.length === 0)
    throw new Error("Responses provider models cannot be empty");
  const unique = new Set<string>();
  for (const modelId of modelIds) {
    if (!CODEX_MODEL_MAP.has(modelId)) {
      throw new Error(`Unknown maintained OpenAI model "${modelId}"`);
    }
    if (
      authMethod === "oauth" &&
      !isCodexModelServedOnChatgptBackend(modelId)
    ) {
      throw new Error(
        `Model "${modelId}" is not served by the ChatGPT/Codex OAuth endpoint`,
      );
    }
    if (authMethod === "apiKey" && !defaults.includes(modelId)) {
      throw new Error(`Model "${modelId}" is not available on the OpenAI API`);
    }
    if (unique.has(modelId))
      throw new Error(`Duplicate Responses model "${modelId}"`);
    unique.add(modelId);
  }
  return [...unique];
}

function apiKeyCredentialProvider(
  providerId: string,
  apiKey: OpenAIResponsesApiKey,
): CodexCredentialProvider<CodexProviderCredentialContext> {
  return {
    async resolveAuth({ context, modelId }) {
      const value =
        typeof apiKey === "string"
          ? apiKey
          : await (
              apiKey as (request: {
                principal: AgentPrincipal;
                providerId: string;
                modelId: string;
              }) => string | undefined | Promise<string | undefined>
            )({
              principal: context.principal,
              providerId,
              modelId,
            });
      const bearerToken = value?.trim();
      return bearerToken
        ? { method: "apiKey", bearerToken, canRefresh: false }
        : null;
    },
  };
}

function coreCredentialProvider<TPrincipal extends AgentPrincipal>(
  resolver: CoreModelCredentialResolver,
  providerId: string,
): CodexCredentialProvider<CodexProviderCredentialContext<TPrincipal>> {
  return {
    async resolveAuth({ context, modelId, purpose }) {
      if (purpose === "nativeWeb") return null;
      const credential = await resolver.resolveCredential({
        principal: context.principal,
        providerId,
        modelId,
        purpose,
      });
      return toCodexAuth(credential, providerId);
    },
  };
}

function toCodexAuth(
  credential: CoreResolvedModelCredential | null,
  providerId: string,
): CodexResolvedAuth | null {
  if (!credential?.secret.trim() || credential.providerId !== providerId) {
    return null;
  }
  return {
    method: credential.method,
    bearerToken: credential.secret.trim(),
    accountId: credential.accountId,
    canRefresh: credential.canRefresh === true,
    ...(credential.method === "oauth" && credential.accountId
      ? { oauthAccountPoolId: credential.accountId }
      : {}),
  };
}

function credentialFingerprint(secret: string): string {
  return createHash("sha256").update(secret).digest("hex").slice(0, 16);
}

function isAgentClientError(error: unknown): error is Error {
  return error instanceof Error && error.name === "AgentClientError";
}

function abortError(): Error {
  const error = new Error("Responses request aborted");
  error.name = "AbortError";
  return error;
}
