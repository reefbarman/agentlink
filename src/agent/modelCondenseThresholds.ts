import * as vscode from "vscode";

const LEGACY_THRESHOLD_KEY = "autoCondenseThreshold";
export const MODEL_THRESHOLD_KEY = "modelCondenseThresholds";

const LARGE_CONTEXT_DEFAULT_THRESHOLD = 0.7;
const LEGACY_LARGE_MODEL_DEFAULT_THRESHOLD = 0.6;
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
    (lower.includes("sonnet") || lower.includes("opus"))
  );
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
  const overrides = getMigratedModelCondenseThresholdMap(config, modelId);
  return getEffectiveAutoCondenseThreshold(modelId, overrides, capabilities);
}

export function getModelCondenseThresholdMap(
  config: vscode.WorkspaceConfiguration,
): ModelCondenseThresholdMap {
  return normalizeModelThresholdMap(config.get(MODEL_THRESHOLD_KEY));
}

export function getMigratedModelCondenseThresholdMap(
  config: vscode.WorkspaceConfiguration,
  selectedModel: string,
): ModelCondenseThresholdMap {
  const explicit = getModelCondenseThresholdMap(config);
  if (Object.keys(explicit).length > 0) return explicit;

  const inspected = config.inspect<number>(LEGACY_THRESHOLD_KEY);
  const legacy =
    inspected?.globalValue ??
    inspected?.workspaceValue ??
    inspected?.workspaceFolderValue;
  if (typeof legacy !== "number") return explicit;

  return { [selectedModel]: clampCondenseThreshold(legacy) };
}
