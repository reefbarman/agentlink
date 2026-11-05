// @vitest-environment jsdom

import type {
  ChatMessage,
  McpResourceWatchView,
} from "@agentlink/protocol/chat-transcript";
import {
  McpResourcePendingIndicator,
  McpResourceWatchPanel,
  useMcpResourceWatchReveal,
} from "../../shared/ui/McpResourceUpdates";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  agentMessagesToChatMessages,
  initialState,
  reducer,
} from "../../shared/chatProjection";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/preact";

import { MessageBubble } from "./components/MessageBubble";
import { TranscriptMessageList } from "./components/TranscriptMessageList";

vi.mock("./components/mermaidRenderer", () => ({
  renderMermaid: vi.fn(async () => "<svg />"),
}));
afterEach(cleanup);

it("counts pending watches and preserves pending state when opening controls", () => {
  const onOpen = vi.fn();
  const watch: McpResourceWatchView = {
    server: "comms",
    uri: "comms://one",
    mode: "notify",
    paused: false,
    pending: true,
  };
  const watches = [
    watch,
    { ...watch, uri: "comms://two" },
    { ...watch, uri: "comms://three", pending: false },
  ];
  const { container, rerender } = render(
    <McpResourcePendingIndicator watches={watches} onOpen={onOpen} />,
  );
  const button = container.querySelector("button")!;
  expect(button.textContent).toContain("2 MCP updates available");
  fireEvent.click(button);
  expect(onOpen).toHaveBeenCalledOnce();
  expect(watches.filter((entry) => entry.pending)).toHaveLength(2);
  rerender(
    <McpResourcePendingIndicator watches={watches} onOpen={onOpen} disabled />,
  );
  fireEvent.click(button);
  expect(onOpen).toHaveBeenCalledOnce();
  rerender(<McpResourcePendingIndicator watches={[]} onOpen={onOpen} />);
  expect(container.querySelector("button")).toBeNull();
});
const update = {
  id: "one",
  server: "external",
  uri: "https://hostile.invalid/secret",
  receivedAt: 123,
};
const watch: McpResourceWatchView = {
  server: update.server,
  uri: update.uri,
  mode: "wake",
  paused: true,
  pending: true,
  reason: "Action required: sign in",
};

