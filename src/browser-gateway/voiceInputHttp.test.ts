import { describe, expect, it } from "vitest";

import { MAX_BROWSER_VOICE_AUDIO_BYTES } from "../shared/voiceInputProtocol.js";
import { decodeVoiceTranscribeBody } from "./voiceInputHttp.js";

describe("decodeVoiceTranscribeBody", () => {
  it("decodes base64 audio with an audio MIME type", () => {
    const result = decodeVoiceTranscribeBody({
      audio: Buffer.from([1, 2, 3]).toString("base64"),
      mimeType: "audio/webm;codecs=opus",
    });

    expect(result).toEqual({
      ok: true,
      audio: {
        data: new Uint8Array([1, 2, 3]),
        mimeType: "audio/webm;codecs=opus",
      },
    });
  });

  it.each([
    null,
    {},
    { audio: "AQID", mimeType: "video/webm" },
    { audio: "", mimeType: "audio/wav" },
    { audio: "not base64!", mimeType: "audio/wav" },
  ])("rejects malformed bodies: %j", (body) => {
    expect(decodeVoiceTranscribeBody(body)).toEqual({
      ok: false,
      status: 400,
      error: "invalid_request",
    });
  });

  it("rejects oversized uploads before decoding", () => {
    expect(
      decodeVoiceTranscribeBody({
        audio: "A".repeat(Math.ceil(MAX_BROWSER_VOICE_AUDIO_BYTES / 3) * 4 + 4),
        mimeType: "audio/webm",
      }),
    ).toEqual({ ok: false, status: 413, error: "audio_too_large" });
  });
});
