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

  it("preserves live queue, approval, and usage fields during same-session hydration", () => {
    const current: AppState = {
      ...initialState,
      chatState: { ...initialState.chatState, sessionId: "session-1" },
      messageQueue: [queuedMessage],
      approvalRequest: {
        kind: "write",
        id: "approval-1",
        filePath: "src/one.ts",
        writeOperation: "modify",
      },
      questionRequest: { id: "question-1", context: "", questions: [] },
      lastCacheReadTokens: 125_000,
      estimatedTotalUsed: 250_000,
    };

    const loaded = loadSession(current, "session-1");

    expect(loaded.messageQueue).toEqual([queuedMessage]);
    expect(loaded.approvalRequest?.id).toBe("approval-1");
    expect(loaded.questionRequest?.id).toBe("question-1");
    expect(loaded.lastCacheReadTokens).toBe(125_000);
    expect(loaded.estimatedTotalUsed).toBe(250_000);
  });

  it("clears session-local queue, approval, and usage fields during cross-session hydration", () => {
    const current: AppState = {
      ...initialState,
      chatState: { ...initialState.chatState, sessionId: "session-1" },
      messageQueue: [queuedMessage],
      approvalRequest: {
        kind: "write",
        id: "approval-1",
        filePath: "src/one.ts",
        writeOperation: "modify",
      },
      questionRequest: { id: "question-1", context: "", questions: [] },
      lastCacheReadTokens: 125_000,
      estimatedTotalUsed: 250_000,
    };

    const loaded = loadSession(current, "session-2");

    expect(loaded.messageQueue).toEqual([]);
    expect(loaded.approvalRequest).toBeNull();
    expect(loaded.questionRequest).toBeNull();
    expect(loaded.lastCacheReadTokens).toBe(0);
    expect(loaded.estimatedTotalUsed).toBe(0);
  });

  it("clears approvals only when the request identity matches", () => {
    const approval = {
      kind: "write" as const,
      id: "approval-1",
      filePath: "src/one.ts",
      writeOperation: "modify" as const,
    };
    const withApproval = reducer(initialState, {
      type: "SET_APPROVAL",
      request: approval,
    });

    expect(
      reducer(withApproval, { type: "CLEAR_APPROVAL", id: "approval-other" })
        .approvalRequest,
    ).toEqual(approval);
    expect(
      reducer(withApproval, { type: "CLEAR_APPROVAL", id: approval.id })
        .approvalRequest,
    ).toBeNull();
    expect(
      reducer(withApproval, { type: "CLEAR_INTERACTION_PROMPTS" })
        .approvalRequest,
    ).toBeNull();
    expect(
      reducer(withApproval, { type: "NEW_SESSION" }).approvalRequest,
    ).toBeNull();
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

    expect(restored).toBe(destination);
    expect(restored.messageQueue).toBe(destination.messageQueue);
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

describe("deferred native tool chat projection", () => {
  it("renders the canonical target without mutating provider replay history", () => {
    const wrapperInput = {
      name: "get_call_hierarchy",
      input: {
        path: "src/file.ts",
        line: 1,
        column: 1,
        direction: "both",
      },
    };
    const source = [
      {
        role: "assistant" as const,
        content: [
          {
            type: "tool_use" as const,
            id: "native-1",
            name: "call_native_tool",
            input: wrapperInput,
          },
        ],
      },
      {
        role: "user" as const,
        content: [
          {
            type: "tool_result" as const,
            tool_use_id: "native-1",
            content: "hierarchy",
          },
        ],
      },
    ];

    const messages = agentMessagesToChatMessages(source);

    expect(messages[0]?.blocks[0]).toMatchObject({
      type: "tool_call",
      id: "native-1",
      name: "get_call_hierarchy",
      inputJson: JSON.stringify(wrapperInput.input),
      result: "hierarchy",
    });
    expect(source[0]?.content[0]).toEqual({
      type: "tool_use",
      id: "native-1",
      name: "call_native_tool",
      input: wrapperInput,
    });
  });

  it("does not let wrappers impersonate inline session controls", () => {
    const messages = agentMessagesToChatMessages([
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "native-1",
            name: "call_native_tool",
            input: { name: "ask_user", input: { questions: [] } },
          },
        ],
      },
    ]);

    expect(messages[0]?.blocks[0]).toMatchObject({
      type: "tool_call",
      name: "call_native_tool",
    });
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

describe("ask_user result projection", () => {
  const question = {
    id: "choice",
    type: "multiple_choice" as const,
    question: "Which option?",
    options: ["A", "B"],
    recommended: "A",
  };

  function pendingQuestionState() {
    let state = reducer(initialState, {
      type: "TOOL_START" as const,
      toolCallId: "tool-ask-1",
      toolName: "ask_user",
      input: { context: "Choose.", questions: [question] },
    });
    state = reducer(state, {
      type: "SET_QUESTION",
      id: "request-1",
      context: "Choose.",
      questions: [question],
    });
    return state;
  }

  it("projects submitted answers immediately and reconciles the durable result", () => {
    let state = reducer(pendingQuestionState(), {
      type: "SUBMIT_QUESTION",
      id: "request-1",
      answers: { choice: "B" },
      notes: { choice: "Use the smaller scope." },
    });

    expect(state.questionRequest).toBeNull();
    expect(state.messages.flatMap((message) => message.blocks)).toContainEqual({
      type: "question_answer",
      toolCallId: "tool-ask-1",
      items: [
        {
          question: "Which option?",
          answer: "B",
          note: "Use the smaller scope.",
        },
      ],
    });

    state = reducer(state, {
      type: "TOOL_COMPLETE",
      toolCallId: "tool-ask-1",
      toolName: "ask_user",
      result: JSON.stringify({
        responses: [{ question: "Which option?", answer: "B" }],
      }),
      durationMs: 1,
    });

    const answerBlocks = state.messages
      .flatMap((message) => message.blocks)
      .filter((block) => block.type === "question_answer");
    expect(answerBlocks).toEqual([
      {
        type: "question_answer",
        toolCallId: "tool-ask-1",
        items: [{ question: "Which option?", answer: "B" }],
      },
    ]);
  });

  it("reconstructs a missing ask_user tool call from the question request", () => {
    let state = reducer(initialState, {
      type: "SET_STATUS_OVERRIDE",
      message: "Retrying…",
    });
    state = reducer(state, {
      type: "SET_QUESTION",
      id: "request-1",
      toolCallId: "tool-ask-1",
      context: "Choose.",
      questions: [question],
    });

    expect(state.messages.flatMap((message) => message.blocks)).toContainEqual({
      type: "tool_call",
      id: "tool-ask-1",
      name: "ask_user",
      inputJson: JSON.stringify({ context: "Choose.", questions: [question] }),
      result: "",
      complete: false,
    });

    state = reducer(state, {
      type: "SUBMIT_QUESTION",
      id: "request-1",
      answers: { choice: "B" },
      notes: {},
    });
    state = reducer(state, {
      type: "TOOL_START",
      toolCallId: "tool-ask-1",
      toolName: "ask_user",
      input: { context: "Choose.", questions: [question] },
    });

    const blocks = state.messages.flatMap((message) => message.blocks);
    expect(
      blocks.filter(
        (block) => block.type === "tool_call" && block.id === "tool-ask-1",
      ),
    ).toHaveLength(1);
    expect(blocks).toContainEqual({
      type: "question_answer",
      toolCallId: "tool-ask-1",
      items: [{ question: "Which option?", answer: "B" }],
    });
    expect(state.statusOverride).toBeNull();
  });

  it("does not synthesize a foreground tool call for a background question", () => {
    const state = reducer(initialState, {
      type: "SET_QUESTION",
      id: "request-bg",
      toolCallId: "tool-ask-bg",
      context: "Background review needs input.",
      questions: [question],
      backgroundTask: "Review implementation",
    });

    expect(state.questionRequest).toMatchObject({
      id: "request-bg",
      toolCallId: "tool-ask-bg",
      backgroundTask: "Review implementation",
    });
    expect(
      state.messages
        .flatMap((message) => message.blocks)
        .some((block) => block.type === "tool_call"),
    ).toBe(false);
  });

  it("does not infer a foreground tool call for an uncorrelated background question", () => {
    let state = reducer(initialState, {
      type: "TOOL_START",
      toolCallId: "tool-ask-foreground",
      toolName: "ask_user",
      input: { context: "Foreground choice.", questions: [question] },
    });
    state = reducer(state, {
      type: "SET_QUESTION",
      id: "request-bg",
      context: "Background review needs input.",
      questions: [question],
      backgroundTask: "Review implementation",
    });

    expect(state.questionRequest).toMatchObject({
      id: "request-bg",
      backgroundTask: "Review implementation",
    });
    expect(state.questionRequest).not.toHaveProperty("toolCallId");

    state = reducer(state, {
      type: "SUBMIT_QUESTION",
      id: "request-bg",
      answers: { choice: "B" },
      notes: {},
    });
    expect(
      state.messages
        .flatMap((message) => message.blocks)
        .some((block) => block.type === "question_answer"),
    ).toBe(false);
  });

  it("uses an explicit tool-call ID when multiple ask_user calls are present", () => {
    let state = reducer(initialState, {
      type: "TOOL_START",
      toolCallId: "tool-ask-1",
      toolName: "ask_user",
      input: { context: "First.", questions: [question] },
    });
    state = reducer(state, {
      type: "TOOL_START",
      toolCallId: "tool-ask-2",
      toolName: "ask_user",
      input: { context: "Second.", questions: [question] },
    });

    state = reducer(state, {
      type: "SET_QUESTION",
      id: "request-1",
      toolCallId: "tool-ask-1",
      context: "First.",
      questions: [question],
    });
    state = reducer(state, {
      type: "SUBMIT_QUESTION",
      id: "request-1",
      answers: { choice: "A" },
      notes: {},
    });

    expect(state.messages.flatMap((message) => message.blocks)).toContainEqual({
      type: "question_answer",
      toolCallId: "tool-ask-1",
      items: [{ question: "Which option?", answer: "A" }],
    });
  });

  it("ignores a delayed clear for an earlier question", () => {
    let state = pendingQuestionState();
    state = reducer(state, {
      type: "SET_QUESTION",
      id: "request-2",
      context: "Choose again.",
      questions: [question],
    });

    const next = reducer(state, { type: "CLEAR_QUESTION", id: "request-1" });

    expect(next.questionRequest?.id).toBe("request-2");
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

describe("context health projection", () => {
  const health = {
    memory: {
      status: "ready" as const,
      retrieval: "hybrid" as const,
      activeRecordCount: 7,
    },
    retrieval: {
      status: "degraded" as const,
      lexical: "ready" as const,
      vector: "unavailable" as const,
      structural: "ready" as const,
      sourceCount: 12,
      chunkCount: 48,
      staleSourceCount: 2,
    },
    index: {
      status: "working" as const,
      state: "indexing" as const,
      current: 3,
      total: 10,
    },
  };

  it("preserves health across partial state updates and replaces explicit values", () => {
    const withHealth = reducer(initialState, {
      type: "SET_STATE",
      state: {
        sessionId: "session-1",
        mode: "code",
        model: "gpt-5.6-sol",
        streaming: false,
        contextHealth: health,
      },
    });
    const preserved = reducer(withHealth, {
      type: "SET_STATE",
      state: {
        sessionId: "session-1",
        mode: "code",
        model: "gpt-5.6-sol",
        streaming: true,
      },
    });
    const cleared = reducer(preserved, {
      type: "SET_STATE",
      state: {
        sessionId: "session-1",
        mode: "code",
        model: "gpt-5.6-sol",
        streaming: false,
        contextHealth: null,
      },
    });

    expect(preserved.contextHealth).toBe(health);
    expect(cleared.contextHealth).toBeNull();
  });
});
