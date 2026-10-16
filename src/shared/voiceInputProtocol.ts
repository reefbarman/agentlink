/**
 * Browser voice input wire contract shared by the browser app, the VS Code
 * bridge, and the Ask Agent helper. Audio is recorded on the browser device
 * and uploaded as base64 JSON so it survives the helper proxy and relay.
 */

/** Upload ceiling for one recorded clip (decoded bytes). */
export const MAX_BROWSER_VOICE_AUDIO_BYTES = 20 * 1024 * 1024;

/** Browser recordings stop automatically after this many seconds. */
export const BROWSER_VOICE_MAX_DURATION_SECONDS = 600;

/** User-tunable dictation behavior, published with availability. */
export interface VoiceInputPreferences {
  /** Silence after speech that ends dictation; 0 disables auto-stop. */
  autoStopAfterSilenceMs: number;
  /** Sends the message when dictation finishes on its own or on release. */
  autoSend: boolean;
}

export const DEFAULT_VOICE_INPUT_PREFERENCES: VoiceInputPreferences = {
  autoStopAfterSilenceMs: 2000,
  autoSend: false,
};

/** Ends a dictation that hears no speech, when auto-stop is enabled. */
export const VOICE_INPUT_NO_SPEECH_TIMEOUT_MS = 10_000;

/** Normalizes untrusted preference values into safe bounds. */
export function normalizeVoiceInputPreferences(
  value: Partial<VoiceInputPreferences> | undefined,
): VoiceInputPreferences {
  const raw = Number(value?.autoStopAfterSilenceMs);
  return {
    autoStopAfterSilenceMs: Number.isFinite(raw)
      ? Math.min(10_000, Math.max(0, Math.round(raw)))
      : DEFAULT_VOICE_INPUT_PREFERENCES.autoStopAfterSilenceMs,
    autoSend: value?.autoSend === true,
  };
}

/** Live dictation feedback pushed from a recording host to its composer. */
export type VoiceInputLiveEvent =
  | { kind: "partial"; text: string }
  | { kind: "level"; level: number }
  | { kind: "autoStop" };

export interface VoiceInputAvailabilityResponse {
  available: boolean;
  /** True when the user has no ChatGPT/Codex subscription for dictation. */
  hidden?: boolean;
  reason?: string;
  preferences?: VoiceInputPreferences;
}

export interface VoiceTranscribeRequest {
  /** Base64-encoded audio bytes. */
  audio: string;
  mimeType: string;
}

export interface VoiceTranscribeResponse {
  ok: boolean;
  text?: string;
  error?: string;
}
