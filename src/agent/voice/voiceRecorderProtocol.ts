/** Messages exchanged with dist/voice-recorder-worker.js. */

export interface VoiceRecorderWorkerData {
  /** Samples kept before further frames are discarded. */
  maxSamples: number;
}

export type VoiceRecorderWorkerCommand =
  | { type: "finish" }
  | { type: "cancel" };

export type VoiceRecorderWorkerReply =
  | { type: "started"; sampleRate: number; device?: string }
  | { type: "limit" }
  | {
      type: "audio";
      /** Transferred buffer holding mono 16-bit PCM samples. */
      pcm: ArrayBuffer;
      sampleRate: number;
    }
  | { type: "cancelled" }
  | {
      type: "error";
      code: "recorder_unavailable" | "microphone_unavailable" | "read_failed";
      message: string;
    };
