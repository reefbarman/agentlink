import {
  agentMessagesToChatMessages,
  initialState,
  reducer,
} from "./chatProjection.js";
import { describe, expect, it } from "vitest";

import type { AppState } from "./chatProjection.js";
import type { ChatMessage } from "../agent/webview/types.js";

describe("fresh-session handoff chat projection", () => {
  it("projects a valid handoff hint while retaining the ordinary user content", () => {
    const messages = agentMessagesToChatMessages([
      {
        role: "user",
        content: "Continue this work in a fresh session.",
        uiHint: {
          handoff: {
            schemaVersion: 1,
            sourceSessionId: "source-session",
            sourceTitle: "Source task",
            handoffId: "handoff-1",
          },
        },
      },
    ]);

    expect(messages[0]).toMatchObject({
      role: "user",
      content: "Continue this work in a fresh session.",
      handoff: {
        sourceSessionId: "source-session",
        sourceTitle: "Source task",
        handoffId: "handoff-1",
      },
    });
  });
});

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

describe("surface change projection", () => {
  const change = {
    model: { previousModel: "gpt-5.4", model: "gpt-5.6-sol" },
    reasoning: {
      previousReasoningEffort: "high" as const,
      reasoningEffort: "low" as const,
    },
  };

  it("keeps a fresh assistant shell after an in-turn marker", () => {
    const streaming = reducer(initialState, {
      type: "ADD_USER_MESSAGE",
      text: "Start",
    });
    const changed = reducer(streaming, {
      type: "ADD_SURFACE_CHANGE",
      change,
    });

    expect(changed.messages.at(-2)?.surfaceChange).toEqual(change);
    expect(changed.messages.at(-1)).toMatchObject({
      role: "assistant",
      blocks: [],
    });
    expect(changed.messages.at(-1)?.surfaceChange).toBeUndefined();
  });

  it("keeps a marker after the condense row when the change happens during condense", () => {
    const condensing = reducer(initialState, { type: "CONDENSE_START" });
    const changed = reducer(condensing, {
      type: "ADD_SURFACE_CHANGE",
      change,
    });
    const completed = reducer(changed, {
      type: "ADD_CONDENSE",
      prevInputTokens: 10_000,
      newInputTokens: 2_000,
      durationMs: 25,
    });

    const condenseIndex = completed.messages.findIndex(
      (message) => message.role === "condense",
    );
    const markerIndex = completed.messages.findIndex(
      (message) => message.surfaceChange,
    );
    expect(condenseIndex).toBeGreaterThanOrEqual(0);
    expect(markerIndex).toBeGreaterThan(condenseIndex);
    expect(
      completed.messages[condenseIndex]?.condenseInfo?.condensing,
    ).toBeFalsy();
  });

  it("restores persisted transcript-only surface changes", () => {
    const messages = agentMessagesToChatMessages([
      {
        role: "assistant",
        content: [],
        diagnosticOnly: true,
        uiHint: { surfaceChange: change },
      },
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: "assistant",
      blocks: [],
      surfaceChange: change,
    });
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
        durationMs: 12,
        startedAt: expect.any(Number),
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
    completion: {
      sessionId: "bg-1",
      task: "Review implementation",
      status: "completed" as const,
      resultState: "completed" as const,
      resultText: "Looks good.",
      completedAt: 1,
    },
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
    state = reducer(state, {
      ...bgDone,
      completion: { ...bgDone.completion, summary: "Still complete." },
    });

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
      completion: {
        ...bgDone.completion,
        resultText: undefined,
        summary: "No blocking issues.",
      },
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

  it("does not let a provisional failed tool result override a later canonical completion", () => {
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
      result: JSON.stringify({
        status: "failed",
        terminalReason: "transport_closed",
        retrySafe: true,
        partialOutput: "Partial review",
      }),
      durationMs: 1,
      input: { sessionId: "bg-1" },
    });
    state = reducer(state, bgDone);

    expect(state.messages[0].blocks[1]).toMatchObject({
      type: "bg_agent_result",
      status: "completed",
      resultState: "completed",
      resultText: "Looks good.",
      partialOutput: undefined,
      sourceAuthority: "canonical",
    });
  });

  it("does not let a later provisional tool result override a canonical completion", () => {
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
    state = reducer(state, {
      type: "TOOL_COMPLETE",
      toolCallId: "tool-result",
      toolName: "get_background_result",
      result: JSON.stringify({
        status: "failed",
        terminalReason: "transport_closed",
        retrySafe: true,
        partialOutput: "Partial review",
      }),
      durationMs: 1,
      input: { sessionId: "bg-1" },
    });

    expect(state.messages[0].blocks[1]).toMatchObject({
      type: "bg_agent_result",
      status: "completed",
      resultState: "completed",
      resultText: "Looks good.",
      partialOutput: undefined,
      sourceAuthority: "canonical",
    });
  });

  it("preserves JSON success output with metadata-like keys verbatim", () => {
    const result = JSON.stringify({
      status: "ok",
      done: true,
      partialOutput: ["raw evidence"],
    });
    const state = reducer(
      stateWith(
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
      ),
      {
        type: "TOOL_COMPLETE",
        toolCallId: "tool-result",
        toolName: "get_background_result",
        result,
        durationMs: 1,
        input: { sessionId: "bg-1" },
      },
    );

    expect(state.messages[0].blocks[0]).toMatchObject({
      type: "tool_call",
      result,
    });
    expect(state.messages[0].blocks[1]).toMatchObject({
      type: "bg_agent_result",
      status: "completed",
      resultState: "completed",
      terminalReason: undefined,
      resultText: result,
      retrySafe: undefined,
      sourceAuthority: "tool",
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

  it("does not duplicate an active canonical result when older history is prepended", () => {
    const canonicalResult = {
      type: "bg_agent_result" as const,
      sessionId: "bg-restored",
      task: "Review implementation",
      status: "completed" as const,
      resultState: "completed" as const,
      resultText: "Canonical result",
      sourceAuthority: "canonical" as const,
    };
    const state: AppState = {
      ...initialState,
      messages: [
        {
          id: "assistant-tail",
          role: "assistant",
          content: "",
          timestamp: 2,
          blocks: [canonicalResult],
        },
      ],
    };

    const next = reducer(state, {
      type: "PREPEND_SESSION_CHUNK",
      messages: [
        {
          id: "assistant-older",
          role: "assistant",
          content: "",
          timestamp: 1,
          blocks: [
            {
              ...canonicalResult,
              resultText: "Older tool-derived result",
              sourceAuthority: "tool",
            },
            { type: "text", text: "Older transcript content" },
          ],
        },
      ],
      userTurnOffset: 0,
      hasMoreBefore: false,
    });

    const results = next.messages.flatMap((message) =>
      message.blocks.filter(
        (block) =>
          block.type === "bg_agent_result" && block.sessionId === "bg-restored",
      ),
    );
    expect(results).toEqual([canonicalResult]);
    expect(next.messages[0].blocks).toEqual([
      { type: "text", text: "Older transcript content" },
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
          resultState: "completed",
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
        resultState: "completed",
        terminalReason: undefined,
        resultText: "Found one issue.",
        partialOutput: undefined,
        summary: "One issue found",
        retrySafe: undefined,
        agentRetryable: undefined,
        sourceAuthority: "canonical",
      },
    ]);
  });

  it("deduplicates repeated tool-derived results at the latest canonical location", () => {
    const duplicateResult = {
      type: "bg_agent_result" as const,
      sessionId: "bg-restored",
      task: "Review implementation",
      status: "completed" as const,
      resultState: "completed" as const,
      resultText: "Tool-derived result",
      sourceAuthority: "tool" as const,
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
          blocks: [duplicateResult, { type: "text", text: "Between results" }],
        },
        {
          id: "assistant-2",
          role: "assistant",
          content: "",
          timestamp: 2,
          blocks: [duplicateResult],
        },
      ],
      todos: [],
      backgroundResults: [
        {
          sessionId: "bg-restored",
          task: "Review implementation",
          status: "completed",
          resultState: "completed",
          resultText: "Canonical result",
          completedAt: 3,
        },
      ],
    });

    expect(next.messages[0].blocks).toEqual([
      { type: "text", text: "Between results" },
    ]);
    expect(next.messages[1].blocks).toEqual([
      expect.objectContaining({
        type: "bg_agent_result",
        sessionId: "bg-restored",
        resultText: "Canonical result",
        sourceAuthority: "canonical",
      }),
    ]);
  });

  it("reconciles a tool-derived background result with canonical child metadata", () => {
    const existingResult = {
      type: "bg_agent_result" as const,
      sessionId: "bg-restored",
      task: "Review implementation",
      status: "error" as const,
      resultState: "failed" as const,
      terminalReason: "transport_closed",
      partialOutput: "Stale partial output",
      sourceAuthority: "tool" as const,
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
          resultState: "completed",
          resultText: "Found one issue.",
          completedAt: 2,
        },
      ],
    });

    const results = next.messages.flatMap((message) =>
      message.blocks.filter(
        (block) =>
          block.type === "bg_agent_result" && block.sessionId === "bg-restored",
      ),
    );
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      status: "completed",
      resultState: "completed",
      resultText: "Found one issue.",
      partialOutput: undefined,
      sourceAuthority: "canonical",
    });
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

