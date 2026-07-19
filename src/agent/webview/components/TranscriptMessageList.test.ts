/** @vitest-environment jsdom */

import type { ChatMessage, ReasoningEffort } from "../types";
import { cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";

import { StreamingBaselineRecorder } from "../../../shared/streamingBaselineMetrics";
import { TranscriptMessageList } from "./TranscriptMessageList";
import { h } from "preact";

function apiRequest(
  model: string,
  reasoningEffort?: ReasoningEffort,
): NonNullable<ChatMessage["apiRequest"]> {
  return {
    requestId: `request-${model}`,
    model,
    reasoningEffort,
    inputTokens: 100,
    outputTokens: 20,
    durationMs: 500,
    timeToFirstToken: 100,
  };
}

describe("TranscriptMessageList native web tool rendering", () => {
  it("renders web_fetch as a normal expandable tool call with full input and result", () => {
    cleanup();
    const result = {
      backend: "provider",
      provider: "openai-codex",
      operation: "fetch",
      input: { url: "https://docs.example.com/guide", section: "Usage" },
      activities: [
        {
          id: "fetch-provider-1",
          kind: "fetch",
          status: "completed",
          backend: "provider",
          url: "https://docs.example.com/guide",
        },
      ],
      content: "Example guide content",
      citations: [
        {
          url: "https://docs.example.com/guide",
          title: "Example guide",
        },
      ],
    };
    const messages: ChatMessage[] = [
      {
        id: "a-web",
        role: "assistant",
        content: "",
        timestamp: 1,
        blocks: [
          {
            type: "tool_call",
            id: "fetch-1",
            name: "web_fetch",
            inputJson: JSON.stringify({
              url: "https://docs.example.com/guide",
              section: "Usage",
            }),
            result: JSON.stringify(result, null, 2),
            complete: true,
          },
        ],
      },
    ];

    const { container } = render(
      h(TranscriptMessageList, { messages, streaming: false }),
    );

    expect(container.querySelectorAll(".tool-group-block")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: /Tools/ }));
    const toolName = screen.getByText("web_fetch");
    expect(toolName).toBeTruthy();
    expect(screen.getByText("https://docs.example.com/guide")).toBeTruthy();
    fireEvent.click(toolName.closest("button")!);
    expect(screen.getByText("Input")).toBeTruthy();
    expect(screen.getByText("Result")).toBeTruthy();
    const details =
      container.querySelector(".tool-call-details")?.textContent ?? "";
    expect(details).toContain("section");
    expect(details).toContain("Usage");
    expect(details).toContain("Example guide content");
    expect(details).toContain("https://docs.example.com/guide");
    cleanup();
  });

  it("renders a failed web_fetch using the normal tool error state", () => {
    cleanup();
    const messages: ChatMessage[] = [
      {
        id: "a-web-failed",
        role: "assistant",
        content: "The fetch failed.",
        timestamp: 1,
        blocks: [
          {
            type: "tool_call",
            id: "fetch-failed",
            name: "web_fetch",
            inputJson: JSON.stringify({
              url: "https://docs.example.com/private",
            }),
            result: JSON.stringify({
              error: "Provider fetch limit exceeded",
              citations: [
                {
                  url: "https://first.example/source",
                  title: "First source",
                },
                {
                  url: "https://second.example/source",
                  title: "Second source",
                },
              ],
            }),
            complete: true,
          },
        ],
      },
    ];

    const { container } = render(
      h(TranscriptMessageList, { messages, streaming: false }),
    );

    expect(container.querySelector(".tool-call-block.tool-error")).toBeTruthy();
    fireEvent.click(screen.getByText("web_fetch").closest("button")!);
    const details =
      container.querySelector(".tool-call-details")?.textContent ?? "";
    expect(details).toContain("Provider fetch limit exceeded");
    expect(details).toContain("https://first.example/source");
    expect(details).toContain("https://second.example/source");
    cleanup();
  });
});

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
        apiRequest: apiRequest("gpt-5.4", "high"),
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
        apiRequest: apiRequest("gpt-5.4", "high"),
      },
      {
        id: "a2",
        role: "assistant",
        content: "",
        timestamp: 2,
        blocks: [{ type: "text", text: "Second response" }],
        apiRequest: apiRequest("gpt-5.4", "high"),
      },
    ];

    const { container } = render(
      h(TranscriptMessageList, { messages, streaming: false }),
    );

    expect(container.querySelector(".model-change-divider")).toBeNull();
  });

  it("shows the same divider when the thinking level changes", () => {
    const messages: ChatMessage[] = [
      {
        id: "a1",
        role: "assistant",
        content: "",
        timestamp: 1,
        blocks: [{ type: "text", text: "First response" }],
        apiRequest: apiRequest("gpt-5.4", "high"),
      },
      {
        id: "u1",
        role: "user",
        content: "Use less thinking",
        timestamp: 2,
        blocks: [],
      },
      {
        id: "a2",
        role: "assistant",
        content: "",
        timestamp: 3,
        blocks: [{ type: "text", text: "Second response" }],
        apiRequest: apiRequest("gpt-5.4", "low"),
      },
    ];

    const { container } = render(
      h(TranscriptMessageList, { messages, streaming: false }),
    );

    const divider = container.querySelector(".model-change-divider");
    expect(divider?.textContent).toContain("Thinking level changed to");
    expect(divider?.textContent).toContain("Low");
    expect(divider?.textContent).not.toContain("Model changed to");
    expect(divider?.getAttribute("aria-label")).toBe(
      "Thinking level changed from High to Low",
    );
  });

  it("combines model and thinking changes into one divider", () => {
    const messages: ChatMessage[] = [
      {
        id: "a1",
        role: "assistant",
        content: "",
        timestamp: 1,
        blocks: [{ type: "text", text: "First response" }],
        apiRequest: apiRequest("claude-sonnet-4-6", "high"),
      },
      {
        id: "a2",
        role: "assistant",
        content: "",
        timestamp: 2,
        blocks: [{ type: "text", text: "Second response" }],
        apiRequest: apiRequest("gpt-5.4", "medium"),
      },
    ];

    const { container } = render(
      h(TranscriptMessageList, { messages, streaming: false }),
    );

    const dividers = container.querySelectorAll(".model-change-divider");
    expect(dividers).toHaveLength(1);
    expect(dividers[0]?.textContent).toContain("Model changed to");
    expect(dividers[0]?.textContent).toContain("Thinking level changed to");
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

  it("renders a set_task_status summary as the result when no prose is available", () => {
    const messages: ChatMessage[] = [
      {
        id: "assistant-with-summary-only-bg-result",
        role: "assistant",
        content: "",
        timestamp: 1,
        blocks: [
          {
            type: "bg_agent_result",
            sessionId: "bg-summary-only",
            task: "Audit project parity",
            status: "completed",
            summary: "The audit found no parity gaps.",
          },
        ],
      },
    ];

    const { container } = render(
      h(TranscriptMessageList, { messages, streaming: false }),
    );

    const result = container.querySelector(".bg-agent-result-block");
    expect(result?.textContent).toContain("The audit found no parity gaps.");
    expect(result?.textContent).not.toContain("No output available.");
    expect(result?.querySelector(".bg-result-preview")).toBeNull();
    expect(result?.querySelector(".bg-result-content")?.textContent).toContain(
      "The audit found no parity gaps.",
    );
  });
});

