import * as vscode from "vscode";

export const MODEL_THRESHOLD_KEY = "modelCondenseThresholds";

// Condensing is the expensive event, not carrying context: each condense costs
// a full summarization request and invalidates the entire prompt cache, so the
// next request reprocesses the whole rewritten history uncached. With healthy
// caching, large contexts are cheap per-request — condense near the limit
// (like Claude Code/Codex auto-compaction), not as routine hygiene.
const GPT_5_6_DEFAULT_THRESHOLD = 0.65;
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

function isGpt56Model(modelId: string): boolean {
  return /^gpt-5\.6(?:-|$)/i.test(modelId);
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

export function getDefaultAutoCondenseThreshold(
  modelId: string,
  capabilities?: { contextWindow?: number },
): number {
  if (isGpt56Model(modelId)) return GPT_5_6_DEFAULT_THRESHOLD;
  if (
    typeof capabilities?.contextWindow === "number" &&
    capabilities.contextWindow >= LARGE_CONTEXT_WINDOW_TOKENS
  ) {
    return LARGE_CONTEXT_DEFAULT_THRESHOLD;
  }
  return isLegacyLargeContextFrontierModel(modelId)
    ? LEGACY_LARGE_MODEL_DEFAULT_THRESHOLD
    : OTHER_MODELS_DEFAULT_THRESHOLD;
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
  capabilities?: { contextWindow?: number },
): number {
  const explicit = overrides?.[modelId];
  if (typeof explicit === "number") return clampCondenseThreshold(explicit);
  return getDefaultAutoCondenseThreshold(modelId, capabilities);
}

export function getConfiguredBaseThresholdForModel(
  config: vscode.WorkspaceConfiguration,
  modelId: string,
  capabilities?: { contextWindow?: number },
): number {
  const overrides = getModelCondenseThresholdMap(config);
  return getEffectiveAutoCondenseThreshold(modelId, overrides, capabilities);
}

export function getModelCondenseThresholdMap(
  config: vscode.WorkspaceConfiguration,
): ModelCondenseThresholdMap {
  return normalizeModelThresholdMap(config.get(MODEL_THRESHOLD_KEY));
}
