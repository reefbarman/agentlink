import type { ModelCapabilities, ModelInfo } from "../types.js";
import type { OpenAiCodexResolvedAuth } from "./OpenAiCodexAuthManager.js";

export interface CodexModelDef {
  id: string;
  displayName: string;
  contextWindow: number;
  maxOutputTokens: number;
  supportsImages: boolean;
  supportsThinking: boolean;
  defaultReasoningEffort: string;
}

/**
 * Capabilities of a specific Responses API endpoint+auth surface.
 *
 * The public OpenAI API (api.openai.com/v1/responses) exposes the full
 * documented Responses feature set. The ChatGPT/Codex backend
 * (chatgpt.com/backend-api/codex/responses) is an internal surface that
 * rejects parameters the public docs describe — so we treat it conservatively.
 */
export interface ResponsesCaps {
  supportsPreviousResponseId: boolean;
  supportsPromptCacheKey: boolean;
  supportsPromptCacheRetention: boolean;
}

/** The preferred cheap/fast model for condensing on Codex. */
export const CODEX_CONDENSE_MODEL = "gpt-5.1-codex-mini";

/** Ordered fallback chain for condensing when account entitlements vary. */
export const CODEX_CONDENSE_MODEL_FALLBACKS = [
  CODEX_CONDENSE_MODEL,
  "gpt-5.2-codex",
  "gpt-5.3-codex",
] as const;

export const CODEX_MODELS: CodexModelDef[] = [
  {
    id: "gpt-5.4",
    displayName: "GPT-5.4",
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    supportsImages: true,
    supportsThinking: true,
    defaultReasoningEffort: "medium",
  },
  {
    id: "gpt-5.3-codex",
    displayName: "GPT-5.3 Codex",
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    supportsImages: true,
    supportsThinking: true,
    defaultReasoningEffort: "medium",
  },
  {
    id: "gpt-5.2",
    displayName: "GPT-5.2",
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    supportsImages: true,
    supportsThinking: true,
    defaultReasoningEffort: "medium",
  },
  {
    id: "gpt-5.2-codex",
    displayName: "GPT-5.2 Codex",
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    supportsImages: true,
    supportsThinking: true,
    defaultReasoningEffort: "medium",
  },
  {
    id: "gpt-5.1-codex-mini",
    displayName: "GPT-5.1 Codex Mini",
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    supportsImages: false,
    supportsThinking: true,
    defaultReasoningEffort: "medium",
  },
  {
    id: "gpt-5.1-codex-max",
    displayName: "GPT-5.1 Codex Max",
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    supportsImages: true,
    supportsThinking: true,
    defaultReasoningEffort: "xhigh",
  },
];

export const CODEX_MODEL_MAP = new Map(
  CODEX_MODELS.map((model) => [model.id, model]),
);

export function getEndpointCaps(auth: OpenAiCodexResolvedAuth): ResponsesCaps {
  if (auth.method === "apiKey") {
    return {
      supportsPreviousResponseId: true,
      supportsPromptCacheKey: true,
      supportsPromptCacheRetention: true,
    };
  }

  return {
    supportsPreviousResponseId: false,
    supportsPromptCacheKey: false,
    supportsPromptCacheRetention: false,
  };
}

export function getCodexModelCapabilities(model: string): ModelCapabilities {
  const def = CODEX_MODEL_MAP.get(model);
  return {
    supportsThinking: def?.supportsThinking ?? true,
    supportsCaching: true,
    supportsImages: def?.supportsImages ?? true,
    supportsToolUse: true,
    contextWindow: def?.contextWindow ?? 400_000,
    maxOutputTokens: def?.maxOutputTokens ?? 128_000,
  };
}

export function listCodexModels(providerId: string): ModelInfo[] {
  return CODEX_MODELS.map((model) => ({
    id: model.id,
    displayName: model.displayName,
    provider: providerId,
    capabilities: getCodexModelCapabilities(model.id),
  }));
}
