import {
  agentMessagesToChatMessages,
  initialState,
  reducer,
} from "./chatProjection.js";
import { describe, expect, it } from "vitest";

import type { AppState } from "./chatProjection.js";
import type { ChatMessage } from "../agent/webview/types.js";

describe("initial chat projection", () => {
  it("does not claim a model before host state is hydrated", () => {
    expect(initialState.chatState.model).toBe("");
  });
});

describe("original prompt projection", () => {
  it("keeps the first submitted prompt stable across later user turns", () => {
    const afterFirst = reducer(initialState, {
      type: "ADD_USER_MESSAGE",
      text: "Original prompt",
    });
    const afterSecond = reducer(afterFirst, {
      type: "ADD_USER_MESSAGE",
      text: "Later follow-up",
    });

    expect(afterFirst.originalPrompt).toBe("Original prompt");
    expect(afterSecond.originalPrompt).toBe("Original prompt");
    expect(reducer(afterSecond, { type: "NEW_SESSION" }).originalPrompt).toBe(
      null,
    );
  });

  it("uses the explicit original prompt when a restored transcript contains only a tail", () => {
    const restored = reducer(initialState, {
      type: "LOAD_SESSION",
      sessionId: "session-1",
      title: "Session",
      originalPrompt: "Original prompt",
      mode: "code",
      model: "model",
      messages: [
        {
          id: "recent-user",
          role: "user",
          content: "Recent follow-up",
          timestamp: 1,
          blocks: [],
        },
      ],
      todos: [],
      userTurnOffset: 8,
      hasMoreBefore: true,
    });

    expect(restored.originalPrompt).toBe("Original prompt");
  });
});

describe("session projection isolation", () => {
  const queuedMessage = {
    id: "queue-1",
    text: "queued message",
    displayText: "queued message",
    isSlashCommand: false,
  };

  function loadSession(state: AppState, sessionId: string): AppState {
    return reducer(state, {
      type: "LOAD_SESSION",
      sessionId,
      title: "Session",
      mode: "code",
      model: "model",
      messages: [],
      todos: [],
    });
  }

  it("preserves live queue and usage fields during same-session hydration", () => {
    const current: AppState = {
      ...initialState,
      chatState: { ...initialState.chatState, sessionId: "session-1" },
      messageQueue: [queuedMessage],
      questionRequest: { id: "question-1", context: "", questions: [] },
      lastCacheReadTokens: 125_000,
      estimatedTotalUsed: 250_000,
    };

    const loaded = loadSession(current, "session-1");

    expect(loaded.messageQueue).toEqual([queuedMessage]);
    expect(loaded.questionRequest?.id).toBe("question-1");
    expect(loaded.lastCacheReadTokens).toBe(125_000);
    expect(loaded.estimatedTotalUsed).toBe(250_000);
  });

  it("clears session-local queue and usage fields during cross-session hydration", () => {
    const current: AppState = {
      ...initialState,
      chatState: { ...initialState.chatState, sessionId: "session-1" },
      messageQueue: [queuedMessage],
      questionRequest: { id: "question-1", context: "", questions: [] },
      lastCacheReadTokens: 125_000,
      estimatedTotalUsed: 250_000,
    };

    const loaded = loadSession(current, "session-2");

    expect(loaded.messageQueue).toEqual([]);
    expect(loaded.questionRequest).toBeNull();
    expect(loaded.lastCacheReadTokens).toBe(0);
    expect(loaded.estimatedTotalUsed).toBe(0);
  });

  it("restores the supplied projection without retaining fields from current state", () => {
    const current: AppState = {
      ...initialState,
      chatState: { ...initialState.chatState, sessionId: "session-1" },
      estimatedTotalUsed: 250_000,
    };
    const destination: AppState = {
      ...initialState,
      chatState: { ...initialState.chatState, sessionId: "session-2" },
      messageQueue: [queuedMessage],
      lastCacheReadTokens: 50_000,
      estimatedTotalUsed: 75_000,
    };

    const restored = reducer(current, {
      type: "RESTORE_PROJECTION",
      state: destination,
    });

    expect(restored).toEqual(destination);
    expect(restored).not.toBe(destination);
    expect(restored.messageQueue).not.toBe(destination.messageQueue);
  });
});

