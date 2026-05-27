import {
  FanoutAgentUiPublisher,
  InMemoryAgentUiEventHub,
  WebviewAgentUiPublisher,
} from "./AgentUiPublisher.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
  };
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("WebviewAgentUiPublisher", () => {
  it("publishes approval, idle, and question messages with the expected shapes", () => {
    const publishMessage = vi.fn();
    const publisher = new WebviewAgentUiPublisher(publishMessage);

    publisher.publishApproval({
      kind: "write",
      id: "approval-1",
      filePath: "src/file.ts",
      writeOperation: "modify",
    });
    publisher.publishApprovalIdle();
    publisher.publishQuestionRequest("question-1", [
      {
        id: "q1",
        type: "multiple_choice",
        question: "Choose one",
        options: ["a", "b"],
        recommended: "a",
      },
    ]);

    expect(publishMessage.mock.calls).toEqual([
      [
        {
          type: "showApproval",
          request: {
            kind: "write",
            id: "approval-1",
            filePath: "src/file.ts",
            writeOperation: "modify",
          },
        },
      ],
      [{ type: "idle" }],
      [
        {
          type: "agentQuestionRequest",
          id: "question-1",
          questions: [
            {
              id: "q1",
              type: "multiple_choice",
              question: "Choose one",
              options: ["a", "b"],
              recommended: "a",
            },
          ],
        },
      ],
    ]);
  });

  it("includes backgroundTask attribution when set", () => {
    const publishMessage = vi.fn();
    const publisher = new WebviewAgentUiPublisher(publishMessage);

    publisher.publishQuestionRequest("question-bg", [], "review_pr");

    expect(publishMessage).toHaveBeenCalledWith({
      type: "agentQuestionRequest",
      id: "question-bg",
      questions: [],
      backgroundTask: "review_pr",
    });
  });
});

describe("InMemoryAgentUiEventHub", () => {
  it("publishes events to subscribers and keeps the last published snapshot", () => {
    const hub = new InMemoryAgentUiEventHub();
    const listener = vi.fn();
    const disposable = hub.onDidPublish(listener);

    hub.publishApproval({
      kind: "write",
      id: "approval-2",
      filePath: "src/other.ts",
      writeOperation: "create",
    });
    expect(listener).toHaveBeenLastCalledWith({
      type: "showApproval",
      request: {
        kind: "write",
        id: "approval-2",
        filePath: "src/other.ts",
        writeOperation: "create",
      },
    });
    expect(hub.getSnapshot()).toEqual({
      type: "showApproval",
      request: {
        kind: "write",
        id: "approval-2",
        filePath: "src/other.ts",
        writeOperation: "create",
      },
    });

    hub.publishApprovalIdle();
    expect(listener).toHaveBeenLastCalledWith({ type: "idle" });
    expect(hub.getSnapshot()).toEqual({ type: "idle" });

    hub.publishQuestionRequest("question-3", []);
    expect(listener).toHaveBeenLastCalledWith({
      type: "agentQuestionRequest",
      id: "question-3",
      questions: [],
    });
    expect(hub.getSnapshot()).toEqual({
      type: "agentQuestionRequest",
      id: "question-3",
      questions: [],
    });

    disposable.dispose();
    hub.dispose();
    expect(hub.getSnapshot()).toBeUndefined();
  });
});

describe("FanoutAgentUiPublisher", () => {
  it("forwards published events to all target publishers", () => {
    const left = {
      publishApproval: vi.fn(),
      publishApprovalIdle: vi.fn(),
      publishQuestionRequest: vi.fn(),
      publishQuestionCleared: vi.fn(),
      publishQuestionProgress: vi.fn(),
    };
    const right = {
      publishApproval: vi.fn(),
      publishApprovalIdle: vi.fn(),
      publishQuestionRequest: vi.fn(),
      publishQuestionCleared: vi.fn(),
      publishQuestionProgress: vi.fn(),
    };

    const publisher = new FanoutAgentUiPublisher([left, right]);

    publisher.publishApproval({
      kind: "write",
      id: "approval-3",
      filePath: "src/fanout.ts",
      writeOperation: "modify",
    });
    publisher.publishApprovalIdle();
    publisher.publishQuestionRequest("question-2", []);
    publisher.publishQuestionCleared("question-2");
    publisher.publishQuestionProgress({
      id: "question-3",
      step: 1,
      answers: { a: "b" },
      notes: { note: "hello" },
      origin: "test-origin",
    });

    for (const target of [left, right]) {
      expect(target.publishApproval).toHaveBeenCalledWith({
        kind: "write",
        id: "approval-3",
        filePath: "src/fanout.ts",
        writeOperation: "modify",
      });
      expect(target.publishApprovalIdle).toHaveBeenCalledOnce();
      expect(target.publishQuestionRequest).toHaveBeenCalledWith(
        "question-2",
        [],
        undefined,
      );
      expect(target.publishQuestionCleared).toHaveBeenCalledWith("question-2");
      expect(target.publishQuestionProgress).toHaveBeenCalledWith({
        id: "question-3",
        step: 1,
        answers: { a: "b" },
        notes: { note: "hello" },
        origin: "test-origin",
      });
    }
  });
});
