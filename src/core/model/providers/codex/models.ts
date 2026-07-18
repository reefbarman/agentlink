import type { CoreReasoningEffort } from "../../../modelCatalog.js";
import type { CoreModelCapabilities } from "../../../modelRuntime.js";

export type CodexAuthMethod = "oauth" | "apiKey";

export interface CodexEffectiveModelResolution {
  model: string;
  remapped: boolean;
}

export interface CodexResolvedAuthShape {
  method: CodexAuthMethod;
}

export interface CodexModelDef {
  id: string;
  displayName: string;
  contextWindow: number;
  maxInputTokens?: number;
  maxOutputTokens: number;
  supportsImages: boolean;
  supportsThinking: boolean;
  defaultReasoningEffort: CoreReasoningEffort;
  reasoningEfforts: CoreReasoningEffort[];
}

const GPT_5_4_REASONING_EFFORTS = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
] as const satisfies readonly CoreReasoningEffort[];

const GPT_5_6_REASONING_EFFORTS = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly CoreReasoningEffort[];

const GPT_5_REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
] as const satisfies readonly CoreReasoningEffort[];

const GPT_5_CODEX_MAX_REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const satisfies readonly CoreReasoningEffort[];

/**
 * Capabilities of a specific Responses API endpoint+auth surface.
 *
 * The public OpenAI API (api.openai.com/v1/responses) exposes the full
 * documented Responses feature set. The ChatGPT/Codex backend
 * (chatgpt.com/backend-api/codex/responses) supports native web search but
 * rejects some other parameters the public docs describe, so each capability
 * remains explicit.
 */
export interface ResponsesCaps {
  supportsPreviousResponseId: boolean;
  supportsPersistedReasoning: boolean;
  supportsProMode: boolean;
  supportsPromptCacheKey: boolean;
  supportsPromptCacheRetention: boolean;
  supportsMaxOutputTokens: boolean;
  supportsHostedWebSearch: boolean;
}

/**
 * Models the ChatGPT/Codex OAuth backend (chatgpt.com/backend-api/codex)
 * actually serves. Verified by probing the endpoint — it rejects every other
 * model with "<id> is not supported when using Codex with a ChatGPT account",
 * which reaches our SDK as a bare `400 status code (no body)`. The public
 * API-key endpoint (api.openai.com) serves the full CODEX_MODELS set, so this
 * gate only applies to OAuth auth.
 *
 * The backend only exposes roughly the current generation and rotates older
 * ones out, so keep this list in sync as models ship. The runtime remap in
 * CodexProvider is the backstop when this drifts.
 */
export const CODEX_CHATGPT_BACKEND_MODEL_IDS = [
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
] as const;

const CHATGPT_BACKEND_MODEL_SET = new Set<string>(
  CODEX_CHATGPT_BACKEND_MODEL_IDS,
);

/**
 * Default Codex model — routed to for background agents on the codex/gpt side
 * (e.g. "opposite" provider strategy) and used as the OAuth remap target.
 */
export const CODEX_DEFAULT_MODEL = "gpt-5.6-sol";

/** Cheapest OAuth-served Codex model, used for condensing and cheap-tier tasks. */
export const CODEX_OAUTH_CHEAP_MODEL = "gpt-5.6-luna";

export function isCodexModelServedOnChatgptBackend(modelId: string): boolean {
  return CHATGPT_BACKEND_MODEL_SET.has(modelId);
}

/**
 * Map an arbitrary (possibly OAuth-unavailable) Codex model id to one the
 * ChatGPT backend serves, preserving the rough tier: mini/nano collapse to the
 * cheap model, everything else to the default (gpt-5.5).
 */
export function remapToChatgptBackendModel(modelId: string): string {
  if (isCodexModelServedOnChatgptBackend(modelId)) return modelId;
  if (
    /mini|nano/.test(modelId) &&
    CHATGPT_BACKEND_MODEL_SET.has(CODEX_OAUTH_CHEAP_MODEL)
  ) {
    return CODEX_OAUTH_CHEAP_MODEL;
  }
  return CODEX_DEFAULT_MODEL;
}

