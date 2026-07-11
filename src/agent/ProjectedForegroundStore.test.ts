import { describe, expect, it } from "vitest";

import { ProjectedForegroundStore } from "./ProjectedForegroundStore.js";
import { initialState } from "../shared/chatProjection.js";

function loadSession(sessionId = "session-1") {
  return {
    type: "LOAD_SESSION" as const,
    sessionId,
    title: "Session",
    mode: "code",
    model: "claude-sonnet-4-6",
    messages: [],
    lastInputTokens: 12,
    lastOutputTokens: 34,
    checkpoints: [],
    userTurnOffset: 0,
    hasMoreBefore: false,
  };
}

describe("ProjectedForegroundStore", () => {
  it("applies reducer actions and synchronizes the streaming guard", () => {
    const store = new ProjectedForegroundStore();

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

    store.apply({ type: "DONE" });
    expect(store.state.streaming).toBe(false);
    expect(store.isStreaming).toBe(false);
  });

  it("replaces raw state without changing the independent streaming guard", () => {
    const store = new ProjectedForegroundStore();
    store.setStreaming(true);

    store.replaceState({
      ...initialState,
      streaming: false,
      debugInfo: { source: "replacement" },
    });

    expect(store.state.debugInfo).toEqual({ source: "replacement" });
    expect(store.isStreaming).toBe(true);
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
    expect(store.state.todos).toEqual([]);
    expect(store.isStreaming).toBe(false);
  });

  it("tracks a paged session load and accepts only matching chunks", () => {
    const store = new ProjectedForegroundStore();

    store.beginSessionLoad("session-1", true);

    expect(store.sessionId).toBe("session-1");
    expect(store.acceptSessionChunk("session-2", false)).toBe(false);
    expect(store.acceptSessionChunk("session-1", true)).toBe(true);
    expect(store.acceptSessionChunk("session-1", false)).toBe(true);
    expect(store.acceptSessionChunk("session-1", false)).toBe(true);
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

    store.reset();

    expect(store.state).toEqual(initialState);
    expect(store.sessionId).toBeNull();
    expect(store.isStreaming).toBe(false);
    expect(store.acceptSessionChunk("session-1", false)).toBe(false);
  });
});
