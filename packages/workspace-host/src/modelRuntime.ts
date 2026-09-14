import {
  CoreModelBackendRegistry,
  DefaultCoreModelRuntime,
  createCodexProvider,
  createOpenAICompatibleProvider,
  createOpenAIProvider,
  type AgentModelReference,
  type AgentPrincipal,
  type CodexCredentialProvider,
  type CoreModelBackend,
  type CoreModelCapabilities,
  type CoreModelCompleteOperationRequest,
  type CoreModelCompleteResult,
  type CoreModelRuntime,
  type CoreModelStreamEvent,
  type CoreModelStreamOperationRequest,
  type CreateOpenAiCompatibleProviderOptions,
} from "@agentlink/core";

export interface WorkspaceOpenAiProviderConfig {
  readonly type: "openai";
  readonly id?: string;
  readonly displayName?: string;
  readonly modelIds: readonly string[];
  readonly resolveApiKey: () =>
    | string
    | undefined
    | Promise<string | undefined>;
}

export interface WorkspaceCodexProviderConfig {
  readonly type: "codex";
  readonly id?: string;
  readonly displayName?: string;
  readonly modelIds: readonly string[];
  readonly credentialProvider: CodexCredentialProvider<{
    principal: AgentPrincipal;
    authContext: undefined;
  }>;
}

export interface WorkspaceCompatibleProviderConfig extends Omit<
  CreateOpenAiCompatibleProviderOptions,
  "apiKey"
> {
  readonly type: "openai-compatible";
  readonly resolveApiKey?: () =>
    | string
    | undefined
    | Promise<string | undefined>;
}

export type WorkspaceProviderConfig =
  | WorkspaceOpenAiProviderConfig
  | WorkspaceCodexProviderConfig
  | WorkspaceCompatibleProviderConfig;

export interface WorkspaceModelRequestLimits {
  /** Absolute encoded request ceiling before the model-specific token envelope. */
  readonly maxInputBytes?: number;
  readonly maxOutputBytes?: number;
  readonly maxRetries?: number;
  /** Conservative upper bound: one UTF-8 byte is treated as one token. */
  readonly inputSafetyTokens?: number;
}

export class WorkspaceContextLimitError extends Error {
  readonly code = "workspace_context_limit_exceeded";

  constructor(
    readonly inputBytes: number,
    readonly maxInputTokens: number,
    readonly model: AgentModelReference,
  ) {
    super(
      `Conversation needs at most ${inputBytes.toLocaleString()} conservative input tokens, but ${model.providerId}/${model.modelId} allows ${maxInputTokens.toLocaleString()}. Start a fresh session.`,
    );
    this.name = "WorkspaceContextLimitError";
  }
}

export function createWorkspaceModelRuntime(options: {
  readonly ownerId: string;
  readonly providers: readonly WorkspaceProviderConfig[];
  readonly limits?: WorkspaceModelRequestLimits;
}): CoreModelRuntime {
  if (options.providers.length === 0) {
    throw new Error("At least one workspace model provider is required");
  }
  const registry = new CoreModelBackendRegistry();
  for (const provider of options.providers)
    registry.register(createProvider(provider));
  const runtime = new DefaultCoreModelRuntime(registry, {
    ownerId: options.ownerId,
  });
  return new BoundedWorkspaceModelRuntime(runtime, options.limits);
}

class BoundedWorkspaceModelRuntime implements CoreModelRuntime {
  constructor(
    private readonly runtime: CoreModelRuntime,
    private readonly limits: WorkspaceModelRequestLimits = {},
  ) {}

  listCatalog: CoreModelRuntime["listCatalog"] = async (request) =>
    await this.runtime.listCatalog(request);

  refreshCatalog: CoreModelRuntime["refreshCatalog"] = async (request) =>
    await this.runtime.refreshCatalog(request);

  resolveModel: CoreModelRuntime["resolveModel"] = (request) =>
    this.runtime.resolveModel(request);

  tryResolveModel: CoreModelRuntime["tryResolveModel"] = (request) =>
    this.runtime.tryResolveModel(request);

