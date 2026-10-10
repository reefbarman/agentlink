import { existsSync } from "node:fs";
import * as path from "node:path";
import { Worker } from "node:worker_threads";

import {
  transcribeCodexAudio,
  type CodexCredentialProvider,
  type CodexTranscriptionAudio,
} from "@agentlink/core/codex";

import type {
  VoiceRecorderWorkerCommand,
  VoiceRecorderWorkerData,
  VoiceRecorderWorkerReply,
} from "./voiceRecorderProtocol.js";
import { encodeWavPcm16 } from "../../shared/wavEncoding.js";
import {
  DEFAULT_VOICE_INPUT_PREFERENCES,
  VOICE_INPUT_NO_SPEECH_TIMEOUT_MS,
  type VoiceInputPreferences,
} from "../../shared/voiceInputProtocol.js";

/** Ten minutes of 16 kHz PCM is about 19 MB of WAV, under the 25 MB limit. */
export const VOICE_INPUT_MAX_DURATION_SECONDS = 600;
const RECORDER_SAMPLE_RATE = 16_000;
const MIN_TRANSCRIBABLE_SAMPLES = RECORDER_SAMPLE_RATE / 4;

export type VoiceInputAvailability =
  | { available: true; preferences: VoiceInputPreferences }
  | {
      available: false;
      /** Hidden when the user has no ChatGPT/Codex subscription. */
      hidden: boolean;
      reason: string;
    };

export interface CapturedVoiceAudio {
  pcm: Int16Array;
  sampleRate: number;
}

export interface VoiceCapture {
  /** Resolves with audio not yet emitted as a segment, plus the peak. */
  finish(): Promise<CapturedVoiceAudio & { peak: number }>;
  cancel(): void;
}

export type StartVoiceCapture = (options: {
  maxSamples: number;
  autoStopMs: number;
  noSpeechTimeoutMs: number;
  /** An utterance cut at a pause while recording continues. */
  onSegment: (audio: CapturedVoiceAudio) => void;
  onLevel: (level: number) => void;
  onAutoStop: () => void;
}) => Promise<VoiceCapture>;

/** Live feedback for one dictation. */
export interface VoiceSessionListener {
  /** Text for an utterance transcribed while recording continues. */
  onPartial?: (text: string) => void;
  onLevel?: (level: number) => void;
  /** The speaker went quiet; the client decides whether to finish. */
  onAutoStop?: () => void;
}

interface VoiceSession {
  listener: VoiceSessionListener;
  chain: Promise<void>;
  segments: number;
  cancelled: boolean;
  error?: Error;
}

export interface VoiceInputServiceOptions {
  hasCodexSubscription: () => Promise<boolean>;
  credentialProvider: CodexCredentialProvider<undefined>;
  /** Returns a reason when local microphone capture cannot work. */
  recorderUnavailableReason: () => string | null;
  startCapture: StartVoiceCapture;
  transcribe?: typeof transcribeCodexAudio;
  /**
   * HTTP client for transcription uploads. chatgpt.com's Cloudflare edge
   * challenges the default TLS handshake of Electron-hosted Node, so hosts
   * pass a fetch with an accepted TLS configuration.
   */
  fetch?: typeof globalThis.fetch;
  getPreferences?: () => VoiceInputPreferences;
  log?: (message: string) => void;
}

/**
 * Host-side voice input: captures microphone audio off-thread, then
 * transcribes it with the user's ChatGPT/Codex subscription. One capture is
 * active at a time; starting from another owner cancels the previous one.
 */
export class VoiceInputService {
  private active: {
    ownerId: string;
    capture: VoiceCapture;
    session: VoiceSession;
  } | null = null;
  private readonly transcribe: typeof transcribeCodexAudio;

  constructor(private readonly options: VoiceInputServiceOptions) {
    this.transcribe = options.transcribe ?? transcribeCodexAudio;
  }

