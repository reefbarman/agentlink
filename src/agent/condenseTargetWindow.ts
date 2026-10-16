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
