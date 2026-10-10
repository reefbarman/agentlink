import { useCallback, useEffect, useRef, useState } from "preact/hooks";

export type ComposerVoiceStatus =
  | "idle"
  | "starting"
  | "recording"
  | "transcribing";

/**
 * Surface-supplied voice backend. VS Code records on the extension host;
 * browser surfaces record locally and upload the clip for transcription.
 */
export interface ComposerVoiceInput {
  /** When set, the mic button is shown disabled with this explanation. */
  disabledReason?: string;
  start(): Promise<void>;
  /** Stops recording and resolves with the transcript ("" when silent). */
  finish(): Promise<string>;
  cancel(): void;
}

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

export function useComposerVoiceInput(options: {
  voiceInput?: ComposerVoiceInput;
  onTranscript: (text: string) => void;
  onEvent?: (event: string, fields?: Record<string, number>) => void;
}) {
  const { voiceInput, onTranscript, onEvent } = options;
  const [status, setStatus] = useState<ComposerVoiceStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  // Bumped on cancel/unmount so late results never touch a stale composer.
  const generationRef = useRef(0);
  const statusRef = useRef(status);
  statusRef.current = status;
  const startedAtRef = useRef(0);

  const toggle = useCallback(async () => {
    if (!voiceInput || voiceInput.disabledReason) return;
    const current = statusRef.current;
    if (current === "starting" || current === "transcribing") return;
    const generation = ++generationRef.current;
    setError(null);
    try {
      if (current === "idle") {
        setStatus("starting");
        await voiceInput.start();
        if (generation !== generationRef.current) return;
        startedAtRef.current = Date.now();
        setStatus("recording");
        onEvent?.("voice.start");
        return;
      }
      setStatus("transcribing");
      const text = await voiceInput.finish();
      if (generation !== generationRef.current) return;
      setStatus("idle");
      onEvent?.("voice.transcribed", {
        chars: text.length,
        durationMs: Date.now() - startedAtRef.current,
      });
      if (text.trim()) onTranscript(text);
    } catch (err) {
      if (generation !== generationRef.current) return;
      setStatus("idle");
      setError(err instanceof Error ? err.message : String(err));
      onEvent?.("voice.failed");
    }
  }, [voiceInput, onTranscript, onEvent]);

  const cancel = useCallback(() => {
    if (statusRef.current === "idle") return;
    generationRef.current += 1;
    voiceInput?.cancel();
    setStatus("idle");
    onEvent?.("voice.cancel");
  }, [voiceInput, onEvent]);

  const clearError = useCallback(() => setError(null), []);

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

  return { status, error, toggle, cancel, clearError };
}
