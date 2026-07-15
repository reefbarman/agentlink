/** @vitest-environment jsdom */

import { cleanup, render, screen } from "@testing-library/preact";
import { describe, expect, it } from "vitest";

import type { ChatMessage } from "../types";
import { StreamingBaselineRecorder } from "../../../shared/streamingBaselineMetrics";
import { TranscriptMessageList } from "./TranscriptMessageList";
import { h } from "preact";

function apiRequest(model: string): NonNullable<ChatMessage["apiRequest"]> {
  return {
    requestId: `request-${model}`,
    model,
    inputTokens: 100,
    outputTokens: 20,
    durationMs: 500,
    timeToFirstToken: 100,
  };
}

describe("TranscriptMessageList model change rendering", () => {
  it("shows a divider before the first response from a different model", () => {
    const messages: ChatMessage[] = [
      {
        id: "a1",
        role: "assistant",
        content: "",
        timestamp: 1,
        blocks: [{ type: "text", text: "First response" }],
        apiRequest: apiRequest("claude-sonnet-4-6"),
      },
      {
        id: "u1",
        role: "user",
        content: "Use another model",
        timestamp: 2,
        blocks: [],
      },
      {
        id: "a2",
        role: "assistant",
        content: "",
        timestamp: 3,
        blocks: [{ type: "text", text: "Second response" }],
        apiRequest: apiRequest("gpt-5.4"),
      },
    ];

    const { container } = render(
      h(TranscriptMessageList, { messages, streaming: false }),
    );

    const divider = container.querySelector(".model-change-divider");
    const secondResponse = screen.getByText("Second response");
    expect(divider).toBeTruthy();
    expect(divider?.textContent).toContain("Model changed to");
    expect(divider?.textContent).toContain("gpt-5.4");
    expect(divider?.getAttribute("aria-label")).toBe(
      "Model changed from claude-sonnet-4-6 to gpt-5.4",
    );
    expect(
      (divider?.compareDocumentPosition(secondResponse) ?? 0) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("does not show a divider for the initial model or repeated model usage", () => {
    const messages: ChatMessage[] = [
      {
        id: "a1",
        role: "assistant",
        content: "",
        timestamp: 1,
        blocks: [{ type: "text", text: "First response" }],
        apiRequest: apiRequest("gpt-5.4"),
      },
      {
        id: "a2",
        role: "assistant",
        content: "",
        timestamp: 2,
        blocks: [{ type: "text", text: "Second response" }],
        apiRequest: apiRequest("gpt-5.4"),
      },
    ];

    const { container } = render(
      h(TranscriptMessageList, { messages, streaming: false }),
    );

    expect(container.querySelector(".model-change-divider")).toBeNull();
  });

  it("renders one divider before a split response instead of each segment", () => {
    const messages: ChatMessage[] = [
      {
        id: "a1",
        role: "assistant",
        content: "",
        timestamp: 1,
        blocks: [{ type: "text", text: "First response" }],
        apiRequest: apiRequest("claude-sonnet-4-6"),
      },
      {
        id: "a2",
        role: "assistant",
        content: "",
        timestamp: 2,
        blocks: [
          { type: "text", text: "Checking" },
          {
            type: "bg_agent_result",
            sessionId: "bg-1",
            task: "Review",
            status: "completed",
            resultText: "Done",
          },
          { type: "text", text: "Finished" },
        ],
        apiRequest: apiRequest("gpt-5.4"),
      },
    ];

    const { container } = render(
      h(TranscriptMessageList, { messages, streaming: false }),
    );

    expect(container.querySelectorAll(".model-change-divider")).toHaveLength(1);
  });
});

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

describe("TranscriptMessageList background result rendering", () => {
  it("renders background agent results as top-level chat rows", () => {
    const messages: ChatMessage[] = [
      {
        id: "assistant-with-bg-result",
        role: "assistant",
        content: "",
        timestamp: 1,
        blocks: [
          { type: "text", text: "I am checking the foreground path." },
          {
            type: "tool_call",
            id: "tool-bg-result",
            name: "get_background_result",
            inputJson: JSON.stringify({ sessionId: "bg-1" }),
            result: "Looks good overall.",
            complete: true,
          },
          {
            type: "bg_agent_result",
            sessionId: "bg-1",
            task: "Review implementation",
            status: "completed",
            resultText: "Looks good overall.",
            summary: "No blocking issues found.",
          },
          { type: "text", text: "I will incorporate that result." },
        ],
      },
    ];

    const { container } = render(
      h(TranscriptMessageList, { messages, streaming: false }),
    );

    const rows = Array.from(container.querySelectorAll(".assistant-message"));
    expect(rows).toHaveLength(3);
    expect(rows[0].textContent).toContain("I am checking the foreground path.");
    expect(rows[1].textContent).toContain("Background Result");
    expect(rows[1].textContent).toContain("Review implementation");
    expect(rows[1].textContent).toContain("No blocking issues found.");
    expect(rows[1].textContent).toContain("Looks good overall.");
    expect(rows[2].textContent).toContain("I will incorporate that result.");
    expect(container.querySelector(".tool-group-block")).toBeNull();
  });

  it("keeps the streaming indicator on the foreground assistant row", () => {
    const messages: ChatMessage[] = [
      {
        id: "assistant-streaming-with-bg-result",
        role: "assistant",
        content: "",
        timestamp: 1,
        blocks: [
          { type: "text", text: "Foreground work is still in progress." },
          {
            type: "bg_agent_result",
            sessionId: "bg-2",
            task: "Check tests",
            status: "completed",
            resultText: "Tests look covered.",
          },
        ],
      },
    ];

    const { container } = render(
      h(TranscriptMessageList, { messages, streaming: true }),
    );

    const indicator = container.querySelector(".streaming-indicator");
    const activeRow = indicator?.closest(".assistant-message");
    const rows = Array.from(container.querySelectorAll(".assistant-message"));
    expect(indicator).toBeTruthy();
    expect(activeRow).toBe(rows[0]);
    expect(activeRow?.textContent).not.toContain("Background Result");
    expect(rows[1].textContent).toContain("Background Result");
  });
});

describe("TranscriptMessageList retry error rendering", () => {
  it("groups adjacent retries into one compact recovery notice", () => {
    const messages: ChatMessage[] = [1, 2, 3].map((attempt) => ({
      id: `warning-${attempt}`,
      role: "warning",
      content: "",
      timestamp: attempt,
      blocks: [],
      warningMessage: `Connection error EADDRNOTAVAIL — retrying request (attempt ${attempt}/4)`,
      warningRetry: {
        retryAttempt: attempt,
        retryMaxAttempts: 4,
      },
    }));

    const { container } = render(
      h(TranscriptMessageList, { messages, streaming: true }),
    );

    expect(container.querySelectorAll(".error-notice")).toHaveLength(1);
    expect(screen.getByText("Connection interrupted")).toBeTruthy();
    expect(
      screen.getByText(/retrying automatically · attempt 3 of 4/i),
    ).toBeTruthy();
    expect(screen.getByText("Technical details (3)")).toBeTruthy();
    expect(screen.getByText(/no action is needed/i)).toBeTruthy();
    cleanup();
  });

  it("keeps retry notices separate when transcript content occurs between them", () => {
    const warning = (id: string, timestamp: number): ChatMessage => ({
      id,
      role: "warning",
      content: "",
      timestamp,
      blocks: [],
      warningMessage: "Request timed out — retrying request",
    });
    const messages: ChatMessage[] = [
      warning("warning-1", 1),
      {
        id: "assistant-progress",
        role: "assistant",
        content: "",
        timestamp: 2,
        blocks: [{ type: "text", text: "Recovered and continued." }],
      },
      warning("warning-2", 3),
    ];

    const { container } = render(
      h(TranscriptMessageList, { messages, streaming: true }),
    );

    expect(container.querySelectorAll(".error-notice")).toHaveLength(2);
    expect(screen.getByText("Request resumed")).toBeTruthy();
    expect(screen.getByText("Response timed out")).toBeTruthy();
    cleanup();
  });
});

describe("TranscriptMessageList streaming baseline metrics", () => {
  it("distinguishes unchanged history from the active message", () => {
    const history: ChatMessage = {
      id: "history-1",
      role: "user",
      content: "Earlier prompt",
      timestamp: 1,
      blocks: [],
    };
    const active: ChatMessage = {
      id: "active-1",
      role: "assistant",
      content: "",
      timestamp: 2,
      blocks: [{ type: "text", text: "A" }],
    };
    const recorder = new StreamingBaselineRecorder();
    const { rerender } = render(
      h(TranscriptMessageList, {
        messages: [history, active],
        streaming: true,
        streamingMetrics: recorder,
        streamingMetricsSurface: "vscode-webview",
        streamingMetricsScope: "session-1",
      }),
    );
    recorder.reset();

    const nextActive: ChatMessage = {
      ...active,
      blocks: [{ type: "text", text: "AB" }],
    };
    rerender(
      h(TranscriptMessageList, {
        messages: [{ ...history }, nextActive],
        streaming: true,
        streamingMetrics: recorder,
        streamingMetricsSurface: "vscode-webview",
        streamingMetricsScope: "session-1",
      }),
    );

    expect(recorder.summarize("vscode-webview", "session-1")).toMatchObject({
      historyRenders: 1,
      unchangedHistoryRenders: 1,
      activeRenders: 1,
      historyCommits: 1,
      unchangedHistoryCommits: 1,
      activeCommits: 1,
    });
    cleanup();
  });

  it("measures long-transcript amplification through real Preact renders", () => {
    const history: ChatMessage[] = Array.from({ length: 199 }, (_, index) => ({
      id: `history-${index + 1}`,
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: index % 2 === 0 ? `Prompt ${index + 1}` : "",
      timestamp: index + 1,
      blocks:
        index % 2 === 0
          ? []
          : [{ type: "text" as const, text: `Response ${index + 1}` }],
    }));
    const active: ChatMessage = {
      id: "active-long",
      role: "assistant",
      content: "",
      timestamp: 200,
      blocks: [{ type: "text", text: "A" }],
    };
    const recorder = new StreamingBaselineRecorder();
    const { rerender } = render(
      h(TranscriptMessageList, {
        messages: [...history, active],
        streaming: true,
        streamingMetrics: recorder,
        streamingMetricsSurface: "browser-webview",
        streamingMetricsScope: "long-session",
      }),
    );
    recorder.reset();

    for (let update = 1; update <= 12; update += 1) {
      rerender(
        h(TranscriptMessageList, {
          messages: [
            ...history,
            {
              ...active,
              blocks: [{ type: "text", text: `A${update}` }],
            },
          ],
          streaming: true,
          streamingMetrics: recorder,
          streamingMetricsSurface: "browser-webview",
          streamingMetricsScope: "long-session",
        }),
      );
    }

    expect(recorder.summarize("browser-webview", "long-session")).toMatchObject(
      {
        historyRenders: 2_388,
        unchangedHistoryRenders: 2_388,
        activeRenders: 12,
        historyCommits: 2_388,
        unchangedHistoryCommits: 2_388,
        activeCommits: 12,
      },
    );
    cleanup();
  });

  it("classifies split background results outside the active row", () => {
    const recorder = new StreamingBaselineRecorder();
    const messages: ChatMessage[] = [
      {
        id: "assistant-streaming-with-bg-result",
        role: "assistant",
        content: "",
        timestamp: 1,
        blocks: [
          { type: "text", text: "Foreground work is still in progress." },
          {
            type: "bg_agent_result",
            sessionId: "bg-2",
            task: "Check tests",
            status: "completed",
            resultText: "Tests look covered.",
          },
        ],
      },
    ];

    render(
      h(TranscriptMessageList, {
        messages,
        streaming: true,
        streamingMetrics: recorder,
        streamingMetricsSurface: "browser-webview",
        streamingMetricsScope: "ask-agent",
      }),
    );

    expect(recorder.summarize("browser-webview", "ask-agent")).toMatchObject({
      historyRenders: 1,
      activeRenders: 1,
      historyCommits: 1,
      activeCommits: 1,
    });
    cleanup();
  });
});