describe("legacy web activity chat projection", () => {
  it("assigns distinct fallback IDs to malformed persisted activities", () => {
    const messages = agentMessagesToChatMessages([
      {
        role: "assistant",
        content: [
          {
            type: "web_activity",
            activity: {
              id: undefined as unknown as string,
              kind: "search",
              status: "started",
              backend: "provider",
              query: "first",
            },
          },
          {
            type: "web_activity",
            activity: {
              id: undefined as unknown as string,
              kind: "search",
              status: "started",
              backend: "provider",
              query: "second",
            },
          },
        ],
      },
    ]);

    const toolCalls = messages[0]?.blocks.filter(
      (block) => block.type === "tool_call",
    );
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls?.[0]).toMatchObject({ name: "web_search" });
    expect(toolCalls?.[1]).toMatchObject({ name: "web_search" });
    expect(toolCalls?.[0]?.id).not.toBe(toolCalls?.[1]?.id);
  });

  it("projects legacy provider activity as a normal tool call with only public fields", () => {
    const messages = agentMessagesToChatMessages([
      {
        role: "assistant",
        content: [
          {
            type: "web_activity",
            activity: {
              id: "search-1",
              kind: "search",
              status: "completed",
              backend: "provider",
              query: "AgentLink",
              privatePayload: "must-not-project",
            },
          },
          {
            type: "text",
            text: "Result",
            citations: [
              { url: "https://example.com/result", title: "Result source" },
              { url: "data:text/plain,secret", title: "Unsafe source" },
            ],
          },
        ],
        providerReplay: {
          providerId: "anthropic",
          codecVersion: 1,
          payload: { encrypted_content: "secret" },
          serializedBytes: 10,
        },
      },
    ]);

    expect(JSON.stringify(messages)).not.toContain("privatePayload");
    expect(JSON.stringify(messages)).not.toContain("encrypted_content");
    expect(messages[0]?.blocks).toHaveLength(2);
    const tool = messages[0]?.blocks[0];
    expect(tool).toMatchObject({
      type: "tool_call",
      id: "search-1",
      name: "web_search",
      inputJson: JSON.stringify({ query: "AgentLink" }),
      complete: true,
    });
    expect(tool?.type === "tool_call" ? JSON.parse(tool.result) : null).toEqual(
      {
        id: "search-1",
        kind: "search",
        status: "completed",
        backend: "provider",
        query: "AgentLink",
        citations: [
          { url: "https://example.com/result", title: "Result source" },
        ],
      },
    );
    expect(messages[0]?.blocks[1]).toEqual({ type: "text", text: "Result" });
  });
});

describe("assistant image chat projection", () => {
  it("projects restored tool-result documents onto the tool call", () => {
    const messages = agentMessagesToChatMessages([
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "ask-1",
            name: "ask_user",
            input: { questions: [] },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "ask-1",
            content: [
              { type: "text", text: '{"responses":[]}' },
              {
                type: "document",
                title: "brief.pdf",
                source: {
                  type: "base64",
                  media_type: "application/pdf",
                  data: "pdf-data",
                },
              },
            ],
          },
        ],
      },
    ]);

    expect(messages[0]?.blocks[0]).toMatchObject({
      type: "tool_call",
      id: "ask-1",
      resultDocuments: [
        {
          name: "brief.pdf",
          mimeType: "application/pdf",
          data: "pdf-data",
        },
      ],
    });
  });

  it("projects direct assistant images into shared display media", () => {
    const messages = agentMessagesToChatMessages([
      {
        role: "assistant",
        content: [
          { type: "text", text: "Generated result" },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: "YWJjZA==",
            },
          },
        ],
      },
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.blocks).toEqual([
      { type: "text", text: "Generated result" },
    ]);
    expect(messages[0]?.displayMedia).toEqual({
      images: [
        {
          name: "generated-image-1.png",
          mimeType: "image/png",
          src: "data:image/png;base64,YWJjZA==",
        },
      ],
      documents: [],
    });
  });
});

