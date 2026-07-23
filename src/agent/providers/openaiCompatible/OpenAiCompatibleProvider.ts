import type {
  CompleteRequest,
  CompleteResult,
  ModelCapabilities,
  ModelInfo,
  ModelProvider,
  ProviderStreamEvent,
  StreamRequest,
} from "../types.js";
import {
  completeOpenAiCompatibleCompletion,
  streamOpenAiCompatibleCompletion,
} from "../../../core/model/providers/openaiCompatible/completionFacade.js";

import type { NormalizedOpenAiCompatibleConnection } from "./config.js";
import type { OpenAiCompatibleFetch } from "../../../core/model/providers/openaiCompatible/types.js";
import { getOpenAiCompatibleSecretKey } from "../../openAiCompatibleSecrets.js";

export interface OpenAiCompatibleSecretResolver {
  get(authKey: string): Thenable<string | undefined>;
}

export interface OpenAiCompatibleProviderOptions {
  connection: NormalizedOpenAiCompatibleConnection;
  secrets: OpenAiCompatibleSecretResolver;
  fetch?: OpenAiCompatibleFetch;
}

export class OpenAiCompatibleProvider implements ModelProvider {
  readonly id: string;
  readonly displayName: string;
  readonly condenseModel: string;

  private readonly connection: NormalizedOpenAiCompatibleConnection;
  private readonly secrets: OpenAiCompatibleSecretResolver;
  private readonly fetch?: OpenAiCompatibleFetch;
  private readonly modelsById: ReadonlyMap<
    string,
    NormalizedOpenAiCompatibleConnection["models"][number]
  >;

  constructor(options: OpenAiCompatibleProviderOptions) {
    this.connection = options.connection;
    this.secrets = options.secrets;
    this.fetch = options.fetch;
    this.id = options.connection.providerId;
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

  async isAuthenticated(): Promise<boolean> {
    if (!this.authKey) return true;
    return Boolean(
      await this.secrets.get(getOpenAiCompatibleSecretKey(this.authKey)),
    );
  }

  getAuxiliaryModel(activeModel: string): string {
    if (this.connection.auxiliaryModel) return this.connection.auxiliaryModel;
    return this.modelsById.has(activeModel) ? activeModel : this.condenseModel;
  }

  getCapabilities(model: string): ModelCapabilities {
    const configured = this.modelsById.get(model);
    if (!configured) {
      throw new Error(`Unknown model "${model}" for provider "${this.id}"`);
    }
    return { ...configured.capabilities };
  }

  listModels(): ModelInfo[] {
    return this.connection.models.map((model) => ({
      id: model.id,
      displayName: model.displayName,
      provider: this.id,
      providerDisplayName: this.displayName,
      supportsToolUse: model.capabilities.supportsToolUse,
      supportsImages: model.capabilities.supportsImages,
      capabilities: { ...model.capabilities },
    }));
  }

  async *stream(request: StreamRequest): AsyncGenerator<ProviderStreamEvent> {
    this.getCapabilities(request.model);
    const apiKey = await this.resolveApiKey();
    yield* streamOpenAiCompatibleCompletion({
      profile: this.runtimeProfile,
      apiKey,
      request,
      fetch: this.fetch,
    });
  }

  async complete(request: CompleteRequest): Promise<CompleteResult> {
    this.getCapabilities(request.model);
    const apiKey = await this.resolveApiKey();
    return await completeOpenAiCompatibleCompletion({
      profile: this.runtimeProfile,
      apiKey,
      request,
      fetch: this.fetch,
    });
  }

  private async resolveApiKey(): Promise<string | undefined> {
    if (!this.authKey) return undefined;
    const value = await this.secrets.get(
      getOpenAiCompatibleSecretKey(this.authKey),
    );
    return value?.trim() || undefined;
  }
}
