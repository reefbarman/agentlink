import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DeltaBufferFlusher } from "./DeltaBufferFlusher.js";
import type { ExtensionMessage } from "./webview/types.js";

type DeltaBufferMessage = Extract<
  ExtensionMessage,
  {
    type:
      | "agentTextDelta"
      | "agentThinkingDelta"
      | "agentToolInputDelta"
      | "agentBgTextDelta"
      | "agentBgThinkingDelta"
      | "agentBgToolInputDelta";
  }
>;

function createFlusher(backgroundSessions = new Set<string>()) {
  const messages: DeltaBufferMessage[] = [];
  const flusher = new DeltaBufferFlusher({
    emit: (message) => messages.push(message),
    isBackgroundSession: (sessionId) => backgroundSessions.has(sessionId),
  });
  return { flusher, messages };
}

describe("DeltaBufferFlusher", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("coalesces text fragments and schedules only one flush", () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const { flusher, messages } = createFlusher();

    flusher.appendText("session-1", "hel");
    flusher.appendText("session-1", "lo");

    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
    expect(messages).toEqual([]);

    vi.advanceTimersByTime(16);

    expect(messages).toEqual([
      { type: "agentTextDelta", sessionId: "session-1", text: "hello" },
    ]);
  });

  it("coalesces thinking and tool input independently by session and id", () => {
    const { flusher, messages } = createFlusher();

    flusher.appendThinking("session-1", "thinking-1", "a");
    flusher.appendThinking("session-1", "thinking-2", "b");
    flusher.appendThinking("session-1", "thinking-1", "c");
    flusher.appendThinking("session-2", "thinking-1", "d");
    flusher.appendToolInput("session-1", "tool-1", '{"a"');
    flusher.appendToolInput("session-1", "tool-2", '{"b":2}');
    flusher.appendToolInput("session-1", "tool-1", ":1}");
    flusher.appendToolInput("session-2", "tool-1", "{}");

    vi.advanceTimersByTime(16);

    expect(messages).toEqual([
      {
        type: "agentThinkingDelta",
        sessionId: "session-1",
        thinkingId: "thinking-1",
        text: "ac",
      },
      {
        type: "agentThinkingDelta",
        sessionId: "session-1",
        thinkingId: "thinking-2",
        text: "b",
      },
      {
        type: "agentThinkingDelta",
        sessionId: "session-2",
        thinkingId: "thinking-1",
        text: "d",
      },
      {
        type: "agentToolInputDelta",
        sessionId: "session-1",
        toolCallId: "tool-1",
        partialJson: '{"a":1}',
      },
      {
        type: "agentToolInputDelta",
        sessionId: "session-1",
        toolCallId: "tool-2",
        partialJson: '{"b":2}',
      },
      {
        type: "agentToolInputDelta",
        sessionId: "session-2",
        toolCallId: "tool-1",
        partialJson: "{}",
      },
    ]);
  });

  it("flushes categories and keys in stable insertion order", () => {
    const { flusher, messages } = createFlusher();

    flusher.appendToolInput("session-2", "tool-2", "tool");
    flusher.appendThinking("session-2", "thinking-2", "thinking");
    flusher.appendText("session-2", "second");
    flusher.appendText("session-1", "first");
    flusher.appendThinking("session-1", "thinking-1", "first-thinking");
    flusher.appendToolInput("session-1", "tool-1", "first-tool");

    flusher.flushNow();

    expect(
      messages.map((message) => [message.type, message.sessionId]),
    ).toEqual([
      ["agentTextDelta", "session-2"],
      ["agentTextDelta", "session-1"],
      ["agentThinkingDelta", "session-2"],
      ["agentThinkingDelta", "session-1"],
      ["agentToolInputDelta", "session-2"],
      ["agentToolInputDelta", "session-1"],
    ]);
  });

  it("cancels a pending timer when flushing synchronously", () => {
    const { flusher, messages } = createFlusher();

    flusher.appendText("session-1", "text");
    flusher.flushNow();

    expect(messages).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);

    vi.advanceTimersByTime(16);
    expect(messages).toHaveLength(1);
  });

  it("chooses the tool input message type at flush time", () => {
    const backgroundSessions = new Set<string>();
    const { flusher, messages } = createFlusher(backgroundSessions);

    flusher.appendToolInput("session-1", "tool-1", "{}");
    backgroundSessions.add("session-1");
    flusher.flushNow();

    expect(messages).toEqual([
      {
        type: "agentBgToolInputDelta",
        sessionId: "session-1",
        toolCallId: "tool-1",
        partialJson: "{}",
      },
    ]);
  });

  it("emits background variants for text and thinking deltas", () => {
    const backgroundSessions = new Set<string>(["bg-session"]);
    const { flusher, messages } = createFlusher(backgroundSessions);

    flusher.appendText("bg-session", "hel");
    flusher.appendText("bg-session", "lo");
    flusher.appendText("fg-session", "front");
    flusher.appendThinking("bg-session", "thinking-1", "hmm");
    flusher.flushNow();

    expect(messages).toEqual([
      { type: "agentBgTextDelta", sessionId: "bg-session", text: "hello" },
      { type: "agentTextDelta", sessionId: "fg-session", text: "front" },
      {
        type: "agentBgThinkingDelta",
        sessionId: "bg-session",
        thinkingId: "thinking-1",
        text: "hmm",
      },
    ]);
  });

  it("schedules another timer after a timed flush", () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const { flusher, messages } = createFlusher();

    flusher.appendText("session-1", "first");
    vi.advanceTimersByTime(16);
    flusher.appendText("session-1", "second");
    vi.advanceTimersByTime(16);

    expect(setTimeoutSpy).toHaveBeenCalledTimes(2);
    expect(messages).toEqual([
      { type: "agentTextDelta", sessionId: "session-1", text: "first" },
      { type: "agentTextDelta", sessionId: "session-1", text: "second" },
    ]);
  });
});
