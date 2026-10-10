import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "preact/hooks";

import type { ComposerVoiceInput } from "../../agent/webview/components/composerVoiceInput";
import {
  BROWSER_VOICE_MAX_DURATION_SECONDS,
  MAX_BROWSER_VOICE_AUDIO_BYTES,
  type VoiceInputAvailabilityResponse,
  type VoiceTranscribeResponse,
} from "../../shared/voiceInputProtocol";

const PREFERRED_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "audio/ogg;codecs=opus",
];

export interface BrowserVoiceEndpoints {
  availabilityPath: string;
  transcribePath: string;
}

/** Explains why this page cannot record, or null when it can. */
export function getBrowserRecordingUnavailableReason(
  env: {
    isSecureContext?: boolean;
    hasGetUserMedia: boolean;
    hasMediaRecorder: boolean;
  } = {
    isSecureContext: globalThis.isSecureContext,
    hasGetUserMedia: Boolean(globalThis.navigator?.mediaDevices?.getUserMedia),
    hasMediaRecorder: typeof globalThis.MediaRecorder === "function",
  },
): string | null {
  if (env.isSecureContext === false) {
    return "Voice input needs a secure page. Open AgentLink over HTTPS or on localhost to use the microphone.";
  }
  if (!env.hasGetUserMedia || !env.hasMediaRecorder) {
    return "This browser cannot record audio.";
  }
  return null;
}

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder.isTypeSupported !== "function") return undefined;
  return PREFERRED_MIME_TYPES.find((type) =>
    MediaRecorder.isTypeSupported(type),
  );
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
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
  recorder: MediaRecorder;
  stream: MediaStream;
  chunks: Blob[];
  stopped: Promise<void>;
  limitTimer: ReturnType<typeof setTimeout>;
}

/**
 * Browser and Desktop dictation: records on this device with MediaRecorder
 * and uploads the clip to the owning host for ChatGPT/Codex transcription.
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

  const release = useCallback((recording: ActiveRecording) => {
    clearTimeout(recording.limitTimer);
    for (const track of recording.stream.getTracks()) track.stop();
  }, []);

  const start = useCallback(async () => {
    if (activeRef.current) return;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
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
    const mimeType = pickMimeType();
    const recorder = new MediaRecorder(
      stream,
      mimeType ? { mimeType } : undefined,
    );
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    const stopped = new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
    });
    // Stop capturing at the cap; the clip is kept until finish or cancel.
    const limitTimer = setTimeout(() => {
      if (recorder.state === "recording") recorder.stop();
    }, BROWSER_VOICE_MAX_DURATION_SECONDS * 1000);
    recorder.start(1000);
    activeRef.current = { recorder, stream, chunks, stopped, limitTimer };
  }, []);

  const finish = useCallback(async (): Promise<string> => {
    const recording = activeRef.current;
    if (!recording || !transcribePath) {
      throw new Error("Voice recording is no longer active.");
    }
    activeRef.current = null;
    if (recording.recorder.state !== "inactive") recording.recorder.stop();
    await recording.stopped;
    release(recording);
    const blob = new Blob(recording.chunks, {
      type: recording.recorder.mimeType || "audio/webm",
    });
    if (blob.size === 0) return "";
    if (blob.size > MAX_BROWSER_VOICE_AUDIO_BYTES) {
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
        audio: await blobToBase64(blob),
        mimeType: blob.type,
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
  }, [authToken, release, transcribePath]);

  const cancel = useCallback(() => {
    const recording = activeRef.current;
    if (!recording) return;
    activeRef.current = null;
    if (recording.recorder.state !== "inactive") recording.recorder.stop();
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
    return { disabledReason, start, finish, cancel };
  }, [availability, start, finish, cancel]);
}
