export interface CliCompatibleModel {
  readonly id: string;
  readonly model?: string;
  readonly displayName?: string;
  readonly contextWindow: number;
  readonly maxInputTokens?: number;
  readonly maxOutputTokens: number;
  readonly supportsToolUse: boolean;
  readonly supportsThinking?: boolean;
}

export interface CliCompatibleProvider {
  readonly id: string;
  readonly displayName?: string;
  readonly baseURL: string;
  readonly profile?: "generic" | "openrouter";
  readonly noAuth?: boolean;
  readonly allowInsecureHttp?: boolean;
  readonly models: readonly CliCompatibleModel[];
}

export interface CliConfig {
  readonly schemaVersion: 1;
  readonly defaultModel: {
    readonly providerId: string;
    readonly modelId: string;
  };
  readonly openAiModels: readonly string[];
  readonly codexModels: readonly string[];
  readonly compatibleProviders: readonly CliCompatibleProvider[];
}
