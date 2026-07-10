import { beforeEach, describe, expect, it, vi } from "vitest";

import { ToolCallTracker } from "./ToolCallTracker.js";

const mocks = vi.hoisted(() => ({
  detachTerminal: vi.fn<(terminalId: string) => boolean>(),
  interruptTerminal: vi.fn<(terminalId: string) => void>(),
  getCurrentOutput: vi.fn<(terminalId: string) => string | undefined>(),
  resolveCurrentDiff: vi.fn<(decision: "accept" | "reject") => boolean>(),
}));

vi.mock("../integrations/TerminalManager.js", () => ({
  getTerminalManager: () => ({
    detachTerminal: mocks.detachTerminal,
    interruptTerminal: mocks.interruptTerminal,
    getCurrentOutput: mocks.getCurrentOutput,
  }),
}));

vi.mock("../integrations/DiffViewProvider.js", () => ({
  resolveCurrentDiff: mocks.resolveCurrentDiff,
}));

describe("ToolCallTracker continueInBackground", () => {
  beforeEach(() => {
    vi.useRealTimers();
    mocks.detachTerminal.mockReset();
    mocks.detachTerminal.mockReturnValue(true);
    mocks.interruptTerminal.mockReset();
    mocks.getCurrentOutput.mockReset();
    mocks.resolveCurrentDiff.mockReset();
    mocks.resolveCurrentDiff.mockReturnValue(false);
  });

  it("detaches immediately when execute_command already has a terminal", async () => {
    const tracker = new ToolCallTracker();
    const context = tracker.registerAgentCall(
      "call-1",
      "execute_command",
      "npm test",
      "session-1",
      vi.fn(),
    );
    context.setTerminalId("term_1");

    tracker.continueInBackground("call-1");
    await vi.waitFor(() => {
      expect(mocks.detachTerminal).toHaveBeenCalledWith("term_1");
    });
  });

  it("waits for terminal assignment when background is requested early", async () => {
    const tracker = new ToolCallTracker();
    const context = tracker.registerAgentCall(
      "call-2",
      "execute_command",
      "npm test",
      "session-1",
      vi.fn(),
    );

    tracker.continueInBackground("call-2");
    expect(mocks.detachTerminal).not.toHaveBeenCalled();

    context.setTerminalId("term_2");
    await vi.waitFor(() => {
      expect(mocks.detachTerminal).toHaveBeenCalledTimes(1);
      expect(mocks.detachTerminal).toHaveBeenCalledWith("term_2");
    });
  });

  it("detaches execute_command calls that use inline files", async () => {
    const tracker = new ToolCallTracker();
    const context = tracker.registerAgentCall(
      "call-files",
      "execute_command",
      "node script.js",
      "session-1",
      vi.fn(),
      JSON.stringify({
        command: "node {{file:script.js}}",
        files: [{ name: "script.js", content: "console.log('ok')" }],
      }),
    );
    context.setTerminalId("term_files");

    expect(tracker.getActiveCalls()[0]).toMatchObject({
      canContinueInBackground: true,
    });
    tracker.continueInBackground("call-files");
    await vi.waitFor(() => {
      expect(mocks.detachTerminal).toHaveBeenCalledWith("term_files");
    });
  });

  it("ignores background requests for other tools", async () => {
    const tracker = new ToolCallTracker();
    tracker.registerAgentCall(
      "call-3",
      "read_file",
      "src/index.ts",
      "session-1",
      vi.fn(),
    );

    tracker.continueInBackground("call-3");
    await Promise.resolve();

    expect(mocks.detachTerminal).not.toHaveBeenCalled();
  });
});

describe("ToolCallTracker agent lifecycle", () => {
  beforeEach(() => {
    vi.useRealTimers();
    mocks.detachTerminal.mockReset();
    mocks.interruptTerminal.mockReset();
    mocks.getCurrentOutput.mockReset();
    mocks.resolveCurrentDiff.mockReset();
    mocks.resolveCurrentDiff.mockReturnValue(false);
  });

  it("emits registration/completion changes and expires recent calls", () => {
    vi.useFakeTimers();
    const tracker = new ToolCallTracker();
    const onChange = vi.fn();
    tracker.on("change", onChange);

    tracker.registerAgentCall(
      "call-life",
      "read_file",
      "src/index.ts",
      "session-a",
      vi.fn(),
      '{"path":"src/index.ts"}',
    );
    expect(tracker.getActiveCalls()).toEqual([
      expect.objectContaining({
        id: "call-life",
        toolName: "read_file",
        displayArgs: "src/index.ts",
        params: '{"path":"src/index.ts"}',
        status: "active",
        source: "agent",
      }),
    ]);

    tracker.completeAgentCall("call-life");
    expect(tracker.getActiveCalls()).toEqual([
      expect.objectContaining({
        id: "call-life",
        status: "completed",
        source: "agent",
      }),
    ]);
    expect(onChange).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(8_000);
    expect(tracker.getActiveCalls()).toEqual([]);
    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it("clears only agent calls belonging to the stopped session", () => {
    const tracker = new ToolCallTracker();
    const onChange = vi.fn();
    tracker.on("change", onChange);
    tracker.registerAgentCall("call-a", "read_file", "a", "session-a", vi.fn());
    tracker.registerAgentCall("call-b", "read_file", "b", "session-b", vi.fn());
    onChange.mockClear();

    tracker.clearAgentCalls("session-a");

    expect(tracker.getActiveCalls()).toEqual([
      expect.objectContaining({ id: "call-b", status: "active" }),
    ]);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("cancels linked agent terminal, approval, diff, and force resolver", async () => {
    const tracker = new ToolCallTracker();
    const forceResolve = vi.fn();
    const cancelApproval = vi.fn();
    const context = tracker.registerAgentCall(
      "call-cancel",
      "execute_command",
      "npm test",
      "session-a",
      forceResolve,
    );
    context.setTerminalId("term-cancel");
    context.setApprovalId("approval-cancel");

    tracker.cancelCall("call-cancel", { cancelApproval } as never);
    await vi.waitFor(() => {
      expect(mocks.interruptTerminal).toHaveBeenCalledWith("term-cancel");
      expect(mocks.resolveCurrentDiff).toHaveBeenCalledWith("reject");
    });

    expect(cancelApproval).toHaveBeenCalledWith("approval-cancel");
    expect(forceResolve).toHaveBeenCalledTimes(1);
    expect(JSON.parse(forceResolve.mock.calls[0][0].content[0].text)).toEqual({
      status: "cancelled",
      tool: "execute_command",
      message: "Cancelled by user from VS Code",
    });
  });

  it("force-completes execute_command with captured output", async () => {
    mocks.getCurrentOutput.mockReturnValue("partial output");
    const tracker = new ToolCallTracker();
    const forceResolve = vi.fn();
    const context = tracker.registerAgentCall(
      "call-complete",
      "execute_command",
      "npm test",
      "session-a",
      forceResolve,
    );
    context.setTerminalId("term-complete");

    await tracker.completeCall("call-complete", {
      cancelApproval: vi.fn(),
    } as never);

    expect(mocks.getCurrentOutput).toHaveBeenCalledWith("term-complete", {
      force: true,
    });
    expect(mocks.interruptTerminal).toHaveBeenCalledWith("term-complete");
    expect(
      JSON.parse(forceResolve.mock.calls[0][0].content[0].text),
    ).toMatchObject({
      exit_code: null,
      output: "partial output",
      output_captured: true,
      terminal_id: "term-complete",
      status: "force-completed",
    });
  });
});
