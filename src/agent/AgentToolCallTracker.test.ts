import type {
  TerminalOutputRequest,
  TerminalProvider,
  TerminalTargetRequest,
} from "../core/capabilities/terminal.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AgentToolCallTracker } from "./AgentToolCallTracker.js";

const mocks = vi.hoisted(() => ({
  detachTerminal: vi.fn<(request: TerminalTargetRequest) => boolean>(),
  revealTerminal: vi.fn<(request: TerminalTargetRequest) => boolean>(),
  interruptTerminal: vi.fn<(request: TerminalTargetRequest) => boolean>(),
  getCurrentOutput:
    vi.fn<(request: TerminalOutputRequest) => string | undefined>(),
  getBackgroundState: vi.fn(),
  resolveCurrentDiff: vi.fn<(decision: "accept" | "reject") => boolean>(),
}));

vi.mock("../integrations/TerminalManager.js", () => ({
  getTerminalManager: () => ({
    detachTerminal: mocks.detachTerminal,
    revealTerminal: mocks.revealTerminal,
    interruptTerminal: mocks.interruptTerminal,
    getCurrentOutput: mocks.getCurrentOutput,
    getBackgroundState: mocks.getBackgroundState,
  }),
}));

vi.mock("../integrations/DiffViewProvider.js", () => ({
  resolveCurrentDiff: mocks.resolveCurrentDiff,
}));

function createTerminalProvider(): TerminalProvider {
  return {
    executeCommand: vi.fn(),
    getBackgroundState: mocks.getBackgroundState,
    getCurrentOutput: mocks.getCurrentOutput,
    interruptTerminal: mocks.interruptTerminal,
    detachTerminal: mocks.detachTerminal,
    revealTerminal: mocks.revealTerminal,
    getRecentlyClosedTerminals: vi.fn(() => []),
    listTerminals: vi.fn(() => []),
    closeTerminals: vi.fn(() => ({ closed: 0 })),
  };
}

function createTracker(): AgentToolCallTracker {
  const terminalProvider = createTerminalProvider();
  return new AgentToolCallTracker(undefined, () => terminalProvider);
}

