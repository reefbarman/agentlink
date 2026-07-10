import { beforeEach, describe, expect, it, vi } from "vitest";

import { ToolCallTracker } from "./ToolCallTracker.js";

const mocks = vi.hoisted(() => ({
  detachTerminal: vi.fn<(terminalId: string) => boolean>(),
}));

vi.mock("../integrations/TerminalManager.js", () => ({
  getTerminalManager: () => ({ detachTerminal: mocks.detachTerminal }),
}));

describe("ToolCallTracker continueInBackground", () => {
  beforeEach(() => {
    mocks.detachTerminal.mockReset();
    mocks.detachTerminal.mockReturnValue(true);
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
