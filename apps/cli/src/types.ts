export interface CliCompatibleModel {
  readonly id: string;
  readonly model?: string;
  readonly displayName?: string;
  readonly contextWindow: number;
  readonly maxInputTokens?: number;
  readonly maxOutputTokens: number;
  readonly supportsToolUse: boolean;
  readonly supportsThinking?: boolean;
  readonly promptProfile?: import("@agentlink/protocol/prompt-profile").PromptProfile;
}

export interface CliCompatibleProvider {
  readonly id: string;
  readonly displayName?: string;
  readonly baseURL: string;
  readonly profile?: "generic" | "openrouter";
  readonly noAuth?: boolean;
  /**
   * Environment variable holding this provider's API key. Checked before the
   * OS credential store, for hosts without one.
   */
  readonly apiKeyEnv?: string;
  readonly allowInsecureHttp?: boolean;
  readonly models: readonly CliCompatibleModel[];
}

/** Owner-controlled settings for the web tools (`web_fetch`, `web_search`). */
export interface CliWebConfig {
  /** SearXNG base URL for `web_search` on non-Codex models. */
  readonly searxngUrl?: string;
}

export interface CliConfig {
  readonly schemaVersion: 1;
  readonly updateAutomaticChecks: boolean;
  readonly defaultModel: {
    readonly providerId: string;
    readonly modelId: string;
  };
  readonly openAiModels: readonly string[];
  readonly codexModels: readonly string[];
  readonly codexUseWebSocket?: boolean;
  readonly compatibleProviders: readonly CliCompatibleProvider[];
  /** Absent in older configs; read with {@link cliWebConfig}. */
  readonly web?: CliWebConfig;
}
