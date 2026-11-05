import { afterEach, describe, expect, it, vi } from "vitest";
// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from "@testing-library/preact";

import { McpResourceWatchPanel } from "../../shared/ui/McpResourceUpdates";
import type { McpResourceWatchView } from "@agentlink/protocol/chat-transcript";
import { MessageBubble } from "./components/MessageBubble";
import { TranscriptMessageList } from "./components/TranscriptMessageList";
import { agentMessagesToChatMessages } from "../../shared/chatProjection";

vi.mock("./components/mermaidRenderer", () => ({
  renderMermaid: vi.fn(async () => "<svg />"),
}));
afterEach(cleanup);
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
    expect(container.textContent).not.toContain(text);
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(getByText(text)).toBeTruthy();
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
      expect(getByText(/1 update pending/)).toBeTruthy();
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