describe("transcript stability invariants", () => {
  const baseLoad = {
    type: "LOAD_SESSION" as const,
    sessionId: "session-1",
    title: "Session",
    mode: "code",
    model: "model",
    todos: [],
  };

  function assistantRaw(blocks: unknown[]): unknown {
    return { role: "assistant", content: blocks };
  }

  it("rehydrates deterministic message ids when a base index is provided", () => {
    const raw = [
      { role: "user", content: "hello" },
      assistantRaw([{ type: "text", text: "hi" }]),
    ];
    const first = agentMessagesToChatMessages(raw, { baseIndex: 10 });
    const second = agentMessagesToChatMessages(raw, { baseIndex: 10 });

    expect(first.map((m) => m.id)).toEqual(["t10", "t11"]);
    expect(second.map((m) => m.id)).toEqual(first.map((m) => m.id));
  });

  it("carries hydration-sourced interrupted state on LOAD_SESSION and resets it by default", () => {
    const message = {
      id: "t0",
      role: "user" as const,
      content: "prompt",
      timestamp: 1,
      blocks: [],
    };
    const interrupted = reducer(initialState, {
      ...baseLoad,
      messages: [message],
      interrupted: true,
    });
    expect(interrupted.chatState.interrupted).toBe(true);

    // A later hydration without the flag (or a streaming one) clears it.
    const cleared = reducer(interrupted, { ...baseLoad, messages: [message] });
    expect(cleared.chatState.interrupted).toBe(false);
    const streaming = reducer(interrupted, {
      ...baseLoad,
      messages: [message],
      interrupted: true,
      streaming: true,
    });
    expect(streaming.chatState.interrupted).toBe(false);
  });

  it("renders the in-flight live tail on LOAD_SESSION and preserves streaming", () => {
    const loaded = reducer(initialState, {
      ...baseLoad,
      messages: [
        {
          id: "t0",
          role: "user",
          content: "prompt",
          timestamp: 1,
          blocks: [],
        },
      ],
      inFlight: [
        {
          type: "thinking",
          id: "think-1",
          text: "reasoning...",
          complete: false,
        },
        { type: "text", text: "partial answer" },
        {
          type: "tool_call",
          id: "tool-1",
          name: "read_file",
          inputJson: "{}",
          complete: false,
        },
      ],
      streaming: true,
    });

    const tail = loaded.messages[loaded.messages.length - 1];
    expect(loaded.streaming).toBe(true);
    expect(loaded.chatState.streaming).toBe(true);
    expect(tail.role).toBe("assistant");
    expect(tail.blocks).toEqual([
      {
        type: "thinking",
        id: "think-1",
        text: "reasoning...",
        complete: false,
      },
      { type: "text", text: "partial answer" },
      {
        type: "tool_call",
        id: "tool-1",
        name: "read_file",
        inputJson: "{}",
        result: "",
        complete: false,
      },
    ]);

    // Streaming continues into the live tail after the hydration: the delta
    // lands in the same assistant message (a fresh text block after the
    // trailing tool_call), not in a new duplicate message.
    const withDelta = reducer(loaded, { type: "TEXT_DELTA", text: " more" });
    expect(withDelta.messages).toHaveLength(loaded.messages.length);
    const tailAfter = withDelta.messages[withDelta.messages.length - 1];
    const lastBlock = tailAfter.blocks[tailAfter.blocks.length - 1];
    expect(lastBlock).toEqual({ type: "text", text: " more" });
  });

  it("skips in-flight blocks whose ids already landed in the restored transcript", () => {
    const loaded = reducer(initialState, {
      ...baseLoad,
      messages: [
        {
          id: "t0",
          role: "assistant",
          content: "",
          timestamp: 1,
          blocks: [
            {
              type: "tool_call",
              id: "tool-1",
              name: "read_file",
              inputJson: "{}",
              result: "done",
              complete: true,
            },
          ],
        },
      ],
      inFlight: [
        {
          type: "tool_call",
          id: "tool-1",
          name: "read_file",
          inputJson: "{}",
          complete: true,
        },
      ],
      streaming: true,
    });

    const toolBlocks = loaded.messages.flatMap((m) =>
      m.blocks.filter((b) => b.type === "tool_call" && b.id === "tool-1"),
    );
    expect(toolBlocks).toHaveLength(1);
  });

  it("keeps LOAD_SESSION non-streaming by default", () => {
    const loaded = reducer(initialState, { ...baseLoad, messages: [] });
    expect(loaded.streaming).toBe(false);
    expect(loaded.chatState.streaming).toBe(false);
  });

  it("ignores replayed THINKING_START for an existing block", () => {
    const started = reducer(initialState, {
      type: "THINKING_START",
      thinkingId: "think-1",
    });
    const withText = reducer(started, {
      type: "THINKING_DELTA",
      thinkingId: "think-1",
      text: "abc",
    });
    const replayed = reducer(withText, {
      type: "THINKING_START",
      thinkingId: "think-1",
    });
    const withMoreText = reducer(replayed, {
      type: "THINKING_DELTA",
      thinkingId: "think-1",
      text: "def",
    });

    const thinkingBlocks = withMoreText.messages.flatMap((m) =>
      m.blocks.filter((b) => b.type === "thinking" && b.id === "think-1"),
    );
    expect(thinkingBlocks).toHaveLength(1);
    expect(
      thinkingBlocks[0].type === "thinking" ? thinkingBlocks[0].text : "",
    ).toBe("abcdef");
  });

  it("self-heals a THINKING_DELTA whose start block is missing", () => {
    const state = reducer(initialState, {
      type: "THINKING_DELTA",
      thinkingId: "think-lost",
      text: "recovered",
    });
    const blocks = state.messages.flatMap((m) =>
      m.blocks.filter((b) => b.type === "thinking" && b.id === "think-lost"),
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type === "thinking" ? blocks[0].text : "").toBe(
      "recovered",
    );
  });

  it("ignores replayed TOOL_START for any tool whose block already exists", () => {
    const started = reducer(initialState, {
      type: "TOOL_START",
      toolCallId: "tool-1",
      toolName: "read_file",
      input: { path: "a.ts" },
    });
    const replayed = reducer(started, {
      type: "TOOL_START",
      toolCallId: "tool-1",
      toolName: "read_file",
      input: { path: "a.ts" },
    });

    const toolBlocks = replayed.messages.flatMap((m) =>
      m.blocks.filter((b) => b.type === "tool_call" && b.id === "tool-1"),
    );
    expect(toolBlocks).toHaveLength(1);
  });

  it("does not double-count a replayed child tool start in the compose trace", () => {
    const parent = reducer(initialState, {
      type: "TOOL_START",
      toolCallId: "parent-1",
      toolName: "compose",
      input: {},
    });
    const child = reducer(parent, {
      type: "TOOL_START",
      toolCallId: "child-1",
      toolName: "read_file",
      parentCallId: "parent-1",
      input: {},
    });
    const replayed = reducer(child, {
      type: "TOOL_START",
      toolCallId: "child-1",
      toolName: "read_file",
      parentCallId: "parent-1",
      input: {},
    });

    const parentBlock = replayed.messages
      .flatMap((m) => m.blocks)
      .find((b) => b.type === "tool_call" && b.id === "parent-1");
    expect(
      parentBlock?.type === "tool_call"
        ? parentBlock.composeTrace?.totalChildren
        : undefined,
    ).toBe(1);
  });

  it("keeps a submitted ask_user answer when the anchor tool_call was lost", () => {
    const withQuestion = reducer(initialState, {
      type: "SET_QUESTION",
      id: "q-1",
      toolCallId: "ask-1",
      context: "",
      questions: [
        { id: "q1", type: "text" as const, question: "Which colour?" },
      ],
    });
    // Simulate a hydration that dropped the synthesized anchor.
    const wiped = { ...withQuestion, messages: [] };
    const submitted = reducer(wiped, {
      type: "SUBMIT_QUESTION",
      id: "q-1",
      answers: { q1: "teal" },
      notes: {},
    });

    const answer = submitted.messages
      .flatMap((m) => m.blocks)
      .find((b) => b.type === "question_answer" && b.toolCallId === "ask-1");
    expect(answer).toBeDefined();
    expect(
      answer?.type === "question_answer" ? answer.items[0]?.answer : "",
    ).toBe("teal");
    expect(submitted.questionRequest).toBeNull();
  });

  it("synthesizes the ask_user tool_call and answer when TOOL_COMPLETE finds no anchor", () => {
    const result = JSON.stringify({
      responses: [{ question: "Which colour?", answer: "teal" }],
    });
    const completed = reducer(initialState, {
      type: "TOOL_COMPLETE",
      toolCallId: "ask-1",
      toolName: "ask_user",
      result,
      durationMs: 5,
    });

    const blocks = completed.messages.flatMap((m) => m.blocks);
    const tool = blocks.find(
      (b) =>
        (b.type === "tool_call" || b.type === "skill_load") && b.id === "ask-1",
    );
    const answer = blocks.find(
      (b) => b.type === "question_answer" && b.toolCallId === "ask-1",
    );
    expect(tool?.type === "tool_call" ? tool.complete : false).toBe(true);
    expect(answer).toBeDefined();
  });

  it("does not duplicate the question context when the transcript already shows it inline", () => {
    const context = "Pick the brand colour for the header.";
    const hydrated = reducer(initialState, {
      ...baseLoad,
      messages: [
        {
          id: "t0",
          role: "assistant",
          content: "",
          timestamp: 1,
          blocks: [
            { type: "text", text: context },
            {
              type: "tool_call",
              id: "ask-1",
              name: "ask_user",
              inputJson: "{}",
              result: "",
              complete: false,
            },
          ],
        },
      ],
    });
    const withQuestion = reducer(hydrated, {
      type: "SET_QUESTION",
      id: "q-1",
      toolCallId: "ask-1",
      context,
      questions: [
        { id: "q1", type: "text" as const, question: "Which colour?" },
      ],
    });

    const occurrences = withQuestion.messages
      .flatMap((m) => m.blocks)
      .filter((b) => b.type === "text" && b.text.trim() === context);
    expect(occurrences).toHaveLength(1);
  });

  it("ignores a replayed committed user message with a known id", () => {
    const first = reducer(initialState, {
      type: "ADD_COMMITTED_USER_MESSAGE",
      id: "commit-1",
      text: "run the tests",
    });
    const replayed = reducer(first, {
      type: "ADD_COMMITTED_USER_MESSAGE",
      id: "commit-1",
      text: "run the tests",
    });

    expect(replayed).toBe(first);
    expect(
      replayed.messages.filter((m) => m.content === "run the tests"),
    ).toHaveLength(1);
  });

  it("keeps an identical background completion in place on replay", () => {
    const completion = {
      sessionId: "bg-1",
      task: "Research",
      status: "completed" as const,
      resultState: "completed" as const,
      resultText: "All done",
      completedAt: 123,
    };
    const first = reducer(initialState, {
      type: "BG_AGENT_DONE",
      completion,
    });
    const replayed = reducer(first, { type: "BG_AGENT_DONE", completion });

    expect(replayed).toBe(first);
  });
});
