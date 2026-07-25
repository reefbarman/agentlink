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
  dispatchDelta(action: StreamingDeltaAction): void;
  onInactiveSessionMessage?(msg: SessionScopedExtensionMessage): void;
  onMessage(msg: ExtensionMessage, controls: WebviewMessageControls): void;
}

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
    let deltaAnimationFrame: number | null = null;

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
    };

    const scheduleDeltaFlush = () => {
      if (deltaAnimationFrame !== null) return;
      deltaAnimationFrame = requestAnimationFrame(() => {
        deltaAnimationFrame = null;
        drainDeltaBuffers();
      });
    };

    const flushDeltasNow = () => {
      if (deltaAnimationFrame !== null) {
        cancelAnimationFrame(deltaAnimationFrame);
        deltaAnimationFrame = null;
      }
      drainDeltaBuffers();
    };

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
          if (streamingRef.current) return false;
          console.debug(
            `[agentlink-webview] dropping ${msg.type}: streamingRef=false (eventSession=${eventSessionId ?? "none"}, current=${sessionIdRef.current ?? "null"})`,
          );
          reportDrop("streaming_false");
          return true;
        },
        appendTextDelta: (text) => {
          textDeltaBuffer += text;
          scheduleDeltaFlush();
        },
        appendThinkingDelta: (thinkingId, text) => {
          thinkingDeltaBuffer.set(
            thinkingId,
            (thinkingDeltaBuffer.get(thinkingId) ?? "") + text,
          );
          scheduleDeltaFlush();
        },
        appendToolInputDelta: (toolCallId, partialJson) => {
          toolInputDeltaBuffer.set(
            toolCallId,
            (toolInputDeltaBuffer.get(toolCallId) ?? "") + partialJson,
          );
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

    window.addEventListener("message", handler);
    optionsRef.current.vscodeApi.postMessage({ command: "webviewReady" });

    return () => {
      window.removeEventListener("message", handler);
      replayMessageRef.current = () => {};
      if (deltaAnimationFrame !== null) {
        cancelAnimationFrame(deltaAnimationFrame);
      }
    };
  }, []);

  return useCallback((message: ExtensionMessage) => {
    replayMessageRef.current(message);
  }, []);
}
