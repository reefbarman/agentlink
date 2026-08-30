/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/preact";

import { BgAgentBlock } from "./BgAgentBlock";
import { BgAgentResultBlock } from "./BgAgentResultBlock";
import type { ChatMessage } from "@agentlink/protocol/chat-transcript";
import { ChatView } from "./ChatView";
import { TranscriptView } from "./TranscriptView";
import { h } from "preact";

const resizeObserverInstances: Array<{ observe: ReturnType<typeof vi.fn> }> =
  [];

function makeMessages(count: number): ChatMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `message-${index + 1}`,
    role: "user" as const,
    content: `Message ${index + 1}`,
    timestamp: index + 1,
    blocks: [],
  }));
}

describe("ChatView message windowing", () => {
  beforeEach(() => {
    globalThis.requestAnimationFrame = vi.fn(
      (callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      },
    );
    globalThis.cancelAnimationFrame = vi.fn();
    resizeObserverInstances.length = 0;
    globalThis.ResizeObserver = class {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();

      constructor() {
        resizeObserverInstances.push(this);
      }
    } as unknown as typeof ResizeObserver;
  });

  afterEach(() => cleanup());

  it("mounts the newest batch first and reveals earlier messages in batches", () => {
    const { container } = render(
      h(ChatView, {
        messages: makeMessages(45),
        streaming: false,
        sessionId: "session-1",
        initialMessageLimit: 20,
      }),
    );

    const transcript = within(container.querySelector(".chat-message-list")!);
    expect(transcript.queryByText("Message 25")).toBeNull();
    expect(transcript.getByText("Message 26")).toBeTruthy();
    expect(transcript.getByText("Message 45")).toBeTruthy();
    expect(screen.getByText("25 hidden")).toBeTruthy();
    expect(screen.queryByTitle("Message 1")).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: /Show 20 earlier messages/ }),
    );

    expect(transcript.queryByText("Message 5")).toBeNull();
    expect(transcript.getByText("Message 6")).toBeTruthy();
    expect(screen.getByText("5 hidden")).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: /Show 5 earlier messages/ }),
    );

    expect(transcript.getByText("Message 1")).toBeTruthy();
    expect(transcript.queryByText(/hidden/)).toBeNull();
    expect(screen.getByTitle("Message 1")).toBeTruthy();
  });

  it("keeps the prompt preview on the original prompt when only a tail is loaded", () => {
    const { rerender } = render(
      h(ChatView, {
        messages: makeMessages(2).map((message, index) => ({
          ...message,
          content: `Recent prompt ${index + 1}`,
        })),
        streaming: false,
        sessionId: "session-1",
        originalPrompt: "The actual original prompt",
        earlierUserTurnCount: 6,
      }),
    );

    expect(screen.getByTitle("The actual original prompt")).toBeTruthy();
    expect(screen.queryByTitle("Recent prompt 1")).toBeNull();

    rerender(
      h(ChatView, {
        messages: makeMessages(4).map((message, index) => ({
          ...message,
          content: `Earlier loaded prompt ${index + 1}`,
        })),
        streaming: false,
        sessionId: "session-1",
        originalPrompt: "The actual original prompt",
        earlierUserTurnCount: 4,
      }),
    );

    expect(screen.getByTitle("The actual original prompt")).toBeTruthy();
    expect(screen.queryByTitle("Earlier loaded prompt 1")).toBeNull();
  });

  it("uses the foreground chat surface for background transcripts with todos", () => {
    const { container } = render(
      h(TranscriptView, {
        task: "Review implementation",
        sessionId: "background-1",
        messages: makeMessages(1),
        streaming: true,
        runtimeStatus: { phase: "waiting_for_provider" },
        todos: [
          {
            id: "review",
            content: "Review implementation",
            activeForm: "Reviewing implementation",
            status: "in_progress",
          },
        ],
        onClose: vi.fn(),
      }),
    );

    expect(
      container.querySelector(".transcript-messages > .chat-messages"),
    ).toBeTruthy();
    expect(screen.getByText("Tasks 0/1")).toBeTruthy();
    expect(screen.getAllByText("Reviewing implementation")).toHaveLength(2);
    expect(screen.getByText("Waiting for provider…")).toBeTruthy();
  });

  it("shows the resolved provider, model, and thinking level in background agent metadata", () => {
    const { container } = render(
      h(BgAgentBlock, {
        sessionId: "background-1",
        task: "Review implementation",
        resolvedProvider: "anthropic",
        resolvedModel: "claude-sonnet-4-6",
        reasoningEffort: "high",
      }),
    );

    expect(screen.getByText("anthropic/claude-sonnet-4-6 · high")).toBeTruthy();
    fireEvent.click(container.querySelector(".tool-call-header")!);
    expect(screen.getByText("Thinking level")).toBeTruthy();
    expect(screen.getByText("high")).toBeTruthy();
  });

  it("shows the resolved provider, model, and thinking level in background transcript and result headers", () => {
    const { unmount } = render(
      h(TranscriptView, {
        task: "Review implementation",
        sessionId: "background-1",
        messages: makeMessages(1),
        runtimeStatus: {
          phase: "responding",
          resolvedProvider: "anthropic",
          resolvedModel: "claude-sonnet-4-6",
          reasoningEffort: "high",
        },
        onClose: vi.fn(),
      }),
    );

    expect(
      screen.getByText(
        "Review implementation — anthropic / claude-sonnet-4-6 · high",
      ),
    ).toBeTruthy();
    unmount();

    render(
      h(BgAgentResultBlock, {
        sessionId: "background-1",
        task: "Review implementation",
        status: "completed",
        resultText: "No issues found.",
        resolvedProvider: "anthropic",
        resolvedModel: "claude-sonnet-4-6",
        reasoningEffort: "high",
      }),
    );

    expect(
      screen.getByText("anthropic / claude-sonnet-4-6 · high"),
    ).toBeTruthy();
  });

  it("renders explicit background terminal result families and preserved output", () => {
    const { container, rerender } = render(
      h(BgAgentResultBlock, {
        sessionId: "background-incomplete",
        task: "Review implementation",
        status: "error",
        resultState: "incomplete_expected_result",
        terminalReason: "incomplete_expected_result",
        partialOutput: "Recovered partial findings.",
        resultText: '{"status":"incomplete_expected_result"}',
      }),
    );

    expect(container.querySelector(".bg-agent-result-warning")).toBeTruthy();
    expect(screen.getByText("Incomplete Result")).toBeTruthy();
    expect(container.textContent).toContain("expected result format");
    expect(container.textContent).toContain("Recovered partial findings.");
    expect(container.textContent).not.toContain('{"status"');

    rerender(
      h(BgAgentResultBlock, {
        sessionId: "background-unauthorized",
        task: "Review implementation",
        status: "error",
        resultState: "authorization_lost",
        terminalReason: "outside_caller_subtree",
      }),
    );
    expect(container.querySelector(".bg-agent-result-error")).toBeTruthy();
    expect(screen.getByText("Background Failed")).toBeTruthy();
    expect(container.textContent).toContain("authorization lost");
    expect(container.textContent).toContain("no longer authorized");
  });

  it("cancels pending bottom scrolling before revealing earlier history", () => {
    const callbacks = new Map<number, FrameRequestCallback>();
    let nextId = 0;
    globalThis.requestAnimationFrame = vi.fn(
      (callback: FrameRequestCallback) => {
        nextId += 1;
        callbacks.set(nextId, callback);
        return nextId;
      },
    );
    globalThis.cancelAnimationFrame = vi.fn((id: number) => {
      callbacks.delete(id);
    });

    const { container } = render(
      h(ChatView, {
        messages: makeMessages(45),
        streaming: false,
        sessionId: "session-1",
        initialMessageLimit: 20,
      }),
    );
    const transcript = container.querySelector(".chat-messages")!;
    let scrollHeightReads = 0;
    Object.defineProperties(transcript, {
      scrollHeight: {
        configurable: true,
        get: () => (scrollHeightReads++ === 0 ? 1000 : 1400),
      },
      scrollTop: { configurable: true, writable: true, value: 200 },
    });
    const pendingId = nextId;
    const staleCallback = callbacks.get(pendingId)!;

    fireEvent.click(
      screen.getByRole("button", { name: /Show 20 earlier messages/ }),
    );

    expect(cancelAnimationFrame).toHaveBeenCalledWith(pendingId);
    expect(transcript.scrollTop).toBe(600);
    staleCallback(0);
    expect(transcript.scrollTop).toBe(600);
  });

  it("renders supplied setup content for an empty foreground chat", () => {
    render(
      h(ChatView, {
        messages: [],
        streaming: false,
        sessionId: null,
        emptyState: <div>Set up AgentLink</div>,
      }),
    );

    expect(screen.getByText("Set up AgentLink")).toBeTruthy();
    expect(screen.queryByText("Ask anything to get started")).toBeNull();
  });

  it("keeps the generic empty state for transcript callers", () => {
    render(
      h(ChatView, {
        messages: [],
        streaming: false,
        sessionId: null,
      }),
    );

    expect(screen.getByText("Ask anything to get started")).toBeTruthy();
  });

  it("observes transcript growth when an initially empty chat receives messages", () => {
    const { rerender } = render(
      h(ChatView, {
        messages: [],
        streaming: false,
        sessionId: "session-1",
      }),
    );
    expect(resizeObserverInstances).toHaveLength(0);

    rerender(
      h(ChatView, {
        messages: makeMessages(1),
        streaming: false,
        sessionId: "session-1",
      }),
    );

    expect(resizeObserverInstances).toHaveLength(1);
    expect(resizeObserverInstances[0]?.observe).toHaveBeenCalledTimes(1);
  });

  it("restores the complete transcript when the responsive limit is removed", () => {
    const { container, rerender } = render(
      h(ChatView, {
        messages: makeMessages(45),
        streaming: false,
        sessionId: "session-1",
        initialMessageLimit: 20,
      }),
    );
    const transcript = within(container.querySelector(".chat-message-list")!);
    expect(transcript.queryByText("Message 1")).toBeNull();

    rerender(
      h(ChatView, {
        messages: makeMessages(45),
        streaming: false,
        sessionId: "session-1",
      }),
    );

    expect(transcript.getByText("Message 1")).toBeTruthy();
    expect(screen.queryByText(/hidden/)).toBeNull();
  });

  it("renders the complete transcript when no limit is configured", () => {
    const { container } = render(
      h(ChatView, {
        messages: makeMessages(45),
        streaming: false,
        sessionId: "session-1",
      }),
    );

    const transcript = within(container.querySelector(".chat-message-list")!);
    expect(transcript.getByText("Message 1")).toBeTruthy();
    expect(transcript.getByText("Message 45")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /earlier messages/ }),
    ).toBeNull();
  });
});
