import { describe, expect, it, vi } from "vitest";

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

  it("clones events at ingress and transfers them without cloning again", () => {
    const cache = new InactiveChatProjectionCache();
    const event = {
      type: "agentQueuedMessage" as const,
      sessionId: "session-1",
      queueId: "queue-1",
      text: "queued",
      displayText: "queued",
      isSlashCommand: false,
    };
    const clone = vi.spyOn(globalThis, "structuredClone");

    cache.append(event);
    expect(clone).toHaveBeenCalledTimes(1);

    const [taken] = cache.take("session-1");
    expect(clone).toHaveBeenCalledTimes(1);
    expect(taken).toEqual(event);
    expect(taken).not.toBe(event);
    expect(cache.size("session-1")).toBe(0);
    clone.mockRestore();
  });

  it("isolates nested event payloads from later caller mutation", () => {
    const cache = new InactiveChatProjectionCache();
    const event = {
      type: "agentTodoUpdate" as const,
      sessionId: "session-1",
      todos: [
        {
          id: "todo-1",
          content: "original",
          activeForm: "Working",
          status: "in_progress" as const,
          children: [],
        },
      ],
    };

    cache.append(event);
    event.todos[0].content = "mutated";

    expect(cache.take("session-1")).toEqual([
      {
        ...event,
        todos: [{ ...event.todos[0], content: "original" }],
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

  it("marks a session truncated once overflow drops events, until taken", () => {
    const cache = new InactiveChatProjectionCache(1);
    cache.append({
      type: "agentThinkingStart",
      sessionId: "session-1",
      thinkingId: "thinking-1",
    });
    expect(cache.wasTruncated("session-1")).toBe(false);

    cache.append({
      type: "agentThinkingEnd",
      sessionId: "session-1",
      thinkingId: "thinking-1",
    });
    expect(cache.wasTruncated("session-1")).toBe(true);
    expect(cache.wasTruncated("session-2")).toBe(false);

    cache.take("session-1");
    expect(cache.wasTruncated("session-1")).toBe(false);
  });

  it("clears truncation state for closed sessions and on clear()", () => {
    const cache = new InactiveChatProjectionCache(1);
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
    cache.retainSessions(new Set());
    expect(cache.wasTruncated("session-1")).toBe(false);

    cache.append({
      type: "agentThinkingStart",
      sessionId: "session-2",
      thinkingId: "thinking-2",
    });
    cache.append({
      type: "agentThinkingEnd",
      sessionId: "session-2",
      thinkingId: "thinking-2",
    });
    expect(cache.wasTruncated("session-2")).toBe(true);
    cache.clear();
    expect(cache.wasTruncated("session-2")).toBe(false);
  });
});
