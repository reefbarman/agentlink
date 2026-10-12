// Default condense targets assume a 256k usable-input window regardless of the
// model's advertised context. Larger windows scale the default fraction and the
// cache-hit bonus down so sessions condense at the same absolute point a 256k
// model would; raising the per-model percentage restores the full window.
export const TARGET_USABLE_INPUT_TOKENS = 262_144;

// Codex raised GPT-6.1 Sol's default context from 272k to 500k (Oct 2026) to
// reduce compactions on long tasks. Mirror that default for the same model.
export const GPT_6_1_SOL_TARGET_USABLE_INPUT_TOKENS = 500_000;

export interface CondenseWindowCapabilities {
  contextWindow?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
}

function isGpt61SolModel(modelId: string): boolean {
  return /^gpt-6\.1-sol(?:-|$)/i.test(modelId);
}

/** Absolute usable-input target that default condense thresholds aim for. */
export function getTargetUsableInputTokens(modelId?: string): number {
  if (modelId && isGpt61SolModel(modelId)) {
    return GPT_6_1_SOL_TARGET_USABLE_INPUT_TOKENS;
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
  const target = getTargetUsableInputTokens(modelId);
  if (usable === undefined || usable <= target) return 1;
  return target / usable;
}
