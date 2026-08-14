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

function deliverAuthenticatedModels(): void {
  deliver({
    type: "agentModelsUpdate",
    models: [
      {
        id: "claude-opus-5",
        displayName: "Claude Opus",
        provider: "anthropic",
        authenticated: true,
      },
    ],
  });
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
    restored?: boolean;
    streaming?: boolean;
    inFlight?: Array<Record<string, unknown>>;
    interrupted?: boolean;
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
    restored: opts.restored,
    streaming: opts.streaming,
    inFlight: opts.inFlight,
    interrupted: opts.interrupted,
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
  it("keeps the optimistic first message when its tab is bound to a new session", async () => {
    const vscodeApi = createVsCodeApi();
    const snapshot = createSnapshot("tab-1");
    snapshot.tabs[0] = {
      ...snapshot.tabs[0]!,
      sessionId: null,
      status: "idle",
      busy: false,
    };
    const { container } = render(<App vscodeApi={vscodeApi} />);
    deliverAuthenticatedModels();
    deliver({ type: "chatWorkspaceUpdate", snapshot });
    deliver({
      type: "stateUpdate",
      state: {
        sessionId: null,
        mode: "code",
        model: "claude-opus-5",
        streaming: false,
        reasoningEffort: "high",
        thinkingEnabled: true,
      },
    });

    const composer = container.querySelector(
      ".chat-input",
    ) as HTMLTextAreaElement;
    fireEvent.input(composer, {
      target: { value: "FirstPromptMustRemain" },
    });
    fireEvent.click(
      container.querySelector<HTMLButtonElement>(
        'button[title="Send message (Enter)"]',
      )!,
    );
    expect(transcriptOccurrences(container, "FirstPromptMustRemain")).toBe(1);

    deliver({
      type: "chatWorkspaceUpdate",
      snapshot: createSnapshot("tab-1"),
    });

    // A creation-time hydration may still be empty because the manager has not
    // committed the user turn yet. It must not replace the optimistic row.
    deliver({
      ...sessionLoaded("session-1", {
        transcriptRevision: 0,
        origin: "focus",
        streaming: true,
      }),
      messages: [],
    });
    expect(transcriptOccurrences(container, "FirstPromptMustRemain")).toBe(1);

    // The first canonical hydration is authoritative and repairs any events
    // missed before binding without duplicating the optimistic user row.
    deliver({
      ...sessionLoaded("session-1", {
        userText: "FirstPromptMustRemain",
        transcriptRevision: 1,
        origin: "focus",
        streaming: false,
      }),
      mode: "ask",
    });

    await waitFor(() => {
      expect(transcriptOccurrences(container, "FirstPromptMustRemain")).toBe(1);
      expect(container.querySelector('[title="Mode: Ask"]')).toBeTruthy();
    });
  });

  it("does not preserve an optimistic first message across controller epochs", () => {
    const vscodeApi = createVsCodeApi();
    const snapshot = createSnapshot("tab-1", "epoch-1");
    snapshot.tabs[0] = { ...snapshot.tabs[0]!, sessionId: null };
    const { container } = render(<App vscodeApi={vscodeApi} />);
    deliverAuthenticatedModels();
    deliver({ type: "chatWorkspaceUpdate", snapshot });
    deliver({
      type: "stateUpdate",
      state: { sessionId: null, mode: "code", model: "claude-opus-5" },
    });

    const composer = container.querySelector(
      ".chat-input",
    ) as HTMLTextAreaElement;
    fireEvent.input(composer, { target: { value: "OldEpochPrompt" } });
    fireEvent.click(
      container.querySelector<HTMLButtonElement>(
        'button[title="Send message (Enter)"]',
      )!,
    );
    expect(transcriptOccurrences(container, "OldEpochPrompt")).toBe(1);

    deliver({
      type: "chatWorkspaceUpdate",
      snapshot: createSnapshot("tab-1", "epoch-2"),
    });
    expect(transcriptOccurrences(container, "OldEpochPrompt")).toBe(0);
  });

  it("does not transfer an optimistic first message to another tab", () => {
    const vscodeApi = createVsCodeApi();
    const snapshot = createSnapshot("tab-1");
    snapshot.tabs[0] = { ...snapshot.tabs[0]!, sessionId: null };
    snapshot.tabs[1] = { ...snapshot.tabs[1]!, sessionId: null };
    const { container } = render(<App vscodeApi={vscodeApi} />);
    deliverAuthenticatedModels();
    deliver({ type: "chatWorkspaceUpdate", snapshot });
    deliver({
      type: "stateUpdate",
      state: { sessionId: null, mode: "code", model: "claude-opus-5" },
    });

    const composer = container.querySelector(
      ".chat-input",
    ) as HTMLTextAreaElement;
    fireEvent.input(composer, { target: { value: "OnlyForFirstTab" } });
    fireEvent.click(
      container.querySelector<HTMLButtonElement>(
        'button[title="Send message (Enter)"]',
      )!,
    );
    expect(transcriptOccurrences(container, "OnlyForFirstTab")).toBe(1);

    deliver({
      type: "chatWorkspaceUpdate",
      snapshot: { ...snapshot, focusedTabId: "tab-2" },
    });
    const boundSecondTab = createSnapshot("tab-2");
    boundSecondTab.tabs[0] = {
      ...boundSecondTab.tabs[0]!,
      sessionId: null,
    };
    deliver({ type: "chatWorkspaceUpdate", snapshot: boundSecondTab });
    expect(transcriptOccurrences(container, "OnlyForFirstTab")).toBe(0);
  });

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

  it("hides interrupted controls until restored transcript hydration completes", async () => {
    const vscodeApi = createVsCodeApi();
    const { container } = render(<App vscodeApi={vscodeApi} />);
    deliver({ type: "chatWorkspaceUpdate", snapshot: createSnapshot("tab-1") });
    deliver({ type: "agentRestoreSessionStart" });
    deliver({
      type: "stateUpdate",
      state: {
        sessionId: "session-1",
        interrupted: true,
        streaming: false,
      },
    });

    expect(container.querySelector(".interrupted-session-banner")).toBeNull();

    deliver(
      sessionLoaded("session-1", {
        restored: true,
        transcriptRevision: 2,
        userText: "HydratedBeforeResumeControls",
      }),
    );
    deliver({
      type: "stateUpdate",
      state: {
        sessionId: "session-1",
        interrupted: true,
        streaming: false,
      },
    });
    deliver({ type: "agentRestoreSessionDone" });

    await waitFor(() => {
      expect(
        transcriptOccurrences(container, "HydratedBeforeResumeControls"),
      ).toBe(1);
      expect(
        container.querySelector(".interrupted-session-banner"),
      ).toBeTruthy();
    });
  });

  it("shows interrupted controls as soon as a hydration carrying interrupted state lands, before restore completes", async () => {
    const vscodeApi = createVsCodeApi();
    const { container } = render(<App vscodeApi={vscodeApi} />);
    deliver({ type: "chatWorkspaceUpdate", snapshot: createSnapshot("tab-1") });
    deliver({ type: "agentRestoreSessionStart" });

    // A provisional tail hydration carries the persisted interrupted flag.
    deliver(
      sessionLoaded("session-1", {
        restored: true,
        transcriptRevision: 2,
        userText: "ProvisionalTailPaint",
        interrupted: true,
      }),
    );

    await waitFor(() => {
      expect(transcriptOccurrences(container, "ProvisionalTailPaint")).toBe(1);
      expect(
        container.querySelector(".interrupted-session-banner"),
      ).toBeTruthy();
    });

    // Restore is still pending — resume must be clickable already.
    const resume = container.querySelector<HTMLButtonElement>(
      ".interrupted-session-resume",
    );
    expect(resume).toBeTruthy();
    fireEvent.click(resume!);
    expect(vscodeApi.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "agentResumeSession",
        sessionId: "session-1",
      }),
    );
    deliver({ type: "agentRestoreSessionDone" });
  });

  it("starts a new chat immediately while a restored transcript is still loading", async () => {
    const vscodeApi = createVsCodeApi();
    const { container } = render(<App vscodeApi={vscodeApi} />);
    deliver({ type: "chatWorkspaceUpdate", snapshot: createSnapshot("tab-1") });
    deliver({ type: "agentRestoreSessionStart" });
    deliver(
      sessionLoaded("session-1", {
        restored: true,
        transcriptRevision: 2,
        userText: "SlowRestoredTranscript",
      }),
    );
    await waitFor(() => {
      expect(transcriptOccurrences(container, "SlowRestoredTranscript")).toBe(
        1,
      );
    });

    const newChatButton = container.querySelector<HTMLButtonElement>(
      ".chat-header .icon-button",
    );
    expect(newChatButton).toBeTruthy();
    fireEvent.click(newChatButton!);

    // The webview clears to an empty chat right away — it does not wait for
    // the (possibly still transcript-parsing) host to respond.
    await waitFor(() => {
      expect(transcriptOccurrences(container, "SlowRestoredTranscript")).toBe(
        0,
      );
    });
    expect(vscodeApi.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: "chatTabNewChat" }),
    );

    // A late hydration from the superseded restore must not repaint the old
    // transcript over the fresh chat.
    deliver(
      sessionLoaded("session-1", {
        restored: true,
        transcriptRevision: 3,
        userText: "SlowRestoredTranscript",
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(transcriptOccurrences(container, "SlowRestoredTranscript")).toBe(0);
  });

  it("re-arms restored hydration acceptance for a reconnected webview", async () => {
    const vscodeApi = createVsCodeApi();
    const { container } = render(<App vscodeApi={vscodeApi} />);
    deliver({ type: "chatWorkspaceUpdate", snapshot: createSnapshot("tab-1") });
    deliver({ type: "agentRestoreSessionDone" });
    deliver({ type: "agentRestoreSessionStart" });
    deliver(
      sessionLoaded("session-1", {
        restored: true,
        transcriptRevision: 3,
        userText: "RestoredAfterReconnectXyz",
      }),
    );

    await waitFor(() => {
      expect(
        transcriptOccurrences(container, "RestoredAfterReconnectXyz"),
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