  async getAvailability(options?: {
    requireRecorder?: boolean;
  }): Promise<VoiceInputAvailability> {
    if (!(await this.options.hasCodexSubscription())) {
      return {
        available: false,
        hidden: true,
        reason: "Sign in with a ChatGPT/Codex subscription to use voice input.",
      };
    }
    if (options?.requireRecorder !== false) {
      const reason = this.options.recorderUnavailableReason();
      if (reason) return { available: false, hidden: false, reason };
    }
    return { available: true, preferences: this.preferences() };
  }

  private preferences(): VoiceInputPreferences {
    return this.options.getPreferences?.() ?? DEFAULT_VOICE_INPUT_PREFERENCES;
  }

  async start(
    ownerId: string,
    listener: VoiceSessionListener = {},
  ): Promise<void> {
    const availability = await this.getAvailability();
    if (!availability.available) throw new Error(availability.reason);
    this.cancel();
    const { autoStopAfterSilenceMs } = availability.preferences;
    const session: VoiceSession = {
      listener,
      chain: Promise.resolve(),
      segments: 0,
      cancelled: false,
    };
    const capture = await this.options.startCapture({
      maxSamples: VOICE_INPUT_MAX_DURATION_SECONDS * RECORDER_SAMPLE_RATE,
      autoStopMs: autoStopAfterSilenceMs,
      noSpeechTimeoutMs:
        autoStopAfterSilenceMs > 0 ? VOICE_INPUT_NO_SPEECH_TIMEOUT_MS : 0,
      onSegment: (audio) => this.queueSegment(session, audio),
      onLevel: (level) => {
        if (!session.cancelled) listener.onLevel?.(level);
      },
      onAutoStop: () => {
        if (!session.cancelled) listener.onAutoStop?.();
      },
    });
    this.active = { ownerId, capture, session };
  }

  /** Transcribes utterances in order while the user keeps talking. */
  private queueSegment(session: VoiceSession, audio: CapturedVoiceAudio): void {
    if (session.cancelled || audio.pcm.length < MIN_TRANSCRIBABLE_SAMPLES) {
      return;
    }
    session.segments += 1;
    session.chain = session.chain.then(async () => {
      if (session.cancelled || session.error) return;
      try {
        const text = await this.transcribeAudio(toWav(audio));
        if (!session.cancelled && text.trim()) {
          session.listener.onPartial?.(text);
        }
      } catch (error) {
        session.error ??=
          error instanceof Error ? error : new Error(String(error));
      }
    });
  }

  /**
   * Stops recording and resolves with the text of the final utterance.
   * Earlier utterances were already delivered through `onPartial`.
   */
  async finish(ownerId: string): Promise<string> {
    const active = this.active;
    if (!active || active.ownerId !== ownerId) {
      throw new Error("Voice recording is no longer active.");
    }
    this.active = null;
    const { session } = active;
    const audio = await active.capture.finish();
    await session.chain;
    if (session.error) throw session.error;
    if (audio.peak === 0 && session.segments === 0) {
      throw new Error(
        "The microphone recorded only silence. Check that VS Code is allowed to use the microphone (macOS: System Settings > Privacy & Security > Microphone).",
      );
    }
    if (audio.pcm.length < MIN_TRANSCRIBABLE_SAMPLES) {
      return "";
    }
    return await this.transcribeAudio(toWav(audio));
  }

  /** Cancels the active capture, or only the owner's capture when given. */
  cancel(ownerId?: string): void {
    const active = this.active;
    if (!active || (ownerId && active.ownerId !== ownerId)) return;
    this.active = null;
    active.session.cancelled = true;
    active.capture.cancel();
  }

  /** Transcribes audio recorded elsewhere, such as in a browser client. */
  async transcribeAudio(audio: CodexTranscriptionAudio): Promise<string> {
    const availability = await this.getAvailability({ requireRecorder: false });
    if (!availability.available) throw new Error(availability.reason);
    const started = Date.now();
    const result = await this.transcribe({
      credentialProvider: this.options.credentialProvider,
      context: undefined,
      audio,
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
    });
    this.options.log?.(
      `[voice-input] transcribed ${audio.data.byteLength} bytes (${audio.mimeType}) in ${Date.now() - started}ms`,
    );
    return result.text;
  }

