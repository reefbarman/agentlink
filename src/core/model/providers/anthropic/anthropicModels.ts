import type {
  AnthropicModelCapabilities,
  StaticModelEntry,
} from "./anthropicModelCatalog.js";
import type { CoreReasoningEffort } from "../../../modelCatalog.js";

const CLAUDE_REASONING_EFFORTS = [
  "none",
  "low",
  "medium",
  "high",
  "max",
] as const satisfies readonly CoreReasoningEffort[];

export const ANTHROPIC_MODEL_CAPABILITIES: Record<
  string,
  AnthropicModelCapabilities
> = {
  "claude-opus-4-8": {
    supportsThinking: true,
    supportsAdaptiveThinking: true,
    supportsCaching: true,
    supportsImages: true,
    supportsToolUse: true,
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    reasoningEfforts: [...CLAUDE_REASONING_EFFORTS],
    defaultReasoningEffort: "high",
  },
  "claude-sonnet-4-6": {
    supportsThinking: true,
    supportsAdaptiveThinking: true,
    supportsCaching: true,
    supportsImages: true,
    supportsToolUse: true,
    contextWindow: 1_000_000,
    maxOutputTokens: 64_000,
    reasoningEfforts: [...CLAUDE_REASONING_EFFORTS],
    defaultReasoningEffort: "high",
  },
  "claude-haiku-4-5-20251001": {
    supportsThinking: false,
    supportsAdaptiveThinking: false,
    supportsCaching: true,
    supportsImages: true,
    supportsToolUse: true,
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
  },
};

/** Display names for the statically-known models (merge base + offline fallback). */
export const ANTHROPIC_MODEL_DISPLAY_NAMES: Record<string, string> = {
  "claude-sonnet-4-6": "Claude Sonnet 4.6",
  "claude-opus-4-8": "Claude Opus 4.8",
  "claude-haiku-4-5-20251001": "Claude Haiku 4.5",
};

/** Static-listing order preserved from the original hard-coded `listModels()`. */
export const ANTHROPIC_STATIC_MODEL_ORDER = [
  "claude-sonnet-4-6",
  "claude-opus-4-8",
  "claude-haiku-4-5-20251001",
] as const;

export function buildAnthropicStaticModelEntries(): StaticModelEntry[] {
  return ANTHROPIC_STATIC_MODEL_ORDER.map((id) => ({
    id,
    displayName: ANTHROPIC_MODEL_DISPLAY_NAMES[id] ?? id,
    capabilities: ANTHROPIC_MODEL_CAPABILITIES[id],
  }));
}

export const DEFAULT_ANTHROPIC_MODEL_CAPABILITIES: AnthropicModelCapabilities =
  {
    supportsThinking: false,
    supportsCaching: true,
    supportsImages: true,
    supportsToolUse: true,
    contextWindow: 200_000,
    maxOutputTokens: 128_000,
  };

/** The preferred cheap/fast model for condensing. */
export const ANTHROPIC_CONDENSE_MODEL = "claude-haiku-4-5-20251001";