describe("tool lifecycle projection", () => {
  it("refreshes a tool card with a non-empty completion title", () => {
    let state = reducer(initialState, {
      type: "TOOL_START",
      toolCallId: "acp-read",
      toolName: "Read",
      input: { file_path: "src/index.ts" },
    });

    state = reducer(state, {
      type: "TOOL_COMPLETE",
      toolCallId: "acp-read",
      toolName: "Read: src/index.ts",
      result: "contents",
      durationMs: 12,
      input: { file_path: "src/index.ts" },
    });

    expect(state.messages[0]?.blocks).toContainEqual(
      expect.objectContaining({
        type: "tool_call",
        id: "acp-read",
        name: "Read: src/index.ts",
        complete: true,
        result: "contents",
      }),
    );
  });

  it("does not blank a tool card when completion has an empty title", () => {
    let state = reducer(initialState, {
      type: "TOOL_START",
      toolCallId: "acp-read",
      toolName: "Read",
    });

    state = reducer(state, {
      type: "TOOL_COMPLETE",
      toolCallId: "acp-read",
      toolName: "",
      result: "contents",
      durationMs: 12,
    });

    expect(state.messages[0]?.blocks).toContainEqual(
      expect.objectContaining({ name: "Read", complete: true }),
    );
  });
});

