import { describe, expect, it, vi } from "vitest";

import { ProjectedForegroundStore } from "./ProjectedForegroundStore.js";
import { initialState } from "../shared/chatProjection.js";

function loadSession(
  sessionId = "session-1",
  todos = [
    {
      id: "restored",
      content: "Restore todo",
      activeForm: "Restoring todo",
      status: "in_progress" as const,
    },
  ],
) {
  return {
    type: "LOAD_SESSION" as const,
    sessionId,
    title: "Session",
    mode: "code",
    model: "claude-sonnet-4-6",
    messages: [],
    todos,
    lastInputTokens: 12,
    lastOutputTokens: 34,
    checkpoints: [],
    userTurnOffset: 0,
    hasMoreBefore: false,
  };
}

describe("ProjectedForegroundStore", () => {
  it("notifies listeners for reducer actions that change projected state", () => {
    const store = new ProjectedForegroundStore();
    const listener = vi.fn();
    store.onDidChange(listener);

    store.apply({
      type: "SET_STATE",
      state: {
        sessionId: "session-1",
        mode: "code",
        model: "claude-sonnet-4-6",
        streaming: true,
      },
    });

    expect(store.state.chatState.sessionId).toBe("session-1");
    expect(store.state.streaming).toBe(true);
    expect(store.isStreaming).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);

    store.apply({ type: "DONE" });
    expect(store.state.streaming).toBe(false);
    expect(store.isStreaming).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("does not notify after disposal or reducer no-ops", () => {
    const store = new ProjectedForegroundStore();
    const listener = vi.fn();
    const subscription = store.onDidChange(listener);

    store.apply({
      type: "TOOL_INPUT_DELTA",
      toolCallId: "missing-tool",
      partialJson: "{}",
    });
    expect(listener).not.toHaveBeenCalled();

    subscription.dispose();
    store.apply({
      type: "SET_STATE",
      state: {
        sessionId: "session-1",
        mode: "code",
        model: "claude-sonnet-4-6",
        streaming: true,
      },
    });
    expect(listener).not.toHaveBeenCalled();
  });

  it("replaces raw state without changing the independent streaming guard", () => {
    const store = new ProjectedForegroundStore();
    const listener = vi.fn();
    store.onDidChange(listener);

    store.setStreaming(true);

    store.replaceState({
      ...initialState,
      streaming: false,
      debugInfo: { source: "replacement" },
    });

    expect(store.state.debugInfo).toEqual({ source: "replacement" });
    expect(store.isStreaming).toBe(true);
    expect(listener).toHaveBeenCalledTimes(2);

    store.replaceState(store.state);
    store.setStreaming(true);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("hydrates a session from a clean state with its token estimate", () => {
    const store = new ProjectedForegroundStore();
    store.apply({
      type: "TODO_UPDATE",
      todos: [
        { id: "old", content: "old", activeForm: "old", status: "pending" },
      ],
    });
    store.setStreaming(true);

    const listener = vi.fn(() => {
      expect(store.state.chatState.sessionId).toBe("session-1");
      expect(store.state.estimatedTotalUsed).toBe(56);
      expect(store.state.todos).toEqual([
        expect.objectContaining({ id: "restored", status: "in_progress" }),
      ]);
      expect(store.isStreaming).toBe(false);
    });
    store.onDidChange(listener);

    store.hydrate(loadSession(), 56);

    expect(store.sessionId).toBe("session-1");
    expect(store.state.chatState).toMatchObject({
      sessionId: "session-1",
      mode: "code",
      model: "claude-sonnet-4-6",
    });
    expect(store.state.lastInputTokens).toBe(12);
    expect(store.state.lastOutputTokens).toBe(34);
    expect(store.state.estimatedTotalUsed).toBe(56);
    expect(store.state.todos).toEqual([
      expect.objectContaining({ id: "restored", status: "in_progress" }),
    ]);
    expect(store.isStreaming).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("accepts the first canonical load after synthetic foreground hydration", () => {
    const store = new ProjectedForegroundStore();
    store.setControllerEpoch("epoch-1");
    store.hydrate(loadSession(), 56);

    expect(store.acceptSessionLoad("session-1", 2)).toBe(true);
    store.beginSessionLoad("session-1", false);
    store.apply({
      ...loadSession(),
      backgroundResults: [
        {
          sessionId: "bg-1",
          task: "Review",
          status: "completed",
          resultState: "completed",
          resultText: "Canonical child result",
          completedAt: 1,
        },
      ],
    });

    expect(
      store.state.messages.flatMap((message) => message.blocks),
    ).toContainEqual(
      expect.objectContaining({
        type: "bg_agent_result",
        sessionId: "bg-1",
        resultText: "Canonical child result",
      }),
    );
    expect(store.acceptSessionLoad("session-1", 2)).toBe(false);
  });

  it("accepts only newer canonical loads for the current session and epoch", () => {
    const store = new ProjectedForegroundStore();
    store.setControllerEpoch("epoch-1");
    store.setSessionId("session-1");

    expect(store.acceptSessionLoad("session-2", 1)).toBe(false);
    expect(store.acceptSessionLoad("session-1", 2)).toBe(true);
    expect(store.acceptSessionLoad("session-1", 2)).toBe(false);
    expect(store.acceptSessionLoad("session-1", 1)).toBe(false);
    expect(store.acceptSessionLoad("session-1", 3)).toBe(true);

    store.setControllerEpoch("epoch-2");
    expect(store.acceptSessionLoad("session-1", 1)).toBe(true);
  });

  it("keeps transcript completion revisions monotonic", () => {
    const store = new ProjectedForegroundStore();
    store.setControllerEpoch("epoch-1");
    store.setSessionId("session-1");
    store.recordTranscriptRevision("session-1", 5);
    store.recordTranscriptRevision("session-1", 3);

    expect(store.acceptSessionLoad("session-1", 4)).toBe(false);
    expect(store.acceptSessionLoad("session-1", 6)).toBe(true);
  });

  it("tracks a paged session load and accepts only matching chunks", () => {
    const store = new ProjectedForegroundStore();

    const listener = vi.fn();
    store.onDidChange(listener);

    store.beginSessionLoad("session-1", true);

    expect(store.sessionId).toBe("session-1");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.acceptSessionChunk("session-2", false)).toBe(false);
    expect(store.acceptSessionChunk("session-1", true)).toBe(true);
    expect(store.acceptSessionChunk("session-1", false)).toBe(true);
    expect(store.acceptSessionChunk("session-1", false)).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("accepts matching chunks through the current session after loading completes", () => {
    const store = new ProjectedForegroundStore();

    store.beginSessionLoad("session-1", false);

    expect(store.acceptSessionChunk("session-1", false)).toBe(true);
    expect(store.acceptSessionChunk("session-2", false)).toBe(false);
  });

  it("resets state, session identity, loading identity, and streaming", () => {
    const store = new ProjectedForegroundStore();
    store.beginSessionLoad("session-1", true);
    store.setStreaming(true);
    store.apply({
      type: "TODO_UPDATE",
      todos: [
        { id: "todo", content: "todo", activeForm: "todo", status: "pending" },
      ],
    });

    const listener = vi.fn();
    store.onDidChange(listener);

    store.reset();

    expect(store.state).toEqual(initialState);
    expect(store.sessionId).toBeNull();
    expect(store.isStreaming).toBe(false);
    expect(store.acceptSessionChunk("session-1", false)).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);

    store.reset();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
