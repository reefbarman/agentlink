// @vitest-environment jsdom

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/preact";

import { App } from "./App.js";
import type { ChatWorkspaceViewSnapshot } from "../chatTabProtocol.js";

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

afterEach(() => cleanup());

function createVsCodeApi() {
  return {
    postMessage: vi.fn(),
    getState: vi.fn(() => undefined),
    setState: vi.fn(),
  };
}

function deliver(message: unknown): void {
  fireEvent(window, new MessageEvent("message", { data: message }));
}

function agentDone(sessionId: string, transcriptRevision: number) {
  return {
    type: "agentDone",
    sessionId,
    transcriptRevision,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheCreationTokens: 0,
  };
}

function createSnapshot(
  focusedTabId = "tab-1",
  controllerEpoch = "epoch-1",
): ChatWorkspaceViewSnapshot {
  return {
    controllerEpoch,
    focusedTabId,
    tabs: [
      {
        tabId: "tab-1",
        displayNumber: 1,
        label: "T1",
        sessionId: "session-1",
        placement: "docked",
        title: "First chat",
      },
      {
        tabId: "tab-2",
        displayNumber: 2,
        label: "T2",
        sessionId: "session-2",
        placement: "docked",
        title: "Second chat",
      },
    ],
  } as unknown as ChatWorkspaceViewSnapshot;
}

function sessionLoaded(
  sessionId: string,
  opts: {
    userText?: string;
    assistantText?: string;
    transcriptRevision?: number;
    origin?: "focus";
    streaming?: boolean;
    inFlight?: Array<Record<string, unknown>>;
  } = {},
) {
  const messages: Array<Record<string, unknown>> = [
    { role: "user", content: opts.userText ?? `prompt for ${sessionId}` },
  ];
  if (opts.assistantText) {
    messages.push({
      role: "assistant",
      content: [{ type: "text", text: opts.assistantText }],
    });
  }
  return {
    type: "agentSessionLoaded",
    sessionId,
    transcriptRevision: opts.transcriptRevision,
    title: `Loaded ${sessionId}`,
    mode: "code",
    model: "claude-opus-5",
    messages,
    messageIndexOffset: 0,
    todos: [],
    lastInputTokens: 0,
    lastOutputTokens: 0,
    origin: opts.origin,
    streaming: opts.streaming,
    inFlight: opts.inFlight,
  };
}

/** Occurrences of `needle` inside rendered transcript markdown only. */
function transcriptOccurrences(container: Element, needle: string): number {
  return Array.from(container.querySelectorAll(".markdown-body")).reduce(
    (count, el) => count + ((el.textContent?.split(needle).length ?? 1) - 1),
    0,
  );
}

