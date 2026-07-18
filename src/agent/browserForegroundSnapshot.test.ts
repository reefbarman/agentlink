import { describe, expect, it } from "vitest";

import { initialState, type AppState } from "../shared/chatProjection.js";
import { createBrowserForegroundSnapshot } from "./browserForegroundSnapshot.js";

function createState(overrides: Partial<AppState> = {}): AppState {
  return {
    ...initialState,
    chatState: {
      ...initialState.chatState,
      sessionId: "session-1",
      mode: "code",
      model: "claude-sonnet-4-6",
      streaming: true,
      interrupted: true,
      contextBudget: {
        contextWindow: 200_000,
        maxInputTokens: 180_000,
        usedInputTokens: 120_000,
        outputReservation: 20_000,
        safetyBufferTokens: 5_000,
        softThresholdBudget: 135_000,
        hardBudget: 155_000,
      },
      condenseThreshold: 0.75,
    },
    streaming: true,
    thinkingEnabled: true,
    lastInputTokens: 12,
    lastOutputTokens: 34,
    lastCacheReadTokens: 56,
    estimatedTotalUsed: 78,
    statusOverride: "Working",
    messages: [
      {
        id: "message-1",
        role: "assistant",
        content: "hello",
        timestamp: 1,
        blocks: [{ type: "text", text: "hello" }],
      },
    ],
    messageQueue: [
      {
        id: "queue-1",
        text: "queued",
        attachments: ["src/index.ts"],
        images: [{ name: "image.png", mimeType: "image/png", base64: "abc" }],
        documents: [{ name: "notes.md", mimeType: "text/markdown" }],
        source: "browser",
      },
    ],
    questionRequest: {
      id: "question-1",
      context: "Choose one.",
      questions: [
        {
          id: "choice",
          type: "multiple_choice",
          question: "Which option?",
          options: ["A", "B"],
          recommended: "A",
        },
      ],
      backgroundTask: "Research",
    },
    detectedQuestion: {
      messageId: "message-1",
      kind: "single_choice",
      prompt: "Continue?",
      options: [{ label: "Yes", payload: "Continue" }],
    },
    todos: [
      {
        id: "todo-1",
        content: "Finish work",
        activeForm: "Finishing work",
        status: "in_progress",
      },
    ],
    debugInfo: { model: "claude-sonnet-4-6" },
    systemPrompt: "system prompt",
    loadedInstructions: [{ source: "CLAUDE.md", chars: 100 }],
    restoringSession: true,
    revertRecoveryNotice: {
      projectId: "project-test",
      checkpointId: "checkpoint-1",
      sessionRevision: "revision-1",
      workspaceRevision: "abcdef",
      startedAt: 123,
      title: "Recovery needed",
      message: "Retry the save.",
    },
    ...overrides,
  };
}

describe("createBrowserForegroundSnapshot", () => {
  it("maps browser-visible foreground state and applies the reasoning fallback", () => {
    const snapshot = createBrowserForegroundSnapshot(
      "session-1",
      createState(),
    );

    expect(snapshot).toMatchObject({
      sessionId: "session-1",
      mode: "code",
      model: "claude-sonnet-4-6",
      streaming: true,
      interrupted: true,
      statusOverride: "Working",
      lastInputTokens: 12,
      lastOutputTokens: 34,
      lastCacheReadTokens: 56,
      estimatedTotalUsed: 78,
      thinkingEnabled: true,
      reasoningEffort: "high",
      restoringSession: true,
      condenseThreshold: 0.75,
      systemPrompt: "system prompt",
    });

    expect(
      createBrowserForegroundSnapshot(
        "session-1",
        createState({
          thinkingEnabled: false,
          chatState: {
            ...createState().chatState,
            reasoningEffort: undefined,
          },
        }),
      ).reasoningEffort,
    ).toBe("none");
    expect(
      createBrowserForegroundSnapshot(
        "session-1",
        createState({
          chatState: {
            ...createState().chatState,
            reasoningEffort: "medium",
          },
        }),
      ).reasoningEffort,
    ).toBe("medium");
  });

  it("copies every mutable container copied by the browser projection contract", () => {
    const state = createState();
    const snapshot = createBrowserForegroundSnapshot("session-1", state);

    expect(snapshot.projectedMessages).not.toBe(state.messages);
    expect(snapshot.projectedMessages[0]).toBe(state.messages[0]);
    expect(snapshot.messageQueue).not.toBe(state.messageQueue);
    expect(snapshot.messageQueue[0]).not.toBe(state.messageQueue[0]);
    expect(snapshot.messageQueue[0].attachments).not.toBe(
      state.messageQueue[0].attachments,
    );
    expect(snapshot.messageQueue[0].images?.[0]).not.toBe(
      state.messageQueue[0].images?.[0],
    );
    expect(snapshot.messageQueue[0].documents?.[0]).not.toBe(
      state.messageQueue[0].documents?.[0],
    );
    expect(snapshot.questionRequest).not.toBe(state.questionRequest);
    expect(snapshot.questionRequest?.questions[0]).not.toBe(
      state.questionRequest?.questions[0],
    );
    expect(snapshot.detectedQuestion).not.toBe(state.detectedQuestion);
    expect(snapshot.detectedQuestion?.options[0]).not.toBe(
      state.detectedQuestion?.options[0],
    );
    expect(snapshot.todos[0]).not.toBe(state.todos[0]);
    expect(snapshot.debugInfo).not.toBe(state.debugInfo);
    expect(snapshot.loadedInstructions?.[0]).not.toBe(
      state.loadedInstructions?.[0],
    );
    expect(snapshot.contextBudget).not.toBe(state.chatState.contextBudget);
    expect(snapshot.revertRecoveryNotice).not.toBe(state.revertRecoveryNotice);
  });

  it("preserves null and undefined optional projection values", () => {
    const state = createState({
      questionRequest: null,
      detectedQuestion: null,
      debugInfo: null,
      loadedInstructions: null,
      revertRecoveryNotice: null,
      messageQueue: [{ id: "queue-1", text: "queued" }],
      chatState: {
        ...createState().chatState,
        contextBudget: undefined,
        condenseThreshold: undefined,
      },
    });

    expect(createBrowserForegroundSnapshot("session-1", state)).toMatchObject({
      questionRequest: null,
      detectedQuestion: null,
      debugInfo: null,
      loadedInstructions: null,
      contextBudget: undefined,
      condenseThreshold: undefined,
      revertRecoveryNotice: null,
      messageQueue: [
        {
          attachments: undefined,
          images: undefined,
          documents: undefined,
        },
      ],
    });
  });
});
