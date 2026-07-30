import { beforeEach, describe, expect, it, vi } from "vitest";

import { StatusBarManager } from "./StatusBarManager.js";

const mocks = vi.hoisted(() => {
  const items: Array<{
    id: string;
    alignment: number;
    priority: number;
    name?: string;
    text: string;
    tooltip?: string;
    backgroundColor?: { id: string };
    command?:
      | string
      | { command: string; title: string; arguments?: unknown[] };
    show: ReturnType<typeof vi.fn>;
    hide: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  }> = [];
  return { items };
});

vi.mock("vscode", () => ({
  StatusBarAlignment: { Left: 1 },
  ThemeColor: class {
    constructor(public readonly id: string) {}
  },
  window: {
    createStatusBarItem: (id: string, alignment: number, priority: number) => {
      const item = {
        id,
        alignment,
        priority,
        name: undefined,
        text: "",
        tooltip: undefined,
        backgroundColor: undefined,
        command: undefined,
        show: vi.fn(),
        hide: vi.fn(),
        dispose: vi.fn(),
      };
      mocks.items.push(item);
      return item;
    },
  },
}));

describe("StatusBarManager retained approval and error behavior", () => {
  beforeEach(() => {
    vi.useRealTimers();
    mocks.items.length = 0;
  });

  it("creates one unified AgentLink status-bar entry", () => {
    const manager = new StatusBarManager();

    expect(mocks.items).toHaveLength(1);
    expect(mocks.items[0]).toMatchObject({
      id: "approvalAlert",
      alignment: 1,
      priority: 10000,
      name: "AgentLink Status",
    });
    manager.dispose();
  });

  it("stays hidden while idle and hides after an approval alert", () => {
    const manager = new StatusBarManager();
    const primary = mocks.items[0];

    expect(primary.show).not.toHaveBeenCalled();

    const alert = manager.showAlert("Command approval required");
    expect(primary).toMatchObject({
      text: "$(link) AgentLink — Command approval required",
      command: "agentLink.focusApproval",
      backgroundColor: { id: "statusBarItem.warningBackground" },
    });
    expect(primary.show).toHaveBeenCalledTimes(1);

    alert.dispose();
    expect(primary).toMatchObject({
      text: "",
      tooltip: undefined,
      command: undefined,
      backgroundColor: undefined,
    });
    expect(primary.hide).toHaveBeenCalledTimes(1);
    manager.dispose();
  });

  it("keeps the approval label and width stable while awaiting a decision", () => {
    vi.useFakeTimers();
    const manager = new StatusBarManager();
    const item = mocks.items[0];

    manager.showAlert("Command approval required");
    const initialText = item.text;
    const initialShowCalls = item.show.mock.calls.length;

    manager.clearError();
    manager.clearError();
    vi.advanceTimersByTime(10_000);

    expect(item.text).toBe(initialText);
    expect(item.show).toHaveBeenCalledTimes(initialShowCalls);
    expect(vi.getTimerCount()).toBe(0);
    manager.dispose();
  });

  it("keeps the newest active alert visible and restores the previous target", () => {
    const manager = new StatusBarManager();
    const primary = mocks.items[0];
    const firstCommand = {
      command: "agentLink.focusApproval",
      title: "Focus first approval",
      arguments: [{ sessionId: "session-1" }],
    };
    const secondCommand = {
      command: "agentLink.focusApproval",
      title: "Focus second question",
      arguments: [{ sessionId: "session-2" }],
    };

    const first = manager.showAlert("First approval required", firstCommand);
    const second = manager.showAlert(
      "Question requires a response",
      secondCommand,
    );
    expect(primary).toMatchObject({
      text: "$(link) AgentLink — Question requires a response (+1 pending)",
      tooltip:
        "Question requires a response\n1 more AgentLink interaction pending",
      command: secondCommand,
    });

    first.dispose();

    expect(primary).toMatchObject({
      text: "$(link) AgentLink — Question requires a response",
      tooltip: "Question requires a response",
      command: secondCommand,
    });
    expect(primary.hide).not.toHaveBeenCalled();

    second.dispose();
    expect(primary.hide).toHaveBeenCalledOnce();
    manager.dispose();
  });

  it("restores an older pending alert when the newest request resolves", () => {
    const manager = new StatusBarManager();
    const primary = mocks.items[0];
    const first = manager.showAlert("First approval required");
    const second = manager.showAlert("Question requires a response");

    second.dispose();

    expect(primary).toMatchObject({
      text: "$(link) AgentLink — First approval required",
      tooltip: "First approval required",
      command: "agentLink.focusApproval",
    });
    expect(primary.hide).not.toHaveBeenCalled();

    first.dispose();
    expect(primary.hide).toHaveBeenCalledOnce();
    manager.dispose();
  });

  it("shows and hides a queued approval count on the unified item", () => {
    const manager = new StatusBarManager();
    const item = mocks.items[0];

    manager.setPendingCount(2);
    expect(item).toMatchObject({
      text: "$(link) AgentLink — 2 approvals pending",
      tooltip: "2 AgentLink approvals pending",
      command: "agentLink.focusApproval",
      backgroundColor: { id: "statusBarItem.warningBackground" },
    });
    expect(item.show).toHaveBeenCalledTimes(1);

    manager.setPendingCount(0);
    expect(item.hide).toHaveBeenCalledTimes(1);
    manager.dispose();
  });

  it("does not mix queued-provider counts into an active interaction alert", () => {
    const manager = new StatusBarManager();
    const item = mocks.items[0];
    const alert = manager.showAlert("Question requires a response");

    manager.setPendingCount(2);
    expect(item).toMatchObject({
      text: "$(link) AgentLink — Question requires a response",
      tooltip: "Question requires a response",
      command: "agentLink.focusApproval",
    });

    alert.dispose();
    expect(item.text).toBe("$(link) AgentLink — 2 approvals pending");
    manager.setPendingCount(0);
    expect(item.hide).toHaveBeenCalledOnce();
    manager.dispose();
  });

  it("preserves an indexer error across an alert and hides when cleared", () => {
    const manager = new StatusBarManager();
    const primary = mocks.items[0];
    manager.setError("Indexing: retrieval store unavailable");

    expect(primary).toMatchObject({
      text: "$(link) AgentLink — Error",
      tooltip: "Indexing: retrieval store unavailable",
      command: "agentLink.statusView.focus",
      backgroundColor: { id: "statusBarItem.errorBackground" },
    });
    expect(primary.show).toHaveBeenCalledTimes(1);

    const alert = manager.showAlert("File approval required");
    expect(primary.tooltip).toBe("File approval required");
    alert.dispose();
    expect(primary).toMatchObject({
      text: "$(link) AgentLink — Error",
      tooltip: "Indexing: retrieval store unavailable",
      backgroundColor: { id: "statusBarItem.errorBackground" },
    });

    manager.clearError();
    expect(primary).toMatchObject({
      text: "",
      tooltip: undefined,
      command: undefined,
      backgroundColor: undefined,
    });
    expect(primary.hide).toHaveBeenCalledTimes(1);
    manager.dispose();
  });

  it("disposes the unified status item", () => {
    const manager = new StatusBarManager();
    manager.showAlert("Approval required");

    manager.dispose();

    expect(mocks.items[0].dispose).toHaveBeenCalledTimes(1);
  });
});
