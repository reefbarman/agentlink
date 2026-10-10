import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "preact/hooks";

import type {
  ComposerVoiceInput,
  ComposerVoiceSessionListener,
} from "../../agent/webview/components/composerVoiceInput";
import {
  resampleToPcm16,
  VoiceActivitySegmenter,
} from "../../shared/voiceActivity";
import {
  BROWSER_VOICE_MAX_DURATION_SECONDS,
  DEFAULT_VOICE_INPUT_PREFERENCES,
  MAX_BROWSER_VOICE_AUDIO_BYTES,
  normalizeVoiceInputPreferences,
  VOICE_INPUT_NO_SPEECH_TIMEOUT_MS,
  type VoiceInputAvailabilityResponse,
  type VoiceTranscribeResponse,
} from "../../shared/voiceInputProtocol";
import { encodeWavPcm16 } from "../../shared/wavEncoding";

/** Transcription input rate: small uploads, plenty for speech. */
const TARGET_SAMPLE_RATE = 16_000;
/** ~43 ms at 48 kHz: responsive meter and pause detection. */
const PROCESSOR_BUFFER_SIZE = 2048;
/** Tails shorter than this are breath or clicks, not words. */
const MIN_TAIL_SAMPLES = TARGET_SAMPLE_RATE * 0.3;

export interface BrowserVoiceEndpoints {
  availabilityPath: string;
  transcribePath: string;
}

type AudioContextConstructor = new () => AudioContext;

function getAudioContextConstructor(): AudioContextConstructor | undefined {
  const scope = globalThis as unknown as {
    AudioContext?: AudioContextConstructor;
    webkitAudioContext?: AudioContextConstructor;
  };
  return scope.AudioContext ?? scope.webkitAudioContext;
}

/** Explains why this page cannot record, or null when it can. */
export function getBrowserRecordingUnavailableReason(
  env: {
    isSecureContext?: boolean;
    hasGetUserMedia: boolean;
    hasAudioContext: boolean;
  } = {
    isSecureContext: globalThis.isSecureContext,
    hasGetUserMedia: Boolean(globalThis.navigator?.mediaDevices?.getUserMedia),
    hasAudioContext: Boolean(getAudioContextConstructor()),
  },
): string | null {
  if (env.isSecureContext === false) {
    return "Voice input needs a secure page. Open AgentLink over HTTPS or on localhost to use the microphone.";
  }
  if (!env.hasGetUserMedia || !env.hasAudioContext) {
    return "This browser cannot record audio.";
  }
  return null;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + chunkSize),
    );
  }
  return btoa(binary);
}

interface ActiveRecording {
  stream: MediaStream;
  context: AudioContext;
  source: MediaStreamAudioSourceNode;
  processor: ScriptProcessorNode;
  segmenter: VoiceActivitySegmenter;
  listener: ComposerVoiceSessionListener;
  /** Utterance uploads, kept in order so text lands in speaking order. */
  uploads: Promise<void>;
  error: Error | null;
  segments: number;
  cancelled: boolean;
  limitTimer: ReturnType<typeof setTimeout>;
}

/**
 * Browser and Desktop dictation: records PCM on this device, cuts it into
 * utterances at natural pauses, and uploads each one to the owning host for
 * ChatGPT/Codex transcription while the user keeps talking.
 */
