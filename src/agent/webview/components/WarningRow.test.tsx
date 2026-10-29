// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/preact";

import type { ChatMessage } from "@agentlink/protocol/chat-transcript";
import { WarningRow } from "./WarningRow";

afterEach(() => {
  cleanup();
});

function warningMessage(text: string): ChatMessage {
  return {
    id: "warn-1",
    role: "warning",
    content: "",
    timestamp: 0,
    blocks: [],
    warningMessage: text,
  };
}

describe("WarningRow", () => {
  it("presents overloaded retries as a provider-side issue that needs waiting", () => {
    render(
      <WarningRow
        messages={[
          warningMessage(
            "API error 529: Overloaded — retrying request in 2s (attempt 1/8)",
          ),
        ]}
      />,
    );

    expect(screen.getByText("Provider is overloaded")).toBeTruthy();
    expect(
      screen.getByText(/issues on their end.*up to its retry limit/i),
    ).toBeTruthy();
  });

  it("shows the Codex retry cause with countdown and attempt", () => {
    const message: ChatMessage = {
      ...warningMessage(
        "Codex is overloaded (503). Retry 2 of 11 in 1.1s over WebSocket.",
      ),
      warningRetry: {
        retryDelayMs: 1100,
        retryAt: Date.now() + 60_000,
        retryAttempt: 2,
        retryMaxAttempts: 11,
      },
    };
    render(<WarningRow messages={[message]} />);

    expect(screen.getByText("Provider is overloaded")).toBeTruthy();
    expect(screen.getByText(/Retrying in \d+s · Attempt 2 of 11/)).toBeTruthy();
  });

  it("marks recovered Codex overload retries as resolved", () => {
    const message: ChatMessage = {
      ...warningMessage(
        "Codex is overloaded (503). Retry 1 of 11 in 0.5s over WebSocket.",
      ),
      warningRetry: { retryAttempt: 1, retryMaxAttempts: 11 },
    };
    render(<WarningRow messages={[message]} resolved />);

    expect(screen.getByText("Provider recovered")).toBeTruthy();
    expect(screen.getByText("1 automatic retry")).toBeTruthy();
  });

  it.each([
    [
      "Codex rate limit reached (429). Retry 1 of 11 in 0.5s over WebSocket.",
      "Rate limit reached",
    ],
    [
      "Codex server error (500). Retry 1 of 11 in 0.5s over WebSocket.",
      "Provider server error",
    ],
    [
      "Codex response timed out. Retry 1 of 11 in 0.2s over WebSocket.",
      "Response timed out",
    ],
    [
      "Connection to Codex was interrupted. Retry 1 of 11 in 0.2s over HTTP.",
      "Connection interrupted",
    ],
    [
      "Codex response stream was interrupted. Retry 1 of 11 in 0.2s over WebSocket.",
      "Request interrupted",
    ],
  ])("titles %s", (text, title) => {
    render(<WarningRow messages={[warningMessage(text)]} />);
    expect(screen.getByText(title)).toBeTruthy();
  });

  it("keeps the generic hint for non-overloaded warnings", () => {
    render(
      <WarningRow
        messages={[
          warningMessage("fetch failed — retrying request in 2s (attempt 1/4)"),
        ]}
      />,
    );

    expect(screen.getByText("Connection interrupted")).toBeTruthy();
    expect(
      screen.getByText(/the agent is still running; no action is needed/i),
    ).toBeTruthy();
  });
});
