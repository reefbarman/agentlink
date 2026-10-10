/**
 * Portable voice activity detection for dictation. Feeds on mono 16-bit PCM
 * frames and reports a meter level, utterance segments cut at natural pauses
 * (so they can be transcribed while the user keeps talking), and an auto-stop
 * signal once the speaker has gone quiet. Energy-based with an adaptive noise
 * floor: no model, no dependencies, and identical in Node and the browser.
 */

export interface VoiceActivityOptions {
  sampleRate: number;
  /** Silence that ends one utterance segment. */
  pauseMs?: number;
  /** Silence after speech that ends the dictation; 0 disables auto-stop. */
  autoStopMs?: number;
  /** Ends a dictation that never hears speech; 0 disables. */
  noSpeechTimeoutMs?: number;
  /** Continuous speech needed before a burst counts as talking. */
  minSpeechMs?: number;
  /** Long monologues are cut here even without a pause. */
  maxSegmentMs?: number;
  /** Audio kept before speech starts so first syllables are not clipped. */
  prefixPaddingMs?: number;
}

export interface VoiceActivityResult {
  /** Meter level in [0, 1]. */
  level: number;
  /** A finished utterance, ready to transcribe. */
  segment?: Int16Array;
  /** True once, when the dictation should end by itself. */
  autoStop?: boolean;
}

export const DEFAULT_VOICE_PAUSE_MS = 700;
const MIN_SPEECH_RMS = 0.006;
const NOISE_FLOOR_MULTIPLIER = 2.5;
const RELEASE_RATIO = 0.7;
const SHORT_BURST_RESET_MS = 300;

export class VoiceActivitySegmenter {
  private readonly sampleRate: number;
  private readonly pauseMs: number;
  private readonly autoStopMs: number;
  private readonly noSpeechTimeoutMs: number;
  private readonly minSpeechMs: number;
  private readonly maxSegmentSamples: number;
  private readonly prefixSamples: number;

  private pending: Int16Array[] = [];
  private pendingSamples = 0;
  // Seeded low so a user who starts talking immediately is still heard.
  private noiseFloor = MIN_SPEECH_RMS / NOISE_FLOOR_MULTIPLIER;
  private speaking = false;
  private speechMs = 0;
  private silenceMs = 0;
  private segmentHasSpeech = false;
  private heardSpeech = false;
  private elapsedMs = 0;
  private autoStopped = false;
  private peakSample = 0;

  constructor(options: VoiceActivityOptions) {
    this.sampleRate = options.sampleRate;
    this.pauseMs = options.pauseMs ?? DEFAULT_VOICE_PAUSE_MS;
    this.autoStopMs = options.autoStopMs ?? 0;
    this.noSpeechTimeoutMs = options.noSpeechTimeoutMs ?? 0;
    this.minSpeechMs = options.minSpeechMs ?? 200;
    this.maxSegmentSamples = Math.round(
      ((options.maxSegmentMs ?? 25_000) / 1000) * this.sampleRate,
    );
    this.prefixSamples = Math.round(
      ((options.prefixPaddingMs ?? 300) / 1000) * this.sampleRate,
    );
  }

  /** Largest absolute sample seen; 0 means the input was digital silence. */
  get peak(): number {
    return this.peakSample;
  }

  /** True once any speech has been detected in this dictation. */
  get hasHeardSpeech(): boolean {
    return this.heardSpeech;
  }

