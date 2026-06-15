import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BrowserGatewayServer } from "./BrowserGatewayServer.js";
import { BrowserGatewayService } from "./BrowserGatewayService.js";
import { InMemoryAgentUiEventHub } from "../agent/AgentUiPublisher.js";
import { diffSnapshotHub } from "./DiffSnapshotHub.js";

vi.mock("vscode", () => {
  type Listener<T> = (event: T) => void;

  class MockEventEmitter<T> {
    private listeners = new Set<Listener<T>>();

    event = (listener: Listener<T>) => {
      this.listeners.add(listener);
      return { dispose: () => this.listeners.delete(listener) };
    };

    fire(value: T): void {
      for (const listener of this.listeners) {
        listener(value);
      }
    }

    dispose(): void {
      this.listeners.clear();
    }
  }

  return {
    EventEmitter: MockEventEmitter,
    workspace: {
      getConfiguration: () => ({
        get: () => undefined,
      }),
    },
  };
});

function makeSessionManagerStub() {
  return {
    listPersistedSessions: vi.fn(() => [
      {
        schemaVersion: 1,
        id: "session-1",
        mode: "code",
        model: "claude-sonnet-4-6",
        title: "Test Session",
        messageCount: 2,
        totalInputTokens: 10,
        totalOutputTokens: 20,
        createdAt: 1,
        lastActiveAt: 2,
      },
    ]),
    getForegroundSession: vi.fn(() => ({
      id: "session-1",
      title: "Test Session",
      mode: "code",
      model: "claude-sonnet-4-6",
      status: "idle",
      lastInputTokens: 10,
      lastOutputTokens: 20,
      lastCacheReadTokens: 3,
      estimatedTotalUsed: 33,
      getAllMessages: vi.fn(() => [
        { role: "user", content: "hello" },
        { role: "assistant", content: [{ type: "text", text: "world" }] },
      ]),
    })),
    getPersistedSessionMessages: vi.fn(() => [
      { role: "user", content: "hello" },
      { role: "assistant", content: [{ type: "text", text: "world" }] },
    ]),
    getBgSessionInfos: vi.fn(() => [
      {
        id: "bg-1",
        task: "Review implementation",
        status: "streaming",
        displayStatus: "streaming",
        resolvedMode: "review",
        resolvedModel: "claude-opus-4-8",
      },
    ]),
  };
}

function makeChatViewProviderStub() {
  return {
    submitBrowserApprovalDecision: vi.fn(() => true),
    submitBrowserQuestionResponse: vi.fn(() => true),
    publishBrowserQuestionProgress: vi.fn(() => true),
    submitBrowserSend: vi.fn<() => Promise<{ ok: boolean; queued?: boolean }>>(
      async () => ({ ok: true }),
    ),
    submitBrowserModeSwitch: vi.fn(async (mode: string) => ({
      approved: true,
      mode,
    })),
    getBrowserSlashCommands: vi.fn(async () => [
      {
        name: "new",
        description: "Create new session",
        source: "builtin",
        builtin: true,
      },
      {
        name: "mcp",
        description: "Open MCP panel",
        source: "builtin",
        builtin: true,
      },
    ]),
    searchBrowserFiles: vi.fn(async (query: string) =>
      query === "src" ? [{ path: "src/index.ts", kind: "file" as const }] : [],
    ),
    getBrowserModes: vi.fn(async () => [
      { slug: "code", name: "Code", icon: "code" },
      { slug: "architect", name: "Architect", icon: "symbol-structure" },
    ]),
    getBrowserModels: vi.fn(async () => [
      {
        id: "claude-sonnet-4-6",
        displayName: "Claude Sonnet 4.6",
        provider: "anthropic",
        contextWindow: 200000,
        authenticated: true,
        condenseThreshold: 0.8,
      },
    ]),
    submitBrowserSetModel: vi.fn(async (_model: string) => ({ ok: true })),
    submitBrowserSetWriteApproval: vi.fn(() => ({ ok: true })),
    submitBrowserSetThinkingEnabled: vi.fn(() => ({ ok: true })),
    submitBrowserNewSession: vi.fn(async () => ({ ok: true })),
    submitBrowserAttachFile: vi.fn(async () => ({
      files: ["/tmp/from-picker.txt"],
    })),
    submitBrowserStop: vi.fn(() => ({ ok: true })),
    submitBrowserStopBackground: vi.fn(() => ({ ok: true })),
    getBrowserBgTranscript: vi.fn((sessionId: string) => ({
      ok: true,
      transcript: {
        sessionId,
        task: "Background Agent",
        messages: [
          { role: "assistant", content: [{ type: "text", text: "Done" }] },
        ],
      },
    })),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  diffSnapshotHub.remove("approval-1");
  diffSnapshotHub.remove("approval-large");
});

