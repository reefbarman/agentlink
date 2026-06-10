import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  tryGetFirstWorkspaceRoot,
  validateCommand,
  validateInteractiveCommand,
  executeCommand,
  getConfiguration,
} = vi.hoisted(() => ({
  tryGetFirstWorkspaceRoot: vi.fn(),
  validateCommand: vi.fn(),
  validateInteractiveCommand: vi.fn(),
  executeCommand: vi.fn(),
  getConfiguration: vi.fn(() => ({
    get: vi.fn((key: string, fallback?: unknown) => {
      if (key === "masterBypass") return true;
      return fallback;
    }),
  })),
}));

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration,
  },
}));

vi.mock("../util/paths.js", () => ({
  tryGetFirstWorkspaceRoot,
}));

vi.mock("../util/pipeValidator.js", () => ({
  validateCommand,
}));

vi.mock("../util/interactiveValidator.js", () => ({
  validateInteractiveCommand,
}));

vi.mock("../integrations/TerminalManager.js", () => ({
  getTerminalManager: () => ({
    executeCommand,
  }),
}));

describe("handleExecuteCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tryGetFirstWorkspaceRoot.mockReturnValue("/workspace");
    validateCommand.mockReturnValue(null);
    validateInteractiveCommand.mockReturnValue(null);
    executeCommand.mockResolvedValue({
      exit_code: 0,
      output: "ok",
      output_captured: true,
      terminal_id: "term_1",
    });
  });

  it("forwards env map to TerminalManager.executeCommand", async () => {
    const { handleExecuteCommand } = await import("./executeCommand.js");

    await handleExecuteCommand(
      {
        command: "go test ./...",
        env: { CI: "1", GOFLAGS: "-count=1" },
      },
      { isCommandApproved: () => true } as never,
      { isRecentlyApproved: () => true } as never,
      "session-1",
    );

    expect(executeCommand).toHaveBeenCalledTimes(1);
    expect(executeCommand.mock.calls[0][0]).toMatchObject({
      command: "go test ./...",
      env: { CI: "1", GOFLAGS: "-count=1" },
    });
  });

  it("filters terminal raw output with the same output window", async () => {
    executeCommand.mockResolvedValue({
      exit_code: 0,
      output: "one\ntwo\nthree",
      terminal_raw_output:
        "\u001b[31mone\u001b[0m\n\u001b[32mtwo\u001b[0m\n\u001b[33mthree\u001b[0m",
      output_captured: true,
      terminal_id: "term_1",
    });

    const { handleExecuteCommand } = await import("./executeCommand.js");
    const result = await handleExecuteCommand(
      {
        command: "printf lines",
        output_tail: 2,
      },
      { isCommandApproved: () => true } as never,
      { isRecentlyApproved: () => true } as never,
      "session-raw",
    );

    const textItem = result.content[0];
    expect(textItem.type).toBe("text");
    if (textItem.type !== "text") throw new Error("Expected text result");

    const payload = JSON.parse(textItem.text);
    expect(payload.output).toBe("two\nthree");
    expect(payload.terminal_raw_output).toBe(
      "\u001b[32mtwo\u001b[0m\n\u001b[33mthree\u001b[0m",
    );
  });

  it("rejects protected memory writes before masterBypass and force handling", async () => {
    const { handleExecuteCommand } = await import("./executeCommand.js");

    const result = await handleExecuteCommand(
      {
        command: "echo remember >> AGENTS.md",
        force: true,
        force_reason: "test should still reject protected memory writes",
      },
      { isCommandApproved: () => true } as never,
      { isRecentlyApproved: () => true } as never,
      "session-protected",
    );

    expect(executeCommand).not.toHaveBeenCalled();
    const textItem = result.content[0];
    expect(textItem.type).toBe("text");
    if (textItem.type !== "text") throw new Error("Expected text result");

    const payload = JSON.parse(textItem.text);
    expect(payload.status).toBe("rejected");
    expect(payload.reason).toContain("protected instructions or memory");
    expect(payload.reason).toContain("force=true cannot bypass");
  });

  it("rejects protected memory writes introduced by approval command edits", async () => {
    getConfiguration.mockReturnValueOnce({
      get: vi.fn((key: string, fallback?: unknown) => {
        if (key === "masterBypass") return false;
        return fallback;
      }),
    });
    const { handleExecuteCommand } = await import("./executeCommand.js");

    const result = await handleExecuteCommand(
      { command: "echo ok" },
      {
        isCommandApproved: () => false,
        findMatchingCommandRule: () => undefined,
      } as never,
      {
        isRecentlyApproved: () => false,
        enqueueCommandApproval: () => ({
          promise: Promise.resolve({
            decision: "accept",
            editedCommand: "echo remember >> .agentlink/memory.md",
          }),
        }),
      } as never,
      "session-edited-protected",
    );

    expect(executeCommand).not.toHaveBeenCalled();
    const textItem = result.content[0];
    expect(textItem.type).toBe("text");
    if (textItem.type !== "text") throw new Error("Expected text result");

    const payload = JSON.parse(textItem.text);
    expect(payload.status).toBe("rejected");
    expect(payload.command).toBe("echo remember >> .agentlink/memory.md");
    expect(payload.original_command).toBe("echo ok");
    expect(payload.reason).toContain("protected instructions or memory");
  });

  it("returns actionable newline regex hint on ripgrep newline error", async () => {
    executeCommand.mockRejectedValue(
      new Error("ripgrep error: regex parse error: unescaped literal newline"),
    );

    const { handleExecuteCommand } = await import("./executeCommand.js");
    const result = await handleExecuteCommand(
      {
        command: "rg -n 'foo\\nbar' src",
      },
      { isCommandApproved: () => true } as never,
      { isRecentlyApproved: () => true } as never,
      "session-2",
    );

    const textItem = result.content[0];
    expect(textItem.type).toBe("text");
    if (textItem.type !== "text") throw new Error("Expected text result");

    const payload = JSON.parse(textItem.text);
    expect(payload.error).toContain("ripgrep error");
    expect(payload.hint).toContain("literal newline");
    expect(payload.hint).toContain("multiline");
  });
});
