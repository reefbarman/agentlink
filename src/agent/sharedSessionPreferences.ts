import * as vscode from "vscode";

import {
  SessionPreferencesStore,
  type SessionPreferencesPatch,
  type SessionPreferencesSnapshot,
} from "@agentlink/node-host";

export const MODE_MODEL_PREFERENCES_KEY = "modeModelPreferences";
export const MODE_REASONING_EFFORT_PREFERENCES_KEY =
  "modeReasoningEffortPreferences";
export const MODEL_CONDENSE_THRESHOLDS_KEY = "modelCondenseThresholds";
export const DEFAULT_MODE_KEY = "defaultMode";

let sharedPreferences: SessionPreferencesSnapshot | undefined;
let sharedPreferencesStore: SessionPreferencesStore | undefined;

export function initializeSharedSessionPreferences(
  store: SessionPreferencesStore,
  preferences: SessionPreferencesSnapshot,
): void {
  sharedPreferencesStore = store;
  sharedPreferences = preferences;
}

export function resetSharedSessionPreferencesForTesting(): void {
  sharedPreferencesStore = undefined;
  sharedPreferences = undefined;
}

/** Picker defaults come from the host-neutral shared store after activation. */
export function getUserSessionPreference<T>(
  config: vscode.WorkspaceConfiguration,
  key: string,
): T | undefined {
  const hasSharedPreferences = sharedPreferences !== undefined;
  const inspected = config.inspect?.<T>(key);
  const defaults = inspected?.defaultValue;
  const saved = hasSharedPreferences
    ? (getSharedValue(key) as T | undefined)
    : inspected?.globalValue;
  if (!config.inspect && !hasSharedPreferences) return config.get<T>(key);
  if (
    defaults &&
    saved &&
    typeof defaults === "object" &&
    typeof saved === "object" &&
    !Array.isArray(defaults) &&
    !Array.isArray(saved)
  ) {
    return { ...defaults, ...saved };
  }
  return saved ?? defaults;
}

export function getNewSessionMode(fallback = "code"): string {
  return (
    getUserSessionPreference<string>(
      vscode.workspace.getConfiguration("agentlink"),
      DEFAULT_MODE_KEY,
    )?.trim() || fallback
  );
}

export async function writeUserSessionPreference<T>(
  config: vscode.WorkspaceConfiguration,
  key: string,
  value: T,
): Promise<void> {
  const store = sharedPreferencesStore;
  if (!store) {
    await config.update(key, value, vscode.ConfigurationTarget.Global);
    return;
  }
  sharedPreferences = await store.update(preferencePatch(key, value));
}

export async function writeUserSessionPreferenceEntry<T>(
  config: vscode.WorkspaceConfiguration,
  key: string,
  entryKey: string,
  value: T,
): Promise<void> {
  const normalizedKey = entryKey.trim();
  if (!normalizedKey) throw new Error("Shared session preference key is empty");
  const store = sharedPreferencesStore;
  if (!store) {
    const current =
      getUserSessionPreference<Record<string, T>>(config, key) ?? {};
    await config.update(
      key,
      { ...current, [normalizedKey]: value },
      vscode.ConfigurationTarget.Global,
    );
    return;
  }
  sharedPreferences = await store.update(
    preferenceEntryPatch(key, normalizedKey, value),
  );
}

export async function removeUserSessionPreferenceEntry(
  config: vscode.WorkspaceConfiguration,
  key: typeof MODEL_CONDENSE_THRESHOLDS_KEY,
  entryKey: string,
): Promise<void> {
  const normalizedKey = entryKey.trim();
  if (!normalizedKey) throw new Error("Shared session preference key is empty");
  const legacy = {
    ...config.inspect?.<Record<string, number>>(key)?.globalValue,
  };
  if (normalizedKey in legacy) {
    delete legacy[normalizedKey];
    await config.update(key, legacy, true);
  }
  const store = sharedPreferencesStore;
  if (!store) return;
  sharedPreferences = await store.update({
    removeModelCondenseThresholds: [normalizedKey],
  });
}

export async function rememberSessionMode(mode: string): Promise<void> {
  await writeUserSessionPreference(
    vscode.workspace.getConfiguration("agentlink"),
    DEFAULT_MODE_KEY,
    mode,
  );
}

function getSharedValue(key: string): unknown {
  if (!sharedPreferences) return undefined;
  switch (key) {
    case MODE_MODEL_PREFERENCES_KEY:
      return sharedPreferences.modeModels;
    case MODE_REASONING_EFFORT_PREFERENCES_KEY:
      return sharedPreferences.modeReasoningEfforts;
    case MODEL_CONDENSE_THRESHOLDS_KEY:
      return sharedPreferences.modelCondenseThresholds;
    case DEFAULT_MODE_KEY:
      return sharedPreferences.defaultMode;
    default:
      return undefined;
  }
}

function preferencePatch<T>(key: string, value: T): SessionPreferencesPatch {
  switch (key) {
    case MODE_MODEL_PREFERENCES_KEY:
      return {
        modeModels: changedEntries(
          sharedPreferences?.modeModels,
          value as Record<string, string>,
        ),
      };
    case MODE_REASONING_EFFORT_PREFERENCES_KEY:
      return {
        modeReasoningEfforts: changedEntries(
          sharedPreferences?.modeReasoningEfforts,
          value as NonNullable<SessionPreferencesPatch["modeReasoningEfforts"]>,
        ),
      };
    case MODEL_CONDENSE_THRESHOLDS_KEY:
      return {
        modelCondenseThresholds: changedEntries(
          sharedPreferences?.modelCondenseThresholds,
          value as Record<string, number>,
        ),
      };
    case DEFAULT_MODE_KEY:
      return { defaultMode: String(value) };
    default:
      throw new Error(`Unsupported shared session preference: ${key}`);
  }
}

function changedEntries<T>(
  current: Readonly<Record<string, T>> | undefined,
  requested: Readonly<Record<string, T>>,
): Record<string, T> {
  return Object.fromEntries(
    Object.entries(requested).filter(
      ([key, value]) => current?.[key] !== value,
    ),
  );
}

function preferenceEntryPatch<T>(
  key: string,
  entryKey: string,
  value: T,
): SessionPreferencesPatch {
  switch (key) {
    case MODE_MODEL_PREFERENCES_KEY:
      return { modeModels: { [entryKey]: String(value) } };
    case MODE_REASONING_EFFORT_PREFERENCES_KEY:
      return {
        modeReasoningEfforts: {
          [entryKey]: value as NonNullable<
            SessionPreferencesPatch["modeReasoningEfforts"]
          >[string],
        },
      };
    case MODEL_CONDENSE_THRESHOLDS_KEY:
      return { modelCondenseThresholds: { [entryKey]: Number(value) } };
    default:
      throw new Error(`Unsupported shared session preference map: ${key}`);
  }
}