describe("BrowserGatewayServer", () => {
  it("serves API/stream routes, registry/snapshot state, diff detail, and routes browser actions", async () => {
    const hub = new InMemoryAgentUiEventHub();
    const sessionManager = makeSessionManagerStub();
    const chatViewProvider = makeChatViewProviderStub();
    let projectedModel = "claude-sonnet-4-6";
    chatViewProvider.submitBrowserSetModel.mockImplementation(
      async (model: string) => {
        projectedModel = model;
        return { ok: true };
      },
    );
    chatViewProvider.submitBrowserNewSession.mockImplementation(async () => {
      projectedModel = "gpt-5.3-codex";
      return { ok: true };
    });
    const service = new BrowserGatewayService(
      hub,
      sessionManager as never,
      () => ({
        cssVariables: {
          "--vscode-editor-background": "#1e1e1e",
        },
        colorScheme: "dark",
        themeLabel: "Dark",
        source: "vscode-theme-api",
      }),
      () => "prompt",
      () => true,
      () => "high",
      () => ({
        sessionId: "session-1",
        mode: "code",
        model: projectedModel,
        streaming: false,
        statusOverride: null,
        projectedMessages: [
          {
            id: "chat-1",
            role: "assistant",
            content: "",
            timestamp: 1,
            blocks: [{ type: "text", text: "world" }],
          },
        ],
        lastInputTokens: 10,
        lastOutputTokens: 20,
        lastCacheReadTokens: 3,
        estimatedTotalUsed: 33,
        thinkingEnabled: true,
        reasoningEffort: "high",
        messageQueue: [],
        questionRequest: null,
        detectedQuestion: null,
        todos: [],
        debugInfo: null,
        systemPrompt: null,
        loadedInstructions: null,
        restoringSession: false,
        revertRecoveryNotice: null,
        contextBudget: {
          contextWindow: 200000,
          maxInputTokens: 191808,
          usedInputTokens: 10,
          outputReservation: 8192,
          safetyBufferTokens: 4096,
          softThresholdBudget: 150000,
          hardBudget: 180000,
        },
        condenseThreshold: 0.8,
      }),
      () => [],
    );
    const server = new BrowserGatewayServer(
      service,
      chatViewProvider as never,
      "test-token",
      "instance-1",
      "Workspace One",
      "/workspace/one",
      vi.fn(),
    );
    const port = await server.start(0);
    const baseUrl = `http://127.0.0.1:${port}`;

    hub.publishApproval({
      kind: "write",
      id: "approval-1",
      filePath: "src/file.ts",
      writeOperation: "modify",
    });
    hub.publishQuestionRequest("question-1", "Need confirmation.", [
      {
        id: "q1",
        type: "yes_no",
        question: "Continue?",
      },
    ]);
    diffSnapshotHub.upsert({
      requestId: "approval-1",
      filePath: "src/file.ts",
      operation: "modify",
      originalContent: "before",
      proposedContent: "after",
      outsideWorkspace: false,
      createdAt: 1,
    });
    diffSnapshotHub.upsert({
      requestId: "approval-large",
      filePath: "src/large-file.ts",
      operation: "modify",
      originalContent: "a".repeat(1_000_001),
      proposedContent: "b".repeat(1_000_000),
      outsideWorkspace: false,
      createdAt: 2,
    });

    const instancesResponse = await fetch(`${baseUrl}/api/instances`);
    expect(instancesResponse.ok).toBe(true);
    const instancesJson = (await instancesResponse.json()) as {
      currentInstanceId: string;
      instances: Array<{
        instanceId: string;
        status?: { kind: string; label: string };
      }>;
    };
    expect(instancesJson).toHaveProperty("currentInstanceId", "instance-1");
    expect(Array.isArray(instancesJson.instances)).toBe(true);
    const currentInstance = instancesJson.instances.find(
      (instance) => instance.instanceId === "instance-1",
    );
    if (currentInstance) {
      expect(currentInstance.status).toEqual({
        kind: "awaiting_approval",
        label: "Question",
        detail: "Awaiting response",
        sessionTitle: "Test Session",
      });
    }

    const unauthorizedInstanceStatusResponse = await fetch(
      `${baseUrl}/api/instance-status`,
    );
    expect(unauthorizedInstanceStatusResponse.status).toBe(401);

    const instanceStatusResponse = await fetch(
      `${baseUrl}/api/instance-status`,
      { headers: { Authorization: "Bearer test-token" } },
    );
    expect(instanceStatusResponse.ok).toBe(true);
    expect(await instanceStatusResponse.json()).toEqual({
      kind: "awaiting_approval",
      label: "Question",
      detail: "Awaiting response",
      sessionTitle: "Test Session",
    });

    const pageResponse = await fetch(`${baseUrl}/`);
    expect(pageResponse.status).toBe(404);
    expect(await pageResponse.json()).toEqual({ error: "not_found" });

    const gatewayJsResponse = await fetch(`${baseUrl}/browser-gateway.js`);
    expect(gatewayJsResponse.status).toBe(404);

    const gatewayCssResponse = await fetch(`${baseUrl}/browser-gateway.css`);
    expect(gatewayCssResponse.status).toBe(404);

    const codiconFontResponse = await fetch(
      `${baseUrl}/codicon.ttf?c7330ef9199d97dc5b8aae3449a5dc27`,
    );
    expect(codiconFontResponse.status).toBe(404);

    const faviconResponse = await fetch(`${baseUrl}/favicon.ico`);
    expect(faviconResponse.status).toBe(404);

    const snapshotResponse = await fetch(`${baseUrl}/api/ui-state`);
    expect(snapshotResponse.ok).toBe(true);
    const snapshotJson = await snapshotResponse.json();
    expect(snapshotJson).toEqual({
      ui: {
        approval: {
          kind: "write",
          id: "approval-1",
          filePath: "src/file.ts",
          writeOperation: "modify",
        },
        mcpStatusInfos: [],
        question: {
          id: "question-1",
          context: "Need confirmation.",
          questions: [
            {
              id: "q1",
              type: "yes_no",
              question: "Continue?",
            },
          ],
        },
        questionProgress: null,
        recentEvents: [
          {
            type: "showApproval",
            request: {
              kind: "write",
              id: "approval-1",
              filePath: "src/file.ts",
              writeOperation: "modify",
            },
          },
          {
            type: "agentQuestionRequest",
            id: "question-1",
            context: "Need confirmation.",
            questions: [
              {
                id: "q1",
                type: "yes_no",
                question: "Continue?",
              },
            ],
          },
        ],
      },
      session: {
        sessions: [
          {
            schemaVersion: 1,
            id: "session-1",
            mode: "code",
            model: "claude-sonnet-4-6",
            title: "Test Session",
            messageCount: 2,
            totalInputTokens: 10,
            totalOutputTokens: 20,
            createdAt: 1,
            lastActiveAt: 2,
          },
        ],
        repository: null,
        foreground: {
          sessionId: "session-1",
          title: "Test Session",
          mode: "code",
          model: "claude-sonnet-4-6",
          status: "idle",
          streaming: false,
          messages: [
            { role: "user", content: "hello" },
            { role: "assistant", content: [{ type: "text", text: "world" }] },
          ],
          projectedMessages: [
            {
              id: "chat-1",
              role: "assistant",
              content: "",
              timestamp: 1,
              blocks: [{ type: "text", text: "world" }],
            },
          ],
          statusOverride: null,
          thinkingEnabled: true,
          reasoningEffort: "high",
          lastInputTokens: 10,
          lastOutputTokens: 20,
          lastCacheReadTokens: 3,
          estimatedTotalUsed: 33,
          messageQueue: [],
          questionRequest: null,
          detectedQuestion: null,
          todos: [],
          debugInfo: null,
          systemPrompt: null,
          loadedInstructions: null,
          restoringSession: false,
          revertRecoveryNotice: null,
          contextBudget: {
            contextWindow: 200000,
            maxInputTokens: 191808,
            usedInputTokens: 10,
            outputReservation: 8192,
            safetyBufferTokens: 4096,
            softThresholdBudget: 150000,
            hardBudget: 180000,
          },
          condenseThreshold: 0.8,
          agentWriteApproval: "prompt",
        },
      },
      background: [
        {
          id: "bg-1",
          task: "Review implementation",
          status: "streaming",
          displayStatus: "streaming",
          resolvedMode: "review",
          resolvedModel: "claude-opus-4-8",
        },
      ],
      diffs: [
        {
          requestId: "approval-1",
          filePath: "src/file.ts",
          operation: "modify",
          originalPreview: "before",
          proposedPreview: "after",
          outsideWorkspace: false,
          createdAt: 1,
        },
        {
          requestId: "approval-large",
          filePath: "src/large-file.ts",
          operation: "modify",
          originalPreview: "a".repeat(600),
          proposedPreview: "b".repeat(600),
          outsideWorkspace: false,
          createdAt: 2,
        },
      ],
      theme: {
        cssVariables: {
          "--vscode-editor-background": "#1e1e1e",
        },
        colorScheme: "dark",
        themeLabel: "Dark",
        source: "vscode-theme-api",
      },
    });

    const unauthorizedDiffDetailResponse = await fetch(
      `${baseUrl}/api/diff/approval-1`,
    );
    expect(unauthorizedDiffDetailResponse.status).toBe(401);
    expect(await unauthorizedDiffDetailResponse.json()).toEqual({
      error: "unauthorized",
    });

    const diffDetailResponse = await fetch(`${baseUrl}/api/diff/approval-1`, {
      headers: { Authorization: "Bearer test-token" },
    });
    expect(diffDetailResponse.ok).toBe(true);
    expect(await diffDetailResponse.json()).toEqual({
      requestId: "approval-1",
      filePath: "src/file.ts",
      operation: "modify",
      outsideWorkspace: false,
      createdAt: 1,
      originalContent: "before",
      proposedContent: "after",
    });

    const missingDiffResponse = await fetch(`${baseUrl}/api/diff/missing`, {
      headers: { Authorization: "Bearer test-token" },
    });
    expect(missingDiffResponse.status).toBe(404);
    expect(await missingDiffResponse.json()).toEqual({ error: "not_found" });

    const largeDiffResponse = await fetch(
      `${baseUrl}/api/diff/approval-large`,
      {
        headers: { Authorization: "Bearer test-token" },
      },
    );
    expect(largeDiffResponse.status).toBe(413);
    expect(await largeDiffResponse.json()).toEqual({
      error: "diff_too_large",
      maxChars: 2_000_000,
      totalChars: 2_000_001,
      requestId: "approval-large",
      filePath: "src/large-file.ts",
      operation: "modify",
      outsideWorkspace: false,
      createdAt: 2,
    });

    const sseResponse = await fetch(`${baseUrl}/events`, {
      headers: { Accept: "text/event-stream" },
    });
    expect(sseResponse.ok).toBe(true);
    expect(sseResponse.body).toBeTruthy();

    const reader = sseResponse.body!.getReader();
    const decoder = new TextDecoder();

    const firstChunk = await reader.read();
    const snapshotChunk = decoder.decode(firstChunk.value, { stream: true });
    expect(snapshotChunk).toContain("event: snapshot");
    expect(snapshotChunk).toContain('"approval-1"');
    expect(snapshotChunk).toContain('"question-1"');
    expect(snapshotChunk).toContain('"session-1"');
    expect(snapshotChunk).toContain('"bg-1"');

    hub.publishApprovalIdle();

    const secondChunk = await reader.read();
    const updateChunk = decoder.decode(secondChunk.value, { stream: true });
    expect(updateChunk).toContain("event: update");
    expect(updateChunk).toContain('"approval":null');

    const unauthorizedApproval = await fetch(`${baseUrl}/api/approval`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "approval-1", decision: "accept" }),
    });
    expect(unauthorizedApproval.status).toBe(401);

    const invalidApproval = await fetch(`${baseUrl}/api/approval`, {
      method: "POST",
      headers: {
        Authorization: "Bearer test-token",
      },
      body: "{bad json",
    });
    expect(invalidApproval.status).toBe(400);
    expect(await invalidApproval.json()).toEqual({ error: "invalid_json" });

    const authorizedApproval = await fetch(`${baseUrl}/api/approval`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-token",
      },
      body: JSON.stringify({ id: "approval-1", decision: "accept" }),
    });
    expect(authorizedApproval.status).toBe(200);
    expect(await authorizedApproval.json()).toEqual({ ok: true });
    expect(chatViewProvider.submitBrowserApprovalDecision).toHaveBeenCalledWith(
      {
        id: "approval-1",
        decision: "accept",
      },
    );

    const authorizedQuestion = await fetch(`${baseUrl}/api/question`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-token",
      },
      body: JSON.stringify({
        id: "question-1",
        answers: { q1: "Yes" },
        notes: {},
      }),
    });
    expect(authorizedQuestion.status).toBe(200);
    expect(await authorizedQuestion.json()).toEqual({ ok: true });
    expect(chatViewProvider.submitBrowserQuestionResponse).toHaveBeenCalledWith(
      {
        id: "question-1",
        answers: { q1: "Yes" },
        notes: {},
      },
    );

    const authorizedProgress = await fetch(`${baseUrl}/api/question-progress`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-token",
      },
      body: JSON.stringify({
        id: "question-1",
        step: 1,
        answers: { q1: "Yes" },
        notes: { q1: "because reasons" },
        origin: "browser-origin-abc",
      }),
    });
    expect(authorizedProgress.status).toBe(200);
    expect(await authorizedProgress.json()).toEqual({ ok: true });
    expect(
      chatViewProvider.publishBrowserQuestionProgress,
    ).toHaveBeenCalledWith({
      id: "question-1",
      step: 1,
      answers: { q1: "Yes" },
      notes: { q1: "because reasons" },
      origin: "browser-origin-abc",
    });

    const invalidProgress = await fetch(`${baseUrl}/api/question-progress`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-token",
      },
      body: JSON.stringify({ id: "question-1" }),
    });
    expect(invalidProgress.status).toBe(400);

    const authorizedSend = await fetch(`${baseUrl}/api/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-token",
      },
      body: JSON.stringify({
        text: "Ship it",
        sessionId: "session-1",
        mode: "code",
        images: [
          {
            name: "diagram.png",
            mimeType: "image/png",
            base64: "img-base64",
          },
        ],
        documents: [
          {
            name: "brief.pdf",
            mimeType: "application/pdf",
            base64: "pdf-base64",
          },
        ],
      }),
    });
    expect(authorizedSend.status).toBe(200);
    expect(await authorizedSend.json()).toEqual({ ok: true });
    expect(chatViewProvider.submitBrowserSend).toHaveBeenCalledWith({
      text: "Ship it",
      sessionId: "session-1",
      mode: "code",
      thinkingEnabled: undefined,
      reasoningEffort: undefined,
      attachments: [],
      images: [
        {
          name: "diagram.png",
          mimeType: "image/png",
          base64: "img-base64",
        },
      ],
      documents: [
        {
          name: "brief.pdf",
          mimeType: "application/pdf",
          base64: "pdf-base64",
        },
      ],
      displayText: undefined,
      slashCommandLabel: undefined,
      isSlashCommand: false,
    });

    chatViewProvider.submitBrowserSend.mockResolvedValueOnce({
      ok: true,
      queued: true,
    });
    const queuedSend = await fetch(`${baseUrl}/api/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-token",
      },
      body: JSON.stringify({
        text: "Queue it",
        sessionId: "session-1",
        mode: "code",
      }),
    });
    expect(queuedSend.status).toBe(200);
    expect(await queuedSend.json()).toEqual({ ok: true, queued: true });

    const authorizedMode = await fetch(`${baseUrl}/api/mode`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-token",
      },
      body: JSON.stringify({
        mode: "architect",
      }),
    });
    expect(authorizedMode.status).toBe(200);
    expect(await authorizedMode.json()).toEqual({
      approved: true,
      mode: "architect",
    });
    expect(chatViewProvider.submitBrowserModeSwitch).toHaveBeenCalledWith(
      "architect",
    );

    const unauthorizedSlash = await fetch(`${baseUrl}/api/slash-commands`);
    expect(unauthorizedSlash.status).toBe(401);

    const authorizedSlash = await fetch(`${baseUrl}/api/slash-commands`, {
      headers: { Authorization: "Bearer test-token" },
    });
    expect(authorizedSlash.status).toBe(200);
    expect(await authorizedSlash.json()).toEqual({
      commands: [
        {
          name: "new",
          description: "Create new session",
          source: "builtin",
          builtin: true,
        },
        {
          name: "mcp",
          description: "Open MCP panel",
          source: "builtin",
          builtin: true,
        },
      ],
    });
    expect(chatViewProvider.getBrowserSlashCommands).toHaveBeenCalled();

    const invalidSearch = await fetch(`${baseUrl}/api/search-files`, {
      headers: { Authorization: "Bearer test-token" },
    });
    expect(invalidSearch.status).toBe(400);

    const authorizedSearch = await fetch(
      `${baseUrl}/api/search-files?query=src`,
      {
        headers: { Authorization: "Bearer test-token" },
      },
    );
    expect(authorizedSearch.status).toBe(200);
    expect(await authorizedSearch.json()).toEqual({
      files: [{ path: "src/index.ts", kind: "file" }],
    });
    expect(chatViewProvider.searchBrowserFiles).toHaveBeenCalledWith("src");

    const authorizedModes = await fetch(`${baseUrl}/api/modes`, {
      headers: { Authorization: "Bearer test-token" },
    });
    expect(authorizedModes.status).toBe(200);
    expect(await authorizedModes.json()).toEqual({
      modes: [
        { slug: "code", name: "Code", icon: "code" },
        { slug: "architect", name: "Architect", icon: "symbol-structure" },
      ],
    });
    expect(chatViewProvider.getBrowserModes).toHaveBeenCalled();

    const authorizedModels = await fetch(`${baseUrl}/api/models`, {
      headers: { Authorization: "Bearer test-token" },
    });
    expect(authorizedModels.status).toBe(200);
    expect(await authorizedModels.json()).toEqual({
      models: [
        {
          id: "claude-sonnet-4-6",
          displayName: "Claude Sonnet 4.6",
          provider: "anthropic",
          contextWindow: 200000,
          authenticated: true,
          condenseThreshold: 0.8,
        },
      ],
    });
    expect(chatViewProvider.getBrowserModels).toHaveBeenCalled();

    const authorizedModelSwitch = await fetch(`${baseUrl}/api/model`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-token",
      },
      body: JSON.stringify({ model: "claude-opus-4-8" }),
    });
    expect(authorizedModelSwitch.status).toBe(200);
    const modelSwitchJson = await authorizedModelSwitch.json();
    expect(modelSwitchJson).toMatchObject({
      ok: true,
      snapshot: {
        session: {
          foreground: {
            model: "claude-opus-4-8",
          },
        },
      },
    });
    expect(chatViewProvider.submitBrowserSetModel).toHaveBeenCalledWith(
      "claude-opus-4-8",
    );

    const authorizedWriteApproval = await fetch(
      `${baseUrl}/api/write-approval`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer test-token",
        },
        body: JSON.stringify({ mode: "session" }),
      },
    );
    expect(authorizedWriteApproval.status).toBe(200);
    expect(await authorizedWriteApproval.json()).toEqual({ ok: true });
    expect(chatViewProvider.submitBrowserSetWriteApproval).toHaveBeenCalledWith(
      "session",
    );

    const authorizedThinking = await fetch(`${baseUrl}/api/thinking`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-token",
      },
      body: JSON.stringify({ enabled: false }),
    });
    expect(authorizedThinking.status).toBe(200);
    expect(await authorizedThinking.json()).toEqual({ ok: true });
    expect(
      chatViewProvider.submitBrowserSetThinkingEnabled,
    ).toHaveBeenCalledWith(false);

    const authorizedAttach = await fetch(`${baseUrl}/api/attach-file`, {
      method: "POST",
      headers: {
        Authorization: "Bearer test-token",
      },
    });
    expect(authorizedAttach.status).toBe(200);
    expect(await authorizedAttach.json()).toEqual({
      files: ["/tmp/from-picker.txt"],
    });
    expect(chatViewProvider.submitBrowserAttachFile).toHaveBeenCalled();

    const authorizedNewSession = await fetch(`${baseUrl}/api/session/new`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-token",
      },
      body: JSON.stringify({ mode: "code" }),
    });
    expect(authorizedNewSession.status).toBe(200);
    await expect(authorizedNewSession.json()).resolves.toMatchObject({
      ok: true,
      snapshot: {
        session: {
          foreground: {
            model: "gpt-5.3-codex",
          },
        },
      },
    });
    expect(chatViewProvider.submitBrowserNewSession).toHaveBeenCalledWith(
      "code",
    );

    const authorizedStop = await fetch(`${baseUrl}/api/stop`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-token",
      },
      body: JSON.stringify({ sessionId: "session-1" }),
    });
    expect(authorizedStop.status).toBe(200);
    expect(await authorizedStop.json()).toEqual({ ok: true });
    expect(chatViewProvider.submitBrowserStop).toHaveBeenCalledWith(
      "session-1",
    );

    const authorizedBgStop = await fetch(`${baseUrl}/api/background/stop`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-token",
      },
      body: JSON.stringify({ sessionId: "bg-1" }),
    });
    expect(authorizedBgStop.status).toBe(200);
    expect(await authorizedBgStop.json()).toEqual({ ok: true });
    expect(chatViewProvider.submitBrowserStopBackground).toHaveBeenCalledWith(
      "bg-1",
    );

    const authorizedBgTranscript = await fetch(
      `${baseUrl}/api/background/open-transcript`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer test-token",
        },
        body: JSON.stringify({ sessionId: "bg-1" }),
      },
    );
    expect(authorizedBgTranscript.status).toBe(200);
    await expect(authorizedBgTranscript.json()).resolves.toMatchObject({
      ok: true,
      transcript: {
        sessionId: "bg-1",
        task: "Background Agent",
      },
    });
    expect(chatViewProvider.getBrowserBgTranscript).toHaveBeenCalledWith(
      "bg-1",
    );

    await reader.cancel();
    await server.stop();
    service.dispose();
    hub.dispose();
  });
});