export function useBrowserVoiceInput(options: {
  endpoints: BrowserVoiceEndpoints | null;
  authToken: string;
}): ComposerVoiceInput | undefined {
  const { endpoints, authToken } = options;
  const [availability, setAvailability] =
    useState<VoiceInputAvailabilityResponse | null>(null);
  const activeRef = useRef<ActiveRecording | null>(null);
  const availabilityPath = endpoints?.availabilityPath;
  const transcribePath = endpoints?.transcribePath;
  const preferences = useMemo(
    () =>
      normalizeVoiceInputPreferences(
        availability?.preferences ?? DEFAULT_VOICE_INPUT_PREFERENCES,
      ),
    [availability],
  );

  useEffect(() => {
    if (!availabilityPath) {
      setAvailability(null);
      return;
    }
    let cancelled = false;
    const refresh = () => {
      void fetch(availabilityPath, {
        credentials: "same-origin",
        headers: { Authorization: `Bearer ${authToken}` },
      })
        .then(async (response) =>
          response.ok
            ? ((await response.json()) as VoiceInputAvailabilityResponse)
            : null,
        )
        .catch(() => null)
        .then((next) => {
          if (!cancelled) setAvailability(next);
        });
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", refresh);
    };
  }, [availabilityPath, authToken]);

  const transcribe = useCallback(
    async (pcm: Int16Array): Promise<string> => {
      if (!transcribePath) throw new Error("Voice input is unavailable.");
      const wav = encodeWavPcm16(pcm, TARGET_SAMPLE_RATE);
      if (wav.length > MAX_BROWSER_VOICE_AUDIO_BYTES) {
        throw new Error("The recording is too long to transcribe.");
      }
      const response = await fetch(transcribePath, {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          audio: bytesToBase64(wav),
          mimeType: "audio/wav",
        }),
      });
      const body = (await response
        .json()
        .catch(() => ({}))) as Partial<VoiceTranscribeResponse>;
      if (!response.ok || !body.ok) {
        throw new Error(
          body.error ?? `Transcription failed (HTTP ${response.status})`,
        );
      }
      return body.text ?? "";
    },
    [authToken, transcribePath],
  );

  const release = useCallback((recording: ActiveRecording) => {
    clearTimeout(recording.limitTimer);
    recording.processor.onaudioprocess = null;
    recording.source.disconnect();
    recording.processor.disconnect();
    for (const track of recording.stream.getTracks()) track.stop();
    void recording.context.close().catch(() => undefined);
  }, []);

  const enqueue = useCallback(
    (recording: ActiveRecording, pcm: Int16Array) => {
      recording.segments += 1;
      recording.uploads = recording.uploads.then(async () => {
        if (recording.cancelled || recording.error) return;
        try {
          const text = await transcribe(pcm);
          if (!recording.cancelled && text.trim()) {
            recording.listener.onPartial(text);
          }
        } catch (error) {
          recording.error =
            error instanceof Error ? error : new Error(String(error));
        }
      });
    },
    [transcribe],
  );

  const start = useCallback(
    async (listener: ComposerVoiceSessionListener) => {
      if (activeRef.current) return;
      const AudioContextCtor = getAudioContextConstructor();
      if (!AudioContextCtor)
        throw new Error("This browser cannot record audio.");
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
      } catch (error) {
        const name = (error as { name?: string } | null)?.name;
        if (name === "NotAllowedError" || name === "SecurityError") {
          throw new Error(
            "Microphone access was blocked. Allow this page to use the microphone and try again.",
            { cause: error },
          );
        }
        if (name === "NotFoundError") {
          throw new Error("No microphone was found.", { cause: error });
        }
        throw error;
      }
      const context = new AudioContextCtor();
      if (context.state === "suspended") {
        await context.resume().catch(() => undefined);
      }
      const source = context.createMediaStreamSource(stream);
      // ScriptProcessor is deprecated but universally available, including
      // embedded Chromium hosts, and needs no separate worklet module.
      const processor = context.createScriptProcessor(
        PROCESSOR_BUFFER_SIZE,
        1,
        1,
      );
      const autoStopMs = preferences.autoStopAfterSilenceMs;
      const recording: ActiveRecording = {
        stream,
        context,
        source,
        processor,
        segmenter: new VoiceActivitySegmenter({
          sampleRate: TARGET_SAMPLE_RATE,
          autoStopMs,
          noSpeechTimeoutMs:
            autoStopMs > 0 ? VOICE_INPUT_NO_SPEECH_TIMEOUT_MS : 0,
        }),
        listener,
        uploads: Promise.resolve(),
        error: null,
        segments: 0,
        cancelled: false,
        // At the cap, ask the composer to finish like an auto-stop.
        limitTimer: setTimeout(() => {
          if (activeRef.current === recording) listener.onAutoStop();
        }, BROWSER_VOICE_MAX_DURATION_SECONDS * 1000),
      };
      processor.onaudioprocess = (event) => {
        if (activeRef.current !== recording) return;
        const pcm = resampleToPcm16(
          event.inputBuffer.getChannelData(0),
          context.sampleRate,
          TARGET_SAMPLE_RATE,
        );
        const result = recording.segmenter.push(pcm);
        listener.onLevel(result.level);
        if (result.segment) enqueue(recording, result.segment);
        if (result.autoStop) listener.onAutoStop();
      };
      source.connect(processor);
      // The processor only runs while connected; it outputs silence.
      processor.connect(context.destination);
      activeRef.current = recording;
    },
    [enqueue, preferences.autoStopAfterSilenceMs],
  );

  const finish = useCallback(async (): Promise<string> => {
    const recording = activeRef.current;
    if (!recording) throw new Error("Voice recording is no longer active.");
    activeRef.current = null;
    release(recording);
    const tail = recording.segmenter.flush();
    await recording.uploads;
    if (recording.error) throw recording.error;
    if (recording.segmenter.peak === 0 && recording.segments === 0) {
      throw new Error(
        "The microphone recorded only silence. Check that this page is allowed to use the microphone.",
      );
    }
    if (!tail || tail.length < MIN_TAIL_SAMPLES) return "";
    return await transcribe(tail);
  }, [release, transcribe]);

  const cancel = useCallback(() => {
    const recording = activeRef.current;
    if (!recording) return;
    activeRef.current = null;
    recording.cancelled = true;
    release(recording);
  }, [release]);

  // Never leave the microphone open when the target changes or unmounts.
  useEffect(() => cancel, [cancel, transcribePath]);

  return useMemo<ComposerVoiceInput | undefined>(() => {
    if (!availability) return undefined;
    if (!availability.available && availability.hidden) return undefined;
    const disabledReason = availability.available
      ? (getBrowserRecordingUnavailableReason() ?? undefined)
      : (availability.reason ?? "Voice input is unavailable.");
    return {
      disabledReason,
      autoSend: preferences.autoSend,
      start,
      finish,
      cancel,
    };
  }, [availability, preferences.autoSend, start, finish, cancel]);
}
