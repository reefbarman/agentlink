import {
  resolveCoreModelCatalogReadiness,
  type CoreModelCatalogEntry,
} from "@agentlink/protocol/model-catalog";
import type { CoreModelToolDefinition } from "./modelRuntime.js";
import {
  defineTool,
  type HostTool,
  type HostToolExecutionContext,
} from "./hostTools.js";

export interface ListModelsInput {
  query?: string;
  provider?: string;
  limit?: number;
  offset?: number;
}

export type DiscoveredModel = Pick<
  CoreModelCatalogEntry,
  | "id"
  | "displayName"
  | "providerId"
  | "providerDisplayName"
  | "contextWindow"
  | "maxInputTokens"
  | "maxOutputTokens"
  | "reasoningEfforts"
  | "defaultReasoningEffort"
  | "authenticated"
> & {
  supportsToolUse: boolean;
  supportsImages: boolean;
  readiness: string;
};

export interface ListModelsResult {
  models: DiscoveredModel[];
  total: number;
  offset: number;
  limit: number;
  nextOffset?: number;
  guidance: string;
}

export const LIST_MODELS_DESCRIPTION =
  "Discover configured models and their local IDs, provider IDs, capabilities, authentication and readiness for this agent's principal. Search before choosing a model for a background agent or model switch. This is a configured catalog, not a live entitlement, quota, or availability check; authentication and tool support do not guarantee background-agent eligibility. Does not change the current model or authenticate providers.";

export const LIST_MODELS_TOOL: CoreModelToolDefinition = {
  name: "list_models",
  description: LIST_MODELS_DESCRIPTION,
  input_schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      query: {
        type: "string",
        maxLength: 500,
        description:
          "Case-insensitive AND-word search across local model IDs, display names, and provider names/IDs",
      },
      provider: {
        type: "string",
        description: "Filter by exact provider ID",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 100,
        description: "Maximum models to return (default: 50, maximum: 100)",
      },
      offset: {
        type: "integer",
        minimum: 0,
        maximum: Number.MAX_SAFE_INTEGER,
        description: "Number of matching models to skip (default: 0)",
      },
    },
  },
};

/** Opt-in SDK tool. The host supplies its live, enabled, principal-scoped catalog. */
export function createModelDiscoveryTool(options: {
  listModels: (
    context: HostToolExecutionContext,
  ) => Promise<readonly CoreModelCatalogEntry[]>;
}): HostTool {
  return defineTool({
    name: LIST_MODELS_TOOL.name,
    description: LIST_MODELS_DESCRIPTION,
    inputSchema: LIST_MODELS_TOOL.input_schema,
    effect: "read",
    parallelSafe: true,
    authorization: "none",
    handler: async (input, context) => {
      try {
        discoverModels([], input);
      } catch {
        return {
          modelContent: JSON.stringify({
            status: "invalid_model_discovery_input",
            error: "Invalid list_models input",
          }),
          isError: true,
        };
      }
      try {
        const result = discoverModels(await options.listModels(context), input);
        return { modelContent: JSON.stringify(result), displayContent: result };
      } catch {
        return {
          modelContent: JSON.stringify({
            status: "model_catalog_unavailable",
            error:
              "The configured model catalog could not be read. Check provider configuration and try again.",
          }),
          isError: true,
        };
      }
    },
  });
}

/** Project an already principal-scoped catalog, never provider credentials or errors. */
export function discoverModels(
  models: readonly CoreModelCatalogEntry[],
  input: ListModelsInput = {},
): ListModelsResult {
  if (
    input.query !== undefined &&
    (typeof input.query !== "string" || input.query.length > 500)
  ) {
    throw new Error("query must be a string of at most 500 characters");
  }
  if (input.provider !== undefined && typeof input.provider !== "string") {
    throw new Error("provider must be a string");
  }
  const limit = input.limit ?? 50;
  const offset = input.offset ?? 0;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("limit must be an integer from 1 to 100");
  }
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new Error("offset must be a non-negative safe integer");
  }
  const words = (input.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const matches = models.filter((model) => {
    if (input.provider !== undefined && model.providerId !== input.provider)
      return false;
    const text = [
      model.id,
      model.displayName,
      model.providerId,
      model.providerDisplayName ?? "",
    ]
      .join(" ")
      .toLowerCase();
    return words.every((word) => text.includes(word));
  });
  const page = matches
    .slice(offset, offset + limit)
    .map((model): DiscoveredModel => ({
      id: model.id,
      displayName: model.displayName,
      providerId: model.providerId,
      ...(model.providerDisplayName !== undefined
        ? { providerDisplayName: model.providerDisplayName }
        : {}),
      supportsToolUse: model.supportsToolUse === true,
      supportsImages: model.supportsImages === true,
      contextWindow: model.contextWindow,
      ...(model.maxInputTokens !== undefined
        ? { maxInputTokens: model.maxInputTokens }
        : {}),
      ...(model.maxOutputTokens !== undefined
        ? { maxOutputTokens: model.maxOutputTokens }
        : {}),
      ...(model.reasoningEfforts !== undefined
        ? { reasoningEfforts: [...model.reasoningEfforts] }
        : {}),
      ...(model.defaultReasoningEffort !== undefined
        ? { defaultReasoningEffort: model.defaultReasoningEffort }
        : {}),
      authenticated: model.authenticated,
      readiness: resolveCoreModelCatalogReadiness(model).status,
    }));
  return {
    models: page,
    total: matches.length,
    offset,
    limit,
    ...(offset + page.length < matches.length
      ? { nextOffset: offset + page.length }
      : {}),
    guidance:
      "This enabled configured catalog is not a list of arbitrary upstream models or a live entitlement, quota, or availability check. Authentication and tool support do not guarantee background-agent eligibility. VS Code spawn uses model=id and provider=providerId; standalone model selection uses model_id=id and provider_id=providerId.",
  };
}