describe("TranscriptMessageList retry error rendering", () => {
  it("renders condense failures through the bounded standard error notice", () => {
    const requestId = "req_" + "a".repeat(240);
    const messages: ChatMessage[] = [
      {
        id: "condense-error",
        role: "condense",
        content: "",
        timestamp: 1,
        blocks: [],
        condenseInfo: {
          prevInputTokens: 0,
          newInputTokens: 0,
          errorMessage: `Condensing API call failed: 529 {"type":"error","request_id":"${requestId}"}`,
        },
      },
    ];

    const { container } = render(
      h(TranscriptMessageList, { messages, streaming: false }),
    );

    expect(container.querySelectorAll(".error-notice")).toHaveLength(1);
    expect(container.querySelector(".condense-row-error")).toBeNull();
    expect(screen.getByText("Context condensing failed")).toBeTruthy();
    expect(screen.getByText("Technical details")).toBeTruthy();
    cleanup();
  });

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
      historyRenders: 0,
      unchangedHistoryRenders: 0,
      activeRenders: 1,
      historyCommits: 0,
      unchangedHistoryCommits: 0,
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
        historyRenders: 0,
        unchangedHistoryRenders: 0,
        activeRenders: 12,
        historyCommits: 0,
        unchangedHistoryCommits: 0,
        activeCommits: 12,
      },
    );
    cleanup();
  });

  it("rerenders only a semantically changed historical row", () => {
    const history: ChatMessage = {
      id: "history-changing",
      role: "assistant",
      content: "",
      timestamp: 1,
      blocks: [{ type: "text", text: "Before" }],
    };
    const active: ChatMessage = {
      id: "active-stable",
      role: "assistant",
      content: "",
      timestamp: 2,
      blocks: [{ type: "text", text: "Active" }],
    };
    const recorder = new StreamingBaselineRecorder();
    const { rerender } = render(
      h(TranscriptMessageList, {
        messages: [history, active],
        streaming: true,
        streamingMetrics: recorder,
        streamingMetricsSurface: "vscode-webview",
        streamingMetricsScope: "changed-history",
      }),
    );
    recorder.reset();

    rerender(
      h(TranscriptMessageList, {
        messages: [
          { ...history, blocks: [{ type: "text", text: "After" }] },
          active,
        ],
        streaming: true,
        streamingMetrics: recorder,
        streamingMetricsSurface: "vscode-webview",
        streamingMetricsScope: "changed-history",
      }),
    );

    expect(screen.getByText("After")).toBeTruthy();
    expect(
      recorder.summarize("vscode-webview", "changed-history"),
    ).toMatchObject({
      historyRenders: 1,
      unchangedHistoryRenders: 0,
      activeRenders: 0,
      historyCommits: 1,
      unchangedHistoryCommits: 0,
      activeCommits: 0,
    });
    cleanup();
  });

  it("rerenders only a row whose matched background session changes", () => {
    const history: ChatMessage = {
      id: "history-background",
      role: "assistant",
      content: "",
      timestamp: 1,
      blocks: [
        {
          type: "bg_agent",
          sessionId: "bg-live",
          task: "Inspect tests",
          message: "Inspect the focused tests.",
        },
      ],
    };
    const active: ChatMessage = {
      id: "active-background",
      role: "assistant",
      content: "",
      timestamp: 2,
      blocks: [{ type: "text", text: "Waiting" }],
    };
    const recorder = new StreamingBaselineRecorder();
    const baseProps = {
      messages: [history, active],
      streaming: true,
      streamingMetrics: recorder,
      streamingMetricsSurface: "vscode-webview" as const,
      streamingMetricsScope: "background-state",
    };
    const { rerender } = render(
      h(TranscriptMessageList, {
        ...baseProps,
        bgSessions: [
          { id: "bg-live", task: "Inspect tests", status: "streaming" },
        ],
      }),
    );
    recorder.reset();

    rerender(
      h(TranscriptMessageList, {
        ...baseProps,
        bgSessions: [
          {
            id: "bg-live",
            task: "Inspect tests",
            status: "tool_executing",
            currentTool: "npm test",
            displayStatus: "Running focused tests",
          },
        ],
      }),
    );

    expect(screen.getByText("Running focused tests")).toBeTruthy();
    expect(
      recorder.summarize("vscode-webview", "background-state"),
    ).toMatchObject({
      historyRenders: 1,
      activeRenders: 0,
      historyCommits: 1,
      activeCommits: 0,
    });
    cleanup();
  });

  it("rerenders only an existing warning group when another warning is appended", () => {
    const warning = (id: string, attempt: number): ChatMessage => ({
      id,
      role: "warning",
      content: "",
      timestamp: attempt,
      blocks: [],
      warningMessage: `Connection error — retrying request (attempt ${attempt}/4)`,
      warningRetry: { retryAttempt: attempt, retryMaxAttempts: 4 },
    });
    const active: ChatMessage = {
      id: "active-warning",
      role: "assistant",
      content: "",
      timestamp: 4,
      blocks: [{ type: "text", text: "Recovering" }],
    };
    const recorder = new StreamingBaselineRecorder();
    const baseProps = {
      streaming: true,
      streamingMetrics: recorder,
      streamingMetricsSurface: "vscode-webview" as const,
      streamingMetricsScope: "warning-group",
    };
    const first = warning("warning-1", 1);
    const second = warning("warning-2", 2);
    const { rerender } = render(
      h(TranscriptMessageList, {
        ...baseProps,
        messages: [first, second, active],
      }),
    );
    recorder.reset();

    rerender(
      h(TranscriptMessageList, {
        ...baseProps,
        messages: [first, second, warning("warning-3", 3), active],
      }),
    );

    expect(screen.getByText("Technical details (3)")).toBeTruthy();
    expect(recorder.summarize("vscode-webview", "warning-group")).toMatchObject(
      {
        historyRenders: 1,
        activeRenders: 0,
        historyCommits: 1,
        activeCommits: 0,
      },
    );
    cleanup();
  });

  it("rerenders only the row targeted by detected-question state", () => {
    const target: ChatMessage = {
      id: "question-target",
      role: "assistant",
      content: "",
      timestamp: 1,
      blocks: [{ type: "text", text: "Should I continue?" }],
    };
    const unrelated: ChatMessage = {
      id: "question-unrelated",
      role: "user",
      content: "Earlier prompt",
      timestamp: 2,
      blocks: [],
    };
    const recorder = new StreamingBaselineRecorder();
    const baseProps = {
      messages: [target, unrelated],
      streaming: false,
      streamingMetrics: recorder,
      streamingMetricsSurface: "vscode-webview" as const,
      streamingMetricsScope: "question-state",
    };
    const { rerender } = render(h(TranscriptMessageList, baseProps));
    recorder.reset();

    rerender(
      h(TranscriptMessageList, {
        ...baseProps,
        detectedQuestion: {
          messageId: target.id,
          kind: "yes_no",
          prompt: "Should I continue?",
          options: [
            { label: "Yes", payload: "Yes" },
            { label: "No", payload: "No" },
          ],
        },
      }),
    );

    expect(screen.getByText("Detected choice prompt")).toBeTruthy();
    expect(
      recorder.summarize("vscode-webview", "question-state"),
    ).toMatchObject({
      historyRenders: 1,
      activeRenders: 0,
      historyCommits: 1,
      activeCommits: 0,
    });
    cleanup();
  });

  it("uses replacement callbacks without rerendering unchanged rows", () => {
    const message: ChatMessage = {
      id: "detected-question",
      role: "assistant",
      content: "",
      timestamp: 1,
      blocks: [{ type: "text", text: "Should I continue?" }],
    };
    const question = {
      messageId: message.id,
      kind: "yes_no" as const,
      prompt: "Should I continue?",
      options: [
        { label: "Yes", payload: "Yes" },
        { label: "No", payload: "No" },
      ],
    };
    const firstAnswer = vi.fn();
    const latestAnswer = vi.fn();
    const recorder = new StreamingBaselineRecorder();
    const baseProps = {
      messages: [message],
      streaming: false,
      detectedQuestion: question,
      streamingMetrics: recorder,
      streamingMetricsSurface: "browser-webview" as const,
      streamingMetricsScope: "callback-replacement",
    };
    const { rerender } = render(
      h(TranscriptMessageList, {
        ...baseProps,
        onDetectedQuestionAnswer: firstAnswer,
      }),
    );
    recorder.reset();

    rerender(
      h(TranscriptMessageList, {
        ...baseProps,
        onDetectedQuestionAnswer: latestAnswer,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Yes" }));

    expect(firstAnswer).not.toHaveBeenCalled();
    expect(latestAnswer).toHaveBeenCalledWith("Yes");
    expect(
      recorder.summarize("browser-webview", "callback-replacement"),
    ).toMatchObject({
      historyRenders: 0,
      unchangedHistoryRenders: 0,
      historyCommits: 0,
      unchangedHistoryCommits: 0,
    });
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
