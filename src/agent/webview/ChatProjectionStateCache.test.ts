import { describe, expect, it } from "vitest";

import { initialState, type AppState } from "../../shared/chatProjection.js";
import { ChatProjectionStateCache } from "./ChatProjectionStateCache.js";

function stateFor(
  sessionId: string,
  options: {
    estimatedTotalUsed: number;
    queueText?: string;
    approvalId?: string;
  },
): AppState {
  return {
    ...structuredClone(initialState),
    chatState: {
      ...structuredClone(initialState.chatState),
      sessionId,
      model: `model-${sessionId}`,
    },
    estimatedTotalUsed: options.estimatedTotalUsed,
    messageQueue: options.queueText
      ? [{ id: `queue-${sessionId}`, text: options.queueText }]
      : [],
    approvalRequest: options.approvalId
      ? {
          kind: "write",
          id: options.approvalId,
          filePath: `src/${sessionId}.ts`,
          writeOperation: "modify",
        }
      : null,
    modes: [{ slug: "code", name: "Code", icon: "code" }],
    availableModels: [],
    slashCommands: [],
  };
}

const shared = {
  modes: [{ slug: "ask", name: "Ask", icon: "question" }],
  availableModels: [],
  slashCommands: [],
};

describe("ChatProjectionStateCache", () => {
  it("restores context and queue state only for the matching session", () => {
    const cache = new ChatProjectionStateCache();
    cache.save(
      stateFor("session-1", {
        estimatedTotalUsed: 250_000,
        queueText: "queued for session one",
      }),
    );

    const fresh = cache.restore("session-2", shared);
    expect(fresh.chatState.sessionId).toBe("session-2");
    expect(fresh.estimatedTotalUsed).toBe(0);
    expect(fresh.messageQueue).toEqual([]);

    const restored = cache.restore("session-1", shared);
    expect(restored.chatState.sessionId).toBe("session-1");
    expect(restored.estimatedTotalUsed).toBe(250_000);
    expect(restored.messageQueue).toEqual([
      { id: "queue-session-1", text: "queued for session one" },
    ]);
    expect(restored.modes).toEqual(shared.modes);
  });

  it("restores approval cards only for the owning session", () => {
    const cache = new ChatProjectionStateCache();
    cache.save(
      stateFor("session-2", {
        estimatedTotalUsed: 0,
        approvalId: "approval-2",
      }),
    );

    expect(cache.restore("session-1", shared).approvalRequest).toBeNull();
    expect(cache.restore("session-2", shared).approvalRequest?.id).toBe(
      "approval-2",
    );
  });

  it("drops closed sessions without affecting retained projections", () => {
    const cache = new ChatProjectionStateCache();
    cache.save(stateFor("session-1", { estimatedTotalUsed: 100 }));
    cache.save(stateFor("session-2", { estimatedTotalUsed: 200 }));

    cache.retainSessions(new Set(["session-2"]));

    expect(cache.has("session-1")).toBe(false);
    expect(cache.has("session-2")).toBe(true);
  });
});
