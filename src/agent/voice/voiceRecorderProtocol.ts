/** Messages exchanged with dist/voice-recorder-worker.js. */

export interface VoiceRecorderWorkerData {
  /** Samples kept before further frames are discarded. */
  maxSamples: number;
  /** Silence after speech that triggers an `autoStop` reply; 0 disables. */
  autoStopMs: number;
  /** Ends a recording that never hears speech; 0 disables. */
  noSpeechTimeoutMs: number;
}

export type VoiceRecorderWorkerCommand =
  | { type: "finish" }
  | { type: "cancel" };

export type VoiceRecorderWorkerReply =
  | { type: "started"; sampleRate: number; device?: string }
  | { type: "limit" }
  /** Throttled meter level in [0, 1]. */
  | { type: "level"; level: number }
  /** A finished utterance, cut at a pause while recording continues. */
  | { type: "segment"; pcm: ArrayBuffer; sampleRate: number }
  | { type: "autoStop" }
  | {
      type: "audio";
      /** Transferred buffer holding the trailing mono 16-bit PCM samples. */
      pcm: ArrayBuffer;
      sampleRate: number;
      /** Largest absolute sample of the whole recording; 0 = silence. */
      peak: number;
    }
  | { type: "cancelled" }
  | {
      type: "error";
      code: "recorder_unavailable" | "microphone_unavailable" | "read_failed";
      message: string;
    };
