/** @vitest-environment jsdom */

import { cleanup, render, screen } from "@testing-library/preact";
import { afterEach, describe, expect, it } from "vitest";

import type { ChatMessage } from "../types";
import { StreamingStatusBar } from "./StreamingStatusBar";

const assistantMessage = (blocks: ChatMessage["blocks"]): ChatMessage => ({
  id: "assistant-1",
  role: "assistant",
  content: "",
  timestamp: 1,
  blocks,
});

describe("StreamingStatusBar", () => {
  afterEach(cleanup);

  it("shows the Live Link with the projected literal activity", () => {
    const { container } = render(
      <StreamingStatusBar
        messages={[assistantMessage([{ type: "text", text: "Hello" }])]}
      />,
    );

    expect(screen.getByText("Responding…")).toBeTruthy();
    expect(
      container
        .querySelector(".live-link-indicator")
        ?.classList.contains("live-link-moving"),
    ).toBe(true);
  });

  it("uses the attention treatment for an explicit approval phase", () => {
    const { container } = render(
      <StreamingStatusBar
        messages={[]}
        runtimeStatus={{ phase: "awaiting_approval" }}
      />,
    );

    expect(screen.getByText("Approval needed")).toBeTruthy();
    expect(
      container
        .querySelector(".live-link-indicator")
        ?.classList.contains("live-link-attention"),
    ).toBe(true);
  });
});
