import { useCallback, useEffect, useRef } from "preact/hooks";

import type { ExtensionMessage } from "./types";
import { shouldDropSessionScopedEvent } from "../../shared/chatProjection.js";

export interface WebviewMessageApi {
  postMessage(message: unknown): void;
}

interface ReadonlyRef<T> {
  readonly current: T;
}

export type SessionScopedExtensionMessage = ExtensionMessage & {
  sessionId: string;
};

interface MutableRef<T> {
  current: T;
}

export type StreamingDeltaAction =
  | { type: "TEXT_DELTA"; text: string }
  | { type: "THINKING_DELTA"; thinkingId: string; text: string }
  | { type: "TOOL_INPUT_DELTA"; toolCallId: string; partialJson: string };

export interface WebviewMessageControls {
  dropIfNotStreaming(): boolean;
  appendTextDelta(text: string): void;
  appendThinkingDelta(thinkingId: string, text: string): void;
  appendToolInputDelta(toolCallId: string, partialJson: string): void;
  flushDeltasNow(): void;
}

export interface WebviewMessageConnectionOptions {
  vscodeApi: WebviewMessageApi;
  sessionIdRef: ReadonlyRef<string | null>;
  streamingRef: MutableRef<boolean>;
  openSessionIdsRef?: ReadonlyRef<ReadonlySet<string>>;
  flushDeltasRef?: MutableRef<() => void>;
  dispatchDelta(action: StreamingDeltaAction): void;
  onInactiveSessionMessage?(msg: SessionScopedExtensionMessage): void;
  /**
   * Called whenever a session-scoped event is dropped. A drop means the local
   * projection for that session is no longer a complete replica of the
   * extension's stream — callers should stop treating it as authoritative.
   */
  onStreamDrop?(sessionId: string | undefined): void;
  onMessage(msg: ExtensionMessage, controls: WebviewMessageControls): void;
}

const DELTA_FLUSH_MAX_DELAY_MS = 100;
const MAX_BUFFERED_DELTA_CHARS = 256 * 1024;

const BACKGROUND_EVENT_TYPES = new Set<ExtensionMessage["type"]>([
  "agentFleetEvent",
  "agentBgThinkingStart",
  "agentBgThinkingDelta",
  "agentBgThinkingEnd",
  "agentBgTextDelta",
  "agentBgToolStart",
  "agentBgToolInputDelta",
  "agentBgToolComplete",
  "agentBgApiRequest",
  "agentBgError",
  "agentBgTodoUpdate",
  "agentBgWarning",
  "agentBgStatusUpdate",
  "agentBgFinalMarker",
  "agentBgCondenseStart",
  "agentBgCondense",
  "agentBgCondenseError",
  "agentBgInterjection",
  "agentBgDone",
]);

