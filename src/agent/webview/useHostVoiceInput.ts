import type { ExtensionMessage, VoiceInputAvailabilityState } from "./types";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "preact/hooks";

import type { ComposerVoiceInput } from "./components/composerVoiceInput";
import { randomId } from "../../shared/randomId";

const START_TIMEOUT_MS = 20_000;
const FINISH_TIMEOUT_MS = 120_000;

type VoiceHostMessage = Extract<
  ExtensionMessage,
  { type: "voiceInputAvailability" | "voiceInputResult" }
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
      start: async () => {
        await request("voiceInputStart", START_TIMEOUT_MS);
      },
      finish: () => request("voiceInputFinish", FINISH_TIMEOUT_MS),
      cancel: () =>
        vscodeApi.postMessage({
          command: "voiceInputCancel",
          requestId: randomId(),
          ownerId: ownerIdRef.current,
        }),
    };
  }, [availability, request, vscodeApi]);

  return { voiceInput, handleHostMessage };
}
