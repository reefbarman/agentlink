// Default condense targets assume a 256k usable-input window regardless of the
// model's advertised context. Larger windows scale the default fraction and the
// cache-hit bonus down so sessions condense at the same absolute point a 256k
// model would; raising the per-model percentage restores the full window.
export const TARGET_USABLE_INPUT_TOKENS = 262_144;

export interface CondenseWindowCapabilities {
  contextWindow?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
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

/** Fraction that maps the model's usable input onto the 256k target (1 when already at or below it). */
export function getTargetWindowScale(
  capabilities?: CondenseWindowCapabilities,
): number {
  const usable = getUsableInputTokens(capabilities);
  if (usable === undefined || usable <= TARGET_USABLE_INPUT_TOKENS) return 1;
  return TARGET_USABLE_INPUT_TOKENS / usable;
}
