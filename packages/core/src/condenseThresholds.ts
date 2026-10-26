// VS Code's default auto-condense thresholds and target windows, shared so
// every host condenses at the same point. VS Code's
// `src/agent/condenseTargetWindow.ts` and the pure parts of
// `src/agent/modelCondenseThresholds.ts` re-export these.

import { usesCodexAlignedCondense } from "./codex/models.js";

// Default condense targets assume a 256k usable-input window regardless of the
// model's advertised context. Larger windows scale the default fraction and the
// cache-hit bonus down so sessions condense at the same absolute point a 256k
// model would; raising the per-model percentage restores the full window.
export const TARGET_USABLE_INPUT_TOKENS = 262_144;

// Claude 4.6+ frontier models bill the full 1M window at standard pricing, but
// every turn still re-reads the whole (cached) context, so per-turn usage grows
// with context size. A ~300k condense point (0.9 of this target) is a moderate
// step up from the 256k default without the ~30-45% per-turn usage increase of
// condensing near 450k. Claude Code itself compacts these models near 967k.
export const ANTHROPIC_FRONTIER_TARGET_USABLE_INPUT_TOKENS = Math.round(
  300_000 / 0.9,
);

// Haiku 5.5 bills prompts above 100k at a higher rate.
export const HAIKU_5_5_TARGET_USABLE_INPUT_TOKENS = 100_000;

export interface CondenseWindowCapabilities {
  contextWindow?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  /** Provider-declared target for this endpoint (for example subscription-only defaults). */
  condenseTargetInputTokens?: number;
}

export function isAnthropicFrontierModel(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  return (
    lower.startsWith("claude-") &&
    (lower.includes("sonnet") ||
      lower.includes("opus") ||
      lower.includes("fable") ||
      lower.includes("mythos"))
  );
}

function isHaiku55Model(modelId: string): boolean {
  return /^claude-haiku-5-5(?:-|$)/i.test(modelId);
}

/** Absolute usable-input target that default condense thresholds aim for. */
export function getTargetUsableInputTokens(
  modelId?: string,
  capabilities?: CondenseWindowCapabilities,
): number {
  if (typeof capabilities?.condenseTargetInputTokens === "number") {
    return capabilities.condenseTargetInputTokens;
  }
  if (modelId && isHaiku55Model(modelId)) {
    return HAIKU_5_5_TARGET_USABLE_INPUT_TOKENS;
  }
  if (modelId && isAnthropicFrontierModel(modelId)) {
    return ANTHROPIC_FRONTIER_TARGET_USABLE_INPUT_TOKENS;
  }
  return TARGET_USABLE_INPUT_TOKENS;
}

/** Mirrors the engine's usable-input derivation: provider cap, else window minus output. */
export function getUsableInputTokens(
  capabilities?: CondenseWindowCapabilities,
): number | undefined {
  if (typeof capabilities?.maxInputTokens === "number") {
    return capabilities.maxInputTokens;
  }
  if (typeof capabilities?.contextWindow !== "number") return undefined;
  return Math.max(
    0,
    capabilities.contextWindow - (capabilities.maxOutputTokens ?? 0),
  );
}

/** Fraction that maps the model's usable input onto its target window (1 when already at or below it). */
export function getTargetWindowScale(
  capabilities?: CondenseWindowCapabilities,
  modelId?: string,
): number {
  const usable = getUsableInputTokens(capabilities);
  const target = getTargetUsableInputTokens(modelId, capabilities);
  if (usable === undefined || usable <= target) return 1;
  return target / usable;
}

// Condensing is the expensive event, not carrying context: each condense costs
// a full summarization request and invalidates the entire prompt cache, so the
// next request reprocesses the whole rewritten history uncached. With healthy
// caching, large contexts are cheap per-request — condense near the limit
// (like Claude Code/Codex auto-compaction), not as routine hygiene.
//
// These fractions are relative to a target usable-input window rather than the
// model's real window (see above): quality degrades well before a 1M window
// fills, so the default scales down for larger models. The target is 256k by
// default, 500k for Claude 1M frontier models and GPT-6.1 Sol on a ChatGPT
// sign-in, and 100k for Haiku 5.5.
//
// Codex-aligned models condense at 90% of their target, like Codex
// auto-compaction (90% of its window): ~236k for GPT-5.6, GPT-6.1 Terra, and
// GPT-6.1 Sol on an API key (under the 272k API long-context price tier),
// ~450k on 500k targets.
const CODEX_ALIGNED_DEFAULT_THRESHOLD = 0.9;
const LARGE_CONTEXT_DEFAULT_THRESHOLD = 0.85;
const LEGACY_LARGE_MODEL_DEFAULT_THRESHOLD = 0.8;
const OTHER_MODELS_DEFAULT_THRESHOLD = 0.9;
const LARGE_CONTEXT_WINDOW_TOKENS = 1_000_000;
const MIN_THRESHOLD = 0.1;
const MAX_THRESHOLD = 1;

export type ModelCondenseThresholdMap = Record<string, number>;

export function clampCondenseThreshold(value: number): number {
  if (!Number.isFinite(value)) return OTHER_MODELS_DEFAULT_THRESHOLD;
  return Math.min(MAX_THRESHOLD, Math.max(MIN_THRESHOLD, value));
}

/** Frontier models historically treated as large when capabilities are unavailable. */
function isLegacyLargeContextFrontierModel(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  return (
    isAnthropicFrontierModel(lower) ||
    lower === "gpt-5.5" ||
    lower === "gpt-5.4" ||
    lower === "gpt-5.4-pro"
  );
}

function getBaseAutoCondenseThreshold(
  modelId: string,
  capabilities?: CondenseWindowCapabilities,
): number {
  if (usesCodexAlignedCondense(modelId)) {
    return CODEX_ALIGNED_DEFAULT_THRESHOLD;
  }
  if (
    typeof capabilities?.contextWindow === "number" &&
    capabilities.contextWindow >= LARGE_CONTEXT_WINDOW_TOKENS
  ) {
    return isAnthropicFrontierModel(modelId)
      ? CODEX_ALIGNED_DEFAULT_THRESHOLD
      : LARGE_CONTEXT_DEFAULT_THRESHOLD;
  }
  return isLegacyLargeContextFrontierModel(modelId)
    ? LEGACY_LARGE_MODEL_DEFAULT_THRESHOLD
    : OTHER_MODELS_DEFAULT_THRESHOLD;
}

export function getDefaultAutoCondenseThreshold(
  modelId: string,
  capabilities?: CondenseWindowCapabilities,
): number {
  return clampCondenseThreshold(
    getBaseAutoCondenseThreshold(modelId, capabilities) *
      getTargetWindowScale(capabilities, modelId),
  );
}

export function normalizeModelThresholdMap(
  value: unknown,
): ModelCondenseThresholdMap {
  if (!value || typeof value !== "object") return {};
  const out: ModelCondenseThresholdMap = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw !== "number") continue;
    out[key] = clampCondenseThreshold(raw);
  }
  return out;
}

export function getEffectiveAutoCondenseThreshold(
  modelId: string,
  overrides?: ModelCondenseThresholdMap,
  capabilities?: CondenseWindowCapabilities,
): number {
  const explicit = overrides?.[modelId];
  if (typeof explicit === "number") return clampCondenseThreshold(explicit);
  return getDefaultAutoCondenseThreshold(modelId, capabilities);
}
