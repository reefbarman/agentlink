import { describe, expect, it } from "vitest";

import {
  VoiceActivitySegmenter,
  resampleToPcm16,
  type VoiceActivityResult,
} from "./voiceActivity";

const RATE = 16_000;
const FRAME = 512; // 32 ms

function frame(amplitude: number, seed = 1): Int16Array {
  const out = new Int16Array(FRAME);
  for (let index = 0; index < FRAME; index += 1) {
    out[index] = Math.round(Math.sin((index + seed) / 6) * amplitude);
  }
  return out;
}

const speech = () => frame(6000);
const quiet = () => frame(40);

function feed(
  segmenter: VoiceActivitySegmenter,
  make: () => Int16Array,
  ms: number,
): VoiceActivityResult[] {
  const results: VoiceActivityResult[] = [];
  for (let elapsed = 0; elapsed < ms; elapsed += (FRAME / RATE) * 1000) {
    results.push(segmenter.push(make()));
  }
  return results;
}

describe("VoiceActivitySegmenter", () => {
  it("cuts a segment at a pause and keeps listening", () => {
    const segmenter = new VoiceActivitySegmenter({
      sampleRate: RATE,
      pauseMs: 600,
    });
    feed(segmenter, quiet, 1000);
    expect(feed(segmenter, speech, 1200).some((r) => r.segment)).toBe(false);
    const pause = feed(segmenter, quiet, 800);
    const segments = pause.filter((r) => r.segment);
    expect(segments).toHaveLength(1);
    // Speech plus pre-roll and the pause, without the long leading silence.
    const seconds = segments[0]!.segment!.length / RATE;
    expect(seconds).toBeGreaterThan(1.2);
    expect(seconds).toBeLessThan(2.3);

    feed(segmenter, speech, 500);
    expect(segmenter.flush()?.length).toBeGreaterThan(0);
  });

  it("hears a speaker who starts talking immediately", () => {
    const segmenter = new VoiceActivitySegmenter({
      sampleRate: RATE,
      pauseMs: 600,
    });
    feed(segmenter, speech, 800);
    expect(segmenter.hasHeardSpeech).toBe(true);
    expect(feed(segmenter, quiet, 800).filter((r) => r.segment)).toHaveLength(
      1,
    );
  });

  it("ignores short noise bursts", () => {
    const segmenter = new VoiceActivitySegmenter({
      sampleRate: RATE,
      pauseMs: 600,
    });
    feed(segmenter, quiet, 500);
    feed(segmenter, speech, 64);
    expect(feed(segmenter, quiet, 1500).some((r) => r.segment)).toBe(false);
    expect(segmenter.hasHeardSpeech).toBe(false);
    expect(segmenter.flush()).toBeNull();
  });

  it("auto-stops once after trailing silence", () => {
    const segmenter = new VoiceActivitySegmenter({
      sampleRate: RATE,
      autoStopMs: 1500,
    });
    feed(segmenter, quiet, 300);
    feed(segmenter, speech, 800);
    const before = feed(segmenter, quiet, 1300);
    expect(before.some((r) => r.autoStop)).toBe(false);
    const after = feed(segmenter, quiet, 1000);
    expect(after.filter((r) => r.autoStop)).toHaveLength(1);
  });

  it("does not auto-stop when disabled, but times out without speech", () => {
    const disabled = new VoiceActivitySegmenter({ sampleRate: RATE });
    feed(disabled, speech, 500);
    expect(feed(disabled, quiet, 5000).some((r) => r.autoStop)).toBe(false);

    const silent = new VoiceActivitySegmenter({
      sampleRate: RATE,
      noSpeechTimeoutMs: 2000,
    });
    expect(feed(silent, quiet, 2500).filter((r) => r.autoStop)).toHaveLength(1);
  });

  it("reports meter levels and digital silence", () => {
    const segmenter = new VoiceActivitySegmenter({ sampleRate: RATE });
    expect(segmenter.push(new Int16Array(FRAME)).level).toBe(0);
    expect(segmenter.peak).toBe(0);
    expect(segmenter.push(speech()).level).toBeGreaterThan(0.5);
    expect(segmenter.peak).toBeGreaterThan(5000);
  });

  it("cuts long monologues at the segment cap", () => {
    const segmenter = new VoiceActivitySegmenter({
      sampleRate: RATE,
      maxSegmentMs: 2000,
    });
    expect(
      feed(segmenter, speech, 4500).filter((r) => r.segment).length,
    ).toBeGreaterThanOrEqual(2);
  });
});

describe("resampleToPcm16", () => {
  it("downsamples float audio to 16-bit PCM", () => {
    const input = new Float32Array(48_000).fill(0.5);
    const output = resampleToPcm16(input, 48_000, 16_000);
    expect(output).toHaveLength(16_000);
    expect(output[100]).toBe(Math.trunc(0.5 * 32767));
  });
});
