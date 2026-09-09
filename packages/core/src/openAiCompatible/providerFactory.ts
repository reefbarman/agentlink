import type { AgentPrincipal } from "../modelIdentity.js";
import type {
  CoreModelBackend,
  CoreModelCredentialResolver,
  CoreResolvedModelCredential,
} from "../modelRuntime.js";
import { OpenAiCompatibleBackend } from "./backend.js";
import {
  normalizeOpenAiCompatibleConnections,
  type OpenAiCompatibleConnectionDto,
  type OpenAiCompatibleModelDto,
} from "./config.js";
import type {
  OpenAiCompatibleFetch,
  OpenAiCompatibleModelFamily,
  OpenAiCompatibleProfileKind,
  OpenAiCompatibleReasoningEffortMode,
} from "./types.js";

export type OpenAiCompatibleApiKey =
  | string
  | (() => string | undefined | Promise<string | undefined>)
  | ((request: {
      principal: AgentPrincipal;
      providerId: string;
      modelId: string;
    }) => string | undefined | Promise<string | undefined>);

export interface OpenAiCompatibleProviderModel {
  id: string;
  model?: string;
  displayName?: string;
  contextWindow: number;
  maxInputTokens?: number;
  maxOutputTokens: number;
  supportsToolUse: boolean;
  supportsThinking?: boolean;
  reasoningEfforts?: OpenAiCompatibleModelDto["reasoningEfforts"];
  defaultReasoningEffort?: OpenAiCompatibleModelDto["defaultReasoningEffort"];
  supportsImages?: boolean;
  structuredOutput?: "json_schema";
  modelFamily?: OpenAiCompatibleModelFamily;
}

export interface CreateOpenAiCompatibleProviderOptions {
  id: string;
  displayName?: string;
  baseURL: string;
  apiKey?: OpenAiCompatibleApiKey;
  noAuth?: boolean;
  profile?: OpenAiCompatibleProfileKind;
  reasoningEffortMode?: OpenAiCompatibleReasoningEffortMode;
  timeoutMs?: number;
  headers?: Record<string, string>;
  allowInsecureHttp?: boolean;
  auxiliaryModel?: string;
  supportsStoreFalse?: boolean;
  models: OpenAiCompatibleProviderModel[];
  fetch?: OpenAiCompatibleFetch;
}

/**
 * Creates a server-only backend for an OpenAI Chat Completions compatible API.
 * The factory performs validation only and never performs network access.
 */
export function createOpenAICompatibleProvider(
  options: CreateOpenAiCompatibleProviderOptions,
): CoreModelBackend {
  if (Boolean(options.apiKey) === Boolean(options.noAuth)) {
    throw new Error(
      "OpenAI-compatible providers require exactly one of apiKey or noAuth: true",
    );
  }
  const dto: OpenAiCompatibleConnectionDto = {
    id: options.id,
    displayName: options.displayName ?? options.id,
    baseUrl: options.baseURL,
    profile: options.profile ?? "generic",
    reasoningEffortMode: options.reasoningEffortMode,
    authKey: options.apiKey ? "factory-api-key" : undefined,
    timeoutMs: options.timeoutMs,
    headers: options.headers,
    allowInsecureHttp: options.allowInsecureHttp,
    auxiliaryModel: options.auxiliaryModel,
    supportsStoreFalse: options.supportsStoreFalse,
    models: options.models.map((model) => ({
      id: model.id,
      model: model.model ?? model.id,
      displayName: model.displayName ?? model.id,
      contextWindow: model.contextWindow,
      maxInputTokens: model.maxInputTokens,
      maxOutputTokens: model.maxOutputTokens,
      supportsToolUse: model.supportsToolUse,
      supportsThinking: model.supportsThinking,
      reasoningEfforts: model.reasoningEfforts,
      defaultReasoningEffort: model.defaultReasoningEffort,
      supportsImages: model.supportsImages,
      structuredOutput: model.structuredOutput,
      modelFamily: model.modelFamily,
    })),
  };
  const normalized = normalizeOpenAiCompatibleConnections([dto]);
  if (normalized.issues.length > 0 || normalized.connections.length !== 1) {
    throw new Error(
      `Invalid OpenAI-compatible provider: ${normalized.issues
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  const connection = normalized.connections[0]!;
  const providerId = options.id;
  const requestControls = {
    maxRetries: true,
    beforeModelDispatch: true,
    maxOutputBytes: true,
  } as const;
  const models = connection.models.map((model) => ({
    ...model,
    capabilities: {
      ...model.capabilities,
      supportsTemperature: true as const,
      supportsMaxOutputTokens: true as const,
      requestControls,
      completionEvidence: "authoritative" as const,
    },
  }));
  const configured = {
    ...connection,
    providerId,
    models,
    runtimeProfile: {
      ...connection.runtimeProfile,
      providerId,
      models: Object.fromEntries(
        models.map((model) => [
          model.id,
          {
            id: model.id,
            model: model.model,
            ...(model.modelFamily ? { modelFamily: model.modelFamily } : {}),
            capabilities: model.capabilities,
          },
        ]),
      ),
    },
  };
  return new OpenAiCompatibleBackend({
    connection: configured,
    ...(options.apiKey
      ? { defaultCredentialResolver: apiKeyResolver(options.apiKey) }
      : {}),
    fetch: options.fetch,
  });
}

function apiKeyResolver(
  apiKey: OpenAiCompatibleApiKey,
): CoreModelCredentialResolver {
  return {
    async resolveCredential(
      request,
    ): Promise<CoreResolvedModelCredential | null> {
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
              principal: request.principal,
              providerId: request.providerId,
              modelId: request.modelId,
            });
      const secret = value?.trim();
      return secret
        ? {
            providerId: request.providerId,
            method: "apiKey",
            secret,
          }
        : null;
    },
  };
}
