import { describe, expect, it } from "vitest";

import { BrowserGatewayAskAgentSessionStore } from "./browserGatewayAskAgentSessionStore.js";
import { BrowserGatewayCoreOwnerRegistry } from "./coreOwnerRegistry.js";
import type { BrowserGatewayModelCredentialStatus } from "./browserGatewayModelCredentialCache.js";
import type { BrowserGatewayThemeSnapshot } from "../shared/types.js";

const theme: BrowserGatewayThemeSnapshot = {
  cssVariables: {},
  colorScheme: "dark",
  themeLabel: "Dark",
  source: "vscode-theme-api",
};

function createStore(): BrowserGatewayAskAgentSessionStore {
  return new BrowserGatewayAskAgentSessionStore(
    new BrowserGatewayCoreOwnerRegistry({ heartbeatTtlMs: 30_000 }),
  );
}

describe("BrowserGatewayAskAgentSessionStore", () => {
  it("starts without a static ready message and emits credential errors only after a turn", () => {
    const store = createStore();
    const credentialStatus: BrowserGatewayModelCredentialStatus = {
      state: "missing",
      reason:
        "Open a VS Code AgentLink window to grant model credentials to the browser gateway.",
    };

    const initial = store.getOrCreate({
      now: 50,
      theme,
      modelCredentialStatus: credentialStatus,
    });
    expect(initial.snapshot.session.foreground.statusOverride).toBeNull();
    expect(initial.snapshot.session.foreground.projectedMessages).toEqual([]);

    const response = store.sendMessage({
      id: "ask-user-1",
      text: "Hello",
      now: 100,
      theme,
      modelCredentialStatus: credentialStatus,
    });

    expect(response.snapshot.session.foreground.statusOverride).toBeNull();
    expect(response.snapshot.session.foreground.projectedMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: "Hello",
        }),
        expect.objectContaining({
          role: "assistant",
          content: expect.stringContaining("needs model credentials"),
        }),
      ]),
    );
    const userMessage =
      response.snapshot.session.foreground.projectedMessages.find(
        (message) => message.role === "user",
      );
    expect(userMessage).not.toHaveProperty("origin");
  });

  it("does not accumulate empty sessions when creating new sessions repeatedly", () => {
    const store = createStore();

    store.createSession(100);
    const firstSessionId = store.getActiveSessionId();
    store.createSession(200);
    store.createSession(300);

    expect(store.getActiveSessionId()).toBe(firstSessionId);
    expect(store.listSessions()).toEqual([]);
    expect(store.getHistorySnapshot()).toEqual({ sessions: [] });
  });

  it("treats repeated client message ids as idempotent sends", () => {
    const store = createStore();
    const credentialStatus: BrowserGatewayModelCredentialStatus = {
      state: "missing",
      reason: "No cached model credentials.",
    };

    const first = store.sendMessage({
      id: "ask-user-duplicate",
      text: "Going forward, always ask me before switching modes.",
      now: 100,
      theme,
      modelCredentialStatus: credentialStatus,
    });
    const repeated = store.sendMessage({
      id: "ask-user-duplicate",
      text: "Going forward, always ask me before switching modes.",
      now: 200,
      theme,
      modelCredentialStatus: credentialStatus,
    });

    expect(first.snapshot.session.foreground.projectedMessages).toHaveLength(2);
    expect(repeated.snapshot.session.foreground.projectedMessages).toHaveLength(
      2,
    );
    expect(
      repeated.snapshot.session.foreground.projectedMessages.filter(
        (message) => message.role === "user",
      ),
    ).toHaveLength(1);
    expect(store.getHistorySnapshot().sessions[0]?.messages).toHaveLength(2);
  });

  it("projects display media without leaking raw base64 media payloads", () => {
    const store = createStore();
    const credentialStatus: BrowserGatewayModelCredentialStatus = {
      state: "missing",
      reason: "No cached model credentials.",
    };

    const response = store.sendMessage({
      id: "ask-user-media",
      text: "Inspect this",
      now: 100,
      theme,
      modelCredentialStatus: credentialStatus,
      media: {
        images: [
          { name: "screenshot.png", mimeType: "image/png", base64: "abc123" },
        ],
        documents: [
          { name: "notes.txt", mimeType: "text/plain", base64: "bm90ZXM=" },
        ],
      },
    });

    const userMessage =
      response.snapshot.session.foreground.projectedMessages.find(
        (message) => message.role === "user",
      );
    expect(userMessage).toMatchObject({
      content: "Inspect this",
      displayMedia: {
        images: [
          {
            name: "screenshot.png",
            mimeType: "image/png",
            src: "data:image/png;base64,abc123",
          },
        ],
        documents: [{ name: "notes.txt", mimeType: "text/plain" }],
      },
    });
    expect(userMessage).not.toHaveProperty("media");

    const storedUserMessage = store
      .getTranscriptMessages()
      .find((message) => message.role === "user");
    expect(storedUserMessage?.media).toEqual({
      images: [
        { name: "screenshot.png", mimeType: "image/png", base64: "abc123" },
      ],
      documents: [
        { name: "notes.txt", mimeType: "text/plain", base64: "bm90ZXM=" },
      ],
    });
  });

  it("promotes generated image tool results to assistant display media", () => {
    const store = createStore();
    const credentialStatus: BrowserGatewayModelCredentialStatus = {
      state: "ready",
      providerId: "openai-codex",
      method: "oauth",
      modelScopes: ["chat"],
      grantedByOwnerId: "vscode-owner",
      grantedAt: 100,
    };

    const assistant = store.startAssistantMessage({ now: 100 });
    store.startAssistantToolCall({
      messageId: assistant.id,
      toolCallId: "generate-image-live",
      toolName: "generate_image",
      input: { prompt: "teal icon" },
    });
    store.completeAssistantToolCall({
      messageId: assistant.id,
      toolCallId: "generate-image-live",
      toolName: "generate_image",
      input: { prompt: "teal icon" },
      result: JSON.stringify({ status: "accepted", generated_count: 1 }),
      resultImages: [{ mimeType: "image/png", data: "YWJjZA==" }],
      durationMs: 42,
    });

    const response = store.getOrCreate({
      now: 200,
      theme,
      modelCredentialStatus: credentialStatus,
    });
    const assistantMessage =
      response.snapshot.session.foreground.projectedMessages.find(
        (message) => message.id === assistant.id,
      );

    expect(assistantMessage?.displayMedia).toEqual({
      images: [
        {
          name: "generated-image-1.png",
          mimeType: "image/png",
          src: "data:image/png;base64,YWJjZA==",
        },
      ],
      documents: [],
    });
    expect(assistantMessage?.blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "tool_call",
          id: "generate-image-live",
          resultImages: [{ mimeType: "image/png", data: "YWJjZA==" }],
        }),
      ]),
    );
  });

  it("marks assistant model failures with structured error metadata", () => {
    const store = createStore();
    const credentialStatus: BrowserGatewayModelCredentialStatus = {
      state: "ready",
      providerId: "openai-codex",
      method: "oauth",
      modelScopes: ["chat"],
      grantedByOwnerId: "vscode-owner",
      grantedAt: 100,
    };

    store.appendUserMessage({ id: "ask-user-1", text: "Hello", now: 100 });
    const assistant = store.startAssistantMessage({ now: 100 });
    store.finishAssistantErrorMessage({
      messageId: assistant.id,
      text: "I tried to call the model, but the request failed before a response was available. Please try again.",
      code: "model_error",
      retryable: true,
    });

    const response = store.getOrCreate({
      now: 100,
      theme,
      modelCredentialStatus: credentialStatus,
    });

    expect(response.snapshot.session.foreground.projectedMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: assistant.id,
          role: "assistant",
          content: "",
          blocks: [],
          error: {
            message: expect.stringContaining("request failed"),
            retryable: true,
            code: "model_error",
          },
        }),
      ]),
    );
    expect(response.snapshot.session.foreground.streaming).toBe(false);
  });

  it("maps fallback GPT/Codex models to the browser Codex credential family", () => {
    const store = createStore();

    expect(store.getModel()).toBe("gpt-5.3-codex");
    expect(store.getModelProvider()).toBe("openai-codex");
  });

  it("leaves unknown non-Codex model providers unavailable to browser credentials", () => {
    const store = createStore();

    store.updateAvailableModels([
      {
        id: "future-model",
        displayName: "Future Model",
        provider: "browser-gateway",
        contextWindow: 200_000,
        maxInputTokens: 180_000,
        reasoningEfforts: ["none", "low"],
        defaultReasoningEffort: "low",
        authenticated: true,
      },
    ]);

    expect(store.setModel("future-model")).toBe(true);
    expect(store.getModelProvider()).toBe("browser-gateway");
  });

  it("maps VS Code Codex provider IDs to the browser Codex credential family", () => {
    const store = createStore();

    store.updateAvailableModels([
      {
        id: "gpt-5.5",
        displayName: "GPT-5.5",
        provider: "codex",
        contextWindow: 1_000_000,
        maxInputTokens: 900_000,
        reasoningEfforts: ["none", "low", "medium", "high", "xhigh"],
        defaultReasoningEffort: "medium",
        authenticated: true,
      },
    ]);

    expect(store.setModel("gpt-5.5")).toBe(true);
    expect(store.getModelProvider()).toBe("openai-codex");
  });

  it("applies persisted model preferences when the published catalog arrives", () => {
    const store = new BrowserGatewayAskAgentSessionStore(
      new BrowserGatewayCoreOwnerRegistry({ heartbeatTtlMs: 30_000 }),
      { model: "claude-sonnet-4-5", reasoningEffort: "high" },
    );
    const credentialStatus: BrowserGatewayModelCredentialStatus = {
      state: "ready",
      providerId: "openai-codex",
      method: "oauth",
      modelScopes: ["chat"],
      grantedByOwnerId: "vscode-owner",
      grantedAt: 100,
    };

    expect(store.getModel()).toBe("gpt-5.3-codex");
    expect(store.getReasoningEffort()).toBe("high");

    store.updateAvailableModels([
      {
        id: "claude-sonnet-4-5",
        displayName: "Claude Sonnet 4.5",
        provider: "anthropic",
        contextWindow: 200_000,
        maxInputTokens: 180_000,
        reasoningEfforts: ["none", "low", "medium", "high"],
        defaultReasoningEffort: "medium",
        authenticated: true,
      },
      {
        id: "gpt-5.3-codex",
        displayName: "GPT-5.3 Codex",
        provider: "openai-codex",
        contextWindow: 200_000,
        maxInputTokens: 200_000,
        reasoningEfforts: ["none", "minimal", "low", "medium", "high"],
        defaultReasoningEffort: "low",
        authenticated: true,
      },
    ]);

    const response = store.getOrCreate({
      now: 100,
      theme,
      modelCredentialStatus: credentialStatus,
    });

    expect(response.snapshot.session.foreground.model).toBe(
      "claude-sonnet-4-5",
    );
    expect(response.snapshot.session.foreground.reasoningEffort).toBe("high");
    expect(store.getPreferencesSnapshot()).toEqual({
      model: "claude-sonnet-4-5",
      reasoningEffort: "high",
    });
  });

  it("creates, loads, renames, deletes, and snapshots Ask Agent sessions", () => {
    const store = createStore();
    const credentialStatus: BrowserGatewayModelCredentialStatus = {
      state: "missing",
      reason: "Missing credentials.",
    };

    const first = store.sendMessage({
      id: "ask-user-1",
      text: "First durable chat",
      now: 100,
      theme,
      modelCredentialStatus: credentialStatus,
    });
    const firstSessionId = first.snapshot.session.foreground.sessionId;
    expect(first.snapshot.session.foreground.title).toBe("First durable chat");

    store.createSession(200);
    const second = store.getOrCreate({
      now: 200,
      theme,
      modelCredentialStatus: credentialStatus,
    });
    const secondSessionId = second.snapshot.session.foreground.sessionId;
    expect(secondSessionId).not.toBe(firstSessionId);
    expect(second.snapshot.session.foreground.projectedMessages).toEqual([]);

    expect(store.listSessions().map((session) => session.id)).toEqual([
      firstSessionId,
    ]);

    expect(store.loadSession(firstSessionId)).toBe(true);
    expect(
      store.getOrCreate({
        now: 300,
        theme,
        modelCredentialStatus: credentialStatus,
      }).snapshot.session.foreground.projectedMessages,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ content: "First durable chat" }),
      ]),
    );

    expect(store.renameSession(firstSessionId, "Renamed chat", 400)).toBe(true);
    expect(store.getFirstPrompt(firstSessionId)).toBe("First durable chat");
    expect(store.deleteSession(firstSessionId, 500)).toBe(true);
    expect(store.getActiveSessionId()).toBe(secondSessionId);
    expect(store.listSessions()).toEqual([]);

    const history = store.getHistorySnapshot();
    const reloaded = createStore();
    reloaded.loadHistory(history);
    expect(reloaded.listSessions()).toEqual([]);
  });

  it("records assistant tool calls using shared transcript block shape", () => {
    const store = createStore();
    store.appendUserMessage({ id: "ask-user-1", text: "Use a tool", now: 100 });
    const assistant = store.startAssistantMessage({ now: 101 });

    store.appendAssistantDelta(assistant.id, "Checking...");
    store.startAssistantToolCall({
      messageId: assistant.id,
      toolCallId: "call_todos",
      toolName: "todo_write",
      input: {
        todos: [
          {
            id: "audit",
            content: "Audit parity",
            activeForm: "Auditing parity",
            status: "in_progress",
          },
        ],
      },
    });
    store.completeAssistantToolCall({
      messageId: assistant.id,
      toolCallId: "call_todos",
      toolName: "todo_write",
      input: {
        todos: [
          {
            id: "audit",
            content: "Audit parity",
            activeForm: "Auditing parity",
            status: "in_progress",
          },
        ],
      },
      result: JSON.stringify({ ok: true }),
      durationMs: 12,
    });
    store.appendAssistantDelta(assistant.id, "done.");

    const response = store.getOrCreate({
      now: 102,
      theme,
      modelCredentialStatus: {
        state: "ready",
        providerId: "openai-codex",
        method: "oauth",
        modelScopes: ["chat"],
        grantedByOwnerId: "vscode-owner",
        grantedAt: 100,
      },
    });
    const projectedAssistant =
      response.snapshot.session.foreground.projectedMessages.find(
        (message) => message.id === assistant.id,
      );

    expect(projectedAssistant?.content).toBe("Checking...done.");
    expect(projectedAssistant?.blocks).toEqual([
      { type: "text", text: "Checking..." },
      expect.objectContaining({
        type: "tool_call",
        id: "call_todos",
        name: "todo_write",
        result: JSON.stringify({ ok: true }),
        complete: true,
        durationMs: 12,
      }),
      { type: "text", text: "done." },
    ]);
  });

  it("snapshots structured question, progress, and todo state and clears it on session switches", () => {
    const store = createStore();
    const credentialStatus: BrowserGatewayModelCredentialStatus = {
      state: "ready",
      providerId: "openai-codex",
      method: "oauth",
      modelScopes: ["chat"],
      grantedByOwnerId: "vscode-owner",
      grantedAt: 100,
    };

    const assistant = store.startAssistantMessage({ now: 99 });
    store.startAssistantToolCall({
      messageId: assistant.id,
      toolCallId: "ask-question-1",
      toolName: "ask_user",
      input: {},
    });

    store.setQuestionRequest({
      id: "ask-question-1",
      context: "Need a read-only decision.",
      questions: [
        {
          id: "continue",
          type: "yes_no",
          question: "Continue?",
          recommended: "Yes",
        },
      ],
    });
    expect(
      store.setQuestionProgress({
        id: "ask-question-1",
        step: 0,
        answers: { continue: true },
        notes: { continue: "Looks good." },
        origin: "browser-a",
      }),
    ).toBe(true);
    store.setTodos([
      {
        id: "audit",
        content: "Audit parity",
        activeForm: "Auditing parity",
        status: "in_progress",
      },
    ]);
    const handoff = store.proposeProjectHandoff({
      id: "handoff-1",
      sessionId: store.getActiveSessionId(),
      createdAt: 100,
      targetInstanceId: "vscode-instance-1",
      targetWorkspaceName: "AgentLink",
      targetWorkspacePath: "/workspace/agentlink",
      mode: "code",
      instruction: "Continue the approved plan.",
    });
    expect(handoff.status).toBe("pending");
    store.addReadGrant({
      id: "read-grant-1",
      createdAt: 100,
      rootPath: "/workspace/agentlink",
      label: "agentlink",
      kind: "directory",
    });

    const response = store.getOrCreate({
      now: 100,
      theme,
      modelCredentialStatus: credentialStatus,
    });
    expect(response.snapshot.ui.question?.id).toBe("ask-question-1");
    expect(response.snapshot.ui.questionProgress).toMatchObject({
      id: "ask-question-1",
      answers: { continue: true },
    });
    expect(response.snapshot.session.foreground.questionRequest?.id).toBe(
      "ask-question-1",
    );
    expect(response.snapshot.session.foreground.todos).toEqual([
      expect.objectContaining({ id: "audit", status: "in_progress" }),
    ]);
    expect(response.snapshot.ui.projectHandoff).toMatchObject({
      id: "handoff-1",
      status: "pending",
      instruction: "Continue the approved plan.",
    });
    expect(response.snapshot.ui.readGrants).toEqual([
      {
        id: "read-grant-1",
        createdAt: 100,
        rootPath: "/workspace/agentlink",
        label: "agentlink",
        kind: "directory",
      },
    ]);
    expect(store.removeReadGrant("read-grant-1")).toBe(true);
    expect(store.getReadGrants()).toEqual([]);
    expect(store.markProjectHandoffLaunching("handoff-1")?.status).toBe(
      "launching",
    );
    expect(store.failProjectHandoff("handoff-1", "target unavailable")).toBe(
      true,
    );
    expect(store.getProjectHandoff()).toMatchObject({
      id: "handoff-1",
      status: "failed",
      error: "target unavailable",
    });

    expect(store.answerQuestion("ask-question-1")).toMatchObject({
      toolCallId: "ask-question-1",
    });
    const answered = store.getOrCreate({
      now: 101,
      theme,
      modelCredentialStatus: credentialStatus,
    });
    expect(answered.snapshot.ui.question).toBeNull();
    expect(answered.snapshot.ui.questionProgress).toBeNull();

    store.setQuestionRequest({
      id: "ask-question-2",
      context: "Another decision.",
      questions: [
        { id: "again", type: "yes_no", question: "Again?", recommended: "No" },
      ],
    });
    store.createSession(200);
    const nextSession = store.getOrCreate({
      now: 200,
      theme,
      modelCredentialStatus: credentialStatus,
    });
    expect(nextSession.snapshot.ui.question).toBeNull();
    expect(nextSession.snapshot.session.foreground.todos).toEqual([]);
    expect(nextSession.snapshot.ui.projectHandoff).toBeNull();
  });

  it("prepares the latest retryable assistant error without duplicating the user prompt", () => {
    const store = createStore();
    const credentialStatus: BrowserGatewayModelCredentialStatus = {
      state: "ready",
      providerId: "openai-codex",
      method: "oauth",
      modelScopes: ["chat"],
      grantedByOwnerId: "vscode-owner",
      grantedAt: 100,
    };

    store.appendUserMessage({ id: "ask-user-1", text: "Retry me", now: 100 });
    const sessionId = store.getActiveSessionId();
    const assistant = store.startAssistantMessage({ now: 101 });
    store.finishAssistantErrorMessage({
      messageId: assistant.id,
      text: "I tried to call the model, but the request failed before a response was available. Please try again.",
      code: "model_error",
      retryable: true,
    });

    const retryableTurn = store.prepareLatestRetryableTurn({
      sessionId,
      now: 200,
    });
    expect(retryableTurn?.userMessage.id).toBe("ask-user-1");
    expect(retryableTurn?.toolResults).toEqual([]);

    const response = store.getOrCreate({
      now: 200,
      theme,
      modelCredentialStatus: credentialStatus,
    });
    expect(response.snapshot.session.foreground.projectedMessages).toEqual([
      expect.objectContaining({
        id: "ask-user-1",
        role: "user",
        content: "Retry me",
      }),
    ]);
    expect(
      store.prepareLatestRetryableTurn({ sessionId, now: 201 }),
    ).toBeNull();
  });

  it("prepares the latest retryable turn in a multi-turn transcript", () => {
    const store = createStore();
    store.appendUserMessage({ id: "ask-user-1", text: "First turn", now: 100 });
    const firstAssistant = store.startAssistantMessage({ now: 101 });
    store.finishAssistantMessage(firstAssistant.id, "First answer");
    store.appendUserMessage({
      id: "ask-user-2",
      text: "Second turn",
      now: 200,
    });
    const secondAssistant = store.startAssistantMessage({ now: 201 });
    store.finishAssistantErrorMessage({
      messageId: secondAssistant.id,
      text: "I tried to call the model, but the request failed before a response was available. Please try again.",
      code: "model_error",
      retryable: true,
    });
    const sessionId = store.getActiveSessionId();

    const retryableTurn = store.prepareLatestRetryableTurn({
      sessionId,
      now: 300,
    });

    expect(retryableTurn?.userMessage.id).toBe("ask-user-2");
    expect(retryableTurn?.toolResults).toEqual([]);
    const messages = store.getOrCreate({
      now: 300,
      theme,
      modelCredentialStatus: {
        state: "ready",
        providerId: "openai-codex",
        method: "oauth",
        modelScopes: ["chat"],
        grantedByOwnerId: "vscode-owner",
        grantedAt: 100,
      },
    }).snapshot.session.foreground.projectedMessages;
    expect(messages.map((message) => message.id)).toEqual([
      "ask-user-1",
      firstAssistant.id,
      "ask-user-2",
    ]);
  });

  it("captures completed ask_user tool results while preparing a retryable answer-resume failure", () => {
    const store = createStore();
    store.appendUserMessage({ id: "ask-user-1", text: "Ask me", now: 100 });
    const assistant = store.startAssistantMessage({ now: 101 });
    store.startAssistantToolCall({
      messageId: assistant.id,
      toolCallId: "call_question",
      toolName: "ask_user",
      input: { context: "Need input.", questions: [] },
    });
    store.completeAssistantToolCall({
      messageId: assistant.id,
      toolCallId: "call_question",
      toolName: "ask_user",
      input: { context: "Need input.", questions: [] },
      result: JSON.stringify({
        ok: true,
        responses: [{ question: "Continue?", answer: true }],
      }),
      durationMs: 0,
    });
    store.finishAssistantErrorMessage({
      messageId: assistant.id,
      text: "Retryable failure after answer.",
      code: "model_error",
      retryable: true,
      preserveCompletedAskUserBlocks: true,
    });

    const retryableTurn = store.prepareLatestRetryableTurn({
      sessionId: store.getActiveSessionId(),
      now: 200,
    });

    expect(retryableTurn?.userMessage.id).toBe("ask-user-1");
    expect(retryableTurn?.toolResults).toEqual([
      {
        toolCallId: "call_question",
        toolName: "ask_user",
        input: { context: "Need input.", questions: [] },
        result: JSON.stringify({
          ok: true,
          responses: [{ question: "Continue?", answer: true }],
        }),
      },
    ]);
  });

  it("does not create an implicit session when retry has no explicit match", () => {
    const store = createStore();

    expect(
      store.prepareLatestRetryableTurn({
        sessionId: "browser-gateway:ask-agent:missing",
        now: 200,
      }),
    ).toBeNull();
    expect(store.getHistorySnapshot()).toEqual({ sessions: [] });
  });

  it("leaves retryable assistant errors without resendable user prompts untouched", () => {
    const store = createStore();
    const assistant = store.startAssistantMessage({ now: 100 });
    store.finishAssistantErrorMessage({
      messageId: assistant.id,
      text: "I tried to call the model, but the request failed before a response was available. Please try again.",
      retryable: true,
      code: "model_error",
    });
    const sessionId = store.getActiveSessionId();

    expect(
      store.prepareLatestRetryableTurn({ sessionId, now: 200 }),
    ).toBeNull();
    expect(
      store.getOrCreate({
        now: 200,
        theme,
        modelCredentialStatus: { state: "missing", reason: "Missing." },
      }).snapshot.session.foreground.projectedMessages,
    ).toEqual([
      expect.objectContaining({
        id: assistant.id,
        error: expect.objectContaining({ retryable: true }),
      }),
    ]);
  });

  it("does not prepare non-retryable assistant errors", () => {
    const store = createStore();
    store.appendUserMessage({ id: "ask-user-1", text: "Stopped", now: 100 });
    const assistant = store.startAssistantMessage({ now: 101 });
    store.finishAssistantErrorMessage({
      messageId: assistant.id,
      text: "Response stopped.",
      code: "model_stopped",
      retryable: false,
    });

    expect(
      store.prepareLatestRetryableTurn({
        sessionId: store.getActiveSessionId(),
        now: 200,
      }),
    ).toBeNull();
  });

  it("updates helper-owned model and reasoning state", () => {
    const store = createStore();
    const credentialStatus: BrowserGatewayModelCredentialStatus = {
      state: "ready",
      providerId: "openai-codex",
      method: "oauth",
      modelScopes: ["chat"],
      grantedByOwnerId: "vscode-owner",
      grantedAt: 100,
    };

    expect(store.getModel()).toBe("gpt-5.3-codex");
    expect(store.getReasoningEffort()).toBe("low");
    expect(store.getAvailableModels().map((model) => model.id)).toEqual([
      "gpt-5.3-codex",
      "gpt-5.2-codex",
      "gpt-5.1-codex",
    ]);
    expect(store.setReasoningEffort("high")).toBe(true);
    expect(store.setModel("gpt-5.3-codex")).toBe(true);

    const response = store.getOrCreate({
      now: 100,
      theme,
      modelCredentialStatus: credentialStatus,
    });

    expect(response.snapshot.session.foreground.model).toBe("gpt-5.3-codex");
    expect(response.snapshot.session.foreground.reasoningEffort).toBe("high");
    expect(response.snapshot.session.foreground.thinkingEnabled).toBe(true);
  });

  it("does not advertise streaming as a future slice once credentials are ready", () => {
    const store = createStore();
    const credentialStatus: BrowserGatewayModelCredentialStatus = {
      state: "ready",
      providerId: "openai-codex",
      method: "oauth",
      modelScopes: ["chat"],
      grantedByOwnerId: "vscode-owner",
      grantedAt: 100,
      accountLabel: "acct@example.com",
    };

    const response = store.sendMessage({
      id: "ask-user-1",
      text: "Hello",
      now: 100,
      theme,
      modelCredentialStatus: credentialStatus,
    });

    const assistantText = response.snapshot.session.foreground.projectedMessages
      .filter((message) => message.role === "assistant")
      .map((message) => message.content)
      .join("\n");

    expect(assistantText).toContain("cached model credentials");
    expect(assistantText).not.toContain("next Phase 3B slice");
    expect(assistantText).not.toContain("streaming real model turns");
  });
});