  push(frame: Int16Array): VoiceActivityResult {
    if (frame.length === 0) return { level: 0 };
    const frameMs = (frame.length / this.sampleRate) * 1000;
    this.elapsedMs += frameMs;

    let sumSquares = 0;
    for (let index = 0; index < frame.length; index += 1) {
      const sample = frame[index]!;
      const magnitude = sample < 0 ? -sample : sample;
      if (magnitude > this.peakSample) this.peakSample = magnitude;
      const normalized = sample / 32768;
      sumSquares += normalized * normalized;
    }
    const rms = Math.sqrt(sumSquares / frame.length);
    this.updateNoiseFloor(rms, this.speaking);

    const threshold = Math.max(
      MIN_SPEECH_RMS,
      this.noiseFloor * NOISE_FLOOR_MULTIPLIER,
    );
    const isSpeech = this.speaking
      ? rms >= threshold * RELEASE_RATIO
      : rms >= threshold;
    this.speaking = isSpeech;

    if (isSpeech) {
      this.speechMs += frameMs;
      this.silenceMs = 0;
      if (this.speechMs >= this.minSpeechMs) {
        this.segmentHasSpeech = true;
        this.heardSpeech = true;
      }
    } else {
      this.silenceMs += frameMs;
      if (!this.segmentHasSpeech && this.silenceMs >= SHORT_BURST_RESET_MS) {
        this.speechMs = 0;
      }
    }

    this.pending.push(frame);
    this.pendingSamples += frame.length;

    const result: VoiceActivityResult = { level: meterLevel(rms) };
    if (this.segmentHasSpeech) {
      if (
        this.silenceMs >= this.pauseMs ||
        this.pendingSamples >= this.maxSegmentSamples
      ) {
        result.segment = this.takePending();
      }
    } else if (this.speechMs === 0) {
      this.trimLeadingSilence();
    }

    if (!this.autoStopped && this.shouldAutoStop()) {
      this.autoStopped = true;
      result.autoStop = true;
    }
    return result;
  }

  /** Returns trailing audio that still holds speech, if any. */
  flush(): Int16Array | null {
    const hasSpeech = this.segmentHasSpeech || this.speechMs > 0;
    const pending = this.takePending();
    return hasSpeech && pending.length > 0 ? pending : null;
  }

  private shouldAutoStop(): boolean {
    if (this.heardSpeech) {
      return this.autoStopMs > 0 && this.silenceMs >= this.autoStopMs;
    }
    return (
      this.noSpeechTimeoutMs > 0 && this.elapsedMs >= this.noSpeechTimeoutMs
    );
  }

  private updateNoiseFloor(rms: number, speaking: boolean): void {
    // Falls quickly to quiet frames and rises slowly, much more slowly while
    // talking, so sustained speech is not absorbed into the floor.
    this.noiseFloor =
      rms < this.noiseFloor
        ? this.noiseFloor * 0.7 + rms * 0.3
        : this.noiseFloor +
          (rms - this.noiseFloor) * (speaking ? 0.0002 : 0.002);
    this.noiseFloor = Math.max(this.noiseFloor, 1e-5);
  }

  private trimLeadingSilence(): void {
    while (
      this.pending.length > 1 &&
      this.pendingSamples - this.pending[0]!.length >= this.prefixSamples
    ) {
      this.pendingSamples -= this.pending.shift()!.length;
    }
  }

  private takePending(): Int16Array {
    const merged = new Int16Array(this.pendingSamples);
    let offset = 0;
    for (const frame of this.pending) {
      merged.set(frame, offset);
      offset += frame.length;
    }
    this.pending = [];
    this.pendingSamples = 0;
    this.segmentHasSpeech = false;
    this.speechMs = 0;
    return merged;
  }
}

/** Perceptual meter curve: quiet speech still moves the meter visibly. */
function meterLevel(rms: number): number {
  return Math.min(1, Math.sqrt(rms / 0.12));
}

/** Converts Float32 [-1, 1] audio to 16-bit PCM at `targetRate`. */
export function resampleToPcm16(
  input: Float32Array,
  inputRate: number,
  targetRate: number,
): Int16Array {
  const ratio = inputRate / targetRate;
  const length = Math.floor(input.length / ratio);
  const output = new Int16Array(length);
  for (let index = 0; index < length; index += 1) {
    // Average the source window to low-pass before decimating.
    const start = Math.floor(index * ratio);
    const end = Math.min(
      input.length,
      Math.max(start + 1, Math.floor((index + 1) * ratio)),
    );
    let sum = 0;
    for (let source = start; source < end; source += 1) sum += input[source]!;
    const value = Math.max(-1, Math.min(1, sum / (end - start)));
    output[index] = value < 0 ? value * 32768 : value * 32767;
  }
  return output;
}