  getCapabilities: CoreModelRuntime["getCapabilities"] = (request) =>
    this.runtime.getCapabilities(request);

  getAuthStatus: CoreModelRuntime["getAuthStatus"] = async (request) =>
    await this.runtime.getAuthStatus(request);

  async *stream(
    operation: CoreModelStreamOperationRequest,
  ): AsyncGenerator<CoreModelStreamEvent> {
    const controls = this.executionControls(operation);
    yield* this.runtime.stream({
      ...operation,
      request: { ...operation.request, executionControls: controls },
    });
  }

  async complete(
    operation: CoreModelCompleteOperationRequest,
  ): Promise<CoreModelCompleteResult> {
    const controls = this.executionControls(operation);
    return await this.runtime.complete({
      ...operation,
      request: { ...operation.request, executionControls: controls },
    });
  }

  private executionControls(
    operation:
      | CoreModelStreamOperationRequest
      | CoreModelCompleteOperationRequest,
  ) {
    const resolved = this.runtime.resolveModel({
      principal: operation.principal,
      authContext: operation.authContext,
      model: operation.model,
    });
    const existing = operation.request.executionControls;
    const assertWithinLimits = (attempt: { model: string }) => {
      assertRequestWithinLimits(
        operation,
        resolved.reference,
        resolved.capabilities,
        this.limits,
      );
      existing?.beforeModelDispatch(attempt);
    };
    return {
      maxRetries: minimumLimit(this.limits.maxRetries, existing?.maxRetries, 0),
      maxOutputBytes: minimumLimit(
        this.limits.maxOutputBytes,
        existing?.maxOutputBytes,
        1024 * 1024,
      ),
      beforeModelDispatch: assertWithinLimits,
    };
  }
}

function createProvider(config: WorkspaceProviderConfig): CoreModelBackend {
  if (config.type === "codex") {
    return createCodexProvider({
      credentialProvider: config.credentialProvider,
      id: config.id,
      displayName: config.displayName,
      modelIds: config.modelIds,
    });
  }
  if (config.type === "openai") {
    return createOpenAIProvider({
      apiKey: config.resolveApiKey,
      id: config.id,
      displayName: config.displayName,
      modelIds: config.modelIds,
    });
  }
  const { type: _type, resolveApiKey, ...options } = config;
  return createOpenAICompatibleProvider({
    ...options,
    ...(options.noAuth ? {} : { apiKey: resolveApiKey }),
  });
}

function minimumLimit(
  hostLimit: number | undefined,
  requestLimit: number | undefined,
  fallback: number,
): number {
  if (hostLimit === undefined) return requestLimit ?? fallback;
  if (requestLimit === undefined) return hostLimit;
  return Math.min(hostLimit, requestLimit);
}

function assertRequestWithinLimits(
  operation:
    | CoreModelStreamOperationRequest
    | CoreModelCompleteOperationRequest,
  model: AgentModelReference,
  capabilities: CoreModelCapabilities,
  limits: WorkspaceModelRequestLimits,
): void {
  const inputBytes = Buffer.byteLength(
    JSON.stringify({
      systemPrompt: operation.request.systemPrompt,
      messages: operation.request.messages,
      tools: "tools" in operation.request ? operation.request.tools : undefined,
      hostedTools:
        "hostedTools" in operation.request
          ? operation.request.hostedTools
          : undefined,
    }),
  );
  const absoluteByteLimit = limits.maxInputBytes ?? 8 * 1024 * 1024;
  const modelInputLimit =
    (capabilities.maxInputTokens ??
      capabilities.contextWindow - operation.request.maxTokens) -
    (limits.inputSafetyTokens ?? 1024);
  if (modelInputLimit <= 0) {
    throw new Error(
      `Model ${model.providerId}/${model.modelId} has no usable input capacity after reserving output and safety tokens`,
    );
  }
  if (inputBytes > absoluteByteLimit || inputBytes > modelInputLimit) {
    throw new WorkspaceContextLimitError(
      inputBytes,
      Math.min(absoluteByteLimit, modelInputLimit),
      model,
    );
  }
}