describe("transcript stability across hydrations", () => {
  it("keeps streamed content when a focus hydration arrives mid-turn for the live session", async () => {
    const vscodeApi = createVsCodeApi();
    const { container } = render(<App vscodeApi={vscodeApi} />);
    deliver({ type: "chatWorkspaceUpdate", snapshot: createSnapshot("tab-1") });
    deliver(
      sessionLoaded("session-1", { transcriptRevision: 1, streaming: true }),
    );
    await waitFor(() => {
      expect(transcriptOccurrences(container, "prompt for session-1")).toBe(1);
    });

    deliver({
      type: "agentTextDelta",
      sessionId: "session-1",
      text: "StreamedAnswerXyz",
    });
    // A focus hydration mid-turn: revision advanced, the persisted transcript
    // lacks the streaming text, streaming still on. It must neither clobber
    // nor duplicate the live view. (Its handler also flushes pending deltas.)
    deliver(
      sessionLoaded("session-1", {
        transcriptRevision: 4,
        origin: "focus",
        streaming: true,
      }),
    );

    // Streaming continues after the hydration — nothing gets dropped, and
    // once the turn completes everything streamed appears exactly once.
    deliver({
      type: "agentTextDelta",
      sessionId: "session-1",
      text: "ContinuedTail",
    });
    deliver(agentDone("session-1", 6));
    await waitFor(() => {
      expect(
        transcriptOccurrences(container, "StreamedAnswerXyzContinuedTail"),
      ).toBe(1);
    });
  });

  it("does not duplicate a turn that streamed while its tab was inactive", async () => {
    const vscodeApi = createVsCodeApi();
    const { container } = render(<App vscodeApi={vscodeApi} />);
    deliver({ type: "chatWorkspaceUpdate", snapshot: createSnapshot("tab-1") });
    deliver(
      sessionLoaded("session-1", { transcriptRevision: 1, streaming: true }),
    );
    deliver({
      type: "agentTextDelta",
      sessionId: "session-1",
      text: "AlphaSegment",
    });
    deliver({
      type: "agentToolStart",
      sessionId: "session-1",
      toolCallId: "tool-flush-1",
      toolName: "read_file",
      input: {},
    });
    await waitFor(() => {
      expect(transcriptOccurrences(container, "AlphaSegment")).toBe(1);
    });

    // Switch to tab 2; session-1 keeps streaming in the background and
    // completes there.
    deliver({ type: "chatWorkspaceUpdate", snapshot: createSnapshot("tab-2") });
    deliver(sessionLoaded("session-2", { transcriptRevision: 1 }));
    await waitFor(() => {
      expect(transcriptOccurrences(container, "prompt for session-2")).toBe(1);
    });
    deliver({
      type: "agentTextDelta",
      sessionId: "session-1",
      text: "BetaSegment",
    });
    deliver(agentDone("session-1", 3));

    // Switch back: the extension re-sends the persisted transcript (now
    // containing the full turn) as a focus hydration. The cached projection
    // plus buffered replay must render the turn exactly once.
    deliver({ type: "chatWorkspaceUpdate", snapshot: createSnapshot("tab-1") });
    deliver(
      sessionLoaded("session-1", {
        transcriptRevision: 3,
        origin: "focus",
        assistantText: "AlphaSegment tool result BetaSegment",
      }),
    );

    await waitFor(() => {
      expect(transcriptOccurrences(container, "BetaSegment")).toBe(1);
    });
    expect(transcriptOccurrences(container, "AlphaSegment")).toBe(1);
  });

  it("renders the in-flight live tail delivered with a hydration", async () => {
    const vscodeApi = createVsCodeApi();
    const { container } = render(<App vscodeApi={vscodeApi} />);
    deliver({ type: "chatWorkspaceUpdate", snapshot: createSnapshot("tab-1") });
    deliver(
      sessionLoaded("session-1", {
        transcriptRevision: 2,
        streaming: true,
        inFlight: [{ type: "text", text: "InFlightPartialQrs" }],
      }),
    );

    // Deltas keep flowing into the same live tail rather than a new message:
    // after the turn completes, snapshot text and post-hydration deltas form
    // one contiguous block.
    deliver({
      type: "agentTextDelta",
      sessionId: "session-1",
      text: "MoreLiveText",
    });
    deliver(agentDone("session-1", 3));
    await waitFor(() => {
      expect(
        transcriptOccurrences(container, "InFlightPartialQrsMoreLiveText"),
      ).toBe(1);
    });
  });

  it("recovers a session whose first hydration arrived after rapid tab switching", async () => {
    const vscodeApi = createVsCodeApi();
    const { container } = render(<App vscodeApi={vscodeApi} />);
    deliver({ type: "chatWorkspaceUpdate", snapshot: createSnapshot("tab-1") });
    deliver(sessionLoaded("session-1", { transcriptRevision: 1 }));
    await waitFor(() => {
      expect(transcriptOccurrences(container, "prompt for session-1")).toBe(1);
    });

    // Switch to tab 2 and back before session-2's hydration arrives — the
    // never-hydrated placeholder must not poison the projection cache.
    deliver({ type: "chatWorkspaceUpdate", snapshot: createSnapshot("tab-2") });
    deliver({ type: "chatWorkspaceUpdate", snapshot: createSnapshot("tab-1") });
    deliver(
      sessionLoaded("session-1", { transcriptRevision: 1, origin: "focus" }),
    );

    // Now genuinely open tab 2; its focus hydration must render even though a
    // stale placeholder existed for it earlier.
    deliver({ type: "chatWorkspaceUpdate", snapshot: createSnapshot("tab-2") });
    deliver(
      sessionLoaded("session-2", {
        transcriptRevision: 2,
        origin: "focus",
        userText: "SessionTwoPromptUvw",
      }),
    );

    await waitFor(() => {
      expect(transcriptOccurrences(container, "SessionTwoPromptUvw")).toBe(1);
    });
  });
});
