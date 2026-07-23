import type { OpenAiCompatibleRuntimeProfile } from "../../../core/model/providers/openaiCompatible/types.js";
import type { ModelProvider } from "../types.js";
import type { ProviderRegistry } from "../index.js";
import {
  normalizeOpenAiCompatibleConnections,
  type NormalizedOpenAiCompatibleConnection,
  type NormalizeOpenAiCompatibleConnectionsResult,
  type OpenAiCompatibleConfigIssue,
} from "./config.js";
import {
  OpenAiCompatibleProvider,
  type OpenAiCompatibleSecretResolver,
} from "./OpenAiCompatibleProvider.js";

export interface OpenAiCompatibleConfigurationReader {
  get<T>(section: string, defaultValue: T): T;
}

export interface OpenAiCompatibleProviderManagerOptions {
  registry: ProviderRegistry;
  builtInProviders: readonly ModelProvider[];
  configuration: OpenAiCompatibleConfigurationReader;
  secrets: OpenAiCompatibleSecretResolver;
  log?: (message: string) => void;
}

export interface OpenAiCompatibleProviderReconcileResult {
  applied: boolean;
  providers: readonly OpenAiCompatibleProvider[];
  issues: readonly OpenAiCompatibleConfigIssue[];
  warnings: readonly OpenAiCompatibleConfigIssue[];
}

export class OpenAiCompatibleProviderManager {
  private providers: OpenAiCompatibleProvider[] = [];
  private connections: NormalizedOpenAiCompatibleConnection[] = [];

  constructor(
    private readonly options: OpenAiCompatibleProviderManagerOptions,
  ) {}

  validateConnections(
    raw: unknown,
  ): NormalizeOpenAiCompatibleConnectionsResult {
    return normalizeOpenAiCompatibleConnections(raw, {
      builtInModelIds: this.options.builtInProviders.flatMap((provider) => [
        ...provider.listModels().map((model) => model.id),
        ...(provider.listRoutableModelIds?.() ?? []),
      ]),
    });
  }

  reconcile(): OpenAiCompatibleProviderReconcileResult {
    const raw = this.options.configuration.get<unknown>("connections", []);
    const normalized = this.validateConnections(raw);

    for (const issue of [...normalized.issues, ...normalized.warnings]) {
      this.options.log?.(`[openai-compatible] ${issue.path}: ${issue.message}`);
    }

    if (normalized.issues.length > 0) {
      return {
        applied: false,
        providers: this.providers,
        issues: normalized.issues,
        warnings: normalized.warnings,
      };
    }

    const providers = normalized.connections.map(
      (connection) =>
        new OpenAiCompatibleProvider({
          connection,
          secrets: this.options.secrets,
        }),
    );

    try {
      this.options.registry.reconcile([
        ...this.options.builtInProviders,
        ...providers,
      ]);
    } catch (error) {
      const issue = {
        path: "$",
        message: error instanceof Error ? error.message : String(error),
      };
      this.options.log?.(`[openai-compatible] $: ${issue.message}`);
      return {
        applied: false,
        providers: this.providers,
        issues: [issue],
        warnings: normalized.warnings,
      };
    }

    this.connections = [...normalized.connections];
    this.providers = providers;
    return {
      applied: true,
      providers,
      issues: [],
      warnings: normalized.warnings,
    };
  }

  listProviders(): readonly OpenAiCompatibleProvider[] {
    return this.providers;
  }

  listConfiguredAuthKeys(): string[] {
    return [
      ...new Set(
        this.connections.flatMap((connection) =>
          connection.authKey ? [connection.authKey] : [],
        ),
      ),
    ].sort((left, right) => left.localeCompare(right));
  }

  getAuthKey(providerId: string): string | undefined {
    return this.connections.find(
      (connection) => connection.providerId === providerId,
    )?.authKey;
  }

  getRuntimeProfiles(): Readonly<
    Record<string, OpenAiCompatibleRuntimeProfile>
  > {
    return Object.fromEntries(
      this.connections.map((connection) => [
        connection.providerId,
        connection.runtimeProfile,
      ]),
    );
  }
}
