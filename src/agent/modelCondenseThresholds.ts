import * as vscode from "vscode";

import {
  getTargetWindowScale,
  isAnthropicFrontierModel,
  type CondenseWindowCapabilities,
} from "./condenseTargetWindow.js";

export { isAnthropicFrontierModel };
import { getUserSessionPreference } from "./sharedSessionPreferences.js";

export const MODEL_THRESHOLD_KEY = "modelCondenseThresholds";

// Condensing is the expensive event, not carrying context: each condense costs
// a full summarization request and invalidates the entire prompt cache, so the
// next request reprocesses the whole rewritten history uncached. With healthy
// caching, large contexts are cheap per-request — condense near the limit
// (like Claude Code/Codex auto-compaction), not as routine hygiene.
//
// These fractions are relative to a target usable-input window rather than the
// model's real window (see condenseTargetWindow.ts): quality degrades well
// before a 1M window fills, so the default scales down for larger models. The
// target is 256k by default, 500k for Claude 1M frontier models and GPT-6.1
// Sol on a ChatGPT sign-in, and 100k for Haiku 5.5.
//
// Codex-aligned models condense at 90% of their target, like Codex
// auto-compaction (90% of its window): ~236k for GPT-5.6 and GPT-6.1 Sol on an
// API key (under the 272k API long-context price tier), ~450k on 500k targets.
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

function isGpt56Model(modelId: string): boolean {
  return /^gpt-5\.6(?:-|$)/i.test(modelId);
}

function isGpt61SolModel(modelId: string): boolean {
  return /^gpt-6\.1-sol(?:-|$)/i.test(modelId);
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
  if (isGpt56Model(modelId) || isGpt61SolModel(modelId)) {
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

export function getConfiguredBaseThresholdForModel(
  config: vscode.WorkspaceConfiguration,
  modelId: string,
  capabilities?: CondenseWindowCapabilities,
): number {
  const overrides = getModelCondenseThresholdMap(config);
  return getEffectiveAutoCondenseThreshold(modelId, overrides, capabilities);
}

export function getModelCondenseThresholdMap(
  config: vscode.WorkspaceConfiguration,
): ModelCondenseThresholdMap {
  return normalizeModelThresholdMap(
    getUserSessionPreference(config, MODEL_THRESHOLD_KEY),
  );
}
