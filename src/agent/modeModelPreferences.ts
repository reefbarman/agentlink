import type * as vscode from "vscode";

import { CODEX_DEFAULT_MODEL } from "@agentlink/core/codex";

export const FALLBACK_AGENT_MODEL = CODEX_DEFAULT_MODEL;

export type ModeModelPreferences = Record<string, string>;

export function getModeModelPreferences(
  config: vscode.WorkspaceConfiguration,
): ModeModelPreferences {
  const raw = config.get<unknown>("modeModelPreferences");
  if (!raw || typeof raw !== "object") return {};

  const prefs: ModeModelPreferences = {};
  for (const [mode, model] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof model !== "string") continue;
    const trimmedMode = mode.trim();
    const trimmedModel = model.trim();
    if (!trimmedMode || !trimmedModel) continue;
    prefs[trimmedMode] = trimmedModel;
  }

  return prefs;
}

export function resolveModelForMode(
  config: vscode.WorkspaceConfiguration,
  mode: string,
  fallbackModel: string = FALLBACK_AGENT_MODEL,
): string {
  const prefs = getModeModelPreferences(config);
  const preferredModel = prefs[mode]?.trim();
  return preferredModel || fallbackModel;
}
