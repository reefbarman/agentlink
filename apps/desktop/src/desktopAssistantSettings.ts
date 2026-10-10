import {
  DEFAULT_ASSISTANT_ORIGIN,
  normalizeAssistantOrigin,
} from "../../../src/shared/assistantAddress.js";
import {
  parseAssistantCa,
  type PinnedAssistantCa,
} from "./desktopAssistantTrust.js";
import {
  readDesktopPreferences,
  updateDesktopPreferences,
  type DesktopPreferences,
} from "./desktopPreferences.js";

export interface DesktopAssistantConfig {
  readonly origin: string;
  readonly ca?: PinnedAssistantCa;
}

/** What the Settings window shows; never the CA itself. */
export interface DesktopAssistantSettings {
  readonly origin: string;
  readonly defaultOrigin: string;
  readonly caFingerprint256: string | null;
}

export interface DesktopAssistantSettingsUpdate {
  readonly origin: string;
  /** A CA PEM to pin, `null` to stop pinning, or omitted to keep the current one. */
  readonly caPem?: string | null;
}

export function assistantConfigFrom(
  preferences: DesktopPreferences,
): DesktopAssistantConfig {
  const origin =
    normalizeAssistantOrigin(preferences.assistantOrigin) ??
    DEFAULT_ASSISTANT_ORIGIN;
  let ca: PinnedAssistantCa | undefined;
  try {
    ca = preferences.assistantCaPem
      ? parseAssistantCa(preferences.assistantCaPem)
      : undefined;
  } catch {
    // A damaged stored CA pins nothing; Settings shows none to replace.
    ca = undefined;
  }
  return { origin, ...(ca ? { ca } : {}) };
}

export function assistantSettingsFrom(
  config: DesktopAssistantConfig,
): DesktopAssistantSettings {
  return {
    origin: config.origin,
    defaultOrigin: DEFAULT_ASSISTANT_ORIGIN,
    caFingerprint256: config.ca?.fingerprint256 ?? null,
  };
}

export async function readAssistantConfig(
  preferencesPath: string,
): Promise<DesktopAssistantConfig> {
  return assistantConfigFrom(await readDesktopPreferences(preferencesPath));
}

/** Validate and store an update from the Settings window. */
export async function updateAssistantSettings(
  preferencesPath: string,
  value: unknown,
): Promise<DesktopAssistantConfig> {
  if (!value || typeof value !== "object") {
    throw new Error("assistant_settings_invalid");
  }
  const update = value as DesktopAssistantSettingsUpdate;
  const origin = normalizeAssistantOrigin(update.origin);
  if (!origin) throw new Error("assistant_origin_invalid");
  const patch: DesktopPreferences = { assistantOrigin: origin };
  if (update.caPem === null) {
    patch.assistantCaPem = null;
  } else if (update.caPem !== undefined) {
    patch.assistantCaPem = parseAssistantCa(update.caPem).pem;
  }
  await updateDesktopPreferences(preferencesPath, patch);
  return await readAssistantConfig(preferencesPath);
}