  dispose(): void {
    this.cancel();
  }
}

function toWav(audio: CapturedVoiceAudio): CodexTranscriptionAudio {
  return {
    data: encodeWavPcm16(audio.pcm, audio.sampleRate),
    mimeType: "audio/wav",
    filename: "voice-input.wav",
  };
}

const VOICE_RECORDER_PLATFORMS = new Set([
  "darwin-arm64",
  "darwin-x64",
  "linux-x64",
  "win32-x64",
  "win32-arm64",
]);

/** Checks that this build staged pvrecorder for the running platform. */
export function getBundledRecorderUnavailableReason(
  extensionPath: string,
  platform = process.platform,
  arch = process.arch,
): string | null {
  if (!VOICE_RECORDER_PLATFORMS.has(`${platform}-${arch}`)) {
    return `Voice input is not supported on ${platform}-${arch}.`;
  }
  const workerPath = path.join(
    extensionPath,
    "dist",
    "voice-recorder-worker.js",
  );
  const packagePath = path.join(
    extensionPath,
    "dist",
    "node_modules",
    "@picovoice",
    "pvrecorder-node",
    "package.json",
  );
  if (!existsSync(workerPath) || !existsSync(packagePath)) {
    return "The voice recorder is missing from this AgentLink build.";
  }
  return null;
}

/** Starts captures in dist/voice-recorder-worker.js worker threads. */
export function createWorkerVoiceCapture(
  workerPath: string,
): StartVoiceCapture {
  return async ({
    maxSamples,
    autoStopMs,
    noSpeechTimeoutMs,
    onSegment,
    onLevel,
    onAutoStop,
  }) => {
    const worker = new Worker(workerPath, {
      workerData: {
        maxSamples,
        autoStopMs,
        noSpeechTimeoutMs,
      } satisfies VoiceRecorderWorkerData,
    });
    let settleFinish:
      | {
          resolve: (audio: CapturedVoiceAudio & { peak: number }) => void;
          reject: (error: Error) => void;
        }
      | undefined;
    let failure: Error | undefined;
    const send = (command: VoiceRecorderWorkerCommand) =>
      worker.postMessage(command);

    await new Promise<void>((resolve, reject) => {
      worker.on("message", (message: VoiceRecorderWorkerReply) => {
        switch (message.type) {
          case "started":
            resolve();
            break;
          case "level":
            onLevel(message.level);
            break;
          case "segment":
            onSegment({
              pcm: new Int16Array(message.pcm),
              sampleRate: message.sampleRate,
            });
            break;
          case "autoStop":
            onAutoStop();
            break;
          case "audio":
            settleFinish?.resolve({
              pcm: new Int16Array(message.pcm),
              sampleRate: message.sampleRate,
              peak: message.peak,
            });
            void worker.terminate();
            break;
          case "cancelled":
            void worker.terminate();
            break;
          case "error":
            failure = new Error(message.message);
            reject(failure);
            settleFinish?.reject(failure);
            void worker.terminate();
            break;
          case "limit":
            break;
        }
      });
      worker.on("error", (error) => {
        failure = error;
        reject(error);
        settleFinish?.reject(error);
      });
      worker.on("exit", () => {
        const exited = failure ?? new Error("The voice recorder stopped.");
        reject(exited);
        settleFinish?.reject(exited);
      });
    });

    return {
      finish: () =>
        new Promise<CapturedVoiceAudio & { peak: number }>(
          (resolve, reject) => {
            if (failure) {
              reject(failure);
              return;
            }
            settleFinish = { resolve, reject };
            send({ type: "finish" });
          },
        ),
      cancel: () => {
        send({ type: "cancel" });
        // Ensure the native recorder is released even if the worker stalls.
        setTimeout(() => void worker.terminate(), 2_000).unref();
      },
    };
  };
}
