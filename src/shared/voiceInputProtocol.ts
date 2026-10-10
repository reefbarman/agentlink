/**
 * Browser voice input wire contract shared by the browser app, the VS Code
 * bridge, and the Ask Agent helper. Audio is recorded on the browser device
 * and uploaded as base64 JSON so it survives the helper proxy and relay.
 */

/** Upload ceiling for one recorded clip (decoded bytes). */
export const MAX_BROWSER_VOICE_AUDIO_BYTES = 20 * 1024 * 1024;

/** Browser recordings stop automatically after this many seconds. */
export const BROWSER_VOICE_MAX_DURATION_SECONDS = 600;

export interface VoiceInputAvailabilityResponse {
  available: boolean;
  /** True when the user has no ChatGPT/Codex subscription for dictation. */
  hidden?: boolean;
  reason?: string;
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
