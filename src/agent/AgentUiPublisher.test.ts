import {
  FanoutAgentUiPublisher,
  InMemoryAgentUiEventHub,
  WebviewAgentUiPublisher,
  type AgentUiPublisher,
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
      for (const listener of this.listeners) listener(value);
    }

    dispose(): void {
      this.listeners.clear();
    }
  }

  return { EventEmitter: MockEventEmitter };
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("WebviewAgentUiPublisher", () => {
  it("session-addresses question messages without changing approval shapes", () => {
    const publishMessage = vi.fn();
    const publisher = new WebviewAgentUiPublisher(publishMessage);

    publisher.publishApproval("session-1", {
      kind: "write",
      id: "approval-1",
      filePath: "src/file.ts",
      writeOperation: "modify",
    });
    publisher.publishApprovalIdle("session-1", "approval-1");
    publisher.publishQuestionRequest(
      "session-1",
      "question-1",
      "Pick the best option.",
      [
        {
          id: "q1",
          type: "multiple_choice",
          question: "Choose one",
          options: ["a", "b"],
          recommended: "a",
        },
      ],
    );
    publisher.publishQuestionProgress("session-1", {
      id: "question-1",
      step: 1,
      answers: { q1: "a" },
      notes: {},
      origin: "browser",
    });
    publisher.publishQuestionCleared("session-1", "question-1");

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
          sessionId: "session-1",
          id: "question-1",
          context: "Pick the best option.",
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
      [
        {
          type: "agentQuestionProgress",
          sessionId: "session-1",
          id: "question-1",
          step: 1,
          answers: { q1: "a" },
          notes: {},
          origin: "browser",
        },
      ],
      [
        {
          type: "agentQuestionCleared",
          sessionId: "session-1",
          id: "question-1",
        },
      ],
    ]);
  });

  it("does not let a mismatched approval clear hide the visible card", () => {
    const publishMessage = vi.fn();
    const publisher = new WebviewAgentUiPublisher(publishMessage);

    publisher.publishApproval("session-2", {
      kind: "write",
      id: "approval-2",
      filePath: "src/other.ts",
      writeOperation: "modify",
    });
    publisher.publishApprovalIdle("session-1", "approval-1");

    expect(publishMessage).toHaveBeenCalledTimes(1);
    expect(publishMessage).not.toHaveBeenCalledWith({ type: "idle" });
  });

  it("keeps background fallback questions globally visible", () => {
    const publishMessage = vi.fn();
    const publisher = new WebviewAgentUiPublisher(publishMessage);

    publisher.publishQuestionRequest(
      "session-bg",
      "question-bg",
      "Review needs input.",
      [],
      "review_pr",
    );
    publisher.publishQuestionProgress("session-bg", {
      id: "question-bg",
      step: 1,
      answers: {},
      notes: {},
      origin: "browser",
    });
    publisher.publishQuestionCleared("session-bg", "question-bg");

    expect(publishMessage.mock.calls).toEqual([
      [
        {
          type: "agentQuestionRequest",
          id: "question-bg",
          context: "Review needs input.",
          questions: [],
          backgroundTask: "review_pr",
        },
      ],
      [
        {
          type: "agentQuestionProgress",
          id: "question-bg",
          step: 1,
          answers: {},
          notes: {},
          origin: "browser",
        },
      ],
      [{ type: "agentQuestionCleared", id: "question-bg" }],
    ]);
  });
});