/** Stable equivalents used when a limited-preview GPT-5.6 model is unavailable. */
export function getCodexPreviewModelFallback(
  modelId: string,
): string | undefined {
  switch (modelId) {
    case "gpt-5.6-sol":
      return "gpt-5.5";
    case "gpt-5.6-terra":
      return "gpt-5.4";
    case "gpt-5.6-luna":
      return "gpt-5.4-mini";
    default:
      return undefined;
  }
}

export function resolveCodexEffectiveModel(
  modelId: string,
  authMethod: CodexAuthMethod,
): CodexEffectiveModelResolution {
  if (authMethod !== "oauth" || isCodexModelServedOnChatgptBackend(modelId)) {
    return { model: modelId, remapped: false };
  }

  return {
    model: remapToChatgptBackendModel(modelId),
    remapped: true,
  };
}

export function resolveCodexReasoningEffort(params: {
  modelId: string;
  requestedEffort?: CoreReasoningEffort;
}): CoreReasoningEffort | undefined {
  if (params.requestedEffort === "none") {
    return undefined;
  }

  return (
    params.requestedEffort ??
    CODEX_MODEL_MAP.get(params.modelId)?.defaultReasoningEffort ??
    "medium"
  );
}

/** The preferred cheap/fast model for condensing on Codex (OAuth-served). */
export const CODEX_CONDENSE_MODEL = CODEX_OAUTH_CHEAP_MODEL;

/**
 * Ordered fallback chain for condensing when account entitlements vary.
 * OAuth-served models first so the ChatGPT backend never wastes a doomed call;
 * API-key-only generations follow for completeness.
 */
export const CODEX_CONDENSE_MODEL_FALLBACKS = [
  CODEX_CONDENSE_MODEL,
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.2-codex",
  "gpt-5.3-codex",
] as const;

const CODEX_400K_INPUT_TOKENS = 272_000;
const CODEX_1M_CONTEXT_TOKENS = 1_050_000;
const CODEX_OAUTH_GPT_5_5_CONTEXT_TOKENS = 400_000;
const CODEX_OAUTH_GPT_5_6_INPUT_TOKENS = 353_000;
const CODEX_OAUTH_GPT_5_6_CONTEXT_TOKENS =
  CODEX_OAUTH_GPT_5_6_INPUT_TOKENS + 128_000;