describe("AgentToolCallTracker continueInBackground", () => {
  beforeEach(() => {
    vi.useRealTimers();
    mocks.detachTerminal.mockReset();
    mocks.detachTerminal.mockReturnValue(true);
    mocks.revealTerminal.mockReset();
    mocks.revealTerminal.mockReturnValue(true);
    mocks.interruptTerminal.mockReset();
    mocks.interruptTerminal.mockReturnValue(true);
    mocks.getCurrentOutput.mockReset();
    mocks.getBackgroundState.mockReset();
    mocks.resolveCurrentDiff.mockReset();
    mocks.resolveCurrentDiff.mockReturnValue(false);
  });

  it("detaches immediately when execute_command already has a terminal", async () => {
    const tracker = createTracker();
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
      expect(mocks.detachTerminal).toHaveBeenCalledWith({
        owner: undefined,
        terminalId: "term_1",
      });
    });
  });

  it("waits for terminal assignment when background is requested early", async () => {
    const tracker = createTracker();
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
      expect(mocks.detachTerminal).toHaveBeenCalledWith({
        owner: undefined,
        terminalId: "term_2",
      });
    });
  });

  it("detaches execute_command calls that use inline files", async () => {
    const tracker = createTracker();
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
      expect(mocks.detachTerminal).toHaveBeenCalledWith({
        owner: undefined,
        terminalId: "term_files",
      });
    });
  });

  it("returns control from get_background_result without stopping the background agent", () => {
    const tracker = createTracker();
    const forceResolve = vi.fn();
    tracker.registerAgentCall(
      "call-background-result",
      "get_background_result",
      "bg-session-1",
      "session-1",
      forceResolve,
      JSON.stringify({ sessionId: "bg-session-1" }),
    );

    expect(tracker.getActiveCalls()[0]).toMatchObject({
      canContinueInBackground: true,
    });

    tracker.continueInBackground("call-background-result");

    expect(mocks.detachTerminal).not.toHaveBeenCalled();
    expect(mocks.interruptTerminal).not.toHaveBeenCalled();
    expect(JSON.parse(forceResolve.mock.calls[0][0].content[0].text)).toEqual({
      status: "continued-in-background",
      done: false,
      sessionId: "bg-session-1",
      message:
        "Returned control to the agent. The background agent is still running; use get_background_status to check progress or get_background_result when ready to wait again.",
    });
  });

  it("ignores background requests for other tools", async () => {
    const tracker = createTracker();
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

describe("AgentToolCallTracker revealTerminal", () => {
  beforeEach(() => {
    mocks.revealTerminal.mockReset();
    mocks.revealTerminal.mockReturnValue(true);
  });

  it("reveals the terminal assigned to a running execute_command", async () => {
    const tracker = createTracker();
    const context = tracker.registerAgentCall(
      "call-reveal",
      "execute_command",
      "npm test",
      "session-1",
      vi.fn(),
    );
    context.setTerminalId("term_reveal");

    tracker.revealTerminal("call-reveal");

    await vi.waitFor(() => {
      expect(mocks.revealTerminal).toHaveBeenCalledWith({
        owner: undefined,
        terminalId: "term_reveal",
      });
    });
  });

  it("honors a reveal click made before terminal assignment", async () => {
    const tracker = createTracker();
    const context = tracker.registerAgentCall(
      "call-pending-reveal",
      "execute_command",
      "npm test",
      "session-1",
      vi.fn(),
    );

    tracker.revealTerminal("call-pending-reveal");
    expect(mocks.revealTerminal).not.toHaveBeenCalled();

    context.setTerminalId("term_pending_reveal");

    await vi.waitFor(() => {
      expect(mocks.revealTerminal).toHaveBeenCalledWith({
        owner: undefined,
        terminalId: "term_pending_reveal",
      });
    });
  });

  it("does not reveal terminals for other running tools", () => {
    const tracker = createTracker();
    tracker.registerAgentCall(
      "call-read",
      "read_file",
      "src/index.ts",
      "session-1",
      vi.fn(),
    );

    tracker.revealTerminal("call-read");

    expect(mocks.revealTerminal).not.toHaveBeenCalled();
  });
});

describe("AgentToolCallTracker lifecycle", () => {
  beforeEach(() => {
    vi.useRealTimers();
    mocks.detachTerminal.mockReset();
    mocks.interruptTerminal.mockReset();
    mocks.interruptTerminal.mockReturnValue(true);
    mocks.getCurrentOutput.mockReset();
    mocks.getBackgroundState.mockReset();
    mocks.resolveCurrentDiff.mockReset();
    mocks.resolveCurrentDiff.mockReturnValue(false);
  });

  it("emits registration/completion changes and expires recent calls", () => {
    vi.useFakeTimers();
    const tracker = createTracker();
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
      }),
    ]);

    tracker.completeAgentCall("call-life");
    expect(tracker.getActiveCalls()).toEqual([
      expect.objectContaining({
        id: "call-life",
        status: "completed",
      }),
    ]);
    expect(onChange).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(8_000);
    expect(tracker.getActiveCalls()).toEqual([]);
    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it("clears only agent calls belonging to the stopped session", () => {
    const tracker = createTracker();
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

  it("pins terminal control to the provider captured when the call starts", () => {
    const firstInterrupt = vi.fn(() => true);
    const secondInterrupt = vi.fn(() => true);
    let currentProvider = {
      ...createTerminalProvider(),
      interruptTerminal: firstInterrupt,
    };
    const tracker = new AgentToolCallTracker(undefined, () => currentProvider);
    const context = tracker.registerAgentCall(
      "call-generation",
      "execute_command",
      "npm test",
      "session-a",
      vi.fn(),
    );
    context.setTerminalId("term-old-generation");
    currentProvider = {
      ...createTerminalProvider(),
      interruptTerminal: secondInterrupt,
    };

    tracker.cancelCall("call-generation");

    expect(firstInterrupt).toHaveBeenCalledWith({
      owner: undefined,
      terminalId: "term-old-generation",
    });
    expect(secondInterrupt).not.toHaveBeenCalled();
  });

  it("cancels the linked terminal, diff, and force resolver", async () => {
    const tracker = createTracker();
    const forceResolve = vi.fn();
    const context = tracker.registerAgentCall(
      "call-cancel",
      "execute_command",
      "npm test",
      "session-a",
      forceResolve,
    );
    context.setTerminalId("term-cancel");

    tracker.cancelCall("call-cancel");
    await vi.waitFor(() => {
      expect(mocks.interruptTerminal).toHaveBeenCalledWith({
        owner: undefined,
        terminalId: "term-cancel",
      });
      expect(mocks.resolveCurrentDiff).toHaveBeenCalledWith("reject");
    });

    expect(forceResolve).toHaveBeenCalledTimes(1);
    expect(JSON.parse(forceResolve.mock.calls[0][0].content[0].text)).toEqual({
      status: "cancelled",
      tool: "execute_command",
      message: "Cancelled by user from VS Code",
    });
  });

  it("cancels all active descendants with their parent", () => {
    const tracker = createTracker();
    const parentResolve = vi.fn();
    const childResolve = vi.fn();
    const grandchildResolve = vi.fn();
    tracker.registerAgentCall(
      "parent",
      "compose",
      "",
      "session-a",
      parentResolve,
    );
    tracker.registerAgentCall(
      "child",
      "get_context",
      "",
      "session-a",
      childResolve,
      undefined,
      "parent",
    );
    const grandchildContext = tracker.registerAgentCall(
      "grandchild",
      "execute_command",
      "",
      "session-a",
      grandchildResolve,
      undefined,
      "child",
    );
    grandchildContext.setTerminalId("sandbox-descendant");

    tracker.cancelCall("parent");

    expect(parentResolve).toHaveBeenCalledOnce();
    expect(childResolve).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "cancelled" }),
      }),
    );
    expect(grandchildResolve).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "cancelled" }),
      }),
    );
    expect(mocks.interruptTerminal).toHaveBeenCalledWith({
      owner: undefined,
      terminalId: "sandbox-descendant",
    });
  });

  it("force-completes generic tools with the existing fallback", async () => {
    const tracker = createTracker();
    const forceResolve = vi.fn();
    tracker.registerAgentCall(
      "call-generic",
      "read_file",
      "src/index.ts",
      "session-a",
      forceResolve,
    );

    await tracker.completeCall("call-generic");

    expect(JSON.parse(forceResolve.mock.calls[0][0].content[0].text)).toEqual({
      status: "force-completed",
      tool: "read_file",
      message: "Force-completed by user from VS Code",
    });
  });

  it("force-completes execute_command with captured output", async () => {
    mocks.getCurrentOutput.mockReturnValue("partial output");
    const tracker = createTracker();
    const forceResolve = vi.fn();
    const context = tracker.registerAgentCall(
      "call-complete",
      "execute_command",
      "npm test",
      "session-a",
      forceResolve,
    );
    context.setTerminalId("term-complete");

    await tracker.completeCall("call-complete");

    expect(mocks.getCurrentOutput).toHaveBeenCalledWith({
      owner: undefined,
      terminalId: "term-complete",
      force: true,
    });
    expect(mocks.interruptTerminal).toHaveBeenCalledWith({
      owner: undefined,
      terminalId: "term-complete",
    });
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

  it("returns managed terminal output without forcing a second capture", async () => {
    mocks.getBackgroundState.mockReturnValue({
      is_running: true,
      exit_code: null,
      output_captured: true,
      output: "managed output",
    });
    const tracker = createTracker();
    const forceResolve = vi.fn();
    tracker.registerAgentCall(
      "call-output",
      "get_terminal_output",
      "term-output",
      "session-a",
      forceResolve,
    );

    await tracker.completeCall("call-output");

    expect(mocks.getCurrentOutput).not.toHaveBeenCalled();
    expect(
      JSON.parse(forceResolve.mock.calls[0][0].content[0].text),
    ).toMatchObject({
      terminal_id: "term-output",
      is_running: true,
      exit_code: null,
      output_captured: true,
      output: "managed output",
      status: "force-completed",
    });
  });

  it("force-reads output when the terminal is no longer managed", async () => {
    mocks.getBackgroundState.mockReturnValue(undefined);
    mocks.getCurrentOutput.mockReturnValue("direct output");
    const tracker = createTracker();
    const forceResolve = vi.fn();
    tracker.registerAgentCall(
      "call-output-direct",
      "get_terminal_output",
      "term-direct",
      "session-a",
      forceResolve,
    );

    await tracker.completeCall("call-output-direct");

    expect(mocks.getCurrentOutput).toHaveBeenCalledWith({
      owner: undefined,
      terminalId: "term-direct",
      force: true,
    });
    expect(
      JSON.parse(forceResolve.mock.calls[0][0].content[0].text),
    ).toMatchObject({
      terminal_id: "term-direct",
      is_running: false,
      output_captured: true,
      output: "direct output",
      status: "force-completed",
    });
  });

  it.each(["write_file", "apply_diff"])(
    "auto-accepts pending diffs for %s without force-resolving",
    async (toolName) => {
      mocks.resolveCurrentDiff.mockReturnValue(true);
      const tracker = createTracker();
      const forceResolve = vi.fn();
      tracker.registerAgentCall(
        `call-${toolName}`,
        toolName,
        "src/index.ts",
        "session-a",
        forceResolve,
      );

      await tracker.completeCall(`call-${toolName}`);

      expect(mocks.resolveCurrentDiff).toHaveBeenCalledWith("accept");
      expect(forceResolve).not.toHaveBeenCalled();
    },
  );

  it("force-completes a write tool when no diff is pending", async () => {
    const tracker = createTracker();
    const forceResolve = vi.fn();
    tracker.registerAgentCall(
      "call-write-fallback",
      "write_file",
      "src/index.ts",
      "session-a",
      forceResolve,
    );

    await tracker.completeCall("call-write-fallback");

    expect(JSON.parse(forceResolve.mock.calls[0][0].content[0].text)).toEqual({
      status: "force-completed",
      path: "src/index.ts",
      message:
        "No pending diff to accept — file may already be saved or approval was not yet shown",
    });
  });
});
