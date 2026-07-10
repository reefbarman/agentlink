import { beforeEach, describe, expect, it, vi } from "vitest";

import { StatusBarManager } from "./StatusBarManager.js";

const mocks = vi.hoisted(() => {
  const items: Array<{
    text: string;
    tooltip?: string;
    backgroundColor?: { id: string };
    command?: string;
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
    createStatusBarItem: () => {
      const item = {
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

  it("stays hidden while idle and hides after an approval alert", () => {
    vi.useFakeTimers();
    const manager = new StatusBarManager();
    const primary = mocks.items[0];

    expect(primary.show).not.toHaveBeenCalled();

    const alert = manager.showAlert("Command approval required");
    expect(primary).toMatchObject({
      text: "$(alert) Command approval required",
      command: "agentLink.focusApproval",
      backgroundColor: { id: "statusBarItem.warningBackground" },
    });
    expect(primary.show).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(800);
    expect(primary.text).toBe("     Command approval required");

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

  it("shows and hides the queued approval count", () => {
    const manager = new StatusBarManager();
    const pending = mocks.items[1];

    manager.setPendingCount(2);
    expect(pending.text).toBe("$(ellipsis) 2 more approvals pending");
    expect(pending.show).toHaveBeenCalledTimes(1);

    manager.setPendingCount(0);
    expect(pending.hide).toHaveBeenCalledTimes(1);
    manager.dispose();
  });

  it("preserves an indexer error across an alert and hides when cleared", () => {
    const manager = new StatusBarManager();
    const primary = mocks.items[0];
    manager.setError("Indexing: Qdrant unavailable");

    expect(primary).toMatchObject({
      text: "$(link) AgentLink — Error",
      tooltip: "Indexing: Qdrant unavailable",
      command: "agentLink.statusView.focus",
      backgroundColor: { id: "statusBarItem.errorBackground" },
    });
    expect(primary.show).toHaveBeenCalledTimes(1);

    const alert = manager.showAlert("File approval required");
    expect(primary.tooltip).toBe("File approval required");
    alert.dispose();
    expect(primary).toMatchObject({
      text: "$(link) AgentLink — Error",
      tooltip: "Indexing: Qdrant unavailable",
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

  it("disposes both status items and active flashing", () => {
    vi.useFakeTimers();
    const manager = new StatusBarManager();
    manager.showAlert("Approval required");

    manager.dispose();
    vi.advanceTimersByTime(1_600);

    expect(mocks.items[0].dispose).toHaveBeenCalledTimes(1);
    expect(mocks.items[1].dispose).toHaveBeenCalledTimes(1);
  });
});