export const CODEX_MODELS: CodexModelDef[] = [
  {
    id: "gpt-5.6-sol",
    displayName: "GPT-5.6 Sol (Preview)",
    contextWindow: CODEX_1M_CONTEXT_TOKENS,
    maxOutputTokens: 128_000,
    supportsImages: true,
    supportsThinking: true,
    defaultReasoningEffort: "medium",
    reasoningEfforts: [...GPT_5_6_REASONING_EFFORTS],
  },
  {
    id: "gpt-5.6-terra",
    displayName: "GPT-5.6 Terra (Preview)",
    contextWindow: CODEX_1M_CONTEXT_TOKENS,
    maxOutputTokens: 128_000,
    supportsImages: true,
    supportsThinking: true,
    defaultReasoningEffort: "medium",
    reasoningEfforts: [...GPT_5_6_REASONING_EFFORTS],
  },
  {
    id: "gpt-5.6-luna",
    displayName: "GPT-5.6 Luna (Preview)",
    contextWindow: CODEX_1M_CONTEXT_TOKENS,
    maxOutputTokens: 128_000,
    supportsImages: true,
    supportsThinking: true,
    defaultReasoningEffort: "medium",
    reasoningEfforts: [...GPT_5_6_REASONING_EFFORTS],
  },
  {
    id: "gpt-5.5",
    displayName: "GPT-5.5",
    contextWindow: CODEX_1M_CONTEXT_TOKENS,
    maxOutputTokens: 128_000,
    supportsImages: true,
    supportsThinking: true,
    defaultReasoningEffort: "medium",
    reasoningEfforts: [...GPT_5_4_REASONING_EFFORTS],
  },
  {
    id: "gpt-5.4",
    displayName: "GPT-5.4",
    contextWindow: CODEX_1M_CONTEXT_TOKENS,
    maxOutputTokens: 128_000,
    supportsImages: true,
    supportsThinking: true,
    defaultReasoningEffort: "medium",
    reasoningEfforts: [...GPT_5_4_REASONING_EFFORTS],
  },
  {
    id: "gpt-5.4-pro",
    displayName: "GPT-5.4 Pro",
    contextWindow: CODEX_1M_CONTEXT_TOKENS,
    maxOutputTokens: 128_000,
    supportsImages: true,
    supportsThinking: true,
    defaultReasoningEffort: "high",
    reasoningEfforts: [...GPT_5_4_REASONING_EFFORTS],
  },
  {
    id: "gpt-5.4-mini",
    displayName: "GPT-5.4 Mini",
    contextWindow: 400_000,
    maxInputTokens: CODEX_400K_INPUT_TOKENS,
    maxOutputTokens: 128_000,
    supportsImages: true,
    supportsThinking: true,
    defaultReasoningEffort: "medium",
    reasoningEfforts: [...GPT_5_4_REASONING_EFFORTS],
  },
  {
    id: "gpt-5.4-nano",
    displayName: "GPT-5.4 Nano",
    contextWindow: 400_000,
    maxInputTokens: CODEX_400K_INPUT_TOKENS,
    maxOutputTokens: 128_000,
    supportsImages: true,
    supportsThinking: true,
    defaultReasoningEffort: "medium",
    reasoningEfforts: [...GPT_5_4_REASONING_EFFORTS],
  },
  {
    id: "gpt-5.3-codex",
    displayName: "GPT-5.3 Codex",
    contextWindow: 400_000,
    maxInputTokens: CODEX_400K_INPUT_TOKENS,
    maxOutputTokens: 128_000,
    supportsImages: true,
    supportsThinking: true,
    defaultReasoningEffort: "medium",
    reasoningEfforts: [...GPT_5_REASONING_EFFORTS],
  },
  {
    id: "gpt-5.2",
    displayName: "GPT-5.2",
    contextWindow: 400_000,
    maxInputTokens: CODEX_400K_INPUT_TOKENS,
    maxOutputTokens: 128_000,
    supportsImages: true,
    supportsThinking: true,
    defaultReasoningEffort: "medium",
    reasoningEfforts: [...GPT_5_REASONING_EFFORTS],
  },
  {
    id: "gpt-5.2-codex",
    displayName: "GPT-5.2 Codex",
    contextWindow: 400_000,
    maxInputTokens: CODEX_400K_INPUT_TOKENS,
    maxOutputTokens: 128_000,
    supportsImages: true,
    supportsThinking: true,
    defaultReasoningEffort: "medium",
    reasoningEfforts: [...GPT_5_REASONING_EFFORTS],
  },
  {
    id: "gpt-5.1-codex-mini",
    displayName: "GPT-5.1 Codex Mini",
    contextWindow: 400_000,
    maxInputTokens: CODEX_400K_INPUT_TOKENS,
    maxOutputTokens: 128_000,
    supportsImages: true,
    supportsThinking: true,
    defaultReasoningEffort: "medium",
    reasoningEfforts: [...GPT_5_REASONING_EFFORTS],
  },
  {
    id: "gpt-5.1-codex-max",
    displayName: "GPT-5.1 Codex Max",
    contextWindow: 400_000,
    maxInputTokens: CODEX_400K_INPUT_TOKENS,
    maxOutputTokens: 128_000,
    supportsImages: true,
    supportsThinking: true,
    defaultReasoningEffort: "xhigh",
    reasoningEfforts: [...GPT_5_CODEX_MAX_REASONING_EFFORTS],
  },
];

export const CODEX_MODEL_MAP = new Map(
  CODEX_MODELS.map((model) => [model.id, model]),
);

export function getEndpointCaps(auth: CodexResolvedAuthShape): ResponsesCaps {
  if (auth.method === "apiKey") {
    return {
      supportsPreviousResponseId: true,
      supportsPersistedReasoning: true,
      supportsProMode: true,
      supportsPromptCacheKey: true,
      supportsPromptCacheRetention: true,
      supportsMaxOutputTokens: true,
      supportsHostedWebSearch: true,
    };
  }

  return {
    supportsPreviousResponseId: false,
    supportsPersistedReasoning: false,
    supportsProMode: false,
    supportsPromptCacheKey: false,
    supportsPromptCacheRetention: false,
    supportsMaxOutputTokens: false,
    supportsHostedWebSearch: true,
  };
}

