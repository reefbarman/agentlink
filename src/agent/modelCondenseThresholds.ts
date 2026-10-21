import * as vscode from "vscode";

import {
  getEffectiveAutoCondenseThreshold,
  normalizeModelThresholdMap,
  type CondenseWindowCapabilities,
  type ModelCondenseThresholdMap,
} from "@agentlink/core/context-condense";

import { getUserSessionPreference } from "./sharedSessionPreferences.js";

// The defaults are shared with SDK hosts (packages/core/src/condenseThresholds.ts);
// only the VS Code setting reader lives here.
export {
  clampCondenseThreshold,
  getDefaultAutoCondenseThreshold,
  getEffectiveAutoCondenseThreshold,
  isAnthropicFrontierModel,
  normalizeModelThresholdMap,
  type ModelCondenseThresholdMap,
} from "@agentlink/core/context-condense";

export const MODEL_THRESHOLD_KEY = "modelCondenseThresholds";

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
