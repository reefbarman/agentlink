import {
  MAX_BROWSER_VOICE_AUDIO_BYTES,
  type VoiceTranscribeRequest,
} from "../shared/voiceInputProtocol.js";

export type DecodedVoiceTranscribeBody =
  | { ok: true; audio: { data: Uint8Array; mimeType: string } }
  | { ok: false; status: 400 | 413; error: string };

const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/u;

/** Validates and decodes a browser `/transcribe` JSON body. */
export function decodeVoiceTranscribeBody(
  body: unknown,
): DecodedVoiceTranscribeBody {
  const request = body as Partial<VoiceTranscribeRequest> | null;
  const mimeType =
    typeof request?.mimeType === "string" ? request.mimeType.trim() : "";
  const encoded = typeof request?.audio === "string" ? request.audio : "";
  if (!/^audio\/[a-z0-9.+-]+(;.*)?$/iu.test(mimeType) || !encoded) {
    return { ok: false, status: 400, error: "invalid_request" };
  }
  if (encoded.length > Math.ceil(MAX_BROWSER_VOICE_AUDIO_BYTES / 3) * 4) {
    return { ok: false, status: 413, error: "audio_too_large" };
  }
  if (!BASE64_PATTERN.test(encoded)) {
    return { ok: false, status: 400, error: "invalid_request" };
  }
  const data = new Uint8Array(Buffer.from(encoded, "base64"));
  if (data.byteLength === 0) {
    return { ok: false, status: 400, error: "invalid_request" };
  }
  return { ok: true, audio: { data, mimeType } };
}
