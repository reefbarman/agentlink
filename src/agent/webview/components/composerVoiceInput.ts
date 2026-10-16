import { useCallback, useEffect, useRef, useState } from "preact/hooks";

export type ComposerVoiceStatus =
  | "idle"
  | "starting"
  | "recording"
  | "transcribing";

/** Live feedback a backend reports while a dictation is recording. */
export interface ComposerVoiceSessionListener {
  /** An utterance transcribed while the user keeps talking. */
  onPartial: (text: string) => void;
  /** Meter level in [0, 1]. */
  onLevel: (level: number) => void;
  /** The speaker went quiet long enough to finish. */
  onAutoStop: () => void;
}

/**
 * Surface-supplied voice backend. VS Code records on the extension host;
 * browser surfaces record locally and upload utterances for transcription.
 */
export interface ComposerVoiceInput {
  /** When set, the mic button is shown disabled with this explanation. */
  disabledReason?: string;
  /** Sends after a dictation ends by silence or by releasing a hold. */
  autoSend?: boolean;
  start(listener: ComposerVoiceSessionListener): Promise<void>;
  /** Stops recording and resolves with the final utterance ("" if none). */
  finish(): Promise<string>;
  cancel(): void;
}

/** Presses at least this long are push-to-talk; shorter ones toggle. */
export const VOICE_HOLD_THRESHOLD_MS = 350;

type StopReason = "manual" | "auto" | "release";

/** Inserts dictated text at the selection, adding spaces at word boundaries. */
export function insertTranscript(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  transcript: string,
): { value: string; caret: number } {
  const text = transcript.trim();
  if (!text) return { value, caret: selectionEnd };
  const before = value.slice(0, selectionStart);
  const after = value.slice(selectionEnd);
  const lead = before && !/\s$/u.test(before) ? " " : "";
  const trail = after && !/^\s/u.test(after) ? " " : "";
  const inserted = `${lead}${text}${trail}`;
  return {
    value: `${before}${inserted}${after}`,
    caret: before.length + lead.length + text.length,
  };
}

