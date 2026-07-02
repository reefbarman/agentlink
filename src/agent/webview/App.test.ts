import { describe, expect, it } from "vitest";
import {
  initialState,
  reducer,
  shouldAcceptSessionChunk,
  shouldDropSessionScopedEvent,
} from "./App";

describe("webview App reducer background agent launch blocks", () => {
  it("uses final tool input to populate the bg_agent message for spawn_background_agent", () => {
    const toolCallId = "tool-1";
    const sessionId = "bg-123";
    const task = "Review implementation";
    const message = "Review these changes and report any issues.";

    let state = reducer(initialState, {
      type: "ADD_USER_MESSAGE",
      text: "run review",
    });

    state = reducer(state, {
      type: "TOOL_START",
      toolCallId,
      toolName: "spawn_background_agent",
    });

    state = reducer(state, {
      type: "TOOL_COMPLETE",
      toolCallId,
      toolName: "spawn_background_agent",
      result: JSON.stringify({ sessionId }),
      durationMs: 12,
      input: { task, message },
    });

    const assistant = state.messages[state.messages.length - 1];
    expect(assistant?.role).toBe("assistant");

    const bgBlock = assistant?.blocks.find((b) => b.type === "bg_agent");
    expect(bgBlock).toBeDefined();
    expect(bgBlock).toMatchObject({
      type: "bg_agent",
      sessionId,
      task,
      message,
    });
  });

  it("falls back to parsed tool_call inputJson when final input is missing", () => {
    const toolCallId = "tool-2";
    const sessionId = "bg-456";
    const task = "Review architecture";
    const message = "Check the plan for gaps and inconsistencies.";

    let state = reducer(initialState, {
      type: "ADD_USER_MESSAGE",
      text: "run architecture review",
    });

    state = reducer(state, {
      type: "TOOL_START",
      toolCallId,
      toolName: "spawn_background_agent",
    });

    state = reducer(state, {
      type: "TOOL_INPUT_DELTA",
      toolCallId,
      partialJson: JSON.stringify({ task, message }),
    });

    state = reducer(state, {
      type: "TOOL_COMPLETE",
      toolCallId,
      toolName: "spawn_background_agent",
      result: JSON.stringify({ sessionId }),
      durationMs: 8,
    });

    const assistant = state.messages[state.messages.length - 1];
    expect(assistant?.role).toBe("assistant");

    const bgBlock = assistant?.blocks.find((b) => b.type === "bg_agent");
    expect(bgBlock).toBeDefined();
    expect(bgBlock).toMatchObject({
      type: "bg_agent",
      sessionId,
      task,
      message,
    });
  });

  it("adds a visible background result block when get_background_result completes", () => {
    const bgSessionId = "bg-result-live";
    const task = "Review implementation";
    const resultText = "The background review found no blocking issues.";

    let state = reducer(initialState, {
      type: "ADD_USER_MESSAGE",
      text: "run review",
    });

    state = reducer(state, {
      type: "TOOL_START",
      toolCallId: "tool-spawn-bg",
      toolName: "spawn_background_agent",
    });

    state = reducer(state, {
      type: "TOOL_COMPLETE",
      toolCallId: "tool-spawn-bg",
      toolName: "spawn_background_agent",
      result: JSON.stringify({ sessionId: bgSessionId }),
      durationMs: 12,
      input: { task, message: "Review the implementation." },
    });

    state = reducer(state, {
      type: "TOOL_START",
      toolCallId: "tool-bg-result",
      toolName: "get_background_result",
    });

    state = reducer(state, {
      type: "TOOL_COMPLETE",
      toolCallId: "tool-bg-result",
      toolName: "get_background_result",
      result: resultText,
      durationMs: 20,
      input: { sessionId: bgSessionId },
    });

    const assistant = state.messages[state.messages.length - 1];
    expect(assistant?.role).toBe("assistant");
    expect(assistant?.blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "tool_call",
          id: "tool-bg-result",
          name: "get_background_result",
          result: resultText,
          complete: true,
        }),
        {
          type: "bg_agent_result",
          sessionId: bgSessionId,
          task,
          status: "completed",
          resultText,
          summary: undefined,
        },
      ]),
    );
  });

  it("marks incomplete tool calls complete when the turn errors", () => {
    const toolCallId = "tool-error-stop";

    let state = reducer(initialState, {
      type: "ADD_USER_MESSAGE",
      text: "write a file",
    });

    state = reducer(state, {
      type: "TOOL_START",
      toolCallId,
      toolName: "write_file",
    });

    state = reducer(state, {
      type: "ERROR",
      error: "API request failed",
      retryable: false,
    });

    const assistant = state.messages[state.messages.length - 1];
    const toolBlock = assistant?.blocks.find(
      (b) => b.type === "tool_call" && b.id === toolCallId,
    );
    expect(toolBlock).toMatchObject({
      type: "tool_call",
      id: toolCallId,
      complete: true,
      result: '{"status":"stopped"}',
    });
    expect(assistant?.error?.message).toBe("API request failed");
  });

  it("promotes live generated image tool results to assistant display media", () => {
    const toolCallId = "tool-generate-image";
    let state = reducer(initialState, {
      type: "ADD_USER_MESSAGE",
      text: "generate an icon",
    });

    state = reducer(state, {
      type: "TOOL_START",
      toolCallId,
      toolName: "generate_image",
    });

    state = reducer(state, {
      type: "TOOL_COMPLETE",
      toolCallId,
      toolName: "generate_image",
      result: JSON.stringify({ status: "accepted", generated_count: 1 }),
      resultImages: [{ mimeType: "image/png", data: "YWJjZA==" }],
      durationMs: 42,
      input: { prompt: "teal icon" },
    });

    const assistant = state.messages[state.messages.length - 1];
    expect(assistant?.role).toBe("assistant");
    expect(assistant?.displayMedia).toEqual({
      images: [
        {
          name: "generated-image-1.png",
          mimeType: "image/png",
          src: "data:image/png;base64,YWJjZA==",
        },
      ],
      documents: [],
    });
    expect(assistant?.blocks).toEqual([
      expect.objectContaining({
        type: "tool_call",
        id: toolCallId,
        resultImages: [{ mimeType: "image/png", data: "YWJjZA==" }],
      }),
    ]);
  });

  it("promotes generated images when completing earlier tool messages and multiple image tools", () => {
    let state = reducer(initialState, {
      type: "ADD_USER_MESSAGE",
      text: "generate two images",
    });

    state = reducer(state, {
      type: "TOOL_START",
      toolCallId: "tool-generate-first",
      toolName: "generate_image",
    });
    state = reducer(state, {
      type: "TOOL_START",
      toolCallId: "tool-generate-second",
      toolName: "generate_image",
    });
    state = reducer(state, {
      type: "ADD_ANNOTATION",
      text: "continuing while tools complete",
      badge: "follow-up",
    });

    state = reducer(state, {
      type: "TOOL_COMPLETE",
      toolCallId: "tool-generate-first",
      toolName: "generate_image",
      result: JSON.stringify({ status: "accepted", generated_count: 1 }),
      resultImages: [{ mimeType: "image/png", data: "Zmlyc3Q=" }],
      durationMs: 42,
      input: { prompt: "first" },
    });
    state = reducer(state, {
      type: "TOOL_COMPLETE",
      toolCallId: "tool-generate-second",
      toolName: "generate_image",
      result: JSON.stringify({ status: "accepted", generated_count: 1 }),
      resultImages: [{ mimeType: "image/webp", data: "c2Vjb25k" }],
      durationMs: 43,
      input: { prompt: "second" },
    });

    const assistantIndex = state.messages.findIndex((message) =>
      message.blocks.some(
        (block) =>
          block.type === "tool_call" && block.id === "tool-generate-first",
      ),
    );
    const assistant = state.messages[assistantIndex];
    const trailingPlaceholder = state.messages[state.messages.length - 1];

    expect(assistantIndex).toBeGreaterThanOrEqual(0);
    expect(assistantIndex).toBeLessThan(state.messages.length - 1);
    expect(trailingPlaceholder).toMatchObject({
      role: "assistant",
      blocks: [],
    });
    expect(trailingPlaceholder?.displayMedia).toBeUndefined();
    expect(assistant?.displayMedia).toEqual({
      images: [
        {
          name: "generated-image-1.png",
          mimeType: "image/png",
          src: "data:image/png;base64,Zmlyc3Q=",
        },
        {
          name: "generated-image-2.webp",
          mimeType: "image/webp",
          src: "data:image/webp;base64,c2Vjb25k",
        },
      ],
      documents: [],
    });
    expect(assistant?.blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "tool_call",
          id: "tool-generate-first",
          resultImages: [{ mimeType: "image/png", data: "Zmlyc3Q=" }],
        }),
        expect.objectContaining({
          type: "tool_call",
          id: "tool-generate-second",
          resultImages: [{ mimeType: "image/webp", data: "c2Vjb25k" }],
        }),
      ]),
    );
  });

  it("backfills tool inputJson from TOOL_COMPLETE when no input deltas arrived", () => {
    const toolCallId = "tool-no-delta";
    const finalInput = {
      path: "src/agent/webview/App.tsx",
      query: "tool input",
    };

    let state = reducer(initialState, {
      type: "ADD_USER_MESSAGE",
      text: "Inspect tool input",
    });

    state = reducer(state, {
      type: "TOOL_START",
      toolCallId,
      toolName: "read_file",
    });

    state = reducer(state, {
      type: "TOOL_COMPLETE",
      toolCallId,
      toolName: "read_file",
      result: JSON.stringify({ total_lines: 10 }),
      durationMs: 5,
      input: finalInput,
    });

    const assistant = state.messages[state.messages.length - 1];
    expect(assistant?.role).toBe("assistant");

    const toolBlock = assistant?.blocks.find(
      (b) => b.type === "tool_call" && b.id === toolCallId,
    );
    expect(toolBlock).toBeDefined();
    expect(toolBlock).toMatchObject({
      type: "tool_call",
      id: toolCallId,
      inputJson: JSON.stringify(finalInput),
      result: JSON.stringify({ total_lines: 10 }),
      complete: true,
      durationMs: 5,
    });
  });

  it("preserves streamed tool inputJson when TOOL_COMPLETE also includes input", () => {
    const toolCallId = "tool-preserve-delta";
    const streamedInput = JSON.stringify({ path: "src/agent/webview/App.tsx" });
    const finalInput = {
      path: "src/agent/webview/App.tsx",
      query: "should not overwrite streamed input",
    };

    let state = reducer(initialState, {
      type: "ADD_USER_MESSAGE",
      text: "Inspect streamed input",
    });

    state = reducer(state, {
      type: "TOOL_START",
      toolCallId,
      toolName: "read_file",
    });

    state = reducer(state, {
      type: "TOOL_INPUT_DELTA",
      toolCallId,
      partialJson: streamedInput,
    });

    state = reducer(state, {
      type: "TOOL_COMPLETE",
      toolCallId,
      toolName: "read_file",
      result: JSON.stringify({ total_lines: 10 }),
      durationMs: 6,
      input: finalInput,
    });

    const assistant = state.messages[state.messages.length - 1];
    expect(assistant?.role).toBe("assistant");

    const toolBlock = assistant?.blocks.find(
      (b) => b.type === "tool_call" && b.id === toolCallId,
    );
    expect(toolBlock).toBeDefined();
    expect(toolBlock).toMatchObject({
      type: "tool_call",
      id: toolCallId,
      inputJson: streamedInput,
      result: JSON.stringify({ total_lines: 10 }),
      complete: true,
      durationMs: 6,
    });
  });

  it("posts ask_user shared context as an assistant chat message", () => {
    const state = reducer(initialState, {
      type: "SET_QUESTION",
      id: "question-1",
      context: "I found two viable paths and recommend the provider fix.",
      questions: [
        {
          id: "scope",
          type: "multiple_choice",
          question: "Which scope should I implement?",
          options: ["Provider fix", "UI-only fix"],
        },
      ],
    });

    expect(state.questionRequest).toMatchObject({
      id: "question-1",
      context: "I found two viable paths and recommend the provider fix.",
    });
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({
      id: "question-context-question-1",
      role: "assistant",
      blocks: [
        {
          type: "text",
          text: "I found two viable paths and recommend the provider fix.",
        },
      ],
    });

    const repeated = reducer(state, {
      type: "SET_QUESTION",
      id: "question-1",
      context: "I found two viable paths and recommend the provider fix.",
      questions: [],
    });
    expect(repeated.messages).toHaveLength(1);
  });

  it("restores ask_user shared context as assistant text", async () => {
    const { agentMessagesToChatMessages } = await import("./App");

    const restored = agentMessagesToChatMessages([
      { role: "user", content: "What next?" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool-ask-user",
            name: "ask_user",
            input: {
              context: "Shared **markdown** context for the decision.",
              questions: [
                {
                  id: "scope",
                  type: "multiple_choice",
                  question: "Which scope?",
                  options: ["A", "B"],
                },
              ],
            },
          },
        ],
      },
    ] as unknown[]);

    const assistant = restored[1];
    expect(assistant?.role).toBe("assistant");
    expect(assistant?.blocks[0]).toEqual({
      type: "text",
      text: "Shared **markdown** context for the decision.",
    });
    expect(assistant?.blocks[1]).toMatchObject({
      type: "tool_call",
      id: "tool-ask-user",
      name: "ask_user",
    });
  });

  it("restores ask_user submitted answers from persisted tool results", async () => {
    const { agentMessagesToChatMessages } = await import("./App");

    const restored = agentMessagesToChatMessages([
      { role: "user", content: "What next?" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool-ask-user",
            name: "ask_user",
            input: {
              context: "Need a decision.",
              questions: [
                {
                  id: "scope",
                  type: "multiple_choice",
                  question: "Which scope?",
                  options: ["A", "B"],
                },
                {
                  id: "includeTests",
                  type: "yes_no",
                  question: "Include tests?",
                },
              ],
            },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-ask-user",
            content: JSON.stringify({
              context: "Need a decision.",
              responses: [
                {
                  question: "Which scope?",
                  answer: "B",
                  note: "Historical reload should show this note.",
                },
                {
                  question: "Include tests?",
                  answer: true,
                },
              ],
            }),
          },
        ],
      },
    ] as unknown[]);

    const assistant = restored[1];
    expect(assistant?.role).toBe("assistant");
    expect(assistant?.blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "tool_call",
          id: "tool-ask-user",
          name: "ask_user",
        }),
        {
          type: "question_answer",
          items: [
            {
              question: "Which scope?",
              answer: "B",
              note: "Historical reload should show this note.",
            },
            {
              question: "Include tests?",
              answer: true,
            },
          ],
        },
      ]),
    );
  });

  it("stores MCP approval promotion metadata on completed tool_call blocks", () => {
    const toolCallId = "mcp-tool-1";

    let state = reducer(initialState, {
      type: "ADD_USER_MESSAGE",
      text: "Run MCP tool",
    });

    state = reducer(state, {
      type: "TOOL_START",
      toolCallId,
      toolName: "notion__search",
    });

    state = reducer(state, {
      type: "TOOL_COMPLETE",
      toolCallId,
      toolName: "notion__search",
      result: JSON.stringify({ ok: true }),
      durationMs: 9,
      input: { query: "docs" },
      mcpApprovalPromotion: {
        serverName: "notion",
        bareToolName: "search",
        scopes: ["session", "project", "global"],
      },
    });

    const assistant = state.messages[state.messages.length - 1];
    const toolBlock = assistant?.blocks.find(
      (b) => b.type === "tool_call" && b.id === toolCallId,
    );

    expect(toolBlock).toMatchObject({
      type: "tool_call",
      mcpApprovalPromotion: {
        serverName: "notion",
        bareToolName: "search",
        scopes: ["session", "project", "global"],
      },
    });
  });

  it("converts load_skill tool calls into dedicated skill_load blocks", () => {
    const toolCallId = "skill-tool-1";
    const skillPath = "/workspace/.claude/skills/push-to-repo/SKILL.md";
    const content = "# Push to repo\n\nUse this skill to commit and tag.";

    let state = reducer(initialState, {
      type: "ADD_USER_MESSAGE",
      text: "load the push skill",
    });

    state = reducer(state, {
      type: "TOOL_START",
      toolCallId,
      toolName: "load_skill",
    });

    state = reducer(state, {
      type: "TOOL_COMPLETE",
      toolCallId,
      toolName: "load_skill",
      result: JSON.stringify({
        skill_name: "push-to-repo",
        path: skillPath,
        content,
      }),
      durationMs: 7,
      input: { path: skillPath },
    });

    const assistant = state.messages[state.messages.length - 1];
    expect(assistant?.role).toBe("assistant");

    const skillBlock = assistant?.blocks.find(
      (b) => b.type === "skill_load" && b.id === toolCallId,
    );
    expect(skillBlock).toBeDefined();
    expect(skillBlock).toMatchObject({
      type: "skill_load",
      id: toolCallId,
      inputJson: JSON.stringify({ path: skillPath }),
      result: JSON.stringify({
        skill_name: "push-to-repo",
        path: skillPath,
        content,
      }),
      complete: true,
      durationMs: 7,
      skillName: "push-to-repo",
      path: skillPath,
      content,
    });
  });

  it("marks incomplete skill_load blocks complete when DONE is dispatched", () => {
    const toolCallId = "skill-tool-stop";

    let state = reducer(initialState, {
      type: "ADD_USER_MESSAGE",
      text: "load the push skill",
    });

    state = reducer(state, {
      type: "TOOL_START",
      toolCallId,
      toolName: "load_skill",
    });

    state = reducer(state, { type: "DONE" });

    const assistant = state.messages[state.messages.length - 1];
    expect(assistant?.role).toBe("assistant");

    const skillBlock = assistant?.blocks.find(
      (b) => b.type === "skill_load" && b.id === toolCallId,
    );
    expect(skillBlock).toBeDefined();
    expect(skillBlock).toMatchObject({
      type: "skill_load",
      id: toolCallId,
      complete: true,
      result: '{"status":"stopped"}',
    });
  });

  it("retains queued images and documents in messageQueue state", () => {
    const images = [
      { name: "diagram.png", mimeType: "image/png", base64: "img-base64" },
    ];
    const documents = [
      {
        name: "spec.pdf",
        mimeType: "application/pdf",
        base64: "pdf-base64",
      },
    ];

    const state = reducer(initialState, {
      type: "ENQUEUE_MESSAGE",
      id: "queue-1",
      text: "[1 image, 1 PDF attached]\nplease review",
      fullText: "please review",
      images,
      documents,
      source: "browser",
    });

    expect(state.messageQueue).toEqual([
      {
        id: "queue-1",
        text: "[1 image, 1 PDF attached]\nplease review",
        fullText: "please review",
        images,
        documents,
        source: "browser",
      },
    ]);
  });

  it("removes only the targeted queued message", () => {
    let state = reducer(initialState, {
      type: "ENQUEUE_MESSAGE",
      id: "queue-vscode",
      text: "from VS Code",
      source: "vscode",
    });
    state = reducer(state, {
      type: "ENQUEUE_MESSAGE",
      id: "queue-browser",
      text: "from browser",
      source: "browser",
    });

    state = reducer(state, {
      type: "REMOVE_FROM_QUEUE",
      id: "queue-browser",
    });

    expect(state.messageQueue).toEqual([
      {
        id: "queue-vscode",
        text: "from VS Code",
        source: "vscode",
      },
    ]);
  });

  it("marks a queued message as ready to interject", () => {
    let state = reducer(initialState, {
      type: "ENQUEUE_MESSAGE",
      id: "queue-1",
      text: "interject soon",
      source: "vscode",
    });

    state = reducer(state, {
      type: "MARK_QUEUE_INTERJECTION_READY",
      id: "queue-1",
      ready: true,
    });

    expect(state.messageQueue).toEqual([
      {
        id: "queue-1",
        text: "interject soon",
        source: "vscode",
        interjectionReady: true,
      },
    ]);
  });

  it("preserves slash command label alongside attachment indicators", () => {
    const state = reducer(initialState, {
      type: "ADD_USER_MESSAGE",
      text: "[1 image attached]\nplease inspect this",
      isSlashCommand: true,
      slashCommandLabel: "/snapshot latest",
    });

    expect(state.messages[0]).toMatchObject({
      role: "user",
      content: "[1 image attached]\nplease inspect this",
      isSlashCommand: true,
      slashCommandLabel: "/snapshot latest",
    });
  });

  it("clears slash-command metadata when an enqueued message is edited", () => {
    let state = reducer(initialState, {
      type: "ENQUEUE_MESSAGE",
      id: "queue-1",
      text: "/review",
      fullText: "expanded prompt body",
      isSlashCommand: true,
    });

    state = reducer(state, {
      type: "EDIT_QUEUE_MESSAGE",
      id: "queue-1",
      text: "follow-up clarification",
    });

    expect(state.messageQueue).toEqual([
      {
        id: "queue-1",
        text: "follow-up clarification",
        fullText: "follow-up clarification",
        isSlashCommand: false,
      },
    ]);
  });

  it("stores retry metadata on warning messages when provided", () => {
    const retryAt = Date.now() + 2_000;
    const state = reducer(initialState, {
      type: "ADD_WARNING",
      message:
        "Codex API error unknown: Request timed out. — retrying in 2s (attempt 1/3)",
      retryDelayMs: 2_000,
      retryAt,
      retryAttempt: 1,
      retryMaxAttempts: 3,
    });

    const warning = state.messages[state.messages.length - 1];
    expect(warning?.role).toBe("warning");
    expect(warning?.warningMessage).toContain("retrying in 2s");
    expect(warning?.warningRetry).toEqual({
      retryDelayMs: 2_000,
      retryAt,
      retryAttempt: 1,
      retryMaxAttempts: 3,
    });
  });

  it("does not drop session chunk events in the generic session guard", () => {
    expect(
      shouldDropSessionScopedEvent(
        "agentSessionChunk",
        "session-b",
        "session-a",
        false,
      ),
    ).toBe(false);
  });

  it("drops unrelated foreground events for non-active sessions", () => {
    expect(
      shouldDropSessionScopedEvent(
        "agentTextDelta",
        "session-b",
        "session-a",
        false,
      ),
    ).toBe(true);
  });

  it("accepts backfill chunks for the session currently being restored", () => {
    expect(
      shouldAcceptSessionChunk("session-b", "session-a", "session-b"),
    ).toBe(true);
  });

  it("rejects chunks for unrelated sessions during restore", () => {
    expect(
      shouldAcceptSessionChunk("session-c", "session-a", "session-b"),
    ).toBe(false);
  });

  it("falls back to the active session when no restore is in progress", () => {
    expect(shouldAcceptSessionChunk("session-a", "session-a", null)).toBe(true);
    expect(shouldAcceptSessionChunk("session-b", "session-a", null)).toBe(
      false,
    );
  });

  it("maps checkpoint turn indices to the preceding user message", () => {
    let state = reducer(initialState, {
      type: "ADD_USER_MESSAGE",
      text: "first prompt",
    });
    state = reducer(state, { type: "DONE" });
    state = reducer(state, {
      type: "ADD_USER_MESSAGE",
      text: "second prompt",
    });
    state = reducer(state, { type: "DONE" });

    state = reducer(state, {
      type: "SET_CHECKPOINT",
      checkpointId: "cp-live",
      turnIndex: 1,
    });

    expect(state.messages[0]).toMatchObject({
      role: "user",
      content: "first prompt",
      checkpointId: "cp-live",
    });
    expect(state.messages[2]).toMatchObject({
      role: "user",
      content: "second prompt",
    });
    expect(state.messages[2]).not.toHaveProperty("checkpointId");

    const restored = reducer(initialState, {
      type: "LOAD_SESSION",
      sessionId: "session-1",
      title: "Checkpoint session",
      mode: "code",
      model: "gpt-5.3-codex",
      messages: state.messages.map(
        ({ checkpointId: _checkpointId, ...message }) => message,
      ),
      checkpoints: [{ turnIndex: 1, checkpointId: "cp-restored" }],
      lastInputTokens: 0,
      lastOutputTokens: 0,
    });

    expect(restored.chatState.model).toBe("gpt-5.3-codex");
    expect(restored.messages[0]).toMatchObject({
      role: "user",
      content: "first prompt",
      checkpointId: "cp-restored",
    });
    expect(restored.messages[2]).toMatchObject({
      role: "user",
      content: "second prompt",
    });
    expect(restored.messages[2]).not.toHaveProperty("checkpointId");
  });

  it("replays pending checkpoint once committed browser user message arrives", () => {
    let state = reducer(initialState, {
      type: "SET_CHECKPOINT",
      checkpointId: "cp-browser",
      turnIndex: 1,
    });

    expect(state.pendingCheckpoints).toEqual([
      { checkpointId: "cp-browser", turnIndex: 1 },
    ]);

    state = reducer(state, {
      type: "ADD_COMMITTED_USER_MESSAGE",
      text: "hello from browser",
      origin: "browser",
    });

    expect(state.pendingCheckpoints).toEqual([]);
    expect(state.messages[0]).toMatchObject({
      role: "user",
      content: "hello from browser",
      origin: "browser",
      checkpointId: "cp-browser",
    });
  });

  it("retains unresolved checkpoint until matching user row appears in later backfill chunk", () => {
    let state = reducer(initialState, {
      type: "LOAD_SESSION",
      sessionId: "session-1",
      title: "Chunked session",
      mode: "code",
      model: "gpt-5.3-codex",
      messages: [
        {
          id: "assistant-tail",
          role: "assistant",
          content: "",
          timestamp: 2,
          blocks: [{ type: "text", text: "tail" }],
        },
      ],
      checkpoints: [{ turnIndex: 1, checkpointId: "cp-chunk" }],
      userTurnOffset: 1,
      hasMoreBefore: true,
      lastInputTokens: 0,
      lastOutputTokens: 0,
    });

    expect(state.pendingCheckpoints).toEqual([
      { checkpointId: "cp-chunk", turnIndex: 1 },
    ]);

    state = reducer(state, {
      type: "PREPEND_SESSION_CHUNK",
      messages: [
        {
          id: "user-head",
          role: "user",
          content: "first prompt",
          timestamp: 1,
          blocks: [],
        },
      ],
      userTurnOffset: 0,
      hasMoreBefore: false,
    });

    expect(state.pendingCheckpoints).toEqual([]);
    expect(state.messages[0]).toMatchObject({
      role: "user",
      content: "first prompt",
      checkpointId: "cp-chunk",
    });
  });

  it("restores persisted condense summaries even when they are stored as user messages", async () => {
    const { agentMessagesToChatMessages } = await import("./App");

    const restored = agentMessagesToChatMessages([
      { role: "user", content: "Investigate condense" },
      {
        role: "user",
        isSummary: true,
        content: [
          {
            type: "text",
            text: '## Resume Anchor (deterministic)\n- Continue from this task: "Investigate condense"',
          },
          { type: "text", text: "## Conversation Summary\n\nSummary body" },
        ],
      },
    ] as unknown[]);

    expect(restored).toHaveLength(3);
    expect(restored[0]?.role).toBe("user");
    expect(restored[1]?.role).toBe("condense");
    expect(restored[2]?.role).toBe("assistant");
    expect(restored[2]?.blocks).toEqual([
      {
        type: "text",
        text: '## Resume Anchor (deterministic)\n- Continue from this task: "Investigate condense"## Conversation Summary\n\nSummary body',
      },
    ]);
  });

  it("strips system-reminder blocks from restored condense summary assistant text", async () => {
    const { agentMessagesToChatMessages } = await import("./App");

    const restored = agentMessagesToChatMessages([
      { role: "user", content: "Investigate condense" },
      {
        role: "user",
        isSummary: true,
        content: [
          {
            type: "text",
            text: '<system-reminder>\n## Resume Anchor\n- Continue from this task: "Investigate condense"\n</system-reminder>\n\n## Conversation Summary\n\nSummary body',
          },
        ],
      },
    ] as unknown[]);

    expect(restored).toHaveLength(3);
    expect(restored[1]?.role).toBe("condense");
    expect(restored[2]?.role).toBe("assistant");
    const textBlock = restored[2]?.blocks[0];
    expect(textBlock).toEqual({
      type: "text",
      text: "## Conversation Summary\n\nSummary body",
    });
  });

  it("clears interrupted state when a new user message starts streaming", () => {
    const state = reducer(
      {
        ...initialState,
        chatState: {
          ...initialState.chatState,
          sessionId: "session-1",
          interrupted: true,
        },
      },
      {
        type: "ADD_USER_MESSAGE",
        text: "resume",
      },
    );

    expect(state.streaming).toBe(true);
    expect(state.chatState.interrupted).toBe(false);
  });

  it("updates top-level thinkingEnabled from SET_STATE", () => {
    const state = reducer(initialState, {
      type: "SET_STATE",
      state: {
        sessionId: "session-1",
        mode: "code",
        model: "claude-sonnet-4-6",
        streaming: false,
        thinkingEnabled: false,
      },
    });

    expect(state.thinkingEnabled).toBe(false);
    expect(state.chatState.thinkingEnabled).toBe(false);
  });

  it("restores condense row metadata from persisted uiHint", async () => {
    const { agentMessagesToChatMessages } = await import("./App");

    const restored = agentMessagesToChatMessages([
      { role: "user", content: "Investigate condense" },
      {
        role: "assistant",
        isSummary: true,
        content: [{ type: "text", text: "Summary body" }],
        uiHint: {
          condense: {
            prevInputTokens: 12000,
            newInputTokens: 4200,
            durationMs: 950,
            validationWarnings: ["retry used"],
          },
        },
      },
    ] as unknown[]);

    expect(restored).toHaveLength(3);
    expect(restored[1]?.role).toBe("condense");
    expect(restored[1]?.condenseInfo).toEqual({
      prevInputTokens: 12000,
      newInputTokens: 4200,
      durationMs: 950,
      validationWarnings: ["retry used"],
      errorMessage: undefined,
      condensing: undefined,
    });
  });

  it("projects persisted final markers with expandable set_task_status tool input", async () => {
    const { agentMessagesToChatMessages } = await import("./App");

    const restored = agentMessagesToChatMessages([
      { role: "user", content: "plan this" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "I can implement this next." },
          {
            type: "tool_use",
            id: "final-1",
            name: "set_task_status",
            input: { status: "waiting_for_user" },
          },
        ],
        uiHint: {
          finalMarker: {
            status: "waiting_for_user",
            source: "tool",
            summary: "Ready to continue",
            continueAction: {
              label: "Implement this",
              prompt: "Please implement this plan.",
            },
          },
        },
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "final-1",
            content: '{"ok":true}',
          },
        ],
      },
    ] as unknown[]);

    expect(restored).toHaveLength(2);
    expect(restored[1]?.blocks).toEqual([
      { type: "text", text: "I can implement this next." },
    ]);
    expect(restored[1]?.finalMarker).toMatchObject({
      status: "waiting_for_user",
      source: "tool",
      summary: "Ready to continue",
      continueAction: {
        label: "Implement this",
        prompt: "Please implement this plan.",
      },
      toolCall: {
        id: "final-1",
        name: "set_task_status",
        inputJson: JSON.stringify({ status: "waiting_for_user" }),
        result: '{"ok":true}',
      },
    });
  });

  it("keeps unhosted set_task_status calls visible during historical projection", async () => {
    const { agentMessagesToChatMessages } = await import("./App");

    const restored = agentMessagesToChatMessages([
      { role: "user", content: "give me a prompt" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "rejected-final",
            name: "set_task_status",
            input: {
              status: "completed",
              summary: "Here’s the prompt.",
            },
          },
          {
            type: "tool_use",
            id: "final-ok",
            name: "set_task_status",
            input: {
              status: "completed",
              summary: "Prompt provided above.",
            },
          },
        ],
        uiHint: {
          finalMarker: {
            status: "completed",
            source: "tool",
            summary: "Prompt provided above.",
            toolCall: {
              id: "final-ok",
              name: "set_task_status",
              inputJson: JSON.stringify({
                status: "completed",
                summary: "Prompt provided above.",
              }),
            },
          },
        },
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "rejected-final",
            content: '{"error":"Final summary promises an artifact"}',
          },
          {
            type: "tool_result",
            tool_use_id: "final-ok",
            content: '{"ok":true}',
          },
        ],
      },
    ] as unknown[]);

    expect(restored).toHaveLength(2);
    expect(restored[1]?.blocks).toEqual([
      {
        type: "tool_call",
        id: "rejected-final",
        name: "set_task_status",
        inputJson: JSON.stringify({
          status: "completed",
          summary: "Here’s the prompt.",
        }),
        result: '{"error":"Final summary promises an artifact"}',
        complete: true,
      },
    ]);
    expect(restored[1]?.finalMarker?.toolCall?.id).toBe("final-ok");
  });

  it("preserves marker-only final messages during historical projection", async () => {
    const { agentMessagesToChatMessages } = await import("./App");

    const restored = agentMessagesToChatMessages([
      { role: "user", content: "can you test it again?" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "final-only-1",
            name: "set_task_status",
            input: {
              status: "completed",
              summary: "One-shot test complete.",
            },
          },
        ],
        uiHint: {
          finalMarker: {
            status: "completed",
            source: "tool",
            summary: "One-shot test complete.",
          },
        },
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "final-only-1",
            content: '{"ok":true}',
          },
        ],
      },
    ] as unknown[]);

    expect(restored).toHaveLength(2);
    expect(restored[1]).toMatchObject({
      role: "assistant",
      blocks: [],
      finalMarker: {
        status: "completed",
        source: "tool",
        summary: "One-shot test complete.",
        toolCall: {
          id: "final-only-1",
          name: "set_task_status",
          inputJson: JSON.stringify({
            status: "completed",
            summary: "One-shot test complete.",
          }),
          result: '{"ok":true}',
        },
      },
    });
  });

  it("restores suppressed completed final markers", async () => {
    const { agentMessagesToChatMessages } = await import("./App");

    const restored = agentMessagesToChatMessages([
      { role: "user", content: "finish this" },
      {
        role: "assistant",
        content: [{ type: "text", text: "Done." }],
        uiHint: {
          finalMarker: {
            status: "completed",
            source: "tool",
            summary: "All done.",
            continueActionSuppressed: true,
          },
        },
      },
    ] as unknown[]);

    expect(restored.at(-1)?.finalMarker).toEqual({
      status: "completed",
      source: "tool",
      summary: "All done.",
      continueActionSuppressed: true,
    });
  });

  it("does not add a final marker when projecting messages without explicit marker metadata", async () => {
    const { agentMessagesToChatMessages } = await import("./App");

    const restored = agentMessagesToChatMessages([
      { role: "user", content: "finish this" },
      {
        role: "assistant",
        content: [{ type: "text", text: "Done." }],
      },
    ] as unknown[]);

    expect(restored.at(-1)?.finalMarker).toBeUndefined();
  });

  it("does not override persisted explicit final markers during projection", async () => {
    const { agentMessagesToChatMessages } = await import("./App");

    const restored = agentMessagesToChatMessages([
      { role: "user", content: "finish this" },
      {
        role: "assistant",
        content: [{ type: "text", text: "Need credentials." }],
        uiHint: {
          finalMarker: {
            status: "blocked",
            source: "tool",
            summary: "Need credentials",
          },
        },
      },
    ] as unknown[]);

    expect(restored.at(-1)?.finalMarker).toEqual({
      status: "blocked",
      source: "tool",
      summary: "Need credentials",
    });
  });

  it("does not add a final marker on DONE when no explicit marker exists", () => {
    const state = reducer(
      {
        ...initialState,
        messages: [
          {
            id: "a1",
            role: "assistant",
            content: "",
            timestamp: 1,
            blocks: [{ type: "text", text: "Done." }],
          },
        ],
        streaming: true,
      },
      { type: "DONE" },
    );

    expect(state.messages[0]?.finalMarker).toBeUndefined();
  });

  it("clears final marker continue actions without removing marker styling", () => {
    const state = reducer(
      {
        ...initialState,
        messages: [
          {
            id: "a1",
            role: "assistant",
            content: "",
            timestamp: 1,
            blocks: [{ type: "text", text: "Ready." }],
            finalMarker: {
              status: "completed",
              source: "tool",
              summary: "Ready to continue.",
              continueAction: {
                label: "Continue",
                prompt: "Please continue.",
              },
            },
          },
        ],
      },
      { type: "CLEAR_FINAL_MARKER_CONTINUE_ACTIONS" },
    );

    expect(state.messages[0]?.finalMarker).toEqual({
      status: "completed",
      source: "tool",
      summary: "Ready to continue.",
      continueActionConsumed: true,
    });
  });

  it("marks a final marker when Auto Continue stops", () => {
    const state = reducer(
      {
        ...initialState,
        messages: [
          {
            id: "a1",
            role: "assistant",
            content: "",
            timestamp: 1,
            blocks: [],
            finalMarker: {
              status: "completed",
              source: "tool",
              summary: "Ready to continue.",
            },
          },
        ],
      },
      {
        type: "MARK_AUTO_CONTINUE_STOPPED",
        messageId: "a1",
        reason:
          "Auto Continue stopped after 10 turns to avoid an infinite loop.",
      },
    );

    expect(state.messages[0]?.finalMarker).toMatchObject({
      status: "completed",
      autoContinueStopReason:
        "Auto Continue stopped after 10 turns to avoid an infinite loop.",
    });
  });

  it("clears stale final marker continue actions when a new message is added", () => {
    const state = reducer(
      {
        ...initialState,
        messages: [
          {
            id: "a1",
            role: "assistant",
            content: "",
            timestamp: 1,
            blocks: [{ type: "text", text: "Ready." }],
            finalMarker: {
              status: "completed",
              source: "tool",
              summary: "Ready to continue.",
              continueAction: {
                label: "Continue",
                prompt: "Please continue.",
              },
            },
          },
        ],
      },
      { type: "ADD_USER_MESSAGE", text: "Please continue." },
    );

    expect(state.messages[0]?.finalMarker).toEqual({
      status: "completed",
      source: "tool",
      summary: "Ready to continue.",
      continueActionConsumed: true,
    });
    expect(state.messages.at(-2)).toMatchObject({
      role: "user",
      content: "Please continue.",
    });
  });

  it("applies explicit final marker intent on DONE", () => {
    const marker = {
      status: "blocked" as const,
      source: "tool" as const,
      summary: "Need credentials",
    };
    const withIntent = reducer(initialState, {
      type: "SET_FINAL_MARKER",
      marker,
    });
    const state = reducer(
      {
        ...withIntent,
        messages: [
          {
            id: "a1",
            role: "assistant",
            content: "",
            timestamp: 1,
            blocks: [{ type: "text", text: "I am blocked." }],
          },
        ],
        streaming: true,
      },
      { type: "DONE" },
    );

    expect(state.pendingFinalMarker).toBeNull();
    expect(state.messages[0]?.finalMarker).toEqual(marker);
  });

  it("restores slash-command display text and pill metadata from persisted uiHint", async () => {
    const { agentMessagesToChatMessages } = await import("./App");

    const restored = agentMessagesToChatMessages([
      {
        role: "user",
        content: "expanded slash command body",
        uiHint: {
          userMessage: {
            displayText: "/review",
            isSlashCommand: true,
          },
        },
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
      },
    ] as unknown[]);

    expect(restored).toHaveLength(2);
    expect(restored[0]?.role).toBe("user");
    expect(restored[0]?.content).toBe("/review");
    expect(restored[0]?.isSlashCommand).toBe(true);
    expect(restored[0]?.slashCommandLabel).toBe("/review");
  });

  it("projects persisted user-message origin metadata into chat messages", async () => {
    const { agentMessagesToChatMessages } = await import("./App");

    const restored = agentMessagesToChatMessages([
      {
        role: "user",
        content: "hello from remote",
        uiHint: {
          userMessage: {
            origin: "browser",
          },
        },
      },
    ] as unknown[]);

    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({
      role: "user",
      content: "hello from remote",
      origin: "browser",
    });
  });

  it("restores pasted image media as display previews", async () => {
    const { agentMessagesToChatMessages } = await import("./App");

    const restored = agentMessagesToChatMessages([
      {
        role: "user",
        content: "[1 image attached]\nPlease inspect",
        media: {
          images: [
            {
              name: "screenshot.png",
              mimeType: "image/png",
              base64: "abc123",
            },
          ],
          documents: [],
        },
      },
    ] as unknown[]);

    expect(restored).toHaveLength(1);
    expect(restored[0]?.displayMedia).toEqual({
      images: [
        {
          name: "screenshot.png",
          mimeType: "image/png",
          src: "data:image/png;base64,abc123",
        },
      ],
      documents: [],
    });
  });

  it("preserves user context text around persisted slash commands", async () => {
    const { agentMessagesToChatMessages } = await import("./App");

    const restored = agentMessagesToChatMessages([
      {
        role: "user",
        content: "Please do this before sending",
        uiHint: {
          userMessage: {
            displayText: "Please do this before sending",
            isSlashCommand: true,
            slashCommandLabel: "/snapshot important state",
          },
        },
      },
    ] as unknown[]);

    expect(restored).toHaveLength(1);
    expect(restored[0]?.role).toBe("user");
    expect(restored[0]?.content).toBe("Please do this before sending");
    expect(restored[0]?.isSlashCommand).toBe(true);
    expect(restored[0]?.slashCommandLabel).toBe("/snapshot important state");
  });

  it("restores persisted load_skill tool calls as skill_load blocks", async () => {
    const { agentMessagesToChatMessages } = await import("./App");

    const skillPath = "/workspace/.claude/skills/push-to-repo/SKILL.md";
    const content = "# Push to repo\n\nUse this skill to commit and tag.";

    const restored = agentMessagesToChatMessages([
      { role: "user", content: "load the push skill" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "skill-tool-restore",
            name: "load_skill",
            input: { path: skillPath },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "skill-tool-restore",
            content: JSON.stringify({
              skill_name: "push-to-repo",
              path: skillPath,
              content,
            }),
          },
        ],
      },
    ] as unknown[]);

    expect(restored).toHaveLength(2);
    expect(restored[0]?.role).toBe("user");
    expect(restored[1]?.role).toBe("assistant");
    expect(restored[1]?.blocks).toEqual([
      {
        type: "skill_load",
        id: "skill-tool-restore",
        inputJson: JSON.stringify({ path: skillPath }),
        result: JSON.stringify({
          skill_name: "push-to-repo",
          path: skillPath,
          content,
        }),
        complete: true,
        skillName: "push-to-repo",
        path: skillPath,
        content,
      },
    ]);
  });

  it("restores generated image tool result blocks for chat display", async () => {
    const { agentMessagesToChatMessages } = await import("./App");

    const resultText = JSON.stringify({
      status: "accepted",
      generated_count: 1,
      images: [{ bytes: 4, mimeType: "image/png" }],
    });

    const restored = agentMessagesToChatMessages([
      { role: "user", content: "generate an icon" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "generate-image-restore",
            name: "generate_image",
            input: { prompt: "teal icon" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "generate-image-restore",
            content: [
              { type: "text", text: resultText },
              { type: "image", data: "YWJjZA==", mimeType: "image/png" },
            ],
          },
        ],
      },
    ] as unknown[]);

    expect(restored[1]?.blocks).toEqual([
      {
        type: "tool_call",
        id: "generate-image-restore",
        name: "generate_image",
        inputJson: JSON.stringify({ prompt: "teal icon" }),
        result: resultText,
        resultImages: [{ data: "YWJjZA==", mimeType: "image/png" }],
        complete: true,
      },
    ]);
    expect(restored[1]?.displayMedia).toEqual({
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

  it("restores persisted MCP approval promotion metadata onto tool call blocks", async () => {
    const { agentMessagesToChatMessages } = await import("./App");

    const restored = agentMessagesToChatMessages([
      { role: "user", content: "list Linear issues" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "mcp-tool-restore",
            name: "linear__list_issues",
            input: { query: "status:open" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "mcp-tool-restore",
            content: JSON.stringify({ ok: true }),
            mcpApprovalPromotion: {
              serverName: "linear",
              bareToolName: "list_issues",
              scopes: ["session", "project", "global"],
            },
          },
        ],
      },
    ] as unknown[]);

    expect(restored[1]?.blocks).toEqual([
      {
        type: "tool_call",
        id: "mcp-tool-restore",
        name: "linear__list_issues",
        inputJson: JSON.stringify({ query: "status:open" }),
        result: JSON.stringify({ ok: true }),
        complete: true,
        mcpApprovalPromotion: {
          serverName: "linear",
          bareToolName: "list_issues",
          scopes: ["session", "project", "global"],
        },
      },
    ]);
  });

  it("restores persisted background tool calls into bg_agent and bg_agent_result blocks", async () => {
    const { agentMessagesToChatMessages } = await import("./App");

    const bgSessionId = "bg-session-restore";
    const task = "Review implementation";
    const message = "Review the patch and report correctness issues.";
    const resultText = "Looks good overall. I found one edge case to fix.";

    const restored = agentMessagesToChatMessages([
      { role: "user", content: "run a background review" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "bg-spawn-tool",
            name: "spawn_background_agent",
            input: { task, message },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "bg-spawn-tool",
            content: JSON.stringify({
              sessionId: bgSessionId,
              resolvedMode: "review",
              resolvedProvider: "openai",
              resolvedModel: "gpt-5.3-codex",
              taskClass: "review_code",
              routingReason: "taskClass policy",
            }),
          },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "bg-result-tool",
            name: "get_background_result",
            input: { sessionId: bgSessionId },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "bg-result-tool",
            content: resultText,
          },
        ],
      },
    ] as unknown[]);

    expect(restored).toHaveLength(3);
    expect(restored[0]?.role).toBe("user");

    expect(restored[1]?.role).toBe("assistant");
    expect(restored[1]?.blocks).toEqual([
      {
        type: "tool_call",
        id: "bg-spawn-tool",
        name: "spawn_background_agent",
        inputJson: JSON.stringify({ task, message }),
        result: JSON.stringify({
          sessionId: bgSessionId,
          resolvedMode: "review",
          resolvedProvider: "openai",
          resolvedModel: "gpt-5.3-codex",
          taskClass: "review_code",
          routingReason: "taskClass policy",
        }),
        complete: true,
      },
      {
        type: "bg_agent",
        sessionId: bgSessionId,
        task,
        message,
        resolvedMode: "review",
        resolvedProvider: "openai",
        resolvedModel: "gpt-5.3-codex",
        taskClass: "review_code",
        routingReason: "taskClass policy",
      },
    ]);

    expect(restored[2]?.role).toBe("assistant");
    expect(restored[2]?.blocks).toEqual([
      {
        type: "tool_call",
        id: "bg-result-tool",
        name: "get_background_result",
        inputJson: JSON.stringify({ sessionId: bgSessionId }),
        result: resultText,
        complete: true,
      },
      {
        type: "bg_agent_result",
        sessionId: bgSessionId,
        task,
        status: "completed",
        resultText,
      },
    ]);
  });

  it("restores persisted runtime errors on assistant messages with retry metadata", async () => {
    const { agentMessagesToChatMessages } = await import("./App");

    const restored = agentMessagesToChatMessages([
      { role: "user", content: "Try Codex again" },
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Codex API error: An error occurred while processing your request.",
          },
        ],
        runtimeError: {
          message:
            "Codex API error: An error occurred while processing your request.",
          retryable: true,
        },
      },
    ] as unknown[]);

    expect(restored).toHaveLength(2);
    expect(restored[0]?.role).toBe("user");
    expect(restored[1]?.role).toBe("assistant");
    expect(restored[1]?.blocks).toEqual([]);
    expect(restored[1]?.error).toEqual({
      message:
        "Codex API error: An error occurred while processing your request.",
      retryable: true,
    });
  });

  it("restores oauth usage-limit exhausted runtime error action metadata on assistant messages", async () => {
    const { agentMessagesToChatMessages } = await import("./App");

    const restored = agentMessagesToChatMessages([
      { role: "user", content: "Try Codex again" },
      {
        role: "assistant",
        content: [{ type: "text", text: "Codex API error 429" }],
        runtimeError: {
          message: "Codex API error 429: The usage limit has been reached.",
          retryable: true,
          code: "oauth_usage_limit_exhausted",
          actions: {
            signInAnotherAccount: true,
          },
        },
      },
    ] as unknown[]);

    expect(restored).toHaveLength(2);
    expect(restored[1]?.role).toBe("assistant");
    expect(restored[1]?.blocks).toEqual([
      { type: "text", text: "Codex API error 429" },
    ]);
    expect(restored[1]?.error).toEqual({
      message: "Codex API error 429: The usage limit has been reached.",
      retryable: true,
      code: "oauth_usage_limit_exhausted",
      actions: {
        signInAnotherAccount: true,
      },
    });
  });

  it("restores runtime errors even when assistant content is empty", async () => {
    const { agentMessagesToChatMessages } = await import("./App");

    const restored = agentMessagesToChatMessages([
      { role: "user", content: "Try again" },
      {
        role: "assistant",
        content: [],
        runtimeError: {
          message: "Codex API error: timeout",
          retryable: true,
        },
      },
    ] as unknown[]);

    expect(restored).toHaveLength(2);
    expect(restored[1]?.role).toBe("assistant");
    expect(restored[1]?.blocks).toEqual([]);
    expect(restored[1]?.error).toEqual({
      message: "Codex API error: timeout",
      retryable: true,
    });
  });

  it("maps condense errors with metadata into a standard error block", () => {
    let state = reducer(initialState, {
      type: "CONDENSE_START",
    });

    state = reducer(state, {
      type: "ADD_CONDENSE_ERROR",
      errorMessage:
        "Condensing API call failed: Codex API error 429: The usage limit has been reached",
      retryable: true,
      code: "oauth_usage_limit_exhausted",
      actions: { signInAnotherAccount: true },
    });

    const last = state.messages[state.messages.length - 1];
    expect(last?.role).toBe("assistant");
    expect(last?.error).toEqual({
      message:
        "Condensing API call failed: Codex API error 429: The usage limit has been reached",
      retryable: true,
      code: "oauth_usage_limit_exhausted",
      actions: { signInAnotherAccount: true },
    });
  });

  it("clears stale running token estimates after successful condense", () => {
    let state = reducer(initialState, {
      type: "TOKEN_ESTIMATE",
      estimatedTotalUsed: 220_200,
    });

    state = reducer(state, {
      type: "ADD_CONDENSE",
      prevInputTokens: 253_100,
      newInputTokens: 10_600,
      durationMs: 15_400,
    });

    expect(state.lastInputTokens).toBe(10_600);
    expect(state.estimatedTotalUsed).toBe(0);
  });

  it("stores and clears detected question fallback state", () => {
    const detected = {
      messageId: "assistant-1",
      kind: "yes_no" as const,
      prompt: "Proceed?",
      options: [
        { label: "Yes", payload: "Yes" },
        { label: "No", payload: "No" },
      ],
    };

    let state = reducer(initialState, {
      type: "SET_DETECTED_QUESTION",
      detectedQuestion: detected,
    });
    expect(state.detectedQuestion).toEqual(detected);

    state = reducer(state, {
      type: "DISMISS_DETECTED_QUESTION",
      messageId: "assistant-1",
    });
    expect(state.detectedQuestion).toBeNull();
    expect(state.dismissedDetectedQuestionIds).toContain("assistant-1");
  });

  it("reconciles a committed browser user message into the live transcript", async () => {
    const { reducer, initialState } = await import("./App");

    const state = reducer(initialState, {
      type: "ADD_COMMITTED_USER_MESSAGE",
      text: "hello from browser",
      origin: "browser",
    });

    expect(state.streaming).toBe(true);
    expect(state.messages).toHaveLength(2);
    expect(state.messages[0]).toMatchObject({
      role: "user",
      content: "hello from browser",
      origin: "browser",
    });
    expect(state.messages[1]).toMatchObject({ role: "assistant" });
  });

  it("dismisses detected question when user sends a normal message", () => {
    let state = reducer(initialState, {
      type: "SET_DETECTED_QUESTION",
      detectedQuestion: {
        messageId: "assistant-3",
        kind: "single_choice",
        prompt: "Choose A or B.",
        options: [
          { label: "Option A", payload: "Option A" },
          { label: "Option B", payload: "Option B" },
        ],
      },
    });

    state = reducer(state, {
      type: "ADD_USER_MESSAGE",
      text: "I want option C instead",
    });

    expect(state.detectedQuestion).toBeNull();
    expect(state.dismissedDetectedQuestionIds).toContain("assistant-3");
  });

  it("keeps dismissed detected-question ids unchanged when no prompt is active", () => {
    const state = reducer(initialState, {
      type: "ADD_USER_MESSAGE",
      text: "hello",
    });

    expect(state.dismissedDetectedQuestionIds).toEqual([]);
  });

  it("dismisses detected question when user queues a message while streaming", () => {
    let state = reducer(initialState, {
      type: "SET_DETECTED_QUESTION",
      detectedQuestion: {
        messageId: "assistant-4",
        kind: "yes_no",
        prompt: "Proceed?",
        options: [
          { label: "Yes", payload: "Yes" },
          { label: "No", payload: "No" },
        ],
      },
    });

    state = reducer(state, {
      type: "ENQUEUE_MESSAGE",
      id: "queued-1",
      text: "Actually do X",
    });

    expect(state.detectedQuestion).toBeNull();
    expect(state.dismissedDetectedQuestionIds).toContain("assistant-4");
  });

  it("clears transient interaction prompts without resetting dismiss history", () => {
    let state = reducer(initialState, {
      type: "SET_QUESTION",
      id: "question-1",
      context: "Need input.",
      questions: [
        {
          id: "choice",
          type: "multiple_choice",
          question: "Pick one.",
          options: ["A", "B"],
          recommended: "A",
        },
      ],
    });

    state = reducer(state, {
      type: "SET_DETECTED_QUESTION",
      detectedQuestion: {
        messageId: "assistant-5",
        kind: "yes_no",
        prompt: "Proceed?",
        options: [
          { label: "Yes", payload: "Yes" },
          { label: "No", payload: "No" },
        ],
      },
    });

    state = reducer(state, {
      type: "DISMISS_DETECTED_QUESTION",
      messageId: "old-assistant",
    });

    state = {
      ...state,
      messages: [
        ...state.messages,
        {
          id: "assistant-final",
          role: "assistant",
          content: "Done.",
          timestamp: Date.now(),
          blocks: [{ type: "text", text: "Done." }],
          finalMarker: {
            status: "completed",
            source: "tool",
            continueAction: {
              label: "Continue",
              prompt: "Do the next thing.",
            },
          },
        },
      ],
    };

    state = reducer(state, { type: "CLEAR_INTERACTION_PROMPTS" });

    expect(state.questionRequest).toBeNull();
    expect(state.detectedQuestion).toBeNull();
    expect(state.dismissedDetectedQuestionIds).toEqual(["old-assistant"]);
    expect(state.messages.at(-1)?.finalMarker).toMatchObject({
      status: "completed",
      continueActionConsumed: true,
    });
    expect(
      state.messages.at(-1)?.finalMarker &&
        "continueAction" in state.messages.at(-1)!.finalMarker!,
    ).toBe(false);
  });

  it("resets detected question state on NEW_SESSION", () => {
    let state = reducer(initialState, {
      type: "SET_DETECTED_QUESTION",
      detectedQuestion: {
        messageId: "assistant-2",
        kind: "yes_no",
        prompt: "Proceed?",
        options: [
          { label: "Yes", payload: "Yes" },
          { label: "No", payload: "No" },
        ],
      },
    });

    state = reducer(state, {
      type: "DISMISS_DETECTED_QUESTION",
      messageId: "assistant-2",
    });

    state = reducer(state, { type: "NEW_SESSION" });
    expect(state.detectedQuestion).toBeNull();
    expect(state.dismissedDetectedQuestionIds).toEqual([]);
  });
});
