import { describe, expect, it } from "vitest";

import { InactiveChatProjectionCache } from "./InactiveChatProjectionCache.js";

describe("InactiveChatProjectionCache", () => {
  it("isolates and coalesces live deltas by session without changing order", () => {
    const cache = new InactiveChatProjectionCache();
    cache.append({
      type: "agentThinkingStart",
      sessionId: "session-1",
      thinkingId: "thinking-1",
    });
    cache.append({
      type: "agentThinkingDelta",
      sessionId: "session-1",
      thinkingId: "thinking-1",
      text: "first ",
    });
    cache.append({
      type: "agentThinkingDelta",
      sessionId: "session-1",
      thinkingId: "thinking-1",
      text: "second",
    });
    cache.append({
      type: "agentTextDelta",
      sessionId: "session-2",
      text: "other",
    });

    expect(cache.take("session-1")).toEqual([
      {
        type: "agentThinkingStart",
        sessionId: "session-1",
        thinkingId: "thinking-1",
      },
      {
        type: "agentThinkingDelta",
        sessionId: "session-1",
        thinkingId: "thinking-1",
        text: "first second",
      },
    ]);
    expect(cache.take("session-2")).toEqual([
      {
        type: "agentTextDelta",
        sessionId: "session-2",
        text: "other",
      },
    ]);
  });

  it("retains terminal events in order and clears only closed-tab entries", () => {
    const cache = new InactiveChatProjectionCache();
    cache.append({
      type: "agentQueuedMessage",
      sessionId: "session-1",
      queueId: "queue-1",
      text: "keep me",
      displayText: "keep me",
      isSlashCommand: false,
    });
    cache.append({
      type: "agentDone",
      sessionId: "session-1",
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
    });
    cache.append({
      type: "agentTextDelta",
      sessionId: "session-2",
      text: "other",
    });
    cache.retainSessions(new Set(["session-1"]));

    expect(cache.take("session-1")).toEqual([
      {
        type: "agentQueuedMessage",
        sessionId: "session-1",
        queueId: "queue-1",
        text: "keep me",
        displayText: "keep me",
        isSlashCommand: false,
      },
      {
        type: "agentDone",
        sessionId: "session-1",
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheReadTokens: 0,
        totalCacheCreationTokens: 0,
      },
    ]);
    expect(cache.size("session-2")).toBe(0);
  });

  it("bounds retained events per inactive session", () => {
    const cache = new InactiveChatProjectionCache(2);
    cache.append({
      type: "agentThinkingStart",
      sessionId: "session-1",
      thinkingId: "thinking-1",
    });
    cache.append({
      type: "agentThinkingEnd",
      sessionId: "session-1",
      thinkingId: "thinking-1",
    });
    cache.append({
      type: "agentTextDelta",
      sessionId: "session-1",
      text: "tail",
    });

    expect(cache.take("session-1")).toEqual([
      {
        type: "agentThinkingEnd",
        sessionId: "session-1",
        thinkingId: "thinking-1",
      },
      {
        type: "agentTextDelta",
        sessionId: "session-1",
        text: "tail",
      },
    ]);
  });
});