describe("shared MCP resource UI", () => {
  it("shows live activity after an external update before model output, without adding history or duplicate spinners", () => {
    const messages = agentMessagesToChatMessages([
      {
        role: "user",
        content: "External snapshot",
        uiHint: { mcpResourceUpdate: update },
      },
    ]);
    const { container, rerender } = render(
      <TranscriptMessageList messages={messages} streaming />,
    );
    expect(container.querySelectorAll(".streaming-indicator")).toHaveLength(1);
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("warning");
    const thinking = reducer(
      { ...initialState, messages, streaming: true },
      { type: "THINKING_START", thinkingId: "new-thinking" },
    );
    rerender(<TranscriptMessageList messages={thinking.messages} streaming />);
    expect(container.querySelectorAll(".streaming-indicator")).toHaveLength(1);
    rerender(<TranscriptMessageList messages={messages} streaming={false} />);
    expect(container.querySelector(".streaming-indicator")).toBeNull();
  });

  it("keeps the previous final answer settled while a new turn is preparing", () => {
    const previous: ChatMessage = {
      id: "old-final",
      role: "assistant",
      content: "",
      blocks: [],
      timestamp: 1,
      finalMarker: {
        status: "completed",
        source: "tool",
        summary: "Previous completed answer",
      },
    };
    const { container, getByText, rerender } = render(
      <TranscriptMessageList messages={[previous]} streaming />,
    );
    expect(getByText("Previous completed answer")).toBeTruthy();
    expect(container.querySelectorAll(".streaming-indicator")).toHaveLength(1);
    rerender(<TranscriptMessageList messages={[previous]} streaming={false} />);
    expect(container.querySelector(".streaming-indicator")).toBeNull();
    expect(getByText("Previous completed answer")).toBeTruthy();
  });

  it("reveals additions per chat, but not routine updates or returning to an unchanged watch list", () => {
    const onReveal = vi.fn();
    function Probe({
      sessionId,
      watches,
    }: {
      sessionId: string;
      watches: McpResourceWatchView[];
    }) {
      useMcpResourceWatchReveal(sessionId, watches, onReveal);
      return null;
    }
    const { rerender } = render(<Probe sessionId="a" watches={[]} />);
    rerender(<Probe sessionId="a" watches={[watch]} />);
    expect(onReveal).toHaveBeenCalledOnce();
    onReveal.mockClear();
    rerender(
      <Probe
        sessionId="a"
        watches={[{ ...watch, paused: false, pending: false }]}
      />,
    );
    expect(onReveal).not.toHaveBeenCalled();
    rerender(<Probe sessionId="b" watches={[watch]} />);
    rerender(<Probe sessionId="a" watches={[watch]} />);
    expect(onReveal).not.toHaveBeenCalled();
    rerender(<Probe sessionId="a" watches={[]} />);
    rerender(<Probe sessionId="a" watches={[watch]} />);
    expect(onReveal).toHaveBeenCalledOnce();
  });

  it("shows an expandable non-user card and never interprets content or URIs as links/images", () => {
    const text =
      '<img src="https://hostile.invalid/image"> ![fetch](https://hostile.invalid/image) [approve](javascript:alert(1))';
    const [message] = agentMessagesToChatMessages([
      {
        role: "user",
        content: "RAW INTERNAL ENVELOPE",
        uiHint: {
          mcpResourceUpdate: update,
          userMessage: { displayText: text },
        },
      },
    ]);
    const { getByRole, getByText, container } = render(
      <MessageBubble message={message} streaming={false} />,
    );
    const toggle = getByRole("button", { name: /MCP resource update/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.querySelector(".codicon-chevron-right")).toBeTruthy();
    expect(toggle.querySelector(".codicon-mail")).toBeTruthy();
    expect(container.textContent).not.toContain(text);
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(getByText(text)).toBeTruthy();
    expect(toggle.querySelector(".codicon-chevron-down")).toBeTruthy();
    expect(
      container.querySelector(".tool-call-details .tool-call-code"),
    ).toBeTruthy();
    expect(getByText(/Untrusted external content/)).toBeTruthy();
    expect(container.textContent).not.toContain("RAW INTERNAL ENVELOPE");
    expect(container.querySelector("a, img, .user-message")).toBeNull();
  });

  it("keeps resource cards separate from warnings in the shared transcript list", () => {
    const messages = agentMessagesToChatMessages([
      {
        role: "user",
        content: "Snapshot one",
        uiHint: { mcpResourceUpdate: update },
      },
      {
        role: "user",
        content: "Snapshot two",
        uiHint: { mcpResourceUpdate: { ...update, id: "two" } },
      },
    ]);
    const { getAllByRole, container } = render(
      <TranscriptMessageList messages={messages} streaming={false} />,
    );
    const cards = getAllByRole("button", { name: /MCP resource update/ });
    expect(cards).toHaveLength(2);
    fireEvent.click(cards[0]);
    expect(container.textContent).toContain("Snapshot one");
    expect(container.textContent).not.toContain("Snapshot two");
  });

  it.each([
    [false, "Pause", "pause"],
    [true, "Resume", "resume"],
    [true, "Stop watching", "unwatch"],
    [true, "Send once", "send-once"],
  ] as const)(
    "routes %s / %s to the exact resource",
    async (paused, label, action) => {
      const onAction = vi.fn(async () => undefined);
      const { getByRole, getByText } = render(
        <McpResourceWatchPanel
          watches={[{ ...watch, paused }]}
          onAction={onAction}
        />,
      );
      expect(getByText(/Deliver and wake/)).toBeTruthy();
      expect(getByText("Update pending")).toBeTruthy();
      expect(getByText(watch.reason!)).toBeTruthy();
      fireEvent.click(getByRole("button", { name: label }));
      await waitFor(() =>
        expect(onAction).toHaveBeenCalledWith({
          server: watch.server,
          uri: watch.uri,
          action,
        }),
      );
    },
  );

  it("hides and reopens controls without changing a watch's permission", () => {
    const onAction = vi.fn();
    const onClose = vi.fn();
    const { getByRole, queryByRole, rerender } = render(
      <McpResourceWatchPanel
        watches={[watch]}
        onAction={onAction}
        onClose={onClose}
        open
      />,
    );
    fireEvent.click(getByRole("button", { name: "Hide resource watches" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onAction).not.toHaveBeenCalled();
    rerender(
      <McpResourceWatchPanel
        watches={[watch]}
        onAction={onAction}
        onClose={onClose}
        open={false}
      />,
    );
    expect(queryByRole("region", { name: "MCP resource watches" })).toBeNull();
    rerender(
      <McpResourceWatchPanel
        watches={[watch]}
        onAction={onAction}
        onClose={onClose}
        open
      />,
    );
    expect(getByRole("button", { name: "Stop watching" })).toBeTruthy();
    expect(onAction).not.toHaveBeenCalled();
  });

  it("reports failed actions without claiming the watch changed", async () => {
    const { getByRole, getByText } = render(
      <McpResourceWatchPanel
        watches={[watch]}
        onAction={async () => {
          throw new Error("Approval denied");
        }}
      />,
    );
    fireEvent.click(getByRole("button", { name: "Resume" }));
    await waitFor(() =>
      expect(getByRole("alert").textContent).toBe("Approval denied"),
    );
    expect(getByText(/Paused/)).toBeTruthy();
  });
});
