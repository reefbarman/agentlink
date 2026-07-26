/** @vitest-environment jsdom */

import { cleanup, render } from "@testing-library/preact";
import { h } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  useWebviewMessageConnection,
  type StreamingDeltaAction,
  type WebviewMessageControls,
} from "./useWebviewMessageConnection";
import type { ExtensionMessage } from "./types";

interface TestRef<T> {
  current: T;
}

function Harness({
  postMessage,
  sessionIdRef,
  streamingRef,
  dispatchDelta,
  openSessionIdsRef,
  onInactiveSessionMessage,
  onMessage,
  replayMessageRef,
  flushDeltasRef,
}: {
  postMessage: (message: unknown) => void;
  sessionIdRef: TestRef<string | null>;
  streamingRef: TestRef<boolean>;
  openSessionIdsRef?: TestRef<ReadonlySet<string>>;
  dispatchDelta: (action: StreamingDeltaAction) => void;
  onInactiveSessionMessage?: (
    msg: ExtensionMessage & { sessionId: string },
  ) => void;
  onMessage: (msg: ExtensionMessage, controls: WebviewMessageControls) => void;
  replayMessageRef?: TestRef<(message: ExtensionMessage) => void>;
  flushDeltasRef?: TestRef<() => void>;
}) {
  const replayMessage = useWebviewMessageConnection({
    vscodeApi: { postMessage },
    sessionIdRef,
    streamingRef,
    openSessionIdsRef,
    flushDeltasRef,
    dispatchDelta,
    onInactiveSessionMessage,
    onMessage,
  });
  if (replayMessageRef) replayMessageRef.current = replayMessage;
  return null;
}

function sendMessage(message: ExtensionMessage): void {
  window.dispatchEvent(new MessageEvent("message", { data: message }));
}

