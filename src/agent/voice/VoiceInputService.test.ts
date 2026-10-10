import type { transcribeCodexAudio } from "@agentlink/core/codex";
import { describe, expect, it, vi } from "vitest";

import {
  VOICE_INPUT_MAX_DURATION_SECONDS,
  VoiceInputService,
  getBundledRecorderUnavailableReason,
  type StartVoiceCapture,
  type VoiceInputServiceOptions,
} from "./VoiceInputService.js";
import { encodeWavPcm16 } from "./wavEncoding.js";

function createService(overrides: Partial<VoiceInputServiceOptions> = {}) {
  const capture = {
    finish: vi.fn(async () => ({
      pcm: new Int16Array(16_000).fill(120),
      sampleRate: 16_000,
    })),
    cancel: vi.fn(),
  };
  const startCapture = vi.fn<StartVoiceCapture>(async () => capture);
  const transcribe = vi.fn<typeof transcribeCodexAudio>(async () => ({
    text: "open the readme",
    method: "oauth",
  }));
  const credentialProvider = { resolveAuth: vi.fn(async () => null) };
  const service = new VoiceInputService({
    hasCodexSubscription: async () => true,
    credentialProvider,
    recorderUnavailableReason: () => null,
    startCapture,
    transcribe,
    ...overrides,
  });
  return { service, capture, startCapture, transcribe, credentialProvider };
}

describe("VoiceInputService", () => {
  it("hides voice input without a ChatGPT/Codex subscription", async () => {
    const { service, startCapture } = createService({
      hasCodexSubscription: async () => false,
    });

    await expect(service.getAvailability()).resolves.toMatchObject({
      available: false,
      hidden: true,
    });
    await expect(service.start("pane")).rejects.toThrow(/subscription/);
    expect(startCapture).not.toHaveBeenCalled();
  });

  it("shows but disables voice input when the recorder is unavailable", async () => {
    const { service } = createService({
      recorderUnavailableReason: () => "No recorder here.",
    });

    await expect(service.getAvailability()).resolves.toEqual({
      available: false,
      hidden: false,
      reason: "No recorder here.",
    });
    await expect(
      service.getAvailability({ requireRecorder: false }),
    ).resolves.toEqual({ available: true });
  });

  it("records, encodes WAV, and transcribes with the Codex credential", async () => {
    const { service, startCapture, transcribe, credentialProvider } =
      createService();

    await service.start("pane-a");
    await expect(service.finish("pane-a")).resolves.toBe("open the readme");

    expect(startCapture).toHaveBeenCalledWith({
      maxSamples: VOICE_INPUT_MAX_DURATION_SECONDS * 16_000,
    });
    const request = transcribe.mock.calls[0]![0];
    expect(request.credentialProvider).toBe(credentialProvider);
    expect(request.audio.mimeType).toBe("audio/wav");
    expect(request.audio.data.byteLength).toBe(44 + 16_000 * 2);
  });

  it("skips transcription for a near-silent tap", async () => {
    const { service, capture, transcribe } = createService();
    capture.finish.mockResolvedValueOnce({
      pcm: new Int16Array(100),
      sampleRate: 16_000,
    });

    await service.start("pane");
    await expect(service.finish("pane")).resolves.toBe("");
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("reports an all-zero recording as a microphone access problem", async () => {
    const { service, capture, transcribe } = createService();
    capture.finish.mockResolvedValueOnce({
      pcm: new Int16Array(16_000),
      sampleRate: 16_000,
    });

    await service.start("pane");
    await expect(service.finish("pane")).rejects.toThrow(/only silence/);
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("lets a new owner replace an active capture and ignores stale finishes", async () => {
    const { service, capture } = createService();

    await service.start("pane-a");
    await service.start("pane-b");

    expect(capture.cancel).toHaveBeenCalledTimes(1);
    await expect(service.finish("pane-a")).rejects.toThrow(/no longer active/);
    service.cancel("pane-a");
    expect(capture.cancel).toHaveBeenCalledTimes(1);
    service.cancel("pane-b");
    expect(capture.cancel).toHaveBeenCalledTimes(2);
  });

  it("transcribes uploaded browser audio without requiring a local recorder", async () => {
    const { service, transcribe } = createService({
      recorderUnavailableReason: () => "No recorder here.",
    });
    const audio = { data: new Uint8Array([1, 2]), mimeType: "audio/webm" };

    await expect(service.transcribeAudio(audio)).resolves.toBe(
      "open the readme",
    );
    expect(transcribe.mock.calls[0]![0].audio).toBe(audio);
    expect(transcribe.mock.calls[0]![0]).not.toHaveProperty("fetch");
  });

  it("uploads with the host-supplied fetch instead of the global fetch", async () => {
    const hostFetch = vi.fn<typeof globalThis.fetch>();
    const { service, transcribe } = createService({ fetch: hostFetch });

    await service.start("pane-a");
    await service.finish("pane-a");

    expect(transcribe.mock.calls[0]![0].fetch).toBe(hostFetch);
  });
});

describe("getBundledRecorderUnavailableReason", () => {
  it("rejects platforms pvrecorder does not ship for", () => {
    expect(
      getBundledRecorderUnavailableReason("/ext", "linux", "arm64"),
    ).toMatch(/not supported on linux-arm64/);
  });

  it("reports a build without the staged recorder", () => {
    expect(
      getBundledRecorderUnavailableReason("/does/not/exist", "darwin", "arm64"),
    ).toMatch(/missing/);
  });
});

describe("encodeWavPcm16", () => {
  it("writes a mono 16-bit PCM RIFF header and little-endian samples", () => {
    const bytes = encodeWavPcm16(new Int16Array([1, -2]), 16_000);
    const view = new DataView(bytes.buffer);
    const ascii = (offset: number) =>
      String.fromCharCode(...bytes.slice(offset, offset + 4));

    expect(ascii(0)).toBe("RIFF");
    expect(view.getUint32(4, true)).toBe(40);
    expect(ascii(8)).toBe("WAVE");
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(ascii(36)).toBe("data");
    expect(view.getUint32(40, true)).toBe(4);
    expect(view.getInt16(44, true)).toBe(1);
    expect(view.getInt16(46, true)).toBe(-2);
  });
});