/**
 * The ChatGPT/Codex OAuth backend enforces smaller context windows than the
 * models' API metadata advertises, and rejects over-limit requests with
 * context_window_exceeded instead of compacting. GPT-5.5 errors at ~272k input
 * tokens (400k window minus the 128k output reserve); GPT-5.6 Sol errors at
 * ~353k. Terra/Luna are unverified but assumed to share the 5.6 generation cap
 * — under-clamping only compacts earlier, while over-advertising causes hard
 * request failures.
 */
const CODEX_OAUTH_WINDOW_OVERRIDES: Record<
  string,
  Pick<CodexModelDef, "contextWindow" | "maxInputTokens">
> = {
  "gpt-5.5": {
    contextWindow: CODEX_OAUTH_GPT_5_5_CONTEXT_TOKENS,
    maxInputTokens: CODEX_400K_INPUT_TOKENS,
  },
  "gpt-5.6-sol": {
    contextWindow: CODEX_OAUTH_GPT_5_6_CONTEXT_TOKENS,
    maxInputTokens: CODEX_OAUTH_GPT_5_6_INPUT_TOKENS,
  },
  "gpt-5.6-terra": {
    contextWindow: CODEX_OAUTH_GPT_5_6_CONTEXT_TOKENS,
    maxInputTokens: CODEX_OAUTH_GPT_5_6_INPUT_TOKENS,
  },
  "gpt-5.6-luna": {
    contextWindow: CODEX_OAUTH_GPT_5_6_CONTEXT_TOKENS,
    maxInputTokens: CODEX_OAUTH_GPT_5_6_INPUT_TOKENS,
  },
};

function getAuthAdjustedModelDef(
  model: string,
  authMethod?: CodexAuthMethod,
): CodexModelDef | undefined {
  const def = CODEX_MODEL_MAP.get(model);
  if (!def || authMethod !== "oauth") return def;

  const override = CODEX_OAUTH_WINDOW_OVERRIDES[model];
  if (!override) return def;

  return { ...def, ...override };
}

export function getCodexModelCapabilities(
  model: string,
  authMethod?: CodexAuthMethod,
): CoreModelCapabilities {
  const def = getAuthAdjustedModelDef(model, authMethod);
  const maxInputTokens = def ? def.maxInputTokens : CODEX_400K_INPUT_TOKENS;
  return {
    supportsThinking: def?.supportsThinking ?? true,
    supportsCaching: true,
    supportsImages: def?.supportsImages ?? true,
    supportsToolUse: true,
    hostedWeb: {
      search: {
        supported: true,
        supportsDomainRestrictions: authMethod === "apiKey",
        supportsCitations: true,
        // OpenAI page open/find actions are part of web_search rather than a
        // separately configurable hosted fetch tool. AgentLink can delegate a
        // web_fetch wrapper call to this page-access mode.
        supportsPageAccess: true,
      },
      fetch: { supported: false },
    },
    contextWindow: def?.contextWindow ?? 400_000,
    ...(typeof maxInputTokens === "number" ? { maxInputTokens } : {}),
    maxOutputTokens: def?.maxOutputTokens ?? 128_000,
    reasoningEfforts: def?.reasoningEfforts ?? [...GPT_5_REASONING_EFFORTS],
    defaultReasoningEffort: def?.defaultReasoningEffort ?? "medium",
  };
}

export function listCodexModels(
  providerId: string,
  authMethod?: CodexAuthMethod,
): Array<{
  id: string;
  displayName: string;
  provider: string;
  capabilities: CoreModelCapabilities;
}> {
  return CODEX_MODELS.map((model) => ({
    id: model.id,
    displayName: model.displayName,
    provider: providerId,
    capabilities: getCodexModelCapabilities(model.id, authMethod),
  }));
}
