import { beforeEach, describe, expect, it, vi } from "vitest";

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
    getBgSessionInfos: vi.fn(() => []),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

const themeSnapshotStub = {
  cssVariables: {
    "--vscode-editor-background": "#1e1e1e",
  },
  colorScheme: "dark" as const,
  themeLabel: "Dark",
  source: "vscode-theme-api" as const,
};

describe("BrowserGatewayService", () => {
  it("tracks approval and question state from hub events", () => {
    const hub = new InMemoryAgentUiEventHub();
    const sessionManager = makeSessionManagerStub();
    const service = new BrowserGatewayService(
      hub,
      sessionManager as never,
      () => themeSnapshotStub,
      () => "prompt",
      () => true,
      () => "high",
      () => ({
        sessionId: "session-1",
        mode: "code",
        model: "claude-sonnet-4-6",
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
    const onDidChange = vi.fn();
    const subscription = service.onDidChange(onDidChange);

    hub.publishApproval({
      kind: "write",
      id: "approval-1",
      filePath: "src/file.ts",
      writeOperation: "modify",
    });

    expect(service.getUiState()).toMatchObject({
      approval: {
        kind: "write",
        id: "approval-1",
        filePath: "src/file.ts",
        writeOperation: "modify",
      },
      question: undefined,
    });
    expect(service.getSerializableSessionState()).toEqual({
      sessions: [
        expect.objectContaining({
          id: "session-1",
          title: "Test Session",
        }),
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
    });
    diffSnapshotHub.upsert({
      requestId: "approval-1",
      filePath: "src/file.ts",
      operation: "modify",
      originalContent: "before",
      proposedContent: "after",
      outsideWorkspace: false,
      createdAt: 1,
    });
    expect(service.getSerializableSnapshotState().diffs).toEqual([
      {
        requestId: "approval-1",
        filePath: "src/file.ts",
        operation: "modify",
        originalPreview: "before",
        proposedPreview: "after",
        outsideWorkspace: false,
        createdAt: 1,
      },
    ]);
    expect(onDidChange).toHaveBeenCalled();

    hub.publishQuestionRequest("question-1", "Need confirmation.", [
      {
        id: "q1",
        type: "yes_no",
        question: "Continue?",
      },
    ]);

    expect(service.getUiState()).toMatchObject({
      approval: {
        kind: "write",
        id: "approval-1",
      },
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
    });

    hub.publishApprovalIdle();

    expect(service.getUiState()).toMatchObject({
      approval: undefined,
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
    });

    service.dispose();
    hub.publishApproval({
      kind: "write",
      id: "approval-after-dispose",
      filePath: "src/ignored.ts",
      writeOperation: "modify",
    });
    expect(service.getUiState()).toEqual({
      approval: undefined,
      question: undefined,
      recentEvents: [],
    });
    subscription.dispose();
    diffSnapshotHub.remove("approval-1");
    hub.dispose();
  });

  it("seeds initial state from the hub snapshot, caps recent event history, and clears state on dispose", () => {
    const hub = new InMemoryAgentUiEventHub();
    const sessionManager = makeSessionManagerStub();
    hub.publishApproval({
      kind: "write",
      id: "approval-seeded",
      filePath: "src/seeded.ts",
      writeOperation: "create",
    });

    const service = new BrowserGatewayService(
      hub,
      sessionManager as never,
      () => themeSnapshotStub,
      () => "prompt",
      () => true,
      () => "high",
      () => ({
        sessionId: "session-1",
        mode: "code",
        model: "claude-sonnet-4-6",
        streaming: false,
        statusOverride: null,
        projectedMessages: [],
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
      2,
    );

    expect(service.getUiState()).toMatchObject({
      approval: {
        id: "approval-seeded",
        filePath: "src/seeded.ts",
        writeOperation: "create",
      },
    });

    hub.publishQuestionRequest("question-2", "Need input.", []);
    hub.publishApprovalIdle();

    expect(service.getUiState().recentEvents).toEqual([
      {
        type: "agentQuestionRequest",
        id: "question-2",
        context: "Need input.",
        questions: [],
      },
      { type: "idle" },
    ]);

    service.dispose();
    expect(service.getUiState()).toEqual({
      approval: undefined,
      question: undefined,
      recentEvents: [],
    });
    hub.dispose();
  });
});