describe("useWebviewMessageConnection", () => {
  const animationFrames: FrameRequestCallback[] = [];
  let animationFrameId = 0;

  beforeEach(() => {
    animationFrames.length = 0;
    animationFrameId = 0;
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        animationFrames.push(callback);
        animationFrameId += 1;
        return animationFrameId;
      }),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("registers once, posts the ready handshake, and tears down the listener", () => {
    const addEventListener = vi.spyOn(window, "addEventListener");
    const removeEventListener = vi.spyOn(window, "removeEventListener");
    const postMessage = vi.fn();
    const onMessage = vi.fn();
    const { unmount } = render(
      <Harness
        postMessage={postMessage}
        sessionIdRef={{ current: "session-1" }}
        streamingRef={{ current: false }}
        dispatchDelta={vi.fn()}
        onMessage={onMessage}
      />,
    );

    const registration = addEventListener.mock.calls.find(
      ([type]) => type === "message",
    );
    expect(registration).toBeDefined();
    expect(postMessage).toHaveBeenCalledWith({ command: "webviewReady" });

    unmount();

    expect(removeEventListener).toHaveBeenCalledWith(
      "message",
      registration?.[1],
    );
  });

  it("coalesces text, thinking, and tool-input deltas into one animation frame", () => {
    const dispatchDelta = vi.fn<(action: StreamingDeltaAction) => void>();
    render(
      <Harness
        postMessage={vi.fn()}
        sessionIdRef={{ current: "session-1" }}
        streamingRef={{ current: true }}
        dispatchDelta={dispatchDelta}
        onMessage={(msg, controls) => {
          if (controls.dropIfNotStreaming()) return;
          if (msg.type === "agentTextDelta") {
            controls.appendTextDelta(msg.text);
          } else if (msg.type === "agentThinkingDelta") {
            controls.appendThinkingDelta(msg.thinkingId, msg.text);
          } else if (msg.type === "agentToolInputDelta") {
            controls.appendToolInputDelta(msg.toolCallId, msg.partialJson);
          }
        }}
      />,
    );

    sendMessage({
      type: "agentTextDelta",
      sessionId: "session-1",
      text: "hello ",
    });
    sendMessage({
      type: "agentTextDelta",
      sessionId: "session-1",
      text: "world",
    });
    sendMessage({
      type: "agentThinkingDelta",
      sessionId: "session-1",
      thinkingId: "thinking-1",
      text: "reasoning",
    });
    sendMessage({
      type: "agentToolInputDelta",
      sessionId: "session-1",
      toolCallId: "tool-1",
      partialJson: '{"path":',
    });

    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
    expect(dispatchDelta).not.toHaveBeenCalled();

    animationFrames.shift()?.(0);

    expect(dispatchDelta.mock.calls.map(([action]) => action)).toEqual([
      { type: "TEXT_DELTA", text: "hello world" },
      {
        type: "THINKING_DELTA",
        thinkingId: "thinking-1",
        text: "reasoning",
      },
      {
        type: "TOOL_INPUT_DELTA",
        toolCallId: "tool-1",
        partialJson: '{"path":',
      },
    ]);
  });

  it("flushes through a timer when animation frames are suspended", () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        animationFrames.push(callback);
        animationFrameId += 1;
        return animationFrameId;
      }),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const dispatchDelta = vi.fn<(action: StreamingDeltaAction) => void>();
    render(
      <Harness
        postMessage={vi.fn()}
        sessionIdRef={{ current: "session-1" }}
        streamingRef={{ current: true }}
        dispatchDelta={dispatchDelta}
        onMessage={(msg, controls) => {
          if (msg.type === "agentTextDelta") {
            controls.appendTextDelta(msg.text);
          }
        }}
      />,
    );

    sendMessage({
      type: "agentTextDelta",
      sessionId: "session-1",
      text: "hidden stream",
    });
    expect(dispatchDelta).not.toHaveBeenCalled();

    vi.advanceTimersByTime(100);

    expect(cancelAnimationFrame).toHaveBeenCalledWith(1);
    expect(dispatchDelta).toHaveBeenCalledWith({
      type: "TEXT_DELTA",
      text: "hidden stream",
    });
  });

  it("flushes immediately when buffered deltas reach the memory ceiling", () => {
    const dispatchDelta = vi.fn<(action: StreamingDeltaAction) => void>();
    render(
      <Harness
        postMessage={vi.fn()}
        sessionIdRef={{ current: "session-1" }}
        streamingRef={{ current: true }}
        dispatchDelta={dispatchDelta}
        onMessage={(msg, controls) => {
          if (msg.type === "agentTextDelta") {
            controls.appendTextDelta(msg.text);
          }
        }}
      />,
    );

    const text = "x".repeat(256 * 1024);
    sendMessage({ type: "agentTextDelta", sessionId: "session-1", text });

    expect(dispatchDelta).toHaveBeenCalledWith({ type: "TEXT_DELTA", text });
    expect(requestAnimationFrame).not.toHaveBeenCalled();
  });

  it("flushes pending deltas when webview visibility changes", () => {
    const dispatchDelta = vi.fn<(action: StreamingDeltaAction) => void>();
    render(
      <Harness
        postMessage={vi.fn()}
        sessionIdRef={{ current: "session-1" }}
        streamingRef={{ current: true }}
        dispatchDelta={dispatchDelta}
        onMessage={(msg, controls) => {
          if (msg.type === "agentTextDelta") {
            controls.appendTextDelta(msg.text);
          }
        }}
      />,
    );

    sendMessage({
      type: "agentTextDelta",
      sessionId: "session-1",
      text: "before visibility change",
    });
    document.dispatchEvent(new Event("visibilitychange"));

    expect(dispatchDelta).toHaveBeenCalledTimes(1);
    expect(dispatchDelta).toHaveBeenCalledWith({
      type: "TEXT_DELTA",
      text: "before visibility change",
    });
    animationFrames.shift()?.(0);
    expect(dispatchDelta).toHaveBeenCalledTimes(1);
  });

  it("flushes pending deltas synchronously before a projection swap", () => {
    const dispatchDelta = vi.fn<(action: StreamingDeltaAction) => void>();
    const flushDeltasRef = { current: () => {} };
    render(
      <Harness
        postMessage={vi.fn()}
        sessionIdRef={{ current: "session-1" }}
        streamingRef={{ current: true }}
        flushDeltasRef={flushDeltasRef}
        dispatchDelta={dispatchDelta}
        onMessage={(msg, controls) => {
          if (msg.type === "agentTextDelta") {
            controls.appendTextDelta(msg.text);
          }
        }}
      />,
    );

    sendMessage({
      type: "agentTextDelta",
      sessionId: "session-1",
      text: "before swap",
    });
    flushDeltasRef.current();

    expect(cancelAnimationFrame).toHaveBeenCalledTimes(1);
    expect(dispatchDelta).toHaveBeenCalledWith({
      type: "TEXT_DELTA",
      text: "before swap",
    });
  });

  it("rejects session-mismatched events before routing them", () => {
    const postMessage = vi.fn();
    const onMessage = vi.fn();
    render(
      <Harness
        postMessage={postMessage}
        sessionIdRef={{ current: "session-1" }}
        streamingRef={{ current: true }}
        dispatchDelta={vi.fn()}
        onMessage={onMessage}
      />,
    );

    sendMessage({
      type: "agentTextDelta",
      sessionId: "session-2",
      text: "stale",
    });

    expect(onMessage).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenLastCalledWith({
      command: "agentStreamDrop",
      reason: "session_mismatch",
      eventType: "agentTextDelta",
      eventSessionId: "session-2",
      currentSessionId: "session-1",
      streaming: true,
    });
  });

  it("routes open inactive-tab events to the keyed projection cache", () => {
    const postMessage = vi.fn();
    const onMessage = vi.fn();
    const onInactiveSessionMessage = vi.fn();
    render(
      <Harness
        postMessage={postMessage}
        sessionIdRef={{ current: "session-1" }}
        streamingRef={{ current: true }}
        openSessionIdsRef={{ current: new Set(["session-1", "session-2"]) }}
        dispatchDelta={vi.fn()}
        onInactiveSessionMessage={onInactiveSessionMessage}
        onMessage={onMessage}
      />,
    );

    const message = {
      type: "agentTextDelta" as const,
      sessionId: "session-2",
      text: "live in T2",
    };
    sendMessage(message);

    expect(onInactiveSessionMessage).toHaveBeenCalledWith(message);
    expect(onMessage).not.toHaveBeenCalled();
    expect(postMessage.mock.calls).toEqual([[{ command: "webviewReady" }]]);
  });

  it("replays cached events through the live processor without session rerouting", () => {
    const postMessage = vi.fn();
    const dispatchDelta = vi.fn<(action: StreamingDeltaAction) => void>();
    const onInactiveSessionMessage = vi.fn();
    const replayMessageRef = {
      current: (_message: ExtensionMessage) => {},
    };
    render(
      <Harness
        postMessage={postMessage}
        sessionIdRef={{ current: "session-1" }}
        streamingRef={{ current: true }}
        openSessionIdsRef={{ current: new Set(["session-1", "session-2"]) }}
        dispatchDelta={dispatchDelta}
        onInactiveSessionMessage={onInactiveSessionMessage}
        onMessage={(msg, controls) => {
          if (msg.type === "agentTextDelta" && !controls.dropIfNotStreaming()) {
            controls.appendTextDelta(msg.text);
          }
        }}
        replayMessageRef={replayMessageRef}
      />,
    );

    replayMessageRef.current({
      type: "agentTextDelta",
      sessionId: "session-2",
      text: "replayed",
    });
    animationFrames.shift()?.(0);

    expect(onInactiveSessionMessage).not.toHaveBeenCalled();
    expect(dispatchDelta).toHaveBeenCalledWith({
      type: "TEXT_DELTA",
      text: "replayed",
    });
    expect(postMessage.mock.calls).toEqual([[{ command: "webviewReady" }]]);
  });

  it("keeps streaming guards when replaying cached events", () => {
    const postMessage = vi.fn();
    const dispatchDelta = vi.fn();
    const replayMessageRef = {
      current: (_message: ExtensionMessage) => {},
    };
    render(
      <Harness
        postMessage={postMessage}
        sessionIdRef={{ current: "session-1" }}
        streamingRef={{ current: false }}
        dispatchDelta={dispatchDelta}
        onMessage={(msg, controls) => {
          if (msg.type === "agentTextDelta" && !controls.dropIfNotStreaming()) {
            controls.appendTextDelta(msg.text);
          }
        }}
        replayMessageRef={replayMessageRef}
      />,
    );

    replayMessageRef.current({
      type: "agentTextDelta",
      sessionId: "session-2",
      text: "stale",
    });

    expect(dispatchDelta).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenLastCalledWith({
      command: "agentStreamDrop",
      reason: "streaming_false",
      eventType: "agentTextDelta",
      eventSessionId: "session-2",
      currentSessionId: "session-1",
      streaming: false,
    });
  });

  it("routes background transcript events independently of the foreground session", () => {
    const onMessage = vi.fn();
    render(
      <Harness
        postMessage={vi.fn()}
        sessionIdRef={{ current: "foreground-1" }}
        streamingRef={{ current: true }}
        dispatchDelta={vi.fn()}
        onMessage={onMessage}
      />,
    );

    sendMessage({
      type: "agentBgTodoUpdate",
      sessionId: "background-1",
      todos: [],
    });
    sendMessage({
      type: "agentBgWarning",
      sessionId: "background-1",
      message: "Provider stream first event timed out — retrying",
    });

    expect(onMessage).toHaveBeenCalledTimes(2);
  });

  it("routes fleet lifecycle events independently of the foreground session", () => {
    const onMessage = vi.fn();
    render(
      <Harness
        postMessage={vi.fn()}
        sessionIdRef={{ current: "foreground-1" }}
        streamingRef={{ current: true }}
        dispatchDelta={vi.fn()}
        onMessage={onMessage}
      />,
    );

    sendMessage({
      type: "agentFleetEvent",
      sessionId: "background-1",
      event: { type: "queued" },
    });

    expect(onMessage).toHaveBeenCalledTimes(1);
  });

  it("rejects stale deltas after done marks the stream inactive", () => {
    const postMessage = vi.fn();
    const streamingRef = { current: true };
    const dispatchDelta = vi.fn();
    render(
      <Harness
        postMessage={postMessage}
        sessionIdRef={{ current: "session-1" }}
        streamingRef={streamingRef}
        dispatchDelta={dispatchDelta}
        onMessage={(msg, controls) => {
          if (msg.type === "agentDone") {
            controls.flushDeltasNow();
            streamingRef.current = false;
          } else if (
            msg.type === "agentTextDelta" &&
            !controls.dropIfNotStreaming()
          ) {
            controls.appendTextDelta(msg.text);
          }
        }}
      />,
    );

    sendMessage({
      type: "agentDone",
      sessionId: "session-1",
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
    });
    sendMessage({
      type: "agentTextDelta",
      sessionId: "session-1",
      text: "late",
    });

    expect(requestAnimationFrame).not.toHaveBeenCalled();
    expect(dispatchDelta).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenLastCalledWith({
      command: "agentStreamDrop",
      reason: "streaming_false",
      eventType: "agentTextDelta",
      eventSessionId: "session-1",
      currentSessionId: "session-1",
      streaming: false,
    });
  });

  it("cancels pending delta schedulers during teardown", () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        animationFrames.push(callback);
        animationFrameId += 1;
        return animationFrameId;
      }),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    const pendingTimersBefore = vi.getTimerCount();
    const { unmount } = render(
      <Harness
        postMessage={vi.fn()}
        sessionIdRef={{ current: "session-1" }}
        streamingRef={{ current: true }}
        dispatchDelta={vi.fn()}
        onMessage={(msg, controls) => {
          if (msg.type === "agentTextDelta") {
            controls.appendTextDelta(msg.text);
          }
        }}
      />,
    );
    sendMessage({
      type: "agentTextDelta",
      sessionId: "session-1",
      text: "pending",
    });

    expect(vi.getTimerCount()).toBe(pendingTimersBefore + 1);
    unmount();

    expect(cancelAnimationFrame).toHaveBeenCalledWith(1);
    expect(clearTimeoutSpy).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(pendingTimersBefore);
  });

  it("cancels a pending delta frame during teardown", () => {
    const { unmount } = render(
      <Harness
        postMessage={vi.fn()}
        sessionIdRef={{ current: "session-1" }}
        streamingRef={{ current: true }}
        dispatchDelta={vi.fn()}
        onMessage={(msg, controls) => {
          if (msg.type === "agentTextDelta") {
            controls.appendTextDelta(msg.text);
          }
        }}
      />,
    );
    sendMessage({
      type: "agentTextDelta",
      sessionId: "session-1",
      text: "pending",
    });

    unmount();

    expect(cancelAnimationFrame).toHaveBeenCalledWith(1);
  });
});