export function useWebviewMessageConnection(
  options: WebviewMessageConnectionOptions,
): (message: ExtensionMessage) => void {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const replayMessageRef = useRef<(message: ExtensionMessage) => void>(
    () => {},
  );

  useEffect(() => {
    let textDeltaBuffer = "";
    const thinkingDeltaBuffer = new Map<string, string>();
    const toolInputDeltaBuffer = new Map<string, string>();
    let bufferedDeltaChars = 0;
    let deltaAnimationFrame: number | null = null;
    let deltaFlushTimer: ReturnType<typeof setTimeout> | null = null;

    const drainDeltaBuffers = () => {
      const { dispatchDelta } = optionsRef.current;
      if (textDeltaBuffer) {
        dispatchDelta({ type: "TEXT_DELTA", text: textDeltaBuffer });
        textDeltaBuffer = "";
      }
      for (const [thinkingId, text] of thinkingDeltaBuffer) {
        dispatchDelta({ type: "THINKING_DELTA", thinkingId, text });
      }
      thinkingDeltaBuffer.clear();
      for (const [toolCallId, partialJson] of toolInputDeltaBuffer) {
        dispatchDelta({
          type: "TOOL_INPUT_DELTA",
          toolCallId,
          partialJson,
        });
      }
      toolInputDeltaBuffer.clear();
      bufferedDeltaChars = 0;
    };

    const clearScheduledDeltaFlush = () => {
      if (deltaAnimationFrame !== null) {
        cancelAnimationFrame(deltaAnimationFrame);
        deltaAnimationFrame = null;
      }
      if (deltaFlushTimer !== null) {
        clearTimeout(deltaFlushTimer);
        deltaFlushTimer = null;
      }
    };

    const flushDeltasNow = () => {
      clearScheduledDeltaFlush();
      drainDeltaBuffers();
    };

    const scheduleDeltaFlush = () => {
      if (bufferedDeltaChars >= MAX_BUFFERED_DELTA_CHARS) {
        flushDeltasNow();
        return;
      }
      if (deltaAnimationFrame === null) {
        deltaAnimationFrame = requestAnimationFrame(() => {
          deltaAnimationFrame = null;
          if (deltaFlushTimer !== null) {
            clearTimeout(deltaFlushTimer);
            deltaFlushTimer = null;
          }
          drainDeltaBuffers();
        });
      }
      if (deltaFlushTimer === null) {
        deltaFlushTimer = setTimeout(() => {
          deltaFlushTimer = null;
          if (deltaAnimationFrame !== null) {
            cancelAnimationFrame(deltaAnimationFrame);
            deltaAnimationFrame = null;
          }
          drainDeltaBuffers();
        }, DELTA_FLUSH_MAX_DELAY_MS);
      }
    };
    if (optionsRef.current.flushDeltasRef) {
      optionsRef.current.flushDeltasRef.current = flushDeltasNow;
    }

    const processMessage = (
      msg: ExtensionMessage,
      bypassSessionRouting = false,
    ) => {
      const {
        vscodeApi,
        sessionIdRef,
        streamingRef,
        openSessionIdsRef,
        onInactiveSessionMessage,
        onMessage,
      } = optionsRef.current;
      const eventSessionId =
        "sessionId" in msg
          ? (msg as { sessionId: string }).sessionId
          : undefined;

      const reportDrop = (
        reason: "session_mismatch" | "streaming_false",
      ): void => {
        optionsRef.current.onStreamDrop?.(eventSessionId);
        vscodeApi.postMessage({
          command: "agentStreamDrop",
          reason,
          eventType: msg.type,
          eventSessionId: eventSessionId ?? null,
          currentSessionId: sessionIdRef.current,
          streaming: streamingRef.current,
        });
      };

      const isBackgroundEvent = BACKGROUND_EVENT_TYPES.has(msg.type);
      if (
        !bypassSessionRouting &&
        eventSessionId !== undefined &&
        eventSessionId !== sessionIdRef.current &&
        !isBackgroundEvent &&
        openSessionIdsRef?.current.has(eventSessionId)
      ) {
        onInactiveSessionMessage?.(msg as SessionScopedExtensionMessage);
        return;
      }

      if (
        !bypassSessionRouting &&
        shouldDropSessionScopedEvent(
          msg.type,
          eventSessionId,
          sessionIdRef.current,
          isBackgroundEvent,
        )
      ) {
        console.debug(
          `[agentlink-webview] dropping ${msg.type}: session mismatch (event=${eventSessionId}, current=${sessionIdRef.current ?? "null"})`,
        );
        reportDrop("session_mismatch");
        return;
      }

      const controls: WebviewMessageControls = {
        dropIfNotStreaming: () => {
          // Replayed buffered events were valid in order when they were
          // captured; the streaming gate only exists to reject stale live
          // events and must never discard a replay.
          if (bypassSessionRouting) return false;
          if (streamingRef.current) return false;
          console.debug(
            `[agentlink-webview] dropping ${msg.type}: streamingRef=false (eventSession=${eventSessionId ?? "none"}, current=${sessionIdRef.current ?? "null"})`,
          );
          reportDrop("streaming_false");
          return true;
        },
        appendTextDelta: (text) => {
          textDeltaBuffer += text;
          bufferedDeltaChars += text.length;
          scheduleDeltaFlush();
        },
        appendThinkingDelta: (thinkingId, text) => {
          thinkingDeltaBuffer.set(
            thinkingId,
            (thinkingDeltaBuffer.get(thinkingId) ?? "") + text,
          );
          bufferedDeltaChars += text.length;
          scheduleDeltaFlush();
        },
        appendToolInputDelta: (toolCallId, partialJson) => {
          toolInputDeltaBuffer.set(
            toolCallId,
            (toolInputDeltaBuffer.get(toolCallId) ?? "") + partialJson,
          );
          bufferedDeltaChars += partialJson.length;
          scheduleDeltaFlush();
        },
        flushDeltasNow,
      };

      onMessage(msg, controls);
    };

    const handler = (event: MessageEvent) => {
      processMessage(event.data as ExtensionMessage);
    };
    replayMessageRef.current = (message) => processMessage(message, true);

    const handleVisibilityChange = () => flushDeltasNow();

    window.addEventListener("message", handler);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    optionsRef.current.vscodeApi.postMessage({ command: "webviewReady" });

    return () => {
      window.removeEventListener("message", handler);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      replayMessageRef.current = () => {};
      clearScheduledDeltaFlush();
      if (optionsRef.current.flushDeltasRef) {
        optionsRef.current.flushDeltasRef.current = () => {};
      }
    };
  }, []);

  return useCallback((message: ExtensionMessage) => {
    replayMessageRef.current(message);
  }, []);
}