/** Formats a recording duration as m:ss. */
export function formatVoiceElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function useComposerVoiceInput(options: {
  voiceInput?: ComposerVoiceInput;
  onTranscript: (text: string) => void;
  onAutoSend?: () => void;
  onEvent?: (event: string, fields?: Record<string, number>) => void;
}) {
  const { voiceInput, onTranscript, onAutoSend, onEvent } = options;
  const [status, setStatus] = useState<ComposerVoiceStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [level, setLevel] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  // Bumped per dictation and on cancel/unmount so late results never touch
  // a stale composer.
  const generationRef = useRef(0);
  const statusRef = useRef(status);
  statusRef.current = status;
  const startedAtRef = useRef(0);
  /** Set while the mic button or shortcut is physically held. */
  const pressRef = useRef<{ at: number } | null>(null);
  /** A stop requested while the microphone was still starting. */
  const pendingStopRef = useRef<StopReason | null>(null);
  const callbacksRef = useRef({ onTranscript, onAutoSend, onEvent });
  callbacksRef.current = { onTranscript, onAutoSend, onEvent };

  const stop = useCallback(
    async (reason: StopReason) => {
      if (!voiceInput) return;
      if (statusRef.current === "starting") {
        pendingStopRef.current = reason;
        return;
      }
      if (statusRef.current !== "recording") return;
      const generation = generationRef.current;
      const { onEvent: emit } = callbacksRef.current;
      statusRef.current = "transcribing";
      setStatus("transcribing");
      setLevel(0);
      if (reason === "auto") emit?.("voice.autoStop");
      try {
        const text = await voiceInput.finish();
        if (generation !== generationRef.current) return;
        statusRef.current = "idle";
        setStatus("idle");
        const callbacks = callbacksRef.current;
        callbacks.onEvent?.("voice.transcribed", {
          chars: text.length,
          durationMs: Date.now() - startedAtRef.current,
        });
        if (text.trim()) callbacks.onTranscript(text);
        if (voiceInput.autoSend && reason !== "manual") {
          callbacks.onEvent?.("voice.autoSend");
          callbacks.onAutoSend?.();
        }
      } catch (err) {
        if (generation !== generationRef.current) return;
        statusRef.current = "idle";
        setStatus("idle");
        setError(err instanceof Error ? err.message : String(err));
        callbacksRef.current.onEvent?.("voice.failed");
      }
    },
    [voiceInput],
  );

  const begin = useCallback(async () => {
    if (!voiceInput || voiceInput.disabledReason) return;
    if (statusRef.current !== "idle") return;
    const generation = ++generationRef.current;
    const current = () => generation === generationRef.current;
    pendingStopRef.current = null;
    setError(null);
    setLevel(0);
    setElapsedMs(0);
    statusRef.current = "starting";
    setStatus("starting");
    try {
      await voiceInput.start({
        onPartial: (text) => {
          if (current() && text.trim()) callbacksRef.current.onTranscript(text);
        },
        onLevel: (next) => {
          if (current() && statusRef.current === "recording") setLevel(next);
        },
        onAutoStop: () => {
          // Push-to-talk records until release, however long the pause.
          if (current() && !pressRef.current) void stop("auto");
        },
      });
      if (!current()) return;
      startedAtRef.current = Date.now();
      statusRef.current = "recording";
      setStatus("recording");
      callbacksRef.current.onEvent?.("voice.start");
      const pending = pendingStopRef.current;
      pendingStopRef.current = null;
      if (pending) void stop(pending);
    } catch (err) {
      if (!current()) return;
      statusRef.current = "idle";
      setStatus("idle");
      setError(err instanceof Error ? err.message : String(err));
      callbacksRef.current.onEvent?.("voice.failed");
    }
  }, [voiceInput, stop]);

  /** Click or keyboard activation: start, or stop and keep the draft. */
  const toggle = useCallback(async () => {
    if (statusRef.current === "idle") await begin();
    else if (statusRef.current === "recording") await stop("manual");
  }, [begin, stop]);

  /** Mic button or shortcut pressed: a hold is push-to-talk. */
  const pressStart = useCallback(() => {
    if (pressRef.current) return;
    if (statusRef.current === "idle") {
      pressRef.current = { at: Date.now() };
      void begin();
    } else if (statusRef.current === "recording") {
      void stop("manual");
    }
  }, [begin, stop]);

  /** Released: finish a hold, or keep recording after a short tap. */
  const pressEnd = useCallback(() => {
    const press = pressRef.current;
    pressRef.current = null;
    if (!press) return;
    if (Date.now() - press.at >= VOICE_HOLD_THRESHOLD_MS) {
      void stop("release");
    }
  }, [stop]);

  const cancel = useCallback(() => {
    pressRef.current = null;
    pendingStopRef.current = null;
    if (statusRef.current === "idle") return;
    generationRef.current += 1;
    voiceInput?.cancel();
    statusRef.current = "idle";
    setStatus("idle");
    setLevel(0);
    callbacksRef.current.onEvent?.("voice.cancel");
  }, [voiceInput]);

  const clearError = useCallback(() => setError(null), []);

  useEffect(() => {
    if (status !== "recording") return;
    const timer = setInterval(
      () => setElapsedMs(Date.now() - startedAtRef.current),
      250,
    );
    return () => clearInterval(timer);
  }, [status]);

  // A hold whose release happened outside the window becomes a toggle.
  useEffect(() => {
    const onBlur = () => {
      pressRef.current = null;
    };
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, []);

  // Release the microphone if the composer or its backend goes away.
  useEffect(
    () => () => {
      if (statusRef.current !== "idle") {
        generationRef.current += 1;
        voiceInput?.cancel();
      }
    },
    [voiceInput],
  );

  return {
    status,
    error,
    level,
    elapsedMs,
    toggle,
    pressStart,
    pressEnd,
    cancel,
    clearError,
  };
}
