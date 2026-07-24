import { describe, expect, it } from "vitest";

import type { AppState } from "./chatProjection.js";
import type { ChatMessage } from "../agent/webview/types.js";
import {
  agentMessagesToChatMessages,
  initialState,
  reducer,
} from "./chatProjection.js";

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
