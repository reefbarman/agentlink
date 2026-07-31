// @vitest-environment jsdom

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/preact";

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

function postedCommands(
  postMessage: ReturnType<typeof vi.fn>,
  command: string,
) {
  return postMessage.mock.calls
    .map(([message]) => message as Record<string, unknown>)
    .filter((message) => message.command === command);
}

function sessionLoaded(
  sessionId: string,
  message: string,
  transcriptRevision?: number,
) {
  return {
    type: "agentSessionLoaded",
    sessionId,
    transcriptRevision,
    title: `Loaded ${sessionId}`,
    mode: "code",
    model: "claude-opus-5",
    messages: [{ role: "user", content: message }],
    todos: [],
    lastInputTokens: 0,
    lastOutputTokens: 0,
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
        status: "streaming",
        busy: true,
      },
      {
        tabId: "tab-2",
        displayNumber: 2,
        label: "T2",
        sessionId: "session-2",
        placement: "docked",
        title: "Second chat",
        status: "idle",
        busy: false,
      },
    ],
  };
}

describe("App chat workspace integration", () => {
  it("renders a keyed workspace and addresses focus and New Tab commands", () => {
    const vscodeApi = createVsCodeApi();
    const { container } = render(<App vscodeApi={vscodeApi} />);
    deliver({ type: "chatWorkspaceUpdate", snapshot: createSnapshot() });

    expect(screen.getByRole("tablist", { name: "Agent chats" })).toBeTruthy();
    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(2);
    expect(
      container.querySelector<HTMLElement>(".chat-session-pane")?.dataset
        .tabKey,
    ).toBe("tab-1:session-1");

    const tabSelectors =
      container.querySelectorAll<HTMLButtonElement>(".chat-tab-select");
    fireEvent.click(tabSelectors[1]!);
    expect(postedCommands(vscodeApi.postMessage, "chatTabFocus")).toEqual([
      {
        command: "chatTabFocus",
        controllerEpoch: "epoch-1",
        tabId: "tab-2",
        sessionId: "session-2",
      },
    ]);

    fireEvent.click(screen.getByRole("button", { name: "New Tab" }));
    expect(postedCommands(vscodeApi.postMessage, "chatTabNew")).toEqual([
      {
        command: "chatTabNew",
        mode: "code",
        controllerEpoch: "epoch-1",
        tabId: "tab-1",
        sessionId: "session-1",
      },
    ]);

    fireEvent.click(screen.getByRole("button", { name: "New Chat" }));
    expect(postedCommands(vscodeApi.postMessage, "chatTabNewChat")).toEqual([
      {
        command: "chatTabNewChat",
        mode: "code",
        projectId: undefined,
        controllerEpoch: "epoch-1",
        tabId: "tab-1",
        sessionId: "session-1",
      },
    ]);
  });

  it("keeps composer selections made before the first message", async () => {
    const vscodeApi = createVsCodeApi();
    const snapshot = createSnapshot("tab-1");
    snapshot.tabs[0] = {
      ...snapshot.tabs[0]!,
      sessionId: null,
      status: "idle",
      busy: false,
    };
    const { container } = render(<App vscodeApi={vscodeApi} />);
    deliver({ type: "chatWorkspaceUpdate", snapshot });
    deliver({
      type: "stateUpdate",
      state: {
        sessionId: null,
        mode: "code",
        model: "model-a",
        streaming: false,
        reasoningEffort: "high",
        thinkingEnabled: true,
        agentWriteApproval: "prompt",
        commandApprovalPolicy: "safe",
        configuredCommandApprovalPolicy: "safe",
        projects: [
          {
            projectId: "project-1",
            displayName: "Project",
            availability: "available",
          },
        ],
      },
    });
    deliver({
      type: "agentModesUpdate",
      modes: [
        { slug: "code", name: "Code", icon: "code" },
        { slug: "ask", name: "Ask", icon: "comment-discussion" },
      ],
    });
    deliver({
      type: "agentModelsUpdate",
      models: [
        {
          id: "model-a",
          displayName: "Model A",
          provider: "test",
          authenticated: true,
          reasoningEfforts: ["none", "low", "high"],
        },
        {
          id: "model-b",
          displayName: "Model B",
          provider: "test",
          authenticated: true,
          reasoningEfforts: ["none", "low", "high"],
        },
      ],
    });

    fireEvent.click(screen.getByTitle("Mode: Code"));
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    expect(screen.getByTitle("Mode: Ask")).toBeTruthy();

    fireEvent.click(screen.getByTitle(/Model: Model A/));
    fireEvent.click(screen.getByRole("button", { name: /Model B/ }));
    expect(screen.getByTitle(/Model: Model B/)).toBeTruthy();

    fireEvent.click(screen.getByTitle("Reasoning: High"));
    fireEvent.click(screen.getByRole("button", { name: "Low" }));
    expect(screen.getByTitle("Reasoning: Low")).toBeTruthy();

    fireEvent.click(screen.getByTitle("Writes: Prompt"));
    fireEvent.click(screen.getByRole("button", { name: "Project" }));
    expect(screen.getByTitle("Writes: Project")).toBeTruthy();

    fireEvent.click(screen.getByTitle(/Let a separate reviewer approve/));

    deliver({
      type: "stateUpdate",
      state: {
        sessionId: null,
        mode: "code",
        model: "model-a",
        streaming: false,
        reasoningEffort: "high",
        thinkingEnabled: true,
        agentWriteApproval: "prompt",
        commandApprovalPolicy: "safe",
        configuredCommandApprovalPolicy: "safe",
      },
    });
    expect(screen.getByTitle("Mode: Ask")).toBeTruthy();
    expect(screen.getByTitle(/Model: Model B/)).toBeTruthy();
    expect(screen.getByTitle("Reasoning: Low")).toBeTruthy();
    expect(screen.getByTitle("Writes: Project")).toBeTruthy();

    const composer = container.querySelector(
      ".chat-input",
    ) as HTMLTextAreaElement;
    fireEvent.input(composer, { target: { value: "first message" } });
    fireEvent.click(screen.getByTitle("Send message (Enter)"));

    expect(postedCommands(vscodeApi.postMessage, "chatTabNewChat")).toEqual([]);
    expect(postedCommands(vscodeApi.postMessage, "agentSetModel")).toEqual([]);
    expect(
      postedCommands(vscodeApi.postMessage, "agentSetWriteApproval"),
    ).toEqual([]);
    expect(
      postedCommands(vscodeApi.postMessage, "agentSetCommandApprovalPolicy"),
    ).toEqual([]);
    expect(postedCommands(vscodeApi.postMessage, "agentSend")).toEqual([
      expect.objectContaining({
        sessionId: null,
        mode: "ask",
        model: "model-b",
        reasoningEffort: "low",
        thinkingEnabled: true,
        agentWriteApproval: "project",
        commandApprovalPolicy: "approve-for-me",
      }),
    ]);
  });

  it("renders ask_user from an explicitly correlated question request", () => {
    const vscodeApi = createVsCodeApi();
    render(<App vscodeApi={vscodeApi} />);
    deliver({ type: "chatWorkspaceUpdate", snapshot: createSnapshot("tab-1") });
    deliver(sessionLoaded("session-1", "transcript for A"));

    deliver({
      type: "agentQuestionRequest",
      sessionId: "session-1",
      id: "question-a",
      toolCallId: "tool-ask-a",
      context: "Need a decision.",
      questions: [
        {
          id: "continue",
          type: "yes_no",
          question: "Continue?",
        },
      ],
    });

    expect(screen.getByText("Continue?")).toBeTruthy();
    expect(screen.getByRole("button", { name: /^ask_user/ })).toBeTruthy();
  });

  it("routes question cards to their owning tab", async () => {
    const vscodeApi = createVsCodeApi();
    render(<App vscodeApi={vscodeApi} />);
    deliver({ type: "chatWorkspaceUpdate", snapshot: createSnapshot("tab-1") });
    deliver(sessionLoaded("session-1", "transcript for A"));

    deliver({
      type: "agentQuestionRequest",
      sessionId: "session-2",
      id: "question-b",
      context: "Only T2 should show this question.",
      questions: [
        {
          id: "choice",
          type: "multiple_choice",
          question: "Choose for T2",
          options: ["one", "two"],
          recommended: "one",
        },
      ],
    });

    expect(screen.queryByText("Choose for T2")).toBeNull();

    deliver({ type: "chatWorkspaceUpdate", snapshot: createSnapshot("tab-2") });
    deliver(sessionLoaded("session-2", "transcript for B"));

    await waitFor(() => {
      expect(screen.getByText("Choose for T2")).toBeTruthy();
    });
  });

  it("routes approval cards and clears to their owning tab and request", async () => {
    const vscodeApi = createVsCodeApi();
    render(<App vscodeApi={vscodeApi} />);
    deliver({ type: "chatWorkspaceUpdate", snapshot: createSnapshot("tab-1") });
    deliver(sessionLoaded("session-1", "transcript for A"));

    deliver({
      type: "showApproval",
      sessionId: "session-2",
      request: {
        kind: "write",
        id: "approval-b",
        filePath: "src/only-t2.ts",
        writeOperation: "modify",
      },
    });

    expect(screen.queryByText("src/only-t2.ts")).toBeNull();

    deliver({ type: "chatWorkspaceUpdate", snapshot: createSnapshot("tab-2") });
    deliver(sessionLoaded("session-2", "transcript for B"));

    await waitFor(() => {
      expect(screen.getByText("src/only-t2.ts")).toBeTruthy();
    });

    deliver({ type: "idle", sessionId: "session-1", id: "approval-b" });
    deliver({ type: "idle", sessionId: "session-2", id: "approval-other" });
    expect(screen.getByText("src/only-t2.ts")).toBeTruthy();

    deliver({ type: "idle", sessionId: "session-2", id: "approval-b" });
    await waitFor(() => {
      expect(screen.queryByText("src/only-t2.ts")).toBeNull();
    });

    deliver({ type: "chatWorkspaceUpdate", snapshot: createSnapshot("tab-1") });
    deliver(sessionLoaded("session-1", "transcript for A"));
    expect(screen.queryByText("src/only-t2.ts")).toBeNull();
  });

  it("keeps background approvals globally visible and clears them across tab switches", async () => {
    const vscodeApi = createVsCodeApi();
    render(<App vscodeApi={vscodeApi} />);
    deliver({ type: "chatWorkspaceUpdate", snapshot: createSnapshot("tab-1") });
    deliver(sessionLoaded("session-1", "transcript for A"));

    deliver({
      type: "showApproval",
      request: {
        kind: "write",
        id: "approval-bg",
        filePath: "src/background-global.ts",
        writeOperation: "modify",
        backgroundTask: "Detached review",
      },
    });

    expect(screen.getByText("src/background-global.ts")).toBeTruthy();
    expect(screen.getByText("Detached review")).toBeTruthy();

    deliver({ type: "chatWorkspaceUpdate", snapshot: createSnapshot("tab-2") });
    deliver(sessionLoaded("session-2", "transcript for B"));
    expect(screen.getByText("src/background-global.ts")).toBeTruthy();

    deliver({ type: "idle", id: "approval-bg" });
    await waitFor(() => {
      expect(screen.queryByText("src/background-global.ts")).toBeNull();
    });

    deliver({ type: "chatWorkspaceUpdate", snapshot: createSnapshot("tab-1") });
    deliver(sessionLoaded("session-1", "transcript for A"));
    expect(screen.queryByText("src/background-global.ts")).toBeNull();
  });

  it("keeps coordinator-less background questions globally visible", () => {
    const vscodeApi = createVsCodeApi();
    render(<App vscodeApi={vscodeApi} />);
    deliver({ type: "chatWorkspaceUpdate", snapshot: createSnapshot("tab-1") });
    deliver(sessionLoaded("session-1", "transcript for A"));

    deliver({
      type: "agentQuestionRequest",
      id: "question-bg",
      context: "A detached background agent needs input.",
      questions: [
        {
          id: "continue",
          type: "yes_no",
          question: "Continue background work?",
        },
      ],
      backgroundTask: "Detached review",
    });

    expect(screen.getByText("Continue background work?")).toBeTruthy();
    expect(screen.getByText("Detached review")).toBeTruthy();
  });

  it("keeps BTW cards with their originating chat across tab switches", () => {
    const vscodeApi = createVsCodeApi();
    render(<App vscodeApi={vscodeApi} />);
    deliver({ type: "chatWorkspaceUpdate", snapshot: createSnapshot("tab-1") });
    deliver(sessionLoaded("session-1", "transcript for A"));
    deliver({
      type: "agentBtwLoading",
      sessionId: "session-1",
      requestId: "btw-1",
      question: "Question for A",
    });

    expect(screen.getByText("Question for A")).toBeTruthy();

    deliver({ type: "chatWorkspaceUpdate", snapshot: createSnapshot("tab-2") });
    deliver({
      ...sessionLoaded("session-2", "transcript for B"),
      origin: "focus",
    });
    expect(screen.queryByText("Question for A")).toBeNull();

    deliver({
      type: "agentBtwProgress",
      sessionId: "session-1",
      requestId: "btw-1",
      answer: "Answer for A while inactive",
      tools: [],
      warnings: [],
      budget: {
        apiTurns: 1,
        maxApiTurns: 5,
        toolCalls: 0,
        maxToolCalls: 10,
      },
    });
    expect(screen.queryByText("Answer for A while inactive")).toBeNull();

    deliver({ type: "chatWorkspaceUpdate", snapshot: createSnapshot("tab-1") });
    deliver({
      ...sessionLoaded("session-1", "transcript for A"),
      origin: "focus",
    });

    expect(screen.getByText("Question for A")).toBeTruthy();
    expect(screen.getByText("Answer for A while inactive")).toBeTruthy();
  });

  it("isolates context usage and queued messages across tab switches", () => {
    const vscodeApi = createVsCodeApi();
    const { container } = render(<App vscodeApi={vscodeApi} />);
    deliver({ type: "chatWorkspaceUpdate", snapshot: createSnapshot("tab-1") });
    deliver({
      type: "stateUpdate",
      state: {
        sessionId: "session-1",
        mode: "code",
        model: "claude-opus-5",
        streaming: true,
        thinkingEnabled: true,
        reasoningEffort: "high",
        contextBudget: {
          maxInputTokens: 1_000_000,
          usedInputTokens: 250_000,
          outputReservation: 0,
        },
      },
    });
    deliver({
      type: "agentTokenEstimate",
      sessionId: "session-1",
      estimatedTotalUsed: 250_000,
    });
    deliver({
      type: "agentQueuedMessage",
      sessionId: "session-1",
      queueId: "queue-1",
      text: "queued for the first tab",
      displayText: "queued for the first tab",
      isSlashCommand: false,
    });

    expect(
      container.querySelector(".context-bar-label")?.textContent,
    ).toContain("250.0k");
    expect(screen.getByText("queued for the first tab")).toBeTruthy();

    const unboundSecondTab = createSnapshot("tab-2");
    unboundSecondTab.tabs[1] = {
      ...unboundSecondTab.tabs[1]!,
      sessionId: null,
    };
    deliver({ type: "chatWorkspaceUpdate", snapshot: unboundSecondTab });
    deliver({
      type: "stateUpdate",
      state: {
        sessionId: "session-1",
        mode: "code",
        model: "claude-opus-5",
        streaming: true,
        contextBudget: {
          maxInputTokens: 1_000_000,
          usedInputTokens: 250_000,
          outputReservation: 0,
        },
      },
    });
    expect(container.querySelector(".context-bar-label")).toBeNull();
    expect(screen.queryByText("queued for the first tab")).toBeNull();

    deliver({ type: "chatWorkspaceUpdate", snapshot: createSnapshot("tab-2") });
    expect(container.querySelector(".context-bar-label")).toBeNull();

    deliver({
      type: "agentDone",
      sessionId: "session-1",
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
    });
    deliver({ type: "chatWorkspaceUpdate", snapshot: createSnapshot("tab-1") });
    deliver({
      type: "agentSessionLoaded",
      sessionId: "session-1",
      title: "First chat",
      mode: "code",
      model: "claude-opus-5",
      messages: [],
      todos: [],
      lastInputTokens: 0,
      lastOutputTokens: 0,
    });

    expect(
      container.querySelector(".context-bar-label")?.textContent,
    ).toContain("250.0k");
    expect(screen.getByText("queued for the first tab")).toBeTruthy();
  });

  it("rejects late session loads without consuming inactive events", async () => {
    const vscodeApi = createVsCodeApi();
    render(<App vscodeApi={vscodeApi} />);
    deliver({ type: "chatWorkspaceUpdate", snapshot: createSnapshot("tab-1") });
    deliver(sessionLoaded("session-1", "transcript for A"));

    deliver({ type: "chatWorkspaceUpdate", snapshot: createSnapshot("tab-2") });
    deliver(sessionLoaded("session-2", "transcript for B"));
    deliver({ type: "chatWorkspaceUpdate", snapshot: createSnapshot("tab-1") });
    expect(screen.getAllByText("transcript for A")).not.toHaveLength(0);

    deliver({
      type: "agentQueuedMessage",
      sessionId: "session-2",
      queueId: "queue-b",
      text: "buffered for B",
      displayText: "buffered for B",
      isSlashCommand: false,
    });
    deliver(sessionLoaded("session-2", "late overwrite from B"));
    deliver({
      type: "stateUpdate",
      state: {
        sessionId: "session-2",
        mode: "code",
        model: "claude-opus-5",
        streaming: false,
        contextBudget: {
          maxInputTokens: 1_000_000,
          usedInputTokens: 400_000,
          outputReservation: 0,
        },
      },
    });

    expect(screen.getAllByText("transcript for A")).not.toHaveLength(0);
    expect(screen.queryByText("late overwrite from B")).toBeNull();
    expect(screen.queryByText("buffered for B")).toBeNull();
    expect(document.querySelector(".context-bar-label")).toBeNull();

    deliver({ type: "chatWorkspaceUpdate", snapshot: createSnapshot("tab-2") });
    deliver(sessionLoaded("session-2", "transcript for B"));

    await waitFor(() => {
      expect(screen.getAllByText("transcript for B")).not.toHaveLength(0);
      expect(screen.getByText("buffered for B")).toBeTruthy();
    });
  });

  it("does not restore a cached projection from a previous controller epoch", async () => {
    const vscodeApi = createVsCodeApi();
    render(<App vscodeApi={vscodeApi} />);
    deliver({ type: "chatWorkspaceUpdate", snapshot: createSnapshot("tab-1") });
    deliver(sessionLoaded("session-1", "pre-reset transcript for A", 1));
    deliver({ type: "chatWorkspaceUpdate", snapshot: createSnapshot("tab-2") });
    deliver(sessionLoaded("session-2", "pre-reset transcript for B", 1));

    deliver({
      type: "chatWorkspaceUpdate",
      snapshot: createSnapshot("tab-1", "epoch-2"),
    });

    expect(screen.queryByText("pre-reset transcript for A")).toBeNull();
    expect(screen.queryByText("pre-reset transcript for B")).toBeNull();

    deliver(
      sessionLoaded("session-1", "post-reset canonical transcript for A", 1),
    );
    await waitFor(() => {
      expect(
        screen.getAllByText("post-reset canonical transcript for A"),
      ).not.toHaveLength(0);
    });
  });

  it("hydrates an uncached tab when an inactive completion has the same revision", async () => {
    const vscodeApi = createVsCodeApi();
    render(<App vscodeApi={vscodeApi} />);
    deliver({ type: "chatWorkspaceUpdate", snapshot: createSnapshot("tab-1") });
    deliver(sessionLoaded("session-1", "transcript for A", 1));
    deliver({
      type: "agentDone",
      sessionId: "session-2",
      transcriptRevision: 2,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
    });

    deliver({ type: "chatWorkspaceUpdate", snapshot: createSnapshot("tab-2") });
    deliver(sessionLoaded("session-2", "first canonical transcript for B", 2));

    await waitFor(() => {
      expect(
        screen.getAllByText("first canonical transcript for B"),
      ).not.toHaveLength(0);
    });
  });

  it("does not duplicate a turn that completes while its tab is inactive", async () => {
    const vscodeApi = createVsCodeApi();
    render(<App vscodeApi={vscodeApi} />);
    deliver({ type: "chatWorkspaceUpdate", snapshot: createSnapshot("tab-1") });
    deliver(sessionLoaded("session-1", "last user message in A", 1));
    deliver({
      type: "stateUpdate",
      state: {
        sessionId: "session-1",
        mode: "code",
        model: "claude-opus-5",
        streaming: true,
      },
    });

    deliver({ type: "chatWorkspaceUpdate", snapshot: createSnapshot("tab-2") });
    deliver(sessionLoaded("session-2", "transcript for B", 1));
    deliver({
      type: "agentTextDelta",
      sessionId: "session-1",
      text: "assistant completed while A was inactive",
    });
    deliver({
      type: "agentDone",
      sessionId: "session-1",
      transcriptRevision: 2,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
    });

    deliver({ type: "chatWorkspaceUpdate", snapshot: createSnapshot("tab-1") });
    deliver({
      ...sessionLoaded("session-1", "persisted transcript revision 2", 2),
      origin: "focus",
    });

    await waitFor(() => {
      expect(
        screen.getAllByText("assistant completed while A was inactive"),
      ).toHaveLength(1);
    });
    expect(screen.queryByText("persisted transcript revision 2")).toBeNull();
  });

  it("keeps live assistant content after the last user message when a cached tab is focused", async () => {
    const vscodeApi = createVsCodeApi();
    render(<App vscodeApi={vscodeApi} />);
    deliver({ type: "chatWorkspaceUpdate", snapshot: createSnapshot("tab-1") });
    deliver(sessionLoaded("session-1", "last user message in A", 1));
    deliver({
      type: "stateUpdate",
      state: {
        sessionId: "session-1",
        mode: "code",
        model: "claude-opus-5",
        streaming: true,
      },
    });
    deliver({
      type: "agentTextDelta",
      sessionId: "session-1",
      text: "assistant content after the last user message",
    });
    deliver({
      type: "agentDone",
      sessionId: "session-1",
      transcriptRevision: 2,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
    });
    await waitFor(() => {
      expect(
        screen.getAllByText("assistant content after the last user message"),
      ).toHaveLength(1);
    });

    deliver({ type: "chatWorkspaceUpdate", snapshot: createSnapshot("tab-2") });
    deliver(sessionLoaded("session-2", "transcript for B", 1));
    deliver({ type: "chatWorkspaceUpdate", snapshot: createSnapshot("tab-1") });
    deliver({
      ...sessionLoaded("session-1", "stale persisted tail for A", 2),
      origin: "focus",
      backgroundResults: [
        {
          sessionId: "bg-completed-while-inactive",
          task: "Inactive review",
          status: "completed",
          resultText: "recovered background result",
          completedAt: 1,
        },
      ],
    });

    await waitFor(() => {
      expect(
        screen.getAllByText("assistant content after the last user message"),
      ).toHaveLength(1);
      expect(screen.getAllByText("recovered background result")).toHaveLength(
        1,
      );
    });
    expect(screen.queryByText("stale persisted tail for A")).toBeNull();

    deliver(sessionLoaded("session-1", "older duplicate load for A", 1));
    expect(
      screen.getAllByText("assistant content after the last user message"),
    ).toHaveLength(1);
    expect(screen.queryByText("older duplicate load for A")).toBeNull();

    deliver(sessionLoaded("session-1", "newer authoritative load for A", 3));
    expect(
      screen.getAllByText("newer authoritative load for A"),
    ).not.toHaveLength(0);
    expect(
      screen.queryByText("assistant content after the last user message"),
    ).toBeNull();
    expect(
      document.querySelectorAll(".message.user-message .markdown-body p"),
    ).toHaveLength(1);
  });

  it("accepts a higher-revision destructive replacement as the first cached-focus load", async () => {
    const vscodeApi = createVsCodeApi();
    render(<App vscodeApi={vscodeApi} />);
    deliver({ type: "chatWorkspaceUpdate", snapshot: createSnapshot("tab-1") });
    deliver(sessionLoaded("session-1", "original transcript for A", 4));
    deliver({ type: "chatWorkspaceUpdate", snapshot: createSnapshot("tab-2") });
    deliver(sessionLoaded("session-2", "transcript for B", 1));

    deliver({ type: "chatWorkspaceUpdate", snapshot: createSnapshot("tab-1") });
    deliver(sessionLoaded("session-1", "reverted transcript for A", 5));

    await waitFor(() => {
      expect(screen.getAllByText("reverted transcript for A")).not.toHaveLength(
        0,
      );
    });
    expect(screen.queryByText("original transcript for A")).toBeNull();
  });

  it("resets pagination state when restoring a cached tab", async () => {
    const vscodeApi = createVsCodeApi();
    render(<App vscodeApi={vscodeApi} />);
    deliver({ type: "chatWorkspaceUpdate", snapshot: createSnapshot("tab-1") });
    deliver({
      ...sessionLoaded("session-1", "transcript for A", 1),
      userTurnOffset: 1,
      hasMoreBefore: true,
    });
    deliver({ type: "chatWorkspaceUpdate", snapshot: createSnapshot("tab-2") });
    deliver({
      ...sessionLoaded("session-2", "transcript for B", 1),
      userTurnOffset: 2,
      hasMoreBefore: true,
    });

    fireEvent.click(
      screen.getByRole("button", { name: /Show earlier messages/ }),
    );
    expect(
      postedCommands(vscodeApi.postMessage, "agentLoadEarlierSessionMessages"),
    ).toEqual([
      expect.objectContaining({
        sessionId: "session-2",
        beforeUserTurnOffset: 2,
      }),
    ]);

    deliver({ type: "chatWorkspaceUpdate", snapshot: createSnapshot("tab-1") });
    deliver({
      ...sessionLoaded("session-1", "stale persisted tail for A", 1),
      origin: "focus",
    });
    deliver({
      type: "agentSessionChunk",
      sessionId: "session-2",
      messages: [{ role: "user", content: "late history from B" }],
      userTurnOffset: 0,
      hasMoreBefore: false,
    });

    expect(screen.queryByText("late history from B")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: /Show earlier messages/ }),
    );
    expect(
      postedCommands(vscodeApi.postMessage, "agentLoadEarlierSessionMessages"),
    ).toEqual([
      expect.objectContaining({ sessionId: "session-2" }),
      expect.objectContaining({
        sessionId: "session-1",
        beforeUserTurnOffset: 1,
      }),
    ]);
  });

  it("does not duplicate an inactive queued interjection after terminal replay", async () => {
    const vscodeApi = createVsCodeApi();
    render(<App vscodeApi={vscodeApi} />);
    deliver({ type: "chatWorkspaceUpdate", snapshot: createSnapshot("tab-2") });
    deliver(sessionLoaded("session-2", "transcript for B"));
    deliver({ type: "chatWorkspaceUpdate", snapshot: createSnapshot("tab-1") });
    deliver(sessionLoaded("session-1", "transcript for A"));

    deliver({
      type: "agentQueuedMessage",
      sessionId: "session-2",
      queueId: "queue-b",
      text: "interject once",
      displayText: "interject once",
      isSlashCommand: false,
    });
    deliver({
      type: "agentInterjection",
      sessionId: "session-2",
      queueId: "queue-b",
      text: "interject once",
      displayText: "interject once",
      isSlashCommand: false,
    });
    deliver({
      type: "agentDone",
      sessionId: "session-2",
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
    });

    deliver({ type: "chatWorkspaceUpdate", snapshot: createSnapshot("tab-2") });
    deliver({
      ...sessionLoaded("session-2", "transcript for B"),
      origin: "focus",
    });

    await waitFor(() => {
      expect(screen.getAllByText("interject once")).toHaveLength(1);
    });
    expect(screen.queryByText("Queued (1)")).toBeNull();
    expect(postedCommands(vscodeApi.postMessage, "agentSend")).toHaveLength(0);
  });

  it("replays the exact confirmed address and allows cancellation", () => {
    const vscodeApi = createVsCodeApi();
    render(<App vscodeApi={vscodeApi} />);
    deliver({ type: "chatWorkspaceUpdate", snapshot: createSnapshot() });
    deliver({
      type: "chatTabActionConfirmationRequested",
      request: {
        command: "chatTabLoadSession",
        action: "load_session",
        address: {
          controllerEpoch: "confirmation-epoch",
          tabId: "tab-2",
          sessionId: "session-2",
        },
        mode: "ask",
        projectId: "project-2",
        targetSessionId: "saved-session",
      },
    });

    fireEvent.click(screen.getByRole("button", { name: "Keep current chat" }));
    expect(
      postedCommands(vscodeApi.postMessage, "chatTabLoadSession"),
    ).toHaveLength(0);

    deliver({
      type: "chatTabActionConfirmationRequested",
      request: {
        command: "chatTabLoadSession",
        action: "load_session",
        address: {
          controllerEpoch: "confirmation-epoch",
          tabId: "tab-2",
          sessionId: "session-2",
        },
        mode: "ask",
        projectId: "project-2",
        targetSessionId: "saved-session",
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Stop and load chat" }));

    expect(postedCommands(vscodeApi.postMessage, "chatTabLoadSession")).toEqual(
      [
        {
          command: "chatTabLoadSession",
          controllerEpoch: "confirmation-epoch",
          tabId: "tab-2",
          sessionId: "session-2",
          mode: "ask",
          projectId: "project-2",
          targetSessionId: "saved-session",
          stopRunning: true,
        },
      ],
    );
  });

  it("applies a stale-action snapshot and shows recoverable feedback", () => {
    const vscodeApi = createVsCodeApi();
    const { container } = render(<App vscodeApi={vscodeApi} />);
    deliver({ type: "chatWorkspaceUpdate", snapshot: createSnapshot("tab-2") });
    deliver(sessionLoaded("session-2", "transcript for B"));
    deliver({ type: "chatWorkspaceUpdate", snapshot: createSnapshot("tab-1") });
    deliver(sessionLoaded("session-1", "transcript for A"));
    deliver({
      type: "agentQueuedMessage",
      sessionId: "session-1",
      queueId: "queue-a",
      text: "queued for A",
      displayText: "queued for A",
      isSlashCommand: false,
    });

    deliver({
      type: "chatTabActionRejected",
      rejection: {
        command: "chatTabFocus",
        reason: "stale_session",
        snapshot: createSnapshot("tab-2"),
      },
    });

    expect(screen.getByRole("alert").textContent).toContain(
      "That chat tab changed. Please try the action again.",
    );
    expect(
      container.querySelector<HTMLElement>(".chat-session-pane")?.dataset
        .tabKey,
    ).toBe("tab-2:session-2");
    expect(screen.getAllByText("transcript for B")).not.toHaveLength(0);
    expect(screen.queryByText("transcript for A")).toBeNull();
    expect(screen.queryByText("queued for A")).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Dismiss tab message" }),
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
