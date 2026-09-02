import {
  OpenAiCompatibleBackend,
  type NormalizedOpenAiCompatibleConnection,
  type OpenAiCompatibleFetch,
} from "@agentlink/core/openai-compatible";
import type {
  CoreModelCredentialResolver,
  CoreModelRequestContext,
} from "@agentlink/core/model-runtime";

import type {
  CompleteRequest,
  CompleteResult,
  ModelCapabilities,
  ModelInfo,
  ModelProvider,
  ProviderStreamEvent,
  StreamRequest,
} from "../types.js";
import { getOpenAiCompatibleSecretKey } from "../../openAiCompatibleSecrets.js";

export interface OpenAiCompatibleSecretResolver {
  get(authKey: string): Thenable<string | undefined>;
}

export interface OpenAiCompatibleProviderOptions {
  connection: NormalizedOpenAiCompatibleConnection;
  secrets: OpenAiCompatibleSecretResolver;
  fetch?: OpenAiCompatibleFetch;
}

const EXTENSION_MODEL_PRINCIPAL = {
  tenantId: "agentlink-extension",
  subjectId: "local-user",
} as const;
const EXTENSION_MODEL_REQUEST_CONTEXT: CoreModelRequestContext = {
  principal: EXTENSION_MODEL_PRINCIPAL,
  authContext: undefined,
};

export class OpenAiCompatibleProvider implements ModelProvider {
  readonly id: string;
  readonly displayName: string;
  readonly condenseModel: string;

  private readonly connection: NormalizedOpenAiCompatibleConnection;
  private readonly secrets: OpenAiCompatibleSecretResolver;
  private readonly backend: OpenAiCompatibleBackend;

  constructor(options: OpenAiCompatibleProviderOptions) {
    this.connection = options.connection;
    this.secrets = options.secrets;
    const credentialResolver: CoreModelCredentialResolver = {
      resolveCredential: async ({ providerId }) => {
        if (providerId !== options.connection.providerId) return null;
        const authKey = options.connection.authKey;
        if (!authKey) return null;
        const secret = await options.secrets.get(
          getOpenAiCompatibleSecretKey(authKey),
        );
        const trimmed = secret?.trim();
        return trimmed
          ? {
              providerId,
              method: "apiKey",
              secret: trimmed,
            }
          : null;
      },
    };
    this.backend = new OpenAiCompatibleBackend({
      connection: options.connection,
      credentialResolver,
      credentialPrincipal: EXTENSION_MODEL_PRINCIPAL,
      fetch: options.fetch,
    });
    this.id = this.backend.providerId;
    this.displayName = this.backend.displayName;
    this.condenseModel = this.backend.condenseModel;
  }

  get runtimeProfile() {
    return this.backend.runtimeProfile;
  }

  get authKey(): string | undefined {
    return this.connection.authKey;
  }

  async isAuthenticated(): Promise<boolean> {
    if (!this.authKey) return true;
    return Boolean(
      await this.secrets.get(getOpenAiCompatibleSecretKey(this.authKey)),
    );
  }

  getCatalogAuthAction() {
    return this.authKey
      ? { kind: "api_key" as const, providerId: this.id }
      : undefined;
  }

  getAuxiliaryModel(activeModel: string): string {
    return this.backend.getAuxiliaryModel(activeModel);
  }

  getCapabilities(model: string): ModelCapabilities {
    return this.backend.getCapabilities(model);
  }

  getModelFamily(model: string): "anthropic" | "openai" | undefined {
    return this.backend.getModelFamily(model);
  }

  listModels(): ModelInfo[] {
    return this.connection.models.map(
      (model: NormalizedOpenAiCompatibleConnection["models"][number]) => ({
        id: model.id,
        displayName: model.displayName,
        provider: this.id,
        providerDisplayName: this.displayName,
        supportsToolUse: model.capabilities.supportsToolUse,
        supportsImages: model.capabilities.supportsImages,
        capabilities: { ...model.capabilities },
      }),
    );
  }

  stream(request: StreamRequest): AsyncGenerator<ProviderStreamEvent> {
    return this.backend.stream(request, EXTENSION_MODEL_REQUEST_CONTEXT);
  }

  async complete(request: CompleteRequest): Promise<CompleteResult> {
    return await this.backend.complete(
      request,
      EXTENSION_MODEL_REQUEST_CONTEXT,
    );
  }
}
