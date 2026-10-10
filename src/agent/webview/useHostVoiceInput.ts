import type {
  ComposerVoiceInput,
  ComposerVoiceSessionListener,
} from "./components/composerVoiceInput";
import type { ExtensionMessage, VoiceInputAvailabilityState } from "./types";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "preact/hooks";

import { randomId } from "../../shared/randomId";

const START_TIMEOUT_MS = 20_000;
const FINISH_TIMEOUT_MS = 120_000;

type VoiceHostMessage = Extract<
  ExtensionMessage,
  { type: "voiceInputAvailability" | "voiceInputResult" | "voiceInputEvent" }
>;

/**
 * VS Code webviews cannot open the microphone, so recording runs on the
 * extension host. This hook adapts that request/response protocol to the
 * composer voice contract and tracks subscription-gated availability.
 */
export function useHostVoiceInput(vscodeApi: {
  postMessage: (msg: unknown) => void;
}): {
  voiceInput: ComposerVoiceInput | undefined;
  handleHostMessage: (msg: ExtensionMessage) => boolean;
} {
  const [availability, setAvailability] =
    useState<VoiceInputAvailabilityState | null>(null);
  const ownerIdRef = useRef(randomId());
  /** Receives live events for the dictation currently recording. */
  const listenerRef = useRef<ComposerVoiceSessionListener | null>(null);
  const pendingRef = useRef(
    new Map<
      string,
      { resolve: (text: string) => void; reject: (error: Error) => void }
    >(),
  );

  useEffect(() => {
    vscodeApi.postMessage({ command: "voiceInputAvailabilityRequest" });
  }, [vscodeApi]);

  const request = useCallback(
    (
      command: "voiceInputStart" | "voiceInputFinish",
      timeoutMs: number,
    ): Promise<string> =>
      new Promise((resolve, reject) => {
        const requestId = randomId();
        const timeout = setTimeout(() => {
          if (pendingRef.current.delete(requestId)) {
            reject(new Error("Voice input timed out."));
          }
        }, timeoutMs);
        pendingRef.current.set(requestId, {
          resolve: (text) => {
            clearTimeout(timeout);
            resolve(text);
          },
          reject: (error) => {
            clearTimeout(timeout);
            reject(error);
          },
        });
        vscodeApi.postMessage({
          command,
          requestId,
          ownerId: ownerIdRef.current,
        });
      }),
    [vscodeApi],
  );

  const handleHostMessage = useCallback((msg: ExtensionMessage): boolean => {
    const message = msg as VoiceHostMessage;
    if (message.type === "voiceInputAvailability") {
      setAvailability(message.availability);
      return true;
    }
    if (message.type === "voiceInputEvent") {
      const listener = listenerRef.current;
      if (listener && message.ownerId === ownerIdRef.current) {
        const { event } = message;
        if (event.kind === "partial") listener.onPartial(event.text);
        else if (event.kind === "level") listener.onLevel(event.level);
        else if (event.kind === "autoStop") listener.onAutoStop();
      }
      return true;
    }
    if (message.type === "voiceInputResult") {
      const pending = pendingRef.current.get(message.requestId);
      if (pending) {
        pendingRef.current.delete(message.requestId);
        if (message.error) pending.reject(new Error(message.error));
        else pending.resolve(message.text ?? "");
      }
      return true;
    }
    return false;
  }, []);

  const voiceInput = useMemo<ComposerVoiceInput | undefined>(() => {
    if (!availability) return undefined;
    if (!availability.available && availability.hidden) return undefined;
    return {
      disabledReason: availability.available ? undefined : availability.reason,
      autoSend: availability.available
        ? availability.preferences?.autoSend === true
        : false,
      start: async (listener) => {
        listenerRef.current = listener;
        try {
          await request("voiceInputStart", START_TIMEOUT_MS);
        } catch (err) {
          listenerRef.current = null;
          throw err;
        }
      },
      finish: async () => {
        try {
          return await request("voiceInputFinish", FINISH_TIMEOUT_MS);
        } finally {
          listenerRef.current = null;
        }
      },
      cancel: () => {
        listenerRef.current = null;
        vscodeApi.postMessage({
          command: "voiceInputCancel",
          requestId: randomId(),
          ownerId: ownerIdRef.current,
        });
      },
    };
  }, [availability, request, vscodeApi]);

  return { voiceInput, handleHostMessage };
}
