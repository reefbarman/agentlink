import {
  isCodexModelServedOnChatgptBackend,
  listCodexModels,
} from "@agentlink/core/codex";

import type { CoreModelCatalogEntry } from "@agentlink/protocol/model-catalog";
import {
  normalizeOpenAiCompatibleConnections,
  type NormalizedOpenAiCompatibleConnection,
} from "@agentlink/core/openai-compatible";

export function buildDesktopCodexCatalog(
  authMethod: "oauth" | "apiKey",
): CoreModelCatalogEntry[] {
  const models = listCodexModels("openai-codex", authMethod);
  return models
    .filter(
      (model) =>
        authMethod === "apiKey" || isCodexModelServedOnChatgptBackend(model.id),
    )
    .map((model) => ({
      id: model.id,
      displayName: model.displayName,
      providerId: "openai-codex",
      providerDisplayName: "OpenAI",
      supportsToolUse: model.capabilities.supportsToolUse,
      supportsImages: model.capabilities.supportsImages,
      contextWindow: model.capabilities.contextWindow,
      maxInputTokens: model.capabilities.maxInputTokens,
      maxOutputTokens: model.capabilities.maxOutputTokens,
      reasoningEfforts: model.capabilities.reasoningEfforts,
      defaultReasoningEffort: model.capabilities.defaultReasoningEffort,
      authenticated: true,
      readiness: { status: "ready" },
    }));
}

export function buildDesktopOpenAiCompatibleCatalog(
  raw: unknown,
  availableAuthKeys: ReadonlySet<string> = new Set(),
): {
  connections: readonly NormalizedOpenAiCompatibleConnection[];
  models: CoreModelCatalogEntry[];
} {
  const normalized = normalizeOpenAiCompatibleConnections(raw, {
    builtInModelIds: buildDesktopCodexCatalog("apiKey").map(
      (model) => model.id,
    ),
  });
  if (normalized.issues.length > 0) {
    throw new Error(
      `agentlink_openai_compatible_config_invalid:${normalized.issues
        .map((issue) => `${issue.path}:${issue.message}`)
        .join("|")}`,
    );
  }
  return {
    connections: normalized.connections,
    models: normalized.connections.flatMap((connection) => {
      const authenticated =
        !connection.authKey || availableAuthKeys.has(connection.authKey);
      return connection.models.map((model) => ({
        id: model.id,
        displayName: model.displayName,
        providerId: connection.providerId,
        providerDisplayName: connection.displayName,
        supportsToolUse: model.capabilities.supportsToolUse,
        supportsImages: model.capabilities.supportsImages,
        contextWindow: model.capabilities.contextWindow,
        maxInputTokens: model.capabilities.maxInputTokens,
        maxOutputTokens: model.capabilities.maxOutputTokens,
        reasoningEfforts: model.capabilities.reasoningEfforts,
        defaultReasoningEffort: model.capabilities.defaultReasoningEffort,
        authenticated,
        readiness: authenticated
          ? ({ status: "ready" } as const)
          : ({
              status: "credentials_required",
              action: {
                kind: "api_key",
                providerId: connection.providerId,
              },
            } as const),
      }));
    }),
  };
}
