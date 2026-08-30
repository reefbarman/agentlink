import * as vscode from "vscode";

import {
  isCoreReasoningEffort,
  type CoreReasoningEffort,
} from "@agentlink/protocol/model-catalog";

export const FALLBACK_REASONING_EFFORT: CoreReasoningEffort = "high";

export type ModeReasoningEffortPreferences = Record<
  string,
  CoreReasoningEffort
>;

export function getModeReasoningEffortPreferences(
  config: vscode.WorkspaceConfiguration,
): ModeReasoningEffortPreferences {
  const raw = config.get<unknown>("modeReasoningEffortPreferences");
  if (!raw || typeof raw !== "object") return {};

  const preferences: ModeReasoningEffortPreferences = {};
  for (const [mode, effort] of Object.entries(raw as Record<string, unknown>)) {
    const trimmedMode = mode.trim();
    if (!trimmedMode || !isCoreReasoningEffort(effort)) continue;
    preferences[trimmedMode] = effort;
  }

  return preferences;
}

export function resolveReasoningEffortForMode(
  config: vscode.WorkspaceConfiguration,
  mode: string,
  fallbackEffort: CoreReasoningEffort = FALLBACK_REASONING_EFFORT,
): CoreReasoningEffort {
  return getModeReasoningEffortPreferences(config)[mode] ?? fallbackEffort;
}