describe("InMemoryAgentUiEventHub", () => {
  it("publishes session envelopes and keeps all pending entries per session", () => {
    const hub = new InMemoryAgentUiEventHub();
    const listener = vi.fn();
    const disposable = hub.onDidPublish(listener);

    hub.publishApproval("session-1", {
      kind: "write",
      id: "approval-1",
      filePath: "src/other.ts",
      writeOperation: "create",
    });
    hub.publishQuestionRequest("session-1", "question-1", "Need input.", []);
    hub.publishQuestionProgress("session-1", {
      id: "question-1",
      step: 1,
      answers: { continue: true },
      notes: {},
      origin: "test",
    });

    expect(listener).toHaveBeenLastCalledWith({
      sessionId: "session-1",
      event: {
        type: "agentQuestionProgress",
        id: "question-1",
        step: 1,
        answers: { continue: true },
        notes: {},
        origin: "test",
      },
    });
    expect(hub.getSnapshot("session-1")).toEqual([
      {
        sessionId: "session-1",
        event: {
          type: "showApproval",
          request: {
            kind: "write",
            id: "approval-1",
            filePath: "src/other.ts",
            writeOperation: "create",
          },
        },
      },
      {
        sessionId: "session-1",
        event: {
          type: "agentQuestionRequest",
          id: "question-1",
          context: "Need input.",
          questions: [],
        },
      },
      {
        sessionId: "session-1",
        event: {
          type: "agentQuestionProgress",
          id: "question-1",
          step: 1,
          answers: { continue: true },
          notes: {},
          origin: "test",
        },
      },
    ]);

    disposable.dispose();
    hub.dispose();
    expect(hub.getSnapshot("session-1")).toEqual([]);
  });

  it("cannot clear another session or a different request", () => {
    const hub = new InMemoryAgentUiEventHub();
    hub.publishQuestionRequest("session-1", "question-1", "First", []);
    hub.publishQuestionRequest("session-2", "question-2", "Second", []);

    hub.publishQuestionCleared("session-2", "question-1");
    hub.publishQuestionCleared("session-1", "question-unknown");

    expect(hub.getSnapshot("session-1")).toHaveLength(1);
    expect(hub.getSnapshot("session-2")).toHaveLength(1);

    hub.publishQuestionCleared("session-1", "question-1");
    expect(hub.getSnapshot("session-1")).toEqual([]);
    expect(hub.getSnapshot("session-2")).toHaveLength(1);
  });

  it("isolates snapshots while preserving undefined question answers", () => {
    const hub = new InMemoryAgentUiEventHub();
    hub.publishQuestionRequest("session-1", "question-1", "Continue?", []);
    hub.publishQuestionProgress("session-1", {
      id: "question-1",
      step: 1,
      answers: { choice: undefined },
      notes: {},
      origin: "test",
    });

    const firstSnapshot = hub.getSnapshot("session-1");
    const progress = firstSnapshot[1]?.event;
    expect(progress).toMatchObject({
      type: "agentQuestionProgress",
      answers: { choice: undefined },
    });
    expect(
      progress?.type === "agentQuestionProgress" &&
        Object.hasOwn(progress.answers, "choice"),
    ).toBe(true);

    if (progress?.type === "agentQuestionProgress") {
      progress.answers.choice = "mutated";
    }
    expect(hub.getSnapshot("session-1")[1]?.event).toMatchObject({
      type: "agentQuestionProgress",
      answers: { choice: undefined },
    });
  });

  it("does not retain progress for an unknown or cleared question", () => {
    const hub = new InMemoryAgentUiEventHub();
    const progress = {
      id: "question-1",
      step: 1,
      answers: {},
      notes: {},
      origin: "test",
    };

    hub.publishQuestionProgress("session-1", progress);
    expect(hub.getSnapshot("session-1")).toEqual([]);

    hub.publishQuestionRequest("session-1", "question-1", "Continue?", []);
    hub.publishQuestionProgress("session-1", progress);
    hub.publishQuestionCleared("session-1", "question-1");
    expect(hub.getSnapshot("session-1")).toEqual([]);
  });
});

describe("FanoutAgentUiPublisher", () => {
  it("forwards complete session-addressed argument tuples to every target", () => {
    const makeTarget = (): AgentUiPublisher => ({
      publishApproval: vi.fn(),
      publishApprovalIdle: vi.fn(),
      publishQuestionRequest: vi.fn(),
      publishQuestionCleared: vi.fn(),
      publishQuestionProgress: vi.fn(),
      publishFormElicitationRequest: vi.fn(),
      publishFormElicitationCleared: vi.fn(),
      publishUrlElicitationRequest: vi.fn(),
      publishUrlElicitationCleared: vi.fn(),
    });
    const left = makeTarget();
    const right = makeTarget();
    const publisher = new FanoutAgentUiPublisher([left, right]);

    const approval = {
      kind: "write" as const,
      id: "approval-3",
      filePath: "src/fanout.ts",
      writeOperation: "modify" as const,
    };
    publisher.publishApproval("session-3", approval);
    publisher.publishApprovalIdle("session-3", "approval-3");
    publisher.publishQuestionRequest(
      "session-3",
      "question-2",
      "Fanout needs input.",
      [],
    );
    publisher.publishQuestionCleared("session-3", "question-2");

    for (const target of [left, right]) {
      expect(target.publishApproval).toHaveBeenCalledWith(
        "session-3",
        approval,
      );
      expect(target.publishApprovalIdle).toHaveBeenCalledWith(
        "session-3",
        "approval-3",
      );
      expect(target.publishQuestionRequest).toHaveBeenCalledWith(
        "session-3",
        "question-2",
        "Fanout needs input.",
        [],
        undefined,
      );
      expect(target.publishQuestionCleared).toHaveBeenCalledWith(
        "session-3",
        "question-2",
      );
    }
  });
});