describe("BG_AGENT_DONE result placement", () => {
  const bgDone = {
    type: "BG_AGENT_DONE" as const,
    sessionId: "bg-1",
    task: "Review implementation",
    status: "completed" as const,
    resultText: "Looks good.",
  };

  function stateWith(
    blocks: ChatMessage["blocks"],
    streaming: boolean,
  ): AppState {
    return {
      ...initialState,
      streaming,
      messages: [
        {
          id: "assistant-1",
          role: "assistant",
          content: "",
          timestamp: 1,
          blocks,
        },
      ],
    };
  }

  it("inserts the result before a still-running tool call at the tail", () => {
    const state = stateWith(
      [
        { type: "thinking", id: "think-1", text: "Plan.", complete: true },
        {
          type: "tool_call",
          id: "tool-1",
          name: "read_file",
          inputJson: "{}",
          result: "",
          complete: false,
        },
      ],
      true,
    );

    const next = reducer(state, bgDone);

    expect(next.messages[0].blocks.map((b) => b.type)).toEqual([
      "thinking",
      "bg_agent_result",
      "tool_call",
    ]);
  });

  it("moves an early result after get_background_result when the tool completes", () => {
    let state = stateWith(
      [
        {
          type: "tool_call",
          id: "tool-result",
          name: "get_background_result",
          inputJson: JSON.stringify({ sessionId: "bg-1" }),
          result: "",
          complete: false,
        },
      ],
      true,
    );

    state = reducer(state, bgDone);
    expect(state.messages[0].blocks.map((block) => block.type)).toEqual([
      "bg_agent_result",
      "tool_call",
    ]);

    state = reducer(state, {
      type: "TOOL_COMPLETE",
      toolCallId: "tool-result",
      toolName: "get_background_result",
      result: "Looks good.",
      durationMs: 1,
      input: { sessionId: "bg-1" },
    });

    expect(state.messages[0].blocks.map((block) => block.type)).toEqual([
      "tool_call",
      "bg_agent_result",
    ]);
    expect(
      state.messages[0].blocks.filter(
        (block) => block.type === "bg_agent_result",
      ),
    ).toHaveLength(1);
  });

  it("moves a standalone early result into the earlier completed tool message", () => {
    let state: AppState = {
      ...initialState,
      streaming: true,
      messages: [
        {
          id: "assistant-tool",
          role: "assistant",
          content: "",
          timestamp: 1,
          blocks: [
            {
              type: "tool_call",
              id: "tool-result",
              name: "get_background_result",
              inputJson: JSON.stringify({ sessionId: "bg-1" }),
              result: "",
              complete: false,
            },
          ],
        },
        {
          id: "user-later",
          role: "user",
          content: "Unrelated interjection",
          timestamp: 2,
          blocks: [],
        },
      ],
    };

    state = reducer(state, bgDone);
    expect(state.messages).toHaveLength(3);

    state = reducer(state, {
      type: "TOOL_COMPLETE",
      toolCallId: "tool-result",
      toolName: "get_background_result",
      result: "Looks good.",
      durationMs: 1,
      input: { sessionId: "bg-1" },
    });

    expect(state.messages).toHaveLength(2);
    expect(state.messages[0].blocks.map((block) => block.type)).toEqual([
      "tool_call",
      "bg_agent_result",
    ]);
    expect(
      state.messages
        .flatMap((message) => message.blocks)
        .filter((block) => block.type === "bg_agent_result"),
    ).toHaveLength(1);
  });

  it("does not leave an empty assistant row when a pushed result repeats", () => {
    let state: AppState = {
      ...initialState,
      messages: [
        {
          id: "user-1",
          role: "user",
          content: "Start review",
          timestamp: 1,
          blocks: [],
        },
      ],
    };

    state = reducer(state, bgDone);
    state = {
      ...state,
      messages: [
        ...state.messages,
        {
          id: "user-2",
          role: "user",
          content: "Meanwhile",
          timestamp: 2,
          blocks: [],
        },
      ],
    };
    state = reducer(state, { ...bgDone, summary: "Still complete." });

    expect(
      state.messages.filter(
        (message) =>
          message.role === "assistant" &&
          message.blocks.length === 0 &&
          message.content.length === 0,
      ),
    ).toEqual([]);
    expect(
      state.messages
        .flatMap((message) => message.blocks)
        .filter((block) => block.type === "bg_agent_result"),
    ).toHaveLength(1);
  });

  it("preserves the live streaming shell when a background result is pushed", () => {
    const state: AppState = {
      ...initialState,
      streaming: true,
      messages: [
        {
          id: "assistant-complete",
          role: "assistant",
          content: "",
          timestamp: 1,
          blocks: [
            {
              type: "bg_agent_result",
              sessionId: "bg-1",
              task: "Review implementation",
              status: "completed",
              resultText: "Earlier result.",
            },
          ],
        },
        {
          id: "assistant-streaming",
          role: "assistant",
          content: "",
          timestamp: 2,
          blocks: [],
        },
      ],
    };

    const next = reducer(state, bgDone);

    expect(next.messages.map((message) => message.id)).toEqual([
      "assistant-streaming",
    ]);
    expect(next.messages[0].blocks).toEqual([
      expect.objectContaining({ type: "bg_agent_result", sessionId: "bg-1" }),
    ]);
  });

  it("preserves the live streaming shell when get_background_result completes", () => {
    const state: AppState = {
      ...initialState,
      streaming: true,
      messages: [
        {
          id: "assistant-tool",
          role: "assistant",
          content: "",
          timestamp: 1,
          blocks: [
            {
              type: "tool_call",
              id: "tool-result",
              name: "get_background_result",
              inputJson: JSON.stringify({ sessionId: "bg-1" }),
              result: "",
              complete: false,
            },
          ],
        },
        {
          id: "assistant-streaming",
          role: "assistant",
          content: "",
          timestamp: 2,
          blocks: [],
        },
      ],
    };

    const next = reducer(state, {
      type: "TOOL_COMPLETE",
      toolCallId: "tool-result",
      toolName: "get_background_result",
      result: "Looks good.",
      durationMs: 1,
      input: { sessionId: "bg-1" },
    });

    expect(next.messages.map((message) => message.id)).toEqual([
      "assistant-tool",
      "assistant-streaming",
    ]);
    expect(next.messages[0].blocks.map((block) => block.type)).toEqual([
      "tool_call",
      "bg_agent_result",
    ]);
    expect(next.messages[1].blocks).toEqual([]);
  });

  it("updates one result after a completed get_background_result tool call", () => {
    let state = stateWith(
      [
        {
          type: "tool_call",
          id: "tool-result",
          name: "get_background_result",
          inputJson: JSON.stringify({ sessionId: "bg-1" }),
          result: "",
          complete: false,
        },
      ],
      true,
    );

    state = reducer(state, {
      type: "TOOL_COMPLETE",
      toolCallId: "tool-result",
      toolName: "get_background_result",
      result: "Looks good.",
      durationMs: 1,
      input: { sessionId: "bg-1" },
    });
    state = reducer(state, {
      ...bgDone,
      resultText: undefined,
      summary: "No blocking issues.",
    });

    expect(state.messages[0].blocks.map((block) => block.type)).toEqual([
      "tool_call",
      "bg_agent_result",
    ]);
    expect(state.messages[0].blocks[1]).toMatchObject({
      type: "bg_agent_result",
      sessionId: "bg-1",
      resultText: "Looks good.",
      summary: "No blocking issues.",
    });
  });

  it("appends the result after completed blocks during a streaming gap", () => {
    const state = stateWith(
      [
        {
          type: "tool_call",
          id: "tool-1",
          name: "read_file",
          inputJson: "{}",
          result: "done",
          complete: true,
        },
      ],
      true,
    );

    const next = reducer(state, bgDone);

    expect(next.messages[0].blocks.map((b) => b.type)).toEqual([
      "tool_call",
      "bg_agent_result",
    ]);
  });

  it("inserts the result before text that is still streaming", () => {
    const state = stateWith(
      [{ type: "text", text: "Streaming answer so far" }],
      true,
    );

    const next = reducer(state, bgDone);

    expect(next.messages[0].blocks.map((b) => b.type)).toEqual([
      "bg_agent_result",
      "text",
    ]);
  });

  it("appends the result after text when the foreground turn is idle", () => {
    const state = stateWith([{ type: "text", text: "Finished answer" }], false);

    const next = reducer(state, bgDone);

    expect(next.messages[0].blocks.map((b) => b.type)).toEqual([
      "text",
      "bg_agent_result",
    ]);
  });

  it("creates a standalone assistant message when the last message is from the user", () => {
    const state: AppState = {
      ...initialState,
      messages: [
        {
          id: "user-1",
          role: "user",
          content: "Please check this",
          timestamp: 1,
          blocks: [],
        },
      ],
    };

    const next = reducer(state, bgDone);

    expect(next.messages).toHaveLength(2);
    expect(next.messages[1].role).toBe("assistant");
    expect(next.messages[1].blocks.map((b) => b.type)).toEqual([
      "bg_agent_result",
    ]);
  });

  it("rehydrates durable results missing from persisted parent messages", () => {
    const next = reducer(initialState, {
      type: "LOAD_SESSION",
      sessionId: "foreground-1",
      title: "Restored session",
      mode: "code",
      model: "gpt-5.6-sol",
      messages: [
        {
          id: "assistant-1",
          role: "assistant",
          content: "",
          timestamp: 1,
          blocks: [{ type: "text", text: "Foreground response" }],
        },
      ],
      todos: [],
      backgroundResults: [
        {
          sessionId: "bg-restored",
          task: "Review implementation",
          status: "completed",
          resultText: "Found one issue.",
          summary: "One issue found",
          completedAt: 2,
        },
      ],
    });

    expect(next.messages[0].blocks).toEqual([
      { type: "text", text: "Foreground response" },
      {
        type: "bg_agent_result",
        sessionId: "bg-restored",
        task: "Review implementation",
        status: "completed",
        resultText: "Found one issue.",
        summary: "One issue found",
      },
    ]);
  });

  it("does not duplicate a background result already restored from tool history", () => {
    const existingResult = {
      type: "bg_agent_result" as const,
      sessionId: "bg-restored",
      task: "Review implementation",
      status: "completed" as const,
      resultText: "Found one issue.",
    };
    const next = reducer(initialState, {
      type: "LOAD_SESSION",
      sessionId: "foreground-1",
      title: "Restored session",
      mode: "code",
      model: "gpt-5.6-sol",
      messages: [
        {
          id: "assistant-1",
          role: "assistant",
          content: "",
          timestamp: 1,
          blocks: [existingResult],
        },
      ],
      todos: [],
      backgroundResults: [
        {
          sessionId: "bg-restored",
          task: "Review implementation",
          status: "completed",
          resultText: "Found one issue.",
          completedAt: 2,
        },
      ],
    });

    expect(
      next.messages.flatMap((message) =>
        message.blocks.filter(
          (block) =>
            block.type === "bg_agent_result" &&
            block.sessionId === "bg-restored",
        ),
      ),
    ).toHaveLength(1);
  });
});
