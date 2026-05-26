/** @vitest-environment jsdom */

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/preact";

import type { ChatMessage } from "../types";
import { TranscriptMessageList } from "./TranscriptMessageList";
import { h } from "preact";

describe("TranscriptMessageList final marker rendering", () => {
  it("renders final marker styling for historical and latest assistant messages", () => {
    const messages: ChatMessage[] = [
      {
        id: "a1",
        role: "assistant",
        content: "",
        timestamp: 1,
        blocks: [{ type: "text", text: "Earlier response." }],
        finalMarker: { status: "completed", source: "tool" },
      },
      {
        id: "u1",
        role: "user",
        content: "continue",
        timestamp: 2,
        blocks: [],
      },
      {
        id: "a2",
        role: "assistant",
        content: "",
        timestamp: 3,
        blocks: [{ type: "text", text: "Latest response." }],
        finalMarker: {
          status: "completed",
          source: "tool",
          summary: "Done now.",
        },
      },
    ];

    const { container } = render(
      h(TranscriptMessageList, { messages, streaming: false }),
    );

    expect(screen.getByText("Earlier response.")).toBeTruthy();
    expect(screen.getByText("Latest response.")).toBeTruthy();
    expect(screen.getAllByText("Task complete")).toHaveLength(2);
    expect(container.querySelectorAll(".assistant-final-region")).toHaveLength(
      2,
    );
    expect(container.querySelectorAll(".assistant-message-final")).toHaveLength(
      0,
    );
  });

  it("renders marker-only final messages without the empty response fallback", () => {
    const messages: ChatMessage[] = [
      {
        id: "a1",
        role: "assistant",
        content: "",
        timestamp: 1,
        blocks: [],
        finalMarker: {
          status: "completed",
          source: "tool",
          summary: "Completed with no text body.",
        },
      },
    ];

    const { container } = render(
      h(TranscriptMessageList, { messages, streaming: false }),
    );

    const finalRegion = container.querySelector(".assistant-final-region");
    expect(finalRegion).toBeTruthy();
    expect(finalRegion?.textContent).toContain("Task complete");
    expect(finalRegion?.textContent).toContain("Completed with no text body.");
    expect(screen.queryByText("(No response)")).toBeNull();
  });

  it("renders header-only final markers without action content", () => {
    const messages: ChatMessage[] = [
      {
        id: "a1",
        role: "assistant",
        content: "",
        timestamp: 1,
        blocks: [{ type: "text", text: "Finished." }],
        finalMarker: {
          status: "completed",
          source: "tool",
        },
      },
    ];

    const { container } = render(
      h(TranscriptMessageList, { messages, streaming: false }),
    );

    const finalRegion = container.querySelector(".assistant-final-region");
    expect(screen.getByText("Finished.")).toBeTruthy();
    expect(finalRegion).toBeTruthy();
    expect(finalRegion?.textContent).toContain("Task complete");
    expect(finalRegion?.querySelector(".final-marker-actions")).toBeNull();
  });

  it("scopes final marker styling to the bottom final marker region", () => {
    const messages: ChatMessage[] = [
      {
        id: "a1",
        role: "assistant",
        content: "",
        timestamp: 1,
        blocks: [
          { type: "text", text: "I will verify this first." },
          {
            type: "tool_call",
            id: "tool-verify",
            name: "execute_command",
            inputJson: JSON.stringify({ command: "npm test" }),
            result: JSON.stringify({ ok: true }),
            complete: true,
          },
        ],
        finalMarker: {
          status: "completed",
          source: "tool",
          summary: "Done — the final summary only should be highlighted.",
        },
      },
    ];

    const { container } = render(
      h(TranscriptMessageList, { messages, streaming: false }),
    );

    const finalRegion = container.querySelector(".assistant-final-region");
    expect(screen.getByText("I will verify this first.")).toBeTruthy();
    expect(finalRegion).toBeTruthy();
    expect(finalRegion?.textContent).toContain("Task complete");
    expect(finalRegion?.textContent).toContain(
      "Done — the final summary only should be highlighted.",
    );
    expect(finalRegion?.textContent).not.toContain("I will verify this first.");
    expect(finalRegion?.querySelector(".tool-call-block")).toBeNull();
  });
});
